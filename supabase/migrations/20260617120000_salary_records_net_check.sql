-- Enforce net_salary = gross_salary - total_deductions at the DB layer.
-- A trigger is used instead of a CHECK constraint because total_deductions is
-- itself a stored derived column — a CHECK would only catch the stored value
-- but a trigger actively corrects it on every write to a mutable batch.
-- Approved/locked batches are already protected by phx_prevent_closed_salary_records_mutation,
-- so the WHEN clause excludes them to avoid trigger-order conflicts.

CREATE OR REPLACE FUNCTION phx_recompute_net_salary()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_status text;
BEGIN
  SELECT status INTO v_batch_status
  FROM public.salary_batches
  WHERE id = NEW.batch_id;

  -- Only recompute on mutable batches; approved/locked are already immutable.
  IF v_batch_status NOT IN ('approved', 'locked') THEN
    NEW.net_salary := NEW.gross_salary - NEW.total_deductions;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS phx_recompute_net_before_write ON public.salary_records;

CREATE TRIGGER phx_recompute_net_before_write
  BEFORE INSERT OR UPDATE ON public.salary_records
  FOR EACH ROW
  EXECUTE FUNCTION phx_recompute_net_salary();
