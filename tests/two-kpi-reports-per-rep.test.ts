import assert from "node:assert/strict";

import { LIST_TYPES } from "../src/lib/crm/list-types.ts";
import { KPI_TABS, KPI_TAB_HINT, KPI_TAB_LABEL } from "../src/lib/crm/kpis-tabs.ts";
import { coverageTargetForGrade } from "../src/lib/crm/sfe-doctor-coverage.ts";
import {
  buildRepKpiReports,
  formatAmPmPair,
  kpiGradeTierOf,
  kpiReportsCoverEveryListType,
  unscoredLabel,
  CATCH_ALL_CONTACT_CRM_ID,
  DEFAULT_REP_KPI_STANDARDS,
  resolveRepKpiStandards,
  type KpiPanelContact,
  type KpiVisitInput,
  type RepKpiStandards,
  MIN_SCORED_PANEL,
} from "../src/lib/crm/rep-kpi-reports.ts";

/**
 * Two KPI reports per rep — the owner's requirement, 2026-09-05: "in phx we want to have 2 separate
 * kpis report / rep the first is call rate frequency and covergae am/pm and the 2nd for pharmacies".
 *
 * Every check below exists because the corresponding mistake produces a PLAUSIBLE NUMBER rather
 * than an error — nobody would report any of these as a bug:
 *
 *   1. Coverage and frequency are DIFFERENT numbers. Reporting the graded norm as "coverage" is
 *      what the existing board does, and it reads as a rep failing when he has seen every doctor
 *      on his list.
 *   2. Splitting on `speciality` instead of `list_type` puts hospitals and pharmacies in one bucket
 *      and splits the AM list itself in two. Both cuts exist and they cross.
 *   3. Averaging AM and PM lets a good morning pay for an afternoon that never happened.
 *   4. A rep with no pharmacy list rendered as 0% is an accusation against 25 of 69 reps.
 *   5. A zero norm treated as a real target paints an entire population green.
 *   6. A Thursday visit counted into a rate whose denominator excludes Thursday inflates it
 *      silently.
 *   7. Visits to a contact that is on no list, folded into PM, inflate the doctor number by 6.2%.
 */

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

function contact(overrides: Partial<KpiPanelContact> = {}): KpiPanelContact {
  return { contactCrmId: 1, listType: "PM", grade: "A", ...overrides };
}

/** `n` Saturday-through-Wednesday visits to one contact. August 2026: the 1st is a Saturday. */
function visits(contactCrmId: number, n: number): KpiVisitInput[] {
  // 2026-08-01 (Sat), 02 (Sun), 03 (Mon), 04 (Tue), 05 (Wed) — five real working days, so a
  // fixture never accidentally lands on the Thursday this module excludes.
  const workingDates = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"];
  return Array.from({ length: n }, (_, index) => ({
    contactCrmId,
    visitDateIso: workingDates[index % workingDates.length]!,
  }));
}

// A pharmacy panel big enough to BE scored. MIN_SCORED_PANEL.Pharmacy is 5 (owner rule
// 2026-09-06), so a fixture that means "this rep has a pharmacy list" must carry at least five —
// a smaller one silently exercises the floor instead of whatever the test is actually about.
function pharmacyPanel(count: number, startId = 9): KpiPanelContact[] {
  return Array.from({ length: count }, (_, i) =>
    contact({ contactCrmId: startId + i, listType: "Pharmacy", grade: "A" }),
  );
}

function build(input: {
  panel: readonly KpiPanelContact[];
  visits?: readonly KpiVisitInput[];
  workingDays?: number;
  standards?: RepKpiStandards;
}) {
  return buildRepKpiReports({
    repHrId: "B-155",
    repName: "Batool Rafiq",
    month: "2026-08",
    workingDays: input.workingDays ?? 23,
    panel: input.panel,
    visits: input.visits ?? [],
    standards: input.standards,
  });
}

// ── The vocabulary — three different numbers ─────────────────────────────────────────────────

