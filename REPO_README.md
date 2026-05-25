# cubi-bridge-installer

Repo dedicado **SOLO** al build del instalador `.exe` (NSIS) del CUBI Bridge.

> Este repo NO contiene el código del sitio principal `apocalipsisconcafe.com`
> ni del Coffee Revelation. Solo el código del Electron app de escritorio que
> conecta Cubase con el Coproductor IA.

## Cómo cortar una nueva versión

1. Bumpear `"version"` en `package.json` (ej: `1.4.1` → `1.4.2`).
2. Commit + push a `main`.
3. Ir a **Releases** → **Draft a new release** → tag: `bridge-v1.4.2` (click "Create new tag on publish").
4. Click **Publish release** (verde).
5. En ~5 minutos el workflow Actions compila y publica `CUBI-Bridge-Setup.exe` como **Release Asset**.
6. El servidor de `apocalipsisconcafe.com` detecta automáticamente el nuevo `.exe` y lo sirve desde `/lab` → "Descargar Bridge".

## Red de seguridad

Si por cualquier razón `electron-builder` falla al subir el asset, el `.exe`
queda igualmente descargable manualmente desde:

**Actions → último workflow run → Artifacts → CUBI-Bridge-Setup-exe** (30 días).

## Variables de entorno del servidor (Replit)

El servidor de `apocalipsisconcafe.com` ya está configurado para usar este
repo via las env vars:

```
BRIDGE_GITHUB_OWNER=josephcubillos67-commits
BRIDGE_GITHUB_REPO=cubi-bridge-installer
```

Si se mueve el repo, basta cambiar esas dos variables — cero cambios de
código en el servidor.
