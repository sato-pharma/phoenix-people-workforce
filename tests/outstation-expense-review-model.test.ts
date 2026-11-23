import assert from "node:assert/strict";

import {
  DEFAULT_DESK_VIEW,
  approvePress,
  claimsInLane,
  deskTopLine,
  laneSummaries,
  openingLane,
  pressLabel,
  reasonChips,
  reduceBlocked,
  typedAmount,
} from "../src/lib/outstation/approvals/desk-view.ts";
import { EMPTY_PRESS_QUEUE, addPress, pressedRequestIds, queueWithPressesOut, undoPress } from "../src/lib/outstation/approvals/press-queue.ts";
import { TRIP_STANDINGS, TRIP_STANDING_LABEL, countTripStandings, tripStanding } from "../src/lib/outstation/approvals/standing.ts";
import type { ClaimCheck, DeskClaim, DeskDecisionRequest, DeskQueue } from "../src/lib/outstation/approvals/types.ts";

// Expense approvals: the rules of the screen that are not money, tested by BEHAVIOUR.
//
// First written on 2026-11-07 against `expense-review/review-model.ts` (owner: "RETIRE THE CURRENT
// EXPENSE APPROVAL AND REBUILD FROM SCRATCH SAME PHOENIX CRM IDENTITY"). That screen was itself
// retired on 2026-11-23 (owner: "REBUILD FROM SCRATCH", "Save at once, with Undo"), and its model
// went with it. The seven things this file held the old model to are all still rules of the page;
// each is pinned below in the shape the decision desk gives it (src/lib/outstation/approvals/):
//
//   1. where a trip sits            nine tabs read from a mark on screen → two lanes filed by the
//                                    server's checks, plus the trip's stored standing
//   2. the counts                    six tiles that overlapped → five that each count one standing
//   3. moving through the trips      "next awaiting" → the lane's own order, minus what was pressed
//   4. unsaved decisions and drafts  a Save button and a draft in the browser → a press, six
//                                    seconds of Undo, nothing kept in the browser
//   5. the state pill                one word per standing
//   6. the reasons offered           true of THIS trip, from a check that failed on it
//   7. the one line of advice        the top line, from the same figure as the Waiting tile

const pass = (key: ClaimCheck["key"]): ClaimCheck => ({ answer: "pass", key, label: key, sentence: `${key} passed.` });
const fail = (key: ClaimCheck["key"], sentence: string): ClaimCheck => ({ answer: "fail", key, label: key, sentence });

function claim(overrides: Partial<DeskClaim> & { requestId: number }): DeskClaim {
  return {
    allowance: 300,
    approvedAmount: null,
    daysWaiting: 2,
    decidedAt: null,
    employeeName: "Mona Saleh",
    employeeNote: null,
    employeeRole: "Medical Rep",
    from: "Tanta",
    holdReason: null,
    hrComment: "",
    hrId: "A-1",
    locked: false,
    payable: 1000,
    payoutMonth: 11,
    payoutYear: 2026,
    preCut: null,
    relatedRequestIds: [],
    revision: `rev-${overrides.requestId}`,
    standing: "waiting",
    submittedAt: "2026-11-20T08:00:00.000Z",
    systemNote: null,
    to: "Alexandria",
    total: 1000,
    transportation: "train",
    tripEnd: "2026-11-14",
    tripId: `OUTSTATION-${overrides.requestId}`,
    tripStart: "2026-11-12",
    tripType: "outstation",
    verdict: { checks: [pass("field_work"), pass("arrival_photo")], idleDates: [], lane: "ready", reason: null },
    ...overrides,
  };
}

function queueOf(claims: DeskClaim[]): DeskQueue {
  return {
    agreement: { ready: { approved: 0, decided: 0 }, windowDays: 30, yourCall: { approved: 0, decided: 0 } },
    canDecide: true,
    claims,
    overSevenDays: claims.filter((one) => one.standing === "waiting" && one.daysWaiting > 7).length,
    tiles: countTripStandings(claims),
    unavailable: [],
  };
}

const approve = (one: DeskClaim): DeskDecisionRequest => approvePress(one);

