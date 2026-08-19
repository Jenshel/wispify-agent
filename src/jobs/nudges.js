'use strict';
// src/jobs/nudges.js — 4-stage contextual follow-up system (tasks.md Phase
// 10.1), PORTED from WhiteLabel_WA_System's routes/nudges.js.
//
// Scans conversations every 2 minutes. Tracks 4 follow-up stages per
// conversation, each with increasing urgency, all AI-generated based on
// real recent conversation context.
//
// Stages:
//   1. 15 min after last client message  -> gentle follow-up
//   2. 1 hour after last client message  -> value-driven nudge
//   3. Next day at 10am Mexico time      -> fresh start recap (ONLY if
//                                            stage 2 was already sent and
//                                            got no reply)
//   4. 5 min before 24h window closes    -> maximum urgency
//
// Gemini-only (design.md de-slotting table: "nudges: OpenRouter primary +
// Gemini fallback -> Gemini only", an explicit scope decision — this port
// drops the OpenRouter branch entirely, no dual-provider code anywhere
// here).
//
// Reuses src/brain/gemini.js's generateContent() wrapper (same request
// shape/auth pattern every other Gemini call in this repo already uses —
// no reinvented raw fetch to the Gemini REST API) and
// src/channels/whatsapp/client.js's sendText() (the same primitive
// src/agent/effects/appointment.js and src/routes/payments.js already use
// — no second Meta Graph API POST helper).
//
// Real per-conversation state (tasks.md's own scope note — this repo has
// neither a conversations table nor per-phone message history yet):
// src/db/conversations.js, new in this same phase. See that module's
// header comment / schema.sql's comment on the `conversations` table for
// why a dedicated table, and src/channels/whatsapp/webhook.js's
// handleIncomingMessage for where it gets written (the only place inbound
// messages are observed). Dedupe reads that table fresh on every scan — a
// real DB read, not in-memory state that would reset on restart (this job
// starts unconditionally at boot, same precedent as
// src/jobs/appointment-reminders.js).
//
// No cron/scheduler dependency — a minimal setTimeout+setInterval runner,
// same shape as src/jobs/appointment-reminders.js (do not invent a second
// job-runner pattern).
//
// Deliberately NOT built here (out of scope, carried from PR9's Open
// Risks): conversation-level pause/archived/status/message-limit guards.
// app_config.bot_paused IS wired here (PR13 follow-up fix — the webhook
// path's own gap was closed in this same PR, and this job would otherwise
// have been the one remaining place that ignored the pause flag). This
// repo has a single GLOBAL bot_paused flag, not a per-conversation one, so
// the whole scan pass is skipped while paused rather than gating
// per-conversation — see scanAndFollowup() below for the early-return.

const store = require('../config/store');
const client = require('../channels/whatsapp/client');
const gemini = require('../brain/gemini');
const conversations = require('../db/conversations');

const SCAN_INTERVAL_MS = 2 * 60 * 1000; // scan every 2 minutes
const START_DELAY_MS = 45 * 1000; // ported verbatim from the source's boot delay
const WINDOW_TOTAL_MS = 24 * 60 * 60 * 1000; // 24h Meta window
const MEXICO_OFFSET_MS = -6 * 60 * 60 * 1000; // UTC-6 (no DST)

// Stage timing
const STAGE_1_DELAY_MS = 15 * 60 * 1000; // 15 min after last client msg
const STAGE_2_DELAY_MS = 60 * 60 * 1000; // 1 hour after last client msg
const STAGE_4_THRESHOLD_MS = 5 * 60 * 1000; // 5 min before 24h expiry
const MIN_CONTEXT_TURNS = 2; // not enough context to nudge about below this

// ── AI prompts per stage — PORTED VERBATIM (tuned Spanish copy, not
// placeholder text). Shared with the main bot's soul-docs system: nudges
// have their own tone/urgency prompts but must still respect the same
// emoji whitelist and punctuation rule, otherwise a follow-up can visibly
// clash with the main conversation. ─────────────────────────────────────

const FORMAT_RULES = `

FORMATO (obligatorio, igual que el resto de la conversación):
- Emojis SOLO de esta lista: 🤗 ✨ 👩‍💻 📅 💡 📊 🔍 🚀. Máximo 1-2 por mensaje.
- NUNCA emojis tristes, dudosos o fuera de la lista (🤔 😥 😢 son ejemplos PROHIBIDOS).
- SOLO signos de puntuación de cierre. Nunca empieces una frase con ¡ o ¿.`;

