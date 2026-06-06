/* ============================================================
 * app.js — orquestador del Jarvis HUD v2
 * ============================================================
 * Responsable de:
 *   1. Estado central (mode / state / clickthrough / dock / opacity)
 *   2. Manejo de controles del header
 *   3. Chat UI (render mensajes, typing indicator, input)
 *   4. Transiciones de estado visual con auto-revert
 *   5. Dock lateral (snap-to-edge preview)
 *   6. Settings panel (slide-in)
 *
 * NO habla con la red — eso es trabajo de messaging.js.
 * NO sabe de Electron — eso será trabajo de main.js cuando el HUD
 * se monte como ventana real (v1.5.0).
 * ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const body = document.body;
const chatLog = $("#chat-log");
const chatInput = $("#chat-input");
const statusLabel = $("#status-label");
const settingsPanel = $("#settings-panel");

/* ============================================================
 * ESTADO CENTRAL
 * ============================================================ */
const state = {
  mode: "expanded",         // compact | expanded | stadium
  visual: "idle",           // idle | listening | thinking | analyzing | speaking | error | processing
  clickthrough: false,
  dock: "none",             // none | left | right | bottom
  opacity: 0.92,
  settingsOpen: false,
};

const STATE_LABELS = {
  idle: "En reposo",
  listening: "Escuchando",
  thinking: "Pensando",
  analyzing: "Analizando",
  speaking: "Respondiendo",
  error: "Error",
  processing: "Procesando stems",
};

function setVisual(next, opts = {}) {
  state.visual = next;
  body.dataset.state = next;
  statusLabel.textContent = STATE_LABELS[next] || next;

  if (opts.autoRevert) {
    clearTimeout(setVisual._revertTimer);
    setVisual._revertTimer = setTimeout(() => {
      setVisual("idle");
    }, opts.autoRevert);
  }
}

function setMode(next) {
  state.mode = next;
  body.dataset.mode = next;
}

function cycleMode() {
  const order = ["compact", "expanded", "stadium"];
  const idx = order.indexOf(state.mode);
  setMode(order[(idx + 1) % order.length]);
}

function toggleClickthrough() {
  state.clickthrough = !state.clickthrough;
  body.dataset.clickthrough = state.clickthrough ? "on" : "off";
  $("#btn-clickthrough").classList.toggle("active", state.clickthrough);
  const settingsToggle = $("#settings-clickthrough");
  if (settingsToggle) {
    settingsToggle.textContent = state.clickthrough ? "ON" : "OFF";
    settingsToggle.classList.toggle("on", state.clickthrough);
  }
}

function cycleDock() {
  const order = ["none", "left", "right", "bottom"];
  const idx = order.indexOf(state.dock);
  state.dock = order[(idx + 1) % order.length];
  body.dataset.dock = state.dock;
  $("#btn-dock").classList.toggle("active", state.dock !== "none");
}

function setOpacity(pct) {
  state.opacity = pct / 100;
  $("#hud").style.opacity = String(state.opacity);
  const valueEl = $("#opacity-value");
  if (valueEl) valueEl.textContent = `${pct}%`;
}

function toggleSettings() {
  state.settingsOpen = !state.settingsOpen;
  settingsPanel.classList.toggle("open", state.settingsOpen);
  settingsPanel.setAttribute("aria-hidden", String(!state.settingsOpen));
  $("#btn-settings").classList.toggle("active", state.settingsOpen);
}

/* ============================================================
 * CHAT UI
 * ============================================================ */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderMessage({ role, text, actions = [], severity = null }) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  // Pastor 26-may-2026: severidad visual diferenciada.
  // critical → rojo (urgente, hay que actuar); warn → ámbar (atención);
  // info/good/null → estilo normal.
  if (severity === "critical") msg.classList.add("severity-critical");
  else if (severity === "warn") msg.classList.add("severity-warn");
  else if (severity === "good") msg.classList.add("severity-good");

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? "👤" : "🎧";

  const content = document.createElement("div");

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;

  // Botón × para borrar este mensaje. Aparece al pasar el mouse por encima.
  // Pastor 26-may-2026: cuando el copiloto se vuelve charlatán o repite,
  // el Pastor barre el chat sin tener que limpiarlo entero.
  const closeBtn = document.createElement("button");
  closeBtn.className = "msg-close";
  closeBtn.type = "button";
  closeBtn.title = "Borrar este mensaje";
  closeBtn.setAttribute("aria-label", "Borrar mensaje");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    msg.classList.add("removing");
    setTimeout(() => msg.remove(), 220);
  });
  bubble.appendChild(closeBtn);

  content.appendChild(bubble);

  if (actions.length > 0) {
    const actionsRow = document.createElement("div");
    actionsRow.className = "msg-actions";
    actions.forEach(a => {
      const btn = document.createElement("button");
      btn.className = "action-chip";
      btn.textContent = a.label;
      btn.dataset.actionId = a.id;
      if (a.confirm) btn.dataset.confirm = "true";
      btn.addEventListener("click", () => handleAction(a));
      actionsRow.appendChild(btn);
    });
    content.appendChild(actionsRow);
  }

  msg.appendChild(avatar);
  msg.appendChild(content);
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderTyping() {
  const msg = document.createElement("div");
  msg.className = "msg assistant";
  msg.id = "typing-msg";
  msg.innerHTML = `
    <div class="msg-avatar">🎧</div>
    <div class="msg-bubble">
      <div class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
    </div>`;
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function removeTyping() {
  const t = document.getElementById("typing-msg");
  if (t) t.remove();
}

function handleAction(action) {
  // Stub: en v1.5.1 cada action.id se mapea a un IPC al main de Electron.
  // Por ahora, mostramos un toast inline en el chat.
  if (action.confirm) {
    renderMessage({
      role: "assistant",
      text: `Acción "${action.label}" requiere confirmación. (En el Bridge real esto abriría un preview A/B antes de aplicar — ADN CUBI.)`,
    });
  } else {
    renderMessage({
      role: "assistant",
      text: `Acción "${action.label}" registrada. (Stub preview — se conecta al Coproductor en v1.5.1.)`,
    });
  }
}

async function sendUserMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  renderMessage({ role: "user", text });
  chatInput.value = "";
  chatInput.style.height = "auto";

  setVisual("thinking");
  renderTyping();

  try {
    const response = await window.jarvisAPI.sendMessage(text);
    removeTyping();
    setVisual("speaking", { autoRevert: 2400 });
    // 1.8.0 — si el cerebro escuchó los últimos 10s reales del master
    // (Gemini Audio multimodal), agregamos un marcador discreto al inicio.
    // Cero modal, cero wizard — el Pastor lo ve y entiende que fue oído real.
    const prefix = response._audioUsed ? "🎧 " : "";
    renderMessage({
      role: "assistant",
      text: prefix + response.reply,
      actions: response.actions,
    });
  } catch (err) {
    removeTyping();
    setVisual("error", { autoRevert: 3000 });
    renderMessage({
      role: "assistant",
      text: `No pude procesar: ${err.message}`,
    });
  }
}

