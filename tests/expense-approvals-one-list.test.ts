import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  expenseApprovalQueueRank,
  expenseApprovalState,
} from "../src/lib/outstation/approval-state.ts";
import { claimsInLane } from "../src/lib/outstation/approvals/desk-view.ts";
import type { DeskClaim } from "../src/lib/outstation/approvals/types.ts";

/**
 * The Expense Approvals queue is ONE list, not three tabs — owner, 2026-09-08: "i want them in one
 * list not tabs".
 *
 * What that rule protects, through two rebuilds (7 Nov 2026, then 23 Nov 2026):
 *
 *  1. THE WORK SURFACES FIRST. Opening the page lands on what needs a decision. Since 23 Nov the
 *     page reads ONLY what waits; decided trips are History, read on a press.
 *
 *  2. NOTHING RE-SORTS UNDER THE CURSOR. The order is the server's and the browser never re-ranks
 *     it. Since 23 Nov ("Save at once, with Undo") a press takes its claim off the list — that is
 *     the decision being made, and Undo puts the claim back in the place it had.
 *
 * `expenseApprovalQueueRank` (section 1) is the domain's ranking of a mixed list. No screen calls
 * it since 23 Nov, because no screen mixes waiting and decided trips any more; it stays pinned so a
 * list that does mix them again ranks them the way he asked.
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

  // ── 2. The screen ────────────────────────────────────────────────────────────────────
  // Rebuilt from scratch on 2026-11-23 (approvals-desk/; owner: "REBUILD FROM SCRATCH", "Save at
  // once, with Undo"). The page shows what WAITS, in two lanes the server files — Ready and Your
  // call — and History is its own lane, read on a press. What the one list was built for still
  // holds, in the shape his new rule gives it:
  //
  //   - a claim's lane is the SERVER's verdict and its stored standing, never a mark on screen;
  //   - a press takes the claim off the list at once and Undo puts it back where it was — nothing
  //     re-sorts under the cursor, because the order is the server's (oldest first) and is never
  //     re-ranked in the browser.
  const lanes = [
    { daysWaiting: 9, employeeName: "Rep A", from: "Cairo", requestId: 1, standing: "waiting", to: "Aswan", verdict: { lane: "ready" } },
    { daysWaiting: 2, employeeName: "Rep B", from: "Cairo", requestId: 2, standing: "waiting", to: "Luxor", verdict: { lane: "your_call" } },
    { daysWaiting: 1, employeeName: "Rep C", from: "Cairo", requestId: 3, standing: "waiting", to: "Qena", verdict: { lane: "ready" } },
    { daysWaiting: 30, employeeName: "Rep D", from: "Cairo", requestId: 4, standing: "approved_queued", to: "Minya", verdict: { lane: "ready" } },
  ] as unknown as DeskClaim[];
  const noNarrowing = { overSevenDays: false, search: "" };
  assert.deepEqual(
    claimsInLane(lanes, "ready", noNarrowing).map((claim) => claim.requestId),
    [1, 3],
    "HEADLINE: a lane holds the claims still waiting whose server verdict names it, in the order they were sent",
  );
  assert.deepEqual(
    claimsInLane(lanes, "your_call", noNarrowing).map((claim) => claim.requestId),
    [2],
    "and Your call holds the rest of what waits: a decided claim is in neither",
  );
  assert.deepEqual(
    claimsInLane(lanes, "ready", noNarrowing, new Set([1])).map((claim) => claim.requestId),
    [3],
    "a claim inside a press is off the list",
  );
  assert.deepEqual(
    claimsInLane(lanes, "ready", noNarrowing, new Set()).map((claim) => claim.requestId),
    [1, 3],
    "HEADLINE: and Undo puts it back in the place it had: nothing was re-sorted meanwhile",
  );

  const view = readSource("../src/lib/outstation/approvals/desk-view.ts");
  const membership = view.match(/export function claimsInLane\([\s\S]*?\n\}/)?.[0];
  assert.ok(membership, "a lane's membership must be decided in one function");
  assert.doesNotMatch(membership, /\.sort\(/, "and that function never re-ranks: the order is the server's");

  // The reviewer walks the lane on screen, so Previous and Next are the rows he was reading.
  const workspace = readSource("../src/components/outstation/approvals-desk/desk-workspace.tsx");
  assert.ok(
    workspace.includes("walk={laneClaims.map((claim) => claim.requestId)}"),
    "the reviewer's walk is the lane on screen, in its order",
  );

  // Ticks are scoped to what can actually be decided. A reader who cannot decide gets none, and a
  // claim that was decided meanwhile drops out of the batch rather than being sent again.
  const row = readSource("../src/components/outstation/approvals-desk/desk-row.tsx");
  assert.ok(
    row.includes("onTick: canDecide ? (on: boolean) => tick(claim.requestId, on) : undefined,"),
    "HEADLINE: a row carries a tick only for someone who can decide",
  );
  assert.ok(row.includes("{onTick ? <TickBox checked={ticked} name={claim.employeeName} onChange={onTick} /> : null}"), "and draws none without it");
  assert.ok(
    row.includes("const selection = selectionBatch(claims, ticked, DESK_DECISION_LIMIT);"),
    "the ticked batch is read against the claims on screen, not kept from an earlier render",
  );
  assert.ok(
    view.includes('const chosen = claims.filter((claim) => claim.standing === "waiting" && ticked.has(claim.requestId));'),
    "and only a claim still waiting counts",
  );
  assert.ok(
    row.includes("onChange={(on) => setTicked(on ? new Set(page.map((claim) => claim.requestId)) : new Set())}"),
    "select-all ticks the rows drawn, and nothing behind Show more",
  );

  // A decided trip carries no tick box: History is read only until a trip is opened.
  const history = readSource("../src/components/outstation/approvals-desk/desk-history.tsx");
  assert.ok(!history.includes("TickBox") && !history.includes("SelectionBar"), "History offers no tick: a tick there would invite a press that does nothing");
}