export function runTwoKpiReportsVocabularyTests() {
  // COVERAGE is "visited at least once". FREQUENCY is "met the graded norm". A rep who saw every
  // A-grade doctor exactly once has covered 100% of his panel and met 0% of the frequency norm,
  // because an A needs three visits (owner, 2026-09-06 — raised from two). Collapsing the two —
  // which the existing coverage board does when it scores `visitsThisMonth >= target` and calls the
  // result coverage — reports this rep as having covered nothing, which is the opposite of what
  // happened.
  const panel = [contact({ contactCrmId: 1 }), contact({ contactCrmId: 2 })];
  const onceEach = [...visits(1, 1), ...visits(2, 1)];
  const report = build({ panel, visits: onceEach });

  assert.equal(report.ampm.pm.coverage.visited, 2);
  assert.equal(report.ampm.pm.coverage.pct, 100, "every doctor on the panel was seen — coverage is 100%");
  assert.equal(report.ampm.pm.frequency.met, 0, "an A grade needs three visits; one does not meet the norm");
  assert.equal(report.ampm.pm.frequency.pct, 0, "frequency is 0% for the same rep in the same month");

  // And the inverse: three visits each meets the A norm, so both numbers reach 100 — proving the
  // two are genuinely independent rather than one being a rescaling of the other.
  const thriceEach = [...visits(1, 3), ...visits(2, 3)];
  const met = build({ panel, visits: thriceEach });
  assert.equal(met.ampm.pm.coverage.pct, 100);
  assert.equal(met.ampm.pm.frequency.pct, 100);

  // CALL RATE is neither: it is visits over working days and does not consult the panel at all.
  // Six visits across 23 working days is 0.26/day even though coverage and frequency are both 100%.
  assert.equal(met.ampm.pm.callRate.visits, 6);
  assert.ok(
    Math.abs((met.ampm.pm.callRate.perWorkingDay ?? 0) - 6 / 23) < 1e-9,
    "call rate divides by the CALENDAR working days, not by the days the rep happened to work",
  );
}

// ── The split is `list_type`, never `speciality` ──────────────────────────────────────────────

export function runTwoKpiReportsSplitTests() {
  // The two reports are fed by the CRM's own list assignment. A pharmacy is on the Pharmacy list
  // and must never reach the AM/PM report, and an AM account must never reach the pharmacy one —
  // regardless of what either contact's speciality would classify as. `list_type` is the only
  // field consulted here; there is deliberately no speciality input to consult.
  const report = build({
    panel: [
      contact({ contactCrmId: 1, listType: "PM", grade: "A" }),
      contact({ contactCrmId: 2, listType: "AM", grade: "A" }),
      ...pharmacyPanel(5, 3),
    ],
    visits: [...visits(1, 1), ...visits(2, 1), ...visits(3, 1)],
  });

  assert.equal(report.ampm.pm.coverage.panel, 1, "the PM panel holds only PM-list contacts");
  assert.equal(report.ampm.am.coverage.panel, 1, "the AM panel holds only AM-list contacts");
  assert.equal(report.pharmacies.pharmacies.coverage.panel, 5, "pharmacies are their own panel");

  // A PHARMACY IS NOT A CONTACT. The AM/PM report's panels must not include it anywhere — this is
  // the check that fails if somebody "helpfully" merges the pharmacy list back into the doctor
  // denominator the 90-120 rule judges.
  assert.equal(
    report.ampm.am.coverage.panel + report.ampm.pm.coverage.panel,
    2,
    "the pharmacy stays OUT of the AM/PM denominator entirely",
  );

  // Both reports together must cover every list type the CRM can emit. If a fourth ever appears,
  // this fails rather than letting its contacts vanish from both reports unnoticed.
  assert.ok(
    kpiReportsCoverEveryListType(),
    `every CRM list type must land in one of the two reports — LIST_TYPES is ${LIST_TYPES.join(", ")}`,
  );
}

// ── Never average AM and PM ──────────────────────────────────────────────────────────────────

