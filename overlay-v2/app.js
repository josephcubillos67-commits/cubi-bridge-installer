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

function renderMessage({ role, text, actions = [] }) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? "👤" : "🎧";

  const content = document.createElement("div");

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;
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
$("#btn-settings").addEventListener("click", toggleSettings);
$("#btn-close").addEventListener("click", () => {
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
  recentCodes: new Map(), // code -> timestamp
  DEDUP_WINDOW_MS: 30_000,
  SEVERITY_ICON: { critical: "⚠️", warn: "•", info: "·", good: "✨" },
};

function pushObservationToChat(obs) {
  if (!obs || !obs.code || !obs.text) return;
  // Filtrar info/good — solo críticas y advertencias merecen interrumpir
  if (obs.severity !== "critical" && obs.severity !== "warn") return;

  const now = Date.now();
  const lastCode = microFeedback.recentCodes.get(obs.code) ?? 0;
  if (now - lastCode < microFeedback.DEDUP_WINDOW_MS) return;
  if (now - microFeedback.lastEmitAt < microFeedback.MIN_INTERVAL_MS) return;

  microFeedback.recentCodes.set(obs.code, now);
  microFeedback.lastEmitAt = now;

  // Limpieza periódica del dedup map
  if (microFeedback.recentCodes.size > 30) {
    for (const [k, ts] of microFeedback.recentCodes) {
      if (now - ts > microFeedback.DEDUP_WINDOW_MS * 2) microFeedback.recentCodes.delete(k);
    }
  }

  const icon = microFeedback.SEVERITY_ICON[obs.severity] || "•";
  setVisual("analyzing", { autoRevert: 2200 });
  renderMessage({ role: "assistant", text: `${icon} ${obs.text}` });
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

    // Indicador de status del Bridge en el chat (1 sola vez por cambio)
    if (typeof window.overlayAPI?.onStatus === "function") {
      let lastStatus = null;
      window.overlayAPI.onStatus((s) => {
        if (!s || s.connected === lastStatus) return;
        lastStatus = s.connected;
        renderMessage({
          role: "assistant",
          text: s.connected
            ? "🟢 Bridge conectado al estudio."
            : "🔴 Bridge desconectado. Reconectá desde el tray.",
        });
      });
    }
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
