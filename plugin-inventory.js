/**
 * ============================================================
 * CUBI BRIDGE — Inventario de Plugins (Etapa 0 del Motor VST)
 * ============================================================
 *
 * Módulo READ-ONLY: encuentra los plugins instalados, los reconoce
 * y registra su ubicación. NUNCA los mueve, copia ni carga.
 *
 * Qué hace:
 *   1. Escanea las ubicaciones estándar de VST en Windows
 *      (+ carpetas manuales que agregue el Pastor).
 *   2. Lee metadatos honestos:
 *        - VST3 bundle → Contents/moduleinfo.json (nombre, fabricante,
 *          versión, y si es Instrument o Fx) cuando el plugin lo trae.
 *        - Si no hay moduleinfo → nombre desde el archivo y el resto
 *          queda "desconocido" (nunca se adivina).
 *   3. Persiste el inventario localmente (electron-store).
 *   4. Envía al servidor SOLO el catálogo (nombres/metadatos/rutas),
 *      jamás archivos. El servidor lo cruza contra la Biblioteca
 *      Profesional registrada y devuelve el informe.
 *   5. Permite marcar plugins como Biblioteca Profesional y
 *      clasificarlos por categoría.
 *
 * "Probar compatibilidad" queda como botón futuro (deshabilitado):
 * eso ya implicaría CARGAR el plugin, y es la etapa siguiente.
 * ============================================================
 */

const { BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

// Ubicaciones estándar de VST en Windows (no se inventan otras).
const STANDARD_FOLDERS = [
  "C:\\Program Files\\Common Files\\VST3",
  "C:\\Program Files\\Common Files\\VST2",
  "C:\\Program Files\\Steinberg\\VstPlugins",
  "C:\\Program Files\\VSTPlugins",
  "C:\\Program Files (x86)\\VstPlugins",
  "C:\\Program Files (x86)\\Steinberg\\VstPlugins",
];

const CATEGORIES = [
  "mezcla", "mastering", "restauracion", "bateria",
  "guitarra", "bajo", "teclados", "cinematografico",
];

const MAX_DEPTH = 6;
const STORE_KEY_INVENTORY = "pluginInventory";        // { scannedAt, plugins: [] }
const STORE_KEY_FOLDERS = "pluginInventoryFolders";   // ["C:\\..."]
const STORE_KEY_MARKS = "pluginInventoryMarks";       // { [path]: { important, category } }

let store = null;
let sendWs = null;          // (obj) => boolean — inyectado desde main.js
let inventoryWindow = null;
let lastReport = null;      // último informe de cruce recibido del server

// ─── Lectura de metadatos VST3 (moduleinfo.json del bundle) ─────
function readModuleInfo(bundlePath) {
  // VST3 SDK 3.7.2+: <bundle>.vst3/Contents/moduleinfo.json
  const candidates = [
    path.join(bundlePath, "Contents", "moduleinfo.json"),
    path.join(bundlePath, "Contents", "Resources", "moduleinfo.json"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      // Algunos moduleinfo traen comentarios estilo // — limpiar suave
      const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
      const fi = json["Factory Info"] || {};
      const classes = Array.isArray(json.Classes) ? json.Classes : [];
      const audioClass = classes.find((c) => (c.Category || "") === "Audio Module Class") || null;
      const sub = audioClass && (audioClass["Sub Categories"] || audioClass.SubCategories);
      const subList = Array.isArray(sub) ? sub : typeof sub === "string" ? sub.split("|") : [];
      let kind = "desconocido";
      if (subList.some((s) => String(s).toLowerCase().includes("instrument"))) kind = "instrumento";
      else if (subList.some((s) => String(s).toLowerCase().includes("fx"))) kind = "procesador";
      return {
        name: (json.Name || (audioClass && audioClass.Name) || null),
        vendor: (fi.Vendor || (audioClass && audioClass.Vendor) || null),
        version: (json.Version || (audioClass && audioClass.Version) || null),
        kind,
      };
    } catch {
      // moduleinfo ilegible → seguimos con metadatos del filename (honesto)
    }
  }
  return null;
}

// ─── Escaneo recursivo de UNA carpeta ───────────────────────────
function scanFolder(root, isStandard, found, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // carpeta inexistente o sin permiso — se salta en silencio
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    const lower = e.name.toLowerCase();
    if (lower.endsWith(".vst3")) {
      // Puede ser bundle (carpeta) o archivo suelto legacy
      const info = e.isDirectory() ? readModuleInfo(full) : null;
      found.push({
        name: (info && info.name) || e.name.replace(/\.vst3$/i, ""),
        vendor: (info && info.vendor) || guessVendorFromPath(full),
        version: (info && info.version) || null,
        kind: (info && info.kind) || "desconocido",
        format: "VST3",
        path: full,
        standardLocation: isStandard,
      });
      continue; // no descender dentro del bundle
    }
    if (e.isDirectory()) {
      scanFolder(full, isStandard, found, depth + 1);
    } else if (lower.endsWith(".dll")) {
      // VST2 clásico: solo dentro de carpetas de plugins (ya estamos en una)
      found.push({
        name: e.name.replace(/\.dll$/i, ""),
        vendor: guessVendorFromPath(full),
        version: null,
        kind: "desconocido",
        format: "VST2",
        path: full,
        standardLocation: isStandard,
      });
    }
  }
}

// Pista honesta de fabricante: subcarpeta del root estándar (p.ej.
// ...\VST3\iZotope\Ozone.vst3 → "iZotope"). Si no hay, null.
function guessVendorFromPath(fullPath) {
  for (const rootDir of STANDARD_FOLDERS) {
    if (fullPath.toLowerCase().startsWith(rootDir.toLowerCase() + path.sep)) {
      const rel = fullPath.substring(rootDir.length + 1);
      const parts = rel.split(path.sep);
      if (parts.length > 1) return parts[0];
      return null;
    }
  }
  return null;
}

