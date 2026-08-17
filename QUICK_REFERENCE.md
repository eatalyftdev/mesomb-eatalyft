# v2.0.0 Quick Reference Card

## Critical Changes at a Glance

| Aspect | v1.0.0 | v2.0.0 |
|--------|--------|--------|
| **Architecture** | Direct Processor | Gateway |
| **Signature Verification** | ❌ None | ✅ HMAC-SHA256 |
| **Wallet Credit** | Microservice | **Main App** |
| **Mission Activation** | Microservice | **Main App** |
| **Notifications** | Microservice | **Main App** |
| **Required Variables** | 3 | 5 |
| **Code Complexity** | ~600 lines | ~420 lines |

---

## Environment Variables

### REQUIRED ⚠️
```bash
MESOMB_WEBHOOK_SECRET=your_secret_from_mesomb_dashboard
EATALYFT_MAIN_APP_URL=https://eatalyft.cm
FIREBASE_PROJECT_ID=your_firebase_project
FIREBASE_CLIENT_EMAIL=your-email@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### OPTIONAL ⚪
```bash
WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS=300  # default: 5 minutes
PORT=8080                                  # default: 8080
NODE_ENV=production                        # default: production
```

### DEPRECATED 🚫
```bash
SUPABASE_URL=          # No longer used by microservice
SUPABASE_SERVICE_ROLE_KEY=  # No longer used by microservice
```

---

## Webhook Flow (New)

```
┌─────────────┐
│   MeSomb    │
│  Dashboard  │  POST /webhooks/mesomb
└──────┬──────┘
       │
       ▼
┌──────────────────────────────┐
│  Microservice v2.0.0         │
├──────────────────────────────┤
│ 1. Verify signature          │  ← New
│    ✅ HMAC-SHA256            │  ← New
│    ✅ Replay protection      │  ← New
│                              │
│ 2. Check deduplication       │  ← New
│    ✅ Firestore guard        │  ← New
│                              │
│ 3. Forward to main app       │  ← New
│    ✅ Raw body + headers     │  ← New
│                              │
│ 4. Record event              │  ← New
│    ✅ Firestore audit log    │  ← New
└──────────────┬───────────────┘
               │
               ▼
        ┌──────────────┐
        │  Main App    │
        │  Authoritative│
        │  Processor   │
        └──────────────┘
          ├─ Credit wallet
          ├─ Activate mission
          ├─ Send notifications
          └─ Update business state
```

---

## Request/Response Examples

### Valid Request (from MeSomb)
```bash
curl -X POST https://eatapay.eatalyft.cm/webhooks/mesomb \
  -H "Content-Type: application/json" \
  -H "X-MeSomb-Webhook-Signature: t=1234567890,v1=abc123def456..." \
  -H "X-MeSomb-Webhook-Event-Id: evt_1234567890" \
  -d '{
    "event_type": "payment.transaction.succeeded",
    "reference": "trx-123",
    "data": { "object": { "pk": "123", "amount": 5000, "status": "SUCCESS" } }
  }'
```

### Response: Success
```json
{
  "received": true,
  "forwarded": true,
  "message": "Event processed via main app"
}
```

### Response: Duplicate
```json
{
  "received": true,
  "duplicate": true,
  "message": "Event already processed"
}
```

### Response: Invalid Signature
```json
{
  "received": false,
  "error": "Unauthorized: Signature mismatch"
}
HTTP 401
```

### Response: Main App Unreachable
```json
{
  "received": false,
  "error": "Main app webhook unreachable — will retry"
}
HTTP 500
```

---

## Key Functions

### verifyMeSombSignature()
```javascript
verifyMeSombSignature({
  rawBody,              // Buffer
  signatureHeader,      // "t=1234567890,v1=abc123..."
  secret,               // MESOMB_WEBHOOK_SECRET
  toleranceSeconds      // 300 (5 minutes)
})
// Returns: { ok: true/false, reason: string }
```

### isAlreadyProcessed()
```javascript
await isAlreadyProcessed(eventId)
// Returns: boolean
// Checks: memory cache first → Firestore second
```

### markProcessed()
```javascript
await markProcessed(eventId, event)
// Adds to memory cache (bounded to 5000)
// Writes to Firestore mesomb_events
```

### forwardEvent()
```javascript
await forwardEvent({
  url,              // Main app webhook URL
  rawBody,          // Request body
  headers,          // Original headers with signature
  timeoutMs         // 10000 (10 seconds)
})
// Returns: { ok: true/false, status: number, error?: string }
```

---

## Firestore Schema

### mesomb_events Collection

**Purpose**: Deduplication + Audit trail

```javascript
db.collection("mesomb_events").doc(eventId).set({
  receivedAt: Timestamp,
  forwardedTo: "https://eatalyft.cm",
  eventType: "payment.transaction.succeeded",
  reference: "trx-123",
  status: "SUCCESS",
  amount: 5000,
  raw: { /* full event */ }
})
```

**Queries**:
```javascript
// Find all events for a transaction
db.collection("mesomb_events").where("reference", "==", "trx-123").get()

