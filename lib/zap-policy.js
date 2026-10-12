"use strict";

const DEFAULT_MAX_SATS = 100000;
const DEFAULT_LIMIT = 8;
const WINDOW_MS = 60 * 1000;
const MAX_CLIENTS = 2048;

function readPositiveInteger(name, raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(String(raw))) {
    throw new Error(name + " must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(name + " exceeds the supported range");
  }
  return value;
}

function validateInvoice(body, maxSats = DEFAULT_MAX_SATS) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  // The original browser client serialized input[type=number].value as a string.
  // Accept only canonical decimal digits for backward compatibility.
  const amount = typeof body.amount === "string"
    ? (/^[1-9][0-9]*$/.test(body.amount) ? Number(body.amount) : NaN)
    : body.amount;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > maxSats) {
    return null;
  }
  const memo = body.memo === undefined ? "" : body.memo;
  if (typeof memo !== "string" || Buffer.byteLength(memo, "utf8") > 200 || /[\u0000-\u001F\u007F]/.test(memo)) {
    return null;
  }
  return { out: false, amount, memo };
}

function createInvoiceLimiter(options = {}) {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const windowMs = options.windowMs ?? WINDOW_MS;
  const maxClients = options.maxClients ?? MAX_CLIENTS;
  const globalLimit = options.globalLimit ?? 120;
  const now = options.now ?? Date.now;
  let global = { count: 0, resetAt: 0 };
  const clients = new Map();
  return (req, res, next) => {
    const time = now();
    if (time >= global.resetAt) global = { count: 0, resetAt: time + windowMs };
    global.count += 1;
    if (global.count > globalLimit) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((global.resetAt - time) / 1000))));
      return res.status(429).json({ error: "Invoice service rate limit reached" });
    }
    // Express trust proxy is not enabled. Ignore user-supplied X-Forwarded-For.
    const client = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    let entry = clients.get(client);
    if (!entry || time >= entry.resetAt) {
      if (!entry && clients.size >= maxClients) {
        for (const [key, value] of clients) {
          if (time >= value.resetAt) clients.delete(key);
        }
        if (clients.size >= maxClients) {
          return res.status(503).json({ error: "Invoice service busy" });
        }
      }
      entry = { count: 0, resetAt: time + windowMs };
      clients.set(client, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - time) / 1000))));
      return res.status(429).json({ error: "Too many invoice requests" });
    }
    return next();
  };
}

function createInvoiceHandler({ domain, apiKey, maxSats = DEFAULT_MAX_SATS, fetchImpl = globalThis.fetch, timeoutMs = 10000, maxConcurrent = 4 }) {
  // Configuration must be a hostname, never an arbitrary URL or credentials.
  if (!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(domain) || domain.includes("..")) {
    throw new Error("LNBITS_DOMAIN must be a hostname");
  }
  if (!apiKey) throw new Error("LNBITS_API_KEY must be configured");
  if (typeof fetchImpl !== "function") throw new Error("Node.js 18+ fetch is required");
  const url = "https://" + domain + "/api/v1/payments";
  let inFlight = 0;

  return async (req, res) => {
    const request = validateInvoice(req.body, maxSats);
    if (!request) {
      return res.status(400).json({ error: "Invalid invoice amount or memo" });
    }
    if (inFlight >= maxConcurrent) {
      return res.status(503).json({ error: "Invoice service busy" });
    }
    inFlight += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        return res.status(502).json({ error: "Invoice provider unavailable" });
      }
      const result = await upstream.json();
      if (!result || typeof result.payment_hash !== "string" ||
          !/^[a-fA-F0-9]{64}$/.test(result.payment_hash)) {
        return res.status(502).json({ error: "Invalid invoice provider response" });
      }
      // Never forward upstream metadata or credentials to the caller.
      return res.status(201).json({ payment_hash: result.payment_hash });
    } catch (_) {
      return res.status(502).json({ error: "Invoice provider unavailable" });
    } finally {
      clearTimeout(timeout);
      inFlight -= 1;
    }
  };
}

module.exports = { readPositiveInteger, validateInvoice, createInvoiceLimiter, createInvoiceHandler };
