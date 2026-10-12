# YVRSidewalk

Changes yvrsidewalk when you send polygon to 0x9c327C46351a09abbBF440E1E756A3bea9fEc11c

```bash
pm2 start index.js --name yvrsidewalk-backend
pm2 startup
# Follow the instructions
```
## Deployment secrets and TLS

Copy `.env.example` to a host-local `.env` or inject its variables through your
service manager. Provide TLS files through `TLS_KEY_PATH` and `TLS_CERT_PATH`;
never store TLS private material, service credentials, or live environment values
in Git. Provide the display controller URL through `BANNER_ENDPOINT`.

**Important:** Historical Git commits can preserve files deleted from the current
tree. If actual credentials were ever committed, revoke and replace them at their
issuer, then coordinate history cleanup and fork/cache handling. A clean HEAD
does not mean historical credentials are safe.

## Public invoice endpoint safeguards

The `POST /zap` API creates **incoming invoices only** (`out: false`).
LNbits expects an integer satoshi `amount`, not millisatoshis. Provision a
**new LNbits invoice-only key** for `LNBITS_API_KEY`, never an admin key.
The historical key must be revoked at its issuer; rewriting Git history
alone does not revoke it.

Input validation accepts positive integer satoshis up to
`MAX_INVOICE_SATS` (default 100,000), including decimal digit strings from
the legacy web form. Memos are at most 200 UTF-8 bytes without control
characters. The request body is limited to 4 KiB. Incoming invoice
creation is bounded to 8 requests per client and 120 requests globally
per minute by default, with at most four upstream requests in flight;
provider requests timeout after 10 seconds. Provider errors are not
returned verbatim to browsers.

Browser CORS is disabled by default. Set `CORS_ALLOWED_ORIGINS` to the
actual frontend origin(s), comma-separated, without a wildcard. The
example uses `http://localhost:3000` for local React development.
CORS is **not** an authentication mechanism. This in-process limiter
does not provide distributed quotas; a deployment with multiple workers
needs reverse-proxy or shared-state limits. Express proxy trust is not
enabled: when behind a reverse proxy, its direct peer address is used
for the per-client limiter. Do not enable trust-proxy without a vetted
proxy and IP address policy.

Use Node.js 18 or newer. Run `npm test` for offline policy tests.
These tests never contact a wallet and do not validate live deployment,
rotated key privileges, or TLS trust. The separate
`yvrsidewalk-ui` browser client presently targets localhost; configure
its backend URL before any public deployment.

## Polygon transaction history

The public `GET /history` endpoint uses Etherscan API V2 with `chainid=137` and the server's fixed `MULTISIG_ADDRESS`. The legacy PolygonScan V1 endpoint is retired. Provision a **new** Etherscan API key only as the backend `ETHERSCAN_API_KEY` environment variable; do not add this key to React build configuration, query parameters sent to browsers, source control, logs, or client-side error messages. When the key is absent, this endpoint returns HTTP 503.

The endpoint accepts no caller-controlled address or API query. It returns up to 50 sanitized incoming transactions, caches a successful refresh for 60 seconds, deduplicates simultaneous refreshes, applies an eight-second upstream timeout and a 256 KiB parsed-response size check, negative-caches failures for 30 seconds, and fails closed on malformed responses. Add ingress-wide request quotas and structured, redacted metrics before a public multi-instance deployment; its cache is per process.

The browser History page must consume `GET /history` through the same `REACT_APP_ZAP_API_ORIGIN` used for invoices, with backend `CORS_ALLOWED_ORIGINS` set to the actual frontend origin. The previously committed browser-side PolygonScan key should be invalidated through the provider if it was active. Old public Git histories may retain it until coordinated reference cleanup.
