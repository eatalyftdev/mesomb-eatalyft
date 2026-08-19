import crypto from "node:crypto";

const INTERNAL_KEY_HEADER = "x-internal-service-key";

/**
 * Require the shared secret used only for main-app → EataPay calls.
 * MeSomb webhook authentication is intentionally separate and does not use this middleware.
 */
export function requireInternalServiceKey(req, res, next) {
  const expected = process.env.EATAPAY_INTERNAL_KEY || "";
  const received = String(req.get(INTERNAL_KEY_HEADER) || "");

  if (!expected) {
    console.error("[InternalAuth] EATAPAY_INTERNAL_KEY is not configured; rejecting payment request.");
    return res.status(503).json({
      success: false,
      error: "PAYMENT_SERVICE_MISCONFIGURED",
    });
  }

  if (!received) {
    return res.status(401).json({
      success: false,
      error: "INTERNAL_AUTH_REQUIRED",
    });
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  const validLength = expectedBuffer.length === receivedBuffer.length;
  const valid = validLength && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);

  if (!valid) {
    return res.status(403).json({
      success: false,
      error: "INTERNAL_AUTH_INVALID",
    });
  }

  return next();
}

export const INTERNAL_SERVICE_KEY_HEADER = "X-Internal-Service-Key";
