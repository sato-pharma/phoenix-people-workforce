import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  joinKpiRows,
  buildKpiPodium,
  sumKpiTeamTotals,
  type KpiDirectoryEntry,
  type KpiRepRow,
} from "../src/lib/crm/kpis-board.ts";
import { buildKpiManagerRows, KPI_MANAGER_MEASURES, kpiRepMeasures } from "../src/lib/crm/kpis-manager-rows.ts";
import { isAgentInScope, type DoctorCoverageScope } from "../src/lib/crm/doctor-coverage-roles.ts";
import { normalizeHrIdForAccess } from "../src/lib/hr-id.ts";
import {
  applyKpiFilters,
  applyKpiManagerFilters,
  buildKpiFacets,
  buildKpisQuery,
  amBandOf,
  pmBandOf,
  coverageBandOf,
  COVERAGE_TARGET_FLOOR_PCT,
  EMPTY_KPI_FILTERS,
  frequencyBandOf,
  kpiFiltersToParams,
  kpiFlagsOf,
  nextKpiSort,
  parseKpiFilters,
  isTooEarlyToScore,
  KPI_VERDICT_THRESHOLD,
  sortKpiRows,
  UNASSIGNED_FACET_KEY,
  type KpiFilterState,
} from "../src/lib/crm/kpis-filters.ts";
import { keepMedicalRepsOnly } from "../src/lib/crm/medical-rep.ts";
import type { RepCallRate } from "../src/lib/crm/call-rate.ts";

/**
 * KPIs advanced filters — the things that would each be wrong in a way nobody could see.
 *
 * The board itself is covered by tests/kpis-board.test.ts. What is new here is a filter layer over
 * a security-scoped list, and every check below exists because the corresponding mistake produces a
 * PLAUSIBLE screen rather than an error:
 *
 *   1. A filter that could WIDEN the row set would leak another manager's reps, and the screen
 *      would look completely normal — this is the only failure here nobody would ever report.
 *   2. A rep with no plan filed under "Behind" reads as a failing employee. He is not failing; he
 *      was never given anything to do. That is a real accusation made silently.
 *   3. Nulls sorting FIRST on "worst coverage" fills the top of the list with the unmeasurable and
 *      pushes the rep who actually missed forty doctors off the first screen.
 *   4. A URL builder that drops the filters on a tab or month change shows a WIDER board while the
 *      chips still say a filter is on — the worst of the two possible directions to be wrong in.
 *   5. Call-rate attainment averaged across two slices instead of over one denominator reads 50%
 *      for a rep who delivered 2 of the 12 calls his targets asked for.
 */

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

/** A complete row, so each test can vary exactly the field it is about and nothing else. */
function row(overrides: Partial<KpiRepRow> = {}): KpiRepRow {
  return {
    agentCrmId: 1,
    agentHrId: "a-1",
    repName: "Rep One",
    lineName: "Pedia",
    regionName: "Giza",
    areaName: "GZ3",
    managerName: "Manager One",
    jobTitle: "Medical Rep",
    workingDays: 20,
    amVerified: 40,
    pmVerified: 200,
    amRate: 2,
    pmRate: 10,
    // Reported ABOVE verified, and deliberately not equal to it: a fixture where the two match
    // would let a bug that returned the verified figure for both halves pass unnoticed here.
    amReported: 60,
    pmReported: 240,
    amReportedRate: 3,
    pmReportedRate: 12,
    totalCalls: 240,
    campaignCalls: 0,
    campaignShare: 0,
    campaignOnlyDays: 0,
    hasCallRate: true,
    noGpsFeed: false,
    awaitingValidation: 0,
    amAttainmentPct: 100,
    pmAttainmentPct: 100,
    // Separate from AM/PM entirely (owner, 2026-09-05) — no target yet, so no attainment percentage
    // either. See PHARMACY_CALL_RATE_TARGET in crm/call-rate.ts.
    pharmacyVerified: 0,
    pharmacyRate: 0,
    pharmacyReported: 0,
    pharmacyReportedRate: 0,
    pharmacyAttainmentPct: null,
    plannedDoctors: 100,
    visitedDoctors: 95,
    missedDoctors: 5,
    coveragePct: 95,
    // 95 clears the 95% floor exactly — the boundary is inclusive.
    meetsCoverageFloor: true,
    onPlanDoctors: 95,
    underDoctors: 5,
    overDoctors: 0,
    frequencyPct: 95,
    hasMeasurablePlan: true,
    plannedCalls: 200,
    plannedCallsToDate: 200,
    actualCalls: 190,
    offPlanDoctors: 3,
    plannedAccounts: 4,
    gradeA: 10,
    gradeB: 20,
    gradeC: 1,
    underPlannedVsGrade: 2,
    ...overrides,
  };
}

function filters(overrides: Partial<KpiFilterState> = {}): KpiFilterState {
  return { ...EMPTY_KPI_FILTERS, ...overrides };
}

// ── 1. A filter can only ever narrow ──────────────────────────────────────────────────────────