// ─── Escaneo completo ───────────────────────────────────────────
function runScan() {
  const customFolders = store.get(STORE_KEY_FOLDERS) || [];
  const found = [];
  for (const f of STANDARD_FOLDERS) scanFolder(f, true, found);
  for (const f of customFolders) scanFolder(f, false, found);

  // dedup por ruta (por si una carpeta manual solapa una estándar)
  const byPath = new Map();
  for (const p of found) if (!byPath.has(p.path.toLowerCase())) byPath.set(p.path.toLowerCase(), p);
  const plugins = Array.from(byPath.values()).sort((a, b) => a.name.localeCompare(b.name));

  // aplicar marcas guardadas
  const marks = store.get(STORE_KEY_MARKS) || {};
  for (const p of plugins) {
    const m = marks[p.path];
    p.important = !!(m && m.important);
    p.category = (m && m.category) || null;
  }

  const inventory = { scannedAt: Date.now(), plugins };
  store.set(STORE_KEY_INVENTORY, inventory);
  return inventory;
}

// ─── Catálogo hacia el servidor (SOLO metadatos, jamás archivos) ─
function sendCatalog() {
  const inv = store.get(STORE_KEY_INVENTORY);
  if (!inv || !Array.isArray(inv.plugins) || !sendWs) return false;
  return sendWs({
    type: "plugin-inventory",
    scannedAt: inv.scannedAt,
    plugins: inv.plugins.map((p) => ({
      name: p.name, vendor: p.vendor, version: p.version, kind: p.kind,
      format: p.format, path: p.path, standardLocation: !!p.standardLocation,
      important: !!p.important, category: p.category || null,
    })),
  });
}

// ─── Ventana del inventario ─────────────────────────────────────
function openInventoryWindow() {
  if (inventoryWindow && !inventoryWindow.isDestroyed()) {
    inventoryWindow.show();
    inventoryWindow.focus();
    return;
  }
  inventoryWindow = new BrowserWindow({
    width: 960,
    height: 700,
    title: "CUBI Bridge — Inventario de Plugins",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  inventoryWindow.loadFile("inventory.html");
  inventoryWindow.on("closed", () => { inventoryWindow = null; });
}

function forwardToInventoryWindow(channel, payload) {
  try {
    if (inventoryWindow && !inventoryWindow.isDestroyed()) {
      inventoryWindow.webContents.send(channel, payload);
    }
  } catch {}
}

// ─── Mensajes del servidor ──────────────────────────────────────
function handleServerMessage(msg) {
  if (msg.type === "plugin-inventory-report") {
    lastReport = msg.report || null;
    forwardToInventoryWindow("inventory:report", lastReport);
  }
}

// ─── Init: registrar IPC ────────────────────────────────────────
function init(opts) {
  store = opts.store;
  sendWs = opts.sendWs;

  ipcMain.handle("inventory:get-state", () => ({
    inventory: store.get(STORE_KEY_INVENTORY) || null,
    customFolders: store.get(STORE_KEY_FOLDERS) || [],
    standardFolders: STANDARD_FOLDERS,
    categories: CATEGORIES,
    report: lastReport,
  }));

  ipcMain.handle("inventory:scan", () => {
    const inventory = runScan();
    const sent = sendCatalog(); // dispara el cruce con la Biblioteca en el server
    return { inventory, sentToServer: sent };
  });

  ipcMain.handle("inventory:add-folder", async () => {
    const win = inventoryWindow && !inventoryWindow.isDestroyed() ? inventoryWindow : null;
    const res = await dialog.showOpenDialog(win, {
      title: "Agregar carpeta de plugins",
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths.length) return { added: null };
    const folder = res.filePaths[0];
    const folders = store.get(STORE_KEY_FOLDERS) || [];
    if (!folders.some((f) => f.toLowerCase() === folder.toLowerCase())) {
      folders.push(folder);
      store.set(STORE_KEY_FOLDERS, folders);
    }
    return { added: folder, customFolders: folders };
  });

  ipcMain.handle("inventory:remove-folder", (_e, folder) => {
    const folders = (store.get(STORE_KEY_FOLDERS) || []).filter(
      (f) => f.toLowerCase() !== String(folder).toLowerCase()
    );
    store.set(STORE_KEY_FOLDERS, folders);
    return { customFolders: folders };
  });

  ipcMain.handle("inventory:set-mark", (_e, payload) => {
    const { pluginPath, important, category } = payload || {};
    if (!pluginPath) return { ok: false };
    const marks = store.get(STORE_KEY_MARKS) || {};
    marks[pluginPath] = {
      important: !!important,
      category: category && CATEGORIES.includes(category) ? category : null,
    };
    store.set(STORE_KEY_MARKS, marks);
    // reflejar en el inventario persistido
    const inv = store.get(STORE_KEY_INVENTORY);
    if (inv && Array.isArray(inv.plugins)) {
      for (const p of inv.plugins) {
        if (p.path === pluginPath) {
          p.important = marks[pluginPath].important;
          p.category = marks[pluginPath].category;
        }
      }
      store.set(STORE_KEY_INVENTORY, inv);
    }
    sendCatalog(); // catálogo actualizado al server (barato: solo texto)
    return { ok: true };
  });

  ipcMain.on("inventory:open", () => openInventoryWindow());
}

module.exports = {
  init,
  openInventoryWindow,
  handleServerMessage,
  sendCatalog,
};