export function runTwoKpiReportsNeverAveragedTests() {
  // The owner, 2026-09-04: "this two and this ten. Don't never get average." A rep who did his two
  // AM accounts and none of his ten PM clinics is 100% AM and 0% PM. Averaged he reads 50%; over
  // one denominator he reads 17%. Both are wrong, and both hide an afternoon that never happened.
  const report = build({
    workingDays: 1,
    panel: [contact({ contactCrmId: 1, listType: "AM" }), contact({ contactCrmId: 2, listType: "AM" }), contact({ contactCrmId: 3, listType: "PM" })],
    visits: [...visits(1, 1), ...visits(2, 1)],
  });

  assert.equal(report.ampm.am.callRate.perWorkingDay, 2, "two AM accounts in one working day");
  assert.equal(report.ampm.pm.callRate.perWorkingDay, 0, "and nothing at all in the afternoon");

  const amScore = report.ampm.am.callRate.score;
  const pmScore = report.ampm.pm.callRate.score;
  assert.ok(amScore.scored && amScore.meets, "AM met its target of 2");
  assert.ok(pmScore.scored && !pmScore.meets, "PM did not — and that must stay visible");

  // STRUCTURAL: there is no combined figure to print. This is the guard that survives a future
  // session adding a convenience field, because the rule is the ABSENCE — a `combined`, `overall`,
  // `average` or `total` on the AM/PM report is the bug itself, not a helper.
  const forbidden = /combined|average|overall|total|blended|merged/i;
  const offenders = Object.keys(report.ampm).filter((key) => forbidden.test(key));
  assert.deepEqual(offenders, [], "the AM/PM report must expose NO combined figure — AM and PM are reported apart");

  // NEVER PRINT THE PAIR WITH A SLASH. He read "1.63 / 6.57" as "1.63 out of 6.57".
  const pair = formatAmPmPair("1.63", "6.57");
  assert.equal(pair, "1.63 AM · 6.57 PM");
  assert.ok(!pair.includes("/"), "a slash between two independent rates reads as a fraction");
}

// ── Not applicable is not the same as not scored ─────────────────────────────────────────────

export function runTwoKpiReportsApplicabilityTests() {
  // A REP WITH NO PHARMACY LIST IS NORMAL — 25 of 69 on production. Report 2 must say "not
  // applicable"; rendering 0% would accuse two fifths of the field force of covering nothing.
  const noPharmacies = build({ panel: [contact({ contactCrmId: 1, listType: "PM" })] });
  assert.equal(noPharmacies.pharmacies.applicable, false, "no pharmacy list is not a gap");
  const pharmacyCoverage = noPharmacies.pharmacies.pharmacies.coverage;
  assert.equal(pharmacyCoverage.pct, null, "an absent list has no percentage, not a zero one");
  assert.ok(!pharmacyCoverage.score.scored && pharmacyCoverage.score.reason === "not-applicable");
  assert.equal(unscoredLabel("not-applicable"), "Not applicable");

  // A REP WITH NO AM/PM LIST *IS* WORTH FLAGGING — that half is universal, and the two cases must
  // not collapse into one indistinguishable "n/a".
  const pharmaciesOnly = build({ panel: pharmacyPanel(5) });
  assert.equal(pharmaciesOnly.ampm.applicable, false, "no AM and no PM list is the case worth flagging");
  assert.equal(pharmaciesOnly.pharmacies.applicable, true);

  // NOT SCORED is the third state: the list exists and the rep's own figure is real, but the owner
  // has not supplied the standard yet. The measured number must still be shown — only the verdict
  // is missing. Rendering it as 0, or as "not applicable", would each be a different lie.
  const pharmacyReport = build({
    panel: pharmacyPanel(5),
    visits: visits(9, 3),
  });
  const rate = pharmacyReport.pharmacies.pharmacies.callRate;
  assert.equal(rate.visits, 3, "the rep's real pharmacy calls are counted and shown");
  assert.ok(rate.perWorkingDay != null && rate.perWorkingDay > 0, "and his real rate is measured");
  assert.ok(
    !rate.score.scored && rate.score.reason === "no-standard-set",
    "but there is no pharmacy call-rate target anywhere, so it carries no verdict",
  );
  assert.equal(unscoredLabel("no-standard-set"), "Not scored");

  // Still parked, and none may be invented.
  assert.equal(DEFAULT_REP_KPI_STANDARDS.Pharmacy.callRatePerDay, null, "parked question 1");
  assert.equal(DEFAULT_REP_KPI_STANDARDS.Pharmacy.frequencyNorms.A, null, "parked question 2");

  // ANSWERED by the owner 2026-09-06 — these two are now the standard, not a guess.
  // 50 is NOT a typo for the AM/PM 95: pharmacy coverage ran at 40.6% in August, so a 95%
  // floor would fail every rep on day one. Do not "align" these two numbers.
  assert.equal(DEFAULT_REP_KPI_STANDARDS.Pharmacy.coverageFloorPct, 50, "owner answer: pharmacy coverage floor is 50%");
  assert.equal(DEFAULT_REP_KPI_STANDARDS.AM.frequencyNorms.A, 1, "owner answer: a grade A AM account is visited once a month");
  assert.equal(DEFAULT_REP_KPI_STANDARDS.AM.frequencyNorms.B, null, "he left grade B blank = keep as today");

  // ANSWERED by the owner 2026-09-06, confirmed directly in chat the same day: PM's frequency
  // norms rise from {A:2,B:1,C:1} to {A:3,B:2,C:1}. `doctor_coverage_config.norms.sp` was updated
  // live in production the same day so the OLD board's own Frequency tab agrees with this number —
  // two boards disagreeing on one figure is exactly the shape #3341 retracted the visits/day band
  // over, and this assertion is what would catch that recurring here.
  assert.equal(DEFAULT_REP_KPI_STANDARDS.PM.frequencyNorms.A, 3, "owner answer: a grade A PM doctor is visited 3 times a month");
  assert.equal(DEFAULT_REP_KPI_STANDARDS.PM.frequencyNorms.B, 2, "owner answer: a grade B PM doctor is visited twice a month");
  assert.equal(DEFAULT_REP_KPI_STANDARDS.PM.frequencyNorms.C, 1, "grade C stays at 1 — unchanged");
}

