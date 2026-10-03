import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildRankingBoards,
  rankingWindow,
  type RankingFilters,
  type RankingPerson,
} from "../src/lib/sales/rankings.ts";
import type { RepEstablishment } from "../src/lib/employee-portal/rep-establishment.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE RANKINGS TAB — the whole field ranked, over any window, through any slice.
 *
 * Owner, 2026-10-03, handing over the concept of the rep's own two ranking cards: *"build a page
 * the same concept — I can filter by line, by multiple lines, by all company, by period (multiple
 * months, quarter, semester), on one employee, on one title, on anything I want. Of course you
 * will not build it in the overview; take the concept and build it as a new tab."*
 *
 * Six things can go wrong silently here, and each one is pinned below.
 *
 *  1. THE BOARD COULD DISAGREE WITH THE CLOSING IT REPORTS. Achievement is covered-actual ÷ target
 *     off the Monthly Closing engine (AGENTS.md §4). A query of its own in the loader, or ranking
 *     on full sales instead of the covered figure, is how a manager's board starts contradicting
 *     the rep's own badge and the closing matrix at once.
 *  2. A WINDOW COULD AVERAGE ITS MONTHS. A quarter is SUMMED and divided once; averaging three
 *     monthly ratios lets a tiny month outweigh a large one, and the quarter then disagrees with
 *     the three months it is made of.
 *  3. AN UNPUBLISHED MONTH COULD RANK. An unfinished month is not a leaderboard, and the gate is
 *     per line — a month published for CNS and not for Pedia is exactly the shape that bites.
 *  4. A LEAVER COULD HOLD A PLACE. Source of Sales keeps a rep's money after he resigns, so a
 *     departed name pushes every serving rep down one. A FAILED directory read must rank
 *     everybody rather than nobody.
 *  5. A FILTER COULD NARROW THE BOARD BUT NOT THE ARITHMETIC. Filtering to one line has to rank
 *     each rep on THAT line's money; otherwise a rep's rank inside a line board is decided by
 *     sales the board is not showing.
 *  6. THE "OUT OF N" COULD OUTLIVE ITS MEANING. It is the organogram's rep seats, vacancies
 *     included (the owner's rule). The moment a title, a region or a name narrows the board it is
 *     no longer the rep population, so the seat count must switch off rather than quote a
 *     denominator the board no longer matches.
 */

function row(partial: {
  repHrId: string;
  lineCode?: string | null;
  period?: string;
  actualValue: number;
  targetValue: number | null;
}): AchievementRow {
  const targetValue = partial.targetValue;
  return {
    period: partial.period ?? "2026-08",
    lineCode: partial.lineCode === undefined ? "cns" : partial.lineCode,
    regionCode: "RG1",
    areaCode: "AR1",
    areaState: "active",
    isOther: false,
    repSeatId: `seat-${partial.repHrId}`,
    repHrId: partial.repHrId,
    dmSeatId: "dm-seat",
    dmHrId: "B-900",
    productCode: "GU001",
    actualUnits: 1,
    actualValue: partial.actualValue,
    targetUnits: targetValue == null ? null : 1,
    targetValue,
    achievementValue: targetValue ? partial.actualValue / targetValue : null,
    achievementUnits: null,
    hasTarget: targetValue != null && targetValue > 0,
    hasActual: partial.actualValue > 0,
  };
}

const PUBLISHED = new Set([
  "cns|2026-07",
  "pedia|2026-07",
  "anti_infective|2026-07",
  "cns|2026-08",
  "pedia|2026-08",
  "anti_infective|2026-08",
]);

const MONTHS = ["2026-07", "2026-08"];

function person(hrId: string, partial: Partial<RankingPerson> = {}): RankingPerson {
  return {
    hrId,
    name: partial.name ?? `Rep ${hrId}`,
    title: partial.title ?? "Medical Representative",
    lineName: partial.lineName ?? "CNS",
    regionName: partial.regionName ?? "Delta",
    areaName: partial.areaName ?? "Tanta",
    managerName: partial.managerName ?? "Manager",
    hasPhoto: partial.hasPhoto ?? false,
  };
}

function peopleOf(...entries: [string, Partial<RankingPerson>?][]): Map<string, RankingPerson> {
  const map = new Map<string, RankingPerson>();
  for (const [hrId, partial] of entries) {
    map.set(hrId.toUpperCase().replace(/[^A-Z0-9]/g, ""), person(hrId, partial));
  }
  return map;
}

const NO_FILTERS: RankingFilters = { lines: [], titles: [], regions: [], query: "" };

const ESTABLISHMENT: RepEstablishment = {
  company: { seats: 111, vacant: 35 },
  byLine: new Map([
    ["cns", { seats: 40, vacant: 9 }],
    ["pedia", { seats: 41, vacant: 14 }],
    ["anti_infective", { seats: 30, vacant: 12 }],
  ]),
};

function boardsOf(options: {
  rows: AchievementRow[];
  periods?: string[];
  priorPeriods?: string[];
  people?: Map<string, RankingPerson>;
  activeKeys?: Set<string> | null;
  establishment?: RepEstablishment | null;
  filters?: Partial<RankingFilters>;
}) {
  return buildRankingBoards({
    rows: options.rows,
    priorRows: options.rows,
    publishedKeys: PUBLISHED,
    periods: options.periods ?? MONTHS,
    priorPeriods: options.priorPeriods ?? [],
    people: options.people ?? peopleOf(["B-1"], ["B-2"], ["B-3"]),
    activeKeys: options.activeKeys === undefined ? null : options.activeKeys,
    establishment: options.establishment ?? ESTABLISHMENT,
    filters: { ...NO_FILTERS, ...options.filters },
  });
}

export function runSalesRankingsTests() {
  // ── 1. Every window the owner named, and only PUBLISHED months inside it ─────────────────────
  const published = ["2026-07", "2026-08"];

  const month = rankingWindow("month", "2026-08", published);
  assert.deepEqual(month?.periods, ["2026-08"], "a month window is that one month");
  assert.equal(month?.label, "Aug 2026", "the month is named, never printed as a raw period");
  assert.deepEqual(month?.prior?.periods, ["2026-07"], "a month is compared with the month before it");

  const quarter = rankingWindow("quarter", "2026-08", published);
  assert.deepEqual(
    quarter?.periods,
    ["2026-07", "2026-08"],
    "Q3 is Jul-Aug-Sep, but September is not published — a quarter is its published months, never a hole",
  );
  assert.equal(quarter?.label, "Q3 2026", "a quarter is called by its own name");
  assert.equal(quarter?.prior, null, "Q2 has nothing published, so the quarter has nothing to be compared with");

  const semester = rankingWindow("semester", "2026-08", published);
  assert.deepEqual(semester?.periods, ["2026-07", "2026-08"], "H2 is Jul-Dec, published part only");
  assert.equal(semester?.label, "H2 2026", "the semester is H1/H2, the halves the business plans in");
  const firstHalf = rankingWindow("semester", "2026-03", ["2026-03", "2026-07"]);
  assert.deepEqual(firstHalf?.periods, ["2026-03"], "a March anchor resolves to H1, not to the newest half");

  assert.deepEqual(rankingWindow("year", "2026-08", published)?.periods, published, "a year is every published month in it");
  assert.equal(rankingWindow("year", "2026-08", published)?.label, "2026", "the year window is called by its year");

  const cumulative = rankingWindow("published", null, published);
  assert.deepEqual(cumulative?.periods, published, "the cumulative board is every published month there is");
  assert.deepEqual(
    cumulative?.prior?.periods,
    ["2026-07"],
    "a cumulative board has no window before it, so it is compared with itself one month shorter — which is what " +
      "'vs last month' means on the rep's own badge",
  );

  // An anchor nobody has published must not empty the board: it resolves back to the newest
  // published month at or before it.
  assert.equal(rankingWindow("month", "2026-12", published)?.anchor, "2026-08", "an unpublished anchor falls back, never empties");
  assert.equal(rankingWindow("month", "2026-01", published)?.anchor, "2026-07", "an anchor before the floor takes the earliest published month");
  assert.equal(rankingWindow("month", "2026-08", []), null, "with nothing published there is no window at all");

  // ── 2. Summed, then divided ONCE — never an average of monthly ratios ────────────────────────
  // B-1 does 10% of a 1,000 month and then 400% of a 100 month. Averaged he reads 205%; summed and
  // divided once he reads 109%, which is the money he actually sold against the target he carried.
  const summed = boardsOf({
    rows: [
      row({ repHrId: "B-1", period: "2026-07", actualValue: 100, targetValue: 1000 }),
      row({ repHrId: "B-1", period: "2026-08", actualValue: 1100, targetValue: 100 }),
    ],
  });
  assert.equal(
    Math.round(summed.overall[0].achievementPercent),
    109,
    "a window is summed and divided once (1200/1100), never averaged across its months (205%)",
  );

  // ── 3. The published gate, per line ──────────────────────────────────────────────────────────
  const unpublished = boardsOf({
    rows: [
      row({ repHrId: "B-1", period: "2026-09", actualValue: 500, targetValue: 100 }),
      row({ repHrId: "B-2", period: "2026-08", actualValue: 100, targetValue: 100 }),
    ],
    periods: ["2026-08", "2026-09"],
  });
  assert.deepEqual(
    unpublished.overall.map((entry) => entry.hrId),
    ["B-2"],
    "September is not published for any line — a 500% month in it cannot take first place",
  );
  const halfPublished = boardsOf({
    rows: [
      row({ repHrId: "B-1", lineCode: "pedia", period: "2026-07", actualValue: 900, targetValue: 100 }),
      row({ repHrId: "B-2", lineCode: "cns", period: "2026-07", actualValue: 100, targetValue: 100 }),
    ],
    periods: ["2026-07"],
    people: peopleOf(["B-1"], ["B-2"]),
  });
  assert.equal(halfPublished.overall.length, 2, "both lines are published for July in this fixture");
  const cnsOnly = buildRankingBoards({
    rows: [
      row({ repHrId: "B-1", lineCode: "pedia", period: "2026-07", actualValue: 900, targetValue: 100 }),
      row({ repHrId: "B-2", lineCode: "cns", period: "2026-07", actualValue: 100, targetValue: 100 }),
    ],
    priorRows: [],
    publishedKeys: new Set(["cns|2026-07"]),
    periods: ["2026-07"],
    priorPeriods: [],
    people: peopleOf(["B-1"], ["B-2"]),
    activeKeys: null,
    establishment: ESTABLISHMENT,
    filters: NO_FILTERS,
  });
  assert.deepEqual(
    cnsOnly.overall.map((entry) => entry.hrId),
    ["B-2"],
    "the gate is per LINE: Pedia's July is unpublished here, so its 900% rep is not on the board",
  );

  // ── 4. Leavers, and the directory read that fails ────────────────────────────────────────────
  const withLeaver = [
    row({ repHrId: "B-1", actualValue: 300, targetValue: 100 }),
    row({ repHrId: "B-2", actualValue: 150, targetValue: 100 }),
    row({ repHrId: "B-3", actualValue: 120, targetValue: 100 }),
  ];
  const serving = boardsOf({ rows: withLeaver, activeKeys: new Set(["B2", "B3"]) });
  assert.deepEqual(
    serving.overall.map((entry) => entry.hrId),
    ["B-2", "B-3"],
    "a departed rep comes off the board BEFORE the ranking, not after — he was holding first place",
  );
  assert.equal(serving.overall[0].rank, 1, "the serving rep takes the place the leaver was holding");
  assert.equal(
    boardsOf({ rows: withLeaver, activeKeys: new Set() }).overall.length,
    3,
    "a FAILED directory read (no keys at all) ranks everybody — fail open, never fail empty",
  );

  // ── 5. No target in the window is not a rank ─────────────────────────────────────────────────
  const noTarget = boardsOf({
    rows: [
      row({ repHrId: "B-1", actualValue: 300, targetValue: 100 }),
      row({ repHrId: "B-2", actualValue: 90_000, targetValue: null }),
    ],
    people: peopleOf(["B-1"], ["B-2"]),
  });
  assert.deepEqual(
    noTarget.overall.map((entry) => entry.hrId),
    ["B-1"],
    "a rep with no target in the window is not ranked — 0% would be arithmetic, not performance",
  );

  // ── 6. The filter decides the population AND the arithmetic ──────────────────────────────────
  const twoLines = [
    row({ repHrId: "B-1", lineCode: "cns", actualValue: 100, targetValue: 100 }),
    row({ repHrId: "B-1", lineCode: "pedia", actualValue: 900, targetValue: 100 }),
    row({ repHrId: "B-2", lineCode: "cns", actualValue: 300, targetValue: 100 }),
  ];
  const company = boardsOf({ rows: twoLines, people: peopleOf(["B-1"], ["B-2"]) });
  assert.equal(Math.round(company.overall[0].achievementPercent), 500, "company-wide, a rep's lines are added (1000/200)");
  const cnsBoard = boardsOf({ rows: twoLines, people: peopleOf(["B-1"], ["B-2"]), filters: { lines: ["cns"] } });
  assert.deepEqual(
    cnsBoard.overall.map((entry) => [entry.hrId, Math.round(entry.achievementPercent)]),
    [["B-2", 300], ["B-1", 100]],
    "filtered to CNS, each rep is ranked on CNS money alone — B-1's Pedia sales cannot win him a CNS board",
  );
  assert.equal(
    cnsBoard.byLine.length,
    1,
    "a line filter leaves only that line's board — the page never shows a board the filter excluded",
  );

  // Multiple lines at once: the union, with each rep's money inside those lines.
  const twoOfThree = boardsOf({
    rows: [
      ...twoLines,
      row({ repHrId: "B-3", lineCode: "anti_infective", actualValue: 800, targetValue: 100 }),
    ],
    people: peopleOf(["B-1"], ["B-2"], ["B-3"]),
    filters: { lines: ["cns", "pedia"] },
  });
  assert.deepEqual(
    twoOfThree.overall.map((entry) => entry.hrId),
    ["B-1", "B-2"],
    "two lines selected is their union — the Anti Infective rep is not in this comparison",
  );
  assert.equal(twoOfThree.seats, 81, "the seat count follows the selection: CNS 40 + Pedia 41");

  // ── 7. Title, region and name — and what they do to the 'out of N' ───────────────────────────
  const mixedTitles = boardsOf({
    rows: [
      row({ repHrId: "B-1", actualValue: 300, targetValue: 100 }),
      row({ repHrId: "B-2", actualValue: 150, targetValue: 100 }),
    ],
    people: peopleOf(["B-1", { title: "Senior Medical Representative" }], ["B-2"]),
    filters: { titles: ["Senior Medical Representative"] },
  });
  assert.deepEqual(mixedTitles.overall.map((entry) => entry.hrId), ["B-1"], "a title filter keeps only that title");
  assert.equal(
    mixedTitles.seats,
    null,
    "a title is not a seat model: the board says how many it ranked rather than quoting a rep-seat count it no longer matches",
  );
  assert.equal(mixedTitles.ranked, 1, "the ranked count is always true of whatever slice is on screen");

  const byRegion = boardsOf({
    rows: [
      row({ repHrId: "B-1", actualValue: 300, targetValue: 100 }),
      row({ repHrId: "B-2", actualValue: 150, targetValue: 100 }),
    ],
    people: peopleOf(["B-1", { regionName: "Upper Egypt" }], ["B-2", { regionName: "Delta" }]),
    filters: { regions: ["Delta"] },
  });
  assert.deepEqual(byRegion.overall.map((entry) => entry.hrId), ["B-2"], "a region filter keeps only that region");

  const byName = boardsOf({
    rows: [
      row({ repHrId: "B-1", actualValue: 300, targetValue: 100 }),
      row({ repHrId: "B-2", actualValue: 150, targetValue: 100 }),
    ],
    people: peopleOf(["B-1", { name: "Aya Ibrahim" }], ["B-2", { name: "Mohamed Ali" }]),
    filters: { query: "aya" },
  });
  assert.deepEqual(byName.overall.map((entry) => entry.name), ["Aya Ibrahim"], "one person can be looked up by name");
  assert.equal(byName.seats, null, "a search is a slice too — the seat denominator switches off with it");

  // ── 8. The company seat count, and the move since the window before ──────────────────────────
  assert.equal(
    boardsOf({ rows: [row({ repHrId: "B-1", actualValue: 300, targetValue: 100 })] }).seats,
    111,
    "unsliced, 'out of N' is the organogram's rep seats, vacancies included (owner, 2026-10-03)",
  );
  assert.equal(
    boardsOf({ rows: [row({ repHrId: "B-1", actualValue: 300, targetValue: 100 })] }).vacant,
    35,
    "the vacancies travel with the seat count, so a board can say what the number includes",
  );

  const moved = buildRankingBoards({
    // July: B-2 leads. August: B-1 leads. So B-1 moved up one and B-2 down one.
    rows: [
      row({ repHrId: "B-1", period: "2026-08", actualValue: 300, targetValue: 100 }),
      row({ repHrId: "B-2", period: "2026-08", actualValue: 150, targetValue: 100 }),
      row({ repHrId: "B-1", period: "2026-07", actualValue: 100, targetValue: 100 }),
      row({ repHrId: "B-2", period: "2026-07", actualValue: 400, targetValue: 100 }),
    ],
    priorRows: [
      row({ repHrId: "B-1", period: "2026-07", actualValue: 100, targetValue: 100 }),
      row({ repHrId: "B-2", period: "2026-07", actualValue: 400, targetValue: 100 }),
    ],
    publishedKeys: PUBLISHED,
    periods: ["2026-08"],
    priorPeriods: ["2026-07"],
    people: peopleOf(["B-1"], ["B-2"]),
    activeKeys: null,
    establishment: ESTABLISHMENT,
    filters: NO_FILTERS,
  });
  assert.equal(moved.overall[0].trend, 1, "moving from 2nd to 1st reads as +1 — positive is UP the board");
  assert.equal(moved.overall[1].trend, -1, "and the rep he passed reads -1");
  const brandNew = buildRankingBoards({
    rows: [row({ repHrId: "B-9", period: "2026-08", actualValue: 300, targetValue: 100 })],
    priorRows: [],
    publishedKeys: PUBLISHED,
    periods: ["2026-08"],
    priorPeriods: ["2026-07"],
    people: peopleOf(["B-9"]),
    activeKeys: null,
    establishment: ESTABLISHMENT,
    filters: NO_FILTERS,
  });
  assert.equal(brandNew.overall[0].trend, null, "a rep who was not ranked last window has no move, not a move of zero");

  // A rep straddling two lines is labelled with the line carrying most of his money.
  const straddler = boardsOf({ rows: twoLines, people: peopleOf(["B-1"], ["B-2"]) });
  assert.equal(
    straddler.overall.find((entry) => entry.hrId === "B-1")?.lineLabel,
    "Pedia",
    "a two-line rep's row names the line he actually sells, never the first row the engine returned",
  );

  // ── 9. The loader reads the closing engine and nothing else ──────────────────────────────────
  const loader = stripComments(readFileSync("src/lib/sales/rankings-page.ts", "utf8"));
  for (const call of ["loadAchievementRange", "loadPublishedPeriodKeys", "applyAchievementAreaMerges"]) {
    assert.ok(
      loader.includes(call),
      `rankings-page.ts must read the Monthly Closing engine through ${call}() — the source-of-truth golden ` +
        `rule (AGENTS.md §4) is what keeps this board equal to the closing it reports`,
    );
  }
  assert.ok(
    !loader.includes("getSupabaseAdmin") && !/\.from\(["'`]/.test(loader),
    "rankings-page.ts must not query a table of its own: a second definition of achievement here is how the " +
      "board starts disagreeing with the rep's own badge",
  );

  // ── 10. The page itself: its gate, and the two locked looks ──────────────────────────────────
  const page = stripComments(readFileSync("app/(admin)/sales/rankings/page.tsx", "utf8"));
  assert.ok(
    page.includes('assertPermission(access, "sales", "read")'),
    "server-side access control is the security boundary — the page asserts sales:read before it reads anything",
  );
  assert.ok(
    page.includes('resolveNavigationMode(access) === "employee-portal"') && page.includes("redirect("),
    "portal-shell roles are redirected to their own scoped analytics rather than denied, as /sales/vs-target does",
  );

  const ui = stripComments(readFileSync("src/components/sales/rankings/rankings-explorer.tsx", "utf8"));
  assert.ok(!/\brounded-/.test(ui), "THE SQUARE-EDGE GOLDEN RULE — no rounded corners anywhere on this page");
  assert.ok(
    !/\btruncate\b/.test(ui) && !ui.includes("text-ellipsis") && !ui.includes("…"),
    "NO TRUNCATION EVER (owner rule): a long name wraps, it is never cut short with an ellipsis",
  );
  assert.ok(
    ui.includes('className="w-full table-fixed text-left text-sm"') && ui.includes("<colgroup>"),
    "THE FITS-THE-SCREEN GOLDEN RULE — a table-fixed table with a colgroup, so the page fits its screen",
  );
  assert.ok(
    !ui.includes("overflow-x-auto") && !/min-w-\[/.test(ui),
    "a sideways scroll over a min-width IS the bug the fits-the-screen rule names — the phone gets cards instead",
  );
  // 🔒 The switch is the BOARD'S own width, never the viewport's. A board renders full-width in the
  // bottom section and at half of `xl:grid-cols-2` in the panels, and those are not the same number
  // of pixels: with a viewport-keyed `lg:block` the two-up panel is 452px at a 1280px viewport, and
  // scripts/measure-rankings-fit.mjs measured 18 clipped cells there — the fits-the-screen rule
  // broken on a wide monitor, which no viewport breakpoint can see. Restoring `lg:block` here must
  // fail this assertion.
  assert.ok(
    ui.includes('className="@container"'),
    "each board is its own query container, so the table/card switch reads the BAND's width, not the viewport's",
  );
  assert.ok(
    !/\b(?:sm|md|lg|xl|2xl):hidden\b/.test(ui) && !/hidden (?:sm|md|lg|xl|2xl):block\b/.test(ui),
    "a VIEWPORT breakpoint cannot decide this — a 1280px viewport holds a 452px board and a 918px one at once",
  );

  // The colgroup's own arithmetic, re-done from the source the way
  // tests/sales-target-tables-fit-the-screen.test.ts does it for this module's other two tables.
  //
  // The admin table is at its NARROWEST at a 1024px viewport, where the shell's rail is already in
  // and the display scale has not yet widened anything: ~660px (measured 2026-09-16 on the real
  // page). What binds is never the figures — it is the one-word "ACHIEVEMENT" header, 10px black
  // capitals with 0.12em tracking, ~101px of ink plus 24px of cell padding.
  const NARROWEST_ADMIN_TABLE_PX = 660;
  // And the container threshold IS that number, not a second one beside it: below the only width
  // this colgroup has been proven at, the board shows cards rather than a table on trust.
  assert.ok(
    ui.includes(`hidden @min-[${NARROWEST_ADMIN_TABLE_PX}px]:block`) &&
      ui.includes(`@min-[${NARROWEST_ADMIN_TABLE_PX}px]:hidden`),
    `the table appears only at or above ${NARROWEST_ADMIN_TABLE_PX}px of BOARD width — the width the arithmetic below proves`,
  );
  const shares = [...ui.matchAll(/<col style=\{\{ width: "(\d+)%" \}\} \/>/g)].map((match) => Number(match[1]));
  assert.equal(shares.length, 5, "five columns: the line and the region are MERGED under the name, never columns of their own");
  assert.equal(shares.reduce((sum, share) => sum + share, 0), 100, "the colgroup must account for exactly 100% of the table");
  const px = shares.map((share) => (share / 100) * NARROWEST_ADMIN_TABLE_PX);
  assert.ok(px[0] >= 52, `the rank column holds a 28px tile plus 24px of padding; it has ${Math.round(px[0])}px`);
  assert.ok(px[2] >= 125, `ACHIEVEMENT's header needs 125px with its padding; the column has ${Math.round(px[2])}px`);
  assert.ok(px[3] >= 99, `"EGP 1.23M" needs about 99px with its padding; the Sales column has ${Math.round(px[3])}px`);
  assert.ok(px[4] >= 70, `a trend pill ("▲ +12") needs about 70px; the column has ${Math.round(px[4])}px`);
  assert.ok(
    px[1] >= 240,
    `the name column carries a 36px photo, a 12px gap and two wrapping lines — it needs ~240px and has ${Math.round(px[1])}px`,
  );

  // ── 11. The tab itself exists, gated like its sibling ────────────────────────────────────────
  const nav = readFileSync("src/config/system-navigation.ts", "utf8");
  const navRow = nav.split("\n").find((line) => line.includes('href: "/sales/rankings"'));
  assert.ok(navRow, "the Rankings tab must be in the sidebar — a page nobody can reach is not a tab");
  assert.ok(
    navRow.includes('label: "Rankings"') && navRow.includes('resource: "sales"') && navRow.includes('action: "read"'),
    "the row is gated on sales:read, the same permission the page asserts",
  );
  for (const role of ["Super Admin", "SFE Manager", "CEO"]) {
    assert.ok(navRow.includes(`"${role}"`), `${role} reads Sales vs Target and so reads its ranking board`);
  }
}
