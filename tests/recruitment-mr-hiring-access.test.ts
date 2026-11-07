import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Who may do what in the Medical Rep workflow (owner's email, effective 8 November 2026, and his
// answers of 7 November): HR screens and holds the 1st interview; the DSM who held the 2nd records its
// feedback, or HR decides once it has ended without any; the NSM writes the recommendation; the final
// decision is the HR Manager's ALONE; and the NSM's proposed salary is seen only by the HR Manager,
// Talent Acquisition and the NSM who wrote it — stripped on the server for everyone else.

import {
  canSeeSalary,
  mayRecommend,
  mayRecordStep,
  mrViewer,
  readsJourneyWithoutLookup,
  redactFactsFor,
} from "../src/lib/recruitment/mr-hiring/access.ts";
import type { MrCandidateRecord } from "../src/lib/recruitment/mr-hiring/facts-db.ts";
import { buildMrRow } from "../src/lib/recruitment/mr-hiring/rows.ts";
import type { MrBookingFact, MrCandidateFacts, MrStepResultFact } from "../src/lib/recruitment/mr-hiring/stage.ts";
import type { MrInterviewRound, MrResult, MrResultStep } from "../src/lib/recruitment/mr-hiring/vocabulary.ts";
import { stripComments } from "./support/comment-strip.ts";

const codeOnly = (path: string) => stripComments(readFileSync(path, "utf8"));

const NOW = new Date("2026-11-12T12:00:00.000Z");

const hrManager = mrViewer({ hrId: "B-10", role: "Super Admin" });
const talent = mrViewer({ hrId: "T-1", role: "HR Resourcing" });
const ceo = mrViewer({ hrId: "C-1", role: "CEO" });
const dsm = mrViewer({ hrId: "D-1", role: "District Manager" });
const otherDsm = mrViewer({ hrId: "D-9", role: "District Manager" });
const nsm = mrViewer({ hrId: "N-1", role: "National Sales Manager" });
const otherNsm = mrViewer({ hrId: "N-2", role: "National Sales Manager" });
const rsm = mrViewer({ hrId: "R-1", role: "Regional Manager" });
const otherRsm = mrViewer({ hrId: "R-2", role: "Regional Manager" });

let seq = 0;
function booking(round: MrInterviewRound, startsAt: string, interviewerHrId: string, panelistHrIds: string[] = []): MrBookingFact {
  seq += 1;
  return { durationMinutes: 30, id: `b-${seq}`, interviewerHrId, interviewerName: null, location: null, outcome: null, panelistHrIds, platform: "zoom", round, startsAt, zoomJoinUrl: null };
}

function result(step: MrResultStep, value: MrResult, createdAt: string): MrStepResultFact {
  seq += 1;
  return { bookingId: null, byHrId: "B-10", byName: null, comment: "Written on the CV.", createdAt, decidedWithoutDsm: false, id: `r-${seq}`, rating: null, result: value, step };
}

function facts(overrides: Partial<MrCandidateFacts> = {}): MrCandidateFacts {
  return {
    bookings: [],
    candidateId: "22222222-2222-4222-8222-222222222222",
    offer: null,
    onOfficialLine: true,
    receivedAt: "2026-11-08T08:00:00.000Z",
    recommendations: [],
    results: [],
    status: "new",
    ...overrides,
  };
}

const screenedAndFirst = [result("hr_screening", "pass", "2026-11-08T09:00:00.000Z"), result("hr_first", "pass", "2026-11-09T09:00:00.000Z")];
const firstBooking = booking("hr_first", "2026-11-09T08:00:00.000Z", "T-1");

function record(candidateFacts: MrCandidateFacts, extra: Partial<MrCandidateRecord> = {}): MrCandidateRecord {
  return {
    area: "Giza (1)",
    bookingPeople: candidateFacts.bookings.map((item) => ({ bookingId: item.id, hrIds: [item.interviewerHrId ?? "", ...item.panelistHrIds].filter(Boolean), round: item.round })),
    facts: candidateFacts,
    governorate: "Giza",
    intake: [],
    name: "Dr Karim Fathy",
    offerId: null,
    sentToHrId: null,
    sentToName: null,
    source: "whatsapp",
    ...extra,
  };
}

export function runRecruitmentMrHiringAccessTests() {
  // The seats.
  assert.ok(hrManager.isHrManager && hrManager.canWork && hrManager.readsAll, "the Super Admin is the HR Manager");
  assert.ok(talent.isTalentAcquisition && talent.canWork && !talent.isHrManager, "Talent Acquisition works the CVs but is not the HR Manager");
  assert.ok(ceo.readsAll && !ceo.canWork, "the CEO reads every candidate and works none");
  assert.ok(!dsm.readsAll && !dsm.canWork, "a DSM reads only the candidates he is involved with");
  // The page's own gate, called for both HR seats (tests/hr-seat-route-coherence.test.ts records it).
  const hrOperations = mrViewer({ hrId: "O-1", role: "HR Operations" });
  assert.ok(talent.readsAll, "HR Resourcing opens the Medical Rep Hiring page");
  assert.ok(!hrOperations.readsAll && !hrOperations.canWork && !hrOperations.isTalentAcquisition, "HR Operations reads and works nothing in it");
  assert.equal(canSeeSalary(hrOperations, { byHrId: "N-1" }), false, "and never sees the salary");

  // 1 — screening is HR's.
  const fresh = facts();
  assert.equal(mayRecordStep(talent, fresh, "hr_screening", { now: NOW }).ok, true, "Talent Acquisition screens");
  assert.equal(mayRecordStep(ceo, fresh, "hr_screening", { now: NOW }).ok, false, "the CEO never records a step");
  assert.equal(mayRecordStep(dsm, fresh, "hr_screening", { now: NOW }).ok, false, "a DSM does not screen");
  assert.equal(mayRecordStep(talent, fresh, "dsm", { now: NOW }).ok, false, "nobody records a step the candidate is not on");

  // 3 — the DSM's feedback: the DSM on the interview, once it has ended.
  const dsmRunning = facts({ bookings: [firstBooking, booking("dsm", "2026-11-12T11:45:00.000Z", "D-1")], results: screenedAndFirst });
  const dsmEnded = facts({ bookings: [firstBooking, booking("dsm", "2026-11-10T08:00:00.000Z", "D-1")], results: screenedAndFirst });
  assert.equal(mayRecordStep(dsm, dsmEnded, "dsm", { now: NOW }).ok, true, "the DSM who held the interview records its feedback");
  assert.equal(mayRecordStep(dsm, dsmRunning, "dsm", { now: NOW }).ok, false, "not before the interview has ended");
  assert.equal(mayRecordStep(otherDsm, dsmEnded, "dsm", { now: NOW }).ok, false, "another DSM may not");
  assert.equal(mayRecordStep(talent, dsmEnded, "dsm", { now: NOW }).ok, false, "HR does not write the DSM's feedback for him");
  // §6 — HR decides without it, but only once the interview has ended, and only HR.
  const noDsm = mayRecordStep(talent, dsmEnded, "dsm", { decidedWithoutDsm: true, now: NOW });
  assert.ok(noDsm.ok && noDsm.decidedWithoutDsm, "HR may decide with no DSM feedback once the interview has ended");
  assert.equal(mayRecordStep(talent, dsmRunning, "dsm", { decidedWithoutDsm: true, now: NOW }).ok, false, "never while the DSM interview is still to happen");
  assert.equal(mayRecordStep(ceo, dsmEnded, "dsm", { decidedWithoutDsm: true, now: NOW }).ok, false, "the CEO may not decide without the DSM");
  const dsmAnswered = facts({ bookings: dsmEnded.bookings, results: [...screenedAndFirst, result("dsm", "backup", "2026-11-10T09:00:00.000Z")] });
  assert.equal(mayRecordStep(talent, dsmAnswered, "dsm", { decidedWithoutDsm: true, now: NOW }).ok, false, "once the DSM has answered, HR does not overrule him through the no-feedback path");

  // 5 and 6 — the NSM's final and recommendation.
  const dsmPassed = [...screenedAndFirst, result("dsm", "pass", "2026-11-10T09:00:00.000Z")];

  // The RSM interview (Pedia line, if applicable): "the RSM ... must submit their evaluation in the system".
  const rsmEnded = facts({
    bookings: [firstBooking, booking("dsm", "2026-11-10T08:00:00.000Z", "D-1"), booking("rsm", "2026-11-11T08:00:00.000Z", "R-1")],
    results: dsmPassed,
  });
  const rsmRunning = facts({
    bookings: [firstBooking, booking("dsm", "2026-11-10T08:00:00.000Z", "D-1"), booking("rsm", "2026-11-12T11:45:00.000Z", "R-1")],
    results: dsmPassed,
  });
  assert.equal(mayRecordStep(rsm, rsmEnded, "rsm", { now: NOW }).ok, true, "the RSM who held the interview submits the evaluation");
  assert.equal(mayRecordStep(rsm, rsmRunning, "rsm", { now: NOW }).ok, false, "not before the interview has ended");
  assert.equal(mayRecordStep(otherRsm, rsmEnded, "rsm", { now: NOW }).ok, false, "another RSM may not");
  assert.equal(mayRecordStep(dsm, rsmEnded, "rsm", { now: NOW }).ok, false, "nor the DSM");
  assert.equal(mayRecordStep(talent, rsmEnded, "rsm", { now: NOW }).ok, false, "Talent Acquisition does not write the RSM's evaluation");
  assert.equal(mayRecordStep(ceo, rsmEnded, "rsm", { now: NOW }).ok, false, "nor the CEO");
  assert.equal(mayRecordStep(talent, rsmEnded, "rsm", { decidedWithoutDsm: true, now: NOW }).ok, false, "the no-feedback path is the DSM's step only");
  assert.equal(mayRecordStep(rsm, rsmEnded, "hr_manager", { now: NOW }).ok, false, "the 3rd interview waits until the RSM has evaluated");
  const rsmRow = buildMrRow(rsm, record(rsmEnded), NOW);
  assert.equal(rsmRow.can.record, "rsm", "the RSM's row offers the evaluation");
  assert.deepEqual(rsmRow.can.book, [], "and no booking — HR books");
  assert.equal(readsJourneyWithoutLookup(rsm, record(rsmEnded)), true, "the RSM on the interview reads the journey");
  const atThird = facts({ bookings: [firstBooking, booking("dsm", "2026-11-10T08:00:00.000Z", "D-1")], results: dsmPassed });
  assert.deepEqual(
    buildMrRow(talent, record(atThird), NOW).can.book,
    ["hr_manager", "joint_final", "rsm"],
    "after the DSM, HR may book the 3rd interview, the joint final or the RSM's — the 3rd interview first, so the page's button books it",
  );
  const finalEnded = facts({
    bookings: [firstBooking, booking("dsm", "2026-11-10T08:00:00.000Z", "D-1"), booking("joint_final", "2026-11-11T08:00:00.000Z", "N-1", ["B-10"])],
    results: dsmPassed,
  });
  assert.equal(mayRecordStep(nsm, finalEnded, "joint_final", { now: NOW }).ok, true, "the NSM records the joint final");
  assert.equal(mayRecordStep(hrManager, finalEnded, "joint_final", { now: NOW }).ok, true, "and so does the HR Manager on it");
  assert.equal(mayRecordStep(otherNsm, finalEnded, "joint_final", { now: NOW }).ok, false, "another NSM may not");
  assert.equal(mayRecordStep(nsm, finalEnded, "nsm_final", { now: NOW }).ok, false, "the result goes under the kind of final that was booked");

  const atRecommendation = facts({ ...finalEnded, results: [...dsmPassed, result("joint_final", "pass", "2026-11-11T09:00:00.000Z")] });
  assert.equal(mayRecommend(nsm, atRecommendation, NOW).ok, true, "the NSM who held the final writes the recommendation");
  assert.equal(mayRecommend(dsm, atRecommendation, NOW).ok, false, "the DSM does not");
  assert.equal(mayRecommend(otherNsm, atRecommendation, NOW).ok, false, "another NSM does not");
  assert.equal(mayRecommend(nsm, finalEnded, NOW).ok, false, "not before the final has passed");

  // 7 — the final decision belongs to the HR Manager alone (owner, 7 Nov 2026).
  const atDecision = facts({
    ...atRecommendation,
    recommendations: [
      { bookingId: null, byHrId: "N-1", byName: "Sara Nabil", createdAt: "2026-11-11T10:00:00.000Z", id: "rec-1", note: null, proposedJoiningDate: "2026-12-01", proposedSalary: 15000, recommendation: "make_offer" },
    ],
  });
  assert.equal(mayRecordStep(hrManager, atDecision, "final_decision", { now: NOW }).ok, true, "the HR Manager makes the final decision");
  for (const [name, viewer] of [["Talent Acquisition", talent], ["the NSM", nsm], ["the CEO", ceo], ["the DSM", dsm]] as const) {
    assert.equal(mayRecordStep(viewer, atDecision, "final_decision", { now: NOW }).ok, false, `${name} never makes the final decision`);
  }

  // §10 + the owner's salary answer — stripped on the server for everyone but three.
  const salaryFor = (viewer: typeof hrManager) => redactFactsFor(viewer, atDecision).recommendations[0]?.proposedSalary ?? null;
  assert.equal(salaryFor(hrManager), 15000, "the HR Manager sees the proposed salary");
  assert.equal(salaryFor(talent), 15000, "Talent Acquisition sees it");
  assert.equal(salaryFor(nsm), 15000, "the NSM who wrote it sees it");
  assert.equal(salaryFor(mrViewer({ hrId: "n-1", role: "National Sales Manager" })), 15000, "his own HR id in another case is still his");
  assert.equal(salaryFor(dsm), null, "the DSM never receives it");
  assert.equal(salaryFor(ceo), null, "the CEO never receives it");
  assert.equal(salaryFor(otherNsm), null, "another NSM never receives it");
  assert.equal(atDecision.recommendations[0]?.proposedSalary, 15000, "redaction copies — the loaded record is left whole");
  assert.equal(canSeeSalary(otherDsm, { byHrId: "N-1" }), false, "an uninvolved manager may not see it");
  // The joining date is not money — everyone on the journey reads it.
  assert.equal(redactFactsFor(ceo, atDecision).recommendations[0]?.proposedJoiningDate, "2026-12-01", "the joining date stays visible");

  // The row a component receives: salary already gone, and only the buttons the route will accept.
  const ceoRow = buildMrRow(ceo, record(atDecision), NOW);
  assert.equal(ceoRow.recommendation?.proposedSalary ?? null, null, "the CEO's row carries no salary");
  assert.equal(ceoRow.can.record, null, "the CEO's row offers no result");
  assert.deepEqual(ceoRow.can.book, [], "the CEO's row offers no booking");
  const managerRow = buildMrRow(hrManager, record(atDecision), NOW);
  assert.equal(managerRow.can.record, "final_decision", "the HR Manager's row offers the decision");
  assert.equal(managerRow.recommendation?.proposedSalary, 15000, "and the salary he decides on");
  const talentRow = buildMrRow(talent, record(atDecision), NOW);
  assert.equal(talentRow.can.record, null, "Talent Acquisition's row never offers the decision");

  // Who may read the journey without a lookup: the three read-all seats, and anyone on an interview.
  const finalRecord = record(finalEnded);
  assert.equal(readsJourneyWithoutLookup(ceo, finalRecord), true, "the CEO reads every journey");
  assert.equal(readsJourneyWithoutLookup(dsm, finalRecord), true, "the DSM on an interview reads it");
  assert.equal(readsJourneyWithoutLookup(mrViewer({ hrId: "B-10", role: "District Manager" }), finalRecord), true, "a panel member reads it");
  assert.equal(readsJourneyWithoutLookup(otherDsm, finalRecord), false, "a manager on none of the interviews does not");
  assert.equal(readsJourneyWithoutLookup(otherDsm, record(finalEnded, { sentToHrId: "D-9" })), true, "the manager the CV was sent to does");
  assert.equal(readsJourneyWithoutLookup(mrViewer({ hrId: null, role: "District Manager" }), finalRecord), false, "nobody without an HR id");

  // The CV and the application, at every step and for everyone involved (owner, 7 Nov 2026: "the cv
  // and application must appear and be appearing in all steps for every one"). Read from the code with
  // comments removed, so a comment cannot pass it.
  const server = codeOnly("src/lib/recruitment/mr-hiring/server.ts");
  assert.match(
    server,
    /async function readableMrRecord\([\s\S]{0,300}mayReadMrJourney\(access, record\)[\s\S]{0,120}notFoundError\(/,
    "one gate: whoever may read the journey, and a not-found for anyone else",
  );
  assert.match(server, /export async function loadMrJourney\([\s\S]{0,160}await readableMrRecord\(access, candidateId\)/, "the journey passes it");
  assert.match(server, /export async function loadMrCvAndApplication\([\s\S]{0,160}await readableMrRecord\(access, candidateId\)/, "the CV and application pass the same gate");
  assert.match(server, /export async function loadMrCvFile\([\s\S]{0,160}await readableMrRecord\(access, candidateId\)/, "and so does each file");
  assert.match(server, /if \(!files\.some\(\(file\) => file\.id === fileId\)\) return null/, "a file that is not this candidate's is never served");
  assert.match(server, /phonesHidden: !mrViewer\(access\)\.readsAll/, "a manager reads the CV with the phone numbers masked; HR and the CEO in full");
  assert.equal(hrManager.readsAll && talent.readsAll && ceo.readsAll, true, "the HR Manager, Talent Acquisition and the CEO read the CV in full");
  assert.equal(dsm.readsAll || nsm.readsAll, false, "the DSM and the NSM read it masked");
  const route = codeOnly("app/api/recruitment/mr-hiring/[candidateId]/cv/route.ts");
  assert.match(route, /assertCandidateVisible\(access, candidateId\)[\s\S]*loadMrCvAndApplication\(access, candidateId\)[\s\S]*loadMrCvFile\(access, candidateId, fileId\)/, "the route asks the fence, then the gate");

  const sheet = codeOnly("src/components/recruitment/mr-hiring/mr-cv-application.tsx");
  assert.match(sheet, /redactPhones=\{state\.phonesHidden\}/, "the CV masks the phone numbers when the server says so");
  assert.match(sheet, /allowDownload=\{!state\.phonesHidden\}/, "and offers no download");
  assert.match(sheet, /state\.application\.map\(/, "the application lists every question and answer");
  const drawer = codeOnly("src/components/recruitment/mr-hiring/mr-journey-drawer.tsx");
  assert.match(drawer, /\{wide \? \(\s*<aside aria-label="CV and application"[\s\S]{0,300}<MrCvApplication candidateId=\{candidateId\} \/>/, "a wide screen shows the CV and application beside the journey");
  assert.match(drawer, /\{wide \? null : <MrCvApplication candidateId=\{candidateId\} \/>\}/, "a narrow one under the current step");
  const panel = codeOnly("src/components/recruitment/mr-hiring/mr-interviews-panel.tsx");
  assert.doesNotMatch(panel, /<MrResultForm|<MrRecommendationForm/, "a manager never writes feedback away from the CV");
  assert.match(panel, /initialAction=\{open\.action\}/, "the feedback and recommendation open in the journey, beside the CV");
}
