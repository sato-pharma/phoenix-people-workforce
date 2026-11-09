import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// Expense Approvals' "Waiting for your decision" list opens and closes trip by trip (owner, 2026-11-09:
// "MAKE THIS COLLAPSABLE AND EXPANDABLE: I EXPAND, THE DETAILS AND PICS APPEAR; I COLLAPSE, COLLAPSED").
//
// Pinned: every row starts collapsed; the details and the photos exist only under an open row (so a
// list of 86 fetches no photos); the toggle is a native button with aria-expanded and aria-controls;
// "Expand all / Collapse all" sits in the heading; and collapsing cannot touch a decision — the open
// set is screen state of its own, and the details panel is handed no setter of any kind.

export function runOutstationExpenseApprovalsCollapsibleRowsTests() {
  const dir = "src/components/outstation/expense-review";
  const table = stripComments(readFileSync(`${dir}/review-queue-table.tsx`, "utf8"));
  const details = stripComments(readFileSync(`${dir}/review-row-details.tsx`, "utf8"));

  // ── 1. Collapsed by default ─────────────────────────────────────────────────────────────────
  assert.match(
    table,
    /const \[expanded, setExpanded\] = useState<ReadonlySet<string>>\(\(\) => new Set\(\)\);/,
    "HEADLINE: every trip in the list starts collapsed — the open set starts empty",
  );
  const openRead = /const open = actions\.expanded\.has\(record\.tripId\);/g;
  assert.equal(table.match(openRead)?.length, 2, "the desktop row and the phone card both read the same open set");

  // ── 2. The details and photos appear only once a trip is expanded ───────────────────────────
  const mounts = table.match(/\{open \? \([\s\S]*?<ReviewRowDetails [^>]*\/>[\s\S]*?\) : null\}/g) ?? [];
  assert.equal(mounts.length, 2, "HEADLINE: the details panel is mounted only under an open row, desktop and phone");
  assert.equal(table.match(/<ReviewRowDetails /g)?.length, 2, "and nowhere else in the list — a collapsed row renders no details");
  assert.match(details, /<TripAttachments tripId=\{record\.tripId\} \/>/, "an expanded trip shows its photos, stops and tickets");
  assert.match(details, /<DeckSubject /, "an expanded trip shows every fact of the claim");
  assert.match(details, /<EmployeeNote note=\{record\.employeeNote\} wide \/>/, "an expanded trip shows the employee's own words");
  assert.doesNotMatch(table, /TripAttachments|employeeNote/, "a collapsed row shows no photos and no note — they live only in the details panel");

  // ── 3. The toggle: a native button, keyboard-reachable, announced ────────────────────────────
  assert.match(details, /<button\s+\{\.\.\.rowDetailToggleProps\(rowDetailsId\(tripId\), expanded\)\}[\s\S]*?type="button"/, "HEADLINE: the toggle is a native button carrying aria-expanded and aria-controls (rowDetailToggleProps)");
  assert.match(details, /id=\{rowDetailsId\(record\.tripId\)\}/, "aria-controls names the panel it opens");
  assert.equal(table.match(/<RowExpandToggle expanded=\{open\} onToggle=\{\(\) => actions\.onExpand\(record\.tripId\)\}/g)?.length, 2, "every row and every card carries the toggle");
  assert.match(table, /\{allPageExpanded \? "Collapse all" : "Expand all"\}/, "HEADLINE: Expand all / Collapse all sits beside the heading");
  assert.match(table, /setExpanded\(allPageExpanded \? new Set\(\) : new Set\(page\.map\(\(record\) => record\.tripId\)\)\)/, "Expand all opens the trips on screen; Collapse all closes every one");

  // ── 4. Collapsing never touches a decision ──────────────────────────────────────────────────
  const onExpand = table.match(/const onExpand = \(tripId: string\) =>[\s\S]*?\n {4}\}\);/)?.[0] ?? "";
  assert.ok(onExpand.length > 0, "the per-row toggle handler is found");
  assert.doesNotMatch(onExpand, /decision|Decision|setDecision|undo|select/i, "HEADLINE: opening or closing a row only changes the open set — never a decision, an amount or a tick");
  const expandAll = table.match(/const expandOrCollapseAll = [^\n]*/)?.[0] ?? "";
  assert.ok(expandAll.length > 0 && !/decision|undo|select/i.test(expandAll), "Expand all / Collapse all changes only the open set");
  // The panel is handed values, never a handler: it cannot write a decision even by mistake.
  const props = details.match(/export function ReviewRowDetails\(\{([^}]*)\}/)?.[1] ?? "";
  assert.equal(props.replace(/\s+/g, ""), "decision,duplicateOf,record,unsaved", "the details panel takes the decision to SHOW it, and no setter");
  assert.doesNotMatch(details, /onChange|onApprove|onReject|onUndo|setDecision|fetch\(/, "the details panel writes and reads nothing of its own");

  // ── 5. The house look: square, flat, wraps ──────────────────────────────────────────────────
  for (const [name, source] of [["review-row-details.tsx", details], ["review-queue-table.tsx", table]] as const) {
    assert.doesNotMatch(source, /\brounded(?!-none)(-[a-z0-9]+)?\b/, `${name}: no round corners`);
    assert.doesNotMatch(source, /\bshadow-|\bbg-gradient|\btruncate\b|\bline-clamp/, `${name}: no shadow, gradient or ellipsis`);
  }
}
