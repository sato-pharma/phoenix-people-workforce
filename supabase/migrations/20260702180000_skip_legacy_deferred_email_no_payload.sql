-- Migration: skip_legacy_deferred_email_no_payload
--
-- Before the unified notification engine stored metadata.emailInput in deferred
-- email delivery rows, the quiet-hours deferral path created notification_deliveries
-- rows with status='pending' but with no emailInput in metadata. The deferred-drain
-- cron (GET /api/notifications/daily) cannot re-dispatch these legacy rows and
-- emits a Sentry warning for each one (PHOENIX-12).
--
-- This migration terminally closes all such rows so they are never retried again.
-- New deferred rows always carry metadata.emailInput (fixed in application code),
-- so this one-time cleanup is safe.

update public.notification_deliveries
set
  status         = 'skipped',
  last_error     = 'Legacy deferred row: no emailInput payload was stored; notification cannot be re-dispatched.',
  next_attempt_at = null,
  updated_at     = now()
where
  channel = 'email'
  and status  = 'pending'
  and (metadata is null or metadata->>'emailInput' is null);