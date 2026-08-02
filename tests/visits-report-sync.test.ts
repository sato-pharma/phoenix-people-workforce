import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  dedupeByKey,
  isValidIsoDate,
  resolveWideReconciliationSlice,
  rowFromVisit,
  selectCheckinsToGeocode,
  WIDE_RECONCILIATION_SLICE_DAYS,
  WIDE_RECONCILIATION_TOTAL_DAYS,
  type CheckinDraftRow,
} from "../src/lib/crm/sync.ts";
import { mapVisitRow } from "../src/lib/crm/reads.ts";
import type { IReports360Visit } from "../src/lib/crm/client.ts";

// Structural stand-in for CrmIdentityMaps (not exported from service.ts — same technique the
// double-visit-analytics test file uses via `Parameters<typeof ...>` to avoid a test-only export).
type CrmIdentityMaps = Parameters<typeof rowFromVisit>[1];

function emptyMaps(): CrmIdentityMaps {
  return {
    hrIdByCrmId: new Map(),
    hrIdByCrmUsername: new Map(),
    hrIdByManualOverride: new Map(),
    // Empty = nobody has a last working date, so the post-exit attribution guard never fires and
    // these fixtures keep testing the row shape rather than the guard (which has its own suite).
    lastWorkingDateByHrId: new Map(),
    // Same reasoning: with no last working date the guard returns before it ever consults a label.
    crmUsernameByHrId: new Map(),
  };
}

function checkinDraft(overrides: Partial<CheckinDraftRow> = {}): CheckinDraftRow {
  return {
    address: null,
    agent_crm_id: 100,
    agent_hr_id: "M-1",
    check_date: "2026-07-01T10:00:00",
    contact_crm_id: null,
    contact_name: null,
    crm_checkin_id: 1,
    lat: 30.0444,
    lon: 31.2357,
    raw_payload: {},
    synced_at: "2026-07-01T10:05:00Z",
    updated_at: "2026-07-01T10:05:00Z",
    ...overrides,
  };
}

function visit(overrides: Partial<IReports360Visit> = {}): IReports360Visit {
  return {
    agentID: 100,
    agentName: "Some Rep",
    ampm: "AM",
    attendance: null,
    callType: null,
    comment: null,
    contactID: null,
    contactName: null,
    contactGrade: null,
    customerName: null,
    doubleID: null,
    doubleName: null,
    id: 1,
    region: null,
    regionID: null,
    saveDate: null,
    speciality: null,
    visitDate: "2026-07-01",
    visitType: 0,
    visitTypeDescription: "Regular Visit",
    ...overrides,
  };
}

