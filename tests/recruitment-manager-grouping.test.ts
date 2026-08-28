import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  groupCandidatesByNotifiedManager,
  managerSeatKey,
  managerSeatLabel,
} from "../src/lib/recruitment/manager-grouping.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

/**
 * "The same area are listed together and the same title are listed together" — the owner's words,
 * 2026-08-27, about the pile of CVs he had sent to managers.
 *
 * Until that day a send recorded a manager NAME and nothing else, so the answer to "what is sitting
 * with the Giza District Sales Manager?" required knowing every manager's seat by heart. Measured in
 * production the same day: 24 sends across 5 managers, 3 distinct job titles and 5 areas, shown as
 * one flat list ordered by arrival.
 *
 * Two things this file exists to hold still:
 *
 *   1. The seat is read from the STAMP frozen onto the candidate at send time, never joined live
 *      from the employee directory. A manager who transfers next month must not retroactively move
 *      last week's CVs, and a live join would rewrite history on every promotion.
 *   2. Grouping keys on the HR_ID, not on the label. `ats_candidates` stores lower-case ids while
 *      `employees` stores upper-case — the same case trap that once made a join report `full_name:
 *      null` for 53 real decisions — so `b-10` and `B-10` must land in one pile, not two.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function sent(overrides: {
  id: string;
  hrId: string;
  name: string;
  sentAt: string;
  jobTitle?: string | null;
  areaName?: string | null;
  regionName?: string | null;
}): Candidate {
  return {
    createdAt: "2026-08-26T09:00:00.000Z",
    fullName: `Candidate ${overrides.id}`,
    id: overrides.id,
    managerNotified: {
      areaName: overrides.areaName ?? null,
      hrId: overrides.hrId,
      jobTitle: overrides.jobTitle ?? null,
      name: overrides.name,
      regionName: overrides.regionName ?? null,
      sentAt: overrides.sentAt,
    },
    status: "sent_to_manager",
  } as Candidate;
}

function unsent(id: string): Candidate {
  return {
    createdAt: "2026-08-26T09:00:00.000Z",
    fullName: `Candidate ${id}`,
    id,
    managerNotified: null,
    status: "new",
  } as Candidate;
}

export async function runRecruitmentManagerGroupingTests() {
  // ── 1 · The label a person reads ───────────────────────────────────────────
  assert.equal(
    managerSeatLabel({ areaName: "Giza", jobTitle: "District Sales Manager" }),
    "District Sales Manager · Giza",
    "a full seat reads title then area",
  );
  // A missing half is OMITTED, never filled in. The owner's standing rule is that no invented value
  // reaches a screen, and "District Sales Manager · Unknown" reads as a fault to chase when the
  // employee row simply carries no area — 3 of the 31 live managers are in exactly that state.
  assert.equal(
    managerSeatLabel({ areaName: null, jobTitle: "National Sales Manager" }),
    "National Sales Manager",
    "no area must not produce a placeholder",
  );
  assert.equal(
    managerSeatLabel({ areaName: "Alexandria", jobTitle: null }),
    "Alexandria",
    "no title must not produce a placeholder",
  );
  assert.equal(managerSeatLabel({ areaName: null, jobTitle: null }), "", "an empty seat is an empty string");
  assert.equal(
    managerSeatLabel({ areaName: "   ", jobTitle: "District Sales Manager" }),
    "District Sales Manager",
    "whitespace is not an area",
  );

  // ── 2 · The case trap, which is the whole reason this keys on an id ────────
  assert.equal(managerSeatKey({ hrId: "B-10" }), managerSeatKey({ hrId: "b-10" }), "case must not split a pile");
  assert.equal(managerSeatKey({ hrId: "  b-10  " }), "b-10", "surrounding space must not split a pile");

  const mixedCase = groupCandidatesByNotifiedManager([
    sent({ areaName: "Giza", hrId: "b-10", id: "c1", jobTitle: "District Sales Manager", name: "Ahmed Samir", sentAt: "2026-08-26T10:00:00.000Z" }),
    sent({ areaName: "Giza", hrId: "B-10", id: "c2", jobTitle: "District Sales Manager", name: "Ahmed Samir", sentAt: "2026-08-26T11:00:00.000Z" }),
  ]);
  assert.equal(mixedCase.length, 1, "b-10 and B-10 are one manager, not two");
  assert.equal(mixedCase[0].candidates.length, 2, "both CVs belong to the same pile");

  // Two managers who hold the SAME title in the SAME area must stay apart — which is exactly what
  // keying on the label instead of the id would get wrong.
  const sameSeatTwoPeople = groupCandidatesByNotifiedManager([
    sent({ areaName: "Giza", hrId: "b-10", id: "c1", jobTitle: "District Sales Manager", name: "Ahmed Samir", sentAt: "2026-08-26T10:00:00.000Z" }),
    sent({ areaName: "Giza", hrId: "b-77", id: "c2", jobTitle: "District Sales Manager", name: "Mona Adel", sentAt: "2026-08-26T10:00:00.000Z" }),
  ]);
  assert.equal(sameSeatTwoPeople.length, 2, "one seat label held by two people is two piles");

  // ── 3 · Ordering: title, then area, then name ─────────────────────────────
  const ordered = groupCandidatesByNotifiedManager([
    sent({ areaName: "Cairo", hrId: "n-1", id: "c1", jobTitle: "National Sales Manager", name: "Zeinab Fouad", sentAt: "2026-08-26T10:00:00.000Z" }),
    sent({ areaName: "Giza", hrId: "d-2", id: "c2", jobTitle: "District Sales Manager", name: "Ahmed Samir", sentAt: "2026-08-26T10:00:00.000Z" }),
    sent({ areaName: "Alexandria", hrId: "d-3", id: "c3", jobTitle: "District Sales Manager", name: "Basma Nabil", sentAt: "2026-08-26T10:00:00.000Z" }),
  ]);
  assert.deepEqual(
    ordered.map((group) => managerSeatLabel(group.seat)),
    ["District Sales Manager · Alexandria", "District Sales Manager · Giza", "National Sales Manager · Cairo"],
    "groups arrive by title, then area — the same order the send dropdown uses",
  );

  // ── 4 · Inside a pile, newest send first ──────────────────────────────────
  const withinGroup = groupCandidatesByNotifiedManager([
    sent({ hrId: "d-2", id: "older", name: "Ahmed Samir", sentAt: "2026-08-20T10:00:00.000Z" }),
    sent({ hrId: "d-2", id: "newest", name: "Ahmed Samir", sentAt: "2026-08-26T10:00:00.000Z" }),
    sent({ hrId: "d-2", id: "middle", name: "Ahmed Samir", sentAt: "2026-08-24T10:00:00.000Z" }),
  ]);
  assert.deepEqual(
    withinGroup[0].candidates.map((candidate) => candidate.id),
    ["newest", "middle", "older"],
    "the reason to open a pile is what just landed in it",
  );
  assert.equal(withinGroup[0].lastSentAt, "2026-08-26T10:00:00.000Z", "lastSentAt is the newest send in the pile");

  // ── 5 · The seat shown is the one from the MOST RECENT send ───────────────
  //
  // Older stamps predate the backfill and can carry no title at all. Showing the oldest would hide
  // a seat we do know, which is the opposite of the point.
  const backfilled = groupCandidatesByNotifiedManager([
    sent({ areaName: null, hrId: "d-2", id: "old", jobTitle: null, name: "Ahmed Samir", sentAt: "2026-08-10T10:00:00.000Z" }),
    sent({ areaName: "Giza", hrId: "d-2", id: "new", jobTitle: "District Sales Manager", name: "Ahmed Samir", sentAt: "2026-08-26T10:00:00.000Z" }),
  ]);
  assert.equal(
    managerSeatLabel(backfilled[0].seat),
    "District Sales Manager · Giza",
    "a known seat must not be hidden by an older stamp that carries none",
  );

  // ── 6 · Candidates nobody sent are NOT in the grouping ────────────────────
  //
  // 370 of the 434 rows in production have never been sent. A silent "Unsent" bucket at the bottom
  // of this function's output would be a group nobody asked for; the caller decides what to do with
  // them, and the pool renders them under their own heading so they are visibly still there.
  const withUnsent = groupCandidatesByNotifiedManager([
    unsent("u1"),
    sent({ hrId: "d-2", id: "s1", name: "Ahmed Samir", sentAt: "2026-08-26T10:00:00.000Z" }),
    unsent("u2"),
  ]);
  assert.equal(withUnsent.length, 1, "only sent candidates are grouped");
  assert.equal(withUnsent[0].candidates.length, 1, "an unsent candidate never joins a manager's pile");

  // A stamp with no HR_ID at all is skipped rather than forming an anonymous group.
  const noHrId = groupCandidatesByNotifiedManager([
    sent({ hrId: "   ", id: "c1", name: "Nobody", sentAt: "2026-08-26T10:00:00.000Z" }),
  ]);
  assert.equal(noHrId.length, 0, "a stamp with no id forms no group");

  assert.deepEqual(groupCandidatesByNotifiedManager([]), [], "an empty pool groups to nothing");

  // ── 7 · The stamp is WRITTEN, or every group above is empty forever ───────
  //
  // Pure functions cannot tell you the columns are populated. These three assertions are the reason
  // the feature works at all: the notify path has to record the seat at send time, and the mapper
  // has to read it back.
  const notifySource = read("src/lib/recruitment/hiring-manager-notify.ts");
  assert.match(
    notifySource,
    /manager_notified_job_title:/,
    "a send must stamp the manager's job title onto the candidate",
  );
  assert.match(notifySource, /manager_notified_area:/, "a send must stamp the manager's area onto the candidate");
  assert.match(notifySource, /manager_notified_region:/, "a send must stamp the manager's region onto the candidate");
  // The lookup crosses the two tables that disagree about case. A bare `.eq("hr_id", …)` here
  // returns no row and the send is silently attributed to a raw HR_ID with no title and no area.
  assert.match(
    notifySource,
    /\.in\("hr_id",\s*hrIdLookupKeys\(/,
    "the manager lookup must be case-safe, not a bare eq",
  );

  // The seat columns are newer than the code path that writes them, and the code ships on a merge
  // while the migration is a separate step around it. In that window an update naming a column the
  // database has never heard of must NOT take the send down with it — a send with no seat is what
  // every send looked like yesterday; a send that throws is a regression.
  assert.match(
    notifySource,
    /code === "PGRST204" \|\| code === "42703"/,
    "both spellings of \"that column does not exist\" must be recognised — PostgREST caches its own answer",
  );
  assert.match(
    notifySource,
    /seatColumnsExist = false;/,
    "a missing seat column must fall back to recording the send without the seat",
  );
  assert.match(
    notifySource,
    /if \(retry\.error\) throw retry\.error;/,
    "the fallback write is still the only record of the send — it must never be swallowed",
  );

  const dbSource = read("src/lib/recruitment/db.ts");
  assert.match(dbSource, /manager_notified_job_title/, "mapCandidate must read the stamped job title back");
  assert.match(dbSource, /manager_notified_area/, "mapCandidate must read the stamped area back");

  // ── 8 · The screen groups by the STAMP, not by a live directory join ──────
  const workspaceSource = read("src/components/recruitment/recruitment-workspace.tsx");
  assert.match(
    workspaceSource,
    /groupCandidatesByNotifiedManager\(visibleCandidates\)/,
    "the pool must group what is on screen, so a filter narrows the piles too",
  );
  assert.match(
    workspaceSource,
    /hiringManagerOptionLabel/,
    "the send dropdown must name the seat, not just the person",
  );
}