/* ============================================================
 * BIND CONTROLES + INPUT
 * ============================================================ */
$("#btn-mode").addEventListener("click", cycleMode);
$("#btn-clickthrough").addEventListener("click", toggleClickthrough);
$("#btn-dock").addEventListener("click", cycleDock);
/* Botones de limpieza del chat — Pastor 28-may-2026 (2 niveles)
   ADN CUBI: cero modal. Confirmación inline por doble-click (2.5s ventana).
   ─ 🗑️ Borrar chat  → sólo limpia las burbujas visibles. El cerebro server
                       sigue recordando los topics (anti-repetición intacto).
   ─ 🧹 Reset conversación → limpia burbujas + manda WS al server para wipear
                              el ring buffer del anti-repetición de este userId.
                              Empezás fresco real. */
function wireConfirmButton(btn, onConfirmed, baseTitle) {
  let confirmTimer = null;
  btn.addEventListener("click", async () => {
    if (btn.dataset.confirming === "true") {
      clearTimeout(confirmTimer);
      confirmTimer = null;
      btn.dataset.confirming = "false";
      btn.title = baseTitle;
      await onConfirmed();
      return;
    }
    btn.dataset.confirming = "true";
    btn.title = "Tocá de nuevo para confirmar";
    confirmTimer = setTimeout(() => {
      btn.dataset.confirming = "false";
      btn.title = baseTitle;
      confirmTimer = null;
    }, 2500);
  });
}

function fadeOutChat() {
  const msgs = Array.from(chatLog.querySelectorAll(".msg"));
  msgs.forEach(m => m.classList.add("removing"));
  return new Promise((r) => setTimeout(() => {
    chatLog.innerHTML = "";
    r();
  }, 240));
}

/* 🗑️ Borrar chat — sólo visual. */
const clearChatBtn = $("#btn-clear-chat");
wireConfirmButton(
  clearChatBtn,
  async () => { await fadeOutChat(); },
  "🗑️ Borrar chat (sólo limpia las burbujas — el cerebro sigue recordando)"
);

/* 🧹 Reset conversación — visual + memoria server. */
const resetConvBtn = $("#btn-reset-conv");
if (resetConvBtn) {
  wireConfirmButton(
    resetConvBtn,
    async () => {
      await fadeOutChat();
      let serverOk = false;
      let reason = null;
      if (window.overlayAPI?.resetConversation) {
        try {
          const res = await window.overlayAPI.resetConversation();
          serverOk = !!res?.ok;
          reason = res?.reason || null;
        } catch (_) { serverOk = false; reason = "exception"; }
      }
      // Confirmación discreta como mensaje del copiloto (cero modal).
      renderMessage({
        role: "assistant",
        text: serverOk
          ? "Listo, conversación reseteada. Empezamos fresco — sin contexto viejo."
          : `Chat limpio acá, pero no pude resetear el cerebro (${reason || "sin respuesta"}). Reintentá o reabrí el HUD.`,
      });
    },
    "🧹 Reset conversación (borra chat + memoria del cerebro)"
  );
}

/* 🔄 Refrescar HUD — recarga el bundle preservando pairing y posición. */
const reloadBtn = $("#btn-reload");
if (reloadBtn) {
  reloadBtn.addEventListener("click", () => {
    if (window.overlayAPI?.reload) window.overlayAPI.reload();
  });
}

/* ============================================================
 * 🎤 MICRÓFONO — voz → texto (Pastor 02-jun-2026)
 * ============================================================
 * El Pastor pidió poder HABLARLE al copiloto además de escribir.
 * Flujo (ADN CUBI: cero modal, una sola pantalla):
 *   1. Toca 🎤 → empieza a grabar (botón en rojo pulsante).
 *   2. Habla.
 *   3. Toca 🎤 de nuevo → "Transcribiendo…" y manda el clip al cerebro.
 *   4. El texto vuelve y cae en la CAJITA — el Pastor lo revisa/corrige y
 *      envía con Enter o el botón. NO se envía solo: la transcripción en
 *      español no es perfecta (honestidad > magia).
 * La cajita de texto sigue 100% funcional en paralelo (las dos cosas).
 * Graba en WebM/Opus — mismo formato que ya funciona con Gemini Audio.
 * ============================================================ */
const micBtn = $("#btn-mic");
let micRecorder = null;
let micChunks = [];
let micStream = null;
let micRecording = false;
let micBusy = false; // mientras transcribe, evita doble disparo
let micAborted = false; // true → al parar, descartar sin transcribir (minimizar/cerrar)

function setMicState(recording) {
  micRecording = recording;
  if (!micBtn) return;
  micBtn.classList.toggle("recording", recording);
  micBtn.title = recording
    ? "Grabando… tocá para terminar"
    : "Hablar (toca para grabar, toca de nuevo para terminar)";
}

function stopMicStream() {
  try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  micStream = null;
}

/* El Pastor habla por su PreSonus StudioLive USB (no el micrófono interno de
   la PC). Pidió que el micrófono se conecte SOLO a ese dispositivo de forma
   automática. Camino: pedimos permiso genérico (desbloquea los labels de
   enumerateDevices), buscamos un input cuyo nombre matchee StudioLive/PreSonus
   y reconectamos a ESE deviceId. Si no aparece, nos quedamos con el genérico
   (fallback honesto — no rompemos si la interfaz no está enchufada). */
const PREFERRED_MIC_RE = /studio\s*live|presonus/i;

async function pickPreferredMicStream() {
  let stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const preferred = inputs.find((d) => PREFERRED_MIC_RE.test(d.label || ""));
    if (preferred && preferred.deviceId) {
      const currentId = stream.getAudioTracks()[0]?.getSettings?.().deviceId;
      if (currentId !== preferred.deviceId) {
        stream.getTracks().forEach((t) => t.stop());
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: preferred.deviceId } },
          });
        } catch (_) {
          // Si la interfaz falla al abrir explícita, volvemos al genérico.
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      }
    }
  } catch (_) {
    // enumerateDevices puede fallar; nos quedamos con el stream genérico.
  }
  return stream;
}

