require("dotenv").config();
const cors = require("cors");
const ethers = require("ethers");
const asyncHandler = require("express-async-handler");
const express = require("express");
const morgan = require("morgan");
const { readPositiveInteger, createInvoiceLimiter, createInvoiceHandler } = require("./lib/zap-policy");
const { createHistoryHandler } = require("./lib/history-policy");
const { MAX_QUEUE_ITEMS, enqueueBanner, createBannerDelivery } = require("./lib/banner-policy");
const fs = require("fs");
const https = require("https");

// **** Block listener ****

const ENV_VARS = [
  "RPC_URL",
  "MULTISIG_ADDRESS",
  "LNBITS_DOMAIN",
  "LNBITS_API_KEY",
  "BANNER_ENDPOINT",
  "TLS_KEY_PATH",
  "TLS_CERT_PATH",
];
for (let i = 0; i < ENV_VARS.length; i++) {
  const envVar = ENV_VARS[i];
  if (!process.env[envVar]) {
    console.error(`Missing ${envVar} environment variable`);
    process.exit(1);
  }
}
const RPC_URL = process.env.RPC_URL;
const MULTISIG_ADDRESS = process.env.MULTISIG_ADDRESS.toLowerCase();
const LNBITS_DOMAIN = process.env.LNBITS_DOMAIN;
const LNBITS_API_KEY = process.env.LNBITS_API_KEY;

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

const queue = [];
const deliverBanner = createBannerDelivery({ endpoint: process.env.BANNER_ENDPOINT });

// A delivery failure leaves the message at the head for the next retry.
// Never run multiple deliveries concurrently.
setInterval(() => {
  void deliverBanner(queue).catch(() => {
    console.error("Banner delivery unexpectedly failed");
  });
}, 60 * 1000);

const onBlock = async (blockNumber) => {
  const block = await provider.getBlockWithTransactions(blockNumber);
  if (!block || !Array.isArray(block.transactions)) return;
  for (const tx of block.transactions) {
    if ((tx.to || "").toLowerCase() !== MULTISIG_ADDRESS ||
        !(tx.value || ethers.constants.Zero).gte(ethers.utils.parseUnits("1"))) {
      continue;
    }
    if (!enqueueBanner(queue, tx, ethers.utils.toUtf8String, MAX_QUEUE_ITEMS)) {
      // Do not log transaction bytes, untrusted display strings or secrets.
      console.warn("Paid message skipped: invalid text or queue at capacity");
    }
  }
};

// Serialize block processing; catch rejected RPC/UTF-8 work rather than
// returning an unhandled Promise from the EventEmitter callback.
let processingBlocks = Promise.resolve();
let outstandingBlocks = 0;
provider.on("block", (blockNumber) => {
  if (outstandingBlocks >= 32) {
    console.error("Block-processing backlog limit reached");
    return;
  }
  outstandingBlocks += 1;
  processingBlocks = processingBlocks.then(
    () => onBlock(blockNumber),
  ).catch(() => {
    console.error("Block processing failed");
  }).finally(() => {
    outstandingBlocks -= 1;
  });
});

// **** Server ****

const app = express();
const port = 4000;

// Cross-origin access is opt-in; this is not an authentication mechanism.
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",").map((origin) => origin.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false }));
app.use(morgan("combined"));
app.use(express.json({ limit: "4kb" }));
app.use(express.urlencoded({ extended: false, limit: "4kb" }));

// TLS private material is provisioned outside the repository.
const privateKey = fs.readFileSync(process.env.TLS_KEY_PATH, "utf8");
const certificate = fs.readFileSync(process.env.TLS_CERT_PATH, "utf8");

const credentials = { key: privateKey, cert: certificate };

var httpsServer = https.createServer(credentials, app);

app.get(
  "/queue",
  asyncHandler(async (req, res) => {
    res.json({ queue });
  }),
);

const maxInvoiceSats = readPositiveInteger("MAX_INVOICE_SATS", process.env.MAX_INVOICE_SATS, 100000);
const invoicePerMinute = readPositiveInteger("INVOICE_REQUESTS_PER_MINUTE", process.env.INVOICE_REQUESTS_PER_MINUTE, 8);
const invoiceGlobalPerMinute = readPositiveInteger("INVOICE_GLOBAL_REQUESTS_PER_MINUTE", process.env.INVOICE_GLOBAL_REQUESTS_PER_MINUTE, 120);
const invoiceLimiter = createInvoiceLimiter({
  limit: invoicePerMinute,
  globalLimit: invoiceGlobalPerMinute,
});
const invoiceHandler = createInvoiceHandler({
  domain: LNBITS_DOMAIN,
  apiKey: LNBITS_API_KEY,
  maxSats: maxInvoiceSats,
});

app.post("/zap", invoiceLimiter, invoiceHandler);

// Fixed-address read-only history. Etherscan credentials never reach clients.
app.get("/history", createHistoryHandler({
  address: MULTISIG_ADDRESS,
  apiKey: process.env.ETHERSCAN_API_KEY,
}));

// Respond with bounded, non-sensitive errors for malformed or oversized bodies.
app.use((error, req, res, next) => {
  if (error && error.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  if (error && error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  console.error("Unhandled request error");
  return res.status(500).json({ error: "Internal Server Error" });
});

httpsServer.listen(port, () => {
  console.log(`Express server running on port ${port}`);
});
