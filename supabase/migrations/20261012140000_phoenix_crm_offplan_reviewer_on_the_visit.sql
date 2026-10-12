-- Phoenix CRM — an off-plan visit whose approving manager was ON it goes to SFE
--
-- Owner's ruling, 2026-10-12, answering the one gap of the second-pass CRM audit that had no rule and
-- no test either way: "when a manager was on the visit herself, should she still be the one who
-- approves it?" — "No, the SFE approves it instead."
--
-- WHY IT NEEDED A RULING. Measured read-only on this database on 2026-10-12: of the 31 non-test
-- off-plan visits that carried a companion, 27 were decided by that same companion — every one of the
-- 27 the named manager, every one approved, across 8 managers; the largest single case was 8 visits in
-- one day. Nothing at any of the three layers compared the approver against who went: the access
-- check is never handed the visit, the decision read loaded no companion column, and the RPC wrote
-- `v_actor` without comparing it. That is a MISSING GUARD, never a finding against anybody — the
-- manager on the ride-along is the person who actually knows why the rep went, and nothing told her
-- the system had noticed.
--
-- WHERE THE RULE LIVES. In the application, not here: `unplannedFirstStatus` in
-- src/lib/phoenix-crm/unplanned-rules.ts, resolved at save time in server/visits.ts, because only the
-- application can read the organogram — the same reason a territory with a VACANT manager chain has
-- always started at the SFE stage, and the same mechanism. A third fence in server/unplanned.ts
-- refuses the manager step to whoever is actually clicking.
--
-- WHAT THIS FILE IS FOR. The rows that were ALREADY waiting when the rule landed. The application
-- only chooses a first status as a visit saves, so without this statement the 4 non-test rows sitting
-- at `manager_pending` whose reviewer was on the visit would sit there for ever: the new fence refuses
-- their manager, and the SFE cannot take a step the row is not at.
--
-- 🔴 WHAT IT DELIBERATELY DOES NOT DO.
--   * It does not touch a SETTLED row. The 27 already approved stay approved — re-opening a decided
--     visit would restate a rep's own counted month, and nothing here is a finding against anyone.
--   * It writes NO `manager_decided_by_hr_id` and NO `manager_decided_at`. Nobody took that step, and
--     a timestamp there would make the rep's own screen say "your manager approved it" about a step
--     that never happened.
--   * It raises no flag, writes no integrity row, and sends no notification or email. The SFE reads
--     these in the ordinary queue.
--   * It is idempotent: a second run matches nothing, because the rows are no longer `manager_pending`.
--
-- `version` is bumped with the status because it is the table's optimistic lock — a manager's page
-- loaded before this ran must be told to reload rather than allowed to decide a step that has moved.

update public.phoenix_crm_unplanned_visits u
set status = 'sfe_pending',
    version = u.version + 1,
    updated_at = now()
from public.phoenix_crm_visits v
where v.id = u.visit_id
  and u.status = 'manager_pending'
  -- An empty reviewer is not a reviewer, and it must be excluded BEFORE the comparison below: the
  -- `coalesce(..., '')` arms exist so a null companion cannot error, and an empty key would match
  -- them and move a row whose manager was on nothing. The same empty-key guard the name fold needs.
  and u.manager_hr_id is not null
  and btrim(u.manager_hr_id) <> ''
  -- The same comparison `personKey` makes in TypeScript: these columns differ in case and padding
  -- between the tables that store them, so a raw equality would quietly match nothing.
  and lower(btrim(u.manager_hr_id)) in (
    lower(btrim(coalesce(v.manager_hr_id, ''))),
    lower(btrim(coalesce(v.senior_hr_id, ''))),
    lower(btrim(coalesce(v.product_manager_hr_id, '')))
  );
