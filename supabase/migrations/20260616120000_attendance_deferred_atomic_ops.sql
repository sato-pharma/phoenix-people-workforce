-- Atomic attendance-policy upsert + rule replacement.
-- Replaces the snapshot+restore compensation pattern in src/lib/attendance/policies.ts.
-- Called as service_role via supabase.rpc(); no anon/authenticated exposure.

CREATE OR REPLACE FUNCTION phx_save_attendance_policy(
  p_id            bigint,
  p_policy_name   text,
  p_target_type   text,
  p_target_value  text,
  p_sched_start   text,    -- HH:MM
  p_sched_end     text,    -- HH:MM
  p_grace_minutes integer,
  p_effective_from date,
  p_effective_to  date,
  p_is_active     boolean,
  p_weekdays      smallint[],
  p_rules         jsonb,   -- [{event_type, from_minutes, to_minutes, recommended_action, deduction_days, deduction_value, is_active, sort_order}]
  p_now           timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_id IS NOT NULL THEN
    UPDATE attendance_policy_groups SET
      policy_name      = p_policy_name,
      target_type      = p_target_type,
      target_value     = p_target_value,
      scheduled_start  = p_sched_start::time,
      scheduled_end    = p_sched_end::time,
      grace_minutes    = p_grace_minutes,
      effective_from   = p_effective_from,
      effective_to     = p_effective_to,
      is_active        = p_is_active,
      working_weekdays = p_weekdays,
      updated_at       = p_now
    WHERE id = p_id;
    v_id := p_id;
  ELSE
    INSERT INTO attendance_policy_groups (
      policy_name, target_type, target_value, scheduled_start, scheduled_end,
      grace_minutes, effective_from, effective_to, is_active, working_weekdays,
      created_at, updated_at
    ) VALUES (
      p_policy_name, p_target_type, p_target_value,
      p_sched_start::time, p_sched_end::time,
      p_grace_minutes, p_effective_from, p_effective_to, p_is_active, p_weekdays,
      p_now, p_now
    )
    RETURNING id INTO v_id;
  END IF;

  -- Atomically replace rules — the delete+insert pair is inside this transaction,
  -- so there is no window where the policy can have zero rules.
  DELETE FROM attendance_policy_rules WHERE policy_id = v_id;

  INSERT INTO attendance_policy_rules (
    policy_id, event_type, from_minutes, to_minutes, recommended_action,
    deduction_days, deduction_value, is_active, sort_order, updated_at
  )
  SELECT
    v_id,
    (r->>'event_type')::text,
    NULLIF(r->>'from_minutes', '')::integer,
    NULLIF(r->>'to_minutes',   '')::integer,
    (r->>'recommended_action')::text,
    NULLIF(r->>'deduction_days',  '')::numeric,
    NULLIF(r->>'deduction_value', '')::numeric,
    COALESCE((r->>'is_active')::boolean, true),
    (r->>'sort_order')::integer,
    p_now
  FROM jsonb_array_elements(p_rules) AS r
  WHERE (r->>'event_type') IS NOT NULL;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION phx_save_attendance_policy FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION phx_save_attendance_policy TO service_role;

-- ---------------------------------------------------------------------------
-- Atomic monthly deduction finalization.
-- Replaces the 3-step (summary insert → lines insert → decisions update)
-- pattern in src/lib/deductions-governance/service.ts :: finalizeMonthlyDeductions.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION phx_finalize_monthly_deductions(
  p_month_key       text,
  p_month           integer,
  p_year            integer,
  p_finalized_by    text,
  p_candidate_count integer,
  p_employee_count  integer,
  p_total_days      numeric,
  p_total_amount    numeric,
  p_source_counts   jsonb,
  p_notes           text,
  p_lines           jsonb,   -- [{candidate_id, decision_id, employee_code, employee_hr_id_compact, employee_name, month_key, source_module, deduction_type, payroll_column, deduction_unit, original_deduction_value, applied_deduction_value, applied_amount, dates, reason, hr_note}]
  p_decision_ids    uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_summary_id uuid;
  v_result     jsonb;
BEGIN
  INSERT INTO deduction_monthly_summaries (
    month_key, month, year, finalized_by,
    candidate_count, employee_count, total_days, total_amount,
    source_counts, notes
  ) VALUES (
    p_month_key, p_month, p_year, p_finalized_by,
    p_candidate_count, p_employee_count, p_total_days, p_total_amount,
    COALESCE(p_source_counts, '{}'::jsonb),
    NULLIF(btrim(COALESCE(p_notes, '')), '')
  )
  RETURNING id INTO v_summary_id;

  INSERT INTO deduction_monthly_summary_lines (
    summary_id, candidate_id, decision_id,
    employee_code, employee_hr_id_compact, employee_name,
    month_key, source_module, deduction_type, payroll_column, deduction_unit,
    original_deduction_value, applied_deduction_value, applied_amount,
    dates, reason, hr_note
  )
  SELECT
    v_summary_id,
    (line->>'candidate_id')::uuid,
    (line->>'decision_id')::uuid,
    line->>'employee_code',
    line->>'employee_hr_id_compact',
    NULLIF(line->>'employee_name', ''),
    line->>'month_key',
    line->>'source_module',
    line->>'deduction_type',
    line->>'payroll_column',
    line->>'deduction_unit',
    (line->>'original_deduction_value')::numeric,
    (line->>'applied_deduction_value')::numeric,
    (line->>'applied_amount')::numeric,
    COALESCE(line->'dates', '[]'::jsonb),
    NULLIF(line->>'reason',  ''),
    NULLIF(line->>'hr_note', '')
  FROM jsonb_array_elements(p_lines) AS line;

  IF array_length(p_decision_ids, 1) > 0 THEN
    UPDATE deduction_decisions SET
      finalized_summary_id   = v_summary_id,
      payroll_handoff_status = 'Pending integration',
      updated_at             = now()
    WHERE id = ANY(p_decision_ids);
  END IF;

  SELECT jsonb_build_object(
    'id',              id,
    'month_key',       month_key,
    'month',           month,
    'year',            year,
    'status',          status,
    'finalized_by',    finalized_by,
    'finalized_at',    finalized_at,
    'candidate_count', candidate_count,
    'employee_count',  employee_count,
    'total_days',      total_days,
    'total_amount',    total_amount,
    'source_counts',   source_counts,
    'notes',           notes,
    'created_at',      created_at
  ) INTO v_result
  FROM deduction_monthly_summaries
  WHERE id = v_summary_id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION phx_finalize_monthly_deductions FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION phx_finalize_monthly_deductions TO service_role;