// ── A zero norm is "not scored", never green ─────────────────────────────────────────────────

export function runTwoKpiReportsZeroNormTests() {
  // Production stores the unscored state as a literal 0 — doctor_coverage_config has
  // {"hcp":{"A":0,"B":0,"C":0}} since 2026-08-19. `visits >= 0` is true for every contact, so
  // treating that 0 as a real target paints an entire population green and inflates the number.
  const zeroNorms: RepKpiStandards = {
    ...DEFAULT_REP_KPI_STANDARDS,
    PM: { ...DEFAULT_REP_KPI_STANDARDS.PM, frequencyNorms: { A: 0, B: 0, C: 0 } },
  };
  const report = build({
    standards: zeroNorms,
    panel: [contact({ contactCrmId: 1 }), contact({ contactCrmId: 2 })],
    visits: [],
  });

  const frequency = report.ampm.pm.frequency;
  assert.equal(frequency.met, 0, "a zero norm must never count a never-visited contact as having met it");
  assert.equal(frequency.scoredPanel, 0, "the population leaves the denominator instead");
  assert.ok(
    !frequency.score.scored && frequency.score.reason === "no-standard-set",
    "a zero norm reads as 'nobody set a standard', never as 'zero visits expected'",
  );
}

// ── The Saturday-to-Wednesday gate, the catch-all, and off-list visits ───────────────────────

export function runTwoKpiReportsVisitGateTests() {
  // THURSDAY IS NOT A WORKING DAY (owner, 2026-09-05: "donot count thursday as working day" /
  // "visists to be counted from sat to wednesday only regular visits"). 2026-08-06 is a Thursday
  // and 2026-08-07 a Friday. A visit on either must not reach any slice — counting it into a rate
  // whose denominator excludes the day inflates the rate with no error anywhere.
  const report = build({
    panel: [contact({ contactCrmId: 1 })],
    visits: [
      { contactCrmId: 1, visitDateIso: "2026-08-05" }, // Wednesday — counts
      { contactCrmId: 1, visitDateIso: "2026-08-06" }, // Thursday — must not
      { contactCrmId: 1, visitDateIso: "2026-08-07" }, // Friday — must not
    ],
  });
  assert.equal(report.ampm.pm.callRate.visits, 1, "only the Sat-Wed visit counts");

  // THE CATCH-ALL CONTACT is not a doctor. Reps log against 100000 when they have nobody real, and
  // it poisons every per-contact figure it reaches — it must leave both the panel and the visits.
  const withCatchAll = build({
    panel: [contact({ contactCrmId: 1 }), contact({ contactCrmId: CATCH_ALL_CONTACT_CRM_ID })],
    visits: [...visits(1, 1), ...visits(CATCH_ALL_CONTACT_CRM_ID, 5)],
  });
  assert.equal(withCatchAll.ampm.pm.coverage.panel, 1, "the catch-all is not on anybody's panel");
  assert.equal(withCatchAll.ampm.pm.callRate.visits, 1, "and its visits are not calls");
  assert.equal(withCatchAll.offListVisits, 0, "nor is it an off-list visit — it is excluded outright");

  // OFF-LIST VISITS: 867 of 14,076 regular Sat-Wed visits in August 2026 (6.2%) went to a contact
  // on none of that rep's lists, so no `list_type` can attribute them. Dropping them understates
  // call rate; folding them into PM inflates the doctor number. They are surfaced instead.
  const offList = build({
    panel: [contact({ contactCrmId: 1 })],
    visits: [...visits(1, 2), ...visits(777, 3)],
  });
  assert.equal(offList.offListVisits, 3, "a visit to a contact on no list is counted and named");
  assert.equal(offList.ampm.pm.callRate.visits, 2, "and never silently added to the PM figure");
  assert.equal(offList.pharmacies.pharmacies.callRate.visits, 0, "nor to the pharmacy one");
}

