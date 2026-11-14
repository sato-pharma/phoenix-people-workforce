import assert from "node:assert/strict";
import fs from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// ONE APPROVALS INTERFACE (enterprise audit REC-032, 14 Nov 2026). Every approval decision wears the
// same look and words — src/components/approvals-hub/approval-action-kit.tsx — wherever it is
// decided: the request pages (DecisionActions), the weekly-plan and manager-plan panels, the Action
// Center's inline row and the Expense Approvals queue. Before this the same Reject was a filled red
// rounded button in one place and a rose outline in the next.
// Expense Approvals keeps its batch save (owner, 14 Nov 2026): the row wears the look, and its
// decisions are still marked on screen and saved together.
// ─────────────────────────────────────────────────────────────────────────────

const KIT = "src/components/approvals-hub/approval-action-kit.tsx";
const read = (file: string) => fs.readFileSync(file, "utf8");

const SCREENS = [
  "src/components/approvals-hub/decision-actions.tsx",
  "src/components/approvals-hub/plan-decision-actions.tsx",
  "src/components/approvals-hub/manager-plan-decision-actions.tsx",
  "src/components/action-center/action-center-hub.tsx",
  "src/components/outstation/expense-review/review-queue-table.tsx",
];

export function runApprovalsOneInterfaceTests() {
  const kit = read(KIT);

  // The kit's own rules: square, the 44px floor, a filled action drops its lift when disabled, and a
  // table row is flat.
  assert.doesNotMatch(kit, /\brounded(?!-none)(-[a-z0-9]+)?\b/, "the approvals interface has no round corners");
  assert.match(kit, /regular: "h-11 /, "the regular size is the 44px touch floor");
  const lift = kit.match(/const LIFT = "([^"]*)";/)?.[1] ?? "";
  assert.ok(lift.includes("disabled:shadow-none"), "a filled action drops its lift when disabled");
  assert.match(kit, /size === "dense" \? approvalActionToneClassName\[tone\]\.replace\(` \$\{LIFT\}`, ""\)/, "the dense (table-row) size is flat");
  for (const tone of ["approve", "acknowledge", "return", "reject", "override", "overrideQuiet", "confirm", "neutral"]) {
    assert.match(kit, new RegExp(`\\n  ${tone}: [\`"]border `), `the "${tone}" tone is defined, square, with its border`);
  }
  assert.match(kit, /confirm: `border border-orange-500 bg-orange-500/, "the are-you-sure step is orange whatever the act — never a green Confirm reject");
  assert.match(kit, /approvalActionClassName\("confirm", "regular"/, "the confirm pair uses the confirm tone");

  // Every decision screen draws its actions from the kit, and none draws its own.
  for (const file of SCREENS) {
    const source = read(file);
    assert.match(source, /from "@\/components\/approvals-hub\/approval-action-kit"/, `${file} must use the one approvals interface`);
    assert.match(source, /approvalActionClassName\(|ApprovalResponsePanel|ApprovalConfirmButtons/, `${file} must draw its actions from the kit`);
    assert.doesNotMatch(source, /\bphxButton(Approve|Danger)ClassName\b/, `${file} must not draw its own approve or reject button`);
  }
  for (const file of SCREENS.slice(0, 3)) {
    assert.doesNotMatch(read(file), /adminPanelHeaderClassName/, `${file} must sit in the shared response panel, not a hand-built one`);
  }

  // The Action Center's decision row: no hand-coloured buttons and no round corners left in it.
  const hub = read("src/components/action-center/action-center-hub.tsx");
  const row = hub.slice(hub.indexOf("{/* Action buttons */}"), hub.indexOf("{marketingPrompt && ("));
  assert.ok(row.length > 1000, "the Action Center's decision row is found");
  assert.doesNotMatch(row, /\brounded\b|\brounded-/, "the Action Center's decision buttons are square");
  assert.doesNotMatch(row, /className="[^"]*\b(bg-emerald|bg-rose|bg-amber|bg-slate-700|bg-sky)/, "no decision button in the Action Center is hand-coloured");
  assert.match(hub, /function hubActionTone\(/, "leave and resignation actions take their tone from the kit");

  // Expense Approvals keeps its batch save: the row marks the decision on screen and never posts it.
  const queue = read("src/components/outstation/expense-review/review-queue-table.tsx");
  assert.match(queue, /className=\{approvalActionClassName\("approve", "dense"\)\}\s*data-quick-approve/, "the row's Approve wears the shared look");
  assert.match(queue, /onClick=\{\(\) => actions\.onQuickApprove\(record\)\}/, "the row's Approve still only marks the trip on screen");
  assert.doesNotMatch(queue, /\bfetch\(/, "the expense row saves nothing itself — Save commits the batch");
}
