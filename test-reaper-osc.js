/**
 * ============================================================
 * PRUEBA MOCK end-to-end del canal REAPER (sin REAPER real)
 * ============================================================
 *
 * Valida la cadena COMPLETA del lado bridge sobre UDP de verdad:
 *
 *   reaper_config(enabled) → abre socket OSC
 *   reaper_cmd            → encode OSC → UDP → [REAPER falso]
 *   [REAPER falso]        → refleja el cambio como feedback OSC → UDP
 *   bridge-reaper         → decode → reaper_state hacia el "server"
 *
 * El "server" es un WebSocket falso que solo captura lo que el módulo
 * emite (reaper_status / reaper_ack / reaper_state).
 *
 * Lo único que NO se prueba acá es el REAPER real (eso lo hace el Pastor
 * en su PC). Si esto pasa, el código del bridge es correcto.
 *
 * Correr:  node cubi-bridge/test-reaper-osc.js
 * ============================================================
 */

const dgram = require("dgram");
const bridgeReaper = require("./bridge-reaper");
const { encodeOscMessage } = bridgeReaper._osc;

const SEND_PORT = 18000; // "REAPER falso" escucha acá (bridge → REAPER)
const RECV_PORT = 19000; // bridge escucha acá (REAPER → bridge feedback)

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── WebSocket FALSO: captura lo que el módulo manda al server ──
const captured = [];
const fakeWs = {
  readyState: 1, // OPEN
  send(str) { try { captured.push(JSON.parse(str)); } catch {} },
};
function last(type) {
  for (let i = captured.length - 1; i >= 0; i--) if (captured[i].type === type) return captured[i];
  return null;
}
function allOf(type) { return captured.filter((m) => m.type === type); }

// ── REAPER FALSO: recibe comandos OSC y refleja feedback ──
const reaper = dgram.createSocket({ type: "udp4", reuseAddr: true });
const reaperGot = [];

reaper.on("message", (raw) => {
  for (const m of decodeForTest(raw)) {
    reaperGot.push(m);
    // Refleja el cambio como feedback (lo que REAPER hace de verdad).
    const echo = encodeOscMessage(m.address, [{ type: "f", value: m.args[0] }]);
    reaper.send(echo, RECV_PORT, "127.0.0.1");
  }
});

// decoder local (reusa el del módulo)
function decodeForTest(buf) { return bridgeReaper._osc.decodeOscPacket(buf); }

async function run() {
  await new Promise((res) => reaper.bind(SEND_PORT, "127.0.0.1", res));
  console.log(`[mock] REAPER falso escuchando en 127.0.0.1:${SEND_PORT}`);

  // 1) attach + habilitar
  bridgeReaper.attach(fakeWs);
  bridgeReaper.handleServerMessage({ type: "reaper_config", enabled: true, sendPort: SEND_PORT, recvPort: RECV_PORT });
  await sleep(150); // bind del socket del bridge

  const st = last("reaper_status");
  check("status reporta enabled=true", !!st && st.enabled === true);
  check("status reporta listening=true", !!st && st.listening === true);
  check("status usa puertos correctos", !!st && st.sendPort === SEND_PORT && st.recvPort === RECV_PORT);

  // 2) comando set_volume → debe llegar a REAPER falso + ack + feedback
  captured.length = 0;
  reaperGot.length = 0;
  bridgeReaper.handleServerMessage({ type: "reaper_cmd", id: 1, action: "set_volume", track: 1, value: 0.5 });
  await sleep(150);

  check("REAPER falso recibió /track/1/volume", reaperGot.some((m) => m.address === "/track/1/volume" && Math.abs(m.args[0] - 0.5) < 1e-6));
  const ack = last("reaper_ack");
  check("ack ok=true con id=1", !!ack && ack.ok === true && ack.id === 1);
  const stt = last("reaper_state");
  check("feedback reaper_state volume 0.5 track 1", !!stt && stt.field === "volume" && stt.track === 1 && Math.abs(stt.value - 0.5) < 1e-6);

  // 3) fx param
  captured.length = 0; reaperGot.length = 0;
  bridgeReaper.handleServerMessage({ type: "reaper_cmd", id: 2, action: "set_fx_param", track: 2, fx: 1, param: 3, value: 0.8 });
  await sleep(150);
  check("REAPER falso recibió fxparam", reaperGot.some((m) => m.address === "/track/2/fx/1/fxparam/3/value" && Math.abs(m.args[0] - 0.8) < 1e-6));
  const fst = last("reaper_state");
  check("feedback fxparam parseado (fx/param)", !!fst && fst.field === "fxparam" && fst.fx === 1 && fst.param === 3 && Math.abs(fst.value - 0.8) < 1e-6);

  // 4) validación de rango → ack ok=false, NO llega a REAPER
  captured.length = 0; reaperGot.length = 0;
  bridgeReaper.handleServerMessage({ type: "reaper_cmd", id: 3, action: "set_volume", track: 1, value: 5 }); // fuera de rango
  await sleep(80);
  const badAck = last("reaper_ack");
  check("rango inválido → ack ok=false OUT_OF_RANGE", !!badAck && badAck.ok === false && badAck.error === "OUT_OF_RANGE");
  check("rango inválido NO se envió a REAPER", reaperGot.length === 0);

  // 5) feedback espontáneo (Pastor mueve perilla EN REAPER) vía bundle
  captured.length = 0;
  const m1 = encodeOscMessage("/track/1/pan", [{ type: "f", value: 0.25 }]);
  const m2 = encodeOscMessage("/track/2/mute", [{ type: "f", value: 1 }]);
  const sz = (b) => { const x = Buffer.alloc(4); x.writeInt32BE(b.length, 0); return x; };
  const head = Buffer.alloc(16); head.write("#bundle\0", 0, "ascii");
  const bundle = Buffer.concat([head, sz(m1), m1, sz(m2), m2]);
  reaper.send(bundle, RECV_PORT, "127.0.0.1");
  await sleep(120);
  const states = allOf("reaper_state");
  check("bundle feedback: pan 0.25 track1", states.some((s) => s.field === "pan" && s.track === 1 && Math.abs(s.value - 0.25) < 1e-6));
  check("bundle feedback: mute 1 track2", states.some((s) => s.field === "mute" && s.track === 2 && Math.abs(s.value - 1) < 1e-6));

  // 6) disabled → comando rechazado localmente
  bridgeReaper.handleServerMessage({ type: "reaper_config", enabled: false });
  await sleep(80);
  captured.length = 0; reaperGot.length = 0;
  bridgeReaper.handleServerMessage({ type: "reaper_cmd", id: 9, action: "set_volume", track: 1, value: 0.3 });
  await sleep(80);
  const offAck = last("reaper_ack");
  check("OFF local → ack ok=false disabled_locally", !!offAck && offAck.ok === false && offAck.error === "disabled_locally");
  check("OFF local NO envía a REAPER", reaperGot.length === 0);

  // limpieza
  bridgeReaper.detach();
  reaper.close();

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error("test crash:", e); process.exit(1); });
