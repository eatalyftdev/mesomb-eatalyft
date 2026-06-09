# EataLyft App — Payment Microservice Integration Prompt

> **How to use:** Paste the block below directly into the Eatalyft main app's AI agent
> (Replit Agent, Cursor, Copilot, etc.) to wire up payments end-to-end.

---

```
You are integrating the EataLyft Payment Microservice into the main Eatalyft app.
The microservice handles ALL mobile money payments (MTN, Orange, Airtel in XAF) for
rides, food orders, parcels, bus bookings, hotel bookings, and wallet top-ups.

The microservice URL is: https://<your-mesomb-service-domain>
(Replace with your actual deployed Replit domain)

════════════════════════════════════════════════════════════════
PART 1 — INITIATING A PAYMENT (collect from customer)
════════════════════════════════════════════════════════════════

Call this endpoint when a customer confirms payment for any order:

  POST https://<service>/api/payments/collect
  Content-Type: application/json

  {
    "phone":   "<customer phone number, local format e.g. 677000000>",
    "amount":  <integer amount in XAF>,
    "service": "MTN" | "ORANGE" | "AIRTEL",
    "type":    "Ride" | "Food" | "Parcel" | "Wallet" | "Bus" | "Hotel",
    "trxID":   "<your internal order/booking ID — THIS IS THE RECONCILIATION KEY>",
    "userId":  "<Firebase Auth UID of the customer>",
    "mode":    "asynchronous",
    "customer": {
      "firstName": "<customer first name>",
      "lastName":  "<customer last name>",
      "email":     "<customer email>"
    }
  }

IMPORTANT — trxID rules:
  • Use your actual order UUID or booking ID as trxID.
  • Prefix it so the microservice can map it to the right table:
      Ride orders:    "EATALYFT-RIDE-<orderId>"
      Food orders:    "EATALYFT-FOOD-<orderId>"
      Parcel orders:  "EATALYFT-PARCEL-<orderId>"
      Bus bookings:   "EATALYFT-BUS-<bookingId>"
      Hotel bookings: "EATALYFT-HOTEL-<bookingId>"
      Wallet top-up:  "EATALYFT-WALLET-<userId>-<timestamp>"
  • This becomes the `reference` field in ALL webhook events — never omit it.

Response (returns immediately — do NOT treat this as the final status):
  {
    "success": true,          // operation was accepted by MeSomb
    "trxID": "EATALYFT-RIDE-abc123",
    "paymentId": "<uuid>",    // Supabase payments table row ID
    "status": "PENDING",      // always PENDING — final status comes via webhook
    "transactionId": null     // MeSomb pk, may be null in async mode
  }

After this call:
  1. Store trxID and paymentId on the order record.
  2. Set order payment_status = "pending" in your database.
  3. Show the customer a "Waiting for payment confirmation..." screen.
  4. Poll for status OR listen to your Supabase realtime subscription (see Part 3).

════════════════════════════════════════════════════════════════
PART 2 — PAYOUTS (deposit to driver/vendor/customer)
════════════════════════════════════════════════════════════════

Call this to send money OUT to a driver, vendor, or customer refund:

  POST https://<service>/api/payments/deposit
  Content-Type: application/json

  {
    "phone":   "<recipient phone>",
    "amount":  <integer amount in XAF>,
    "service": "MTN" | "ORANGE" | "AIRTEL",
    "trxID":   "<your payout reference ID, e.g. PAYOUT-driverId-timestamp>",
    "userId":  "<recipient Firebase UID>"
  }

════════════════════════════════════════════════════════════════
PART 3 — GETTING FINAL PAYMENT STATUS
════════════════════════════════════════════════════════════════

The final payment status (SUCCESS or FAILED) arrives asynchronously via webhook.
The microservice processes the webhook and writes the result to both Supabase and
Firestore automatically. In the main app, use ONE of these approaches:

── Option A: Supabase Realtime subscription (recommended) ────────────────────

  import { createClient } from '@supabase/supabase-js';
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  supabase
    .channel('payment-status')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'payments',
      filter: `reference=eq.${trxID}`,
    }, (payload) => {
      const status = payload.new.status;
      if (status === 'SUCCESS') {
        // Mark order as paid, proceed with fulfilment
      } else if (status === 'FAILED') {
        // Show retry UI to customer
      }
    })
    .subscribe();

── Option B: Firestore realtime listener (if Firebase is your primary DB) ────

  import { doc, onSnapshot } from 'firebase/firestore';

  const unsubscribe = onSnapshot(doc(db, 'payments', trxID), (snap) => {
    if (!snap.exists()) return;
    const { status, finTrxId, amount } = snap.data();
    if (status === 'SUCCESS') { /* proceed */ }
    if (status === 'FAILED')  { /* show retry */ }
  });
  // Call unsubscribe() when the screen unmounts

── Option C: Poll the microservice directly ──────────────────────────────────

  GET https://<service>/api/payments/transactions?ids=<mesombPk>&source=MESOMB

  // or by your own trxID:
  GET https://<service>/api/payments/transactions?ids=<trxID>&source=EXTERNAL

  Response: { "success": true, "transactions": [{ "status": "SUCCESS", ... }] }

════════════════════════════════════════════════════════════════
PART 4 — PAYMENT STATUS VALUES
════════════════════════════════════════════════════════════════

  "PENDING"           Payment initiated, waiting for operator confirmation.
                      Show "Processing payment..." UI. DO NOT fulfil the order yet.

  "SUCCESS"           Funds collected. Mark order as paid. Proceed with fulfilment.
                      The `fin_trx_id` field contains the MTN/Orange operator reference
                      — store it for reconciliation.

  "FAILED"            Collection failed (wrong PIN, insufficient funds, timeout).
                      This is a NORMAL business event — not a system error.
                      Show the customer a clear failure message with a retry button.

  "REFUNDED"          Funds returned to customer.

  "funded"            (SecurePay) Escrow funded — notify seller to prepare.

  "completed"         (SecurePay) Escrow released — seller has been paid.

════════════════════════════════════════════════════════════════
PART 5 — ORDER TABLE SCHEMA REQUIRED
════════════════════════════════════════════════════════════════

Each order/booking table needs two columns for the microservice to update it.
Run this migration once against your Supabase DB (adapt to each table):

  ALTER TABLE rides         ADD COLUMN IF NOT EXISTS payment_reference TEXT;
  ALTER TABLE rides         ADD COLUMN IF NOT EXISTS payment_status     TEXT DEFAULT 'pending';
  ALTER TABLE rides         ADD COLUMN IF NOT EXISTS payment_id         UUID;

  ALTER TABLE orders        ADD COLUMN IF NOT EXISTS payment_reference TEXT;
  ALTER TABLE orders        ADD COLUMN IF NOT EXISTS payment_status     TEXT DEFAULT 'pending';
  ALTER TABLE orders        ADD COLUMN IF NOT EXISTS payment_id         UUID;

  ALTER TABLE parcel_orders ADD COLUMN IF NOT EXISTS payment_reference TEXT;
  ALTER TABLE parcel_orders ADD COLUMN IF NOT EXISTS payment_status     TEXT DEFAULT 'pending';
  ALTER TABLE parcel_orders ADD COLUMN IF NOT EXISTS payment_id         UUID;

  ALTER TABLE bus_bookings  ADD COLUMN IF NOT EXISTS payment_reference TEXT;
  ALTER TABLE bus_bookings  ADD COLUMN IF NOT EXISTS payment_status     TEXT DEFAULT 'pending';
  ALTER TABLE bus_bookings  ADD COLUMN IF NOT EXISTS payment_id         UUID;

  ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS payment_reference TEXT;
  ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS payment_status     TEXT DEFAULT 'pending';
  ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS payment_id         UUID;

When you create an order/booking, set `payment_reference = trxID` immediately.
The microservice uses this column to find and update the right row on webhook receipt.

Also run the microservice migration (creates payments + webhook_events tables):
  → Paste supabase/migrations/001_payments_schema.sql into your Supabase SQL editor.

════════════════════════════════════════════════════════════════
PART 6 — REFUNDS
════════════════════════════════════════════════════════════════

  POST https://<service>/api/payments/refund
  Content-Type: application/json

  {
    "transactionId": "<mesomb_pk from the payments table>",
    "amount": 2500    // optional — omit for a full refund
  }

  Response: { "success": true, "transactionSuccess": true, "status": "REFUNDED" }

════════════════════════════════════════════════════════════════
PART 7 — ENVIRONMENT VARIABLES TO ADD TO THE MAIN APP
════════════════════════════════════════════════════════════════

Add these to the main Eatalyft app's Secrets / environment:

  PAYMENT_SERVICE_URL=https://<your-mesomb-service-domain>

  # Same Supabase project as the microservice (shared payments table)
  SUPABASE_URL=<your supabase url>
  SUPABASE_ANON_KEY=<your supabase anon key>        # for client-side realtime
  SUPABASE_SERVICE_ROLE_KEY=<service role key>      # for server-side writes

════════════════════════════════════════════════════════════════
PART 8 — WEBHOOK CONFIGURATION IN MESOMB DASHBOARD
════════════════════════════════════════════════════════════════

In your MeSomb dashboard (mesomb.business/applications/):
  1. Open your application → Settings → Webhooks
  2. Set the webhook URL to: https://<your-mesomb-service-domain>/webhooks/mesomb
  3. Copy the signing secret (whsec_...) and set it as MESOMB_WEBHOOK_SECRET
     in the microservice's Replit Secrets.
  4. Enable all event types, especially:
       ✓ payment.transaction.success
       ✓ payment.transaction.failed
       ✓ checkout.session.completed

════════════════════════════════════════════════════════════════
PART 9 — COMPLETE PAYMENT FLOW (summary)
════════════════════════════════════════════════════════════════

  Customer taps "Pay"
        │
        ▼
  Main app → POST /api/payments/collect (with trxID = order ID)
        │
        ▼
  Microservice calls MeSomb → customer gets MTN/Orange USSD push
        │
        ├─ Microservice saves PENDING to Supabase + Firestore immediately
        │
        ▼
  Main app shows "Awaiting confirmation..." → listens on Supabase/Firestore
        │
  Customer enters PIN on phone
        │
        ▼
  MeSomb sends webhook → microservice receives it
        ├─ Verifies HMAC signature
        ├─ Checks for duplicates (idempotent)
        ├─ Upserts payment record in Supabase + Firestore (SUCCESS or FAILED)
        ├─ Updates order table payment_status in Supabase
        └─ Updates transactions/{trxID} in Firestore
        │
        ▼
  Supabase Realtime / Firestore listener fires in main app
        │
        ├─ SUCCESS → mark order paid, notify driver/vendor, show receipt
        └─ FAILED  → show "Payment failed, please try again" + retry button
```
