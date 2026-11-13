import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";

import {
  bookingLink,
  buildInterviewCalendarExportModel,
  buildInterviewCalendarPdfHtml,
  buildInterviewCalendarWorkbook,
  interviewCalendarFilename,
} from "../src/lib/recruitment/interview-calendar-export.ts";
import { createAccessContext, systemAccessContext } from "../src/lib/auth/permissions.ts";
import {
  assertMayPickInterviewer,
  calendarRoleFor,
  canSetInterviewOutcome,
  checkCvUpload,
  grantFromLinkRow,
  hashInterviewCalendarLinkToken,
  linkTokenFrom,
  mayReadBooking,
  requireCalendarAccess,
  validateExternalPerson,
  validateInterviewBookingInput,
  validateInterviewSessionInput,
  type InterviewCalendarCaller,
  type InterviewCalendarLinkRow,
} from "../src/lib/recruitment/interview-calendar.ts";
import { INTERVIEW_CALENDAR_LINK_LIFETIME_DAYS, newInterviewCalendarLinkToken } from "../src/lib/recruitment/interview-calendar-links.ts";
import {
  canBookInterviews,
  checkPollQuestions,
  interviewCalendarBaseFor,
  interviewCalendarHref,
  interviewCalendarLinkPath,
  interviewOutcomeCandidateEffect,
  interviewOutcomeGroup,
  interviewOutcomeGroups,
  interviewOutcomeLabels,
  interviewOutcomes,
  isDistrictManagerOrAbove,
  isInterviewCalendarOwner,
  normalizeEgyptianMobile,
  readInterviewOutcome,
  resolveCalendarRole,
  roleMeets,
  seesWholeInterviewCalendar,
  sessionSlotStarts,
  whatsAppShareUrl,
  type InterviewBooking,
  type InterviewCalendarLinkGrant,
} from "../src/lib/recruitment/interview-calendar-types.ts";
import {
  cairoDateKey,
  cairoLocalToUtc,
  cairoMinutesOfDay,
  formatDuration,
  formatTimeOfDay,
  formatWeekOf,
  formatWeekRange,
  isBookableDay,
  isBookableWindow,
  isDateKey,
  monthGrid,
  slotFor,
  slotStarts,
  upcomingWeekStart,
  weekDays,
  weekInstantRange,
  weekStartFor,
} from "../src/lib/recruitment/interview-calendar-week.ts";
import {
  createZoomMeeting,
  deleteZoomMeeting,
  getZoomHostStartUrl,
  readZoomConfig,
  resetZoomTokenCacheForTests,
  zoomMeetingBody,
  type ZoomConfig,
  zoomMeetingIdFromJoinUrl,
} from "../src/lib/zoom/meetings.ts";
import { stripComments } from "./support/comment-strip.ts";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

/**
 * The interview calendar — the owner's request of 2026-09-18, in his words: "on the CV without any
 * steps from screening or from recruitment or from WhatsApp application screening tab from any
 * screen, any CV … I have the option to schedule an interview", then a date, a time, In office or
 * Zoom, a week grid like his own Google sheet, a PDF and an Excel export in which "I click on name
 * the CV appear", and sharing "from Phoenix itself" as editor, commenter or viewer.
 *
 * His answers when asked: the candidate is sent NOTHING (calendar only); only he and the people he
 * shares with can see it; Phoenix creates the Zoom meeting; Sunday to Thursday, 9:00 AM to 5:00 PM,
 * in half-hour rows.
 *
 * Then, the same day: COPY LINKS "exactly as Google Sheets" (Viewer, Commenter or Editor; this week
 * or the whole calendar; view without sign-in), interview SESSIONS ("day 20 from 11 a.m. to 3
 * p.m." — one Zoom meeting cut into slots), long interviews up to the whole day, pressable empty
 * cells that book someone from Phoenix or from OUTSIDE with their CV, and Zoom's attendance, polls,
 * invitation and AI summary on every Zoom interview — sent by nobody but the person who presses Send.
 */
export async function runInterviewCalendarTests() {
  runWeekTests();
  runAddressTests();
  runRoleTests();
  runLinkTests();
  runValidationTests();
  runSessionAndOutsideTests();
  runPollAndWhatsAppTests();
  runOutcomeTests();
  runInterviewerAccessTests();
  await runZoomTests();
  await runExportTests();
  runWiringTests();
}

// ── The outcome of an interview: six words, one list (owner, 2026-09-20) ─────────────────────────
function runOutcomeTests() {
  assert.deepEqual(
    [...interviewOutcomes].sort(),
    ["attended", "backup", "did_not_come", "no_answer", "prioritized", "rejected", "shortlisted", "will_reschedule", "withdrew"],
    "Attended and its four decisions, Didn't come and its three reasons — nine words, no more",
  );
  assert.deepEqual(Object.keys(interviewOutcomeLabels).sort(), [...interviewOutcomes].sort(), "every word has a label");

  // THE PICKER IS TWO STEPS (owner, 2026-09-20): every word sits under exactly one of Attended / Didn't come.
  assert.deepEqual([...interviewOutcomeGroups.attended.followUps], ["shortlisted", "backup", "rejected", "prioritized"]);
  assert.deepEqual([...interviewOutcomeGroups.did_not_come.followUps], ["will_reschedule", "no_answer", "withdrew"]);
  for (const word of interviewOutcomes) assert.ok(interviewOutcomeGroup(word), `${word} sits under Attended or Didn't come`);
  assert.equal(interviewOutcomeGroup("rejected"), "attended", "a decision is under Attended");
  assert.equal(interviewOutcomeGroup("attended"), "attended", "and the parent alone is under itself");
  assert.equal(interviewOutcomeGroup("no_answer"), "did_not_come", "a reason is under Didn't come");
  assert.equal(interviewOutcomeGroup(null), null, "no outcome, no group");
  for (const word of ["will_reschedule", "no_answer", "withdrew"] as const) {
    assert.deepEqual(interviewOutcomeCandidateEffect(word), { rating: null, status: null }, `${word} marks the interview only`);
  }
  assert.match(
    readFileSync(join(process.cwd(), "supabase/migrations/20260920195928_ats_interview_outcome_didnt_come_reasons.sql"), "utf8"),
    /'did_not_come', 'will_reschedule', 'no_answer', 'withdrew'/,
    "the database's closed list carries the three new words",
  );
  const pickerSource = readFileSync(join(process.cwd(), "src/components/recruitment/interview-calendar/interview-calendar-view.tsx"), "utf8");
  assert.match(pickerSource, /interviewOutcomeGroup\(booking\.outcome\)/, "the screen finds which step-one choice is open");
  assert.match(pickerSource, /interviewOutcomeGroups\[activeGroup\]\.followUps\.map/, "and shows only that choice's follow-ups");
  assert.doesNotMatch(pickerSource, /interviewOutcomes\.map/, "the screen no longer lists all the words in one row");
  // On a phone and a tablet both steps are thumb-sized (44px) and the picker sits above the CV, not 60% of a screen below it.
  // The size follows the CV modal's own stack: it is one column below lg, so 44px runs to lg, not md (a 768px tablet got 26px).
  assert.equal(pickerSource.split("min-h-[44px] border px-3 py-1.5").length - 1, 2, "both picker rows are 44px tall on a phone");
  assert.equal(pickerSource.split("lg:min-h-0 lg:px-2").length - 1, 2, "and return to the compact size from lg up, where the modal goes side by side");
  assert.doesNotMatch(pickerSource, /md:min-h-0 md:px-2/, "a tablet in the stacked layout keeps the 44px size");
  assert.match(pickerSource, /<CvPreviewModal[^>]*sidePanelFirstOnPhone/, "the interview panel asks to sit above the CV on a phone");
  const cvModalSource = readFileSync(join(process.cwd(), "src/components/recruitment/cv-preview-modal.tsx"), "utf8");
  assert.ok(cvModalSource.includes("order-first lg:order-none"), "the modal puts that panel first below lg and restores the columns at lg");
  assert.equal(readInterviewOutcome("backup"), "backup");
  assert.equal(readInterviewOutcome("Backup"), null, "an unknown spelling is no outcome, never a guess");
  assert.equal(readInterviewOutcome(null), null);

  // What each word does to the candidate in Recruitment.
  assert.deepEqual(interviewOutcomeCandidateEffect("shortlisted"), { rating: null, status: "shortlisted" });
  assert.deepEqual(interviewOutcomeCandidateEffect("backup"), { rating: null, status: "backup" });
  assert.deepEqual(interviewOutcomeCandidateEffect("rejected"), { rating: null, status: "rejected" });
  assert.deepEqual(interviewOutcomeCandidateEffect("prioritized"), { rating: 3, status: "shortlisted" }, "prioritized is shortlist + the 3-star Top pick");
  assert.deepEqual(interviewOutcomeCandidateEffect("attended"), { rating: null, status: null }, "attended and didn't come only mark the interview");
  assert.deepEqual(interviewOutcomeCandidateEffect("did_not_come"), { rating: null, status: null });

  // Only the interviewer and the calendar's owner may set it.
  const member = createAccessContext({ hrId: "A-99", role: "Employee" });
  const guest = { ...createAccessContext({ hrId: null, role: "Employee" }), source: "guest" } as InterviewCalendarCaller["access"];
  const asOwner: InterviewCalendarCaller = { access: member, link: null, own: "owner" };
  const asEditor: InterviewCalendarCaller = { access: member, link: null, own: null };
  assert.equal(canSetInterviewOutcome(asOwner, null), true, "the owner may, with or without a chosen interviewer");
  assert.equal(canSetInterviewOutcome(asEditor, "a-99"), true, "the interviewer may — id case does not matter");
  assert.equal(canSetInterviewOutcome(asEditor, "B-10"), false, "somebody else's interview is not theirs to mark");
  assert.equal(canSetInterviewOutcome(asEditor, null), false, "no chosen interviewer, not the owner: nobody but the owner");
  assert.equal(canSetInterviewOutcome({ access: guest, link: null, own: "owner" }, "A-99"), false, "a copy link is never a person");

  // Wiring: saved BEFORE the candidate moves, and nothing is ever sent.
  const service = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  const setStart = service.indexOf("export async function setInterviewOutcome");
  const body = service.slice(setStart, service.indexOf("\n}\n", setStart));
  assert.ok(body.indexOf(".update(") > -1 && body.indexOf(".update(") < body.indexOf("applyOutcomeToCandidate("), "the outcome is saved first, the candidate moves after");
  assert.ok(!/notify|sendEmail|sendWhatsApp|sendMail/i.test(body), "recording an outcome never sends anything");
  // The label is drawn on BOTH the desktop tile and the phone-width day card (the card was missed once).
  const view = stripComments(read("src/components/recruitment/interview-calendar/interview-calendar-view.tsx"));
  const tile = (owner: string) => `{${owner}.outcome ? <span className="font-bold text-slate-900">{interviewOutcomeLabels[${owner}.outcome]}</span> : null}`;
  assert.ok(view.includes(tile("booking")), "the desktop tile says how it went");
  assert.ok(view.includes(tile("item.booking")), "and so does the phone-width day card");
  const route = read("app/api/recruitment/interview-calendar/bookings/[id]/outcome/route.ts");
  assert.ok(route.includes("assertSameOriginMutation") && route.includes("export async function PATCH"), "the route is a same-origin PATCH");
}

