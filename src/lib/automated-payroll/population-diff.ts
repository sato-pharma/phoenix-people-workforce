import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";

import type { PopulationMember } from "./recommend.ts";
import type { RowLifecycle } from "./types.ts";

/**
 * Population diff vs. the previous month — the guard for silent-disappearance
 * bugs.
 *
 * Motivated by a real incident (2026-07-25): an employee serving a resignation
 * notice period into a FUTURE month was dropped from the ENTIRE payroll
 * population for every month before their actual exit. No error, no empty
 * state, nothing to notice by — they simply never got a payslip. It was found
 * only because the owner happened to ask about that one person by name.
 *
 * Headcount alone doesn't catch it (a joiner can mask a disappearance in the
 * same month), so this names people rather than counting them, and separates:
 *   joined        — present now, absent last month, and flagged as a joiner
 *   left          — absent now, present last month, and expected (a leaver)
 *   disappeared   — absent now, present last month, NOT explained by anything.
 *                   This is the bug bucket. It should always be empty.
 *
 * Every function here is pure; callers supply last month's roster. (The one import is
 * compactHrKey, the same id normalizer the rest of this module family matches on — a second copy
 * of it is how a hyphen or a capital silently splits one person into two.)
 */

export type PopulationDiffPerson = {
  hrId: string;
  fullName: string;
  lifecycle?: RowLifecycle;
};

export type PopulationDiff = {
  currentHeadcount: number;
  previousHeadcount: number;
  joined: PopulationDiffPerson[];
  left: PopulationDiffPerson[];
  /** Present last month, gone now, with no resignation on file — investigate. */
  disappeared: PopulationDiffPerson[];
  /** True when there is no previous roster to compare against (first-ever run). */
  noBaseline: boolean;
};

export type PreviousRosterEntry = {
  hrId: string;
  compact: string;
  fullName: string;
  /** Whether last month's row was already settled as a leaver (so absence now is expected). */
  wasLeaver: boolean;
};

export function diffPopulation(input: {
  current: PopulationMember[];
  previous: PreviousRosterEntry[];
}): PopulationDiff {
  const previousByCompact = new Map(input.previous.map((entry) => [entry.compact, entry]));
  const currentByCompact = new Map(input.current.map((member) => [member.compact, member]));

  const joined: PopulationDiffPerson[] = [];
  for (const member of input.current) {
    if (previousByCompact.has(member.compact)) continue;
    joined.push({
      hrId: member.employee.hrId,
      fullName: member.employee.fullName,
      lifecycle: member.lifecycle,
    });
  }

  const left: PopulationDiffPerson[] = [];
  const disappeared: PopulationDiffPerson[] = [];
  for (const entry of input.previous) {
    if (currentByCompact.has(entry.compact)) continue;
    const person = { hrId: entry.hrId, fullName: entry.fullName };
    // Someone settled as a leaver last month is legitimately gone now. Anyone
    // else vanishing without that explanation is the bug shape this exists for.
    if (entry.wasLeaver) left.push(person);
    else disappeared.push(person);
  }

  return {
    currentHeadcount: input.current.length,
    previousHeadcount: input.previous.length,
    joined,
    left,
    disappeared,
    noBaseline: input.previous.length === 0,
  };
}

/** One-line human summary for the wizard banner / sheet subtitle. */
export function describePopulationDiff(diff: PopulationDiff): string {
  if (diff.noBaseline) return "No previous month to compare against.";
  const parts = [`${diff.currentHeadcount} employees (was ${diff.previousHeadcount})`];
  if (diff.joined.length > 0) parts.push(`+${diff.joined.length} joined`);
  if (diff.left.length > 0) parts.push(`−${diff.left.length} left`);
  if (diff.disappeared.length > 0) parts.push(`⚠ ${diff.disappeared.length} unexplained`);
  return parts.join(" · ");
}

/**
 * The subset of `disappeared` that nobody has accounted for (audit finding 46).
 *
 * Someone HR removed from this run on purpose still has a draft row, flagged excluded with a
 * reason — that is an explanation, and Part 2 must not ask about them again. Anyone else who was
 * paid last month and is simply absent now is the question the Part 2 confirm stops on.
 */
export function unexplainedDisappearances(
  diff: PopulationDiff,
  draftRows: ReadonlyArray<{ employeeHrIdCompact: string; excluded: boolean }>,
): PopulationDiffPerson[] {
  const explained = new Set(
    draftRows.filter((row) => row.excluded).map((row) => compactHrKey(row.employeeHrIdCompact)),
  );
  return diff.disappeared.filter((person) => !explained.has(compactHrKey(person.hrId)));
}

/** What HR is asked to acknowledge, naming every person in full — never a count, never an ellipsis. */
export function describeUnexplainedDisappearances(people: PopulationDiffPerson[]): string {
  if (people.length === 0) return "";
  const names = people.map((person) => `${person.fullName} (${person.hrId})`).join(", ");
  const subject =
    people.length === 1
      ? "1 employee who was paid last month is missing"
      : `${people.length} employees who were paid last month are missing`;
  return `${subject} from this run with no resignation on file: ${names}.`;
}
