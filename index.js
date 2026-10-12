require("dotenv").config();
const cors = require("cors");
const ethers = require("ethers");
const asyncHandler = require("express-async-handler");
const express = require("express");
const morgan = require("morgan");
const { readPositiveInteger, createInvoiceLimiter, createInvoiceHandler } = require("./lib/zap-policy");
const { createHistoryHandler } = require("./lib/history-policy");
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

let queue = [];

setInterval(
  () => {
    // Make sure queue is > 0
    if (queue.length === 0) {
      return;
    }

    // Shift
    const curString = queue.shift();

    // TODO:
    console.log(`Changing text to ${curString}`);
    fetch(process.env.BANNER_ENDPOINT, {
      headers: {
        accept: "*/*",
        "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      },
      body: `show=Banner&banner=${curString}&imgShow=orangeDot`,
      method: "POST",
    })
      .then(() => {
        console.log("successfully changed text");
      })
      .catch(() => {
        console.log("failed to change text");
      });
  },
  1 * 60 * 1000,
);

const onBlock = async (b) => {
  const block = await provider.getBlockWithTransactions(b);
  const relevantTxs = block.transactions
    .filter((x) => (x.to || "").toLowerCase() === MULTISIG_ADDRESS)
    .filter((x) =>
      (x.value || ethers.constants.Zero).gte(ethers.utils.parseUnits("1")),
    );

  if (relevantTxs.length) {
    console.log(b, "Payment Txs", relevantTxs);
  }

  // Add to the queue
  relevantTxs.forEach((x) => {
    // Max 64 characters
    const str = ethers.utils.toUtf8String(x.data).slice(0, 64);
    queue.push(str);
  });
};

provider.on("block", (b) => {
  onBlock(b);
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
