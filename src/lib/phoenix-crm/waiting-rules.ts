/**
 * How long a row on Place checks has waited for a person's decision, and the order that follows from it.
 *
 * Phoenix CRM validation audit, 14 Nov 2026 (owner: "build the five enhancements"): 46 validations and 38
 * polyclinic seatings were waiting, the oldest for 11.6 days, and the board listed them newest first, so
 * the ones that had waited longest sat at the bottom of the last page. A customer waiting there is out of
 * the KPIs for every one of those days. What is WAITING is now listed oldest first and says how long it
 * has waited; what is already decided keeps its newest-first order.
 *
 * Pure: no I/O, and `now` is always handed in, so the server and a test read the same clock.
 */

const HOUR_MS = 60 * 60 * 1000;

/** A wait this long is drawn in the warning tone. Three days: one weekend can no longer explain it. */
export const WAITING_LONG_HOURS = 72;

/** Whole hours waited since `since`. Null when there is no usable instant, never a guess. */
export function waitingHours(since: string | null | undefined, now: Date): number | null {
  if (!since) return null;
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / HOUR_MS));
}

/**
 * The wait in the board's words: hours below a day, whole days above it. Elapsed time, not calendar
 * days, so a row captured at 23:00 does not read "1 day" an hour later.
 */
export function waitingText(since: string | null | undefined, now: Date): string | null {
  const hours = waitingHours(since, now);
  if (hours === null) return null;
  if (hours < 1) return "Waiting under 1 hour";
  if (hours < 24) return `Waiting ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `Waiting ${days} ${days === 1 ? "day" : "days"}`;
}

export function waitingIsLong(since: string | null | undefined, now: Date): boolean {
  const hours = waitingHours(since, now);
  return hours !== null && hours >= WAITING_LONG_HOURS;
}

/**
 * Oldest first, the id breaking a tie so two rows of one instant never swap between two reads. A row
 * with no usable instant goes last: it is never allowed to jump the queue on a broken stamp.
 */
export function compareOldestFirst(left: { at: string; id: string }, right: { at: string; id: string }): number {
  const leftAt = Date.parse(left.at);
  const rightAt = Date.parse(right.at);
  const leftKnown = Number.isFinite(leftAt);
  const rightKnown = Number.isFinite(rightAt);
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  if (leftKnown && rightKnown && leftAt !== rightAt) return leftAt - rightAt;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}

/**
 * The waiting rows oldest first, everything else exactly where it was. The board splits one list into
 * "waiting" and "decided" by filtering, which keeps order, so ordering the waiting rows inside the one
 * list is enough and no reader of the decided rows sees a change.
 */
export function waitingOldestFirst<Row>(rows: ReadonlyArray<Row>, isWaiting: (row: Row) => boolean, key: (row: Row) => { at: string; id: string }): Row[] {
  const waiting = rows.filter(isWaiting).sort((left, right) => compareOldestFirst(key(left), key(right)));
  let next = 0;
  return rows.map((row) => (isWaiting(row) ? waiting[next++] : row));
}
