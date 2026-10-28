import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "./support/comment-strip.ts";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

// Tier 3 (owner, 2026-09-26): the chosen interviewer confirms/declines the assignment, the CV of an
// outside candidate can be replaced after booking, and every change is kept in a per-interview
// history. The DB-backed helpers cannot run in this suite (no database), so this pins the wiring:
// the guards, the reminder exclusion, the reset-on-reassignment, the routes and the registry.

export function runInterviewTier3Tests() {
  const domain = stripComments(read("src/lib/recruitment/interview-calendar.ts"));

  // The confirmation columns are read on every booking.
  assert.match(domain, /interviewer_confirmation,interviewer_confirmation_at,interviewer_confirmation_by_hr_id,decline_reason/, "the confirmation columns are selected");

  // CONFIRM / DECLINE — only the LEAD interviewer, only before it happens.
  assert.match(domain, /export async function setInterviewerConfirmation/, "the confirm/decline helper exists");
  assert.match(domain, /viewer !== canonicalHrIdKey\(row\.interviewer_hr_id\)[\s\S]*Only the interviewer chosen to conduct/, "only the chosen lead interviewer may answer");
  assert.match(domain, /time has passed — record its outcome instead/, "a past interview is answered by its outcome, not confirm/decline");
  assert.match(domain, /decision !== "confirmed" && decision !== "declined"/, "the decision is validated");
  assert.match(domain, /recruitment_interview_declined/, "a decline notifies the people who arranged it");
  assert.match(domain, /recordBookingChange\(row\.id, actor, "declined"/, "a decline is written to the history");
  assert.match(domain, /recordBookingChange\(row\.id, actor, "confirmed"/, "a confirm is written to the history");

  // A DECLINED lead is dropped from the reminders (owner: he answered "I can't").
  assert.match(domain, /row\.interviewer_confirmation === "declined" \? null : row\.interviewer_hr_id/, "a declined lead is not reminded");

  // Reassigning the interviewer CLEARS the predecessor's answer.
  assert.match(domain, /const interviewerChanged = interviewerHrId !== undefined && canonicalHrIdKey\(interviewerHrId\) !== canonicalHrIdKey\(row\.interviewer_hr_id\)/, "an interviewer change is detected");
  assert.match(domain, /confirmationReset[\s\S]*interviewer_confirmation: null/, "a reassignment clears the confirmation");

  // CV replace — external only, and it records the change.
  assert.match(domain, /export async function replaceInterviewExternalCv/, "the CV-replace helper exists");
  // An in-house candidate (owner, 2026-10-28): a missing CV is ATTACHED to their Recruitment record from
  // the calendar; one who already has a readable CV is refused, never replaced.
  assert.match(domain, /if \(row\.candidate_id\) return attachMissingCandidateCv\(caller, row, row\.candidate_id, cv\)/, "an in-house candidate goes to the attach-missing path");
  const attachStart = domain.indexOf("async function attachMissingCandidateCv");
  assert.ok(attachStart >= 0, "the attach-missing helper exists");
  const attach = domain.slice(attachStart, domain.indexOf("function asPlatform", attachStart));
  assert.match(attach, /if \(hasReadableCv\) throw new Error\("This candidate already has a CV/, "a candidate who has a readable CV is refused");
  assert.ok(attach.indexOf("if (hasReadableCv) throw") >= 0 && attach.indexOf("if (hasReadableCv) throw") < attach.indexOf("uploadCandidateFile("), "the refusal comes before any upload");
  assert.match(attach, /uploadCandidateFile\(caller\.access, \{[\s\S]*?kind: "cv"[\s\S]*?origin: "interview_calendar"/, "the CV lands on the candidate record");
  assert.match(attach, /assertMayUseRecruitmentFromCalendar\(caller\.access, "create"\)/, "attaching needs Recruitment create access");
  assert.match(domain, /recordBookingChange\(row\.id, actor, "cv"/, "a CV change is written to the history");

  // The change history is APPEND-ONLY and best-effort — a missing log never fails the change.
  assert.match(domain, /async function recordBookingChange[\s\S]*catch \{/, "recording a change is swallowed on failure");
  assert.match(domain, /recordBookingChange\(bookedRow\.id, actor, "booked"/, "booking records a history entry");
  assert.match(domain, /recordBookingChange\([\s\S]*"outcome"/, "recording an outcome writes history");

  // Hydrate exposes the new read fields.
  assert.match(domain, /canConfirmInterview:/, "the booking says whether THIS viewer may confirm/decline");
  assert.match(domain, /changeHistory: changesByBooking\.get\(row\.id\)/, "the booking carries its change history");

  // ROUTES.
  const confirmationRoute = stripComments(read("app/api/recruitment/interview-calendar/bookings/[id]/confirmation/route.ts"));
  assert.match(confirmationRoute, /assertSameOriginMutation\(request\)/, "the confirmation route checks CSRF");
  assert.match(confirmationRoute, /setInterviewerConfirmation\(caller, id, body\.decision, body\.reason\)/, "and calls the domain helper");

  const cvRoute = stripComments(read("app/api/recruitment/interview-calendar/bookings/[id]/cv/route.ts"));
  assert.match(cvRoute, /export async function GET/, "the CV route still downloads");
  assert.match(cvRoute, /export async function POST/, "and now replaces");
  assert.match(cvRoute, /replaceInterviewExternalCv\(caller, id/, "the POST calls the replace helper");
  assert.match(cvRoute, /assertSameOriginMutation\(request\)/, "the CV replace checks CSRF");

  // ACCESS REGISTRY — both routes are covered.
  const registry = stripComments(read("src/lib/security/access-registry.ts"));
  assert.match(registry, /pattern: "\/api\/recruitment\/interview-calendar\/bookings\/\*\/confirmation"/, "the confirmation route is registered");
  assert.match(
    registry,
    /methods: \["GET", "POST"\], pattern: "\/api\/recruitment\/interview-calendar\/bookings\/\*\/cv"/,
    "the CV route now allows POST",
  );

  // MIGRATION — the columns, the table and the check constraint.
  const migration = read("supabase/migrations/20260926190000_ats_interview_confirmation_and_history.sql");
  assert.match(migration, /add column if not exists interviewer_confirmation text/, "the confirmation column is added");
  assert.match(migration, /add column if not exists decline_reason text/, "the decline reason column is added");
  assert.match(migration, /create table if not exists public\.ats_interview_booking_changes/, "the history table is created");
  assert.match(migration, /interviewer_confirmation in \('confirmed', 'declined'\)/, "the confirmation value is constrained");
  assert.match(migration, /grant all on table public\.ats_interview_booking_changes to service_role/, "the history table is service-role only");

  // TYPES — the client-safe shape carries the new fields.
  const types = read("src/lib/recruitment/interview-calendar-types.ts");
  assert.match(types, /export type InterviewChange = \{/, "the change type is exported");
  assert.match(types, /interviewerConfirmation: InterviewConfirmation \| null/, "the booking carries the confirmation");
  assert.match(types, /canConfirmInterview: boolean/, "and whether the viewer may answer");
}
