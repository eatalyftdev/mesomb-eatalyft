/**
 * MeSomb Webhook Handler
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
 * • Dual-write strategy: every payment record is written to BOTH Supabase and
 *   Firestore. Supabase is primary; Firestore is the fallback mirror. The
 *   Firestore write always runs regardless of whether Supabase succeeded.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import express from "express";
import { verifyMeSombWebhook, MeSombEventTypes, resolveOrderTable } from "../lib/mesombWebhook.js";
import { supabase } from "../config/supabase.js";
import { db } from "../config/firebase.js";

const router = express.Router();

// ─── Raw body middleware (scoped to this router only) ───────────────────────
// express.json() must NOT be applied here — we need the raw buffer.
router.use(express.raw({ type: "*/*" }));

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the canonical payments row from a MeSomb transaction object.
 * Used for Supabase upserts (snake_case keys).
 *
 * @param {object} txn - data.object from a MeSomb event
 * @param {boolean} livemode
 * @returns {object}
 */
function buildPaymentRow(txn, livemode = true) {
  return {
    mesomb_pk:     txn.pk            || null,
    fin_trx_id:    txn.fin_trx_id   || null,
    reference:     txn.reference    || null,
    status:        txn.status,
    amount:        txn.amount,
    fees:          txn.fees         ?? 0,
    trxamount:     txn.trxamount    || null,
    service:       txn.service      || null,
    currency:      txn.currency     || "XAF",
    country:       txn.country      || "CM",
    direction:     txn.direction    ?? null,
    type:          txn.type         || null,
    b_party:       txn.b_party      || null,
    message:       txn.message      || null,
    customer_data: txn.customer     || null,
    location_data: txn.location     || null,
    products:      txn.products     || null,
    livemode,
    updated_at:    new Date().toISOString(),
  };
}

/**
 * Mirror a payment record to Firestore `payments` collection.
 *
 * Called after every Supabase write — regardless of whether Supabase succeeded.
 * Firestore is the fallback; if Supabase is down this ensures data is not lost.
 *
 * Document ID = reference (trxID) when present, else mesomb_pk.
 * Fields are camelCase (JS convention) matching the Firestore data model.
 *
 * @param {object} row       - Supabase-format payment row from buildPaymentRow()
 * @param {object} [extra]   - Any extra fields to merge (e.g. supabaseId, walletCredited)
 */
async function mirrorPaymentToFirestore(row, extra = {}) {
  if (!db) return;

  const docId = row.reference || row.mesomb_pk;
  if (!docId) {
    console.warn("mirrorPaymentToFirestore: no reference or mesomb_pk — skipping");
    return;
  }

  const doc = {
    // Core identity
    mesombPk:      row.mesomb_pk     || null,
    finTrxId:      row.fin_trx_id   || null,
    reference:     row.reference    || null,
    // Status & amounts
    status:        row.status,
    amount:        row.amount,
    fees:          row.fees          ?? 0,
    trxAmount:     row.trxamount    || null,
    // Network
    service:       row.service      || null,
    currency:      row.currency     || "XAF",
    country:       row.country      || "CM",
    direction:     row.direction    ?? null,
    type:          row.type         || null,
    bParty:        row.b_party      || null,
    message:       row.message      || null,
    // Rich objects
    customer:      row.customer_data || null,
    location:      row.location_data || null,
    products:      row.products      || null,
    // Meta
    livemode:      row.livemode      ?? true,
    updatedAt:     new Date(),
    source:        "mesomb-webhook",
    ...extra,
  };

  try {
    await db.collection("payments").doc(docId).set(doc, { merge: true });
    console.log(`Firestore payments/${docId} mirrored (status=${row.status})`);
  } catch (err) {
    console.error(`Firestore mirror failed for payments/${docId}:`, err.message);
  }
}

/**
 * Mirror a checkout session to Firestore `checkout_sessions` collection.
 *
 * @param {object} session - session object from MeSomb event
 * @param {string} status  - created | completed | expired | canceled
 */
