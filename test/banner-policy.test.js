"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decodeBannerMessage, enqueueBanner, validateBannerEndpoint, createBannerDelivery,
} = require("../lib/banner-policy");

const toHex = (text) => "0x" + Buffer.from(text, "utf8").toString("hex");
const decode = (hex) => Buffer.from(hex.slice(2), "hex").toString("utf8");

test("matches public client's ASCII-only message constraints", () => {
  assert.equal(decodeBannerMessage(toHex("Hello World"), decode), "Hello World");
  assert.equal(decodeBannerMessage(toHex("  Hello  "), decode), "Hello");
  for (const value of ["", " ", "X".repeat(65), "hello&admin=true", "hello=world",
                        "<script>", "123", "a\nb", "🙂"]) {
    assert.equal(decodeBannerMessage(toHex(value), decode), null);
  }
});
test("rejects malformed, unbounded and invalid UTF-8 transaction data", () => {
  for (const hex of ["", "abcdef", "0x0", "0xGG", toHex("x".repeat(257))]) {
    assert.equal(decodeBannerMessage(hex, decode), null);
  }
  assert.equal(decodeBannerMessage("0xff", () => { throw Error("invalid UTF8"); }), null);
});
test("queue capacity never grows unbounded", () => {
  const queue = [];
  assert.equal(enqueueBanner(queue, { data: toHex("one") }, decode, 1), true);
  assert.equal(enqueueBanner(queue, { data: toHex("two") }, decode, 1), false);
  assert.deepEqual(queue, ["one"]);
});
test("banner delivery sends encoded form without permitting field injection", async () => {
  let sent;
  const send = createBannerDelivery({ endpoint: "http://127.0.0.1:3456/startshow",
    fetchImpl: async (url, options) => {
      sent = {url, options};
      return { ok: true };
    },
  });
  const queue = ["Hello World"];
  assert.equal(await send(queue), true);
  assert.deepEqual(queue, []);
  assert.equal(sent.url, "http://127.0.0.1:3456/startshow");
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(sent.options.body)),
    { show: "Banner", banner: "Hello World", imgShow: "orangeDot" },
  );
  assert.ok(sent.options.signal);
});
test("failed or thrown delivery leaves head message for retry", async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 500 }),
    async () => { throw Error("provider unavailable"); },
  ]) {
    const send = createBannerDelivery({endpoint: "https://example.org/banner", fetchImpl});
    const queue = ["Keep me"];
    assert.equal(await send(queue), false);
    assert.deepEqual(queue, ["Keep me"]);
  }
});
test("concurrent delivery cannot send or dequeue same message twice", async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const send = createBannerDelivery({ endpoint: "https://example.org/banner",
    fetchImpl: async () => { calls++; await gate; return { ok: true }; },
  });
  const queue = ["one", "two"];
  const first = send(queue);
  assert.equal(await send(queue), false);
  release();
  assert.equal(await first, true);
  assert.deepEqual(queue, ["two"]);
  assert.equal(calls, 1);
});
test("banner endpoint rejects external plaintext and embedded credentials", () => {
  for (const value of ["http://example.org/", "file:///etc/passwd", "ftp://localhost/",
                       "https://a:b@x.test/", "http://localhost/#fragment", "not-url"]) {
    assert.throws(() => validateBannerEndpoint(value));
  }
  assert.equal(validateBannerEndpoint("https://example.org/banner"), "https://example.org/banner");
  assert.equal(validateBannerEndpoint("http://localhost:3456/startshow"), "http://localhost:3456/startshow");
});
