import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveCalendarCandidate, type CalendarCandidateDeps } from "../src/lib/recruitment/calendar-candidate-resolve.ts";
import { interviewJobTitleLabel, INTERVIEW_JOB_TITLE_LIMIT } from "../src/lib/recruitment/interview-calendar.ts";
import {
  interviewAwaitsOutcome,
  interviewsAwaitingOutcome,
  type InterviewBooking,
} from "../src/lib/recruitment/interview-calendar-types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The Interview Calendar names the ROLE an interview is for, and asks how a finished one went.
 *
 * ## The two holes this closes
 *
 * A booking recorded the sales Area and the Line and nothing naming the JOB. So a candidate created
 * from the calendar (`ats_candidates.source = 'interview_calendar'`) was written with
 * `applied_for_job_title` NULL and never appeared in that round's pile — measured on production
 * 2026-10-15, 28 of the 68 interviews held from 1 September on sit on a candidate in exactly that
 * state. And the outcome, which has existed since 2026-09-20 and already moves the candidate, was
 * filled in on 18 of those 68: 50 carried nothing at all, while the reminder job had been nagging
 * the lead interviewer about every one of them since 2026-09-23.
 *
 * So: the role is chosen when the interview is booked, carried onto a candidate the booking
 * creates, and the calendar itself asks about a finished interview nobody has answered for.
 *
 * ## What is pinned by BEHAVIOUR and what by SOURCE
 *
 * The three pure pieces are exercised for real: the stored label, the identity handed to
 * `createCandidate`, and the predicate that decides an interview is waiting. The rest of the chain
 * is a database away from this suite, so it is pinned as source — with comments stripped through
 * the one sanctioned stripper, because the prose above each change quotes the very strings the
 * negative assertions look for.
 */

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

// A booking fixture: only the fields the pure predicates read, widened to the real shape so a
// renamed field fails here rather than passing on a structural match.
function booking(overrides: Partial<InterviewBooking>): Pick<InterviewBooking, "ended" | "outcome" | "id"> {
  return { ended: false, id: "fixture", outcome: null, ...overrides };
}

function candidateHarness(): { deps: CalendarCandidateDeps; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    deps: {
      createCandidate: async (identity) => {
        created.push({ ...identity });
        return { candidate: { fullName: identity.fullName, id: "made-now" }, created: true };
      },
      fingerprintCv: () => "md5",
      findCvOwnerId: async () => null,
      findPhoneTwins: async () => [],
      getCandidateById: async (id) => ({ fullName: "Already On File", id }),
    },
  };
}