const STAGE_PROMPTS = {
  1: {
    label: '15 min follow-up',
    system: `Eres un asistente comercial de Wispify. El lead dejó de responder hace 15 minutos.

TAREA: Generar UN mensaje de seguimiento corto que re-engage la conversación.

TONO: Cálido, casual, como un amigo que se dio cuenta que se cortó la conversación.
URGENCIA: Baja — no presionar, solo reactivar.

REGLAS:
- Máximo 2 líneas, texto plano
- Referenciar lo último que hablaron (nombre, negocio, pregunta pendiente)
- NO repetir lo que ya dijiste
- Preguntar algo específico que avance la conversación
- Si el lead hizo una pregunta que no se contestó, contestarla
- NUNCA inventar datos${FORMAT_RULES}`,
  },
  2: {
    label: '1 hour follow-up',
    system: `Eres un asistente comercial de Wispify. El lead dejó de responder hace 1 hora.

TAREA: Generar UN mensaje que muestre valor específico para su negocio.

TONO: Profesional, consultivo, como un experto que conoce su industria.
URGENCIA: Media — crear FOMO sutil sin ser agresivo.

REGLAS:
- Máximo 3 líneas, texto plano
- Mencionar un beneficio CONCRETO del agente IA para SU tipo de negocio
- Ejemplo: "un restaurante como el tuyo podría automatizar pedidos por WhatsApp 24/7"
- Cerrar con pregunta directa: ¿quiere ver una demo? ¿le interesa ver los planes?
- NUNCA inventar datos que no estén en la conversación
- Si no sabes qué tipo de negocio es, preguntar directamente${FORMAT_RULES}`,
  },
  3: {
    label: 'Next day 10am',
    system: `Eres un asistente comercial de Wispify. Es un nuevo día (10am) y el lead no respondió ayer.

TAREA: Generar UN mensaje de "buenos días" que retome la conversación desde un ángulo fresco.

TONO: Fresco, energético, como un nuevo día de oportunidades.
URGENCIA: Media-alta — "ayer hablamos de X, tengo una idea para ti"

REGLAS:
- Máximo 3 líneas, texto plano
- Saludar brevemente ("Buenos días, [nombre]")
- Recapitular EN UNA ORACIÓN lo que hablaron ayer
- Ofrecer algo nuevo: demo, caso de éxito, plan especial, o pregunta que desbloquee
- NUNCA inventar datos
- Si el lead no dio mucha info, hacer una pregunta directa que avance${FORMAT_RULES}`,
  },
  4: {
    label: '5 min before window close',
    system: `Eres un asistente comercial de Wispify. La ventana de 24h de WhatsApp se cierra en 5 MINUTOS.

TAREA: Generar UN mensaje FINAL de máxima urgencia profesional.

TONO: Directo, urgente pero respetuoso — como un asesor que realmente quiere ayudar.
URGENCIA: Máxima — después de esto NO podrás enviar mensajes libres.

REGLAS:
- Máximo 3 líneas, texto plano
- Ser honesto: "mi ventana de atención se cierra en unos minutos"
- Referenciar lo que hablaron para demostrar que estuviste atento
- Call-to-action claro y directo: responder AHORA para agendar demo o ver planes
- Si no responde, ofrecer que puede escribir cuando quiera (pero ya no podrás iniciar tú)
- NUNCA inventar datos${FORMAT_RULES}`,
  },
};

// Deterministic enforcement — mirrors src/agent/tags.js's control-tag
// stripping precedent (PR9): prompt compliance is probabilistic, a
// deterministic strip is the guarantee. The rule is "never opening marks,
// anywhere" — not just at line start.
function stripOpeningPunctuation(text) {
  return text.replace(/[¡¿]/g, '');
}

/** Mexico City wall-clock Date for a given instant (UTC-6, no DST — same convention as src/agent/date.js). `now` is already a UTC epoch-ms instant, so no local-timezone correction is needed (unlike the source's getMexicoNow(), which read the server's own local clock via a bare `new Date()`). */
function getMexicoDate(now) {
  return new Date(now + MEXICO_OFFSET_MS);
}

/** True when Mexico-local time is 10:00-10:11 (matches the source's `mx.getMinutes() < 12` window). */
function isMexico10am(now = Date.now()) {
  const mx = getMexicoDate(now);
  return mx.getUTCHours() === 10 && mx.getUTCMinutes() < 12;
}