async function startMicRecording() {
  // Sin overlayAPI (preview web sin Bridge) el micrófono no transcribe.
  if (!window.overlayAPI?.transcribeVoice) {
    renderMessage({
      role: "assistant",
      text: "El micrófono funciona en el HUD de escritorio (no en la vista del navegador).",
    });
    return;
  }
  try {
    micStream = await pickPreferredMicStream();
  } catch (err) {
    renderMessage({
      role: "assistant",
      text: "No pude acceder al micrófono. Revisá que Windows tenga permiso de micrófono para la app.",
    });
    return;
  }
  micChunks = [];
  micAborted = false;
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : (MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "");
  try {
    try {
      micRecorder = mimeType ? new MediaRecorder(micStream, { mimeType }) : new MediaRecorder(micStream);
    } catch (_) {
      micRecorder = new MediaRecorder(micStream);
    }
    micRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) micChunks.push(e.data); };
    micRecorder.onstop = () => { handleMicStop().catch(() => {}); };
    micRecorder.start();
    setMicState(true);
    setVisual("listening");
  } catch (err) {
    // Cualquier fallo creando/arrancando el recorder → soltar el stream para
    // no dejar el micrófono abierto (sin esto el LED del mic queda encendido).
    stopMicStream();
    micRecorder = null;
    setMicState(false);
    setVisual("idle");
    renderMessage({ role: "assistant", text: "No pude iniciar la grabación. Probá de nuevo." });
  }
}

/* Aborta la grabación en curso SIN transcribir (minimizar/cerrar/ocultar).
   Suelta el MediaRecorder y el MediaStream para no dejar el micrófono abierto. */
function abortMicRecording() {
  if (!micRecording) return;
  micAborted = true;
  try { if (micRecorder && micRecorder.state !== "inactive") micRecorder.stop(); } catch (_) {}
  // Si onstop no llega (window oculta), forzamos limpieza igual.
  stopMicStream();
  micChunks = [];
  setMicState(false);
}

async function handleMicStop() {
  setMicState(false);
  stopMicStream();
  if (micAborted) {
    // Grabación descartada a propósito (minimizar/cerrar) — no transcribir.
    micAborted = false;
    micChunks = [];
    setVisual("idle");
    return;
  }
  const blob = new Blob(micChunks, { type: "audio/webm" });
  micChunks = [];
  if (!blob.size) {
    setVisual("idle");
    return;
  }
  micBusy = true;
  setVisual("thinking");
  // Indicador discreto en la cajita mientras transcribe (cero modal).
  const prevPlaceholder = chatInput.placeholder;
  chatInput.placeholder = "Transcribiendo lo que dijiste…";
  try {
    const base64 = await blobToBase64(blob);
    const res = await window.overlayAPI.transcribeVoice(base64, "audio/webm");
    if (res?.ok && res.text) {
      // El texto cae en la cajita — el Pastor revisa y envía.
      chatInput.value = chatInput.value
        ? `${chatInput.value} ${res.text}`.trim()
        : res.text;
      chatInput.focus();
      autoGrowInput();
      setVisual("idle");
    } else {
      const reason = res?.reason;
      const msg = reason === "timeout"
        ? "La transcripción tardó demasiado. Probá de nuevo con una frase más corta."
        : (reason === "bridge-offline"
            ? "El Bridge está desconectado. Reconectalo desde el tray."
            : "No te entendí bien. Probá de nuevo, hablando claro y cerca del micrófono.");
      setVisual("error", { autoRevert: 2600 });
      renderMessage({ role: "assistant", text: msg });
    }
  } catch (err) {
    setVisual("error", { autoRevert: 2600 });
    renderMessage({ role: "assistant", text: "Hubo un problema transcribiendo el audio. Probá de nuevo." });
  } finally {
    micBusy = false;
    chatInput.placeholder = prevPlaceholder;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // result viene como "data:audio/webm;base64,XXXX" — nos quedamos con XXXX.
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function autoGrowInput() {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
}

if (micBtn) {
  micBtn.addEventListener("click", () => {
    if (micBusy) return; // está transcribiendo, ignorar
    if (micRecording) {
      try { if (micRecorder && micRecorder.state !== "inactive") micRecorder.stop(); } catch (_) {}
    } else {
      startMicRecording();
    }
  });
}

/* ============================================================
 * AUDIO SOURCE PICKER (Bridge 1.10.1)
 * ============================================================
 * El selector vive en el HUD porque el tray de Windows no es confiable
 * en todas las máquinas. La lista de devices la pueblan tres caminos:
 *   1. getAudioState() al abrir el HUD (estado actual + cache)
 *   2. onAudioInputs() push desde main.js cuando capture.html enumera
 *   3. Re-emisión cada vez que el Pastor selecciona uno (eco de confirm)
 * Cambio de device → main.js recicla captureWindow → HUD pasa de
 * "EN REPOSO / -106 LUFS" a métricas vivas en ~5 segundos.
 * ============================================================ */
const audioPanel = $("#audio-panel");
const audioList = $("#audio-panel-list");
let audioState = { inputs: [], selected: { deviceId: null, label: null } };
let audioPanelOpen = false;

function renderAudioPanel() {
  if (!audioList) return;
  const { inputs, selected } = audioState;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    audioList.innerHTML = '<div class="audio-panel-empty">Detectando entradas… (reabrí este menú en 3s si no aparece nada)</div>';
    return;
  }
  const selId = selected?.deviceId || null;
  const opts = [
    {
      deviceId: null,
      label: "Default del sistema (WASAPI loopback)",
      hint: "DEFAULT",
    },
    ...inputs.map((d) => ({
      deviceId: d.deviceId,
      label: d.label || d.deviceId || "Device sin nombre",
      hint: /voicemeeter/i.test(d.label || "") ? "VOICEMEETER"
          : /loopback/i.test(d.label || "") ? "LOOPBACK"
          : /focusrite|presonus|studio/i.test(d.label || "") ? "INTERFAZ"
          : "ENTRADA",
    })),
  ];
  audioList.innerHTML = opts.map((o, i) => {
    const isSel = (o.deviceId || null) === selId;
    return `<button class="audio-opt ${isSel ? "selected" : ""}" data-aidx="${i}" type="button">
      <span class="audio-opt-dot"></span>
      <span class="audio-opt-label">${escapeAudio(o.label)}</span>
      <span class="audio-opt-hint">${o.hint}</span>
    </button>`;
  }).join("");
  audioList.querySelectorAll(".audio-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.aidx, 10);
      const opt = opts[idx];
      if (!opt) return;
      window.overlayAPI?.selectAudioInput(opt.deviceId, opt.label);
      audioState.selected = { deviceId: opt.deviceId, label: opt.label };
      renderAudioPanel();
      // Cerrar dropdown tras 600ms para dar feedback visual del check.
      setTimeout(() => toggleAudioPanel(false), 600);
    });
  });
}
function escapeAudio(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
function toggleAudioPanel(forceState) {
  if (!audioPanel) return;
  audioPanelOpen = (typeof forceState === "boolean") ? forceState : !audioPanelOpen;
  audioPanel.classList.toggle("open", audioPanelOpen);
  audioPanel.setAttribute("aria-hidden", String(!audioPanelOpen));
  if (audioPanelOpen) {
    // Refrescar contra el main al abrir, por si llegaron devices nuevos
    if (typeof window.overlayAPI?.getAudioState === "function") {
      window.overlayAPI.getAudioState().then((s) => {
        if (s && Array.isArray(s.inputs)) {
          audioState = s;
          renderAudioPanel();
        }
      }).catch(() => {});
    }
    renderAudioPanel();
  }
}
$("#btn-audio")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleAudioPanel();
});
document.addEventListener("click", (e) => {
  if (
    audioPanelOpen &&
    !audioPanel.contains(e.target) &&
    !$("#btn-audio").contains(e.target)
  ) {
    toggleAudioPanel(false);
  }
});

