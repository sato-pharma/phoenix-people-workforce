import assert from "node:assert/strict";
import fs from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// ONE APPROVALS INTERFACE (enterprise audit REC-032, 14 Nov 2026). Every approval decision wears the
// same look and words — src/components/approvals-hub/approval-action-kit.tsx — wherever it is
// decided: the request pages (DecisionActions), the weekly-plan and manager-plan panels, the Action
// Center's inline row and the Expense Approvals queue. Before this the same Reject was a filled red
// rounded button in one place and a rose outline in the next.
// Expense Approvals kept its batch save on 14 Nov 2026; the owner lifted that on 23 Nov 2026 ("Save
// at once, with Undo") when the page was rebuilt. Its decisions now wear the look AND save by
// themselves: a press goes to the page, waits six seconds of Undo, and is sent (use-desk.ts).
// ─────────────────────────────────────────────────────────────────────────────

const KIT = "src/components/approvals-hub/approval-action-kit.tsx";
const read = (file: string) => fs.readFileSync(file, "utf8");

const SCREENS = [
  "src/components/approvals-hub/decision-actions.tsx",
  "src/components/approvals-hub/plan-decision-actions.tsx",
  "src/components/approvals-hub/manager-plan-decision-actions.tsx",
  "src/components/action-center/action-center-hub.tsx",
  "src/components/outstation/approvals-desk/desk-decision.tsx",
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

  // Expense Approvals: the decision is drawn ONCE (desk-decision.tsx) and used by the list row, the
  // phone card and the reviewer. It wears the shared look, and a press is handed to the page — the
  // buttons themselves never post.
  const decision = read("src/components/outstation/approvals-desk/desk-decision.tsx");
  assert.match(decision, /className=\{approvalActionClassName\("approve", size\)\}\s*data-press="approve"/, "the row's Approve wears the shared look");
  assert.ok(decision.includes('className={approvalActionClassName("reject", size)} data-press="reject"'), "and so does Reject");
  assert.ok(decision.includes("onClick={() => onPress([approvePress(claim)], [claim])}"), "Approve is one press, handed to the page");
  assert.ok(!decision.includes("fetch("), "the buttons save nothing themselves: the page sends the press after its Undo window");
  for (const screen of ["desk-row.tsx", "desk-trip-file.tsx"]) {
    const source = read(`src/components/outstation/approvals-desk/${screen}`);
    assert.ok(source.includes("<DecisionButtons "), `${screen} draws the one decision`);
    assert.ok(
      !source.includes('approvalActionClassName("approve"') && !source.includes('approvalActionClassName("reject"'),
      `${screen} never draws an Approve or Reject of its own`,
    );
  }
  const hookFile = read("src/components/outstation/approvals-desk/use-desk.ts");
  assert.ok(hookFile.includes("const next = addPress(pressesRef.current, { claims, decisions, now: Date.now() });"), "a press joins the Undo queue");
  assert.ok(hookFile.includes("body: JSON.stringify(pressBody(press)),"), "and is sent by itself when the window ends: there is no Save button");
}
