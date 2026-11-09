import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AXIS_LINE_HEIGHT,
  DASHBOARD_UNAVAILABLE,
  REFRESH_FAILED,
  closingIntro,
  deltaWords,
  earlierClosings,
  monthName,
  paceWords,
  percentTowardZero,
  rankedChartHeight,
  sharePercentText,
  trendTitle,
  uploadWords,
  versusMonth,
  wholePercentText,
  wrapAxisLabel,
} from "@/lib/sales/sos-portal-words";

// The employee portal's Source of Sales page (`/employee-portals/source-of-sales`), premium pass:
// every word and rounding is worked by hand here, then the three screen files are read to prove they
// say it through sos-portal-words.ts. Figures themselves are untouched; only how they are said.

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

function percentagesNeverRoundAcrossALine() {
  // Progress against target: 99.6% is not "100%".
  assert.equal(wholePercentText(0.996), "99%");
  assert.equal(wholePercentText(1), "100%");
  assert.equal(wholePercentText(1.2349), "123%");
  // A drop of 29.6% on a "30% or more" list never reads 30%; 30.4% reads 30%.
  assert.equal(wholePercentText(-0.296), "-29%");
  assert.equal(wholePercentText(-0.304), "-30%");
  // Floating point: 0.29 * 100 is 28.999…, and must still read 29.
  assert.equal(percentTowardZero(0.29), 29);
  assert.equal(percentTowardZero(-0.29), -29);
  assert.equal(percentTowardZero(0.123, 1), 12.3);
  // Nothing, or a value too small to show, is a plain zero (never "-0%").
  assert.equal(wholePercentText(null), "0%");
  assert.equal(wholePercentText(-0.004), "0%");
  assert.equal(wholePercentText(Number.NaN), "0%");
  // Shares keep one decimal, cut toward zero: 99.96% is "99.9%", never "100.0%".
  assert.equal(sharePercentText(0.9996), "99.9%");
  assert.equal(sharePercentText(0.12349), "12.3%");
  assert.equal(sharePercentText(0), "0.0%");
}

function changesSayTheirDirectionOnlyWhenTheyHaveOne() {
  assert.deepEqual(deltaWords(0.1236), { text: "+12.3%", tone: "up" });
  assert.deepEqual(deltaWords(-0.0319), { text: "-3.1%", tone: "down" });
  // Too small for one decimal: grey and unsigned, never a green "+0.0%" or a red "-0.0%".
  assert.deepEqual(deltaWords(0.0004), { text: "0.0%", tone: "flat" });
  assert.deepEqual(deltaWords(-0.0009), { text: "0.0%", tone: "flat" });
  assert.deepEqual(deltaWords(0), { text: "0.0%", tone: "flat" });
}

function monthsAreNamed() {
  assert.equal(monthName("2026-09"), "Sep 2026");
  assert.equal(monthName("2026-01"), "Jan 2026");
  assert.equal(monthName(null), "—");
  assert.equal(monthName("2026-13"), "2026-13");
  assert.equal(versusMonth("2026-08"), "vs Aug 2026");
  assert.equal(versusMonth(null), "vs the month before");
}

function theTrendTitleNamesTheMonthsItDraws() {
  const six = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
  assert.equal(trendTitle(six, "2026-09"), "Value trend · Apr 2026 to Sep 2026");
  // Unsorted input, a picked month inside the run.
  assert.equal(trendTitle([...six].reverse(), "2026-06"), "Value trend · Apr 2026 to Sep 2026");
  // A picked month older than the six newest sits apart, and the title says so.
  assert.equal(trendTitle(["2026-01", ...six], "2026-01"), "Value trend · Apr 2026 to Sep 2026, and Jan 2026");
  assert.equal(trendTitle(["2026-01", "2026-09"], "2026-01"), "Value trend · Sep 2026, and Jan 2026");
  // Across a year end with no gap, it is one run.
  assert.equal(trendTitle(["2025-12", "2026-01", "2026-02"], "2025-12"), "Value trend · Dec 2025 to Feb 2026");
  assert.equal(trendTitle(["2026-09"], "2026-09"), "Value trend · Sep 2026");
  assert.equal(trendTitle([], null), "Value trend");
}

