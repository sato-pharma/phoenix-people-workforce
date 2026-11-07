import assert from "node:assert/strict";

// The Medical Rep workflow's steps (owner's email, effective Sunday 8 November 2026): where a
// candidate is, what comes next and who it waits for. The stage is DERIVED from the bookings, results,
// recommendation and offer — never stored — so these walk one candidate through every step.

import { mrBookingRefusal } from "../src/lib/recruitment/mr-hiring/rows.ts";
import {
  isHeldOffChannel,
  mrHiringStage,
  mrStageCounts,
  type MrBookingFact,
  type MrCandidateFacts,
  type MrRecommendationFact,
  type MrStepResultFact,
} from "../src/lib/recruitment/mr-hiring/stage.ts";
import { mrStageHeadline, mrStageStateLine } from "../src/lib/recruitment/mr-hiring/display.ts";
import type { MrInterviewRound, MrResult, MrResultStep } from "../src/lib/recruitment/mr-hiring/vocabulary.ts";

const NOW = new Date("2026-11-12T12:00:00.000Z");

function facts(overrides: Partial<MrCandidateFacts> = {}): MrCandidateFacts {
  return {
    bookings: [],
    candidateId: "11111111-1111-4111-8111-111111111111",
    offer: null,
    onOfficialLine: true,
    receivedAt: "2026-11-08T08:00:00.000Z",
    recommendations: [],
    results: [],
    status: "new",
    ...overrides,
  };
}

let seq = 0;
function booking(round: MrInterviewRound, startsAt: string, interviewerHrId = "D-1", interviewerName = "Ahmed Ali"): MrBookingFact {
  seq += 1;
  return {
    durationMinutes: 30,
    id: `b-${seq}`,
    interviewerHrId,
    interviewerName,
    location: null,
    outcome: null,
    panelistHrIds: [],
    platform: "zoom",
    round,
    startsAt,
    zoomJoinUrl: null,
  };
}

function result(step: MrResultStep, value: MrResult, createdAt: string, extra: Partial<MrStepResultFact> = {}): MrStepResultFact {
  seq += 1;
  return {
    bookingId: null,
    byHrId: "B-10",
    byName: "Omar Gawish",
    comment: "Clear and confident.",
    createdAt,
    decidedWithoutDsm: false,
    id: `r-${seq}`,
    rating: 4,
    result: value,
    step,
    ...extra,
  };
}

function recommendation(createdAt: string): MrRecommendationFact {
  return {
    bookingId: null,
    byHrId: "N-1",
    byName: "Sara Nabil",
    createdAt,
    id: "rec-1",
    note: null,
    proposedJoiningDate: "2026-12-01",
    proposedSalary: 15000,
    recommendation: "make_offer",
  };
}

// A candidate through the DSM, passed — the base for the later steps.
const throughDsm = (): Partial<MrCandidateFacts> => ({
  bookings: [booking("hr_first", "2026-11-09T08:00:00.000Z", "T-1", "Mona HR"), booking("dsm", "2026-11-10T08:00:00.000Z")],
  results: [
    result("hr_screening", "pass", "2026-11-08T09:00:00.000Z"),
    result("hr_first", "pass", "2026-11-09T09:00:00.000Z"),
    result("dsm", "pass", "2026-11-10T09:00:00.000Z", { byHrId: "D-1" }),
  ],
});

