import crypto from "node:crypto";

export const SERVICE_KEY_HEADER = "x-service-key";

/**
 * Require the shared service key sent by the EataLyft main app.
 * This is intentionally separate from EATAPAY_INTERNAL_KEY and MeSomb webhook HMAC auth.
 */
export function requireServiceKey(req, res, next) {
  const expected = process.env.MESOMB_SERVICE_KEY || "";
  const received = String(req.get(SERVICE_KEY_HEADER) || "");

  if (!expected) {
    console.error("[ServiceAuth] MESOMB_SERVICE_KEY is not configured; rejecting payment request.");
    return res.status(503).json({
      success: false,
      error: "PAYMENT_SERVICE_MISCONFIGURED",
    });
  }

  if (!received) {
    return res.status(401).json({
      success: false,
      error: "SERVICE_AUTH_REQUIRED",
    });
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  const validLength = expectedBuffer.length === receivedBuffer.length;
  const valid = validLength && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);

  if (!valid) {
    return res.status(403).json({
      success: false,
      error: "SERVICE_AUTH_INVALID",
    });
  }

  return next();
}

export default requireServiceKey;
