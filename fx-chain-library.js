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

function createFxChainLibrary({ dir, onChange, log }) {
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
            found.push({
              name: path.basename(e.name, path.extname(e.name)),
              file: full,
              mtime: st.mtimeMs,
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

  /** Lista pública (sin rutas privadas): [{ name, mtime }] */
  function list() {
    return chains.map((c) => ({ name: c.name, mtime: Math.round(c.mtime) }));
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
