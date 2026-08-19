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
//    protocol text is emitted (there is nothing to reference yet). This
//    remains true after PR9/Phase 7: [ENVIAR_FOTO] is still never
//    instructed for the same reason — telling the model to reference a
//    catalog that doesn't exist would just bait a hallucinated tag.
//
// 2. PR8 (Phase 6) deliberately shipped NO control-tag protocol text.
//    PR9 (Phase 7) closes that gap for the tags that now have a real
//    parsing/gating pipeline (src/agent/tags.js + src/agent/pipeline.js,
//    landing in the SAME PR — PR8's own hard requirement: never ship
//    prompt instructions for a tag without the pipeline that strips/
//    handles it):
//      - [ESCALAR_HUMANO:reason] and [DATOS_CONTACTO]...[/DATOS_CONTACTO]
//        are always instructed — no capability gates either of them.
//      - [CITA_CONFIRMADA]...[/CITA_CONFIRMADA] is instructed ONLY when
//        capabilities.scheduling is true; otherwise the existing
//        SCHEDULING_OFF_LINE decline line is kept as-is. The field labels
//        below (Servicio/Fecha/Hora/Duracion/Pago/Total) are exactly what
//        src/agent/tags.js's parseCitaFields() looks for — changing one
//        without the other breaks parsing silently.
//      - [PEDIDO_CONFIRMADO] is instructed ONLY when capabilities.payments
//        is true; otherwise PAYMENTS_OFF_LINE is kept. Both the block form
//        and the inline JSON form are documented, matching
//        src/agent/tags.js's parseTags()/parseOrderFields() support for
//        either shape.

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

// ── Control-tag protocol blocks (Phase 7) ────────────────────────────────
// Field labels/format here are load-bearing: src/agent/tags.js's
// parseCitaFields()/parseOrderFields()/parseContactFields() parse these
// exact labels. Do not change one without the other.

const ESCALAR_HUMANO_PROTOCOL = `PROTOCOLO DE ESCALAMIENTO A HUMANO:
Si el cliente pide hablar con una persona, está muy molesto, o preguntas algo que no puedes resolver, agrega al final de tu respuesta (invisible para el cliente):
[ESCALAR_HUMANO:motivo breve]`;

const DATOS_CONTACTO_PROTOCOL = `PROTOCOLO DE DATOS DE CONTACTO:
Si el cliente comparte su nombre o el nombre de su negocio, agrega al final de tu respuesta (invisible para el cliente):
[DATOS_CONTACTO]
Nombre: (nombre del cliente si lo dio)
Negocio: (nombre del negocio del cliente si lo dio)
[/DATOS_CONTACTO]`;

const CITA_CONFIRMADA_PROTOCOL = `PROTOCOLO DE CITAS:
Cuando el cliente confirme día, hora y servicio de una cita, agrega al final de tu respuesta (invisible para el cliente, exactamente en este formato):
[CITA_CONFIRMADA]
Servicio: (nombre del servicio)
Fecha: (día que indicó el cliente, tal cual lo dijo)
Hora: (hora en formato HH:MM)
Duracion: (minutos, solo número)
Pago: (al_llegar, transferencia o tarjeta)
Total: (monto, solo número)
[/CITA_CONFIRMADA]
No inventes un horario ni confirmes una cita que el cliente no aceptó explícitamente.`;

const PEDIDO_CONFIRMADO_PROTOCOL = `PROTOCOLO DE PEDIDOS:
Cuando el cliente confirme qué quiere comprar, agrega al final de tu respuesta (invisible para el cliente) uno de estos dos formatos:
[PEDIDO_CONFIRMADO]
Producto x(cantidad) $(precio)
Total: $(monto)
[/PEDIDO_CONFIRMADO]
o, si lo prefieres como JSON en una sola línea:
[PEDIDO_CONFIRMADO:{"items":[{"name":"...","qty":1,"price":0}],"total":0}]
No inventes precios ni confirmes un pedido que el cliente no aceptó explícitamente.`;

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

  // Always available — no capability gates either of these (design.md's
  // gating table only lists scheduling/payments; escalation and contact
  // capture are core conversation mechanics, not optional integrations).
  lines.push(ESCALAR_HUMANO_PROTOCOL);
  lines.push(DATOS_CONTACTO_PROTOCOL);

  if (capabilities.scheduling) {
    lines.push(CITA_CONFIRMADA_PROTOCOL);
  } else {
    lines.push(SCHEDULING_OFF_LINE);
  }

  if (capabilities.payments) {
    lines.push(PEDIDO_CONFIRMADO_PROTOCOL);
  } else {
    lines.push(PAYMENTS_OFF_LINE);
  }

  // ENVIAR_FOTO is deliberately never instructed — see header comment
  // (`catalog` has no data yet, so there's nothing to reference).

  return lines.join('\n\n');
}

module.exports = { buildSystemPrompt };
