"use strict";
// ─── Receptor mínimo ReaStream — PoC del Audio Gateway sin VoiceMeeter ──────
// (Pastor 8-ago-2026: "primero validar, después integrar")
//
// ReaStream (plugin gratuito de Cockos) se pone en el master de Cubase y manda
// el audio por UDP local (puerto 58710). Este módulo SOLO recibe y parsea esos
// paquetes y entrega PCM mono float32 al pipeline EXISTENTE de captura
// (medidor + ring + clip) — no toca nada más del Bridge.
//
// Protocolo (público, http://www.1014.org/shiz/reastream.txt):
//   bytes 0-3   'M','R','S','R'  (audio; 'mRSR' = MIDI, lo ignoramos)
//   bytes 4-7   int32 LE packetsize
//   bytes 8-39  identifier (32 bytes, zero padded)
//   byte  40    uint8 nch (1-64)
//   bytes 41-44 int32 LE samplerate
//   bytes 45-46 uint16 LE sblocklen (bytes de audio, máx 1200)
//   bytes 47+   float32 LE NO-interleaved (bloque ch0, bloque ch1, …)
//
// Nivel REAL garantizado por diseño: la señal sale del master del DAW, antes
// del volumen de Windows — la divergencia ~13dB del loopback no existe acá.

const dgram = require("dgram");

const REASTREAM_PORT = 58710;
const HEADER_LEN = 47;
// Lote de ~100ms antes de mandar por IPC — cientos de paquetes/s por IPC
// individual sería ruido; el FIFO del renderer absorbe el granulado.
const FLUSH_MS = 100;

// Parsea UN bloque de audio que empieza en `off`. Devuelve { block|null, next }.
// REGLA DURA (review 8-ago): si el datagrama no trae el bloque COMPLETO según
// su propio header (packetsize/sblocklen), se DESCARTA — jamás downmixear un
// bloque parcial (desalinearía los canales y corrompería el audio del medidor).
// Nota de framing: ReaStream manda bloques ≤1200 bytes, uno por datagrama
// (UDP entrega el datagrama entero o nada); igual soportamos varios bloques
// concatenados avanzando por packetsize.
function parseAudioBlockAt(msg, off) {
  if (msg.length - off < HEADER_LEN) return { block: null, next: msg.length };
  const isAudio = msg[off] === 0x4d && msg[off + 1] === 0x52 && msg[off + 2] === 0x53 && msg[off + 3] === 0x52; // 'MRSR'
  const isMidi = msg[off] === 0x6d && msg[off + 1] === 0x52 && msg[off + 2] === 0x53 && msg[off + 3] === 0x52;  // 'mRSR'
  const packetSize = msg.readInt32LE(off + 4);
  if (packetSize < HEADER_LEN || off + packetSize > msg.length) {
    // Header corrupto o bloque truncado → tirar el resto del datagrama.
    return { block: null, next: msg.length };
  }
  const next = off + packetSize;
  if (!isAudio) return { block: null, next: isMidi ? next : msg.length };
  const nch = msg.readUInt8(off + 40);
  const sampleRate = msg.readInt32LE(off + 41);
  const blockLen = msg.readUInt16LE(off + 45);
  if (nch < 1 || nch > 64) return { block: null, next };
  if (sampleRate < 8000 || sampleRate > 384000) return { block: null, next };
  // El bloque declara sblocklen: debe caber ENTERO dentro de packetsize y del
  // datagrama, y ser múltiplo exacto de 4·nch (canales completos) — si no, drop.
  if (HEADER_LEN + blockLen > packetSize) return { block: null, next };
  if (blockLen % (4 * nch) !== 0) return { block: null, next };
  const perCh = blockLen / 4 / nch;
  if (perCh <= 0) return { block: null, next };
  // Downmix promedio → mono (el pipeline del Bridge es mono, igual que hoy).
  const mono = new Float32Array(perCh);
  const dataBase = off + HEADER_LEN;
  for (let ch = 0; ch < nch; ch++) {
    const base = dataBase + ch * perCh * 4;
    for (let i = 0; i < perCh; i++) mono[i] += msg.readFloatLE(base + i * 4);
  }
  if (nch > 1) {
    for (let i = 0; i < perCh; i++) mono[i] /= nch;
  }
  return { block: { mono, sampleRate, nch }, next };
}

/** Datagrama → lista de bloques de audio completos y válidos. */
function parseDatagram(msg) {
  const blocks = [];
  let off = 0;
  while (off + HEADER_LEN <= msg.length) {
    const { block, next } = parseAudioBlockAt(msg, off);
    if (block) blocks.push(block);
    if (next <= off) break; // defensa anti-loop
    off = next;
  }
  return blocks;
}

// Compat con tests existentes: un datagrama con un solo bloque.
function parseAudioPacket(msg) {
  const blocks = parseDatagram(msg);
  return blocks.length > 0 ? blocks[0] : null;
}

/**
 * Crea el receptor. `onPcm(float32Array, sampleRate)` recibe lotes mono ~100ms.
 * `onStatus(status)` recibe "listening" | "receiving" | "idle" | "error".
 * Devuelve { start, stop } — stop es idempotente.
 */
function createReaStreamReceiver({ onPcm, onStatus, log }) {
  const say = (m) => { try { (log || console.log)("[ReaStream] " + m); } catch {} };
  let socket = null;
  let flushTimer = null;
  let idleTimer = null;
  let chunks = [];
  let chunkSamples = 0;
  let rate = 0;
  let packets = 0;
  let announcedFirst = false;

  function flush() {
    if (chunkSamples === 0 || !rate) return;
    const out = new Float32Array(chunkSamples);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    chunks = [];
    chunkSamples = 0;
    try { onPcm(out, rate); } catch (e) { say("onPcm error: " + e.message); }
  }

  function start() {
    if (socket) return;
    socket = dgram.createSocket("udp4");
    socket.on("error", (e) => {
      say("socket error: " + e.message);
      try { onStatus && onStatus("error"); } catch {}
      stop();
    });
    socket.on("message", (msg) => {
      const blocks = parseDatagram(msg);
      if (blocks.length === 0) return;
      for (const p of blocks) {
        packets++;
        if (!announcedFirst) {
          announcedFirst = true;
          say(`primer paquete de audio: ${p.nch}ch @ ${p.sampleRate}Hz — Cubase está hablando.`);
          try { onStatus && onStatus("receiving"); } catch {}
        }
        // Si el DAW cambia de sample rate a mitad, purgamos el lote a medias.
        if (rate && rate !== p.sampleRate) { chunks = []; chunkSamples = 0; }
        rate = p.sampleRate;
        chunks.push(p.mono);
        chunkSamples += p.mono.length;
      }
      // Silencio de fuente (stop en Cubase / plugin bypass) → estado idle.
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        announcedFirst = false;
        try { onStatus && onStatus("idle"); } catch {}
      }, 3000);
    });
    socket.bind(REASTREAM_PORT, () => {
      say(`escuchando UDP ${REASTREAM_PORT} (ReaStream en el master del DAW).`);
      try { onStatus && onStatus("listening"); } catch {}
    });
    flushTimer = setInterval(flush, FLUSH_MS);
  }

  function stop() {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    chunks = []; chunkSamples = 0; rate = 0; announcedFirst = false;
    if (socket) {
      const s = socket;
      socket = null;
      try { s.close(); } catch {}
      say(`receptor cerrado (${packets} paquetes recibidos en la sesión).`);
    }
  }

  return { start, stop };
}

module.exports = { createReaStreamReceiver, REASTREAM_PORT, parseAudioPacket, parseDatagram };
