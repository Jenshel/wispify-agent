'use strict';
// src/brain/prompt.js — buildSystemPrompt() (tasks.md Phase 6.1).
//
// Module boundary (design.md): "buildSystemPrompt(business, catalog,
// soulDocs, capabilities)" assembles the actual Gemini system prompt.
// Reference: WhiteLabel_WA_System/wa-brain-local/index.js's
// buildSystemPrompt() — used here as the STRUCTURAL pattern (assemble
// config.context + config.personalityCustom + soul-docs rules text into a
// system prompt), not a literal line-for-line port of its full text.
//
// Scope boundary for PR8 / Phase 6 (deliberate, noted explicitly):
//
// 1. No `catalog` table exists yet in this repo (schema.sql defers it to a
//    later phase — see its own header comment). `catalog` is accepted here
//    for forward compatibility with design.md's signature, but this PR
//    never receives a non-empty one, so no product listing / photo-tag
//    protocol text is emitted (there is nothing to reference yet).
//
// 2. No control-tag protocol text ([CITA_CONFIRMADA], [PEDIDO_CONFIRMADO],
//    [ENVIAR_FOTO], etc.) is emitted yet, REGARDLESS of `capabilities`.
//    Phase 7's src/agent/tags.js + src/agent/pipeline.js — the code that
//    parses, strips, and acts on those tags — does not exist yet.
//    Instructing Gemini to emit a bracket tag with nothing downstream to
//    strip it would leak raw "[TAG]" text straight into a real customer's
//    WhatsApp message, which is a functional regression this PR must not
//    ship. `capabilities` is used ONLY to render an honest, graceful
//    decline line when scheduling/payments are off — design.md's own
//    capability-gating language ("no puedes agendar; ofrece que el equipo
//    contacte" / two-step order flow replaced by "toma el pedido y avisa
//    que el equipo confirmará"). Phase 7 is expected to extend this
//    function with the real tag-protocol blocks at the same time it ships
//    the pipeline that consumes them.

const BASE_PERSONA = 'Eres un asistente de ventas profesional y servicial.';

const PERSONALITY_PRESETS = {
  formal: 'Habla de forma profesional, formal y estructurada. Usa usted.',
  amigable: 'Habla de forma cálida, cercana y amigable. Usa tú.',
  juvenil: 'Habla de forma casual, moderna y con energía. Usa expresiones actuales.',
};

const FORMAT_RULES = `REGLAS DE FORMATO:
- Máximo 2-3 líneas por mensaje. Una pregunta por mensaje.
- Responde siempre en el idioma en que te hablen.
- Usa únicamente la información proporcionada arriba. No inventes datos, precios ni horarios que no estén configurados.
- Si el cliente pregunta algo que no tienes configurado, dilo honestamente y sugiere contactar al negocio directamente.`;

const SCHEDULING_OFF_LINE =
  'No puedes agendar citas por este medio. Si el cliente lo pide, ofrece que el equipo lo contacte directamente.';
const PAYMENTS_OFF_LINE =
  'No puedes generar enlaces de pago por este medio. Si el cliente quiere comprar, toma su pedido y avisa que el equipo lo confirmará.';

/**
 * @param {{
 *   appConfig?: {businessName?: string, greeting?: string, context?: string,
 *     personality?: string, personalityCustom?: string, soulDocs?: string},
 *   catalog?: Array<object>,
 *   capabilities?: {scheduling?: boolean, payments?: boolean},
 * }} [params]
 * @returns {string}
 */
function buildSystemPrompt({ appConfig = {}, catalog = [], capabilities = {} } = {}) {
  const lines = [BASE_PERSONA];

  if (appConfig.businessName) {
    lines.push(`Tu nombre es ${appConfig.businessName}.`);
  }

  if (appConfig.greeting) {
    lines.push(`Si es el primer mensaje de la conversación, usa este saludo: "${appConfig.greeting}"`);
  }

  if (appConfig.context) {
    lines.push(`INFORMACIÓN DEL NEGOCIO:\n${appConfig.context}`);
  }

  if (appConfig.personality && appConfig.personality !== 'custom' && PERSONALITY_PRESETS[appConfig.personality]) {
    lines.push(`TONO: ${PERSONALITY_PRESETS[appConfig.personality]}`);
  }

  if (appConfig.personalityCustom) {
    lines.push(`INSTRUCCIONES DE PERSONALIDAD:\n${appConfig.personalityCustom}`);
  }

  // `catalog` is reserved for a future phase (see header comment) — always
  // empty today, so intentionally unused beyond this documented no-op.
  void catalog;

  if (appConfig.soulDocs) {
    lines.push(`REGLAS PERSONALIZADAS DEL NEGOCIO:\n${appConfig.soulDocs}`);
  }

  lines.push(FORMAT_RULES);

  if (!capabilities.scheduling) {
    lines.push(SCHEDULING_OFF_LINE);
  }
  if (!capabilities.payments) {
    lines.push(PAYMENTS_OFF_LINE);
  }

  return lines.join('\n\n');
}

module.exports = { buildSystemPrompt };
