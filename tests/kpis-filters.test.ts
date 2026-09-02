import assert from "node:assert/strict";

import { joinKpiRows, buildKpiPodium, type KpiRepRow } from "../src/lib/crm/kpis-board.ts";
import {
  applyKpiFilters,
  buildKpiFacets,
  buildKpisQuery,
  callRateBandOf,
  coverageBandOf,
  EMPTY_KPI_FILTERS,
  frequencyBandOf,
  kpiFiltersToParams,
  kpiFlagsOf,
  nextKpiSort,
  parseKpiFilters,
  isMedicalRepTitle,
  isTooEarlyToScore,
  KPI_VERDICT_THRESHOLD,
  keepMedicalRepsOnly,
  sortKpiRows,
  UNASSIGNED_FACET_KEY,
  type KpiFilterState,
} from "../src/lib/crm/kpis-filters.ts";
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
    totalCalls: 240,
    campaignCalls: 0,
    campaignShare: 0,
    campaignOnlyDays: 0,
    hasCallRate: true,
    callRateAttainmentPct: 100,
    plannedDoctors: 100,
    coverageDueDoctors: 100,
    visitedDoctors: 95,
    missedDoctors: 5,
    coveragePct: 95,
    onPlanDoctors: 95,
    underDoctors: 5,
    overDoctors: 0,
    notDueDoctors: 0,
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
  assert.equal(
    callRateBandOf(row({ hasCallRate: false, callRateAttainmentPct: null })),
    "noplan",
    "a rep who logged nothing has no call-rate band — 'Behind' would state something the data cannot say",
  );

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
}

// ── 6. The podium ranks nobody it cannot honestly rank ────────────────────────────────────────

export function runKpiPodiumTests() {
  const rows = [
    row({ agentCrmId: 1, repName: "Top coverage", coveragePct: 99, frequencyPct: 10, callRateAttainmentPct: 10 }),
    row({ agentCrmId: 2, repName: "Top frequency", coveragePct: 10, frequencyPct: 99, callRateAttainmentPct: 10 }),
    row({ agentCrmId: 3, repName: "Top call rate", coveragePct: 10, frequencyPct: 10, callRateAttainmentPct: 99 }),
    // Deliberately given a LOW call rate rather than the fixture default: having no plan does not
    // mean logging no calls, and at the default 100% this rep would legitimately top the call-rate
    // podium and mask what the assertion below is trying to prove.
    row({
      agentCrmId: 4,
      repName: "No plan",
      hasMeasurablePlan: false,
      coveragePct: 0,
      frequencyPct: 0,
      callRateAttainmentPct: 5,
    }),
    row({ agentCrmId: 5, repName: "No calls", hasCallRate: false, callRateAttainmentPct: null }),
  ];
  const podium = buildKpiPodium(rows);

  // THREE LEADERBOARDS, THREE ANSWERS. The board adds no fourth measure, so there is no blended
  // "best rep" anywhere — and on these fixtures the three winners are three different people,
  // which is exactly the shape production produces (68% coverage against 39% frequency).
  assert.equal(podium.coverage[0]?.repName, "Top coverage");
  assert.equal(podium.frequency[0]?.repName, "Top frequency");
  assert.equal(podium.callRate[0]?.repName, "Top call rate");

  // Nobody is put on a podium at 0% for a measure they have no value on.
  for (const entry of [...podium.coverage, ...podium.frequency]) {
    assert.notEqual(entry.repName, "No plan", "a rep with no plan is never ranked on coverage or frequency");
  }
  for (const entry of podium.callRate) {
    assert.notEqual(entry.repName, "No calls", "a rep who logged nothing is never ranked on call rate");
  }
  assert.ok(podium.coverage.length <= 3, "a podium holds at most three");
  assert.deepEqual(buildKpiPodium([]).coverage, [], "an empty board produces an empty podium, not a crash");
}

