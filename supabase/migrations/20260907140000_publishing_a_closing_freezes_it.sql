-- Publishing a closing FREEZES it. Until today, publishing froze nothing at all.
--
-- OWNER RULE, 2026-09-07: "since the monthly closing is published then no ever change in it ever
-- never even if finance chose a direct order sales month of a published month it doesnt accept and
-- shift to the next month."
--
-- ── What actually went wrong ─────────────────────────────────────────────────────────────────
-- August 2026 was published and announced with a workbook built 5 September. On 6 September,
-- between 11:22 and 13:22 Cairo, Finance booked 10 more Anti Infective direct orders into the same
-- month — 490 units, 32,795.70 EGP — and the announced figure moved underneath a sheet that was
-- already in managers' hands. Nothing refused it, because PUBLISHED and FROZEN were two unrelated
-- switches:
--
--   * `monthly_closing_publications` gates portal VISIBILITY and fires the announcement.
--   * `monthly_closing_locks` is what the database triggers actually enforce.
--
-- `publishClosing` wrote the first and never touched the second, so a month was only protected if
-- somebody separately remembered to click the padlock. August had no lock row of any kind, and the
-- guard in `sales-month-lock-guard.ts` reads locks only — so it had nothing to refuse.
--
-- ── The second half: unpublishing erased the evidence ────────────────────────────────────────
-- `unpublishClosing` DELETED the row. So after the owner published August and later unpublished it,
-- the database held no trace that August had ever been published — the investigation could not tell
-- an unpublished month from one that was never published, and had to be reconstructed from the
-- audit log. A publication is a fact about the past; it is now recorded as one.
--
-- ── The shape of the fix ─────────────────────────────────────────────────────────────────────
--   1. `unpublished_at` / `unpublished_by` replace the DELETE. The row survives, so "was this month
--      ever published?" is always answerable. A BEFORE DELETE trigger refuses the old path outright,
--      including from ad-hoc SQL and migrations, because a history that a stray statement can erase
--      is not a history.
--   2. An AFTER INSERT OR UPDATE trigger locks (line, period) the moment it becomes published.
--      In the database rather than in `publishClosing`, for the same reason the snapshot trigger of
--      20260905133000 lives here: a Supabase request that times out at 15s still COMMITS, so
--      "publish, then lock" can leave a published month unfrozen with nothing recording why. This
--      cannot be skipped by a caller that forgets, and it fires for a direct SQL publish too.
--   3. UNPUBLISHING DOES NOT UNLOCK. That is the owner's rule taken literally: the freeze is
--      anchored to having been published, not to being published *now*. Withdrawing a month from
--      the portal must not quietly reopen its numbers to a re-import — which is precisely the state
--      August was in this morning.
--
-- The deliberate escape hatch stays exactly what it already was: `phx_unlock_monthly_closing`,
-- Super Admin, recorded with a reason and a released-at stamp. One audited door, not a side effect
-- of a visibility toggle.
--
-- ── Why AFTER INSERT *and* AFTER UPDATE ──────────────────────────────────────────────────────
-- `publishClosing` upserts with ON CONFLICT (normalized_line, period). On a first publish that is
-- an INSERT; on a re-publish after an unpublish it takes the DO UPDATE branch, and an AFTER INSERT
-- trigger does not fire there. Both are a publish, so both must freeze. The function is idempotent
-- and no-ops when an active lock already exists, so the ordinary re-publish costs one indexed probe.

begin;

-- ── 1. a publication is a fact about the past ────────────────────────────────────────────────
alter table public.monthly_closing_publications
  add column if not exists unpublished_at timestamptz,
  add column if not exists unpublished_by text;

comment on column public.monthly_closing_publications.unpublished_at is
  'Set when the month was withdrawn from the portal. The row is NEVER deleted, so "was this '
  '(line, period) ever published?" stays answerable. Does NOT release the closing lock.';