// ── Grades, and the band ──────────────────────────────────────────────────────────────────────

export function runTwoKpiReportsGradeAndBandTests() {
  // "A+" folds into A — one PM contact on production carries it, and it is A's norm that applies.
  // Pinned against the EXPORTED behaviour of the existing coverage board so the two cannot drift:
  // if sfe-doctor-coverage ever stops folding A+ into A, this fails rather than the two boards
  // quietly disagreeing about one doctor.
  assert.equal(kpiGradeTierOf("A+"), "A");
  assert.equal(kpiGradeTierOf("A"), "A");
  assert.equal(kpiGradeTierOf("B"), "B");
  assert.equal(kpiGradeTierOf("C"), "C");
  assert.equal(kpiGradeTierOf(""), null, "blank is ungraded, not a tier");
  assert.equal(kpiGradeTierOf("D"), null, "an unknown vendor code is ungraded, never guessed into a tier");
  assert.equal(
    coverageTargetForGrade("A+"),
    coverageTargetForGrade("A"),
    "the existing board folds A+ into A too — these two must agree",
  );

  // An ungraded contact is COUNTED and surfaced rather than dropped, so a vendor grading gap is
  // visible instead of silently shrinking the frequency denominator.
  const ungraded = build({
    panel: [contact({ contactCrmId: 1, grade: "A" }), contact({ contactCrmId: 2, grade: null })],
    visits: visits(1, 2),
  });
  assert.equal(ungraded.ampm.pm.frequency.ungraded, 1, "the ungraded contact is named, not hidden");
  assert.equal(ungraded.ampm.pm.frequency.scoredPanel, 1, "and is not in the frequency denominator");
  assert.equal(ungraded.ampm.pm.coverage.panel, 2, "but it IS on the panel coverage judges");

  // THE PM BAND is "8-12 pm only" — the owner's own words. A rep at 8.0 MEETS the standard even
  // though the headline target is 10; a rep at 13.0 does not, even though he is above it. Scoring
  // PM as ">= 10" would fail every rep in the band the owner defined as acceptable.
  const band = DEFAULT_REP_KPI_STANDARDS.PM.callRateBand;
  assert.deepEqual(band, { min: 8, max: 12 });

  const eight = build({
    workingDays: 1,
    panel: Array.from({ length: 8 }, (_, i) => contact({ contactCrmId: i + 1 })),
    visits: Array.from({ length: 8 }, (_, i) => ({ contactCrmId: i + 1, visitDateIso: "2026-08-01" })),
  });
  const eightScore = eight.ampm.pm.callRate.score;
  assert.ok(eightScore.scored && eightScore.meets, "8 calls a day is inside the owner's 8-12 band");

  const thirteen = build({
    workingDays: 1,
    panel: Array.from({ length: 13 }, (_, i) => contact({ contactCrmId: i + 1 })),
    visits: Array.from({ length: 13 }, (_, i) => ({ contactCrmId: i + 1, visitDateIso: "2026-08-01" })),
  });
  const thirteenScore = thirteen.ampm.pm.callRate.score;
  assert.ok(thirteenScore.scored && !thirteenScore.meets, "13 is outside the band — above it is still outside");

  // AM has no band: its standard is a flat "2 am accounts", so met means >= 2.
  assert.equal(DEFAULT_REP_KPI_STANDARDS.AM.callRateBand, null);
  assert.equal(DEFAULT_REP_KPI_STANDARDS.AM.callRatePerDay, 2);
}

