import type { PlanSlot } from "./plan-v1.ts";

/**
 * Whether two slots on the same day claim the same time. A full day claims both halves; AM and PM
 * never claim each other.
 */
export function planSlotsOverlap(left: PlanSlot, right: PlanSlot): boolean {
  return left === right || left === "full" || right === "full";
}

/**
 * Which half of a day's Full day / AM / PM switch is lit. Only a day holding exactly one FULL-day
 * row is "full"; a day with more than one row, or with a lone AM or PM row, is "split".
 *
 * Counting rows alone lit "Full day" over a Field Force Thursday (owner's video, 2026-09-13): that
 * day is seeded as a single AM row by design (planRequiredSlotsByDate), so its one row read as a
 * full day while its own pill said AM.
 */
export function planDayMode(rows: readonly { slot: PlanSlot }[]): "full" | "split" {
  return rows.length > 1 || rows.some((row) => row.slot !== "full") ? "split" : "full";
}

export type SourcedSlotRow = {
  activityDate: string;
  key: string;
  locked?: boolean;
  slot: PlanSlot;
};

/**
 * Places one row sourced from another plan or request (approved leave, a national holiday, the
 * submitted weekly plan inside a monthly one, the monthly plan inside a weekly one) onto a day.
 *
 * It displaces every row it OVERLAPS, not only the row with its own slot. Matching on the slot
 * alone is what broke the AM / PM switch (owner, 2026-09-13): a weekly day split into AM + PM
 * landed in the monthly plan beside the empty seeded "Full day" row, which nothing matched, so the
 * day carried three rows, one of them locked, and a locked day's mode buttons are disabled. The
 * stray full-day row was then saved with the plan.
 *
 * - A LOCKED row wins: it displaces the same-slot row and every unlocked overlapping row. It never
 *   displaces a locked row of a different slot.
 * - An UNLOCKED row only fills an untouched day: if anything it overlaps is locked or already
 *   filled in, it is not placed at all.
 *
 * The placed row keeps the key of the same-slot row it replaces, so an open input keeps focus.
 */
export function placeSourcedPlanRow<T extends SourcedSlotRow>(
  rows: readonly T[],
  incoming: T,
  isFilled: (row: T) => boolean,
): T[] {
  const overlapping = rows.filter(
    (row) => row.activityDate === incoming.activityDate && planSlotsOverlap(row.slot, incoming.slot),
  );
  if (!incoming.locked && overlapping.some((row) => row.locked || isFilled(row))) {
    return [...rows];
  }
  const sameSlot = overlapping.find((row) => row.slot === incoming.slot);
  const displaced = new Set(overlapping.filter((row) => row.slot === incoming.slot || !row.locked));
  const placed = sameSlot ? { ...incoming, key: sameSlot.key } : incoming;
  return [...rows.filter((row) => !displaced.has(row)), placed];
}