// ── The chosen interviewer's own window (owner, 2026-09-20) ────────────────────────────────────
// "I want to be able to choose the interviewer ... and the interviewer that I choose have the same
// window, and his interviews appear to him" — only their own, from District Managers and up, never a
// Medical Rep.
function runInterviewerAccessTests() {
  // WHO: District Managers and above, by app role first (authority follows it) then job title.
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager", "CEO", "Super Admin", "Product Manager", "HR Operations Manager"]) {
    assert.equal(isDistrictManagerOrAbove({ role }), true, `${role} may be chosen`);
  }
  for (const title of ["District Sales Manager", "Regional Sales Manager", "National Sales Manager", "Group Product Manager", "Head of Recruitment", "Chief Executive Officer"]) {
    assert.equal(isDistrictManagerOrAbove({ jobTitle: title }), true, `${title} may be chosen`);
  }
  for (const role of ["Medical Rep", "Medical Representative"]) {
    assert.equal(isDistrictManagerOrAbove({ role }), false, `${role} is below District Manager — never`);
    assert.equal(isDistrictManagerOrAbove({ jobTitle: role }), false, `${role} as a title is below District Manager — never`);
  }
  assert.equal(isDistrictManagerOrAbove({ jobTitle: "Senior Medical Representative" }), false, "seniority does not lift a rep");
  assert.equal(isDistrictManagerOrAbove({ role: "Employee", jobTitle: "Medical Representative" }), false, "a plain Employee role falls back to the title");
  assert.equal(isDistrictManagerOrAbove({ role: "District Manager", jobTitle: "Medical Representative" }), true, "an acting DM's authority is the app role, not the title");
  assert.equal(isDistrictManagerOrAbove({ jobTitle: "Accountant" }), false, "an unrecognised title fails closed");
  assert.equal(isDistrictManagerOrAbove({}), false, "no role and no title is nobody");

  // WHAT: only their own interviews, and nothing beyond "view".
  const me = createAccessContext({ hrId: "D-07", role: "District Manager" });
  const asInterviewer: InterviewCalendarCaller = { access: me, link: null, own: "interviewer" };
  const at = "2026-09-22T09:00:00.000Z";
  assert.equal(mayReadBooking(asInterviewer, { interviewer_hr_id: "d-07", starts_at: at }), true, "their own interview — id case does not matter");
  assert.equal(mayReadBooking(asInterviewer, { interviewer_hr_id: "D-08", starts_at: at }), false, "a colleague's interview is not theirs to read");
  assert.equal(mayReadBooking(asInterviewer, { interviewer_hr_id: null, starts_at: at }), false, "an interview with nobody chosen is not theirs");
  const asViewer: InterviewCalendarCaller = { access: me, link: null, own: "viewer" };
  assert.equal(mayReadBooking(asViewer, { interviewer_hr_id: "D-08", starts_at: at }), true, "a Viewer still reads the whole calendar");
  assert.equal(mayReadBooking({ access: me, link: null, own: null }, { interviewer_hr_id: "D-07", starts_at: at }), false, "no role, no read — even of one's own");
  for (const need of ["comment", "book", "share"] as const) {
    assert.throws(() => requireCalendarAccess(asInterviewer, need, null), /Forbidden/, `an interviewer can never ${need}`);
  }
  assert.equal(requireCalendarAccess(asInterviewer, "view", "2026-09-20"), "interviewer", "but the window opens");
  assert.equal(canSetInterviewOutcome(asInterviewer, "D-07"), true, "and they record how their own interview went");
  assert.equal(canSetInterviewOutcome(asInterviewer, "D-08"), false, "never somebody else's");

  // WIRING: every place that serves a booking to a "view" caller asks mayReadBooking / mayReadSessions —
  // the gate alone would hand an interviewer the whole calendar and every candidate's CV. A NEW "view"
  // site fails the count until somebody decides how it guards the rows.
  const domain = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  assert.equal(domain.split('requireCalendarAccess(caller, "view"').length - 1, 15, "fifteen view sites, each guarded below");
  const guarded: Array<[string, RegExp]> = [
    ["listInterviewCalendarWeek", /mayReadBooking\(caller, row\)[\s\S]*mayReadSessions\(/],
    ["listInterviewCalendarDay", /mayReadBooking\(caller, row\)[\s\S]*mayReadSessions\(/],
    ["listUpcomingInterviewsForCandidate", /mayReadBooking\(caller, row\)/],
    ["getInterviewBooking", /mayReadBooking\(caller, row\)/],
    ["getInterviewSession", /mayReadSessions\(/],
    ["setInterviewOutcome", /mayReadBooking\(caller, row\)/],
    // The outcome prompt is narrower than "view": it lists only what this caller may ANSWER for, so a
    // viewer gets nothing and a share-link guest gets nothing at all.
    ["listInterviewsAwaitingOutcome", /mayReadBooking\(caller, row\)[\s\S]*canSetOutcome/],
    ["resolveInterviewMeeting", /mayReadSessions\([\s\S]*mayReadBooking\(caller, row\)/],
    ["getInterviewExternalCv", /mayReadBooking\(caller, row\)/],
    // A scorecard is filed only by someone ON the interview — the lead or a panel member.
    ["saveInterviewScorecard", /isInterviewAttendee\(caller, row\)/],
    // Confirm/decline is answered ONLY by the lead interviewer named on the row.
    ["setInterviewerConfirmation", /viewer !== canonicalHrIdKey\(row\.interviewer_hr_id\)/],
  ];
  for (const [name, pattern] of guarded) assert.match(functionBody(domain, name), pattern, `${name} guards the rows an interviewer may read`);
  const onCalendar = domain.slice(domain.indexOf("async function assertCandidateOnCalendar"));
  assert.match(onCalendar.slice(0, 900), /interviewer_hr_id[\s\S]*mayReadBooking\(caller, row\)/, "a CV opens only for a candidate the interviewer conducts");
  // The interviewer is chosen from District Managers and up, and a new one below that is refused.
  assert.match(domain, /Interviewers are District Managers and above/, "choosing someone below District Manager is refused");
  assert.match(domain, /purpose !== "interviewer" \|\| isDistrictManagerOrAbove\(/, "and the picker never offers them");
  assert.match(domain, /async function isChosenInterviewer[\s\S]*isDistrictManagerOrAbove\(/, "a Medical Rep chosen before the rule holds no calendar");

  // WHO MAY PICK ONE: the request flow's point is that a requester who cannot book still names the
  // interviewer. Booking rights pass; a requester and an interviewer pass; a viewer/commenter is
  // refused. Requiring "book" here made the picker read "Nobody matches that" for every requester.
  const dm = createAccessContext({ hrId: "B-116", role: "District Sales Manager" });
  assert.doesNotThrow(() => assertMayPickInterviewer({ access: dm, link: null, own: "requester" }), "a requester picks who conducts it");
  assert.doesNotThrow(() => assertMayPickInterviewer({ access: dm, link: null, own: "interviewer" }), "a chosen interviewer picks (self-book)");
  assert.doesNotThrow(() => assertMayPickInterviewer({ access: dm, link: null, own: "owner" }), "the owner picks");
  assert.doesNotThrow(() => assertMayPickInterviewer({ access: dm, link: null, own: "editor" }), "an editor picks");
  assert.throws(() => assertMayPickInterviewer({ access: dm, link: null, own: "viewer" }), /Forbidden/, "a viewer has no interviewer to pick");
  assert.throws(() => assertMayPickInterviewer({ access: dm, link: null, own: "commenter" }), /Forbidden/, "nor does a commenter");
  assert.match(domain, /if \(purpose === "interviewer"\) assertMayPickInterviewer\(caller\)/, "the picker search uses the pick gate, not the book gate");
}

// ── 1 · The week: every day, 9 to 5, in Cairo ──────────────────────────────────────────────────
function runWeekTests() {
  // 2026-09-18 is a Friday, 2026-09-20 a Sunday.
  assert.equal(weekStartFor("2026-09-18"), "2026-09-13", "a Friday belongs to the week that started on the Sunday before");
  assert.equal(weekStartFor("2026-09-19"), "2026-09-13", "and so does a Saturday");
  assert.equal(weekStartFor("2026-09-20"), "2026-09-20", "a Sunday starts its own week");
  assert.deepEqual(
    weekDays("2026-09-22"),
    ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"],
    "the grid is every day, Sunday to Saturday (owner, 7 Nov 2026: \"make able to schedule any day in the week\"), whatever day it is asked from",
  );

  const starts = slotStarts();
  assert.equal(starts.length, 16, "9:00 AM to 5:00 PM is sixteen half-hour rows");
  assert.equal(formatTimeOfDay(starts[0]), "9:00 AM");
  assert.equal(formatTimeOfDay(starts[starts.length - 1]), "4:30 PM", "the last row starts at 4:30 PM");
  assert.equal(formatTimeOfDay(720), "12:00 PM", "noon is 12:00 PM, never 0:00 PM");
  assert.equal(slotFor(9 * 60 + 15), 9 * 60, "a 9:15 interview is drawn in the 9:00 row");

  assert.equal(isBookableDay("2026-09-18"), true, "a Friday holds interviews");
  assert.equal(isBookableDay("2026-09-19"), true, "and so does a Saturday");
  assert.equal(isBookableDay("2026-09-20"), true);
  assert.equal(isBookableDay("2026-09-24"), true, "and every weekday");
  assert.equal(isDateKey("2026-02-30"), false, "a date that does not exist is refused, not rolled into March");

  // Any time of day — the owner, 7 Nov 2026: "make hr freely add any time".
  assert.equal(isBookableWindow(8 * 60 + 30, 30), true, "an 8:30 AM interview is bookable");
  assert.equal(isBookableWindow(9 * 60, 30), true);
  assert.equal(isBookableWindow(19 * 60 + 5, 30), true, "so is 7:05 PM, to the minute");
  assert.equal(isBookableWindow(23 * 60 + 30, 30), true, "an 11:30 PM half hour ends at midnight exactly");
  assert.equal(isBookableWindow(23 * 60 + 45, 30), false, "and nothing runs past midnight");
  assert.equal(isBookableWindow(-15, 30), false, "nor starts before it");
  assert.equal(isBookableWindow(9 * 60 + 5, 20), false, "lengths stay whole quarter hours");
  // The grid opens 9 to 5 and widens to reach an interview booked outside it.
  const widened = slotStarts([{ durationMinutes: 30, startMinutes: 19 * 60 + 40 }, { durationMinutes: 60, startMinutes: 7 * 60 + 10 }]);
  assert.equal(widened[0], 7 * 60, "an interview at 7:10 AM opens the grid at 7:00 AM");
  assert.equal(widened[widened.length - 1], 20 * 60, "one at 7:40 PM to 8:10 PM keeps rows to 8:00 PM");
  assert.deepEqual(slotStarts([{ durationMinutes: 30, startMinutes: 10 * 60 }]), starts, "one inside 9 to 5 leaves the sixteen rows alone");

  // THE CAIRO TRAP. The server runs in UTC; Cairo is two or three hours ahead. Just after midnight
  // on a Sunday in Cairo it is still Saturday in UTC, and a calendar keyed on the server's clock
  // would open on the week that just ended. With every day an interview day, the calendar always
  // opens on the week today is in — counted in Cairo.
  assert.equal(upcomingWeekStart(new Date("2026-09-18T09:00:00Z")), "2026-09-13", "on a Friday the calendar stays on this week — Friday and Saturday hold interviews");
  assert.equal(upcomingWeekStart(new Date("2026-09-19T20:30:00Z")), "2026-09-13", "Saturday 11:30 PM in Cairo is still this week");
  assert.equal(
    upcomingWeekStart(new Date("2026-09-19T21:30:00Z")),
    "2026-09-20",
    "Sunday 12:30 AM in Cairo is the new week, though UTC still reads Saturday",
  );

  // DAYLIGHT SAVING. Egypt keeps it again since 2023 (+3 in summer, +2 in winter), so the offset
  // cannot be a constant. 9:00 AM must be 9:00 AM in Cairo on both sides of the change.
  assert.equal(cairoLocalToUtc("2026-09-20", 9 * 60).toISOString(), "2026-09-20T06:00:00.000Z", "summer: Cairo is UTC+3");
  assert.equal(cairoLocalToUtc("2026-11-01", 9 * 60).toISOString(), "2026-11-01T07:00:00.000Z", "winter: Cairo is UTC+2");
  assert.equal(cairoLocalToUtc("2027-01-10", 14 * 60 + 30).toISOString(), "2027-01-10T12:30:00.000Z");
  for (const [key, minutes] of [
    ["2026-09-20", 9 * 60],
    ["2026-10-29", 16 * 60 + 30],
    ["2026-11-01", 9 * 60 + 15],
    ["2027-04-25", 12 * 60],
  ] as const) {
    const instant = cairoLocalToUtc(key, minutes);
    assert.equal(cairoDateKey(instant), key, `${key} round-trips to the same Cairo day`);
    assert.equal(cairoMinutesOfDay(instant), minutes, `${key} round-trips to the same Cairo time`);
  }
  const range = weekInstantRange("2026-09-22");
  assert.equal(range.from.toISOString(), "2026-09-19T21:00:00.000Z", "the week's query starts at Sunday midnight in Cairo");
  assert.equal(range.to.toISOString(), "2026-09-26T21:00:00.000Z", "and ends at the next Sunday's midnight");

  const september = monthGrid(2026, 8);
  assert.equal(september.length, 5, "September 2026 is five Sunday-first rows");
  assert.deepEqual(september[0].slice(0, 3), [null, null, "2026-09-01"], "1 September 2026 is a Tuesday");
  assert.deepEqual(september[4], ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", null, null, null]);
  assert.ok(september.every((row) => row.length === 7), "every row is a whole week");

  assert.equal(formatWeekRange("2026-09-20"), "20 – 26 September 2026", "the week runs Sunday to Saturday");
  assert.equal(formatWeekRange("2026-09-27"), "27 September – 3 October 2026", "a week across a month names both");
  assert.equal(formatWeekRange("2025-12-28"), "28 December 2025 – 3 January 2026", "and across a year, both years");
  assert.equal(formatWeekOf("2026-09-23"), "Week of: 20 September", "the grid is headed the way the owner's sheet is");
}

// ── 2 · A link stays in the shell it was pressed in ────────────────────────────────────────────
function runAddressTests() {
  assert.equal(interviewCalendarBaseFor("/recruitment/screening"), "/recruitment/interview-calendar");
  assert.equal(interviewCalendarBaseFor("/hr/recruitment"), "/hr/recruitment/interview-calendar", "the HR shell keeps its own address");
  assert.equal(interviewCalendarBaseFor("/hr"), "/hr/recruitment/interview-calendar");
  assert.equal(interviewCalendarBaseFor("/hrm/anything"), "/recruitment/interview-calendar", "only /hr itself is the HR shell");
  assert.equal(
    interviewCalendarBaseFor("/employee-portals/recruitment-candidates"),
    "/employee-portals/interview-calendar",
    "the portal has its own twin",
  );
  assert.equal(interviewCalendarBaseFor(null), "/recruitment/interview-calendar");
  assert.equal(interviewCalendarHref(), "/recruitment/interview-calendar");
  const id = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  assert.equal(
    interviewCalendarHref({ base: "/hr/recruitment/interview-calendar", open: id, weekStart: "2026-09-20" }),
    `/hr/recruitment/interview-calendar?week=2026-09-20&open=${id}`,
  );
}

// ── 3 · Who may do what: owner, editor, commenter, viewer ──────────────────────────────────────
function runRoleTests() {
  const table: Array<[Parameters<typeof roleMeets>[0], boolean, boolean, boolean, boolean]> = [
    // role        view   comment book   share
    ["owner", true, true, true, true],
    ["editor", true, true, true, false],
    ["commenter", true, true, false, false],
    ["viewer", true, false, false, false],
    ["interviewer", true, false, false, false],
    [null, false, false, false, false],
  ];
  for (const [role, view, comment, book, share] of table) {
    assert.equal(roleMeets(role, "view"), view, `${role ?? "nobody"} viewing`);
    assert.equal(roleMeets(role, "comment"), comment, `${role ?? "nobody"} leaving notes`);
    assert.equal(roleMeets(role, "book"), book, `${role ?? "nobody"} booking, moving and cancelling`);
    assert.equal(roleMeets(role, "share"), share, `${role ?? "nobody"} sharing — only the owner shares`);
    assert.equal(canBookInterviews(role), book, "the Schedule interview button follows the same rule as the server");
  }
  assert.equal(resolveCalendarRole({ isOwner: true, shareLevel: "viewer" }), "owner", "the owner cannot demote himself by sharing");
  assert.equal(resolveCalendarRole({ isOwner: false, shareLevel: "commenter" }), "commenter");
  assert.equal(resolveCalendarRole({ isOwner: false, shareLevel: null }), null, "no share row, no calendar");

  // The owner, as a real session carries him. createAccessContext is what the session builds, and
  // it gives a signed-in Super Admin scope "company", not "system" — a scope-only owner test
  // locked him out of his own calendar (2026-09-18, caught before merge).
  const owner = createAccessContext({ hrId: "B-10", role: "Super Admin" });
  assert.equal(isInterviewCalendarOwner(owner), true, "the signed-in Super Admin owns the calendar");
  assert.equal(isInterviewCalendarOwner(systemAccessContext), true, "a system job acts as the owner");
  // HR Operations is the calendar's admin — an owner, by the owner's ruling of 2026-09-21.
  const hrOperations = createAccessContext({ hrId: "HR-009", role: "HR Operations" });
  assert.equal(isInterviewCalendarOwner(hrOperations), true, "HR Operations runs the calendar as an owner");
  assert.equal(resolveCalendarRole({ isOwner: isInterviewCalendarOwner(hrOperations), shareLevel: "viewer" }), "owner", "a share row cannot demote HR Operations");
  // TALENT ACQUISITION IS AN OWNER TOO (owner, 2026-10-21: "make the TA have full access on the interview
  // and can schedule and do everything and use every single feature"). It replaced her Viewer tier of
  // 2026-10-08 and her read-only request list of 2026-10-18. Run through createAccessContext, the way a
  // real session builds her, so a scope-only test cannot pass for the wrong reason.
  const talentAcquisition = createAccessContext({ hrId: "HR-011", role: "HR Resourcing" });
  assert.equal(isInterviewCalendarOwner(talentAcquisition), true, "Talent Acquisition runs the calendar as an owner");
  const taRole = resolveCalendarRole({ isOwner: isInterviewCalendarOwner(talentAcquisition), shareLevel: null });
  assert.equal(taRole, "owner", "she resolves to the owner level, with no share row at all");
  assert.equal(resolveCalendarRole({ isOwner: isInterviewCalendarOwner(talentAcquisition), shareLevel: "viewer" }), "owner", "a share row cannot demote Talent Acquisition");
  for (const need of ["view", "comment", "book", "share"] as const) {
    assert.equal(roleMeets(taRole, need), true, `as an owner she meets "${need}" — schedule, comment, share, every feature`);
  }
  assert.equal(canBookInterviews(taRole), true, "the Schedule interview button follows the same rule as the server, and draws for her");
  for (const role of ["CEO", "Finance Manager", "HR Advisory", "National Sales Manager", "Employee"]) {
    const other = createAccessContext({ hrId: "A-99", role });
    assert.equal(isInterviewCalendarOwner(other), false, `${role} (scope ${other.scope}) is not the owner — only a share row lets them in`);
  }

  // THE CEO SEES THE WHOLE CALENDAR (owner, 2026-09-26): a Viewer, not an owner. Only the CEO — no
  // other executive is widened, and the Super Admin/HR Operations reach it as owners already.
  assert.equal(seesWholeInterviewCalendar(createAccessContext({ hrId: "A-99", role: "CEO" })), true, "the CEO reads the whole calendar");
  // The HR Operations Specialist seat, 2026-10-20 — the owner's answer: "She can view it only".
  const specialist = createAccessContext({ hrId: "A-99", role: "HR Administration" });
  assert.equal(seesWholeInterviewCalendar(specialist), true, "the HR Operations Specialist reads the whole calendar");
  assert.equal(isInterviewCalendarOwner(specialist), false, "the HR Operations Specialist does not own the calendar — Talent Acquisition's ruling is hers alone");
  for (const role of ["Finance Manager", "HR Advisory", "National Sales Manager", "District Manager", "Medical Representative", "Employee"]) {
    assert.equal(seesWholeInterviewCalendar(createAccessContext({ hrId: "A-99", role })), false, `${role} does not get the whole calendar from this seat`);
  }
  // A Viewer role — which is what the CEO resolves to — reads every booking, including ones he was
  // never chosen for; the own-only requester tier does not. (mayReadBooking is pinned above too.)
  const ceoAccess = createAccessContext({ hrId: "A-99", role: "CEO" });
  const someWeek = "2026-09-20T09:00:00.000Z";
  assert.equal(
    mayReadBooking({ access: ceoAccess, link: null, own: "viewer" }, { interviewer_hr_id: "D-08", starts_at: someWeek }),
    true,
    "as a Viewer the CEO reads an interview he is not on",
  );
  assert.equal(
    mayReadBooking({ access: ceoAccess, link: null, own: "requester" }, { interviewer_hr_id: "D-08", starts_at: someWeek }),
    false,
    "the own-only requester tier would NOT — which is the state this change lifts the CEO out of",
  );
}

// ── 3b · Copy links: "exactly as Google Sheets", and view-only until sign-in ────────────────────
function linkRow(overrides: Partial<InterviewCalendarLinkRow> = {}): InterviewCalendarLinkRow {
  return {
    access_level: "editor",
    created_at: "2026-09-18T18:00:00.000Z",
    created_by_hr_id: "B-10",
    guest_cvs: true,
    id: "11111111-2222-4333-8444-555555555555",
    is_active: true,
    last_used_at: null,
    token_preview: "aaaaaaaa",
    expires_at: null,
    updated_at: "2026-09-18T18:00:00.000Z",
    use_count: 0,
    week_start: "2026-09-20",
    ...overrides,
  };
}

function runLinkTests() {
  const week = "2026-09-20";
  const nextWeek = "2026-09-27";
  const guest = { ...createAccessContext({ hrId: null, role: "Employee" }), source: "guest" } as InterviewCalendarCaller["access"];
  const member = createAccessContext({ hrId: "A-99", role: "Employee" });
  const caller = (own: InterviewCalendarCaller["own"], link: InterviewCalendarLinkGrant | null, access = member): InterviewCalendarCaller => ({
    access,
    link,
    own,
  });

  // The row a link is, read back.
  const signedOut = grantFromLinkRow(linkRow(), false) as InterviewCalendarLinkGrant;
  assert.deepEqual(signedOut, { accessLevel: "editor", guestCvs: true, id: linkRow().id, signedIn: false, weekStart: week });
  assert.equal(grantFromLinkRow(linkRow({ is_active: false }), true), null, "a switched-off link gives nothing");
  assert.equal(grantFromLinkRow(linkRow({ access_level: "owner" }), true), null, "a link can never make someone the owner");
  assert.equal(grantFromLinkRow(linkRow({ guest_cvs: null }), false)?.guestCvs, true, "CVs open without sign-in unless switched off");
  assert.equal(grantFromLinkRow(linkRow({ week_start: "2026-09-20T00:00:00+00:00" }), false)?.weekStart, week);
  assert.equal(grantFromLinkRow(linkRow({ week_start: null }), false)?.weekStart, null, "no week is the whole calendar");

  // KEPT 90 DAYS (owner, 13 Nov 2026): a link past its expiry gives nothing, signed in or not.
  const madeAt = new Date("2026-09-18T18:00:00.000Z");
  const expiresAt = new Date(madeAt.getTime() + INTERVIEW_CALENDAR_LINK_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
  assert.equal(INTERVIEW_CALENDAR_LINK_LIFETIME_DAYS, 90, "every link opens nothing 90 days after it was made");
  const dated = linkRow({ expires_at: expiresAt.toISOString() });
  assert.ok(grantFromLinkRow(dated, false, new Date(expiresAt.getTime() - 1)), "a link opens up to its last moment");
  assert.equal(grantFromLinkRow(dated, false, expiresAt), null, "a link opens nothing from its expiry on");
  assert.equal(grantFromLinkRow(dated, true, new Date(expiresAt.getTime() + 1)), null, "signing in does not reopen an expired link");

  // STORED AS A HASH: the SHA-256 of the link, never the link — and never its first 8 characters alone.
  const sample = "b".repeat(43);
  assert.match(hashInterviewCalendarLinkToken(sample), /^[0-9a-f]{64}$/, "the stored form is a 64-character SHA-256");
  assert.equal(hashInterviewCalendarLinkToken(sample), hashInterviewCalendarLinkToken(sample), "the same link always finds the same row");
  assert.notEqual(hashInterviewCalendarLinkToken(sample), hashInterviewCalendarLinkToken(`${sample.slice(0, 42)}c`), "one character apart is another row");
  assert.ok(!hashInterviewCalendarLinkToken(sample).includes(sample.slice(0, 8)), "the hash does not carry the link");

  // WITHOUT SIGN-IN, A LINK VIEWS — whatever level it carries (the owner's choice).
  const outsider = caller(null, signedOut, guest);
  assert.equal(calendarRoleFor(outsider, week), "viewer");
  assert.equal(calendarRoleFor(outsider, "any"), "viewer");
  assert.equal(calendarRoleFor(outsider, nextWeek), null, "a week link opens its own week only");
  assert.equal(requireCalendarAccess(outsider, "view", week), "viewer");
  assert.throws(() => requireCalendarAccess(outsider, "book", week), /sign in to Phoenix to comment or edit/, "the refusal says how to get more");
  assert.throws(() => requireCalendarAccess(outsider, "view", nextWeek), /opens only the week of 20/);
  assert.throws(() => requireCalendarAccess(outsider, "share", null), /opens only the week of/, "a week link does not answer for the whole calendar");
  const outsiderWhole = caller(null, grantFromLinkRow(linkRow({ week_start: null }), false), guest);
  assert.equal(calendarRoleFor(outsiderWhole, nextWeek), "viewer", "a whole-calendar link views every week");
  assert.throws(() => requireCalendarAccess(outsiderWhole, "comment", nextWeek), /sign in to Phoenix to comment or edit/);
  assert.throws(() => requireCalendarAccess(outsiderWhole, "share", null), /only the calendar's owner can share it/, "no link shares, signed in or not");

  // SIGNED IN, the link's own level — on its week.
  const signedIn = grantFromLinkRow(linkRow(), true) as InterviewCalendarLinkGrant;
  assert.equal(requireCalendarAccess(caller(null, signedIn), "book", week), "editor");
  assert.throws(() => requireCalendarAccess(caller(null, signedIn), "book", nextWeek), /opens only the week of/);
  const wholeCommenter = grantFromLinkRow(linkRow({ access_level: "commenter", week_start: null }), true) as InterviewCalendarLinkGrant;
  assert.equal(requireCalendarAccess(caller(null, wholeCommenter), "comment", nextWeek), "commenter", "a whole-calendar link reaches every week");
  assert.throws(() => requireCalendarAccess(caller(null, wholeCommenter), "book", nextWeek), /owner and its editors/);
  assert.throws(() => requireCalendarAccess(caller(null, wholeCommenter), "share", null), /only the calendar's owner/, "no link shares");

  // Their own access and a link: the higher wins, week by week.
  assert.equal(calendarRoleFor(caller("viewer", signedIn), week), "editor");
  assert.equal(calendarRoleFor(caller("viewer", signedIn), nextWeek), "viewer", "their own share still holds outside the link's week");
  assert.equal(requireCalendarAccess(caller("owner", null), "share", null), "owner");
  assert.throws(() => requireCalendarAccess(caller(null, null, guest), "view", week), /sign in to Phoenix to open the interview calendar/);

  // The link rides on a header, or on `?link=` where a browser opens the address itself.
  const token = newInterviewCalendarLinkToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, URL-safe");
  assert.notEqual(token, newInterviewCalendarLinkToken(), "every link is its own secret");
  assert.equal(linkTokenFrom(new Request(`https://x.test/api/recruitment/interview-calendar/bookings?week=${week}&link=${token}`)), token);
  assert.equal(linkTokenFrom(new Request("https://x.test/a", { headers: { "x-interview-calendar-link": ` ${token} ` } })), token);
  assert.equal(linkTokenFrom(new Request("https://x.test/a")), null);
  assert.equal(interviewCalendarLinkPath(token), `/share/interview-calendar/${token}`, "outside both shells, so it opens with no sign-in");
}

// ── 4 · A booking the server will take ─────────────────────────────────────────────────────────
function runValidationTests() {
  const candidateId = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const good = { candidateId, dateKey: "2026-09-20", durationMinutes: 45, notes: "  Bring the offer draft  ", platform: "zoom", startMinutes: 10 * 60 };
  assert.deepEqual(validateInterviewBookingInput(good), {
    candidateId,
    dateKey: "2026-09-20",
    durationMinutes: 45,
    external: null,
    notes: "Bring the offer draft",
    platform: "zoom",
    startMinutes: 600,
  });
  assert.equal(validateInterviewBookingInput({ ...good, notes: "   " }).notes, null, "a blank note is no note");
  assert.equal(validateInterviewBookingInput({ ...good, dateKey: "2026-09-18" }).dateKey, "2026-09-18", "a Friday is booked like any day");
  assert.equal(validateInterviewBookingInput({ ...good, dateKey: "2026-09-19" }).dateKey, "2026-09-19", "and a Saturday");
  assert.equal(validateInterviewBookingInput({ ...good, startMinutes: 8 * 60 + 30 }).startMinutes, 8 * 60 + 30, "before 9:00 AM is booked");
  assert.equal(validateInterviewBookingInput({ ...good, durationMinutes: 60, startMinutes: 19 * 60 + 5 }).startMinutes, 19 * 60 + 5, "and 7:05 PM");
  assert.throws(() => validateInterviewBookingInput({ ...good, durationMinutes: 60, startMinutes: 23 * 60 + 30 }), /must end by midnight/);
  assert.throws(() => validateInterviewBookingInput({ ...good, durationMinutes: 20 }), /30 minutes up to the whole day/);
  // Long interviews, up to the whole day — the owner's answer "Both" (2026-09-18).
  assert.equal(validateInterviewBookingInput({ ...good, durationMinutes: 480, startMinutes: 9 * 60 }).durationMinutes, 480, "9 to 5 is one interview");
  assert.equal(validateInterviewBookingInput({ ...good, durationMinutes: 90, startMinutes: 11 * 60 }).durationMinutes, 90);
  assert.throws(() => validateInterviewBookingInput({ ...good, durationMinutes: 480, startMinutes: 16 * 60 + 15 }), /must end by midnight/);
  assert.throws(() => validateInterviewBookingInput({ ...good, durationMinutes: 100 }), /30 minutes up to the whole day/, "only the lengths on offer");
  assert.equal(formatDuration(480), "8 h");
  assert.equal(formatDuration(90), "1 h 30 min");
  assert.equal(formatDuration(45), "45 min");
  assert.throws(() => validateInterviewBookingInput({ ...good, platform: "teams" }), /In office or Zoom/);
  assert.throws(() => validateInterviewBookingInput({ ...good, candidateId: "B-10" }), /candidate/, "the candidate is a record id");
  assert.throws(() => validateInterviewBookingInput({ ...good, dateKey: "2026-02-30" }), /date/);
}

// ── 4b · Sessions ("day 20 from 11 a.m. to 3 p.m.") and people from outside ────────────────────
function runSessionAndOutsideTests() {
  const session = { dateKey: "2026-09-20", durationMinutes: 240, notes: "", platform: "zoom", slotMinutes: 30, startMinutes: 11 * 60, title: "  Medical Reps  day " };
  assert.deepEqual(validateInterviewSessionInput(session), {
    dateKey: "2026-09-20",
    durationMinutes: 240,
    notes: null,
    platform: "zoom",
    slotMinutes: 30,
    startMinutes: 660,
    title: "Medical Reps day",
  });
  assert.deepEqual(
    sessionSlotStarts({ durationMinutes: 240, slotMinutes: 30, startMinutes: 660 }),
    [660, 690, 720, 750, 780, 810, 840, 870],
    "11:00 AM to 3:00 PM in half hours is eight interviews",
  );
  assert.deepEqual(
    sessionSlotStarts({ durationMinutes: 240, slotMinutes: 45, startMinutes: 660 }),
    [660, 705, 750, 795, 840],
    "a slot that does not fit before the end is not offered",
  );
  assert.equal(sessionSlotStarts({ durationMinutes: 240, slotMinutes: 15, startMinutes: 660 }).length, 16);
  assert.throws(() => validateInterviewSessionInput({ ...session, slotMinutes: 20 }), /15, 30, 45 or 60/);
  assert.throws(() => validateInterviewSessionInput({ ...session, durationMinutes: 30, slotMinutes: 45 }), /shorter than one slot/);
  assert.throws(() => validateInterviewSessionInput({ ...session, durationMinutes: 25 }), /at least 30 minutes/);
  assert.equal(validateInterviewSessionInput({ ...session, durationMinutes: 390 }).durationMinutes, 390, "11:00 AM plus 6 h 30 min runs past five, and is fine");
  assert.throws(() => validateInterviewSessionInput({ ...session, durationMinutes: 480, startMinutes: 17 * 60 }), /must end by midnight/, "5:00 PM plus 8 h runs past midnight");
  assert.equal(validateInterviewSessionInput({ ...session, dateKey: "2026-09-18" }).dateKey, "2026-09-18", "a session may be held on a Friday");
  assert.throws(() => validateInterviewSessionInput({ ...session, platform: "phone" }), /In office or Zoom/, "but never as a phone call — a session is one meeting for many");
  assert.throws(() => validateInterviewSessionInput({ ...session, platform: "teams" }), /In office or Zoom/);

  // Someone from outside Phoenix: a name, and a phone or e-mail if known.
  assert.deepEqual(validateExternalPerson({ email: " mona@example.com ", name: "  Mona   Ali ", phone: "010 1234 5678" }), {
    email: "mona@example.com",
    name: "Mona Ali",
    phone: "010 1234 5678",
  });
  assert.deepEqual(validateExternalPerson({ name: "Mona Ali" }), { email: null, name: "Mona Ali", phone: null });
  assert.throws(() => validateExternalPerson({ name: "M" }), /Write the name/);
  assert.throws(() => validateExternalPerson({ name: "Mona Ali", phone: "12" }), /phone number/);
  assert.throws(() => validateExternalPerson({ email: "mona@", name: "Mona Ali" }), /e-mail address/);
  const outside = validateInterviewBookingInput({
    dateKey: "2026-09-20",
    durationMinutes: 30,
    external: { name: "Mona Ali", phone: "01012345678" },
    platform: "in_office",
    startMinutes: 11 * 60,
  });
  assert.equal(outside.candidateId, null, "no Recruitment record unless the booker adds one");
  assert.deepEqual(outside.external, { email: null, name: "Mona Ali", phone: "01012345678" });
  assert.throws(() => validateInterviewBookingInput({ dateKey: "2026-09-20", durationMinutes: 30, platform: "zoom", startMinutes: 660 }), /Choose the candidate/);

  // Their CV: a PDF, a Word document or a picture, up to 10 MB.
  const bytes = Buffer.from("%PDF-1.4");
  assert.equal(checkCvUpload({ bytes, fileName: "Mona CV.PDF", mimeType: "", sizeBytes: bytes.length }).mimeType, "application/pdf", "named by its extension");
  assert.equal(checkCvUpload({ bytes, fileName: "../../etc/cv.pdf", mimeType: "application/pdf", sizeBytes: bytes.length }).fileName, ".. .. etc cv.pdf", "no path in a name");
  assert.throws(() => checkCvUpload({ bytes, fileName: "cv.exe", mimeType: "application/x-msdownload", sizeBytes: bytes.length }), /PDF, a Word document or a picture/);
  assert.throws(() => checkCvUpload({ bytes: Buffer.alloc(0), fileName: "cv.pdf", mimeType: "application/pdf", sizeBytes: 0 }), /empty/);
  assert.throws(() => checkCvUpload({ bytes, fileName: "cv.pdf", mimeType: "application/pdf", sizeBytes: 11 * 1024 * 1024 }), /larger than 10 MB/);
}

// ── 4c · Polls, and WhatsApp that sends nothing by itself ───────────────────────────────────────
function runPollAndWhatsAppTests() {
  const ok = checkPollQuestions([
    { answers: [" Yes ", "No", ""], name: " Did the candidate arrive on time? ", type: "single" },
    { answers: ["ignored"], name: "What stood out?", type: "short_answer" },
  ]);
  assert.deepEqual(ok, {
    questions: [
      { answers: ["Yes", "No"], name: "Did the candidate arrive on time?", type: "single" },
      { answers: [], name: "What stood out?", type: "short_answer" },
    ],
  });
  assert.deepEqual(checkPollQuestions([]), { error: "Add at least one question." });
  assert.deepEqual(checkPollQuestions([{ answers: ["Only one"], name: "Pick", type: "multiple" }]), { error: "Question 1 needs at least two choices." });
  assert.deepEqual(checkPollQuestions([{ answers: [], name: " ", type: "single" }]), { error: "Question 1 has no text." });
  assert.deepEqual(checkPollQuestions([{ answers: ["a", "b"], name: "Pick", type: "rating" }]), { error: "Choose what kind of answer question 1 takes." });

  assert.equal(normalizeEgyptianMobile("010 1234 5678"), "201012345678");
  assert.equal(normalizeEgyptianMobile("+20 100 123 4567"), "201001234567");
  assert.equal(normalizeEgyptianMobile("00201001234567"), "201001234567");
  assert.equal(normalizeEgyptianMobile("1112345678"), "201112345678");
  assert.equal(normalizeEgyptianMobile("123"), null);
  assert.equal(normalizeEgyptianMobile(null), null);
  assert.equal(whatsAppShareUrl("Your interview: 11:00 AM", "01012345678"), "https://wa.me/201012345678?text=Your%20interview%3A%2011%3A00%20AM");
  assert.equal(whatsAppShareUrl("Here is the link"), "https://wa.me/?text=Here%20is%20the%20link", "no number: WhatsApp asks who");
}

// ── 5 · Phoenix makes the Zoom meeting ─────────────────────────────────────────────────────────
async function runZoomTests() {
  assert.equal(readZoomConfig({}), null, "no Zoom variables, no Zoom — the booking still saves");
  assert.equal(
    readZoomConfig({ ZOOM_ACCOUNT_ID: "acc", ZOOM_CLIENT_ID: "cid", ZOOM_CLIENT_SECRET: "sec" }),
    null,
    "all four are needed; three is not connected",
  );
  const config = readZoomConfig({
    ZOOM_ACCOUNT_ID: "﻿acc",
    ZOOM_CLIENT_ID: " cid ",
    ZOOM_CLIENT_SECRET: "sec",
    ZOOM_HOST_USER: "host@example.com",
  }) as ZoomConfig;
  assert.equal(config.accountId, "acc", "a byte-order mark Railway stored inside a value is stripped (AGENTS.md §2.3)");
  assert.equal(config.clientId, "cid");

  const input = { dateKey: "2026-11-01", durationMinutes: 45, startMinutes: 9 * 60 + 30, topic: "Interview · Mona Ali" };
  assert.deepEqual(zoomMeetingBody(input), {
    duration: 45,
    settings: { join_before_host: false, waiting_room: false },
    start_time: "2026-11-01T09:30:00",
    timezone: "Africa/Cairo",
    topic: "Interview · Mona Ali",
    type: 2,
  }, "a scheduled meeting at the Cairo wall-clock time, with no zone on the time — Zoom does the daylight saving");
  assert.equal(zoomMeetingBody(input).settings.waiting_room, false, "no waiting room: the owner had to admit every candidate by hand (2026-09-20)");
  assert.equal(zoomMeetingBody(input).settings.join_before_host, false, "but nobody is in before the interviewer starts it");

  resetZoomTokenCacheForTests();
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const zoom = async (url: string, init?: RequestInit) => {
    calls.push({ init, url });
    if (url.startsWith("https://zoom.us/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3599 }), { status: 200 });
    }
    if (url.endsWith("/meetings") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: 88012345678, join_url: "https://us06web.zoom.us/j/88012345678" }), { status: 201 });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 404 });
    return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
  };

  const meeting = await createZoomMeeting(config, input, zoom);
  assert.deepEqual(meeting, { id: "88012345678", joinUrl: "https://us06web.zoom.us/j/88012345678" });
  assert.equal(calls.length, 2, "one sign-in, one meeting");
  assert.equal(calls[0].url, "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=acc");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    `Basic ${Buffer.from("cid:sec").toString("base64")}`,
    "Server-to-Server OAuth signs in with the client id and secret",
  );
  assert.equal(calls[1].url, "https://api.zoom.us/v2/users/host%40example.com/meetings", "the meeting is made for the host user");
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer tok-1");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), zoomMeetingBody(input));

  await createZoomMeeting(config, input, zoom);
  assert.equal(calls.length, 3, "the token is reused until it expires — one call for the second meeting");

  await deleteZoomMeeting(config, "88012345678", zoom);
  assert.equal(calls.length, 4, "a meeting Zoom no longer has counts as deleted");

  resetZoomTokenCacheForTests();
  const refusing = async (url: string) =>
    url.startsWith("https://zoom.us/oauth/token")
      ? new Response(JSON.stringify({ reason: "Invalid client_id or client_secret" }), { status: 400 })
      : new Response("{}", { status: 500 });
  await assert.rejects(
    () => createZoomMeeting(config, input, refusing),
    /Zoom refused Phoenix's sign-in \(400: Invalid client_id or client_secret\)/,
    "a refusal says what Zoom said, so the calendar can show it",
  );

  // The interviewer's link is the HOST link, so the meeting starts by itself (owner, 2026-09-20).
  resetZoomTokenCacheForTests();
  const hosting = async (url: string) => {
    if (url.startsWith("https://zoom.us/oauth/token")) return new Response(JSON.stringify({ access_token: "tok-2", expires_in: 3599 }), { status: 200 });
    if (url === "https://api.zoom.us/v2/meetings/96901316749") {
      return new Response(JSON.stringify({ id: 96901316749, join_url: "https://zoom.us/j/96901316749?pwd=x", start_url: "https://zoom.us/s/96901316749?zak=abc" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 5, join_url: "https://zoom.us/j/5" }), { status: 200 });
  };
  assert.equal(await getZoomHostStartUrl(config, "96901316749", hosting), "https://zoom.us/s/96901316749?zak=abc", "the host link, not the guest link");
  await assert.rejects(() => getZoomHostStartUrl(config, "5", hosting), /without a host link/, "no host link from Zoom is an error the caller falls back from");
  assert.equal(zoomMeetingIdFromJoinUrl("https://zoom.us/j/96901316749?pwd=i4LnL9nc3IfU7XX8FItmQah9s3BNaB.1"), "96901316749");
  assert.equal(zoomMeetingIdFromJoinUrl("https://us06web.zoom.us/j/88012345678"), "88012345678");
  assert.equal(zoomMeetingIdFromJoinUrl("https://example.com/not-a-meeting"), null);
  resetZoomTokenCacheForTests();
}

// ── 6 · The export: the owner's week grid, every name a link to its CV ─────────────────────────
function booking(overrides: Partial<InterviewBooking> & Pick<InterviewBooking, "id" | "candidateName" | "dateKey" | "startMinutes">): InterviewBooking {
  return {
    bookedByName: "Omar Gawish",
    canReschedule: false,
    candidateId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    candidateJobTitle: null,
    comments: [],
    createdAt: "2026-09-18T10:00:00.000Z",
    durationMinutes: 30,
    ended: false,
    external: false,
    externalCvFileName: null,
    externalCvMimeType: null,
    externalEmail: null,
    externalHasCv: false,
    externalPhone: null,
    hasMeeting: false,
    interviewerHrId: null,
    interviewerName: null,
    interviewRound: null,
    jobTitle: null,
    location: null,
    panelists: [],
    area: null,
    line: null,
    scorecards: [],
    canScoreInterview: false,
    interviewerConfirmation: null,
    confirmationAt: null,
    confirmedByName: null,
    declineReason: null,
    canConfirmInterview: false,
    changeHistory: [],
    notes: null,
    canSetOutcome: false,
    outcome: null,
    outcomeSetAt: null,
    outcomeSetByName: null,
    platform: "in_office",
    sessionId: null,
    sessionTitle: null,
    startsAt: "2026-09-20T06:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    zoomError: null,
    zoomJoinUrl: null,
    zoomStatus: "not_needed",
    ...overrides,
  };
}

async function runExportTests() {
  // Mona's round is for the job her own record already names, so the export must not print it twice.
  const early = booking({
    candidateJobTitle: "Medical Rep",
    candidateName: "Mona Ali",
    dateKey: "2026-09-20",
    id: "00000000-0000-4000-8000-000000000001",
    jobTitle: "Medical Rep",
    startMinutes: 9 * 60,
  });
  const second = booking({
    candidateName: `Karim <b>"Adel"</b> & Sons`,
    dateKey: "2026-09-20",
    id: "00000000-0000-4000-8000-000000000002",
    startMinutes: 9 * 60 + 15,
  });
  // Sara applied as a Medical Rep and is being interviewed for a District Manager seat — two
  // different facts, and the export must say both.
  const zoom = booking({
    candidateJobTitle: "Medical Rep",
    candidateName: "Sara Hassan",
    dateKey: "2026-09-21",
    durationMinutes: 45,
    id: "00000000-0000-4000-8000-000000000003",
    jobTitle: "District Manager",
    outcome: "prioritized",
    platform: "zoom",
    startMinutes: 10 * 60,
    zoomJoinUrl: "https://us06web.zoom.us/j/88012345678",
    zoomStatus: "created",
  });
  const late = booking({ candidateName: "Late Entry", dateKey: "2026-09-22", id: "00000000-0000-4000-8000-000000000004", startMinutes: 17 * 60 });

  const model = buildInterviewCalendarExportModel({
    bookings: [zoom, late, second, early],
    now: new Date("2026-09-18T12:00:00Z"),
    origin: "https://phoenix-hr.satopharma.com/",
    weekStart: "2026-09-23",
  });
  assert.equal(model.weekStart, "2026-09-20", "any day of the week exports that week");
  assert.deepEqual(model.days.map((day) => day.weekday), ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], "the export carries every day of the week");
  assert.deepEqual(
    model.slots[0].perDay[0].map((entry) => entry.id),
    [early.id, second.id],
    "two interviews in one half hour are both drawn, in time order — neither overwrites the other",
  );
  assert.deepEqual(model.slots[2].perDay[1].map((entry) => entry.id), [zoom.id], "Monday 10:00 AM");
  // Any time of day (owner, 7 Nov 2026): the grid widens to give a 5:00 PM interview its own row.
  assert.equal(model.slots.length, 17, "a 5:00 PM interview adds a seventeenth row");
  assert.deepEqual(model.slots[16].perDay[2].map((entry) => entry.id), [late.id], "Tuesday 5:00 PM holds it");
  assert.deepEqual(model.offGrid, [], "so nothing is left off the grid");
  assert.equal(model.bookings.length, 4, "and the list under the grid still holds every interview");

  const link = bookingLink(model, zoom);
  assert.equal(
    link,
    `https://phoenix-hr.satopharma.com/recruitment/interview-calendar?week=2026-09-20&open=${zoom.id}`,
    "a name opens that interview on the calendar with its CV up",
  );
  assert.equal(interviewCalendarFilename(model, "pdf"), "interview-calendar-20-26-september-2026.pdf", "the file is named by its week, in words");
  assert.equal(interviewCalendarFilename(model, "xlsx"), "interview-calendar-20-26-september-2026.xlsx");

  // THE PDF — the owner's first choice, "I click on name the CV appear even in the export".
  const html = buildInterviewCalendarPdfHtml(model);
  for (const entry of [early, zoom]) {
    assert.ok(
      // `&amp;` because it is an attribute in HTML; Chromium decodes it back when it writes the PDF link.
      html.includes(`<a class="name" href="${bookingLink(model, entry).replace(/&/g, "&amp;")}">${entry.candidateName}</a>`),
      `${entry.candidateName}'s name is a link in the PDF`,
    );
  }
  assert.ok(html.includes("Karim &lt;b&gt;&quot;Adel&quot;&lt;/b&gt; &amp; Sons"), "a name is text, never markup");
  assert.ok(!html.includes(`<b>"Adel"</b>`), "so nothing a CV calls itself can draw into the document");
  assert.ok(html.includes("Week of: 20 September"), "headed the way the owner's sheet is");
  assert.ok(html.includes(`href="https://us06web.zoom.us/j/88012345678"`), "a Zoom interview carries its link");
  // HOW IT WENT (owner, 2026-09-20): on the grid tile and in its own list column, only once recorded.
  assert.ok(html.includes("Outcome: Prioritized"), "the grid tile says how the interview went");
  assert.ok(html.includes("<th>Outcome</th>") && html.includes("<td>Prioritized</td>"), "and the list has an Outcome column");
  assert.equal(html.split("Outcome: ").length - 1, 1, "an interview with no outcome recorded prints none");

  // THE ROLE THE INTERVIEW IS FOR (owner, 2026-10-15): on the grid tile beside the area and the line,
  // and in its own column in the list under it. Blank where nobody named one — never a dash.
  assert.ok(html.includes("Role: District Manager"), "the grid tile names the role the interview is for");
  assert.equal(html.split("Role: ").length - 1, 2, "and only the two interviews that name one print it — the rest print nothing at all");
  const listTable = html.slice(html.indexOf(`<table class="list">`), html.indexOf("</table>", html.indexOf(`<table class="list">`)));
  const listTableRows = [...listTable.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => cell[1].trim()),
  );
  const roleColumn = listTableRows[0].indexOf("Role");
  assert.equal(roleColumn, 3, "the list's Role column sits straight after the candidate whose interview it is");
  const listRowFor = (entry: InterviewBooking) => {
    const cells = listTableRows.find((row) => row.join(" ").includes(entry.id));
    assert.ok(cells, `${entry.candidateName} has a row in the PDF list`);
    return cells as string[];
  };
  assert.equal(listRowFor(zoom)[roleColumn], "District Manager", "the list prints the role that interview is for");
  assert.equal(listRowFor(second)[roleColumn], "", "and leaves the cell empty when nobody named one — no dash, nothing a reader could take for an answer");
  assert.equal(listRowFor(late)[roleColumn], "", "including the interview that sits outside the grid");
  assert.ok(listRowFor(zoom)[2].includes("Applied for Medical Rep"), "what the candidate's own record says is kept beside the role when the two differ");
  assert.ok(!listRowFor(early)[2].includes("Applied for"), "and is not said twice when the role is the job they applied for");
  {
    // THE FITS-THE-SCREEN RULE: the column was fitted by re-weighting the others, never by widening
    // the paper, adding a sideways scroll or shrinking the type.
    const widths = [...(/<colgroup>([\s\S]*?)<\/colgroup>/.exec(listTable)?.[1] ?? "").matchAll(/width:(\d+(?:\.\d+)?)%/g)].map((match) =>
      Number(match[1]),
    );
    assert.equal(widths.length, listTableRows[0].length, "every list column is weighted, the new one included");
    assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, "and the weights still add up to the width of the page");
    assert.ok(html.includes("font-size: 8pt"), "the body type is the size it always was — no column is paid for by shrinking it");
    assert.ok(!/overflow-x/.test(html) && !/min-width:\s*[1-9]/.test(html), "and nothing on the sheet scrolls sideways");
  }
  assert.ok(html.includes("border-radius: 0 !important"), "square edges, the house rule");
  assert.doesNotMatch(html, /border-radius:\s*[1-9]/, "and no corner is rounded anywhere");

  // THE PREMIUM DRESS (owner, 13 Oct 2026: "change to the premium look"). Dress only — every word, column,
  // row and name link asserted above is still there — so these pin the new masthead, sheet and foot
  // where the old hand-rolled letterhead and Chrome's "Page N of M" used to be asserted by omission.
  assert.ok(html.includes('<header class="pm-mast pm-mast--compact">'), "the premium masthead heads the sheet, compact so the grid keeps its height");
  assert.ok(html.includes('<h1 class="pm-mast__t pm-mast__t--en" dir="ltr" lang="en">Interview Calendar</h1>'), "and its title is the one the old letterhead carried");
  assert.ok(
    html.includes("Week of: 20 September · 20 – 26 September 2026 · generated 18 September 2026 at 15:00 (Cairo)"),
    "the old letterhead's one subtitle line is the masthead's subtitle, word for word",
  );
  assert.ok(!html.includes('class="lh"') && !html.includes("rpt__title"), "the hand-rolled letterhead is gone, not hidden");
  assert.ok(html.includes("@page { size: A4 landscape; margin: 0; }"), "the sheet is the turned A4 with no page margin, so the frame and foot reach the edge");
  assert.equal(html.split('class="pm-chrome pm-chrome--landscape"').length - 1, 1, "one landscape chrome, which print repeats on every page");
  const foot = /<div class="pm-foot__code" dir="ltr">([^<]*)<\/div>/.exec(html)?.[1] ?? "";
  assert.equal(
    foot,
    "Sato Pharma · Interview Calendar · 20 – 26 September 2026 · SATO-DIS-2026-01 v1.0",
    "the running foot names the company, the paper and its week — what Chrome's footer used to say — and the identity code",
  );
  assert.ok(!/phoenix/i.test(foot), "a company paper's foot says Sato Pharma, never Phoenix");
  assert.ok(html.includes('<div class="pm-foot__ph"></div>'), "the foot's left slot is empty — a Sato-only foot, with no Phoenix label or emblem");
  assert.ok(!/phoenix/i.test(html.slice(html.indexOf('<div class="pm-chrome'))), "nothing in the chrome — label, emblem or microtext — names Phoenix");
  assert.ok(html.includes('class="pm-foot__page"'), "the foot keeps the slot the page count is written into after layout");
  assert.ok(!/Page \d+ of \d+|pageNumber|totalPages/.test(html), "and no page count is printed by the page itself — Chrome's footer is off and the stamped count is the only one");
  {
    // The ink rule: no filled area except the 6% zebra row. Every rule that paints a background must be an even row.
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const fills = [...css.matchAll(/([^{}]+)\{([^{}]*\bbackground(?:-color)?\s*:[^{}]*)\}/g)].map((match) => match[1].trim());
    assert.ok(fills.length >= 2, "the zebra rows are still there to be found, so this scan is not blind");
    assert.ok(fills.every((selector) => /nth-child\(even\)/.test(selector)), `only the zebra row is filled — ${fills.join(" | ")}`);
  }
  assert.ok(!/box-shadow|text-shadow|gradient\(/.test(html), "no shadow and no gradient anywhere on the sheet");

  // THE ROUTE prints it that way: margin 0 and no Chrome header or footer, the brand artwork inlined, and the
  // page count stamped afterwards. A unit test cannot run Chromium, so the wiring is read at the source.
  {
    const route = stripComments(readFileSync("app/api/recruitment/interview-calendar/export/route.ts", "utf8"));
    assert.ok(!route.includes("displayHeaderFooter") && !route.includes("footerTemplate"), "Chrome's own header and footer are off");
    assert.ok(/margin:\s*\{\s*bottom:\s*"0",\s*left:\s*"0",\s*right:\s*"0",\s*top:\s*"0"\s*\}/.test(route), "the page margin is zero — the premium sheet draws its own");
    assert.ok(route.includes("landscape: true") && route.includes("preferCSSPageSize: true"), "the paper stays A4 landscape");
    assert.ok(route.includes("inlineLocalAssets(buildInterviewCalendarPdfHtml(model))"), "the /brand artwork is inlined, since setContent has no base URL");
    assert.ok(route.includes("data-pm-numbered") && route.includes("stampPremiumPageNumbers(bytes)"), "the page count is stamped into the foot after Chromium has counted");
  }

  // THE WORKBOOK — every name a real hyperlink, in the grid AND in the list.
  const workbook = new ExcelJS.Workbook();
  const buffer = await buildInterviewCalendarWorkbook(model);
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const linksIn = (sheetName: string) => {
    const sheet = workbook.getWorksheet(sheetName);
    assert.ok(sheet, `the workbook has a ${sheetName} sheet`);
    const found: Array<{ text: string; hyperlink: string }> = [];
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        const value = cell.value as { hyperlink?: string; text?: unknown } | null;
        if (value && typeof value === "object" && typeof value.hyperlink === "string") {
          found.push({ hyperlink: value.hyperlink, text: String(value.text ?? "") });
        }
      }),
    );
    return found;
  };
  const gridLinks = linksIn("Week");
  for (const entry of [early, second, zoom]) {
    assert.ok(
      gridLinks.some((cell) => cell.hyperlink === bookingLink(model, entry) && cell.text.startsWith(entry.candidateName)),
      `${entry.candidateName} is a link in the week grid`,
    );
  }
  const listSheet = workbook.getWorksheet("Interviews");
  const listCells: string[] = [];
  listSheet?.eachRow((row) => row.eachCell((cell) => listCells.push(String(cell.value ?? ""))));
  assert.ok(listCells.includes("Outcome") && listCells.includes("Prioritized"), "the workbook's list has an Outcome column carrying the word");
  assert.ok(gridLinks.some((cell) => cell.text.includes("Outcome: Prioritized")), "and the week grid's tile says it too");

  // THE ROLE, in the workbook: on the week tile beside the area and the line, and in the list in its
  // own column next to what the candidate's own record says they applied for.
  assert.ok(gridLinks.some((cell) => cell.text.includes("Role: District Manager")), "the workbook's week tile names the role the interview is for");
  {
    const cellText = (value: ExcelJS.CellValue): string =>
      value && typeof value === "object" && "text" in value ? String((value as { text?: unknown }).text ?? "") : String(value ?? "");
    let headerRow = 0;
    listSheet?.eachRow((row, number) => {
      if (cellText(row.getCell(1).value) === "Day") headerRow = number;
    });
    assert.ok(headerRow > 0, "the list sheet's header row is there to read");
    const headers = Array.from({ length: 12 }, (_, index) => cellText(listSheet?.getRow(headerRow).getCell(index + 1).value));
    const roleAt = headers.indexOf("Role") + 1;
    assert.ok(roleAt > 0, "the list sheet has a Role column");
    assert.equal(headers.indexOf("Applied for"), roleAt, "and it sits beside Applied for — the role of this round, then the job the candidate's own record names");
    const rowFor = (entry: InterviewBooking) => {
      for (let number = headerRow + 1; number <= (listSheet?.rowCount ?? 0); number += 1) {
        const candidate = listSheet?.getRow(number).getCell(3).value as { hyperlink?: string } | null;
        if (candidate && typeof candidate === "object" && candidate.hyperlink === bookingLink(model, entry)) return listSheet?.getRow(number);
      }
      return assert.fail(`${entry.candidateName} has a row in the workbook's list`);
    };
    assert.equal(cellText(rowFor(zoom)?.getCell(roleAt).value), "District Manager", "the workbook prints the role that interview is for");
    assert.equal(cellText(rowFor(zoom)?.getCell(roleAt + 1).value), "Medical Rep", "and what the candidate applied for, unchanged, beside it");
    assert.equal(cellText(rowFor(second)?.getCell(roleAt).value), "", "an interview nobody named a role for leaves the cell empty — never a dash that reads as data");
  }
  const listLinks = linksIn("Interviews");
  for (const entry of [early, second, zoom, late]) {
    assert.ok(
      listLinks.some((cell) => cell.hyperlink === bookingLink(model, entry) && cell.text === entry.candidateName),
      `${entry.candidateName} is a link in the list — the off-grid one included`,
    );
  }
}

// ── 7 · The wiring: every route gated, nothing sent to the candidate, a button on every CV ─────
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} still exists`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir))) {
    const relative = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), relative)).isDirectory()) out.push(...routeFiles(relative));
    else if (entry === "route.ts") out.push(relative);
  }
  return out;
}

function runWiringTests() {
  const domain = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  const links = stripComments(read("src/lib/recruitment/interview-calendar-links.ts"));
  const extras = stripComments(read("src/lib/recruitment/interview-calendar-zoom-extras.ts"));

  // THE ONE GATE, inside every domain function — asked about the week each touches, because a copy
  // link may open one week only.
  type Need = "view" | "comment" | "book" | "share";
  const gates: Array<[string, string, Need]> = [
    [domain, "addInterviewComment", "comment"],
    [domain, "cancelInterviewBooking", "book"],
    [domain, "cancelInterviewSession", "book"],
    [domain, "createInterviewBooking", "book"],
    [domain, "createInterviewSession", "book"],
    [domain, "getInterviewBooking", "view"],
    [domain, "getInterviewCalendarCandidateApplication", "view"],
    [domain, "getInterviewCalendarCandidateFile", "view"],
    [domain, "getInterviewExternalCv", "view"],
    [domain, "getInterviewManagerSharePlan", "share"],
    [domain, "getInterviewSession", "view"],
    [domain, "listInterviewCalendarCandidateFiles", "view"],
    [domain, "listInterviewCalendarDay", "view"],
    [domain, "listInterviewCalendarShares", "share"],
    [domain, "listInterviewCalendarWeek", "view"],
    [domain, "listUpcomingInterviewsForCandidate", "view"],
    [domain, "resolveInterviewMeeting", "view"],
    [domain, "retryInterviewSessionZoom", "book"],
    [domain, "retryInterviewZoomMeeting", "book"],
    [domain, "saveInterviewManagerShare", "share"],
    [domain, "searchInterviewCalendarPeople", "share"],
    [domain, "searchInterviewCandidates", "book"],
    [domain, "shareInterviewCalendar", "share"],
    [domain, "unshareInterviewCalendar", "share"],
    [domain, "updateInterviewBooking", "book"],
    [domain, "updateInterviewSession", "book"],
    [links, "createInterviewCalendarLink", "share"],
    [links, "deleteInterviewCalendarLink", "share"],
    [links, "listInterviewCalendarLinks", "share"],
    [links, "updateInterviewCalendarLink", "share"],
    [extras, "addInterviewPoll", "book"],
    [extras, "createInterviewPollSet", "book"],
    [extras, "deleteInterviewPollSet", "book"],
    [extras, "listInterviewPollSets", "book"],
    [extras, "removeInterviewPoll", "book"],
    [extras, "retryInterviewPoll", "book"],
    [extras, "updateInterviewPollSet", "book"],
  ];
  for (const [source, name, need] of gates) {
    assert.match(
      functionBody(source, name),
      new RegExp(`requireCalendarAccess\\(caller, "${need}"`),
      `${name} must pass the calendar's gate for "${need}"`,
    );
  }
  // What Zoom reported, the invitation and the polls on a meeting are read through the meeting, whose
  // resolver is gated above for the week the interview is in.
  for (const name of ["getInterviewInvitation", "getInterviewZoomInsights", "listInterviewPolls"]) {
    assert.match(functionBody(extras, name), /resolveInterviewMeeting\(caller, /, `${name} reads the meeting through its gate`);
  }
  // A CV is the most private thing on the calendar: a link holder who has not signed in opens it
  // only if the owner left "CVs open without sign-in" on.
  assert.match(functionBody(domain, "getInterviewExternalCv"), /assertCvsOpenTo\(caller\)/, "an outside person's CV keeps the guest-CV switch");
  assert.match(domain, /async function assertCandidateOnCalendar[\s\S]*?assertCvsOpenTo\(caller\);\r?\n\}/, "and so does every Recruitment CV on it");

  // Every route resolves who is asking and the link they came through, every write is same-origin
  // first, and every handler reaches the gate — its own, or the one inside the function it calls.
  const gatedCalls = [
    "requireCalendarAccess(caller,",
    "calendarRoleFor(caller,",
    ...gates.map(([, name]) => `${name}(caller`),
    "getInterviewInvitation(caller",
    "getInterviewZoomInsights(caller",
    "listInterviewPolls(caller",
    // The invitation module's three entry points and the "Zoom is starting" check; each is pinned to
    // its own gate in tests/interview-invitation.test.ts.
    "getInterviewInvitationPlan(caller",
    "emailInterviewInvitation(caller",
    "recordInterviewWhatsAppOpened(caller",
    "listDueZoomInterviews(caller",
    "setInterviewOutcome(caller",
    "saveInterviewScorecard(caller",
    // The role an interview is for: the suggestion list holds the calendar's own "book" gate (never
    // offers:read — the people who book interviews are not the people who write offer letters), and
    // the outcome prompt's loader holds "view" and then narrows to who may record the outcome.
    "listInterviewJobTitleOptions(caller",
    "listInterviewsAwaitingOutcome(caller",
    // Tier 3: the lead confirms/declines the assignment; an outside candidate's CV is replaced after
    // booking. Each resolves the caller and checks a right before it touches the row.
    "setInterviewerConfirmation(caller",
    "replaceInterviewExternalCv(caller",
    // The two-step request flow (interview-requests.ts). Each entry point resolves the caller and
    // checks a right before it touches a row — pinned in tests/interview-requests.test.ts.
    "listMyInterviewRequests(caller",
    "listInterviewRequestsInbox(caller",
    "createInterviewRequest(caller",
    "getInterviewRequest(caller",
    "scheduleInterviewRequestItem(caller",
    "cancelInterviewRequest(caller",
    "getInterviewRequestItemCv(caller",
    // The per-person .ics subscription: minting a feed token is its own gate — signed-in Phoenix
    // person only, and only their own token (interview-calendar-ics.ts).
    "getOrCreateMyCalendarFeedToken(caller",
  ];
  const routes = routeFiles("app/api/recruitment/interview-calendar");
  assert.ok(routes.length >= 28, `the calendar's routes were found (${routes.length})`);
  // The ONE public route: the per-person .ics subscription feed. A calendar app (Outlook, Google, the
  // phone) cannot sign in to Phoenix, so the bearer token IS the credential — exactly the copy-link
  // model the owner chose. It resolves no Phoenix sign-in by design; its contract is pinned on its own
  // below. Everything else on the calendar must still resolve who is asking and reach the gate.
  const PUBLIC_ICS_FEED = "app/api/recruitment/interview-calendar/ics/[token]/route.ts";
  for (const file of routes) {
    if (file.replace(/\\/g, "/").endsWith(PUBLIC_ICS_FEED)) continue;
    // A call wrapped over several lines — `createInterviewBooking(\n  caller,` — is still the call.
    const source = stripComments(read(file)).replace(/\(\s+/g, "(");
    const handlers = source.split(/(?=export async function (?:GET|POST|PATCH|PUT|DELETE)\()/).slice(1);
    assert.ok(handlers.length > 0, `${file} exports a handler`);
    for (const handler of handlers) {
      const method = /export async function (\w+)/.exec(handler)?.[1] ?? "?";
      const where = `${file} ${method}`;
      const resolved = handler.indexOf("resolveAccessContext(request)");
      assert.ok(resolved > 0, `${where} must resolve who is asking`);
      assert.ok(handler.indexOf("interviewCalendarCaller(access, request)") > resolved, `${where} must read the copy link it came with`);
      if (method !== "GET") {
        const csrf = handler.indexOf("assertSameOriginMutation(request)");
        assert.ok(csrf > 0 && csrf < resolved, `${where} must refuse a cross-site write before anything else`);
      }
      assert.ok(gatedCalls.some((call) => handler.includes(call)), `${where} must reach the calendar's gate`);
    }
  }

  // STORED AS A HASH, SHOWN ONCE, METERED (REC-055). A link is found by its hash and never by itself;
  // no read of the table asks for the old column; a new link is stored without it and handed back whole
  // only in the answer that made it; every lookup is metered per address and per link BEFORE it runs.
  assert.ok(domain.includes('.eq("token_hash", hashInterviewCalendarLinkToken(token))'), "a link is found by its hash");
  assert.ok(!/\.eq\("token",/.test(domain) && !/\.eq\("token",/.test(links), "no read looks a link up by the link itself");
  assert.ok(!/(^|,)token(,|$)/.test(/LINK_COLUMNS =\s*"([^"]+)"/.exec(domain)?.[1] ?? "token"), "the list never reads the old token column");
  const insert = links.slice(links.indexOf(".insert({"), links.indexOf("})", links.indexOf(".insert({")));
  assert.ok(insert.includes("token_hash: hashInterviewCalendarLinkToken(token)") && insert.includes("token_preview: token.slice(0, 8)"), "a new link is stored as its hash and its first 8 characters");
  assert.ok(!/(^|[\s{,])token\s*[:,}]/m.test(insert), "a new link is never stored whole");
  assert.ok(insert.includes("expires_at:"), "a new link is given its expiry");
  assert.ok(links.includes("created: { id: String((data as { id: string }).id), token }"), "the whole link comes back once, in the answer that made it");
  const linksRoute = stripComments(read("app/api/recruitment/interview-calendar/links/route.ts"));
  assert.ok(linksRoute.includes("{ created, links, success: true }") && linksRoute.includes('"Cache-Control": "no-store"'), "the new link is handed back once, never cached");
  const callerBody = domain.slice(domain.indexOf("export async function interviewCalendarCaller"));
  const metered = callerBody.indexOf("assertInterviewCalendarLinkRate(request, token)");
  assert.ok(metered > 0 && metered < callerBody.indexOf("loadInterviewCalendarLinkByToken(token)"), "every API lookup is metered before the link is looked up");
  assert.ok(domain.includes('scope: "interview_calendar_link_ip"') && domain.includes('scope: "interview_calendar_link_token"'), "metered per address and per link");
  const sharedPage = stripComments(read("app/share/interview-calendar/[token]/page.tsx"));
  const pageMeter = sharedPage.indexOf("assertInterviewCalendarLinkRate(asked, token)");
  assert.ok(pageMeter > 0 && pageMeter < sharedPage.indexOf("openInterviewCalendarLink(token, access)"), "the shared page is metered before it opens the link");
  assert.ok(sharedPage.includes("more than 90 days old"), "the dead-link page names expiry as a reason");
  const copySection = stripComments(read("src/components/recruitment/interview-calendar/copy-link-section.tsx"));
  assert.ok(!/\blink\.token\b/.test(copySection), "the owner's list never holds a whole link it was not just given");
  assert.ok(copySection.includes("tokenPreview"), "the owner's list shows each link by its first 8 characters");

  // THE CANDIDATE IS SENT NOTHING — the owner's answer. Only the person a calendar is shared with
  // hears about it, in the app. The invitation and a copy link go out only through WhatsApp opening
  // on the booker's own device (wa.me), where nothing leaves until they press Send.
  for (const [source, name] of [[domain, "the calendar"], [links, "copy links"], [extras, "Zoom's extras"]] as const) {
    assert.doesNotMatch(source, /@\/lib\/(email|whatsapp)|sendEmail|sendWhatsApp|resend/i, `${name} send no email or WhatsApp`);
  }
  assert.match(domain, /channels: \["in_app", "push"\]/, "the one notice is in-app to the person it was shared with");
  for (const file of ["src/components/recruitment/interview-calendar/zoom-panels.tsx", "src/components/recruitment/interview-calendar/copy-link-section.tsx"]) {
    const source = stripComments(read(file));
    assert.match(source, /whatsAppShareUrl\(/, `${file} hands WhatsApp the text to send`);
    assert.doesNotMatch(source, /\/api\/(whatsapp|email|sato-email)/, `${file} never sends from Phoenix`);
  }

  // The copy-link page: outside every shell, never indexed, and it asks the link what it gives.
  const sharePage = stripComments(read("app/share/interview-calendar/[token]/page.tsx"));
  assert.match(sharePage, /robots: \{ follow: false, index: false, nocache: true \}/, "a copy link is never indexed");
  assert.match(sharePage, /openInterviewCalendarLink\(token, access\)/, "the page opens only what the link gives");
  assert.match(
    read("src/lib/error-monitor/redact-route.ts"),
    /"\/share\/interview-calendar",/,
    "a copy link's token is redacted from the error log (tests/error-monitor-redact-route.test.ts pins the list)",
  );

  // The new tables are service-role only, like the first ones; the link table holds bearer tokens.
  const second = read("supabase/migrations/20260918215608_ats_interview_calendar_sessions_links_zoom.sql").replace(/--[^\n]*/g, "");
  for (const table of ["ats_interview_sessions", "ats_interview_calendar_links", "ats_interview_poll_sets", "ats_interview_zoom_polls", "ats_interview_zoom_insights"]) {
    assert.match(second, new RegExp(`alter table public\\.${table} enable row level security;`), `${table} has RLS on`);
    assert.match(second, new RegExp(`revoke all on table public\\.${table} from anon, authenticated;`), `${table} is closed to the browser key`);
  }
  assert.doesNotMatch(second, /grant [^;]* to (anon|authenticated)/i, "and nothing grants them back");
  assert.match(second, /token text not null unique/, "a link token is unique");

  // The tables are service-role only.
  const migration = read("supabase/migrations/20260918195837_ats_interview_calendar.sql");
  for (const table of ["ats_interview_bookings", "ats_interview_calendar_shares", "ats_interview_booking_comments"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`), `${table} has RLS on`);
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from anon, authenticated;`), `${table} is closed to the browser key`);
  }
  assert.doesNotMatch(migration, /grant [^;]* to (anon|authenticated)/i, "and nothing grants it back");

  // A button that would answer "Forbidden" is worse than none.
  const button = stripComments(read("src/components/recruitment/interview-calendar/schedule-interview-button.tsx"));
  assert.match(button, /if \(!canBookInterviews\(me\.role\)\) return null;/, "the button draws only for someone who can book");

  // "from any screen, any CV".
  const surfaces: Array<[string, string]> = [
    ["src/components/recruitment/workstation/workstation-review-header.tsx", "screening"],
    ["src/components/recruitment/recruitment-workspace.tsx", "the recruitment profile and its CV previews"],
    ["src/components/recruitment/whatsapp-applicants-search.tsx", "WhatsApp Applicants"],
    ["src/components/recruitment/candidate-record-page.tsx", "the candidate's own page"],
    ["src/components/recruitment/candidate-folders-tab.tsx", "the folders' CV preview"],
    ["src/components/recruitment/manager-engagement-view.tsx", "the manager-engagement CV preview"],
    ["src/components/employee-portal/candidate-cv-actions.tsx", "the portal's CV preview"],
  ];
  for (const [file, where] of surfaces) {
    assert.match(stripComments(read(file)), /<ScheduleInterviewButton\b/, `${where} offers Schedule interview`);
  }
  const header = stripComments(read("src/components/recruitment/workstation/workstation-review-header.tsx"));
  const decisions = header.slice(header.indexOf("const decisions = ("), header.indexOf("const afterBands = ("));
  const linkedIn = decisions.indexOf('label="LinkedIn"');
  const schedule = decisions.indexOf('label="Schedule interview"');
  const shortlist = decisions.indexOf('label="Shortlist"');
  assert.ok(
    linkedIn > 0 && linkedIn < schedule && schedule < shortlist,
    "on screening it sits in the strip BOTH bands render, with the ways of reaching the person and before the verdicts",
  );
  assert.match(
    stripComments(read("src/components/recruitment/cv-preview-modal.tsx")),
    /\{headerActions\}/,
    "the CV preview draws what its caller hands it, which is how a preview anywhere gets the button",
  );

  // An interview booked straight from a calendar cell — the only path that can book someone from
  // OUTSIDE Phoenix — can name the interviewer too, so an outside candidate's interview reaches the
  // chosen interviewer's own calendar (owner, 2026-09-26). Before this the cell dialog carried no
  // picker, so every cell-booked outside interview was born with interviewer_hr_id null and stayed
  // invisible to interviewers. The domain already resolves an interviewer on an external booking.
  const cellDialog = stripComments(read("src/components/recruitment/interview-calendar/cell-dialog.tsx"));
  assert.match(cellDialog, /<InterviewerPicker\b/, "the cell booking offers an interviewer picker");
  assert.match(cellDialog, /interviewerHrId:\s*interviewer\?\.hrId\s*\?\?\s*null/, "and it sends the chosen interviewer with the booking, external candidate included");

  // Editing an interview already on the calendar (owner, 2026-09-26): change the interviewer — on a
  // PAST interview too — and add/fix the outside person's name, phone and e-mail (the forgotten
  // WhatsApp number). It is a details-only edit: the domain touches no time, place or Zoom meeting,
  // so it needs no bookable window and the Move pop-up's future-only day grid does not stand in the
  // way. An external person's contact lives on the booking; a Recruitment candidate's does not, so
  // the edit is refused there.
  const domainSrc = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  const updateFn = domainSrc.slice(domainSrc.indexOf("export async function updateInterviewBooking"));
  assert.match(updateFn.slice(0, updateFn.indexOf("{", updateFn.indexOf("zoomConfig"))), /external\?:\s*unknown/, "updateInterviewBooking accepts an external contact patch");
  assert.match(updateFn, /const detailsOnly =/, "a details-only edit path exists so a past interview can be edited");
  assert.match(updateFn, /resolveExternalContactPatch\(row, patch\.external\)/, "external contact is resolved on update");
  assert.match(domainSrc, /function resolveExternalContactPatch[\s\S]*?row\.candidate_id[\s\S]*?candidate record/, "a Recruitment candidate's contact is not edited on the booking");
  const patchRoute = stripComments(read("app/api/recruitment/interview-calendar/bookings/[id]/route.ts"));
  assert.match(patchRoute, /external:\s*body\.external/, "the PATCH route forwards the external contact patch");
  const editDialog = stripComments(read("src/components/recruitment/interview-calendar/edit-details-dialog.tsx"));
  assert.match(editDialog, /<InterviewerPicker\b/, "the edit dialog offers the interviewer picker");
  assert.match(editDialog, /interviewerHrId:\s*interviewer\?\.hrId\s*\?\?\s*null/, "the edit dialog sends the chosen (or cleared) interviewer");
  assert.match(editDialog, /body\.external = \{/, "the edit dialog sends the outside person's name, phone and e-mail");
  const viewSrc = stripComments(read("src/components/recruitment/interview-calendar/interview-calendar-view.tsx"));
  assert.match(viewSrc, /<EditInterviewDetailsDialog\b/, "the interview panel opens the edit dialog");

  // The DISTRICT MANAGER WHO REQUESTED an interview may change its day, time and place (owner,
  // 2026-10-04: "make able to change the day of the requester booked interview"). The requester is
  // identified by the booking's requested_by_hr_id, passes the book gate on their OWN request only,
  // and is held to when/where — the interviewer, panel, area/line, outside contact and session stay
  // HR's. HR's full Move is unchanged. Break any one of these and the matching assertion fires.
  assert.match(updateFn, /const isRequester =[\s\S]*?canonicalHrIdKey\(row\.requested_by_hr_id\)/, "the requester is the booking's requested_by person");
  assert.match(updateFn, /if \(!hasBook && !isRequester\) requireCalendarAccess\(caller, "book"/, "a requester passes the book gate on their own request's booking");
  assert.match(
    updateFn,
    /if \(!hasBook\) \{[\s\S]*?patch\.interviewerHrId !== undefined[\s\S]*?patch\.panelistHrIds !== undefined[\s\S]*?patch\.area !== undefined[\s\S]*?patch\.line !== undefined[\s\S]*?patch\.external !== undefined[\s\S]*?patch\.sessionId !== undefined[\s\S]*?throw new Error/,
    "a non-book caller (the requester) is refused the interviewer, panel, area/line, outside contact and session",
  );
  assert.match(updateFn, /if \(hasBook\) requireCalendarAccess\(caller, "book", weekStartFor\(input\.dateKey\)\)/, "only the booking tier is re-gated for the destination week — a requester may move across weeks");
  assert.match(domainSrc, /canReschedule:[\s\S]*?canonicalHrIdKey\(row\.requested_by_hr_id\)/, "the hydrated booking tells the requester (or booking tier) it may be rescheduled");
  assert.match(viewSrc, /booking\.canReschedule \?/, "the interview panel offers the requester a move control");
  assert.match(viewSrc, /Change day & time/, "the requester's control reads 'Change day & time'");
  assert.match(viewSrc, /timeOnly=\{!canBook\}/, "the move dialog is time-only for a requester, full for HR");
  const scheduleDialog = stripComments(read("src/components/recruitment/interview-calendar/schedule-interview-dialog.tsx"));
  assert.match(scheduleDialog, /timeOnly\?: boolean/, "the schedule dialog accepts a timeOnly flag");
  // The place is the platform and, for an in-person interview, its location (8 Nov 2026 workflow §5) —
  // updateInterviewBooking lets a requester change both and refuses every HR-only field.
  assert.match(scheduleDialog, /timeOnly\s*\r?\n?\s*\? \{ dateKey, durationMinutes, location: place, notes: notes\.trim\(\), platform, startMinutes \}/, "a timeOnly save sends only day, time and place — never the HR-only fields");

  // "My interviews" on the portal home + a per-person .ics subscription (owner, 2026-09-26: make the
  // calendar relevant to everyone daily). The card travels inside the ONE identity band every role
  // lands on, and myInterviews is a REQUIRED band prop so no landing surface can silently drop it —
  // every call site must pass it, which the required prop enforces at compile time.
  const domainSrc2 = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  assert.match(domainSrc2, /export async function listMyUpcomingInterviews\(/, "the domain lists a person's own upcoming interviews");
  assert.match(domainSrc2, /export async function listInterviewsForCalendarFeed\(/, "the domain lists a person's interviews for the .ics feed");
  const snapshot = stripComments(read("src/lib/employee-portal/home-snapshot.ts"));
  assert.match(snapshot, /myInterviews: Streamed<PortalMyInterview\[\]>/, "the portal snapshot carries the person's own interviews");
  assert.match(snapshot, /loadMyUpcomingInterviews\(access\)/, "the snapshot computes them");
  const band = stripComments(read("src/components/employee-portal/portal-command-center.tsx"));
  assert.match(band, /<MyInterviewsCard interviews=\{myInterviews\} \/>/, "the identity band renders the My interviews card");
  assert.match(band, /myInterviews: Streamed<PortalMyInterview\[\]>;/, "the band takes myInterviews as a required prop (no landing surface can drop it)");
  for (const file of [
    "src/components/employee-portal/portal-command-center.tsx",
    "src/components/employee-portal/dashboards/rm-command-center.tsx",
    "src/components/employee-portal/dashboards/nsm-command-center.tsx",
    "src/components/employee-portal/dashboards/marketing-manager-command-center.tsx",
    "src/components/employee-portal/dashboards/dsm-command-center.tsx",
  ]) {
    const src = stripComments(read(file));
    if (!src.includes("<PortalIdentityBand")) continue;
    assert.doesNotMatch(src, /<PortalIdentityBand(?![^>]*myInterviews)[^>]*\/>/, `${file} passes myInterviews to every identity band`);
  }
  const feedRoute = stripComments(read("app/api/recruitment/interview-calendar/ics/[token]/route.ts"));
  assert.match(feedRoute, /text\/calendar/, "the .ics feed route serves text/calendar");
  assert.match(feedRoute, /buildCalendarFeedForToken\(/, "the feed is built from the token alone");
  assert.doesNotMatch(feedRoute, /resolveAccessContext/, "the feed is public by design — the bearer token is the credential, so no Phoenix sign-in");
  const myFeedRoute = stripComments(read("app/api/recruitment/interview-calendar/my-calendar-feed/route.ts"));
  assert.match(myFeedRoute, /getOrCreateMyCalendarFeedToken\(caller\)/, "the subscribe route mints the person's own feed token");

  // Interview PANELS (owner, 2026-09-26): an interview may have more than one interviewer. The lead
  // (interviewer_hr_id) stays the outcome-setter and Zoom host; additional panel members (an array
  // column) each SEE the interview — on the calendar, in "My interviews" and on their .ics feed. The
  // read gate, the personal list and the feed all check panel membership, and panel members are
  // District Managers and above, deduped, never the lead.
  const domainPanel = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  assert.match(domainPanel, /panelist_hr_ids/, "the booking carries a panel array");
  assert.match(domainPanel, /async function resolvePanelists\(/, "the panel is validated (District Managers and above, deduped, never the lead)");
  assert.match(domainPanel, /Panel members are District Managers and above/, "panel members meet the interviewer rank rule");
  assert.match(domainPanel, /isOnPanel\(viewer, row\.panelist_hr_ids\)/, "a panel member may read the interview");
  assert.match(domainPanel, /isOnPanel\(me, row\.panelist_hr_ids\)/, "a panel member's own list and .ics feed include the interview");
  assert.match(domainPanel, /panelists: \(row\.panelist_hr_ids \?\? \[\]\)/, "hydrate exposes the panel members");
  const bookingsPost = stripComments(read("app/api/recruitment/interview-calendar/bookings/route.ts"));
  assert.match(bookingsPost, /panelistHrIds: body\.panelistHrIds/, "the booking route forwards the panel");
  assert.match(patchRoute, /panelistHrIds: body\.panelistHrIds/, "the move/edit route forwards the panel");
  for (const file of [
    "src/components/recruitment/interview-calendar/cell-dialog.tsx",
    "src/components/recruitment/interview-calendar/schedule-interview-dialog.tsx",
    "src/components/recruitment/interview-calendar/edit-details-dialog.tsx",
  ]) {
    const src = stripComments(read(file));
    assert.match(src, /<PanelPicker\b/, `${file} offers a panel picker`);
    assert.match(src, /panelistHrIds: panel\.map\(\(member\) => member\.hrId\)/, `${file} sends the chosen panel`);
  }
  assert.match(viewSrc, /Panel <span/, "the interview detail lists the panel members");
  const panelMigration = read("supabase/migrations/20260926153000_ats_interview_booking_panelists.sql");
  assert.match(panelMigration, /add column if not exists panelist_hr_ids text\[\] not null default '\{\}'/, "the migration adds the panel array");

  // Interviewer name + optional Area & Line in the calendar and the share link (owner, 2026-09-26):
  // from outside one can read the interviewer, the area and the line. Area & Line auto-fill from the
  // chosen interviewer's own org seat (via the people search) and are editable; they are ungated like
  // the interviewer's name, so a not-signed-in share guest sees them.
  const domainOrg = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  assert.match(domainOrg, /interview_area,interview_line/, "the booking selects its area & line");
  assert.match(domainOrg, /area: row\.interview_area\?\.trim\(\) \|\| null/, "hydrate exposes the area (ungated, beside interviewerName)");
  assert.match(domainOrg, /async function resolveSeatOrgForHrIds\(/, "an interviewer's seat area & line are resolved for auto-fill");
  assert.match(domainOrg, /\.from\("au_v_org_tree"\)/, "the seat area & line come from the org tree");
  assert.match(bookingsPost, /area: body\.area/, "the booking route forwards the area");
  assert.match(patchRoute, /line: body\.line/, "the move/edit route forwards the line");
  for (const file of [
    "src/components/recruitment/interview-calendar/cell-dialog.tsx",
    "src/components/recruitment/interview-calendar/schedule-interview-dialog.tsx",
    "src/components/recruitment/interview-calendar/edit-details-dialog.tsx",
  ]) {
    const src = stripComments(read(file));
    assert.match(src, /<OrgFields\b/, `${file} offers the area & line fields`);
    assert.match(src, /function chooseInterviewer\(person: ChosenInterviewer \| null\)/, `${file} auto-fills area & line from the chosen interviewer`);
  }
  // The calendar cell AND the share link (same component) show the interviewer name and area/line.
  // The area sits BESIDE the name — "Name / Area" (owner, 2026-09-26) — and the meta line under it
  // keeps the interviewer and line.
  assert.match(viewSrc, /booking\.area \? <span[^>]*> \/ \{booking\.area\}<\/span> : null/, "the area shows beside the name as Name / Area");
  assert.match(viewSrc, /\[booking\.interviewerName, booking\.line\]\.filter\(Boolean\)/, "the chip's meta line keeps interviewer · line");
  const orgMigration = read("supabase/migrations/20260926155000_ats_interview_area_line.sql");
  assert.match(orgMigration, /add column if not exists interview_area text/, "the migration adds the area column");
  assert.match(orgMigration, /add column if not exists interview_line text/, "the migration adds the line column");

  // Interview scorecards (owner, 2026-09-26, Tier 2): each interviewer files their OWN rating 1-5 +
  // verdict; shown side by side; only someone ON the interview may file or see them (never a guest);
  // it complements the outcome and moves nothing. New service-role-only table.
  const scoreDomain = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  assert.match(scoreDomain, /export async function saveInterviewScorecard\(/, "an interviewer can file a scorecard");
  assert.match(scoreDomain, /Only the interviewer or a panel member can score/, "only someone on the interview may score");
  assert.match(scoreDomain, /rating < 1 \|\| rating > 5/, "the rating is 1 to 5");
  assert.match(scoreDomain, /function isInterviewAttendee\(/, "attendance decides who may score and see scorecards");
  assert.match(scoreDomain, /seesScorecards \? \(scorecardsByBooking\.get\(row\.id\) \?\? \[\]\) : \[\]/, "scorecards are hidden from anyone who is neither on the interview nor a booker (so never a guest)");
  const scoreRoute = stripComments(read("app/api/recruitment/interview-calendar/bookings/[id]/scorecard/route.ts"));
  assert.match(scoreRoute, /saveInterviewScorecard\(caller/, "the scorecard route files through the domain gate");
  assert.match(scoreRoute, /assertSameOriginMutation\(request\)/, "and refuses a cross-site write first");
  assert.match(viewSrc, /<ScorecardPanel\b/, "the interview panel shows the scorecards");
  const scoreMigration = read("supabase/migrations/20260926165000_ats_interview_scorecards.sql");
  assert.match(scoreMigration, /create table if not exists public\.ats_interview_scorecards/, "the migration creates the scorecards table");
  assert.match(scoreMigration, /rating between 1 and 5/, "with a 1-5 rating check");
  assert.match(scoreMigration, /unique \(booking_id, evaluator_hr_id\)/, "one scorecard per interviewer per interview");
  assert.match(scoreMigration, /revoke all on table public\.ats_interview_scorecards from anon, authenticated/, "and it is service-role only");
}
