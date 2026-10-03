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
 *  1. THE RANK COULD DISAGREE WITH THE PERCENTAGE PRINTED ABOVE IT. Achievement is covered-actual ÷
 *     target off the closing engine (Rule #1). Re-deriving it, or ranking on full sales instead of
 *     the covered figure, puts a rank on the page that the rep's own tile contradicts.
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
  // Achievement descending, and it is the COVERED actual over the target, never full sales: B-2
  // outsells B-1 and is still behind it, because achievement is what the badge ranks.
  const board = [
    row({ repHrId: "B-1", actualValue: 200, targetValue: 100 }),
    row({ repHrId: "B-2", actualValue: 900, targetValue: 1000 }),
    row({ repHrId: "B-3", actualValue: 150, targetValue: 100 }),
  ];
  const first = repRankStanding(board, PUBLISHED, { hrId: "B-1" });
  assert.ok(first?.company, "a rep at 200% must hold a company badge");
  assert.equal(first.company.rank, 1, "200% ranks above 150% and 90%");
  assert.equal(first.company.outOf, 3, "out-of counts every rep that could be scored");
  assert.equal(Math.round(first.company.achievementPercent), 200, "the % on the badge is covered ÷ target");
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
  assert.ok(
    /<RepRankBadges standing=\{mrRankStanding\} \/>/.test(center),
    `${CENTER}: the badge prints its OWN window, never the tile's month — they cover different periods`,
  );
  // 🔒 HIS OWN PLACEMENT, 2026-10-03: "no, put it above Medical Representative / Field Performance".
  assert.ok(
    /<RepRankBadges standing=\{mrRankStanding\} \/> <PortalContextBar context="Field Performance"/.test(center),
    `${CENTER}: the badges sit directly ABOVE the Field Performance context bar — the owner moved them there`,
  );

  // ── 8. The badge's own look ──────────────────────────────────────────────────────────────────
  const badgeStart = center.indexOf("function RepRankBadges");
  const badgeEnd = center.indexOf("function RepFrequencyBreakdown", badgeStart);
  assert.ok(badgeStart > 0 && badgeEnd > badgeStart, `${CENTER}: RepRankBadges must exist to be measured`);
  const badge = center.slice(badgeStart, badgeEnd);
  assert.ok(
    /if \(!standing\) return null;/.test(badge) && /if \(badges\.length === 0\) return null;/.test(badge),
    `${CENTER}: no badge and no consolation state outside the two bands — the owner's own sentence`,
  );
  assert.ok(
    !/\brounded(-|\b)/.test(badge),
    `${CENTER}: the square-edge golden rule — no round or semi-round corners on the badges`,
  );
  assert.ok(
    !/truncate|line-clamp|text-ellipsis|…/.test(badge),
    `${CENTER}: never truncate — where it collides with fitting the screen, wrapping wins (AGENTS.md §4)`,
  );
  assert.ok(
    !/overflow-x-auto|min-w-\[/.test(badge),
    `${CENTER}: a horizontal scroll is the bug the fits-the-screen rule names, never the fix`,
  );
  assert.ok(
    badge.includes("@container") && /@2xl:grid-cols-2/.test(badge),
    `${CENTER}: two across only once the ROW has the width — a container query, never the viewport`,
  );

  // 🔒 THE BRANDS, AND THE FIELD THEY ARE STRUCK ON (owner, 2026-10-03: "colour off, matching the
  // system identity" → "brand Sato + Phoenix"). The company badge wears Phoenix's own orange and
  // warm gold off the signature card; the line badge wears Sato's logo blues; both sit on the
  // identity card's navy band, which is the colour immediately above them on the page.
  const tonesStart = center.indexOf("const REP_HONOUR_FIELD");
  const tones = center.slice(tonesStart, center.indexOf("function RepRankBadges"));
  assert.ok(tonesStart > 0 && tones.length > 0, `${CENTER}: the honour metals must be declared before the badge`);
  assert.ok(
    /#0b1f3a/.test(tones) && /#2a3a5c/.test(tones),
    `${CENTER}: the field is PhoenixSignatureCard's own navy — the band sitting directly above these badges`,
  );
  assert.ok(
    /#f47b20/.test(tones) && /#f9c06a/.test(tones),
    `${CENTER}: the company badge is struck in PHOENIX metal — the signature card's orange and warm gold`,
  );
  assert.ok(
    /#1482C2/.test(tones) && /#0A527D/.test(tones),
    `${CENTER}: the line badge is struck in SATO metal — the logo blues from house-identity.ts`,
  );
  assert.ok(
    /REP_HONOUR_PHOENIX/.test(badge) && /REP_HONOUR_SATO/.test(badge),
    `${CENTER}: one brand per board — Phoenix for the company, Sato for the line`,
  );
  assert.ok(
    !/slate-900|slate-800|amber-400|sky-400/.test(badge + tones),
    `${CENTER}: no generic palette colour on an honour — it is the two brands or nothing`,
  );
  // The award devices, pinned so a later tidy-up cannot flatten the badge back into a plain tile.
  assert.ok(
    /linear-gradient\(90deg/.test(tones),
    `${CENTER}: the top edge is a metal gradient with a highlight band, never a flat status rail`,
  );
  assert.ok(
    /bg-clip-text text-transparent/.test(tones),
    `${CENTER}: the rank numerals are struck in metal, not painted one flat colour`,
  );
  assert.ok(
    (badge.match(/border-l border-t|border-r border-t|border-b border-l|border-b border-r/g) ?? []).length === 4,
    `${CENTER}: four corner brackets — the certificate device, and four right angles by construction`,
  );
  assert.ok(
    />\s*Rank\s*<\/span>/.test(badge) && /sealOuter/.test(badge) && /sealInner/.test(badge),
    `${CENTER}: the double-ruled square seal holds the place — a square hallmark, never a round medal`,
  );
  assert.ok(
    badge.includes("COMPANY_RANK_BADGE_LIMIT") && badge.includes("LINE_RANK_BADGE_LIMIT"),
    `${CENTER}: the badge prints the limits from the module that enforces them, so the two cannot drift`,
  );
  assert.ok(
    badge.includes("You ranked") && badge.includes("medical reps"),
    `${CENTER}: the badge says what the owner asked for — "you ranked Nth of N medical reps"`,
  );
  assert.ok(
    /ordinal\(badge\.rank\)/.test(badge),
    `${CENTER}: a rank reads as an ordinal — "8th", not "8"`,
  );
  assert.ok(
    /standing\.windowLabel/.test(badge),
    `${CENTER}: every badge names the window it ranked — a rank with no period on it is a fact about nothing`,
  );
  // The payslip rule covers every landing surface, and this is a new element on one of them.
  assert.ok(
    !/netSalary|payslip/i.test(badge),
    `${CENTER}: no payslip on a landing surface, not even by accident on a new badge`,
  );
}
