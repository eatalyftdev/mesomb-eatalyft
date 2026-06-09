import { PaymentOperation, RandomGenerator } from "@hachther/mesomb";
import { supabase } from "../config/supabase.js";
import { db } from "../config/firebase.js";

if (!process.env.MESOMB_APPLICATION_KEY || !process.env.MESOMB_ACCESS_KEY || !process.env.MESOMB_SECRET_KEY) {
  console.warn("MeSomb credentials not fully configured. Payment operations will fail.");
}

const client = new PaymentOperation({
  applicationKey: process.env.MESOMB_APPLICATION_KEY,
  accessKey:      process.env.MESOMB_ACCESS_KEY,
  secretKey:      process.env.MESOMB_SECRET_KEY,
});

/**
 * Save an initial PENDING payment record to BOTH Supabase and Firestore.
 *
 * Called immediately after makeCollect / makeDeposit — before the webhook arrives.
 * Firestore write always runs regardless of whether Supabase succeeded.
 *
 * @param {object} params
 * @param {string}  params.trxID     - Internal reference / trxID (reconciliation key)
 * @param {string}  params.phone     - Payer/receiver phone number
 * @param {number}  params.amount    - Amount in XAF
 * @param {string}  params.service   - MTN | ORANGE | AIRTEL
 * @param {string}  params.type      - COLLECT | DEPOSIT
 * @param {string}  [params.userId]  - Your internal user ID
 * @param {string}  [params.mesombPk] - transaction.pk returned synchronously (may be null)
 * @returns {Promise<string|null>} Supabase payments row UUID, or null
 */
async function savePendingPayment({ trxID, phone, amount, service, type, userId, mesombPk }) {
  const livemode  = process.env.MESOMB_LIVEMODE !== "false";
  const now       = new Date();

  // ── Supabase (primary) ──
  let supabaseId = null;

  if (supabase) {
    const { data, error } = await supabase
      .from("payments")
      .upsert(
        {
          mesomb_pk:  mesombPk  || null,
          reference:  trxID,
          status:     "PENDING",
          amount,
          service,
          b_party:    phone,
          type,
          currency:   "XAF",
          country:    "CM",
          direction:  type === "DEPOSIT" ? 1 : -1,
          livemode,
          updated_at: now.toISOString(),
        },
        { onConflict: "reference" }
      )
      .select("id")
      .single();

    if (error) {
      console.error("Supabase PENDING record failed:", error.message);
    } else {
      supabaseId = data?.id || null;
    }
  }

  // ── Firestore mirror (always runs, even if Supabase failed) ──
  if (db && trxID) {
    try {
      await db.collection("payments").doc(trxID).set(
        {
          mesombPk:   mesombPk  || null,
          reference:  trxID,
          status:     "PENDING",
          amount,
          service,
          bParty:     phone,
          type,
          currency:   "XAF",
          country:    "CM",
          direction:  type === "DEPOSIT" ? 1 : -1,
          livemode,
          userId:     userId    || null,
          supabaseId: supabaseId || null,
          source:     "mesomb-collect",
          updatedAt:  now,
          createdAt:  now,
        },
        { merge: true }
      );
      console.log(`Firestore payments/${trxID} initialised as PENDING`);
    } catch (err) {
      console.error(`Firestore PENDING record failed for ${trxID}:`, err.message);
    }
  }

  return supabaseId;
}

/**
 * Collect money from a customer's mobile money account.
 *
 * Uses ASYNCHRONOUS mode for production — final status arrives via webhook.
 * An initial PENDING record is written to both Supabase and Firestore immediately.
 *
 * @param {object} params
 * @param {string}  params.phone     - Phone number to collect from (e.g. '677000000')
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
 * @returns {Promise<{response, paymentId, opSuccess, txnSuccess}>}
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
    payer:    phone,
    amount,
    service,
    country,
    currency,
    nonce:    RandomGenerator.nonce(),
    trxID,
    mode,
    customer: customer || {
      firstName: "EataLyft",
      lastName:  type || "Customer",
      email:     "support@eatalyft.com",
    },
    location: location || {
      town:    "Bamenda",
      region:  "North-West",
      country: "CM",
    },
    products: products || [
      { name: `${type || "EataLyft"} Payment`, category: type || "Payment", quantity: 1, amount },
    ],
  });

  const opSuccess  = response.isOperationSuccess();
  const txnSuccess = response.isTransactionSuccess();

  console.log(`makeCollect trxID=${trxID} opSuccess=${opSuccess} txnSuccess=${txnSuccess} status=${response.transaction?.status}`);

  const mesombPk  = response.transaction?.pk || null;
  const paymentId = await savePendingPayment({ trxID, phone, amount, service, type: "COLLECT", userId, mesombPk });

  return { response, paymentId, opSuccess, txnSuccess };
}

/**
 * Deposit (payout) money into a customer's mobile account.
 *
 * An initial PENDING record is written to both Supabase and Firestore immediately.
 *
 * @param {object} params
 * @param {string}  params.phone    - Recipient phone number
 * @param {number}  params.amount   - Amount in XAF
 * @param {'MTN'|'ORANGE'|'AIRTEL'} params.service
 * @param {string}  params.trxID    - Your internal payout reference
 * @param {string}  [params.userId]
 * @param {string}  [params.country='CM']
 * @param {string}  [params.currency='XAF']
 * @returns {Promise<{response, paymentId, opSuccess, txnSuccess}>}
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

  console.log(`makeDeposit trxID=${trxID} opSuccess=${opSuccess} txnSuccess=${txnSuccess}`);

  const mesombPk  = response.transaction?.pk || null;
  const paymentId = await savePendingPayment({ trxID, phone, amount, service, type: "DEPOSIT", userId, mesombPk });

  return { response, paymentId, opSuccess, txnSuccess };
}

/**
 * Refund a transaction.
 *
 * @param {string}  transactionId - MeSomb transaction pk
 * @param {number}  [amount]      - Partial refund amount; omit for full refund
 * @returns {Promise<TransactionResponse>}
 */
export async function refundTransaction(transactionId, amount) {
  return await client.refundTransaction(transactionId, {
    amount: amount || undefined,
    nonce:  RandomGenerator.nonce(),
  });
}

/**
 * Get transactions by their IDs.
 *
 * @param {string[]} ids
 * @param {'MESOMB'|'EXTERNAL'} [source='MESOMB']
 */
export async function getTransactions(ids, source = "MESOMB") {
  return await client.getTransactions(ids, source);
}

/**
 * Check / validate transactions by their IDs.
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
