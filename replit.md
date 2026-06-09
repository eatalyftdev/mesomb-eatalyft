# EataLyft Payment Microservice

A hardened Node.js/Express backend payment microservice for the EataLyft super-app. Wraps the MeSomb mobile money API (MTN, Orange, Airtel in XAF), persists transactions to Supabase, and optionally logs to Firebase Firestore. Includes HMAC-SHA256 webhook signature verification, full idempotency, and handlers for all MeSomb event types.

## Architecture

- **Runtime**: Node.js 20 (ES Modules)
- **Framework**: Express.js
- **Package Manager**: npm
- **Port**: 5000 (localhost)
- **Entry point**: `src/index.js`

## Project Structure

```
src/
  index.js                   # App entry point — routes, health check, config status
  config/
    firebase.js              # Firebase Admin SDK init (graceful no-op if unconfigured)
    supabase.js              # Supabase client init (graceful no-op if unconfigured)
  lib/
    mesombWebhook.js         # HMAC-SHA256 signature verification + event type constants
  routes/
    payments.js              # Payment API under /api/payments/
    webhooks.js              # Hardened webhook handler at /webhooks/mesomb
  services/
    mesombService.js         # MeSomb SDK wrapper — all payment operations
  __tests__/
    webhook.test.js          # 10 unit tests for signature verification (node --test)
supabase/
  migrations/
    001_payments_schema.sql  # webhook_events + payments tables + order table patches
index.js                     # Standalone all-in-one legacy version (reference only)
.env.example                 # All required environment variables with descriptions
```

## API Endpoints

### Payments (`/api/payments/`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/payments/collect` | Collect from customer mobile account (async by default) |
| POST | `/api/payments/deposit` | Payout to a mobile account |
| POST | `/api/payments/refund` | Refund a transaction (full or partial) |
| GET | `/api/payments/transactions?ids=id1,id2&source=MESOMB` | Get transactions by IDs |
| GET | `/api/payments/transactions/check?ids=id1,id2` | Check/validate transactions |
| GET | `/api/payments/status` | MeSomb application status & balances |

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/mesomb` | MeSomb event receiver — HMAC-verified, idempotent |

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info, endpoint list, config status |

## Request Payloads

### POST /api/payments/collect
```json
{
  "phone": "677000000",
  "amount": 5000,
  "service": "MTN",
  "type": "Ride",
  "trxID": "RIDE-abc123",
  "userId": "user_abc123",
  "mode": "asynchronous",
  "customer": { "firstName": "Jean", "lastName": "Nkeng", "email": "jean@example.com" }
}
```
- `trxID` — **set this to your internal order/booking ID**. It becomes the `reference` field in webhook events for reconciliation.
- `mode`: `"asynchronous"` (default, production-safe) | `"synchronous"`
- `service`: `"MTN"` | `"ORANGE"` | `"AIRTEL"`
- `type`: `"Ride"` | `"Food"` | `"Parcel"` | `"Wallet"` | `"Bus"` | `"Hotel"`

### POST /api/payments/deposit
```json
{
  "phone": "677000000",
  "amount": 5000,
  "service": "MTN",
  "trxID": "PAYOUT-xyz789",
  "userId": "user_abc123"
}
```

### POST /api/payments/refund
```json
{
  "transactionId": "mesomb-pk-here",
  "amount": 5000
}
```
- `amount` is optional — omit for full refund.

## Webhook Event Types Handled

| Event | Handler Action |
|-------|---------------|
| `payment.transaction.success` | Upsert payment → Supabase, update linked order table, top up wallet in Firestore |
| `payment.transaction.failed` | Upsert failed record, update order to `failed` — graceful, not an error |
| `checkout.session.completed` | Update checkout session, trigger fulfilment if `payment_status=paid` |
| `checkout.session.expired` | Mark session expired |
| `checkout.session.canceled` | Mark session canceled |
| `checkout.session.created` | Record new session |
| `securepay.transaction.funded` | Mark order `funded` |
| `securepay.transaction.released` | Mark order `completed` |
| `securepay.transaction.refunded` | Mark order `refunded` |
| `securepay.transaction.disputed` | Record dispute |
| All other securepay/dispute events | Stored with status update, no crash |

## Security Model

- **HMAC-SHA256** signature verification on every webhook (`X-MeSomb-Webhook-Signature: t=<ts>,v1=<sig>`)
- **`crypto.timingSafeEqual`** — never `===` for signature comparison
- **Replay-attack protection** — events older than `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` (default 300s) are rejected
- **Idempotency** — `webhook_events` table in Supabase deduplicates by `X-MeSomb-Webhook-Event-Id`
- **Unknown event types** always return `200` — never `404/500` (avoids unnecessary MeSomb retries)

## Required Secrets

| Secret Key | Description |
|-----------|-------------|
| `MESOMB_APPLICATION_KEY` | MeSomb application key |
| `MESOMB_ACCESS_KEY` | MeSomb access key |
| `MESOMB_SECRET_KEY` | MeSomb secret key |
| `MESOMB_WEBHOOK_SECRET` | Webhook signing secret (`whsec_...`) from MeSomb dashboard |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (bypasses RLS) |
| `FIREBASE_PROJECT_ID` | Firebase project ID (optional) |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email (optional) |
| `FIREBASE_PRIVATE_KEY` | Firebase service account private key (optional) |

See `.env.example` for the full list.

> Get MeSomb credentials: https://mesomb.business/applications/

## Running Tests

```bash
npm test
# → 10 unit tests via node:test (no extra dependencies)
```

## Database Setup

Run the migration against your Supabase project:

```bash
# Using Supabase CLI
supabase db push

# Or paste supabase/migrations/001_payments_schema.sql directly into the SQL editor
```

This creates:
- `webhook_events` — deduplication table
- `payments` — canonical transaction records
- Adds `payment_id` + `payment_status` columns to `rides`, `orders`, `parcel_orders`, `bus_bookings`, `hotel_bookings` (safe DO-block, only if tables exist)

## Key Implementation Rules (Do Not Break)

- The webhook route uses `express.raw()` — it is registered **before** `express.json()` in `src/index.js`. Do not move it.
- `trxID` must always be your internal order ID — this is the reconciliation key.
- `makeCollect` uses `asynchronous` mode in production — final status comes via webhook, not the API response.
- `isOperationSuccess()` and `isTransactionSuccess()` are checked separately and both logged.