$("#btn-settings").addEventListener("click", toggleSettings);

// Pastor 27-may-2026 — minimizar real: `hide()` del lado de Electron.
// Mantiene la BrowserWindow viva → preserva DOM, historial del chat,
// scroll, state visual. Al reabrirlo desde el tray (toggleOverlay) el
// openOverlayWindow detecta la window existente y llama .show() en vez
// de crear una nueva. ADN CUBI: un icono inline, cero modal.
// Botón "Abrir LAB": lleva directo a la página principal del Laboratorio
// (donde está el chat grande) en el navegador. La plomería ya existe en main.js
// (overlay:open-lab → shell.openExternal(SERVER_URL + "/lab")).
const openLabBtn = $("#btn-open-lab");
if (openLabBtn) {
  openLabBtn.addEventListener("click", () => {
    if (typeof window.overlayAPI?.openLab === "function") {
      window.overlayAPI.openLab();
      return;
    }
    // Fallback en preview web (sin Electron): abrir en pestaña nueva.
    try { window.open("/lab", "_blank", "noopener"); } catch (_) {}
  });
}

$("#btn-minimize").addEventListener("click", () => {
  abortMicRecording(); // no dejar el micrófono grabando en una ventana oculta
  if (typeof window.overlayAPI?.minimize === "function") {
    window.overlayAPI.minimize();
    return;
  }
  // Preview web: feedback visible.
  $("#hud").style.opacity = "0";
  setTimeout(() => { $("#hud").style.opacity = state.opacity; }, 240);
});

// Red de seguridad: si la ventana se oculta o se cierra por cualquier vía
// (tray toggle, cierre del SO, etc.) mientras se graba, soltar el micrófono.
window.addEventListener("beforeunload", () => { abortMicRecording(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) abortMicRecording();
});

$("#btn-close").addEventListener("click", () => {
  abortMicRecording(); // soltar el micrófono antes de cerrar
  // En Electron real (HUD desktop): cerrar la ventana flotante via IPC.
  // En preview web: animación de fade-out + mensaje.
  if (typeof window.overlayAPI?.close === "function") {
    window.overlayAPI.close();
    return;
  }
  $("#hud").style.opacity = "0";
  $("#hud").style.transform = "scale(0.96)";
  setTimeout(() => {
    $("#hud").style.opacity = state.opacity;
    $("#hud").style.transform = "";
    renderMessage({
      role: "assistant",
      text: "En el Bridge real esto me vuelve al tray. Click en el ícono 🎧 del tray para traerme de vuelta.",
    });
  }, 320);
});

$("#btn-send").addEventListener("click", sendUserMessage);

$("#opacity-slider")?.addEventListener("input", (e) => {
  setOpacity(parseInt(e.target.value, 10));
});

$("#settings-clickthrough")?.addEventListener("click", toggleClickthrough);

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 110) + "px";
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendUserMessage();
  }
});

// Pastor 27-may-2026 — Tercera capa de defensa para pegar desde ChatGPT/
// navegador. Si por alguna razón ni el menú de Electron ni el
// before-input-event capturan Ctrl+V, este handler local lee el clipboard
// vía navigator.clipboard (Electron lo expone) e inserta en el textarea
// en la posición del cursor. Cero opciones, cero modal — pegás y listo.
chatInput.addEventListener("paste", async (e) => {
  // Si el evento ya trae datos (caso normal en Electron con editMenu activo),
  // dejamos que el navegador haga lo suyo — solo aseguramos auto-resize.
  if (e.clipboardData && e.clipboardData.getData("text")) {
    setTimeout(() => {
      chatInput.style.height = "auto";
      chatInput.style.height = Math.min(chatInput.scrollHeight, 110) + "px";
    }, 0);
    return;
  }
  // Sino, fallback manual via navigator.clipboard.
  try {
    e.preventDefault();
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const start = chatInput.selectionStart ?? chatInput.value.length;
    const end = chatInput.selectionEnd ?? chatInput.value.length;
    chatInput.value = chatInput.value.slice(0, start) + text + chatInput.value.slice(end);
    const cursor = start + text.length;
    chatInput.setSelectionRange(cursor, cursor);
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 110) + "px";
  } catch (err) {
    console.warn("[chat] paste fallback falló:", err?.message || err);
  }
});

// Cerrar settings al click fuera
document.addEventListener("click", (e) => {
  if (
    state.settingsOpen &&
    !settingsPanel.contains(e.target) &&
    !$("#btn-settings").contains(e.target)
  ) {
    toggleSettings();
  }
});

/* ============================================================
 * METRICS STRIP — ingeniero de mastering en vivo
 * ============================================================
 * Pastor 26-may-2026: el Bridge desktop empuja métricas del master
 * cada ~500ms via IPC (overlay:metrics). Acá las pintamos:
 *   - 4 tarjetas grandes (Volumen/Pico/Cuerpo/Dinámica)
 *   - Sparkline LUFS de los últimos 60s con línea meta -14
 *   - 8 bandas de espectro (sub→top)
 * Auto-clear si dejan de llegar (>4s) → "—".
 * READ-ONLY: cero interacción con Cubase.
 * ============================================================ */
const SPARK_HISTORY = 120;          // 60s @ 500ms
const SPARK_MIN = -36, SPARK_MAX = 0, SPARK_TARGET = -14;
const lufsHistory = [];
let lastMetricsAt = 0;
const sparkCanvas = $("#spark-lufs");
const sparkCtx = sparkCanvas ? sparkCanvas.getContext("2d") : null;

