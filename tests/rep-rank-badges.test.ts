import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  COMPANY_RANK_BADGE_LIMIT,
  LINE_RANK_BADGE_LIMIT,
  repRankStanding,
} from "../src/lib/employee-portal/rep-rank.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE MEDICAL REP'S HONOUR BADGES ON HIS LANDING PAGE.
 *
 * Owner, 2026-10-03: *"on medical reps landing overview I want to add a motivating badge if his ach%
 * is from the top 15 medical reps in the company — show him 'you ranked the 8th out of' and tell the
 * medical reps count of the company in the period from to. If not from 15 do not show anything. The
 * same thing but if from the top 7 in his line, so Hassan … area Pedia line will have 2 badges."*
 *
 * Four things can go wrong silently, and each is pinned below.
 *
 *  1. THE RANK COULD DISAGREE WITH THE PERCENTAGE PRINTED ABOVE IT. Achievement is ALL sales ÷
 *     target off the closing engine (Rule #1) — what the published closing and his portal overview
 *     divide. Re-deriving it, or dividing only the targeted slice (the covered rule it used until
 *     2026-10-25), puts a rank on the page that the closing contradicts.
 *  2. THE WINDOW COULD SILENTLY NARROW TO ONE MONTH. Owner, 2026-10-03, correcting the first
 *     build: *"do not calculate only August, calculate up to date — example for now 7 and 8, when
 *     9 closing is published then 7 8 9."* So the board is every PUBLISHED month summed and
 *     divided once, it widens by itself when a closing is published, and the badge prints the
 *     window it actually used — the keycard beside it shows ONE month and the two differ by
 *     design.
 *  3. A LEAVER COULD HOLD A PLACE. Source of Sales keeps a resigned rep's money, correctly, so a
 *     departed name sits on the raw board and pushes everyone below it down one. Measured on
 *     production for 2026-08: 3 of 73 ranked seats had already left, one of them in 8th place.
 *  4. A CONSOLATION BADGE COULD CREEP IN. "If not from 15 do not show anything" is the owner's own
 *     sentence. A greyed badge, a "keep going" line or a rank printed outside the band all break it.
 *
 * Comments are stripped before every source read: this file's prose spells the strings it pins, and
 * a test that matched its own explanation would pin nothing (AGENTS.md §2.1).
 */

const RANK = "src/lib/employee-portal/rep-rank.ts";
const SNAPSHOT = "src/lib/employee-portal/home-snapshot.ts";
const CENTER = "src/components/employee-portal/portal-command-center.tsx";
const STRIP = "src/components/employee-portal/rep-honour-strip.tsx";

/** Source with comments removed and whitespace flattened — these files are hard-wrapped at ~100 cols. */
const flat = (path: string) => stripComments(readFileSync(path, "utf8")).replace(/\s+/g, " ");

/** One achievement row, with every field the engine returns so the fixtures stay type-complete. */
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

export function runRepRankBadgesTests() {
  // ── 1. The owner's own numbers ───────────────────────────────────────────────────────────────
  assert.equal(COMPANY_RANK_BADGE_LIMIT, 15, "the company badge is the top 15 — the owner's number");
  assert.equal(LINE_RANK_BADGE_LIMIT, 7, "the line badge is the top 7 — the owner's number");

  // ── 2. The ranking itself ────────────────────────────────────────────────────────────────────
  // Achievement descending, never raw sales: B-2 outsells B-1 and is still behind it, because
  // achievement is what the badge ranks.
  const board = [
    row({ repHrId: "B-1", actualValue: 200, targetValue: 100 }),
    row({ repHrId: "B-2", actualValue: 900, targetValue: 1000 }),
    row({ repHrId: "B-3", actualValue: 150, targetValue: 100 }),
  ];
  const first = repRankStanding(board, PUBLISHED, { hrId: "B-1" });
  assert.ok(first?.company, "a rep at 200% must hold a company badge");
  assert.equal(first.company.rank, 1, "200% ranks above 150% and 90%");
  assert.equal(first.company.outOf, 3, "out-of counts every rep that could be scored");
  assert.equal(Math.round(first.company.achievementPercent), 200, "the % on the badge is sales ÷ target");

  // ALL sales ÷ target, as the closing divides: B-4 sells 100 against his one target of 200 and 300
  // on an untargeted product, so the closing reads 400/200 = 200%. The covered rule read 50%
  // (production: PD0017 July, 21.76% on the badge against the closing's 25.90%).
  const mixed = [
    row({ repHrId: "B-4", actualValue: 100, targetValue: 200 }),
    row({ repHrId: "B-4", actualValue: 300, targetValue: null }),
    row({ repHrId: "B-5", actualValue: 150, targetValue: 100 }),
  ];
  const mixedStanding = repRankStanding(mixed, PUBLISHED, { hrId: "B-4" });
  assert.equal(
    Math.round(mixedStanding?.company?.achievementPercent ?? 0),
    200,
    "the badge divides ALL his sales by his target (400/200), never the targeted slice alone (50%)",
  );
  assert.equal(mixedStanding?.company?.rank, 1, "and ranks on it: 200% stands above 150%");
  assert.equal(
    repRankStanding(board, PUBLISHED, { hrId: "B-2" })?.company?.rank,
    3,
    "the biggest seller is LAST here — the board ranks achievement, not sales",
  );
  assert.equal(
    repRankStanding(board, PUBLISHED, { hrId: "b1" })?.company?.rank,
    1,
    "HR ids match hyphen- and case-insensitively: the engine's casing is not the repo's",
  );

  // Sales break a tie, the same way every portal leaderboard breaks one.
  const tied = [
    row({ repHrId: "B-10", actualValue: 100, targetValue: 100 }),
    row({ repHrId: "B-11", actualValue: 500, targetValue: 500 }),
  ];
  assert.equal(
    repRankStanding(tied, PUBLISHED, { hrId: "B-11" })?.company?.rank,
    1,
    "two reps both at 100% — the larger sales value takes the higher place",
  );

  // ── 3. Who is NOT on the board ───────────────────────────────────────────────────────────────
  // A rep with no target is not ranked and is not in anybody's denominator: 0% would be arithmetic,
  // not performance, and counting them in "out of N" would be a lie to every other rep.
  const withNoTarget = [
    row({ repHrId: "B-1", actualValue: 200, targetValue: 100 }),
    row({ repHrId: "B-2", actualValue: 150, targetValue: 100 }),
    row({ repHrId: "B-9", actualValue: 400, targetValue: null }),
  ];
  assert.equal(
    repRankStanding(withNoTarget, PUBLISHED, { hrId: "B-9" }),
    null,
    "a rep with no target gets no badge — there is nothing to be a percentage of",
  );
  assert.equal(
    repRankStanding(withNoTarget, PUBLISHED, { hrId: "B-1" })?.company?.outOf,
    2,
    "and they are not in the denominator either",
  );

  // A LEAVER comes off before the ranking, so the serving rep behind them moves up.
  const activeOnly = new Set(["B1", "B3"]);
  const withLeaver = [
    row({ repHrId: "B-1", actualValue: 200, targetValue: 100 }),
    row({ repHrId: "B-2", actualValue: 180, targetValue: 100 }),
    row({ repHrId: "B-3", actualValue: 150, targetValue: 100 }),
  ];
  assert.equal(
    repRankStanding(withLeaver, PUBLISHED, { hrId: "B-3" })?.company?.rank,
    3,
    "control: with nobody filtered, the third rep is third",
  );
  const afterLeaver = repRankStanding(withLeaver, PUBLISHED, { hrId: "B-3", activeHrKeys: activeOnly });
  assert.equal(afterLeaver?.company?.rank, 2, "a departed rep in 2nd must not hold the place of a serving rep");
  assert.equal(afterLeaver?.company?.outOf, 2, "and must not be counted in the 'out of N' every rep reads");
  assert.equal(
    repRankStanding(withLeaver, PUBLISHED, { hrId: "B-2", activeHrKeys: activeOnly }),
    null,
    "the leaver themself gets no badge",
  );
  // FAIL OPEN, never fail empty: a directory read that came back with nothing must rank everybody.
  assert.equal(
    repRankStanding(withLeaver, PUBLISHED, { hrId: "B-3", activeHrKeys: new Set() })?.company
      ?.outOf,
    3,
    "an empty active set is a FAILED directory read — it must rank everyone, not nobody",
  );

  // An UNPUBLISHED month is not a leaderboard. Same gate as every other sales surface.
  assert.equal(
    repRankStanding(board, new Set(), { hrId: "B-1" }),
    null,
    "no published closing for the line means no board at all",
  );
  // Head Office carries no line code, so it can never be published — and never ranked.
  assert.equal(
    repRankStanding([row({ repHrId: "B-1", actualValue: 200, targetValue: 100, lineCode: null })], PUBLISHED, {
      hrId: "B-1",
    }),
    null,
    "a row with no line is an area's row, never a person's rank",
  );

  // ── 3b. THE WINDOW IS CUMULATIVE, AND SUMMED BEFORE IT IS DIVIDED ────────────────────────────
  // Owner, 2026-10-03: "do not calculate only August, calculate up to date — example for now 7 and
  // 8, when 9 closing is published then 7 8 9." This fixture fails BOTH ways it can go wrong:
  //
  //   B-1  Jul   100 / 1,000 =  10%     B-2  Jul  500 / 1,000 = 50%
  //        Aug   400 /   100 = 400%          Aug   50 /   100 = 50%
  //        summed 500 / 1,100 = 45.5%        summed 550 / 1,100 = 50%
  //
  // Ranked on AUGUST ALONE, B-1 (400%) is first. Ranked on the AVERAGE of his monthly ratios
  // (205%) he is first too. Ranked the one correct way — summed, then divided once — he is SECOND.
  const cumulative = [
    row({ repHrId: "B-1", period: "2026-07", actualValue: 100, targetValue: 1000 }),
    row({ repHrId: "B-1", period: "2026-08", actualValue: 400, targetValue: 100 }),
    row({ repHrId: "B-2", period: "2026-07", actualValue: 500, targetValue: 1000 }),
    row({ repHrId: "B-2", period: "2026-08", actualValue: 50, targetValue: 100 }),
  ];
  const cumulativeFirst = repRankStanding(cumulative, PUBLISHED, { hrId: "B-2" });
  const cumulativeSecond = repRankStanding(cumulative, PUBLISHED, { hrId: "B-1" });
  assert.equal(cumulativeFirst?.company?.rank, 1, "the steadier rep leads the CUMULATIVE board");
  assert.equal(
    cumulativeSecond?.company?.rank,
    2,
    "a 400% August does NOT win: ranking one month, or averaging the monthly ratios, would put him first",
  );
  assert.equal(
    Math.round((cumulativeSecond?.company?.achievementPercent ?? 0) * 10) / 10,
    45.5,
    "the % is the summed window (500/1,100), never 400% and never the 205% an average would give",
  );
  assert.equal(cumulativeSecond?.fromPeriod, "2026-07", "the window starts at the earliest published month");
  assert.equal(cumulativeSecond?.toPeriod, "2026-08", "and ends at the latest one");
  assert.equal(
    cumulativeSecond?.windowLabel,
    "Jul – Aug 2026",
    "the badge prints the window it used — a rank with no period on it is a fact about nothing",
  );

  // AN UNPUBLISHED MONTH NEVER WIDENS THE WINDOW. September's rows are present and must be ignored
  // until its closing is published — at which point the window becomes Jul–Sep on its own.
  const withSeptember = [
    ...cumulative,
    row({ repHrId: "B-1", period: "2026-09", actualValue: 9000, targetValue: 100 }),
    row({ repHrId: "B-2", period: "2026-09", actualValue: 1, targetValue: 100 }),
  ];
  const stillAugust = repRankStanding(withSeptember, PUBLISHED, { hrId: "B-1" });
  assert.equal(stillAugust?.toPeriod, "2026-08", "an unpublished September must not reach the board");
  assert.equal(stillAugust?.company?.rank, 2, "nor change the ranking");
  const septemberPublished = new Set([...PUBLISHED, "cns|2026-09", "pedia|2026-09", "anti_infective|2026-09"]);
  const afterPublish = repRankStanding(withSeptember, septemberPublished, { hrId: "B-1" });
  assert.equal(afterPublish?.toPeriod, "2026-09", "publishing September widens the window with no code change");
  assert.equal(afterPublish?.windowLabel, "Jul – Sep 2026", "and the badge says so");
  assert.equal(afterPublish?.company?.rank, 1, "and his September carries him to the top of the cumulative board");

  // A single-month window still reads as a period, not as a range.
  const julyOnly = new Set(["cns|2026-07", "pedia|2026-07", "anti_infective|2026-07"]);
  assert.equal(
    repRankStanding(cumulative, julyOnly, { hrId: "B-2" })?.windowLabel,
    "Jul 2026",
    "one published month is named, never printed as a range against itself",
  );

  // ── 4. The two bands, and the silence outside them ───────────────────────────────────────────
  // 16 reps, one line. The 15th holds a company badge, the 16th holds nothing at all.
  const sixteen = Array.from({ length: 16 }, (_, index) =>
    row({ repHrId: `B-${index + 1}`, actualValue: 1600 - index * 100, targetValue: 1000 }),
  );
  assert.equal(
    repRankStanding(sixteen, PUBLISHED, { hrId: "B-15" })?.company?.rank,
    15,
    "15th of the company still earns the badge",
  );
  assert.equal(
    repRankStanding(sixteen, PUBLISHED, { hrId: "B-16" }),
    null,
    "16th earns NOTHING — neither badge, and no half-empty standing to render around: 'if not from 15 do not show anything'",
  );
  assert.equal(
    repRankStanding(sixteen, PUBLISHED, { hrId: "B-7" })?.line?.rank,
    7,
    "7th of the line still earns the line badge",
  );
  assert.equal(
    repRankStanding(sixteen, PUBLISHED, { hrId: "B-8" })?.line,
    null,
    "8th of the line does not",
  );
  assert.equal(
    repRankStanding(sixteen, PUBLISHED, { hrId: "B-404" }),
    null,
    "a rep with no rows in the month is not on the board at all",
  );

  // ── 5. The line board is its own board ───────────────────────────────────────────────────────
  // The owner's own example: strong in his line, nowhere near the company top 15. Eight CNS reps all
  // above him, and he is still 1st of Pedia.
  const twoLines = [
    ...Array.from({ length: 16 }, (_, index) =>
      row({ repHrId: `C-${index + 1}`, actualValue: 2000 - index * 10, targetValue: 1000, lineCode: "cns" }),
    ),
    row({ repHrId: "P-1", actualValue: 500, targetValue: 1000, lineCode: "pedia" }),
    row({ repHrId: "P-2", actualValue: 400, targetValue: 1000, lineCode: "pedia" }),
  ];
  const pediaBest = repRankStanding(twoLines, PUBLISHED, { hrId: "P-1" });
  assert.equal(pediaBest?.company, null, "outside the company top 15 — so no company badge");
  assert.equal(pediaBest?.line?.rank, 1, "but first in his own line");
  assert.equal(pediaBest?.line?.outOf, 2, "against his own line's reps only, never the company's");
  assert.equal(pediaBest?.line?.lineName, "Pedia", "the badge names the line, not its code");
  const cnsBest = repRankStanding(twoLines, PUBLISHED, { hrId: "C-1" });
  assert.ok(cnsBest?.company && cnsBest.line, "a rep can hold BOTH badges — the owner's two-badge case");
  assert.equal(cnsBest.line.lineName, "CNS", "and the second badge names his line");

  // A rep holding rows on two lines belongs to the line carrying most of their money — not to
  // whichever line the engine happened to return first. Two of 73 seats straddled lines in 2026-08.
  const straddler = [
    row({ repHrId: "B-1", actualValue: 10, targetValue: 100, lineCode: "cns" }),
    row({ repHrId: "B-1", actualValue: 900, targetValue: 1000, lineCode: "pedia" }),
    row({ repHrId: "P-9", actualValue: 100, targetValue: 1000, lineCode: "pedia" }),
  ];
  assert.equal(
    repRankStanding(straddler, PUBLISHED, { hrId: "B-1" })?.line?.lineName,
    "Pedia",
    "the rep's line is where the money is, not the first row seen",
  );

  // ── 6. The loader's own guards ───────────────────────────────────────────────────────────────
  const rankSource = flat(RANK);
  assert.ok(
    /loadAchievementRange\(SALES_VS_TARGET_FLOOR, current\)/.test(rankSource),
    `${RANK}: the window runs from the engine floor to today — every published month, not one`,
  );
  assert.ok(
    !/period: options\.period|row\.period !== /.test(rankSource),
    `${RANK}: no single-period filter may come back — the board is cumulative (owner, 2026-10-03)`,
  );
  assert.ok(
    /getEmployeeDirectoryRows\(\)\.catch/.test(rankSource),
    `${RANK}: the directory read is caught — a failed lookup ranks everybody, it never fails the page`,
  );
  assert.ok(
    rankSource.includes("applyAchievementAreaMerges"),
    `${RANK}: Fayoum/Beni Suef merge BEFORE grouping, like every other consumer of these rows`,
  );
  assert.ok(
    rankSource.includes("isRowPublished"),
    `${RANK}: published rows only — an unpublished month is an unfinished one, not a leaderboard`,
  );

  // ── 7. The tile's month, and the badge's own window ──────────────────────────────────────────
  // These are DIFFERENT windows and must stay visibly different: the keycard is one month, the
  // badge is every published month summed. The tile's label is still single-sourced so it cannot
  // drift from the number it sits above.
  const snapshot = flat(SNAPSHOT);
  assert.ok(
    snapshot.includes("effectivePeriod"),
    `${SNAPSHOT}: the month the tile actually shows is computed once, server-side`,
  );
  assert.ok(
    /effectivePeriod: currentPoint && currentPoint\.targetValue > 0 \? currentPeriod/.test(snapshot),
    `${SNAPSHOT}: the picked month counts only when it is published WITH a target — the tile's own rule`,
  );
  assert.ok(
    /newestFirst\.find\(\(point\) => point\.targetValue > 0\)/.test(snapshot),
    `${SNAPSHOT}: the fallback is the newest published month WITH a target, off the same four points the tile draws`,
  );
  assert.ok(
    /mrAchievementPeriod,/.test(snapshot) && /mrRankStanding,/.test(snapshot),
    `${SNAPSHOT}: both fields must reach the snapshot the page renders`,
  );
  assert.ok(
    /loadRepRankStanding\(hrId\)\.catch\(\(\) => null\)/.test(snapshot),
    `${SNAPSHOT}: the rank takes NO period — it ranks the published window — and never rejects`,
  );
  assert.ok(
    !/loadRepRankStanding\(hrId, /.test(snapshot),
    `${SNAPSHOT}: passing a period back in would narrow the board to one month again`,
  );

  const center = flat(CENTER);
  assert.ok(
    /const achMonth = mrAchievementPeriod \?/.test(center),
    `${CENTER}: the Achievement tile's own month label comes from mrAchievementPeriod`,
  );
  // 🔒 HIS OWN PLACEMENT, 2026-10-03: "no, put it above Medical Representative / Field Performance",
  // and then "I want only a strip … that simple, easy cake — not all over-engineered." Two medals and
  // a separate export panel became ONE strip.
  assert.ok(
    (center.match(/<RepHonourStrip standing=\{mrRankStanding\} \/>/g) ?? []).length === 1,
    `${CENTER}: ONE strip on the rep's landing`,
  );
  // 🔒 "Remove this section, Medical Representative / Field Performance" (owner, 2026-10-03). The bar
  // the strip used to sit above is gone from the REP's landing — the other roles keep theirs.
  assert.ok(
    !/<PortalContextBar context="Field Performance" role="Medical Representative"/.test(center),
    `${CENTER}: no "Medical Representative · Field Performance" bar on the rep's landing — he removed it`,
  );
  // 🔒 LINE · JOINED · REPORTS TO ON ONE LINE, AT EVERY WIDTH (owner, 2026-10-03: "in mobile view I want
  // this to be in one line, not two"). It paired Line + Joined on a phone and stacked Reports To under
  // them. The row no longer turns into a column below sm, and the last cell takes what is left. Every
  // cell stays min-w-0 and its value wraps: a long name breaks onto a second line inside its own cell,
  // never an ellipsis and never a sideways scroll (measured with "Anti Infective" and a three-part
  // manager name at 375px — one row, nothing clipped, page overflow 0).
  assert.ok(
    /<div className="relative flex gap-px">/.test(center) && !/flex flex-col gap-px sm:flex-row/.test(center),
    `${CENTER}: Line, Joined and Reports To share ONE row on a phone — never stacked into two`,
  );
  assert.ok(
    !/RepRankBadges|RepPerformanceCardShare/.test(center),
    `${CENTER}: the two medals and the export panel are gone — they are what made the page crowded`,
  );

  // ── 8. The strip itself ──────────────────────────────────────────────────────────────────────
  const strip = flat(STRIP);
  assert.ok(strip.startsWith('"use client"'), `${STRIP}: it renders and shares files, so it is a client component`);
  assert.ok(
    /if \(!standing\) return null;/.test(strip),
    `${STRIP}: no strip and no consolation state outside the two bands — the owner's own sentence`,
  );
  assert.ok(
    !/\brounded(-|\b)/.test(strip),
    `${STRIP}: the square-edge golden rule — no round or semi-round corners, not even on an icon frame`,
  );
  assert.ok(
    !/truncate|line-clamp|text-ellipsis|…/.test(strip),
    `${STRIP}: never truncate — where it collides with fitting the screen, wrapping wins (AGENTS.md §4)`,
  );
  assert.ok(
    !/overflow-x-auto|min-w-\[/.test(strip),
    `${STRIP}: a horizontal scroll is the bug the fits-the-screen rule names, never the fix`,
  );
  // 🔒 HIS FOOTER, 2026-10-03. He sent a finished Sato × Phoenix photo frame — "check this design" —
  // then "build the rank strip in this footer's style", then "put a line at the bottom as the one you
  // are putting at the top". Everything pinned below is that footer, MEASURED off the image: a 3px
  // brand-blue rule, a faint SQUARE grid, Sato full colour on the left, the full Phoenix LOCKUP (bird +
  // PHOENIX + WORKFORCE) on the right, and a 32×3px orange tick over a line of navy capitals in the
  // middle — the date on his footer, the RANKING here.
  // 🔴 THIS SUPERSEDES DIRECTION A, which pinned the ABSENCE of the grid and the tick. Those were right
  // for A and are wrong for this; his newer instruction is the design. Do not "restore" A's bans.
  assert.ok(
    /linear-gradient\(to_right,#ebeef1_1px,transparent_1px\),linear-gradient\(to_bottom,#ebeef1_1px,transparent_1px\)/.test(strip)
      && /bg-\[length:18px_18px\]/.test(strip),
    `${STRIP}: the ruled paper is a faint SQUARE grid — one length used twice, as on his footer`,
  );
  // 🔴 FAINT ON PURPOSE. The first build used #e4e7ea and on a phone it read far louder than his
  // footer: a 1px CSS line is TWO device pixels at 2x, so the same grey draws twice the weight.
  assert.ok(
    !/linear-gradient\(to_right,#e4e7ea|linear-gradient\(to_right,#dde4e8/.test(strip),
    `${STRIP}: the grid stays at the faint #ebeef1 — the darker greys read louder than his footer on a 2x screen`,
  );
  assert.ok(
    /shrink-0 flex-col items-center justify-center bg-white/.test(strip),
    `${STRIP}: the area behind the ranking stays BLANK — his own rule ("this square will be empty") overrides the footer`,
  );
  // 🔒 THE BLANK PANEL IS CUT EXACTLY ON THE GRID — kept by the owner, 2026-10-03. Measured before: its
  // edges sat 1.8px off the nearest line at the sides and 4px off at top and bottom, so it was ringed
  // by slivers of squares — his "all squares must be the same size", at the panel's edge. A line runs
  // through the strip's CENTRE (the half-tile offset — `bg-center` centres a TILE, whose line sits on
  // its own edge, 9px off centre), and the panel is an EVEN number of whole 18px cells: 10 × 6 on a
  // phone, 14 × 6 from @md. Measured after: 0.00px and 0.04px off the lines.
  assert.ok(
    /bg-\[position:calc\(50%_\+_9px\)_calc\(50%_\+_9px\)\]/.test(strip),
    `${STRIP}: a grid line runs through the strip's centre — the half-tile offset the panel's cut depends on`,
  );
  assert.ok(
    /h-\[108px\]/.test(strip) && /w-\[180px\]/.test(strip) && /@md:w-\[252px\]/.test(strip),
    `${STRIP}: the blank panel is an even number of WHOLE grid cells — 10 × 6, and 14 × 6 from @md`,
  );
  // 🔒 A LONG LABEL IS SET SMALLER AND HELD ON ONE LINE — the words are never cut and never broken
  // across lines (owner, 2026-10-03: "no truncation ever", then "they are still truncated" of the
  // broken-up wrap, then "no — small the size of the font"). 🔴 THIS IS THE ONE PLACE THE
  // FITS-THE-SCREEN RULE'S "merge, never shrink" IS OVERRIDDEN, BY HIM, FOR THIS LABEL. Three earlier
  // attempts are recorded in the component so none returns: dropping the word, letting it wrap three
  // deep, and stacking the two boards.
  // Measured live against the cell each label gets — 95.7px on a phone, 131.6px from @md, both fixed
  // because the panel is: nineteen letter-spaced capitals need 8px/0.08em and 10px/0.1em to fit.
  // 🔴 PINNED AS THE WHOLE EXPRESSION, NOT THE CLASS STRINGS. Asserting that "text-[8px]" merely
  // appears in the file passes while the smaller type is never CHOSEN — the hole a source-text test
  // falls into, proven once already on this strip by disarming a condition and watching it stay green.
  assert.ok(
    /hasLongLabel\s*\?\s*"text-\[8px\] tracking-\[0\.08em\] @md:text-\[10px\] @md:tracking-\[0\.1em\]"\s*:\s*"text-\[10\.5px\] tracking-\[0\.2em\]"/.test(
      strip,
    ) && /cells\.some\(\(cell\) => cell\.label\.length > 2 \* PHONE_LABEL_CHARS_PER_LINE\)/.test(strip),
    `${STRIP}: a long label — measured from the label itself — is SET SMALLER so it stays on one line, rather than the words being cut or broken`,
  );
  // 🔴 AND IT IS HELD ON ONE LINE, which is the half that does nothing without the other: the cells are
  // flex items that size to their CONTENT, so shrinking the type shrank the cell with it and the label
  // wrapped again at its new width (measured: 82px into 81.7px of cell).
  assert.ok(
    /whitespace-nowrap font-bold uppercase leading-none text-\[#0b1f3a\] \$\{labelType\}/.test(strip),
    `${STRIP}: the label is held on ONE line — without it the cell shrinks with the type and the label wraps again`,
  );
  // 🔴 AND THE GAP CLOSES WITH THE TYPE on a phone. Held on one line the long label makes its own cell
  // 92px wide, and with the full 24px gap the two cells came to 190.4px — WIDER than the 180px panel,
  // so the ranking spilled out of the white onto the grid. At 12px the row is 178.4 and sits inside.
  assert.ok(
    /hasLongLabel \? "gap-3 @md:gap-10" : "gap-6 @md:gap-10"/.test(strip),
    `${STRIP}: the gap between the two boards closes with the type, or the row spills out of the panel`,
  );
  // 🔒 PHOENIX IS NAMED ON A PHONE — kept by the owner, same day. Below @md the lockup gives way to the
  // bird, and the strip read "SATO PHARMA" on one side and an unlabelled bird on the other.
  assert.ok(
    />\s*PHOENIX\s*<\/span>[\s\S]{0,40}<\/span>/.test(strip) && /tracking-\[0\.14em\] text-\[#0b1f3a\] @md:hidden/.test(strip),
    `${STRIP}: on a phone the bird carries the word PHOENIX under it; from @md the full lockup takes over`,
  );
  assert.ok(
    /h-\[3px\] w-8 bg-\[#f47b20\]/.test(strip),
    `${STRIP}: the orange tick sits over the ranking, as it sits over the date on his footer`,
  );
  assert.ok(
    /absolute inset-x-0 top-0 z-10 h-\[3px\] bg-\[#0879b8\]/.test(strip)
      && /absolute inset-x-0 bottom-0 z-10 h-\[3px\] bg-\[#0879b8\]/.test(strip),
    `${STRIP}: a 3px brand-blue rule along the TOP and its twin along the BOTTOM — "a line at the bottom as the one at the top"`,
  );
  assert.ok(
    !/self-stretch bg-\[#0879b8\]/.test(strip) && !/inset-y-0 left-0 w-\[3px\]/.test(strip),
    `${STRIP}: no vertical rules and no side seam — the footer is framed top and bottom only`,
  );
  // 🔴 THE PERIOD IS UNDER THE RANKING, AT EVERY WIDTH — "I want the duration under the rank, not beside".
  assert.ok(
    (strip.match(/\{standing\.windowLabel\}/g) ?? []).length === 1,
    `${STRIP}: ONE window label, always UNDER the ranking — never split into a phone copy and an inline laptop copy`,
  );
  {
    const centre = strip.indexOf("shrink-0 flex-col items-center justify-center bg-white"); // comments are stripped from strip
    const label = strip.indexOf("{standing.windowLabel}");
    const right = strip.indexOf("flex min-w-0 flex-1 items-center justify-end gap-1");
    assert.ok(
      centre >= 0 && label > centre && label < right,
      `${STRIP}: the window label lives in the CENTRE column, under the figures — where his footer has the date`,
    );
  }
  assert.ok(
    /aria-label=\{open \? "Hide save and share"/.test(strip) && /<Share2/.test(strip),
    `${STRIP}: save and share are still one control on the strip — beside the period, never a second panel`,
  );
  // 🔴 NOT PALE — said twice. No wash-grey type and no faded mark.
  assert.ok(
    !/text-\[#a9b2b9\]|text-\[#b6bec4\]/.test(strip),
    `${STRIP}: no wash-grey type on the strip`,
  );
  assert.ok(
    !/opacity-\[0\.\d+\][^"]*"\s*src="\/brand\/(sato-pharma|phoenix)/.test(strip) && !/select-none opacity-/.test(strip),
    `${STRIP}: both marks at FULL strength, as on his footer — he called the faded ones "too pale" twice`,
  );
  // The footer's own ink: the date on it is near-black navy (darkest pixel #061319). The labels, the
  // period and the denominators carry the identity navy, never a grey.
  assert.ok(
    (strip.match(/text-\[#0b1f3a\]/g) ?? []).length >= 3
      && !/tracking-\[0\.2em\] text-\[#69757e\]|tracking-\[0\.2em\] text-\[#8a959d\]/.test(strip.split("{open && (")[0]),
    `${STRIP}: labels, period and denominators are the footer's NAVY ink — no grey type on the strip itself`,
  );
  assert.ok(
    /@md:text-\[30px\]/.test(strip),
    `${STRIP}: the figures carry HERO weight on a laptop — they are the whole point of the strip`,
  );
  // 🔒 SATO LEFT, PHOENIX RIGHT — his footer's order. Structural, not distance-based.
  {
    const leftCol = strip.indexOf("flex min-w-0 flex-1 justify-start");
    const rightCol = strip.indexOf("flex min-w-0 flex-1 items-center justify-end gap-1");
    const sato = strip.indexOf("sato-pharma-logo-on-light.png");
    const phoenix = strip.indexOf("phoenix-bird-icon.png");
    assert.ok(
      leftCol >= 0 && sato > leftCol && sato < rightCol,
      `${STRIP}: the SATO mark is in the LEFT column — his footer's own order`,
    );
    assert.ok(
      rightCol >= 0 && phoenix > rightCol && sato < phoenix,
      `${STRIP}: the PHOENIX lockup is in the RIGHT column — his footer's own order`,
    );
  }
  // 🔴 THE FULL LOCKUP, as on his footer: the bird, then PHOENIX in navy over WORKFORCE in orange. Below
  // @md there is no room for the words beside a ranking, so the bird carries the mark alone there.
  assert.ok(
    />\s*PHOENIX\s*</.test(strip) && />\s*WORKFORCE\s*</.test(strip) && /hidden flex-col @md:flex/.test(strip),
    `${STRIP}: the Phoenix mark is the full LOCKUP from @md — bird, PHOENIX and WORKFORCE — and the bird alone on a phone`,
  );
  // 🔴 THE MARKS STAY IN FLOW in their own flex-1 columns — every overlap this strip ever had came from
  // pinning them absolutely. And the two columns are EQUAL, which is what puts the ranking on the TRUE
  // centre: his footer centres its date BETWEEN the logos, 73px left of the photo above it, because the
  // lockup is 158px wider than the Sato mark. That defect is deliberately not copied.
  assert.ok(
    !/absolute[^"]*(sato-pharma|phoenix-bird)/.test(strip)
      && /flex min-w-0 flex-1 justify-start/.test(strip)
      && /flex min-w-0 flex-1 items-center justify-end gap-1/.test(strip),
    `${STRIP}: both marks in FLOW in two EQUAL flex-1 columns — the ranking sits on the true centre, not between the logos`,
  );
  assert.ok(
    !/px-\[clamp\(|\bpl-\d|\bpr-\d/.test(strip.split("{open && (")[0]),
    `${STRIP}: symmetric side padding — his footer's margins differ by 13px, this one's do not`,
  );
  assert.ok(
    /src="\/brand\/phoenix-bird-icon\.png"/.test(strip) && !/phoenix-camera-watermark/.test(strip),
    `${STRIP}: the Phoenix bird is the colour logo, not the faded camera line-art`,
  );
  assert.ok(
    /@container/.test(strip),
    `${STRIP}: the strip is its own query container, so every size below scales with the STRIP, not the page`,
  );
  // Calibrated against his footer as he VIEWS it: the portal's own 88% zoom shrinks container units by
  // about that factor, so these land on the footer's proportions at the zoom he uses.
  assert.ok(
    /w-\[clamp\(46px,11cqw,112px\)\]/.test(strip) && /w-\[clamp\(40px,6\.5cqw,66px\)\]/.test(strip),
    `${STRIP}: each mark RESIZES with the view between a floor and a ceiling — never a fixed width`,
  );
  assert.ok(
    /justify-center|items-center/.test(strip),
    `${STRIP}: the ranking is CENTRED between the two marks`,
  );
  assert.ok(
    /text-\[#f47b20\]/.test(strip) && /text-\[#0879b8\]/.test(strip),
    `${STRIP}: Phoenix orange reads the company, Sato's one brand blue reads the line`,
  );
  // 🔒 THE LINE CELL IS WRITTEN OUT IN FULL — "<name> line", NEVER shortened to the name alone
  // (owner, 2026-10-03: "no truncation ever"). Dropping the word was tried as a way to stop the
  // longest line name stacking three deep on a phone and he refused it: cutting a word to make it fit
  // IS truncation, and his standing rule is that where text collides with the space, WRAPPING wins.
  // The words stay and the PANEL grows instead — see the eight-square assertion above.
  assert.ok(
    /label: `\$\{line\.lineName\} line`/.test(strip),
    `${STRIP}: the line cell names the line IN FULL — "<name> line", never cut back to the name to make it fit`,
  );
  assert.ok(
    /text-\[10\.5px\] font-bold uppercase[^"]*tracking-\[0\.2em\]/.test(strip),
    `${STRIP}: the micro label is the system's one label voice — 10.5px bold uppercase, 0.2em tracking`,
  );
  assert.ok(
    !/slate-900|amber-400|sky-400|f9c06a|5db7e8/.test(strip),
    `${STRIP}: no generic palette colour and no invented metal — the two marks or nothing`,
  );
  assert.ok(
    /standing\.windowLabel/.test(strip),
    `${STRIP}: the band names the window it ranked — a rank with no period on it is a fact about nothing`,
  );
  assert.ok(
    /ordinal\(cell\.rank\)/.test(strip),
    `${STRIP}: a rank reads as an ordinal — "8th", not "8"`,
  );
  assert.ok(
    !/netSalary|payslip/i.test(strip),
    `${STRIP}: no payslip on a landing surface, not even by accident on a new strip`,
  );
}
