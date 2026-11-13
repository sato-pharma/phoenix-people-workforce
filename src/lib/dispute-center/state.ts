import type { DisputeCaseEvent, DisputeCaseState, DisputeMessage } from "./types.ts";

// Where a dispute stands, worked out from what is stored — never stored itself, so it can never go
// stale against the conversation it summarises. Pure, so the rule is pinned without a database
// (tests/dispute-center-state.test.ts).
//
// The owner's answers that shape it (2026-10-09):
//   - "Wait, no deadline": nothing closes by itself. A case waits on whoever owes the next word.
//   - "Employee asks, reviewer reopens": a decided case stays decided until the REVIEWER reopens it;
//     the employee's request only flags it.

function time(iso: string | null | undefined): number {
  const value = Date.parse(String(iso ?? ""));
  return Number.isFinite(value) ? value : 0;
}

/** The newest of the given events, or null. Ties go to the later one in the list. */
function newest(events: DisputeCaseEvent[], types: ReadonlyArray<DisputeCaseEvent["eventType"]>) {
  let found: DisputeCaseEvent | null = null;
  for (const event of events) {
    if (!types.includes(event.eventType)) continue;
    if (!found || time(event.createdAt) >= time(found.createdAt)) found = event;
  }
  return found;
}

/**
 * For a module that keeps no status of its own (a deduction dispute is a comment thread): decided
 * when the newest "decided" is later than the newest "reopened".
 */
export function isDecidedByEvents(events: DisputeCaseEvent[]): boolean {
  const decided = newest(events, ["decided"]);
  if (!decided) return false;
  const reopened = newest(events, ["reopened"]);
  return !reopened || time(decided.createdAt) >= time(reopened.createdAt);
}

/**
 * Has the case been reopened since its module last recorded a decision? A calendar or weekly-review
 * dispute keeps a decided status on its own row; a reopen moves it back to open there too, but the
 * events are what say WHEN, so a list can show "reopened 2 days ago".
 */
export function reopenedSince(events: DisputeCaseEvent[], decidedAt: string | null): boolean {
  const reopened = newest(events, ["reopened"]);
  if (!reopened) return false;
  return !decidedAt || time(reopened.createdAt) > time(decidedAt);
}

/**
 * A decision that stopped half-way and could not be put back (F-PAY-005): its "decision_interrupted"
 * event is newer than the newest "decided". Cleared by the next decision that completes.
 */
export function needsAttentionByEvents(events: DisputeCaseEvent[]): boolean {
  const interrupted = newest(events, ["decision_interrupted"]);
  if (!interrupted) return false;
  const decided = newest(events, ["decided"]);
  return !decided || time(interrupted.createdAt) > time(decided.createdAt);
}

export function deriveDisputeCaseState(input: {
  /** The module's own answer: is a decision on record right now (not reopened since)? */
  decided: boolean;
  events: DisputeCaseEvent[];
  messages: Pick<DisputeMessage, "createdAt" | "side">[];
  openedAt: string;
}): DisputeCaseState {
  // Never read as open or decided while a half-finished decision is on it.
  if (needsAttentionByEvents(input.events)) return "needs_attention";
  if (input.decided) {
    const latest = newest(input.events, ["reopen_requested", "reopen_declined", "reopened", "decided"]);
    return latest?.eventType === "reopen_requested" ? "reopen_requested" : "decided";
  }

  // Open. Whoever spoke last decides who is owed the next word. The opening is the employee's; a
  // reopen is the reviewer taking the case back to decide again, so it reads as "waiting for the
  // reviewer" until the reviewer asks the employee something.
  let lastSide: "employee" | "reviewer" = "employee";
  let lastAt = time(input.openedAt);
  const reopened = newest(input.events, ["reopened"]);
  if (reopened && time(reopened.createdAt) >= lastAt) {
    lastSide = "employee";
    lastAt = time(reopened.createdAt);
  }
  for (const message of input.messages) {
    const at = time(message.createdAt);
    if (at >= lastAt) {
      lastAt = at;
      lastSide = message.side;
    }
  }
  return lastSide === "reviewer" ? "waiting_employee" : "waiting_reviewer";
}

/** The newest moment anything happened on the case — the sort key of every list. */
export function lastActivityAt(input: {
  events: Pick<DisputeCaseEvent, "createdAt">[];
  messages: Pick<DisputeMessage, "createdAt">[];
  openedAt: string;
  decidedAt?: string | null;
}): string {
  let best = input.openedAt;
  const consider = (iso: string | null | undefined) => {
    if (iso && time(iso) > time(best)) best = iso;
  };
  for (const message of input.messages) consider(message.createdAt);
  for (const event of input.events) consider(event.createdAt);
  consider(input.decidedAt ?? null);
  return best;
}

/** Order for an inbox: what is waiting on the reviewer first, then reopen requests, then the rest; newest first within each. */
export function compareCasesForReviewer(
  left: { state: DisputeCaseState; lastActivityAt: string },
  right: { state: DisputeCaseState; lastActivityAt: string },
): number {
  const rank: Record<DisputeCaseState, number> = {
    needs_attention: -1,
    waiting_reviewer: 0,
    reopen_requested: 1,
    waiting_employee: 2,
    decided: 3,
  };
  const byState = rank[left.state] - rank[right.state];
  if (byState !== 0) return byState;
  return time(right.lastActivityAt) - time(left.lastActivityAt);
}