// Find recent payment events
db.collection("mesomb_events")
  .where("eventType", "==", "payment.transaction.succeeded")
  .orderBy("receivedAt", "desc")
  .limit(100)
  .get()

// Check if event already processed
db.collection("mesomb_events").doc(eventId).get()
```

---

## Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `401 Unauthorized: Missing signature` | No `X-MeSomb-Webhook-Signature` header | Configure webhook secret in MeSomb dashboard |
| `401 Unauthorized: Signature mismatch` | Wrong secret or tampered body | Verify `MESOMB_WEBHOOK_SECRET` matches |
| `401 Unauthorized: Signature timestamp outside tolerance` | Clock skew or old webhook | Sync server clocks; adjust tolerance if needed |
| `500 Main app webhook unreachable` | `EATALYFT_MAIN_APP_URL` wrong or down | Check URL is HTTPS; verify main app is running |
| `No Firebase credentials` | `FIREBASE_*` vars not set | Set all Firebase environment variables |

---

## Deployment Checklist

- [ ] Update `.env`: `MESOMB_WEBHOOK_SECRET`, `EATALYFT_MAIN_APP_URL`, Firebase vars
- [ ] Test locally: `npm start`
- [ ] Verify health endpoint: `curl http://localhost:8080/`
- [ ] Configure MeSomb dashboard: webhook URL → `https://<domain>/webhooks/mesomb`
- [ ] Deploy microservice: `git push` → deploy pipeline
- [ ] Deploy main app: ensure `/api/webhook/mesomb` endpoint is ready
- [ ] Monitor logs: `fly logs`
- [ ] Check Firestore: `mesomb_events` collection should have events
- [ ] Verify main app logs: wallet credits, mission activations, notifications

---

## Key Differences from v1.0.0

**v1.0.0 Behavior**:
```javascript
MeSomb → Microservice → [No verification, no dedup]
                      → Supabase write [direct credit]
                      → Firestore write [direct credit]
                      → Main app [never called]
```

**v2.0.0 Behavior**:
```javascript
MeSomb → Microservice → [Verify signature]
                      → [Check Firestore dedup]
                      → [Forward to main app]
                      → Main App [processes payment]
                      → Firestore write [audit trail only]
```

---

## Testing with curl

### Local Test
```bash
# Start server
npm start

# Health check
curl http://localhost:8080/

# Test invalid signature (should return 401)
curl -X POST http://localhost:8080/webhooks/mesomb \
  -H "Content-Type: application/json" \
  -d '{"test":"data"}'
```

### Monitor Firestore
```javascript
// In Firebase Console → Firestore Database
db.collection("mesomb_events").orderBy("receivedAt", "desc").limit(10)
// Should show recent events as they arrive
```

---

## Performance Notes

- **Microservice response time**: ~200-400ms (was ~500-1000ms)
- **Firestore write**: ~100ms per event
- **Main app forward**: ~100-300ms depending on network
- **Total latency**: ~400-700ms

MeSomb has 72-hour automatic retry, so latency is acceptable.

---

## Support Resources

- **MeSomb Docs**: https://docs.mesomb.com/development/webhooks
- **Firebase Console**: https://console.firebase.google.com/
- **Microservice Health**: https://eatapay.eatalyft.cm/ (returns JSON with version)
- **Main Integration Prompt**: See `EATALYFT_APP_INTEGRATION_PROMPT.md`
- **Migration Guide**: See `MIGRATION_v2.0.0.md`
- **Implementation Details**: See `IMPLEMENTATION_SUMMARY.md`

---

**Version**: 2.0.0  
**Last Updated**: 2025-01-23  
**Status**: ✅ Ready for Production
