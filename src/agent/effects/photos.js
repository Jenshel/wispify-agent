'use strict';
// src/agent/effects/photos.js — [ENVIAR_FOTO:productName] effect handler
// (tasks.md Phase 7.4) — DOCUMENTED STUB, NOT the real thing yet.
//
// Unlike appointment.js/order.js, there is no dedicated future phase number
// in tasks.md yet that owns a catalog table / product-image system — none
// of Phase 8-13 build one. This effect exists purely so the seam is
// exercised end to end (src/agent/pipeline.js always routes every
// [ENVIAR_FOTO:x] occurrence here rather than silently dropping it — see
// pipeline.js's own header comment) rather than the prompt or pipeline
// pretending the tag doesn't exist.
//
// src/channels/whatsapp/client.js's uploadMedia()/sendImageById() (built in
// PR7, Phase 5.3) are the exact primitives a future catalog-aware
// implementation should call — NOT reinvent — once there is a real product
// image to resolve `productName` to a file/buffer with. This stub
// deliberately does NOT call them: without a catalog, there is nothing to
// upload, and calling a Graph API primitive with no real image would just
// be a differently-shaped no-op.

/**
 * @param {{productName: string, to: string}} payload
 * @param {{fetchImpl?: typeof fetch}} [ctx]
 * @returns {Promise<{ok: false, stub: true, reason: string}>}
 */
async function sendPhoto({ productName, to } = {}, _ctx = {}) {
  console.warn(
    `[ENVIAR_FOTO] STUB — to=${to} productName="${productName || ''}"` +
      ' — no catalog/product-image table exists yet, nothing to send.' +
      ' See this module\'s header comment for the client.js primitives a future implementation should reuse.'
  );
  return { ok: false, stub: true, reason: 'catalog_not_implemented_yet' };
}

module.exports = { sendPhoto };
