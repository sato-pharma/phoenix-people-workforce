import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cronJobRegistry } from "../src/lib/cron-control/job-registry.ts";
import {
  NO_CRM_CUTOVER,
  VENDOR_SYNC_RETIRED_REASON,
  crmCutoverMonthDeductionNote,
  crmKpiSeriesBreak,
  isCrmCutoverMonth,
  isCrmCutoverSchemaMissing,
  isOnOrAfterCrmCutover,
  monthRangeCrossesCrmSeriesBreak,
  parseCrmCutoverRow,
  vendorSyncStandDownReason,
  type CrmCutoverSetting,
} from "../src/lib/crm/cutover.ts";
import {
  CRM_CONTACT_MASTER_FORCE_REFRESH_MS,
  CRM_HOUSEKEEPING_LEASE_KEY,
  CRM_HOUSEKEEPING_LEASE_TTL_SECONDS,
  CRM_HOUSEKEEPING_PROBATION_DV_GAP_MS,
  CRM_HOUSEKEEPING_RETRY_AFTER_FAILURE_MS,
  CRM_HOUSEKEEPING_TICK_MS,
  isContactMasterActivityDue,
  isContactMasterListRefreshDue,
  isProbationDvCaptureDue,
} from "../src/lib/crm/housekeeping-scheduler.ts";
import {
  CRM_CHECKINS_UNIFIED_VIEW,
  CRM_CUTOVER_TABLE,
  CRM_PLAN_ENTRIES_UNIFIED_VIEW,
  CRM_VISITS_UNIFIED_VIEW,
} from "../src/lib/crm/tables.ts";
import { crmVacationPersonKey } from "../src/lib/deductions/connectors/vacation.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The CRM cutover (CRM phase 5).
//
// WHAT THIS FILE GUARDS:
//   · DORMANT UNTIL A DATE. The migration seeds no date, and while there is none every unified view is
//     exactly its vendor table: the vendor branch is bounded by `coalesce(date, infinity)` and the native
//     branch by `>= date`, which a null date makes empty.
//   · ONE SOURCE PER DAY (decision 19): vendor rows before the date, Phoenix rows on and after it.
//   · EVERY READ DOOR serves the unified views, and filters resigned agents on `exclusion_crm_id` —
//     `null not in (…)` is null, so filtering on agent_crm_id would silently drop every native rep
//     with no CRM id.
//   · DECISION 18: the cutover month's CRM no-activity days are never charged, and the collection says
//     why instead of reporting a silent zero.
//   · A RETIRED VENDOR stands the poller, the four vendor crons and the four vendor sync buttons down,
//     and the probation double-visit capture moves to the housekeeping timer instead of dying with them.
//   · A native rep with no CRM id still has his half-day leave matched against his own work that day.
// ─────────────────────────────────────────────────────────────────────────────

const read = (path: string) => readFileSync(path, "utf8");

/** The SQL with every comment removed, so a pin can never be satisfied by prose. */
function sqlCode(path: string): string {
  return stripSqlComments(read(path));
}

const DATED: CrmCutoverSetting = { cutoverDate: "2026-10-01", vendorSyncRetiredAt: null };
const RETIRED: CrmCutoverSetting = { cutoverDate: "2026-10-01", vendorSyncRetiredAt: "2026-10-02T06:00:00Z" };

