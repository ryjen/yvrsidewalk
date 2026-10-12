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
