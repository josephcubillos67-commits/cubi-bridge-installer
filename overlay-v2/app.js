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
function renderMetrics(m) {
  if (!m) return;
  lastMetricsAt = Date.now();
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
