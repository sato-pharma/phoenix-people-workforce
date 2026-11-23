/**
 * Expense Approvals, rebuilt 2026-11-23 — THE CHECKS AND THE LANE, pinned.
 *
 * The old checks said nothing: a claim they called matched was rejected 24% of the time and one
 * they called no activity 26%, and the territory check fired on 56 of 64 waiting claims. The
 * rebuilt checks each answer pass, fail or "could not check" in one sentence, and a claim is Ready
 * only when every check passed.
 *
 *   1. A clean trip is Ready; a car trip owes no ticket line.
 *   2. "Could not check" is never a pass: Phoenix CRM unread, a trip not over, a day before the
 *      team moved to Phoenix CRM — each keeps the claim out of Ready, and none is an idle day.
 *   3. An idle day (no visit AND no recorded meeting, on a day that is over) fails, is named, and is
 *      what the idle-day cut is offered on. A recorded meeting is field work.
 *   4. The departure photo, calibrated on his own decisions: taken together with the arrival photo
 *      PASSES (78% approved against 82% with no flag); only outside the trip or over 40 km fails.
 *   5. The one reason of a "Your call" row is picked in the order he rejects for: duplicate first.
 *   6. A meeting or other cost is not a trip: the duplicate and the amount (and, for a meeting, its
 *      day), and it is never Ready.
 *   7. The pre-cut: the per-idle-day share of the allowance, never travel or tickets.
 *
 * Added 2026-11-23, after the District Manager expense inspection (the owner's three choices):
 *   8. An arrival photo uploaded from the gallery is never Ready; a blank stored photo fails.
 *   9. A return fare with no read return ticket fails; tickets never read cannot be checked.
 *  10. Two trips of one person on the same day: the shared day fails the duplicate check.
 *  11. The odometer of a car trip: no line before the rule; going down, or moving less than 90% of
 *      the driving paid since the last reading, fails.
 */
import assert from "node:assert/strict";

import {
  CHECK_LABEL,
  claimPreCut,
  DEPARTURE_MAX_KM_FROM_ARRIVAL,
  ODOMETER_PAID_KM_SHARE,
  idleTripDates,
  isTripClaim,
  judgeClaim,
  runClaimChecks,
  shortDay,
  verdictFromChecks,
  type ClaimCheckFacts,
  type FieldWorkDay,
} from "@/lib/outstation/approvals/checks";
import type { CheckKey } from "@/lib/outstation/approvals/types";

const day = (date: string, over: Partial<FieldWorkDay> = {}): FieldWorkDay => ({
  atDestination: true,
  beforePhoenix: false,
  date,
  meetings: 0,
  positioned: true,
  visits: 4,
  ...over,
});

/** A District Manager's one-day car trip on 18 Nov, read on 23 Nov: everything in order. */
function facts(over: Partial<ClaimCheckFacts> = {}): ClaimCheckFacts {
  return {
    arrival: { capturedOn: "2026-11-18", hasPosition: true, onFile: true, uploaded: false },
    attachments: 0,
    departure: { capturedOn: "2026-11-18", flags: [], hasPosition: true, kmFromArrival: 1.2, minutesAfterArrival: 240, onFile: true },
    duplicateTickets: [],
    duplicateTrips: [],
    eligibilityReason: null,
    eligibilityStatus: "eligible",
    evidenceGateStatus: "complete",
    expenseType: "traveling",
    fieldWork: { days: [day("2026-11-18")], homeDays: [], km: null },
    hasNoTicketFare: false,
    role: "District Manager",
    today: "2026-11-23",
    transportation: "car",
    tripDates: ["2026-11-18"],
    ...over,
  };
}

const answerOf = (input: ClaimCheckFacts, key: CheckKey) => runClaimChecks(input).find((entry) => entry.key === key);

