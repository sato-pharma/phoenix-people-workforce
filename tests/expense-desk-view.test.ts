/**
 * Expense Approvals, rebuilt 2026-11-23 — WHAT THE PAGE SHOWS, AND WHAT A PRESS CHANGES ON IT.
 *
 * The audit found three different "waiting" counts on one page, a tile called Approved that held
 * paid trips, filters lost on a reload, and a reason box pre-filled with a sentence the employee
 * would then be sent. Pinned here, on the pure functions the browser calls:
 *
 *   1. The two waiting lanes add up to the Waiting tile — one list, split once.
 *   2. The view lives in the address: a reload opens the same lane, search and trip; defaults are
 *      left out; junk in the address is ignored.
 *   3. Approve names the idle-day cut and sends it — except on a trip the payroll gate would hold,
 *      where it pays in full and Reduce says why it is not offered.
 *   4. After the server answers, the decided claim leaves the list and moves between tiles; a
 *      refused or changed claim comes back with its new figures; nothing goes below zero.
 *   5. A reason chip is built only from a check that FAILED on this claim, as a sentence the
 *      employee can read. No failed check, no chip.
 *   6. One vocabulary.
 */
import assert from "node:assert/strict";

import {
  applyDeskOutcomes,
  approvePays,
  approvePress,
  claimsInLane,
  DEFAULT_DESK_VIEW,
  DESK_LANE_LABEL,
  DESK_WORDS,
  deskTopLine,
  deskViewFromSearch,
  deskViewToSearch,
  laneSummaries,
  openingLane,
  paysIdleDayInFull,
  pressLabel,
  readyBatch,
  otherFindings,
  reasonChips,
  reduceBlocked,
  rejectSelection,
  selectionBatch,
  tripDayCount,
  typedAmount,
  waitLabel,
} from "@/lib/outstation/approvals/desk-view";
import { countTripStandings } from "@/lib/outstation/approvals/standing";
import type { ClaimCheck, DeskClaim, DeskQueue } from "@/lib/outstation/approvals/types";

const pass = (key: ClaimCheck["key"]): ClaimCheck => ({ answer: "pass", key, label: key, sentence: "Fine." });
const fail = (key: ClaimCheck["key"], sentence: string): ClaimCheck => ({ answer: "fail", key, label: key, sentence });

function claim(requestId: number, over: Partial<DeskClaim> = {}): DeskClaim {
  return {
    allowance: 200,
    approvedAmount: null,
    daysWaiting: 2,
    decidedAt: null,
    employeeName: "Hossam Adel",
    employeeNote: null,
    employeeRole: "Medical Rep",
    from: "Cairo",
    holdReason: null,
    hrComment: "",
    hrId: "PD-0015",
    kind: "traveling",
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
    tripStart: "2026-11-18",
    tripType: "traveling",
    verdict: { checks: [pass("field_work")], idleDates: [], lane: "ready", reason: null },
    ...over,
  };
}

const yourCall = (requestId: number, over: Partial<DeskClaim> = {}) =>
  claim(requestId, {
    verdict: { checks: [fail("field_work", "No visit and no meeting on 19 Nov.")], idleDates: ["2026-11-19"], lane: "your_call", reason: "No visit and no meeting on 19 Nov." },
    ...over,
  });

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

