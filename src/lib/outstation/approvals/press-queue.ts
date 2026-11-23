/**
 * A press that has not been sent yet — the six seconds of Undo, and what happens when they end.
 *
 * Rebuilt 2026-11-23 (owner: "Save at once, with Undo"). A decision is a press: nothing is marked
 * and saved later. The press waits six seconds in the browser, during which Undo takes it back;
 * then it is sent, and the claim's answer comes back with it. The server reverses nothing.
 *
 * Pure, so the three things that must never go wrong are proven without a browser:
 *
 *   - a claim inside a press is off the list and out of the waiting count until the press is
 *     answered or taken back — it can never be pressed twice;
 *   - leaving the page sends every press still inside its window (`takeAll`), so a decision he made
 *     is never dropped in silence;
 *   - a claim whose decision did not land comes back to the list with the reason, by name.
 */

import type { DeskClaim, DeskDecisionOutcome, DeskDecisionRequest, DeskQueue, DecisionAction } from "@/lib/outstation/approvals/types";

export const UNDO_WINDOW_MS = 6_000;

export type DeskPress = {
  /** Each claim as it was on screen when it was pressed. */
  claims: DeskClaim[];
  decisions: DeskDecisionRequest[];
  /** When the press is sent. */
  dueAt: number;
  id: number;
};

export type PressQueue = {
  nextId: number;
  /** Sent, not answered yet. Past Undo. */
  sending: DeskPress[];
  /** Inside the Undo window. */
  waiting: DeskPress[];
};

export const EMPTY_PRESS_QUEUE: PressQueue = { nextId: 1, sending: [], waiting: [] };

/** Every claim inside a press, waiting or being sent: off the list until it is answered. */
export function pressedRequestIds(queue: PressQueue): Set<number> {
  const ids = new Set<number>();
  for (const press of [...queue.waiting, ...queue.sending]) for (const decision of press.decisions) ids.add(decision.requestId);
  return ids;
}

/**
 * A new press. A decision for a claim already inside a press, or for a claim that is not on screen,
 * is dropped: one claim, one press at a time. Returns the same queue when nothing is left.
 */
export function addPress(
  queue: PressQueue,
  input: { claims: ReadonlyArray<DeskClaim>; decisions: ReadonlyArray<DeskDecisionRequest>; now: number },
): PressQueue {
  const taken = pressedRequestIds(queue);
  const onScreen = new Map(input.claims.map((claim) => [claim.requestId, claim]));
  const decisions: DeskDecisionRequest[] = [];
  const claims: DeskClaim[] = [];
  for (const decision of input.decisions) {
    const claim = onScreen.get(decision.requestId);
    if (!claim || taken.has(decision.requestId)) continue;
    taken.add(decision.requestId);
    decisions.push(decision);
    claims.push(claim);
  }
  if (decisions.length === 0) return queue;
  return {
    nextId: queue.nextId + 1,
    sending: queue.sending,
    waiting: [...queue.waiting, { claims, decisions, dueAt: input.now + UNDO_WINDOW_MS, id: queue.nextId }],
  };
}

/** Undo. Only a press still inside its window can be taken back; one already sent cannot. */
export function undoPress(queue: PressQueue, id: number): PressQueue {
  if (!queue.waiting.some((press) => press.id === id)) return queue;
  return { ...queue, waiting: queue.waiting.filter((press) => press.id !== id) };
}

/** The presses whose window has ended, moved to "being sent". */
export function takeDue(queue: PressQueue, now: number): { due: DeskPress[]; queue: PressQueue } {
  const due = queue.waiting.filter((press) => press.dueAt <= now);
  if (due.length === 0) return { due, queue };
  return { due, queue: { ...queue, sending: [...queue.sending, ...due], waiting: queue.waiting.filter((press) => press.dueAt > now) } };
}

/** The page is closing: every press still inside its window is sent now. */
export function takeAll(queue: PressQueue): { due: DeskPress[]; queue: PressQueue } {
  if (queue.waiting.length === 0) return { due: [], queue };
  return { due: queue.waiting, queue: { ...queue, sending: [...queue.sending, ...queue.waiting], waiting: [] } };
}