export async function runInterviewRoleAndOutcomeTests() {
  // ── 1 · The role, as it is stored ─────────────────────────────────────────────────────────────
  // Free text over a datalist, the way the Job Offers composer asks the same question: the offer
  // catalogue held FOUR active titles when this was measured, and interviews are held for roles
  // that are not in it, so the catalogue suggests and never decides.
  assert.equal(interviewJobTitleLabel("Office Coordinator"), "Office Coordinator");
  assert.equal(interviewJobTitleLabel("  District   Sales Manager  "), "District Sales Manager", "whitespace is collapsed and trimmed");
  assert.equal(interviewJobTitleLabel(""), null, "blank is a real answer — nobody named the role");
  assert.equal(interviewJobTitleLabel("   "), null, "and so is whitespace");
  assert.equal(interviewJobTitleLabel(null), null, "a missing value is not a role");
  assert.equal(interviewJobTitleLabel(undefined), null, "and neither is an absent one");
  assert.equal(interviewJobTitleLabel(42), null, "nor anything that is not text");
  assert.throws(
    () => interviewJobTitleLabel("x".repeat(INTERVIEW_JOB_TITLE_LIMIT + 1)),
    /Keep the job title under 120 characters/,
    "an over-long title refuses the booking in a sentence the booker can act on",
  );
  assert.equal(
    interviewJobTitleLabel("x".repeat(INTERVIEW_JOB_TITLE_LIMIT)),
    "x".repeat(INTERVIEW_JOB_TITLE_LIMIT),
    "the limit itself is allowed",
  );

  // ── 2 · A candidate the calendar creates carries the role ─────────────────────────────────────
  // The whole point of storing it. `createCandidate` matches before it inserts, so this is also the
  // boundary: a record ALREADY in the pipeline keeps whatever its own CV said it applied for.
  {
    const { created, deps } = candidateHarness();
    const resolution = await resolveCalendarCandidate(
      { appliedForJobTitle: "Office Coordinator", email: null, fullName: "Booked Person", phone: null },
      null,
      deps,
    );
    assert.equal(resolution.created, true);
    assert.equal(created.length, 1, "a person nobody holds is created once");
    assert.equal(
      created[0]?.appliedForJobTitle,
      "Office Coordinator",
      "the role reaches createCandidate, which is what writes applied_for_job_title",
    );
  }
  {
    // The same booking against a CV already on file: nothing is created, so nothing is rewritten —
    // a late interview for a different role must never overwrite what the candidate applied for.
    const { created, deps } = candidateHarness();
    const resolution = await resolveCalendarCandidate(
      { appliedForJobTitle: "Medical Rep", email: null, fullName: "Booked Person", phone: null },
      Buffer.from("cv"),
      { ...deps, findCvOwnerId: async () => "already-on-file" },
    );
    assert.equal(resolution.candidateId, "already-on-file");
    assert.equal(created.length, 0, "a matched candidate is never handed a job title to overwrite their own with");
  }

  // The call site passes it, and the column is written and read.
  const domain = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  assert.match(domain, /interview_area,interview_line,interview_job_title,/, "the column is selected on every booking");
  assert.match(domain, /const jobTitle = interviewJobTitleLabel\(raw\.jobTitle\)/, "the role is checked before anything is written");
  assert.match(
    domain,
    /\{ appliedForJobTitle: jobTitle, email: input\.external\.email, fullName: input\.external\.name/,
    "and handed to the candidate the booking creates",
  );
  assert.match(domain, /interview_job_title: jobTitle,/, "the booking row stores it");
  assert.match(domain, /jobTitle: row\.interview_job_title\?\.trim\(\) \|\| null,/, "and every reader of a booking gets it back");
  assert.match(
    domain,
    /orgColumns\.interview_job_title = interviewJobTitleLabel\(patch\.jobTitle\)/,
    "it is editable after the interview, like the area and the line",
  );
  assert.match(
    domain,
    /patch\.jobTitle !== undefined \|\|/,
    "and a requester who may only move their interview cannot change it — the role is HR's",
  );

  // The suggestion list goes through the CALENDAR's gate, not the offers permission: an Editor the
  // owner shared the calendar with holds no `offers:read`, and the names are all that leave.
  assert.match(domain, /export async function listInterviewJobTitleOptions/, "the suggestion list is a domain helper");
  // `\s+` and not a newline literal: this working tree is CRLF and the CI runner checks out LF.
  assert.match(
    domain,
    /requireCalendarAccess\(caller, "book", "any"\);\s+const titles = await listOfferJobTitles\(\)/,
    "behind the calendar's own book gate, asked BEFORE the catalogue is read",
  );

  // ── 3 · A finished interview with no outcome is flagged ───────────────────────────────────────
  const over = booking({ ended: true });
  const answered = booking({ ended: true, outcome: "shortlisted" });
  const stillToCome = booking({ ended: false });
  const comingAndAnswered = booking({ ended: false, outcome: "attended" });
  assert.equal(interviewAwaitsOutcome(over), true, "its time is over and nobody has said how it went");
  assert.equal(interviewAwaitsOutcome(answered), false, "an answered interview asks nothing");
  assert.equal(interviewAwaitsOutcome(stillToCome), false, "an interview still to happen is not late — it has not happened");
  assert.equal(interviewAwaitsOutcome(comingAndAnswered), false);
  assert.deepEqual(
    interviewsAwaitingOutcome([over, answered, stillToCome, comingAndAnswered]).map((entry) => entry.id),
    ["fixture"],
    "only the finished and unanswered one is listed",
  );

  // The loader is scoped to who can ANSWER — the lead interviewer or the calendar's owner, the same
  // gate setInterviewOutcome enforces. A viewer handed a list they cannot act on is noise, and a
  // share-link guest handed one is a leak.
  assert.match(domain, /export async function listInterviewsAwaitingOutcome/, "the prompt has a domain loader");
  assert.match(
    domain,
    /interviewAwaitsOutcome\(booking\) && booking\.canSetOutcome/,
    "and it returns only the interviews this caller may record an outcome on",
  );
  assert.match(domain, /OUTCOME_PROMPT_LOOKBACK_DAYS = INTERVIEW_OUTCOME_WINDOW_DAYS/, "it reaches back two weeks only: an older unanswered interview leaves the panel (owner, 2026-10-17)");
  assert.match(domain, /OUTCOME_PROMPT_LIMIT = 25/, "and never puts an unreadable list in front of anybody");

  // ── 4 · The screens ask ───────────────────────────────────────────────────────────────────────
  const orgFields = stripComments(read("src/components/recruitment/interview-calendar/org-fields.tsx"));
  assert.match(orgFields, /Role interviewed for \(optional\)/, "the booking form asks for the role");
  assert.match(orgFields, /list="interview-job-title-options"/, "as free text over a datalist, never a closed list");
  assert.match(orgFields, /<datalist id="interview-job-title-options">/, "whose options are the offer catalogue's titles");
  assert.match(orgFields, /api\s*\n?\s*\.get\("\/job-titles"\)/, "read through the calendar's own route");
  assert.doesNotMatch(orgFields, /<select[^>]*onChange=\{\(event\) => onJobTitle/, "the role is never a select — a role outside the catalogue must be typeable");

  // All four places an interview is booked or edited send it.
  for (const [file, label] of [
    ["src/components/recruitment/interview-calendar/cell-dialog.tsx", "pressing a free cell on the calendar"],
    ["src/components/recruitment/interview-calendar/schedule-interview-dialog.tsx", "Schedule interview from a CV screen"],
    ["src/components/recruitment/interview-calendar/edit-details-dialog.tsx", "editing an interview already booked"],
    ["src/components/recruitment/interview-calendar/requests-inbox.tsx", "giving a requested CV a time"],
  ] as const) {
    assert.match(stripComments(read(file)), /jobTitle: jobTitle\.trim\(\) \|\| null,/, `${label} sends the role`);
  }

  const view = stripComments(read("src/components/recruitment/interview-calendar/interview-calendar-view.tsx"));
  assert.match(view, /<OutcomePromptPanel api=\{api\}/, "the calendar draws the outcome prompt");
  assert.match(view, /interviewAwaitsOutcome\(booking\) \? <span className="font-bold text-amber-700">Outcome\?<\/span>/, "and flags the interview on the week grid");
  assert.match(view, /interviewAwaitsOutcome\(item\.booking\) \? <span className="font-bold text-amber-700">Outcome\?<\/span>/, "and on the phone's day cards, where there is no grid");
  assert.match(view, /Interviewed for \{booking\.jobTitle\}/, "the interview says what role it is for");

  const panel = stripComments(read("src/components/recruitment/interview-calendar/outcome-prompt-panel.tsx"));
  assert.match(panel, /\/bookings\?awaiting=outcome/, "the panel reads the scoped list");
  assert.match(panel, /if \(bookings\.length === 0\) return null;/, "and draws nothing at all when nothing is waiting");
  assert.doesNotMatch(panel, /createSystemNotification|sendEmail|fetch\("\/api\/email/, "it asks on the screen and sends nobody anything");

  // ── 5 · The routes and the registry ───────────────────────────────────────────────────────────
  const bookingsRoute = stripComments(read("app/api/recruitment/interview-calendar/bookings/route.ts"));
  assert.match(bookingsRoute, /params\.get\("awaiting"\) === "outcome"/, "the bookings route serves the prompt's list");
  assert.match(bookingsRoute, /listInterviewsAwaitingOutcome\(caller\)/, "through the domain loader, which holds the gate");
  assert.match(bookingsRoute, /jobTitle: body\.jobTitle,/, "and a new booking's role reaches the domain module");

  const oneBookingRoute = stripComments(read("app/api/recruitment/interview-calendar/bookings/[id]/route.ts"));
  assert.match(oneBookingRoute, /jobTitle: body\.jobTitle,/, "an edit's role does too");

  const titlesRoute = stripComments(read("app/api/recruitment/interview-calendar/job-titles/route.ts"));
  assert.match(titlesRoute, /interviewCalendarCaller\(access, request\)/, "the suggestion route resolves a calendar caller");
  assert.match(titlesRoute, /listInterviewJobTitleOptions\(caller\)/, "and asks the domain helper, which gates it");
  assert.doesNotMatch(titlesRoute, /assertPermission/, "it is deliberately NOT behind the offers permission — the booker is not the letter writer");

  const scheduleRoute = stripComments(read("app/api/recruitment/interview-calendar/requests/[id]/schedule/route.ts"));
  assert.match(scheduleRoute, /jobTitle: body\.jobTitle,/, "a booking made from a request names its role as well");

  const registry = stripComments(read("src/lib/security/access-registry.ts"));
  assert.match(
    registry,
    /pattern: "\/api\/recruitment\/interview-calendar\/job-titles"/,
    "the new route is declared in the access registry, or the required validate job goes red",
  );

  // ── 6 · The migration ─────────────────────────────────────────────────────────────────────────
  const migration = read("supabase/migrations/20261015185548_ats_interview_booking_job_title.sql");
  assert.match(migration, /add column if not exists interview_job_title text/, "the column is added, nullable and additive");
  assert.doesNotMatch(migration, /\bupdate\s+public\.ats_interview_bookings\b/i, "no backfill — nobody can say now what an old interview was for");
  assert.doesNotMatch(migration, /\bnot null\b/i, "and no default is forced onto the rows already there");
}
