/**
 * Phoenix CRM — his own week, planned against done, with no I/O.
 *
 * Owner, 2026-10-02: under his planned day the rep reads ONE line for the field week he is in —
 * what his sent plan holds and what he has visited so far. The I/O half is
 * `src/lib/phoenix-crm/server/week-progress.ts`; the line is drawn on his landing page's "Your day".
 *
 *   - PLANNED is his own sent plan for the week, every stop on it Saturday to Thursday. A plan he has
 *     sent (waiting or approved) plans the week; a draft, or one sent back to him, plans nothing yet —
 *     it is still his to change — so the line then says what he visited and nothing about a plan.
 *   - VISITED is the week so far, Saturday through today, read from `phoenix_crm_countable_visits`:
 *     the view every figure in the module reads, so an off-plan visit nobody has approved yet is
 *     not counted here either, and one approved later is.
 *
 * 🔴 AM · PM · PHARMACIES, THREE FIGURES APART (the owner's golden rules of 2026-09-04 and
 * 2026-09-21). AM and PM are never added into one figure, never averaged and never joined with a
 * slash; a pharmacy is never counted inside either, and has no planned figure because nothing is
 * planned against one — it is feedback recorded ON a visit, so it is counted as the day's distinct
 * pharmacies, summed over the week's days, exactly as the calendar counts them.
 *
 * GOLDEN RULE #1: his own plan and his own work, which stays visible to him. Nothing here compares
 * him with anybody, and nothing here judges him.
 */

import { isPlanSentForReview } from "@/lib/phoenix-crm/plan-rules";
import type { PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";

export type WeekProgress = {
  /** The Saturday the field week starts on. */
  weekStart: string;
  /** What his SENT plan holds for the week; null while the week's plan is a draft, sent back, or absent. */
  planned: { am: number; pm: number } | null;
  /** The week so far, Saturday through today — AM, PM and pharmacies, apart. */
  visited: { am: number; pm: number; pharmacies: number };
};

export type WeekVisit = { visitDate: string; listType: string | null; pharmacyName: string | null };

/** "AM" is AM; anything else is the PM list — the calendar's own rule, so one visit is in one figure. */
function isAm(listType: string | null): boolean {
  return String(listType ?? "").trim().toUpperCase() === "AM";
}

export function weekProgressOf(input: {
  weekStart: string;
  planStatus: PhoenixCrmPlanStatus | null;
  /** The list type of every stop on the week's plan. */
  plannedListTypes: ReadonlyArray<string | null>;
  visits: ReadonlyArray<WeekVisit>;
}): WeekProgress {
  const planned = isPlanSentForReview(input.planStatus)
    ? {
        am: input.plannedListTypes.filter((listType) => isAm(listType)).length,
        pm: input.plannedListTypes.filter((listType) => !isAm(listType)).length,
      }
    : null;
  const pharmaciesByDay = new Map<string, Set<string>>();
  for (const visit of input.visits) {
    const name = String(visit.pharmacyName ?? "").trim().toLocaleLowerCase();
    if (!name) continue;
    const seen = pharmaciesByDay.get(visit.visitDate) ?? new Set<string>();
    seen.add(name);
    pharmaciesByDay.set(visit.visitDate, seen);
  }
  let pharmacies = 0;
  for (const names of pharmaciesByDay.values()) pharmacies += names.size;
  return {
    weekStart: input.weekStart,
    planned,
    visited: {
      am: input.visits.filter((visit) => isAm(visit.listType)).length,
      pm: input.visits.filter((visit) => !isAm(visit.listType)).length,
      pharmacies,
    },
  };
}

/**
 * The line's parts, one per figure, in the module's order: AM, then PM, then pharmacies —
 * "AM 10 planned · 6 visited", "PM 50 planned · 28 visited", "Pharmacies 4".
 *
 * A list with nothing planned and nothing visited says nothing (a rep with no AM customers is not
 * told "AM 0 planned · 0 visited" every day), and pharmacies are left out at zero, as the day's own
 * chip is. Empty when there is nothing at all to say — and then there is no line.
 */
export function weekProgressParts(week: WeekProgress): string[] {
  const parts: string[] = [];
  const list = (label: "AM" | "PM", planned: number | null, visited: number) => {
    if (planned === null) {
      if (visited > 0) parts.push(`${label} ${visited} visited`);
      return;
    }
    if (planned > 0 || visited > 0) parts.push(`${label} ${planned} planned · ${visited} visited`);
  };
  list("AM", week.planned?.am ?? null, week.visited.am);
  list("PM", week.planned?.pm ?? null, week.visited.pm);
  if (week.visited.pharmacies > 0) parts.push(`Pharmacies ${week.visited.pharmacies}`);
  return parts;
}
