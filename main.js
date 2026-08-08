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
const bridgeReaper = require("./bridge-reaper");
// Etapa 0 del Motor VST — Inventario de Plugins (READ-ONLY del disco:
// encuentra, reconoce y registra; nunca mueve, copia ni carga plugins).
const pluginInventory = require("./plugin-inventory");
const { createReaStreamReceiver } = require("./reastream-receiver");
const vstHandsPoc = require("./vst-hands-poc");
// Biblioteca de Cadenas + render remoto (Mesa → Bridge → REAPER → Mesa)
const { createFxChainLibrary } = require("./fx-chain-library");
const bridgeRender = require("./bridge-render");

// Biblioteca viva de FX Chains: escanea/vigila la carpeta de REAPER y
// publica NOMBRES por la WS (jamás contenido — presets privados del Pastor).
const fxChainLibrary = createFxChainLibrary({
  dir: vstHandsPoc.fxChainsDir(),
  onChange: (chains) => sendFxChains(chains),
  log: (...a) => console.log("[FxChains]", ...a),
});
function sendFxChains(chains) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: "fx-chains", chains: chains || fxChainLibrary.list() })); } catch {}
  }
}

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

// Etapa 0 Motor VST — Inventario de Plugins: IPC + persistencia local.
// sendWs entrega el catálogo por la WS autenticada cuando está viva.
pluginInventory.init({
  store,
  sendWs: (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
    }
    return false;
  },
});

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

// Bridge 1.15.0 — último motivo de desconexión, en español, para que el HUD
// muestre POR QUÉ se cortó (reemplazado / red / token / timeout) en vez de un
// 🔴 mudo. Se limpia al reconectar (ws.on("open")).
let lastDisconnectReason = null;

function humanDisconnectReason(code, reasonStr) {
  const r = (reasonStr || "").toLowerCase();
  if (r.includes("replaced")) return "Otra instancia tomó tu conexión (¿el Bridge quedó abierto dos veces o en otra PC?)";
  if (r.includes("revoked")) return "Acceso revocado desde la web — volvé a emparejar";
  if (r.includes("invalid token")) return "Token inválido — volvé a emparejar";
  if (r.includes("missing token")) return "Falta el token — volvé a emparejar";
  if (r.includes("timeout")) return "El servidor dejó de recibir tu señal (timeout)";
  if (code === 1006) return "Se cortó la red o el servidor (cierre abrupto)";
  if (code === 1001) return "El servidor se está reiniciando";
  if (reasonStr) return reasonStr.slice(0, 200);
  return "Motivo desconocido (código " + code + ")";
}

// Bridge 1.10.0 — audio inputs reportados por capture.html (post-permiso).
// El submenu "🎤 Fuente de audio" se construye desde este cache.
let cachedAudioInputs = [];

