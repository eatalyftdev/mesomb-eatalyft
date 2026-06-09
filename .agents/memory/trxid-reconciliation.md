---
name: trxID reconciliation
description: How to link webhook events back to internal orders using trxID/reference
---

The `trxID` parameter passed to `makeCollect`/`makeDeposit` becomes the `reference` field in every MeSomb webhook event payload. This is the sole reconciliation key between the payment microservice and the main Eatalyft app.

**Convention used in this service:**
- Rides:   `EATALYFT-RIDE-<orderId>` or just pass the ride order UUID directly as trxID
- Food:    `EATALYFT-FOOD-<orderId>`
- Parcel:  `EATALYFT-PARCEL-<orderId>`
- Bus:     `EATALYFT-BUS-<bookingId>`
- Hotel:   `EATALYFT-HOTEL-<bookingId>`
- Wallet:  `EATALYFT-WALLET-<userId>-<ts>`
- Deposit: `EATALYFT-DEPOSIT-<ts>`

`resolveOrderTable(reference)` in `src/lib/mesombWebhook.js` maps the prefix to the Supabase table name.

**Why:** Without trxID set, the webhook `reference` field is null and there is no way to update the order's payment_status after the operator responds.
