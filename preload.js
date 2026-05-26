const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridgeAPI", {
  // Pairing window
  redeem: (code) => ipcRenderer.invoke("bridge:redeem", code),
  getStatus: () => ipcRenderer.invoke("bridge:status"),

  // Capture window (Bridge 1 — análisis del master output)
  sendMetrics: (metrics) => ipcRenderer.send("bridge:metrics", metrics),
  reportCaptureError: (msg) => ipcRenderer.send("bridge:capture-error", msg),

  // Bridge 1.9.0 — Perfil musical en vivo (BPM/key/tempo/groove/energy/dinámica/crescendo)
  // Calculado 100% local en capture.html. Refresh cada 2s. Cero coste IA.
  sendMusicProfile: (profile) => ipcRenderer.send("bridge:music-profile", profile),

  // Bridge 1.8.0 — Audio clip on-demand para Gemini Audio.
  // El server pide los últimos N segundos del master cuando el Pastor hace
  // una pregunta musical en el HUD. La ventana de captura devuelve un
  // WebM/Opus base64 (~120KB para 10s). Solo viaja bajo demanda — NO continuo.
  sendAudioClip: (payload) => ipcRenderer.send("bridge:audio-clip-reply", payload),
  onAudioClipRequest: (cb) => {
    const handler = (_e, req) => cb(req);
    ipcRenderer.on("bridge:request-audio-clip", handler);
    return () => ipcRenderer.removeListener("bridge:request-audio-clip", handler);
  },
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
  // Bridge 1.9.0 — perfil musical en vivo desde capture.html (cada 2s)
  onMusicProfile: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on("overlay:music-profile", handler);
    return () => ipcRenderer.removeListener("overlay:music-profile", handler);
  },
  // Bridge 1.9.0 — STYLE/REFERENCE/CHARACTER vía WS autenticada del bridge.
  // El overlay vive en file://, no puede hacer fetch al server directo.
  // Pattern: idéntico a sendLiveMessage — reqId + reply correlacionada + timeout.
  requestStyleTag: (payload) => {
    const reqId = `style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const TIMEOUT_MS = 12_000;
      const handler = (_e, r) => {
        if (!r || r.reqId !== reqId) return;
        ipcRenderer.removeListener("overlay:style-tag-reply", handler);
        clearTimeout(timer);
        resolve({
          ok: !!r.ok,
          style: r.style || null,
          reference: r.reference || null,
          character: r.character || null,
          reason: r.reason || null,
        });
      };
      const timer = setTimeout(() => {
        ipcRenderer.removeListener("overlay:style-tag-reply", handler);
        resolve({ ok: false, reason: "timeout" });
      }, TIMEOUT_MS);
      ipcRenderer.on("overlay:style-tag-reply", handler);
      ipcRenderer.send("overlay:request-style-tag", { reqId, payload });
    });
  },

  // Acciones (todas non-destructivas — no afectan a Cubase).
  openLab: () => ipcRenderer.send("overlay:open-lab"),
  close: () => ipcRenderer.send("overlay:close"),
  toggleCompact: () => ipcRenderer.send("overlay:toggle-compact"),

  // Pastor 25-may-2026 · Live Copilot interactivo (HUD v2).
  // El usuario escribe en el chat del HUD → main.js → server WS → IA → respuesta.
  // sendLiveMessage genera un reqId único y resuelve la promesa cuando llega la respuesta correlacionada.
  sendLiveMessage: (text) => {
    const reqId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const TIMEOUT_MS = 20_000;
      const handler = (_e, payload) => {
        if (!payload || payload.reqId !== reqId) return;
        ipcRenderer.removeListener("overlay:live-reply", handler);
        clearTimeout(timer);
        resolve({
          ok: !!payload.ok,
          text: String(payload.text || ""),
          reason: payload.reason || null,
          // 1.8.0 — propagar flag de Gemini Audio multimodal hasta el HUD
          // (app.js lo usa para mostrar marcador 🎧 cuando el cerebro
          // realmente escuchó los últimos ~10s del master).
          audioUsed: !!payload.audioUsed,
        });
      };
      const timer = setTimeout(() => {
        ipcRenderer.removeListener("overlay:live-reply", handler);
        resolve({ ok: false, text: "Sin respuesta del cerebro (timeout).", reason: "timeout" });
      }, TIMEOUT_MS);
      ipcRenderer.on("overlay:live-reply", handler);
      ipcRenderer.send("overlay:send-live-message", { reqId, text });
    });
  },
  // Para mensajes broadcast (no correlacionados) — útil si el server empuja
  // observaciones que querés renderizar como mensaje del copilot automático.
  onLiveReply: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("overlay:live-reply", handler);
    return () => ipcRenderer.removeListener("overlay:live-reply", handler);
  },
});
