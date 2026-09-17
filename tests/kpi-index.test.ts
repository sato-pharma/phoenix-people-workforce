import assert from "node:assert/strict";

import {
  kpiIndexOf,
  KPI_INDEX_COMPONENT_KEYS,
  KPI_INDEX_METHOD,
  type KpiIndexInput,
} from "../src/lib/crm/kpi-index.ts";
import { joinKpiRows } from "../src/lib/crm/kpis-board.ts";
import type { RepCallRate } from "../src/lib/crm/call-rate.ts";

/**
 * THE OVERALL KPI — the four measures consolidated into one percentage.
 *
 * Owner, 2026-09-17: "consolidate the result of the call rate and the coverage and the frequency
 * and the KPIs in general into one percentage or one number ... let them separated as they are and
 * consolidate them based on average and mathematical actual calculations, and you must show in a
 * line how it is calculated."
 *
 * Every check here exists because the corresponding mistake produces a PLAUSIBLE number rather
 * than an error — a wrong consolidated score is the single most dangerous figure on this board,
 * because it is the one a manager reads instead of the four:
 *
 *   1. AN UNCAPPED AVERAGE reads 100% for a rep who did 20 PM clinics and not one morning
 *      account. That is the exact arithmetic the owner banned on 2026-09-04 ("this two and this
 *      ten. Don't never get average"), arriving through the back door of a new figure he DID ask
 *      for. This is the headline assertion in the file.
 *   2. A FIXED DIVISOR OF FOUR scores a rep with no plan as though he had failed coverage and
 *      frequency, when the plan asked nothing of him — the accusation `hasMeasurablePlan` exists
 *      to prevent, made silently by an average.
 *   3. A ZERO INSTEAD OF NULL turns "nothing to score" into "scored zero" on a company board.
 *   4. PHARMACIES SLIPPING INTO THE AVERAGE would put a made-up denominator inside the one number
 *      the owner reads: there is no pharmacy target yet (PHARMACY_CALL_RATE_TARGET is null).
 *   5. A FORMULA LINE THAT DOES NOT RECONCILE is worse than none. He asked for the arithmetic to
 *      be shown, and a line whose numbers do not add up to the figure above it destroys the only
 *      thing that makes one consolidated number checkable by hand.
 */

const input = (overrides: Partial<KpiIndexInput> = {}): KpiIndexInput => ({
  coveragePct: 0,
  frequencyPct: 0,
  hasMeasurablePlan: true,
  amAttainmentPct: 0,
  pmAttainmentPct: 0,
  hasCallRate: true,
  ...overrides,
});

