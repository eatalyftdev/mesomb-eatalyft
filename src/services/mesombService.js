import { PaymentOperation, RandomGenerator } from "@hachther/mesomb";
import { supabase } from "../config/supabase.js";
import { db } from "../config/firebase.js";

if (
  !process.env.MESOMB_APPLICATION_KEY ||
  !process.env.MESOMB_ACCESS_KEY ||
  !process.env.MESOMB_SECRET_KEY
) {
  console.warn(
    "MeSomb credentials not fully configured. Payment operations will fail."
  );
}

const client = new PaymentOperation({
  applicationKey: process.env.MESOMB_APPLICATION_KEY,
  accessKey: process.env.MESOMB_ACCESS_KEY,
  secretKey: process.env.MESOMB_SECRET_KEY,
});

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Save or update a payment record in Supabase + Firestore.
 *
 * Called:
 *  (a) immediately after makeCollect/makeDeposit  → status = PENDING or FAILED
 *  (b) from the webhook handler                   → status = SUCCESS | FAILED | REFUNDED
 *
 * @param {object} params
 * @param {string}  params.trxID       - Internal reference / trxID (reconciliation key)
 * @param {string}  params.phone       - Payer/receiver phone number
 * @param {number}  params.amount      - Amount in XAF
 * @param {string}  params.service     - MTN | ORANGE | AIRTEL
 * @param {string}  params.type        - COLLECT | DEPOSIT
 * @param {string}  params.status      - PENDING | SUCCESS | FAILED | REFUNDED
 * @param {string}  [params.userId]
 * @param {string}  [params.mesombPk]  - transaction.pk from MeSomb response/webhook
 * @param {string}  [params.finTrxId]  - Operator transaction ID (from webhook)
 * @param {string}  [params.message]   - MeSomb response message (useful for FAILED)
 * @param {number}  [params.fees]
 * @param {number}  [params.trxamount]
 * @param {object}  [params.customerData]
 * @param {object}  [params.locationData]
 * @returns {Promise<string|null>} Supabase payments row UUID, or null
 */
async function savePaymentRecord({
  trxID,
  phone,
  amount,
  service,
  type,
  status,
  userId,
  mesombPk,
  finTrxId,
  message,
  fees,
  trxamount,
  customerData,
  locationData,
}) {
  const livemode = process.env.MESOMB_LIVEMODE !== "false";
  const now = new Date();
  let supabaseId = null;

  // ── Supabase ──────────────────────────────────────────────
  if (supabase) {
    const { data, error } = await supabase
      .from("payments")
      .upsert(
        {
          mesomb_pk: mesombPk || null,
          fin_trx_id: finTrxId || null,
          reference: trxID,
          status,
          amount,
          fees: fees ?? null,
          trxamount: trxamount ?? null,
          service,
          b_party: phone,
          type,
          message: message || null,
          currency: "XAF",
          country: "CM",
          direction: type === "DEPOSIT" ? 1 : -1,
          customer_data: customerData || null,
          location_data: locationData || null,
          livemode,
          updated_at: now.toISOString(),
        },
        { onConflict: "reference" }
      )
      .select("id")
      .single();

    if (error) {
      console.error(`Supabase ${status} record failed [${trxID}]:`, error.message);
    } else {
      supabaseId = data?.id || null;
      console.log(`Supabase payments/${trxID} saved as ${status} (id=${supabaseId})`);
    }
  }

  // ── Firestore mirror (always runs, even if Supabase failed) ──
  if (db && trxID) {
    try {
      await db
        .collection("payments")
        .doc(trxID)
        .set(
          {
            mesombPk: mesombPk || null,
            finTrxId: finTrxId || null,
            reference: trxID,
            status,
            amount,
            fees: fees ?? null,
            trxamount: trxamount ?? null,
            service,
            bParty: phone,
            type,
            message: message || null,
            currency: "XAF",
            country: "CM",
            direction: type === "DEPOSIT" ? 1 : -1,
            customerData: customerData || null,
            locationData: locationData || null,
            livemode,
            userId: userId || null,
            supabaseId: supabaseId || null,
            source: "mesomb-collect",
            updatedAt: now,
            // Only set createdAt on first write
            ...(status === "PENDING" && { createdAt: now }),
          },
          { merge: true }
        );
      console.log(`Firestore payments/${trxID} saved as ${status}`);
    } catch (err) {
      console.error(`Firestore record failed for ${trxID}:`, err.message);
    }
  }

  return supabaseId;
}

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * Collect money from a customer's mobile money account.
 *
 * Uses ASYNCHRONOUS mode for production — final status arrives via webhook.
 * An initial PENDING (or FAILED) record is written immediately.
 *
 * @param {object} params
 * @param {string}  params.phone     - Phone number in local format e.g. '677000000'
 * @param {number}  params.amount    - Amount in XAF
 * @param {'MTN'|'ORANGE'|'AIRTEL'} params.service
 * @param {string}  params.type      - 'Ride' | 'Food' | 'Parcel' | 'Wallet' | 'Bus' | 'Hotel'
 * @param {string}  params.trxID     - Your internal order/booking ID → becomes `reference` in webhooks
 * @param {object}  [params.customer]
 * @param {object}  [params.location]
 * @param {object[]} [params.products]
 * @param {'synchronous'|'asynchronous'} [params.mode='asynchronous']
 * @param {string}  [params.userId]
 * @param {string}  [params.country='CM']
 * @param {string}  [params.currency='XAF']
 * @returns {Promise<{response, paymentId, opSuccess, txnSuccess, message}>}
 */
