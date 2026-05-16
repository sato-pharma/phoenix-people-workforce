-- Permanent leave workflow stabilization:
-- 1) canonical workflow-compatible statuses
-- 2) audit/event tables
-- 3) notification attempt tracking

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'leave_requests'
  ) THEN
    ALTER TABLE public.leave_requests
      DROP CONSTRAINT IF EXISTS leave_requests_status_check;

    UPDATE public.leave_requests
    SET status = CASE lower(trim(status))
      WHEN 'pending_manager' THEN 'pending_manager'
      WHEN 'manager_approved' THEN 'pending_hr'
      WHEN 'pending_hr' THEN 'pending_hr'
      WHEN 'hr_approved' THEN 'approved'
      WHEN 'manager_rejected' THEN 'manager_rejected'
      WHEN 'hr_rejected' THEN 'hr_rejected'
      WHEN 'cancelled' THEN 'cancelled'
      WHEN 'needs_routing' THEN 'needs_routing'
      ELSE 'pending_manager'
    END;

    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_status_check CHECK (
        status = ANY (
          ARRAY[
            'draft'::text,
            'pending_manager'::text,
            'pending_hr'::text,
            'approved'::text,
            'manager_rejected'::text,
            'hr_rejected'::text,
            'cancelled'::text,
            'needs_routing'::text
          ]
        )
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.leave_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.leave_requests(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_hr_id text,
  actor_role text NOT NULL,
  from_status text,
  to_status text,
  reason text,
  override_reason text,
  payload_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leave_request_events_request_id_idx
ON public.leave_request_events (request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.leave_notification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.leave_requests(id) ON DELETE CASCADE,
  stage text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  recipients text[] NOT NULL DEFAULT '{}'::text[],
  provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_text text,
  retry_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_notification_attempts_status_check CHECK (
    status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'skipped'::text])
  )
);

CREATE INDEX IF NOT EXISTS leave_notification_attempts_request_id_idx
ON public.leave_notification_attempts (request_id, created_at DESC);