// ── Every number is configurable ──────────────────────────────────────────────────────────────

export function runTwoKpiReportsConfigurableTests() {
  // No stored standard yet — the reports run on today's real numbers, with the still-unanswered
  // ones null and the owner's 2026-09-06 answers baked into the defaults. This is what ships.
  assert.deepEqual(resolveRepKpiStandards(null), DEFAULT_REP_KPI_STANDARDS);
  assert.deepEqual(resolveRepKpiStandards(undefined), DEFAULT_REP_KPI_STANDARDS);

  // Answering ONE parked question must not disturb the other three, or any list it does not name.
  // A partial edit that silently reset PM's live {A:3,B:2,C:1} norms would move every doctor
  // number on the board with nothing on screen to say why.
  const answered = resolveRepKpiStandards({ Pharmacy: { callRatePerDay: 4 } });
  assert.equal(answered.Pharmacy.callRatePerDay, 4, "the owner's answer is taken");
  assert.equal(
    answered.Pharmacy.coverageFloorPct,
    50,
    "a key the edit does not name keeps its default — here the owner's answered 50% floor",
  );
  assert.equal(answered.Pharmacy.frequencyNorms.A, null, "and a still-open question stays unanswered");
  assert.deepEqual(answered.PM, DEFAULT_REP_KPI_STANDARDS.PM, "and the list he did not name is untouched");
  assert.deepEqual(answered.AM, DEFAULT_REP_KPI_STANDARDS.AM);

  // A stored NULL is an ANSWER — "this population is not held to this standard" — and must be kept,
  // not treated as a missing key that falls back to the default. Only an ABSENT key falls back.
  const explicitNull = resolveRepKpiStandards({ PM: { coverageFloorPct: null } });
  assert.equal(explicitNull.PM.coverageFloorPct, null, "an explicit null means 'do not score this'");
  assert.equal(explicitNull.PM.callRatePerDay, 10, "while the keys it did not mention keep their defaults");
  assert.deepEqual(explicitNull.PM.frequencyNorms, DEFAULT_REP_KPI_STANDARDS.PM.frequencyNorms);

  // Per-grade edits merge per grade, so pricing an A does not blank a B.
  const gradeEdit = resolveRepKpiStandards({ Pharmacy: { frequencyNorms: { A: 2 } } });
  assert.equal(gradeEdit.Pharmacy.frequencyNorms.A, 2);
  assert.equal(gradeEdit.Pharmacy.frequencyNorms.B, null, "B is still an open question");

  // And an answered standard actually SCORES — the whole point of making it configurable is that
  // "Not scored" turns into a verdict the moment the owner supplies a number, with no code change.
  const before = build({
    panel: pharmacyPanel(5),
    visits: visits(9, 46),
    workingDays: 23,
  });
  assert.ok(!before.pharmacies.pharmacies.callRate.score.scored, "unpriced today");

  const after = build({
    panel: pharmacyPanel(5),
    visits: visits(9, 46),
    workingDays: 23,
    standards: resolveRepKpiStandards({ Pharmacy: { callRatePerDay: 2 } }),
  });
  const scored = after.pharmacies.pharmacies.callRate.score;
  assert.ok(scored.scored && scored.meets, "46 calls over 23 working days is 2/day — meets a target of 2");
}

// ── The two tabs on the KPIs board ────────────────────────────────────────────────────────────

