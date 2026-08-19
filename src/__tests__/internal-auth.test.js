import test from "node:test";
import assert from "node:assert/strict";
import { requireInternalServiceKey } from "../middleware/internalServiceAuth.js";

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function makeRequest(value) {
  return {
    get(name) {
      assert.equal(name, "x-internal-service-key");
      return value;
    },
  };
}

test("rejects payment requests when the internal key is missing from configuration", () => {
  const previous = process.env.EATAPAY_INTERNAL_KEY;
  delete process.env.EATAPAY_INTERNAL_KEY;
  const response = makeResponse();

  requireInternalServiceKey(makeRequest("secret"), response, () => {
    throw new Error("next() must not be called");
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {
    success: false,
    error: "PAYMENT_SERVICE_MISCONFIGURED",
  });
  if (previous === undefined) delete process.env.EATAPAY_INTERNAL_KEY;
  else process.env.EATAPAY_INTERNAL_KEY = previous;
});

test("returns JSON 401 when the internal key header is absent", () => {
  process.env.EATAPAY_INTERNAL_KEY = "a".repeat(64);
  const response = makeResponse();

  requireInternalServiceKey(makeRequest(""), response, () => {
    throw new Error("next() must not be called");
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, {
    success: false,
    error: "INTERNAL_AUTH_REQUIRED",
  });
});

test("returns JSON 403 when the internal key does not match", () => {
  process.env.EATAPAY_INTERNAL_KEY = "a".repeat(64);
  const response = makeResponse();

  requireInternalServiceKey(makeRequest("b".repeat(64)), response, () => {
    throw new Error("next() must not be called");
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, {
    success: false,
    error: "INTERNAL_AUTH_INVALID",
  });
});

test("passes a correctly authenticated payment request to the route", () => {
  process.env.EATAPAY_INTERNAL_KEY = "a".repeat(64);
  const response = makeResponse();
  let called = false;

  requireInternalServiceKey(makeRequest("a".repeat(64)), response, () => {
    called = true;
  });

  assert.equal(called, true);
  assert.equal(response.statusCode, null);
});