export function runKpiFilterNarrowingTests() {
  const rows = [
    row({ agentCrmId: 1, repName: "Ali", lineName: "Pedia", areaName: "GZ3" }),
    row({ agentCrmId: 2, repName: "Bassem", lineName: "CNS", areaName: "CA1" }),
    row({ agentCrmId: 3, repName: "Carim", lineName: "Anti Infective", areaName: "D11" }),
  ];

  // THE SECURITY-ADJACENT PROPERTY. `applyKpiFilters` runs after the scope gate has already dropped
  // every rep the viewer may not see, so no combination of parameters may ever produce a row that
  // was not in the input. This is asserted over a deliberately hostile spread of states rather than
  // one happy case, because the failure mode is a screen that looks entirely normal.
  const hostile: KpiFilterState[] = [
    filters(),
    filters({ lines: ["Pedia"] }),
    filters({ lines: ["Pedia", "CNS", "Anti Infective", "Nothing At All"] }),
    filters({ areas: [UNASSIGNED_FACET_KEY] }),
    filters({ query: "" }),
    filters({ query: "zzz" }),
    filters({ coverage: ["elite", "strong", "steady", "behind", "noplan"] }),
    filters({ flags: ["never-reached", "no-calls", "no-plan"] }),
    filters({ sort: "coverage", direction: "desc" }),
  ];
  for (const state of hostile) {
    const result = applyKpiFilters(rows, state);
    assert.ok(
      result.length <= rows.length,
      "a filter must never return more rows than it was given — that would be a scope leak",
    );
    for (const entry of result) {
      assert.ok(
        rows.includes(entry),
        "every returned row must be one of the input rows, never a reconstruction",
      );
    }
  }

  // Facets are AND-ed ACROSS dimensions and OR-ed WITHIN one. Getting this backwards is the
  // difference between "Pedia reps in Giza" and "everyone who is either Pedia or in Giza" — the
  // second is wider than what was asked for, on a board where wider means somebody else's team.
  assert.deepEqual(
    applyKpiFilters(rows, filters({ lines: ["Pedia", "CNS"] })).map((entry) => entry.repName),
    ["Ali", "Bassem"],
    "two values on ONE facet are OR-ed",
  );
  assert.deepEqual(
    applyKpiFilters(rows, filters({ lines: ["Pedia"], areas: ["CA1"] })).map((entry) => entry.repName),
    [],
    "two DIFFERENT facets are AND-ed — Pedia and CA1 is nobody",
  );

  // Case and spacing must not matter: the value comes back from a URL a human may have edited.
  assert.equal(
    applyKpiFilters(rows, filters({ lines: ["  pedia  "] })).length,
    1,
    "facet matching is case- and space-insensitive",
  );

  // An unrecognised value DROPS rather than emptying the board — the same rule resolveKpiTab
  // follows. A blank board is a statement about the reps, not about a typo in a query string.
  const parsed = parseKpiFilters({ cov: "elite,not-a-band", flag: "never-reached,made-up", sort: "nonsense" });
  assert.deepEqual(parsed.coverage, ["elite"], "an unknown band is dropped, the known one kept");
  assert.deepEqual(parsed.flags, ["never-reached"], "an unknown flag is dropped, the known one kept");
  assert.equal(parsed.sort, "rep", "an unknown sort field falls back to the default, never throws");
}

// ── 2. No plan is not a failure ───────────────────────────────────────────────────────────────

export function runKpiBandTests() {
  const noPlan = row({ hasMeasurablePlan: false, coveragePct: 0, frequencyPct: 0 });

  // THE ACCUSATION TEST. `hasMeasurablePlan` exists so a rep with nothing planned is not ranked as
  // a 0% performer. If the band ignored it, both of these would read "behind" — and a manager
  // filtering for "Behind · under 50%" would be handed a list of people who missed nothing.
  assert.equal(coverageBandOf(noPlan), "noplan", "no measurable plan is never a coverage failure");
  assert.equal(frequencyBandOf(noPlan), "noplan", "no measurable plan is never a frequency failure");
  assert.notEqual(coverageBandOf(noPlan), "behind", "a rep with no plan must not land in the Behind band");

  // Same rule on the other axis: a rep with no CRM row at all in the window has no call rate. That
  // can be leave, a sync gap, or a genuinely idle period, and the board must not pick one.
  const loggedNothing = row({ hasCallRate: false, amAttainmentPct: null, pmAttainmentPct: null });
  assert.equal(
    amBandOf(loggedNothing),
    "noplan",
    "a rep who logged nothing has no AM band — 'Behind' would state something the data cannot say",
  );
  assert.equal(pmBandOf(loggedNothing), "noplan", "and no PM band either, for the same reason");

  // THE OWNER'S RULE, 2026-09-04: the two are banded APART. A morning that hit its target sits in
  // one band while the afternoon that missed sits in another, and no third band merges them —
  // which is what a manager filtering "Behind" needs, because the two failures are different jobs.
  const morningOnly = row({ hasCallRate: true, amAttainmentPct: 100, pmAttainmentPct: 20 });
  assert.equal(amBandOf(morningOnly), "elite", "2 of 2 in the morning is elite on its own axis");
  assert.equal(pmBandOf(morningOnly), "behind", "2 of 10 in the afternoon is behind on its own axis");

  // The boundaries themselves, at the exact edge in both directions.
  assert.equal(coverageBandOf(row({ coveragePct: 90 })), "elite", "90 is elite");
  assert.equal(coverageBandOf(row({ coveragePct: 89 })), "strong", "89 is strong");
  assert.equal(coverageBandOf(row({ coveragePct: 75 })), "strong", "75 is strong");
  assert.equal(coverageBandOf(row({ coveragePct: 74 })), "steady", "74 is steady");
  assert.equal(coverageBandOf(row({ coveragePct: 50 })), "steady", "50 is steady");
  assert.equal(coverageBandOf(row({ coveragePct: 49 })), "behind", "49 is behind");
  assert.equal(coverageBandOf(row({ coveragePct: 0 })), "behind", "a real measured zero IS behind");

  // Filtering by the `noplan` band must return exactly the unmeasurable reps, so the two
  // populations can be separated in one click.
  const rows = [row({ agentCrmId: 1, repName: "Has plan" }), row({ agentCrmId: 2, repName: "No plan", hasMeasurablePlan: false })];
  assert.deepEqual(
    applyKpiFilters(rows, filters({ coverage: ["noplan"] })).map((entry) => entry.repName),
    ["No plan"],
    "the noplan band isolates the reps nothing was asked of",
  );
  assert.deepEqual(
    applyKpiFilters(rows, filters({ coverage: ["behind"] })).map((entry) => entry.repName),
    [],
    "and Behind does not quietly include them",
  );

  // Flags describe the same rows without overlapping claims.
  assert.ok(kpiFlagsOf(row({ visitedDoctors: 0 })).includes("never-reached"), "planned but visited nobody is flagged");
  assert.ok(
    !kpiFlagsOf(row({ hasMeasurablePlan: false, visitedDoctors: 0 })).includes("never-reached"),
    "a rep with no plan cannot have 'never reached a planned doctor' — there were none",
  );
  assert.ok(
    kpiFlagsOf(row({ campaignShare: 0.6, campaignCalls: 30 })).includes("campaign-heavy"),
    "half or more campaign work is flagged as unverifiable",
  );
}

