/**
 * ============================================================
 * CUBI BRIDGE — Desktop tray app (Bridge 0 skeleton)
 * ============================================================
 *
 * Observador READ-ONLY del estudio del Pastor.
 * Corre como ícono en la bandeja del sistema (Windows tray).
 *
 * FASE BRIDGE 0 (este archivo):
 *   - Ventana pequeña de emparejamiento (escribir código 6 chars)
 *   - Persistir token en electron-store
 *   - Conectar al servidor vía WebSocket
 *   - Reconectar automáticamente si se cae la conexión
 *   - Enviar ping cada 30s
 *
 * FASE BRIDGE 1 (próximo turno):
 *   - Capturar audio del master output (WASAPI loopback)
 *   - Analizar local: LUFS, True Peak, RMS, espectro
 *   - Enviar métricas cada 500ms vía WS
 *
 * LÍNEA ROJA: este programa nunca escribe al DAW.
 *             Solo observa metadata.
 * ============================================================
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, desktopCapturer, session, shell, screen, Notification, dialog } = require("electron");
const Store = require("electron-store");
const WebSocket = require("ws");
const net = require("net");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

// CP5 — Canal WRITE separado (MIDI OUT a loopMIDI). Módulo
// completamente aislado del observer READ-ONLY. OFF por defecto.
const bridgeWrite = require("./bridge-write");

// ════════════════════════════════════════════════════════════════
// HARDENING v1.6.0 — Self-heal del launcher (Windows)
// ════════════════════════════════════════════════════════════════
// Pastor reportó 2 PCs distintos donde el Bridge quedaba colgado:
//   - Electron en zombie (proceso vivo, ventana muerta)
//   - %appdata%/cubi-bridge bloqueado
//   - .exe del escritorio dejaba de abrir
//   - había que matar manualmente desde Task Manager
//
// Esta capa hace que el Bridge se autorecupere SIN tocar nada:
//   1. PID file con heartbeat → detecta zombies
//   2. Lock recovery → si el lock lo tiene un proceso muerto, lo libera
//   3. Store recovery → si el JSON está corrupto, lo respalda y arranca limpio
//   4. IPC port recovery → si el 49162 está ocupado por zombie, lo mata
//   5. uncaughtException → relaunch suave
//   6. repairBridge() → tray menu + IPC para reparar bajo demanda
// ════════════════════════════════════════════════════════════════
const PID_FILE = path.join(app.getPath("userData"), "bridge.pid");

function readPidFile() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const [pidStr] = raw.split(":");
    const pid = parseInt(pidStr, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

function writePidFile() {
  try { fs.writeFileSync(PID_FILE, `${process.pid}:${Date.now()}`); } catch {}
}

function isPidAlive(pid) {
  if (!pid || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = solo chequea, no mata
    return true;
  } catch (err) {
    return err.code === "EPERM"; // existe pero sin permiso = vivo
  }
}

function killZombieBridges() {
  if (process.platform !== "win32") return false;
  try {
    execSync(
      `taskkill /F /IM "CUBI Bridge.exe" /T /FI "PID ne ${process.pid}"`,
      { stdio: "ignore", windowsHide: true, timeout: 5000 }
    );
    return true;
  } catch { return false; }
}

function killProcessOnPort(port) {
  if (process.platform !== "win32") return false;
  try {
    const out = execSync(
      `netstat -ano -p TCP`,
      { encoding: "utf8", windowsHide: true, timeout: 5000 }
    );
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue;
      const m = line.trim().match(/LISTENING\s+(\d+)/i);
      if (m) {
        const pid = parseInt(m[1], 10);
        if (pid !== process.pid && pid > 0) pids.add(pid);
      }
    }
    for (const pid of pids) {
      try { execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch {}
    }
    return pids.size > 0;
  } catch { return false; }
}

// ─── Store con recovery ante JSON corrupto ──────────────────────
function createStoreSafe() {
  try {
    const s = new Store({ name: "cubi-bridge-config" });
    // Forzar parseo del archivo tocando una key
    s.get("__health_probe__");
    return s;
  } catch (err) {
    console.warn("[Bridge] Config corrupta — respaldando y arrancando limpio:", err.message);
    try {
      const cfgPath = path.join(app.getPath("userData"), "cubi-bridge-config.json");
      if (fs.existsSync(cfgPath)) {
        fs.renameSync(cfgPath, cfgPath + `.broken-${Date.now()}`);
      }
    } catch (e) {
      console.warn("[Bridge] No se pudo respaldar config corrupta:", e.message);
    }
    return new Store({ name: "cubi-bridge-config" });
  }
}
// Install Kit v3 — auto-updater DESACTIVADO. El .exe se sirve desde
// Object Storage del servidor (sin GitHub Releases). Si hay version nueva,
// el Pastor vuelve a apretar "Descargar Bridge" desde /lab.
// const { autoUpdater } = require("electron-updater"); // <- desactivado v1.4.0

const store = createStoreSafe();

const SERVER_URL = process.env.BRIDGE_SERVER_URL || "https://apocalipsisconcafe.com";
const WS_URL = SERVER_URL.replace(/^http/, "ws") + "/ws/bridge";
const REDEEM_URL = SERVER_URL + "/api/bridge/redeem";
const BRIDGE_VERSION = app.getVersion();
const PING_INTERVAL_MS = 30 * 1000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30 * 1000;
const TELEMETRY_INTERVAL_MS = 60 * 1000;
const CAPTURE_RESTART_MS = 4000; // si la captura se cae, reintentar en 4s
const CAPTURE_RESTART_MAX = 5;   // máximo de reintentos seguidos antes de pausar
// Update check: electron-updater revisa GitHub Releases al arrancar y cada 6h.
// La descarga es automática en background; el Pastor solo decide cuándo reiniciar.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Capabilities declaradas en el HELLO — el servidor sabe qué puede observar
// este bridge. Bridge 1 trae "capture-master" siempre. Bridge 2 agrega
// "plugin-chain" cuando un VST3 Companion (o el simulador node) se conecta
// al puerto IPC local. Bridge 3 agregará "project-parse".
const BASE_CAPABILITIES = ["capture-master"];
function currentCapabilities() {
  const caps = [...BASE_CAPABILITIES];
  if (localIpcClients.size > 0) caps.push("plugin-chain");
  return caps;
}

// Bridge 2 — Puerto IPC local (loopback). Aquí escuchamos al VST3 Companion
// que el Pastor inserta en el master de Cubase. Protocolo: una línea JSON por
// mensaje, terminada en \n. Conexión SÓLO desde 127.0.0.1 — nunca expuesto a red.
const LOCAL_IPC_PORT = 49162;
const LOCAL_IPC_HOST = "127.0.0.1";
const localIpcClients = new Set();
let localIpcServer = null;

let tray = null;
let pairingWindow = null;
let captureWindow = null;
let overlayWindow = null;
// Update check state — manejado por electron-updater.
// updateState: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error"
let updateState = "idle";
let updateInfo = null;        // { version, releaseNotes } cuando hay update disponible
let updateProgress = 0;       // 0-100 mientras descarga
let updateCheckTimer = null;
// Plugin chain en RAM en el bridge — además de mandarlo al server, lo reenviamos
// al overlay para que muestre el plugin crítico del master sin esperar al socket.io.
let lastPluginChain = null;
let ws = null;
let pingTimer = null;
let telemetryTimer = null;
let reconnectTimer = null;
let captureRestartTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let isPaused = false;
let lastCaptureError = null;
let captureRestartCount = 0;
let lastCpuSnapshot = process.cpuUsage();

// ─── Tray + iconos ──────────────────────────────────────────────
function makeTrayIcon(color) {
  // Genera un icono PNG mínimo de 16x16 del color indicado (rojo/verde/amarillo)
  // Usamos data URL para evitar tener que empaquetar archivos PNG
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="${color}"/></svg>`;
  const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  return nativeImage.createFromDataURL(dataUrl);
}

let currentTrayState = "disconnected";

function updateTrayState(state /* "connected" | "disconnected" | "paused" | "pairing" */) {
  if (!tray) return;
  const prevState = currentTrayState;
  currentTrayState = state;
  // Mantener el overlay al tanto del estado de conexión (punto verde/rojo)
  forwardToOverlay("overlay:status", { connected: state === "connected" });

  // AUTO-OPEN del HUD la primera vez que el Pastor se conecta tras emparejar.
  // El Pastor no debería tener que cazar el ícono del tray para encontrar el
  // HUD — al pasar a "connected" lo mostramos solo. Persistimos un flag para
  // no abrirlo en CADA reconexión (sería molesto si lo cerró a propósito).
  if (state === "connected" && prevState !== "connected") {
    const hasShownHud = !!store.get("hudFirstShown");
    if (!hasShownHud) {
      store.set("hudFirstShown", true);
      // Pequeño delay para que el tray ya esté renderizado y los displays leídos
      setTimeout(() => {
        try {
          openOverlayWindow();
          rebuildMenu(currentTrayState);
        } catch (e) {
          console.warn("[Bridge] auto-open HUD falló:", e.message);
        }
      }, 800);
    }
  }

  const colors = {
    connected: "#22c55e",
    disconnected: "#ef4444",
    paused: "#9ca3af",
    pairing: "#eab308",
  };
  tray.setImage(makeTrayIcon(colors[state] || colors.disconnected));
  const labels = {
    connected: "🟢 Conectado al Coproductor",
    disconnected: "🔴 Desconectado",
    paused: "⏸ Pausado",
    pairing: "🟡 Esperando emparejamiento",
  };
  tray.setToolTip("CUBI Bridge — " + (labels[state] || "Inactivo"));
  rebuildMenu(state);
}