export function runTwoKpiReportsTabTests() {
  // Both reports are reachable as tabs, and every tab — old or new — carries a label and a hint.
  // A Record<KpiTab, string> already makes a MISSING key a type error, but types are stripped at
  // runtime here, so an empty string would pass the compiler and render a nameless tab.
  for (const tab of KPI_TABS) {
    assert.ok(KPI_TAB_LABEL[tab]?.trim(), `tab "${tab}" has a label`);
    assert.ok(KPI_TAB_HINT[tab]?.trim(), `tab "${tab}" has a hint saying what its number MEANS`);
  }
  assert.ok(KPI_TABS.includes("am-pm"), "report 1 is a tab");
  assert.ok(KPI_TABS.includes("pharmacies"), "report 2 is a tab");

  // NEVER A SLASH between the two sessions. The owner read "1.63 / 6.57" as "1.63 out of 6.57",
  // so the AM/PM tab is labelled with the middle dot the rest of the board uses.
  assert.equal(KPI_TAB_LABEL["am-pm"], "AM · PM");
  assert.ok(!KPI_TAB_LABEL["am-pm"].includes("/"), "a slash between AM and PM reads as a fraction");

  // The hints must say these measure against the LIST, not the plan — the four tabs beside them use
  // a different denominator, and a manager comparing the two numbers needs to know why they differ.
  assert.match(KPI_TAB_HINT["am-pm"], /list/i);
  assert.match(KPI_TAB_HINT.pharmacies, /list/i);
  // And the pharmacies hint must say the absent case is NOT a zero — that is the whole point.
  assert.match(KPI_TAB_HINT.pharmacies, /not applicable/i);
}

// ── The owner's own sample rep ────────────────────────────────────────────────────────────────

export function runTwoKpiReportsSampleRepTests() {
  // Batool Rafiq (Dakahlia 1 / C), the rep the owner pointed at: panel 187 = 113 PM + 16 AM + 58
  // Pharmacy, with 119 of the 129 AM/PM contacts visited and 3 of the 58 pharmacies.
  //
  // Mixed into ONE number she reads 122/187 = 65.2% and looks like a failing rep. Split the way he
  // asked, she is 92.2% on the list every rep is judged on. THIS is the whole point of the two
  // reports: the mixed number understates doctor coverage by 6.8 points on average across the
  // company and 28.8 at worst, and two reps clear 95% on doctors while reading as failing.
  const panel: KpiPanelContact[] = [
    ...Array.from({ length: 113 }, (_, i) => contact({ contactCrmId: 1000 + i, listType: "PM" as const })),
    ...Array.from({ length: 16 }, (_, i) => contact({ contactCrmId: 2000 + i, listType: "AM" as const })),
    ...Array.from({ length: 58 }, (_, i) => contact({ contactCrmId: 3000 + i, listType: "Pharmacy" as const })),
  ];
  // 103 of 113 PM and all 16 AM seen once → 119 of 129; 3 of 58 pharmacies.
  const seen: KpiVisitInput[] = [
    ...Array.from({ length: 103 }, (_, i) => ({ contactCrmId: 1000 + i, visitDateIso: "2026-08-01" })),
    ...Array.from({ length: 16 }, (_, i) => ({ contactCrmId: 2000 + i, visitDateIso: "2026-08-02" })),
    ...Array.from({ length: 3 }, (_, i) => ({ contactCrmId: 3000 + i, visitDateIso: "2026-08-03" })),
  ];

  const report = build({ panel, visits: seen });

  const amPmVisited = report.ampm.am.coverage.visited + report.ampm.pm.coverage.visited;
  const amPmPanel = report.ampm.am.coverage.panel + report.ampm.pm.coverage.panel;
  assert.equal(amPmPanel, 129, "the AM/PM panel is 129 — the pharmacies are not in it");
  assert.equal(amPmVisited, 119);
  assert.ok(Math.abs((amPmVisited / amPmPanel) * 100 - 92.2) < 0.1, "she covered 92.2% of the list she is judged on");

  assert.equal(report.pharmacies.pharmacies.coverage.panel, 58);
  assert.equal(report.pharmacies.pharmacies.coverage.visited, 3);
  assert.ok(
    Math.abs((report.pharmacies.pharmacies.coverage.pct ?? 0) - 5.2) < 0.1,
    "her pharmacy coverage is 5.2% and belongs in its own report, against a floor nobody has set yet",
  );

  // The mixed number the two reports exist to retire. Asserted here so the gap is documented in the
  // suite rather than only in a commit message: 65.2% is what she used to read as.
  const mixedPct = ((amPmVisited + 3) / (amPmPanel + 58)) * 100;
  assert.ok(Math.abs(mixedPct - 65.2) < 0.1);
  assert.ok(
    (report.ampm.pm.coverage.pct ?? 0) > mixedPct,
    "splitting the reports is what turns a rep reading 65% into the 92% she actually achieved",
  );

  // Her hr id is canonicalised. HR ids are MIXED CASE in this database, so a raw `.eq` silently
  // under-returns — one such comparison hid 28% of reps' own orders. Asserting the RULE (both
  // spellings land on one key, and it is case-folded) rather than a literal, so this still guards
  // if the canonical form itself ever changes.
  const upper = build({ panel: [contact()] });
  const lower = buildRepKpiReports({
    repHrId: "b-155",
    repName: "Batool Rafiq",
    month: "2026-08",
    workingDays: 23,
    panel: [contact()],
    visits: [],
  });
  assert.equal(upper.repKey, lower.repKey, "'B-155' and 'b-155' are one rep, never two rows");
  assert.equal(report.repKey, report.repKey?.toLowerCase(), "the key is case-folded, so a mixed-case id still joins");

  // A REP WITH NO HR ID KEYS TO NULL, NOT TO "". The vendor feed allows a null `agent_hr_id`, and
  // an empty string is a perfectly good Map key — so coercing it would collapse every unidentified
  // rep into ONE row carrying the sum of their panels and visits. That row would look completely
  // ordinary, which is why this is a test and not a comment.
  const nameless = buildRepKpiReports({
    repHrId: null,
    repName: "Unknown",
    month: "2026-08",
    workingDays: 23,
    panel: [contact()],
    visits: [],
  });
  assert.equal(nameless.repKey, null, "a rep with no hr id is unkeyed, never keyed to the empty string");
  const blank = buildRepKpiReports({
    repHrId: "   ",
    repName: "Unknown",
    month: "2026-08",
    workingDays: 23,
    panel: [contact()],
    visits: [],
  });
  assert.equal(blank.repKey, null, "and whitespace is not an identity either");
}