function updateTrayState(state /* "connected" | "disconnected" | "paused" | "pairing" */) {
  if (!tray) return;
  const prevState = currentTrayState;
  currentTrayState = state;
  // Mantener el overlay al tanto del estado de conexión (punto verde/rojo)
  // Bridge 1.15.0 — adjuntamos el motivo del corte para que el HUD lo muestre.
  // Solo el corte real ("disconnected") lleva motivo; pausa/emparejamiento no
  // son cortes, así no queda un motivo viejo "pegado" en esos estados.
  forwardToOverlay("overlay:status", {
    connected: state === "connected",
    reason: state === "disconnected" ? lastDisconnectReason : null,
  });

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

  // Bridge 1.10.0 — submenu de fuente de audio. Lista poblada por capture.html
  // tras pedir permiso (labels llegan post-getUserMedia). "Default" mantiene el
  // comportamiento pre-1.10 (WASAPI loopback del default playback de Windows).
  const currentAudioId = store.get("audioInputDeviceId") || null;
  const audioInputsSubmenu = [
    {
      label: "🔁 Default del sistema (WASAPI loopback)",
      type: "radio",
      checked: !currentAudioId,
      click: () => selectAudioInput(null, null),
    },
    {
      // PoC Gateway (Pastor 8-ago-2026): oír el master de Cubase DIRECTO por
      // el plugin ReaStream (UDP 58710) — sin VoiceMeeter, nivel real pre-Windows.
      label: REASTREAM_LABEL + " — sin VoiceMeeter",
      type: "radio",
      checked: currentAudioId === REASTREAM_DEVICE_ID,
      click: () => selectAudioInput(REASTREAM_DEVICE_ID, REASTREAM_LABEL),
    },
    { type: "separator" },
  ];
  if (cachedAudioInputs.length === 0) {
    audioInputsSubmenu.push({
      label: "(Enumerando devices… reabre el menú en 3s)",
      enabled: false,
    });
  } else {
    for (const d of cachedAudioInputs) {
      const lbl = (d.label || d.deviceId || "device sin nombre").slice(0, 70);
      audioInputsSubmenu.push({
        label: lbl,
        type: "radio",
        checked: currentAudioId === d.deviceId,
        click: () => selectAudioInput(d.deviceId, d.label),
      });
    }
  }

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
    {
      // Pastor 28-may-2026 — Atajo directo al CUBI Lab desde el tray.
      // Mismo target que el botón "🎛 Abrir LAB completo" del HUD, pero
      // accesible sin necesidad de tener el HUD visible. Abre en el browser
      // default del Pastor (no en Electron) — el Lab es la web completa.
      label: "🧪 Abrir CUBI Lab",
      click: () => { shell.openExternal(`${SERVER_URL}/lab`); },
    },
    { type: "separator" },
    {
      label: hasToken ? "Re-emparejar estudio…" : "Emparejar estudio…",
      click: () => openPairingWindow(),
    },
    {
      label: "🧰 Inventario de Plugins…",
      click: () => { try { pluginInventory.openInventoryWindow(); } catch (e) { console.warn("[Bridge] inventario:", e.message); } },
    },
    {
      // PoC "Las Manos" (Pastor 8-ago-2026): WAV → plugin real (vía REAPER
      // batchconvert, Plan B de la visión Motor VST) → WAV procesado.
      label: "✋ PoC Manos: procesar WAV con mis plugins…",
      click: () => { vstHandsPoc.runHandsPoc({ dialog, shell, Notification }); },
    },
    {
      label: isPaused ? "▶ Reanudar observación" : "⏸ Pausar observación",
      enabled: hasToken,
      click: () => togglePause(),
    },
    {
      label: "🎤 Fuente de audio",
      enabled: hasToken,
      submenu: audioInputsSubmenu,
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
  if (tray) tray.setContextMenu(menu);
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

// ─── Pastor 28-may-2026 — Shortcut "CUBI Lab" en escritorio ─────
// Crea un .url (Windows Internet Shortcut) la primera vez que arranca el
// Bridge. El Pastor entonces tiene 2 accesos al Lab:
//   1. Tray menu → "🧪 Abrir CUBI Lab"
//   2. Doble-click en el .url del escritorio
// Ambos abren la URL en el browser default — el Lab es la web completa.
// .url es nativo de Windows (archivo INI), no requiere deps externas ni
// shell.writeShortcutLink (que requiere target ejecutable, no URL).
function ensureLabDesktopShortcut() {
  if (process.platform !== "win32") return;
  if (store.get("labShortcutCreated")) return;
  try {
    const desktopPath = app.getPath("desktop");
    const urlFile = path.join(desktopPath, "CUBI Lab.url");
    if (fs.existsSync(urlFile)) {
      store.set("labShortcutCreated", true);
      return;
    }
    // Formato INI estándar de Windows. CRLF obligatorio para que el shell
    // de Windows lo reconozca como Internet Shortcut válido.
    const content = `[InternetShortcut]\r\nURL=${SERVER_URL}/lab\r\nIconIndex=0\r\n`;
    fs.writeFileSync(urlFile, content, "utf8");
    store.set("labShortcutCreated", true);
    console.log("[Bridge] CUBI Lab.url creado en escritorio.");
  } catch (err) {
    // No-fatal — el tray menu sigue funcionando aunque falle el escritorio.
    console.warn("[Bridge] No se pudo crear shortcut Lab:", err?.message || err);
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

// Bridge 1.15.0 — Fuente activa / Estado de captura.
// capture.html reporta qué device está escuchando de verdad (label del track)
// y en qué modo (chosen/fallback/loopback). Lo guardamos para que un HUD que
// se abre después pueda pedirlo (overlay:get-capture-source) y lo reenviamos
// en vivo. READ-ONLY local — nunca va al server.
let lastCaptureSource = null;
ipcMain.on("bridge:capture-source", (_event, info) => {
  lastCaptureSource = info || null;
  forwardToOverlay("overlay:capture-source", lastCaptureSource);
});
ipcMain.handle("overlay:get-capture-source", () => lastCaptureSource);

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
// Pastor 27-may-2026 — minimizar real del HUD flotante.
// hide() conserva DOM/historial/scroll. Reabrir desde el tray reutiliza
// esta misma window (openOverlayWindow ya hace .show() si existe).
// Diferencia con overlay:close: close DESTRUYE la ventana y borra el chat
// de la sesión; minimize sólo la oculta.
ipcMain.on("overlay:minimize", () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.hide(); } catch {}
    rebuildMenu(currentTrayState);
  }
});
ipcMain.on("overlay:toggle-compact", () => {
  toggleOverlayCompact();
});

// Pastor 28-may-2026 — Refrescar el HUD sin perder pairing/token/WS.
// reloadIgnoringCache() recarga el bundle del overlay-v2 (HTML/CSS/JS)
// pero la ventana es la misma → posición, modo compacto y la WS del
// Bridge sobreviven. Sirve cuando el chat se queda colgado o la UI quedó
// en estado raro tras una hora de uso, sin tener que cerrar y re-emparejar.
ipcMain.on("overlay:reload", () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.webContents.reloadIgnoringCache(); } catch {}
  }
});