function migrationTests() {
  const sql = sqlCode("supabase/migrations/20260913230000_crm_cutover.sql");

  // Seeded dormant, and a retirement needs a date.
  assert.ok(sql.includes(`create table if not exists public.${CRM_CUTOVER_TABLE} (`), "the setting table is created");
  assert.ok(/values \(true, null, null,/.test(sql), "the setting is seeded with NO cutover date and NO retirement");
  assert.ok(sql.includes("on conflict (id) do nothing"), "a re-run never overwrites a date the owner set");
  assert.ok(sql.includes("constraint crm_cutover_singleton check (id)"), "the setting is one row");
  assert.ok(
    sql.includes("constraint crm_cutover_retire_needs_date check (vendor_sync_retired_at is null or cutover_date is not null)"),
    "the first migration made a retirement need a cutover date",
  );
  // ...and 20261031150000 lifted it: closing the vendor API must never pick the month decision 18 waives.
  const standAlone = sqlCode("supabase/migrations/20261031150000_crm_cutover_retire_without_date.sql");
  assert.ok(
    standAlone.includes("alter table public.crm_cutover drop constraint if exists crm_cutover_retire_needs_date;"),
    "the vendor can be retired with no cutover date",
  );
  assert.ok(!/\b(update|insert|delete)\b/i.test(standAlone), "lifting the constraint writes no setting — the owner sets every field");
  assert.ok(sql.includes("alter table public.crm_cutover enable row level security;"), "RLS is on the setting");
  assert.ok(sql.includes("revoke all on table public.crm_cutover from anon, authenticated;"), "the setting is not exposed to the browser roles");

  for (const view of [CRM_VISITS_UNIFIED_VIEW, CRM_CHECKINS_UNIFIED_VIEW, CRM_PLAN_ENTRIES_UNIFIED_VIEW]) {
    assert.ok(sql.includes(`create or replace view public.${view}\n  with (security_invoker = true)`), `${view} is security_invoker`);
    assert.ok(sql.includes(`revoke all on table public.${view} from anon, authenticated;`), `${view} is not exposed to the browser roles`);
  }

  // Visits: vendor before, native from, never both.
  assert.ok(
    sql.includes("where v.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)"),
    "vendor visits are every row while no date is set, and only days before it once one is",
  );
  assert.ok(
    sql.includes("and n.visit_date >= (select c.cutover_date from public.crm_cutover c where c.id);"),
    "native visits appear only from the date, and not at all while it is null",
  );
  assert.ok(sql.includes("where n.deleted_at is null"), "a deleted native visit is never served");
  assert.ok(sql.includes("v.agent_crm_id as exclusion_crm_id"), "vendor rows filter on their own CRM id");
  assert.ok(
    sql.includes("coalesce(case when e.crm_id ~ '^[0-9]+$' then e.crm_id::bigint end, -1)"),
    "a native rep with no CRM id gets -1, which no resigned list holds, rather than a null that `not in` drops",
  );
  assert.ok(sql.includes("where p.visit_id = n.id and p.status = 'confirmed'"), "only a partner who CONFIRMED is a double visit (decision 10)");

  // Check-ins: the vendor boundary is Cairo midnight of the date; a native visit is one only with a fix.
  assert.ok(
    /where c\.check_date < coalesce\(\s*\(select k\.cutover_date::timestamp at time zone 'UTC' from public\.crm_cutover k where k\.id\),\s*'infinity'::timestamptz\s*\)/.test(sql),
    "vendor check-ins are every row while no date is set",
  );
  assert.ok(sql.includes("and n.gps_status = 'captured'"), "a native visit without a captured fix is not a check-in (decision 7: a flag, not a refusal)");
  assert.ok(sql.includes("and n.visit_date >= (select k.cutover_date from public.crm_cutover k where k.id);"), "native check-ins appear only from the date");

  // Plan entries: a monthly plan has no date and stays vendor; a draft is not a filed plan.
  assert.ok(sql.includes("where pe.plan_date is null"), "a dateless monthly plan entry is always a vendor row");
  assert.ok(sql.includes("and p.status <> 'draft'"), "a draft Phoenix plan is not on any board");
  assert.ok(sql.includes("where i.removed_at is null"),"a doctor dropped from a Phoenix plan is not served");
  assert.ok(sql.includes("and i.plan_date >= (select c.cutover_date from public.crm_cutover c where c.id);"), "native plan entries appear only from the date");
  assert.ok(sql.includes("(case when p.status = 'verified' then 1 else 0 end)::smallint"), "only a verified Phoenix plan reads as verified");

  // Negative stand-in ids from a counter, never a hash.
  for (const table of ["crm_native_visits", "crm_native_plans", "crm_native_plan_items"]) {
    assert.ok(
      new RegExp(`alter table public\\.${table} add column if not exists legacy_id (?:bigint|integer) generated by default as identity;`).test(sql),
      `${table} gets a counter id`,
    );
    assert.ok(sql.includes(`create unique index if not exists ${table}_legacy_id_uidx on public.${table} (legacy_id);`), `${table}'s counter id is unique`);
  }
  assert.ok(sql.includes("-n.legacy_id,") && sql.includes("-i.legacy_id,") && sql.includes("-p.legacy_id,"), "native ids are NEGATIVE, so they never meet a vendor id");
  assert.ok(sql.includes("notify pgrst, 'reload schema';"), "PostgREST sees the views without a restart");
}

function settingTests() {
  assert.deepEqual(parseCrmCutoverRow(null), NO_CRM_CUTOVER, "no row is no cutover");
  assert.deepEqual(
    parseCrmCutoverRow({ cutover_date: "2026-10-01", vendor_sync_retired_at: "2026-10-02T06:00:00Z" }),
    RETIRED,
    "a dated, retired row reads as both",
  );
  const retiredUndated = parseCrmCutoverRow({ cutover_date: null, vendor_sync_retired_at: "2026-11-07T06:00:00Z" });
  assert.deepEqual(
    retiredUndated,
    { cutoverDate: null, vendorSyncRetiredAt: "2026-11-07T06:00:00Z" },
    "a retirement with no date is read: it closes the vendor API on its own",
  );
  assert.equal(vendorSyncStandDownReason(retiredUndated), VENDOR_SYNC_RETIRED_REASON, "an undated retirement stands every vendor pull down");
  assert.equal(isCrmCutoverMonth(retiredUndated, { month: 11, year: 2026 }), false, "an undated retirement waives no month's CRM no-activity");
  assert.equal(isOnOrAfterCrmCutover(retiredUndated, "2026-11-07"), false, "an undated retirement moves no read off the team starts");
  assert.equal(crmKpiSeriesBreak(retiredUndated), null, "an undated retirement breaks no KPI series");
  assert.deepEqual(
    parseCrmCutoverRow({ cutover_date: null, vendor_sync_retired_at: "  " }),
    NO_CRM_CUTOVER,
    "a blank retirement is no retirement",
  );
  assert.deepEqual(parseCrmCutoverRow({ cutover_date: "soon" }), NO_CRM_CUTOVER, "a malformed date is no date");

  assert.equal(isCrmCutoverSchemaMissing({ code: "PGRST205", message: "Could not find the table 'public.crm_cutover' in the schema cache" }), true);
  assert.equal(
    isCrmCutoverSchemaMissing({ code: "42703", message: "column crm_cutover.cutover_date does not exist" }),
    false,
    "a missing COLUMN is a code bug and must surface, not read as no cutover",
  );
  assert.equal(isCrmCutoverSchemaMissing(new Error("connection refused")), false, "an outage is not a missing table");

  assert.equal(vendorSyncStandDownReason(NO_CRM_CUTOVER), null);
  assert.equal(vendorSyncStandDownReason(DATED), null, "a date alone keeps vendor sync running until the owner retires it");
  assert.equal(vendorSyncStandDownReason(RETIRED), VENDOR_SYNC_RETIRED_REASON);

  assert.equal(isOnOrAfterCrmCutover(NO_CRM_CUTOVER, "2030-01-01"), false, "with no date every day is the vendor's");
  assert.equal(isOnOrAfterCrmCutover(DATED, "2026-09-30"), false);
  assert.equal(isOnOrAfterCrmCutover(DATED, "2026-10-01"), true, "the cutover date itself is Phoenix's");
  assert.equal(isOnOrAfterCrmCutover(DATED, "2026-10-01T10:30:00"), true);
}

function decision18Tests() {
  assert.equal(isCrmCutoverMonth(DATED, { month: 10, year: 2026 }), true, "the month the date falls in is the cutover month");
  assert.equal(isCrmCutoverMonth({ cutoverDate: "2026-10-15", vendorSyncRetiredAt: null }, { month: 10, year: 2026 }), true);
  assert.equal(isCrmCutoverMonth(DATED, { month: 9, year: 2026 }), false, "the month before is charged as always");
  assert.equal(isCrmCutoverMonth(DATED, { month: 11, year: 2026 }), false, "the month after is charged as always");
  assert.equal(isCrmCutoverMonth(DATED, { month: 10, year: 2025 }), false, "the same month of another year is not it");
  assert.equal(isCrmCutoverMonth(NO_CRM_CUTOVER, { month: 10, year: 2026 }), false, "no date waives nothing");
  assert.equal(
    crmCutoverMonthDeductionNote({ month: 10, year: 2026 }),
    "CRM no-activity is not charged for October 2026, the month Phoenix replaced iReports360 (owner decision 18).",
  );

  const connector = read("src/lib/deductions/connectors/crm.ts");
  const body = connector.slice(connector.indexOf("export async function collectCrmCandidates"));
  const guard = body.indexOf("if (isCrmCutoverMonth(await readCrmCutoverSetting(), input)) return [];");
  assert.ok(guard > 0, "the CRM no-activity connector returns nothing for the cutover month");
  assert.equal(/\bawait\s/.test(body.slice(0, guard)), false, "the decision-18 guard runs before the connector reads anything");
  assert.equal(
    connector.includes("resolveVendorSyncStandDown") || connector.includes("getCrmCutoverSetting()"),
    false,
    "the connector reads the setting FRESH and fails CLOSED — never the cached, fail-open read the vendor pulls use",
  );

  const collect = read("src/lib/deductions/collect.ts");
  assert.ok(
    collect.includes('collector.key === "crm" ? await withCrmCutoverMonthNote(reconciled, { month, year }) : reconciled'),
    "the CRM collection result carries the decision-18 note, so a zero is never read as everyone active",
  );
}

function seriesBreakTests() {
  assert.equal(crmKpiSeriesBreak(NO_CRM_CUTOVER), null, "no date, no break");
  assert.deepEqual(crmKpiSeriesBreak(DATED), {
    cutoverDate: "2026-10-01",
    firstPhoenixMonth: { month: 10, year: 2026 },
    mixedMonth: false,
  });
  assert.equal(crmKpiSeriesBreak({ cutoverDate: "2026-10-15", vendorSyncRetiredAt: null })?.mixedMonth, true, "a mid-month date makes that month mixed");

  assert.equal(monthRangeCrossesCrmSeriesBreak(DATED, { month: 9, year: 2026 }, { month: 10, year: 2026 }), true);
  assert.equal(monthRangeCrossesCrmSeriesBreak(DATED, { month: 10, year: 2026 }, { month: 9, year: 2026 }), true, "order does not matter");
  assert.equal(monthRangeCrossesCrmSeriesBreak(DATED, { month: 10, year: 2026 }, { month: 11, year: 2026 }), false, "two Phoenix months are one series");
  assert.equal(monthRangeCrossesCrmSeriesBreak(DATED, { month: 8, year: 2026 }, { month: 9, year: 2026 }), false, "two vendor months are one series");
  assert.equal(monthRangeCrossesCrmSeriesBreak(DATED, { month: 12, year: 2025 }, { month: 1, year: 2027 }), true);
  assert.equal(monthRangeCrossesCrmSeriesBreak(NO_CRM_CUTOVER, { month: 1, year: 2020 }, { month: 1, year: 2030 }), false);
}

function readDoorTests() {
  const reads = read("src/lib/crm/reads.ts");
  assert.equal(
    /\.not\(\s*"agent_crm_id",\s*"in",\s*(?:excludedInList|options\.excludedInList)\s*\)/.test(reads),
    false,
    "no read door filters resigned agents on agent_crm_id — a native rep with no CRM id would vanish",
  );
  assert.equal(
    (reads.match(/\.from\(\s*CRM_VISITS_TABLE\s*\)/g) ?? []).length,
    2,
    "only the two IDENTITY reads (departed CRM ids, CRM identity rows) stay on the vendor visits table",
  );
  assert.equal(reads.includes("CRM_CHECKINS_TABLE"), false, "check-ins are read from the unified view only");
  assert.ok((reads.match(/\.from\(\s*CRM_CHECKINS_UNIFIED_VIEW\s*\)/g) ?? []).length >= 2, "both check-in reads use the unified view");

  const planBoard = read("src/lib/crm/plan-board.ts");
  assert.equal(
    (planBoard.match(/\.from\(\s*CRM_PLAN_ENTRIES_UNIFIED_VIEW\s*\)/g) ?? []).length,
    5,
    "all five plan-board reads use the unified view — the board summary's probe, its per-day keyset "
      + "scan and the single scan it keeps for a named-agent or month window, then one plan's entries "
      + "and the monthly planner's last-month reference. It was SIX from 2026-10-17 to 2026-10-18, when "
      + "the several reps' weeks a district manager reads for reps still in the old CRM were read here "
      + "too — and the view anti-joins every rep of a started team, so that read answered zero for every "
      + "rep it was built for (22 reps filed 17 Oct in the old CRM, 0 came through). It is a vendor-row "
      + "question now, one of the raw reads below. "
      + "It was THREE until 2026-10-10, when the "
      + "summary stopped OFFSET-paging a whole month and became the probe-then-days read (the window "
      + "sorted by an id the view synthesises, so every page rebuilt the month: 452.6 ms a page, "
      + "~17.1 s for 44 days, half of all database time left after the roster index). Raising this "
      + "number is only correct when the new site reads the UNIFIED VIEW — which is the whole point "
      + "of the guard. The four `.from(CRM_PLAN_ENTRIES_TABLE)` reads below it are deliberate and "
      + "separate: verification writes back to the vendor, so it resolves the plan's identity from "
      + "the vendor's own rows, and so does the read of what a rep filed in the old app.",
  );
  assert.equal(
    (planBoard.match(/\.from\(\s*CRM_PLAN_ENTRIES_TABLE\s*\)/g) ?? []).length,
    4,
    "the plan's identity (three reads) and the old-CRM weeks of reps already in a started team (one) read the vendor's own rows",
  );
  assert.ok(read("src/lib/crm/rep-doctor-lists.ts").includes(".from(CRM_PLAN_ENTRIES_UNIFIED_VIEW)"), "rep doctor lists read the unified plan view");
  const repsList = read("src/lib/crm/reps-list.ts");
  assert.equal((repsList.match(/\.from\(\s*CRM_CHECKINS_UNIFIED_VIEW\s*\)/g) ?? []).length, 2, "both reps-list check-in reads use the unified view");
  assert.equal(repsList.includes("CRM_CHECKINS_TABLE"), false);

  const repDay = read("src/lib/crm/rep-day.ts");
  assert.ok(repDay.includes(".from(CRM_VISITS_UNIFIED_VIEW)"), "the rep day's record read is the unified view");
  assert.ok(
    repDay.includes("!cutover.vendorSyncRetiredAt &&") && repDay.includes("!isOnOrAfterCrmCutover(cutover, day)"),
    "the rep day never asks the live vendor for a day Phoenix owns, nor once the vendor is retired",
  );

  for (const route of [
    "app/api/admin/field-workforce-compliance/visits/route.ts",
    "app/api/employee-portals/team-calendar/visits/route.ts",
  ]) {
    assert.equal(read(route).includes("isIReports360Configured"), false, `${route} serves the record without vendor credentials`);
  }
}

function standDownTests() {
  for (const route of [
    "app/api/cron/ireports360-visits-sync/route.ts",
    "app/api/cron/ireports360-visits-reconcile/route.ts",
    "app/api/cron/ireports360-visits-live-sync/route.ts",
    "app/api/cron/crm-contact-lists/route.ts",
  ]) {
    const source = read(route);
    const denied = source.indexOf("if (denied) return denied;");
    const standDown = source.indexOf("const standDown = await resolveVendorSyncStandDown();");
    assert.ok(denied > 0 && standDown > denied, `${route}: the stand-down runs after the cron secret is checked`);
    assert.ok(
      source.includes("if (standDown) return NextResponse.json({ reason: standDown, skipped: true });"),
      `${route}: a retired vendor answers skipped, not an error that pages`,
    );
    const config = source.indexOf("isIReports360Configured()");
    if (config > 0) assert.ok(standDown < config, `${route}: the stand-down comes before the credentials check`);
  }

  for (const route of [
    "app/api/crm/early-birds/sync/route.ts",
    "app/api/admin/visits-report/backfill/route.ts",
    "app/api/crm/rep-doctor-lists/sync/route.ts",
    "app/api/crm/plan-verification/verify/route.ts",
  ]) {
    const source = read(route);
    const standDown = source.indexOf("await resolveVendorSyncStandDown()");
    assert.ok(standDown > 0, `${route} asks whether the vendor is retired`);
    assert.ok(source.includes("VENDOR_SYNC_RETIRED_MESSAGE") && source.includes("status: 409"), `${route}: a retired vendor answers 409 with a plain message`);
    const config = source.indexOf("isIReports360Configured()");
    if (config > 0) assert.ok(standDown < config, `${route}: the stand-down comes before the credentials check`);
  }

  const verify = read("app/api/crm/plan-verification/verify/route.ts");
  const negative = verify.indexOf("if (Number.isInteger(crmPlanId) && crmPlanId < 0) {");
  assert.ok(negative > 0, "a Phoenix plan's negative id is refused by the iReports360 verify route");
  assert.ok(negative < verify.indexOf("crmPlanId <= 0"), "it is told apart from a malformed id before the 400");

  const poller = read("src/lib/crm/live-poller.ts");
  const tick = poller.slice(poller.indexOf("async function tick(): Promise<void> {"));
  const guard = tick.indexOf("if (await resolveVendorSyncStandDown()) return;");
  assert.ok(guard > 0, "the live poller's tick stands down once the vendor is retired");
  assert.equal(/\bawait\s/.test(tick.slice(0, guard)), false, "it stands down before any pull or ping");

  const retiredDescriptions = cronJobRegistry.filter((entry) =>
    JSON.stringify(entry).includes("Stands down (answers skipped) once the CRM cutover retires the vendor."),
  );
  assert.equal(retiredDescriptions.length, 3, "the three iReports360 registry entries say they stand down at the cutover");
  assert.equal(cronJobRegistry.length, 9, "no job was added to or dropped from the registry");
}

function housekeepingTests() {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  assert.equal(isProbationDvCaptureDue({ lastFailureMs: null, lastSuccessMs: null, nowMs: now }), true, "the first retired tick captures");
  assert.equal(
    isProbationDvCaptureDue({ lastFailureMs: null, lastSuccessMs: now - CRM_HOUSEKEEPING_PROBATION_DV_GAP_MS + 1, nowMs: now }),
    false,
    "not again inside six hours",
  );
  assert.equal(isProbationDvCaptureDue({ lastFailureMs: null, lastSuccessMs: now - CRM_HOUSEKEEPING_PROBATION_DV_GAP_MS, nowMs: now }), true);
  assert.equal(
    isProbationDvCaptureDue({ lastFailureMs: now - CRM_HOUSEKEEPING_RETRY_AFTER_FAILURE_MS + 1, lastSuccessMs: null, nowMs: now }),
    false,
    "a failure is not retried every tick",
  );
  assert.equal(isProbationDvCaptureDue({ lastFailureMs: now - CRM_HOUSEKEEPING_RETRY_AFTER_FAILURE_MS, lastSuccessMs: null, nowMs: now }), true, "but it is retried within the hour");

  const scheduler = read("src/lib/crm/housekeeping-scheduler.ts");
  assert.equal(scheduler.includes("isIReports360Configured"), false, "the capture outlives the vendor credentials");
  assert.ok(scheduler.includes("const hostRefusal = resolveInProcessHostRefusal();"), "it keeps the poller's host guards");
  assert.ok(scheduler.includes("unrefTimer(timer);"), "its timer never holds the process open");
  const runOnce = scheduler.slice(scheduler.indexOf("async function runOnce"));
  const standDown = runOnce.indexOf("if (!(await resolveVendorSyncStandDown())) return;");
  assert.ok(standDown > 0 && standDown < runOnce.indexOf("syncProbationDvDays("), "it captures only once the vendor is retired, when the poller no longer does");
  assert.ok(runOnce.includes("addDaysIso(today, -PROBATION_DV_LOOKBACK_DAYS)"), "it reads the same 45-day window the poller used");

  // The contact master outlives the vendor too (re-audit, 2026-10-22): its only callers were the poller and the
  // doctor-lists cron, so from the cutover a doctor a rep adds in Phoenix would never reach crm_contacts.
  const refreshAt = runOnce.indexOf("await refreshContactMasterAfterCutover();");
  assert.ok(standDown > 0 && refreshAt > standDown, "the contact master is refreshed only once the vendor is retired, when the poller no longer does");
  assert.ok(runOnce.includes("refreshCrmContactMaster({ includeActivity })"), "it runs the same refresh the poller and the cron ran");
  assert.ok(refreshAt < runOnce.indexOf("await captureProbationDvDays();"), "a refresh never blocks the capture: it never throws, and the capture runs after it");
  assert.equal(isContactMasterActivityDue({ cairoToday: "2026-10-22", lastActivityCairoDay: null }), true, "the first retired tick runs the activity pass");
  assert.equal(isContactMasterActivityDue({ cairoToday: "2026-10-22", lastActivityCairoDay: "2026-10-22" }), false, "once per Cairo day, not every tick");
  assert.equal(isContactMasterActivityDue({ cairoToday: "2026-10-23", lastActivityCairoDay: "2026-10-22" }), true, "and again the next day");

  // ONE timer across every process, and no refresh when nothing changed (owner, 2026-10-27, the afternoon
  // stalls): every process ran its own timer, so the 1.1 s refresh ran ~8 times an hour instead of 4.
  const leaseAt = runOnce.indexOf("if (!(await housekeepingLease.ensure())) return;");
  assert.ok(leaseAt > standDown && leaseAt < refreshAt, "the lease is claimed after the stand-down and before any refresh or capture");
  assert.ok(scheduler.includes("jobKey: CRM_HOUSEKEEPING_LEASE_KEY,"), "the lease is keyed on the housekeeping job");
  assert.equal(CRM_HOUSEKEEPING_LEASE_KEY, "crm-housekeeping");
  assert.ok(CRM_HOUSEKEEPING_LEASE_TTL_SECONDS * 1000 > CRM_HOUSEKEEPING_TICK_MS, "the lease outlives one tick, so its holder keeps it");
  const refreshFn = scheduler.slice(scheduler.indexOf("async function refreshContactMasterAfterCutover"));
  const stampAt = refreshFn.indexOf("await readCrmContactMasterInputsStamp()");
  assert.ok(stampAt > 0 && stampAt < refreshFn.indexOf("refreshCrmContactMaster({ includeActivity })"), "the stamp is read before the refresh, never after");
  assert.ok(
    refreshFn.indexOf("contactRefresh.lastStamp = stamp;") > refreshFn.indexOf('if (outcome.status === "refreshed")'),
    "only a refresh that landed records its stamp",
  );
  const due = { includeActivity: false, lastRefreshMs: now - 60_000, lastStamp: "a", nowMs: now, stamp: "a" };
  assert.equal(isContactMasterListRefreshDue(due), false, "the same inputs as the last refresh skip the tick");
  assert.equal(isContactMasterListRefreshDue({ ...due, stamp: "b" }), true, "a changed input refreshes");
  assert.equal(isContactMasterListRefreshDue({ ...due, includeActivity: true }), true, "the daily activity pass always runs");
  assert.equal(isContactMasterListRefreshDue({ ...due, stamp: null }), true, "an unreadable stamp refreshes as before");
  assert.equal(isContactMasterListRefreshDue({ ...due, lastStamp: null, lastRefreshMs: null }), true, "the first tick refreshes");
  assert.equal(
    isContactMasterListRefreshDue({ ...due, lastRefreshMs: now - CRM_CONTACT_MASTER_FORCE_REFRESH_MS }),
    true,
    "at least every two hours, whatever the stamp says",
  );
  const stampSql = read("supabase/migrations/20261027174307_crm_contact_master_inputs_stamp.sql");
  for (const input of [
    "(now() at time zone 'Africa/Cairo')::date",
    "public.crm_cutover",
    "public.phoenix_crm_customers",
    "public.phoenix_crm_doctor_list_reps()",
    "public.ireports360_contacts",
    "public.ireports360_crm_customer_brick_resolutions",
    "public.ireports360_crm_region_brick_resolutions",
  ]) {
    assert.ok(stampSql.includes(input), `the inputs stamp covers ${input}`);
  }

  const instrumentation = read("instrumentation.ts");
  const earlyBirds = instrumentation.indexOf('await import("@/lib/early-birds/close-scheduler")');
  const housekeeping = instrumentation.indexOf('await import("@/lib/crm/housekeeping-scheduler")');
  assert.ok(earlyBirds > 0 && housekeeping > earlyBirds, "the housekeeping timer starts at boot, in its own try block after Early Birds");
}

function vacationPersonKeyTests() {
  assert.equal(crmVacationPersonKey("1500", "B-10"), "1500", "a row with a CRM slot keys exactly as before");
  assert.equal(crmVacationPersonKey(1500, null), "1500");
  assert.equal(crmVacationPersonKey(null, "B-10"), `hr:${canonicalHrIdKey("B-10")}`, "a native rep with no CRM slot keys on his hr id");
  assert.equal(crmVacationPersonKey(null, "b-10"), crmVacationPersonKey("", "B-10"), "two spellings of one hr id are one person");
  assert.ok(crmVacationPersonKey(null, "B-10").startsWith("hr:"), "an hr key can never collide with a numeric slot");
  assert.equal(crmVacationPersonKey(null, null), "", "a row with neither is skipped");

  const source = read("src/lib/deductions/connectors/vacation.ts");
  assert.ok(source.includes("const dayKey = `${entry.personKey}:${day}`;"), "the mixed-day lookup uses the same key the work rows were stored under");
  assert.equal(source.includes("entry.crmId"), false);
}

export function runCrmCutoverTests() {
  migrationTests();
  settingTests();
  decision18Tests();
  seriesBreakTests();
  readDoorTests();
  standDownTests();
  housekeepingTests();
  vacationPersonKeyTests();
}
