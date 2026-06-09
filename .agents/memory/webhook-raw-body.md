---
name: Webhook raw body
description: Why the webhook route must be before express.json() and use express.raw()
---

The MeSomb webhook route applies `express.raw({ type: '*/*' })` as its own middleware inside the router. This means it must be registered on the Express app **before** `express.json()` is applied globally.

**Why:** HMAC-SHA256 signature verification requires the exact raw request body bytes. If express.json() runs first, it parses and re-serialises the JSON, which changes whitespace/ordering and makes every signature check fail.

**How to apply:** In `src/index.js`, always import and mount webhookRoutes before calling `app.use(express.json())`.
