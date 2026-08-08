"use strict";
/**
 * ============================================================
 * CUBI Bridge · Render remoto — Mesa → Bridge → REAPER → Mesa
 * ============================================================
 *
 * Pedido del Pastor (8-ago-2026): que la Mesa pueda mandar una pista,
 * el Bridge la procese con SUS plugins reales (FX Chain de REAPER) y
 * la versión procesada vuelva sola a la Mesa. REAPER invisible.
 *
 * Flujo (todo sobre canales que YA existen):
 *   1. server → WS: { type:"render-request", jobId, chainName }
 *   2. Bridge baja el WAV:  GET  /api/bridge/render-input/:jobId?token=…
 *   3. renderWavWithChain() (motor validado por el PoC Manos)
 *   4. Bridge sube el WAV:  POST /api/bridge/render-output/:jobId?token=…
 *   5. En fallo: WS { type:"render-result", jobId, ok:false, reason } — honesto,
 *      jamás un archivo incompleto.
 *
 * Contrato: módulo aislado. main.js llama handleRenderRequest(msg, deps).
 * Un render a la vez (los plugins pesados no comparten bien la CPU).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { renderWavWithChain } = require("./vst-hands-poc");

let busy = false;

async function handleRenderRequest(msg, deps) {
  const { serverUrl, getToken, resolveChain, sendWs, log } = deps;
  const logFn = log || ((...a) => console.log("[Render]", ...a));
  const jobId = typeof msg.jobId === "string" ? msg.jobId.slice(0, 64) : "";
  const chainName = typeof msg.chainName === "string" ? msg.chainName.slice(0, 120) : "";
  const fail = (reason) => {
    logFn(`job ${jobId} FALLO: ${reason}`);
    try { sendWs({ type: "render-result", jobId, ok: false, reason }); } catch {}
  };

  if (!jobId) return; // sin jobId no hay a quién responder
  if (!chainName) return fail("sin nombre de cadena");
  if (busy) return fail("ocupado — ya hay un render en marcha");
  busy = true;

  const workDir = path.join(os.tmpdir(), "cubi-render-" + jobId.replace(/[^a-zA-Z0-9_-]/g, ""));
  try {
    const token = getToken();
    if (!token) return fail("bridge sin token");
    const chainPath = resolveChain(chainName);
    if (!chainPath) return fail(`cadena "${chainName}" no existe en la biblioteca`);

    // 1) Bajar el WAV de entrada
    fs.mkdirSync(workDir, { recursive: true });
    const inputPath = path.join(workDir, "entrada.wav");
    logFn(`job ${jobId}: bajando entrada…`);
    const dl = await fetch(`${serverUrl}/api/bridge/render-input/${encodeURIComponent(jobId)}?token=${encodeURIComponent(token)}`);
    if (!dl.ok) return fail(`descarga de entrada HTTP ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return fail("la entrada no es un WAV válido");
    fs.writeFileSync(inputPath, buf);

    // 2) Render con el motor validado del PoC
    logFn(`job ${jobId}: REAPER procesando con "${chainName}" (${Math.round(buf.length / 1024)}KB)…`);
    const r = await renderWavWithChain({ inputPath, chainPath });
    if (!r.ok) return fail(r.error + (r.logTail ? " · log: " + r.logTail.slice(-300) : ""));

    // 3) Subir el resultado (crudo, mismo patrón que la sesión del Estudio)
    const outBuf = fs.readFileSync(r.outputPath);
    logFn(`job ${jobId}: render OK en ${r.secs}s (${Math.round(outBuf.length / 1024)}KB), subiendo…`);
    const up = await fetch(`${serverUrl}/api/bridge/render-output/${encodeURIComponent(jobId)}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: outBuf,
    });
    if (!up.ok) return fail(`subida del resultado HTTP ${up.status}`);
    logFn(`job ${jobId}: COMPLETO ✔`);
    try { sendWs({ type: "render-result", jobId, ok: true, secs: r.secs }); } catch {}
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  } finally {
    busy = false;
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { handleRenderRequest };
