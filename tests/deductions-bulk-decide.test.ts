// The Deductions workspace lets a reviewer tick several candidates (or all) and decide them at once.
//
// Owner request 2026-10-09: "in /admin/deductions make me have the options to multiple select or
// select all and decide". Deciding one candidate at a time was the only way to clear a month of
// hundreds.
//
// WHAT MUST STAY TRUE. A bulk decision is the single-row decision repeated, never a second code path
// with its own rules: it posts to the existing decisions route one candidate per request, so the
// permission check, the reason requirement, the locked-line refusal and the payroll resync all apply
// to every row. It must never send an amount (the server derives it) or days (a reviewer's saved day
// selection is not blanked), it must confirm before it writes, and a pushed — locked — line can never
// be ticked.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACE = "src/components/admin/deductions-workspace.tsx";

export function runDeductionsBulkDecideTests() {
  const source = readFileSync(path.join(ROOT, WORKSPACE), "utf8");

  const barStart = source.indexOf("function BulkDecideBar(");
  const barEnd = source.indexOf("function eligibleForPush(");
  assert.ok(barStart > 0 && barEnd > barStart, `${WORKSPACE}: BulkDecideBar is gone — the multi-select decision no longer exists.`);
  const bar = source.slice(barStart, barEnd);

  assert.ok(
    bar.includes('"/api/admin/deductions/decisions"'),
    `${WORKSPACE}: the bulk bar no longer posts to the single-decision route, so it would need rules of its own.`,
  );
  const body = /body:\s*JSON\.stringify\(\{([^}]*)\}\)/.exec(bar);
  assert.ok(body, `${WORKSPACE}: could not find the bulk request body.`);
  assert.ok(
    /candidateId:\s*row\.id/.test(body[1]) && /decisionStatus:\s*status/.test(body[1]),
    `${WORKSPACE}: the bulk request must carry one candidateId and the chosen decisionStatus.`,
  );
  assert.ok(
    !/appliedValue|appliedDates|appliedAmount/.test(body[1]),
    `${WORKSPACE}: the bulk request sends a figure or days. recordDecision leaves an absent field as it is; sending one would blank a reviewer's saved day selection or set an amount.`,
  );
  assert.ok(
    /pendingStatus/.test(bar) && /Confirm/.test(bar),
    `${WORKSPACE}: the bulk bar writes without a confirmation step. A decision over many rows moves payroll, so it must say how many and how much first.`,
  );
  assert.ok(
    /succeeded\.push/.test(bar) && /onFinished\(succeeded\)/.test(bar),
    `${WORKSPACE}: only the rows that succeeded may be un-ticked, so a failed row stays selected for a retry.`,
  );

  const tabStart = source.indexOf("function CategoryTab(");
  const tab = source.slice(tabStart, source.indexOf("function PublicationPanel(", tabStart));
  // Open-ended on purpose: more exclusions may join this filter (a leave-balance charge did on
  // 2026-10-09), but `!row.pushedLineId` must stay the first of them.
  assert.ok(
    /selectableRows\s*=\s*canDecide \? rows\.filter\(\(row\) => !row\.pushedLineId\b/.test(tab),
    `${WORKSPACE}: the selectable rows are no longer limited to unpushed ones. A pushed line is locked and the server refuses a decision on it.`,
  );
  assert.ok(
    /selectableRows\s*=\s*canDecide \? rows\.filter\(\(row\) =>[^)]*!row\.leaveBalanceCharge/.test(tab),
    `${WORKSPACE}: a row already charged to the employee's annual leave balance is selectable again. recordDecision refuses it until "Return to salary" is pressed, so a bulk decide over it fails the whole tick.`,
  );
  assert.ok(
    /Select all \(/.test(tab) && /Select pending only/.test(tab),
    `${WORKSPACE}: the select-all controls are gone from the category tab.`,
  );
  assert.ok(
    /<TableRowDetail colSpan=\{canDecide \? 7 : 6\}/.test(tab),
    `${WORKSPACE}: the day editor is no longer a TableRowDetail spanning every column of the table (7 with the checkbox and Action merged into Status, 6 without).`,
  );
  assert.ok(
    (tab.match(/type="checkbox"/g) ?? []).length >= 4,
    `${WORKSPACE}: a row checkbox is missing from the table, the mobile card, the header or the toolbar.`,
  );
}
