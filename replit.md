# MeSomb Payment Microservice

A Node.js/Express backend payment microservice for EataLyft, integrating MeSomb mobile money payments (MTN, Orange) and Firebase Firestore.

## Architecture

- **Runtime**: Node.js 20 (ES Modules)
- **Framework**: Express.js
- **Package Manager**: npm
- **Port**: 5000 (localhost)

## Project Structure

```
src/
  index.js           # App entry point — Express setup, routes registration
  config/
    firebase.js      # Firebase Admin SDK initialization (graceful if unconfigured)
  routes/
    payments.js      # POST /api/payments/collect — collect mobile money payment
    webhooks.js      # POST /webhooks/mesomb — MeSomb webhook handler
  services/
    mesombService.js # MeSomb PaymentOperation client wrapper
index.js             # Alternate standalone entry (all-in-one, not used by default)
```

## API Endpoints (src/index.js)

- `GET /` — Health check
- `POST /api/payments/collect` — Collect payment (phone, amount, userId, type)
- `POST /webhooks/mesomb` — MeSomb webhook for payment status updates

## Environment Variables / Secrets

The following secrets must be configured for full functionality:

| Key | Description |
|-----|-------------|
| `PORT` | Server port (default: 5000) |
| `MESOMB_APP_KEY` | MeSomb application key |
| `MESOMB_ACCESS_KEY` | MeSomb access key |
| `MESOMB_SECRET_KEY` | MeSomb secret key |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email |
| `FIREBASE_PRIVATE_KEY` | Firebase service account private key |

## Notes

- Firebase is initialized gracefully — the service starts even if Firebase credentials are absent, with a warning logged.
- The `index.js` at root is a standalone all-in-one version; the canonical entry point is `src/index.js`.
- Deployment target: autoscale (stateless REST API).
