/**
 * Unit tests for MeSomb webhook signature verification.
 * Run with: node --test src/__tests__/webhook.test.js
 * (Node 20 has a built-in test runner — no extra dependencies needed.)
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyMeSombWebhook } from "../lib/mesombWebhook.js";

const TEST_SECRET = "whsec_test_secret_1234567890abcdef";

/**
 * Build a valid X-MeSomb-Webhook-Signature header for a given body + secret.
 */
function buildSignatureHeader(rawBody, secret, timestampOverride) {
  const ts       = timestampOverride ?? Math.floor(Date.now() / 1000);
  const payload  = `${ts}.${rawBody}`;
  const sig      = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return { header: `t=${ts},v1=${sig}`, ts };
}

// ─── Test Suite ────────────────────────────────────────────────────────────

describe("verifyMeSombWebhook", () => {

  const body = JSON.stringify({ id: "evt_001", event_type: "payment.transaction.success" });

  it("1. Valid signature passes without throwing", () => {
    const { header } = buildSignatureHeader(body, TEST_SECRET);
    assert.doesNotThrow(() =>
      verifyMeSombWebhook({
        rawBody:         body,
        signatureHeader: header,
        webhookSecret:   TEST_SECRET,
      })
    );
  });

  it("2. Mismatched signature throws", () => {
    const { header } = buildSignatureHeader(body, "wrong-secret");
    assert.throws(
      () =>
        verifyMeSombWebhook({
          rawBody:         body,
          signatureHeader: header,
          webhookSecret:   TEST_SECRET,
        }),
      /signature mismatch/i
    );
  });

  it("3. Tampered body throws (signature no longer matches)", () => {
    const { header } = buildSignatureHeader(body, TEST_SECRET);
    const tamperedBody = body + "extra";
    assert.throws(
      () =>
        verifyMeSombWebhook({
          rawBody:         tamperedBody,
          signatureHeader: header,
          webhookSecret:   TEST_SECRET,
        }),
      /signature mismatch/i
    );
  });

  it("4. Timestamp too old (>300s) throws", () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const { header }  = buildSignatureHeader(body, TEST_SECRET, oldTimestamp);
    assert.throws(
      () =>
        verifyMeSombWebhook({
          rawBody:           body,
          signatureHeader:   header,
          webhookSecret:     TEST_SECRET,
          toleranceSeconds:  300,
        }),
      /too old/i
    );
  });

  it("5. Missing signature header throws", () => {
    assert.throws(
      () =>
        verifyMeSombWebhook({
          rawBody:         body,
          signatureHeader: "",
          webhookSecret:   TEST_SECRET,
        }),
      /missing x-mesomb-webhook-signature/i
    );
  });

  it("6. Missing webhook secret throws", () => {
    const { header } = buildSignatureHeader(body, TEST_SECRET);
    assert.throws(
      () =>
        verifyMeSombWebhook({
          rawBody:         body,
          signatureHeader: header,
          webhookSecret:   "",
        }),
      /not configured/i
    );
  });

  it("7. Signature header missing timestamp throws", () => {
    const sig    = crypto.createHmac("sha256", TEST_SECRET).update(body).digest("hex");
    const header = `v1=${sig}`; // no t= prefix
    assert.throws(
      () =>
        verifyMeSombWebhook({ rawBody: body, signatureHeader: header, webhookSecret: TEST_SECRET }),
      /missing timestamp/i
    );
  });

  it("8. Signature header missing v1 value throws", () => {
    const ts     = Math.floor(Date.now() / 1000);
    const header = `t=${ts}`; // no v1=
    assert.throws(
      () =>
        verifyMeSombWebhook({ rawBody: body, signatureHeader: header, webhookSecret: TEST_SECRET }),
      /missing v1 signature/i
    );
  });

  it("9. Buffer rawBody is treated identically to string rawBody", () => {
    const buf    = Buffer.from(body, "utf8");
    const { header } = buildSignatureHeader(body, TEST_SECRET);
    assert.doesNotThrow(() =>
      verifyMeSombWebhook({ rawBody: buf, signatureHeader: header, webhookSecret: TEST_SECRET })
    );
  });

  it("10. Custom tolerance is respected — recent event within tolerance passes", () => {
    const ts     = Math.floor(Date.now() / 1000) - 100; // 100s ago
    const { header } = buildSignatureHeader(body, TEST_SECRET, ts);
    assert.doesNotThrow(() =>
      verifyMeSombWebhook({
        rawBody:          body,
        signatureHeader:  header,
        webhookSecret:    TEST_SECRET,
        toleranceSeconds: 200, // 200s tolerance > 100s age
      })
    );
  });
});
