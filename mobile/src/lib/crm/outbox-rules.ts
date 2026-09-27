/**
 * Phoenix CRM — the phone's mirror of `src/lib/phoenix-crm/outbox-rules.ts`.
 *
 * ## Why a mirror exists at all
 *
 * `mobile/` is its own TypeScript project: `@/*` resolves to `mobile/src/*` and nothing else, so the
 * web module is unreachable from here. `drainOutbox` was written to take its rules as an argument
 * precisely so there would be ONE definition — but with no mobile file able to supply them, the
 * queue shipped uncallable (#4560). This is that file, and `runPhoenixCrmMobileMirrorsTests`
 * compares every constant, every code and every sentence in it against the web original, so the two
 * cannot drift in silence.
 *
 * 🔴 **Change the web module first, then this, in the same commit.** A mirror edited alone is how a
 * phone ends up holding 500 visits the server's rules never agreed to.
 *
 * ## The one rule everything here serves
 *
 * A rep's work is never thrown away. An item leaves the queue only when the server ACCEPTED it, or
 * refused it for a reason that can never change. Every network failure and every 5xx is kept and
 * retried, for ever. When the queue is full the NEWEST capture is refused at the door rather than an
 * older one quietly discarded.
 */

/** What the phone does with an item after a failed attempt. */
export type OutboxVerdict = "retry" | "settled" | "sent";

/** How many visits may wait at once. */
export const OUTBOX_MAX_ITEMS = 120;

/** How long a waiting visit is still worth retrying. Deliberately longer than the anchor's 20 hours. */
export const OUTBOX_MAX_AGE_HOURS = 7 * 24;

/**
 * Refusals that are final. Everything else — every network failure, every 5xx — retries.
 *
 * 🔴 These are the API codes the phone actually receives (`ApiError.code`), which `db.ts` builds as
 * `phoenix_crm_<name>` with an UNDERSCORE. The colon form is the Postgres exception text and never
 * reaches here; spelling it that way matches nothing, which is the defect this file was born fixing.
 */
export const OUTBOX_SETTLED_CODES: readonly string[] = [
  "phoenix_crm_already_visited",
  "phoenix_crm_customer_dropped",
  "phoenix_crm_id_conflict",
  "phoenix_crm_customer_not_found",
  "phoenix_crm_bad_input",
  "phoenix_crm_bad_participants",
];

/** The minimum an item must carry for these rules to judge it. The queue's own type is a superset. */
export type OutboxItem = { visitId: string; queuedAtIso: string; photoPath: string | null; attempts: number };

/**
 * What to do with an item after one attempt.
 *
 * A 5xx DID reach Phoenix, but the server broke rather than judged, so it retries — the same
 * distinction the read cache already draws.
 */
export function outboxVerdict(outcome: { ok: boolean; kind?: "offline" | "api"; code?: string | null; status?: number }): OutboxVerdict {
  if (outcome.ok) return "sent";
  if (outcome.kind !== "api") return "retry";
  if (typeof outcome.status === "number" && outcome.status >= 500) return "retry";
  return OUTBOX_SETTLED_CODES.includes(outcome.code ?? "") ? "settled" : "retry";
}

/** Oldest first, so a day drains in the order it happened. */
export function outboxOrder<T extends OutboxItem>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((left, right) => Date.parse(left.queuedAtIso) - Date.parse(right.queuedAtIso) || left.visitId.localeCompare(right.visitId));
}

/** Has this waited so long it is no longer plausible? It stops the retrying; it does NOT delete. */
export function outboxIsStale(item: OutboxItem, nowIso: string): boolean {
  const queued = Date.parse(item.queuedAtIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(queued) || Number.isNaN(now)) return false;
  return now - queued > OUTBOX_MAX_AGE_HOURS * 60 * 60 * 1000;
}

/** 🔴 The NEWEST capture is refused when the queue is full, never an older one discarded. */
export function outboxHasRoom(items: ReadonlyArray<OutboxItem>): boolean {
  return items.length < OUTBOX_MAX_ITEMS;
}

/**
 * What the rep is told.
 *
 * 🔴 Never "failed", never "error", never a count of attempts, never why. A waiting visit is SAFE,
 * and that is the only fact he needs (Golden Rule #1).
 */
export function describeOutbox(count: number): string | null {
  if (count <= 0) return null;
  if (count === 1) return "1 visit is saved on this phone. It will send itself when there is signal.";
  return `${count} visits are saved on this phone. They will send themselves when there is signal.`;
}

/** What he is told at the door when the queue is full. An instruction, not a complaint. */
export const OUTBOX_FULL_MESSAGE =
  "This phone is holding as many visits as it can. Find signal for a moment so they can send, then carry on.";
