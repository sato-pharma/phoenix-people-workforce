/**
 * Phoenix CRM — the rules for a visit waiting on the phone. Pure arithmetic, no I/O, no storage.
 *
 * ## Why this exists at all
 *
 * Until now the app had a stated decision NOT to hold a CRM write (`mobile/src/lib/crm/client.ts`:
 * "There is no offline cache here … a rep validates a customer or enters a visit only where there is
 * a connection to take the photo"). That was true and it was the right call, because a visit could
 * not be DATED without the server. Phases 1 to 3 removed that obstacle: a server-minted anchor plus
 * elapsed monotonic time gives an honest Cairo capture time with no signal at all. So the reason for
 * refusing to hold work is gone, and what is left is a rep in a dead spot losing a real visit.
 *
 * ## 🔴 GOLDEN RULE #1 GOVERNS EVERY WORD A REP SEES HERE
 *
 * The rep's app is EASY, and it never makes him feel checked. So a queued visit is described as
 * **safe**, never as failed: "3 visits are saved on this phone" and not "3 visits failed to send".
 * There is no error count, no red, no retry button he has to understand, and nothing about why a
 * send did not work. The queue is plumbing; his job is the door and the photograph.
 *
 * ## 🔴 A REP'S WORK IS NEVER DELETED TO TIDY UP
 *
 * The only thing that removes an item is the SERVER accepting it, or the server REFUSING it for a
 * reason that can never change — already visited today, customer dropped, id conflict. A network
 * failure retries for ever, because the alternative is throwing away a visit he actually made. When
 * the queue is full the NEWEST capture is refused at the door rather than an older one being
 * discarded: telling him now that he must send before capturing more is honest, and silently eating
 * yesterday's visit is not.
 */

/** What the phone does with an item after a failed attempt. */
export type OutboxVerdict =
  /** The request never landed, or the server broke. Keep it and try again. */
  | "retry"
  /** The server answered and said no for a reason that will not change. Drop it and record why. */
  | "settled"
  /** The server accepted it. */
  | "sent";

/**
 * How many visits may wait at once.
 *
 * A field day is a few dozen visits and a photo is capped at 2 MB, so this is a generous ceiling on
 * both counts — roughly a day and a half of the busiest work, and under 250 MB of phone storage in
 * the worst case. It exists so a phone that has been offline for a week cannot fill its own disk.
 */
export const OUTBOX_MAX_ITEMS = 120;

/**
 * How long a waiting visit is still worth sending.
 *
 * Deliberately LONGER than the anchor's own 20-hour life. Past the anchor the visit can no longer be
 * dated at the door and will be dated at arrival instead — which is worse, but it is still a real
 * visit to a real doctor and dropping it would be a lie about a rep's day. Only at a week does it
 * stop being plausible that the phone has simply been away.
 */
export const OUTBOX_MAX_AGE_HOURS = 7 * 24;

/**
 * Refusals that are final. Everything else — including every network failure and every 5xx — retries.
 *
 * 🔴 This list is the whole safety of the queue, and it is short on purpose. Each entry is a state
 * the server can never come back from: the day already holds that visit, the customer has left the
 * list, or the id belongs to another seat. Adding a code here throws a rep's work away, so nothing
 * joins it without a reason of that kind.
 *
 * 🔴 THE SPELLING IS THE API CODE, NOT THE DATABASE'S. `db.ts` catches `phoenix_crm:<name>` out of a
 * Postgres exception and re-throws it as `new ApiError(status, \`phoenix_crm_${name}\`, …)`, so what
 * reaches the phone is UNDERSCORE-separated. This list first shipped with the colon form (#4560) and
 * therefore matched nothing at all: every permanent refusal read as "retry", and a visit the server
 * would never accept sat in the queue for a week. It failed SAFE — no rep lost work — but the queue
 * could not drain and the rep's "saved on this phone" line would never clear. `runPhoenixCrmOutboxTests`
 * now resolves every entry against `db.ts`'s own REFUSALS table so the two cannot drift again.
 *
 * Deliberately NOT here: `phoenix_crm_conflict`, the bare 23505 race. It does mean the visit is
 * already stored, but it is minted outside REFUSALS and is rare by construction, and keeping a visit
 * too long is the safe direction while deleting one is not.
 */
export const OUTBOX_SETTLED_CODES: readonly string[] = [
  "phoenix_crm_already_visited",
  "phoenix_crm_customer_dropped",
  "phoenix_crm_id_conflict",
  "phoenix_crm_customer_not_found",
  "phoenix_crm_bad_input",
  "phoenix_crm_bad_participants",
];

export type OutboxItem = {
  visitId: string;
  /** When the phone captured it, by its own monotonic reckoning. Used only for ORDER and AGE here. */
  queuedAtIso: string;
  /** The storage path, once an upload has succeeded. Null until then. */
  photoPath: string | null;
  attempts: number;
};

/**
 * What to do with an item after one attempt.
 *
 * `offline` covers every case where the request never reached Phoenix. A 5xx DID reach it, but the
 * server broke rather than judged — so it retries too, which is the same distinction
 * `use-phoenix-query.ts` already draws for its read cache and for the same reason.
 */
export function outboxVerdict(outcome: { ok: boolean; kind?: "offline" | "api"; code?: string | null; status?: number }): OutboxVerdict {
  if (outcome.ok) return "sent";
  if (outcome.kind !== "api") return "retry";
  if (typeof outcome.status === "number" && outcome.status >= 500) return "retry";
  return OUTBOX_SETTLED_CODES.includes(outcome.code ?? "") ? "settled" : "retry";
}

/** Oldest first, so a day drains in the order it happened. */
export function outboxOrder(items: ReadonlyArray<OutboxItem>): OutboxItem[] {
  return [...items].sort((left, right) => Date.parse(left.queuedAtIso) - Date.parse(right.queuedAtIso) || left.visitId.localeCompare(right.visitId));
}

/**
 * Has this item waited so long it is no longer plausible? Note what this does NOT do: it does not
 * delete anything. It only stops the phone retrying for ever, and the caller keeps the file.
 */
export function outboxIsStale(item: OutboxItem, nowIso: string): boolean {
  const queued = Date.parse(item.queuedAtIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(queued) || Number.isNaN(now)) return false;
  return now - queued > OUTBOX_MAX_AGE_HOURS * 60 * 60 * 1000;
}

/**
 * 🔴 The NEWEST capture is refused when the queue is full, never an older one discarded.
 *
 * Telling a rep now that he must find signal before capturing more is honest and actionable. Quietly
 * dropping the visit he made yesterday is neither, and he would never know it happened.
 */
export function outboxHasRoom(items: ReadonlyArray<OutboxItem>): boolean {
  return items.length < OUTBOX_MAX_ITEMS;
}

/**
 * What the rep is told, in his own terms.
 *
 * 🔴 Never "failed", never "error", never a number of attempts, never why. A waiting visit is SAFE,
 * and that is the only fact he needs. The wording lives here rather than in a screen so that this is
 * the one place it can be checked.
 */
export function describeOutbox(count: number): string | null {
  if (count <= 0) return null;
  if (count === 1) return "1 visit is saved on this phone. It will send itself when there is signal.";
  return `${count} visits are saved on this phone. They will send themselves when there is signal.`;
}

/** What he is told at the door when the queue is full. An instruction, not a complaint. */
export const OUTBOX_FULL_MESSAGE =
  "This phone is holding as many visits as it can. Find signal for a moment so they can send, then carry on.";