// ── 3. Nulls park last, in BOTH directions ────────────────────────────────────────────────────

export function runKpiSortTests() {
  const rows = [
    row({ agentCrmId: 1, repName: "Best", coveragePct: 90 }),
    row({ agentCrmId: 2, repName: "Worst", coveragePct: 10 }),
    row({ agentCrmId: 3, repName: "Unmeasurable", hasMeasurablePlan: false, coveragePct: 0 }),
  ];

  // Descending: best first, unmeasurable last.
  assert.deepEqual(
    sortKpiRows(rows, "coverage", "desc").map((entry) => entry.repName),
    ["Best", "Worst", "Unmeasurable"],
    "best first when descending, and the unmeasurable rep is not treated as a 0",
  );

  // THE ONE THAT MATTERS. Ascending is "worst first" — the view a manager opens to find the
  // problem. If nulls sorted first, the top of that list would be the reps who were never given a
  // plan, and the rep who actually missed ninety doctors would be pushed below them.
  assert.deepEqual(
    sortKpiRows(rows, "coverage", "asc").map((entry) => entry.repName),
    ["Worst", "Best", "Unmeasurable"],
    "worst first when ascending — but the unmeasurable rep STILL parks last, not first",
  );

  // Ties break on the name, so the order is stable rather than dependent on input order.
  const tied = [
    row({ agentCrmId: 1, repName: "Zeinab", coveragePct: 50 }),
    row({ agentCrmId: 2, repName: "Amir", coveragePct: 50 }),
  ];
  assert.deepEqual(
    sortKpiRows(tied, "coverage", "desc").map((entry) => entry.repName),
    ["Amir", "Zeinab"],
    "an equal score falls back to the name, so the list does not reshuffle between loads",
  );

  // A NEW numeric column opens descending (best/worst first is the question being asked); a new
  // text column opens ascending; the SAME column flips.
  assert.deepEqual(
    nextKpiSort(filters(), "coverage"),
    filters({ sort: "coverage", direction: "desc" }),
    "a new NUMERIC column opens descending — a manager clicking Coverage wants the top or the bottom",
  );
  assert.deepEqual(
    nextKpiSort(filters({ sort: "coverage", direction: "desc" }), "rep"),
    filters({ sort: "rep", direction: "asc" }),
    "a new TEXT column opens ascending",
  );
  // The default state is already sorted by rep ascending, so clicking that header flips it. This is
  // the same rule as below, asserted from the state a manager actually starts in.
  assert.deepEqual(
    nextKpiSort(filters(), "rep"),
    filters({ sort: "rep", direction: "desc" }),
    "clicking the column the board already opens on flips it rather than doing nothing",
  );
  assert.deepEqual(
    nextKpiSort(filters({ sort: "coverage", direction: "desc" }), "coverage"),
    filters({ sort: "coverage", direction: "asc" }),
    "clicking the sorted column flips it",
  );
}

// ── 4. The URL carries everything, on every control ───────────────────────────────────────────

export function runKpiUrlTests() {
  const state = filters({
    lines: ["Pedia"],
    areas: ["GZ3", "CA1"],
    flags: ["never-reached"],
    coverage: ["behind"],
    query: "ali",
    sort: "coverage",
    direction: "desc",
  });

  // Round trip. Anything lost here is lost on every navigation the board makes.
  assert.deepEqual(parseKpiFilters(kpiFiltersToParams(state)), state, "filters survive a serialise/parse round trip");

  // Defaults are OMITTED, so an unfiltered board has a short, shareable URL.
  assert.deepEqual(kpiFiltersToParams(EMPTY_KPI_FILTERS), {}, "an empty filter state produces no parameters at all");

  // THE PERIOD-PICKER REGRESSION. Changing the month, the period or the tab must carry the filters
  // through. A builder that dropped them would show a WIDER board than the manager asked for while
  // the active-filter chips still said the filter was on.
  const query = buildKpisQuery({ month: "2026-09", period: "w2", tab: "coverage", filters: state });
  const parsedBack = new URLSearchParams(query);
  assert.equal(parsedBack.get("month"), "2026-09");
  assert.equal(parsedBack.get("period"), "w2");
  assert.equal(parsedBack.get("tab"), "coverage");
  assert.equal(parsedBack.get("line"), "Pedia", "the line filter survives a tab change");
  assert.equal(parsedBack.get("area"), "GZ3,CA1", "a multi-value facet survives a tab change");
  assert.equal(parsedBack.get("q"), "ali", "the search text survives a tab change");
  assert.deepEqual(
    parseKpiFilters(Object.fromEntries(parsedBack)),
    state,
    "and the whole state parses back out of the URL the picker built",
  );

  // The two defaults stay out of the address bar.
  const plain = buildKpisQuery({ month: "2026-09", period: "month", tab: "summary", filters: EMPTY_KPI_FILTERS });
  assert.equal(plain, "month=2026-09", "a whole month on the summary tab with no filters is just the month");

  // A repeated parameter resolves to its FIRST value rather than to an array.
  assert.equal(parseKpiFilters({ sort: ["coverage", "frequency"] }).sort, "coverage");
}

// ── 5. Facets come from the data, and count it ────────────────────────────────────────────────