async function mirrorCheckoutToFirestore(session, status) {
  if (!db || !session) return;

  const docId = session.id || session.pk;
  if (!docId) return;

  try {
    await db.collection("checkout_sessions").doc(docId).set(
      { mesombPk: docId, status, payload: session, updatedAt: new Date(), source: "mesomb-webhook" },
      { merge: true }
    );
    console.log(`Firestore checkout_sessions/${docId} mirrored (status=${status})`);
  } catch (err) {
    console.error(`Firestore mirror failed for checkout_sessions/${docId}:`, err.message);
  }
}

/**
 * Update an order table's payment_status and payment_id in Supabase.
 *
 * @param {string} reference     - trxID / reference from MeSomb
 * @param {string|null} paymentUuid - UUID from our Supabase payments table
 * @param {string} paymentStatus - paid | failed | refunded | funded | completed
 */
async function updateOrderPaymentStatus(reference, paymentUuid, paymentStatus) {
  if (!supabase || !reference) return;

  const resolved = resolveOrderTable(reference);
  if (!resolved) {
    console.log(`No order table mapped for reference "${reference}" — skipping order update`);
    return;
  }

  const update = { payment_status: paymentStatus };
  if (paymentUuid) update.payment_id = paymentUuid;

  const { error } = await supabase
    .from(resolved.table)
    .update(update)
    .eq("payment_reference", reference);

  if (error) {
    console.warn(`Could not update ${resolved.table} for ref ${reference}: ${error.message}`);
  } else {
    console.log(`Updated ${resolved.table} payment_status → ${paymentStatus} for ref ${reference}`);
  }

  // Mirror order status update to Firestore transactions collection
  if (db) {
    try {
      await db.collection("transactions").doc(reference).set(
        { paymentStatus, orderTable: resolved.table, updatedAt: new Date() },
        { merge: true }
      );
    } catch (err) {
      console.error("Firestore order status mirror failed:", err.message);
    }
  }
}

// ─── Main webhook endpoint ──────────────────────────────────────────────────