export async function collectPayment({
  phone,
  amount,
  service,
  type,
  trxID,
  customer,
  location,
  products,
  mode = "asynchronous",
  userId,
  country = "CM",
  currency = "XAF",
}) {
  const response = await client.makeCollect({
    payer: phone,
    amount,
    service,
    country,
    currency,
    nonce: RandomGenerator.nonce(),
    trxID,
    mode,
    customer: customer || {
      firstName: "EataLyft",
      lastName: type || "Customer",
      email: "support@eatalyft.cm",
    },
    location: location || {
      town: "Bamenda",
      region: "North-West",
      country: "CM",
    },
    products: products || [
      {
        name: `${type || "EataLyft"} Payment`,
        category: type || "Payment",
        quantity: 1,
        amount,
      },
    ],
  });

  const opSuccess  = response.isOperationSuccess();
  const txnSuccess = response.isTransactionSuccess();
  const txn        = response.transaction;
  const status     = opSuccess ? "PENDING" : "FAILED";
  const message    = txn?.message || null;

  console.log(
    `makeCollect trxID=${trxID} opSuccess=${opSuccess} txnSuccess=${txnSuccess} ` +
    `status=${txn?.status || status} message="${message || "none"}"`
  );

  if (!opSuccess) {
    // MeSomb rejected the request synchronously — log clearly and save as FAILED
    console.warn(
      `[COLLECT FAILED] trxID=${trxID} | reason: "${message}" | ` +
      `service=${service} | phone=${phone} | amount=${amount}`
    );
  }

  const paymentId = await savePaymentRecord({
    trxID,
    phone,
    amount,
    service,
    type: "COLLECT",
    status,
    userId,
    mesombPk:  txn?.pk       || null,
    finTrxId:  txn?.fin_trx_id || null,
    message,
    fees:      txn?.fees     ?? null,
    trxamount: txn?.trxamount ?? null,
  });

  return { response, paymentId, opSuccess, txnSuccess, message };
}

/**
 * Deposit (payout) money into a customer's mobile account.
 *
 * @param {object} params
 * @param {string}  params.phone     - Recipient phone number in local format e.g. '677000000'
 * @param {number}  params.amount    - Amount in XAF
 * @param {'MTN'|'ORANGE'|'AIRTEL'} params.service
 * @param {string}  params.trxID     - Your internal payout reference
 * @param {string}  [params.userId]
 * @param {string}  [params.country='CM']
 * @param {string}  [params.currency='XAF']
 * @returns {Promise<{response, paymentId, opSuccess, txnSuccess, message}>}
 */
