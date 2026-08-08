"use strict";
/**
 * ============================================================
 * CUBI Bridge · Biblioteca de Cadenas (FX Chains de REAPER)
 * ============================================================
 *
 * Pedido del Pastor (8-ago-2026): "Yo creo el sonido una vez.
 * El Bridge lo aprende. El Coproductor sabe cuándo usarlo."
 *
 * Este módulo vigila la carpeta donde REAPER guarda las cadenas
 * (%APPDATA%\REAPER\FXChains) y mantiene una lista viva:
 *   - al iniciar: escaneo completo
 *   - cadena nueva / modificada / eliminada: se refleja sola (fs.watch)
 * Solo viajan NOMBRES y fechas — jamás el contenido del archivo
 * (los presets del Pastor son privados, se quedan en su PC).
 *
 * Contrato: módulo aislado. main.js llama createFxChainLibrary() y
 * recibe onChange(list) para reenviar por la WS autenticada.
 */

const fs = require("fs");
const path = require("path");

const MAX_CHAINS = 200; // tope defensivo
const DEBOUNCE_MS = 1500; // REAPER escribe en varias pasadas; esperar a que asiente

// ── Ficha de cada cadena (Pastor 8-ago-26: "el Bridge administra") ──
// El .RfxChain es texto: los plugins aparecen como <VST "VST3: Ozone 12
// (iZotope, Inc.)" ... , <CLAP "..." o <JS nombre. Leemos SOLO los nombres
// (el contenido/preset jamás sale de la PC).
function parseChainPlugins(file) {
  const plugins = [];
  try {
    const text = fs.readFileSync(file, "utf8").slice(0, 512 * 1024);
    const re = /^\s*<(VST|CLAP|AU|LV2|DX)\s+"([^"]+)"/gm;
    let m;
    while ((m = re.exec(text)) && plugins.length < 32) {
      let name = m[2]
        .replace(/^(VST3?i?|VSTi|CLAP|AUi?|LV2|DXi?):\s*/i, "") // prefijo de formato
        .replace(/\s*\([^)]*\)\s*$/, "") // vendor "(iZotope, Inc.)"
        .trim();
      if (name && !plugins.includes(name)) plugins.push(name);
    }
    // JSFX: <JS nombre/ruta [...]
    const reJs = /^\s*<JS\s+(\S+)/gm;
    while ((m = reJs.exec(text)) && plugins.length < 32) {
      const name = "JS: " + m[1].replace(/^"|"$/g, "");
      if (!plugins.includes(name)) plugins.push(name);
    }
  } catch {}
  return plugins;
}

// Tipo por el nombre que el usuario le puso (heurística honesta: si no
// se reconoce, "General" — jamás inventamos una categoría).
function inferChainType(name) {
  const n = String(name).toLowerCase();
  if (/\b(voz|vocal|voice|vox|coro|predicaci|podcast)/.test(n)) return "Voz";
  if (/\b(master|stream|mezcla final|bus)/.test(n)) return "Master";
  if (/\b(bater|drum|kick|bombo|snare|redoblante|percusi)/.test(n)) return "Batería";
  if (/\b(bajo|bass)/.test(n)) return "Bajo";
  if (/\b(guit|gtr)/.test(n)) return "Guitarra";
  if (/\b(piano|tecla|keys|pad|sinte|synth)/.test(n)) return "Teclas";
  return "General";
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

function createFxChainLibrary({ dir, onChange, log, getInstalledPlugins }) {
  const logFn = log || ((...a) => console.log("[FxChains]", ...a));
  let watcher = null;
  let debounceTimer = null;
  let chains = []; // [{ name, file, mtime }]

  function scan() {
    const found = [];
    try {
      if (!fs.existsSync(dir)) return found;
      // Subcarpetas de primer nivel también (REAPER permite organizarlas)
      const walk = (d, depth) => {
        if (depth > 2 || found.length >= MAX_CHAINS) return;
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (found.length >= MAX_CHAINS) break;
          const full = path.join(d, e.name);
          if (e.isDirectory()) { walk(full, depth + 1); continue; }
          if (!/\.rfxchain$/i.test(e.name)) continue;
          try {
            const st = fs.statSync(full);
            const name = path.basename(e.name, path.extname(e.name));
            found.push({
              name,
              file: full,
              mtime: st.mtimeMs,
              tipo: inferChainType(name),
              plugins: parseChainPlugins(full),
            });
          } catch {}
        }
      };
      walk(dir, 0);
    } catch (err) {
      logFn("scan error: " + err.message);
    }
    found.sort((a, b) => a.name.localeCompare(b.name, "es"));
    return found;
  }

  function refresh(reason) {
    const next = scan();
    const changed =
      next.length !== chains.length ||
      next.some((c, i) => c.name !== chains[i].name || c.mtime !== chains[i].mtime);
    chains = next;
    if (changed) {
      logFn(`biblioteca actualizada (${reason}): ${chains.length} cadena(s)`);
      try { onChange && onChange(list()); } catch (e) { logFn("onChange: " + e.message); }
    }
    return changed;
  }

  /**
   * Lista pública (sin rutas privadas ni contenido):
   * [{ name, tipo, plugins, estado, mtime }]
   * estado: cruce contra el Inventario de Plugins del Bridge —
   *   "disponible" | "falta plugin" | "sin verificar" (sin inventario; honesto).
   */
  function list() {
    let installed = null;
    try {
      const inv = getInstalledPlugins ? getInstalledPlugins() : null;
      if (Array.isArray(inv) && inv.length > 0) installed = inv.map(norm);
    } catch {}
    return chains.map((c) => {
      let estado = "sin verificar";
      if (installed) {
        const faltantes = (c.plugins || []).filter((p) => {
          if (p.startsWith("JS: ")) return false; // JSFX vive dentro de REAPER
          const np = norm(p);
          return !installed.some((i) => i.includes(np) || np.includes(i));
        });
        estado = faltantes.length === 0 ? "disponible" : "falta plugin";
      }
      return {
        name: c.name,
        tipo: c.tipo || "General",
        plugins: c.plugins || [],
        estado,
        mtime: Math.round(c.mtime),
      };
    });
  }

  /** Resuelve un nombre confirmado → ruta del .RfxChain (o null, honesto). */
  function resolve(name) {
    if (typeof name !== "string" || !name.trim()) return null;
    const hit = chains.find((c) => c.name === name.trim());
    return hit ? hit.file : null;
  }

  function start() {
    refresh("inicio");
    try {
      if (!fs.existsSync(dir)) {
        // Sin carpeta todavía (REAPER sin cadenas guardadas): reintentar suave
        // cada 60s hasta que exista — sin error, sin ruido.
        debounceTimer = setInterval(() => {
          if (fs.existsSync(dir)) { clearInterval(debounceTimer); debounceTimer = null; start(); }
        }, 60_000);
        return;
      }
      watcher = fs.watch(dir, { recursive: true }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => refresh("cambio en carpeta"), DEBOUNCE_MS);
      });
      watcher.on("error", (e) => logFn("watch error: " + e.message));
    } catch (e) {
      // fs.watch recursivo puede fallar en rutas raras: la lista del arranque
      // sigue viva y refresh() puede llamarse a demanda.
      logFn("watch no disponible: " + e.message);
    }
  }

  function stop() {
    try { watcher && watcher.close(); } catch {}
    watcher = null;
    if (debounceTimer) { clearTimeout(debounceTimer); clearInterval(debounceTimer); debounceTimer = null; }
  }

  return { start, stop, list, resolve, refresh };
}

module.exports = { createFxChainLibrary };
