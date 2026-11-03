/**
 * POST /api/webhooks/github — GitHub → console live progress push.
 *
 * Exempt from session auth (see _middleware.js) but ONLY accepts deliveries
 * whose X-Hub-Signature-256 is a valid HMAC-SHA256 of the raw body with the
 * GITHUB_WEBHOOK_SECRET Pages secret (constant-time compare). Handles
 * workflow_run + workflow_job events from the two engine repositories and
 * writes run/job status, current step, conclusion, html_url and timestamps to
 * D1. The polling sync (POST /api/sync/github) remains as a fallback.
 */
import { json } from '../_lib/util.js';
import { verifySignature, processEvent } from '../_lib/webhook.js';
import { sweepPublished, hasR2 } from '../_lib/r2.js';

const MAX_BODY = 2 * 1024 * 1024; // GitHub caps payloads at 25 MB; ours are small.

export async function onRequestPost(context) {
  const { request, env } = context;
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return json(null, 503, { ok: false, error: 'Webhook secret not configured.' });

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY) return json(null, 413, { ok: false, error: 'Payload too large.' });
  const valid = await verifySignature(secret, raw, request.headers.get('X-Hub-Signature-256'));
  if (!valid) return json(null, 401, { ok: false, error: 'Invalid signature.' });

  const event = request.headers.get('X-GitHub-Event') || '';
  const delivery = request.headers.get('X-GitHub-Delivery') || null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch {
    return json(null, 400, { ok: false, error: 'Body must be application/json.' });
  }
  try {
    const { status, body } = await processEvent(env.DB, env, event, payload, delivery);
    // Keep published videos out of the 30-day drafts/ expiry (moved to published/ in R2).
    if (hasR2(env) && event === 'workflow_run' && payload?.action === 'completed' && typeof context.waitUntil === 'function') {
      context.waitUntil(sweepPublished(env, env.DB).catch(() => {}));
    }
    return json(null, status, body);
  } catch (err) {
    // 500 lets GitHub show the failure in Recent Deliveries (redeliverable).
    return json(null, 500, { ok: false, error: `Webhook processing failed: ${err.message}` });
  }
}
