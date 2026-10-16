import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  assertMayBookInterview,
  isInterviewRequesterSeat,
  mayReadBooking,
  mayReadRequest,
  type InterviewCalendarCaller,
} from "../src/lib/recruitment/interview-calendar.ts";
import type { InterviewCalendarPerson, InterviewCalendarRole } from "../src/lib/recruitment/interview-calendar-types.ts";
import { stripComments } from "./support/comment-strip.ts";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

// The two-step interview request flow (owner, 2026-09-23): a District Manager and above, or HR, asks
// for a day and attaches CVs; HR gives each CV a time. These tests pin the ACCESS rules (who may ask,
// who may book, and who sees which booking on the shared calendar) and the wiring of the service,
// notifications and UI — the parts a session could quietly break.

function access(hrId: string | null, role: string | null): AccessContext {
  return { hrId, loginId: hrId, role, scope: "portal", source: "session" } as unknown as AccessContext;
}

function caller(own: InterviewCalendarRole | null, hrId: string | null, role = "Medical Representative"): InterviewCalendarCaller {
  return { access: access(hrId, role), link: null, own } as InterviewCalendarCaller;
}

function person(jobTitle: string): InterviewCalendarPerson {
  return { hrId: "X-1", jobTitle, name: "Someone" };
}

function booking(interviewerHrId: string | null, requestedByHrId: string | null) {
  return { interviewer_hr_id: interviewerHrId, requested_by_hr_id: requestedByHrId, starts_at: "2026-09-22T09:00:00.000Z" };
}

