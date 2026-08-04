/**
 * ============================================================
 * CUBI Bridge · Canal REAPER (Prueba de perillas · OSC nativo)
 * ============================================================
 *
 * MÓDULO SEPARADO del observer READ-ONLY del bridge. Igual que
 * bridge-write.js (canal MIDI), vive en su propio archivo y mantiene
 * su propio estado para que NUNCA pueda mezclarse con el flujo de
 * captura/lectura de Cubase.
 *
 * QUÉ ES ESTO (Pastor):
 *   La PRUEBA MÍNIMA de que CUBI puede MOVER las perillas de REAPER
 *   (volumen, paneo, mute/solo y un parámetro de plugin) y LEERLAS de
 *   vuelta cuando vos las movés en REAPER. No es el proyecto grande:
 *   es la pregunta "¿REAPER deja que lo controlen desde afuera?".
 *
 * POR QUÉ OSC NATIVO (y no un script Lua dentro de REAPER):
 *   REAPER trae OSC de fábrica (Preferences → Control/OSC/web). No hay
 *   que instalar nada raro adentro de REAPER: solo activarlo con unos
 *   clics. Acá hablamos OSC por UDP a 127.0.0.1 con `dgram` (nativo de
 *   Node, CERO dependencias que compilar — a diferencia del MIDI).
 *
 * CONTRATO (igual patrón que bridge-write.js):
 *   - OFF por defecto. El server manda reaper_config{enabled, sendPort, recvPort}.
 *   - Si enabled → abre socket UDP local (escucha feedback de REAPER).
 *   - reaper_cmd se ejecuta SOLO si enabled && socket abierto. Valida rangos.
 *   - Defensa en profundidad: aunque el server pida ejecutar, este módulo
 *     ignora si está OFF localmente.
 *
 * Mensajes IN (desde server):
 *   { type:"reaper_config", enabled:boolean, sendPort?:number, recvPort?:number, sendHost?:string }
 *   { type:"reaper_cmd", id?, action, track?, fx?, param?, value? }
 *      action ∈ set_volume | set_pan | set_mute | set_solo | set_fx_param
 *
 * Mensajes OUT (hacia server):
 *   { type:"reaper_status", enabled, listening, sendHost, sendPort, recvPort, error? }
 *   { type:"reaper_state", track, field, value, fx?, param? }   // feedback de REAPER
 *   { type:"reaper_ack", ok, id?, action, error? }
 *
 * Mapeo OSC (Default.ReaperOSC):
 *   volumen  → /track/{n}/volume          (float 0..1 normalizado)
 *   paneo    → /track/{n}/pan             (float 0..1; 0.5 = centro)
 *   mute     → /track/{n}/mute            (float 0/1)
 *   solo     → /track/{n}/solo            (float 0/1)
 *   fx param → /track/{n}/fx/{f}/fxparam/{p}/value   (float 0..1)
 * ============================================================
 */

const dgram = require("dgram");

// ─────────────────────────────────────────────────────────────
// OSC codec — JS puro, big-endian, sin dependencias.
// Soporta float (f), int (i), string (s) y bundles (#bundle).
// Suficiente para la prueba; REAPER manda feedback en mensajes y
// bundles, así que el decoder maneja ambos.
// ─────────────────────────────────────────────────────────────

function pad4(n) {
  return (n + 3) & ~3;
}

function encodeOscString(str) {
  const raw = Buffer.from(String(str), "ascii");
  const out = Buffer.alloc(pad4(raw.length + 1)); // +1 null terminator; alloc rellena con ceros
  raw.copy(out, 0);
  return out;
}

/**
 * Construye un mensaje OSC.
 * @param {string} address  ej "/track/1/volume"
 * @param {Array<{type:'f'|'i'|'s', value:any}>} args
 */