// Pastor 28-may-2026 — Reset conversacional: forward por WS al server.
// El server wipea el ring buffer del anti-repetición para este userId y
// nos devuelve {type:"live-reset-reply"}, que reenviamos al overlay como
// "overlay:reset-reply" para que la preload Promise resuelva.
ipcMain.on("overlay:reset-conversation", (_event, payload) => {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      forwardToOverlay("overlay:reset-reply", {
        reqId: payload?.reqId || null,
        ok: false,
        reason: "bridge-offline",
      });
      return;
    }
    const reqId = String(payload?.reqId || `reset-${Date.now()}`);
    ws.send(JSON.stringify({ type: "live-reset", reqId }));
  } catch (e) {
    console.error("[Bridge] overlay:reset-conversation falló:", e?.message || e);
    forwardToOverlay("overlay:reset-reply", {
      reqId: payload?.reqId || null,
      ok: false,
      reason: "send-error",
    });
  }
});

// 4-ago-26 · Manos del HUD: el Pastor aprobó (o deshace) una tarjeta de
// propuesta. Reenviamos por la WS autenticada; la respuesta vuelve como
// apply-macro-reply y se forwardea al overlay más abajo.
ipcMain.on("overlay:apply-macro", (_event, payload) => {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      forwardToOverlay("overlay:apply-macro-reply", {
        reqId: payload?.reqId || null,
        ok: false,
        error: "Bridge desconectado. Reconectá desde el tray.",
      });
      return;
    }
    ws.send(JSON.stringify({
      type: "apply-macro",
      reqId: String(payload?.reqId || `apply-${Date.now()}`),
      action: payload?.action === "undo_macro" ? "undo_macro" : "set_macro",
      macro: String(payload?.macro || "").slice(0, 64),
      value: typeof payload?.value === "number" ? payload.value : undefined,
    }));
  } catch (e) {
    console.error("[Bridge] overlay:apply-macro falló:", e?.message || e);
    forwardToOverlay("overlay:apply-macro-reply", {
      reqId: payload?.reqId || null,
      ok: false,
      error: "Error enviando la orden al servidor.",
    });
  }
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

