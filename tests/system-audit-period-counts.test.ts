import assert from "node:assert/strict";

import { cairoCalendarDate, computePeriodCounts, selectPeriod, type PeriodOccurrence } from "../src/lib/system-audit/period-counts.ts";

/**
 * Columns 10 and 11 — "Occurrences for this employee" and "Unique vs Shared" — computed in
 * TypeScript the way `system_audit_page` computes them in SQL, for the file sink and the historical
 * runner. The rule both share: counted over the PERIOD, never over the rows a filter left.
 */

const SIG_A = "app:v1:aaaaaaaaaaaaaaaa";
const SIG_B = "app:v1:bbbbbbbbbbbbbbbb";

function occurrence(id: string, signatureKey: string, hrKey: string | null, occurredAt: string, extra: Partial<PeriodOccurrence> = {}): PeriodOccurrence {
  return { id, signatureKey, hrKey, occurredAt, ...extra };
}

export function runSystemAuditPeriodCountsTests() {
  // ── Cairo calendar days, not UTC ones ──────────────────────────────────────────────────────────
  // 22:30 UTC on 20 Oct is 01:30 on 21 Oct in Cairo (UTC+3 in October 2026).
  assert.equal(cairoCalendarDate("2026-10-20T22:30:00.000Z"), "2026-10-21", "a late-evening UTC row belongs to the NEXT Cairo day");
  assert.equal(cairoCalendarDate("2026-10-20T20:30:00.000Z"), "2026-10-20");

  const rows: PeriodOccurrence[] = [
    occurrence("1", SIG_A, "b-10", "2026-10-20T08:00:00.000Z"),
    occurrence("2", SIG_A, "b-10", "2026-10-20T09:00:00.000Z"),
    occurrence("3", SIG_A, "a-1", "2026-10-20T09:30:00.000Z"),
    occurrence("4", SIG_A, "c-3", "2026-10-20T22:30:00.000Z"), // 21 Oct in Cairo
    occurrence("5", SIG_A, null, "2026-10-20T10:00:00.000Z"),
    occurrence("6", SIG_B, "b-10", "2026-10-20T11:00:00.000Z"),
    occurrence("7", SIG_A, "test-b-10", "2026-10-20T11:30:00.000Z", { isTest: true }),
    // One lost visit seen in two modules: one correlation id, one operation.
    occurrence("8", SIG_B, "a-1", "2026-10-20T12:00:00.000Z", { correlationId: "visit-77" }),
    occurrence("9", SIG_B, "a-1", "2026-10-20T12:01:00.000Z", { correlationId: "visit-77" }),
  ];

  // ── The period: Cairo dates, test rows out unless asked ────────────────────────────────────────
  const day20 = selectPeriod(rows, { from: "2026-10-20", to: "2026-10-20" });
  assert.deepEqual(
    day20.map((row) => row.id),
    ["1", "2", "3", "5", "6", "8", "9"],
    "20 Oct in Cairo must hold its own rows, not the late-evening UTC one, and no test row",
  );
  assert.equal(selectPeriod(rows, { from: "2026-10-20", to: "2026-10-21" }).length, 8);
  assert.equal(selectPeriod(rows, { includeTest: true }).length, 9);

  // ── Column 10: operations per person per signature ─────────────────────────────────────────────
  const counts = computePeriodCounts(day20);
  assert.equal(counts.personOps(SIG_A, "b-10"), 2);
  assert.equal(counts.personOps(SIG_A, "a-1"), 1);
  assert.equal(counts.personOps(SIG_B, "a-1"), 1, "one correlation id seen twice is ONE operation");
  assert.equal(counts.personOps(SIG_A, null), 1, "the system rows form their own group");
  assert.equal(counts.personOps(SIG_A, "nobody"), 0);

  // ── Column 11: people per signature, a system row is never an employee ─────────────────────────
  assert.equal(counts.people(SIG_A), 2, "a NULL hr_key must not be counted as an employee");
  assert.equal(counts.scopeLabel(SIG_A, "b-10"), "SHARED — 2 EMPLOYEES AFFECTED");
  assert.equal(counts.scopeLabel(SIG_B, "b-10"), "SHARED — 2 EMPLOYEES AFFECTED");
  assert.equal(counts.scopeLabel(SIG_A, null), "SYSTEM — NO EMPLOYEE ATTRIBUTION");

  const onlyOne = computePeriodCounts([occurrence("x", SIG_A, "b-10", "2026-10-20T08:00:00.000Z")]);
  assert.equal(onlyOne.scopeLabel(SIG_A, "b-10"), "UNIQUE — ONLY THIS EMPLOYEE");

  // ── Over the PERIOD, never the filtered rows ───────────────────────────────────────────────────
  // Filtering the page down to one person must not turn SHARED into UNIQUE: the caller counts the
  // whole period and only DISPLAYS the filtered rows.
  const filteredToOne = day20.filter((row) => row.hrKey === "b-10");
  assert.equal(counts.scopeLabel(SIG_A, filteredToOne[0].hrKey), "SHARED — 2 EMPLOYEES AFFECTED");
  assert.equal(
    computePeriodCounts(filteredToOne).scopeLabel(SIG_A, "b-10"),
    "UNIQUE — ONLY THIS EMPLOYEE",
    "counting the filtered rows gives the WRONG answer — which is why the period is passed instead",
  );
}