export function runKpiFacetTests() {
  const rows = [
    row({ agentCrmId: 1, lineName: "Pedia", areaName: "GZ3" }),
    row({ agentCrmId: 2, lineName: "Pedia", areaName: "CA1" }),
    row({ agentCrmId: 3, lineName: "CNS", areaName: null }),
  ];
  const facets = buildKpiFacets(rows);

  assert.deepEqual(
    facets.lines.map((option) => [option.value, option.count]),
    [["CNS", 1], ["Pedia", 2]],
    "line options come from the rows themselves, alphabetically, with real counts",
  );

  // A row whose area never resolved gets its own bucket rather than disappearing. That population
  // is the most likely to be a data defect, and it is invisible without a way to ask for it.
  const unassigned = facets.areas.find((option) => option.value === UNASSIGNED_FACET_KEY);
  assert.ok(unassigned, "an unresolved area becomes a real, selectable facet option");
  assert.equal(unassigned?.count, 1);
  assert.equal(
    facets.areas[facets.areas.length - 1]?.value,
    UNASSIGNED_FACET_KEY,
    "'Not recorded' sorts last — it is a data-quality bucket, not a place",
  );
  assert.deepEqual(
    applyKpiFilters(rows, filters({ areas: [UNASSIGNED_FACET_KEY] })).map((entry) => entry.agentCrmId),
    [3],
    "and selecting it returns exactly the rows with no area",
  );

  // A band nobody is in is not offered — a dead zero in a filter panel invites a click that empties
  // the board for no reason.
  assert.ok(
    facets.coverage.every((option) => option.count > 0),
    "no band is offered with a zero count",
  );

  // "Reports to" walks the whole chain (owner, 2026-10-20: "when you filter by manager you find no
  // manager"). A National Sales Manager is offered, counted once per rep beneath him, and choosing
  // him keeps every one of those reps — not only the reps whose direct manager he is.
  const chained = [
    row({ agentCrmId: 11, managerName: "District One", managersAbove: ["National One"] }),
    row({ agentCrmId: 12, managerName: "District Two", managersAbove: ["Regional One", "National One"] }),
    row({ agentCrmId: 13, managerName: "District Three", managersAbove: [] }),
    row({ agentCrmId: 14, managerName: null }),
  ];
  assert.deepEqual(
    buildKpiFacets(chained).managers.map((option) => [option.value, option.count]),
    [
      ["District One", 1],
      ["District Three", 1],
      ["District Two", 1],
      ["National One", 2],
      ["Regional One", 1],
      [UNASSIGNED_FACET_KEY, 1],
    ],
    "every manager on the chain is offered, with the reps beneath him counted",
  );
  const kept = (managers: string[]) =>
    applyKpiFilters(chained, filters({ managers })).map((entry) => entry.agentCrmId).sort();
  assert.deepEqual(kept(["National One"]), [11, 12], "choosing the National Sales Manager keeps every rep under him");
  assert.deepEqual(kept(["Regional One"]), [12], "choosing the Regional Manager keeps his reps only");
  assert.deepEqual(kept(["District Two"]), [12], "a district manager still keeps exactly his own reps");
  assert.deepEqual(kept([UNASSIGNED_FACET_KEY]), [14], "'Not recorded' is still the rows with no manager at all");
}

// ── 6. The podium ranks nobody it cannot honestly rank ────────────────────────────────────────

export function runKpiPodiumTests() {
  const rows = [
    row({ agentCrmId: 1, repName: "Top coverage", coveragePct: 99, frequencyPct: 10, amAttainmentPct: 10, pmAttainmentPct: 10 }),
    row({ agentCrmId: 2, repName: "Top frequency", coveragePct: 10, frequencyPct: 99, amAttainmentPct: 10, pmAttainmentPct: 10 }),
    row({ agentCrmId: 3, repName: "Top AM", coveragePct: 10, frequencyPct: 10, amAttainmentPct: 99, pmAttainmentPct: 10 }),
    row({ agentCrmId: 6, repName: "Top PM", coveragePct: 10, frequencyPct: 10, amAttainmentPct: 10, pmAttainmentPct: 99 }),
    // Deliberately given a LOW call rate rather than the fixture default: having no plan does not
    // mean logging no calls, and at the default 100% this rep would legitimately top the call-rate
    // podium and mask what the assertion below is trying to prove.
    row({
      agentCrmId: 4,
      repName: "No plan",
      hasMeasurablePlan: false,
      coveragePct: 0,
      frequencyPct: 0,
      amAttainmentPct: 5,
      pmAttainmentPct: 5,
    }),
    row({ agentCrmId: 5, repName: "No calls", hasCallRate: false, amAttainmentPct: null, pmAttainmentPct: null }),
  ];
  const podium = buildKpiPodium(rows);

  // FOUR LEADERBOARDS, FOUR ANSWERS. There is no blended "best rep" anywhere — and on these
  // fixtures the winners are four different people, which is the shape production produces (68%
  // coverage against 39% frequency in one month).
  assert.equal(podium.coverage[0]?.repName, "Top coverage");
  assert.equal(podium.frequency[0]?.repName, "Top frequency");

  // THE OWNER'S RULE ON THE LEADERBOARD. AM is ranked against 2 and PM against 10, apart, so the
  // best morning and the best afternoon are two questions. A single blended call-rate podium could
  // not have named both of these people, and would have named neither if a third rep had been
  // merely good at both — which is exactly the averaging that hides a bad afternoon.
  assert.equal(podium.amCallRate[0]?.repName, "Top AM");
  assert.equal(podium.pmCallRate[0]?.repName, "Top PM");
  assert.notEqual(
    podium.amCallRate[0]?.repName,
    podium.pmCallRate[0]?.repName,
    "the morning leader and the afternoon leader are different people here — the whole reason the two are ranked apart",
  );

  // Nobody is put on a podium at 0% for a measure they have no value on.
  for (const entry of [...podium.coverage, ...podium.frequency]) {
    assert.notEqual(entry.repName, "No plan", "a rep with no plan is never ranked on coverage or frequency");
  }
  for (const entry of [...podium.amCallRate, ...podium.pmCallRate]) {
    assert.notEqual(entry.repName, "No calls", "a rep who logged nothing is never ranked on either call rate");
  }
  assert.ok(podium.coverage.length <= 3, "a podium holds at most three");
  assert.deepEqual(buildKpiPodium([]).coverage, [], "an empty board produces an empty podium, not a crash");
}

// ── 7. AM and PM are scored apart, and identity is stamped by canonical hr id ─────────────────

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
    // Separate from AM/PM entirely (owner, 2026-09-05) — target null, no target set yet.
    pharmacy: { verified: 0, unverified: 0, campaign: 0, total: 0, verifiedRate: null, totalRate: null, target: null, attainmentPct: null },
    unspecified: 0,
    awaitingValidation: 0,
    campaignShare: 0,
    campaignOverLimitDays: [],
    campaignOnlyDays: 0,
    ...overrides,
  };
}

