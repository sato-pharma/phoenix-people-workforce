-- Publishing a closing now records what was published. Until today it recorded nothing.
--
-- Second half of the SoS audit finding at
-- `supabase/migrations/20260801120000_sos_rollup_and_closing_sql_truth.sql:186`. PR #3199 taught
-- the drift check to SEE value and to fall back to the lock snapshot; this closes the other gap it
-- documented — that **no snapshot is ever taken at publish**.
--
-- Measured on production 2026-09-05: `monthly_closing_publications` has carried
-- `snapshot_taken_at`, `snapshot_units`, `snapshot_cells` and `snapshot_breakdown` all along, and
-- all 3 published rows (Anti Infective / CNS / Pedia 2026-07) have every one of them NULL. The
-- columns were built and never filled: `publishClosing` upserts exactly four columns — line,
-- normalized_line, period, published_by — and nothing else has ever written that table.
--
-- The consequence is that a closing is only auditable if it also happened to be LOCKED. Lock and
-- publish are separate acts, so a published-but-never-locked closing had no baseline of any kind,
-- and a factory-price edit against it was undetectable even after PR #3199.
--
-- ── Why a trigger and not a change to publishClosing ─────────────────────────────────────────
-- The snapshot must be written in the SAME statement as the row. A Supabase client request that
-- times out at 15s still COMMITS, so "insert, then compute, then update" can leave a published
-- closing with no baseline and no audit trail of why. A BEFORE INSERT trigger is atomic by
-- construction and cannot be skipped by a caller that forgets.
--
-- It also keeps `publishClosing` untouched, and that path is load-bearing: its returned
-- `published_at` anchors the notification idempotency key, so a re-publish does not re-mail every
-- sales and product manager. Not editing it is the point.
--
-- ── BEFORE INSERT only, and why that is the whole safety property ────────────────────────────
-- `publishClosing` upserts with ON CONFLICT (normalized_line, period). Two consequences, and the
-- design turns on both:
--
--   1. On a conflict, Postgres fires BEFORE INSERT row triggers BEFORE it detects the conflict, so
--      this function DOES run on a re-publish. Its result is then discarded, because the upsert's
--      DO UPDATE SET names only the four columns publishClosing supplies — the snapshot columns are
--      not among them, so the stored row keeps whatever it already had. The cost is one wasted
--      aggregate on a re-publish, which is rare (3 publication rows exist in total).
--   2. There is deliberately NO update branch. Re-publishing must never re-snapshot: that would
--      silently replace the baseline with today's figures at exactly the moment someone is asking
--      whether the figures moved, which is the failure this whole line of work exists to stop.
--
-- For the same reason the three legacy rows are NOT back-filled. A snapshot taken now would record
-- the already-restated figures as though they were what was published in August — fabricating a
-- baseline, and doing it to a set that includes the one publication the owner ruled untouchable
-- (July 2026 Anti Infective, owner decision 2026-09-04: it stays as published, is not to be
-- corrected, and is not to be offered as correctable). Those rows keep NULL and keep falling back
-- to the lock snapshot, which is a real baseline taken at a real moment.
--
-- An explicitly supplied snapshot is honoured rather than overwritten, so a restore or a
-- deliberate re-insert can carry its own true baseline in.

CREATE OR REPLACE FUNCTION public.phx_publication_take_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_snap jsonb;
begin
  -- A caller that brought its own baseline keeps it. Only an unsnapshotted insert is filled.
  if new.snapshot_breakdown is not null or new.snapshot_taken_at is not null then
    return new;
  end if;

  -- Same shape the drift check compares against, value included (PR #3199).
  v_snap := public.phx_closing_publication_snapshot(new.line, new.period);

  new.snapshot_units      := (v_snap->>'units')::numeric;
  new.snapshot_cells      := (v_snap->>'cells')::integer;
  new.snapshot_breakdown  := v_snap->'breakdown';
  new.snapshot_taken_at   := now();

  return new;
end;
$function$;

-- SECURITY DEFINER over the whole fact rollup, so lock it down like its three siblings.
revoke execute on function public.phx_publication_take_snapshot() from public, anon, authenticated;
grant  execute on function public.phx_publication_take_snapshot() to service_role;

-- BEFORE INSERT, FOR EACH ROW. Never OR UPDATE — see above; an update branch would overwrite a
-- published baseline with current figures.
drop trigger if exists trg_publication_take_snapshot on public.monthly_closing_publications;
create trigger trg_publication_take_snapshot
before insert on public.monthly_closing_publications
for each row execute function public.phx_publication_take_snapshot();

comment on function public.phx_publication_take_snapshot() is
  'BEFORE INSERT on monthly_closing_publications: records units, cells and per-cell value as at the '
  'moment of publishing, so a later factory-price edit or re-attribution is detectable via '
  'phx_closing_publication_drift. Never fires on UPDATE - a re-publish must not restate the '
  'baseline. Added 2026-09-05.';