create index if not exists monthly_closing_publications_live_idx
  on public.monthly_closing_publications (normalized_line, period)
  where unpublished_at is null;

-- ── 2. publishing freezes the month ──────────────────────────────────────────────────────────
create or replace function public.phx_freeze_published_closing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Only a LIVE publication freezes. A row arriving already-withdrawn (a backfill, a correction)
  -- is a record of history, not an act of publishing.
  if new.unpublished_at is not null then
    return null;
  end if;

  -- Idempotent: one ACTIVE lock per (line, period) is a unique index, and a re-publish must not
  -- try to take a second one. An already-locked month is the normal case here.
  if exists (
    select 1
      from public.monthly_closing_locks l
     where l.normalized_line = new.normalized_line
       and l.period = new.period
       and l.unlocked_at is null
  ) then
    return null;
  end if;

  perform public.phx_lock_monthly_closing(
    p_line   => new.line,
    p_period => new.period,
    p_actor  => coalesce(new.published_by, 'published')
  );

  return null;
end;
$$;

comment on function public.phx_freeze_published_closing() is
  'Locks (line, period) the moment its closing is published, so a published month cannot be moved '
  'by a re-import, a migration, ad-hoc SQL or a direct-order booking. Unpublishing does not undo '
  'it — release is only ever phx_unlock_monthly_closing, with a reason.';

drop trigger if exists trg_publication_freezes_closing on public.monthly_closing_publications;
create trigger trg_publication_freezes_closing
  after insert or update on public.monthly_closing_publications
  for each row
  execute function public.phx_freeze_published_closing();

-- ── 3. the record cannot be deleted ──────────────────────────────────────────────────────────
create or replace function public.phx_refuse_publication_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception
    'A monthly closing publication is never deleted. Unpublishing sets unpublished_at, so the '
    'record that % % was published survives. (This includes migrations and direct SQL.)',
    old.line, old.period
    using errcode = 'check_violation',
          hint = 'update public.monthly_closing_publications set unpublished_at = now() where id = ''' || old.id || ''';';
end;
$$;

drop trigger if exists trg_publication_no_delete on public.monthly_closing_publications;
create trigger trg_publication_no_delete
  before delete on public.monthly_closing_publications
  for each row
  execute function public.phx_refuse_publication_delete();

-- ── both functions are SECURITY DEFINER, so EXECUTE comes off PUBLIC ─────────────────────────
-- Neither is meant to be CALLED by anyone: they run as triggers, which fire regardless of who may
-- execute them. anon/authenticated inherit EXECUTE through PUBLIC membership, so revoking only
-- those two would be a no-op — and revoking PUBLIC on a default ACL also strips service_role,
-- which is why the re-grant below is not optional.
revoke execute on function public.phx_freeze_published_closing() from public, anon, authenticated;
grant execute on function public.phx_freeze_published_closing() to service_role;

revoke execute on function public.phx_refuse_publication_delete() from public, anon, authenticated;
grant execute on function public.phx_refuse_publication_delete() to service_role;

-- ── 4. backfill: every month already published gets its lock ─────────────────────────────────
-- July 2026 is already locked on all three lines, so this is expected to be a no-op there. It
-- exists so the rule holds for every published month, not only for ones published from now on.
do $$
declare
  v_row record;
begin
  for v_row in
    select p.line, p.normalized_line, p.period, p.published_by
      from public.monthly_closing_publications p
     where p.unpublished_at is null
       and not exists (
         select 1 from public.monthly_closing_locks l
          where l.normalized_line = p.normalized_line
            and l.period = p.period
            and l.unlocked_at is null
       )
  loop
    perform public.phx_lock_monthly_closing(
      p_line   => v_row.line,
      p_period => v_row.period,
      p_actor  => coalesce(v_row.published_by, 'publish-freeze-backfill-2026-09-07')
    );
  end loop;
end;
$$;

commit;