export function runExpenseDeskChecksTests() {
  // 1. A clean trip is Ready.
  const clean = judgeClaim(facts());
  assert.equal(clean.lane, "ready");
  assert.equal(clean.reason, null);
  assert.deepEqual(clean.idleDates, []);
  assert.deepEqual(
    clean.checks.map((entry) => entry.key),
    ["field_work", "route", "arrival_photo", "departure_photo", "duplicate", "amounts"],
    "a car trip prints no ticket line: a line that can only pass is noise",
  );
  assert.ok(clean.checks.every((entry) => entry.answer === "pass" && entry.label === CHECK_LABEL[entry.key] && entry.sentence.endsWith(".")));
  assert.equal(answerOf(facts(), "field_work")?.sentence, "Worked the day: 4 visits.");

  // 2. "Could not check" is never a pass, and never an idle day.
  const unread = judgeClaim(facts({ fieldWork: null }));
  assert.equal(unread.lane, "your_call");
  assert.equal(answerOf(facts({ fieldWork: null }), "field_work")?.answer, "unknown");
  assert.equal(answerOf(facts({ fieldWork: null }), "route")?.answer, "unknown");
  assert.deepEqual(unread.idleDates, [], "a claim is not filed as idle because Phoenix CRM could not be read");
  assert.match(unread.reason ?? "", /could not be read/);

  const running = facts({ fieldWork: { days: [day("2026-11-23", { visits: 0 })], homeDays: [], km: null }, tripDates: ["2026-11-23"] });
  assert.equal(answerOf(running, "field_work")?.answer, "unknown", "a day that is not over is not idle yet");
  assert.deepEqual(idleTripDates(running), []);
  assert.equal(judgeClaim(running).lane, "your_call");

  const old = facts({ fieldWork: { days: [day("2026-11-18", { beforePhoenix: true, visits: 0 })], homeDays: [], km: null } });
  assert.equal(answerOf(old, "field_work")?.answer, "unknown");
  assert.deepEqual(idleTripDates(old), [], "a day the old system holds is not idle here");

  // 3. An idle day fails, is named, and a recorded meeting is field work.
  const twoDays = ["2026-11-17", "2026-11-18"];
  const idle = facts({
    fieldWork: { days: [day("2026-11-17"), day("2026-11-18", { atDestination: false, positioned: false, visits: 0 })], homeDays: [], km: null },
    tripDates: twoDays,
  });
  const idleVerdict = judgeClaim(idle);
  assert.equal(idleVerdict.lane, "your_call");
  assert.deepEqual(idleVerdict.idleDates, ["2026-11-18"]);
  assert.equal(idleVerdict.reason, "No visit and no meeting on 1 of 2 days: 18 Nov.");
  const meeting = facts({
    fieldWork: { days: [day("2026-11-17"), day("2026-11-18", { meetings: 1, visits: 0 })], homeDays: [], km: null },
    tripDates: twoDays,
  });
  assert.equal(answerOf(meeting, "field_work")?.answer, "pass", "a recorded meeting is field work (owner, 2026-11-07)");
  assert.equal(answerOf(meeting, "field_work")?.sentence, "Worked all 2 days: 4 visits and 1 meeting.");
  assert.deepEqual(judgeClaim(meeting).idleDates, []);

  // Route: back home fails, an overstated distance fails, no position cannot be checked.
  assert.equal(answerOf(facts({ fieldWork: { days: [day("2026-11-18")], homeDays: ["2026-11-18"], km: null } }), "route")?.answer, "fail");
  const far = facts({ fieldWork: { days: [day("2026-11-18")], homeDays: [], km: { claimed: 180, farthest: 22, needsLook: true } } });
  assert.equal(answerOf(far, "route")?.sentence, "180 km claimed, and the farthest visit is 22 km from home.");
  const blind = facts({ fieldWork: { days: [day("2026-11-18", { atDestination: false, positioned: false })], homeDays: [], km: null } });
  assert.equal(answerOf(blind, "route")?.answer, "unknown");

  // 4. The departure photo, calibrated.
  assert.equal(DEPARTURE_MAX_KM_FROM_ARRIVAL, 40);
  const dep = (over: Partial<ClaimCheckFacts["departure"]>) => facts({ departure: { ...facts().departure, ...over } });
  const together = answerOf(dep({ kmFromArrival: 0, minutesAfterArrival: 2 }), "departure_photo");
  assert.equal(together?.answer, "pass", "taken together tells nothing either way, so it must not hold a claim out of Ready");
  assert.match(together?.sentence ?? "", /Taken with the arrival photo, 2 min apart/);
  assert.equal(judgeClaim(dep({ kmFromArrival: 0, minutesAfterArrival: 2 })).lane, "ready");
  assert.equal(answerOf(dep({ kmFromArrival: 40 }), "departure_photo")?.answer, "pass");
  assert.equal(answerOf(dep({ kmFromArrival: 41 }), "departure_photo")?.answer, "fail");
  assert.equal(answerOf(dep({ flags: ["outside_trip_window"] }), "departure_photo")?.answer, "fail");
  assert.equal(answerOf(dep({ hasPosition: false }), "departure_photo")?.answer, "fail");
  assert.equal(answerOf(dep({ onFile: false }), "departure_photo")?.sentence, "No departure photo.");
  // Not owed: a waived role passes, a pre-rule claim cannot be checked (and so is not Ready).
  assert.equal(answerOf(facts({ evidenceGateStatus: "grandfathered" }), "arrival_photo")?.answer, "unknown");
  assert.equal(judgeClaim(facts({ evidenceGateStatus: "grandfathered" })).lane, "your_call");
  // Arrival: an uploaded file is judged on the file's own day.
  const upload = (fileTakenOn: string | null | undefined) =>
    answerOf(facts({ arrival: { capturedOn: "2026-11-18", fileTakenOn, hasPosition: false, onFile: true, uploaded: true } }), "arrival_photo");
  // 8. An upload is never Ready (owner, 2026-11-23): a gallery file proves a photo, not presence.
  assert.equal(upload("2026-11-18")?.answer, "unknown", "HEADLINE: an uploaded arrival photo is always Your call");
  assert.equal(upload("2026-11-18")?.sentence, "Uploaded from the gallery, not taken live; the file says it was taken on 18 Nov.");
  assert.equal(
    judgeClaim(facts({ arrival: { capturedOn: "2026-11-18", fileTakenOn: "2026-11-18", hasPosition: false, onFile: true, uploaded: true } })).lane,
    "your_call",
  );
  assert.equal(upload("2026-11-02")?.answer, "fail", "a file from outside the trip still fails");
  assert.equal(upload(null)?.answer, "unknown");
  // A blank stored photo fails; one never measured is judged as before.
  const blankArrival = facts({ arrival: { ...facts().arrival, blank: true } });
  assert.equal(answerOf(blankArrival, "arrival_photo")?.answer, "fail");
  assert.equal(judgeClaim(blankArrival).reason, "The arrival photo is blank: nothing can be seen in it.");
  assert.equal(answerOf(dep({ blank: true }), "departure_photo")?.sentence, "The departure photo is blank: nothing can be seen in it.");
  assert.equal(answerOf(facts({ arrival: { ...facts().arrival, blank: false } }), "arrival_photo")?.answer, "pass");

  // Ticket: a train trip owes one.
  assert.equal(answerOf(facts({ transportation: "train" }), "ticket")?.answer, "fail");
  assert.equal(answerOf(facts({ attachments: 2, transportation: "train" }), "ticket")?.sentence, "2 ticket photos attached.");
  assert.equal(answerOf(facts({ hasNoTicketFare: true, transportation: "no_ticket" }), "ticket")?.answer, "pass");
  assert.equal(
    answerOf(facts({ hasNoTicketFare: true, noTicketFareLine: " Cairo → Asyut · EGP 420 there and back ", transportation: "no_ticket" }), "ticket")?.sentence,
    "No ticket: priced at the fixed train fare. Cairo → Asyut · EGP 420 there and back",
    "HEADLINE: a no-ticket trip says the stations and the fare it was priced on",
  );
  assert.equal(answerOf(facts({ noTicketFareLine: "Cairo → Asyut", transportation: "no_ticket" }), "ticket")?.answer, "unknown", "a line with no fare on file proves nothing");
  // 9. The return fare is paid on its ticket (owner, 2026-11-23).
  const train = (returnTicket: ClaimCheckFacts["returnTicket"], attachments = 1) =>
    answerOf(facts({ attachments, returnAmount: 270, returnTicket, transportation: "train" }), "ticket");
  assert.equal(train("missing")?.answer, "fail");
  assert.equal(train("missing")?.sentence, "Return EGP 270 claimed with no return ticket.", "HEADLINE: the return fare named, with its gap");
  assert.equal(train("unread")?.answer, "unknown", "tickets never read cannot be checked either way");
  assert.equal(train("present", 2)?.sentence, "2 ticket photos attached, the return ticket among them.");
  assert.equal(train("not_claimed")?.sentence, "1 ticket photo attached.");
  assert.equal(judgeClaim(facts({ attachments: 1, returnAmount: 270, returnTicket: "missing", transportation: "train" })).lane, "your_call");

  // 5. The one reason: what he rejects for first.
  const many = judgeClaim(
    facts({
      departure: { ...facts().departure, onFile: false },
      duplicateTrips: ["the approved claim of 18 Nov"],
      fieldWork: { days: [day("2026-11-18", { visits: 0 })], homeDays: [], km: null },
    }),
  );
  assert.equal(many.reason, "Same day and destination as the approved claim of 18 Nov.", "a duplicate outranks every other finding");
  assert.equal(verdictFromChecks([]).lane, "your_call", "a claim with no checks at all is never Ready");
  assert.equal(
    judgeClaim(facts({ duplicateTickets: ["the waiting claim of 12 Nov"] })).reason,
    "Repeats a ticket, cost or receipt of the waiting claim of 12 Nov.",
  );
  // 10. A shared trip day pays that day twice (owner, 2026-11-23).
  const shared = facts({ sharedTripDays: ["18 Nov with the waiting claim of 17 Nov"] });
  assert.equal(answerOf(shared, "duplicate")?.answer, "fail");
  assert.equal(judgeClaim(shared).reason, "Shares 18 Nov with the waiting claim of 17 Nov.");
  assert.equal(answerOf(facts({ sharedTripDays: [] }), "duplicate")?.answer, "pass");
  // A failure outranks a "could not check".
  const mixed = judgeClaim(facts({ departure: { ...facts().departure, onFile: false }, eligibilityStatus: "manual" }));
  assert.equal(mixed.reason, "No departure photo.");

  // 6. A meeting or other cost.
  assert.equal(isTripClaim("meeting"), false);
  assert.equal(isTripClaim("other"), false);
  assert.equal(isTripClaim("traveling"), true);
  const invoice = judgeClaim(facts({ attachments: 1, expenseType: "meeting" }));
  // A claim filed as Meeting also carries the Thursday line (owner, 2026-11-23; tests/expense-desk-kind.test.ts).
  assert.deepEqual(invoice.checks.map((entry) => entry.key), ["duplicate", "meeting_day", "amounts"]);
  assert.deepEqual(judgeClaim(facts({ attachments: 1, expenseType: "other" })).checks.map((entry) => entry.key), ["duplicate", "amounts"]);
  assert.equal(invoice.lane, "your_call", "an amount the employee typed is always his to read");
  assert.equal(judgeClaim(facts({ attachments: 0, expenseType: "other" })).reason, "A meeting or other cost with no invoice or picture attached.");
  assert.deepEqual(judgeClaim(facts({ expenseType: "meeting", fieldWork: null })).idleDates, []);

  // 7. The pre-cut.
  const cut = claimPreCut({ allowance: 300, idleDays: 1, total: 900, tripDays: 3 });
  assert.deepEqual(cut && { deduction: cut.deduction, label: cut.label, payable: cut.payable }, {
    deduction: 100,
    label: "Allowance for 1 idle day",
    payable: 800,
  });
  assert.match(cut?.reason ?? "", /1 of 3 days with no field activity/);
  assert.equal(claimPreCut({ allowance: 0, idleDays: 1, total: 400, tripDays: 1 }), null, "no allowance, nothing to cut: travel and tickets are real costs");
  assert.equal(claimPreCut({ allowance: 300, idleDays: 0, total: 900, tripDays: 3 }), null);
  assert.equal(claimPreCut({ allowance: 300, idleDays: 1, total: 900, tripDays: 1 })?.payable, 600, "every day idle: the whole allowance");

  // 11. The odometer (owner, 2026-11-23: the system reads the odometer from the car photo).
  assert.equal(ODOMETER_PAID_KM_SHARE, 0.9);
  const km = (value: number) => ({ km: value, status: "read" as const });
  const odo = (over: Partial<NonNullable<ClaimCheckFacts["odometer"]>> = {}) =>
    facts({ odometer: { anchor: null, arrival: km(52612), departure: km(52790), paidKmSinceAnchor: null, ...over } });
  assert.ok(!runClaimChecks(facts()).some((entry) => entry.key === "odometer"), "HEADLINE: no line for a claim filed before the rule");
  assert.ok(!runClaimChecks({ ...odo(), transportation: "train" }).some((entry) => entry.key === "odometer"), "only a car trip");
  assert.deepEqual(
    runClaimChecks(odo()).map((entry) => entry.key),
    ["field_work", "route", "arrival_photo", "departure_photo", "odometer", "duplicate", "amounts"],
  );
  assert.equal(answerOf(odo(), "odometer")?.sentence, "First odometer reading on file: 52,612 km.");
  assert.equal(judgeClaim(odo()).lane, "ready", "a first reading is a pass");
  assert.equal(
    answerOf(odo({ departure: km(52600) }), "odometer")?.sentence,
    "The odometer went down during the trip: 52,612 km on arrival, 52,600 km at departure.",
  );
  const anchor = { date: "2026-11-10", km: 52605 };
  assert.equal(
    answerOf(odo({ anchor: { date: "2026-11-10", km: 53000 } }), "odometer")?.sentence,
    "The odometer went down: 52,612 km now, after 53,000 km on the trip of 10 Nov.",
  );
  const chained = odo({ anchor, paidKmSinceAnchor: 360 });
  assert.equal(answerOf(chained, "odometer")?.answer, "fail");
  assert.equal(
    judgeClaim(chained).reason,
    "The odometer moved 7 km since the trip of 10 Nov, but 360 km of driving was paid between them.",
    "HEADLINE: claim 163, 7 km on the odometer after claim 162",
  );
  // The 90% line, both sides of it.
  const moved = (arrival: number) =>
    answerOf(odo({ anchor: { date: "2026-11-10", km: 50000 }, arrival: km(arrival), departure: null, paidKmSinceAnchor: 200 }), "odometer");
  assert.equal(moved(50180)?.answer, "pass");
  assert.equal(moved(50180)?.sentence, "180 km on the odometer since the trip of 10 Nov; 200 km of driving was paid between them.");
  assert.equal(moved(50179)?.answer, "fail");
  assert.equal(answerOf(odo({ anchor, paidKmSinceAnchor: null }), "odometer")?.sentence, "7 km on the odometer since the trip of 10 Nov.", "a distance unknown is not a shortfall");
  assert.equal(answerOf(odo({ arrival: { km: null, status: "unreadable" } }), "odometer")?.answer, "fail");
  assert.equal(answerOf(odo({ arrival: { km: null, status: "not_read" } }), "odometer")?.answer, "unknown", "the reader down is not the employee's fault");
  assert.equal(judgeClaim(odo({ arrival: { km: null, status: "not_read" } })).lane, "your_call");
  // The odometer outranks a photo finding; an idle day outranks the odometer.
  assert.match(judgeClaim({ ...chained, departure: { ...chained.departure, onFile: false } }).reason ?? "", /^The odometer moved 7 km/);
  assert.match(
    judgeClaim({ ...chained, fieldWork: { days: [day("2026-11-18", { visits: 0 })], homeDays: [], km: null } }).reason ?? "",
    /^No visit and no meeting/,
  );

  assert.equal(shortDay("2026-11-04"), "4 Nov");
  assert.equal(shortDay(null), "an unknown day");
}