/** The press was answered (or failed): its claims are free again. */
export function settlePress(queue: PressQueue, id: number): PressQueue {
  if (!queue.sending.some((press) => press.id === id)) return queue;
  return { ...queue, sending: queue.sending.filter((press) => press.id !== id) };
}

/** When the next press is due; null when none waits. */
export function nextDueAt(queue: PressQueue): number | null {
  return queue.waiting.length === 0 ? null : Math.min(...queue.waiting.map((press) => press.dueAt));
}

/** What the decide route is sent: the decisions and nothing else. */
export function pressBody(press: DeskPress): { decisions: DeskDecisionRequest[] } {
  return { decisions: press.decisions };
}

/** Each pressed claim with its action, as `applyDeskOutcomes` reads it. */
export function pressSent(press: DeskPress): Array<{ action: DecisionAction; claim: DeskClaim }> {
  const actions = new Map(press.decisions.map((decision) => [decision.requestId, decision.action]));
  return press.claims.map((claim) => ({ action: actions.get(claim.requestId) ?? "approve", claim }));
}

const money = (value: number) => Math.round(value * 100) / 100;

/**
 * The page while presses are out: their waiting claims are off the list and out of the Waiting
 * tile, so the top line, the lanes and the list always say the same number. Undo puts them back.
 */
export function queueWithPressesOut(queue: DeskQueue, pressed: ReadonlySet<number>): DeskQueue {
  if (pressed.size === 0) return queue;
  const out = queue.claims.filter((claim) => pressed.has(claim.requestId) && claim.standing === "waiting");
  if (out.length === 0) return queue;
  const claims = queue.claims.filter((claim) => !pressed.has(claim.requestId) || claim.standing !== "waiting");
  const waiting = {
    count: Math.max(0, queue.tiles.waiting.count - out.length),
    value: Math.max(0, money(queue.tiles.waiting.value - out.reduce((sum, claim) => sum + claim.payable, 0))),
  };
  return {
    ...queue,
    claims,
    overSevenDays: claims.filter((claim) => claim.standing === "waiting" && claim.daysWaiting > 7).length,
    tiles: { ...queue.tiles, waiting },
  };
}

export type DeskNotice = {
  message: string;
  name: string;
  requestId: number;
  /** `bad` = the decision did not land and the claim is back; `warn` = it landed, with a caution. */
  tone: "bad" | "warn";
};

/**
 * What the page says after a press was answered: one line per claim that came back (refused, or
 * changed since he saw it), and one per claim that landed with a caution (approved, but held).
 * A claim the answer does not mention did not land — it is named too, never passed over.
 */
export function pressNotices(press: DeskPress, outcomes: ReadonlyArray<DeskDecisionOutcome>, notSaved: string): DeskNotice[] {
  const answered = new Map(outcomes.map((outcome) => [outcome.requestId, outcome]));
  const notices: DeskNotice[] = [];
  for (const claim of press.claims) {
    const outcome = answered.get(claim.requestId);
    if (!outcome) {
      notices.push({ message: notSaved, name: claim.employeeName, requestId: claim.requestId, tone: "bad" });
    } else if (outcome.code !== "saved") {
      notices.push({ message: outcome.message || notSaved, name: claim.employeeName, requestId: claim.requestId, tone: "bad" });
    } else if (outcome.message) {
      notices.push({ message: outcome.message, name: claim.employeeName, requestId: claim.requestId, tone: "warn" });
    }
  }
  return notices;
}

/** The request itself failed: every claim of the press is named, and the list is read again. */
export function failedPressNotices(press: DeskPress, message: string): DeskNotice[] {
  return press.claims.map((claim) => ({ message, name: claim.employeeName, requestId: claim.requestId, tone: "bad" as const }));
}

/** A newer line about a claim replaces the older one; the rest keep their order. */
export function mergeNotices(current: ReadonlyArray<DeskNotice>, incoming: ReadonlyArray<DeskNotice>): DeskNotice[] {
  const fresh = new Set(incoming.map((notice) => notice.requestId));
  return [...current.filter((notice) => !fresh.has(notice.requestId)), ...incoming];
}
