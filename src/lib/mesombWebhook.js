/**
 * MeSomb Webhook Signature Verification
 *
 * Implements HMAC-SHA256 verification per the MeSomb docs (2026-05-01).
 * The signature header format is: "t=<unix_timestamp>,v1=<hex_signature>"
 *
 * IMPORTANT:
 * - Always use crypto.timingSafeEqual — NEVER use === string comparison (timing attack risk).
 * - Always use the raw request body buffer, not re-serialised JSON.
 * - Default tolerance is 300 seconds (5 minutes) to guard against replay attacks.
 */

import crypto from "crypto";

/**
 * Verify an incoming MeSomb webhook signature.
 *
 * @param {object} opts
 * @param {string|Buffer} opts.rawBody    - Raw request body exactly as received
 * @param {string}        opts.signatureHeader - Value of X-MeSomb-Webhook-Signature header
 * @param {string}        opts.webhookSecret   - Your MESOMB_WEBHOOK_SECRET (whsec_...)
 * @param {number}        [opts.toleranceSeconds=300] - Max age in seconds before rejecting
 * @throws {Error} descriptive error on any verification failure
 */
export function verifyMeSombWebhook({ rawBody, signatureHeader, webhookSecret, toleranceSeconds = 300 }) {
  if (!signatureHeader) {
    throw new Error("Missing X-MeSomb-Webhook-Signature header");
  }

  if (!webhookSecret) {
    throw new Error("MESOMB_WEBHOOK_SECRET is not configured");
  }

  // Parse "t=<ts>,v1=<sig>" — MeSomb may include multiple v1 entries
  const parts = signatureHeader.split(",");
  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t") {
      timestamp = value;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }

  if (timestamp === null) {
    throw new Error("Webhook signature header missing timestamp (t=...)");
  }

  if (signatures.length === 0) {
    throw new Error("Webhook signature header missing v1 signature");
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new Error("Webhook signature timestamp is not a valid number");
  }

  // Replay-attack protection: reject events older than toleranceSeconds
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) {
    throw new Error(
      `Webhook timestamp too old — received ${ts}, now ${nowSeconds}, tolerance ${toleranceSeconds}s`
    );
  }

  // Build the signed payload: "<timestamp>.<rawBody>"
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const signedPayload = `${timestamp}.${bodyStr}`;

  // Compute expected HMAC-SHA256 signature
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(signedPayload, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");

  // Compare each signature using timing-safe comparison
  const isValid = signatures.some((sig) => {
    try {
      const sigBuf = Buffer.from(sig, "hex");
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  });

  if (!isValid) {
    throw new Error("Webhook signature verification failed — signature mismatch");
  }
}

/**
 * All known MeSomb event types.
 * @readonly
 */
export const MeSombEventTypes = /** @type {const} */ ({
  // Direct payment transaction events
  PAYMENT_SUCCESS: "payment.transaction.success",
  PAYMENT_FAILED:  "payment.transaction.failed",
  // Checkout session events
  CHECKOUT_CREATED:   "checkout.session.created",
  CHECKOUT_COMPLETED: "checkout.session.completed",
  CHECKOUT_EXPIRED:   "checkout.session.expired",
  CHECKOUT_CANCELED:  "checkout.session.canceled",
  // SecurePay escrow events
  SECUREPAY_CREATED:             "securepay.transaction.created",
  SECUREPAY_CANCELLED:           "securepay.transaction.cancelled",
  SECUREPAY_EXPIRED:             "securepay.transaction.expired",
  SECUREPAY_FUNDED:              "securepay.transaction.funded",
  SECUREPAY_AWAITING_RELEASE:    "securepay.transaction.awaiting_release",
  SECUREPAY_RELEASED:            "securepay.transaction.released",
  SECUREPAY_REFUNDED:            "securepay.transaction.refunded",
  SECUREPAY_DISPUTED:            "securepay.transaction.disputed",
  SECUREPAY_FULFILLMENT_UPDATED: "securepay.transaction.fulfillment_updated",
  // Dispute events
  DISPUTE_EVIDENCE_ADDED: "securepay.dispute.evidence_added",
  DISPUTE_MESSAGE_ADDED:  "securepay.dispute.message_added",
  DISPUTE_UNDER_REVIEW:   "securepay.dispute.under_review",
  DISPUTE_RESOLVED:       "securepay.dispute.resolved",
});

/**
 * Determine which order table and prefix corresponds to a trxID reference.
 * Prefix pattern: "EATALYFT-RIDE-...", "EATALYFT-FOOD-...", etc.
 *
 * @param {string|null} reference - The trxID / reference from the webhook
 * @returns {{ table: string, label: string }|null}
 */
export function resolveOrderTable(reference) {
  if (!reference) return null;
  const upper = reference.toUpperCase();
  if (upper.includes("-RIDE-") || upper.startsWith("RIDE-"))    return { table: "rides",          label: "ride" };
  if (upper.includes("-FOOD-") || upper.startsWith("FOOD-"))    return { table: "orders",         label: "food" };
  if (upper.includes("-PARCEL-") || upper.startsWith("PARCEL-")) return { table: "parcel_orders", label: "parcel" };
  if (upper.includes("-BUS-") || upper.startsWith("BUS-"))      return { table: "bus_bookings",   label: "bus" };
  if (upper.includes("-HOTEL-") || upper.startsWith("HOTEL-"))  return { table: "hotel_bookings", label: "hotel" };
  if (upper.includes("-WALLET-") || upper.startsWith("WALLET-")) return null; // wallet top-ups handled separately
  if (upper.includes("-DEPOSIT-"))                              return null; // outbound payout
  return null;
}