export function runRecruitmentMrHiringStageTests() {
  // 1 — a new CV on a company WhatsApp waits for HR's screening.
  const fresh = mrHiringStage(facts(), NOW);
  assert.ok(fresh.open && fresh.step === "screening" && fresh.state === "to_record" && fresh.action === "record_screening", "a new CV waits for HR screening");
  assert.equal(mrStageHeadline(fresh), "Step 1 of 9 · New CV · HR screening", "the headline numbers the step in the email's own words");

  // §2 — held: from 8 Nov 00:00 Cairo (22:00 UTC on the 7th) a CV that reached no company WhatsApp.
  assert.equal(isHeldOffChannel({ onOfficialLine: false, receivedAt: "2026-11-07T22:00:00.000Z" }), true, "midnight Cairo on 8 Nov is inside the workflow");
  assert.equal(isHeldOffChannel({ onOfficialLine: false, receivedAt: "2026-11-07T21:59:59.000Z" }), false, "a CV from before the start is never held");
  assert.equal(isHeldOffChannel({ onOfficialLine: true, receivedAt: "2026-11-09T10:00:00.000Z" }), false, "a CV on either company line is never held");
  const held = mrHiringStage(facts({ onOfficialLine: false }), NOW);
  assert.ok(!held.open && held.closed === "held", "a CV from email, the website or by hand after the start is held");
  assert.match(mrStageStateLine(held), /company WhatsApp/, "the held line says why in plain words");
  assert.match(mrBookingRefusal(held, "hr_first") ?? "", /held/, "a held CV cannot be booked");

  // 2 — screening passed: book the 1st interview. Booking it from the screening step counts as passing.
  const screened = mrHiringStage(facts({ results: [result("hr_screening", "pass", "2026-11-08T09:00:00.000Z")] }), NOW);
  assert.ok(screened.open && screened.step === "hr_first" && screened.state === "to_book" && screened.action === "book_hr_first", "after screening, the 1st interview is booked");
  assert.equal(mrBookingRefusal(fresh, "hr_first"), null, "booking the 1st interview from screening is allowed");
  assert.notEqual(mrBookingRefusal(fresh, "dsm"), null, "the DSM interview is never booked before the 1st");
  const screenedRejected = mrHiringStage(facts({ results: [result("hr_screening", "not_pass", "2026-11-08T09:00:00.000Z")] }), NOW);
  assert.ok(!screenedRejected.open && screenedRejected.closed === "rejected" && screenedRejected.closedAt === "screening", "Do not pass at screening rejects there");

  // The 1st interview: booked (in the future), then waiting for HR's result once it has ended.
  const firstFuture = mrHiringStage(facts({ bookings: [booking("hr_first", "2026-11-13T08:00:00.000Z", "T-1")] }), NOW);
  assert.ok(firstFuture.open && firstFuture.step === "hr_first" && firstFuture.state === "booked" && firstFuture.waitingFor.kind === "interview", "a future interview reads as booked");
  const firstEnded = mrHiringStage(facts({ bookings: [booking("hr_first", "2026-11-12T11:00:00.000Z", "T-1")] }), NOW);
  assert.ok(firstEnded.open && firstEnded.state === "awaiting_result" && firstEnded.waitingFor.kind === "hr", "an ended 1st interview waits for HR's result");
  assert.match(mrBookingRefusal(firstEnded, "hr_first") ?? "", /already has an interview/, "a step with an interview is not booked twice");

  // 3 — the DSM: booked, and once it has ended with no feedback, HR may decide without it (§6).
  const dsmBooked = mrHiringStage(
    facts({
      bookings: [booking("hr_first", "2026-11-09T08:00:00.000Z", "T-1"), booking("dsm", "2026-11-12T11:45:00.000Z")],
      results: [result("hr_screening", "pass", "2026-11-08T09:00:00.000Z"), result("hr_first", "pass", "2026-11-09T09:00:00.000Z")],
    }),
    NOW,
  );
  assert.ok(dsmBooked.open && dsmBooked.step === "dsm" && dsmBooked.state === "booked", "the DSM interview is still running at 12:00");
  assert.equal(dsmBooked.open && dsmBooked.hrMayDecideWithoutDsm, false, "HR may NOT decide without the DSM before the interview has ended");
  const dsmSilent = mrHiringStage(
    facts({
      bookings: [booking("hr_first", "2026-11-09T08:00:00.000Z", "T-1"), booking("dsm", "2026-11-10T08:00:00.000Z")],
      results: [result("hr_screening", "pass", "2026-11-08T09:00:00.000Z"), result("hr_first", "pass", "2026-11-09T09:00:00.000Z")],
    }),
    NOW,
  );
  assert.ok(dsmSilent.open && dsmSilent.state === "awaiting_result" && dsmSilent.hrMayDecideWithoutDsm, "an ended DSM interview with no feedback lets HR decide — any time after it ended");
  assert.ok(dsmSilent.open && dsmSilent.waitingFor.kind === "interviewer" && dsmSilent.waitingFor.name === "Ahmed Ali", "it waits for the DSM by name");
  assert.equal(mrStageStateLine(dsmSilent), "Waiting for Ahmed Ali's feedback since 10 Nov", "the state line names the DSM and the day");

  const dsmFailed = mrHiringStage(
    facts({
      ...throughDsm(),
      results: [...throughDsm().results!.slice(0, 2), result("dsm", "not_pass", "2026-11-10T09:00:00.000Z")],
    }),
    NOW,
  );
  assert.ok(!dsmFailed.open && dsmFailed.closed === "rejected" && dsmFailed.closedAt === "dsm", "Do not pass at the DSM rejects at the DSM");

  // 4 and 5 — the 3rd interview, then the NSM final.
  const atHrManager = mrHiringStage(facts(throughDsm()), NOW);
  assert.ok(atHrManager.open && atHrManager.step === "hr_manager" && atHrManager.action === "book_hr_manager", "after the DSM, the HR Manager's 3rd interview");
  assert.equal(mrBookingRefusal(atHrManager, "joint_final"), null, "§7's joint final may be booked instead of the 3rd interview");
  assert.equal(mrBookingRefusal(atHrManager, "hr_manager"), null, "or the 3rd interview itself");
  assert.notEqual(mrBookingRefusal(atHrManager, "nsm_final"), null, "the NSM final waits for the 3rd interview");

  // The RSM interview — "If Applicable" (the Pedia line), owner's added section of 7 Nov 2026. With
  // none booked it is not needed and the candidate goes on to the 3rd interview; HR books it from there.
  assert.equal(atHrManager.checklist.find((item) => item.step === "rsm")?.status, "skipped", "no RSM interview booked → the RSM step is not needed");
  assert.equal(mrBookingRefusal(atHrManager, "rsm"), null, "after the DSM passes, HR may book the RSM interview");
  assert.notEqual(mrBookingRefusal(dsmSilent, "rsm"), null, "never before the DSM has passed");
  assert.notEqual(mrBookingRefusal(fresh, "rsm"), null, "nor at screening");
  const rsmBooked = mrHiringStage(facts({ ...throughDsm(), bookings: [...throughDsm().bookings!, booking("rsm", "2026-11-13T08:00:00.000Z", "R-1", "Hany Fouad")] }), NOW);
  assert.ok(rsmBooked.open && rsmBooked.step === "rsm" && rsmBooked.state === "booked", "once booked, the RSM interview is the step the candidate is on");
  assert.equal(mrStageHeadline(rsmBooked), "Step 4 of 9 · RSM interview · Pedia line", "it is step 4, between the DSM and the HR Manager");
  assert.match(mrBookingRefusal(rsmBooked, "hr_manager") ?? "", /already has an interview/, "the 3rd interview waits for the RSM's evaluation");
  const rsmEnded = mrHiringStage(facts({ ...throughDsm(), bookings: [...throughDsm().bookings!, booking("rsm", "2026-11-11T08:00:00.000Z", "R-1", "Hany Fouad")] }), NOW);
  assert.ok(rsmEnded.open && rsmEnded.state === "awaiting_result" && rsmEnded.action === "record_rsm", "an ended RSM interview waits for the RSM's evaluation — it is mandatory once booked");
  assert.ok(rsmEnded.open && rsmEnded.waitingFor.kind === "interviewer" && rsmEnded.waitingFor.hrId === "R-1", "it waits for the RSM who held it");
  assert.equal(mrStageStateLine(rsmEnded), "Waiting for Hany Fouad's evaluation since 11 Nov", "the state line says evaluation, in the email's word");
  assert.equal(rsmEnded.open && rsmEnded.hrMayDecideWithoutDsm, false, "HR's no-feedback decision is the DSM's step only");
  const rsmPassed = mrHiringStage(
    facts({
      ...throughDsm(),
      bookings: [...throughDsm().bookings!, booking("rsm", "2026-11-11T08:00:00.000Z", "R-1", "Hany Fouad")],
      results: [...throughDsm().results!, result("rsm", "pass", "2026-11-11T09:00:00.000Z", { byHrId: "R-1" })],
    }),
    NOW,
  );
  assert.ok(rsmPassed.open && rsmPassed.step === "hr_manager" && rsmPassed.action === "book_hr_manager", "a passed RSM interview goes on to the 3rd interview");
  assert.equal(rsmPassed.checklist.find((item) => item.step === "rsm")?.status, "done", "and shows as done, with its result");
  assert.notEqual(mrBookingRefusal(rsmPassed, "rsm"), null, "an RSM interview already evaluated is not booked again");
  const rsmFailed = mrHiringStage(
    facts({
      ...throughDsm(),
      bookings: [...throughDsm().bookings!, booking("rsm", "2026-11-11T08:00:00.000Z", "R-1", "Hany Fouad")],
      results: [...throughDsm().results!, result("rsm", "not_pass", "2026-11-11T09:00:00.000Z", { byHrId: "R-1" })],
    }),
    NOW,
  );
  assert.ok(!rsmFailed.open && rsmFailed.closed === "rejected" && rsmFailed.closedAt === "rsm", "Do not pass at the RSM rejects at the RSM");
  const hrManagerBooked = mrHiringStage(facts({ ...throughDsm(), bookings: [...throughDsm().bookings!, booking("hr_manager", "2026-11-13T08:00:00.000Z", "B-10", "Omar Gawish")] }), NOW);
  assert.notEqual(mrBookingRefusal(hrManagerBooked, "rsm"), null, "once the 3rd interview is booked, the RSM interview is no longer offered");

  const base = throughDsm();
  const atRecommendation = mrHiringStage(
    facts({
      bookings: [...base.bookings!, booking("hr_manager", "2026-11-11T08:00:00.000Z", "B-10", "Omar Gawish"), booking("nsm_final", "2026-11-11T10:00:00.000Z", "N-1", "Sara Nabil")],
      results: [...base.results!, result("hr_manager", "pass", "2026-11-11T09:00:00.000Z"), result("nsm_final", "pass", "2026-11-11T11:00:00.000Z", { byHrId: "N-1" })],
    }),
    NOW,
  );
  assert.ok(atRecommendation.open && atRecommendation.step === "recommendation" && atRecommendation.state === "awaiting_recommendation", "after the final, the NSM's recommendation (§8)");
  assert.ok(atRecommendation.open && atRecommendation.waitingFor.kind === "interviewer" && atRecommendation.waitingFor.name === "Sara Nabil", "it waits for the NSM who held the final");

  // The joint final replaces both the 3rd interview and the NSM final.
  const joint = mrHiringStage(
    facts({
      bookings: [...base.bookings!, booking("joint_final", "2026-11-11T08:00:00.000Z", "N-1", "Sara Nabil")],
      results: [...base.results!, result("joint_final", "pass", "2026-11-11T09:00:00.000Z")],
    }),
    NOW,
  );
  assert.ok(joint.open && joint.jointFinal && joint.step === "recommendation", "a passed joint final goes straight to the recommendation");
  assert.equal(mrStageHeadline(dsmSilent), "Step 3 of 9 · 2nd interview · DSM", "the DSM is step 3 of 9");
  assert.equal(joint.checklist.find((item) => item.step === "hr_manager")?.status, "skipped", "the 3rd interview shows as skipped, not missing");

  // 7 — the HR Manager's decision, then 8 — the offer.
  const withRec = {
    bookings: [...base.bookings!, booking("joint_final", "2026-11-11T08:00:00.000Z", "N-1", "Sara Nabil")],
    recommendations: [recommendation("2026-11-11T12:00:00.000Z")],
    results: [...base.results!, result("joint_final", "pass", "2026-11-11T09:00:00.000Z")],
  };
  const atDecision = mrHiringStage(facts(withRec), NOW);
  assert.ok(atDecision.open && atDecision.step === "decision" && atDecision.waitingFor.kind === "hr_manager", "the final decision waits for the HR Manager alone (§9)");
  const decided = { ...withRec, results: [...withRec.results, result("final_decision", "pass", "2026-11-11T13:00:00.000Z")] };
  const toOffer = mrHiringStage(facts(decided), NOW);
  assert.ok(toOffer.open && toOffer.step === "offer" && toOffer.action === "prepare_offer", "Make an offer → prepare the offer");
  const kept = mrHiringStage(facts({ ...withRec, results: [...withRec.results, result("final_decision", "backup", "2026-11-11T13:00:00.000Z")] }), NOW);
  assert.ok(!kept.open && kept.closed === "backup" && kept.closedAt === "decision", "Keep as backup at the decision closes as backup");

  const offer = (status: "draft" | "sent" | "accepted" | "declined" | "withdrawn", validUntil: string | null = null) =>
    mrHiringStage(facts({ ...decided, offer: { id: "o-1", issuedOn: "2026-11-11", startDate: "2026-12-01", status, validUntil } }), NOW);
  assert.ok(offer("draft").open && (offer("draft") as { state: string }).state === "offer_draft", "a drafted offer is not sent yet");
  assert.equal((offer("sent", "2026-11-20") as { state: string }).state, "offer_sent", "a sent offer within its validity waits for the candidate");
  assert.equal((offer("sent", "2026-11-11") as { state: string }).state, "offer_expired", "a sent offer past its last valid day reads as expired — shown only");
  assert.equal((offer("accepted") as { action: string }).action, "mark_hired", "an accepted offer is marked hired through the existing door");
  assert.equal((offer("withdrawn") as { state: string }).state, "to_prepare_offer", "a withdrawn offer is prepared again");
  const hired = mrHiringStage(facts({ ...decided, status: "hired" }), NOW);
  assert.ok(!hired.open && hired.closed === "hired", "a hire is final");

  // The workspace's own reject closes the candidate wherever they were.
  const rejectedInWorkspace = mrHiringStage(facts({ ...throughDsm(), status: "rejected" }), NOW);
  assert.ok(!rejectedInWorkspace.open && rejectedInWorkspace.closed === "rejected" && rejectedInWorkspace.closedAt === "hr_manager", "a reject made elsewhere closes at the step they were on");

  // The counts strip adds every candidate exactly once.
  const counts = mrStageCounts([fresh, held, screened, hired, kept]);
  assert.equal(counts.screening, 1, "one at screening");
  assert.equal(counts.hr_first, 1, "one at the 1st interview");
  assert.equal(counts.held + counts.hired + counts.backup, 3, "the closed piles count the rest");
}