export function runKpiAttainmentAndIdentityTests() {
  // THE OWNER'S RULE, 2026-09-04: "this two and this ten. Don't never get average."
  //
  // This rep hit his AM target exactly and did nothing all afternoon. Every way of combining the
  // two into one figure tells a manager something false about that day: averaging the percentages
  // reads 50%, and putting both over one denominator — which this board did until today — reads
  // 2 of 12 = 17%. Neither says the true thing, which is that the morning was perfect and the
  // afternoon did not happen. So the board reports 100% and 0% and stops there.
  const [hitAmOnly] = joinKpiRows({
    callRates: [callRateFixture()],
    docLists: [],
    scope: { kind: "company", basis: "company", label: "test" },
    workingDays: 1,
    amTarget: 2,
    pmTarget: 10,
  });
  assert.equal(hitAmOnly?.amAttainmentPct, 100, "2 verified AM calls against a target of 2 is 100% of the AM standard");
  assert.equal(hitAmOnly?.pmAttainmentPct, 0, "and nothing all afternoon is 0% of the PM standard, said plainly");
  assert.ok(
    !("callRateAttainmentPct" in (hitAmOnly ?? {})),
    "there is NO combined figure on the row at all — the only reliable way to keep one from being printed",
  );

  // Identity is stamped by CANONICAL hr id. Production ids are mixed case and carry legacy aliases,
  // so a case-sensitive match would leave this rep with no line and no area — which reads on screen
  // as a data gap rather than as a bug, and quietly removes him from every organisational filter.
  const [withIdentity] = joinKpiRows({
    callRates: [callRateFixture()],
    docLists: [],
    scope: { kind: "company", basis: "company", label: "test" },
    workingDays: 1,
    directory: [
      {
        hrId: "a-77",
        displayName: "Directory Name",
        lineName: "Pedia",
        regionName: "Giza",
        areaName: "GZ3",
        managerName: "Manager One",
        jobTitle: "Medical Rep",
      },
    ],
  });
  assert.equal(withIdentity?.lineName, "Pedia", "a MIXED-CASE hr id still resolves to its employee record");
  assert.equal(withIdentity?.areaName, "GZ3");
  assert.equal(
    withIdentity?.repName,
    "Directory Name",
    "the directory's nickname-aware display name wins over the vendor's spelling (the owner's human-readable-names rule)",
  );

  // No directory entry: null identity, and the row still appears. Dropping it would hide a real rep
  // from his own manager because a lookup failed.
  const [withoutIdentity] = joinKpiRows({
    callRates: [callRateFixture()],
    docLists: [],
    scope: { kind: "company", basis: "company", label: "test" },
    workingDays: 1,
  });
  assert.equal(withoutIdentity?.lineName, null, "an unresolved rep keeps a null line rather than borrowing one");
  assert.equal(withoutIdentity?.repName, "Vendor Spelling", "and keeps the name the CRM did supply");

  // THE OWNER'S COVERAGE FLOOR, 2026-09-05: "coverage no less than 95%." The constant and the flag
  // are two different things that could independently drift; this pins them together so a change
  // to one without the other fails here.
  assert.equal(COVERAGE_TARGET_FLOOR_PCT, 95, "the owner's own number, pinned");

  assert.ok(
    kpiFlagsOf(row({ hasMeasurablePlan: true, coveragePct: 94, meetsCoverageFloor: false })).includes(
      "below-coverage-floor",
    ),
    "94% has a measurable plan and misses the 95% floor by one point",
  );
  assert.ok(
    !kpiFlagsOf(row({ hasMeasurablePlan: true, coveragePct: 95, meetsCoverageFloor: true })).includes(
      "below-coverage-floor",
    ),
    "95% itself clears the floor — the boundary is inclusive",
  );
  assert.ok(
    !kpiFlagsOf(row({ hasMeasurablePlan: false, coveragePct: 0, meetsCoverageFloor: null })).includes(
      "below-coverage-floor",
    ),
    "no plan means nothing to have missed — never flagged as below the floor",
  );
}

// ── 8. The board is medical reps only ─────────────────────────────────────────────────────────

export function runKpiMedicalRepOnlyTests() {
  // Owner, 2026-09-03: "only show medical reps in this page". The composition measured on
  // production that day, September 2026 at Super Admin scope, was 63 medical representatives,
  // 6 district sales managers and 1 product manager — so this drops exactly the 7.
  //
  // WHO COUNTS AS A REP is asserted in tests/crm-medical-rep.test.ts, against the one rule in
  // crm/medical-rep.ts that both CRM boards now call. This file deliberately does not re-assert it:
  // a second copy of those expectations is what let two implementations drift apart in the first
  // place, and a pinning test that pins the wrong copy is worse than no test. What is asserted here
  // is the part that belongs to THIS board — WHERE the narrowing happens.
  const rows = [
    row({ agentCrmId: 1, repName: "Rep", jobTitle: "Medical Representative" }),
    row({ agentCrmId: 2, repName: "Short spelling", jobTitle: "Medical Rep" }),
    row({ agentCrmId: 3, repName: "District manager", jobTitle: "District Sales Manager" }),
    row({ agentCrmId: 4, repName: "Product manager", jobTitle: "Product Manager" }),
    row({ agentCrmId: 5, repName: "No title", jobTitle: null }),
  ];

  assert.deepEqual(
    keepMedicalRepsOnly(rows).map((entry) => entry.repName),
    ["Rep", "Short spelling"],
    "managers are dropped; both live spellings of the rep title are kept",
  );

  // A KpiRepRow must keep satisfying the helper's structural parameter. The helper takes
  // `{ jobTitle: string | null }` rather than KpiFilterableRow so that one rule can serve a board
  // whose row type it does not import — and a widened KpiRepRow that stopped matching would fail
  // HERE, at the call site, rather than silently somewhere downstream.
  const kept: KpiRepRow[] = keepMedicalRepsOnly(rows);
  assert.equal(kept.length, 2);

  // The restriction runs before the facets, so it can never be undone from the URL. A district
  // manager left on the board would score 'No plan' on two of three measures and drag the team
  // averages toward a number describing nobody.
  assert.equal(
    applyKpiFilters(kept, filters({ titles: ["District Sales Manager"] })).length,
    0,
    "no query string can bring a dropped manager back — the narrowing happens above the filter layer",
  );

  // Managers come back on 2026-10-20 — as rows of AVERAGES in a list of their own, never as rep rows.
  runKpiManagerRowChecks();
}

