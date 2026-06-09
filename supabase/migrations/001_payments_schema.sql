-- =========================================================
-- EataLyft Payment Microservice — Initial Schema
-- MeSomb webhook deduplication + payments table
-- =========================================================

-- ---------------------------------------------------------
-- Webhook event deduplication
-- Stores every processed MeSomb event ID so duplicate
-- webhook deliveries are silently ignored.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id            TEXT        PRIMARY KEY,           -- MeSomb event ID (X-MeSomb-Webhook-Event-Id)
  event_type    TEXT        NOT NULL,
  processed_at  TIMESTAMPTZ DEFAULT NOW(),
  payload       JSONB                              -- full event payload for audit / replay
);

-- ---------------------------------------------------------
-- Payments — canonical record of every MeSomb transaction
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mesomb_pk     TEXT        UNIQUE,                -- transaction.pk from MeSomb
  fin_trx_id    TEXT,                              -- operator transaction ID (MTN/Orange ref)
  reference     TEXT,                              -- your trxID — links to the order / booking
  status        TEXT        NOT NULL DEFAULT 'PENDING',  -- SUCCESS | FAILED | PENDING | REFUNDED
  amount        NUMERIC     NOT NULL,
  fees          NUMERIC     DEFAULT 0,
  trxamount     NUMERIC,                           -- amount + fees
  service       TEXT,                              -- MTN | ORANGE | AIRTEL
  currency      TEXT        DEFAULT 'XAF',
  country       TEXT        DEFAULT 'CM',
  direction     INTEGER,                           -- -1 debit (collect), 1 credit (deposit)
  type          TEXT,                              -- COLLECT | DEPOSIT | PAYMENT | REFILL
  b_party       TEXT,                              -- phone number of payer / receiver
  message       TEXT,                              -- operator message / failure reason
  customer_data JSONB,
  location_data JSONB,
  products      JSONB,
  livemode      BOOLEAN     DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_reference  ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payments_mesomb_pk  ON payments(mesomb_pk);
CREATE INDEX IF NOT EXISTS idx_payments_status     ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_service    ON payments(service);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at DESC);

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------
-- Add payment_id + payment_status to order tables
-- (Uses IF NOT EXISTS via DO blocks for safety)
-- ---------------------------------------------------------
DO $$
BEGIN
  -- rides
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'rides') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='rides' AND column_name='payment_id') THEN
      ALTER TABLE rides ADD COLUMN payment_id UUID REFERENCES payments(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='rides' AND column_name='payment_status') THEN
      ALTER TABLE rides ADD COLUMN payment_status TEXT DEFAULT 'pending';
    END IF;
  END IF;

  -- orders (food)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'orders') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='payment_id') THEN
      ALTER TABLE orders ADD COLUMN payment_id UUID REFERENCES payments(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='payment_status') THEN
      ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'pending';
    END IF;
  END IF;

  -- parcel_orders
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'parcel_orders') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='parcel_orders' AND column_name='payment_id') THEN
      ALTER TABLE parcel_orders ADD COLUMN payment_id UUID REFERENCES payments(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='parcel_orders' AND column_name='payment_status') THEN
      ALTER TABLE parcel_orders ADD COLUMN payment_status TEXT DEFAULT 'pending';
    END IF;
  END IF;

  -- bus_bookings
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bus_bookings') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bus_bookings' AND column_name='payment_id') THEN
      ALTER TABLE bus_bookings ADD COLUMN payment_id UUID REFERENCES payments(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bus_bookings' AND column_name='payment_status') THEN
      ALTER TABLE bus_bookings ADD COLUMN payment_status TEXT DEFAULT 'pending';
    END IF;
  END IF;

  -- hotel_bookings
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'hotel_bookings') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='hotel_bookings' AND column_name='payment_id') THEN
      ALTER TABLE hotel_bookings ADD COLUMN payment_id UUID REFERENCES payments(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='hotel_bookings' AND column_name='payment_status') THEN
      ALTER TABLE hotel_bookings ADD COLUMN payment_status TEXT DEFAULT 'pending';
    END IF;
  END IF;
END
$$;
