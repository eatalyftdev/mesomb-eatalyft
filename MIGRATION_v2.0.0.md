# MeSomb Microservice v2.0.0 Migration Guide

## Overview

**v2.0.0 represents a fundamental architectural shift from a direct payment processor to a lightweight webhook gateway.**

### Critical Changes

This version fixes a **production audit finding** where the microservice was directly crediting wallets without:
- HMAC-SHA256 signature verification
- Idempotency guards against duplicate events
- Proper authorization checks

**Result Risk**: If both the microservice and main app were wired to the same database, wallets could be credited twice for a single transaction.

---

## Architecture: Two-Webhook Pattern

### v1.0.0 (Legacy - DEPRECATED)

```
MeSomb → [Microservice] → Supabase + Firestore (DIRECT WRITES)
                       → Main App (NEVER CALLED)
```

**Problems**:
- ❌ No signature verification
- ❌ No idempotency guard
- ❌ Direct wallet credits (bypasses business logic)
- ❌ Double-credit risk if main app also processes

### v2.0.0 (NEW - RECOMMENDED)

```
MeSomb → [Microservice Gateway]
         ├─ Verify HMAC-SHA256 signature
         ├─ Check Firestore for duplicates
         └─ Forward to Main App
            
            Main App (AUTHORITATIVE)
            ├─ Credit wallet
            ├─ Activate mission
            ├─ Send notifications
            └─ Update all business state
```

**Benefits**:
- ✅ Cryptographic signature verification (HMAC-SHA256)
- ✅ Replay attack protection (5-minute timestamp tolerance)
- ✅ Idempotency guard (Firestore mesomb_events collection)
- ✅ Single source of truth (main app only)
- ✅ No double-credit risk
- ✅ MeSomb retry-safe (72-hour auto-retry, 90-day manual replay)

---

## What Changed

### Removed (v1.0.0 code no longer present)

| Item | v1.0.0 | v2.0.0 |
|------|--------|--------|
| Direct wallet credits | ✓ | ✗ |
| Mission activation | ✓ | ✗ |
| FCM/WhatsApp notifications | ✓ | ✗ |
| Payment status updates | ✓ | ✗ |
| Event handlers (15+) | ✓ | ✗ |
| Supabase writes | ✓ | ✗ (read-only) |

### Added (v2.0.0)

| Feature | Purpose |
|---------|---------|
| HMAC-SHA256 signature verification | Cryptographic proof that event is from MeSomb |
| Firestore idempotency guard | Deduplicate retries and manual replays |
| Main app forwarding | Delegate all business logic |
| Event audit logging | Trace all webhook events in Firestore |
| Timing-safe comparison | Protect against timing-based attacks |

### Modified

| File | Changes |
|------|---------|
| `src/routes/webhooks.js` | Complete rewrite: removed all handlers, added forwarding logic |
| `package.json` | Version `1.0.0` → `2.0.0` |
| `src/config/firebase.js` | Export `admin` in addition to `db` |
| `.env.example` | Added `EATALYFT_MAIN_APP_URL`, clarified Supabase deprecation |

---

## Deployment Steps

### 1. Environment Configuration

Update your `.env` file. **Required new variables**:

```bash
# CRITICAL: Get this from MeSomb dashboard
MESOMB_WEBHOOK_SECRET=your_webhook_signing_secret_here

# CRITICAL: Main app URL (must be HTTPS for production)
EATALYFT_MAIN_APP_URL=https://eatalyft.cm

# Firebase (required for idempotency)
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_CLIENT_EMAIL=your-firebase-client-email@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### 2. Test Locally

```bash
# Terminal 1: Start microservice
npm start
# Expect to see: "EataLyft Payment Engine running on port 8080"

# Terminal 2: Check health
curl http://localhost:8080/
# Expect: { version: "2.0.0", ... }

# Terminal 3: Simulate webhook
curl -X POST http://localhost:8080/webhooks/mesomb \
  -H "Content-Type: application/json" \
  -d '{"event_type":"payment.transaction.succeeded","reference":"test-123"}'
# Expect: 401 (missing valid signature, this is correct)
```

### 3. MeSomb Dashboard Configuration

1. Go to **Settings → Webhooks**
2. Set webhook URL to: `https://<your-domain>/webhooks/mesomb`
3. Ensure **signing secret** is set (copy to `MESOMB_WEBHOOK_SECRET`)
4. Enable webhook events:
   - `payment.transaction.succeeded`
   - `payment.transaction.failed`
   - `checkout.session.*` (if using hosted checkout)
   - `securepay.transaction.*` (if using SecurePay)

### 4. Deploy

```bash
# After testing locally:
git add .
git commit -m "chore: upgrade to v2.0.0 two-webhook pattern"
git push

# Deploy (e.g., Fly.io, Railway, Heroku, etc.)
fly deploy  # or your deployment command
```

### 5. Verify Production

```bash
# Check version
curl https://eatapay.eatalyft.cm/

# Monitor logs
fly logs  # or your logging system

# Check Firestore
# Collection: mesomb_events
# Should see new documents as webhooks arrive
```

---

## Signature Verification Details

### X-MeSomb-Webhook-Signature Header Format