// Pastor 02-jun-2026 · Micrófono del HUD → texto.
// El overlay graba la voz del Pastor (WebM/Opus base64) y la manda acá; la
// reenviamos al server por la misma WS autenticada. La respuesta vuelve como
// msg.type === "live-transcribe-reply" (handler de ws.on("message") más abajo)
// y se reenvía al overlayWindow por IPC ("overlay:transcribe-reply").
ipcMain.on("overlay:transcribe-voice", (_event, payload) => {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      forwardToOverlay("overlay:transcribe-reply", {
        reqId: payload?.reqId || null,
        ok: false,
        text: "",
        reason: "bridge-offline",
        ts: Date.now(),
      });
      return;
    }
    const reqId = String(payload?.reqId || `voice-${Date.now()}`);
    const audio = String(payload?.audio || "");
    const mimeType = String(payload?.mimeType || "audio/webm");
    ws.send(JSON.stringify({ type: "live-transcribe", reqId, audio, mimeType }));
  } catch (e) {
    console.error("[Bridge] overlay:transcribe-voice fallo:", e?.message || e);
    forwardToOverlay("overlay:transcribe-reply", {
      reqId: payload?.reqId || null,
      ok: false,
      text: "",
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

// ─── Bridge 1.10.0 — Audio input device picker ─────────────────
// Permite elegir un device específico (Voicemeeter Output VAIO/AUX, focusrite
// input loop, etc.) cuando la cadena DAW→speakers bypassea el Windows audio
// engine y el default loopback queda en silencio (-106 LUFS / "EN REPOSO").
// Persistencia en electron-store; al cambiar, reciclamos la captura.
ipcMain.handle("bridge:get-audio-config", () => ({
  deviceId: store.get("audioInputDeviceId") || null,
  label: store.get("audioInputLabel") || null,
}));

ipcMain.on("bridge:audio-inputs", (_e, list) => {
  if (!Array.isArray(list)) return;
  cachedAudioInputs = list
    .filter((d) => d && d.deviceId && d.kind === "audioinput")
    .map((d) => ({
      deviceId: d.deviceId,
      label: d.label || "",
      groupId: d.groupId || "",
      kind: d.kind,
    }));
  try { rebuildMenu(currentTrayState); } catch (e) { console.warn("[Bridge] rebuildMenu post-inputs falló:", e.message); }
  // Bridge 1.10.1 — forward al HUD para el selector inline (sustituye al tray
  // cuando Windows no dibuja el icono).
  forwardToOverlay("overlay:audio-inputs", {
    inputs: inputsForPicker(),
    selected: {
      deviceId: store.get("audioInputDeviceId") || null,
      label: store.get("audioInputLabel") || null,
    },
  });
});

// Bridge 1.10.1 — IPC handlers del selector dentro del HUD.
ipcMain.handle("overlay:get-audio-state", () => ({
  inputs: inputsForPicker(),
  selected: {
    deviceId: store.get("audioInputDeviceId") || null,
    label: store.get("audioInputLabel") || null,
  },
}));
ipcMain.on("overlay:select-audio-input", (_e, payload) => {
  const deviceId = payload && payload.deviceId ? String(payload.deviceId) : null;
  const label = payload && payload.label ? String(payload.label) : null;
  selectAudioInput(deviceId, label);
  // Re-emitir estado al HUD para que el dropdown refleje el cambio.
  forwardToOverlay("overlay:audio-inputs", {
    inputs: inputsForPicker(),
    selected: {
      deviceId: store.get("audioInputDeviceId") || null,
      label: store.get("audioInputLabel") || null,
    },
  });
});

// ─── PoC ReaStream (Gateway sin VoiceMeeter) ────────────────────
// Pseudo-fuente "reastream": en vez de getUserMedia, el main abre un socket
// UDP (receptor aislado en reastream-receiver.js) y le pasa el PCM a la
// ventana de captura por IPC. Todo lo demás (medidor, ring, clip, WS) intacto.
const REASTREAM_DEVICE_ID = "reastream";
const REASTREAM_LABEL = "🎛 ReaStream (master de Cubase)";
let reaStreamReceiver = null;

function syncReaStreamReceiver() {
  const wanted = store.get("audioInputDeviceId") === REASTREAM_DEVICE_ID && !!captureWindow;
  if (wanted && !reaStreamReceiver) {
    reaStreamReceiver = createReaStreamReceiver({
      onPcm: (mono, sampleRate) => {
        if (!captureWindow) return;
        try {
          captureWindow.webContents.send("bridge:reastream-pcm", {
            pcm: Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength),
            sampleRate,
          });
        } catch {}
      },
      onStatus: (status) => {
        // El HUD ya muestra "Fuente activa"; acá solo dejamos rastro en consola.
        console.log("[Bridge] ReaStream status: " + status);
      },
      log: console.log,
    });
    reaStreamReceiver.start();
  } else if (!wanted && reaStreamReceiver) {
    try { reaStreamReceiver.stop(); } catch {}
    reaStreamReceiver = null;
  }
}

// La pseudo-fuente debe aparecer también en el selector del HUD (no solo tray).
function inputsForPicker() {
  return [
    { deviceId: REASTREAM_DEVICE_ID, label: REASTREAM_LABEL + " — sin VoiceMeeter", groupId: "", kind: "audioinput" },
    ...cachedAudioInputs,
  ];
}

// ─── Detección + guía de instalación de ReaStream (Pastor 8-ago-2026) ──────
// Cockos NO permite redistribuir ReaPlugs sin acuerdo firmado, así que el
// Bridge detecta el plugin y, si falta, lleva a la descarga OFICIAL de Cockos
// (nunca copias de terceros). Tras instalar, lo detecta solo y guía al master.
const REAPLUGS_OFFICIAL_URL = "https://www.cockos.com/reaper/reaplugs/";
const REASTREAM_DLL_RE = /^reastream.*\.(dll|vst3)$/i;

function reaStreamCandidateDirs() {
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    path.join(pf, "VSTPlugins"),
    path.join(pf86, "VSTPlugins"),
    path.join(pf, "Steinberg", "VstPlugins"),
    path.join(pf, "Steinberg", "VSTPlugins"),
    path.join(pf86, "Steinberg", "VstPlugins"),
    path.join(pf86, "Steinberg", "VSTPlugins"),
    path.join(pf, "Common Files", "VST2"),
    path.join(pf, "Common Files", "Steinberg", "VST2"),
    path.join(pf, "Common Files", "VST3"),
  ];
}

// Busca reastream*.dll con profundidad acotada (los VST folders pueden ser
// enormes; ReaPlugs instala en <root>\ReaPlugs\, así que 3 niveles sobran).
function scanForReaStream(dirs, depth = 3) {
  for (const dir of dirs) {
    const hit = scanDirForReaStream(dir, depth);
    if (hit) return hit;
  }
  return null;
}

function scanDirForReaStream(dir, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isFile() && REASTREAM_DLL_RE.test(e.name)) return path.join(dir, e.name);
  }
  if (depth <= 1) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = scanDirForReaStream(path.join(dir, e.name), depth - 1);
    if (hit) return hit;
  }
  return null;
}

