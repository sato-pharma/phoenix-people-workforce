// Recruitment / ATS — grouping candidates by the manager they were actually sent to.
//
// WHY. A push records who a CV went to, and until 2026-08-27 that was the whole record: a name.
// So the recruiter's "sent to manager" list was one flat column of people, and the question a
// recruiter actually asks — "what is sitting with the Giza District Sales Manager?" — could not be
// answered without knowing every manager's seat by heart. Measured in production that day, 21
// sends spanned 5 managers, 3 distinct job titles and 5 areas; the flat list showed 21 rows.
//
// The seat is read from the STAMP on the candidate row, never joined live from the employee
// directory. That is the whole point of freezing it at send time: a manager who transfers to
// another area next month did not retroactively move last week's candidates, and grouping on a
// live join would silently rewrite history every time somebody was promoted.
//
// Pure on purpose — no React, no database — so the screen, the export and the tests all group the
// same way and cannot drift apart.

import type { Candidate } from "@/lib/recruitment/types";

/** A manager's seat as it stood when a candidate was sent to them. */
export type ManagerSeat = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  areaName: string | null;
  regionName: string | null;
};

export type ManagerGroup = {
  /** Stable identity for React keys and for sorting — never shown to a person. */
  key: string;
  seat: ManagerSeat;
  candidates: Candidate[];
  /** Most recent send in this group, so a group can be ordered by "what arrived last". */
  lastSentAt: string | null;
};

/**
 * "District Sales Manager · Giza" — the seat, as a person reads it.
 *
 * Title first because that is the coarser grouping and the one that answers "is this a field-force
 * pile or a Finance pile"; area second because with seventeen District Sales Managers the title
 * alone does not identify anybody. A missing half is simply omitted rather than filled with a
 * placeholder: the owner's standing rule is that no raw code and no invented value reaches a
 * screen, and "District Sales Manager · Unknown" reads as a data error the recruiter must chase
 * when in fact the employee row genuinely carries no area.
 */
export function managerSeatLabel(seat: Pick<ManagerSeat, "jobTitle" | "areaName">): string {
  return [seat.jobTitle, seat.areaName].filter((part): part is string => Boolean(part && part.trim())).join(" · ");
}

/**
 * How one manager reads in a picker: "Ahmed Samir · District Sales Manager · Giza".
 *
 * Lives HERE, beside `managerSeatLabel`, rather than in a component, because as of 2026-08-27
 * there are two pickers — the pool's row control and the screening queue's — and a recruiter who
 * chose "Ahmed Samir · District Sales Manager · Giza" in one must not meet "Ahmed Samir" in the
 * other. Two copies of a label drift; one cannot.
 *
 * Structurally typed on purpose. `HiringManagerOption` is declared in a module that reaches the
 * service-role client, and this file is imported by client components — taking the three fields it
 * actually reads keeps that dependency from existing at all.
 */
export function managerPickerLabel(manager: {
  name: string;
  jobTitle: string | null;
  areaName: string | null;
}): string {
  const seat = managerSeatLabel({ areaName: manager.areaName, jobTitle: manager.jobTitle });
  return seat ? `${manager.name} · ${seat}` : manager.name;
}

/**
 * Identity of a seat for grouping.
 *
 * Keyed on the HR_ID, lower-cased, and NOT on the label. Two managers can hold the same title in
 * the same area, and one manager whose title was recorded slightly differently across two sends
 * must not split into two piles. The lower-casing is the same case trap that runs through this
 * module: `ats_candidates` stores lower-case ids while `employees` stores upper-case, so grouping
 * on the raw value would put `b-10` and `B-10` in separate groups.
 */
export function managerSeatKey(seat: Pick<ManagerSeat, "hrId">): string {
  return String(seat.hrId ?? "").trim().toLowerCase();
}

/**
 * Group candidates by the manager they were sent to.
 *
 * Candidates never sent to anybody are NOT included — they are not part of this question, and a
 * silent "Unsent" bucket at the bottom of a grouped list is how a screen quietly grows a group
 * nobody asked for. The caller decides what to do with them.
 *
 * Groups are ordered by job title, then area, then manager name — the same order the manager
 * dropdown uses, so the list a recruiter reads after sending is in the order they chose from.
 * Within a group, newest send first: the reason to open a pile is almost always what just landed
 * in it.
 */
export function groupCandidatesByNotifiedManager(candidates: readonly Candidate[]): ManagerGroup[] {
  const groups = new Map<string, ManagerGroup>();

  for (const candidate of candidates) {
    const stamp = candidate.managerNotified;
    if (!stamp) continue;

    const seat: ManagerSeat = {
      areaName: stamp.areaName,
      hrId: stamp.hrId,
      jobTitle: stamp.jobTitle,
      name: stamp.name,
      regionName: stamp.regionName,
    };
    const key = managerSeatKey(seat);
    if (!key) continue;

    const existing = groups.get(key);
    if (existing) {
      existing.candidates.push(candidate);
      // The seat shown is the one from the MOST RECENT send. An older stamp can predate the
      // backfill and carry no title at all, and showing that one would hide a seat we do know.
      if (!existing.lastSentAt || stamp.sentAt > existing.lastSentAt) {
        existing.lastSentAt = stamp.sentAt;
        existing.seat = seat;
      }
      continue;
    }

    groups.set(key, { candidates: [candidate], key, lastSentAt: stamp.sentAt || null, seat });
  }

  for (const group of groups.values()) {
    group.candidates.sort((left, right) => {
      const leftSent = left.managerNotified?.sentAt ?? "";
      const rightSent = right.managerNotified?.sentAt ?? "";
      return rightSent.localeCompare(leftSent);
    });
  }

  return [...groups.values()].sort(
    (left, right) =>
      (left.seat.jobTitle ?? "").localeCompare(right.seat.jobTitle ?? "") ||
      (left.seat.areaName ?? "").localeCompare(right.seat.areaName ?? "") ||
      left.seat.name.localeCompare(right.seat.name),
  );
}
