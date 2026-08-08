"use strict";
/**
 * ============================================================
 * CUBI Bridge · PoC "Las Manos" — procesar un WAV con plugins reales
 * ============================================================
 *
 * QUÉ ES ESTO (Pastor, 8-ago-2026):
 *   La prueba mínima de que el Bridge puede TOMAR un WAV, pasarlo por
 *   uno de SUS plugins (Ozone, Neutron, el que sea) y devolver el WAV
 *   procesado. Sin interfaz nueva, sin automatizaciones, sin Mesa.
 *   Solo demostrar que las manos existen.
 *
 * CÓMO (Plan B de la visión Motor VST — reutilizar antes de construir):
 *   REAPER trae un convertidor por lote de fábrica:
 *     reaper.exe -batchconvert lista.txt
 *   La lista dice: este WAV, con esta cadena de FX (.RfxChain), a esta
 *   carpeta. REAPER carga el VST3 real, procesa offline y termina solo.
 *   Cero instalaciones nuevas: REAPER ya vive en la PC del Pastor.
 *
 * PASO ÚNICO PREVIO (una sola vez, en REAPER):
 *   Insertar Ozone/Neutron en un track → botón FX → guardar cadena
 *   ("Save FX chain…") → queda un .RfxChain con SU plugin y SU preset.
 *
 * CONTRATO: módulo aislado (patrón bridge-write/bridge-reaper). main.js
 * solo llama runHandsPoc(). Nada de esto toca captura/HUD/WS.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// ── Encontrar reaper.exe (rutas estándar de Windows) ─────────────
function findReaperExe() {
  if (process.platform !== "win32") return null;
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = [
    path.join(pf, "REAPER (x64)", "reaper.exe"),
    path.join(pf, "REAPER", "reaper.exe"),
    path.join(pf86, "REAPER", "reaper.exe"),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

// Carpeta default donde REAPER guarda las cadenas de FX del usuario.
function fxChainsDir() {
  return path.join(process.env.APPDATA || os.homedir(), "REAPER", "FXChains");
}

// ── Armar la lista de batchconvert ───────────────────────────────
// Formato oficial (REAPER User Guide, "Batch File/Item Converter"):
//   <CONFIG ... > primero, luego un archivo por línea.
//   FXCHAIN aplica el .RfxChain a cada archivo; OUTPATH + OUTPATTERN
//   definen el destino. Sin OUTFMT usa WAV default del conversor.
function buildBatchList(inputWav, chainPath, outDir, outBaseName) {
  return [
    "<CONFIG",
    `FXCHAIN "${chainPath}"`,
    `OUTPATH "${outDir}"`,
    `OUTPATTERN "${outBaseName}"`,
    ">",
    inputWav,
    "",
  ].join("\r\n");
}

/**
 * ── Motor de render reutilizable (headless, sin diálogos) ────────
 * El MISMO camino validado por el PoC, expuesto para el flujo
 * Mesa→Bridge→REAPER→Mesa. Devuelve veredicto honesto:
 *   { ok, outputPath?, secs, error?, logTail? }
 */
async function renderWavWithChain({ inputPath, chainPath, timeoutMs }) {
  const reaper = findReaperExe();
  if (!reaper) return { ok: false, error: "REAPER no está instalado en las rutas estándar", secs: 0 };
  if (!fs.existsSync(inputPath)) return { ok: false, error: "No existe el WAV de entrada", secs: 0 };
  if (!fs.existsSync(chainPath)) return { ok: false, error: "No existe la cadena .RfxChain", secs: 0 };

  const outDir = path.dirname(inputPath);
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outBaseName = baseName + "-CUBI";
  const expectedOut = path.join(outDir, outBaseName + ".wav");
  try { if (fs.existsSync(expectedOut)) fs.rmSync(expectedOut); } catch {}

  const listPath = path.join(os.tmpdir(), "cubi-render-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + ".txt");
  fs.writeFileSync(listPath, buildBatchList(inputPath, chainPath, outDir, outBaseName), "utf8");

  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    execFile(reaper, ["-newinst", "-nosplash", "-batchconvert", listPath], { timeout: timeoutMs || 5 * 60 * 1000 }, (err) => {
      if (err && err.killed) return reject(new Error("timeout — plugin o REAPER no respondió"));
      resolve(); // la verdad es el archivo de salida, no el exit code
    });
  }).catch((e) => { throw e; });
  const secs = Number(((Date.now() - t0) / 1000).toFixed(1));

  let logTail = "";
  try {
    const logPath = listPath + ".log";
    if (fs.existsSync(logPath)) logTail = fs.readFileSync(logPath, "utf8").slice(-800);
  } catch {}
  try { fs.rmSync(listPath); } catch {}

  const ok = fs.existsSync(expectedOut) && fs.statSync(expectedOut).size > 1000;
  if (!ok) {
    return {
      ok: false, secs, logTail,
      error: "REAPER corrió pero no salió el WAV procesado (¿la cadena referencia un plugin no escaneado?)",
    };
  }
  return { ok: true, outputPath: expectedOut, secs, logTail };
}

/**
 * Corre el ensayo completo con diálogos nativos (sin UI nueva):
 *  1) elegir WAV  2) elegir .RfxChain  3) REAPER procesa  4) mostrar resultado.
 * `deps` = { dialog, shell, Notification } inyectados desde main.js.
 */
