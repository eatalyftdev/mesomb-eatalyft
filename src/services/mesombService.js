import { PaymentOperation, RandomGenerator } from "@hachther/mesomb";
import { supabase } from "../config/supabase.js";

if (!process.env.MESOMB_APPLICATION_KEY || !process.env.MESOMB_ACCESS_KEY || !process.env.MESOMB_SECRET_KEY) {
  console.warn("MeSomb credentials not fully configured. Payment operations will fail.");
}

const client = new PaymentOperation({
  applicationKey: process.env.MESOMB_APPLICATION_KEY,
  accessKey:      process.env.MESOMB_ACCESS_KEY,
  secretKey:      process.env.MESOMB_SECRET_KEY,
});

/**
 * Save an initial PENDING payment record to Supabase immediately after
 * calling makeCollect/makeDeposit — before the webhook arrives.
 *
 * @param {object} params
 * @param {string}  params.trxID     - Your internal reference / trxID
 * @param {string}  params.phone     - Payer/receiver phone
 * @param {number}  params.amount    - Amount in XAF
 * @param {string}  params.service   - MTN | ORANGE | AIRTEL
 * @param {string}  params.type      - COLLECT | DEPOSIT
 * @param {string}  [params.userId]  - Your user ID
 * @param {string}  [params.mesombPk] - transaction.pk if returned synchronously
 */
async function savePendingPayment({ trxID, phone, amount, service, type, userId, mesombPk }) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("payments")
    .upsert(
      {
        mesomb_pk:  mesombPk || null,
        reference:  trxID,
        status:     "PENDING",
        amount,
        service,
        b_party:    phone,
        type,
        currency:   "XAF",
        country:    "CM",
        direction:  type === "DEPOSIT" ? 1 : -1,
        livemode:   process.env.MESOMB_LIVEMODE !== "false",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "reference" }
    )
    .select("id")
    .single();

  if (error) console.error("Failed to save PENDING payment record:", error.message);
  return data?.id || null;
}

/**
 * Collect money from a customer's mobile money account.
 *
 * Uses ASYNCHRONOUS mode for production — the operator response comes via webhook.
 * An initial PENDING record is saved to Supabase immediately.
 *
 * @param {object} params
 * @param {string}  params.phone     - Phone number to collect from (e.g. '677000000')
 * @param {number}  params.amount    - Amount in XAF
 * @param {'MTN'|'ORANGE'|'AIRTEL'} params.service
 * @param {string}  params.type      - Payment label: 'Ride' | 'Food' | 'Parcel' | 'Wallet'
 * @param {string}  params.trxID     - Your internal order/booking ID (becomes `reference` in webhooks)
 * @param {object}  [params.customer]  - { firstName, lastName, email, town, region, country }
 * @param {object}  [params.location]  - { town, region, country }
 * @param {object[]} [params.products] - [{ name, category, quantity, amount }]
 * @param {'synchronous'|'asynchronous'} [params.mode='asynchronous']
 * @param {string}  [params.userId]   - Your user ID (stored in Supabase)
 * @param {string}  [params.country='CM']
 * @param {string}  [params.currency='XAF']
 * @returns {Promise<{response, paymentId}>}
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
      {
        name:     `${type || "EataLyft"} Payment`,
        category: type  || "Payment",
        quantity: 1,
        amount,
      },
    ],
  });

  const opSuccess  = response.isOperationSuccess();
  const txnSuccess = response.isTransactionSuccess();

  console.log(`makeCollect trxID=${trxID} opSuccess=${opSuccess} txnSuccess=${txnSuccess} status=${response.transaction?.status}`);

  // Save PENDING record immediately — webhook will update to SUCCESS/FAILED
  const mesombPk = response.transaction?.pk || null;
  const paymentId = await savePendingPayment({ trxID, phone, amount, service, type: "COLLECT", userId, mesombPk });

  return { response, paymentId, opSuccess, txnSuccess };
}

/**
 * Deposit (payout) money into a customer's mobile account.
 *
 * @param {object} params
 * @param {string}  params.phone    - Recipient phone number
 * @param {number}  params.amount   - Amount in XAF
 * @param {'MTN'|'ORANGE'|'AIRTEL'} params.service
 * @param {string}  params.trxID    - Your internal ID
 * @param {string}  [params.userId]
 * @param {string}  [params.country='CM']
 * @param {string}  [params.currency='XAF']
 * @returns {Promise<{response, paymentId}>}
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
 * @returns {Promise<Transaction[]>}
 */
export async function getTransactions(ids, source = "MESOMB") {
  return await client.getTransactions(ids, source);
}

/**
 * Check / validate transactions by their IDs.
 *
 * @param {string[]} ids
 * @param {'MESOMB'|'EXTERNAL'} [source='MESOMB']
 * @returns {Promise<Transaction[]>}
 */
export async function checkTransactions(ids, source = "MESOMB") {
  return await client.checkTransactions(ids, source);
}

/**
 * Get the current status and balance of your MeSomb application.
 *
 * @returns {Promise<Application>}
 */
export async function getApplicationStatus() {
  return await client.getStatus();
}
