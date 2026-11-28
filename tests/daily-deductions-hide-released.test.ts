import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { indexReleasedLines, linesToRelease, releaseStateOf } from "../src/lib/daily-deductions/release-state.ts";
import {
  applyDailyDeductionViewFilters,
  DAILY_DEDUCTION_VIEW_FILTERS_OFF,
  isAnyDailyDeductionViewFilterOn,
  parseDailyDeductionViewFilters,
  writeDailyDeductionViewFilters,
  type DailyDeductionViewFilters,
} from "../src/lib/daily-deductions/view-filters.ts";

/**
 * "HIDE RELEASED" ON DAILY DEDUCTIONS (owner, 2026-11-28: "In daily deductions, make a toggle. When I
 * press this toggle, hide the released.").
 *
 * Pins: with the toggle ON every tally line whose release state is `released` is hidden — a `changed`
 * line (still needing a decision) and a `not_released` one stay; every row of the released snapshot is
 * hidden; with it OFF every line shows; the input list and its lines are never changed; it starts OFF
 * and round-trips through the address; and the workspace renders the toggle and feeds the filter its
 * release state, so a bulk release can never carry a hidden line.
 */

type Line = {
  category: string;
  employeeHrIdCompact: string;
  employeeName: string;
  deductionDate: string;
  daysCount: number;
  amount: number;
  dates: string[];
};

function line(category: string, hr: string, date: string, amount: number): Line {
  return { category, employeeHrIdCompact: hr, employeeName: hr, deductionDate: date, daysCount: 1, amount, dates: [date] };
}

// What is already out: m22's CRM day at 500 (unchanged), m30's vacation day at 300 (the tally now says 350).
const SNAPSHOT: Line[] = [line("crm", "m22", "2026-11-10", 500), line("unpaid_vacation", "m30", "2026-11-11", 300)];

const TALLY: Line[] = [
  line("crm", "m22", "2026-11-10", 500), // released, same figures → hidden when ON
  line("crm", "m22", "2026-11-12", 500), // not released → stays
  line("unpaid_vacation", "m30", "2026-11-11", 350), // changed since release → stays
  line("fingerprint", "b10", "2026-11-10", 120), // not released → stays
];

const ON: DailyDeductionViewFilters = { ...DAILY_DEDUCTION_VIEW_FILTERS_OFF, hideReleased: true };

function keys(lines: readonly Line[]): string[] {
  return lines.map((entry) => `${entry.category}|${entry.employeeHrIdCompact}|${entry.deductionDate}`);
}

export async function runDailyDeductionsHideReleasedTests(): Promise<void> {
  const index = indexReleasedLines(SNAPSHOT);
  const isReleased = (entry: Line) => releaseStateOf(entry, index) === "released";

  // Sanity: the fixture really has one line in each state.
  assert.deepEqual(
    TALLY.map((entry) => releaseStateOf(entry, index)),
    ["released", "not_released", "changed", "not_released"],
  );

  // ── ON: released tally lines are hidden, nothing else ────────────────────
  {
    const before = JSON.stringify(TALLY);
    const result = applyDailyDeductionViewFilters(TALLY, ON, null, isReleased);
    assert.deepEqual(
      keys(result.lines),
      ["crm|m22|2026-11-12", "unpaid_vacation|m30|2026-11-11", "fingerprint|b10|2026-11-10"],
      "with Hide released ON only the lines already released at these figures are hidden",
    );
    assert.deepEqual(keys(result.hidden), ["crm|m22|2026-11-10"], "the hidden list names what was hidden");
    assert.equal(result.lines.length + result.hidden.length, TALLY.length, "every line is shown or hidden, none lost");
    assert.equal(JSON.stringify(TALLY), before, "the input list and its lines are left unchanged");
    assert.equal(result.headOfficeUnavailable, false, "Hide released never trips the Head Office notice");
  }

  // ── ON: the released snapshot hides whole ────────────────────────────────
  {
    const result = applyDailyDeductionViewFilters(SNAPSHOT, ON, null, () => true);
    assert.equal(result.lines.length, 0, "every released row is hidden while the toggle is ON");
    assert.equal(result.hidden.length, SNAPSHOT.length);
  }

  // ── OFF: every line shows ────────────────────────────────────────────────
  {
    const result = applyDailyDeductionViewFilters(TALLY, DAILY_DEDUCTION_VIEW_FILTERS_OFF, null, isReleased);
    assert.deepEqual(keys(result.lines), keys(TALLY), "with Hide released OFF every line shows, in its order");
    assert.equal(result.hidden.length, 0);
    const snapshot = applyDailyDeductionViewFilters(SNAPSHOT, DAILY_DEDUCTION_VIEW_FILTERS_OFF, null, () => true);
    assert.equal(snapshot.lines.length, SNAPSHOT.length, "the released snapshot shows whole while OFF");
    // With no release answer handed in, the toggle cannot guess — it hides nothing.
    assert.equal(applyDailyDeductionViewFilters(TALLY, ON, null).lines.length, TALLY.length);
  }

  // ── a release sent from the filtered list never carries a hidden line ────
  {
    const shown = applyDailyDeductionViewFilters(TALLY, ON, null, isReleased).lines;
    for (const entry of linesToRelease(shown, index, { from: "2026-11-01", to: "2026-11-16" })) {
      assert.notEqual(releaseStateOf(entry, index), "released", "no hidden released line rides along in a release");
    }
  }

  // ── starts OFF, lives in the address ─────────────────────────────────────
  {
    assert.equal(DAILY_DEDUCTION_VIEW_FILTERS_OFF.hideReleased, false, "the toggle starts OFF");
    assert.equal(parseDailyDeductionViewFilters(new URLSearchParams("")).hideReleased, false);
    assert.equal(isAnyDailyDeductionViewFilterOn(ON), true, "Hide released counts as a filter that is on");
    const written = writeDailyDeductionViewFilters("?tab=x", ON);
    assert.equal(new URLSearchParams(written).get("hideReleased"), "1");
    assert.deepEqual(parseDailyDeductionViewFilters(new URLSearchParams(written)), ON, "the address round-trips");
    assert.equal(writeDailyDeductionViewFilters("?hideReleased=1", DAILY_DEDUCTION_VIEW_FILTERS_OFF), "", "OFF is removed from the address");
  }

  // ── the workspace renders the toggle and feeds it the release state ──────
  {
    const workspace = readFileSync(new URL("../src/components/admin/daily-deductions-workspace.tsx", import.meta.url), "utf8");
    assert.match(workspace, />Hide released</, "the View strip carries a toggle labelled Hide released");
    assert.match(workspace, /onChange\("hideReleased", next\)/);
    assert.match(workspace, /releaseStateOf\(line, releasedIndex\) === "released"/, "only the released state hides — changed stays");
    assert.match(workspace, /applyDailyDeductionViewFilters\(tallyLines, viewFilters, headOfficeSet, isTallyLineReleased\)/);
    assert.match(workspace, /applyDailyDeductionViewFilters\(tallyLines, next, headOfficeSet, isTallyLineReleased\)/, "a tick on a newly hidden line is dropped");
    assert.match(workspace, /applyDailyDeductionViewFilters\(releasedLines, viewFilters, headOfficeSet, \(\) => true\)/);
  }
}
