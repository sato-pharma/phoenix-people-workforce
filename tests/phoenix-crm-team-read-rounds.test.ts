import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * The Team read's rounds (owner, 23 Nov 2026: "Speed up Team").
 *
 * The Field CRM board opens on Team, and for the Super Admin (111 territories) its read waited through eight
 * rounds of the edge one after another: the day's far-visit holds, then today's plans and visits, then their
 * items; then the off-plan visits' extras, after EVERY first read; then the requests' Place-checks holds, then
 * their same-name matches. Each round is ~250-600 ms whatever its SQL costs. Most of them needed only one
 * read's rows, so each now starts the moment those rows arrive:
 *
 *   1. Today's far-visit holds ride beside each batch's plans and visits, not a round before them.
 *   2. The off-plan extras (moved-from days, the allowance standing, the named exceptions) start on the
 *      off-plan rows alone, inside the first wave.
 *   3. The requests' two marks start on the request rows alone, inside the first wave, and run together.
 *   4. The cards are built by one function from the same rows, and take their marks by request id — so the
 *      marks are exactly what the sequential reads produced.
 */

const code = (path: string) => stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.slice(start + 1).search(/\n(?:export )?(?:async )?function |\nconst [A-Z_]+ /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

export function runPhoenixCrmTeamReadRoundsTests(): void {
  const team = code("src/lib/phoenix-crm/server/team.ts");

  // ── 1. Today's far-visit holds ──────────────────────────────────────────────────────────────────
  {
    const today = functionBody(team, "loadTeamToday");
    assert.doesNotMatch(today, /await loadUncountedFarVisitHolds\(/, "the holds are not a round of their own");
    assert.match(today, /const \[plans, dayVisits, farHolds\] = await Promise\.all\(\[[\s\S]*?farHoldsRead,\s*\]\);/, "they ride beside the batch's reads");
  }

  const view = functionBody(team, "loadTeamView");
  const firstWave = /\] = await Promise\.all\(\[([\s\S]*?)\n {4}\]\);/.exec(view)?.[1] ?? "";
  assert.ok(firstWave.length > 0, "the Team read opens with one wave");

  // ── 2. The off-plan extras ──────────────────────────────────────────────────────────────────────
  {
    assert.match(
      firstWave,
      /unplannedRowsRead\.then\(\(unplannedRows\) =>\s*Promise\.all\(\[\s*loadMovedFromDays\([\s\S]*?loadWaitingOffPlanStandings\([\s\S]*?loadExemptVisitIds\(/,
      "they start on the off-plan rows, inside the first wave",
    );
    assert.equal((view.match(/loadMovedFromDays\(/g) ?? []).length, 1, "and are read once");
  }

  // ── 3. The requests' marks ──────────────────────────────────────────────────────────────────────
  {
    assert.match(firstWave, /requestRowsRead\.then\(\(rows\) =>\s*loadTeamRequestMarks\(/, "they start on the request rows, inside the first wave");
    assert.doesNotMatch(view, /await withPlaceCheckHolds\(|await withSameNameMatches\(/, "neither waits for the other or for the names");
    const marks = functionBody(team, "loadTeamRequestMarks");
    assert.match(
      marks,
      /await Promise\.all\(\[\s*withPlaceCheckHolds\(viewer, isTest, drafts\),\s*withSameNameMatches\(viewer, isTest, \(request\) => request\.seatId, drafts\),\s*\]\)/,
      "the two run together",
    );
    assert.match(marks, /placeCheckHold: request\.placeCheckHold, sameNameOnSeat: matched\[index\]\.sameNameOnSeat/, "each keeps its own mark");
  }

  // ── 4. The cards ────────────────────────────────────────────────────────────────────────────────
  {
    assert.match(view, /teamRequestOf\(viewer, isTest, seatsById, row, NO_NAMES, "Territory"\)/, "the marks are asked of the same cards, unnamed");
    assert.match(view, /teamRequestOf\(viewer, isTest, seatsById, row, names, /, "and the cards shown are built by the same function");
    assert.match(view, /return \{ \.\.\.request, \.\.\.requestMarks\.get\(request\.requestId\) \};/, "each takes its marks by request id");
  }
}