function rebuildMenu(state) {
  const hasToken = !!store.get("token");
  const overlayShown = !!(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
  const menuItems = [
    {
      label: state === "connected"
        ? "🟢 Conectado al Coproductor"
        : state === "pairing"
        ? "🟡 Esperando emparejamiento"
        : state === "paused"
        ? "⏸ Pausado"
        : "🔴 Desconectado",
      enabled: false,
    },
    { type: "separator" },
  ];
  if (updateState === "downloaded" && updateInfo) {
    menuItems.push(
      {
        label: `✨ Reiniciar para instalar v${updateInfo.version}`,
        click: () => quitAndInstallUpdate(),
      },
      { type: "separator" },
    );
  } else if (updateState === "downloading") {
    menuItems.push(
      { label: `📥 Descargando actualización… ${updateProgress}%`, enabled: false },
      { type: "separator" },
    );
  } else if (updateState === "available" && updateInfo) {
    menuItems.push(
      { label: `🆕 v${updateInfo.version} disponible (descargando…)`, enabled: false },
      { type: "separator" },
    );
  }
  const autoLaunchEnabled = !!app.getLoginItemSettings().openAtLogin;
  const menu = Menu.buildFromTemplate([
    ...menuItems,
    {
      // Floating HUD overlay — copiloto silencioso encima de Cubase. READ-ONLY.
      label: overlayShown ? "🎧 Ocultar HUD flotante" : "🎧 Mostrar HUD flotante",
      enabled: hasToken,
      click: () => toggleOverlay(),
    },
    {
      // Rescate: si el HUD quedó fuera de pantalla (monitor desconectado,
      // resolución cambiada), lo trae a la esquina inferior-derecha visible.
      label: "📍 Resetear posición del HUD",
      enabled: hasToken,
      click: () => resetOverlayPosition(),
    },
    { type: "separator" },
    {
      label: hasToken ? "Re-emparejar estudio…" : "Emparejar estudio…",
      click: () => openPairingWindow(),
    },
    {
      label: isPaused ? "▶ Reanudar observación" : "⏸ Pausar observación",
      enabled: hasToken,
      click: () => togglePause(),
    },
    {
      label: "Desvincular este equipo",
      enabled: hasToken,
      click: () => {
        store.delete("token");
        disconnect();
        closeOverlayWindow();
        updateTrayState("disconnected");
      },
    },
    { type: "separator" },
    {
      label: "🛠 Reparar Bridge (mantener vinculación)",
      click: () => { repairBridge({ wipeToken: false }).catch((e) => console.warn(e)); },
    },
    {
      label: "🆘 Reparar todo y desvincular",
      click: () => { repairBridge({ wipeToken: true }).catch((e) => console.warn(e)); },
    },
    { type: "separator" },
    {
      label: "🔄 Buscar actualizaciones ahora",
      enabled: updateState !== "checking" && updateState !== "downloading",
      click: () => { checkForUpdatesManual(); },
    },
    {
      label: "🚀 Iniciar al encender la PC",
      type: "checkbox",
      checked: autoLaunchEnabled,
      click: () => toggleAutoLaunch(),
    },
    { type: "separator" },
    {
      label: updateState === "downloaded" && updateInfo
        ? `CUBI Bridge v${BRIDGE_VERSION} (v${updateInfo.version} lista)`
        : updateState === "available" && updateInfo
        ? `CUBI Bridge v${BRIDGE_VERSION} (nueva v${updateInfo.version})`
        : `CUBI Bridge v${BRIDGE_VERSION}`,
      enabled: false,
    },
    { label: "Salir", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ─── Auto-launch on boot (Windows login item) ───────────────────
// Se setea automáticamente la primera vez que arranca el Bridge. Después el
// Pastor puede toggle desde el menú del tray. Persistencia: Windows lo guarda
// en HKCU\Software\Microsoft\Windows\CurrentVersion\Run.
function ensureAutoLaunchDefault() {
  // Primera vez: encender. Después, respetar lo que el Pastor haya elegido.
  if (store.get("autoLaunchConfigured")) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      // Windows: openAsHidden no es respetado fuera de Microsoft Store.
      // Pasamos un arg explícito y lo detectamos en process.argv.
      args: ["--hidden"],
    });
    store.set("autoLaunchConfigured", true);
    console.log("[Bridge] Auto-launch on boot habilitado por defecto (--hidden).");
  } catch (err) {
    console.warn("[Bridge] No se pudo configurar auto-launch:", err.message);
  }
}

function toggleAutoLaunch() {
  const current = app.getLoginItemSettings();
  const next = !current.openAtLogin;
  try {
    app.setLoginItemSettings({
      openAtLogin: next,
      args: ["--hidden"],
    });
    console.log(`[Bridge] Auto-launch ${next ? "ON" : "OFF"}`);
    rebuildMenu(currentTrayState);
  } catch (err) {
    console.warn("[Bridge] toggleAutoLaunch falló:", err.message);
  }
}

// ─── Update check (electron-updater → GitHub Releases) ──────────
// El autoUpdater chequea https://github.com/josephcubillos67-commits/cubi-bridge/releases
// configurado en package.json → build.publish. Sin token (repo público).
// Flujo:
//   1. checkForUpdates() → emite "update-available" si hay versión nueva
//   2. Descarga automática en background → emite "download-progress" + "update-downloaded"
//   3. quitAndInstall() → reinicia el Bridge con la nueva versión
function setupAutoUpdater() {
  // NO-OP en v1.4.0+. Mantenemos la función para no romper referencias.
  return;
  // eslint-disable-next-line no-unreachable
  autoUpdater.autoDownload = true;        // descarga sola
  autoUpdater.autoInstallOnAppQuit = true; // si Pastor cierra antes de aceptar, se instala al próximo arranque
  autoUpdater.logger = {
    info: (m) => console.log("[updater]", m),
    warn: (m) => console.warn("[updater]", m),
    error: (m) => console.error("[updater]", m),
    debug: () => {},
  };

  autoUpdater.on("checking-for-update", () => {
    updateState = "checking";
    rebuildMenu(currentTrayState);
  });

  autoUpdater.on("update-available", (info) => {
    updateState = "available";
    updateInfo = { version: info.version, releaseNotes: info.releaseNotes };
    console.log(`[Bridge] Update disponible: v${info.version} (actual v${BRIDGE_VERSION})`);
    rebuildMenu(currentTrayState);
  });

  autoUpdater.on("update-not-available", () => {
    updateState = "idle";
    updateInfo = null;
    rebuildMenu(currentTrayState);
  });

  autoUpdater.on("download-progress", (p) => {
    updateState = "downloading";
    updateProgress = Math.round(p.percent || 0);
    rebuildMenu(currentTrayState);
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateState = "downloaded";
    updateInfo = { version: info.version, releaseNotes: info.releaseNotes };
    rebuildMenu(currentTrayState);
    if (Notification.isSupported()) {
      const n = new Notification({
        title: `CUBI Bridge v${info.version} listo`,
        body: "La actualización está descargada. Click para reiniciar e instalar.",
        silent: true,
      });
      n.on("click", () => quitAndInstallUpdate());
      n.show();
    }
  });

  autoUpdater.on("error", (err) => {
    updateState = "error";
    console.warn("[Bridge] Update error:", err?.message || err);
    rebuildMenu(currentTrayState);
  });
}

async function checkForUpdatesManual() {
  // NO-OP en v1.4.0+. Redirigimos al Pastor al sitio para que rebaje el .exe.
  try {
    await shell.openExternal(`${SERVER_URL}/lab`);
  } catch {}
}

function quitAndInstallUpdate() {
  // NO-OP en v1.4.0+. El instalador nuevo se obtiene rebajando el .exe.
  try {
    shell.openExternal(`${SERVER_URL}/lab`);
  } catch {}
}

function togglePause() {
  isPaused = !isPaused;
  if (isPaused) {
    disconnect();
    updateTrayState("paused");
  } else {
    updateTrayState("disconnected");
    connect();
  }
}

// ─── Ventana de emparejamiento ──────────────────────────────────
function openPairingWindow() {
  if (pairingWindow) {
    pairingWindow.focus();
    return;
  }
  pairingWindow = new BrowserWindow({
    width: 460,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "CUBI Bridge — Emparejar estudio",
    backgroundColor: "#0a0508",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pairingWindow.loadFile("pairing.html");
  pairingWindow.on("closed", () => { pairingWindow = null; });
}

// IPC: la ventana de pairing nos manda el código
ipcMain.handle("bridge:redeem", async (_event, code) => {
  try {
    const res = await fetch(REDEEM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: String(code || "").trim().toUpperCase() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.message || `HTTP ${res.status}` };
    }
    const data = await res.json();
    store.set("token", data.token);
    store.set("userId", data.userId);
    // Reset reconnect backoff y conectar inmediatamente
    reconnectDelay = RECONNECT_BASE_MS;
    disconnect();
    connect();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("bridge:status", async () => ({
  hasToken: !!store.get("token"),
  isPaused,
  serverUrl: SERVER_URL,
}));

// Métricas live desde la ventana de captura → reenviar al servidor por WS
// Y también al Floating HUD overlay si está abierto (READ-ONLY local, sin red).
ipcMain.on("bridge:metrics", (_event, metrics) => {
  if (ws && ws.readyState === WebSocket.OPEN && !isPaused) {
    ws.send(JSON.stringify({ type: "metrics", ...metrics }));
  }
  forwardToOverlay("overlay:metrics", metrics);
});

// Bridge 1.9.0 — perfil musical (BPM/key/tempo/groove/energy/dinámica/crescendo)
// READ-ONLY local: solo va al overlay. NO se manda al server (cero coste de red
// y cero tracking — son métricas derivadas de las que el server ya tiene).
ipcMain.on("bridge:music-profile", (_event, profile) => {
  forwardToOverlay("overlay:music-profile", profile);
});

// Bridge 1.9.0 — STYLE/REFERENCE/CHARACTER request del HUD overlay.
// El overlay vive en file:// (sin cookies), así que NO puede hacer fetch al
// server. Reusamos la WS autenticada del bridge — mismo patrón que live-message.
// Server responde con {type:"style-tag-reply", reqId, ok, style, reference, character}.
ipcMain.on("overlay:request-style-tag", (_event, payload) => {
  try {
    const reqId = String(payload?.reqId || `style-${Date.now()}`);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      forwardToOverlay("overlay:style-tag-reply", {
        reqId, ok: false, reason: "bridge-offline",
      });
      return;
    }
    ws.send(JSON.stringify({
      type: "style-tag-request",
      reqId,
      payload: payload?.payload || {},
    }));
  } catch (e) {
    console.error("[Bridge] overlay:request-style-tag fallo:", e?.message || e);
    forwardToOverlay("overlay:style-tag-reply", {
      reqId: payload?.reqId || null, ok: false, reason: "send-error",
    });
  }
});

// IPC del Floating HUD overlay — todas las acciones son locales o
// no-destructivas. Cero bytes hacia Cubase.
ipcMain.on("overlay:open-lab", () => {
  shell.openExternal(SERVER_URL + "/lab");
});
ipcMain.on("overlay:close", () => {
  closeOverlayWindow();
  rebuildMenu(currentTrayState);
});
ipcMain.on("overlay:toggle-compact", () => {
  toggleOverlayCompact();
});

// Pastor 25-may-2026 · Live Copilot interactivo (HUD v2):
// El input de chat del HUD manda mensajes acá; los reenviamos al server por la
// misma WS autenticada del Bridge. La respuesta vuelve por el handler de ws.on("message")
// más abajo (msg.type === "live-reply") y se reenvía al overlayWindow por IPC.
ipcMain.on("overlay:send-live-message", (_event, payload) => {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      forwardToOverlay("overlay:live-reply", {
        reqId: payload?.reqId || null,
        ok: false,
        text: "Bridge desconectado. Reconectá desde el tray.",
        reason: "bridge-offline",
        ts: Date.now(),
      });
      return;
    }
    const text = String(payload?.text || "").slice(0, 500);
    const reqId = String(payload?.reqId || `live-${Date.now()}`);
    ws.send(JSON.stringify({ type: "live-message", reqId, text }));
  } catch (e) {
    console.error("[Bridge] overlay:send-live-message fallo:", e?.message || e);
    forwardToOverlay("overlay:live-reply", {
      reqId: payload?.reqId || null,
      ok: false,
      text: "Error mandando el mensaje al cerebro.",
      reason: "send-error",
      ts: Date.now(),
    });
  }
});

// ─── Bridge 1.8.0 — Audio clip on-demand para Gemini Audio ─────────────────
// El server pide los últimos N segundos del master por la WS cuando el
// Pastor hace una pregunta musical/perceptual en el HUD. Acá hacemos puente:
//   server WS → main.js → captureWindow (encode) → main.js → server WS.
// La pregunta sigue volviendo como "live-reply" normal (con flag audioUsed).
ipcMain.on("bridge:audio-clip-reply", (_event, payload) => {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!payload || !payload.clipReqId) return;
    // Forwardear tal cual al server por la WS autenticada.
    ws.send(JSON.stringify({ type: "audio-clip-reply", ...payload }));
  } catch (e) {
    console.warn("[Bridge] audio-clip-reply forward falló:", e?.message || e);
  }
});

ipcMain.on("bridge:capture-error", (_event, msg) => {
  console.warn("[Bridge] Captura falló:", msg);
  lastCaptureError = msg;
  closeCaptureWindow();
  // Auto-restart: cubre el caso "Cubase cerró", "cambié de tarjeta de audio",
  // "Windows soltó el loopback". Tras N reintentos consecutivos sin éxito, paramos
  // y dejamos al usuario re-emparejar manualmente desde el tray.
  if (!isPaused && ws && ws.readyState === WebSocket.OPEN) {
    captureRestartCount += 1;
    if (captureRestartCount > CAPTURE_RESTART_MAX) {
      console.warn(`[Bridge] Captura ha fallado ${CAPTURE_RESTART_MAX} veces seguidas. Pausando reintentos.`);
      captureRestartCount = 0;
      return;
    }
    clearTimeout(captureRestartTimer);
    captureRestartTimer = setTimeout(() => {
      console.log(`[Bridge] Reintentando captura (intento ${captureRestartCount}/${CAPTURE_RESTART_MAX})…`);
      openCaptureWindow();
    }, CAPTURE_RESTART_MS);
  }
});

// ─── Ventana oculta de captura (Bridge 1) ───────────────────────
function openCaptureWindow() {
  if (captureWindow) return;
  if (!store.get("token")) return;
  if (isPaused) return;

  captureWindow = new BrowserWindow({
    width: 320,
    height: 240,
    show: false, // oculta — solo procesa audio en background
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Auto-aceptar la petición de captura del escritorio (sin diálogo de Windows
  // ni picker de Chromium — el usuario ya dio consentimiento al instalar el bridge)
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
      // Tomamos la pantalla principal; el audio que viaja con ella es el de TODO el sistema
      callback({ video: sources[0], audio: "loopback" });
    }).catch((err) => {
      console.warn("[Bridge] desktopCapturer error:", err.message);
      callback({});
    });
  });

  captureWindow.loadFile("capture.html");
  captureWindow.on("closed", () => { captureWindow = null; });

  // Debug: descomentar para ver logs de la captura
  // captureWindow.webContents.openDevTools({ mode: "detach" });
}