/** Build the stage's userMessage (conversation summary + contact/business name + stage label), mirroring the source's template. */
function buildUserMessage(stage, conv) {
  const prompt = STAGE_PROMPTS[stage];
  const convoSummary = conv.recentTurns
    .map((t) => `${t.role === 'user' ? 'Cliente' : 'Bot'}: ${t.content}`)
    .join('\n');

  return `CONVERSACIÓN RECIENTE:
${convoSummary}

Nombre del contacto: ${conv.contactName || 'no proporcionado'}
Negocio: ${conv.businessName || 'no proporcionado'}
Etapa: ${prompt.label}

Genera SOLO el mensaje (sin comillas, sin explicaciones, sin "Aquí tienes").`;
}

/** Generate stage's contextual message via Gemini only. Returns null on any failure/empty reply — the caller must never send a broken/empty nudge. */
async function generateMessage(stage, conv, { geminiCreds, fetchImpl }) {
  const prompt = STAGE_PROMPTS[stage];
  if (!prompt) return null;

  const result = await gemini.generateContent(
    {
      apiKey: geminiCreds.api_key,
      model: geminiCreds.model,
      systemPrompt: prompt.system,
      text: buildUserMessage(stage, conv),
      media: null,
    },
    { fetchImpl }
  );

  if (!result.ok) {
    console.error(`[NUDGE] Gemini call failed: ${result.error}`);
    return null;
  }
  return result.text || null;
}

/**
 * Decide which stage (if any) a conversation is due for this scan.
 *
 * Priority order: stage 4 -> stage 1 -> stage 2 -> stage 3.
 *
 * Stage 4 is a genuine hard-deadline override (the 24h Meta window is about
 * to close), so it is always checked first regardless of stage 1/2/3 state.
 *
 * Stage 1 is checked BEFORE stage 2 (PR12 follow-up fix — the original port
 * checked stage 2 before stage 1, mirroring the source's if/else-if chain
 * verbatim). If stage 1's Gemini call ever fails/returns empty,
 * `stageSentAt[1]` is never set, so stage 1 stays "eligible" forever. Under
 * the old order, once `elapsed` later crossed the stage-2 threshold, stage 2
 * fired FIRST (checked earlier in the chain) and got marked sent — then on a
 * later scan stage 2 was already sent, so stage 1 (checked last, still
 * eligible) fired AFTER stage 2 already went out, inverting the intended
 * escalating-urgency order. Checking stage 1 first closes that path
 * entirely: if stage 1 is still unsent, it always gets a chance to send
 * before stage 2 is ever considered.
 *
 * Stage 3 keeps its position last — it already requires stage 2 to have
 * been sent as a precondition, so its relative position to stage 1/2 does
 * not matter.
 */
function decideStage(conv, { now, is10am }) {
  const lastClientMs = new Date(conv.lastClientMessageAt).getTime();
  if (Number.isNaN(lastClientMs)) return null;

  const elapsed = now - lastClientMs;
  const remaining = WINDOW_TOTAL_MS - elapsed;

  if (remaining <= 0) return null; // window expired
  if (elapsed < STAGE_1_DELAY_MS) return null; // client responded recently
  if (conv.recentTurns.length < MIN_CONTEXT_TURNS) return null; // not enough context

  // Stage 4: 5 min before window closes (highest priority — hard deadline override)
  if (remaining <= STAGE_4_THRESHOLD_MS && !conv.stageSentAt[4]) return 4;

  // Stage 1: 15 min after last client message — checked before stage 2
  if (elapsed >= STAGE_1_DELAY_MS && !conv.stageSentAt[1]) return 1;

  // Stage 2: 1 hour after last client message
  if (elapsed >= STAGE_2_DELAY_MS && !conv.stageSentAt[2]) return 2;

  // Stage 3: next day at 10am Mexico time, ONLY if stage 2 was already sent
  if (is10am && !conv.stageSentAt[3] && elapsed > STAGE_2_DELAY_MS && conv.stageSentAt[2]) return 3;

  return null;
}

/**
 * One scan pass — exported standalone so it is directly unit-testable and
 * reusable, without waiting on the interval (same convention as
 * src/jobs/appointment-reminders.js's scanAndRemind()).
 * @param {import('better-sqlite3').Database} db
 * @param {{fetchImpl?: typeof fetch, now?: number}} [opts]
 */