export function runKpiOverallIndexTests() {
  // ── 1. The plain mean of the four, and a line that reproduces it ─────────────────────────────
  //
  // These are production-shaped figures: the August rep from the owner's own 2026-09-04 reading
  // (43% AM, 94% PM) against a team coverage and frequency that disagree by thirty points.
  const mixed = kpiIndexOf(input({ coveragePct: 97, frequencyPct: 61, amAttainmentPct: 43, pmAttainmentPct: 94 }));
  assert.equal(mixed.counted, 4, "all four measures could be scored");
  assert.equal(mixed.overallPct, 74, "(97 + 61 + 43 + 94) / 4 = 73.75, rounded once at the end");
  assert.ok(mixed.formula.includes("295"), "the line shows the sum, so it can be checked by hand");
  assert.ok(mixed.formula.includes("÷ 4 measures"), "and the divisor it was divided by");
  assert.ok(mixed.formula.includes("= 74%"), "and lands on the figure printed above it");
  for (const label of ["Coverage 97", "Frequency 61", "AM 43", "PM 94"]) {
    assert.ok(mixed.formula.includes(label), `the line names ${label} — a bare sum is not a calculation anybody can follow`);
  }
  assert.equal(mixed.method, KPI_INDEX_METHOD, "the fixed half of the explanation travels with every index");
  assert.ok(
    KPI_INDEX_METHOD.includes("capped at 100%"),
    "the method sentence states the cap — the one part of this arithmetic a reader cannot infer from the numbers",
  );

  // ── 2. THE CAP. A surplus is never currency ──────────────────────────────────────────────────
  //
  // THE OWNER'S RULE, 2026-09-04: "this two and this ten. Don't never get average." A rep who runs
  // 20 PM clinics a day and never opens a morning account is at 0% AM and 200% PM. Uncapped, his
  // overall reads 100% — a perfect score for half a job that did not happen, which is precisely
  // the blend that got the combined call rate banned. Capped, he reads 50%, and the line says out
  // loud that the 200 entered as 100.
  const surplus = kpiIndexOf(
    input({ hasMeasurablePlan: false, amAttainmentPct: 0, pmAttainmentPct: 200 }),
  );
  assert.equal(surplus.counted, 2, "no plan, so only the two call-rate measures could be scored");
  assert.equal(
    surplus.overallPct,
    50,
    "0% AM and 200% PM is 50% overall — a perfect afternoon does NOT pay for a morning that never happened",
  );
  assert.notEqual(surplus.overallPct, 100, "an uncapped mean would read 100% here, and that is the banned arithmetic");
  const pm = surplus.components.find((component) => component.key === "pm");
  assert.equal(pm?.measuredPct, 200, "the measure keeps its real value — the PM column still reads 200%");
  assert.equal(pm?.scoredPct, 100, "but 100 is what entered the average");
  assert.equal(pm?.capped, true);
  assert.ok(
    surplus.formula.includes("PM ran at 200% and counted as 100"),
    "and the line names the cap, because the number in the average no longer matches the column beside it",
  );

  // Exactly 100 is not "capped" — the cap bites only above the standard.
  assert.equal(
    kpiIndexOf(input({ coveragePct: 100, frequencyPct: 100, amAttainmentPct: 100, pmAttainmentPct: 100 })).components.some(
      (component) => component.capped,
    ),
    false,
    "100% is the standard met, not exceeded — the boundary is inclusive",
  );
  assert.equal(
    kpiIndexOf(input({ coveragePct: 100, frequencyPct: 100, amAttainmentPct: 100, pmAttainmentPct: 100 })).overallPct,
    100,
    "and four measures at their standard is 100% overall",
  );

  // ── 3. A measure nobody could score leaves the average, and the divisor with it ───────────────
  const noPlan = kpiIndexOf(input({ coveragePct: 0, frequencyPct: 0, hasMeasurablePlan: false, amAttainmentPct: 80, pmAttainmentPct: 60 }));
  assert.equal(noPlan.counted, 2, "coverage and frequency have no denominator, so they are not scored as zeros");
  assert.equal(noPlan.overallPct, 70, "(80 + 60) / 2 — a fixed divisor of four would have read 35% and called him behind");
  assert.ok(
    noPlan.formula.includes("Coverage (nothing planned)") && noPlan.formula.includes("Frequency (nothing planned)"),
    "the line names what it left out and why — a shorter sum with no explanation is unreadable",
  );

  const noCalls = kpiIndexOf(input({ coveragePct: 90, frequencyPct: 70, hasCallRate: false, amAttainmentPct: null, pmAttainmentPct: null }));
  assert.equal(noCalls.counted, 2, "a rep the CRM holds no row for loses AM and PM the same way");
  assert.equal(noCalls.overallPct, 80);
  assert.ok(noCalls.formula.includes("AM (no calls logged)"), "and the reason is the absence, never a zero");

  // A window with no working days at all: the two attainments are null even though rows exist.
  const noWorkingDays = kpiIndexOf(input({ coveragePct: 50, frequencyPct: 50, amAttainmentPct: null, pmAttainmentPct: null }));
  assert.equal(noWorkingDays.counted, 2);
  assert.ok(noWorkingDays.formula.includes("AM (no working days)"), "which is a different reason, and says so");

  // ── 4. Nothing scoreable is an ABSENCE, never a zero ─────────────────────────────────────────
  const nothing = kpiIndexOf(
    input({ hasMeasurablePlan: false, hasCallRate: false, amAttainmentPct: null, pmAttainmentPct: null }),
  );
  assert.equal(nothing.overallPct, null, "null — a 0% would read as 'the field force did nothing'");
  assert.equal(nothing.counted, 0);
  assert.ok(
    nothing.formula.includes("absence, not a zero"),
    "and the line says so rather than printing an empty sum",
  );

  // A genuine zero is still a zero: every measure scoreable, every one missed.
  const realZero = kpiIndexOf(input());
  assert.equal(realZero.overallPct, 0, "four measures scored at 0 is 0% — distinct from null, and it must stay so");
  assert.equal(realZero.counted, 4);

  // ── 5. Pharmacies are OUT, and AM/PM never meet ──────────────────────────────────────────────
  //
  // There is no pharmacy target (PHARMACY_CALL_RATE_TARGET is null, a parked question from
  // 2026-09-05), so a fifth component would need an invented denominator inside the one figure the
  // owner reads. This pins the component set so adding one is a deliberate act, not a drift.
  assert.deepEqual(
    [...KPI_INDEX_COMPONENT_KEYS],
    ["coverage", "frequency", "am", "pm"],
    "four components, and pharmacy is not one of them until a target exists",
  );
  assert.deepEqual(
    mixed.components.map((component) => component.key),
    ["coverage", "frequency", "am", "pm"],
    "and the index returns exactly those four, scored or excluded",
  );
  assert.ok(
    KPI_INDEX_METHOD.includes("Pharmacies are left out"),
    "named as excluded rather than silently dropped",
  );

  // THE OWNER'S 2026-09-04 RULE SURVIVES THIS FEATURE. AM and PM travel as two independent
  // components the whole way through: nothing here forms, stores or prints a combined CALL RATE.
  // An intermediate "call rate" on this object is what would resurrect the banned figure.
  const am = mixed.components.find((component) => component.key === "am");
  const pmScored = mixed.components.find((component) => component.key === "pm");
  assert.equal(am?.scoredPct, 43, "AM is scored against 2 a day, on its own");
  assert.equal(pmScored?.scoredPct, 94, "PM against 10 a day, on its own");
  assert.ok(
    !("callRateAttainmentPct" in mixed) && !("callRatePct" in mixed),
    "there is NO combined call rate on the index — the overall KPI reaches its number without ever forming one",
  );
  assert.ok(
    !mixed.components.some((component) => component.label.toLowerCase().includes("call rate")),
    "and no component is a call rate: the two halves of the day are never merged into one measure",
  );
  assert.ok(
    KPI_INDEX_METHOD.includes("never averaged into a single call rate"),
    "the method sentence says so on screen, where the next person to read it will be",
  );

  // ── 6. A REAL ROW, not a hand-built object ───────────────────────────────────────────────────
  //
  // The field names are the trap: `kpiIndexOf` takes a subset of both `KpiRepRow` and the board's
  // `totals`, and a rename on either side would compile against a fixture forever. This drives it
  // from the row `joinKpiRows` actually produces — the rep who hit his 2 AM accounts and did
  // nothing all afternoon, the same fixture the attainment rule is pinned on.
  const [row] = joinKpiRows({
    callRates: [callRateFixture()],
    docLists: [],
    scope: { kind: "company", basis: "company", label: "test" },
    workingDays: 1,
    amTarget: 2,
    pmTarget: 10,
  });
  assert.equal(row?.amAttainmentPct, 100, "the fixture is unchanged: a perfect morning");
  assert.equal(row?.pmAttainmentPct, 0, "and an afternoon that did not happen");
  const fromRow = kpiIndexOf({
    coveragePct: row!.coveragePct,
    frequencyPct: row!.frequencyPct,
    hasMeasurablePlan: row!.hasMeasurablePlan,
    amAttainmentPct: row!.amAttainmentPct,
    pmAttainmentPct: row!.pmAttainmentPct,
    hasCallRate: row!.hasCallRate,
  });
  assert.equal(fromRow.counted, 2, "he carries no plan in this fixture, so only the two call rates score");
  assert.equal(
    fromRow.overallPct,
    50,
    "100% AM and 0% PM is 50% overall — and the four figures beside it still read 100 and 0, apart",
  );
}

/** The 2026-09-04 fixture: 2 verified AM calls against a target of 2, and nothing after lunch. */
function callRateFixture(overrides: Partial<RepCallRate> = {}): RepCallRate {
  const slice = (verified: number, target: number) => ({
    verified,
    unverified: 0,
    campaign: 0,
    total: verified,
    verifiedRate: null,
    totalRate: null,
    target,
    attainmentPct: null,
  });
  return {
    agentCrmId: 7,
    agentHrId: "A-77",
    agentName: "Vendor Spelling",
    workingDays: 1,
    am: slice(2, 2),
    pm: slice(0, 10),
    pharmacy: {
      verified: 0,
      unverified: 0,
      campaign: 0,
      total: 0,
      verifiedRate: null,
      totalRate: null,
      target: null,
      attainmentPct: null,
    },
    unspecified: 0,
    campaignShare: 0,
    campaignOverLimitDays: [],
    campaignOnlyDays: 0,
    ...overrides,
  };
}
