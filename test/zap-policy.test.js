"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  readPositiveInteger, validateInvoice, createInvoiceLimiter, createInvoiceHandler,
} = require("../lib/zap-policy");

function response() {
  return {
    code: 200, data: undefined, headers: {},
    status(value) { this.code = value; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(value) { this.data = value; return this; },
  };
}

test("requires positive safe integer configuration", () => {
  assert.equal(readPositiveInteger("LIMIT", undefined, 8), 8);
  assert.equal(readPositiveInteger("LIMIT", "12", 8), 12);
  for (const bad of ["0", "-1", "1.5", "oops", "9007199254740993"]) {
    assert.throws(() => readPositiveInteger("LIMIT", bad, 8));
  }
});
test("integer satoshis and legacy browser digit strings work", () => {
  assert.deepEqual(validateInvoice({ amount: "100", memo: "hello" }), {
    out: false, amount: 100, memo: "hello",
  });
  assert.deepEqual(validateInvoice({ amount: 1 }), { out: false, amount: 1, memo: "" });
});
test("rejects invalid amounts and malformed bodies", () => {
  for (const value of [0, -1, 1.5, "0", "01", "1.5", "1e3", "Infinity", 100001, 1e20, {}, null, true]) {
    assert.equal(validateInvoice({ amount: value }), null);
  }
  assert.equal(validateInvoice(null), null);
  assert.equal(validateInvoice([]), null);
});
test("memo bound includes byte length and control characters", () => {
  for (const value of [123, [], "x".repeat(201), "a\nb", "a\u0000b", "🙂".repeat(51)]) {
    assert.equal(validateInvoice({ amount: 1, memo: value }), null);
  }
  assert.notEqual(validateInvoice({ amount: 1, memo: "🙂".repeat(50) }), null);
});
test("rate limits by observed peer, not forged forwarding", () => {
  let now = 1000;
  const limit = createInvoiceLimiter({ limit: 2, windowMs: 60000, now: () => now });
  const req = { ip: "192.0.2.1", headers: { "x-forwarded-for": "203.0.113.40" } };
  let count = 0;
  for (let i = 0; i < 3; i++) {
    const res = response();
    limit(req, res, () => count++);
    if (i === 2) {
      assert.equal(res.code, 429);
      assert.equal(res.headers["Retry-After"], "60");
    }
  }
  assert.equal(count, 2);
  now += 60000;
  limit(req, response(), () => count++);
  assert.equal(count, 3);
});
test("global cap closes distributed peer bypass", () => {
  const limit = createInvoiceLimiter({ limit: 10, globalLimit: 2 });
  let allowed = 0;
  for (const ip of ["a", "b", "c"]) {
    const res = response();
    limit({ ip }, res, () => allowed++);
    if (ip === "c") assert.equal(res.code, 429);
  }
  assert.equal(allowed, 2);
});
test("bounded map fails closed when full", () => {
  const limit = createInvoiceLimiter({ maxClients: 1 });
  limit({ ip: "a" }, response(), () => {});
  const res = response();
  limit({ ip: "b" }, res, () => assert.fail("unbounded client admitted"));
  assert.equal(res.code, 503);
});
test("invoice-only upstream operation and minimal output", async () => {
  let sent;
  const handler = createInvoiceHandler({
    domain: "example.test", apiKey: "synthetic",
    fetchImpl: async (url, options) => {
      sent = { url, options };
      return { ok: true, json: async () => ({ payment_hash: "a".repeat(64), secret: "never forward" }) };
    },
  });
  const res = response();
  await handler({ body: { amount: "2", memo: "note" } }, res);
  assert.equal(res.code, 201);
  assert.deepEqual(res.data, { payment_hash: "a".repeat(64) });
  assert.equal(sent.url, "https://example.test/api/v1/payments");
  assert.equal(sent.options.headers["X-Api-Key"], "synthetic");
  assert.deepEqual(JSON.parse(sent.options.body), { out: false, amount: 2, memo: "note" });
});
test("bad input does not reach upstream", async () => {
  const handler = createInvoiceHandler({
    domain: "example.test", apiKey: "synthetic",
    fetchImpl: async () => assert.fail("unexpected upstream request"),
  });
  const res = response();
  await handler({ body: { amount: -5 } }, res);
  assert.equal(res.code, 400);
});
test("provider errors are sanitized", async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 401 }),
    async () => ({ ok: true, json: async () => ({ payment_hash: "bad" }) }),
    async () => { throw new Error("sensitive upstream metadata"); },
  ]) {
    const handler = createInvoiceHandler({ domain: "example.test", apiKey: "synthetic", fetchImpl });
    const res = response();
    await handler({ body: { amount: 2 } }, res);
    assert.equal(res.code, 502);
    assert.ok(!JSON.stringify(res.data).includes("sensitive"));
  }
});
test("stalled requests count against concurrency ceiling", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const handler = createInvoiceHandler({
    domain: "example.test", apiKey: "synthetic", maxConcurrent: 1,
    fetchImpl: async () => {
      await blocked;
      return { ok: true, json: async () => ({ payment_hash: "f".repeat(64) }) };
    },
  });
  const first = response();
  const awaiting = handler({ body: { amount: 1 } }, first);
  const second = response();
  await handler({ body: { amount: 1 } }, second);
  assert.equal(second.code, 503);
  release();
  await awaiting;
  assert.equal(first.code, 201);
});
test("misconfigured provider cannot redirect key to arbitrary URL", () => {
  for (const domain of ["https://example.org", "example.org/path", "a@b", "a..b", "a:8000"]) {
    assert.throws(() => createInvoiceHandler({ domain, apiKey: "synthetic" }));
  }
});
