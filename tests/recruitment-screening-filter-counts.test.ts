import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { foreignCountryForGovernorate, candidateRegionCodes } from "../src/lib/recruitment/candidate-region.ts";
import { screeningRatingFilters } from "../src/lib/recruitment/candidate-rating.ts";
import { candidateRoleFamilies } from "../src/lib/recruitment/candidate-role-family.ts";
import { candidateStatuses } from "../src/lib/recruitment/candidate-status.ts";
import {
  matchesScreeningNarrowing,
  screeningAreaKey,
  screeningAreaOptions,
  screeningSourceKey,
  screeningSourceOptions,
  type ScreeningFilterCandidateRow,
} from "../src/lib/recruitment/screening-filter.ts";
import {
  screeningFilterCounts,
  screeningReceivedWindowMs,
} from "../src/lib/recruitment/screening-filter-counts.ts";
import {
  SCREENING_UNKNOWN,
  parseScreeningFilters,
  screeningReceivedFilters,
  type ScreeningQueueFilters,
} from "../src/lib/recruitment/screening-link.ts";

/**
 * "i want to reach all those easily by polished working filters."
 *
 * The owner, 2026-09-18, immediately after the role-mismatch fix made 303 candidates findable at
 * all. Nine selects on the screening bar, ~68 options between them, and not one of them said
 * whether it held 300 people or nobody — and since every filter there is a URL, finding out cost a
 * 5-to-12-second round trip per guess.
 *
 * ── WHAT THIS FILE IS ACTUALLY DEFENDING ───────────────────────────────────────────────────────
 *
 * Not the numbers themselves — those change with every CV that arrives. It defends the one property
 * that makes them worth printing: THE COUNT AND THE FILTER CANNOT DISAGREE. `screening-filter.ts`
 * exists because the pool once filtered on a different fact from the one it displayed, and its
 * header states the rule — "Filtering on a different fact from the one displayed is not a narrower
 * filter, it is a wrong one". A count is a third reading of the same facts, and the most dangerous
 * one: a dropdown promising 55 district managers and then showing 28 is worse than one that
 * promised nothing.
 *
 * So section 2 is the whole point of the file. For every filter and every option it asserts that
 * the tally equals what `matchesScreeningNarrowing` ITSELF returns over the same rows — counts
 * derived in one pass, verified against the real matcher one option at a time. Any future edit that
 * teaches one of them a fact the other does not know fires it.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const AS_OF = Date.parse("2026-09-18T12:00:00Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): string {
  return new Date(AS_OF - ms).toISOString();
}

function row(overrides: Partial<ScreeningFilterCandidateRow>): ScreeningFilterCandidateRow {
  return { id: `c-${Math.random().toString(36).slice(2)}`, status: "new", ...overrides } as ScreeningFilterCandidateRow;
}

/**
 * A population built to make every bucket non-trivial, because a cross-check between two readings of
 * the same fact passes vacuously when both read zero.
 *
 * Abanoub Magdy's shape leads it — production row cb3452cc, the senior medical rep who applied for a
 * district manager seat. He is the reason the role tallies do not sum to the pool.
 */
const POPULATION: ScreeningFilterCandidateRow[] = [
  row({
    appliedForJobTitle: "District Manager",
    createdAt: ago(20 * MINUTE),
    currentJobTitle: "Senior Medical Representative",
    id: "promotion",
    preferredAreaName: "Tanta",
    preferredRegionCode: "D1",
    rating: 3,
    source: "whatsapp",
    status: "new",
  }),
  row({
    appliedForJobTitle: "Medical Representative",
    createdAt: ago(3 * HOUR),
    currentJobTitle: "Medical Representative",
    id: "plain-rep",
    preferredAreaName: "tanta",
    preferredRegionCode: "D1",
    rating: 2,
    source: "whatsapp",
    status: "shortlisted",
  }),
  row({
    appliedForJobTitle: "Office Coordinator",
    createdAt: ago(3 * DAY),
    currentJobTitle: "Secretary",
    id: "coordinator",
    managerNotified: { sentAt: ago(2 * DAY) },
    preferredAreaName: "Sheraton",
    preferredRegionCode: "CA",
    rating: 1,
    source: "email",
    status: "sent_to_manager",
  }),
  row({
    createdAt: ago(20 * DAY),
    id: "no-title",
    preferredRegionCode: "GZ",
    source: "email",
    status: "new",
  }),
  row({
    appliedForJobTitle: "Pharmacist",
    createdAt: ago(20 * DAY),
    currentJobTitle: "Pharmacist",
    governorate: "Riyadh",
    id: "abroad",
    status: "rejected",
  }),
  row({
    appliedForJobTitle: "Warehouse Keeper",
    createdAt: ago(100 * DAY),
    currentJobTitle: "Warehouse Keeper",
    id: "other-family",
    status: "new",
  }),
  // A row with NO readable arrival time — it must be in no window at all, in both readings.
  row({ appliedForJobTitle: "Medical Representative", createdAt: null, id: "undated", status: "new" }),
];

