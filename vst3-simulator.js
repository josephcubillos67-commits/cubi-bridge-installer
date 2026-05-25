#!/usr/bin/env node
/**
 * ============================================================
 * CUBI VST3 COMPANION — SIMULADOR (Bridge 2)
 * ============================================================
 *
 * Finge ser el VST3 Companion real que en el futuro se compilará
 * en C++ con el Steinberg VST3 SDK. Sirve para:
 *   1. Validar el protocolo IPC local de punta a punta sin esperar
 *      al binario.
 *   2. Probar que el Coproductor IA cruza correctamente las métricas
 *      live con la cadena de plugins.
 *   3. Documentar EXACTAMENTE qué mensaje espera el bridge desktop.
 *
 * Uso (con el bridge desktop corriendo en el mismo PC):
 *   node cubi-bridge/vst3-simulator.js
 *
 * Protocolo:
 *   - TCP loopback 127.0.0.1:49162
 *   - Una línea JSON por mensaje, terminada en "\n"
 *   - Mensaje único soportado: { type: "plugin-chain", ts, bus, plugins[] }
 *   - READ-ONLY: el bridge NUNCA responde con comandos hacia el VST3.
 *
 * El binario VST3 real implementará este mismo protocolo desde C++
 * usando el VST3 SDK + IComponentHandler + boost::asio (o el net stack
 * que prefiera el dev). Ver cubi-bridge/ARCHITECTURE.md sección
 * "Bridge 2 — Implementación del VST3 Companion".
 * ============================================================
 */

const net = require("net");

const HOST = process.env.BRIDGE_IPC_HOST || "127.0.0.1";
const PORT = parseInt(process.env.BRIDGE_IPC_PORT || "49162", 10);
const TICK_MS = parseInt(process.env.SIM_TICK_MS || "2000", 10);

// Cadena del master del Pastor — simula un setup típico de mastering en Cubase.
// Se inspira en el inventario real (FabFilter + Ozone + Sonible) del estudio.
function makeSnapshot() {
  // Pequeñas variaciones para que el Coproductor vea evolución entre snapshots.
  const grPro = 2 + Math.random() * 4;      // 2-6 dB de GR en el limiter
  const grComp = 1 + Math.random() * 2.5;   // 1-3.5 dB de GR en el compresor
  return {
    type: "plugin-chain",
    ts: Date.now(),
    bus: "master",
    plugins: [
      {
        slot: 1,
        name: "FabFilter Pro-Q 3",
        vendor: "FabFilter",
        category: "eq",
        bypass: false,
        preset: "Master HPF 30Hz + air shelf",
      },
      {
        slot: 2,
        name: "Sonible smart:EQ 3",
        vendor: "Sonible",
        category: "eq",
        bypass: false,
        preset: "Worship Master",
      },
      {
        slot: 3,
        name: "FabFilter Pro-C 2",
        vendor: "FabFilter",
        category: "comp",
        bypass: false,
        thresholdDb: -12,
        ratio: 2.0,
        gainReductionDb: parseFloat(grComp.toFixed(2)),
        preset: "Glue Master 2:1",
      },
      {
        slot: 4,
        name: "iZotope Ozone 11 Imager",
        vendor: "iZotope",
        category: "imager",
        bypass: false,
      },
      {
        slot: 5,
        name: "FabFilter Pro-L 2",
        vendor: "FabFilter",
        category: "limiter",
        bypass: false,
        thresholdDb: -3,
        ceilingDb: -1.0,
        gainReductionDb: parseFloat(grPro.toFixed(2)),
        oversampling: 4,
        preset: "Modern · Allround",
      },
      {
        slot: 6,
        name: "Youlean Loudness Meter 2",
        vendor: "Youlean",
        category: "analyzer",
        bypass: false,
      },
    ],
  };
}

const client = net.connect(PORT, HOST, () => {
  console.log(`[SIM] Conectado a CUBI Bridge en ${HOST}:${PORT}`);
  const send = () => {
    if (client.destroyed) return;
    const snap = makeSnapshot();
    client.write(JSON.stringify(snap) + "\n");
    const gr = snap.plugins.find(p => p.category === "limiter")?.gainReductionDb;
    console.log(`[SIM] → snapshot ${snap.plugins.length} plugins · Pro-L2 GR=${gr} dB`);
  };
  send();
  const timer = setInterval(send, TICK_MS);
  client.on("close", () => clearInterval(timer));
});

client.on("error", (err) => {
  if (err.code === "ECONNREFUSED") {
    console.error(`[SIM] No hay bridge desktop escuchando en ${HOST}:${PORT}. Arranca cubi-bridge primero.`);
  } else {
    console.error("[SIM] Error:", err.message);
  }
  process.exit(1);
});

client.on("close", () => {
  console.log("[SIM] Conexión cerrada.");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n[SIM] Detenido.");
  client.end();
});
