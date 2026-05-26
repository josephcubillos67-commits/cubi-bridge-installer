# CUBI Jarvis HUD v2 — Especificación visual y arquitectura

> Documento vivo. Esta carpeta NO se carga en runtime del Bridge v1.4.0.
> Es la base preparatoria para el release `bridge-v1.5.0` (HUD Jarvis Musical).

## Filosofía de diseño

**El Pastor produce. El copiloto observa, sugiere, responde — nunca interrumpe.**

- No es una ventanita popup. Es un **HUD cinematográfico minimalista** que vive sobre Cubase.
- Siempre al frente, jamás roba foco del DAW.
- Glassmorphism elegante: backdrop blur 20px + gradiente vino→oro semi-transparente.
- Pensado para pantalla grande / proyector / segundo monitor del estudio.
- Tres modos de tamaño: **compacto / expandido / stadium** (proyector).
- Modular: la base de hoy (chat + estados visuales) prepara el terreno para STT/TTS/multi-overlay.

## Anatomía del HUD

```
┌─────────────────────────────────────────────┐
│ ⬤ CUBI Copilot           ◉ ── ◐ ── ⊟ ── ✕  │  ← Header (drag)
│   "Analizando master..."                     │
├─────────────────────────────────────────────┤
│                                             │
│   ╭───────────────────╮                     │
│   │   [Visualizador]   │   ← Estado actual  │
│   │   según estado     │     animado        │
│   ╰───────────────────╯                     │
│                                             │
│   ─── Conversación ────────────────         │
│                                             │
│   👤 Pastor:                                │
│      "Suena turbio en los 200Hz"            │
│                                             │
│   🎧 CUBI:                                  │
│      "Detectado pile-up en 180-260Hz.       │
│       Sugerencia: cut narrow Q -3dB         │
│       con Pro-Q4 en el bus de coros."       │
│      [▸ Aplicar sugerencia]                 │
│                                             │
├─────────────────────────────────────────────┤
│ 🎤  [Escribí algo al copiloto...]      ➤    │  ← Input
└─────────────────────────────────────────────┘
```

## Estados visuales (7 estados, todos animados)

| Estado | Visual | Cuándo |
|---|---|---|
| `idle` | Gradiente vino→oro respirando suavemente (4s loop) | Sin actividad |
| `listening` | Ondas concéntricas verdes desde el centro | Capturando audio (STT futuro) |
| `thinking` | 3 puntos dorados con pulse staggered | Esperando respuesta del Coproductor |
| `analyzing` | 8 barras EQ verticales animadas (datos DSP reales) | Procesando stem o métrica entrante |
| `speaking` | Waveform horizontal dorada animada | TTS reproduciendo respuesta (futuro) |
| `error` | Pulse rojo en el borde + ícono ⚠ | Fallo de conexión o de proceso |
| `processing` | 4 capas concéntricas rotando (drums/bass/vox/other) | Demucs / stem splitting activo |

## Modos de tamaño

| Modo | Tamaño | Uso |
|---|---|---|
| `compact` | 320×80 | Pastor en flow, mínima distracción |
| `expanded` | 480×720 | Conversación activa con copiloto |
| `stadium` | 720×900 | Proyector / segundo monitor / clase |

Persistencia de modo + posición + transparencia en `electron-store` (futuro).

## Controles del usuario

| Control | Acción |
|---|---|
| Drag por header | Mover ventana |
| Botón ◐ | Ciclo modo: compact → expanded → stadium → compact |
| Botón ◉ | Toggle click-through (HUD se vuelve "pasable" — el mouse atraviesa al DAW) |
| Botón ⊟ | Dock lateral (snap a borde izq/der/inf de pantalla) |
| Slider transparencia | Ajuste 30% → 100% (oculto en menú de settings) |
| Botón ✕ | Cerrar (vuelve al tray) |
| Atajo `Ctrl+Shift+Space` | Toggle visibilidad global (futuro) |
| Atajo `Ctrl+Shift+M` | Mute/unmute click-through (futuro) |

## Chat embebido

- Input controlado con auto-resize hasta 4 líneas.
- Historial scrolleable, últimos 30 turnos en memoria, infinito persistido en `electron-store` (futuro).
- Mensajes del Pastor: avatar 👤, alineados derecha, bubble vino oscuro.
- Mensajes del Copiloto: avatar 🎧, alineados izquierda, bubble glass+gold.
- Indicador "typing" del Copiloto durante `thinking`.
- Sugerencias del copiloto pueden incluir botones de acción inline (ej: `[▸ Aplicar sugerencia]`) — no destructivos, requieren confirmación.

## Arquitectura modular

```
overlay-v2/
├── JARVIS_HUD_SPEC.md      ← este documento
├── index.html               ← markup standalone (sin frameworks)
├── styles.css               ← todos los estilos + animaciones
├── app.js                   ← orquestador, estados, controles, dock
├── messaging.js             ← módulo aislado de comunicación con el Coproductor
└── README.md                ← guía de integración (futuro)
```

**Por qué vanilla JS:**
Arranque instantáneo (<50ms), footprint mínimo (<60KB total), cero stutters durante sesiones de Cubase con 30+ plugins cargados. React/Vue/Svelte agregarían 100-200KB sin valor real para una superficie tan acotada.

## Contratos preparados para v1.6.x+ (NO implementados todavía)

```js
// messaging.js — interfaces dormidas, preparadas para STT/TTS y Coproductor real
window.jarvisAPI = {
  // CHAT (implementado hoy con mock)
  sendMessage(text: string): Promise<{ reply: string, suggestions: Suggestion[] }>

  // VOZ (preparado, no implementado)
  startListening(): Promise<void>
  stopListening(): Promise<string>  // transcript
  speak(text: string, voiceId?: string): Promise<void>

  // INTEGRACIÓN COPRODUCTOR REAL (preparado)
  onDspFinding(cb: (f: DspFinding) => void): UnsubscribeFn
  onPluginSuggestion(cb: (s: PluginSuggestion) => void): UnsubscribeFn
  onStemProgress(cb: (p: StemProgress) => void): UnsubscribeFn

  // MULTI-OVERLAY (preparado)
  spawnOverlay(kind: 'mixer' | 'piano' | 'panic'): Promise<OverlayHandle>
}
```

## Roadmap de releases

| Release | Contenido |
|---|---|
| **bridge-v1.4.0** (mañana) | HUD básico actual (métricas, sparkline, observación). Jarvis v2 NO incluido. |
| **bridge-v1.5.0** | Jarvis HUD: chat + estados visuales + dock + controles. Mock para respuestas. |
| **bridge-v1.5.1** | Conexión real con Coproductor IA backend (auth + endpoint). |
| **bridge-v1.6.0** | Voz STT (Web Speech API o Whisper local). |
| **bridge-v1.6.1** | TTS (ElevenLabs o Edge TTS). |
| **bridge-v1.7.0** | Multi-overlay (mini-mixer, panic button, mini-piano). |

## ADN CUBI inviolable

- ✅ Cero modal, cero wizard.
- ✅ Cero unidades técnicas en UI emocional (los "dB", "Hz" viven solo en el panel `analyzing`).
- ✅ Toda acción IA reversible (toda sugerencia del copiloto se confirma antes de aplicar).
- ✅ Si requiere tutorial, no entra.
- ✅ Español obligatorio en toda UI visible.
