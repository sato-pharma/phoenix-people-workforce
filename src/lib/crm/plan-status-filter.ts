/**
 * The plan status filter's vocabulary — the four groups, the resolver, the predicate and the count.
 *
 * The owner, 2026-09-02: make "the admin, or any role who has the authority" able to "filter by
 * verified plan and non-verified plan".
 *
 * ## Why this is its own file, and must stay one
 *
 * These four exports were written inside `reps-weekly-plans-board.ts`, where they are used. That
 * module reaches `plan-board` → `contact-lists` → `manager-scope` → `employee-directory` →
 * `employee-photo` → `node:crypto`, all of it server-only. The moment the client-side status picker
 * imported `PLAN_STATUS_FILTERS` from there — a VALUE, so not erased the way a type import is — that
 * whole chain was pulled into the browser bundle and webpack refused it outright:
 *
 *     Module build failed: UnhandledSchemeError: Reading from "node:crypto" is not handled
 *     ./src/components/crm/plan-status-picker.tsx
 *
 * The page 500'd, and a cold `tsc --noEmit` had passed clean immediately before — types say nothing
 * about which bundle a module lands in. This is the same boundary that already caught
 * `planPeriodText` and `planStatusClass` on this feature, in the mirror direction: there a server
 * component imported through a "use client" file and got a client reference instead of a function.
 *
 * So this file has NO directive and exactly one import, from `plan-verification.ts`, which itself
 * imports nothing at all. Both halves of the app can hold it. Do not move these back into the board
 * module for tidiness, and do not add an import here that reaches the database, the filesystem or
 * any node: builtin — the next thing to break would be the browser bundle again, at runtime, on a
 * page that typechecks.
 */

import { PLAN_STATUS_NEW } from "@/lib/crm/plan-verification";

/**
 * The status filter's four answers.
 *
 * "NOT VERIFIED" IS TWO FACTS HERE, NOT ONE, and this board keeps them apart everywhere else —
 * `foldRepPlanStatus` returns null only for a rep who filed nothing, and the rep card prints
 * "No plan filed" rather than "Pending". A rep who filed nothing has not planned his week; a rep
 * whose plan is pending is waiting on his manager. Offering a single "not verified" option would
 * merge them on the one screen where a manager decides who to chase, and would hand him a list
 * mixing people he should ring with people he should sign for. So they are separate options, and
 * `all` is the only one that spans both.
 */
export const PLAN_STATUS_FILTERS = ["all", "awaiting", "verified", "missing"] as const;

export type PlanStatusFilter = (typeof PLAN_STATUS_FILTERS)[number];

/** The week in four numbers, keyed by the filter each one selects. */
export type PlanStatusCounts = Record<PlanStatusFilter, number>;

/**
 * A `?status=` that is stale, hand-typed or misspelt resolves to `all`.
 *
 * Same falls-back-never-throws posture as the week resolver. THE DIRECTION MATTERS: an unrecognised
 * value must widen to everybody, never narrow to nobody — a board emptied by a bad parameter reads
 * as "no rep in your reach filed a plan this week", which is a statement about the reps rather than
 * about the URL, and it is the kind a manager acts on.
 */
export function resolvePlanStatusFilter(raw: string | null | undefined): PlanStatusFilter {
  const value = raw?.trim().toLowerCase() ?? "";
  return (PLAN_STATUS_FILTERS as readonly string[]).includes(value) ? (value as PlanStatusFilter) : "all";
}

/** Whether one rep's week belongs in the chosen slice. */
export function repMatchesPlanStatusFilter(
  rep: { planStatus: number | null; plansFiled: number },
  filter: PlanStatusFilter,
): boolean {
  if (filter === "all") return true;
  // Filed-or-not is asked FIRST, so a rep who filed nothing can never fall into "awaiting" on the
  // strength of `planStatus ?? PLAN_STATUS_NEW` — that coalesce is what turns "he did not plan his
  // week" into "you have not signed it", and it is one reordered line away at all times.
  if (rep.plansFiled === 0) return filter === "missing";
  const pending = (rep.planStatus ?? PLAN_STATUS_NEW) === PLAN_STATUS_NEW;
  return filter === (pending ? "awaiting" : "verified");
}

/**
 * The week's totals — ONE arithmetic, read by both the tiles and the filter.
 *
 * The tiles counted this for themselves in the view before the filter existed. Leaving it there
 * would have put the same rule in two places: a tile reading "Awaiting you 3" that filters down to
 * two reps is a board arguing with itself, and neither number looks wrong on its own. Counting here
 * and filtering with the same predicate makes that disagreement unrepresentable rather than merely
 * unlikely.
 */
export function countRepPlanStatuses(
  reps: readonly { planStatus: number | null; plansFiled: number }[],
): PlanStatusCounts {
  const counts: PlanStatusCounts = { all: reps.length, awaiting: 0, missing: 0, verified: 0 };
  for (const rep of reps) {
    if (repMatchesPlanStatusFilter(rep, "missing")) counts.missing += 1;
    else if (repMatchesPlanStatusFilter(rep, "awaiting")) counts.awaiting += 1;
    else counts.verified += 1;
  }
  return counts;
}
