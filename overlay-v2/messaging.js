/* ============================================================
 * messaging.js — comunicación HUD v2 ↔ Coproductor IA real
 * ============================================================
 * Pastor 25-may-2026 · cableado al cerebro real:
 * En Electron real (HUD desktop) usa window.overlayAPI.sendLiveMessage
 * que viaja por la WS autenticada del Bridge → servidor → aiProvider →
 * respuesta correlacionada por reqId. Sin tokens HTTP, sin OAuth.
 *
 * En preview web (sin Electron) cae a los mocks históricos para que
 * el HUD siga siendo previsable desde el browser sin Bridge corriendo.
 *
 * El resto del HUD NUNCA habla directo con la red. Todo pasa por
 * window.jarvisAPI — así, mock vs real, el resto del UI no se entera.
 * ============================================================ */

const HAS_OVERLAY_API =
  typeof window !== "undefined" &&
  window.overlayAPI &&
  typeof window.overlayAPI.sendLiveMessage === "function";

/* ============================================================
 * MOCKS (sólo se usan en preview web sin Bridge)
 * ============================================================ */
const MOCK_REPLIES = [
  { match: /200|low.mid|barro|turbio|mud/i,
    reply: "Pile-up en 180-260 Hz. Corte -3 dB Q=2.5 con Pro-Q3 en bus de coros." },
  { match: /loud|volumen|alto|bajo|lufs/i,
    reply: "Master a -11.8 LUFS-I. Para Spotify hay 2.2 dB de margen. Estás dentro." },
  { match: /vocal|voz|cantante|pastor/i,
    reply: "Voz con pico de 4.2 dB en 3.1 kHz. -1 dB Q=3 con Pro-Q3 y +1.5 dB a 250 Hz con Neutron." },
  { match: /stem|separar|dividir/i,
    reply: "Demucs htdemucs separa 4 stems en ~90s/min. Lanzalo desde el LAB." },
  { match: /hola|buenas|saludos/i,
    reply: "Acá estoy. Dale play en Cubase y te respondo con métricas reales." },
  { match: /test|prueba/i,
    reply: "Canal de chat OK. HUD respondiendo en preview mock." },
];
const DEFAULT_MOCK = "Necesito métricas vivas de tu sesión. Dale play en Cubase.";

function findMockReply(text) {
  for (const m of MOCK_REPLIES) if (m.match.test(text)) return m.reply;
  return DEFAULT_MOCK;
}
function mockDelay(text) {
  return Math.min(2200, 800 + text.length * 6);
}

/* ============================================================
 * API PÚBLICA — el resto del HUD usa SOLO esto
 * ============================================================ */
window.jarvisAPI = {
  /**
   * Manda el texto del usuario al Coproductor IA y devuelve la respuesta.
   * Real: viaja por la WS del Bridge, viene firmado por reqId.
   * Mock: busca por regex en MOCK_REPLIES.
   * Siempre resuelve a { reply: string, actions: [] }. Nunca rechaza.
   */
  async sendMessage(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return { reply: "Decime algo concreto.", actions: [] };

    if (HAS_OVERLAY_API) {
      try {
        const res = await window.overlayAPI.sendLiveMessage(trimmed);
        return {
          reply: res?.text || "Sin respuesta del cerebro.",
          actions: [],
          // Marcadores para que app.js pueda colorear estados de error
          _ok: !!res?.ok,
          _reason: res?.reason || null,
          // 1.8.0 — true si el cerebro escuchó los últimos 10s reales del master
          // (Gemini Audio multimodal). app.js lo usa para mostrar el marcador 🎧.
          _audioUsed: !!res?.audioUsed,
        };
      } catch (e) {
        return {
          reply: "Error de comunicación con el Bridge. Reintentá.",
          actions: [],
          _ok: false,
          _reason: "comm-error",
        };
      }
    }

    // Fallback preview web: mock con typing delay
    await new Promise((r) => setTimeout(r, mockDelay(trimmed)));
    return { reply: findMockReply(trimmed), actions: [] };
  },

  /* VOZ — preparado, no implementado (CP6+) */
  async startListening() { throw new Error("STT pendiente."); },
  async stopListening() { throw new Error("STT pendiente."); },
  async speak(_text) { throw new Error("TTS pendiente."); },

  /* INTEGRACIÓN COPRODUCTOR REAL — observaciones automáticas del Observation Engine */
  onDspFinding(cb) {
    if (HAS_OVERLAY_API && typeof window.overlayAPI.onObservations === "function") {
      return window.overlayAPI.onObservations((obs) => {
        if (!Array.isArray(obs) || obs.length === 0) return;
        // Pasamos la observación de mayor severidad como "finding"
        const ranked = [...obs].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
        cb(ranked[0]);
      });
    }
    return () => {};
  },
  onPluginSuggestion(_cb) { return () => {}; },
  onStemProgress(_cb) { return () => {}; },
};

function severityRank(s) {
  if (s === "critical") return 4;
  if (s === "warn") return 3;
  if (s === "info") return 2;
  if (s === "good") return 1;
  return 0;
}