export function runExpenseDeskViewTests() {
  // 1. The lanes add up to the Waiting tile.
  const claims = [claim(1), claim(2, { total: 300, payable: 300, daysWaiting: 9 }), yourCall(3, { employeeName: "Mona Samir", to: "Sohag" })];
  const queue = queueOf(claims);
  const lanes = laneSummaries(claims);
  assert.deepEqual(lanes, { ready: { count: 2, value: 800 }, your_call: { count: 1, value: 500 } });
  assert.equal(lanes.ready.count + lanes.your_call.count, queue.tiles.waiting.count, "nothing waits outside the two lanes");
  assert.equal(lanes.ready.value + lanes.your_call.value, queue.tiles.waiting.value);
  assert.deepEqual(
    laneSummaries([...claims, claim(4, { standing: "approved_queued" }), yourCall(5, { standing: "rejected" })]),
    lanes,
    "a decided claim is in no waiting lane, whatever lane the system had filed it in",
  );
  assert.deepEqual(claimsInLane([...claims, claim(4, { standing: "approved_queued" })], "ready", DEFAULT_DESK_VIEW).map((entry) => entry.requestId), [1, 2]);
  assert.deepEqual(deskTopLine(queue), { count: 3, overSevenDays: 1, value: 1300 }, "the top line is the Waiting tile, in one unit");
  assert.deepEqual(claimsInLane(claims, "ready", DEFAULT_DESK_VIEW).map((entry) => entry.requestId), [1, 2], "oldest first, as sent");
  assert.deepEqual(claimsInLane(claims, "ready", { overSevenDays: true, search: "" }).map((entry) => entry.requestId), [2]);
  assert.deepEqual(claimsInLane(claims, "your_call", { overSevenDays: false, search: "  mona SOHAG " }).map((entry) => entry.requestId), [3]);
  assert.deepEqual(claimsInLane(claims, "your_call", { overSevenDays: false, search: "mona asyut" }), [], "every word must match");
  assert.deepEqual(claimsInLane(claims, "ready", DEFAULT_DESK_VIEW, new Set([1])).map((entry) => entry.requestId), [2], "a claim inside its Undo window is off the list");
  assert.equal(openingLane(DEFAULT_DESK_VIEW, claims), "ready");
  assert.equal(openingLane(DEFAULT_DESK_VIEW, [yourCall(3)]), "your_call", "an empty Ready lane is not where the page opens");
  assert.equal(openingLane({ ...DEFAULT_DESK_VIEW, lane: "history" }, claims), "history", "a lane named in the address wins");

  // 2. The view lives in the address.
  assert.equal(deskViewToSearch(DEFAULT_DESK_VIEW), "", "defaults leave the address clean");
  const view = { from: "2026-11-01", history: "rejected", kind: "meeting", lane: "your_call", overSevenDays: true, search: "Hossam Adel", to: "2026-11-30", trip: 293 } as const;
  assert.equal(deskViewToSearch(view), "?lane=your_call&q=Hossam+Adel&over7=1&kind=meeting&from=2026-11-01&to=2026-11-30&decided=rejected&trip=293");
  assert.deepEqual(deskViewFromSearch(deskViewToSearch(view)), view, "a reload opens the same view");
  assert.deepEqual(deskViewFromSearch("?lane=paid&trip=abc&over7=yes&decided=all&q="), DEFAULT_DESK_VIEW, "junk in the address is ignored");
  assert.deepEqual(deskViewFromSearch(null), DEFAULT_DESK_VIEW);
  assert.equal(deskViewFromSearch(`?q=${"a".repeat(200)}`).search.length, 60);
  assert.equal(deskViewFromSearch("?trip=0").trip, null);

  // 3. What Approve sends.
  const cut = { deduction: 200, label: "EGP 300 · 1 idle day", payable: 300, reason: "1 of the 2 days had no field activity." };
  assert.deepEqual(approvePress(claim(1)), { action: "approve", requestId: 1, revision: "rev-1" });
  assert.deepEqual(approvePress(yourCall(3, { preCut: cut })), { action: "approve", approvedAmount: 300, requestId: 3, revision: "rev-3" }, "Approve sends the cut its button named");
  assert.deepEqual(
    approvePress(yourCall(3, { preCut: cut }), { full: true }),
    { action: "approve", keepFull: true, requestId: 3, revision: "rev-3" },
    "HEADLINE: Keep full claim sends no amount and SAYS keep-full: the server pays an idle day in full on those words only",
  );
  const held = yourCall(4, { holdReason: "No departure photo yet.", preCut: cut });
  assert.deepEqual(
    approvePress(held),
    { action: "approve", keepFull: true, requestId: 4, revision: "rev-4" },
    "HEADLINE: a trip that would be held is never sent a cut it could not keep, and its row's Approve says it pays in full",
  );
  assert.equal("keepFull" in approvePress(claim(1)), false, "a trip with no idle day has nothing to say");
  assert.equal("keepFull" in approvePress(yourCall(3, { preCut: cut })), false, "an Approve that sends the cut does not also say keep-full");
  assert.match(reduceBlocked(held) ?? "", /held trip cannot carry a reduced amount/);
  for (const standing of ["approved_held", "approved_queued", "rejected"] as const) {
    assert.equal(reduceBlocked(claim(5, { standing })), "This claim was already decided.", `HEADLINE: a claim that stands ${standing} is not offered Reduce`);
  }
  assert.match(reduceBlocked(claim(6, { locked: true, standing: "in_payroll" })) ?? "", /payroll has already taken/);
  assert.equal(reduceBlocked(yourCall(3, { preCut: cut })), null);
  const batch = readyBatch(claimsInLane(claims, "ready", DEFAULT_DESK_VIEW), 100);
  assert.deepEqual({ count: batch.count, left: batch.left, value: batch.value }, { count: 2, left: 0, value: 800 }, "the button shows the count and the total it will approve");
  assert.ok(batch.decisions.every((decision) => decision.action === "approve" && decision.approvedAmount === undefined));
  assert.deepEqual({ count: readyBatch(claims, 1).count, left: readyBatch(claims, 1).left }, { count: 1, left: 2 }, "a lane over the limit says how many are left");
  // A Ready claim has no idle day, so the lane's batch carries no cut today. The batch is still built
  // from each row's OWN Approve, and leaves out a trip whose own Approve would pay an idle day in
  // full — so no list it is ever handed can pay an idle day in full.
  const mixed = readyBatch([yourCall(3, { preCut: cut }), yourCall(4, { holdReason: "No departure photo yet.", preCut: cut }), claim(1)], 100);
  assert.deepEqual(
    mixed.decisions,
    [
      { action: "approve", approvedAmount: 300, requestId: 3, revision: "rev-3" },
      { action: "approve", requestId: 1, revision: "rev-1" },
    ],
    "HEADLINE: Approve all sends each row's own Approve — never Keep full claim, and never a held trip's idle day in full",
  );
  assert.ok(mixed.decisions.every((decision) => !("keepFull" in decision)), "HEADLINE: no batch press carries keep-full — the server refuses one that does");
  assert.deepEqual({ count: mixed.count, left: mixed.left, value: mixed.value }, { count: 2, left: 0, value: 800 }, "HEADLINE: and the total on the button is what those presses pay (300 + 500), not the 1,500 the trips claim");

  // 3b. Several claims in one press: the ticked rows.
  const lane = [yourCall(3, { preCut: cut }), yourCall(4, { holdReason: "No departure photo yet.", preCut: cut }), yourCall(7, { total: 120, payable: 120 })];
  assert.equal(approvePays(lane[0]), 300, "a row's Approve pays the cut its button names");
  assert.equal(approvePays(lane[1]), 500, "a trip that would be held pays in full: it cannot carry a cut");
  assert.deepEqual(lane.map(paysIdleDayInFull), [false, true, false], "only an idle-day trip that would be held pays an idle day in full on its own Approve");
  assert.equal(paysIdleDayInFull(yourCall(4, { holdReason: "No departure photo yet." })), false, "a held trip with no idle day pays nothing extra, so a batch may send it");
  assert.equal(paysIdleDayInFull(claim(4, { holdReason: "x", preCut: cut, standing: "approved_held" })), false, "a decided claim is nobody's batch");
  const ticked = selectionBatch([...lane, claim(8, { standing: "rejected" })], new Set([3, 4, 8, 99]), 100);
  assert.deepEqual(ticked.claims.map((entry) => entry.requestId), [3, 4], "HEADLINE: only a claim still waiting on screen is in the batch — a tick on a decided or vanished claim is forgotten");
  assert.deepEqual(
    ticked.approve,
    [{ action: "approve", approvedAmount: 300, requestId: 3, revision: "rev-3" }],
    "HEADLINE: Approve N sends each row's own Approve — a batch never pays an idle day in full, so the held idle-day trip is left out",
  );
  assert.deepEqual(ticked.needsOpening.map((entry) => entry.requestId), [4], "HEADLINE: and the trip it left out is named, to be opened");
  assert.deepEqual({ count: ticked.count, left: ticked.left, value: ticked.value }, { count: 2, left: 0, value: 300 }, "and the button's figure is the sum of what it sends");
  assert.deepEqual(rejectSelection(ticked.claims, "Copies").map((entry) => entry.requestId), [3, 4], "Reject N still covers every ticked claim: a rejection pays nothing");
  const capped = selectionBatch(lane, new Set([3, 4, 7]), 2);
  assert.deepEqual({ count: capped.count, left: capped.left }, { count: 2, left: 1 }, "over one request's limit, the rest stay ticked");
  assert.deepEqual(selectionBatch(lane, new Set(), 100).approve, [], "nothing ticked, nothing sent");
  assert.deepEqual(rejectSelection(ticked.claims, "   "), [], "HEADLINE: Reject N sends nothing without a written reason");
  assert.deepEqual(
    rejectSelection(ticked.claims, "  The same trip was claimed twice.  "),
    [
      { action: "reject", comment: "The same trip was claimed twice.", requestId: 3, revision: "rev-3" },
      { action: "reject", comment: "The same trip was claimed twice.", requestId: 4, revision: "rev-4" },
    ],
    "every ticked claim carries the one reason, and the version he saw",
  );

  assert.equal(typedAmount("2,430.50"), 2430.5);
  assert.equal(typedAmount(" EGP 300 "), 300);
  for (const bad of ["", "0", "-5", "12.345", "abc", "1e3", "300 EGP x"]) assert.equal(typedAmount(bad), null, `"${bad}" is no amount`);
  assert.equal(waitLabel(0), "Today");
  assert.equal(waitLabel(1), "1 day");
  assert.equal(waitLabel(9), "9 days");
  assert.equal(tripDayCount({ tripEnd: "2026-11-19", tripStart: "2026-11-18" }), 2);
  assert.equal(tripDayCount({ tripEnd: "2026-11-18", tripStart: "2026-11-18" }), 1);
  assert.equal(tripDayCount({ tripEnd: "", tripStart: "2026-11-18" }), 1);

  // 4. After the server answers.
  const approved = { ...claims[0], standing: "approved_queued" as const };
  const rejected = { ...claims[2], payable: 0, standing: "rejected" as const };
  const after = applyDeskOutcomes(
    queue,
    [
      { claim: approved, code: "saved", message: null, requestId: 1 },
      { claim: rejected, code: "saved", message: null, requestId: 3 },
    ],
    [
      { action: "approve", claim: claims[0] },
      { action: "reject", claim: claims[2] },
    ],
  );
  assert.deepEqual(after.claims.map((entry) => entry.requestId), [2], "a decided claim leaves the list at once");
  assert.deepEqual(after.tiles.waiting, { count: 1, value: 300 });
  assert.deepEqual(after.tiles.approved_queued, { count: 1, value: 500 });
  assert.deepEqual(after.tiles.rejected, { count: 1, value: 0 }, "a rejected trip is counted and never summed");
  assert.deepEqual(after.agreement.ready, { approved: 1, decided: 1 }, "the meter moves with the decision");
  assert.deepEqual(after.agreement.yourCall, { approved: 0, decided: 1 });
  assert.equal(after.overSevenDays, 1);
  assert.deepEqual(queue.tiles.waiting, { count: 3, value: 1300 }, "the page before is not changed in place");

  // A claim that had changed comes back with its new figures and stays on the list.
  const moved = { ...claims[1], payable: 420, revision: "rev-2b", total: 420 };
  const back = applyDeskOutcomes(queue, [{ claim: moved, code: "changed", message: "It changed.", requestId: 2 }], [{ action: "approve", claim: claims[1] }]);
  assert.equal(back.claims.find((entry) => entry.requestId === 2)?.total, 420);
  assert.deepEqual(back.tiles.waiting, { count: 3, value: 1420 });
  assert.deepEqual(back.agreement.ready, { approved: 0, decided: 0 }, "a press that did not land is no decision");
  // A press whose answer carries no claim changes nothing.
  assert.deepEqual(applyDeskOutcomes(queue, [{ claim: null, code: "refused", message: "No.", requestId: 1 }], [{ action: "approve", claim: claims[0] }]).tiles, queue.tiles);
  // Tiles never go below zero, whatever arrives.
  const empty = queueOf([]);
  const odd = applyDeskOutcomes(empty, [{ claim: approved, code: "saved", message: null, requestId: 1 }], [{ action: "approve", claim: claims[0] }]);
  assert.deepEqual(odd.tiles.waiting, { count: 0, value: 0 });

  // 5. Reason chips.
  assert.deepEqual(reasonChips(claim(1)), [], "no failed check, no chip: the reason is typed");
  assert.deepEqual(reasonChips(yourCall(3)), [{ key: "idle-days", label: "Idle days", text: "1 of the 2 days of this trip had no field activity." }]);
  assert.equal(reasonChips(yourCall(3, { tripStart: "2026-11-19" }))[0]?.text, "No field activity was recorded on the day of this trip.");
  const many = claim(7, {
    verdict: {
      checks: [
        fail("duplicate", "Same day and destination as the approved claim of 22 Oct."),
        fail("ticket", "A train trip with no ticket attached."),
        { answer: "unknown", key: "route", label: "route", sentence: "No visit carries a position." },
        pass("arrival_photo"),
      ],
      idleDates: [],
      lane: "your_call",
      reason: "x",
    },
  });
  assert.deepEqual(reasonChips(many).map((chip) => chip.key), ["duplicate", "ticket"], "a check that could not be read is never offered as a reason");
  assert.equal(reasonChips(many)[0].text, "This trip was already claimed. Same day and destination as the approved claim of 22 Oct.");
  for (const chip of [...reasonChips(many), ...reasonChips(yourCall(3))]) assert.match(chip.text, /^[A-Z0-9].*\.$/, "every chip is a finished sentence");

  // 5b. The other findings a phone card prints as ONE line (five stacked tags made a card 300 px tall).
  assert.deepEqual(otherFindings(many), { failed: ["duplicate", "ticket"], notChecked: ["route"] }, "HEADLINE: failed and not-checked are told apart, a passed check is never listed");
  const worn = claim(8, { verdict: { ...many.verdict, reason: "A train trip with no ticket attached." } });
  assert.deepEqual(otherFindings(worn), { failed: ["duplicate"], notChecked: ["route"] }, "HEADLINE: the check whose sentence the row already wears is not said twice");
  assert.deepEqual(otherFindings(claim(1)), { failed: [], notChecked: [] }, "a Ready claim has none");

  // 6. One vocabulary.
  assert.deepEqual(DESK_WORDS, {
    approve: "Approve",
    approveAll: "Approve all",
    clearTicks: "Clear",
    keepFull: "Keep full claim",
    open: "Open",
    reduce: "Reduce",
    reject: "Reject",
    undo: "Undo",
  });
  assert.deepEqual(DESK_LANE_LABEL, { history: "History", ready: "Ready", your_call: "Your call" });
  assert.equal(pressLabel([approvePress(claims[0])], claims), "Hossam Adel: approved");
  assert.equal(pressLabel([{ action: "reject", requestId: 3, revision: "r" }], claims), "Mona Samir: rejected");
  assert.equal(pressLabel(batch.decisions, claims), "2 claims approved");
  assert.equal(pressLabel(rejectSelection(ticked.claims, "Twice."), ticked.claims), "2 claims rejected", "HEADLINE: the Undo bar never says approved over a batch of rejections");
  assert.equal(pressLabel([approvePress(claims[0]), { action: "reject", requestId: 3, revision: "r" }], claims), "2 claims decided");
}