const SEEN_BY_VIEWER = new Set(["plain-rep", "coordinator"]);
const SEEN_BY_ANYBODY = new Set(["plain-rep", "coordinator", "abroad"]);

const seenByViewer = (candidate: ScreeningFilterCandidateRow) => SEEN_BY_VIEWER.has(candidate.id);
const seenByAnyone = (candidate: ScreeningFilterCandidateRow) => SEEN_BY_ANYBODY.has(candidate.id);

/** What the matcher itself says, for one narrowing, over the same rows. The authority here. */
function matcherCount(filters: ScreeningQueueFilters): number {
  const narrowing = parseScreeningFilters(filters);
  return POPULATION.filter((candidate) =>
    matchesScreeningNarrowing(candidate, narrowing, {
      asOf: AS_OF,
      seenByAnyone: seenByAnyone(candidate),
      seenByViewer: seenByViewer(candidate),
    }),
  ).length;
}

/** The query-string shape each option is asked for with — see `parseScreeningFilters`. */
const AS_QUERY: Record<string, (value: string) => ScreeningQueueFilters> = {
  area: (value) => ({ area: value }),
  notified: (value) => (value === "sent" ? { sent: "1" } : { unsent: "1" }),
  rating: (value) => ({ rating: value }),
  received: (value) => ({ received: value }),
  region: (value) => ({ region: value }),
  role: (value) => ({ role: value }),
  seen: (value) => (value === "seen" ? { seen: "1" } : value === "unseen" ? { unseen: "1" } : { untouched: "1" }),
  source: (value) => ({ source: value }),
  status: (value) => ({ status: value }),
};

