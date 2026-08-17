/**
 * MeSomb Webhook Handler (Microservice Entry Point)
 *
 * ARCHITECTURE (Two-Webhook Design — v2.0.0):
 * ─────────────────────────────────────────────────────────────────────────────
 * This microservice acts as a **lightweight gateway** to the main app's webhook
 * handler. It is NOT the authoritative processor of payments.
 *
 * RESPONSIBILITY:
 * 1. Verify X-MeSomb-Webhook-Signature (HMAC-SHA256, 5-min tolerance)
 * 2. Check idempotency using Firestore mesomb_events collection
 * 3. Forward raw body + signature headers to main app's /api/webhook/mesomb
 * 4. Record event in Firestore ONLY after main app accepts
 *
 * The main app is the SINGLE SOURCE OF TRUTH for:
 * • Wallet credits
 * • Mission activation
 * • Notifications (FCM, WhatsApp)
 * • All business logic
 *
 * DEPLOYMENT NOTES:
 * ─────────────────────────────────────────────────────────────────────────────
 * • Configure this URL in your MeSomb dashboard:
 *     https://<your-domain>/webhooks/mesomb
 *
 * • This route MUST be mounted BEFORE express.json() — it uses express.raw()
 *   to preserve the exact request body needed for HMAC signature verification.
 *   Passing a re-serialised JSON body will always fail signature checks.
 *
 * • MeSomb retry window: 72-hour auto-retry, 90-day manual replay.
 *   Always return 200/204 for recognised AND unrecognised event types.
 *   Never return 404/500 for unknown event types — that triggers unnecessary retries.
 *
 * • The endpoint must be publicly reachable over HTTPS.
 *
 * • Set environment variables:
 *   - MESOMB_WEBHOOK_SECRET: webhook signing secret from MeSomb dashboard
 *   - EATALYFT_MAIN_APP_URL: main app URL (e.g., https://eatalyft.cm or http://localhost:3000)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import express from "express";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { db, admin } from "../config/firebase.js";

const router = express.Router();

// ─── Raw body middleware (scoped to this router only) ───────────────────────
// express.json() must NOT be applied here — we need the raw buffer.
router.use(express.raw({ type: "*/*" }));

// ═══════════════════════════════════════════════════════════════════════════
// SIGNATURE VERIFICATION & IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verify MeSomb webhook signature using HMAC-SHA256
 * Spec: https://docs.mesomb.com/development/webhooks
 *
 * @param {object} options
 * @param {Buffer} options.rawBody - raw request body
 * @param {string} options.signatureHeader - X-MeSomb-Webhook-Signature header value
 * @param {string} options.secret - MESOMB_WEBHOOK_SECRET
 * @param {number} [options.toleranceSeconds=300] - max age in seconds (5 min default)
 * @returns {object} { ok: boolean, reason: string }
 */
function verifyMeSombSignature({ rawBody, signatureHeader, secret, toleranceSeconds = 300 }) {
  if (!signatureHeader) {
    return { ok: false, reason: "Missing X-MeSomb-Webhook-Signature header" };
  }

  if (!secret) {
    return { ok: false, reason: "MESOMB_WEBHOOK_SECRET not configured" };
  }

  if (!rawBody || rawBody.length === 0) {
    return { ok: false, reason: "Empty request body" };
  }

  // Parse signature header: t=<timestamp>,v1=<signature>
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith("t="));
  const vPart = parts.find((p) => p.startsWith("v1="));

  if (!tPart || !vPart) {
    return { ok: false, reason: "Malformed signature header (expected t=<ts>,v1=<sig>)" };
  }

  const timestamp = Number(tPart.slice(2));
  const signature = vPart.slice(3);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, reason: "Invalid timestamp in signature header" };
  }

  // Replay protection: check timestamp is within tolerance window
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return {
      ok: false,
      reason: `Signature timestamp outside ${toleranceSeconds}s tolerance (replay attempt?)`,
    };
  }

  // HMAC-SHA256 verification
  const bodyStr = rawBody.toString("utf8");
  const signedPayload = `${timestamp}.${bodyStr}`;
  const expected = createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const signatureBuf = Buffer.from(signature, "hex");

  // Timing-safe comparison
  if (
    expectedBuf.length !== signatureBuf.length ||
    !timingSafeEqual(expectedBuf, signatureBuf)
  ) {
    return { ok: false, reason: "Signature mismatch" };
  }

  return { ok: true, reason: "Valid" };
}

// In-memory dedupe cache (first line of defense; Firestore is source of truth)
const processedEvents = new Set();