export function runOutstationExpenseReviewModelTests() {
  const noNarrowing = { overSevenDays: false, search: "" };
  const idleSentence = "No visit and no meeting on 2 of 3 days: Thu 12 Nov, Fri 13 Nov.";

  const ready = claim({ requestId: 1 });
  const unclear = claim({
    daysWaiting: 9,
    employeeName: "Karim Adel",
    payable: 600,
    requestId: 2,
    to: "Sohag",
    total: 600,
    verdict: { checks: [fail("field_work", idleSentence), pass("arrival_photo")], idleDates: ["2026-11-12", "2026-11-13"], lane: "your_call", reason: idleSentence },
  });
  const readyToo = claim({ employeeName: "Hala Nabil", payable: 250, requestId: 3, total: 250 });
  const queued = claim({ payable: 800, requestId: 4, standing: "approved_queued", total: 800 });
  const reduced = claim({ approvedAmount: 400, payable: 400, requestId: 5, standing: "approved_queued", total: 700 });
  const held = claim({ payable: 300, requestId: 6, standing: "approved_held", total: 300 });
  const paid = claim({ locked: true, payable: 500, requestId: 7, standing: "in_payroll", total: 500 });
  // A rejected row can still carry its claimed figure; the tile must not sum it.
  const rejected = claim({ payable: 900, requestId: 8, standing: "rejected", total: 900 });
  const all = [ready, unclear, readyToo, queued, reduced, held, paid, rejected];

  // ── 1. Where a trip sits is the SERVER's reading, never a mark made on screen ────────────────
  assert.deepEqual(claimsInLane(all, "ready", noNarrowing).map((one) => one.requestId), [1, 3], "HEADLINE: a waiting trip every check passed on is in Ready");
  assert.deepEqual(claimsInLane(all, "your_call", noNarrowing).map((one) => one.requestId), [2], "HEADLINE: a waiting trip with a failed check is in Your call");
  const waitingIds = new Set([...claimsInLane(all, "ready", noNarrowing), ...claimsInLane(all, "your_call", noNarrowing)].map((one) => one.requestId));
  for (const decided of [queued, reduced, held, paid, rejected]) {
    assert.equal(waitingIds.has(decided.requestId), false, `HEADLINE: a decided trip (${decided.standing}) is in neither waiting lane — it is History`);
  }
  const lanes = laneSummaries(all);
  assert.deepEqual([lanes.ready.count, lanes.your_call.count], [2, 1], "HEADLINE: each lane's count is the number of trips it shows");
  assert.deepEqual([lanes.ready.value, lanes.your_call.value], [1250, 600], "and its value is what those trips claim");
  // The search narrows by the words typed: name and places. "Over 7 days" narrows by the wait.
  assert.deepEqual(claimsInLane(all, "ready", { overSevenDays: false, search: "hala" }).map((one) => one.requestId), [3]);
  assert.deepEqual(claimsInLane(all, "your_call", { overSevenDays: false, search: "  SOHAG karim " }).map((one) => one.requestId), [2], "every word must match, in any order and any case");
  assert.deepEqual(claimsInLane(all, "your_call", { overSevenDays: true, search: "" }).map((one) => one.requestId), [2]);
  assert.deepEqual(claimsInLane(all, "ready", { overSevenDays: true, search: "" }), [], "a trip that has waited two days is not over a week");
  // The page opens on the work: Ready when it holds a claim, else Your call; an address that names a lane wins.
  assert.equal(openingLane(DEFAULT_DESK_VIEW, all), "ready", "HEADLINE: the page opens on Ready while it holds a claim");
  assert.equal(openingLane(DEFAULT_DESK_VIEW, [unclear, queued]), "your_call", "and on Your call once Ready is empty");
  assert.equal(openingLane({ ...DEFAULT_DESK_VIEW, lane: "history" }, all), "history", "the address's own lane is kept");

  // ── 2. Five tiles, each counting ONE standing ────────────────────────────────────────────────
  const tiles = countTripStandings(all);
  assert.deepEqual(
    TRIP_STANDINGS.map((standing) => [standing, tiles[standing].count]),
    [["waiting", 3], ["approved_held", 1], ["approved_queued", 2], ["in_payroll", 1], ["rejected", 1]],
    "HEADLINE: every trip is in exactly one tile — a paid trip is never also counted as Approved",
  );
  assert.equal(TRIP_STANDINGS.reduce((sum, standing) => sum + tiles[standing].count, 0), all.length, "and the tiles add up to the trips");
  assert.equal(tiles.approved_queued.value, 1200, "HEADLINE: a reduced trip is summed at the amount he typed (800 + 400), never at its claim");
  assert.equal(tiles.rejected.value, 0, "a rejected trip is counted and never summed");
  assert.equal(tiles.waiting.count, lanes.ready.count + lanes.your_call.count, "HEADLINE: the two lanes add up to the Waiting tile — nothing waits outside them");
  // The standing itself: approved with no payroll row is HELD, and says so.
  assert.equal(tripStanding({ hasPayrollRow: false, payoutMonth: 11, payoutYear: 2026, payrollStamped: false, status: "accepted" }), "approved_held", "HEADLINE: an approved trip payroll has no row for reads held, not approved");
  assert.equal(tripStanding({ hasPayrollRow: true, payoutMonth: 11, payoutYear: 2026, payrollStamped: false, status: "accepted" }), "approved_queued");
  assert.equal(tripStanding({ hasPayrollRow: true, payoutMonth: 11, payoutYear: 2026, payrollStamped: true, status: "accepted" }), "in_payroll");

  // ── 3. Moving through the trips ──────────────────────────────────────────────────────────────
  // The walk is the lane as the server sent it. A claim inside a press is off it, so "next" is
  // always a claim still waiting; Undo puts the claim back where it was.
  assert.deepEqual(claimsInLane(all, "ready", noNarrowing, new Set([1])).map((one) => one.requestId), [3], "HEADLINE: the next trip is the next one still waiting — a pressed one is skipped");
  assert.deepEqual(claimsInLane(all, "ready", noNarrowing, new Set()).map((one) => one.requestId), [1, 3], "and Undo returns it to its own place");

  // ── 4. A press, six seconds of Undo, and a page that agrees with itself meanwhile ───────────
  const loaded = queueOf(all);
  const pressed = addPress(EMPTY_PRESS_QUEUE, { claims: [ready], decisions: [approve(ready)], now: 1_000 });
  assert.deepEqual([...pressedRequestIds(pressed)], [1], "HEADLINE: a press takes exactly its own claim");
  const meanwhile = queueWithPressesOut(loaded, pressedRequestIds(pressed));
  assert.deepEqual(meanwhile.claims.filter((one) => one.standing === "waiting").map((one) => one.requestId), [2, 3], "HEADLINE: a trip approved a moment ago is no longer listed as waiting");
  assert.equal(meanwhile.tiles.waiting.count, 2, "HEADLINE: nor counted as waiting");
  assert.equal(meanwhile.tiles.waiting.value, 850, "nor summed as waiting");
  assert.equal(meanwhile.tiles.approved_queued.count, 2, "but it is not counted as approved until the server says so");
  const undone = undoPress(pressed, pressed.waiting[0].id);
  assert.equal(queueWithPressesOut(loaded, pressedRequestIds(undone)), loaded, "HEADLINE: Undo puts the page back exactly as it was read");
  assert.equal(addPress(pressed, { claims: [ready], decisions: [approve(ready)], now: 2_000 }), pressed, "HEADLINE: a claim already inside a press cannot be pressed twice");
  assert.equal(
    queueWithPressesOut(loaded, new Set([7])),
    loaded,
    "a press on a decided trip (History) leaves the waiting figures alone",
  );
  // A trip with idle days is never approved in full from its row unless he says "Keep full claim".
  const cut = claim({ preCut: { deduction: 200, label: "Idle days", payable: 400, reason: "2 of 3 days idle." }, requestId: 9, total: 600 });
  assert.equal(approvePress(cut).approvedAmount, 400, "HEADLINE: a trip with idle days is approved at its pre-cut amount from its row");
  assert.equal("approvedAmount" in approvePress(cut, { full: true }), false, "and in full only on Keep full claim");
  // Reduce is refused in words where the payroll gate could not carry it.
  assert.equal(reduceBlocked(ready), null);
  assert.equal(reduceBlocked(held), "This claim was already decided.", "HEADLINE: a claim already approved and held is decided: it is not offered a reduced amount");
  assert.match(String(reduceBlocked(claim({ holdReason: "The arrival photo is missing.", requestId: 10 }))), /held out of payroll/);
  assert.equal(reduceBlocked(paid), "A payroll has already taken this trip.");
  assert.equal(typedAmount("2,430.50"), 2430.5, "a figure typed the way a person types it");
  assert.equal(typedAmount("EGP 300"), 300);
  for (const bad of ["", "0", "-5", "12.345", "three hundred"]) {
    assert.equal(typedAmount(bad), null, `"${bad}" is not an amount`);
  }

  // ── 5. The state pill: one word per standing ─────────────────────────────────────────────────
  assert.deepEqual(
    TRIP_STANDINGS.map((standing) => TRIP_STANDING_LABEL[standing]),
    ["Waiting", "Approved · held", "Approved · next payroll", "In payroll", "Rejected"],
    "HEADLINE: the five words a row and a tile wear",
  );
  assert.equal(pressLabel([approve(ready)], [ready]), "Mona Saleh: approved", "the Undo bar names who and what");
  assert.equal(pressLabel([{ action: "reject", comment: "Twice.", requestId: 2, revision: "rev-2" }], [unclear]), "Karim Adel: rejected");
  assert.equal(pressLabel([{ action: "reduce", approvedAmount: 300, comment: "Idle.", requestId: 2, revision: "rev-2" }], [unclear]), "Karim Adel: reduced");

  // ── 6. The reasons offered are true of THIS trip ─────────────────────────────────────────────
  assert.deepEqual(reasonChips(unclear).map((chip) => chip.key), ["idle-days"], "HEADLINE: the day-by-day read decides the field-work reason");
  assert.equal(reasonChips(unclear)[0].text, "2 of the 3 days of this trip had no field activity.");
  const allIdle = claim({
    requestId: 11,
    verdict: { checks: [fail("field_work", "No visit and no meeting.")], idleDates: ["2026-11-12", "2026-11-13", "2026-11-14"], lane: "your_call", reason: "No visit and no meeting." },
  });
  assert.deepEqual(reasonChips(allIdle).map((chip) => chip.key), ["no-activity"], "every day idle is said as no field activity at all");
  assert.deepEqual(reasonChips(ready), [], "HEADLINE: a clean trip is offered no reason at all");
  const unknownOnly = claim({
    requestId: 12,
    verdict: { checks: [{ answer: "unknown", key: "ticket", label: "Ticket", sentence: "The ticket could not be read." }], idleDates: [], lane: "your_call", reason: "The ticket could not be read." },
  });
  assert.deepEqual(reasonChips(unknownOnly), [], "HEADLINE: a check that could not be made is never offered as a reason to reject");
  const several = claim({
    requestId: 13,
    verdict: {
      checks: [fail("departure_photo", "Far from the arrival."), fail("ticket", "No ticket."), fail("duplicate", "Claim of 12 Nov is the same trip.")],
      idleDates: [],
      lane: "your_call",
      reason: "Claim of 12 Nov is the same trip.",
    },
  });
  assert.deepEqual(reasonChips(several).map((chip) => chip.key), ["duplicate", "departure-photo", "ticket"], "several failed checks, several chips, the duplicate first");
  assert.match(reasonChips(several)[0].text, /^This trip was already claimed\. Claim of 12 Nov is the same trip\.$/);

  // ── 7. The one line agrees with the tiles ────────────────────────────────────────────────────
  const top = deskTopLine(loaded);
  assert.deepEqual(top, { count: 3, overSevenDays: 1, value: 1850 }, "HEADLINE: the top line names what is waiting, what it is worth and what is over a week");
  assert.equal(top.count, loaded.tiles.waiting.count, "HEADLINE: it is the Waiting tile's own number, by construction");
  assert.deepEqual(deskTopLine(meanwhile), { count: 2, overSevenDays: 1, value: 850 }, "and it moves with a press, like the tile and the list");
}
