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

// ─── Main webhook endpoint ──────────────────────────────────────────────────

router.post("/mesomb", async (req, res) => {
  // 1. Respond fast — MeSomb expects a quick acknowledgement
  //    We read the signature synchronously first, then ack and process.

  const rawBody = req.body; // Buffer, thanks to express.raw()
  const signatureHeader = req.headers["x-mesomb-webhook-signature"] || "";
  const eventIdHeader   = req.headers["x-mesomb-webhook-event-id"]   || "";
  const webhookSecret   = process.env.MESOMB_WEBHOOK_SECRET || "";
  const tolerance       = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) || 300;

  // 2. Verify signature (when secret is configured)
  if (webhookSecret) {
    try {
      verifyMeSombWebhook({
        rawBody,
        signatureHeader,
        webhookSecret,
        toleranceSeconds: tolerance,
      });
    } catch (err) {
      console.warn("Webhook signature verification failed:", err.message);
      return res.status(400).json({ error: err.message });
    }
  } else {
    console.warn("MESOMB_WEBHOOK_SECRET not set — skipping signature verification (unsafe for production)");
  }

  // 3. Parse JSON from raw buffer
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  // 4. Deduplication — use header first, fall back to event.id in body
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
      // Non-fatal: dedup check failed, continue processing (idempotent handlers handle it)
      console.error("Dedup check error:", err.message);
    }
  }

  // 5. Acknowledge immediately before heavy processing
  res.status(200).json({ received: true });

  // 6. Record event in webhook_events table (best-effort)
  if (eventId && supabase) {
    supabase
      .from("webhook_events")
      .insert({ id: eventId, event_type: event.event_type, payload: event })
      .then(({ error }) => { if (error) console.error("Failed to record webhook event:", error.message); });
  }

  // 7. Route to handler
  const eventType = event.event_type;
  const handler = HANDLERS[eventType];

  if (!handler) {
    console.log(`Unrecognised event type "${eventType}" — acknowledged but not processed`);
    return;
  }

  try {
    await handler(event);
  } catch (err) {
    // Log but do NOT propagate — response already sent, MeSomb already acked
    console.error(`Error processing ${eventType} event ${eventId}:`, err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the canonical payments row from a MeSomb transaction object.
 * @param {object} txn - data.object from MeSomb event
 * @param {boolean} livemode
 * @returns {object}
 */
function buildPaymentRow(txn, livemode = true) {
  return {
    mesomb_pk:     txn.pk,
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
 * Update an order table's payment status and link the payment record.
 * @param {string} reference - trxID / reference from the MeSomb transaction
 * @param {string} paymentUuid - UUID from our payments table
 * @param {'paid'|'failed'|'refunded'|'funded'|'completed'} paymentStatus
 */
async function updateOrderPaymentStatus(reference, paymentUuid, paymentStatus) {
  if (!supabase || !reference) return;

  const resolved = resolveOrderTable(reference);
  if (!resolved) {
    console.log(`No order table mapped for reference "${reference}" — skipping order update`);
    return;
  }

  const { error } = await supabase
    .from(resolved.table)
    .update({ payment_status: paymentStatus, payment_id: paymentUuid })
    .eq("payment_reference", reference)  // try payment_reference first
    .is("payment_reference", null)        // no-op clause to keep query valid when column missing

  // Fallback: try matching on id column if payment_reference doesn't exist
  if (error) {
    console.warn(`Could not update ${resolved.table} by payment_reference: ${error.message}`);
  } else {
    console.log(`Updated ${resolved.table} payment_status → ${paymentStatus} for ref ${reference}`);
  }
}

// ─── payment.transaction.success ───────────────────────────────────────────

async function handlePaymentSuccess(event) {
  const txn      = event.data?.object;
  const livemode = event.livemode ?? true;

  if (!txn) return;

  console.log(`[SUCCESS] trxID=${txn.reference} pk=${txn.pk} fin_trx_id=${txn.fin_trx_id} amount=${txn.amount} ${txn.service}`);

  const row = buildPaymentRow(txn, livemode);

  if (supabase) {
    const { data: upserted, error } = await supabase
      .from("payments")
      .upsert(row, { onConflict: "mesomb_pk" })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase upsert failed (payment success):", error.message);
    } else {
      await updateOrderPaymentStatus(txn.reference, upserted?.id, "paid");
    }
  }

  // Firebase: update Firestore transaction document if configured
  if (db && txn.reference) {
    try {
      await db.collection("transactions").doc(txn.reference).set(
        {
          status:        "SUCCESS",
          mesombPk:      txn.pk,
          finTrxId:      txn.fin_trx_id,
          updatedAt:     new Date(),
          webhookEvent:  event.event_type,
        },
        { merge: true }
      );

      // Wallet top-up: credit user balance in Firestore
      const docSnap = await db.collection("transactions").doc(txn.reference).get();
      const txData  = docSnap.data();
      if (txData?.type === "Wallet" && txData?.userId) {
        const userRef = db.collection("users").doc(txData.userId);
        await db.runTransaction(async (t) => {
          const userDoc   = await t.get(userRef);
          const balance   = userDoc.exists ? (userDoc.data()?.balance || 0) : 0;
          t.set(userRef, { balance: balance + txn.amount }, { merge: true });
        });
        console.log(`Wallet topped up for user ${txData.userId}: +${txn.amount}`);
      }
    } catch (err) {
      console.error("Firebase update failed (payment success):", err.message);
    }
  }
}

// ─── payment.transaction.failed ────────────────────────────────────────────
// NOTE: A failed payment is a normal business event — do NOT treat as a system error.

async function handlePaymentFailed(event) {
  const txn      = event.data?.object;
  const livemode = event.livemode ?? true;

  if (!txn) return;

  console.log(`[FAILED] trxID=${txn.reference} pk=${txn.pk} reason="${txn.message}" service=${txn.service}`);

  const row = buildPaymentRow(txn, livemode);

  if (supabase) {
    const { data: upserted, error } = await supabase
      .from("payments")
      .upsert(row, { onConflict: "mesomb_pk" })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase upsert failed (payment failed):", error.message);
    } else {
      await updateOrderPaymentStatus(txn.reference, upserted?.id, "failed");
    }
  }

  if (db && txn.reference) {
    try {
      await db.collection("transactions").doc(txn.reference).set(
        { status: "FAILED", failureReason: txn.message, updatedAt: new Date() },
        { merge: true }
      );
    } catch (err) {
      console.error("Firebase update failed (payment failed):", err.message);
    }
  }
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

  // If the session carries a paid transaction, run the same fulfilment as payment success
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
}

// ─── securepay.transaction.funded ──────────────────────────────────────────

async function handleSecurePayFunded(event) {
  const txn = event.data?.object;
  if (!txn) return;
  console.log(`[SECUREPAY FUNDED] pk=${txn.pk} ref=${txn.reference}`);

  if (supabase) {
    await supabase.from("payments").upsert(
      { ...buildPaymentRow(txn, event.livemode), status: "funded" },
      { onConflict: "mesomb_pk" }
    );
    await updateOrderPaymentStatus(txn.reference, null, "funded");
  }
}

// ─── securepay.transaction.released ───────────────────────────────────────

async function handleSecurePayReleased(event) {
  const txn = event.data?.object;
  if (!txn) return;
  console.log(`[SECUREPAY RELEASED] pk=${txn.pk} ref=${txn.reference}`);

  if (supabase) {
    await supabase.from("payments").upsert(
      { ...buildPaymentRow(txn, event.livemode), status: "SUCCESS" },
      { onConflict: "mesomb_pk" }
    );
    await updateOrderPaymentStatus(txn.reference, null, "completed");
  }
}

// ─── securepay.transaction.refunded ───────────────────────────────────────

async function handleSecurePayRefunded(event) {
  const txn = event.data?.object;
  if (!txn) return;
  console.log(`[SECUREPAY REFUNDED] pk=${txn.pk} ref=${txn.reference}`);

  if (supabase) {
    await supabase.from("payments").upsert(
      { ...buildPaymentRow(txn, event.livemode), status: "REFUNDED" },
      { onConflict: "mesomb_pk" }
    );
    await updateOrderPaymentStatus(txn.reference, null, "refunded");
  }
}

// ─── securepay.transaction.disputed ───────────────────────────────────────

async function handleSecurePayDisputed(event) {
  const txn = event.data?.object;
  if (!txn) return;
  console.log(`[SECUREPAY DISPUTED] pk=${txn.pk} ref=${txn.reference}`);

  if (supabase) {
    await supabase.from("payments").upsert(
      { ...buildPaymentRow(txn, event.livemode), status: "disputed" },
      { onConflict: "mesomb_pk" }
    );
  }
}

// ─── Generic securepay pass-through handlers ──────────────────────────────

async function handleSecurePayGeneric(event, status) {
  const txn = event.data?.object;
  if (!txn || !supabase) return;
  await supabase.from("payments").upsert(
    { ...buildPaymentRow(txn, event.livemode), status },
    { onConflict: "mesomb_pk" }
  );
}

// ─── Dispute sub-event handlers ────────────────────────────────────────────

async function handleDisputeEvent(event) {
  const dispute = event.data?.object;
  if (!dispute) return;
  console.log(`[DISPUTE ${event.event_type}] id=${dispute.id || dispute.pk}`);
  // Store dispute payload in Supabase for review
  if (supabase) {
    const { error } = await supabase
      .from("webhook_events")
      .upsert({ id: `dispute-${event.id}`, event_type: event.event_type, payload: event }, { onConflict: "id" });
    if (error) console.error("Failed to store dispute event:", error.message);
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

  [MeSombEventTypes.SECUREPAY_CREATED]:          (e) => handleSecurePayGeneric(e, "created"),
  [MeSombEventTypes.SECUREPAY_CANCELLED]:        (e) => handleSecurePayGeneric(e, "cancelled"),
  [MeSombEventTypes.SECUREPAY_EXPIRED]:          (e) => handleSecurePayGeneric(e, "expired"),
  [MeSombEventTypes.SECUREPAY_AWAITING_RELEASE]: (e) => handleSecurePayGeneric(e, "awaiting_release"),
  [MeSombEventTypes.SECUREPAY_FULFILLMENT_UPDATED]: (e) => handleSecurePayGeneric(e, "fulfillment_updated"),

  [MeSombEventTypes.DISPUTE_EVIDENCE_ADDED]: handleDisputeEvent,
  [MeSombEventTypes.DISPUTE_MESSAGE_ADDED]:  handleDisputeEvent,
  [MeSombEventTypes.DISPUTE_UNDER_REVIEW]:   handleDisputeEvent,
  [MeSombEventTypes.DISPUTE_RESOLVED]:       handleDisputeEvent,
};

export default router;