export function runScreeningFilterCountsTests(): void {
  const counts = screeningFilterCounts(POPULATION, { asOf: AS_OF, seenByAnyone, seenByViewer });

  // ── 0 · THE FIXTURES REALLY DO EXERCISE THE ODD BUCKETS ───────────────────
  // Asserted rather than assumed. The last time a premise in one of these files went unchecked, the
  // section built on it was wrong in both directions before the test caught it.
  assert.equal(counts.total, POPULATION.length, "every row is counted exactly once in the total");
  assert.ok(
    foreignCountryForGovernorate("Riyadh"),
    "the `abroad` fixture must actually resolve to a foreign country, or the foreign bucket is vacuous",
  );
  assert.ok((counts.region.foreign ?? 0) > 0, "so the foreign region bucket is non-trivial");
  assert.ok((counts.role[SCREENING_UNKNOWN] ?? 0) > 0, "and so is the no-job-title bucket");
  assert.ok((counts.area[SCREENING_UNKNOWN] ?? 0) > 0, "and the no-area bucket");

  // ── 1 · THE HEADLINE: A PROMOTION IS COUNTED UNDER BOTH SEATS ─────────────
  // The counting half of the role-mismatch fix. A senior medical rep who applied for a district
  // manager seat is findable under both families, so the DM option must not read one fewer than the
  // filter will actually return — which is the specific way a count and a filter go wrong together.
  assert.equal(
    counts.role.district_manager,
    matcherCount({ role: "district_manager" }),
    "the District Manager option counts the promotion candidate, exactly as the filter returns him",
  );
  assert.equal(counts.role.district_manager, 1, "and he is that one");
  assert.equal(counts.role.medical_rep, 3, "while still being counted as a medical rep himself");
  // The tallies therefore exceed the population, and that is correct rather than a double-count.
  const roleTally = candidateRoleFamilies.reduce((sum, family) => sum + (counts.role[family] ?? 0), 0);
  assert.ok(
    roleTally > POPULATION.length - (counts.role[SCREENING_UNKNOWN] ?? 0),
    "the role tallies do not sum to the pool, because one candidate can answer two of them",
  );

  // ── 2 · EVERY OPTION, AGAINST THE REAL MATCHER ────────────────────────────
  //
  // THE ANTI-DRIFT ASSERTION, and the reason this file exists. `screeningFilterCounts` resolves each
  // candidate once and increments buckets; `matchesScreeningNarrowing` re-decides one candidate at a
  // time. They share their resolvers and nothing else. Every option below is checked both ways.
  const optionsByFilter: Record<string, readonly string[]> = {
    area: [...screeningAreaOptions(POPULATION).map(screeningAreaKey), SCREENING_UNKNOWN],
    notified: ["sent", "unsent"],
    rating: screeningRatingFilters,
    received: screeningReceivedFilters,
    region: [...candidateRegionCodes, "foreign", SCREENING_UNKNOWN],
    role: [...candidateRoleFamilies, SCREENING_UNKNOWN],
    seen: ["seen", "unseen", "untouched"],
    source: screeningSourceOptions(POPULATION).map(screeningSourceKey),
    status: candidateStatuses,
  };

  let checked = 0;
  // Through `unknown`, because `counts` also holds `total: number` and TypeScript will not narrow a
  // string index across the two shapes. Every key read below is one of the nine tallies.
  const buckets = counts as unknown as Record<string, Record<string, number>>;
  for (const [filter, options] of Object.entries(optionsByFilter)) {
    const bucket = buckets[filter];
    for (const option of options) {
      assert.equal(
        bucket[option] ?? 0,
        matcherCount(AS_QUERY[filter](option)),
        `the ${filter} option "${option}" must promise exactly what the filter returns`,
      );
      checked += 1;
    }
  }
  // A guard on the guard: a refactor that empties `optionsByFilter` would leave the loop above
  // asserting nothing at all and still passing.
  assert.ok(checked >= 40, `the cross-check must actually run over every option — it ran ${checked}`);

  // ── 3 · WINDOWS AND LADDERS NEST, AND THE COUNTS SAY SO ───────────────────
  // Not a bug to be normalised away: picking "Last 24 hours" DOES include the CV that arrived
  // twenty minutes ago, so both options must count it. A future "make the buckets exclusive"
  // tidy-up would make every one of them lie about what it returns.
  assert.ok(
    counts.received.hour < counts.received.day && counts.received.day < counts.received.week,
    "each wider arrival window contains the narrower ones",
  );
  assert.ok(
    (counts.rating["3"] ?? 0) < (counts.rating["2"] ?? 0) && (counts.rating["2"] ?? 0) < (counts.rating["1"] ?? 0),
    "the star ladder nests — '1 star and up' contains the 3-star CVs",
  );
  assert.equal(
    counts.received.month,
    POPULATION.filter((c) => c.createdAt && AS_OF - Date.parse(c.createdAt) <= 30 * DAY).length,
    "and the undated row is in no window at all",
  );
  // `unseen` and `untouched` overlap by design: a CV nobody has opened is also one I have not.
  assert.ok(
    (counts.seen.untouched ?? 0) <= (counts.seen.unseen ?? 0),
    "untouched is a subset of unseen, never the other way round",
  );
  assert.equal(
    (counts.seen.seen ?? 0) + (counts.seen.unseen ?? 0),
    POPULATION.length,
    "seen and unseen are the one pair that IS exclusive, and together they are the whole pool",
  );

  // ── 4 · THE WINDOW TABLE IS THE MATCHER'S ─────────────────────────────────
  // The counts module keeps its own copy on purpose — see its comment — so the two are pinned equal
  // here rather than shared through an import that would make one of them the quiet authority.
  const matcherSource = read("src/lib/recruitment/screening-filter.ts");
  for (const window of screeningReceivedFilters) {
    const expression = { day: "24 * HOUR_MS", hour: "HOUR_MS", month: "30 * 24 * HOUR_MS", week: "7 * 24 * HOUR_MS" }[
      window
    ];
    assert.ok(
      matcherSource.includes(`${window}: ${expression},`),
      `the matcher's ${window} window must still be ${expression} — the counts module duplicates it`,
    );
  }
  assert.equal(screeningReceivedWindowMs.hour, 60 * 60 * 1000, "and the duplicate agrees");
  assert.equal(screeningReceivedWindowMs.month, 30 * 24 * 60 * 60 * 1000);

  // ── 5 · THE BAR ACTUALLY PRINTS THEM ──────────────────────────────────────
  // A count nothing renders is a count nobody has. Source-pinned because the alternative is
  // rendering React in a node test, and the failure this guards against is somebody dropping the
  // prop back out of a call site — which is exactly how the bar's two homes diverged once before.
  const bar = read("src/components/recruitment/screening-page-client.tsx");
  assert.match(bar, /function FilterOption\(/, "the bar still has one shared option component");
  assert.match(
    bar,
    /disabled=\{total === 0 && !selected\}/,
    "a dead option is disabled — except the one the select is currently on, which must still render",
  );
  assert.match(bar, /\{label\} \(\{total\}\)/, "and every option prints its own count");
  assert.match(bar, /count=\{filterCounts\.role\[family\]\}/, "the Role options are fed from the role tallies");
  assert.match(
    bar,
    /count=\{filterCounts\.area\[screeningAreaKey\(value\)\]\}/,
    "and Area is looked up by its FOLDED key, not by the spelling on screen",
  );
  // Both call sites pass it. The types enforce this today; the assertion says why it matters, so a
  // future `filterCounts?:` cannot quietly turn one of them back into all-zeroes.
  assert.equal(
    (bar.match(/filterCounts=\{filterCounts\}/g) ?? []).length,
    1,
    "the page variant passes the counts through",
  );
  assert.match(
    read("src/components/recruitment/workstation/workstation-page-client.tsx"),
    /filterCounts=\{filterCounts\}/,
    "and so does the workstation, which is the one the owner actually screens in",
  );
  for (const page of [
    "app/(admin)/recruitment/screening/page.tsx",
    "app/employee-portals/recruitment/screening/page.tsx",
  ]) {
    assert.match(read(page), /filterCounts=\{workspace\.filterCounts\}/, `${page} feeds the counts in`);
  }
}
