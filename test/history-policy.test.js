"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHistoryHandler, sanitizeTransactions } = require("../lib/history-policy");
const addr = "0x" + "a".repeat(40);
const outgoing = "0x" + "b".repeat(40);
const hash = "0x" + "c".repeat(64);
function tx(overrides = {}) {
  return { from: outgoing, to: addr, hash, input: "0x414243", blockNumber: "39100000", ...overrides };
}
function response() {
  return { code: null, value: null,
    status(code) { this.code = code; return this; },
    json(value) { this.value = value; return this; },
  };
}
function success(items) {
  return { ok: true, text: async () => JSON.stringify({ status: "1", message: "OK", result: items }) };
}
test("unconfigured history fails closed without reaching external provider", async () => {
  const handler = createHistoryHandler({ address: addr, apiKey: "", fetchImpl: async () => assert.fail("unexpected") });
  const res = response();
  await handler({}, res);
  assert.equal(res.code, 503);
  assert.deepEqual(res.value, { error: "History unavailable" });
});
test("fixed Polygon chain and bounded query keep API key server side", async () => {
  let request;
  const handler = createHistoryHandler({ address: addr, apiKey: "synthetic-not-real",
    fetchImpl: async (url, init) => { request = {url, init}; return success([tx()]); } });
  const res = response();
  await handler({ query: { address: outgoing, apikey: "attacker" } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.value.result.length, 1);
  assert.equal(JSON.stringify(res.value).includes("synthetic-not-real"), false);
  const url = new URL(request.url);
  assert.equal(url.origin, "https://api.etherscan.io");
  assert.equal(url.pathname, "/v2/api");
  assert.equal(url.searchParams.get("chainid"), "137");
  assert.equal(url.searchParams.get("address"), addr);
  assert.equal(url.searchParams.get("offset"), "50");
  assert.equal(url.searchParams.get("apikey"), "synthetic-not-real");
});
test("malformed or oversized account lists are denied", () => {
  assert.equal(sanitizeTransactions([tx({ hash: "wrong" })], addr), null);
  assert.equal(sanitizeTransactions([tx({ input: "0xGG" })], addr), null);
  assert.equal(sanitizeTransactions([tx({ blockNumber: "-2" })], addr), null);
  assert.equal(sanitizeTransactions(Array.from({length: 51}, () => tx()), addr), null);
  assert.equal(sanitizeTransactions("not a list", addr), null);
});
test("outgoing transactions do not invalidate incoming messages", () => {
  const result = sanitizeTransactions([tx({ to: outgoing, from: addr }), tx()], addr);
  assert.equal(result.length, 1);
  assert.equal(result[0].to, addr);
});
test("provider errors never expose credential or upstream detail", async () => {
  for (const upstream of [
    async () => ({ ok: false, status: 500 }),
    async () => ({ ok: true, text: async () => "{broken" }),
    async () => ({ ok: true, text: async () => JSON.stringify({status:"0",message:"NOTOK",result:"bad"}) }),
    async () => { throw new Error("secret-detail"); },
  ]) {
    const handler = createHistoryHandler({ address:addr, apiKey:"synthetic-secret", fetchImpl:upstream });
    const res = response();
    await handler({}, res);
    assert.equal(res.code, 502);
    assert.deepEqual(res.value, {error:"History provider unavailable"});
  }
});
test("empty history is accepted only with documented no-transactions status", async () => {
  const handler = createHistoryHandler({ address:addr, apiKey:"fake",
    fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({status:"0",message:"No transactions found",result:[]})}) });
  const res=response();
  await handler({},res);
  assert.deepEqual(res.value,{result:[]});
  assert.equal(res.code,200);
});
test("cached history serves repeat requests without a new API call", async () => {
  let calls=0,clock=1000;
  const handler=createHistoryHandler({address:addr,apiKey:"fake",cacheMs:60000,now:()=>clock,
    fetchImpl:async()=>{calls++;return success([tx()]);}});
  await handler({},response());await handler({},response());
  assert.equal(calls,1);
  clock+=60001;
  await handler({},response());
  assert.equal(calls,2);
});
test("concurrent viewers share a single remote refresh", async () => {
  let resolve, count=0;
  const gate=new Promise(r=>{resolve=r;});
  const handler=createHistoryHandler({address:addr,apiKey:"fake",
    fetchImpl:async()=>{count++;await gate;return success([tx()]);}});
  const a=response(),b=response();
  const one=handler({},a),two=handler({},b);
  resolve();
  await Promise.all([one,two]);
  assert.equal(count,1);
  assert.equal(a.code,200);
  assert.equal(b.code,200);
});
test("upstream payloads above configured ceiling are rejected", async () => {
  const handler=createHistoryHandler({address:addr,apiKey:"fake",
    fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({status:"1",result:[]})+"x".repeat(300000)})});
  const res=response();
  await handler({},res);
  assert.equal(res.code,502);
});
test("invalid monitored recipient is rejected at startup", () => {
  assert.throws(()=>createHistoryHandler({address:"INVALID",apiKey:"fake"}));
});

test("provider failures are negatively cached to bound upstream spend", async () => {
  let calls = 0, clock = 1000;
  const handler = createHistoryHandler({ address: addr, apiKey: "fake",
    now: () => clock,
    fetchImpl: async () => { calls++; return { ok: false, status: 429 }; },
  });
  const first = response();
  await handler({}, first);
  assert.equal(first.code, 502);
  const second = response();
  await handler({}, second);
  assert.equal(second.code, 503);
  assert.equal(calls, 1);
  clock += 30001;
  await handler({}, response());
  assert.equal(calls, 2);
});