export function runVisitsReportSyncTests() {
  // ── isValidIsoDate ────────────────────────────────────────────────────────────────
  assert.equal(isValidIsoDate("2026-07-04"), true);
  assert.equal(isValidIsoDate(""), false, "empty string (from a null-guarded visitDate) is invalid");
  assert.equal(isValidIsoDate("07/04/2026"), false, "wrong format is rejected");

  // ── dedupeByKey: last-wins by a given key ────────────────────────────────────────
  const deduped = dedupeByKey(
    [{ id: 1, tag: "first" }, { id: 2, tag: "only" }, { id: 1, tag: "second-wins" }],
    (row) => row.id,
  );
  assert.equal(deduped.length, 2, "two distinct ids survive, the duplicate collapses");
  assert.equal(deduped.find((row) => row.id === 1)?.tag, "second-wins", "last occurrence wins for a repeated key");

  // ── selectCheckinsToGeocode: check-in address backfill decision logic ───────────
  // A row with a real vendor-supplied address is never touched or selected.
  const hasAddress = checkinDraft({ address: "Real Address, Cairo" });
  const skipHasAddress = selectCheckinsToGeocode([hasAddress], new Map(), 10);
  assert.equal(skipHasAddress.length, 0, "a row that already has a real address is never selected for geocoding");
  assert.equal(hasAddress.address, "Real Address, Cairo", "and its address is left untouched");

  // A row missing coordinates can never be geocoded, regardless of address state.
  const noCoords = checkinDraft({ address: null, lat: null, lon: null });
  assert.equal(selectCheckinsToGeocode([noCoords], new Map(), 10).length, 0, "a row with no lat/lon is never selected");

  // A row missing an address, with coordinates, and NO prior known address: needs a fresh geocode.
  const freshCandidate = checkinDraft({ crm_checkin_id: 42, address: "" });
  const freshResult = selectCheckinsToGeocode([freshCandidate], new Map(), 10);
  assert.equal(freshResult.length, 1, "a never-before-seen check-in missing an address needs a fresh geocode");
  assert.equal(freshResult[0].crm_checkin_id, 42);

  // A row missing an address, but this crm_checkin_id already resolved to a known address on a
  // PRIOR sync: reuse it in place, never call Google again for the same check-in.
  const alreadyKnown = checkinDraft({ crm_checkin_id: 99, address: null });
  const existingById = new Map([[99, "Previously Resolved Address"]]);
  const reuseResult = selectCheckinsToGeocode([alreadyKnown], existingById, 10);
  assert.equal(reuseResult.length, 0, "a check-in with a known prior address is never re-selected for geocoding");
  assert.equal(alreadyKnown.address, "Previously Resolved Address", "its address is filled in from the prior resolution");

  // The per-run cap: only the first `cap` never-before-seen rows are selected; the rest are left
  // for a later sync run rather than risking this run's own time/cost budget.
  const manyCandidates = Array.from({ length: 5 }, (_, i) => checkinDraft({ crm_checkin_id: 200 + i, address: null }));
  const capped = selectCheckinsToGeocode(manyCandidates, new Map(), 2);
  assert.equal(capped.length, 2, "the cap must bound how many rows are selected in one run, regardless of how many need it");

  // ── rowFromVisit: null-guard on visitDate ────────────────────────────────────────
  const maps = emptyMaps();
  const nullDateVisit = visit({ visitDate: null as unknown as string });
  const nullDateRow = rowFromVisit(nullDateVisit, maps);
  assert.equal(nullDateRow.visit_date, "", "a null visitDate never throws — it guards to an empty string");
  assert.equal(isValidIsoDate(nullDateRow.visit_date), false, "and that empty string is correctly flagged invalid, not silently upserted");

  const goodDateRow = rowFromVisit(visit({ visitDate: "2026-07-04T10:30:00Z" }), maps);
  assert.equal(goodDateRow.visit_date, "2026-07-04", "a real visitDate still slices to YYYY-MM-DD as before");
  assert.equal(isValidIsoDate(goodDateRow.visit_date), true);

  // rowFromVisit still carries attendance/crm_save_date through to the DB-row shape (items 5/6's
  // write side — the read side is covered by the mapVisitRow round-trip below).
  const attendanceRow = rowFromVisit(visit({ attendance: 2, saveDate: "2026-07-02T08:00:00Z" }), maps);
  assert.equal(attendanceRow.attendance, 2);
  assert.equal(attendanceRow.crm_save_date, "2026-07-02T08:00:00Z");

  // ── mapVisitRow: attendance + crmSaveDate round-trip (items 5 & 6) ───────────────
  const dbRow = {
    agent_crm_id: 100,
    agent_hr_id: "M-1",
    agent_name: "Some Rep",
    ampm: "AM",
    attendance: 1,
    call_type: null,
    comment: null,
    contact_name: null,
    crm_save_date: "2026-06-20T09:00:00Z",
    crm_visit_id: 555,
    customer_name: null,
    double_crm_id: null,
    double_hr_id: null,
    double_name: null,
    id: "row-uuid",
    visit_date: "2026-07-01",
    visit_date_time: "2026-07-01T09:00:00Z",
    visit_type: 0,
    visit_type_description: "Regular Visit",
  };
  const mapped = mapVisitRow(dbRow);
  assert.equal(mapped.attendance, 1, "attendance is read back into VisitsReportRow, not dropped");
  assert.equal(mapped.crmSaveDate, "2026-06-20T09:00:00Z", "crmSaveDate round-trips unchanged");

  const mappedNullAttendance = mapVisitRow({ ...dbRow, attendance: null });
  assert.equal(mappedNullAttendance.attendance, null, "a null attendance stays null, not NaN/0");

  // ── Item 1 (delete-reconciliation) + item 2 (wide reconciliation): structural checks ──
  // Live-Supabase-dependent behavior isn't unit-testable without a mocked client (none exists
  // in this repo yet) — lock in the critical safety invariants as static source assertions,
  // matching the established pattern in tests/double-visit-analytics.test.ts.
  const service = readFileSync("src/lib/crm/sync.ts", "utf8");
  assert.match(
    service,
    /if \(dedupedVisitRows\.length > 0\) \{/,
    "delete-reconciliation must be gated on a non-empty fetch — never treat zero fetched as zero exists",
  );
  assert.match(
    service,
    /staleIds\.length \/ existingIds\.length > 0\.5/,
    "delete-reconciliation must have a sanity cap against a partial/truncated fetch masquerading as real deletions",
  );
  assert.match(service, /export async function runWideIReports360Reconciliation/, "wide reconciliation function must exist");
  // 2026-07-08: reverted 21 -> 10 (the pre-#796 value) after Sentry recorded 2 consecutive
  // "ireports360-visits-sync" timeout check-ins in one morning — the weekly wide-reconciliation
  // cron already exists to catch anything older than this window within a week, not lost.
  assert.doesNotMatch(service, /lookbackDays = 21/, "the 21-day lookback that caused the 2026-07-08 timeout must not regress");
  assert.match(service, /lookbackDays = 10/, "daily cron's lookback must be back at the pre-#796 10-day window");
  assert.equal(WIDE_RECONCILIATION_TOTAL_DAYS, 120, "wide reconciliation's total window must be materially larger than the daily cron's");

  // ── Check-in address backfill: wiring that isn't unit-testable without a mocked Supabase
  // client — locked in as static source assertions (same established pattern as above).
  assert.match(
    service,
    /await backfillMissingCheckinAddresses\(supabase, checkinRowsForUpsert\);/,
    "the address backfill must run on the exact check-in rows being upserted this run",
  );
  // The live poller narrows the UPSERT arrays to its changed-row delta (filterRowsToUpsert) —
  // but delete-reconciliation MUST keep deriving its fresh-id sets from the deduped FULL fetch,
  // or every unchanged row would look absent from the CRM and be deleted as stale.
  assert.match(
    service,
    /const freshIds = new Set\(dedupedVisitRows\.map\(\(row\) => row\.crm_visit_id\)\);/,
    "visit reconciliation must build its fresh-id set from the full deduped fetch, never the (possibly delta-narrowed) upsert array",
  );
  assert.match(
    service,
    /const freshCheckinIds = new Set\(dedupedCheckinRows\.map\(\(row\) => row\.crm_checkin_id\)\);/,
    "check-in reconciliation must build its fresh-id set from the full deduped fetch, never the (possibly delta-narrowed) upsert array",
  );
  assert.match(
    service,
    /if \(!hasLocationIqKey\(\) && !hasGoogleServerKey\(\)\) return;/,
    "the backfill must no-op entirely when neither LocationIQ nor Google is configured, never throw",
  );

  // ── resolveWideReconciliationSlice: stateless weekly slice rotation (2026-07-06 timeout fix) ──
  // A single 120-day reconciliation run got killed mid-run (see the doc comment on
  // runWideIReports360Reconciliation) — it's now split into 4 stateless 30-day slices, one per
  // week, chosen purely from the ISO week number so no persisted "last slice" state is needed.
  assert.equal(
    Math.ceil(WIDE_RECONCILIATION_TOTAL_DAYS / WIDE_RECONCILIATION_SLICE_DAYS),
    4,
    "120 total days / 30-day slices must divide into exactly 4 slices",
  );

  const weeklySamples = Array.from({ length: 4 }, (_, i) =>
    resolveWideReconciliationSlice(new Date(Date.UTC(2026, 6, 6 + i * 7))), // 4 consecutive Mondays
  );
  const seenSliceIndices = new Set(weeklySamples.map((slice) => slice.sliceIndex));
  assert.equal(
    seenSliceIndices.size,
    4,
    "4 consecutive weeks must rotate through all 4 distinct slices, never repeat one early or skip one",
  );

  weeklySamples.forEach((slice, i) => {
    const now = new Date(Date.UTC(2026, 6, 6 + i * 7));
    const today = now.toISOString().slice(0, 10);
    const spanDays = Math.round(
      (Date.parse(`${slice.dateTo}T00:00:00Z`) - Date.parse(`${slice.dateFrom}T00:00:00Z`)) / 86_400_000,
    );
    assert.equal(spanDays, WIDE_RECONCILIATION_SLICE_DAYS, "every slice must cover exactly one slice-width of days");
    const offsetDays = Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${slice.dateTo}T00:00:00Z`)) / 86_400_000,
    );
    assert.equal(
      offsetDays,
      slice.sliceIndex * WIDE_RECONCILIATION_SLICE_DAYS,
      "dateTo must sit exactly sliceIndex slice-widths before today, so the 4 possible slices tile the full 120-day window with no gaps or overlaps",
    );
  });

  const rerun = resolveWideReconciliationSlice(new Date(Date.UTC(2026, 6, 6)));
  assert.deepEqual(
    rerun,
    weeklySamples[0],
    "resolveWideReconciliationSlice must be a pure function of `now` — a retried run must pick the same slice, not a different one",
  );

  assert.ok(
    existsSync("app/api/cron/ireports360-visits-reconcile/route.ts"),
    "the new wide-reconciliation cron route file must exist",
  );

  const accessRegistry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(
    accessRegistry,
    /\/api\/cron\/ireports360-visits-reconcile/,
    "the new cron route must be registered — tests/access-registry-coverage.test.ts hard-fails on any unregistered app/api route",
  );

  
  

  // ── reapStaleIReports360SyncRuns: reaps sync_runs rows the platform killed mid-flight before
  // their own catch block could mark them "failed" (2026-07-05 incident — a killed run sat at
  // status="running" for ~17h until manually corrected). Mirrors reapStaleProcessingOutboxRows.
  const serviceSource = readFileSync("src/lib/crm/sync.ts", "utf8");
  assert.match(serviceSource, /export async function reapStaleIReports360SyncRuns/, "a reaper for stuck sync runs must exist");
  assert.match(serviceSource, /\.eq\("status", "running"\)/, "the reaper must only touch rows still marked running");
  assert.match(serviceSource, /\.lt\("started_at", threshold\.toISOString\(\)\)/, "the reaper must only touch rows older than its staleness threshold, never an in-flight run");

  const scheduledProcessingSource = readFileSync("src/lib/notifications/scheduled-processing.ts", "utf8");
  assert.match(
    scheduledProcessingSource,
    /reapStaleIReports360SyncRuns\(\)/,
    "the reaper must be wired into the every-30-min notification-process cron, the only one frequent enough to catch a stuck row promptly",
  );

  // Deeper audit finding D: the probation DV auto-tick failure was fully swallowed with no
  // logging (even though the route already has an outer console.error, it never got
  // a chance to fire since the inner catch always absorbed the error first).
  const syncRouteSource = readFileSync("app/api/cron/ireports360-visits-sync/route.ts", "utf8");
  assert.doesNotMatch(
    syncRouteSource,
    /tickDvCheckboxesFromSync\(dateFrom, dateTo\)\.catch\(\(\) => undefined\);/,
    "the DV-tick failure must not be swallowed without logging",
  );
  assert.match(
    syncRouteSource,
    /tickDvCheckboxesFromSync\(dateFrom, dateTo\)\.catch\(\(error: unknown\) => \{\s*console\.error\(error, \{ tags: \{ cron: "ireports360-visits-sync-dv-tick" \} \}\);\s*\}\);/,
    "a failed DV-tick must still be reported to Sentry, isolated from the otherwise-successful visits sync",
  );

  // Fix #10: the WIDE reconcile must ALSO feed probation — a DV landed >10 days old (past the daily
  // sync's window) reaches probation only here; otherwise it shows in DV Analytics but never on a
  // probation checkbox. Both steps run over the reconcile's own slice window, each isolated so a
  // probation failure can't fail the reconcile.
  const reconcileRouteSource = readFileSync("app/api/cron/ireports360-visits-reconcile/route.ts", "utf8");
  assert.match(
    reconcileRouteSource,
    /tickDvCheckboxesFromSync\(dateFrom, dateTo\)\.catch\(/,
    "the wide reconcile must run the DV-checkbox tick over its slice window (isolated with .catch)",
  );
  assert.match(
    reconcileRouteSource,
    /syncProbationDvDays\(getSupabaseAdmin\(\), \{ dateFrom, dateTo \}\)\.catch\(/,
    "the wide reconcile must run the probation DV-day sync over its slice window (isolated with .catch)",
  );

  // Fix #8: tickDvCheckboxesFromSync builds hr-id lists via normalizeHrId (lowercase) but
  // app_auth_users / employees store hr_id UPPERCASE and PostgREST .in is case-sensitive — it must
  // expand every casing variant (hrIdLookupKeys), or every role/DM lookup returns [] and NO checkbox
  // ever ticks (a silent no-op).
  const feedbackServiceSource = readFileSync("src/lib/probation/feedback-service.ts", "utf8");
  assert.match(
    feedbackServiceSource,
    /\.in\("hr_id", Array\.from\(new Set\(visitorHrIds\.flatMap\(hrIdLookupKeys\)\)\)\)/,
    "the app_auth_users role lookup must expand hr-id casing variants so the case-sensitive .in matches",
  );
  assert.match(
    feedbackServiceSource,
    /\.in\("hr_id", Array\.from\(new Set\(probationVisited\.flatMap\(hrIdLookupKeys\)\)\)\)/,
    "the employees DM lookup must expand hr-id casing variants so the case-sensitive .in matches",
  );

  // Fix B (2026-07-18 data-fidelity audit): the legacy checkbox auto-tick must apply the SAME
  // probation-window gate as the authoritative probation_dv_days path — a DV outside the
  // employee's window [hire_date, probation_end_date] must NOT tick a checkbox that DV-Day
  // validation would reject as outside_probation_window (they diverged silently before).
  assert.match(
    feedbackServiceSource,
    /import \{ withinWindow \} from "\.\/intelligence\/dv-validation";/,
    "the checkbox tick must reuse the DV-Day validation window predicate (one source of window semantics)",
  );
  assert.match(
    feedbackServiceSource,
    /withinWindow\(dvRow\.visit_date, empByHrId\.get\(visitedHrId\)\?\.hire_date \?\? null, probRecord\.probation_end_date\)/,
    "each DV must be window-gated against the employee's probation window before ticking a checkbox",
  );
  // Fix B (deeper, 2026-07-18): PM/GPM checkbox tick must skip the CNS line the SAME way
  // probation_dv_days does (dv-validation keys on line_name === 'cns'), not only via the legacy
  // NULL-column sentinel — so the two can't disagree on whether a PM/GPM DV counts.
  assert.match(
    feedbackServiceSource,
    /const isCns = String\(visitedEmp\?\.line_name \?\? ""\)\.trim\(\)\.toLowerCase\(\) === "cns";/,
    "PM/GPM checkbox tick must determine CNS via line_name, matching probation_dv_days",
  );
}