// ── A list too small to carry a percentage ────────────────────────────────────────────────────

export function runTwoKpiReportsMinPanelTests() {
  // Owner rule, 2026-09-06: "exclude reps with less than 5 pharmacies from scoring".
  //
  // Coverage is a PERCENTAGE, and a one-pharmacy list can only ever read 0% or 100%. Measured on
  // production for August 2026: five of the 44 reps carrying a pharmacy list held fewer than five,
  // 10 pharmacies between them, and FOUR of those five read as zero coverage purely because of the
  // denominator — beside colleagues who had genuinely skipped 40-odd pharmacies each.
  assert.equal(MIN_SCORED_PANEL.Pharmacy, 5, "the owner's floor");

  // AM and PM are deliberately 1, NOT 5. That half is universal, so a rep with no AM/PM list IS
  // worth flagging; raising these would silently stop flagging a list that was never set up, which
  // is the opposite of what the floor is for.
  assert.equal(MIN_SCORED_PANEL.AM, 1, "AM stays universal");
  assert.equal(MIN_SCORED_PANEL.PM, 1, "PM stays universal");

  // FOUR is below the floor: the whole pharmacy block reads "Not applicable", exactly as it already
  // does for the 25 reps who carry no pharmacy list at all — never a zero, never a red cell.
  const four = build({ panel: pharmacyPanel(4), visits: visits(9, 20), workingDays: 23 });
  assert.equal(four.pharmacies.applicable, false, "a list of four is too small to score");
  assert.equal(four.pharmacies.pharmacies.coverage.score.scored, false);
  assert.equal(four.pharmacies.pharmacies.callRate.score.scored, false);

  // FIVE is the boundary and IS scored. An off-by-one here would exclude a rep the owner meant to
  // keep: 39 of the 44 reps sit at or above five and carry 1,862 of the 1,872 pharmacies (99.5%).
  const five = build({ panel: pharmacyPanel(5), visits: visits(9, 20), workingDays: 23 });
  assert.equal(five.pharmacies.applicable, true, "five is inside the standard");
  assert.equal(five.pharmacies.pharmacies.coverage.panel, 5, "and its real panel is measured");

  // The floor is PER LIST TYPE, not a blanket 5 — one AM account is still scored.
  const oneAm = build({ panel: [contact({ contactCrmId: 1, listType: "AM", grade: "A" })] });
  assert.equal(oneAm.ampm.applicable, true, "one AM account is still scored");
}
