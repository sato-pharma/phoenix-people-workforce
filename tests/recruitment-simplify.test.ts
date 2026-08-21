import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { cairoDayKey, summarizeCandidatePool } from "../src/lib/recruitment/candidate-stats.ts";
import {
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  DEFAULT_CANDIDATE_STATUS,
  candidateStatusLabel,
  candidateStatuses,
  isCandidateStatus,
  isUnreviewedCandidateStatus,
  normalizeCandidateStatus,
} from "../src/lib/recruitment/candidate-status.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

/**
 * The recruitment module receives CVs brilliantly and, until 2026-08-15, could do nothing with them
 * afterwards. Measured against production that evening:
 *
 *   152 CVs in the last 7 days · 23 that day · intake backlog 0
 *   7 applications ever · 1 interview ever · 0 hires ever
 *   225 of 226 candidates still carrying the database default status
 *   21 positions in the catalogue, 3 of them reachable from the requisition form
 *
 * Three causes, and this file pins the fix for each:
 *
 *   1. Nothing could MOVE — a requisition needed an open seat on the org chart.
 *   2. The status column was DECORATION — free text, and every write returned 405.
 *   3. The screen showed the WRONG THING — it opened on the 7 rows, not the 152.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function fakeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    createdAt: "2026-08-15T09:00:00.000Z",
    fullName: "Mona Adel",
    id: "candidate-1",
    managerNotified: null,
    status: DEFAULT_CANDIDATE_STATUS,
    ...overrides,
  } as Candidate;
}

export async function runRecruitmentSimplifyTests() {
  // ── 1 · A requisition can carry a typed job title with no seat behind it ────
  //
  // The service already accepted a free title; one line of UI (`disabled={pending || !vacancyId}`)
  // was the entire blocker, and it is why 18 of the 21 positions in the catalogue could never be
  // recruited for.
  const workspace = read("src/components/recruitment/recruitment-workspace.tsx");
  assert.match(
    workspace,
    /const canSubmit = vacancyId \? true : Boolean\(typedJobTitle && hiringManagerHrId\)/,
    "either an open vacancy OR a typed title with a named manager must satisfy the form — never the vacancy alone",
  );

  // The hiring manager is not optional on a free-title requisition, and this is the reason:
  // canSeeRequisition scopes on hiringManagerHrId / recruitmentOwnerHrId and never on line or area,
  // so a seatless requisition with no manager is invisible to the person expected to hire for it.
  const access = read("src/lib/recruitment/access.ts");
  assert.match(
    access,
    /hrIdsMatch\(access\.hrId, requisition\.hiringManagerHrId\)/,
    "requisition visibility still hangs off the hiring manager — the reason the field is required",
  );

  // Enforced in three places, because each one is reachable without the others.
  const requisitions = read("src/lib/recruitment/requisitions.ts");
  assert.match(
    requisitions,
    /if \(!vacancy\) \{[\s\S]{0,900}?Choose the hiring manager/,
    "the service is the real boundary — it must refuse a seatless requisition with no manager",
  );
  const requisitionRoute = read("app/api/recruitment/requisitions/route.ts");
  assert.match(
    requisitionRoute,
    /if \(!input\.vacancyId\) \{[\s\S]{0,700}?validationError\(/,
    "the route must answer an empty field itself, not let the service throw into a generic 500",
  );
  assert.match(
    requisitionRoute,
    /function validationError\([\s\S]{0,200}?status: 400/,
    "and that answer is a 400 — an empty field is the caller's mistake, not a server fault",
  );

  // ── 2 · The status is a fixed list, with a free note ────────────────────────
  assert.deepEqual(
    [...candidateStatuses],
    ["new", "shortlisted", "sent_to_manager", "rejected", "hired"],
    "the vocabulary is the contract — the route, the counters and the screen all read this one list",
  );
  assert.equal(isCandidateStatus("interviewing"), false, "a status outside the list is not a status");
  assert.equal(isCandidateStatus("new"), true);

  // The 225 production rows carrying the database default resolve to "new" — that string was set by
  // intake on every single CV, so it says nothing about whether a human looked.
  assert.equal(normalizeCandidateStatus("Candidate Created"), "new");
  assert.equal(normalizeCandidateStatus("candidate created"), "new", "the legacy match is case-insensitive");
  assert.equal(isUnreviewedCandidateStatus("Candidate Created"), true);

  // The 226th row is a sentence somebody typed. It must NOT be guessed into the list, and it must
  // still be shown verbatim — the owner's rule is that text is never hidden or truncated.
  const handwritten = "Not Eligible — Non-Egyptian (Dubai, UAE)";
  assert.equal(normalizeCandidateStatus(handwritten), null, "a handwritten status is never guessed at");
  assert.equal(candidateStatusLabel(handwritten), handwritten, "it is shown exactly as it was written");
  assert.equal(
    isUnreviewedCandidateStatus(handwritten),
    false,
    "somebody typed that sentence, so the candidate HAS been reviewed",
  );
  assert.equal(candidateStatusLabel("sent_to_manager"), "Sent to manager");
  assert.equal(candidateStatusLabel(null), "New", "an empty status still reads as something");

  // The note is validated at the write path, not merely trimmed on screen.
  const statusRoute = read("app/api/recruitment/candidates/[id]/status/route.ts");
  assert.match(statusRoute, /export async function PATCH/, "the status write path is PATCH");
  assert.match(
    statusRoute,
    /if \(!normalizeCandidateStatus\(status\)\) \{[\s\S]{0,200}validationError\(/,
    "the posted status must be checked against the list, or free text simply comes back",
  );
  assert.match(
    statusRoute,
    /note\.length > CANDIDATE_STATUS_NOTE_MAX_LENGTH/,
    "the note length must be bounded at the route, not trusted from the browser",
  );
  assert.equal(CANDIDATE_STATUS_NOTE_MAX_LENGTH, 300, "the bound the route enforces and the screen limits is one number");

  // ── 2b · The 405 that made every status update fail, silently ───────────────
  //
  // The status route exports PATCH and only PATCH. The one control that wrote a status called
  // postJson against it, and Next.js answers a POST to a PATCH-only route with 405 — so every
  // "Update status" click in the history of this module failed, with the error surfacing as a
  // generic "Request failed." That is a large part of why 225 of 226 rows never moved.
  assert.doesNotMatch(statusRoute, /export async function POST/, "the status route has no POST — it never had one");
  assert.match(workspace, /async function patchJson\(/, "the workspace needs a PATCH helper, which it did not have");
  assert.doesNotMatch(
    workspace,
    /postJson\(`\/api\/recruitment\/candidates\/\$\{[^}]+\}\/status`/,
    "nothing may POST to the status route again — that is the exact 405 this fixed",
  );

  // ── 2c · Decide on a candidate with no requisition in between ───────────────
  assert.match(workspace, /function CandidateDecisionButtons\(/, "Shortlist and Reject must exist as real controls");
  assert.match(
    workspace,
    /decide\("shortlisted", null\)/,
    "shortlisting must need nothing else — no application, no requisition, no vacancy",
  );
  assert.match(
    workspace,
    /Why is \$\{candidate\.fullName\} not proceeding\?/,
    "a rejection asks for the reason, which is the whole point of the note",
  );

  // ── 3 · The screen opens on the work, and counts CVs ────────────────────────
  // The default is still Candidates. The one exception is a return trip: HR sends a recruiter back
  // here with ?application=<id> after creating the employee, and landing them on the CV list would
  // hide the application they came back to finish.
  assert.match(
    workspace,
    /useState<TabKey>\(\(\) => \(workspaceParams\.get\("application"\) \? "pipeline" : "candidates"\)\)/,
    "the module must open on the 152 CVs, not on the 7 rows of pipeline — the only exception is arriving back from Add Employee on ?application=<id>",
  );

  const now = new Date("2026-08-15T18:20:00.000Z"); // 20:20 Cairo — the hour the evidence was measured
  const stats = summarizeCandidatePool(
    [
      fakeCandidate({ createdAt: "2026-08-15T06:00:00.000Z", id: "today-1" }),
      fakeCandidate({ createdAt: "2026-08-14T22:30:00.000Z", id: "today-2-cairo" }), // after midnight in Cairo, so it is the 15th
      fakeCandidate({ createdAt: "2026-08-11T09:00:00.000Z", id: "this-week", status: "shortlisted" }),
      fakeCandidate({
        createdAt: "2026-06-01T09:00:00.000Z",
        id: "old",
        managerNotified: { hrId: "B-1", name: "Nosiba", sentAt: "2026-08-14T09:00:00.000Z" },
        status: "sent_to_manager",
      }),
    ],
    now,
  );
  assert.equal(stats.total, 4);
  // Two, and the second one is the whole reason the day key is Cairo: 22:30 UTC on the 14th is
  // already the 15th in Cairo. Counted on the server's own UTC clock it would read as yesterday's
  // CV for the first hours of every working day.
  assert.equal(stats.arrivedToday, 2, "a CV that landed after Cairo midnight belongs to the Cairo day");
  assert.equal(stats.arrivedLast7Days, 3, "the week is a rolling 7 days, not the calendar week");
  assert.equal(stats.notYetReviewed, 2, "the two still carrying the intake default are the untouched ones");
  assert.equal(stats.sentToManager, 1);
  assert.equal(stats.asOf, now.toISOString(), "the counting instant travels to the browser, so cards and list agree");

  // Cairo is UTC+2 in winter and UTC+3 in summer; 22:30 UTC on the 14th is 00:30 or 01:30 on the
  // 15th, so this assertion holds either way and is not a bet on the DST rule of the day.
  assert.equal(cairoDayKey("2026-08-14T22:30:00.000Z"), "2026-08-15");
  assert.equal(cairoDayKey("2026-08-15T06:00:00.000Z"), "2026-08-15");
  assert.equal(cairoDayKey(null), "", "a missing timestamp is not silently today");
  assert.equal(cairoDayKey("not a date"), "", "an unparseable timestamp is not silently today");

  // ── 3b · See what arrived ──────────────────────────────────────────────────
  assert.match(workspace, /label: "Received", value: cairoDateTime\(candidate\.createdAt\)/, "mobile cards show when it arrived");
  assert.match(
    workspace,
    /new Date\(right\.createdAt\)\.getTime\(\) - new Date\(left\.createdAt\)\.getTime\(\)/,
    "the pool sorts newest first — with 152 a week, arrival order is the only order that helps",
  );
  for (const control of ["dateFilter", "statusFilter", "sourceFilter"]) {
    assert.ok(workspace.includes(control), `the pool needs a ${control} — 226 rows behind one search box is not usable`);
  }

  // ── 2d · The dropdown of managers must not be empty ────────────────────────
  //
  // Measured against production 2026-08-15: `employment_status` is lower-case "active" on all 112
  // live employees, so `.eq("employment_status", "Active")` matched 0 rows — no managers in the
  // dropdown, and every send refused with "That person is not a manager who can be sent
  // candidates." A filter that matches nothing is indistinguishable from an org with no managers,
  // which is why this is pinned on the source rather than left to a code review.
  const notify = read("src/lib/recruitment/hiring-manager-notify.ts");
  // Comment lines are stripped before the check. The file explains the incident by quoting the
  // broken filter verbatim, which is how this codebase documents a fix — and a guard that fires on
  // the explanation would force the explanation to be deleted. Only real code is asserted on.
  const notifyCode = notify
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
  assert.doesNotMatch(
    notifyCode,
    /employment_status"?,\s*"Active"/,
    'the capitalised "Active" matches zero rows in production — the manager list must never filter on it',
  );
  assert.match(
    notify,
    /ACTIVE_EMPLOYMENT_STATUSES_IN_LIST/,
    "the manager list uses the same active-employee definition as the rest of the platform",
  );

  // ── 3c · Send several to one manager, in ONE message ───────────────────────
  const bulkRoute = read("app/api/recruitment/candidates/notify-manager/route.ts");
  assert.match(
    bulkRoute,
    /const csrf = assertSameOriginMutation\(request\);\s*\n\s*if \(csrf\) return csrf;/,
    "the CSRF guard's return value must be checked, not discarded",
  );
  assert.match(
    bulkRoute,
    /requireRecruitmentAccess\(request, "recruitment", "update"\)/,
    "the bulk send needs the same permission as every other send",
  );
  assert.match(
    workspace,
    /candidateIds: selectedVisibleIds/,
    "the bulk send posts the ticked candidates — the manager gets one message listing all of them",
  );
}
