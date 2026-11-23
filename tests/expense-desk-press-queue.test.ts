/**
 * Expense Approvals, rebuilt 2026-11-23 — A PRESS SAVES AT ONCE, WITH SIX SECONDS OF UNDO.
 *
 * The owner chose "Save at once, with Undo" over the old mark-then-Save, where a marked trip could
 * be lost by leaving the page and a failed row was dropped without a word. Pinned here, on the pure
 * queue the browser runs:
 *
 *   1. A press waits six seconds; Undo inside them takes it back whole; nothing is sent early.
 *   2. A claim inside a press cannot be pressed again, and is off the list and out of the Waiting
 *      tile until the press is answered or taken back.
 *   3. Leaving the page sends every press still inside its window — none is dropped.
 *   4. A press already sent cannot be undone.
 *   5. A claim whose decision did not land is named with the reason; one the answer does not
 *      mention is named too; an approval that is held says so.
 *   6. The request carries the decisions and nothing else.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { DeskDecideBodySchema } from "@/lib/outstation/approvals/decision-body";
import {
  addPress,
  EMPTY_PRESS_QUEUE,
  failedPressNotices,
  mergeNotices,
  nextDueAt,
  pressBody,
  pressedRequestIds,
  pressNotices,
  pressSent,
  queueWithPressesOut,
  settlePress,
  takeAll,
  takeDue,
  UNDO_WINDOW_MS,
  undoPress,
} from "@/lib/outstation/approvals/press-queue";
import { countTripStandings } from "@/lib/outstation/approvals/standing";
import type { DeskClaim, DeskDecisionRequest, DeskQueue } from "@/lib/outstation/approvals/types";

function claim(requestId: number, over: Partial<DeskClaim> = {}): DeskClaim {
  return {
    allowance: 200,
    approvedAmount: null,
    daysWaiting: 2,
    decidedAt: null,
    employeeName: `Employee ${requestId}`,
    employeeNote: null,
    employeeRole: "Medical Rep",
    from: "Cairo",
    holdReason: null,
    hrComment: "",
    hrId: null,
    locked: false,
    payable: 500,
    payoutMonth: 11,
    payoutYear: 2026,
    preCut: null,
    relatedRequestIds: [],
    requestId,
    revision: `rev-${requestId}`,
    standing: "waiting",
    submittedAt: "2026-11-20T08:00:00.000Z",
    systemNote: null,
    to: "Asyut",
    total: 500,
    transportation: "car",
    tripEnd: "2026-11-19",
    tripId: `OUTSTATION-${requestId}`,
    tripStart: "2026-11-19",
    tripType: "Outstation",
    verdict: { checks: [], idleDates: [], lane: "ready", reason: null },
    ...over,
  };
}

const approve = (requestId: number): DeskDecisionRequest => ({ action: "approve", requestId, revision: `rev-${requestId}` });

function queueOf(claims: DeskClaim[]): DeskQueue {
  return {
    agreement: { ready: { approved: 0, decided: 0 }, windowDays: 30, yourCall: { approved: 0, decided: 0 } },
    canDecide: true,
    claims,
    overSevenDays: claims.filter((entry) => entry.daysWaiting > 7).length,
    tiles: countTripStandings(claims),
    unavailable: [],
  };
}

export function runExpenseDeskPressQueueTests() {
  const claims = [claim(1), claim(2, { daysWaiting: 9, payable: 300 }), claim(3)];
  const now = 1_000_000;

  // 1. Six seconds, and Undo inside them.
  assert.equal(UNDO_WINDOW_MS, 6_000, "the Undo window is six seconds");
  const one = addPress(EMPTY_PRESS_QUEUE, { claims, decisions: [approve(1)], now });
  assert.equal(one.waiting.length, 1);
  assert.equal(one.waiting[0].dueAt, now + UNDO_WINDOW_MS);
  assert.equal(nextDueAt(one), now + UNDO_WINDOW_MS);
  assert.equal(takeDue(one, now + UNDO_WINDOW_MS - 1).due.length, 0, "nothing is sent before the window ends");
  assert.equal(takeDue(one, now + UNDO_WINDOW_MS - 1).queue, one);
  const undone = undoPress(one, one.waiting[0].id);
  assert.equal(undone.waiting.length, 0, "Undo takes the press back whole");
  assert.equal(pressedRequestIds(undone).size, 0);
  assert.equal(takeAll(undone).due.length, 0, "a press taken back is never sent, not even when the page closes");
  assert.equal(nextDueAt(undone), null);

  // 2. One claim, one press; pressed claims are off the list and out of the Waiting tile.
  const again = addPress(one, { claims, decisions: [approve(1)], now: now + 100 });
  assert.equal(again, one, "a claim already inside a press cannot be pressed again");
  const batch = addPress(one, { claims, decisions: [approve(1), approve(2), approve(2), approve(99)], now: now + 100 });
  assert.equal(batch.waiting.length, 2);
  assert.deepEqual(batch.waiting[1].decisions.map((decision) => decision.requestId), [2], "the batch keeps only what is on screen and not yet pressed, once each");
  assert.notEqual(batch.waiting[0].id, batch.waiting[1].id);
  assert.deepEqual([...pressedRequestIds(batch)].sort(), [1, 2]);

  const page = queueOf(claims);
  const shown = queueWithPressesOut(page, pressedRequestIds(batch));
  assert.deepEqual(shown.claims.map((entry) => entry.requestId), [3]);
  assert.deepEqual(shown.tiles.waiting, { count: 1, value: 500 }, "the Waiting tile loses the pressed claims and their money");
  assert.equal(shown.overSevenDays, 0, "the over-seven-days count follows the list");
  assert.equal(page.tiles.waiting.count, 3, "the page as loaded is not changed");
  assert.equal(queueWithPressesOut(page, new Set()), page);
  const afterUndo = queueWithPressesOut(page, pressedRequestIds(undoPress(batch, batch.waiting[1].id)));
  assert.deepEqual(afterUndo.claims.map((entry) => entry.requestId), [2, 3], "Undo puts the claim back on the list");
  assert.deepEqual(afterUndo.tiles.waiting, { count: 2, value: 800 });
  // A decided claim being changed from History is not a waiting claim: the Waiting tile is untouched.
  const decided = queueOf([claim(7, { standing: "approved_queued" }), claim(8)]);
  assert.equal(queueWithPressesOut(decided, new Set([7])), decided);

  // 3. Leaving the page sends every press still inside its window.
  const closing = takeAll(batch);
  assert.equal(closing.due.length, 2, "the page closing sends both presses, though neither window had ended");
  assert.equal(closing.queue.waiting.length, 0);
  assert.equal(closing.queue.sending.length, 2);
  assert.deepEqual([...pressedRequestIds(closing.queue)].sort(), [1, 2], "a claim being sent stays off the list until it is answered");

  // 4. A press already sent cannot be undone; the window ending sends only what is due.
  const due = takeDue(batch, now + UNDO_WINDOW_MS);
  assert.deepEqual(due.due.map((press) => press.id), [one.waiting[0].id], "only the press whose six seconds ended is sent");
  assert.equal(due.queue.waiting.length, 1);
  const sentId = due.due[0].id;
  assert.equal(undoPress(due.queue, sentId), due.queue, "a press already sent cannot be taken back");
  const settled = settlePress(due.queue, sentId);
  assert.equal(settled.sending.length, 0);
  assert.deepEqual([...pressedRequestIds(settled)], [2]);
  assert.equal(settlePress(settled, sentId), settled);

  // 5. What comes back is named.
  const press = closing.due[1];
  const both = { ...press, claims: [claims[0], claims[1], claims[2]], decisions: [approve(1), approve(2), approve(3)] };
  const notices = pressNotices(
    both,
    [
      { claim: null, code: "changed", message: "This claim changed since you opened it.", requestId: 1 },
      { claim: claim(2, { standing: "approved_held" }), code: "saved", message: "Approved. Held out of payroll until its photos and workload land.", requestId: 2 },
    ],
    "The decision was not saved. Nothing changed.",
  );
  assert.deepEqual(notices, [
    { message: "This claim changed since you opened it.", name: "Employee 1", requestId: 1, tone: "bad" },
    { message: "Approved. Held out of payroll until its photos and workload land.", name: "Employee 2", requestId: 2, tone: "warn" },
    { message: "The decision was not saved. Nothing changed.", name: "Employee 3", requestId: 3, tone: "bad" },
  ]);
  assert.deepEqual(pressNotices(both, [{ claim: claim(1, { standing: "approved_queued" }), code: "saved", message: null, requestId: 1 }], "x").map((notice) => notice.requestId), [2, 3], "a clean save says nothing");
  assert.deepEqual(failedPressNotices(press, "No connection.").map((notice) => [notice.requestId, notice.tone]), [[2, "bad"]]);
  const merged = mergeNotices(notices, [{ message: "Saved after all.", name: "Employee 1", requestId: 1, tone: "warn" }]);
  assert.deepEqual(merged.map((notice) => [notice.requestId, notice.message]), [
    [2, "Approved. Held out of payroll until its photos and workload land."],
    [3, "The decision was not saved. Nothing changed."],
    [1, "Saved after all."],
  ]);

  // 6. The request carries the decisions and nothing else.
  assert.deepEqual(Object.keys(pressBody(press)), ["decisions"]);
  assert.ok(DeskDecideBodySchema.safeParse(pressBody(press)).success, "what a press sends is what the decide route accepts");
  assert.deepEqual(pressSent(both).map((entry) => [entry.claim.requestId, entry.action]), [[1, "approve"], [2, "approve"], [3, "approve"]]);

  // The browser hook: it sends on pagehide and when the page is hidden, with keepalive, and on unmount.
  const hook = fs.readFileSync("src/components/outstation/approvals-desk/use-desk.ts", "utf8");
  assert.ok(hook.includes('addEventListener("pagehide"'), "leaving the page sends what is inside its Undo window");
  assert.ok(hook.includes('addEventListener("visibilitychange"'), "a phone that hides the page sends too: pagehide is not promised there");
  assert.ok(/keepalive:\s*closing/.test(hook), "a closing page sends with keepalive, so the request outlives it");
  assert.ok(hook.includes("takeAll(") && hook.includes("takeDue(") && hook.includes("undoPress("), "the hook runs the pure queue, not its own copy");
  assert.ok(!/localStorage|sessionStorage/.test(hook), "a decision is never parked in the browser's storage");
}