async function scanAndFollowup(db, { fetchImpl, now = Date.now() } = {}) {
  const metaCreds = store.getIntegrationCredentials(db, 'meta');
  if (!metaCreds) return; // nothing configured to send follow-ups with

  const geminiCreds = store.getIntegrationCredentials(db, 'gemini');
  if (!geminiCreds || !geminiCreds.api_key || !geminiCreds.model) return; // Gemini-only — no OpenRouter fallback

  // PR13 follow-up fix: read app_config.bot_paused FRESH on every scan (same
  // "no caching, apply live" discipline webhook.js's own gate already
  // established). One global flag, mono-tenant — an admin who pauses the
  // bot expects total silence, including automated follow-ups, so the
  // entire scan pass is skipped, not just individual sends.
  if (store.getAppConfig(db).botPaused) return;

  const is10am = isMexico10am(now);
  const stalled = conversations.listConversationsWithActivity(db);

  for (const conv of stalled) {
    const stageToSend = decideStage(conv, { now, is10am });
    if (!stageToSend) continue;

    const label = STAGE_PROMPTS[stageToSend].label;
    console.log(`[NUDGE] ${conv.customerPhone} | stage ${stageToSend} (${label})`);

    let message = await generateMessage(stageToSend, conv, { geminiCreds, fetchImpl });
    // Deterministic enforcement — prompt compliance alone isn't reliable (same precedent as src/agent/tags.js's control-tag stripping).
    if (message) message = stripOpeningPunctuation(message).trim();

    if (!message) {
      console.log(`[NUDGE] stage ${stageToSend} — AI returned empty, skipping`);
      continue;
    }

    // Stale-snapshot guard (PR12 follow-up fix): `conv` is a snapshot taken
    // at the TOP of this scan, and generateMessage() above just did a real
    // network round-trip to Gemini that can take real seconds. If the
    // customer sent a genuine reply via the webhook while this nudge was
    // mid-flight (the webhook writes last_client_message_at immediately via
    // conversations.recordClientMessage), sending now would deliver a
    // stale "you went quiet" nudge. Re-fetch the conversation FRESH and
    // re-run decideStage() against it before the second network round-trip
    // (the actual WhatsApp send) ever happens — if the fresh decision no
    // longer matches, the conversation state changed mid-flight (a reply
    // landed, or another process already marked this stage sent) and this
    // nudge must never go out.
    const freshConv = conversations.getConversation(db, conv.customerPhone);
    const freshStage = freshConv ? decideStage(freshConv, { now, is10am }) : null;
    if (freshStage !== stageToSend) {
      console.log(`[NUDGE] stage ${stageToSend} for ${conv.customerPhone} skipped — conversation state changed mid-flight`);
      continue;
    }

    const sent = await client.sendText(metaCreds, { to: conv.customerPhone, text: message }, { fetchImpl });
    if (sent) {
      const nowIso = new Date(now).toISOString();
      conversations.markStageSent(db, conv.customerPhone, stageToSend, { now: nowIso });
      conversations.recordBotMessage(db, conv.customerPhone, { text: message, now: nowIso });
      console.log(`[NUDGE] stage ${stageToSend} sent to ${conv.customerPhone} — ${label}`);
    }
  }
}

/**
 * Start the periodic scan loop. Returns a handle with stop() so tests and
 * graceful shutdown never leave a dangling timer (same convention as
 * src/jobs/appointment-reminders.js's startAppointmentReminderJob()).
 * @param {import('better-sqlite3').Database} db
 * @param {{fetchImpl?: typeof fetch, intervalMs?: number, startDelayMs?: number}} [opts]
 */
function startNudgeJob(db, { fetchImpl, intervalMs = SCAN_INTERVAL_MS, startDelayMs = START_DELAY_MS } = {}) {
  let interval = null;
  // Reentrancy guard (PR12 follow-up fix): markStageSent() is an
  // unconditional UPDATE with no locking, and this is a plain setInterval
  // with no check for whether the previous scan's promise is still
  // pending. If a scan runs long (many conversations, slow Gemini/Meta
  // responses) and overlaps the next tick, two concurrent scanAndFollowup()
  // calls could both see the same conversation as "stage not yet sent" and
  // both send it — a duplicate nudge to the same customer. Same-process
  // only, no schema/cross-process locking needed (matches this repo's
  // "keep it minimal" convention) — an in-memory flag is sufficient.
  let scanning = false;
  const runScan = () => {
    if (scanning) {
      console.log('[NUDGE] scan already in progress, skipping this tick');
      return;
    }
    scanning = true;
    scanAndFollowup(db, { fetchImpl })
      .catch((err) => console.error('[NUDGE] scan failed:', err.message))
      .finally(() => {
        scanning = false;
      });
  };
  const timeout = setTimeout(() => {
    runScan();
    interval = setInterval(runScan, intervalMs);
  }, startDelayMs);

  console.log('[NUDGE] 4-stage follow-up job scheduled — scanning every 2 min');

  return {
    stop() {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    },
  };
}

module.exports = { scanAndFollowup, startNudgeJob, stripOpeningPunctuation, isMexico10am };