// ── 7. Attainment is one denominator, and identity is stamped by canonical hr id ──────────────

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
    unspecified: 0,
    campaignShare: 0,
    campaignOverLimitDays: [],
    campaignOnlyDays: 0,
    ...overrides,
  };
}

export function runKpiAttainmentAndIdentityTests() {
  // THE AVERAGING TRAP. This rep hit his AM target exactly and did nothing all afternoon: 2 calls
  // against the 12 the two targets asked for. Averaging the two slice percentages would read
  // (100 + 0) / 2 = 50% — half a day's work — when the honest answer is 17%.
  const [hitAmOnly] = joinKpiRows({
    callRates: [callRateFixture()],
    docLists: [],
    scope: { kind: "company", basis: "company", label: "test" },
    workingDays: 1,
    amTarget: 2,
    pmTarget: 10,
  });
  assert.equal(
    hitAmOnly?.callRateAttainmentPct,
    17,
    "attainment puts both slices over ONE denominator — 2 of 12 is 17%, never the 50% an average would give",
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
}

// ── 8. The board is medical reps only ─────────────────────────────────────────────────────────

export function runKpiMedicalRepOnlyTests() {
  // Owner, 2026-09-03: "only show medical reps in this page". The composition measured on
  // production that day, September 2026 at Super Admin scope, was 63 medical representatives,
  // 6 district sales managers and 1 product manager — so this drops exactly the 7.
  const rows = [
    row({ agentCrmId: 1, repName: "Rep", jobTitle: "Medical Representative" }),
    row({ agentCrmId: 2, repName: "Short spelling", jobTitle: "Medical Rep" }),
    row({ agentCrmId: 3, repName: "District manager", jobTitle: "District Sales Manager" }),
    row({ agentCrmId: 4, repName: "Product manager", jobTitle: "Product Manager" }),
    row({ agentCrmId: 5, repName: "No title", jobTitle: null }),
  ];

  assert.deepEqual(
    keepMedicalRepsOnly(rows).map((entry) => entry.repName),
    ["Rep", "Short spelling", "No title"],
    "managers are dropped; both live spellings of the rep title are kept",
  );

  // BOTH spellings are live in this database and both auto-provision the rep role. Matching on
  // equality against one of them would silently empty half the board.
  assert.equal(isMedicalRepTitle("Medical Representative"), true);
  assert.equal(isMedicalRepTitle("medical rep"), true, "case and spacing must not decide who is a rep");
  assert.equal(isMedicalRepTitle("  Medical Rep  "), true);

  assert.equal(isMedicalRepTitle("District Sales Manager"), false);
  assert.equal(isMedicalRepTitle("Product Manager"), false);
  assert.equal(
    isMedicalRepTitle("Medical Rep Manager"),
    false,
    "a title containing both words is a manager — the substring match must not promote him onto the board",
  );

  // THE DELIBERATELY GENEROUS BRANCH, and the one most likely to be 'tidied' by a later session.
  // A CRM agent with no matching employee record has no title. Dropping him would remove a working
  // rep from his own manager's board with no error and no marker, which reads as 'he covered
  // nothing' rather than as a bug. Being visibly too generous is recoverable; being invisibly too
  // strict is not.
  assert.equal(isMedicalRepTitle(null), true, "an unrecorded title is KEPT — see the block in kpis-filters.ts");
  assert.equal(isMedicalRepTitle(""), true);
  assert.equal(isMedicalRepTitle("   "), true);

  // The restriction runs before the facets, so it can never be undone from the URL. A district
  // manager left on the board would score 'No plan' on two of three measures and drag the team
  // averages toward a number describing nobody.
  const kept = keepMedicalRepsOnly(rows);
  assert.equal(
    applyKpiFilters(kept, filters({ titles: ["District Sales Manager"] })).length,
    0,
    "no query string can bring a dropped manager back — the narrowing happens above the filter layer",
  );
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