function closeCaptureWindow() {
  if (captureWindow) {
    try { captureWindow.close(); } catch {}
    captureWindow = null;
  }
}

// ─── Floating HUD overlay (ventana siempre-encima) ──────────────
// Pastor mezcla en Cubase fullscreen. Esta ventana flotante muestra LUFS, TP,
// observaciones y plugin crítico SIN sacarlo del DAW. READ-ONLY total.
// Pastor 26-may-2026: HUD v2 (Jarvis) + metrics strip integrado.
// Ancho fijo (480) — los modos compact/stadium siguen siendo opt-in.
// Altura redimensionable: min 540 (cabe header+strip+chat mínimo),
// max 1400 (cualquier monitor 1080p+ acepta), default 720.
const OVERLAY_DEFAULT = { width: 480, height: 720 };
const OVERLAY_COMPACT = { width: 320, height: 80 };
const OVERLAY_MIN_HEIGHT = 540;
const OVERLAY_MAX_HEIGHT = 1400;

function getOverlayBounds() {
  // Restaurar posición/tamaño si el usuario los movió. Si no hay nada guardado,
  // colocar en la esquina inferior-derecha del display primario.
  const saved = store.get("overlay") || {};
  const compact = !!saved.compact;
  // Altura persistida (el Pastor estiró el HUD hacia abajo) — clamped a min/max.
  const savedHeight = typeof saved.height === "number" && isFinite(saved.height)
    ? Math.max(OVERLAY_MIN_HEIGHT, Math.min(OVERLAY_MAX_HEIGHT, saved.height))
    : OVERLAY_DEFAULT.height;
  const size = compact
    ? { ...OVERLAY_COMPACT }
    : { width: OVERLAY_DEFAULT.width, height: savedHeight };
  let { x, y } = saved;

  // Default: esquina inferior-derecha del display primario.
  const wa = screen.getPrimaryDisplay().workArea;
  const defaultX = wa.x + wa.width - size.width - 24;
  const defaultY = wa.y + wa.height - size.height - 60;

  if (typeof x !== "number" || typeof y !== "number") {
    x = defaultX;
    y = defaultY;
  } else {
    // Validar que la posición guardada cae dentro de ALGÚN display actual.
    // Caso típico de "HUD invisible": el Pastor desconectó un monitor y la
    // posición guardada quedó en coords (-1920, 0) → ventana fuera de pantalla.
    const displays = screen.getAllDisplays();
    const visible = displays.some(d => {
      const a = d.workArea;
      return x + size.width > a.x + 20 &&
             x < a.x + a.width - 20 &&
             y + size.height > a.y + 20 &&
             y < a.y + a.height - 20;
    });
    if (!visible) {
      console.log("[Bridge] HUD bounds fuera de pantalla — reseteando a esquina");
      x = defaultX;
      y = defaultY;
    }
  }
  return { x, y, ...size, compact };
}

