/**
 * EXPENSE APPROVALS — THE KEY CARDS FOLLOW THE FILTERS AND COUNT WHAT THEY MATCH, pinned.
 *
 * Owner, 24 Nov 2026: "make the key cards in expense approvals follow the filter and show the real
 * filtered count". The six cards (Waiting, Approved · held, Approved · missed, Approved · queued, In
 * payroll, Rejected) counted every trip whatever the kind, trip dates or search said, while the tabs and
 * the list under them followed the filters.
 *
 *   1. No filter: the cards are the server's own count, untouched, and say nothing extra.
 *   2. Waiting counts what the two waiting lanes show under every filter, "over 7 days" included.
 *   3. A decided card counts what History lists under the same filters: the kind, the trip dates and
 *      the employee's name or hr id. "Over 7 days" narrows Waiting alone.
 *   4. The server's lines and its tiles agree: unfiltered, the lines add up to the tiles exactly.
 *   5. A press moves a trip between filtered cards as it does between plain ones.
 *   6. One line under narrowed cards says what they count.
 *   7. The page draws the filtered figures on both card rows (desktop and phone); the server sends
 *      one line per decided trip, with the stored name History searches.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { applyDeskOutcomes, filteredTiles, tallyOf, tilesFilterWords } from "@/lib/outstation/approvals/desk-view";
import { DECIDED_CLAIM_COLUMNS } from "@/lib/outstation/approvals/claim-row";
import { countTripStandings } from "@/lib/outstation/approvals/standing";
import type { DeskClaim, DeskQueue, DeskTally } from "@/lib/outstation/approvals/types";

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
    verdict: { checks: [], idleDates: [], lane: "ready", reason: null },
    ...over,
  };
}

const trip = (requestId: number, over: Partial<DeskTally> = {}): DeskTally => ({
  employeeName: "Hossam Adel",
  hrId: "PD-0015",
  kind: "traveling",
  payable: 400,
  requestId,
  standing: "in_payroll",
  tripEnd: "2026-10-08",
  tripStart: "2026-10-07",
  ...over,
});

const none = { from: null, kind: null, overSevenDays: false, search: "", to: null };

function queueOf(claims: DeskClaim[], decided: DeskTally[]): DeskQueue {
  return {
    agreement: { ready: { approved: 0, decided: 0 }, windowDays: 30, yourCall: { approved: 0, decided: 0 } },
    canDecide: true,
    claims,
    decided,
    overSevenDays: claims.filter((entry) => entry.daysWaiting > 7).length,
    tiles: countTripStandings([...claims, ...decided]),
    unavailable: [],
  };
}

const source = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

export function runExpenseDeskTilesFollowFiltersTests() {
  const claims = [
    claim(1),
    claim(2, { daysWaiting: 9, kind: "meeting", payable: 300, verdict: { checks: [], idleDates: [], lane: "your_call", reason: "Unclear." } }),
    claim(3, { employeeName: "Mona Samir", hrId: "PD-0042", kind: "meeting", payable: 250, tripEnd: "2026-10-30", tripStart: "2026-10-30" }),
  ];
  const decided = [
    trip(10),
    trip(11, { kind: "meeting", payable: 150, standing: "approved_queued" }),
    trip(12, { employeeName: "Mona Samir", hrId: "PD-0042", payable: 0, standing: "rejected", tripEnd: "2026-11-02", tripStart: "2026-10-31" }),
    trip(13, { payable: 600, standing: "approved_held", tripEnd: "2026-09-12", tripStart: "2026-09-10" }),
  ];
  const queue = queueOf(claims, decided);

  // 1. No filter: the server's own count, untouched.
  assert.equal(filteredTiles(queue, none), queue.tiles, "with no filter the cards are the server's own tiles");
  assert.equal(tilesFilterWords(none), null, "with no filter nothing is said under the cards");

  // 4. Unfiltered, the server's lines add up to its tiles.
  assert.deepEqual(countTripStandings([...queue.claims, ...queue.decided]), queue.tiles);

  // 2 + 3. HEADLINE: the kind narrows every card.
  const meetings = filteredTiles(queue, { ...none, kind: "meeting" });
  assert.deepEqual(meetings.waiting, { count: 2, value: 550 }, "HEADLINE: Waiting counts only the waiting meeting claims");
  assert.deepEqual(meetings.approved_queued, { count: 1, value: 150 }, "HEADLINE: a decided card counts only the meeting trips");
  assert.deepEqual(meetings.in_payroll, { count: 0, value: 0 }, "a traveling trip in payroll leaves the Meeting cards");
  assert.equal(meetings.rejected.count, 0);

  // The trip dates: October. A trip of 31 Oct to 2 Nov has a day in October, so it stays.
  const october = filteredTiles(queue, { ...none, from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(october.waiting, { count: 1, value: 250 }, "only the October trip waits in October");
  assert.equal(october.in_payroll.count, 1, "the 7–8 Oct trip in payroll is counted");
  assert.equal(october.approved_queued.count, 1);
  assert.equal(october.rejected.count, 1, "a trip that began on 31 Oct has a day in October");
  assert.equal(october.approved_held.count, 0, "a September trip leaves the October cards");

  // The search, as History reads it: the employee's name or hr id.
  const mona = filteredTiles(queue, { ...none, search: "mona" });
  assert.deepEqual(mona.waiting, { count: 1, value: 250 });
  assert.equal(mona.rejected.count, 1, "the search finds a decided trip by the employee's name");
  assert.equal(mona.in_payroll.count, 0);
  assert.equal(filteredTiles(queue, { ...none, search: "PD-0042" }).rejected.count, 1, "and by the hr id");

  // "Over 7 days" narrows Waiting alone: a decided trip has stopped waiting.
  const old = filteredTiles(queue, { ...none, overSevenDays: true });
  assert.deepEqual(old.waiting, { count: 1, value: 300 }, "HEADLINE: over 7 days, Waiting counts only the old claim");
  assert.deepEqual(old.in_payroll, queue.tiles.in_payroll, "over 7 days leaves the decided cards whole");

  // 5. A press moves a trip between the filtered cards.
  const approved = { ...claims[2], standing: "approved_queued" as const };
  const after = applyDeskOutcomes(queue, [{ claim: approved, code: "saved", message: null, requestId: 3 }], [{ action: "approve", claim: claims[2] }]);
  assert.deepEqual(after.decided.find((entry) => entry.requestId === 3), tallyOf(approved), "the decided trip joins the lines the cards count");
  const afterMeetings = filteredTiles(after, { ...none, kind: "meeting" });
  assert.deepEqual(afterMeetings.waiting, { count: 1, value: 300 }, "the approved meeting leaves the filtered Waiting card");
  assert.deepEqual(afterMeetings.approved_queued, { count: 2, value: 400 }, "and joins the filtered Approved · queued card");
  // Taken back to waiting (a decision changed from History), it leaves the decided lines again.
  const back = applyDeskOutcomes(after, [{ claim: claims[2], code: "saved", message: null, requestId: 3 }], [{ action: "approve", claim: approved }]);
  assert.equal(back.decided.some((entry) => entry.requestId === 3), false, "a trip waiting again is not counted twice");
  assert.deepEqual(filteredTiles(back, { ...none, kind: "meeting" }).waiting, { count: 2, value: 550 });

  // 6. One line says what the narrowed cards count.
  assert.equal(tilesFilterWords({ ...none, kind: "meeting" }), "These cards count only Meeting claims.");
  assert.equal(tilesFilterWords({ ...none, overSevenDays: true }), "Waiting counts only the claims waiting over 7 days.");
  assert.match(String(tilesFilterWords({ ...none, from: "2026-10-01", kind: "meeting", overSevenDays: true, to: "2026-10-31" })), /^These cards count only Meeting claims with a trip day in October 2026\. Waiting counts only/);

  // 7. The page draws the filtered figures; the server sends the lines, with the stored name.
  const workspace = source("src/components/outstation/approvals-desk/desk-workspace.tsx");
  assert.match(workspace, /const tiles = queue \? filteredTiles\(queue, view\) : null;/, "the page counts the cards under its filters");
  assert.equal((workspace.match(/<DeskTiles [^>]*tiles=\{tiles \?\? queue\.tiles\}/g) ?? []).length, 2, "both card rows, desktop and phone, draw the filtered figures");
  const tilesFile = source("src/components/outstation/approvals-desk/desk-tiles.tsx");
  assert.match(tilesFile, /const tile = tiles\[standing\];/, "a card reads the figures it was given");
  assert.doesNotMatch(tilesFile, /queue\.tiles\[/, "a card never reads the unfiltered tiles");
  const queueFile = source("src/lib/outstation/approvals/queue.ts");
  assert.match(queueFile, /const tiles = countTripStandings\(\[\.\.\.claims\.map\(.*\), \.\.\.decided\]\);/, "the server counts its tiles from the lines it sends");
  assert.match(queueFile, /^\s+decided,$/m, "the server sends the lines");
  assert.ok(DECIDED_CLAIM_COLUMNS.split(", ").includes("employee_name"), "the decided read carries the stored name History searches");
}
