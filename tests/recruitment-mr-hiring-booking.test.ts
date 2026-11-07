import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Booking a Medical Rep interview (owner's email, effective 8 November 2026):
//   §3 — the 1st interview is in person for a candidate in Cairo or Giza, on Zoom for anyone else;
//   §4 — booking the DSM's interview sends him the CV through Phoenix and notifies him;
//   §5 — every interview carries its Zoom link or its date, time and location;
//   RSM (Pedia line, if applicable) — "The RSM will receive the interview details through Phoenix".
// And the notices themselves: never email, never the candidate, and each person lands on the screen
// where they act on it.

import { interviewLocationLabel, interviewRoundValue, phoneCallRefusal } from "../src/lib/recruitment/interview-calendar.ts";
import { PLATFORM_LABEL, isHrInterviewerTitle, isInterviewPlatform, isSessionPlatform, mayConductInterview } from "../src/lib/recruitment/interview-calendar-types.ts";
import { isKnownMrArea, mrAreaChoicesFrom } from "../src/lib/recruitment/mr-hiring/areas.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { isCairoOrGiza, parseMrBookingInput, parseMrRecommendationInput, parseMrResultInput } from "../src/lib/recruitment/mr-hiring/inputs.ts";
import {
  MR_INTERVIEW_BOOKED_EVENT,
  MR_NOTICE_CHANNELS,
  MR_RECOMMENDATION_READY_EVENT,
  mrInterviewBookedMessage,
  mrInterviewNoticeHref,
} from "../src/lib/recruitment/mr-hiring/notify.ts";
import { stripComments } from "./support/comment-strip.ts";

const base = { dateKey: "2026-11-15", durationMinutes: 30, startMinutes: 11 * 60 };

const codeOnly = (path: string) => stripComments(readFileSync(path, "utf8"));

export function runRecruitmentMrHiringBookingTests() {
  // §3 — Cairo or Giza decides the place of the 1st interview, and HR confirms the answer.
  assert.equal(isCairoOrGiza("Cairo"), true, "Cairo is in person");
  assert.equal(isCairoOrGiza("Giza Governorate"), true, "Giza is in person, however it is spelled");
  assert.equal(isCairoOrGiza("الجيزة"), true, "and in Arabic");
  assert.equal(isCairoOrGiza("Alexandria"), false, "Alexandria is Zoom");
  assert.equal(isCairoOrGiza("Beni Suef"), false, "Beni Suef is Zoom even though the company's Giza region covers it");
  assert.equal(isCairoOrGiza(null), false, "no governorate is not Cairo or Giza");

  const inPerson = parseMrBookingInput({ ...base, inCairoOrGiza: true, location: "  Head office, 3rd floor ", round: "hr_first" });
  assert.equal(inPerson.platform, "in_office", "Cairo or Giza → in person");
  assert.equal(inPerson.location, "Head office, 3rd floor", "the place is kept, trimmed");
  const remote = parseMrBookingInput({ ...base, inCairoOrGiza: false, location: "Head office", platform: "in_office", round: "hr_first" });
  assert.equal(remote.platform, "zoom", "anywhere else → Zoom, whatever platform the request named");
  assert.equal(remote.location, null, "a Zoom interview keeps no place — its place is the link");
  assert.throws(() => parseMrBookingInput({ ...base, round: "hr_first" }), /Cairo or Giza/, "HR must answer the Cairo-or-Giza question");
  assert.equal(parseMrBookingInput({ ...base, inCairoOrGiza: false, round: "hr_first" }).interviewerHrId, null, "the 1st interview may leave the interviewer to the person booking it");

  // The 1st interview's third way — a phone call (owner, 7 Nov 2026: "only for hr first interview u
  // will add a third option which is phone call"). It needs no Cairo-or-Giza answer and keeps no place.
  const phone = parseMrBookingInput({ ...base, location: "Head office", platform: "phone", round: "hr_first" });
  assert.equal(phone.platform, "phone", "HR may hold the 1st interview as a phone call");
  assert.equal(phone.location, null, "a phone call keeps no place");
  // Its length is never asked (owner, 7 Nov 2026: "don't ask him to choose the length of the call").
  assert.equal(phone.durationMinutes, 30, "a phone call holds half an hour");
  assert.equal(parseMrBookingInput({ ...base, durationMinutes: 600, platform: "phone", round: "hr_first" }).durationMinutes, 30, "whatever length the request sent");
  assert.equal(parseMrBookingInput({ ...base, durationMinutes: 60, inCairoOrGiza: false, round: "hr_first" }).durationMinutes, 60, "a Zoom 1st interview keeps the length HR chose");
  const form = codeOnly("src/components/recruitment/mr-hiring/mr-forms.tsx");
  assert.match(form, /\{byPhone \? null : \(\s*<FormField htmlFor="mr-duration" label="Length">/, "the booking form hides the Length question for a phone call");
  assert.match(form, /durationMinutes: byPhone \? undefined : duration,/, "and sends no length for one");
  assert.equal(parseMrBookingInput({ ...base, inCairoOrGiza: true, platform: "phone", round: "hr_first" }).platform, "phone", "a phone call wins over the Cairo-or-Giza answer");
  assert.throws(() => parseMrBookingInput({ ...base, interviewerHrId: "D-1", platform: "phone", round: "dsm" }), /HR 1st interview only/, "the DSM's interview is never a phone call");
  assert.throws(() => parseMrBookingInput({ ...base, interviewerHrId: "R-1", platform: "phone", round: "rsm" }), /HR 1st interview only/, "nor the RSM's");
  assert.throws(() => parseMrBookingInput({ ...base, round: "hr_first" }), /or choose a phone call/, "the question offers the phone call too");
  // The calendar's own doors hold the same line, so no route books a phone call for another interview.
  assert.equal(phoneCallRefusal("phone", "hr_first"), null, "the calendar books a phone call for the 1st interview");
  assert.match(phoneCallRefusal("phone", null) ?? "", /HR 1st interview only/, "never for an ordinary interview");
  assert.match(phoneCallRefusal("phone", "nsm_final") ?? "", /HR 1st interview only/, "nor a later round");
  assert.equal(phoneCallRefusal("zoom", null), null, "Zoom and in person stay open to every interview");
  assert.equal(isInterviewPlatform("phone"), true, "a booking may be a phone call");
  assert.equal(isSessionPlatform("phone"), false, "a session — one meeting for many — never is");
  assert.equal(PLATFORM_LABEL.phone, "Phone call", "and it reads as a phone call");
  const calendar = codeOnly("src/lib/recruitment/interview-calendar.ts");
  assert.match(calendar, /const phoneRefused = phoneCallRefusal\(input\.platform, interviewRound\);\s*if \(phoneRefused\) throw/, "a new booking is checked");
  assert.match(calendar, /phoneCallRefusal\(patch\.platform \?\? row\.platform, nextRound\);\s*if \(phoneRefused\) throw/, "and so is every move or change of round");

  // The 1st interview's result confirms the area and the line (owner, 7 Nov 2026). A pass needs both.
  const passed = parseMrResultInput({ comment: "Good.", confirmedArea: "  Nasr  City ", confirmedLine: "pedia", result: "pass", step: "hr_first" });
  assert.equal(passed.confirmedArea, "Nasr City", "the area is kept, its spaces folded");
  assert.equal(passed.confirmedLine, "pedia", "and the line");
  assert.throws(() => parseMrResultInput({ comment: "Good.", confirmedLine: "cns", result: "pass", step: "hr_first" }), /Confirm the area/, "a pass needs the area");
  assert.throws(() => parseMrResultInput({ comment: "Good.", confirmedArea: "Nasr City", result: "pass", step: "hr_first" }), /Confirm the line/, "and the line");
  assert.throws(() => parseMrResultInput({ comment: "Good.", confirmedArea: "Nasr City", confirmedLine: "oncology", result: "pass", step: "hr_first" }), /Pedia, Anti Infective or CNS/, "a line outside the three is refused");
  assert.equal(parseMrResultInput({ comment: "Not now.", result: "not_pass", step: "hr_first" }).confirmedLine, null, "a Do not pass needs neither");
  const dsmResult = parseMrResultInput({ comment: "Good.", confirmedArea: "Nasr City", confirmedLine: "pedia", result: "pass", step: "dsm" });
  assert.ok(dsmResult.confirmedArea === null && dsmResult.confirmedLine === null, "no other step carries either");
  const choices = mrAreaChoicesFrom({
    regions: [
      { areas: [{ name: "Nasr City" }, { name: "Maadi" }], name: "Cairo" },
      { areas: [], name: "Empty" },
    ],
  } as never);
  assert.deepEqual(choices, [{ areas: ["Nasr City", "Maadi"], region: "Cairo" }], "the areas come grouped by region, an empty region left out");
  assert.equal(isKnownMrArea(choices, " Nasr  City "), true, "an area on the list is accepted as the bot spells it");
  assert.equal(isKnownMrArea(choices, "Atlantis"), false, "an area off the list is refused");
  assert.equal(isKnownMrArea(choices, "  "), false, "and so is a blank one");
  const recordCode = codeOnly("src/lib/recruitment/mr-hiring/record.ts");
  assert.match(recordCode, /isKnownMrArea\(await loadMrAreaChoices\(\)/, "the server checks the area against the list before writing");

  // §5 — the other rounds may be either, and always name who conducts them.
  assert.throws(() => parseMrBookingInput({ ...base, platform: "zoom", round: "dsm" }), /who conducts/, "a DSM interview names the DSM");
  assert.equal(parseMrBookingInput({ ...base, interviewerHrId: "D-1", platform: "in_office", round: "dsm" }).platform, "in_office", "a DSM interview may be in person");
  assert.throws(() => parseMrBookingInput({ ...base, interviewerHrId: "D-1", round: "dsm" }), /In person or Zoom/, "and must say which");
  assert.throws(() => parseMrBookingInput({ ...base, inCairoOrGiza: true, round: "first" }), /round/, "an unknown round is refused");
  assert.throws(() => parseMrBookingInput({ ...base, durationMinutes: 600, inCairoOrGiza: true, round: "hr_first" }), /4 hours/, "an impossible length is refused");

  // The calendar's own validators for the two new columns: refused, never silently dropped.
  assert.equal(interviewRoundValue(undefined), null, "no round is an ordinary interview");
  assert.equal(interviewRoundValue("joint_final"), "joint_final", "the joint final is a round");
  assert.equal(interviewRoundValue("rsm"), "rsm", "the RSM interview is a round");
  assert.throws(() => interviewRoundValue("ceo_final"), /round/, "a round outside the six is refused");
  assert.equal(interviewLocationLabel("   "), null, "a blank place means the usual venue");
  assert.throws(() => interviewLocationLabel("x".repeat(301)), /300/, "a place over 300 characters is refused");

  // Who may conduct which round: the 1st is HR's own; every other keeps District Manager and above.
  assert.equal(isHrInterviewerTitle("Talent Acquisition Specialist"), true, "a Talent Acquisition title is HR");
  assert.equal(mayConductInterview({ jobTitle: "HR Specialist" }, "hr_first"), true, "an HR specialist conducts the 1st interview");
  assert.equal(mayConductInterview({ jobTitle: "HR Specialist" }, "dsm"), false, "but not the DSM's");
  assert.equal(mayConductInterview({ jobTitle: "HR Specialist" }, null), false, "nor an ordinary interview");
  assert.equal(mayConductInterview({ jobTitle: "District Manager" }, "dsm"), true, "a District Manager conducts the 2nd interview");
  assert.equal(mayConductInterview({ jobTitle: "Regional Manager" }, "rsm"), true, "a Regional Manager conducts the RSM interview");
  assert.equal(mayConductInterview({ jobTitle: "HR Specialist" }, "rsm"), false, "an HR specialist does not");
  assert.throws(() => parseMrBookingInput({ ...base, platform: "zoom", round: "rsm" }), /who conducts/, "an RSM interview names the RSM");
  assert.equal(parseMrBookingInput({ ...base, interviewerHrId: "R-1", platform: "zoom", round: "rsm" }).round, "rsm", "and is booked like the other rounds");

  // Every result carries a comment (the evaluation is written "on the candidate's CV").
  assert.throws(() => parseMrResultInput({ comment: "  ", result: "pass", step: "dsm" }), /comment/, "a result with no comment is refused");
  assert.throws(() => parseMrResultInput({ comment: "ok", decidedWithoutDsm: true, result: "pass", step: "hr_first" }), /DSM interview only/, "no-feedback applies to the DSM step only");
  assert.throws(() => parseMrResultInput({ comment: "ok", rating: 6, result: "pass", step: "dsm" }), /1 to 5/, "the rating is 1 to 5");
  // §8 — an offer recommendation names the salary and the joining date.
  assert.throws(() => parseMrRecommendationInput({ proposedSalary: "15000", recommendation: "make_offer" }), /joining date/, "an offer recommendation needs the joining date");
  assert.equal(parseMrRecommendationInput({ proposedJoiningDate: "2026-11-01", proposedSalary: 15000, recommendation: "make_offer" }).proposedJoiningDate, "2026-11-01", "a joining date already gone is taken — nothing is blocked to HR");
  assert.equal(parseMrRecommendationInput({ proposedJoiningDate: "2026-12-01", proposedSalary: "15,000", recommendation: "make_offer" }).proposedSalary, 15000, "a salary typed with a comma is read as the number");
  assert.equal(parseMrRecommendationInput({ recommendation: "keep_backup" }).proposedSalary, null, "keep as backup needs no salary");

  // The notices: never email, on their own policy rows so the `recruitment.*` email default never applies.
  assert.equal((MR_NOTICE_CHANNELS as readonly string[]).includes("email"), false, "the senders never ask for email");
  for (const eventType of [MR_INTERVIEW_BOOKED_EVENT, MR_RECOMMENDATION_READY_EVENT]) {
    const policy = resolveNotificationPolicy({ eventType, module: "recruitment" });
    assert.equal(policy.channels.includes("email"), false, `recruitment.${eventType} carries no email`);
    assert.equal(policy.channels.includes("in_app"), true, `recruitment.${eventType} reaches the bell`);
  }
  const message = mrInterviewBookedMessage({ candidateName: "Dr Karim Fathy", location: "Head office", platform: "in_office", round: "dsm", startsAt: "2026-11-15T09:00:00.000Z" });
  assert.match(message, /2nd interview · DSM with Dr Karim Fathy, Medical Representative/, "the notice names the round and the candidate");
  assert.match(message, /Sun 15 Nov, 11:00 Cairo time/, "the time is printed in Cairo");
  assert.match(message, /in person at Head office/, "an in-person interview names its place");
  assert.match(
    mrInterviewBookedMessage({ candidateName: "Dr Karim Fathy", location: null, platform: "zoom", round: "nsm_final", startsAt: "2026-11-15T09:00:00.000Z" }),
    /on Zoom/,
    "a Zoom interview says Zoom",
  );
  assert.match(
    mrInterviewBookedMessage({ candidateName: "Dr Karim Fathy", location: "Head office", platform: "phone", round: "hr_first", startsAt: "2026-11-15T09:00:00.000Z" }),
    /by phone call\. /,
    "a phone call says so, and names no place",
  );
  assert.match(
    mrInterviewBookedMessage({ candidateName: "Dr Karim Fathy", location: null, platform: "zoom", round: "rsm", startsAt: "2026-11-15T09:00:00.000Z" }),
    /RSM interview · Pedia line with Dr Karim Fathy[\s\S]*Sun 15 Nov, 11:00 Cairo time[\s\S]*on Zoom/,
    "the RSM receives the interview details through Phoenix: the round, the candidate, the time and the place",
  );
  assert.equal(mrInterviewNoticeHref("manager", "c-1"), "/employee-portals/recruitment-candidates#mr-interviews", "a manager lands on My Medical Rep interviews");
  assert.equal(mrInterviewNoticeHref("hr_manager", "c-1"), "/recruitment/mr-hiring?candidate=c-1", "the HR Manager lands on the candidate on the page");
  assert.equal(mrInterviewNoticeHref("talent_acquisition", "c-1"), "/hr/recruitment/mr-hiring?candidate=c-1", "Talent Acquisition lands on her own address for it");

  // §4 — booking the DSM's interview sends the CV through Phoenix and notifies everyone on it; the
  // salary never travels in a notice. Read from the code with comments removed, so a comment cannot pass it.
  const book = codeOnly("src/lib/recruitment/mr-hiring/book.ts");
  assert.match(book, /input\.round === "dsm"[\s\S]{0,200}sendCandidatesToManager\(/, "a DSM round sends the CV to the DSM");
  assert.match(book, /notifyMrInterviewBooked\(/, "every booking notifies the people on it");
  assert.doesNotMatch(book, /input\.round === "rsm"[\s\S]{0,200}sendCandidatesToManager\(/, "the RSM's booking sends the details, never moves the CV away from the DSM it was sent to");
  assert.match(book, /mrBookingRefusal\(/, "a booking is refused when it is not the next step");
  const notify = codeOnly("src/lib/recruitment/mr-hiring/notify.ts");
  assert.doesNotMatch(notify, /proposedSalary/, "no notice carries the proposed salary");
  // The one exception, by the owner's word of 7 Nov 2026: the area manager's notice goes "in all ways",
  // email included — and only through its own constant (tests/recruitment-mr-hiring-area-notice.test.ts).
  const withoutAreaNotice = notify.replace(/export const MR_AREA_MANAGER_CHANNELS = \[[^\]]*\] as const;/, "");
  assert.notEqual(withoutAreaNotice, notify, "the area manager's channels are one named constant");
  assert.doesNotMatch(withoutAreaNotice, /"email"/, "no other notice names the email channel");
  assert.match(
    notify,
    /: `mr-interview-booked:\$\{input\.bookingId\}:\$\{seat\}`/,
    "each seat's notice has its own key — a group of one recipient is not suffixed per recipient, so two seats would collide",
  );
  assert.match(
    notify,
    /`mr-interview-moved:\$\{input\.bookingId\}:\$\{input\.startsAt\}:\$\{seat\}`/,
    "a moved interview is a notice of its own — per new time and per seat, never swallowed by the booking's key",
  );
}