function encodeOscMessage(address, args) {
  const addrBuf = encodeOscString(address);
  let typeTag = ",";
  const argBufs = [];
  for (const a of args || []) {
    if (a.type === "f") {
      typeTag += "f";
      const b = Buffer.alloc(4);
      b.writeFloatBE(Number(a.value) || 0, 0);
      argBufs.push(b);
    } else if (a.type === "i") {
      typeTag += "i";
      const b = Buffer.alloc(4);
      b.writeInt32BE((Number(a.value) | 0), 0);
      argBufs.push(b);
    } else if (a.type === "s") {
      typeTag += "s";
      argBufs.push(encodeOscString(String(a.value)));
    }
  }
  return Buffer.concat([addrBuf, encodeOscString(typeTag), ...argBufs]);
}

function decodeOscString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString("ascii", offset, end);
  const next = offset + pad4(end - offset + 1);
  return { str, next };
}

function decodeOscMessage(buf, start, end) {
  const a = decodeOscString(buf, start);
  const address = a.str;
  if (!address.startsWith("/")) return null;
  const t = decodeOscString(buf, a.next);
  const typeTag = t.str;
  if (!typeTag.startsWith(",")) return { address, args: [] };
  const args = [];
  let off = t.next;
  for (let i = 1; i < typeTag.length; i++) {
    const c = typeTag[i];
    if (c === "f") { if (off + 4 <= end) args.push(buf.readFloatBE(off)); off += 4; }
    else if (c === "i") { if (off + 4 <= end) args.push(buf.readInt32BE(off)); off += 4; }
    else if (c === "s") { const r = decodeOscString(buf, off); args.push(r.str); off = r.next; }
    else if (c === "T") { args.push(true); }
    else if (c === "F") { args.push(false); }
    else if (c === "d") { off += 8; } // double — ignorado
    else { /* tipo no soportado: no podemos avanzar con seguridad → cortamos */ break; }
  }
  return { address, args };
}

/**
 * Decodifica un paquete OSC (mensaje suelto o bundle anidado).
 * Devuelve un array plano de { address, args }.
 */
function decodeOscPacket(buf) {
  if (!buf || buf.length < 4) return [];
  if (buf.length >= 8 && buf.toString("ascii", 0, 7) === "#bundle") {
    const out = [];
    let off = 16; // 8 (#bundle\0) + 8 (timetag)
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off);
      off += 4;
      if (size <= 0 || off + size > buf.length) break;
      const sub = buf.subarray(off, off + size);
      for (const m of decodeOscPacket(sub)) out.push(m);
      off += size;
    }
    return out;
  }
  const msg = decodeOscMessage(buf, 0, buf.length);
  return msg ? [msg] : [];
}

// ─────────────────────────────────────────────────────────────
// Estado del módulo
// ─────────────────────────────────────────────────────────────

let wsRef = null;
let enabled = false;
let sendHost = "127.0.0.1";
let sendPort = 8000; // "Local listen port" de REAPER (bridge → REAPER)
let recvPort = 9000; // bridge escucha acá (REAPER → bridge: feedback)
let sock = null;
let listening = false;
let lastReportedStatus = null;

// Rate limit defensivo (el thread de REAPER no debe saturarse).
let rlWindowStart = 0;
let rlCount = 0;
const RL_MAX_PER_SEC = 60;

// Dedupe de feedback: evita spamear el mismo valor exacto consecutivo.
const lastFeedback = new Map(); // key → value

function sendToServer(msg) {
  if (!wsRef || wsRef.readyState !== 1 /* OPEN */) return;
  try {
    wsRef.send(JSON.stringify(msg));
  } catch (e) {
    console.warn("[Bridge REAPER] sendToServer falló:", e && e.message);
  }
}

function reportStatus(error) {
  const status = {
    type: "reaper_status",
    enabled,
    listening,
    sendHost,
    sendPort,
    recvPort,
    error: error || null,
  };
  const sig = `${status.enabled}|${status.listening}|${status.sendHost}|${status.sendPort}|${status.recvPort}|${status.error || ""}`;
  if (lastReportedStatus === sig) return;
  lastReportedStatus = sig;
  sendToServer(status);
  console.log(
    `[Bridge REAPER] status enabled=${enabled} listening=${listening} send=${sendHost}:${sendPort} recv=${recvPort}${error ? " err=" + error : ""}`
  );
}