// Resetear posición del overlay (tray menu). Útil si el Pastor cambió de
// monitor o el HUD quedó atrapado fuera de pantalla.
function resetOverlayPosition() {
  const saved = store.get("overlay") || {};
  store.set("overlay", { ...saved, x: undefined, y: undefined });
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const b = getOverlayBounds();
    overlayWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    overlayWindow.show();
    overlayWindow.focus();
  } else {
    openOverlayWindow();
  }
}

function openOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    return;
  }
  const b = getOverlayBounds();
  // Pastor 26-may-2026: ahora redimensionable verticalmente.
  // Ancho fijo (min===max===480) para no romper layout del Jarvis HUD.
  // Alto entre 540 y 1400 — el Pastor estira hacia abajo para ver más chat.
  // En compact, las restricciones se relajan (el modo lo controla CSS).
  const isCompact = !!b.compact;
  overlayWindow = new BrowserWindow({
    x: b.x, y: b.y,
    width: b.width, height: b.height,
    minWidth: isCompact ? OVERLAY_COMPACT.width : OVERLAY_DEFAULT.width,
    maxWidth: isCompact ? OVERLAY_COMPACT.width : OVERLAY_DEFAULT.width,
    minHeight: isCompact ? OVERLAY_COMPACT.height : OVERLAY_MIN_HEIGHT,
    maxHeight: isCompact ? OVERLAY_COMPACT.height : OVERLAY_MAX_HEIGHT,
    frame: false,
    transparent: true,
    resizable: !isCompact,        // sólo el modo expandido se estira
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,           // no contamina el alt-tab del Pastor
    alwaysOnTop: true,           // siempre encima de Cubase
    hasShadow: false,            // sombra propia del CSS
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // crítico: si Cubase tiene foco, no congelar render
    },
  });
  // "floating" → encima incluso de apps fullscreen como Cubase
  overlayWindow.setAlwaysOnTop(true, "floating");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (b.compact) overlayWindow.webContents.once("did-finish-load", () => {
    overlayWindow.webContents.executeJavaScript('document.body.classList.add("compact")').catch(() => {});
  });
  // Pastor 25-may-2026 · graduación al Jarvis HUD v2 (interactivo).
  // El HUD v1 (overlay.html) era read-only. El v2 trae input de chat,
  // 7 estados visuales animados, glassmorphism, 3 modos de tamaño.
  // Si el v2 no carga por cualquier motivo, fallback al v1.
  const v2Path = path.join(__dirname, "overlay-v2", "index.html");
  const v1Path = path.join(__dirname, "overlay.html");
  const overlayFile = require("fs").existsSync(v2Path) ? v2Path : v1Path;
  overlayWindow.loadFile(overlayFile);

  // Push de estado actual al abrir + último snapshot de plugins (si lo hay)
  overlayWindow.webContents.once("did-finish-load", () => {
    forwardToOverlay("overlay:status", { connected: currentTrayState === "connected" });
    if (lastPluginChain) forwardToOverlay("overlay:plugins", lastPluginChain);
  });

  // Persistir posición + altura cuando el Pastor mueve o estira el HUD.
  // Altura se guarda sólo si NO está en compact (compact tiene tamaño fijo).
  const persist = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const [x, y] = overlayWindow.getPosition();
    const [, h] = overlayWindow.getSize();
    const saved = store.get("overlay") || {};
    const next = { ...saved, x, y };
    if (!saved.compact && h >= OVERLAY_MIN_HEIGHT && h <= OVERLAY_MAX_HEIGHT) {
      next.height = h;
    }
    store.set("overlay", next);
  };
  overlayWindow.on("move", persist);
  overlayWindow.on("moved", persist);
  overlayWindow.on("resize", persist);   // Pastor estira hacia abajo
  overlayWindow.on("resized", persist);
  overlayWindow.on("closed", () => {
    overlayWindow = null;
    rebuildMenu(currentTrayState);
  });
}

function closeOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.close(); } catch {}
  }
  overlayWindow = null;
}

function toggleOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    closeOverlayWindow();
  } else {
    openOverlayWindow();
  }
  rebuildMenu(currentTrayState);
}

function toggleOverlayCompact() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const saved = store.get("overlay") || {};
  const nextCompact = !saved.compact;
  // Si vuelve a expandido, restaurar la altura que el Pastor había estirado.
  const expandedHeight = typeof saved.height === "number" && isFinite(saved.height)
    ? Math.max(OVERLAY_MIN_HEIGHT, Math.min(OVERLAY_MAX_HEIGHT, saved.height))
    : OVERLAY_DEFAULT.height;
  const size = nextCompact
    ? { ...OVERLAY_COMPACT }
    : { width: OVERLAY_DEFAULT.width, height: expandedHeight };

  // CRÍTICO: actualizar min/max/resizable ANTES de setSize — si no, los límites
  // viejos clamean el nuevo tamaño y queda atascado en el rango incorrecto.
  if (nextCompact) {
    overlayWindow.setResizable(false);
    overlayWindow.setMinimumSize(OVERLAY_COMPACT.width, OVERLAY_COMPACT.height);
    overlayWindow.setMaximumSize(OVERLAY_COMPACT.width, OVERLAY_COMPACT.height);
  } else {
    overlayWindow.setMinimumSize(OVERLAY_DEFAULT.width, OVERLAY_MIN_HEIGHT);
    overlayWindow.setMaximumSize(OVERLAY_DEFAULT.width, OVERLAY_MAX_HEIGHT);
    overlayWindow.setResizable(true);
  }
  overlayWindow.setSize(size.width, size.height);

  // HUD v2 usa body[data-mode="..."]; HUD v1 usaba body.compact. Setear ambos
  // para que el toggle funcione en cualquier versión cargada.
  overlayWindow.webContents.executeJavaScript(
    nextCompact
      ? 'document.body.classList.add("compact"); document.body.dataset.mode="compact";'
      : 'document.body.classList.remove("compact"); document.body.dataset.mode="expanded";'
  ).catch(() => {});
  store.set("overlay", { ...saved, compact: nextCompact });
}