```
X-MeSomb-Webhook-Signature: t=<unix_timestamp>,v1=<hex_signature>
```

### Verification Algorithm

```javascript
// 1. Parse header: t=1234567890,v1=abc123...
timestamp = 1234567890
signature = "abc123..."

// 2. Check timestamp is recent (within 300 seconds / 5 minutes)
// Prevents replay attacks of old webhooks

// 3. Build signed payload
signedPayload = `${timestamp}.${rawBody}`  // e.g., "1234567890.{...json...}"

// 4. Compute HMAC-SHA256
expectedSignature = HMAC-SHA256(signedPayload, MESOMB_WEBHOOK_SECRET)

// 5. Timing-safe comparison
if (expectedSignature !== signature) return 401

return 200
```

### Critical: Raw Body Preservation

The microservice must use `express.raw()` to capture the exact request body, byte-for-byte. If the body is re-serialized (e.g., by `express.json()`), the signature will always fail.

```javascript
// CORRECT: Preserve raw buffer
router.use(express.raw({ type: "*/*" }))  // Scoped to webhook route only

// WRONG: Re-serialization breaks signature
app.use(express.json())  // Never apply to webhook route
const body = req.body.toString()  // ❌ Different encoding
```

---

## Firestore Schema

### mesomb_events Collection

Each document represents a processed webhook event:

```javascript
{
  docId: "event-id-from-mesomb-header",  // or generated from body
  
  receivedAt: Timestamp,                 // When microservice received it
  forwardedTo: "https://eatalyft.cm",   // Main app URL
  eventType: "payment.transaction.succeeded",
  reference: "trx-123",
  status: "SUCCESS",
  amount: 5000,  // XAF
  
  raw: { /* full MeSomb event object */ },
}
```

This collection serves two purposes:
1. **Deduplication**: Prevent processing the same event twice
2. **Audit trail**: Track all webhook events received

---

## Rollback Plan (If Needed)

If v2.0.0 causes issues:

1. **Immediate**: Deploy previous version tag
   ```bash
   git checkout v1.0.0
   fly deploy
   ```

2. **Check**: Verify main app logs for any errors
   ```bash
   fly logs -a eatalyft-main-app
   ```

3. **Investigate**: Review webhook events in Firestore
   ```
   Firestore → mesomb_events collection
   ```

---

## Monitoring & Debugging

### Success Indicators

✅ **Logs show**:
```
[Webhook] Received event, signature: present
[Webhook] ✅ Signature verified
[Webhook] Event: id=evt_123, type=payment.transaction.succeeded, ref=trx-456
[Webhook] 📤 Forwarding to main app: https://eatalyft.cm/api/webhook/mesomb
[Webhook] ✅ Main app accepted event (200)
[Webhook] ✅ Event evt_123 complete
```

✅ **Firestore mesomb_events**:
- New documents appear as webhooks arrive
- `status` field should be `"SUCCESS"` for paid transactions

✅ **Main app logs**:
- Show wallet being credited
- Show mission being activated
- Show notifications being sent

### Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| `401 Unauthorized: Missing signature` | No `X-MeSomb-Webhook-Signature` header | Check MeSomb dashboard has signing secret configured |
| `401 Unauthorized: Signature mismatch` | Wrong secret or body modified | Verify `MESOMB_WEBHOOK_SECRET` matches MeSomb dashboard |
| `401 Unauthorized: Signature timestamp outside tolerance` | Clock skew or old webhook | Adjust `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` or sync server clocks |
| `500 Main app webhook unreachable` | `EATALYFT_MAIN_APP_URL` wrong or main app down | Check URL, verify main app is running, check network connectivity |
| `200 duplicate: true` | Webhook already processed | This is correct behavior; MeSomb retries are handled gracefully |

---

## v1.0.0 Users: Breaking Changes

⚠️ **If you are upgrading from v1.0.0, be aware**:

1. **Direct wallet writes are removed**. The main app must now handle all wallet operations.
2. **Supabase operations are removed**. All data flow goes through the main app.
3. **Event handlers are removed**. There are no more `handlePaymentSuccess()`, `handlePaymentFailed()`, etc.
4. **New environment variable required**: `EATALYFT_MAIN_APP_URL` must be set.

If you want to keep v1.0.0:
```bash
git checkout v1.0.0
```

---

## Support & Questions

For issues or questions:
1. Check Firestore `mesomb_events` collection for event audit trail
2. Review microservice logs: `fly logs`
3. Review main app logs: `fly logs -a eatalyft-main-app`
4. Verify all environment variables are set correctly
5. Test signature verification locally with a sample webhook

---

## Version History

| Version | Release Date | Architecture | Status |
|---------|--------------|--------------|--------|
| v1.0.0 | 2024 | Direct Processor | ⚠️ DEPRECATED (double-credit risk) |
| v2.0.0 | 2025 | Two-Webhook Gateway | ✅ CURRENT |

---

**Last Updated**: 2025-01-23  
**Microservice URL**: https://eatapay.eatalyft.cm  
**Main App URL**: https://eatalyft.cm  
**Webhook Endpoint**: https://eatapay.eatalyft.cm/webhooks/mesomb