function detectReaStreamPlugin() {
  if (process.platform !== "win32") return null;
  return scanForReaStream(reaStreamCandidateDirs());
}

const CUBASE_MASTER_GUIDE =
  "En Cubase: abra el canal Stereo Out (master) → Inserts → agregue \"ReaStream\" → " +
  "dentro del plugin elija \"Send audio/MIDI\" y destino \"* local broadcast\". " +
  "Reproduzca algo y el Bridge lo oirá al nivel real.";

let reaStreamInstallPoll = null;

function stopReaStreamInstallPoll() {
  if (reaStreamInstallPoll) { clearInterval(reaStreamInstallPoll); reaStreamInstallPoll = null; }
}

function notifyReaStream(title, body) {
  try { new Notification({ title, body }).show(); } catch (e) { console.warn("[Bridge] Notification falló:", e.message); }
}

// Vigila hasta 10 min tras abrir la descarga oficial; al detectar el .dll
// instalado, avisa solo y da el paso siguiente (master de Cubase).
function startReaStreamInstallPoll() {
  stopReaStreamInstallPoll();
  const startedAt = Date.now();
  reaStreamInstallPoll = setInterval(() => {
    const hit = detectReaStreamPlugin();
    if (hit) {
      stopReaStreamInstallPoll();
      console.log("[Bridge] ReaStream detectado: " + hit);
      notifyReaStream("ReaStream detectado ✓", "Instalación correcta. " + CUBASE_MASTER_GUIDE);
      return;
    }
    if (Date.now() - startedAt > 10 * 60 * 1000) {
      stopReaStreamInstallPoll();
      notifyReaStream(
        "ReaStream aún no aparece",
        "Si ya lo instaló, reinicie el Bridge. Si no, la fuente ReaStream quedará esperando al plugin."
      );
    }
  }, 5000);
}

// Al ELEGIR la fuente ReaStream: detectar → guiar (o llevar a descarga oficial).
async function guideReaStreamSetup() {
  if (process.platform !== "win32") return;
  const hit = detectReaStreamPlugin();
  if (hit) {
    console.log("[Bridge] ReaStream ya instalado: " + hit);
    notifyReaStream("ReaStream listo ✓", CUBASE_MASTER_GUIDE);
    return;
  }
  try {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Falta el plugin ReaStream",
      message: "Para oír el master de Cubase al nivel real, falta instalar ReaStream (gratuito, de Cockos).",
      detail:
        "Por licencia no podemos incluirlo en el instalador, pero la descarga oficial es segura y de un paso:\n\n" +
        "1) Descargue \"ReaPlugs VST 64-bit\" del sitio oficial de Cockos.\n" +
        "2) Instálelo con las opciones por defecto (siguiente → siguiente).\n\n" +
        "El Bridge lo detectará solo apenas termine y le dirá el paso siguiente.",
      buttons: ["Descargar del sitio oficial (Cockos)", "Ya lo tengo instalado", "Ahora no"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) {
      try { shell.openExternal(REAPLUGS_OFFICIAL_URL); } catch {}
      startReaStreamInstallPoll();
    } else if (response === 1) {
      // Dice que ya está pero no lo vimos en las carpetas VST estándar:
      // seguimos vigilando por si vive en una ruta no estándar recién agregada.
      notifyReaStream(
        "No encontramos ReaStream todavía",
        "Buscamos en las carpetas VST estándar. Si lo instaló en otra ruta, Cubase igual lo cargará — siga con el master. " + CUBASE_MASTER_GUIDE
      );
      startReaStreamInstallPoll();
    }
  } catch (e) {
    console.warn("[Bridge] guía ReaStream falló:", e.message);
  }
}

