---
name: MeSomb env var name
description: Correct environment variable names for MeSomb credentials
---

The correct env var name is `MESOMB_APPLICATION_KEY` — NOT `MESOMB_APP_KEY`. The original GitHub repo used `MESOMB_APP_KEY` which was a bug.

Full set:
- `MESOMB_APPLICATION_KEY` → PaymentOperation({ applicationKey })
- `MESOMB_ACCESS_KEY`       → PaymentOperation({ accessKey })
- `MESOMB_SECRET_KEY`       → PaymentOperation({ secretKey })
- `MESOMB_WEBHOOK_SECRET`   → HMAC signing secret (whsec_...) from MeSomb dashboard

**Why:** The PaymentOperation constructor parameter is `applicationKey` and the env var must match. Using MESOMB_APP_KEY silently passed `undefined` and caused auth failures only at payment time.
