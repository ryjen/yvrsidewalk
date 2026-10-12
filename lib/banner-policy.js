"use strict";

const MAX_QUEUE_ITEMS = 256;
const MAX_BANNER_CHARS = 64;
const MAX_TX_DATA_BYTES = 256;

function decodeBannerMessage(data, toUtf8String) {
  if (typeof data !== "string" || !/^0x(?:[a-fA-F0-9]{2})*$/.test(data) ||
      (data.length - 2) / 2 > MAX_TX_DATA_BYTES) return null;
  let text;
  try { text = toUtf8String(data); } catch (_) { return null; }
  // The matching public UI only permits ASCII letters and spaces.
  // Do not permit form delimiters, control characters or arbitrary HTML.
  if (typeof text !== "string" || text.length > MAX_BANNER_CHARS ||
      !/^[a-zA-Z ]+$/.test(text)) return null;
  return text.trim() || null;
}

function enqueueBanner(queue, transaction, decode, maxItems = MAX_QUEUE_ITEMS) {
  const message = decodeBannerMessage(transaction && transaction.data, decode);
  if (!message || queue.length >= maxItems) return false;
  queue.push(message);
  return true;
}

function validateBannerEndpoint(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); } catch (_) {
    throw new Error("BANNER_ENDPOINT must be an absolute HTTP(S) URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (!(parsed.protocol === "https:" || (loopback && parsed.protocol === "http:")) ||
      parsed.username || parsed.password || parsed.hash) {
    throw new Error("BANNER_ENDPOINT must be HTTPS or a loopback HTTP service");
  }
  return parsed.href;
}

function createBannerDelivery({ endpoint, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  const url = validateBannerEndpoint(endpoint);
  if (typeof fetchImpl !== "function") throw new Error("Node.js 18+ fetch required");
  let sending = false;
  return async (queue) => {
    if (sending || queue.length === 0) return false;
    sending = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const message = queue[0];
      const payload = new URLSearchParams({
        show: "Banner",
        banner: message,
        imgShow: "orangeDot",
      });
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: payload.toString(),
        signal: controller.signal,
      });
      if (!response.ok) return false;
      queue.shift(); // acknowledge only after successful delivery
      return true;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timeout);
      sending = false;
    }
  };
}

module.exports = {
  MAX_QUEUE_ITEMS, decodeBannerMessage, enqueueBanner,
  validateBannerEndpoint, createBannerDelivery,
};
