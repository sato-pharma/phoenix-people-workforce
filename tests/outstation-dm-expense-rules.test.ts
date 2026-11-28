/**
 * The District Manager expense rules (owner, 28 Nov 2026, "Build them now"). Pinned:
 *
 *   1. The day's work: within 150 km a full day is AM ≥ 1 and PM ≥ 6 (the owner lowered AM from 2 to 1 on
 *      28 Nov 2026); no AM visit counts as PM only and pays half; fewer than 6 PM pays PM/6; beyond 150 km a PM half day is allowed. Only the
 *      allowance is cut, per trip day, and a day whose first or last double visit is not confirmed — or
 *      that had no double visit — pays nothing. A row already at 0 stays 0; a re-price starts from the
 *      day's own base, never from a cut.
 *   2. The 3-hour gap: the departure photo opens 3 hours after the arrival, and a phone clock set back
 *      cannot open it early on an online claim.
 *   3. Tickets within 12 hours of the first double visit of that day.
 *   4. A ticket photo is taken live in the app; an online ticket is the operator's PDF. A gallery
 *      picture or a screenshot is refused.
 *   5. An online ticket is read for its passenger and booking number, and a booking is claimed once —
 *      across claims, never inside one (one booking can carry both legs).
 *   6. The train cap: each leg is paid up to the second-class AC fare of the train taken (one route's
 *      trains differ), else the route's dearest, else the dearest between the stations nearest home and
 *      the destination; nothing known means no cap.
 *   7. A weekly meeting is accepted only on a Thursday, for EVERYONE (owner, 28 Nov 2026): a new claim
 *      that claims a meeting with no Thursday among its days is refused at submit.
 *   8. The wiring: each rule is checked on the server before anything is stored.
 *   9. The risk review's money guards (28 Nov 2026): Approve waits until every trip day is priced (an
 *      approval freezes the allowance); a double visit that reached the server after its day closed never
 *      counts; a not-eligible claim's total never goes negative; a hand-set allowance is never priced over
 *      and gets its idle-day cut back; a read that could not measure the field work writes nothing; a
 *      ticket counts on the leg its DIRECTION names, never its date; a fare above a nearest-route estimate,
 *      and every rule an offline replay skipped, is flagged on the desk instead of lost.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { DESK_REFUSAL, planDeskDecision } from "@/lib/outstation/approvals/decision-plan";
import { reasonChips } from "@/lib/outstation/approvals/desk-view";
import type { ClaimVerdict, DeskClaim } from "@/lib/outstation/approvals/types";
import {
  arrivedBeforeDayClosed,
  crmDayClosesAt,
  dmAllowanceApprovalHold,
  dmAllowanceEditedSincePriced,
  dmExpectedTotalAfter,
  initialDmWorkAllowanceStamp,
  dmArrivalAnchor,
  dmDepartureTooSoonMessage,
  dmTicketDeadline,
  dmTicketSourceRefusal,
  dmTicketTooLateMessage,
  judgeDmTripDay,
  planDmWorkAllowance,
  readDmWorkAllowance,
  type DmTripDayWork,
} from "@/lib/outstation/dm-expense-rules";
import { claimDays, meetingDayRefusal } from "@/lib/outstation/approvals/meeting-day";
import { findDuplicateTicket, readBookingKey, sameTicketTwice, ticketRepeats } from "@/lib/outstation/duplicate-ticket-guard";
import { normalizeTicketScan } from "@/lib/outstation/ticket-scan-rules";
import {
  dmTrainFareFlag,
  dmTrainFareOverCaps,
  dmTrainFareRefusal,
  matchTrainStation,
  nearestRouteFareCap,
  ticketFareCap,
} from "@/lib/outstation/train-fare-cap";
import { TRAIN_AC2_BY_TRAIN, TRAIN_AC2_BY_TRAIN_STATIONS } from "@/lib/outstation/train-fares-by-train-data";

const HOUR = 60 * 60 * 1000;

function visit(id: string, capturedAt: string, confirmed: boolean) {
  return { capturedAt, confirmedAt: confirmed ? capturedAt : null, id, repName: "Rep" };
}

function day(am: number, pm: number, visits = [visit("a", "2026-12-01T08:00:00Z", true), visit("b", "2026-12-01T14:00:00Z", true)]): DmTripDayWork {
  return { am, doubleVisits: visits, final: true, pm };
}

function dayWork() {
  const judge = (work: DmTripDayWork, km: number | null = 100) => judgeDmTripDay({ baseAmount: 200, date: "2026-12-01", km, work });
  assert.equal(judge(day(1, 6)).paidAmount, 200, "HEADLINE: AM 1 and PM 6 within 150 km is a full day — one contract account or hospital is enough");
  assert.equal(judge(day(2, 6)).paidAmount, 200, "AM 2 and PM 6 is a full day too");
  assert.equal(judge(day(5, 9)).paidAmount, 200, "more work never pays more than the day");
  const noAm = judge(day(0, 6));
  assert.equal(noAm.paidAmount, 100, "no AM visit counts as PM only: half");
  assert.match(noAm.reason, /^No AM visit counts as PM only: half/, "the reason says no AM visit, never \"fewer than 1\"");
  assert.equal(judge(day(2, 3)).paidAmount, 100, "3 of 6 PM pays half");
  assert.equal(judge(day(1, 3)).paidAmount, 100, "1 AM and 3 PM: a full day's AM, 3/6 of the PM");
  assert.equal(judge(day(0, 3)).paidAmount, 50, "both cuts: half of 3/6");
  assert.equal(judge(day(0, 6), 151).paidAmount, 200, "beyond 150 km a PM day is allowed");
  assert.equal(judge(day(0, 6), 150).paidAmount, 100, "at exactly 150 km it is not");
  assert.equal(judge(day(2, 0)).paidAmount, 0, "no PM at all pays nothing");

  const unconfirmedLast = judge(day(2, 6, [visit("a", "2026-12-01T08:00:00Z", true), visit("b", "2026-12-01T14:00:00Z", false)]));
  assert.equal(unconfirmedLast.paidAmount, 0, "HEADLINE: the last double visit not confirmed: no allowance that day");
  assert.match(unconfirmedLast.reason, /^The last double visit not confirmed: no allowance/);
  const middleOpen = judge(
    day(2, 6, [visit("a", "2026-12-01T08:00:00Z", true), visit("m", "2026-12-01T11:00:00Z", false), visit("b", "2026-12-01T14:00:00Z", true)]),
  );
  assert.equal(middleOpen.paidAmount, 200, "only the first and the last must be confirmed");
  const none = judge(day(2, 6, []));
  assert.equal(none.paidAmount, 0, "no double visit with him that day: nothing to confirm, nothing paid");
  assert.match(none.reason, /No double visit with you that day/);
  assert.equal(judge({ ...day(2, 6), final: false }).final, false, "a day not over yet is not final");

  const plan = planDmWorkAllowance({
    km: 100,
    now: "2026-12-03T06:00:00Z",
    rowDates: ["2026-12-01", "2026-12-02", "2026-12-03"],
    rows: [
      { amount: 200, label: "Overnight", type: "overnight" as const },
      { amount: 0, label: "Held by another claim", skipped: true, type: "overnight" as const },
      { amount: 60, baseAmount: 125, label: "Return day", type: "return_day" as const },
    ],
    work: (date) => (date === "2026-12-01" ? day(0, 6) : day(2, 6)),
  });
  assert.deepEqual(plan.rows.map((row) => row.amount), [100, 0, 125], "a skipped day stays 0; a re-price starts from the base (125), never from the cut (60)");
  assert.equal(plan.record.allowanceBefore, 325);
  assert.equal(plan.record.allowanceAfter, 225);
  assert.equal(readDmWorkAllowance(plan.record)?.allowanceAfter, 225, "the stored record reads back");
  assert.equal(readDmWorkAllowance({ allowanceAfter: 1 }), null, "a claim filed before the rules has no record");
}

function threeHours() {
  const arrival = "2026-12-01T07:00:00Z";
  const anchor = dmArrivalAnchor({ arrivalCapturedAt: arrival, offlineCaptured: false, submittedAt: "2026-12-01T07:05:00Z" });
  assert.equal(anchor, Date.parse(arrival));
  assert.match(dmDepartureTooSoonMessage({ arrivalAnchorMs: anchor, nowMs: Date.parse(arrival) + 2.9 * HOUR }) ?? "", /must be at least 3 hours after the arrival/);
  assert.equal(dmDepartureTooSoonMessage({ arrivalAnchorMs: anchor, nowMs: Date.parse(arrival) + 3 * HOUR }), null, "HEADLINE: 3 hours after the arrival it opens");
  const setBack = dmArrivalAnchor({ arrivalCapturedAt: "2026-12-01T02:00:00Z", offlineCaptured: false, submittedAt: "2026-12-01T07:00:00Z" });
  assert.equal(setBack, Date.parse("2026-12-01T06:30:00Z"), "a phone clock set back cannot open the departure camera early");
  assert.equal(
    dmArrivalAnchor({ arrivalCapturedAt: "2026-12-01T02:00:00Z", offlineCaptured: true, submittedAt: "2026-12-01T07:00:00Z" }),
    Date.parse("2026-12-01T02:00:00Z"),
    "an offline claim has only the phone's time",
  );
}

function twelveHours() {
  const deadline = dmTicketDeadline({ firstDoubleVisitAt: "2026-12-01T08:00:00Z", tripEndDate: "2026-12-01" });
  assert.equal(deadline?.basis, "first_double_visit");
  assert.equal(deadline?.deadlineMs, Date.parse("2026-12-01T20:00:00Z"), "HEADLINE: 12 hours from the first double visit of that day");
  assert.equal(dmTicketTooLateMessage({ deadline, nowMs: Date.parse("2026-12-01T19:59:00Z") }), null);
  assert.match(dmTicketTooLateMessage({ deadline, nowMs: Date.parse("2026-12-01T20:01:00Z") }) ?? "", /must be added within 12 hours of your first double visit/);
  assert.equal(dmTicketDeadline({ firstDoubleVisitAt: null, tripEndDate: "2026-12-01" })?.basis, "trip_end", "no double visit: from the end of the trip's last day");
}

function liveTickets() {
  assert.equal(dmTicketSourceRefusal([{ contentType: "image/jpeg", source: "live_camera" }]), null, "a live photo passes");
  assert.equal(dmTicketSourceRefusal([{ contentType: "application/pdf", source: "file" }]), null, "the operator's PDF passes");
  const refused = dmTicketSourceRefusal([{ contentType: "image/png", source: "file" }]);
  assert.match(refused ?? "", /must be taken live in the app/, "HEADLINE: a gallery picture or a screenshot is refused");
  assert.match(refused ?? "", /must be/, "the routes answer \"must be\" with a 400");
  assert.ok(dmTicketSourceRefusal([{ contentType: "image/jpeg" }]), "a photo that does not say where it came from is not live");
}

function bookingOnce() {
  const read = normalizeTicketScan({
    booking_number: "GB-٤٥٦٧٨٩",
    from_station: "Cairo",
    is_train_ticket: true,
    passenger_name: "Ahmed Ali",
    problems: [],
    to_station: "Asyut",
    train_number: "980",
    travel_date: "2026-12-01",
  });
  assert.equal(read.status === "read" ? read.bookingNumber : null, "GB-٤٥٦٧٨٩");
  assert.equal(read.status === "read" ? read.passengerName : null, "Ahmed Ali");
  assert.equal(readBookingKey({ bookingNumber: "GB-٤٥٦٧٨٩" }), "gb456789", "Arabic digits and punctuation never split one booking");
  assert.equal(readBookingKey({ bookingNumber: "12" }), null, "too short to be a booking");

  const go = { bookingNumber: "GB456789", matchedTo: "arrival", trainNumber: "980", travelDate: "2026-12-01" };
  const back = { bookingNumber: "GB456789", matchedTo: "departure", trainNumber: "981", travelDate: "2026-12-03" };
  assert.equal(sameTicketTwice({ candidates: [go, back] }), null, "one booking carrying both legs of one claim is never refused");
  const newClaim = { employeeHrId: "B-1", readTickets: [{ ...go, travelDate: "2026-12-10", trainNumber: "990" }], tripEndDate: "2026-12-10", tripStartDate: "2026-12-10" };
  const earlier = { employeeHrId: "B-1", readTickets: [{ scan: go }], tripEndDate: "2026-12-03", tripStartDate: "2026-12-01" };
  assert.deepEqual(ticketRepeats(newClaim, earlier), ["booking"], "HEADLINE: a booking already on another claim repeats it, whatever the day");
  const match = findDuplicateTicket(newClaim, [{ ...earlier, id: 7, status: "pending" }]);
  assert.equal(match?.earlier.id, 7);
}

function trainCap() {
  const cairo = matchTrainStation("القاهرة");
  const asyut = matchTrainStation("محطة أسيوط");
  assert.equal(cairo?.site, "CAIRO", "an Arabic name with its ة matches");
  assert.equal(asyut?.site, "ASYUT", "\"محطة\" and the hamza are read through");
  assert.equal(matchTrainStation("Ramses")?.site, "CAIRO", "Cairo's main station by its own name");
  assert.equal(matchTrainStation("Alexandria")?.site, "ALEXANDRIA");
  assert.equal(matchTrainStation("somewhere else"), null);

  // The sweep's own Cairo → Asyut trains: their fares differ, which is why the cap is per train.
  const from = TRAIN_AC2_BY_TRAIN_STATIONS.indexOf("CAIRO");
  const to = TRAIN_AC2_BY_TRAIN_STATIONS.indexOf("ASYUT");
  const row = TRAIN_AC2_BY_TRAIN.find(([a, b]) => a === from && b === to);
  assert.ok(row, "the sweep has Cairo → Asyut");
  const trains = row![2].split(",").map((entry) => entry.split("=")).map(([train, fare]) => ({ fare: Number(fare), train }));
  const fares = new Set(trains.map((t) => t.fare));
  assert.ok(fares.size > 1, "HEADLINE: one route's AC 2 fares differ by train");
  const cheapest = trains.reduce((a, b) => (b.fare < a.fare ? b : a));
  const dearest = Math.max(...trains.map((t) => t.fare));

  const own = ticketFareCap({ fromStation: "Cairo", toStation: "Asyut", trainNumber: `٠${cheapest.train}` });
  assert.deepEqual([own?.source, own?.fare], ["train", cheapest.fare], "the train taken: its own fare");
  const unknownTrain = ticketFareCap({ fromStation: "Cairo", toStation: "Asyut", trainNumber: "99999" });
  assert.deepEqual([unknownTrain?.source, unknownTrain?.fare], ["route", dearest], "a train not in the sweep: the route's dearest");
  assert.equal(ticketFareCap({ fromStation: null, toStation: "Asyut", trainNumber: cheapest.train }), null);

  const home = { latitude: 30.06, longitude: 31.25 };
  const destination = { latitude: 27.18, longitude: 31.18 };
  const nearest = nearestRouteFareCap({ destination, home });
  assert.equal(nearest?.fare, dearest, "nothing read: the dearest train between the stations nearest home and the destination");
  assert.equal(nearestRouteFareCap({ destination, home: null }), null);

  const ticket = { fromStation: "Cairo", matchedTo: "arrival", toStation: "Asyut", trainNumber: cheapest.train };
  assert.deepEqual(dmTrainFareOverCaps({ destination, goAmount: cheapest.fare, home, returnAmount: 0, tickets: [ticket] }), [], "at the fare it fits");
  const over = dmTrainFareOverCaps({ destination, goAmount: cheapest.fare + 50, home, returnAmount: dearest + 1, tickets: [ticket] });
  assert.deepEqual(over.map((check) => [check.leg, check.cap]), [["go", cheapest.fare], ["return", dearest]], "a return with no ticket read takes the nearest-route cap");
  const words = dmTrainFareRefusal(over) ?? "";
  assert.match(words, /paid up to the second-class AC fare of the train taken/);
  assert.match(words, new RegExp(`train ${cheapest.train}, Cairo to Asyut`));
  assert.deepEqual(
    dmTrainFareOverCaps({ destination: null, goAmount: 9999, home: null, returnAmount: 0, tickets: [] }),
    [],
    "nothing known: never refused for the system's own gap",
  );
  const change = dmTrainFareOverCaps({
    destination,
    goAmount: cheapest.fare * 2,
    home,
    returnAmount: 0,
    tickets: [ticket, { ...ticket }],
  });
  assert.deepEqual(change, [], "a change of train: the leg's cap is the sum of its tickets");
}

function thursdayMeetings() {
  // 3 Dec 2026 is a Thursday.
  assert.equal(meetingDayRefusal({ endDate: "2026-12-03", kind: "meeting", meetingCost: 0, startDate: "2026-12-03" }), null, "a Thursday meeting is accepted");
  const wednesday = meetingDayRefusal({ endDate: "2026-12-02", kind: "meeting", meetingCost: 0, startDate: "2026-12-02" });
  assert.match(wednesday ?? "", /Wednesday 2 Dec, not a Thursday/, "HEADLINE: a meeting on any other day is refused");
  assert.match(wednesday ?? "", /must be on a Thursday/, "and the routes answer \"must be\" with a 400");
  assert.ok(meetingDayRefusal({ endDate: "2026-12-02", kind: "traveling", meetingCost: 150, startDate: "2026-12-01" }), "a trip claiming a meeting amount on no Thursday is refused too");
  assert.equal(meetingDayRefusal({ endDate: "2026-12-04", kind: "traveling", meetingCost: 150, startDate: "2026-12-01" }), null, "a trip whose days include a Thursday passes");
  assert.equal(meetingDayRefusal({ endDate: "2026-12-02", kind: "traveling", meetingCost: 0, startDate: "2026-12-02" }), null, "a trip with no meeting is not touched");
  assert.equal(meetingDayRefusal({ endDate: null, kind: "meeting", meetingCost: 0, startDate: null }), null, "no readable day is never refused");
  assert.deepEqual(claimDays("2026-12-01", "2026-12-03"), ["2026-12-01", "2026-12-02", "2026-12-03"]);
}

function wiring() {
  const service = fs.readFileSync("src/lib/outstation/service.ts", "utf8");
  const submit = service.slice(service.indexOf("export async function submitOutstationRequest("));
  const fare = submit.indexOf("dmTrainFareOverCaps(");
  assert.ok(fare !== -1, "HEADLINE: the train cap is checked on submit");
  assert.ok(fare < submit.indexOf("uploadOutstationTicketAttachments("), "before any file is stored");
  assert.match(submit, /if \(refusal\) throw new TrainTicketRefusedError\(refusal\)/, "and answered 400 with its words");
  assert.ok(submit.indexOf("dmTicketSourceRefusal(") < submit.indexOf("uploadOutstationTicketAttachments("), "a gallery ticket is refused before upload");
  const meeting = submit.indexOf("meetingDayRefusal(");
  assert.ok(meeting !== -1 && meeting < submit.indexOf("uploadOutstationTicketAttachments("), "HEADLINE: a non-Thursday meeting is refused at submit, before anything is stored");
  assert.doesNotMatch(submit.slice(Math.max(0, meeting - 400), meeting), /isDistrictManagerRole/, "for everyone, not District Managers only");
  for (const fn of ["export async function addExtraTicketsToOwnOutstationRequest(", "export async function attachMissingTicketsToOwnOutstationRequest("]) {
    const body = service.slice(service.indexOf(fn), service.indexOf(fn) + 6000);
    assert.match(body, /dmTicketAddRefusal\(existing,/, `${fn} holds the 12 hours and the live photo`);
  }
  const client = fs.readFileSync("src/components/outstation/prepare-ticket-attachment.ts", "utf8");
  assert.match(client, /liveTicketCaptures\.has\(file\) \? "live_camera" : "file"/, "only the app's own camera button marks a file live");
  for (const card of [
    "src/components/outstation/ticket-upload-card.tsx",
    "src/components/outstation/missing-ticket-card.tsx",
    "src/components/outstation/journey-stop-card.tsx",
    "src/components/outstation/extra-ticket-manager.tsx",
  ]) {
    assert.match(fs.readFileSync(card, "utf8"), /capture="environment"[\s\S]{0,160}markLiveTicketCaptures\(event\.target\.files\)/, `${card} has the camera button`);
  }
}

function approvalWaits() {
  const stamp = readDmWorkAllowance(initialDmWorkAllowanceStamp("2026-12-01T06:00:00Z"));
  assert.equal(stamp?.initial, true, "the submit stamp reads back as not priced yet");
  const open = { ...stamp!, days: [], final: false, initial: undefined };
  const beforeClose = crmDayClosesAt("2026-12-03") - 1;
  const hold = dmAllowanceApprovalHold(open, "2026-12-03", beforeClose);
  assert.match(hold ?? "", /not every day is priced yet \(the trip's last day, 3 December 2026, closes at 02:00/, "HEADLINE: Approve waits while a trip day is open");
  assert.match(hold ?? "", /You can still reject it/);
  assert.equal(dmAllowanceApprovalHold(open, "2026-12-03", crmDayClosesAt("2026-12-03")), null, "once the day closed the approval itself prices the finished trip");
  assert.equal(dmAllowanceApprovalHold({ ...open, final: true }, "2026-12-03", beforeClose), null, "a final record approves");
  assert.equal(dmAllowanceApprovalHold(null, "2026-12-03", beforeClose), null, "a claim before the rules is not held");
  assert.equal(new Date(crmDayClosesAt("2026-12-03")).toISOString(), "2026-12-04T00:00:00.000Z", "the CRM day closes 02:00 Cairo the next morning");

  const claim = (over: Partial<DeskClaim> = {}): DeskClaim => ({
    allowance: 300, approvedAmount: null, daysWaiting: 1, decidedAt: null, employeeName: "A District Manager", employeeNote: null,
    employeeRole: "District Manager", from: "Minya", holdReason: null, hrComment: "", hrId: null, kind: "traveling", locked: false,
    payable: 900, payoutMonth: 12, payoutYear: 2026, preCut: null, relatedRequestIds: [], requestId: 9, revision: "r1", standing: "waiting",
    submittedAt: null, systemNote: null, to: "Asyut", total: 900, transportation: "Car", tripEnd: "2026-12-03", tripId: "OUTSTATION-9",
    tripStart: "2026-12-01", tripType: "traveling",
    verdict: { checks: [], idleDates: [], lane: "ready", reason: null },
    ...over,
  });
  const approve = planDeskDecision(claim({ allowanceHold: hold }), { action: "approve", requestId: 9, revision: "r1" });
  assert.deepEqual(approve, { code: "refused", message: hold, ok: false }, "HEADLINE: the desk refuses Approve with the reason in words");
  assert.equal(planDeskDecision(claim({ allowanceHold: hold }), { action: "reduce", approvedAmount: 500, comment: "x", requestId: 9, revision: "r1" }).ok, false, "and Reduce");
  assert.equal(planDeskDecision(claim({ allowanceHold: hold }), { action: "reject", comment: "No work", requestId: 9, revision: "r1" }).ok, true, "Reject stays open");
  assert.equal(planDeskDecision(claim(), { action: "approve", requestId: 9, revision: "r1" }).ok, true, "with no hold it approves");
  assert.ok(DESK_REFUSAL.notSaved);

  // The priced claim's idle days already pay nothing: no "Idle days" reduce reason; "No field activity" stays.
  const idle: ClaimVerdict = { checks: [{ answer: "fail", key: "field_work", label: "Field work", sentence: "1 idle day." }], idleDates: ["2026-12-02"], lane: "your_call", reason: "1 idle day." };
  assert.ok(reasonChips(claim({ verdict: idle })).some((chip) => chip.key === "idle-days"), "an unpriced claim is offered the idle-day reason");
  assert.ok(!reasonChips(claim({ dmWorkPriced: true, verdict: idle })).some((chip) => chip.key === "idle-days"), "a priced one is not");

  const service = fs.readFileSync("src/lib/outstation/service.ts", "utf8");
  const approveFn = service.slice(service.indexOf("export async function approveOutstationRequestForPayroll("));
  const gate = approveFn.indexOf("assertDmAllowanceReadyToApprove(requestId)");
  assert.ok(gate !== -1 && gate < approveFn.indexOf("readOutstationRequestStoredUpdatedAt(requestId)"), "HEADLINE: the server gate runs before the version check");
  const server = fs.readFileSync("src/lib/outstation/dm-work-allowance-server.ts", "utf8");
  assert.match(server, /if \(outcome\.result === "written"\) throw new OutstationClaimChangedError\("changed"\)/, "a claim the gate re-priced is answered changed");
}

function pricerGuards() {
  // A rep's visit that synced after 02:00 never counts as the day's first or last double visit.
  assert.equal(arrivedBeforeDayClosed({ created_at: "2026-12-03T23:59:00Z", visit_date: "2026-12-03" }), true, "arrived before 02:00 Cairo");
  assert.equal(arrivedBeforeDayClosed({ created_at: "2026-12-04T00:00:01Z", visit_date: "2026-12-03" }), false, "HEADLINE: a visit that reached the server after its day closed is left out");
  const server = fs.readFileSync("src/lib/outstation/dm-work-allowance-server.ts", "utf8");
  assert.match(server, /captured_at, created_at, visit_date/, "the server arrival time is read");
  assert.match(server, /\.filter\(\(row\) => arrivedBeforeDayClosed\(row\)\)/, "and filtered on");

  // A not-eligible claim (expected total 0) never goes negative; any other moves by the delta, floored at 0.
  assert.equal(dmExpectedTotalAfter({ delta: -200, eligibilityStatus: "not_eligible", expected: 0 }), 0, "HEADLINE: a not-eligible claim stays at 0");
  assert.equal(dmExpectedTotalAfter({ delta: 150, eligibilityStatus: "not_eligible", expected: 0 }), 0, "HEADLINE: a re-priced not-eligible claim never gains a total either");
  assert.equal(dmExpectedTotalAfter({ delta: -200, eligibilityStatus: "eligible", expected: 900 }), 700);
  assert.equal(dmExpectedTotalAfter({ delta: -200, eligibilityStatus: "eligible", expected: 100 }), 0, "never below nothing");

  // A hand-set allowance is never priced over.
  const priced = planDmWorkAllowance({
    km: 100, now: "2026-12-04T06:00:00Z", rowDates: ["2026-12-03"],
    rows: [{ amount: 200, label: "Overnight", type: "overnight" as const }],
    work: () => day(0, 6),
  }).record;
  assert.equal(dmAllowanceEditedSincePriced(priced, 100), false, "the rule's own figure");
  assert.equal(dmAllowanceEditedSincePriced(priced, 180), true, "HEADLINE: an allowance moved off the priced figure is someone's edit");
  assert.equal(dmAllowanceEditedSincePriced(readDmWorkAllowance(initialDmWorkAllowanceStamp("x")), 180), false, "the unpriced stamp is priced");
  assert.match(server, /if \(dmAllowanceEditedSincePriced\(previous, allowanceNow\)\) return \{ requestId, result: "edited_since_priced" \}/);
  const row = fs.readFileSync("src/lib/outstation/approvals/claim-row.ts", "utf8");
  assert.match(row, /!workRecord\.initial && !dmAllowanceEditedSincePriced\(workRecord, approval\.allowance\)/, "the desk gives a hand-edited claim its idle-day cut back");

  // A read that could not measure the field work writes nothing.
  assert.match(
    server,
    /if \(workload\.matchStatus === "unmapped" \|\| workload\.managerOwnVisits === undefined\) return \{ requestId, result: "unmeasured" \}/,
    "HEADLINE: an unmapped person or a failed own-visit read prices nothing",
  );
  assert.ok(server.indexOf('result: "unmeasured"') < server.indexOf("planDmWorkAllowance({"), "before anything is priced");

  // The priced record with no allowance day is final, not "not priced yet"; the flags ride every re-price.
  const empty = planDmWorkAllowance({ km: 100, now: "n", rowDates: ["2026-12-03"], rows: [{ amount: 0, label: "x", type: "overnight" as const }], work: () => day(2, 6) });
  assert.equal(empty.record.final, true);
  assert.equal(readDmWorkAllowance(empty.record)?.initial, undefined, "a priced record with no days is not the unpriced stamp");
  const flagged = planDmWorkAllowance({ evidenceFlags: ["Offline gallery ticket."], km: 100, now: "n", rowDates: [], rows: [], work: () => day(2, 6) });
  assert.deepEqual(readDmWorkAllowance(flagged.record)?.evidenceFlags, ["Offline gallery ticket."], "a flag survives the re-price");
  assert.match(server, /evidenceFlags: previous\?\.evidenceFlags/);
}

function capByDirection() {
  const home = { latitude: 30.06, longitude: 31.25 };
  const destination = { latitude: 27.18, longitude: 31.18 };
  const go = ticketFareCap({ fromStation: "Cairo", toStation: "Asyut", trainNumber: null });
  const back = ticketFareCap({ fromStation: "Asyut", toStation: "Cairo", trainNumber: null });
  assert.ok(go && back, "both directions have fares");
  // A same-day trip: both tickets dated the arrival day, so both match the arrival.
  const tickets = [
    { fromStation: "Cairo", matchedTo: "arrival", toStation: "Asyut", trainNumber: null },
    { fromStation: "Asyut", matchedTo: "arrival", toStation: "Cairo", trainNumber: null },
  ];
  const over = dmTrainFareOverCaps({ destination, goAmount: go!.fare + 100, home, returnAmount: back!.fare, tickets });
  assert.deepEqual(
    over.map((check) => [check.leg, check.cap, check.refusable]),
    [["go", go!.fare, true]],
    "HEADLINE: each ticket counts on the leg its direction names, never doubling a same-day leg's cap",
  );
  assert.deepEqual(
    dmTrainFareOverCaps({ destination, goAmount: back!.fare, home: null, returnAmount: 0, tickets: [{ ...tickets[1], matchedTo: "arrival" }] }).length,
    0,
    "no home on file: the date match decides",
  );

  // A cap that is the nearest-route estimate is flagged, never refused.
  const guess = dmTrainFareOverCaps({ destination, goAmount: 0, home, returnAmount: 99999, tickets: [] });
  assert.deepEqual(guess.map((check) => [check.leg, check.refusable]), [["return", false]], "HEADLINE: an estimate is not refusable");
  assert.equal(dmTrainFareRefusal(guess.filter((check) => check.refusable)), null);
  assert.match(dmTrainFareFlag(guess) ?? "", /estimated from the stations nearest the employee's home/);
  assert.match(dmTrainFareFlag(over, { offline: true }) ?? "", /synced offline, so it could not be refused/);

  const service = fs.readFileSync("src/lib/outstation/service.ts", "utf8");
  const submit = service.slice(service.indexOf("export async function submitOutstationRequest("));
  assert.match(submit, /dmTrainFareRefusal\(over\.filter\(\(check\) => check\.refusable\)\)/, "submit refuses only the railway's own fare");
  assert.match(submit, /if \(refusal && !options\.dropRefusedTrainTickets\) throw new Error\(refusal\)/, "a gallery ticket online is refused");
  assert.match(submit, /initialDmWorkAllowanceStamp\(calculation\.submittedAt, dmEvidenceFlags\)/, "HEADLINE: what an offline replay skipped is stored on the claim");
  const checks = fs.readFileSync("src/lib/outstation/approvals/checks.ts", "utf8");
  assert.match(checks, /if \(flags\.length > 0\) return check\("work_allowance", "fail", flags\.join\(" "\)\)/, "and fails the desk check");

  const build = fs.readFileSync("scripts/outstation/build-train-fares-by-train.mjs", "utf8");
  assert.match(build, /if \(sweep\.failed > 0\) throw new Error/, "a sweep with a failed search is never built from");
  assert.match(fs.readFileSync("scripts/outstation/sweep-train-fares.mjs", "utf8"), /JSON\.stringify\(\{ date, failed, pairs: pairs\.length, rows \}\)/, "the sweep records its failures");
}

export async function runOutstationDmExpenseRulesTests() {
  approvalWaits();
  pricerGuards();
  capByDirection();
  dayWork();
  threeHours();
  twelveHours();
  liveTickets();
  bookingOnce();
  trainCap();
  thursdayMeetings();
  wiring();
}
