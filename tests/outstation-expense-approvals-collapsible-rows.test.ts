import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULT_DESK_VIEW, deskViewFromSearch, deskViewToSearch } from "../src/lib/outstation/approvals/desk-view.ts";

import { stripComments } from "./support/comment-strip.ts";

// Expense Approvals' waiting list opens and closes trip by trip (owner, 2026-11-09: "MAKE THIS
// COLLAPSABLE AND EXPANDABLE: I EXPAND, THE DETAILS AND PICS APPEAR; I COLLAPSE, COLLAPSED").
//
// Rebuilt 2026-11-23 (approvals-desk/; owner: "REBUILD FROM SCRATCH"). The details panel under a row
// and the one-by-one reviewer were two ways to read one trip; they are now ONE — a row's Open (or
// the employee's name) opens the whole trip on one scroll, and Close or Escape puts it away. What
// his 9 Nov rule protects is unchanged and pinned here: every trip starts closed; the details and
// the photos exist only for the trip that is open (so a list of 86 fetches no photos); the opener
// is a native button; and opening or closing a trip cannot touch a decision.
//
// "Expand all / Collapse all" is retired with the panel it drove: a trip is the whole screen now,
// so only one can be open.

export function runOutstationExpenseApprovalsCollapsibleRowsTests() {
  const dir = "src/components/outstation/approvals-desk";
  const row = stripComments(readFileSync(`${dir}/desk-row.tsx`, "utf8"));
  const decision = stripComments(readFileSync(`${dir}/desk-decision.tsx`, "utf8"));
  const workspace = stripComments(readFileSync(`${dir}/desk-workspace.tsx`, "utf8"));
  const reviewer = stripComments(readFileSync(`${dir}/desk-reviewer.tsx`, "utf8"));
  const tripFile = stripComments(readFileSync(`${dir}/desk-trip-file.tsx`, "utf8"));

  // ── 1. Closed by default ────────────────────────────────────────────────────────────────
  assert.equal(DEFAULT_DESK_VIEW.trip, null, "HEADLINE: every trip in the list starts closed — the page opens with no trip open");
  assert.equal(deskViewFromSearch("").trip, null, "an address that names no trip opens none");
  assert.equal(deskViewFromSearch(deskViewToSearch({ ...DEFAULT_DESK_VIEW, trip: 412 })).trip, 412, "an open trip is kept in the address, so a reload opens the same one");

  // ── 2. The details and photos appear only once a trip is opened ─────────────────────────────
  assert.match(workspace, /\{view\.trip !== null \? \(\s*<DeskReviewer/, "HEADLINE: the trip's details are mounted only while a trip is open");
  assert.equal(workspace.match(/<DeskReviewer/g)?.length, 1, "and in one place: there is one way to read a trip");
  assert.ok(reviewer.includes("<DeskTripFile"), "the reviewer draws the trip file");
  assert.ok(tripFile.includes("fetch(`${ROUTE}/${requestId}`"), "which reads the trip — photos, tickets and field work — in its own one request, on open");
  assert.ok(tripFile.includes("<TripAttachments data={file.attachments}"), "an opened trip shows its photos, stops and tickets");
  assert.ok(tripFile.includes("data-employee-note"), "an opened trip shows the employee's own words");
  assert.doesNotMatch(row, /TripAttachments|employeeNote|fetch\(/, "a closed row shows no photos and no note, and reads nothing of its own");

  // ── 3. The opener: a native button, keyboard-reachable, announced ───────────────────────────
  assert.match(
    decision,
    /<button className=\{approvalActionClassName\("neutral", size\)\} data-open-trip onClick=\{onOpen\} type="button">/,
    "HEADLINE: Open is a native button on every row and card",
  );
  assert.equal(row.match(/onOpen=\{\(\) => onOpen\(claim\.requestId\)\}/g)?.length, 2, "the desktop row and the phone card both carry it");
  assert.match(row, /<button[\s\S]{0,400}onClick=\{\(\) => onOpen\(claim\.requestId\)\}\s*type="button"/, "and the employee's name opens the trip too");
  assert.ok(reviewer.includes('aria-modal="true"') && reviewer.includes('role="dialog"') && reviewer.includes("aria-labelledby={titleId}"), "the open trip is announced as a dialog with its own title");
  assert.ok(reviewer.includes("useDialogA11y<HTMLDivElement>({ open: hydrated, onClose: close })"), "Escape closes it and the keyboard stays inside it");
  assert.ok(reviewer.includes('aria-label="Close the claim"'), "and Close is a labelled button");

  // ── 4. Opening or closing never touches a decision ──────────────────────────────────────────
  assert.ok(workspace.includes("const open = (requestId: number) => desk.setView({ trip: requestId });"), "HEADLINE: opening a trip only changes which trip is open");
  assert.ok(workspace.includes("onClose={() => desk.setView({ trip: null })}"), "HEADLINE: and closing it only clears that — never a decision, an amount or a tick");
  const close = reviewer.match(/const close = useCallback\(\(\) => \{[\s\S]*?\}, \[mode, onClose\]\);/)?.[0] ?? "";
  assert.ok(close.length > 0, "the reviewer's own close is found");
  assert.doesNotMatch(close, /onPress|onUndo|fetch\(/, "the reviewer's close presses nothing and sends nothing");
  assert.doesNotMatch(tripFile, /useEffect\(\(\) => \{[^}]*onPress/, "and opening a trip presses nothing");

  // ── 5. The house look: square, flat, wraps ──────────────────────────────────────────────────
  for (const [name, source] of [["desk-row.tsx", row], ["desk-trip-file.tsx", tripFile], ["desk-reviewer.tsx", reviewer]] as const) {
    assert.doesNotMatch(source, /\brounded(?!-none)(-[a-z0-9]+)?\b/, `${name}: no round corners`);
    assert.doesNotMatch(source, /\bshadow-|\bbg-gradient|\btruncate\b|\bline-clamp/, `${name}: no shadow, gradient or ellipsis`);
  }
}
