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
 *   6. A meeting or other cost is not a trip: two checks only, and it is never Ready.
 *   7. The pre-cut: the per-idle-day share of the allowance, never travel or tickets.
 */
import assert from "node:assert/strict";

import {
  CHECK_LABEL,
  claimPreCut,
  DEPARTURE_MAX_KM_FROM_ARRIVAL,
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
  assert.equal(upload("2026-11-18")?.answer, "pass");
  assert.equal(upload("2026-11-02")?.answer, "fail");
  assert.equal(upload(null)?.answer, "unknown");

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
  // A failure outranks a "could not check".
  const mixed = judgeClaim(facts({ departure: { ...facts().departure, onFile: false }, eligibilityStatus: "manual" }));
  assert.equal(mixed.reason, "No departure photo.");

  // 6. A meeting or other cost.
  assert.equal(isTripClaim("meeting"), false);
  assert.equal(isTripClaim("other"), false);
  assert.equal(isTripClaim("traveling"), true);
  const invoice = judgeClaim(facts({ attachments: 1, expenseType: "meeting" }));
  assert.deepEqual(invoice.checks.map((entry) => entry.key), ["duplicate", "amounts"]);
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

  assert.equal(shortDay("2026-11-04"), "4 Nov");
  assert.equal(shortDay(null), "an unknown day");
}
