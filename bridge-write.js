/**
 * ============================================================
 * CUBI Bridge · WRITE channel (CP5)
 * ============================================================
 *
 * MÓDULO SEPARADO del observer READ-ONLY del bridge. Vive en su
 * propio archivo y mantiene su propio estado para que no pueda
 * mezclarse accidentalmente con el flujo de captura de Cubase.
 *
 * Spec CP5 (Pastor):
 *   - OFF por defecto. Server manda midi_config{enabled, port}.
 *   - Si enabled+puerto encontrado → abre Output a loopMIDI.
 *   - Si no encontrado → reporta error, no crashea.
 *   - Mensajes midi_out se envían SOLO si enabled && port abierto.
 *   - Defensa en profundidad: aunque el server pida envío, este
 *     módulo ignora si está OFF localmente.
 *
 * Librería: @julusian/midi — fork mantenida de node-midi por el
 * team de Companion. Prebuilds para Electron 30+, zero compile
 * en target del Pastor. Si la dependencia falla al cargar
 * (Electron sin prebuild del binario), el módulo entra en modo
 * "disabled-by-missing-dep" y reporta el error al server SIN
 * tirar abajo el bridge.
 *
 * Mensajes IN (desde server):
 *   { type:"midi_config", enabled:boolean, port:string }
 *   { type:"midi_out", port, cc, channel, value7bit, source? }
 *
 * Mensajes OUT (hacia server):
 *   { type:"midi_out_status", connected:boolean, port:string, error?:string }
 *   { type:"midi_out_ack", ok:boolean, cc, channel, value7bit, error?:string }
 * ============================================================
 */

let midi = null;
let midiLoadError = null;
try {
  midi = require("@julusian/midi");
} catch (err) {
  midiLoadError = err && err.message ? err.message : String(err);
  console.warn("[Bridge WRITE] @julusian/midi no disponible:", midiLoadError);
}

let wsRef = null;
let output = null;
let enabled = false;
let portName = "CUBI_WRITE_OUT";
let portOpen = false;
let lastReportedStatus = null; // { connected, port, error } para evitar spam

function sendToServer(msg) {
  if (!wsRef || wsRef.readyState !== 1 /* OPEN */) return;
  try {
    wsRef.send(JSON.stringify(msg));
  } catch (e) {
    console.warn("[Bridge WRITE] sendToServer falló:", e && e.message);
  }
}

function reportStatus(error) {
  const status = {
    type: "midi_out_status",
    connected: portOpen,
    port: portName,
    error: error || null,
  };
  // Dedupe — no spamear si nada cambió
  const sig = `${status.connected}|${status.port}|${status.error || ""}`;
  if (lastReportedStatus === sig) return;
  lastReportedStatus = sig;
  sendToServer(status);
  console.log(
    `[Bridge WRITE] status connected=${status.connected} port=${status.port}${status.error ? " err=" + status.error : ""}`
  );
}

function listPorts() {
  if (!output) return [];
  const n = output.getPortCount();
  const out = [];
  for (let i = 0; i < n; i++) out.push(output.getPortName(i));
  return out;
}

function findPortIndex(name) {
  const ports = listPorts();
  for (let i = 0; i < ports.length; i++) {
    // Match case-insensitive + contains (loopMIDI prefija "0. " en algunos casos)
    if (ports[i] && ports[i].toLowerCase().includes(name.toLowerCase())) return i;
  }
  return -1;
}

function closePort() {
  if (output) {
    try {
      output.closePort();
    } catch {}
  }
  portOpen = false;
}

function openPort() {
  if (!midi) {
    reportStatus(`@julusian/midi no instalado: ${midiLoadError || "desconocido"}`);
    return;
  }
  if (!output) {
    try {
      output = new midi.Output();
    } catch (e) {
      reportStatus(`new midi.Output() falló: ${e && e.message}`);
      return;
    }
  }
  closePort();
  const idx = findPortIndex(portName);
  if (idx < 0) {
    const avail = listPorts();
    reportStatus(
      `Puerto "${portName}" no encontrado. Puertos disponibles: ${avail.length ? avail.join(" | ") : "(ninguno)"}`
    );
    return;
  }
  try {
    output.openPort(idx);
    portOpen = true;
    reportStatus(null);
  } catch (e) {
    reportStatus(`openPort(${idx}) falló: ${e && e.message}`);
  }
}