export async function depositPayment({
  phone,
  amount,
  service,
  trxID,
  userId,
  country = "CM",
  currency = "XAF",
}) {
  const response = await client.makeDeposit({
    receiver: phone,
    amount,
    service,
    country,
    currency,
    nonce: RandomGenerator.nonce(),
    trxID,
  });

  const opSuccess  = response.isOperationSuccess();
  const txnSuccess = response.isTransactionSuccess();
  const txn        = response.transaction;
  const status     = opSuccess ? "PENDING" : "FAILED";
  const message    = txn?.message || null;

  console.log(
    `makeDeposit trxID=${trxID} opSuccess=${opSuccess} txnSuccess=${txnSuccess} ` +
    `status=${txn?.status || status} message="${message || "none"}"`
  );

  if (!opSuccess) {
    console.warn(
      `[DEPOSIT FAILED] trxID=${trxID} | reason: "${message}" | ` +
      `service=${service} | phone=${phone} | amount=${amount}`
    );
  }

  const paymentId = await savePaymentRecord({
    trxID,
    phone,
    amount,
    service,
    type: "DEPOSIT",
    status,
    userId,
    mesombPk:  txn?.pk         || null,
    finTrxId:  txn?.fin_trx_id || null,
    message,
    fees:      txn?.fees       ?? null,
    trxamount: txn?.trxamount  ?? null,
  });

  return { response, paymentId, opSuccess, txnSuccess, message };
}

/**
 * Refund a transaction.
 *
 * @param {string}  transactionId - MeSomb transaction pk (mesomb_pk)
 * @param {number}  [amount]      - Partial refund amount in XAF; omit for full refund
 * @returns {Promise<TransactionResponse>}
 */
export async function refundTransaction(transactionId, amount) {
  const response = await client.refundTransaction(transactionId, {
    ...(amount !== undefined && { amount }),
    nonce: RandomGenerator.nonce(),
  });

  const opSuccess = response.isOperationSuccess();
  const txn       = response.transaction;

  console.log(
    `refund transactionId=${transactionId} opSuccess=${opSuccess} ` +
    `message="${txn?.message || "none"}"`
  );

  return response;
}

/**
 * Get transactions by their MeSomb IDs.
 *
 * @param {string[]} ids
 * @param {'MESOMB'|'EXTERNAL'} [source='MESOMB']
 */
export async function getTransactions(ids, source = "MESOMB") {
  return await client.getTransactions(ids, source);
}

/**
 * Check / validate transactions by their MeSomb IDs.
 *
 * @param {string[]} ids
 * @param {'MESOMB'|'EXTERNAL'} [source='MESOMB']
 */
export async function checkTransactions(ids, source = "MESOMB") {
  return await client.checkTransactions(ids, source);
}

/**
 * Get the current status and balance of your MeSomb application.
 */
export async function getApplicationStatus() {
  return await client.getStatus();
}

/**
 * Update a payment record after a webhook event arrives.
 * Called directly from the webhook handler.
 *
 * @param {object} txn - MeSombTransactionObject from webhook data.object
 * @param {boolean} livemode
 */
export async function updatePaymentFromWebhook(txn, livemode = true) {
  const trxID = txn.reference || txn.name || txn.pk;

  return await savePaymentRecord({
    trxID,
    phone:        txn.b_party      || null,
    amount:       txn.amount,
    service:      txn.service,
    type:         txn.type         || "COLLECT",
    status:       txn.status,                     // SUCCESS | FAILED | REFUNDED
    mesombPk:     txn.pk           || null,
    finTrxId:     txn.fin_trx_id   || null,
    message:      txn.message      || null,
    fees:         txn.fees         ?? null,
    trxamount:    txn.trxamount    ?? null,
    customerData: txn.customer     || null,
    locationData: txn.location     || null,
  });
}