/**
 * Check if event has already been processed (idempotency guard)
 * 1. Check in-memory cache first (fast)
 * 2. Check Firestore mesomb_events collection (durable)
 *
 * @param {string} eventId
 * @returns {Promise<boolean>}
 */
async function isAlreadyProcessed(eventId) {
  if (!eventId) return false;

  // Fast path: check memory
  if (processedEvents.has(eventId)) {
    console.log(`[Webhook] Event ${eventId} found in memory cache`);
    return true;
  }

  // Durable path: check Firestore
  if (db) {
    try {
      const snap = await db.collection("mesomb_events").doc(eventId).get();
      if (snap.exists) {
        console.log(`[Webhook] Event ${eventId} found in Firestore`);
        return true;
      }
    } catch (err) {
      console.warn(`[Webhook] Firestore lookup failed (continuing): ${err.message}`);
      // Don't fail-open — reprocessing is safe (idempotent operations in main app)
    }
  }

  return false;
}

/**
 * Mark an event as processed (idempotency record)
 * 1. Add to memory cache (bounded to 5000 entries)
 * 2. Write to Firestore (durable record)
 *
 * @param {string} eventId
 * @param {object} event - full event payload
 * @returns {Promise<void>}
 */
async function markProcessed(eventId, event) {
  if (!eventId) return;

  processedEvents.add(eventId);
  // Keep memory bounded — Firestore is the durable source of truth
  if (processedEvents.size > 5000) {
    console.log(`[Webhook] Memory cache full, clearing (Firestore is durable)`);
    processedEvents.clear();
  }

  if (db) {
    try {
      await db.collection("mesomb_events").doc(eventId).set(
        {
          receivedAt: admin.firestore.Timestamp.now(),
          forwardedTo: process.env.EATALYFT_MAIN_APP_URL || "https://eatalyft.cm",
          eventType: event?.event_type || event?.type || null,
          reference: event?.reference || event?.data?.object?.reference || null,
          status: event?.status || event?.data?.object?.status || null,
          amount: event?.amount || event?.data?.object?.amount || null,
          raw: event,
        },
        { merge: true }
      );
      console.log(`[Webhook] Event ${eventId} recorded in Firestore`);
    } catch (err) {
      console.warn(`[Webhook] Failed to persist event (continuing): ${err.message}`);
      // Non-fatal: main app will also record this event
    }
  }
}

/**
 * Forward webhook event to main app
 * The main app is the authoritative processor
 *
 * @param {object} options
 * @param {string} options.url - main app webhook URL
 * @param {Buffer|string} options.rawBody - request body
 * @param {object} options.headers - request headers (includes signature)
 * @param {number} [options.timeoutMs=10000] - request timeout
 * @returns {Promise<object>} { ok: boolean, status: number, error?: string }
 */
