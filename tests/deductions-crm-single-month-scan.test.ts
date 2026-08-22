import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  collectLeaverCrmCandidate,
  computeZeroCrmSignalKeys,
  holidayDatesFromResult,
} from "../src/lib/deductions/connectors/crm.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

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
  // Plain string slicing, deliberately not a regex. The previous form used
  // `[\s\S]{0,600}?` — a lazy quantifier over match-anything, which is the shape
  // SonarQube raises as a ReDoS security hotspot (S5852). A hotspot can only be
  // cleared by a human marking it reviewed in the SonarCloud UI, so a scanner can
  // never satisfy the "Security Hotspots Reviewed = 100%" gate condition on its
  // own — it blocked this PR outright. The slice says the same thing more plainly.
  const loopAt = connectorSource.indexOf("for (const employeeRow");
  // Anchor must exist, or the check below inspects an empty string and passes
  // vacuously — proving nothing while looking green.
  assert.notEqual(
    loopAt,
    -1,
    "the per-leaver loop was not found in crm.ts — if it was renamed, this guard is inspecting nothing and must be re-pointed",
  );
  // Bound the loop by its own closing brace, not by 600 bytes. The loop body runs past 1,000
  // bytes, so the byte window stopped around the `collectLeaverCrmCandidate({` call and never
  // reached the lines below it — an awaited call re-added at the bottom of the loop would have
  // sailed straight through this guard.
  const loopEnd = connectorSource.slice(loopAt).search(/^ {4}\}$/m);
  const loopWindow = connectorSource.slice(loopAt, loopEnd >= 0 ? loopAt + loopEnd : connectorSource.length);
  assert.ok(
    !loopWindow.includes("await collectLeaverCrmCandidate"),
    "the per-leaver loop must stay free of awaited I/O — that loop is what serialised 10 company-wide scans",
  );

  // ---- THE ZERO-CRM-SIGNAL EXCLUSION ---------------------------------------
  // An employee whose crm_id logged NOTHING all month is a data-mapping gap, not
  // an absence — flagging them charges essentially their whole working month.
  // Measured July 2026: A-9 (20 days, 30,967.74 EGP) and A-8 (16 days,
  // 22,193.55 EGP), both at work and punching in, neither logging CRM visits.
  // 2026-08-05 it did it again to B-112, a leaver with crm_id NULL, on his last day.
  const zero = computeZeroCrmSignalKeys({
    employeeRows: [
      { hr_id: "B-1", job_title: "Medical Rep", crm_id: "11" }, // has visits by crm_id
      { hr_id: "B-2", job_title: "Medical Rep", crm_id: "22" }, // no signal at all
      { hr_id: "B-3", job_title: "Medical Rep", crm_id: null }, // unmapped -> never any signal
      { hr_id: "B-4", job_title: "Medical Rep", crm_id: "44" }, // named by resolved hr-id only
      { hr_id: "A-1", job_title: "Chief Executive Officer", crm_id: null }, // not FWC-eligible
    ],
    visits: [
      { visit_date: "2026-07-02", visit_type: 1, agent_hr_id: null, double_hr_id: null, agent_crm_id: "11", double_crm_id: null },
      { visit_date: "2026-07-03", visit_type: 1, agent_hr_id: "B-4", double_hr_id: null, agent_crm_id: null, double_crm_id: null },
    ],
  });
  // The set is keyed CANONICALLY (canonicalHrIdKey lowercases), so asserting on the
  // raw "B-2" silently passes every negative check while proving nothing. Resolve the
  // key the same way the implementation does.
  const key = (hrId: string) => canonicalHrIdKey(hrId) ?? hrId;
  assert.ok(!zero.has(key("B-1")), "a visit matching by crm_id is signal — this employee uses the CRM and stays in scope");
  assert.ok(!zero.has(key("B-4")), "a visit matching by resolved agent_hr_id is signal too — agent_hr_id is often null, so both identities must count");
  assert.ok(zero.has(key("B-2")), "an eligible employee with a crm_id and zero visits all month has no usable signal and must be excluded");
  assert.ok(
    zero.has(key("B-3")),
    "an employee with NO crm_id can never produce a positive signal — this is the B-112 case that charged a leaver 451.61 EGP on his final settlement",
  );
  assert.ok(!zero.has(key("A-1")), "a non-field-workforce title is out of scope entirely and must never enter the exclusion set");
  // Guards the guard: if the set ever stopped being canonical, every negative
  // assertion above would pass vacuously and this test would prove nothing.
  assert.ok(
    [...zero].every((k) => k === k.toLowerCase()),
    "the zero-signal set must hold canonical (lower-cased) hr-id keys — a raw-cased key never matches the callers that look it up",
  );

  // A visit naming someone as the DOUBLE (a manager riding along) is their signal too.
  const zeroDouble = computeZeroCrmSignalKeys({
    employeeRows: [{ hr_id: "B-9", job_title: "District Manager", crm_id: "99" }],
    visits: [
      { visit_date: "2026-07-02", visit_type: 1, agent_hr_id: "B-1", double_hr_id: "B-9", agent_crm_id: "11", double_crm_id: "99" },
    ],
  });
  assert.equal(zeroDouble.size, 0, "a double-visit partner logged real field work — counting only agent_hr_id would exclude every manager who rides along");

  // ---- THE DEGRADED-CALENDAR GUARD MUST FAIL CLOSED ------------------------
  // The Google Egypt calendar is the ONLY source of moving Islamic/Coptic
  // holidays. When it cannot be read, every one of them silently becomes an
  // ordinary working day — and a leaver's final settlement is the worst place to
  // over-deduct, because it is the hardest to correct afterwards.
  for (const degraded of [{ calendarReachable: false }, { connected: false }]) {
    assert.throws(
      () => holidayDatesFromResult({ holidayResult: { ...degraded, holidays: [] }, month: 7, year: 2026 }),
      /calendar is degraded for 2026-07/,
      `a degraded calendar (${JSON.stringify(degraded)}) must THROW, never return the fixed-date-only set as if it were complete`,
    );
  }

  // A healthy calendar expands multi-day holidays to every date they cover.
  const holidays = holidayDatesFromResult({
    holidayResult: {
      calendarReachable: true,
      connected: true,
      holidays: [
        { startDate: "2026-07-06", endDate: "2026-07-08" },
        { startDate: "2026-07-23", endDate: null },
      ],
    },
    month: 7,
    year: 2026,
  });
  assert.deepEqual(
    [...holidays].sort(),
    ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-23"],
    "a multi-day holiday must expand to every date inside it — only the endpoints would charge the days between Eid's first and last",
  );
  assert.equal(
    holidayDatesFromResult({ holidayResult: { calendarReachable: true, connected: true, holidays: [] }, month: 7, year: 2026 }).size,
    0,
    "a month with no confirmed holidays is a legitimate empty set, not a failure",
  );
}