router.post("/mesomb", async (req, res) => {
  const rawBody         = req.body;
  const signatureHeader = req.headers["x-mesomb-webhook-signature"] || "";
  const eventIdHeader   = req.headers["x-mesomb-webhook-event-id"]  || "";
  const webhookSecret   = process.env.MESOMB_WEBHOOK_SECRET || "";
  const tolerance       = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) || 300;

  // 1. Verify signature (when secret is configured)
  if (webhookSecret) {
    try {
      verifyMeSombWebhook({ rawBody, signatureHeader, webhookSecret, toleranceSeconds: tolerance });
    } catch (err) {
      console.warn("Webhook signature verification failed:", err.message);
      return res.status(400).json({ error: err.message });
    }
  } else {
    console.warn("MESOMB_WEBHOOK_SECRET not set — skipping signature verification (unsafe for production)");
  }

  // 2. Parse JSON from raw buffer
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  // 3. Deduplication — check Supabase webhook_events table
  const eventId = eventIdHeader || event.id;
  if (eventId && supabase) {
    try {
      const { data: existing } = await supabase
        .from("webhook_events")
        .select("id")
        .eq("id", eventId)
        .maybeSingle();

      if (existing) {
        console.log(`Duplicate webhook event ${eventId} — already processed, ignoring`);
        return res.status(200).json({ received: true, duplicate: true });
      }
    } catch (err) {
      console.error("Dedup check error:", err.message);
    }
  }

  // 4. Acknowledge immediately
  res.status(200).json({ received: true });

  // 5. Record event in Supabase webhook_events (best-effort) + mirror to Firestore
  if (eventId) {
    if (supabase) {
      supabase
        .from("webhook_events")
        .insert({ id: eventId, event_type: event.event_type, payload: event })
        .then(({ error }) => { if (error) console.error("Failed to record webhook event:", error.message); });
    }

    // Firestore mirror of webhook event log
    if (db) {
      db.collection("webhook_events").doc(eventId).set(
        { id: eventId, eventType: event.event_type, payload: event, processedAt: new Date() },
        { merge: true }
      ).catch((err) => console.error("Firestore webhook_events mirror failed:", err.message));
    }
  }

  // 6. Route to handler
  const handler = HANDLERS[event.event_type];
  if (!handler) {
    console.log(`Unrecognised event type "${event.event_type}" — acknowledged but not processed`);
    return;
  }

  try {
    await handler(event);
  } catch (err) {
    console.error(`Error processing ${event.event_type} event ${eventId}:`, err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// ─── payment.transaction.success ───────────────────────────────────────────

async function handlePaymentSuccess(event) {
  const txn      = event.data?.object;
  const livemode = event.livemode ?? true;
  if (!txn) return;

  console.log(`[SUCCESS] trxID=${txn.reference} pk=${txn.pk} fin_trx_id=${txn.fin_trx_id} amount=${txn.amount} ${txn.service}`);

  const row = buildPaymentRow(txn, livemode);
  let supabaseId = null;

  // ── Supabase (primary) ──
  if (supabase) {
    const { data: upserted, error } = await supabase
      .from("payments")
      .upsert(row, { onConflict: "mesomb_pk" })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase upsert failed (payment success):", error.message);
    } else {
      supabaseId = upserted?.id || null;
      await updateOrderPaymentStatus(txn.reference, supabaseId, "paid");
    }
  }

  // ── Firestore mirror (runs regardless of Supabase result) ──
  await mirrorPaymentToFirestore(row, { supabaseId, webhookEvent: event.event_type });

  // Wallet top-up in Firestore: credit the user's balance
  if (db && txn.reference) {
    try {
      const docSnap = await db.collection("transactions").doc(txn.reference).get();
      const txData  = docSnap.data();
      if (txData?.type === "Wallet" && txData?.userId) {
        const userRef = db.collection("users").doc(txData.userId);
        await db.runTransaction(async (t) => {
          const userDoc  = await t.get(userRef);
          const balance  = userDoc.exists ? (userDoc.data()?.balance || 0) : 0;
          t.set(userRef, { balance: balance + txn.amount }, { merge: true });
        });
        console.log(`Wallet topped up for user ${txData.userId}: +${txn.amount}`);
        // Update payment mirror with wallet credit flag
        await mirrorPaymentToFirestore(row, { supabaseId, walletCredited: true, walletUserId: txData.userId });
      }
    } catch (err) {
      console.error("Firestore wallet top-up failed:", err.message);
    }
  }
}

// ─── payment.transaction.failed ────────────────────────────────────────────
// A failed payment is a normal business event — handle gracefully, not as an error.

async function handlePaymentFailed(event) {
  const txn      = event.data?.object;
  const livemode = event.livemode ?? true;
  if (!txn) return;

  console.log(`[FAILED] trxID=${txn.reference} pk=${txn.pk} reason="${txn.message}" service=${txn.service}`);

  const row = buildPaymentRow(txn, livemode);
  let supabaseId = null;

  // ── Supabase (primary) ──
  if (supabase) {
    const { data: upserted, error } = await supabase
      .from("payments")
      .upsert(row, { onConflict: "mesomb_pk" })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase upsert failed (payment failed):", error.message);
    } else {
      supabaseId = upserted?.id || null;
      await updateOrderPaymentStatus(txn.reference, supabaseId, "failed");
    }
  }

  // ── Firestore mirror (runs regardless of Supabase result) ──
  await mirrorPaymentToFirestore(row, {
    supabaseId,
    webhookEvent:  event.event_type,
    failureReason: txn.message || null,
  });
}

// ─── checkout.session.created ──────────────────────────────────────────────

async function handleCheckoutCreated(event) {
  const session = event.data?.object;
  if (!session) return;
  console.log(`[CHECKOUT CREATED] id=${session.id || session.pk}`);

  if (supabase) {
    const { error } = await supabase
      .from("checkout_sessions")
      .upsert({ mesomb_pk: session.id || session.pk, status: "created", payload: session, updated_at: new Date().toISOString() }, { onConflict: "mesomb_pk" });
    if (error) console.error("Supabase upsert failed (checkout created):", error.message);
  }

  await mirrorCheckoutToFirestore(session, "created");
}

// ─── checkout.session.completed ────────────────────────────────────────────

async function handleCheckoutCompleted(event) {
  const session  = event.data?.object;
  const livemode = event.livemode ?? true;
  if (!session) return;
  console.log(`[CHECKOUT COMPLETED] id=${session.id || session.pk} payment_status=${session.payment_status}`);

  if (supabase) {
    const { error } = await supabase
      .from("checkout_sessions")
      .upsert({ mesomb_pk: session.id || session.pk, status: "completed", payload: session, updated_at: new Date().toISOString() }, { onConflict: "mesomb_pk" });
    if (error) console.error("Supabase upsert failed (checkout completed):", error.message);
  }

  await mirrorCheckoutToFirestore(session, "completed");

  // If this session carried a successful payment, trigger full fulfilment
  if (session.payment_status === "paid" && session.payment_intent) {
    await handlePaymentSuccess({
      ...event,
      event_type: MeSombEventTypes.PAYMENT_SUCCESS,
      data: { object: session.payment_intent },
      livemode,
    });
  }
}

// ─── checkout.session.expired ──────────────────────────────────────────────

async function handleCheckoutExpired(event) {
  const session = event.data?.object;
  if (!session) return;
  console.log(`[CHECKOUT EXPIRED] id=${session.id || session.pk}`);

  if (supabase) {
    const { error } = await supabase
      .from("checkout_sessions")
      .upsert({ mesomb_pk: session.id || session.pk, status: "expired", payload: session, updated_at: new Date().toISOString() }, { onConflict: "mesomb_pk" });
    if (error) console.error("Supabase upsert failed (checkout expired):", error.message);
  }

  await mirrorCheckoutToFirestore(session, "expired");
}

// ─── checkout.session.canceled ─────────────────────────────────────────────

async function handleCheckoutCanceled(event) {
  const session = event.data?.object;
  if (!session) return;
  console.log(`[CHECKOUT CANCELED] id=${session.id || session.pk}`);

  if (supabase) {
    const { error } = await supabase
      .from("checkout_sessions")
      .upsert({ mesomb_pk: session.id || session.pk, status: "canceled", payload: session, updated_at: new Date().toISOString() }, { onConflict: "mesomb_pk" });
    if (error) console.error("Supabase upsert failed (checkout canceled):", error.message);
  }

  await mirrorCheckoutToFirestore(session, "canceled");
}

// ─── securepay.transaction.funded ──────────────────────────────────────────

async function handleSecurePayFunded(event) {
  const txn = event.data?.object;
  if (!txn) return;
  console.log(`[SECUREPAY FUNDED] pk=${txn.pk} ref=${txn.reference}`);

  const row = { ...buildPaymentRow(txn, event.livemode), status: "funded" };

  if (supabase) {
    await supabase.from("payments").upsert(row, { onConflict: "mesomb_pk" });
    await updateOrderPaymentStatus(txn.reference, null, "funded");
  }
  await mirrorPaymentToFirestore(row, { webhookEvent: event.event_type });
}

// ─── securepay.transaction.released ───────────────────────────────────────

async function handleSecurePayReleased(event) {
  const txn = event.data?.object;
  if (!txn) return;
  console.log(`[SECUREPAY RELEASED] pk=${txn.pk} ref=${txn.reference}`);

  const row = { ...buildPaymentRow(txn, event.livemode), status: "SUCCESS" };

  if (supabase) {
    await supabase.from("payments").upsert(row, { onConflict: "mesomb_pk" });
    await updateOrderPaymentStatus(txn.reference, null, "completed");
  }
  await mirrorPaymentToFirestore(row, { webhookEvent: event.event_type });
}

// ─── securepay.transaction.refunded ───────────────────────────────────────

async function handleSecurePayRefunded(event) {
  const txn = event.data?.object;
  if (!txn) return;
  console.log(`[SECUREPAY REFUNDED] pk=${txn.pk} ref=${txn.reference}`);

  const row = { ...buildPaymentRow(txn, event.livemode), status: "REFUNDED" };

  if (supabase) {
    await supabase.from("payments").upsert(row, { onConflict: "mesomb_pk" });
    await updateOrderPaymentStatus(txn.reference, null, "refunded");
  }
  await mirrorPaymentToFirestore(row, { webhookEvent: event.event_type });
}

// ─── securepay.transaction.disputed ───────────────────────────────────────

async function handleSecurePayDisputed(event) {
  const txn = event.data?.object;
  if (!txn) return;
  console.log(`[SECUREPAY DISPUTED] pk=${txn.pk} ref=${txn.reference}`);

  const row = { ...buildPaymentRow(txn, event.livemode), status: "disputed" };

  if (supabase) {
    await supabase.from("payments").upsert(row, { onConflict: "mesomb_pk" });
  }
  await mirrorPaymentToFirestore(row, { webhookEvent: event.event_type });
}

// ─── Generic securepay status update handler ──────────────────────────────

async function handleSecurePayGeneric(event, status) {
  const txn = event.data?.object;
  if (!txn) return;

  const row = { ...buildPaymentRow(txn, event.livemode), status };

  if (supabase) {
    await supabase.from("payments").upsert(row, { onConflict: "mesomb_pk" });
  }
  await mirrorPaymentToFirestore(row, { webhookEvent: event.event_type });
}

// ─── Dispute sub-event handlers ────────────────────────────────────────────

async function handleDisputeEvent(event) {
  const dispute = event.data?.object;
  if (!dispute) return;
  console.log(`[DISPUTE ${event.event_type}] id=${dispute.id || dispute.pk}`);

  if (supabase) {
    const { error } = await supabase
      .from("webhook_events")
      .upsert({ id: `dispute-${event.id}`, event_type: event.event_type, payload: event }, { onConflict: "id" });
    if (error) console.error("Failed to store dispute event:", error.message);
  }

  // Firestore mirror of dispute event
  if (db) {
    const docId = `dispute-${event.id || dispute.id || dispute.pk}`;
    db.collection("disputes").doc(docId).set(
      { eventType: event.event_type, payload: event, updatedAt: new Date() },
      { merge: true }
    ).catch((err) => console.error("Firestore dispute mirror failed:", err.message));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER ROUTING MAP
// ═══════════════════════════════════════════════════════════════════════════

const HANDLERS = {
  [MeSombEventTypes.PAYMENT_SUCCESS]: handlePaymentSuccess,
  [MeSombEventTypes.PAYMENT_FAILED]:  handlePaymentFailed,

  [MeSombEventTypes.CHECKOUT_CREATED]:   handleCheckoutCreated,
  [MeSombEventTypes.CHECKOUT_COMPLETED]: handleCheckoutCompleted,
  [MeSombEventTypes.CHECKOUT_EXPIRED]:   handleCheckoutExpired,
  [MeSombEventTypes.CHECKOUT_CANCELED]:  handleCheckoutCanceled,

  [MeSombEventTypes.SECUREPAY_FUNDED]:   handleSecurePayFunded,
  [MeSombEventTypes.SECUREPAY_RELEASED]: handleSecurePayReleased,
  [MeSombEventTypes.SECUREPAY_REFUNDED]: handleSecurePayRefunded,
  [MeSombEventTypes.SECUREPAY_DISPUTED]: handleSecurePayDisputed,

  [MeSombEventTypes.SECUREPAY_CREATED]:             (e) => handleSecurePayGeneric(e, "created"),
  [MeSombEventTypes.SECUREPAY_CANCELLED]:           (e) => handleSecurePayGeneric(e, "cancelled"),
  [MeSombEventTypes.SECUREPAY_EXPIRED]:             (e) => handleSecurePayGeneric(e, "expired"),
  [MeSombEventTypes.SECUREPAY_AWAITING_RELEASE]:    (e) => handleSecurePayGeneric(e, "awaiting_release"),
  [MeSombEventTypes.SECUREPAY_FULFILLMENT_UPDATED]: (e) => handleSecurePayGeneric(e, "fulfillment_updated"),

  [MeSombEventTypes.DISPUTE_EVIDENCE_ADDED]: handleDisputeEvent,
  [MeSombEventTypes.DISPUTE_MESSAGE_ADDED]:  handleDisputeEvent,
  [MeSombEventTypes.DISPUTE_UNDER_REVIEW]:   handleDisputeEvent,
  [MeSombEventTypes.DISPUTE_RESOLVED]:       handleDisputeEvent,
};

export default router;
