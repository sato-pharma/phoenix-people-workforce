import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  dedupeByKey,
  isValidIsoDate,
  mapVisitRow,
  resolveWideReconciliationSlice,
  rowFromVisit,
  WIDE_RECONCILIATION_SLICE_DAYS,
  WIDE_RECONCILIATION_TOTAL_DAYS,
} from "../src/lib/visits-report/service.ts";
import type { IReports360Visit } from "../src/lib/field-workforce-compliance/ireports360-client.ts";

// Structural stand-in for CrmIdentityMaps (not exported from service.ts — same technique the
// double-visit-analytics test file uses via `Parameters<typeof ...>` to avoid a test-only export).
type CrmIdentityMaps = Parameters<typeof rowFromVisit>[1];

function emptyMaps(): CrmIdentityMaps {
  return {
    hrIdByCrmId: new Map(),
    hrIdByCrmUsername: new Map(),
    hrIdByManualOverride: new Map(),
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
    customerName: null,
    doubleID: null,
    doubleName: null,
    id: 1,
    saveDate: null,
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
  const service = readFileSync("src/lib/visits-report/service.ts", "utf8");
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
  assert.match(service, /lookbackDays = 21/, "daily cron's lookback must be widened from the original 10 days");
  assert.equal(WIDE_RECONCILIATION_TOTAL_DAYS, 120, "wide reconciliation's total window must be materially larger than the daily cron's");

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

  const vercelConfig = readFileSync("vercel.json", "utf8");
  assert.match(vercelConfig, /ireports360-visits-reconcile/, "the new cron route must be scheduled in vercel.json");
}
