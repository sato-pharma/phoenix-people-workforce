import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { linesToRelease, indexReleasedLines } from "../src/lib/daily-deductions/release-state.ts";
import {
  applyDailyDeductionViewFilters,
  categoryTotalsOfLines,
  DAILY_DEDUCTION_VIEW_FILTERS_OFF,
  isAnyDailyDeductionViewFilterOn,
  parseDailyDeductionViewFilters,
  readViewFilterFlag,
  writeDailyDeductionViewFilters,
} from "../src/lib/daily-deductions/view-filters.ts";

/**
 * THE DAILY DEDUCTIONS VIEW FILTERS (owner, 2026-11-17: "In daily deductions, make an option to exclude
 * fingerprint or filter by exclude fingerprint or filter by exclude head office employees").
 *
 * Pins: "Exclude fingerprint" hides the fingerprint connector's lines and nothing else; "Exclude Head
 * Office employees" hides the lines of the employees in the server's Head Office set and nothing else;
 * the two combine; both are off by default; an unreadable Head Office list hides NOTHING and says so;
 * the state round-trips through the address; and the workspace derives counts, ticks and releases from
 * the filtered list, so a bulk release can never carry a hidden line.
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

function line(category: string, hr: string, date = "2026-11-10", amount = 100): Line {
  return { category, employeeHrIdCompact: hr, employeeName: hr, deductionDate: date, daysCount: 1, amount, dates: [date] };
}

const HEAD_OFFICE = new Set(["b10", "of0002"]);

const LINES: Line[] = [
  line("fingerprint", "b10"), // Head Office, fingerprint
  line("fingerprint", "m22"), // field, fingerprint
  line("crm", "m22"), // field, CRM no-activity
  line("no_weekly_plan", "of0002"), // Head Office, no weekly plan
  line("unpaid_vacation", "m30"), // field, vacation
  line("no_records_activity", "b10"), // Head Office, no records
];

function keys(lines: readonly Line[]): string[] {
  return lines.map((entry) => `${entry.category}|${entry.employeeHrIdCompact}`);
}

export async function runDailyDeductionsViewFiltersTests(): Promise<void> {
  // ── off by default: everything shows ─────────────────────────────────────
  {
    const result = applyDailyDeductionViewFilters(LINES, DAILY_DEDUCTION_VIEW_FILTERS_OFF, HEAD_OFFICE);
    assert.equal(result.lines.length, LINES.length, "with both filters off every line shows");
    assert.equal(result.hidden.length, 0);
    assert.equal(result.headOfficeUnavailable, false);
    assert.deepEqual(parseDailyDeductionViewFilters(new URLSearchParams("")), DAILY_DEDUCTION_VIEW_FILTERS_OFF, "a plain address turns nothing on");
    assert.equal(isAnyDailyDeductionViewFilterOn(DAILY_DEDUCTION_VIEW_FILTERS_OFF), false);
  }

  // ── exclude fingerprint: only the fingerprint device's lines go ──────────
  {
    const result = applyDailyDeductionViewFilters(LINES, { excludeFingerprint: true, excludeHeadOffice: false, hideReleased: false }, HEAD_OFFICE);
    assert.deepEqual(
      keys(result.lines),
      ["crm|m22", "no_weekly_plan|of0002", "unpaid_vacation|m30", "no_records_activity|b10"],
      "CRM no-activity, no-weekly-plan, vacation and no-records all stay; only fingerprint lines are hidden",
    );
    assert.deepEqual(keys(result.hidden), ["fingerprint|b10", "fingerprint|m22"]);
  }

  // ── exclude Head Office: only Head Office employees' lines go ────────────
  {
    const result = applyDailyDeductionViewFilters(LINES, { excludeFingerprint: false, excludeHeadOffice: true, hideReleased: false }, HEAD_OFFICE);
    assert.deepEqual(
      keys(result.lines),
      ["fingerprint|m22", "crm|m22", "unpaid_vacation|m30"],
      "every line of a Head Office employee is hidden, whatever its type; field lines stay",
    );
    // The set is keyed the deductions' own way: a hyphenated, upper-case id still matches.
    const odd = applyDailyDeductionViewFilters([line("crm", "OF-0002")], { excludeFingerprint: false, excludeHeadOffice: true, hideReleased: false }, HEAD_OFFICE);
    assert.equal(odd.lines.length, 0, "OF-0002 and of0002 are the same Head Office employee");
  }

  // ── both together ────────────────────────────────────────────────────────
  {
    const result = applyDailyDeductionViewFilters(LINES, { excludeFingerprint: true, excludeHeadOffice: true, hideReleased: false }, HEAD_OFFICE);
    assert.deepEqual(keys(result.lines), ["crm|m22", "unpaid_vacation|m30"], "the two filters combine");
    assert.equal(result.lines.length + result.hidden.length, LINES.length, "nothing is lost — every line is shown or hidden");
  }

  // ── an unreadable Head Office list hides nothing and says so ─────────────
  {
    const result = applyDailyDeductionViewFilters(LINES, { excludeFingerprint: false, excludeHeadOffice: true, hideReleased: false }, null);
    assert.equal(result.headOfficeUnavailable, true, "the screen must be told the filter is not applied");
    assert.equal(result.lines.length, LINES.length, "a failed read never guesses who is Head Office");
    const both = applyDailyDeductionViewFilters(LINES, { excludeFingerprint: true, excludeHeadOffice: true, hideReleased: false }, null);
    assert.deepEqual(keys(both.hidden), ["fingerprint|b10", "fingerprint|m22"], "the fingerprint filter still works on its own");
  }

  // ── the address carries the state ────────────────────────────────────────
  {
    assert.equal(readViewFilterFlag("1"), true);
    assert.equal(readViewFilterFlag("true"), true);
    assert.equal(readViewFilterFlag(["1", "0"]), true, "a repeated parameter reads its first value");
    for (const off of [undefined, null, "", "0", "false", "no", "maybe"]) {
      assert.equal(readViewFilterFlag(off), false, `"${String(off)}" must not turn a filter on`);
    }
    assert.deepEqual(parseDailyDeductionViewFilters({ excludeFingerprint: "1", excludeHeadOffice: undefined }), {
      excludeFingerprint: true,
      excludeHeadOffice: false,
      hideReleased: false,
    });
    const written = writeDailyDeductionViewFilters("?tab=x&excludeHeadOffice=1", { excludeFingerprint: true, excludeHeadOffice: false, hideReleased: false });
    const params = new URLSearchParams(written);
    assert.equal(params.get("tab"), "x", "other parameters are kept");
    assert.equal(params.get("excludeFingerprint"), "1");
    assert.equal(params.has("excludeHeadOffice"), false, "an OFF filter is removed, not written as 0");
    assert.equal(writeDailyDeductionViewFilters("?excludeFingerprint=1", DAILY_DEDUCTION_VIEW_FILTERS_OFF), "", "all off is the plain address");
    const round = parseDailyDeductionViewFilters(new URLSearchParams(writeDailyDeductionViewFilters("", { excludeFingerprint: true, excludeHeadOffice: true, hideReleased: false })));
    assert.deepEqual(round, { excludeFingerprint: true, excludeHeadOffice: true, hideReleased: false }, "the address round-trips");
  }

  // ── a release sent from the filtered list never carries a hidden line ────
  {
    const filters = { excludeFingerprint: true, excludeHeadOffice: true, hideReleased: false };
    const shown = applyDailyDeductionViewFilters(LINES, filters, HEAD_OFFICE).lines;
    const releasable = linesToRelease(shown, indexReleasedLines([]), { from: "2026-11-01", to: "2026-11-16" });
    assert.ok(releasable.length > 0);
    for (const entry of releasable) {
      assert.notEqual(entry.category, "fingerprint", "no fingerprint line is released while it is hidden");
      assert.equal(HEAD_OFFICE.has(entry.employeeHrIdCompact), false, "no Head Office line is released while it is hidden");
    }
  }

  // ── the released type chips add up only what the filters leave ──────────
  {
    const released = [
      line("fingerprint", "b10", "2026-11-03", 2489.77),
      line("crm", "m22", "2026-11-04", 500),
      line("crm", "m22", "2026-11-05", 250.01),
      line("unpaid_vacation", "m30", "2026-11-06", 725.81),
    ];
    const shown = applyDailyDeductionViewFilters(released, { excludeFingerprint: true, excludeHeadOffice: false, hideReleased: false }, HEAD_OFFICE).lines;
    assert.deepEqual(
      categoryTotalsOfLines(shown),
      { crm: 750.01, unpaid_vacation: 725.81 },
      // 500 + 250.01 — the fingerprint line (2,489.77) is not in any chip
      "with Exclude fingerprint on, the fingerprint chip is gone and the others sum only the shown lines",
    );
    assert.deepEqual(categoryTotalsOfLines([]), {}, "nothing shown, no chips");
    const workspace = readFileSync(new URL("../src/components/admin/daily-deductions-workspace.tsx", import.meta.url), "utf8");
    assert.match(
      workspace,
      /filtersOn \? categoryTotalsOfLines\(shownReleasedLines\) : \(active\?\.categoryTotals \?\? \{\}\)/,
      "the chips read the filtered released lines while a filter is on",
    );
    assert.match(workspace, /<CategoryTotals totals=\{releasedCategoryTotals\} \/>/, "the chips render the filter-aware totals");
    assert.doesNotMatch(workspace, /<CategoryTotals totals=\{active\.categoryTotals\} \/>/, "never the whole snapshot's totals again");
  }

  // ── the workspace derives every figure, tick and release from the filtered list ──
  {
    const workspace = readFileSync(new URL("../src/components/admin/daily-deductions-workspace.tsx", import.meta.url), "utf8");
    assert.match(
      workspace,
      /const allLines = tallyScope\.lines;/,
      "allLines — what totals, ticks and Release ticked are computed from — must be the view-filtered list",
    );
    assert.match(workspace, /applyDailyDeductionViewFilters\(tallyLines, viewFilters, headOfficeSet, isTallyLineReleased\)/);
    assert.match(workspace, /applyDailyDeductionViewFilters\(releasedLines, viewFilters, headOfficeSet, \(\) => true\)/);
    // The folded released list (owner, 2026-11-28) also takes Withdraw all away — it never brings it back.
    assert.match(workspace, /canPublish && active && !filtersOn && releasedListOpen \?/, "Withdraw all (the whole snapshot) is off while a filter hides lines");
    assert.match(workspace, /writeDailyDeductionViewFilters\(window\.location\.search, next\)/, "the filter state is written to the address");
    const page = readFileSync(new URL("../app/(admin)/admin/daily-deductions/page.tsx", import.meta.url), "utf8");
    assert.match(page, /parseDailyDeductionViewFilters\(await searchParams\)/, "the page starts from the address's filters");
    assert.match(page, /loadHeadOfficeEmployeeCompacts\(\)/, "the Head Office set is read on the server");
    const headOffice = readFileSync(new URL("../src/lib/daily-deductions/head-office.ts", import.meta.url), "utf8");
    assert.match(headOffice, /isHeadOfficeRow\(\{ lineId: row\.lineId, lineName: row\.lineName \}\)/, "Head Office is the existing line rule, never a new definition");
  }
}
