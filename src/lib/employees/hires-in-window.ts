// Employees — how many people the Employee Master says were hired inside a window.
//
// WHY THE MASTER AND NOT THE PIPELINE. The Talent Acquisition dashboard's "Hired" tile used to count
// recruitment APPLICATIONS that reached the hired stage. Production's applications half is barely
// used — two applications are marked hired, ever — while the people actually recruited arrive through
// the candidate pool and a job offer letter and are then entered on the Employee Master. On
// 2026-10-14 the tile read 0 for October while 20 people had been hired that month, 17 of them already
// started (owner: "extremely wrong data"). The Employee Master is where a hire becomes a fact: an
// employee row with a hire date. So the tile counts that, and the pipeline keeps its own funnel.
//
// Pure, with no database client, so the dashboard builder and its test can both import it.

import type { HiredWindow } from "@/lib/recruitment/dashboard";

export type HireDirectoryRow = {
  employmentStatus?: string | null;
  hireDate?: string | null;
};

export type HiresInWindow = {
  /** People whose hire date falls inside the window, whether or not they have started. */
  hired: number;
  /** Of those, how many have a first working day still ahead of `todayIso`. */
  startLater: number;
};

/** `YYYY-MM-DD` from a date or a timestamp, or null when there is no usable day. */
function dayOf(value: string | null | undefined): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? "").trim());
  return match ? match[1] : null;
}

/**
 * People already hired whose first working day is still ahead — the hand-off between an accepted
 * offer and a person at work. Same rules as `countHiresInWindow`: the date text itself is compared,
 * and a declined offer is not a hire.
 */
export function countStartingAfter(employees: readonly HireDirectoryRow[], todayIso: string): number {
  let joining = 0;
  for (const employee of employees) {
    if (String(employee.employmentStatus ?? "").trim().toLowerCase() === "declined_offer") continue;
    const day = dayOf(employee.hireDate);
    if (day && day > todayIso) joining += 1;
  }
  return joining;
}

/**
 * Count the hires inside the window, on the Cairo calendar day (the hire date is a plain date, so
 * the comparison is on the date text itself — no timezone can move a hire into another month).
 *
 * A person recorded as having DECLINED THE OFFER is not a hire, however their row got its hire date:
 * four such rows sat in October on 2026-10-14 and counting them would put people who never worked a
 * day beside the ones who did. The directory already drops leavers, so this is the one status the
 * rule has to name itself.
 */
export function countHiresInWindow(
  employees: readonly HireDirectoryRow[],
  window: HiredWindow,
  todayIso: string,
): HiresInWindow {
  let hired = 0;
  let startLater = 0;
  for (const employee of employees) {
    if (String(employee.employmentStatus ?? "").trim().toLowerCase() === "declined_offer") continue;
    const day = dayOf(employee.hireDate);
    if (!day || day < window.fromIso || day > window.toIso) continue;
    hired += 1;
    if (day > todayIso) startLater += 1;
  }
  return { hired, startLater };
}
