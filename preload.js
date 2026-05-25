const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridgeAPI", {
  // Pairing window
  redeem: (code) => ipcRenderer.invoke("bridge:redeem", code),
  getStatus: () => ipcRenderer.invoke("bridge:status"),

  // Capture window (Bridge 1 — análisis del master output)
  sendMetrics: (metrics) => ipcRenderer.send("bridge:metrics", metrics),
  reportCaptureError: (msg) => ipcRenderer.send("bridge:capture-error", msg),
});

// API exclusiva del Floating HUD overlay (ventana siempre-encima).
// READ-ONLY: la ventana sólo recibe y muestra; no manda datos al DAW ni al servidor.
contextBridge.exposeInMainWorld("overlayAPI", {
  // Suscripciones (cada una devuelve un unsubscribe).
  onMetrics: (cb) => {
    const handler = (_e, m) => cb(m);
    ipcRenderer.on("overlay:metrics", handler);
    return () => ipcRenderer.removeListener("overlay:metrics", handler);
  },
  onObservations: (cb) => {
    const handler = (_e, obs) => cb(obs);
    ipcRenderer.on("overlay:observations", handler);
    return () => ipcRenderer.removeListener("overlay:observations", handler);
  },
  onPlugins: (cb) => {
    const handler = (_e, snap) => cb(snap);
    ipcRenderer.on("overlay:plugins", handler);
    return () => ipcRenderer.removeListener("overlay:plugins", handler);
  },
  onStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on("overlay:status", handler);
    return () => ipcRenderer.removeListener("overlay:status", handler);
  },

  // Acciones (todas non-destructivas — no afectan a Cubase).
  openLab: () => ipcRenderer.send("overlay:open-lab"),
  close: () => ipcRenderer.send("overlay:close"),
  toggleCompact: () => ipcRenderer.send("overlay:toggle-compact"),
});