// Bridge 1.9.0 — añadir relay de style-tag-reply desde la WS del server al overlay.
// Se llama desde el handler central de ws.on("message") más abajo.
function relayStyleTagReply(msg) {
  forwardToOverlay("overlay:style-tag-reply", {
    reqId: msg?.reqId || null,
    ok: !!msg?.ok,
    style: msg?.style || null,
    reference: msg?.reference || null,
    character: msg?.character || null,
    reason: msg?.reason || null,
  });
}

function forwardToOverlay(channel, payload) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.webContents.send(channel, payload); } catch {}
  }
}

// ─── WebSocket al servidor ──────────────────────────────────────
function connect() {
  if (isPaused) return;
  const token = store.get("token");
  if (!token) {
    updateTrayState("disconnected");
    return;
  }

  console.log("[Bridge] Conectando a", WS_URL);
  ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);

  ws.on("open", () => {
    console.log("[Bridge] WebSocket abierto");
    reconnectDelay = RECONNECT_BASE_MS;
    captureRestartCount = 0;
    updateTrayState("connected");
    // CP5 — wire del canal WRITE (MIDI OUT). OFF por defecto hasta
    // que el server mande midi_config{enabled:true} desde /lab.
    try { bridgeWrite.attach(ws); } catch (e) { console.warn("[Bridge] bridgeWrite.attach:", e && e.message); }
    // Hello inicial con capabilities (seam para Bridge 2/3)
    ws.send(JSON.stringify({
      type: "hello",
      os: `${os.platform()} ${os.release()}`,
      daw: "Cubase", // TODO Bridge 3: detectar dinámicamente del parser .cpr
      bridgeVersion: BRIDGE_VERSION,
      capabilities: currentCapabilities(),
    }));
    // Ping periódico (mantiene last_seen + pong para latency)
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
      }
    }, PING_INTERVAL_MS);
    // Telemetría del proceso: CPU/RAM cada 60s — Pastor pidió monitoreo de recursos
    clearInterval(telemetryTimer);
    lastCpuSnapshot = process.cpuUsage();
    telemetryTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const delta = process.cpuUsage(lastCpuSnapshot);
      lastCpuSnapshot = process.cpuUsage();
      const mem = process.memoryUsage();
      // delta en microsegundos durante TELEMETRY_INTERVAL_MS → % aprox
      const cpuUserPct = (delta.user / 1000) / TELEMETRY_INTERVAL_MS * 100;
      const cpuSystemPct = (delta.system / 1000) / TELEMETRY_INTERVAL_MS * 100;
      ws.send(JSON.stringify({
        type: "telemetry",
        cpuUser: Math.round(cpuUserPct * 10) / 10,
        cpuSystem: Math.round(cpuSystemPct * 10) / 10,
        rss: Math.round(mem.rss / 1024 / 1024), // MB
      }));
    }, TELEMETRY_INTERVAL_MS);
    // Bridge 1: arrancar captura del master output
    openCaptureWindow();
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") {
        console.log("[Bridge] Bienvenido al servidor, hora servidor:", new Date(msg.serverTime).toISOString());
      } else if (msg.type === "observations" && Array.isArray(msg.obs)) {
        // Floating HUD: el server reenvía aquí las observaciones del Observation
        // Engine para que la ventana flotante las muestre encima de Cubase sin
        // requerir abrir el navegador.
        forwardToOverlay("overlay:observations", msg.obs);
      } else if (msg.type === "style-tag-reply") {
        // Bridge 1.9.0 — respuesta del STYLE/REFERENCE/CHARACTER pedido
        // desde el HUD overlay. El server llama coproductor-style.computeStyleTag()
        // y manda la respuesta por la misma WS. Reenviamos al overlay vía IPC.
        relayStyleTagReply(msg);
      } else if (msg.type === "live-reply") {
        // Pastor 25-may-2026 · respuesta del Live Copilot interactivo.
        // Vino por la misma WS del Bridge tras un live-message enviado
        // desde el HUD. La reenviamos al overlayWindow vía IPC.
        // 1.8.0+: agrega flag audioUsed (true si el cerebro escuchó los
        // últimos 10s de Cubase via Gemini Audio multimodal).
        forwardToOverlay("overlay:live-reply", {
          reqId: msg.reqId || null,
          ok: !!msg.ok,
          text: msg.text || "",
          reason: msg.reason || null,
          audioUsed: !!msg.audioUsed,
          ts: msg.ts || Date.now(),
        });
      } else if (msg.type === "midi_config" || msg.type === "midi_out") {
        // CP5 — delegado al módulo WRITE separado.
        try { bridgeWrite.handleServerMessage(msg); } catch (e) { console.warn("[Bridge WRITE] handle:", e && e.message); }
      } else if (msg.type === "audio-clip-request" && msg.clipReqId) {
        // 1.8.0 — el server pide los últimos N segundos del master para
        // mandárselos a Gemini Audio. Reenviamos a la ventana de captura
        // (la única que tiene el MediaRecorder con el buffer circular).
        try {
          if (captureWindow && !captureWindow.isDestroyed()) {
            captureWindow.webContents.send("bridge:request-audio-clip", {
              clipReqId: String(msg.clipReqId),
              durationSec: typeof msg.durationSec === "number" ? msg.durationSec : 10,
            });
          } else {
            // Captura cerrada → respondemos no-buffer al server para que no espere
            ws.send(JSON.stringify({
              type: "audio-clip-reply",
              clipReqId: String(msg.clipReqId),
              ok: false,
              reason: "capture-window-closed",
            }));
          }
        } catch (e) {
          console.warn("[Bridge] audio-clip-request handler:", e?.message || e);
        }
      }
    } catch {}
  });

  ws.on("close", (code, reason) => {
    const reasonStr = reason ? reason.toString() : "";
    console.log(`[Bridge] WebSocket cerrado (${code} ${reasonStr})`);
    clearInterval(pingTimer);
    pingTimer = null;
    clearInterval(telemetryTimer);
    telemetryTimer = null;
    clearTimeout(captureRestartTimer);
    captureRestartTimer = null;
    closeCaptureWindow();
    // CP5 — cerrar puerto MIDI al perder WS
    try { bridgeWrite.detach(); } catch {}
    updateTrayState(isPaused ? "paused" : "disconnected");

    // Anti ping-pong: si el servidor nos cerró por token inválido, fuimos
    // reemplazados por otro bridge, o el usuario revocó desde la web, NO
    // reintentamos. Eso evita duelos de reconexión con otro PC con el mismo token.
    const noReconnectReasons = ["invalid token", "missing token", "replaced", "revoked", "timeout"];
    if (code === 1008 || noReconnectReasons.some((r) => reasonStr.includes(r))) {
      console.log("[Bridge] Cierre permanente, no reintentar:", reasonStr);
      if (code === 1008 || reasonStr.includes("invalid token") || reasonStr.includes("revoked")) {
        store.delete("token"); // token muerto, fuerza re-emparejamiento manual
        updateTrayState("pairing");
      }
      return;
    }
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.warn("[Bridge] WebSocket error:", err.message);
    // El close handler ya manejará la reconexión
  });
}