/**
 * Aplica un cambio de config (enabled/port). Si pasa de off→on,
 * intenta abrir el puerto. Si on→off, lo cierra.
 */
function applyConfig(newEnabled, newPort) {
  const prevEnabled = enabled;
  const prevPort = portName;
  enabled = !!newEnabled;
  if (typeof newPort === "string" && newPort.length > 0) portName = newPort;

  if (!enabled) {
    if (prevEnabled || portOpen) {
      closePort();
      reportStatus(null);
    } else {
      // forzar report inicial para que el server sepa el estado
      reportStatus(null);
    }
    return;
  }

  // enabled === true
  if (!portOpen || prevPort !== portName) {
    openPort();
  } else {
    reportStatus(null);
  }
}

/**
 * Envía un CC al puerto abierto. Defensa en profundidad — ignora si
 * el módulo está OFF localmente aunque el server lo pida.
 */
function handleMidiOut(msg) {
  const cc = Number(msg.cc);
  const ch = Number(msg.channel);
  const v7 = Number(msg.value7bit);
  const reqPort = String(msg.port || portName);

  if (!enabled) {
    sendToServer({
      type: "midi_out_ack",
      ok: false,
      cc,
      channel: ch,
      value7bit: v7,
      error: "disabled_locally",
    });
    return;
  }
  if (!output || !portOpen) {
    sendToServer({
      type: "midi_out_ack",
      ok: false,
      cc,
      channel: ch,
      value7bit: v7,
      error: "port_not_open",
    });
    return;
  }
  if (reqPort && reqPort.toLowerCase() !== portName.toLowerCase()) {
    sendToServer({
      type: "midi_out_ack",
      ok: false,
      cc,
      channel: ch,
      value7bit: v7,
      error: `port_mismatch (req=${reqPort} local=${portName})`,
    });
    return;
  }
  if (!Number.isFinite(cc) || cc < 0 || cc > 127) {
    sendToServer({ type: "midi_out_ack", ok: false, cc, channel: ch, value7bit: v7, error: "bad_cc" });
    return;
  }
  if (!Number.isFinite(ch) || ch < 1 || ch > 16) {
    sendToServer({ type: "midi_out_ack", ok: false, cc, channel: ch, value7bit: v7, error: "bad_channel" });
    return;
  }
  if (!Number.isFinite(v7) || v7 < 0 || v7 > 127) {
    sendToServer({ type: "midi_out_ack", ok: false, cc, channel: ch, value7bit: v7, error: "bad_value7bit" });
    return;
  }

  // Status byte: 0xB0 = Control Change, channel 1..16 → 0..15 en el nibble bajo
  const statusByte = 0xb0 | ((ch - 1) & 0x0f);
  try {
    output.sendMessage([statusByte, cc, v7]);
    console.log(
      `[Bridge WRITE] CC enviado port=${portName} cc=${cc} ch=${ch} val7=${v7} src=${msg.source ? JSON.stringify(msg.source) : "?"}`
    );
    sendToServer({ type: "midi_out_ack", ok: true, cc, channel: ch, value7bit: v7 });
  } catch (e) {
    sendToServer({
      type: "midi_out_ack",
      ok: false,
      cc,
      channel: ch,
      value7bit: v7,
      error: `sendMessage falló: ${e && e.message}`,
    });
  }
}

/**
 * Wire del módulo al WebSocket activo del bridge.
 * Llamar tras ws.on("open").
 */
function attach(ws) {
  wsRef = ws;
  // Reporte inicial del estado (probablemente OFF al boot)
  reportStatus(midiLoadError ? `dep_missing: ${midiLoadError}` : null);
}

/**
 * Desconectar — limpia el socket de referencia y cierra puerto.
 */
function detach() {
  wsRef = null;
  closePort();
  lastReportedStatus = null;
}

/**
 * Dispatch desde el handler central de ws.on("message"). Devuelve
 * true si el mensaje fue consumido por este módulo.
 */
function handleServerMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "midi_config") {
    applyConfig(msg.enabled, msg.port);
    return true;
  }
  if (msg.type === "midi_out") {
    handleMidiOut(msg);
    return true;
  }
  return false;
}

function getStatus() {
  return {
    enabled,
    portName,
    portOpen,
    midiLoadError,
  };
}

module.exports = {
  attach,
  detach,
  handleServerMessage,
  getStatus,
};
