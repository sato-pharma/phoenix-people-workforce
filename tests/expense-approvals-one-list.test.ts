import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  expenseApprovalQueueRank,
  expenseApprovalState,
} from "../src/lib/outstation/approval-state.ts";

/**
 * The Expense Approvals queue is ONE list, not three tabs — owner, 2026-09-08: "i want them in one
 * list not tabs".
 *
 * Two things have to hold for that to be an improvement rather than a wall of 400 rows:
 *
 *  1. THE WORK SURFACES FIRST. Undecided trips sort above decided ones, so opening the page still
 *     lands on what needs a decision. That is what the Pending tab did, and it is the only part of
 *     the tabs worth keeping.
 *
 *  2. A ROW DOES NOT MOVE WHEN IT IS DECIDED. The rank is taken from the STORED decision, never
 *     from the one on screen. Ranking the live decision would re-sort the list on every approval —
 *     the row would leave the cursor mid-review, which is the tab behaviour ("it vanished") that
 *     made the owner distrust the screen in the first place. The list settles on the next load,
 *     which is after Save, which is the only moment a reviewer expects movement.
 *
 * Nothing the tabs carried is lost: the three counts live on the stat cards, and an individual
 * trip's state was always on its own row — a coloured spine plus an Approved / Rejected chip.
 */

function readSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

export function runExpenseApprovalsOneListTests() {
  // ── 1. The ordering rule ───────────────────────────────────────────────────────────────────

  assert.equal(expenseApprovalQueueRank("pending"), 0, "undecided trips come first — they are the work");
  assert.ok(
    expenseApprovalQueueRank("pending") < expenseApprovalQueueRank("approved"),
    "an undecided trip must outrank an approved one",
  );
  assert.ok(
    expenseApprovalQueueRank("approved") < expenseApprovalQueueRank("rejected"),
    "approved sits above rejected, so the two decided groups stay in a stable, predictable order",
  );

  // Every state the shared classifier can return must have a rank, or a trip lands in an
  // undefined slot and sorts unpredictably against its neighbours.
  for (const state of ["pending", "approved", "rejected"] as const) {
    const rank = expenseApprovalQueueRank(state);
    assert.ok(Number.isInteger(rank) && rank >= 0, `${state} must carry a real rank`);
  }

  // The ordering the screen actually produces, exercised end to end on the same comparator: rank
  // first, then value descending inside each group.
  const rows = [
    { hrApproved: false, status: "Rejected", total: 900, id: "rejected-900" },
    { hrApproved: true, status: "Approved", total: 100, id: "approved-100" },
    { hrApproved: false, status: "", total: 50, id: "pending-50" },
    { hrApproved: true, status: "Approved", total: 800, id: "approved-800" },
    { hrApproved: false, status: "", total: 700, id: "pending-700" },
  ];
  const ordered = [...rows]
    .sort(
      (left, right) =>
        expenseApprovalQueueRank(expenseApprovalState(left)) -
          expenseApprovalQueueRank(expenseApprovalState(right)) || right.total - left.total,
    )
    .map((row) => row.id);
  assert.deepEqual(
    ordered,
    ["pending-700", "pending-50", "approved-800", "approved-100", "rejected-900"],
    "undecided first by value, then approved by value, then rejected — a 900 rejection never " +
      "outranks a 50 that still needs a decision",
  );

  // ── 2. The screen ──────────────────────────────────────────────────────────────────────────
  // Rebuilt from scratch in the Phoenix CRM identity on 2026-11-07 (expense-review/). The page has
  // tabs again — Needs a look, Clean, Approved and the rest, as Place checks has — but the property
  // the one list was built for still holds: a trip never leaves the list it is being decided in.

  const model = readSource("../src/components/outstation/expense-review/review-model.ts");
  const hook = readSource("../src/components/outstation/expense-review/use-expense-review.ts");

  // THE NON-JUMPING PROPERTY, pinned where it is decided. `savedDecision` is the stored row;
  // `decisionFor` is what is on screen. Filing or ranking by the latter moves a row on every click.
  const membership = model.match(/export function inReviewTab\([\s\S]*?\n\}/)?.[0];
  assert.ok(membership, "a tab's membership must be decided in one function");
  assert.match(membership, /const stored = savedDecision\(record\);/, "HEADLINE: a trip's tab is read from its STORED decision");
  assert.doesNotMatch(membership, /decisionFor/, "and never from the live one — a row stays put the moment it is decided");
  const ordering = model.match(/export function tabRows\([\s\S]*?\n\}/)?.[0];
  assert.ok(ordering, "the tab's rows must be built in one function");
  assert.match(
    ordering,
    /expenseApprovalQueueRank\(expenseApprovalState\(savedDecision\(record\)\)\)/,
    "HEADLINE: All trips ranks the STORED decision — ranking the live one makes a row jump the moment it is decided",
  );
  assert.doesNotMatch(ordering, /decisionFor/, "and must not reach for the live decision at all while ordering");
  // The reviewer walks a FROZEN list of ids, so a decided trip keeps its place and Back returns to it.
  assert.match(hook, /export type DeckState = \{ ids: string\[\]; open: string \| null; tab: TripTab \| "employee" \};/, "the reviewer's walk is frozen when it opens");

  // Select-all is scoped to what can actually be approved, in the tab on screen. Ticking everything
  // would hand planBulkApproval already-decided rows, and it would answer "N were already decided" —
  // a wall of noise standing in for a button that did nothing.
  assert.match(
    hook,
    /const selectable = useMemo\(\s*\(\) => rows\.filter\(\(record\) => !isImportedHistoryTrip\(record\.date\) && expenseApprovalState\(decisionFor\(record\)\) === "pending"\),/,
    "HEADLINE: only a trip still waiting, in the tab on screen, can be ticked",
  );
  assert.match(hook, /for \(const record of selectable\) \{/, "and select-all ticks those only");

  // A decided row carries no tick box — offering one invites a click that silently does nothing.
  const table = readSource("../src/components/outstation/expense-review/review-queue-table.tsx");
  assert.match(
    table,
    // ...and neither does imported history, which is values only (imported-history.ts).
    /if \(!actions\.canDecide \|\| isImportedHistoryTrip\(record\.date\) \|\| expenseApprovalState\(decision\) !== "pending"\) return null;/,
    "only an undecided row may show a checkbox",
  );
}
