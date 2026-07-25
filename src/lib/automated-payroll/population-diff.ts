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
 * Pure + I/O-free so it is unit-tested; callers supply last month's roster.
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
