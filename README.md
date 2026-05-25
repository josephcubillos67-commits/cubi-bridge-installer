# CUBI Bridge

Observador READ-ONLY del estudio Cubase del Pastor. Reporta métricas live (LUFS, true peak, espectro 8 bandas, crest factor, plugin chain del master) al Coproductor IA en `apocalipsisconcafe.com/coproductor-ia` para que pueda responder en tiempo presente sobre la mezcla activa.

**Línea roja:** nunca modifica el proyecto de Cubase. Cero WRITE.

---

## Para el Pastor (instalación)

Ver `INSTALL_PASTOR.md`. Resumen: descargá `CUBI-Bridge-Setup.exe` desde `apocalipsisconcafe.com/lab`, doble click, asistente español, listo en 2 minutos.

---

## Para el equipo técnico (build & release)

Ver `RELEASE.md` para el flujo completo de release.

**Stack:**
- Electron 31 (main + renderer + tray)
- electron-builder → instalador NSIS Windows
- electron-updater → auto-update contra GitHub Releases
- electron-store → persistencia de token/config
- ws → WebSocket al server (`/ws/bridge`)

**Estructura:**
- `main.js` — proceso principal Electron, WS al server, tray menu, autoUpdater
- `preload.js` — bridge IPC para `capture.html` y `overlay.html`
- `capture.html` — Web Audio API captura del dispositivo de loopback, FFT, banding, payload
- `overlay.html` — HUD flotante always-on-top
- `pairing.html` — UI de emparejamiento (input código 6 dígitos)
- `vst3-simulator.js` — fixture para tests del plugin chain (dev only)
- `package.json` — config electron-builder (NSIS perMachine:false, español, publish github)
- `build/license-es.txt` — licencia mostrada en el instalador
- `.github/workflows/release-bridge.yml` (en root del repo) — pipeline de release

**Cortar release:**

```bash
# 1. Bump version en cubi-bridge/package.json
# 2. Commit + tag + push
git tag bridge-v1.x.y && git push --tags
```

GitHub Actions corre `electron-builder --publish always` en `windows-latest` y sube `CUBI-Bridge-Setup.exe` a Releases. Los Bridges activos detectan la versión nueva en su próximo chequeo (boot + cada 6h), descargan en background y se reinician con la versión nueva al primer "ok" del usuario.

**Dev local (sin release):**

```bash
cd cubi-bridge
npm install
npm start          # corre el bridge contra el server local
```

---

## Endpoints del servidor

| URL | Comportamiento |
|---|---|
| `WS /ws/bridge` | Canal bidireccional Bridge ↔ Server (auth via token) |
| `GET /api/bridge/status` | Estado del Bridge del usuario (online, daw, os, version, mute) |
| `POST /api/bridge/generate-code` | Genera código de pairing 6 dígitos (TTL 5 min) |
| `POST /api/bridge/revoke` | Desempareja Bridge actual |
| `GET /api/bridge/installer-info` | URL de descarga del .exe + versión esperada |
| `GET /downloads/cubi-bridge/installer` | 302 → último .exe en GitHub Releases |

---

## Notas

- **READ-ONLY total** — sin excepciones.
- El audio nunca sale de la PC del Pastor. Solo viaja metadata numérica (~1 KB/seg).
- Plugin chain del master se lee via VST3 simulator + futuro Companion VST3 (T-FUTURO-1).
- Sin firma de código todavía → SmartScreen warning la 1ª vez. Comprar cert OV/EV (~$200/año) cuando se quiera eliminar.
