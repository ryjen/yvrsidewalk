"use strict";

// Polygon history is served from the backend. Never expose the Etherscan API
// key in the browser bundle, frontend URLs, or outgoing responses.
const EXPLORER = "https://api.etherscan.io/v2/api";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX_INPUT = /^0x(?:[0-9a-fA-F]{2})*$/;
const MAX_TX = 50;
const MAX_RESPONSE_BYTES = 256 * 1024;

function sanitizeTransactions(value, address) {
  if (!Array.isArray(value) || value.length > MAX_TX) return null;
  const result = [];
  for (const tx of value) {
    if (!tx || typeof tx !== "object" ||
        !ADDRESS.test(tx.from) || !ADDRESS.test(tx.to) ||
        tx.to.toLowerCase() !== address.toLowerCase() ||
        !TX_HASH.test(tx.hash) || typeof tx.input !== "string" ||
        tx.input.length > 4098 || !HEX_INPUT.test(tx.input) ||
        typeof tx.blockNumber !== "string" ||
        !/^[0-9]{1,12}$/.test(tx.blockNumber)) {
      return null;
    }
    result.push({
      from: tx.from,
      to: tx.to,
      hash: tx.hash,
      input: tx.input,
      blockNumber: tx.blockNumber,
    });
  }
  return result;
}

function createHistoryHandler({
  address,
  apiKey,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 8000,
  cacheMs = 60000,
}) {
  if (!ADDRESS.test(address)) throw new Error("MULTISIG_ADDRESS must be an address");
  if (typeof fetchImpl !== "function") throw new Error("Node.js 18+ fetch required");
  let cache = null;
  let expires = 0;
  let pending = null;

  async function refresh() {
    const query = new URLSearchParams({
      chainid: "137",
      module: "account",
      action: "txlist",
      address,
      startblock: "39079318",
      endblock: "99999999",
      page: "1",
      offset: String(MAX_TX),
      sort: "desc",
      apikey: apiKey,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchImpl(EXPLORER + "?" + query, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!upstream.ok) throw new Error("upstream HTTP failure");
      const body = await upstream.text();
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error("oversize upstream response");
      }
      const envelope = JSON.parse(body);
      const empty = envelope.status === "0" &&
        typeof envelope.message === "string" &&
        /no transactions found/i.test(envelope.message) &&
        Array.isArray(envelope.result) && envelope.result.length === 0;
      if (envelope.status !== "1" && !empty) {
        throw new Error("upstream returned non-success status");
      }
      const txs = sanitizeTransactions(envelope.result, address);
      if (!txs) throw new Error("invalid upstream transactions");
      cache = txs;
      expires = now() + cacheMs;
      return txs;
    } finally {
      clearTimeout(timeout);
    }
  }

  return async (_req, res) => {
    if (!apiKey) return res.status(503).json({ error: "History unavailable" });
    try {
      if (cache !== null && now() < expires) {
        return res.status(200).json({ result: cache });
      }
      // Deduplicate simultaneous callers so each refresh makes one API call.
      if (!pending) {
        pending = refresh().finally(() => { pending = null; });
      }
      const result = await pending;
      return res.status(200).json({ result });
    } catch (_) {
      // Suppress provider error details, including URLs bearing the API key.
      return res.status(502).json({ error: "History provider unavailable" });
    }
  };
}

module.exports = { sanitizeTransactions, createHistoryHandler };