function selectAudioInput(deviceId, label) {
  if (deviceId === REASTREAM_DEVICE_ID) {
    // Guía sin bloquear el switch de fuente (el receptor UDP arranca igual).
    setTimeout(() => { guideReaStreamSetup(); }, 200);
  } else {
    stopReaStreamInstallPoll();
  }
  if (deviceId) {
    store.set("audioInputDeviceId", deviceId);
    store.set("audioInputLabel", label || deviceId);
    console.log("[Bridge] Audio source → " + (label || deviceId));
  } else {
    store.delete("audioInputDeviceId");
    store.delete("audioInputLabel");
    console.log("[Bridge] Audio source → default WASAPI loopback");
  }
  // Reciclar la captura para que tome el nuevo device.
  // capture.html releerá la config al cargar vía bridge:get-audio-config.
  closeCaptureWindow();
  setTimeout(() => { try { openCaptureWindow(); } catch (e) { console.warn("[Bridge] openCaptureWindow tras switch falló:", e.message); } }, 400);
  try { rebuildMenu(currentTrayState); } catch {}
}

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
      // Bridge 1.10.0 — partition dedicada. Los handlers de permisos/display
      // (auto-aprobación de "media" + loopback de escritorio) viven SOLO en
      // esta session — no se aplican a pairingWindow ni a overlayWindow, que
      // siguen usando defaultSession con el prompt nativo de Electron.
      partition: "persist:cubi-capture",
    },
  });

  const captureSession = captureWindow.webContents.session;

  // Bridge 1.10.0 — auto-aceptar permiso "media" SÓLO en la session de captura
  // (necesario para getUserMedia con deviceId específico). Cualquier otro
  // permiso se rechaza por defensa en profundidad.
  captureSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });

  // Auto-aceptar la petición de captura del escritorio (sin diálogo de Windows
  // ni picker de Chromium — el usuario ya dio consentimiento al instalar el
  // bridge). Aislado a la session de captura, no afecta al resto del Bridge.
  captureSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
      // Tomamos la pantalla principal; el audio que viaja con ella es el de TODO el sistema
      callback({ video: sources[0], audio: "loopback" });
    }).catch((err) => {
      console.warn("[Bridge] desktopCapturer error:", err.message);
      callback({});
    });
  });

  captureWindow.loadFile("capture.html");
  captureWindow.on("closed", () => { captureWindow = null; syncReaStreamReceiver(); });
  // PoC ReaStream: si la fuente elegida es "reastream", encender el receptor UDP.
  syncReaStreamReceiver();

  // Debug: descomentar para ver logs de la captura
  // captureWindow.webContents.openDevTools({ mode: "detach" });
}

