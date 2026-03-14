# EataLyft Payment Microservice

A Node.js/Express backend payment microservice integrating MeSomb mobile money payments (MTN, Orange, Airtel) and optionally Firebase Firestore for transaction logging.

## Architecture

- **Runtime**: Node.js 20 (ES Modules)
- **Framework**: Express.js
- **Package Manager**: npm
- **Port**: 5000 (localhost)
- **Entry point**: `src/index.js`

## Project Structure

```
src/
  index.js              # App entry point — Express setup, route registration, health check
  config/
    firebase.js         # Firebase Admin SDK init (graceful no-op if unconfigured)
  routes/
    payments.js         # All payment routes under /api/payments/
    webhooks.js         # MeSomb webhook handler at /webhooks/mesomb
  services/
    mesombService.js    # MeSomb SDK wrapper (collectPayment, depositPayment, refundTransaction, etc.)
index.js                # Standalone all-in-one version (legacy, kept for reference)
```

## API Endpoints

### Payments  (`/api/payments/`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/payments/collect` | Collect money from a customer mobile account |
| POST | `/api/payments/deposit` | Deposit money into a customer mobile account (payout) |
| POST | `/api/payments/refund` | Refund a transaction |
| GET | `/api/payments/transactions?ids=id1,id2&source=MESOMB` | Get transactions by IDs |
| GET | `/api/payments/transactions/check?ids=id1,id2` | Check/validate transactions |
| GET | `/api/payments/status` | Get MeSomb application status & balances |

### Webhooks (`/webhooks/`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/mesomb` | Receive payment status updates from MeSomb |

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info and endpoint list |

## Request Payloads

### POST /api/payments/collect
```json
{
  "phone": "677000000",
  "amount": 5000,
  "service": "MTN",
  "type": "Ride",
  "userId": "user_abc123",
  "mode": "synchronous"
}
```
- `service`: `"MTN"` | `"ORANGE"` | `"AIRTEL"`
- `type`: `"Ride"` | `"Food"` | `"Parcel"` | `"Wallet"` (or any label)
- `mode`: `"synchronous"` (default) | `"asynchronous"`

### POST /api/payments/deposit
```json
{
  "phone": "677000000",
  "amount": 5000,
  "service": "MTN",
  "userId": "user_abc123"
}
```

### POST /api/payments/refund
```json
{
  "transactionId": "mesomb-transaction-id",
  "amount": 5000
}
```
- `amount` is optional — omit for a full refund

## Required Secrets

The following secrets must be set for full functionality:

| Secret Key | Description |
|-----------|-------------|
| `MESOMB_APPLICATION_KEY` | MeSomb application key from your MeSomb dashboard |
| `MESOMB_ACCESS_KEY` | MeSomb access key |
| `MESOMB_SECRET_KEY` | MeSomb secret key |
| `FIREBASE_PROJECT_ID` | Firebase project ID (optional — for transaction logging) |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email (optional) |
| `FIREBASE_PRIVATE_KEY` | Firebase service account private key (optional) |

> Get MeSomb credentials from: https://mesomb.business/applications/

## Key Implementation Notes

- **Nonces** are auto-generated using `RandomGenerator.nonce()` from the `@hachther/mesomb` package — no external uuid library needed.
- **Firebase is optional** — the service starts and accepts payments without it. When configured, it logs every transaction to the `transactions` Firestore collection and auto-updates wallet balances on webhook receipt.
- **Webhook URL** to configure in your MeSomb dashboard: `https://<your-domain>/webhooks/mesomb`
- **Environment variable name**: Use `MESOMB_APPLICATION_KEY` (not `MESOMB_APP_KEY`).

## Deployment

Configured for autoscale deployment. Run command: `node src/index.js`
