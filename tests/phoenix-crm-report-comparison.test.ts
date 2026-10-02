import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  averagePerTerritory,
  delta,
  isComparisonMode,
  previousPeriod,
} from "../src/lib/phoenix-crm/report-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — reading a figure against something (C3 of the owner's plan).
 *
 * Three sections gain a comparison: visits, plan against actual, and coverage. Each figure keeps its
 * one column and gains a LINE under it.
 *
 * ## The four things that would be wrong quietly
 *
 *   1. **"The period before" is the same LENGTH of days, not the previous calendar month.** A manager
 *      reads the 1st to today; comparing eleven worked days against a whole thirty-day month shows
 *      every territory collapsing, every month, until he stops using the feature.
 *   2. **A rise from zero has no percentage.** `+100%` off a baseline of nothing is invented, and a
 *      board that shouts an invented number is a board nobody believes about the real ones.
 *   3. **Peer mode is an average, never a ranking.** It answers "is this territory behind the rest of
 *      my district" and refuses "who is worst" — no name, no rank, no "3rd of 12" leaves the module.
 *      A board that ranks named people is one the field force learns to game, and the owner has not
 *      asked for one.
 *   4. **The peer set is the viewer's WHOLE scope**, not the filtered view. Narrowing it to the chosen
 *      territory compares a territory with itself and answers +0% for ever.
 *
 * Plus the two rules the rest of the module already lives by: the headline figure is a COUNT in every
 * section (the difference between two percentages is percentage POINTS, which reads as a percent and
 * is not one), and it is manager-only in v1 — a rep shown "the average" is being shown his
 * colleagues' work in aggregate, the disclosure the place-vs-actual report withholds from him.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