function fmt1(v) {
  return (v != null && isFinite(v)) ? v.toFixed(1) : "—";
}
function setMetricVal(id, val, klass) {
  const el = document.getElementById(id);
  if (!el) return;
  const unitEl = el.querySelector(".metric-unit");
  const unitHtml = unitEl ? unitEl.outerHTML : "";
  el.innerHTML = fmt1(val) + unitHtml;
  el.classList.remove("warn", "cool", "good");
  if (klass) el.classList.add(klass);
}
function classForTP(tp) {
  if (tp == null || !isFinite(tp)) return null;
  if (tp > -1) return "warn";    // clipping inminente
  if (tp > -3) return "cool";    // límite estrecho
  return null;
}
function classForCrest(c) {
  if (c == null || !isFinite(c)) return null;
  if (c < 6) return "warn";      // master aplastado
  if (c > 14) return "good";     // dinámica sana
  return null;
}
function classForLufs(l) {
  if (l == null || !isFinite(l)) return null;
  if (l > -8) return "warn";     // demasiado caliente
  if (l >= -16 && l <= -12) return "good";  // ventana streaming
  return null;
}
/* Bridge 1.15.0 — Fuente activa / Estado de captura (paridad con overlay v1).
 * capConnected: WS del Bridge conectada (onStatus).
 * capSource: {label,mode} reportado por capture.html.
 * capLastSignalTs: último instante con audio real (rms sobre el piso).
 *   >2.5s sin señal → "Sin señal" (Cubase sordo / canción parada). Resuelve el
 *   punto ciego histórico del fallback silencioso a loopback. */
let capConnected = false;
let capSource = null;
let capLastSignalTs = 0;
let capDisconnectReason = null;
const CAP_SIGNAL_FLOOR = -55;
const CAP_SIGNAL_TIMEOUT = 2500;
// Bridge — Ventana de gracia de reconexión. El proxy de borde de la plataforma
// recicla la conexión WebSocket cada ~5 min y el Bridge reengancha solo en ~2-3s.
// Durante ese lapso NO pintamos rojo alarmante: mostramos "Reconectando…" en ámbar.
// Solo si el corte SUPERA esta ventana se trata como caída real (rojo).
const CAP_RECONNECT_GRACE = 8000;
let capDisconnectedAt = 0;
let capEverConnected = false;
let capPendingDropMsg = null;

function renderCapStatus() {
  const dotEl = document.getElementById("cap-status-dot");
  const stateEl = document.getElementById("cap-status-state");
  const srcEl = document.getElementById("cap-status-src");
  if (!dotEl || !stateEl || !srcEl) return;

  const paint = (col) => { dotEl.style.background = col; dotEl.style.color = col; };

  if (!capConnected) {
    // Corte corto tras una conexión previa = reconexión del hosting, no falla real.
    const downMs = capDisconnectedAt ? (Date.now() - capDisconnectedAt) : 0;
    if (capEverConnected && downMs < CAP_RECONNECT_GRACE) {
      paint("var(--gold)");
      stateEl.textContent = "Reconectando…";
      stateEl.style.color = "var(--gold)";
      srcEl.textContent = "· un momento";
      return;
    }
    paint("var(--red)");
    stateEl.textContent = "Sin conexión";
    stateEl.style.color = "var(--red)";
    srcEl.textContent = capDisconnectReason ? ("· " + capDisconnectReason) : "";
    return;
  }

  const src = (capSource && capSource.label) ? capSource.label : "esperando fuente…";
  const fallback = capSource && capSource.mode === "fallback";
  const hasSignal = (Date.now() - capLastSignalTs) < CAP_SIGNAL_TIMEOUT;

  if (!hasSignal) {
    paint("var(--gold)");
    stateEl.textContent = "Sin señal";
    stateEl.style.color = "var(--gold)";
    srcEl.textContent = "· " + src;
    return;
  }

  paint(fallback ? "var(--gold)" : "var(--green)");
  stateEl.textContent = fallback ? "⚠ Loopback" : "Capturando";
  stateEl.style.color = fallback ? "var(--gold)" : "var(--green)";
  srcEl.textContent = "· " + src + (fallback ? " (fuente cambió)" : "");
}