function thePaceRowIsReadableWithoutAHover() {
  // Target 100,000; 62,400 so far; 70,000 expected by today → behind by 7,600.
  const behind = paceWords({ soFarValue: 62_400, targetValue: 100_000, progress: 0.624, expectedByToday: 70_000, onPace: false });
  assert.deepEqual(behind, { progressText: "62% of target", expectedText: "expected 70% by today", badge: "Behind", shortBy: 7_600 });
  // On pace: no shortfall is printed.
  const ahead = paceWords({ soFarValue: 75_000, targetValue: 100_000, progress: 0.75, expectedByToday: 70_000, onPace: true });
  assert.deepEqual(ahead, { progressText: "75% of target", expectedText: "expected 70% by today", badge: "On pace", shortBy: null });
  // 99.6% of target behind a mark of 99.8% never reads "100%" beside "Behind".
  const close = paceWords({ soFarValue: 99_600, targetValue: 100_000, progress: 0.996, expectedByToday: 99_800, onPace: false });
  assert.equal(close.progressText, "99% of target");
  assert.equal(close.expectedText, "expected 99% by today");
  assert.equal(close.shortBy, 200);
  // No target: no percentages, no badge.
  const none = paceWords({ soFarValue: 5_000, targetValue: null, progress: null, expectedByToday: null, onPace: null });
  assert.deepEqual(none, { progressText: null, expectedText: null, badge: null, shortBy: null });
}

function theClosingSentenceReadsAsASentence() {
  assert.equal(earlierClosings(1), "the closing before the latest");
  assert.equal(earlierClosings(3), "the 3 closings before the latest");
  // With no line it used to begin " closing for …" — a leading space and a small letter.
  assert.equal(
    closingIntro({ line: null, latestPeriod: "2026-09", priorPeriods: ["2026-08", "2026-07", "2026-06"], historyComplete: true }),
    "The closing for Sep 2026, compared with Jun 2026, Jul 2026, Aug 2026. Published closings only.",
  );
  assert.equal(
    closingIntro({ line: "CNS", latestPeriod: "2026-09", priorPeriods: ["2026-08"], historyComplete: false }),
    'The CNS closing for Sep 2026, compared with Aug 2026. Published closings only. Only 1 earlier closing is published, so "New" may include pharmacies that bought before them.',
  );
  assert.equal(
    closingIntro({ line: "Pedia", latestPeriod: "2026-07", priorPeriods: [], historyComplete: false }),
    "The Pedia closing for Jul 2026 is the first published month, so there is nothing to compare it with yet.",
  );
}

function theUploadStateIsWords() {
  assert.deepEqual(uploadWords({ uploadedCount: 7, expectedCount: 9, awaitingCount: 2 }), {
    text: "7 of 9 distributors uploaded · 2 still to come",
    tone: "waiting",
  });
  assert.deepEqual(uploadWords({ uploadedCount: 9, expectedCount: 9, awaitingCount: 0 }), { text: "9 of 9 distributors uploaded", tone: "done" });
  assert.equal(uploadWords({ uploadedCount: 0, expectedCount: 0, awaitingCount: 0 }), null);
  assert.equal(uploadWords(null), null);
}

function chartLabelsWrapAndAreNeverCut() {
  assert.deepEqual(wrapAxisLabel("Royanoxicam 15 mg Tablets", 18), ["Royanoxicam 15 mg", "Tablets"]);
  assert.deepEqual(wrapAxisLabel("Cairo", 18), ["Cairo"]);
  // A word longer than the line keeps its own whole line — never cut, never an ellipsis.
  assert.deepEqual(wrapAxisLabel("Supercalifragilistic Ltd", 12), ["Supercalifragilistic", "Ltd"]);
  const lines = wrapAxisLabel("United Company for Pharmacists Distribution", 18);
  assert.deepEqual(lines, ["United Company for", "Pharmacists", "Distribution"]);
  assert.equal(lines.join(" "), "United Company for Pharmacists Distribution", "every word is kept");
  assert.equal(AXIS_LINE_HEIGHT, 13);
  // Eight one-line bars keep the 240px card; eight three-line bars grow it: 8 × (3×13+12) + 8 = 416.
  assert.equal(rankedChartHeight([1, 1, 1, 1, 1, 1, 1, 1]), 240);
  assert.equal(rankedChartHeight([3, 3, 3, 3, 3, 3, 3, 3]), 416);
}

