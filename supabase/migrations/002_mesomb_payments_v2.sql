-- EataPay / EataLyft — Supabase payment and webhook schema
-- Migration: 002_mesomb_payments_v2
-- Run on the new Supabase project before enabling payment traffic.
-- Supports legacy MeSomb payloads, v2 event envelopes, the microservice,
-- and studio/src/lib/payment-sync.ts.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.webhook_events (
  event_id         TEXT PRIMARY KEY,
  event_type       TEXT,
  api_version      TEXT,
  reference        TEXT,
  status           TEXT,
  livemode         BOOLEAN,
  signature        TEXT,
  payload          JSONB NOT NULL,
  headers          JSONB,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at     TIMESTAMPTZ,
  forwarded_at     TIMESTAMPTZ,
  processing_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_reference
  ON public.webhook_events(reference);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
  ON public.webhook_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status
  ON public.webhook_events(status);

CREATE TABLE IF NOT EXISTS public.payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_ref  TEXT,
  reference     TEXT,
  user_id       TEXT,
  service_type  TEXT,
  service_id    TEXT,
  mesomb_pk     TEXT,
  fin_trx_id    TEXT,
  provider_ref  TEXT,
  service       TEXT,
  b_party       TEXT,
  amount_xaf    NUMERIC(14,2),
  amount        NUMERIC(14,2),
  fees          NUMERIC(14,2) DEFAULT 0,
  trxamount     NUMERIC(14,2),
  currency      TEXT NOT NULL DEFAULT 'XAF',
  country       TEXT NOT NULL DEFAULT 'CM',
  direction     SMALLINT,
  type          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  message       TEXT,
  customer_data JSONB,
  location_data JSONB,
  products      JSONB,
  metadata      JSONB NOT NULL DEFAULT '{}'::JSONB,
  livemode      BOOLEAN NOT NULL DEFAULT TRUE,
  initiated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_firebase_ref
  ON public.payments(firebase_ref)
  WHERE firebase_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_reference
  ON public.payments(reference)
  WHERE reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_mesomb_pk
  ON public.payments(mesomb_pk)
  WHERE mesomb_pk IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_user_id
  ON public.payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status
  ON public.payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_service_type
  ON public.payments(service_type);
CREATE INDEX IF NOT EXISTS idx_payments_created_at
  ON public.payments(created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payments_status_check'
      AND conrelid = 'public.payments'::regclass
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_status_check
      CHECK (status IN (
        'pending', 'processing', 'completed', 'success', 'failed', 'refunded',
        'PENDING', 'SUCCESS', 'FAILED', 'REFUNDED'
      ));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.set_payment_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_updated_at ON public.payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_payment_updated_at();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'rides', 'orders', 'food_orders', 'parcel_orders', 'parcels',
    'bus_bookings', 'hotel_bookings'
  ]
  LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS payment_id UUID', table_name);
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS payment_ref TEXT', table_name);
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT ''pending''', table_name);
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I(payment_status)',
        'idx_' || table_name || '_payment_status', table_name
      );
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- Realtime clients may read only their own payment mirror when the Supabase
-- Auth UID is the same identifier used as the Firestore userId.
DROP POLICY IF EXISTS payments_select_own ON public.payments;
CREATE POLICY payments_select_own
  ON public.payments
  FOR SELECT TO authenticated
  USING (auth.uid()::TEXT = user_id);

-- Supabase Realtime publishes committed row changes to authorized clients.
ALTER TABLE public.payments REPLICA IDENTITY FULL;
ALTER TABLE public.webhook_events REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'payments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.payments;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'webhook_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.webhook_events;
  END IF;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'supabase_realtime publication is not available; enable it in the Supabase dashboard.';
END $$;

COMMIT;

-- Verification queries:
-- SELECT table_name, column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name IN ('payments', 'webhook_events')
-- ORDER BY table_name, ordinal_position;
-- SELECT COUNT(*) AS payments FROM public.payments;
-- SELECT COUNT(*) AS webhook_events FROM public.webhook_events;

-- No payment is initiated by this migration.
-- Provider credentials must remain in server-side environment variables.

-- References:
-- https://supabase.com/docs/guides/database/row-level-security
-- https://www.postgresql.org/docs/current/sql-createindex.html
-- https://www.postgresql.org/docs/current/sql-createfunction.html
