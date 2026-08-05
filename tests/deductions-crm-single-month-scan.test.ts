import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { collectLeaverCrmCandidate } from "../src/lib/deductions/connectors/crm.ts";

/**
 * THE CRM CONNECTOR MUST SCAN THE VISIT MIRROR ONCE PER RUN, NOT ONCE PER LEAVER.
 *
 * Owner-reported 2026-08-05: a monthly collection run reported "1 connector(s) failed"
 * with no warning attached. A connector that THROWS is caught and downgraded to a
 * warning, so a bare failure means the HTTP request itself died — and the connector
 * was `crm`.
 *
 * Cause: `collectLeaverCrmCandidate` ran its own `scanVisitsForRangeIncludingDeparted`,
 * and so did `loadZeroCrmSignalHrIdKeys`. Neither read is employee-filtered — each
 * pulled the ENTIRE company's visits for the range and then discarded all but one
 * person's in the `isMine` filter. Measured on July 2026 production:
 *
 *   18,544 visit rows in the month
 *   keyset pagination at 1,000/page      => 19 sequential round trips per scan
 *   10 leavers + 1 zero-signal check     => 11 scans, ~209 round trips
 *   Railway `sfo` -> Supabase `eu-central-1` => every one crosses the Atlantic
 *   Postgres answers the month in 61 ms  => the cost was latency, not query work
 *
 * The fix hoists ONE month-wide scan into `collectCrmCandidates` and passes it down,
 * which is only safe because a wider window cannot change any leaver's answer. That
 * is the property pinned here — not the speed, which no unit test can observe.
 */

type Visit = {
  visit_date: string | null;
  visit_type: number | null;
  agent_hr_id: string | null;
  double_hr_id: string | null;
  agent_crm_id: string | null;
  double_crm_id: string | null;
};

function visit(overrides: { date: string; hrId?: string | null; crmId?: string | null }): Visit {
  return {
    visit_date: overrides.date,
    visit_type: 1,
    agent_hr_id: overrides.hrId ?? null,
    double_hr_id: null,
    agent_crm_id: overrides.crmId ?? null,
    double_crm_id: null,
  };
}

const LEAVER = {
  hrId: "B-1",
  crmId: "77",
  jobTitle: "Medical Rep",
  hireDate: null,
  // Settles on the 10th, so 11-31 July is outside this person's span entirely.
  lastWorkingDate: "2026-07-10",
  month: 7,
  year: 2026,
  // 31,000 over a 31-day month = a clean 1,000 EGP/day, so a wrong day count is
  // visible in the money rather than hidden by rounding.
  baseSalary: 31000,
};

export function runDeductionsCrmSingleMonthScanTests() {
  const holidayDates = new Set<string>();

  // The leaver's own visits, inside the settlement span.
  const inSpan = [visit({ date: "2026-07-02", hrId: "B-1" }), visit({ date: "2026-07-06", hrId: "B-1" })];

  // ---- A WIDER WINDOW MUST NOT CHANGE THE ANSWER ---------------------------
  // This is the whole justification for sharing one month-wide scan: the only
  // consumer of the per-day index is the loop bounded to [loopStart, loopEnd], so
  // days outside the settlement span are never consulted.
  const spanOnly = collectLeaverCrmCandidate({ ...LEAVER, monthVisits: inSpan, holidayDates });
  const monthWide = collectLeaverCrmCandidate({
    ...LEAVER,
    monthVisits: [
      ...inSpan,
      // Same person, AFTER their last working day — must not extend or reduce the charge.
      visit({ date: "2026-07-20", hrId: "B-1" }),
      visit({ date: "2026-07-25", hrId: "B-1" }),
    ],
    holidayDates,
  });

  assert.ok(spanOnly, "the fixture must produce a candidate, otherwise this test proves nothing");
  assert.deepEqual(
    monthWide?.dates,
    spanOnly.dates,
    "widening the visit window must not change which days are charged — this is what makes ONE shared month scan equivalent to a per-leaver scan",
  );
  assert.equal(
    monthWide?.rawValue,
    spanOnly.rawValue,
    "a leaver's post-settlement visits must never alter their flagged-day count",
  );
  assert.equal(
    monthWide?.estimatedAmount,
    spanOnly.estimatedAmount,
    "and therefore must never alter the money",
  );

  // ---- ONE SHARED ARRAY MUST NOT LET EMPLOYEES CONTAMINATE EACH OTHER -------
  // The shared scan now carries every employee's rows, where the old per-leaver
  // scan happened to as well — but this is the failure that would be silent and
  // expensive: another rep's visit suppressing this leaver's no-activity day.
  const everyDayCoveredByOthers: Visit[] = [];
  for (let day = 1; day <= 10; day += 1) {
    everyDayCoveredByOthers.push(
      visit({ date: `2026-07-${String(day).padStart(2, "0")}`, hrId: "B-999", crmId: "999" }),
    );
  }
  const withOtherPeople = collectLeaverCrmCandidate({
    ...LEAVER,
    monthVisits: [...inSpan, ...everyDayCoveredByOthers],
    holidayDates,
  });
  assert.deepEqual(
    withOtherPeople?.dates,
    spanOnly.dates,
    "another employee's visits must never cover this leaver's days — the isMine filter is what makes a shared scan safe",
  );

  // A visit matched by CRM id rather than hr-id still counts as the leaver's own.
  const byCrmId = collectLeaverCrmCandidate({
    ...LEAVER,
    monthVisits: [...inSpan, visit({ date: "2026-07-07", crmId: "77" })],
    holidayDates,
  });
  assert.ok(
    (byCrmId?.dates.length ?? 0) < spanOnly.dates.length,
    "a visit carrying only the leaver's crm_id must still clear that day — an unresolved agent_hr_id is common in the mirror",
  );

  // A confirmed holiday inside the span is never charged.
  const overHoliday = collectLeaverCrmCandidate({
    ...LEAVER,
    monthVisits: inSpan,
    holidayDates: new Set(spanOnly.dates.slice(0, 1)),
  });
  assert.equal(
    overHoliday?.dates.length,
    spanOnly.dates.length - 1,
    "a national holiday inside the settlement span must drop out of the charge",
  );

  // ---- THE N+1 MUST NOT COME BACK ------------------------------------------
  // A source-level guard because the regression is invisible to any behavioural
  // test: re-introducing a per-leaver scan changes nothing about the RESULT, only
  // how many cross-Atlantic round trips it takes to get there.
  const connectorSource = readFileSync(
    new URL("../src/lib/deductions/connectors/crm.ts", import.meta.url),
    "utf8",
  );
  const scanCalls = connectorSource.match(/scanVisitsForRangeIncludingDeparted</g) ?? [];
  assert.equal(
    scanCalls.length,
    1,
    `crm.ts must call scanVisitsForRangeIncludingDeparted exactly ONCE (found ${scanCalls.length}) — one company-wide month scan shared by every leaver and by the zero-signal check, never one per employee`,
  );
  assert.ok(
    !/for \(const employeeRow[\s\S]{0,600}?await collectLeaverCrmCandidate/.test(connectorSource),
    "the per-leaver loop must stay free of awaited I/O — that loop is what serialised 10 company-wide scans",
  );
}
