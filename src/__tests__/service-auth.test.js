import test from "node:test";
import assert from "node:assert/strict";
import { requireServiceKey } from "../middleware/serviceKeyAuth.js";

function makeRequest(value) {
  return {
    get(name) {
      assert.equal(name, "x-service-key");
      return value;
    },
  };
}

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

test("rejects service requests when MESOMB_SERVICE_KEY is missing from configuration", () => {
  const previous = process.env.MESOMB_SERVICE_KEY;
  delete process.env.MESOMB_SERVICE_KEY;
  const response = makeResponse();
  let nextCalled = false;

  requireServiceKey(makeRequest("secret"), response, () => {
    nextCalled = true;
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, "PAYMENT_SERVICE_MISCONFIGURED");
  assert.equal(nextCalled, false);
  if (previous === undefined) delete process.env.MESOMB_SERVICE_KEY;
  else process.env.MESOMB_SERVICE_KEY = previous;
});

test("returns JSON 401 when the service key header is absent", () => {
  process.env.MESOMB_SERVICE_KEY = "a".repeat(64);
  const response = makeResponse();

  requireServiceKey(makeRequest(""), response, () => {
    throw new Error("next() must not run");
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, "SERVICE_AUTH_REQUIRED");
});

test("returns JSON 403 when the service key does not match", () => {
  process.env.MESOMB_SERVICE_KEY = "a".repeat(64);
  const response = makeResponse();

  requireServiceKey(makeRequest("b".repeat(64)), response, () => {
    throw new Error("next() must not run");
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "SERVICE_AUTH_INVALID");
});

test("allows a matching service key", () => {
  process.env.MESOMB_SERVICE_KEY = "a".repeat(64);
  const response = makeResponse();
  let nextCalled = false;

  requireServiceKey(makeRequest("a".repeat(64)), response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(response.statusCode, null);
});