// ─── Bridge 2: IPC local para VST3 Companion ────────────────────
function sendCapabilitiesUpdate() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "capabilities", capabilities: currentCapabilities() }));
  }
}

function startLocalIpcServer() {
  if (localIpcServer) return;
  localIpcServer = net.createServer((socket) => {
    // SEGURIDAD: aceptar SÓLO conexiones desde 127.0.0.1. createServer().listen()
    // ya escucha sólo loopback abajo, pero verificamos por defensa en profundidad.
    if (socket.remoteAddress && !socket.remoteAddress.includes("127.0.0.1") && socket.remoteAddress !== "::1") {
      console.warn("[Bridge IPC] Rechazado conexión no-loopback:", socket.remoteAddress);
      socket.destroy();
      return;
    }
    localIpcClients.add(socket);
    const wasFirst = localIpcClients.size === 1;
    console.log(`[Bridge IPC] VST3 Companion conectado (${localIpcClients.size} activo[s])`);
    if (wasFirst) sendCapabilitiesUpdate();

    // Buffer línea-por-línea (JSONL: un mensaje JSON por línea \n)
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (line.length > 64 * 1024) {  // protección anti-flood
          console.warn("[Bridge IPC] Línea descartada (>64KB)");
          continue;
        }
        try {
          const msg = JSON.parse(line);
          // Sólo aceptamos plugin-chain por ahora. READ-ONLY: nada de lo que llega
          // afecta a Cubase; sólo lo reenviamos al servidor para que el Coproductor
          // lo vea como contexto.
          if (msg.type === "plugin-chain" && ws && ws.readyState === WebSocket.OPEN && !isPaused) {
            const snap = {
              type: "plugins",
              ts: msg.ts ?? Date.now(),
              bus: msg.bus ?? "master",
              plugins: Array.isArray(msg.plugins) ? msg.plugins : [],
            };
            ws.send(JSON.stringify(snap));
            // Floating HUD: mostrar plugin crítico del master sin esperar al server
            lastPluginChain = snap;
            forwardToOverlay("overlay:plugins", snap);
          }
        } catch (err) {
          console.warn("[Bridge IPC] JSON inválido:", err.message);
        }
      }
    });

    socket.on("close", () => {
      localIpcClients.delete(socket);
      console.log(`[Bridge IPC] VST3 Companion desconectado (${localIpcClients.size} restante[s])`);
      if (localIpcClients.size === 0) sendCapabilitiesUpdate();
    });
    socket.on("error", (err) => {
      console.warn("[Bridge IPC] Socket error:", err.message);
    });
  });

  let ipcRetried = false;
  localIpcServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      if (ipcRetried) {
        console.warn(`[Bridge IPC] Puerto ${LOCAL_IPC_PORT} sigue ocupado tras intentar liberarlo — desisto.`);
        return;
      }
      ipcRetried = true;
      console.warn(`[Bridge IPC] Puerto ${LOCAL_IPC_PORT} ocupado — buscando zombie para liberarlo…`);
      const freed = killProcessOnPort(LOCAL_IPC_PORT);
      setTimeout(() => {
        try { localIpcServer.listen(LOCAL_IPC_PORT, LOCAL_IPC_HOST); } catch (e) {
          console.warn("[Bridge IPC] Retry listen falló:", e.message);
        }
      }, freed ? 1500 : 3000);
    } else {
      console.warn("[Bridge IPC] Server error:", err.message);
    }
  });

  localIpcServer.listen(LOCAL_IPC_PORT, LOCAL_IPC_HOST, () => {
    console.log(`[Bridge IPC] Esperando VST3 Companion en ${LOCAL_IPC_HOST}:${LOCAL_IPC_PORT} (READ-ONLY)`);
  });
}

function stopLocalIpcServer() {
  for (const s of localIpcClients) { try { s.destroy(); } catch {} }
  localIpcClients.clear();
  if (localIpcServer) {
    try { localIpcServer.close(); } catch {}
    localIpcServer = null;
  }
}

function disconnect() {
  clearInterval(pingTimer);
  pingTimer = null;
  clearInterval(telemetryTimer);
  telemetryTimer = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearTimeout(captureRestartTimer);
  captureRestartTimer = null;
  closeCaptureWindow();
  if (ws) {
    try { ws.removeAllListeners(); ws.close(); } catch {}
    ws = null;
  }
}

// ─── Repair flow — bajo demanda desde tray o /lab ──────────────
// Cierra todo, limpia caché de Electron, opcionalmente borra config y
// reinicia el proceso. Pensado para cuando algo se sintomatiza (no abre,
// no conecta, métricas en -99 dB) y el Pastor no quiere tocar Task Manager.
async function repairBridge({ wipeToken = false, silent = false } = {}) {
  if (!silent) {
    const opts = {
      type: "warning",
      buttons: wipeToken
        ? ["Reparar y desvincular", "Cancelar"]
        : ["Reparar (mantener vinculación)", "Cancelar"],
      defaultId: 0,
      cancelId: 1,
      title: "Reparar CUBI Bridge",
      message: wipeToken
        ? "Esto cerrará todo, borrará la configuración local, desvinculará el estudio del Coproductor y reiniciará el Bridge. Tendrás que generar un código nuevo en /lab para volver a vincular."
        : "Esto cerrará la conexión actual, limpiará la caché de Electron y reiniciará el Bridge. La vinculación con el Coproductor se mantiene.",
    };
    const result = await dialog.showMessageBox(opts);
    if (result.response !== 0) return false;
  }

  console.log(`[Bridge] Repair iniciado (wipeToken=${wipeToken})`);

  try {
    disconnect();
    stopLocalIpcServer();
    closeCaptureWindow();
    closeOverlayWindow();
    if (pairingWindow && !pairingWindow.isDestroyed()) {
      try { pairingWindow.close(); } catch {}
    }
  } catch (e) {
    console.warn("[Bridge] repair cleanup falló:", e.message);
  }

  // Limpia caché de Electron (cookies/cache/serviceworkers/etc) — el token vive en electron-store, NO acá.
  try {
    const sess = session.defaultSession;
    await sess.clearCache();
    await sess.clearStorageData({
      storages: ["serviceworkers", "shadercache", "cachestorage", "websql", "filesystem"],
    });
  } catch (e) {
    console.warn("[Bridge] clearCache falló:", e.message);
  }

  if (wipeToken) {
    try { store.clear(); } catch (e) { console.warn("[Bridge] store.clear falló:", e.message); }
  } else {
    // Deny-list: borrar SOLO flags transitorios conocidos. Si una versión futura
    // agrega settings persistentes, sobreviven al repair sin tocar este código.
    const TRANSIENT_KEYS = ["hudFirstShown", "__health_probe__"];
    for (const k of TRANSIENT_KEYS) {
      try { store.delete(k); } catch {}
    }
  }

  // Mata cualquier Bridge zombie hermano que pueda estar reteniendo el lock futuro
  killZombieBridges();
  killProcessOnPort(LOCAL_IPC_PORT);

  // Borra el PID file viejo para no confundir al próximo arranque
  try { fs.unlinkSync(PID_FILE); } catch {}

  console.log("[Bridge] Repair completo — relanzando…");
  setTimeout(() => {
    try {
      app.relaunch();
      app.exit(0);
    } catch (e) {
      console.error("[Bridge] relaunch falló:", e.message);
      app.exit(1);
    }
  }, 500);
  return true;
}