// ── 8b. Manager rows: each manager is the average of the rows directly beneath him ─────────────
//
// Owner, 2026-10-20: "add manager row and every dm kpis is calculated based on his reps averag and
// nsm based on dsms av and so on". Every check below is a way of getting that wrong that still
// prints a plausible number: a no-plan rep averaged in as 0, a National Sales Manager averaged over
// every rep at the bottom of his tree instead of over his managers, AM and PM folded into one figure,
// a manager slipping into the rep list or its totals, and a manager row averaging reps the viewer
// may not see.

type OrgPerson = { hrId: string; name: string; title: string; manager: string | null; area: string | null };

const MANAGER_ORG: readonly OrgPerson[] = [
  { hrId: "C-1", name: "Chief Exec", title: "Chief Executive Officer", manager: null, area: null },
  { hrId: "N-1", name: "Nadia National", title: "National Sales Manager", manager: "C-1", area: null },
  { hrId: "R-1", name: "Rami Regional", title: "Regional Sales Manager", manager: "N-1", area: null },
  { hrId: "D-1", name: "Dina District", title: "District Sales Manager", manager: "N-1", area: "GZ1" },
  { hrId: "D-2", name: "Dalia District", title: "District Sales Manager", manager: "R-1", area: "GZ2" },
  // A District Manager reporting straight to the top, past the national line.
  { hrId: "D-3", name: "Dora District", title: "District Sales Manager", manager: "C-1", area: "GZ3" },
  { hrId: "MR-1", name: "Rep A", title: "Medical Representative", manager: "D-1", area: "GZ1" },
  { hrId: "MR-2", name: "Rep B", title: "Medical Representative", manager: "D-1", area: "GZ1" },
  { hrId: "MR-3", name: "Rep C", title: "Medical Representative", manager: "D-1", area: "GZ1" },
  { hrId: "MR-4", name: "Rep D", title: "Medical Representative", manager: "D-2", area: "GZ2" },
  { hrId: "MR-5", name: "Rep E", title: "Medical Representative", manager: "D-2", area: "GZ2" },
  { hrId: "MR-6", name: "Rep F", title: "Medical Representative", manager: "D-2", area: "GZ2" },
  { hrId: "MR-8", name: "Rep H", title: "Medical Representative", manager: "D-3", area: "GZ3" },
];

function managerOrgDirectory(): KpiDirectoryEntry[] {
  const byId = new Map(MANAGER_ORG.map((person) => [person.hrId, person]));
  return MANAGER_ORG.map((person) => {
    const chain: string[] = [];
    let next = person.manager ? byId.get(person.manager) : undefined;
    while (next) {
      chain.push(next.name);
      next = next.manager ? byId.get(next.manager) : undefined;
    }
    return {
      hrId: person.hrId,
      displayName: person.name,
      lineName: "Pedia",
      regionName: person.hrId === "C-1" ? null : "Giza",
      areaName: person.area,
      managerName: chain[0] ?? null,
      managersAbove: chain.slice(1),
      managerHrId: person.manager,
      jobTitle: person.title,
    };
  });
}

/** Each rep's printed figures. MR-3 and MR-8 have calls but no plan: "No plan" on coverage and frequency. */
function managerOrgReps(): KpiRepRow[] {
  const figures: Record<string, Partial<KpiRepRow>> = {
    "MR-1": { coveragePct: 90, frequencyPct: 80, amAttainmentPct: 100, pmAttainmentPct: 30 },
    "MR-2": { coveragePct: 70, frequencyPct: 60, amAttainmentPct: 50, pmAttainmentPct: 90 },
    "MR-3": { hasMeasurablePlan: false, coveragePct: 0, frequencyPct: 0, amAttainmentPct: 75, pmAttainmentPct: 60 },
    "MR-4": { coveragePct: 30, frequencyPct: 20, amAttainmentPct: 45, pmAttainmentPct: 40 },
    "MR-5": { coveragePct: 30, frequencyPct: 20, amAttainmentPct: 45, pmAttainmentPct: 40 },
    "MR-6": { coveragePct: 30, frequencyPct: 20, amAttainmentPct: 45, pmAttainmentPct: 40 },
    "MR-8": { hasMeasurablePlan: false, coveragePct: 0, frequencyPct: 0, amAttainmentPct: 20, pmAttainmentPct: 10 },
  };
  return MANAGER_ORG.filter((person) => person.hrId.startsWith("MR-")).map((person, index) => {
    const own = figures[person.hrId] ?? {};
    const planned = own.hasMeasurablePlan ?? true;
    const manager = MANAGER_ORG.find((candidate) => candidate.hrId === person.manager);
    return row({
      agentCrmId: 100 + index,
      agentHrId: person.hrId.toLowerCase(),
      repName: person.name,
      areaName: person.area,
      managerName: manager?.name ?? null,
      jobTitle: person.title,
      ...own,
      meetsCoverageFloor: planned ? (own.coveragePct ?? 0) >= 95 : null,
    });
  });
}