function closeCaptureWindow() {
  if (captureWindow) {
    try { captureWindow.close(); } catch {}
    captureWindow = null;
  }
  syncReaStreamReceiver();
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

  // Pastor 02-jun-2026 · Permiso de micrófono para el HUD.
  // El overlay graba la voz del Pastor con getUserMedia({audio:true}). En
  // Electron, sin un permission handler, getUserMedia para el micrófono se
  // deniega por defecto. Aprobamos "media" SÓLO en la session del overlay
  // (igual patrón que captureSession para el loopback del master). Cualquier
  // otro permiso se deniega — el HUD no necesita cámara, geolocalización, etc.
  try {
    const overlaySession = overlayWindow.webContents.session;
    // Solo micrófono: aprobamos "media" únicamente si NO pide cámara.
    // El HUD jamás necesita video; denegar la cámara explícitamente.
    overlaySession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      if (permission !== "media") return callback(false);
      const types = (details && details.mediaTypes) || [];
      if (types.includes("video")) return callback(false);
      callback(true);
    });
    overlaySession.setPermissionCheckHandler((_wc, permission, _origin, details) => {
      if (permission !== "media") return false;
      const mt = details && details.mediaType;
      return mt === "audio" || mt === "unknown";
    });
  } catch (e) {
    console.warn("[Bridge] No pude setear permiso de micrófono en el overlay:", e?.message || e);
  }

  // Pastor 27-may-2026 — Cinturón y tirantes para pegar (Ctrl+V) desde
  // apps externas (ChatGPT, navegador). Aunque setApplicationMenu con
  // editMenu role ya registra los accelerators, en Electron con frame:false
  // a veces el menú no captura. Acá interceptamos los atajos a nivel
  // webContents y disparamos las acciones del clipboard directamente.
  overlayWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const mod = input.control || input.meta; // Ctrl en Win/Linux, Cmd en macOS
    if (!mod) return;
    const key = (input.key || "").toLowerCase();
    const wc = overlayWindow.webContents;
    if (key === "v") { wc.paste(); event.preventDefault(); }
    else if (key === "c") { wc.copy(); event.preventDefault(); }
    else if (key === "x") { wc.cut(); event.preventDefault(); }
    else if (key === "a") { wc.selectAll(); event.preventDefault(); }
    else if (key === "z" && !input.shift) { wc.undo(); event.preventDefault(); }
    else if ((key === "z" && input.shift) || key === "y") { wc.redo(); event.preventDefault(); }
  });

  // Pastor 06-jun-2026 — Menú de CLIC DERECHO en el HUD flotante. El Pastor
  // selecciona texto del chat y quiere copiarlo (para pegármelo y mostrarme
  // qué le dijo el Coproductor), pero sin menú contextual el clic derecho no
  // hace nada. Construimos un menú nativo en español según el contexto:
  // Copiar si hay selección, Cortar/Pegar solo en campos editables, y siempre
  // Seleccionar todo. Es la pieza que faltaba además del before-input-event.
  overlayWindow.webContents.on("context-menu", (event, params) => {
    const flags = params.editFlags || {};
    const hasSelection = (params.selectionText || "").trim().length > 0;
    const template = [];
    if (hasSelection || params.isEditable) {
      template.push({ role: "copy", label: "Copiar", enabled: flags.canCopy || hasSelection });
    }
    if (params.isEditable) {
      template.push({ role: "cut", label: "Cortar", enabled: flags.canCut });
      template.push({ role: "paste", label: "Pegar", enabled: flags.canPaste });
    }
    if (template.length) template.push({ type: "separator" });
    template.push({ role: "selectAll", label: "Seleccionar todo" });
    try {
      Menu.buildFromTemplate(template).popup({ window: overlayWindow });
    } catch (err) {
      console.warn("[Bridge] context-menu popup falló:", err?.message || err);
    }
  });

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
    lastDisconnectReason = null; // reconectado: limpiar el motivo del corte
    updateTrayState("connected");
    // CP5 — wire del canal WRITE (MIDI OUT). OFF por defecto hasta
    // que el server mande midi_config{enabled:true} desde /lab.
    try { bridgeWrite.attach(ws); } catch (e) { console.warn("[Bridge] bridgeWrite.attach:", e && e.message); }
    // Canal REAPER (prueba de perillas, OSC nativo). OFF por defecto hasta
    // que el server mande reaper_config{enabled:true} desde /lab-reaper.
    try { bridgeReaper.attach(ws); } catch (e) { console.warn("[Bridge] bridgeReaper.attach:", e && e.message); }
    // Hello inicial con capabilities (seam para Bridge 2/3)
    ws.send(JSON.stringify({
      type: "hello",
      os: `${os.platform()} ${os.release()}`,
      daw: "Cubase", // TODO Bridge 3: detectar dinámicamente del parser .cpr
      bridgeVersion: BRIDGE_VERSION,
      capabilities: currentCapabilities(),
    }));
    // Etapa 0 Motor VST — si hay inventario guardado, reenviar el catálogo
    // al conectar (el server responde con el cruce contra la Biblioteca).
    try { pluginInventory.sendCatalog(); } catch (e) { console.warn("[Bridge] inventory catalog:", e && e.message); }
    // Biblioteca de Cadenas: arrancar la vigilancia (idempotente) y
    // publicar la lista al conectar — el Coproductor solo cita cadenas
    // confirmadas por esta lista.
    try { fxChainLibrary.stop(); fxChainLibrary.start(); sendFxChains(); } catch (e) { console.warn("[Bridge] fx-chains:", e && e.message); }
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
      } else if (msg.type === "live-reset-reply") {
        // Pastor 28-may-2026 — ack del reset conversacional. Reenviamos
        // al overlay para que la promise de preload.js (resetConversation)
        // resuelva y el botón 🧹 pueda mostrar feedback visual al Pastor.
        forwardToOverlay("overlay:reset-reply", {
          reqId: msg.reqId || null,
          ok: !!msg.ok,
          reason: msg.reason || null,
        });
      } else if (msg.type === "render-request") {
        // Mesa → Bridge: procesar una pista con una FX Chain real vía REAPER.
        // Módulo aislado; responde por HTTP (resultado) o WS (fallo honesto).
        bridgeRender.handleRenderRequest(msg, {
          serverUrl: SERVER_URL,
          getToken: () => store.get("token") || null,
          resolveChain: (name) => fxChainLibrary.resolve(name),
          sendWs: (obj) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
          log: (...a) => console.log("[Render]", ...a),
        }).catch((e) => console.warn("[Render] error no capturado:", e && e.message));
      } else if (msg.type === "apply-macro-reply") {
        // 4-ago-26 · Manos del HUD: resultado de la ejecución de una perilla.
        forwardToOverlay("overlay:apply-macro-reply", msg);
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
          // 4-ago-26 · Manos del HUD: propuesta de acción estructurada.
          proposal: msg.proposal || null,
          ts: msg.ts || Date.now(),
        });
      } else if (msg.type === "live-transcribe-reply") {
        // Pastor 02-jun-2026 · respuesta de la transcripción de voz del HUD.
        // Vino por la misma WS tras un live-transcribe enviado desde el overlay.
        // La reenviamos al overlayWindow vía IPC para que ponga el texto en la
        // cajita del chat (el Pastor revisa y envía).
        forwardToOverlay("overlay:transcribe-reply", {
          reqId: msg.reqId || null,
          ok: !!msg.ok,
          text: msg.text || "",
          reason: msg.reason || null,
          ts: msg.ts || Date.now(),
        });
      } else if (msg.type === "plugin-inventory-report") {
        // Etapa 0 Motor VST — informe del cruce catálogo ↔ Biblioteca
        // Profesional registrada. Se reenvía a la ventana del inventario.
        try { pluginInventory.handleServerMessage(msg); } catch (e) { console.warn("[Bridge] inventory report:", e && e.message); }
      } else if (msg.type === "midi_config" || msg.type === "midi_out") {
        // CP5 — delegado al módulo WRITE separado.
        try { bridgeWrite.handleServerMessage(msg); } catch (e) { console.warn("[Bridge WRITE] handle:", e && e.message); }
      } else if (msg.type === "reaper_config" || msg.type === "reaper_cmd") {
        // Prueba REAPER — delegado al módulo OSC separado.
        try { bridgeReaper.handleServerMessage(msg); } catch (e) { console.warn("[Bridge REAPER] handle:", e && e.message); }
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
    lastDisconnectReason = humanDisconnectReason(code, reasonStr);
    clearInterval(pingTimer);
    pingTimer = null;
    clearInterval(telemetryTimer);
    telemetryTimer = null;
    clearTimeout(captureRestartTimer);
    captureRestartTimer = null;
    closeCaptureWindow();
    // CP5 — cerrar puerto MIDI al perder WS
    try { bridgeWrite.detach(); } catch {}
    // Prueba REAPER — cerrar socket OSC al perder WS
    try { bridgeReaper.detach(); } catch {}
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
    // task #16 — avisar al server que ESTE cierre es intencional (el Pastor
    // salió del tray, o hubo reparación/re-emparejamiento/pausa). Así el server
    // NO le manda un WhatsApp de "Bridge desconectado de improviso". Best-effort:
    // si el socket ya está muerto, el cierre limpio por code 1000 lo cubre igual.
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "shutdown", ts: Date.now() }));
      }
    } catch {}
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
  // Pastor 27-may-2026 — Bug reportado: pegar (Ctrl+V) desde ChatGPT al chat
  // del HUD no funcionaba. Causa raíz: Electron NO registra los accelerators
  // Cut/Copy/Paste/SelectAll por default; sin un Menu con role:'editMenu'
  // los atajos no llegan al webContents aunque haya un <textarea> con foco.
  // Fix: setApplicationMenu con editMenu role. La barra está autoHideMenuBar
  // (no se ve), pero los accelerators sí quedan activos en TODAS las
  // BrowserWindows (overlay, pairing, capture).
  try {
    const editTemplate = [{ role: "editMenu" }];
    Menu.setApplicationMenu(Menu.buildFromTemplate(editTemplate));
  } catch (err) {
    console.warn("[Bridge] setApplicationMenu(editMenu) failed:", err?.message || err);
  }

  // Bridge 1.10.1 — Tray defensivo. Si Windows no logra dibujar el icono
  // (caso reportado por Pastor en una máquina Windows 11 con shell roto),
  // el resto del Bridge sigue funcionando y el HUD muestra el selector de
  // audio inline. Antes esto crasheaba silenciosamente y se perdía TODO el
  // resto del whenReady (connect, openOverlayWindow, etc.).
  let trayWarning = null;
  try {
    tray = new Tray(makeTrayIcon("#ef4444"));
    updateTrayState(store.get("token") ? "disconnected" : "pairing");
  } catch (err) {
    tray = null;
    trayWarning = "Windows no pudo crear el ícono del tray (" + (err.message || err) + "). El HUD sigue funcionando — usá el menú 🎤 dentro del HUD para elegir la fuente de audio.";
    console.error("[Bridge] Tray creation failed:", err);
    // Notificar al HUD apenas cargue.
    setTimeout(() => {
      try { forwardToOverlay("overlay:tray-warning", trayWarning); } catch {}
    }, 2000);
  }

  // Bridge 2: abrir puerto IPC local (READ-ONLY) para el VST3 Companion
  startLocalIpcServer();

  // Auto-launch on boot — primera vez en TRUE, después respeta el toggle
  ensureAutoLaunchDefault();
  ensureLabDesktopShortcut();

  // Si no hay token al arrancar, abrir ventana de emparejamiento (a menos que
  // hayamos arrancado oculto desde el login item — en ese caso esperamos a
  // que el Pastor haga click derecho en el tray).
  // Detección portable Windows: arg --hidden inyectado por setLoginItemSettings.
  const launchedHidden = process.argv.includes("--hidden");
  if (!store.get("token") && !launchedHidden) {
    openPairingWindow();
  } else if (store.get("token")) {
    connect();
    // Pastor 02-jun-2026 — El Pastor pidió EXPLÍCITAMENTE que el HUD flotante
    // se abra SOLO al prender la PC (antes quedaba frío en el tray cuando el
    // arranque venía del login item con --hidden, y el Pastor no lo encontraba).
    // Ahora abrimos el HUD SIEMPRE que haya token, tanto en arranque normal
    // (post-instalador) como en boot del PC (--hidden). Damos un respiro mayor
    // en boot porque el sistema está cargando otras apps al mismo tiempo.
    const openDelay = launchedHidden ? 2500 : 800;
    setTimeout(() => openOverlayWindow(), openDelay);
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