function renderMetrics(m) {
  if (!m) return;
  lastMetricsAt = Date.now();
  // Bridge 1.15.0 — hay señal real si el cuerpo (rms) supera el piso.
  if (m.rms != null && isFinite(m.rms) && m.rms > CAP_SIGNAL_FLOOR) capLastSignalTs = Date.now();
  renderCapStatus();
  setMetricVal("m-lufs", m.lufs, classForLufs(m.lufs));
  setMetricVal("m-tp", m.truePeak, classForTP(m.truePeak));
  setMetricVal("m-rms", m.rms, null);
  setMetricVal("m-crest", m.crest, classForCrest(m.crest));

  // Bandas: -60dB → 0% altura, 0dB → 100%
  if (m.bands) {
    const bandEls = document.querySelectorAll(".metrics-bands .band");
    bandEls.forEach((b) => {
      const k = b.dataset.band;
      const dB = m.bands[k];
      if (dB == null || !isFinite(dB)) {
        b.style.height = "2%";
        b.classList.remove("hot");
        return;
      }
      const pct = Math.max(2, Math.min(100, ((dB + 60) / 60) * 100));
      b.style.height = pct + "%";
      if (dB > -10) b.classList.add("hot"); else b.classList.remove("hot");
    });
  }

  // Sparkline LUFS
  if (m.lufs != null && isFinite(m.lufs)) {
    lufsHistory.push(m.lufs);
  } else {
    lufsHistory.push(null);
  }
  while (lufsHistory.length > SPARK_HISTORY) lufsHistory.shift();
  drawSparkline();
}
function drawSparkline() {
  if (!sparkCtx || !sparkCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = sparkCanvas.clientWidth, h = sparkCanvas.clientHeight;
  if (w === 0 || h === 0) return;
  if (sparkCanvas.width !== Math.round(w * dpr) || sparkCanvas.height !== Math.round(h * dpr)) {
    sparkCanvas.width = Math.round(w * dpr);
    sparkCanvas.height = Math.round(h * dpr);
    sparkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sparkCtx.clearRect(0, 0, w, h);

  // Línea meta -14 LUFS (dashed dorada)
  const targetY = h - ((SPARK_TARGET - SPARK_MIN) / (SPARK_MAX - SPARK_MIN)) * h;
  sparkCtx.strokeStyle = "rgba(212, 175, 55, 0.35)";
  sparkCtx.lineWidth = 1;
  sparkCtx.setLineDash([2, 3]);
  sparkCtx.beginPath();
  sparkCtx.moveTo(0, targetY);
  sparkCtx.lineTo(w, targetY);
  sparkCtx.stroke();
  sparkCtx.setLineDash([]);

  if (lufsHistory.length < 2) return;

  // Gradiente vino→oro bajo la curva
  const grad = sparkCtx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(212, 175, 55, 0.35)");
  grad.addColorStop(1, "rgba(107, 15, 26, 0.05)");

  const points = [];
  for (let i = 0; i < lufsHistory.length; i++) {
    const v = lufsHistory[i];
    if (v == null || !isFinite(v)) { points.push(null); continue; }
    const x = (i / (SPARK_HISTORY - 1)) * w;
    const clamped = Math.max(SPARK_MIN, Math.min(SPARK_MAX, v));
    const y = h - ((clamped - SPARK_MIN) / (SPARK_MAX - SPARK_MIN)) * h;
    points.push({ x, y });
  }

  // Área rellena
  sparkCtx.fillStyle = grad;
  sparkCtx.beginPath();
  let opened = false;
  let lastX = 0;
  for (const p of points) {
    if (!p) continue;
    if (!opened) { sparkCtx.moveTo(p.x, h); sparkCtx.lineTo(p.x, p.y); opened = true; }
    else sparkCtx.lineTo(p.x, p.y);
    lastX = p.x;
  }
  if (opened) {
    sparkCtx.lineTo(lastX, h);
    sparkCtx.closePath();
    sparkCtx.fill();
  }

  // Línea superior dorada
  sparkCtx.strokeStyle = "#D4AF37";
  sparkCtx.lineWidth = 1.5;
  sparkCtx.beginPath();
  let started = false;
  for (const p of points) {
    if (!p) { started = false; continue; }
    if (!started) { sparkCtx.moveTo(p.x, p.y); started = true; }
    else sparkCtx.lineTo(p.x, p.y);
  }
  sparkCtx.stroke();
}

// Auto-clear si el Bridge dejó de mandar métricas hace >4s.
// El strip queda en "—" para no mentir con datos viejos.
setInterval(() => {
  if (lastMetricsAt && Date.now() - lastMetricsAt > 4000) {
    setMetricVal("m-lufs", null, null);
    setMetricVal("m-tp", null, null);
    setMetricVal("m-rms", null, null);
    setMetricVal("m-crest", null, null);
    document.querySelectorAll(".metrics-bands .band").forEach((b) => {
      b.style.height = "2%";
      b.classList.remove("hot");
    });
    lastMetricsAt = 0;
  }
}, 2000);

// Redibujar sparkline al resize de la ventana (el Pastor estira el HUD).
window.addEventListener("resize", () => {
  drawSparkline();
});

/* ============================================================
 * MUSIC MONITORS — Pastor 26-may-2026 (Bridge 1.9.0)
 * ============================================================
 * Reemplazan la orb idle. 7 monitores locales + 2 IA cacheados:
 *   LOCAL: bpm / key / energy / dynamics / groove / tempo / crescendo
 *   IA:    style / reference
 * Refresh local: 2s (suscripción overlay:music-profile).
 * Refresh IA: solo cuando cambia BPM (±10), key, o energy band.
 * ============================================================ */
const musicState = {
  lastProfile: null,
  lastStyleSig: null,         // "bpm-bucket|key|energy" usado para gatear llamada IA
  lastStyleAt: 0,             // último ts de llamada IA
  STYLE_MIN_INTERVAL_MS: 25_000,  // hard floor entre llamadas, aunque cambie todo
  STYLE_TTL_MS: 8 * 60_000,   // refrescar IA al menos cada 8 min aunque no cambie nada
  styleCache: { style: null, reference: null, character: null },
};

function bpmBucket(bpm) {
  if (!bpm) return "x";
  return String(Math.round(bpm / 10) * 10);  // bucket de 10 BPM
}
function setMm(id, val, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = val == null || val === "" ? "—" : escapeHtml(String(val)) + (opts.suffix || "");
}
function setMmCardDim(cardId, dim) {
  const el = document.getElementById(cardId);
  if (!el) return;
  el.classList.toggle("mm-dim", !!dim);
}

function renderMusicProfile(p) {
  if (!p) return;
  musicState.lastProfile = p;

  // BPM — con * si la confianza es <40
  const bpmTxt = p.bpm
    ? `${p.bpm}${p.bpmConfidence < 40 ? '<span class="mm-low-conf">*</span>' : ''}`
    : "—";
  const bpmEl = document.getElementById("mm-bpm");
  if (bpmEl) bpmEl.innerHTML = bpmTxt;
  setMmCardDim("mm-bpm-card", !p.bpm);

  // Pulso del HUD sincronizado al BPM detectado
  if (p.bpm && p.bpm > 30 && p.bpm < 250) {
    const periodMs = (60_000 / p.bpm);
    const pulse = document.getElementById("mm-bpm-pulse");
    if (pulse) pulse.style.setProperty("--bpm-period", `${periodMs}ms`);
  }

  // KEY — con * si confianza <30
  const keyTxt = p.key
    ? `${p.key}${p.keyConfidence < 30 ? '<span class="mm-low-conf">*</span>' : ''}`
    : "—";
  const keyEl = document.getElementById("mm-key");
  if (keyEl) keyEl.innerHTML = keyTxt;

  setMm("mm-energy", p.energyLabel || "—");
  setMm("mm-tempo", p.tempoLabel || "—");
  setMm("mm-groove", p.grooveLabel || "—");
  setMm("mm-dynamics", p.dynamicsLabel || "—");
  setMm("mm-crescendo", p.crescendoLabel || "→");

  // ¿Toca refrescar STYLE / REFERENCE vía IA? (gateado, cacheado)
  maybeFetchStyle(p);
}

async function maybeFetchStyle(p) {
  // Necesitamos al menos BPM o KEY para que la IA tenga algo que interpretar
  if (!p.bpm && !p.key) return;
  const sig = `${bpmBucket(p.bpm)}|${p.key || "x"}|${p.energyLabel || "x"}|${p.grooveLabel || "x"}`;
  const now = Date.now();
  const ageMs = now - musicState.lastStyleAt;
  const changed = sig !== musicState.lastStyleSig;
  const tooSoon = ageMs < musicState.STYLE_MIN_INTERVAL_MS;
  const stale = ageMs > musicState.STYLE_TTL_MS;

  // Llamar IA solo si: (sig cambió y no es demasiado pronto) o (cache vieja)
  if (!changed && !stale) return;
  if (tooSoon && !stale) return;

  musicState.lastStyleSig = sig;
  musicState.lastStyleAt = now;

  const payload = {
    bpm: p.bpm,
    key: p.key,
    energy: p.energyLabel,
    dynamics: p.dynamicsLabel,
    groove: p.grooveLabel,
    tempo: p.tempoLabel,
    crescendo: p.crescendoLabel,
  };

  try {
    let data = null;

    // Preferido: vía WS autenticada del Bridge (overlay vive en file://, sin cookies).
    // Si estamos en preview web (sin overlayAPI), caemos al fetch HTTP normal.
    if (window.overlayAPI && typeof window.overlayAPI.requestStyleTag === "function") {
      const r = await window.overlayAPI.requestStyleTag(payload);
      if (r && r.ok) data = r;
    } else {
      const res = await fetch("/api/coproductor/style-tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (res.ok) data = await res.json();
    }

    if (data && (data.style || data.reference || data.character)) {
      musicState.styleCache = {
        style: data.style || musicState.styleCache.style,
        reference: data.reference || musicState.styleCache.reference,
        character: data.character || musicState.styleCache.character,
      };
      if (musicState.styleCache.style) setMm("mm-style", musicState.styleCache.style);
      if (musicState.styleCache.reference) setMm("mm-reference", musicState.styleCache.reference);
    }
  } catch (err) {
    // Cero ruido al usuario — si falla, simplemente queda lo cacheado.
    console.warn("[music-monitors] style-tag fail:", err.message);
  }
}

// Auto-clear si no llegan music profiles en >8s (la pista paró)
let lastMusicProfileAt = 0;
setInterval(() => {
  if (lastMusicProfileAt && Date.now() - lastMusicProfileAt > 8000) {
    setMm("mm-bpm", "—");
    setMm("mm-key", "—");
    setMm("mm-energy", "—");
    setMm("mm-tempo", "—");
    setMm("mm-groove", "—");
    setMm("mm-dynamics", "—");
    setMm("mm-crescendo", "→");
    setMmCardDim("mm-bpm-card", true);
    lastMusicProfileAt = 0;
  }
}, 2500);

/* ============================================================
 * MICRO-FEEDBACK AUTOMÁTICO (Observation Engine → chat)
 * ============================================================
 * Pastor 25-may-2026: cuando el motor heurístico del server detecta
 * algo (kick saltó, voz tapada, limiter respirando…) lo mandamos
 * acá como mensaje del copilot sin que el Pastor pregunte nada.
 *
 * Anti-spam: máximo 1 cada 6s, dedup por code reciente (últimos 30s),
 * y solo critical/warn — info/good se silencian para no ensuciar el chat.
 * ============================================================ */
const microFeedback = {
  lastEmitAt: 0,
  MIN_INTERVAL_MS: 6_000,
  recentCodes: new Map(),  // code -> timestamp
  recentTexts: new Map(),  // texto normalizado -> timestamp
  // Pastor 26-may-2026: el dedup por code (30s) no alcanzaba porque el
  // Observation Engine emite el mismo síntoma con codes distintos cuando
  // cambia ligeramente el contexto (ej: "loudness_low" vs "loudness_low_streaming").
  // Resultado: el copiloto repetía "la mezcla suena chica" cada 30s.
  // Solución: dedup por texto normalizado con ventana de 5 minutos.
  DEDUP_WINDOW_MS: 30_000,
  TEXT_DEDUP_WINDOW_MS: 5 * 60_000,
  SEVERITY_ICON: { critical: "⚠️", warn: "•", info: "·", good: "✨" },
};

// Normaliza un texto para comparar: lowercase, sin tildes, sin números,
// sin signos, colapsando espacios. Así "−19.7 LUFS" y "−18.2 LUFS"
// caen al mismo bucket si el resto de la oración es igual.
function normalizeObsText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[-+]?\d+([.,]\d+)?/g, "#")
    .replace(/[^\p{L}\s#]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function pushObservationToChat(obs) {
  if (!obs || !obs.code || !obs.text) return;
  // Filtrar info/good — solo críticas y advertencias merecen interrumpir
  if (obs.severity !== "critical" && obs.severity !== "warn") return;

  const now = Date.now();
  const lastCode = microFeedback.recentCodes.get(obs.code) ?? 0;
  if (now - lastCode < microFeedback.DEDUP_WINDOW_MS) return;

  // Dedup por texto normalizado (5 min) — evita que el copiloto repita
  // la misma observación con codes ligeramente distintos.
  const normText = normalizeObsText(obs.text);
  if (normText) {
    const lastText = microFeedback.recentTexts.get(normText) ?? 0;
    if (now - lastText < microFeedback.TEXT_DEDUP_WINDOW_MS) return;
    microFeedback.recentTexts.set(normText, now);
  }

  if (now - microFeedback.lastEmitAt < microFeedback.MIN_INTERVAL_MS) return;

  microFeedback.recentCodes.set(obs.code, now);
  microFeedback.lastEmitAt = now;

  // Limpieza periódica de ambos dedup maps
  if (microFeedback.recentCodes.size > 30) {
    for (const [k, ts] of microFeedback.recentCodes) {
      if (now - ts > microFeedback.DEDUP_WINDOW_MS * 2) microFeedback.recentCodes.delete(k);
    }
  }
  if (microFeedback.recentTexts.size > 40) {
    for (const [k, ts] of microFeedback.recentTexts) {
      if (now - ts > microFeedback.TEXT_DEDUP_WINDOW_MS * 2) microFeedback.recentTexts.delete(k);
    }
  }

  const icon = microFeedback.SEVERITY_ICON[obs.severity] || "•";
  setVisual("analyzing", { autoRevert: 2200 });
  renderMessage({
    role: "assistant",
    text: `${icon} ${obs.text}`,
    severity: obs.severity,
  });
}

/* ============================================================
 * MENSAJE DE BIENVENIDA + SUSCRIPCIONES REALES
 * ============================================================ */
window.addEventListener("DOMContentLoaded", () => {
  setOpacity(state.opacity * 100);

  const isRealBridge = typeof window.overlayAPI?.sendLiveMessage === "function";

  if (isRealBridge) {
    renderMessage({
      role: "assistant",
      text: "Acá estoy. Bridge conectado — escucho tu sesión en vivo y aviso cuando algo cambie. Escribime cualquier duda; respondo en 1-2 líneas.",
    });

    // Marcar body como "estamos en Electron" — el CSS deja el HUD ocupar
    // 100% de la ventana real (resizable), en vez de la maqueta 480x720 del preview web.
    document.body.setAttribute("data-electron", "true");

    // Suscripción a métricas en vivo del master (LUFS / TP / RMS / Crest / bandas).
    // El Bridge desktop empuja vía IPC overlay:metrics cada ~500ms.
    if (typeof window.overlayAPI?.onMetrics === "function") {
      window.overlayAPI.onMetrics(renderMetrics);
    }
    // Bridge 1.9.0 — perfil musical (BPM/key/tempo/groove/energy/dinámica/crescendo).
    // Cada 2s desde capture.html. 100% local, cero coste IA en este path.
    if (typeof window.overlayAPI?.onMusicProfile === "function") {
      window.overlayAPI.onMusicProfile((p) => {
        lastMusicProfileAt = Date.now();
        renderMusicProfile(p);
      });
    }

    // Suscripción al Observation Engine del server (vía main.js → IPC)
    if (typeof window.overlayAPI?.onObservations === "function") {
      window.overlayAPI.onObservations((obsList) => {
        if (!Array.isArray(obsList)) return;
        // Procesar la más severa primero
        const ranked = [...obsList].sort((a, b) => {
          const r = { critical: 4, warn: 3, info: 2, good: 1 };
          return (r[b.severity] || 0) - (r[a.severity] || 0);
        });
        ranked.forEach(pushObservationToChat);
      });
    }

    // Bridge 1.10.1 — Suscripción a la lista de devices (push desde main.js)
    if (typeof window.overlayAPI?.onAudioInputs === "function") {
      window.overlayAPI.onAudioInputs((payload) => {
        if (!payload) return;
        audioState = {
          inputs: Array.isArray(payload.inputs) ? payload.inputs : [],
          selected: payload.selected || { deviceId: null, label: null },
        };
        if (audioPanelOpen) renderAudioPanel();
      });
    }
    // Bridge 1.10.1 — Si Windows no pudo crear el tray, mostrar banner en el HUD
    // para que el Pastor sepa que el botón 🎤 del header reemplaza al tray menu.
    if (typeof window.overlayAPI?.onTrayWarning === "function") {
      window.overlayAPI.onTrayWarning((msg) => {
        if (!msg) return;
        const hud = $("#hud");
        if (!hud || hud.querySelector(".tray-warning-banner")) return;
        const banner = document.createElement("div");
        banner.className = "tray-warning-banner";
        banner.style.position = "absolute";
        banner.style.top = "60px";
        banner.style.left = "12px";
        banner.style.right = "12px";
        banner.style.zIndex = "9";
        banner.textContent = String(msg);
        hud.appendChild(banner);
        renderMessage({
          role: "assistant",
          text: "⚠️ Windows no me dejó crear el ícono del tray. Usá el botón 🎤 del header para elegir la fuente de audio — hace exactamente lo mismo que el menú del tray.",
        });
      });
    }
    // Pedir estado inicial de audio (lista + selected) por si el HUD abrió
    // antes que capture.html hubiera publicado los devices.
    if (typeof window.overlayAPI?.getAudioState === "function") {
      window.overlayAPI.getAudioState().then((s) => {
        if (s && Array.isArray(s.inputs)) audioState = s;
      }).catch(() => {});
    }

    // Indicador de status del Bridge en el chat (1 sola vez por cambio)
    if (typeof window.overlayAPI?.onStatus === "function") {
      let capDropMsgPosted = false; // ¿ya avisamos un corte REAL en el chat?
      window.overlayAPI.onStatus((s) => {
        const nowConnected = !!(s && s.connected);
        capDisconnectReason = (s && s.reason) || null;

        if (nowConnected) {
          const wasDown = !capConnected;
          capConnected = true;
          capEverConnected = true;
          capDisconnectedAt = 0;
          if (capPendingDropMsg) { clearTimeout(capPendingDropMsg); capPendingDropMsg = null; }
          renderCapStatus();
          // Solo avisar "reconectado" si antes hubo un corte REAL anunciado
          // (no por los parpadeos de ~2-3s del reciclaje del hosting).
          if (wasDown && capDropMsgPosted) {
            capDropMsgPosted = false;
            renderMessage({ role: "assistant", text: "🟢 Bridge reconectado al estudio." });
          }
          return;
        }

        if (capConnected) capDisconnectedAt = Date.now(); // momento exacto del corte
        capConnected = false;
        renderCapStatus();
        // No alarmar de inmediato: el hosting recicla la conexión cada ~5 min y
        // vuelve en ~2-3s. Solo avisar si el corte SUPERA la ventana de gracia.
        if (!capPendingDropMsg && !capDropMsgPosted) {
          capPendingDropMsg = setTimeout(() => {
            capPendingDropMsg = null;
            if (!capConnected) {
              capDropMsgPosted = true;
              renderMessage({
                role: "assistant",
                text: "🔴 Bridge desconectado" + (capDisconnectReason ? " — " + capDisconnectReason : "") + ". Reconectá desde el tray.",
              });
            }
          }, CAP_RECONNECT_GRACE);
        }
      });
    }

    // Bridge 1.15.0 — Fuente activa / Estado de captura en el header del HUD.
    // Pull inmediato al abrir (última fuente reportada) + updates en vivo.
    if (typeof window.overlayAPI?.getCaptureSource === "function") {
      window.overlayAPI.getCaptureSource().then((info) => {
        if (info) { capSource = info; renderCapStatus(); }
      }).catch(() => {});
    }
    if (typeof window.overlayAPI?.onCaptureSource === "function") {
      window.overlayAPI.onCaptureSource((info) => {
        capSource = info || null;
        renderCapStatus();
      });
    }
    // Si las métricas DEJAN de llegar (captura caída, Cubase mudo), el timeout
    // de señal hace caer el estado a "Sin señal" aunque renderMetrics no corra.
    setInterval(renderCapStatus, 1000);
    renderCapStatus();
  } else {
    // Preview web sin Bridge
    renderMessage({
      role: "assistant",
      text: "Modo preview (sin Bridge). Probá escribir algo — respondo con mocks. En el Bridge real escucho la sesión en vivo.",
      actions: [
        { label: "▸ Ver estados visuales", id: "demo-states" },
        { label: "▸ Probar modo compacto", id: "demo-compact" },
      ],
    });

    document.addEventListener("click", (e) => {
      const id = e.target?.dataset?.actionId;
      if (id === "demo-states") demoStatesShowcase();
      if (id === "demo-compact") setMode("compact");
    });
  }
});

async function demoStatesShowcase() {
  const sequence = [
    { state: "listening", label: "Escuchando", ms: 1800 },
    { state: "thinking", label: "Pensando", ms: 1600 },
    { state: "analyzing", label: "Analizando frecuencias", ms: 2400 },
    { state: "processing", label: "Procesando stems", ms: 2600 },
    { state: "speaking", label: "Respondiendo", ms: 1800 },
    { state: "error", label: "Error simulado", ms: 1400 },
  ];
  for (const s of sequence) {
    setVisual(s.state);
    await new Promise(r => setTimeout(r, s.ms));
  }
  setVisual("idle");
  renderMessage({
    role: "assistant",
    text: "Los 7 estados visuales están operativos. Cada uno se activa según contexto del Coproductor (escucha STT, generación, DSP, separación de stems, TTS, error).",
  });
}