export function runPhoenixCrmReportComparisonTests(): void {
  // ── 1. The period before is the same LENGTH of days ────────────────────────────────────────────
  {
    // A part-month, 1–11 September: eleven days, so the baseline is the eleven days before it.
    assert.deepEqual(
      previousPeriod({ from: "2026-09-01", to: "2026-09-11" }),
      { from: "2026-08-21", to: "2026-08-31" },
      "eleven days are read against the eleven days before them, NOT against the whole of August",
    );
    // A whole month still lands on the whole month before it, which is the case that makes the rule
    // look obvious — and is exactly why the part-month above is the one worth pinning.
    assert.deepEqual(previousPeriod({ from: "2026-09-01", to: "2026-09-30" }), { from: "2026-08-02", to: "2026-08-31" });
    // One day is read against the day before.
    assert.deepEqual(previousPeriod({ from: "2026-09-11", to: "2026-09-11" }), { from: "2026-09-10", to: "2026-09-10" });
    // Across a year boundary, where naive month arithmetic breaks.
    assert.deepEqual(previousPeriod({ from: "2026-01-01", to: "2026-01-05" }), { from: "2025-12-27", to: "2025-12-31" });
  }

  // ── 2. A rise from zero has NO percentage ──────────────────────────────────────────────────────
  {
    const fromNothing = delta(3, 0);
    assert.equal(fromNothing.change, 3, "the change itself is true and is kept");
    assert.equal(fromNothing.changePct, null, "🔴 but there is no percentage — +100% off nothing is invented");
    assert.equal(fromNothing.direction, "up");

    const ordinary = delta(214 * 1.12, 214);
    assert.equal(ordinary.changePct, 12, "an ordinary rise reads as one decimal");
    assert.equal(delta(180, 200).direction, "down");
    assert.equal(delta(200, 200).direction, "same");
    assert.equal(delta(200, 200).changePct, 0);

    // No baseline at all is not zero: it is "nothing to compare with", and every field says so.
    const none = delta(9, null);
    assert.deepEqual(none, { baseline: null, change: null, changePct: null, direction: "same" });

    // A fall to nothing still has a percentage, because the BASELINE is what divides.
    assert.equal(delta(0, 8).changePct, -100);
  }

  // ── 3. The average spans every territory, including the empty ones ─────────────────────────────
  {
    assert.equal(averagePerTerritory(120, 12), 10);
    assert.equal(
      averagePerTerritory(120, 15),
      8,
      "three territories with nothing still divide the total — dropping them would flatter the district and make every working rep look average",
    );
    assert.equal(averagePerTerritory(0, 12), 0, "a district that did nothing averages zero, which is a real answer");
    assert.equal(averagePerTerritory(120, 0), null, "no territories has no average at all — null, never 0");
    assert.equal(averagePerTerritory(10, 3), 3.3, "one decimal");
  }

  // ── 4. The mode is a closed set ────────────────────────────────────────────────────────────────
  {
    for (const mode of ["off", "previous", "peers"]) assert.equal(isComparisonMode(mode), true, `${mode} is a mode`);
    for (const junk of ["rank", "league", "", null, undefined, 1, "PEERS"]) {
      assert.equal(isComparisonMode(junk), false, `${String(junk)} is not a mode — an unknown value must read as off, never as something`);
    }
  }

  // ── 5. Peer mode is an average and NEVER a ranking ─────────────────────────────────────────────
  //
  // 🔴 The whole shape of the feature. Nothing in the module may carry a name, a rank or a position
  // out of N: those turn a manager's read into a scoreboard the field force learns to game.
  {
    const service = source("src/lib/phoenix-crm/server/reports.ts");
    const rules = source("src/lib/phoenix-crm/report-rules.ts");
    const screen = source("src/components/phoenix-crm/reports-tab.tsx");
    const comparisonPart = service.slice(service.indexOf("function buildComparison"), service.indexOf("export function peerTerritories"));
    for (const banned of [/\brank\b/i, /\bleague\b/i, /\bbest\b/i, /\bworst\b/i, /\bposition\b/i, /\bout of \$\{/]) {
      assert.equal(banned.test(comparisonPart), false, `the comparison must not compute ${banned} — it is an average, not an ordering`);
    }
    assert.ok(rules.includes("export function averagePerTerritory"), "the average is the one peer figure");
    // Every seat gets the SAME baseline in peer mode. That is what stops the board becoming a ladder.
    assert.match(
      comparisonPart,
      /const am = averagePerTerritory\(baseline\.totals\.AM, count\);[\s\S]*bySeat: input\.seatIds\.map\(\(seatId\) => \(\{[\s\S]*am: delta\(now\.bySeat\.get\(seatId\)\?\.am \?\? 0, am\)/,
      "in peer mode every territory is read against the SAME district average",
    );
    assert.equal(
      /sort\([^)]*comparison|comparison[^;]*\.sort\(/.test(screen),
      false,
      "the screen must never re-order rows by their comparison — that is a ranking by another route",
    );
  }

  // ── 6. The peer set is the viewer's WHOLE scope, not the filtered view ─────────────────────────
  {
    const service = source("src/lib/phoenix-crm/server/reports.ts");
    assert.match(
      service,
      /export function peerTerritories\(viewer: PhoenixCrmViewer\): OrgSeat\[\] \{\s*return viewer\.scopeTerritories;\s*\}/,
      "the peer set is the whole scope — narrowing it to the filter would compare a territory with itself and answer +0% for ever",
    );
    // And it is what the three loaders actually pass for the peer baseline.
    assert.equal(
      (service.match(/const peers = peerTerritories\(viewer\);/g) ?? []).length,
      3,
      "all three comparable sections resolve the peer set the same way",
    );
    for (const call of ["visitFigures(peers.map", "planFigures(peers.map", "coverageFigures(peers.map"]) {
      assert.ok(service.includes(call), `${call} measures the baseline over the peer set, not the chosen seats`);
    }
  }

  // ── 7. The headline figure is a COUNT in every section ─────────────────────────────────────────
  //
  // The difference between two percentages is percentage POINTS. A cell reading "68% (vs 61% ·
  // +11.5%)" has three numbers in it of which one is not what it says it is.
  {
    const service = source("src/lib/phoenix-crm/server/reports.ts");

    /**
     * The `now:` block each loader hands to buildComparison — the figure the comparison ACTUALLY
     * reads, not merely one that appears somewhere in the file.
     *
     * Anchored rather than searched: the same count is also computed inside the `*Figures` helper for
     * the baseline, so a plain `includes` stayed green while the comparison itself had been switched
     * to a percentage. That false pass was caught by breaking it on 2026-09-27.
     */
    const nowBlocks = [...service.matchAll(/now: \{[\s\S]*?\n            \},/g)].map((match) => match[0]);
    assert.equal(nowBlocks.length, 2, `plan and coverage hand buildComparison an inline now block — found ${nowBlocks.length}`);
    // The visits report has returned through its blind shaper since 2026-10-02 (Golden Rule #1), so
    // its return opens with `blindVisitsReport(viewer, {`. Asserted, because a missing anchor makes
    // `slice` run to the END of the file, which is how this check read the wrong text that day.
    const visitsStart = service.indexOf("const nowFigures: ComparisonFigures");
    const visitsEnd = service.indexOf("return blindVisitsReport(viewer, {\n    period,\n    includeTest: chosen.includeTest,\n    rows,\n    totals,");
    assert.ok(visitsStart !== -1 && visitsEnd > visitsStart, "the visits report's comparison block is found between its figures and its return");
    const visitsNow = service.slice(visitsStart, visitsEnd);
    assert.ok(visitsNow.includes("totals: { AM: totals.AM.visits, PM: totals.PM.visits }"), "visits compares the visit COUNT");
    assert.ok(
      nowBlocks.some((block) => block.includes("totals: { AM: totals.AM.visitedPlanned, PM: totals.PM.visitedPlanned }")),
      "plan compares planned calls KEPT — a count, never the kept percentage",
    );
    assert.ok(
      nowBlocks.some((block) => block.includes("totals: { AM: totals.AM.covered, PM: totals.PM.covered }")),
      "coverage compares customers COVERED — a count, never the coverage percentage",
    );
    for (const block of [visitsNow, ...nowBlocks]) {
      assert.equal(/Pct\b/.test(block), false, "no percentage reaches a comparison — the difference between two of them is points, not a percent");
    }
    assert.equal(
      /delta\([^)]*Pct/.test(service),
      false,
      "and none is handed to delta() by another route either",
    );
  }

  // ── 8. Manager-only in v1, refused in the SERVICE and not by hiding the control ────────────────
  {
    const service = source("src/lib/phoenix-crm/server/reports.ts");
    assert.match(
      service,
      /function comparisonModeOf\([\s\S]*?if \(!readsTeamReports\(viewer\)\) return null;/,
      "a viewer who does not read team reports gets no comparison, whatever the URL says",
    );
    const screen = source("src/components/phoenix-crm/reports-tab.tsx");
    assert.ok(
      screen.includes("view.canSeeLocations && COMPARABLE_SECTIONS.includes(activeSection)"),
      "the control is hidden from a rep too — but that is UX, and the line above is the boundary",
    );
  }

  // ── 9. A second LINE, never a second column ────────────────────────────────────────────────────
  //
  // The fits-the-screen rule: a comparison column on every figure would double three tables that
  // already fill a desktop, and on a phone it is the horizontal scroll the rule bans outright.
  {
    const screen = source("src/components/phoenix-crm/reports-tab.tsx");
    assert.ok(screen.includes("function DeltaLine("), "the comparison renders as a line inside the cell");
    assert.match(screen, /<DeltaLine value=\{change\} \/>/, "and the cells draw it");
    // The three sections' column lists are untouched by the comparison: no header mentions it.
    for (const header of [/headers=\{\[[^\]]*vs /i, /headers=\{\[[^\]]*Change/i, /headers=\{\[[^\]]*Compar/i]) {
      assert.equal(header.test(screen), false, `no table gains a comparison COLUMN (${header})`);
    }
    // A missing baseline draws nothing at all, rather than an empty line that shifts every row.
    assert.match(
      screen,
      /if \(!value \|\| value\.baseline === null \|\| value\.change === null\) return null;/,
      "with nothing to compare against the line is absent, not blank",
    );
  }

  // ── 10. `off` is left out of the URL, and an unknown value reads as off ────────────────────────
  {
    const screen = source("src/components/phoenix-crm/reports-tab.tsx");
    assert.match(
      screen,
      /compare !== "off" \? compare : null/,
      "the default is not sent — a URL that carries every default is a URL nobody can read",
    );
    const service = source("src/lib/phoenix-crm/server/reports.ts");
    assert.match(
      service,
      /const mode = isComparisonMode\(raw\.compare\) \? raw\.compare : "off";/,
      "an unrecognised compare value falls back to off rather than throwing at a manager mid-read",
    );
  }

  console.log("phoenix-crm report comparison: OK");
}