function closeSocket() {
  if (sock) {
    try { sock.close(); } catch {}
  }
  sock = null;
  listening = false;
  lastFeedback.clear();
}

function openSocket() {
  closeSocket();
  let s;
  try {
    s = dgram.createSocket({ type: "udp4", reuseAddr: true });
  } catch (e) {
    reportStatus(`createSocket falló: ${e && e.message}`);
    return;
  }

  s.on("error", (err) => {
    reportStatus(`socket error: ${err && err.message}`);
    closeSocket();
  });

  s.on("message", (raw) => {
    try {
      handleFeedback(raw);
    } catch (e) {
      console.warn("[Bridge REAPER] feedback parse:", e && e.message);
    }
  });

  s.on("listening", () => {
    listening = true;
    reportStatus(null);
  });

  try {
    // Bind SOLO a localhost — nunca expuesto a la red.
    s.bind(recvPort, "127.0.0.1");
    sock = s;
  } catch (e) {
    reportStatus(`bind(${recvPort}) falló: ${e && e.message}`);
  }
}

/**
 * Traduce el feedback OSC de REAPER a reaper_state para la UI del LAB.
 */
function handleFeedback(raw) {
  const messages = decodeOscPacket(raw);
  for (const m of messages) {
    const addr = m.address;
    const v = m.args && m.args.length ? Number(m.args[0]) : null;
    if (v === null || Number.isNaN(v)) continue;

    let parsed = null;
    let mt;
    if ((mt = addr.match(/^\/track\/(\d+)\/volume$/))) {
      parsed = { track: Number(mt[1]), field: "volume", value: v };
    } else if ((mt = addr.match(/^\/track\/(\d+)\/pan$/))) {
      parsed = { track: Number(mt[1]), field: "pan", value: v };
    } else if ((mt = addr.match(/^\/track\/(\d+)\/mute$/))) {
      parsed = { track: Number(mt[1]), field: "mute", value: v };
    } else if ((mt = addr.match(/^\/track\/(\d+)\/solo$/))) {
      parsed = { track: Number(mt[1]), field: "solo", value: v };
    } else if ((mt = addr.match(/^\/track\/(\d+)\/fx\/(\d+)\/fxparam\/(\d+)\/value$/))) {
      parsed = { track: Number(mt[1]), field: "fxparam", fx: Number(mt[2]), param: Number(mt[3]), value: v };
    }
    if (!parsed) continue; // ignoramos vu meters, transport, etc.

    const key = parsed.field === "fxparam"
      ? `t${parsed.track}.fx${parsed.fx}.p${parsed.param}`
      : `t${parsed.track}.${parsed.field}`;
    // Dedupe valor exacto consecutivo (recorta ruido sin perder el movimiento).
    if (lastFeedback.get(key) === parsed.value) continue;
    lastFeedback.set(key, parsed.value);

    sendToServer({ type: "reaper_state", ...parsed });
  }
}

function rateLimited() {
  const now = Date.now();
  if (now - rlWindowStart >= 1000) {
    rlWindowStart = now;
    rlCount = 0;
  }
  rlCount++;
  return rlCount > RL_MAX_PER_SEC;
}

function sendOsc(address, args) {
  if (!sock) return false;
  const buf = encodeOscMessage(address, args);
  try {
    sock.send(buf, sendPort, sendHost);
    return true;
  } catch (e) {
    console.warn("[Bridge REAPER] sendOsc falló:", e && e.message);
    return false;
  }
}

function ack(ok, msg, error) {
  sendToServer({
    type: "reaper_ack",
    ok: !!ok,
    id: msg && msg.id != null ? msg.id : null,
    action: msg ? msg.action : null,
    error: error || null,
  });
}