function theScreensSayItThroughTheWordsModule() {
  const actions = read("src/components/sales/portal/portal-sos-pharmacy-actions.tsx");
  const dashboard = read("src/components/sales/portal/portal-sos-dashboard-impl.tsx");
  const page = read("app/employee-portals/source-of-sales/page.tsx");

  // Nothing below 11px on either screen.
  for (const [name, source] of [["pharmacy actions", actions], ["dashboard", dashboard]] as const) {
    assert.doesNotMatch(source, /text-phx-(2xs|3xs)/, `the ${name} must draw nothing below 11px`);
    assert.doesNotMatch(source, /fontSize: 10\b/, `the ${name} charts must draw nothing below 11px`);
    assert.doesNotMatch(source, /rounded-/, `the ${name} must keep square corners`);
  }

  // The pharmacy lists: percentages cut toward zero, the sentence and the pace from the module.
  assert.doesNotMatch(actions, /Math\.round\(value \* 100\)/, "the pharmacy percentages must never round up");
  assert.match(actions, /const formatPct = wholePercentText;/);
  assert.match(actions, /closingIntro\(\{/, "the sentence over the tiles comes from closingIntro");
  assert.doesNotMatch(actions, /\$\{data\.line \?\? ""\} closing for/, "the old sentence began with a space when there was no line");
  assert.doesNotMatch(actions, /title="Expected by today"/, "the expected mark is printed, never a hover title only");
  assert.match(actions, /\{words\.expectedText \? <p[^>]*>\{words\.expectedText\}<\/p> : null\}/, "the pace row prints where it should be by today");
  assert.match(actions, /short of today's mark/, "a row behind its mark says by how much");

  // The dashboard.
  assert.match(dashboard, /const formatPct = sharePercentText;/);
  assert.match(dashboard, /const formatPeriod = monthName;/, "months are named from the text, never through a Date");
  assert.doesNotMatch(dashboard, /last 6 months/, "the trend title names the months it really draws");
  assert.match(dashboard, /trendTitle\(data\.trend\.map/);
  assert.match(dashboard, /<ReferenceLine x=\{selectedLabel\}/, "the picked month is marked on the trend");
  assert.doesNotMatch(dashboard, /vs last month|Δ vs last/, "every comparison names its month");
  assert.match(dashboard, /versusMonth\(comparison\?\.previousPeriod\)/);
  assert.match(dashboard, /deltaWords\(delta\)/, "a change too small to show is grey, not coloured");
  assert.doesNotMatch(dashboard, /hidden items-center[^"]*sm:inline-flex/, "the upload state is shown on a phone too");
  assert.match(dashboard, /uploadWords\(uploadStatus\)/);
  assert.match(dashboard, /\} else \{\s*setRefreshFailed\(true\);\s*\}/, "a refresh the server refused is said above the old figures");
  assert.match(dashboard, /console\.error\("Failed to refresh Source of Sales", error\);\s*setRefreshFailed\(true\);/, "a refresh that never arrived is said too");
  assert.match(dashboard, /\{REFRESH_FAILED\}/);
  assert.match(dashboard, /activeFilterCount > 0 \? filtersSection : null/, "an empty selection keeps its filters, so it can be undone");
  assert.doesNotMatch(dashboard, /angle=\{-20\}/, "column labels wrap level, never a slanted, clipped line");
  assert.match(dashboard, /<WrappedTick \{\.\.\.props\} anchor="end"/, "bar labels wrap on word boundaries");
  assert.match(dashboard, /<WrappedTick \{\.\.\.props\} anchor="middle"/);
  assert.match(dashboard, /cairoDateTime12h\(iso\)/, "the upload stamp goes through the hydration-safe Cairo formatter");
  // The locks the pass must not touch.
  assert.match(dashboard, /const valueDelta = comparison\?\.totalValueDelta \?\? null;/, "the Total Value arrow still comes from the server's comparison");

  // The page never shows a raw error.
  assert.doesNotMatch(page, /error\.message/, "the page never shows the viewer a raw error message");
  assert.match(page, /message=\{failed \? DASHBOARD_UNAVAILABLE : /, "a failed load shows the page's own sentence");
  assert.doesNotMatch(DASHBOARD_UNAVAILABLE, /error|exception|supabase|timeout/i);
  assert.doesNotMatch(REFRESH_FAILED, /error|exception/i);
  // No he, his, him, she or her in any on-screen sentence of the module.
  const words = read("src/lib/sales/sos-portal-words.ts");
  const strings = [...words.matchAll(/["`]([^"`\n]*)["`]/g)].map((match) => match[1]);
  for (const text of strings) {
    assert.doesNotMatch(text, /\b(he|his|him|she|her)\b/i, `on-screen words must not assume a gender: "${text}"`);
  }
}

export function runSosPortalPremiumTests() {
  percentagesNeverRoundAcrossALine();
  changesSayTheirDirectionOnlyWhenTheyHaveOne();
  monthsAreNamed();
  theTrendTitleNamesTheMonthsItDraws();
  thePaceRowIsReadableWithoutAHover();
  theClosingSentenceReadsAsASentence();
  theUploadStateIsWords();
  chartLabelsWrapAndAreNeverCut();
  theScreensSayItThroughTheWordsModule();
}