let handsPocRunning = false;

async function runHandsPoc(deps) {
  const { dialog, shell, Notification } = deps;
  const notify = (title, body) => { try { new Notification({ title, body }).show(); } catch {} };
  if (handsPocRunning) {
    notify("PoC Manos", "Ya hay un procesamiento en marcha — espere a que termine.");
    return;
  }
  handsPocRunning = true;
  try {
    const reaper = findReaperExe();
    if (!reaper) {
      await dialog.showMessageBox({
        type: "warning",
        title: "PoC Manos — falta REAPER",
        message: "No encontré reaper.exe en las rutas estándar.",
        detail: "Esta prueba usa REAPER como motor de render silencioso (Plan B de la visión). Instálelo o avíseme dónde está instalado.",
        buttons: ["Entendido"],
      });
      return;
    }

    // 1) WAV de entrada
    const wavPick = await dialog.showOpenDialog({
      title: "PoC Manos — elija el WAV a procesar",
      filters: [{ name: "Audio WAV", extensions: ["wav"] }],
      properties: ["openFile"],
    });
    if (wavPick.canceled || !wavPick.filePaths[0]) return;
    const inputWav = wavPick.filePaths[0];

    // 2) Cadena de FX (.RfxChain) — el plugin real del Pastor con su preset
    const chainsDefault = fxChainsDir();
    const chainPick = await dialog.showOpenDialog({
      title: "PoC Manos — elija la cadena de FX (ej. Ozone guardado desde REAPER)",
      defaultPath: fs.existsSync(chainsDefault) ? chainsDefault : undefined,
      filters: [{ name: "Cadena de FX de REAPER", extensions: ["RfxChain", "rfxchain"] }],
      properties: ["openFile"],
    });
    if (chainPick.canceled || !chainPick.filePaths[0]) return;
    const chainPath = chainPick.filePaths[0];

    // 3) Batch convert — salida junto al WAV original, sufijo -CUBI
    const outDir = path.dirname(inputWav);
    const baseName = path.basename(inputWav, path.extname(inputWav));
    const outBaseName = baseName + "-CUBI";
    const expectedOut = path.join(outDir, outBaseName + ".wav");
    // No pisar un resultado previo en silencio.
    try { if (fs.existsSync(expectedOut)) fs.rmSync(expectedOut); } catch {}

    const listPath = path.join(os.tmpdir(), "cubi-hands-poc-" + Date.now() + ".txt");
    fs.writeFileSync(listPath, buildBatchList(inputWav, chainPath, outDir, outBaseName), "utf8");

    notify("PoC Manos en marcha", "REAPER está procesando el WAV con su plugin… aviso al terminar.");
    console.log("[HandsPoC] reaper -batchconvert " + listPath);

    const t0 = Date.now();
    await new Promise((resolve, reject) => {
      // Timeout generoso: Ozone tarda en despertar; 5 min de tope.
      // -newinst: instancia PROPIA aunque REAPER esté abierto (si no, el
      // comando podría reenviarse a la instancia viva); -nosplash: sin logo.
      execFile(reaper, ["-newinst", "-nosplash", "-batchconvert", listPath], { timeout: 5 * 60 * 1000 }, (err) => {
        if (err && err.killed) return reject(new Error("timeout de 5 min — plugin o REAPER no respondió"));
        // batchconvert puede salir con código != 0 y aun así haber procesado;
        // la verdad es el archivo de salida + el .log. No fallamos por exit code.
        resolve();
      });
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    // 4) Veredicto honesto: existe el WAV procesado y pesa algo
    const ok = fs.existsSync(expectedOut) && fs.statSync(expectedOut).size > 1000;
    let logTail = "";
    try {
      const logPath = listPath + ".log";
      if (fs.existsSync(logPath)) logTail = fs.readFileSync(logPath, "utf8").slice(-800);
    } catch {}

    if (ok) {
      console.log("[HandsPoC] OK en " + secs + "s → " + expectedOut);
      notify("✋ Las manos existen", "WAV procesado con su plugin en " + secs + "s. Abriendo la carpeta…");
      try { shell.showItemInFolder(expectedOut); } catch {}
    } else {
      console.warn("[HandsPoC] sin salida. Log: " + logTail);
      await dialog.showMessageBox({
        type: "error",
        title: "PoC Manos — no salió el WAV",
        message: "REAPER corrió pero no apareció el archivo procesado.",
        detail: (logTail ? "Log del conversor:\n" + logTail : "Sin log del conversor.") +
          "\n\nCausa típica: la cadena .RfxChain referencia un plugin que REAPER no tiene escaneado.",
        buttons: ["Entendido"],
      });
    }
    try { fs.rmSync(listPath); } catch {}
  } catch (e) {
    console.warn("[HandsPoC] error: " + e.message);
    try {
      await dialog.showMessageBox({
        type: "error",
        title: "PoC Manos — error",
        message: e.message || String(e),
        buttons: ["Entendido"],
      });
    } catch {}
  } finally {
    handsPocRunning = false;
  }
}

module.exports = { runHandsPoc, findReaperExe, buildBatchList, fxChainsDir };