function applyConfig(newEnabled, newSendPort, newRecvPort, newSendHost) {
  const prevEnabled = enabled;
  const prevRecv = recvPort;
  enabled = !!newEnabled;
  if (Number.isFinite(Number(newSendPort)) && Number(newSendPort) > 0) sendPort = Number(newSendPort);
  if (Number.isFinite(Number(newRecvPort)) && Number(newRecvPort) > 0) recvPort = Number(newRecvPort);
  if (typeof newSendHost === "string" && newSendHost.length > 0) sendHost = newSendHost;

  if (!enabled) {
    if (prevEnabled || listening) closeSocket();
    reportStatus(null);
    return;
  }

  // enabled === true
  if (!listening || prevRecv !== recvPort) {
    openSocket();
  } else {
    reportStatus(null);
  }
}

function handleReaperCmd(msg) {
  const action = String(msg.action || "");
  const track = Number(msg.track);
  const value = Number(msg.value);

  // Defensa en profundidad: OFF local manda aunque el server pida ejecutar.
  if (!enabled) return ack(false, msg, "disabled_locally");
  if (!sock || !listening) return ack(false, msg, "not_listening");
  if (rateLimited()) return ack(false, msg, "rate_limited");

  const validTrack = Number.isInteger(track) && track >= 1 && track <= 512;
  const valid01 = Number.isFinite(value) && value >= 0 && value <= 1;

  switch (action) {
    case "set_volume": {
      if (!validTrack) return ack(false, msg, "bad_track");
      if (!valid01) return ack(false, msg, "OUT_OF_RANGE");
      return ack(sendOsc(`/track/${track}/volume`, [{ type: "f", value }]), msg);
    }
    case "set_pan": {
      if (!validTrack) return ack(false, msg, "bad_track");
      if (!valid01) return ack(false, msg, "OUT_OF_RANGE");
      return ack(sendOsc(`/track/${track}/pan`, [{ type: "f", value }]), msg);
    }
    case "set_mute": {
      if (!validTrack) return ack(false, msg, "bad_track");
      const on = value >= 0.5 ? 1 : 0;
      return ack(sendOsc(`/track/${track}/mute`, [{ type: "f", value: on }]), msg);
    }
    case "set_solo": {
      if (!validTrack) return ack(false, msg, "bad_track");
      const on = value >= 0.5 ? 1 : 0;
      return ack(sendOsc(`/track/${track}/solo`, [{ type: "f", value: on }]), msg);
    }
    case "set_fx_param": {
      const fx = Number(msg.fx);
      const param = Number(msg.param);
      if (!validTrack) return ack(false, msg, "bad_track");
      if (!Number.isInteger(fx) || fx < 1) return ack(false, msg, "bad_fx");
      if (!Number.isInteger(param) || param < 1) return ack(false, msg, "bad_param");
      if (!valid01) return ack(false, msg, "OUT_OF_RANGE");
      return ack(sendOsc(`/track/${track}/fx/${fx}/fxparam/${param}/value`, [{ type: "f", value }]), msg);
    }
    default:
      return ack(false, msg, `unknown_action:${action}`);
  }
}

/**
 * Wire del módulo al WebSocket activo del bridge. Llamar tras ws.on("open").
 */
function attach(ws) {
  wsRef = ws;
  reportStatus(null); // reporte inicial (probablemente OFF al boot)
}

/**
 * Desconectar — limpia el socket de referencia y cierra el UDP.
 */
function detach() {
  wsRef = null;
  closeSocket();
  lastReportedStatus = null;
}

/**
 * Dispatch desde el handler central de ws.on("message"). Devuelve true
 * si el mensaje fue consumido por este módulo.
 */
function handleServerMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "reaper_config") {
    applyConfig(msg.enabled, msg.sendPort, msg.recvPort, msg.sendHost);
    return true;
  }
  if (msg.type === "reaper_cmd") {
    handleReaperCmd(msg);
    return true;
  }
  return false;
}

function getStatus() {
  return { enabled, listening, sendHost, sendPort, recvPort };
}

module.exports = {
  attach,
  detach,
  handleServerMessage,
  getStatus,
  // Exportados para pruebas unitarias (mock / fixtures).
  _osc: { encodeOscString, encodeOscMessage, decodeOscString, decodeOscMessage, decodeOscPacket, pad4 },
};