ipcMain.handle("bridge:repair", async (_e, opts) => {
  try {
    const ok = await repairBridge(opts || {});
    return { ok };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Crash recovery — si una excepción no capturada llega al main process,
// loguear y relanzar suave en vez de morir en silencio dejando al Pastor
// sin HUD ni tray.
let crashRecoveryFired = false;
process.on("uncaughtException", (err) => {
  console.error("[Bridge] uncaughtException:", err);
  if (crashRecoveryFired) return;
  crashRecoveryFired = true;
  try {
    disconnect();
    stopLocalIpcServer();
  } catch {}
  setTimeout(() => {
    try {
      app.relaunch();
      app.exit(1);
    } catch {
      process.exit(1);
    }
  }, 1000);
});
process.on("unhandledRejection", (err) => {
  console.error("[Bridge] unhandledRejection:", err);
});

function scheduleReconnect() {
  if (isPaused) return;
  if (!store.get("token")) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect();
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }, reconnectDelay);
  console.log(`[Bridge] Reintentando en ${reconnectDelay / 1000}s`);
}

// ─── Single-instance + recovery de zombie lock ──────────────────
// Si el Pastor hace doble-click al shortcut "Mostrar HUD CUBI" mientras el
// Bridge ya corre en tray, el segundo proceso muere y nos manda sus argv para
// que el proceso vivo reaccione (toggle del HUD).
//
// HARDENING v1.6.0: si el lock lo tiene un proceso ZOMBIE (Electron crasheado
// sin liberar el lock, lo más común tras un Windows update o un OOM del DAW),
// detectamos vía PID file que el dueño está muerto, lo matamos con taskkill
// y reintentamos el lock UNA vez. Si aún falla, asumimos otra instancia viva
// legítima y salimos en silencio.
let gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  const otherPid = readPidFile();
  const otherAlive = isPidAlive(otherPid);
  if (!otherAlive) {
    console.warn(`[Bridge] Lock retenido por proceso zombie (PID ${otherPid ?? "?"} muerto). Recuperando…`);
    killZombieBridges();
    // Esperita corta para que Windows libere el lock del proceso muerto
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) { /* busy wait — único caso de uso */ }
    gotSingleInstanceLock = app.requestSingleInstanceLock();
    if (gotSingleInstanceLock) {
      console.log("[Bridge] Lock recuperado tras matar zombie — continuando arranque.");
    }
  }
}
if (!gotSingleInstanceLock) {
  console.log("[Bridge] Otra instancia ya corre — saliendo.");
  app.quit();
} else {
  // Heartbeat: regrabar el PID cada 30s para que un Bridge futuro pueda
  // detectar staleness (timestamp viejo + PID muerto = zombie a matar).
  writePidFile();
  setInterval(writePidFile, 30000);

  app.on("second-instance", (_event, argv) => {
    try {
      if (argv.includes("--toggle-hud")) {
        toggleOverlay();
      } else if (argv.includes("--show-hud")) {
        openOverlayWindow();
        rebuildMenu(currentTrayState);
      } else if (argv.includes("--hide-hud")) {
        closeOverlayWindow();
        rebuildMenu(currentTrayState);
      }
    } catch (e) {
      console.warn("[Bridge] second-instance handler:", e.message);
    }
  });

  // Si arrancamos con --toggle-hud/--show-hud (caso raro: el shortcut corre
  // antes de que haya una instancia viva), abrimos el overlay tras whenReady.
  const argv = process.argv.slice(1);
  if (argv.includes("--toggle-hud") || argv.includes("--show-hud")) {
    app.whenReady().then(() => {
      setTimeout(() => openOverlayWindow(), 500);
    });
  }
}

// ─── Ciclo de vida ──────────────────────────────────────────────
app.whenReady().then(() => {
  tray = new Tray(makeTrayIcon("#ef4444"));
  updateTrayState(store.get("token") ? "disconnected" : "pairing");

  // Bridge 2: abrir puerto IPC local (READ-ONLY) para el VST3 Companion
  startLocalIpcServer();

  // Auto-launch on boot — primera vez en TRUE, después respeta el toggle
  ensureAutoLaunchDefault();

  // Si no hay token al arrancar, abrir ventana de emparejamiento (a menos que
  // hayamos arrancado oculto desde el login item — en ese caso esperamos a
  // que el Pastor haga click derecho en el tray).
  // Detección portable Windows: arg --hidden inyectado por setLoginItemSettings.
  const launchedHidden = process.argv.includes("--hidden");
  if (!store.get("token") && !launchedHidden) {
    openPairingWindow();
  } else if (store.get("token")) {
    connect();
    // BRIDGE 1.9.1 — Auto-abrir HUD flotante cuando arrancamos NORMAL
    // (no oculto desde el login item). Esto cubre el caso post-instalador:
    // NSIS termina con runAfterFinish:true → el Bridge arranca SIN --hidden
    // → el Pastor ve el HUD aparecer solo, no queda "perdido en el tray".
    // Si arrancó con --hidden (boot del PC), respetamos y dejamos el tray frío
    // hasta que el Pastor haga click derecho → Mostrar HUD.
    if (!launchedHidden) {
      setTimeout(() => openOverlayWindow(), 800);
    }
  }

  // Auto-updater desactivado en v1.4.0 (Install Kit v3 — sin GitHub Releases).
  // Si en el futuro queremos reactivarlo: descomentar el require de electron-updater
  // arriba + setupAutoUpdater() + los setInterval. El protocolo del autoUpdater
  // queda intacto en el resto del archivo por si necesitamos volver.
});

app.on("window-all-closed", (e) => {
  // No salir cuando se cierran las ventanas — quedamos en tray
  e.preventDefault?.();
});

app.on("before-quit", () => {
  disconnect();
  stopLocalIpcServer();
  clearInterval(updateCheckTimer);
  updateCheckTimer = null;
});