export async function runInterviewRequestTests() {
  // ── Who may REQUEST — the CV PII gate stays: DM-and-above, or HR; never a Medical Rep. ──────────
  assert.equal(isInterviewRequesterSeat(access("H-1", "HR Operations"), null), true, "HR may request");
  assert.equal(isInterviewRequesterSeat(access("H-2", "Human Resources Business Partner"), null), true, "HR (worded differently) may request");
  assert.equal(isInterviewRequesterSeat(access("N-1", "National Sales Manager"), person("National Sales Manager")), true, "an NSM may request");
  assert.equal(isInterviewRequesterSeat(access("D-1", "District Manager"), person("District Manager")), true, "a District Manager may request");
  assert.equal(isInterviewRequesterSeat(access("R-1", ""), person("Medical Representative")), false, "a Medical Rep may NOT request — CVs are DM-and-above only");
  assert.equal(isInterviewRequesterSeat(access(null, null), null), false, "nobody-in-particular may not request");

  // ── DM self-booking — a requester/interviewer may slot ONLY himself; a viewer may not. ──────────
  assert.doesNotThrow(() => assertMayBookInterview(caller("requester", "D-07"), "2026-09-20", "D-07"), "a DM may book himself as the interviewer");
  assert.throws(() => assertMayBookInterview(caller("requester", "D-07"), "2026-09-20", "N-01"), /Forbidden/, "a DM may NOT book someone else directly — that goes through a request");
  assert.doesNotThrow(() => assertMayBookInterview(caller("interviewer", "N-01"), "2026-09-20", "N-01"), "a chosen interviewer may book his own time");
  assert.throws(() => assertMayBookInterview(caller("interviewer", "N-01"), "2026-09-20", "D-07"), /Forbidden/, "but not another person's");
  assert.doesNotThrow(() => assertMayBookInterview(caller("owner", "B-10"), "2026-09-20", "N-01"), "an owner books anyone");
  assert.doesNotThrow(() => assertMayBookInterview(caller("editor", "H-1"), "2026-09-20", "N-01"), "an editor books anyone");
  assert.throws(() => assertMayBookInterview(caller("viewer", "V-1"), "2026-09-20", "V-1"), /Forbidden/, "a viewer cannot even book himself");

  // ── The dual calendar — a booking made from a request shows for BOTH the requester and the ──────
  //    interviewer, and for nobody else in the own-only tier.
  const b = booking("N-01", "D-07"); // interviewer N-01, asked for by D-07
  assert.equal(mayReadBooking(caller("owner", "B-10"), b), true, "the owner sees every interview");
  assert.equal(mayReadBooking(caller("viewer", "V-1"), b), true, "a viewer sees every interview");
  assert.equal(mayReadBooking(caller("interviewer", "N-01"), b), true, "the interviewer sees the interview he conducts");
  assert.equal(mayReadBooking(caller("requester", "D-07"), b), true, "the DM who asked sees it on his own calendar");
  assert.equal(mayReadBooking(caller("requester", "D-99"), b), false, "a different DM does not see someone else's request");
  assert.equal(mayReadBooking(caller("interviewer", "N-99"), b), false, "a different interviewer does not see it");
  // A DM who both requested and was chosen sees it either way.
  assert.equal(mayReadBooking(caller("requester", "D-07"), booking("D-07", "D-07")), true, "self-slotted: seen once, from both sides");

  // ── Reading one REQUEST is gated the same way — a CV is PII. HR/owner read any; the own-only tier ─
  //    reads only its own (asked-for, or chosen to conduct).
  const req = { interviewer_hr_id: "N-01", requested_by_hr_id: "D-07" };
  assert.equal(mayReadRequest(caller("owner", "B-10"), req), true, "the owner reads any request");
  assert.equal(mayReadRequest(caller("viewer", "V-1"), req), true, "HR (a viewer and up) reads any request");
  assert.equal(mayReadRequest(caller("requester", "D-07"), req), true, "the DM who asked reads his own request");
  assert.equal(mayReadRequest(caller("interviewer", "N-01"), req), true, "the chosen interviewer reads it");
  assert.equal(mayReadRequest(caller("requester", "D-99"), req), false, "another DM cannot read someone else's request — its CVs are PII");
  assert.equal(mayReadRequest(caller("interviewer", "N-99"), req), false, "another interviewer cannot read it");
  assert.equal(mayReadRequest(caller(null, "D-07"), req), false, "someone with no calendar seat reads nothing");

  // ── Service wiring — the request becomes an ordinary booking that remembers who asked. ──────────
  const service = stripComments(read("src/lib/recruitment/interview-requests.ts"));
  assert.match(service, /mayRequestInterviews\(caller\.access\)/, "creating a request is gated on the requester seat");
  assert.match(service, /requireCalendarAccess\(caller, "book", "any"\)/, "the HR inbox needs book rights");
  assert.match(service, /if \(!mayReadRequest\(caller, row\)\) throw new Error\(FORBIDDEN_READ\)/, "reading one request is gated the same way a booking is — a CV is PII");
  assert.match(service, /requestLink: \{ requestId: request\.id, requestedByHrId: request\.requested_by_hr_id \}/, "the booking is linked back to the request and who asked");
  assert.match(service, /raw\.addToRecruitment = false/, "an outside person on a request is NOT auto-added to Recruitment when booked");
  assert.match(service, /status: "scheduled"/, "the request flips to scheduled once a CV has a time");
  assert.match(service, /externalCv/, "an uploaded CV rides onto the booking");
  assert.match(service, /MAX_ITEMS_PER_REQUEST/, "a request is capped");

  // ── Notifications — a landing request pings HR + the admin; a booking pings requester + interviewer.
  const notify = stripComments(read("src/lib/recruitment/interview-request-notifications.ts"));
  assert.match(notify, /resolveHrIdsForRole\("Super Admin"/, "the inbox notice reaches the Super Admin");
  assert.match(notify, /resolveHrIdsForRole\("HR Operations"/, "and HR Operations");
  assert.match(notify, /resolveHrIdsForRole\("HR Resourcing"/, "and the Talent Acquisition seat, who reads the calendar (owner, 2026-10-16)");
  assert.match(notify, /HR will phone the candidates/, "her copy says what HR will do — she cannot give a CV its time herself");
  assert.match(notify, /interview-request-created:/, "the new-request notice is deduped per recipient");
  assert.match(notify, /interview-request-scheduled:/, "the requester is told once per booked CV");
  assert.match(notify, /interview-assigned:/, "the interviewer is told once per interview");
  assert.match(notify, /channels: \["in_app", "telegram"\]/, "these go in-app + Telegram, never a candidate e-mail");
  assert.doesNotMatch(notify, /recipientMode: "candidate"|candidateEmail/, "the candidate is never contacted from here");

  // ── The API routes exist and gate every branch. ────────────────────────────────────────────────
  const listRoute = stripComments(read("app/api/recruitment/interview-calendar/requests/route.ts"));
  assert.match(listRoute, /export async function GET/, "the requests are listed");
  assert.match(listRoute, /export async function POST/, "and created");
  assert.match(listRoute, /assertSameOriginMutation\(request\)/, "the create checks the origin");
  const scheduleRoute = stripComments(read("app/api/recruitment/interview-calendar/requests/[id]/schedule/route.ts"));
  assert.match(scheduleRoute, /scheduleInterviewRequestItem/, "the schedule route gives one CV a time");

  // ── The calendar shows the flow to the right people. ───────────────────────────────────────────
  const view = stripComments(read("src/components/recruitment/interview-calendar/interview-calendar-view.tsx"));
  assert.match(view, /const mayRequest = !link && \(canRequest \?\? role === "requester"\)/, "a link viewer never requests; a requester seat does");
  assert.match(view, /mayRequest \? \(\s*<Action onClick=\{\(\) => setRequesting\(true\)\}/, "the Request button is drawn only for a requester");
  assert.match(view, /requesting \? \(\s*<RequestInterviewDialog/, "the Request dialog opens from that button");
  assert.match(view, /mayRequest \|\| canBook \? \(\s*<InterviewRequestPanels/, "the request panels are drawn for a requester or a booker");

  const dialog = stripComments(read("src/components/recruitment/interview-calendar/request-interview-dialog.tsx"));
  assert.match(dialog, /canAdd=\{false\}/, "a request never adds an outside person to Recruitment — HR decides at booking");
  assert.match(dialog, /<MonthPicker/, "the request chooses a DAY");
  assert.doesNotMatch(dialog, /startMinutes|slotStarts|Choose a time/, "and NO time — HR sets that");

  const inbox = stripComments(read("src/components/recruitment/interview-calendar/requests-inbox.tsx"));
  assert.match(inbox, /\/requests\/\$\{encodeURIComponent\(request\.id\)\}\/schedule/, "HR books a time from the inbox");

  // ── A request waiting for a time can OPEN its CV (owner, 2026-10-04: "the request appears to me but I
  // am not able to download the CV"). The calendar's own CV doors need a booking, which a pending
  // request does not have — so the inbox said "CV attached" as a sentence with nothing to press.
  assert.match(inbox, /<CvPreviewModal/, "the inbox opens the CV in the shared preview, which carries Download");
  assert.match(
    inbox,
    /\/requests\/\$\{encodeURIComponent\(request\.id\)\}\/items\/\$\{encodeURIComponent\(reading\.id\)\}\/cv/,
    "and reads it through the REQUEST's own CV door, never the booking's",
  );
  assert.match(inbox, /item\.hasCv \? \(\s*<Button variant="secondary" onClick=\{\(\) => \{ setReading\(item\); setPreviewOpen\(true\); \}\}/, "View CV is a Button opening the preview — drawn for every item that has one, in-house or outside");
  const cvRoute = stripComments(read("app/api/recruitment/interview-calendar/requests/[id]/items/[itemId]/cv/route.ts"));
  assert.match(cvRoute, /getInterviewRequestItemCv\(caller, id, itemId\)/, "the route serves the CV of one request item");
  assert.match(cvRoute, /recruitmentFileResponse\(request, download\)/, "through the shared file response, so inline / base64 / download all work");
  const requestsLib = stripComments(read("src/lib/recruitment/interview-requests.ts"));
  assert.match(requestsLib, /if \(!mayReadRequest\(caller, request\)\) throw new Error\(FORBIDDEN_READ\)/, "the CV is gated by who may read THIS request");
  assert.match(requestsLib, /assertCvsOpenTo\(caller\)/, "and a link holder who is not signed in is refused unless the link's CVs are on");
  assert.match(requestsLib, /\.eq\("request_id", requestId\)/, "the item must belong to the request in the address — an item id cannot be swapped for another request's CV");
  assert.match(requestsLib, /listCandidateFilesByCandidate\(candidateIds\)/, "the inbox learns every in-house candidate's CV in ONE read, never one per card");

  // ── mayReadSessions no longer leaks group sessions to the own-only tier. ────────────────────────
  const calendar = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  assert.match(calendar, /role !== null && role !== "interviewer" && role !== "requester"/, "sessions stay with Viewer-and-up, never a requester");
}
