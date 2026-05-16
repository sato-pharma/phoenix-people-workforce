-- Align `leave_requests` with remote runtime schema expectations used by leave workflows.
-- This migration is safe to replay locally and avoids fallback inserts for core columns.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'leave_requests'
  ) THEN
    RAISE NOTICE 'leave_requests table not found; skipping leave request schema reconciliation migration.';
    RETURN;
  END IF;

  -- Add columns that exist on the remote leave_requests contract but are missing in local history.
  ALTER TABLE public.leave_requests
    ADD COLUMN IF NOT EXISTS requested_at timestamptz,
    ADD COLUMN IF NOT EXISTS manager_decision_at timestamptz,
    ADD COLUMN IF NOT EXISTS hr_decision_at timestamptz,
    ADD COLUMN IF NOT EXISTS attachment_url text,
    ADD COLUMN IF NOT EXISTS manager_comment text,
    ADD COLUMN IF NOT EXISTS hr_comment text,
    ADD COLUMN IF NOT EXISTS payment_reason text,
    ADD COLUMN IF NOT EXISTS manager_status text,
    ADD COLUMN IF NOT EXISTS hr_status text,
    ADD COLUMN IF NOT EXISTS payroll_status text,
    ADD COLUMN IF NOT EXISTS payment_status text,
    ADD COLUMN IF NOT EXISTS duration_unit text,
    ADD COLUMN IF NOT EXISTS total_calendar_days numeric,
    ADD COLUMN IF NOT EXISTS total_working_days numeric,
    ADD COLUMN IF NOT EXISTS leave_type_id uuid,
    ADD COLUMN IF NOT EXISTS policy_id uuid,
    ADD COLUMN IF NOT EXISTS balance_leave_type_id uuid,
    ADD COLUMN IF NOT EXISTS hr_balance_decision text;

  -- Backfill core fields used by API compatibility/constraints.
  UPDATE public.leave_requests
  SET requested_at = COALESCE(requested_at, submitted_at, created_at, now())
  WHERE requested_at IS NULL;

  UPDATE public.leave_requests
  SET status = CASE lower(trim(status))
    WHEN 'approved' THEN 'manager_approved'
    WHEN 'rejected' THEN 'manager_rejected'
    WHEN 'draft' THEN 'draft'
    WHEN 'pending_manager' THEN 'pending_manager'
    WHEN 'manager_approved' THEN 'manager_approved'
    WHEN 'manager_rejected' THEN 'manager_rejected'
    WHEN 'pending_hr' THEN 'pending_hr'
    WHEN 'hr_approved' THEN 'hr_approved'
    WHEN 'hr_rejected' THEN 'hr_rejected'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'pending_manager'
  END
  WHERE status IS NULL
     OR lower(trim(status)) IN ('pending', 'approved', 'rejected', 'pending manager', 'manager approved', 'manager rejected');

  UPDATE public.leave_requests
  SET manager_status = COALESCE(NULLIF(trim(manager_status), ''), 'pending');

  UPDATE public.leave_requests
  SET hr_status = COALESCE(NULLIF(trim(hr_status), ''), 'pending');

  UPDATE public.leave_requests
  SET payroll_status = COALESCE(NULLIF(trim(payroll_status), ''), 'not_required');

  UPDATE public.leave_requests
  SET payment_status = COALESCE(NULLIF(trim(payment_status), ''), 'in_review');

  UPDATE public.leave_requests
  SET duration_unit = CASE lower(trim(day_type))
    WHEN 'am only' THEN 'am'
    WHEN 'pm only' THEN 'pm'
    ELSE 'full_day'
  END
  WHERE duration_unit IS NULL;

  UPDATE public.leave_requests
  SET total_calendar_days = COALESCE(total_calendar_days, COALESCE(total_days, 0)),
      total_working_days = COALESCE(total_working_days, COALESCE(total_days, 0));

  -- Backfill lookup-based columns when lookup tables are present.
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'leave_types'
  ) THEN
    UPDATE public.leave_requests lr
    SET leave_type_id = COALESCE(
      (
        SELECT id
        FROM public.leave_types lt
        WHERE lt.code = CASE lower(trim(COALESCE(lr.request_type, lr.vacation_type)))
          WHEN 'annual leave' THEN 'annual_leave'
          WHEN 'sick leave' THEN 'sick_leave'
          WHEN 'unpaid leave' THEN 'unpaid_leave'
          WHEN 'compensatory leave' THEN 'compensatory_leave'
          WHEN 'other' THEN 'other'
          ELSE 'other'
        END
        LIMIT 1
      ),
      (
        SELECT id
        FROM public.leave_types lt_other
        ORDER BY lt_other.code = 'other' DESC, lt_other.id
        LIMIT 1
      )
    )
    WHERE lr.leave_type_id IS NULL;

    IF NOT EXISTS (
      SELECT 1
      FROM public.leave_requests
      WHERE leave_type_id IS NULL
    ) THEN
      ALTER TABLE public.leave_requests
        ALTER COLUMN leave_type_id SET NOT NULL;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'leave_policies'
  ) THEN
    UPDATE public.leave_requests lr
    SET policy_id = (
      SELECT lp.id
      FROM public.leave_policies lp
      ORDER BY lp.id
      LIMIT 1
    )
    WHERE lr.policy_id IS NULL;

    IF NOT EXISTS (
      SELECT 1
      FROM public.leave_requests
      WHERE policy_id IS NULL
    ) THEN
      ALTER TABLE public.leave_requests
        ALTER COLUMN policy_id SET NOT NULL;
    END IF;
  END IF;

  -- Set remote-compatible defaults and nullability.
  ALTER TABLE public.leave_requests
    ALTER COLUMN status SET DEFAULT 'pending_manager',
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN manager_status SET DEFAULT 'pending',
    ALTER COLUMN manager_status SET NOT NULL,
    ALTER COLUMN hr_status SET DEFAULT 'pending',
    ALTER COLUMN hr_status SET NOT NULL,
    ALTER COLUMN payroll_status SET DEFAULT 'not_required',
    ALTER COLUMN payroll_status SET NOT NULL,
    ALTER COLUMN payment_status SET DEFAULT 'in_review',
    ALTER COLUMN payment_status SET NOT NULL,
    ALTER COLUMN duration_unit SET DEFAULT 'full_day',
    ALTER COLUMN duration_unit SET NOT NULL,
    ALTER COLUMN total_calendar_days SET DEFAULT 0,
    ALTER COLUMN total_calendar_days SET NOT NULL,
    ALTER COLUMN total_working_days SET DEFAULT 0,
    ALTER COLUMN total_working_days SET NOT NULL,
    ALTER COLUMN requested_at SET DEFAULT now(),
    ALTER COLUMN requested_at SET NOT NULL;

  -- Add remote checks if they are not already present.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_status_check'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_status_check CHECK (
        status = ANY (ARRAY['draft'::text, 'pending_manager'::text, 'manager_approved'::text, 'manager_rejected'::text, 'pending_hr'::text, 'hr_approved'::text, 'hr_rejected'::text, 'cancelled'::text])
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_manager_status_check'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_manager_status_check CHECK (
        manager_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'not_required'::text])
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_hr_status_check'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_hr_status_check CHECK (
        hr_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'not_required'::text])
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_payroll_status_check'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_payroll_status_check CHECK (
        payroll_status = ANY (ARRAY['not_required'::text, 'pending'::text, 'processed'::text, 'blocked'::text])
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_payment_status_check'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_payment_status_check CHECK (
        payment_status = ANY (ARRAY['paid'::text, 'unpaid'::text, 'in_review'::text, 'non_deducted'::text])
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_duration_unit_check'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_duration_unit_check CHECK (
        duration_unit = ANY (ARRAY['full_day'::text, 'am'::text, 'pm'::text])
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_hr_balance_decision_check'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_hr_balance_decision_check CHECK (
        (hr_balance_decision IS NULL)
        OR (hr_balance_decision = ANY (ARRAY['deduct'::text, 'no_deduct'::text]))
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_date_check'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_date_check CHECK (end_date >= start_date);
  END IF;

  -- Foreign keys (added when parent tables exist).
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'employees'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_employee_hr_id_fkey'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_employee_hr_id_fkey
      FOREIGN KEY (employee_hr_id) REFERENCES public.employees(hr_id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'leave_types'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_leave_type_id_fkey'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_leave_type_id_fkey
      FOREIGN KEY (leave_type_id) REFERENCES public.leave_types(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'leave_types'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_balance_leave_type_id_fkey'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_balance_leave_type_id_fkey
      FOREIGN KEY (balance_leave_type_id) REFERENCES public.leave_types(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'leave_policies'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leave_requests_policy_id_fkey'
      AND conrelid = 'public.leave_requests'::regclass
  ) THEN
    ALTER TABLE public.leave_requests
      ADD CONSTRAINT leave_requests_policy_id_fkey
      FOREIGN KEY (policy_id) REFERENCES public.leave_policies(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- Keep index parity with remote query paths used by dashboard/admin flows.
DROP INDEX IF EXISTS public.leave_requests_status_idx;
DROP INDEX IF EXISTS public.leave_requests_employee_idx;
DROP INDEX IF EXISTS public.leave_requests_dates_idx;
DROP INDEX IF EXISTS public.leave_requests_status_dates_idx;
DROP INDEX IF EXISTS public.leave_requests_lineup_idx;
DROP INDEX IF EXISTS public.leave_requests_employee_hr_id_idx;
DROP INDEX IF EXISTS public.leave_requests_created_at_idx;

CREATE INDEX leave_requests_employee_idx
  ON public.leave_requests (employee_hr_id, requested_at DESC);

CREATE INDEX leave_requests_status_idx
  ON public.leave_requests (status, requested_at DESC);

CREATE INDEX leave_requests_dates_idx
  ON public.leave_requests (start_date, end_date);

CREATE INDEX leave_requests_status_dates_idx
  ON public.leave_requests (status, start_date, end_date);

CREATE INDEX leave_requests_lineup_idx
  ON public.leave_requests (leave_type_id, policy_id, employee_hr_id, status);

CREATE INDEX leave_requests_employee_hr_id_idx
  ON public.leave_requests (employee_hr_id);

CREATE INDEX leave_requests_created_at_idx
  ON public.leave_requests (created_at DESC);
