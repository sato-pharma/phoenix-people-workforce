import type { PlanSlot } from "./plan-v1.ts";

/**
 * Whether two slots on the same day claim the same time. A full day claims both halves; AM and PM
 * never claim each other.
 */
export function planSlotsOverlap(left: PlanSlot, right: PlanSlot): boolean {
  return left === right || left === "full" || right === "full";
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