function runKpiManagerRowChecks() {
  const directory = managerOrgDirectory();
  const reps = managerOrgReps();
  const repsBefore = structuredClone(reps);
  const totalsBefore = sumKpiTeamTotals(reps);
  const podiumBefore = buildKpiPodium(reps);

  const managers = buildKpiManagerRows({ reps, directory });
  const named = (name: string) => {
    const found = managers.find((manager) => manager.name === name);
    if (!found) throw new assert.AssertionError({ message: `${name} has a manager row` });
    return found;
  };

  assert.deepEqual(
    managers.map((manager) => manager.name),
    ["Chief Exec", "Dora District", "Nadia National", "Dina District", "Rami Regional", "Dalia District"],
    "tree order: each manager before the managers beneath him, siblings by name",
  );

  // A DISTRICT MANAGER is the simple mean of HIS reps' rows.
  const dina = named("Dina District");
  assert.equal(dina.level, "district");
  assert.equal(dina.hrId, "d-1", "keyed by the canonical lower-cased hr id, the same form as a rep row's");
  assert.equal(dina.directReps, 3);
  assert.equal(dina.directManagers, 0);
  assert.equal(dina.averagedRows, 3);
  assert.equal(dina.repsBeneath, 3);
  assert.equal(
    dina.coveragePct,
    80,
    "his coverage is the mean of 90 and 70 — the no-plan rep is LEFT OUT, not averaged in as 0 (that would read 53)",
  );
  assert.equal(dina.measured.coveragePct, 2, "and the row says only two of his three reps went into that figure");
  assert.equal(dina.frequencyPct, 70);
  assert.equal(dina.measured.frequencyPct, 2);

  // AM AND PM ARE TWO AVERAGES (owner, 2026-09-04: "this two and this ten. Don't never get average").
  assert.equal(dina.amAttainmentPct, 75, "AM is the mean of the three AM figures — 100, 50 and 75");
  assert.equal(dina.pmAttainmentPct, 60, "PM is the mean of the three PM figures — 30, 90 and 60 — on its own");
  assert.equal(dina.measured.amAttainmentPct, 3, "the no-plan rep still has calls, so he IS measured on AM");
  assert.ok(
    KPI_MANAGER_MEASURES.includes("amAttainmentPct") && KPI_MANAGER_MEASURES.includes("pmAttainmentPct"),
    "AM and PM attainment are separate measures",
  );
  assert.ok(
    !("callRateAttainmentPct" in dina) && !("attainmentPct" in dina),
    "there is no combined AM+PM figure on a manager row at all",
  );

  // EVERY MANAGER ABOVE averages the rows DIRECTLY beneath him — never every rep at the bottom.
  const rami = named("Rami Regional");
  assert.equal(rami.level, "regional");
  assert.equal(rami.directManagers, 1);
  assert.equal(rami.directReps, 0);
  assert.equal(rami.coveragePct, 30, "a Regional Manager over one District Manager carries that DM's figures");

  const nadia = named("Nadia National");
  assert.equal(nadia.level, "national");
  assert.equal(nadia.directManagers, 2);
  assert.equal(nadia.averagedRows, 2);
  assert.equal(nadia.repsBeneath, 6, "six reps beneath her, counted once each");
  assert.equal(
    nadia.coveragePct,
    55,
    "the NSM's coverage is the mean of her two managers' rows (80 and 30) — NOT 50, the mean of the five planned reps beneath her",
  );
  assert.equal(nadia.frequencyPct, 45, "the mean of 70 and 20 — not 40, the mean of the reps");
  assert.equal(nadia.amAttainmentPct, 60, "AM: the mean of 75 and 45");
  assert.equal(nadia.pmAttainmentPct, 50, "PM: the mean of 60 and 40, apart from AM");

  // A manager whose rows beneath carry NO value on a measure has none either — never a 0.
  const dora = named("Dora District");
  assert.equal(dora.coveragePct, null, "his only rep has no plan, so his coverage is null rather than 0");
  assert.equal(dora.frequencyPct, null);
  assert.equal(dora.measured.coveragePct, 0);
  assert.equal(dora.amAttainmentPct, 20, "while his AM is still measured");

  const chief = named("Chief Exec");
  assert.equal(chief.level, "other");
  assert.equal(chief.reportsTo, null);
  assert.equal(chief.repsBeneath, 7);
  assert.equal(chief.averagedRows, 2);
  assert.equal(chief.coveragePct, 55, "Dora's null is left out of the CEO's coverage, so it is Nadia's 55 alone");
  assert.equal(chief.measured.coveragePct, 1);
  assert.equal(chief.amAttainmentPct, 40, "and on AM both are measured: the mean of 60 and 20");
  assert.equal(chief.pmAttainmentPct, 30, "PM: the mean of 50 and 10");

  // What one rep row contributes: the figure it PRINTS, or nothing where it prints a marker.
  const noFeed = kpiRepMeasures(row({ noGpsFeed: true }));
  assert.equal(noFeed.amAttainmentPct, null, "a 'No GPS feed' rep is not averaged into the proved figures");
  assert.equal(noFeed.amReportedRate, 3, "but his reported rate still is");
  const noCalls = kpiRepMeasures(row({ hasCallRate: false, totalCalls: 0 }));
  assert.equal(noCalls.amAttainmentPct, null, "a 'No calls' rep is not averaged in as 0%");
  assert.equal(noCalls.amReportedRate, null);
  assert.equal(noCalls.campaignShare, null);

  // THE REP LIST, ITS TOTALS AND ITS PODIUM ARE UNTOUCHED — a manager is never a rep row.
  assert.deepEqual(reps, repsBefore, "building the manager rows changes no rep row");
  assert.deepEqual(sumKpiTeamTotals(reps), totalsBefore, "the team totals are the reps' totals, unchanged");
  assert.deepEqual(buildKpiPodium(reps), podiumBefore, "the podium is the reps' podium, unchanged");
  const managerKeys = new Set(managers.map((manager) => manager.hrId));
  assert.ok(
    reps.every((rep) => !managerKeys.has(rep.agentHrId ?? "")),
    "no manager appears among the rep rows",
  );
  const boardSource = readFileSync(new URL("../src/lib/crm/kpis-board.ts", import.meta.url), "utf8");
  assert.match(boardSource, /sumKpiTeamTotals\(reps\)/, "the board's totals are summed over the rep rows");
  assert.match(boardSource, /buildKpiPodium\(reps, /, "and its podium is built from the rep rows");
  assert.doesNotMatch(
    boardSource,
    /(?:sumKpiTeamTotals|buildKpiPodium|buildKpiFacets|applyKpiFilters|kpiTeamFigures)\((?:scoped)?[mM]anagers/,
    "no manager row ever reaches the totals, the podium, the facets or the rep filters",
  );
  assert.match(
    boardSource,
    /buildKpiManagerRows\(\{\s*reps: scopedReps,/,
    "manager rows are built from the scoped rep rows BEFORE any filter, so a filter never changes an average",
  );

  // THE SCOPE GATE. A Regional Manager's board: his scope reaches his District Manager and her reps
  // and nothing else. A rep outside it is never averaged, and the managers above him get no row.
  const rsmScope: DoctorCoverageScope = {
    kind: "agents",
    basis: "team",
    agentHrIds: ["D-2", "MR-4", "MR-5", "MR-6"],
    label: "Rami's team",
  };
  const scopedReps = joinKpiRows({
    callRates: [
      callRateFixture({ agentCrmId: 201, agentHrId: "MR-1", agentName: "Rep A" }),
      callRateFixture({ agentCrmId: 204, agentHrId: "MR-4", agentName: "Rep D" }),
      callRateFixture({ agentCrmId: 205, agentHrId: "MR-5", agentName: "Rep E" }),
    ],
    docLists: [],
    scope: rsmScope,
    workingDays: 1,
    directory,
  });
  assert.equal(scopedReps.length, 2, "the rep outside Rami's reach is dropped by the scope gate before anything is averaged");
  const viewerKey = normalizeHrIdForAccess("R-1");
  const visible = buildKpiManagerRows({
    reps: scopedReps,
    directory,
    canSee: (hrId) => isAgentInScope(rsmScope, hrId) || normalizeHrIdForAccess(hrId) === viewerKey,
  });
  assert.deepEqual(
    visible.map((manager) => manager.name),
    ["Rami Regional", "Dalia District"],
    "he sees himself and his scope down: no row for Nadia or the CEO above him, and none for Dina, whose rep he cannot reach",
  );
  assert.equal(visible[0]?.repsBeneath, 2, "and his own row counts only the reps his scope let through");
  assert.equal(
    buildKpiManagerRows({ reps: scopedReps, directory, canSee: (hrId) => isAgentInScope(rsmScope, hrId) }).some(
      (manager) => manager.name === "Rami Regional",
    ),
    false,
    "his own row comes from the viewer arm, not from his scope list",
  );
  assert.match(
    boardSource,
    /canSee: \(hrId\) =>\s*isAgentInScope\(scope, hrId\) \|\| \(viewerKey != null && normalizeHrIdForAccess\(hrId\) === viewerKey\)/,
    "the board gates manager rows with the same two arms",
  );

  // THE FILTERS. "Reports to" keeps the chosen manager and every manager beneath him; "Not recorded"
  // keeps none; an area filter hides a manager only where his own record names a different area.
  assert.deepEqual(
    applyKpiManagerFilters(managers, filters({ managers: ["Nadia National"] })).map((manager) => manager.name),
    ["Nadia National", "Dina District", "Rami Regional", "Dalia District"],
    "Reports to Nadia keeps her own row and every manager beneath her, and not the CEO or Dora",
  );
  assert.equal(applyKpiManagerFilters(managers, filters({ managers: [UNASSIGNED_FACET_KEY] })).length, 0);
  assert.deepEqual(
    applyKpiManagerFilters(managers, filters({ areas: ["GZ1"] })).map((manager) => manager.name),
    ["Chief Exec", "Nadia National", "Dina District", "Rami Regional"],
    "area GZ1 drops the District Managers of GZ2 and GZ3 and keeps the managers whose record names no area",
  );
  const filtered = applyKpiManagerFilters(managers, filters({ areas: ["GZ1"] }));
  assert.equal(filtered.find((manager) => manager.name === "Nadia National")?.coveragePct, 55, "a filter never changes an average");
}

// ── 9. A percentage early in a window is a position, not a score ──────────────────────────────

export function runKpiTooEarlyToScoreTests() {
  // THE REAL NUMBERS THIS EXISTS FOR. Measured on production 2026-09-03, two working days into a
  // September that holds twenty-two:
  //
  //     Sep 1-2, first two working days   40.2% coverage
  //     Aug 1-2, first two working days   40.1% coverage
  //     August, whole closed month        71.4% coverage
  //
  // The team was within a tenth of a point of the previous month at the same point in it, and the
  // board still headlined "Most of the planned list has not been reached at all yet". The maths was
  // right; the sentence was an accusation the data could not support.
  assert.equal(isTooEarlyToScore(2, 22), true, "two working days into a 22-day month cannot be a verdict");
  assert.equal(isTooEarlyToScore(7, 22), true, "a third of the way in is still short of the threshold");
  assert.equal(isTooEarlyToScore(8, 22), false, "past a third, a shortfall is no longer explained by the calendar");
  assert.equal(isTooEarlyToScore(22, 22), false, "a closed month is always judged");

  // ZERO WORKED IS NOT 'TOO EARLY'. A window with no working days at all is a different state — the
  // board answers it separately, and relabelling it here would hide an empty period behind a
  // reassuring sentence about the month being young.
  assert.equal(isTooEarlyToScore(0, 22), false, "no days worked is an empty window, not an early one");
  assert.equal(isTooEarlyToScore(0, 0), false);
  assert.equal(isTooEarlyToScore(3, 0), false, "a window of no length can never be scored either way");

  // A WEEK is the case a day-count threshold would get wrong: 1 of 5 days is the same position as
  // 4 of 22, and both must read the same way.
  assert.equal(isTooEarlyToScore(1, 5), true, "one day into a five-day week is the same position as four into a month");
  assert.equal(isTooEarlyToScore(2, 5), false, "two of five is past a third — judged");

  assert.ok(
    KPI_VERDICT_THRESHOLD > 0 && KPI_VERDICT_THRESHOLD < 1,
    "the threshold is a SHARE of the window, never a day count — a fixed day count reads a week and a month identically wrong",
  );
}
