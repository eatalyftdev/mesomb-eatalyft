import { PaymentOperation, RandomGenerator } from "@hachther/mesomb";

if (!process.env.MESOMB_APPLICATION_KEY || !process.env.MESOMB_ACCESS_KEY || !process.env.MESOMB_SECRET_KEY) {
  console.warn("MeSomb credentials not fully configured. Payment operations will fail.");
}

const client = new PaymentOperation({
  applicationKey: process.env.MESOMB_APPLICATION_KEY,
  accessKey: process.env.MESOMB_ACCESS_KEY,
  secretKey: process.env.MESOMB_SECRET_KEY,
});

/**
 * Collect money from a customer mobile account.
 *
 * @param {object} params
 * @param {string} params.phone - Phone number to collect from (e.g. '677000000')
 * @param {number} params.amount - Amount in XAF
 * @param {'MTN'|'ORANGE'|'AIRTEL'} params.service - Mobile money service
 * @param {string} [params.trxID] - Your internal transaction ID for reconciliation
 * @param {object} [params.customer] - Customer info { firstName, lastName, email, town, region, country, address }
 * @param {object} [params.location] - Location info { town, region, country }
 * @param {object[]} [params.products] - Products list [{ name, category, quantity, amount }]
 * @param {'synchronous'|'asynchronous'} [params.mode='synchronous'] - Processing mode
 * @param {string} [params.country='CM'] - Country code
 * @param {string} [params.currency='XAF'] - Currency code
 * @returns {Promise<TransactionResponse>}
 */
export async function collectPayment({
  phone,
  amount,
  service,
  trxID,
  customer,
  location,
  products,
  mode = "synchronous",
  country = "CM",
  currency = "XAF",
}) {
  return await client.makeCollect({
    payer: phone,
    amount,
    service,
    country,
    currency,
    nonce: RandomGenerator.nonce(),
    trxID: trxID || undefined,
    mode,
    customer: customer || undefined,
    location: location || undefined,
    products: products || undefined,
  });
}

/**
 * Deposit money into a customer mobile account (payout/disbursement).
 *
 * @param {object} params
 * @param {string} params.phone - Phone number to deposit to
 * @param {number} params.amount - Amount in XAF
 * @param {'MTN'|'ORANGE'|'AIRTEL'} params.service - Mobile money service
 * @param {string} [params.trxID] - Your internal transaction ID
 * @param {string} [params.country='CM'] - Country code
 * @param {string} [params.currency='XAF'] - Currency code
 * @returns {Promise<TransactionResponse>}
 */
export async function depositPayment({
  phone,
  amount,
  service,
  trxID,
  country = "CM",
  currency = "XAF",
}) {
  return await client.makeDeposit({
    receiver: phone,
    amount,
    service,
    country,
    currency,
    nonce: RandomGenerator.nonce(),
    trxID: trxID || undefined,
  });
}

/**
 * Refund a transaction by its MeSomb transaction ID.
 *
 * @param {string} transactionId - The MeSomb transaction ID to refund
 * @param {number} [amount] - Partial refund amount (omit for full refund)
 * @returns {Promise<TransactionResponse>}
 */
export async function refundTransaction(transactionId, amount) {
  return await client.refundTransaction(transactionId, {
    amount: amount || undefined,
    nonce: RandomGenerator.nonce(),
  });
}

/**
 * Get one or more transactions by their IDs.
 *
 * @param {string[]} ids - Array of transaction IDs
 * @param {'MESOMB'|'EXTERNAL'} [source='MESOMB'] - ID source: 'MESOMB' or 'EXTERNAL' (your system's IDs)
 * @returns {Promise<Transaction[]>}
 */
export async function getTransactions(ids, source = "MESOMB") {
  return await client.getTransactions(ids, source);
}

/**
 * Check/validate transactions by their IDs.
 *
 * @param {string[]} ids - Array of transaction IDs
 * @param {'MESOMB'|'EXTERNAL'} [source='MESOMB'] - ID source
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