async function forwardEvent({ url, rawBody, headers, timeoutMs = 10000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Forward all headers from the original request, especially X-MeSomb-Webhook-Signature
    const forwardHeaders = {
      "Content-Type": "application/json",
      "X-MeSomb-Webhook-Signature": headers["x-mesomb-webhook-signature"] || "",
      "X-MeSomb-Webhook-Event-Id": headers["x-mesomb-webhook-event-id"] || "",
      "X-Forwarded-By": "eatapay-microservice",
    };

    const bodyStr = rawBody instanceof Buffer ? rawBody.toString("utf8") : rawBody;

    const response = await fetch(url, {
      method: "POST",
      headers: forwardHeaders,
      body: bodyStr,
      signal: controller.signal,
    });

    const isSuccess = response.status >= 200 && response.status < 300;

    return {
      ok: isSuccess,
      status: response.status,
      error: isSuccess ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err.name === "AbortError" ? "Timeout" : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// MAIN WEBHOOK ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /webhooks/mesomb
 *
 * ARCHITECTURE (Two-Webhook Design):
 * ──────────────────────────────────────────────────────────────────────────
 * 1. Verify X-MeSomb-Webhook-Signature (HMAC-SHA256, 5-min tolerance).
 *    Forged or tampered events are rejected with 401 and NEVER processed.
 *
 * 2. Dedupe on event ID so MeSomb retries or manual replays cannot fire twice.
 *    - Check in-memory cache (fast)
 *    - Check Firestore mesomb_events (durable)
 *    - Return 200 immediately if seen before
 *
 * 3. Forward RAW body + original signature headers to main app's
 *    /api/webhook/mesomb — the SINGLE source of truth for:
 *    - Wallet credit
 *    - Mission activation
 *    - Notifications
 *    - Payment status updates
 *
 * 4. This microservice NO LONGER credits wallets or updates mission state.
 *    All business logic lives in the main app. This design prevents double-credits.
 *
 * 5. Return 2xx only after main app accepts (200-299).
 *    Otherwise return 500 so MeSomb retries.
 *
 * 6. Record event in Firestore ONLY after main app accepts (post-commit).
 * ──────────────────────────────────────────────────────────────────────────
 */
router.post("/mesomb", async (req, res) => {
  const rawBody = req.body;
  const signatureHeader = req.headers["x-mesomb-webhook-signature"] || "";
  const eventIdHeader = req.headers["x-mesomb-webhook-event-id"] || "";

  console.log(`[Webhook] Received event, signature: ${signatureHeader ? "present" : "missing"}`);

  // ─────────────────────────────────────────────────────────────────────────
  // 1. SIGNATURE VERIFICATION — fail closed
  // ─────────────────────────────────────────────────────────────────────────
  const secret = process.env.MESOMB_WEBHOOK_SECRET;
  const toleranceSeconds = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) || 300;

  const check = verifyMeSombSignature({
    rawBody,
    signatureHeader,
    secret,
    toleranceSeconds,
  });

  if (!check.ok) {
    console.warn(`[Webhook] ❌ Rejected event: ${check.reason}`);
    return res.status(401).json({
      received: false,
      error: `Unauthorized: ${check.reason}`,
    });
  }

  console.log(`[Webhook] ✅ Signature verified`);

  // Parse JSON body
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.error(`[Webhook] ❌ Invalid JSON body: ${err.message}`);
    return res.status(400).json({
      received: false,
      error: "Invalid JSON body",
    });
  }

  // Extract event ID (from header or body)
  const eventId =
    eventIdHeader ||
    event.id ||
    event.data?.id ||
    createHash("sha256").update(rawBody).digest("hex");

  console.log(
    `[Webhook] Event: id=${eventId}, type=${event?.event_type}, ` +
      `ref=${event?.reference || event?.data?.object?.reference}`
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 2. IDEMPOTENCY GUARD — skip duplicates
  // ─────────────────────────────────────────────────────────────────────────
  try {
    if (await isAlreadyProcessed(eventId)) {
      console.log(`[Webhook] ⏭️  Duplicate event ignored: ${eventId}`);
      return res.status(200).json({
        received: true,
        duplicate: true,
        message: "Event already processed",
      });
    }
  } catch (err) {
    console.warn(`[Webhook] Dedupe check failed (continuing): ${err.message}`);
    // Continue anyway — duplication is safe (idempotent operations in main app)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check for required fields
  // ─────────────────────────────────────────────────────────────────────────
  const reference = event?.reference || event?.data?.object?.reference;
  if (!reference && !event?.event_type?.includes("checkout")) {
    console.warn(`[Webhook] ⚠️  Event has no transaction reference`);
    return res.status(200).json({
      received: true,
      skipped: "no_reference",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. FORWARD to main app (single source of truth)
  // ─────────────────────────────────────────────────────────────────────────
  const mainAppUrl = (process.env.EATALYFT_MAIN_APP_URL || "https://eatalyft.cm").replace(
    /\/+$/,
    ""
  );
  const webhookUrl = `${mainAppUrl}/api/webhook/mesomb`;

  console.log(`[Webhook] 📤 Forwarding to main app: ${webhookUrl}`);

  const forward = await forwardEvent({
    url: webhookUrl,
    rawBody,
    headers: req.headers,
  });

  if (!forward.ok) {
    console.error(
      `[Webhook] ❌ Forward FAILED (status ${forward.status || "unknown"}): ${forward.error}`
    );
    // Return 500 so MeSomb retries
    return res.status(500).json({
      received: false,
      error: "Main app webhook unreachable — will retry",
    });
  }

  console.log(`[Webhook] ✅ Main app accepted event (${forward.status})`);

  // ─────────────────────────────────────────────────────────────────────────
  // 4. RECORD EVENT — only after main app accepted
  // ─────────────────────────────────────────────────────────────────────────
  try {
    await markProcessed(eventId, event);
  } catch (err) {
    console.warn(`[Webhook] Failed to mark event processed (continuing): ${err.message}`);
  }

  console.log(`[Webhook] ✅ Event ${eventId} complete`);
  return res.status(200).json({
    received: true,
    forwarded: true,
    message: "Event processed via main app",
  });
});


export default router;
