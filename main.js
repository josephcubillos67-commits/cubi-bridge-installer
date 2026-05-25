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
// Install Kit v3 — auto-updater DESACTIVADO. El .exe se sirve desde
// Object Storage del servidor (sin GitHub Releases). Si hay version nueva,
// el Pastor vuelve a apretar "Descargar Bridge" desde /lab.
// const { autoUpdater } = require("electron-updater"); // <- desactivado v1.4.0

const store = new Store({ name: "cubi-bridge-config" });

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
  currentTrayState = state;
  // Mantener el overlay al tanto del estado de conexión (punto verde/rojo)
  forwardToOverlay("overlay:status", { connected: state === "connected" });
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
const OVERLAY_DEFAULT = { width: 340, height: 410 };
const OVERLAY_COMPACT = { width: 260, height: 120 };

function getOverlayBounds() {
  // Restaurar posición/tamaño si el usuario los movió. Si no hay nada guardado,
  // colocar en la esquina inferior-derecha del display primario.
  const saved = store.get("overlay") || {};
  const compact = !!saved.compact;
  const size = compact ? OVERLAY_COMPACT : OVERLAY_DEFAULT;
  let { x, y } = saved;
  if (typeof x !== "number" || typeof y !== "number") {
    const wa = screen.getPrimaryDisplay().workArea;
    x = wa.x + wa.width - size.width - 24;
    y = wa.y + wa.height - size.height - 60;
  }
  return { x, y, ...size, compact };
}

function openOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    return;
  }
  const b = getOverlayBounds();
  overlayWindow = new BrowserWindow({
    x: b.x, y: b.y,
    width: b.width, height: b.height,
    frame: false,
    transparent: true,
    resizable: false,
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
  overlayWindow.loadFile("overlay.html");

  // Push de estado actual al abrir + último snapshot de plugins (si lo hay)
  overlayWindow.webContents.once("did-finish-load", () => {
    forwardToOverlay("overlay:status", { connected: currentTrayState === "connected" });
    if (lastPluginChain) forwardToOverlay("overlay:plugins", lastPluginChain);
  });

  // Persistir posición cuando el Pastor mueve la ventana
  const persist = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const [x, y] = overlayWindow.getPosition();
    const saved = store.get("overlay") || {};
    store.set("overlay", { ...saved, x, y });
  };
  overlayWindow.on("move", persist);
  overlayWindow.on("moved", persist);
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
  const size = nextCompact ? OVERLAY_COMPACT : OVERLAY_DEFAULT;
  overlayWindow.setSize(size.width, size.height);
  overlayWindow.webContents.executeJavaScript(
    nextCompact
      ? 'document.body.classList.add("compact")'
      : 'document.body.classList.remove("compact")'
  ).catch(() => {});
  store.set("overlay", { ...saved, compact: nextCompact });
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

  localIpcServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[Bridge IPC] Puerto ${LOCAL_IPC_PORT} ocupado — otro bridge corriendo?`);
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

// ─── Single-instance + handlers de shortcuts externos ──────────
// Si el Pastor hace doble-click al shortcut "Mostrar HUD CUBI" mientras el
// Bridge ya corre en tray, electron normalmente abriria una segunda instancia.
// Con el lock, el segundo proceso muere y nos manda sus argv para que el
// proceso vivo reaccione (toggle del HUD).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log("[Bridge] Otra instancia ya corre — saliendo.");
  app.quit();
} else {
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
