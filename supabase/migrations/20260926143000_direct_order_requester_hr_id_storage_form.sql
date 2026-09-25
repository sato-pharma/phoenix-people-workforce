-- Direct orders: put every requester_hr_id in the form an HR id is STORED in, and keep it there.
--
-- WHAT WAS WRONG. 78 of the 152 rows in direct_order_requests — 51% — held the LOWERCASE
-- comparison key instead of the stored form: ai-0001, ai-0007, b-1, b-12, b-154, b-23, b-76, b-94,
-- pd-0010. AccessContext.hrId carries canonicalHrIdKey (lower case, right for matching, wrong for
-- persisting) and the submit path wrote it straight through until hrIdForStorage() was introduced
-- on 2026-09-02. src/lib/hr-id.ts records the same root cause for the wider damage:
-- "~37,000 lowercase actor ids across 52 columns (audited 2026-09-02)".
--
-- WHY IT MATTERS EVEN THOUGH THE APP LOOKS FINE. The direct-order domain canonicalises on read —
-- nameLookup(), rep-counters.ts, hrIdsMatch(), hrIdLookupKeys() — so the screens were never wrong.
-- Two things were:
--   1. All NINE people also have rows under the upper-case spelling, so the SAME rep exists twice.
--      Anything that groups by the raw column (an ad-hoc report, an export, a hand-written query)
--      splits one person into two, and a plain
--        join employees e on e.hr_id = r.requester_hr_id
--      silently drops 51% of all direct orders with no error at all.
--   2. Nothing stopped it coming back. The writer was fixed in TypeScript; a migration, a script or
--      a future call site could reintroduce it tomorrow.
-- It does NOT reach the monthly closing: phx_monthly_closing_direct reads
-- source_of_sales_fact_rollup by region/area/product and never touches direct_order_requests.
--
-- SCOPE. requester_hr_id only. The other hr-id columns in this family are already in storage form,
-- except three deliberate SYSTEM sentinels that must NOT be upper-cased —
-- direct_order_report_share_links.revoked_by_hr_id = 'system:rotation' (7 rows) and
-- direct_order_events.actor_hr_id = 'system.duplicate.cleanup.2026-08-13' /
-- 'system.held.cleanup.2026-08-13' (3 rows) — which is exactly why the trigger below is put on the
-- one column that only ever holds a real HR id, and not on the family.
--
-- Pre-image kept in direct_order_hrid_backup_20260926.requester_hr_id_pre (all 152 rows).

update public.direct_order_requests
set requester_hr_id = upper(btrim(requester_hr_id))
where requester_hr_id is not null
  and requester_hr_id <> upper(btrim(requester_hr_id));

-- The guard. BEFORE INSERT OR UPDATE OF, so an update that does not name the column pays nothing.
--
-- Case and whitespace only, deliberately NOT the full hrIdForStorage(): that also applies the
-- aaa -> aa alias for one legacy upload spelling, which is business vocabulary and belongs in
-- src/lib/hr-id.ts alone. Copying it here would give two places to change and one of them would
-- drift. The app keeps writing through hrIdForStorage(); this only catches what bypasses it.
create or replace function public.phx_direct_order_requests_requester_storage_form()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if new.requester_hr_id is not null then
    new.requester_hr_id := upper(btrim(new.requester_hr_id));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_direct_order_requests_requester_storage_form on public.direct_order_requests;

create trigger trg_direct_order_requests_requester_storage_form
before insert or update of requester_hr_id on public.direct_order_requests
for each row
execute function public.phx_direct_order_requests_requester_storage_form();

comment on function public.phx_direct_order_requests_requester_storage_form() is
  'Keeps direct_order_requests.requester_hr_id in the stored (upper-case, trimmed) form. 78 of 152 rows had shipped as the lower-case comparison key, so a plain join to employees.hr_id dropped 51% of direct orders silently.';
