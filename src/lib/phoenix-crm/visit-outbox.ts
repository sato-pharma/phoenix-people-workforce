/**
 * Phoenix CRM — the visits this phone is holding, and the one pass that sends them.
 *
 * Browser storage and the network are both handed in, so the whole flow runs under test with fakes:
 * no real visit is ever saved to prove it, because `.env.local` is production
 * (`tests/phoenix-crm-visit-outbox.test.ts`).
 *
 * Every entry follows the one owner rule (`browser-storage/owner-scoped.ts`): keyed by its person,
 * carrying its person, sent and shown for that person only, and left where it is at sign-out, because
 * the rep was told it is safe.
 */

import { isOwnedByViewer, ownerScopedStorageKey, VISIT_OUTBOX_KEY_BASE } from "@/lib/browser-storage/owner-scoped";
import {
  answerToRefusal,
  isReadyToSend,
  isTooLateToSend,
  queuedSecondsAt,
  VISIT_OUTBOX_MAX_ENTRIES,
  VISIT_RESEND_GAP_MS,
  VISIT_RESEND_IN_FLIGHT_MS,
  withoutVoiceNote,
  type QueuedVisit,
  type VisitResendOutcome,
} from "@/lib/phoenix-crm/visit-resend-rules";

type OutboxStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isEntry(value: unknown): value is QueuedVisit {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<QueuedVisit>;
  return (
    typeof entry.visitId === "string" &&
    typeof entry.seatId === "string" &&
    typeof entry.customerId === "string" &&
    typeof entry.pressedAtMs === "number" &&
    typeof entry.body === "object" &&
    entry.body !== null &&
    (entry.status === "waiting" || entry.status === "refused" || entry.status === "too_late")
  );
}

/** One person's entries, oldest first. Never throws: blocked site data simply reads as nothing held. */
export function readQueuedVisits(storage: OutboxStorage | null, ownerHrId: unknown): QueuedVisit[] {
  const key = ownerScopedStorageKey(VISIT_OUTBOX_KEY_BASE, ownerHrId);
  if (!storage || !key) return [];
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isEntry)
      .filter((entry) => isOwnedByViewer(entry.ownerHrId, ownerHrId))
      .sort((left, right) => left.pressedAtMs - right.pressedAtMs);
  } catch {
    return [];
  }
}

function writeAll(storage: OutboxStorage, ownerHrId: unknown, entries: QueuedVisit[]): boolean {
  const key = ownerScopedStorageKey(VISIT_OUTBOX_KEY_BASE, ownerHrId);
  if (!key) return false;
  try {
    if (entries.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes one entry, replacing any under the same id. False means it was NOT kept — no storage, storage
 * full, or the phone already holding its limit — and the caller then behaves exactly as it did before
 * this queue existed, because telling a rep a visit is safe when it is not is the one unforgivable answer.
 */
export function keepQueuedVisit(storage: OutboxStorage | null, ownerHrId: unknown, entry: QueuedVisit): boolean {
  if (!storage || !isOwnedByViewer(entry.ownerHrId, ownerHrId)) return false;
  const others = readQueuedVisits(storage, ownerHrId).filter((held) => held.visitId !== entry.visitId);
  if (others.length >= VISIT_OUTBOX_MAX_ENTRIES) return false;
  return writeAll(storage, ownerHrId, [...others, entry]);
}

export function forgetQueuedVisit(storage: OutboxStorage | null, ownerHrId: unknown, visitId: string): void {
  if (!storage) return;
  const held = readQueuedVisits(storage, ownerHrId);
  const kept = held.filter((entry) => entry.visitId !== visitId);
  if (kept.length !== held.length) writeAll(storage, ownerHrId, kept);
}

/**
 * The entry already held for this customer on this territory and day, if any. A press for the same visit
 * goes under the SAME id, so if the first one did land the server answers with it rather than a second visit.
 */
export function findHeldVisit(entries: readonly QueuedVisit[], where: { seatId: string; customerId: string; pressedDay: string }): QueuedVisit | null {
  return entries.find((entry) => entry.seatId === where.seatId && entry.customerId === where.customerId && entry.pressedDay === where.pressedDay) ?? null;
}

/** The customers not to offer again on this territory: their visit is already on this phone. */
export function waitingCustomerIds(entries: readonly QueuedVisit[], seatId: string): ReadonlySet<string> {
  return new Set(entries.filter((entry) => entry.seatId === seatId && entry.status === "waiting").map((entry) => entry.customerId));
}

/** A failed send, as the network layer reports it. */
export type SendFailure = { code: string | null; message: string };

export type OutboxDeps = {
  storage: OutboxStorage | null;
  ownerHrId: string;
  /** The phone's clock. */
  now: () => number;
  /** Which of these ids are on file, the switch and the server's clock. Throws when it cannot be read. */
  readStatus: (visitIds: string[]) => Promise<{ enabled: boolean; savedVisitIds: string[]; serverNowMs: number }>;
  /** Sends one body. Answers whether the server called it a repeat, and throws a SendFailure when refused or unreachable. */
  send: (body: Record<string, unknown>) => Promise<{ duplicate: boolean }>;
  /** Files how an entry ended. Answers nothing and must never throw. */
  report: (entry: QueuedVisit, outcome: VisitResendOutcome, queuedSeconds: number | null) => void;
  sleep: (ms: number) => Promise<void>;
  /** The list changed: redraw. */
  changed: () => void;
};

function failureOf(error: unknown): SendFailure {
  const failure = error as Partial<SendFailure> | null;
  return { code: typeof failure?.code === "string" ? failure.code : null, message: typeof failure?.message === "string" ? failure.message : "" };
}

/** Is the signal, or the sign-in, what stopped it? Then nothing is decided: it simply waits for the next pass. */
function isStopper(code: string | null): boolean {
  return code === "offline" || code === "signed_out";
}

/**
 * One pass over one person's waiting visits, oldest first, one at a time. Answers how many remain waiting.
 *
 * 🔴 IT ASKS BEFORE IT SENDS. The status read settles anything that already landed with no POST at all, and
 * costs one request that fails at once where there is no signal. A failed read means nothing is decided.
 */
export async function drainVisitOutbox(deps: OutboxDeps): Promise<number> {
  const { storage, ownerHrId } = deps;
  const waiting = () => readQueuedVisits(storage, ownerHrId).filter((entry) => entry.status === "waiting");
  const candidates = waiting().filter((entry) => isReadyToSend(entry, deps.now()));
  if (candidates.length === 0) return waiting().length;

  let status: Awaited<ReturnType<OutboxDeps["readStatus"]>>;
  try {
    status = await deps.readStatus(candidates.map((entry) => entry.visitId));
  } catch {
    return waiting().length;
  }
  const onFile = new Set(status.savedVisitIds);

  let sentOne = false;
  for (const entry of candidates) {
    const nowMs = deps.now();
    const queuedSeconds = queuedSecondsAt(entry, nowMs);

    if (onFile.has(entry.visitId)) {
      forgetQueuedVisit(storage, ownerHrId, entry.visitId);
      deps.report(entry, "already_saved", queuedSeconds);
      deps.changed();
      continue;
    }
    // Off, past two hours or across 02:00: never sent by itself. He logs it again, and it is a fresh visit.
    if (!status.enabled || isTooLateToSend(entry, nowMs, status.serverNowMs)) {
      keepQueuedVisit(storage, ownerHrId, { ...entry, status: "too_late", sendingUntilMs: 0 });
      deps.report(entry, "timed_out", queuedSeconds);
      deps.changed();
      continue;
    }

    if (sentOne) await deps.sleep(VISIT_RESEND_GAP_MS);
    sentOne = true;

    const stopped = await sendOne(deps, entry);
    if (stopped) break;
  }
  return waiting().length;
}

/** Sends one entry to its end. True when the signal or the sign-in stopped it, so the pass ends here. */
async function sendOne(deps: OutboxDeps, first: QueuedVisit): Promise<boolean> {
  const { storage, ownerHrId } = deps;
  let entry: QueuedVisit = { ...first, attempts: first.attempts + 1, sendingUntilMs: deps.now() + VISIT_RESEND_IN_FLIGHT_MS };
  keepQueuedVisit(storage, ownerHrId, entry);

  // At most twice: once as pressed, and once more if only the spoken note's slot was refused.
  for (let round = 0; round < 2; round += 1) {
    const queuedSeconds = queuedSecondsAt(entry, deps.now());
    try {
      const answer = await deps.send({ ...entry.body, queuedSeconds });
      forgetQueuedVisit(storage, ownerHrId, entry.visitId);
      deps.report(entry, answer.duplicate ? "already_saved" : "landed_late", queuedSeconds);
      deps.changed();
      return false;
    } catch (error) {
      const failure = failureOf(error);
      if (isStopper(failure.code)) {
        keepQueuedVisit(storage, ownerHrId, { ...entry, sendingUntilMs: 0 });
        return true;
      }
      // A refusal does not prove the visit is unsaved, so the id is read again before anything is said.
      let idIsOnFile = false;
      try {
        idIsOnFile = (await deps.readStatus([entry.visitId])).savedVisitIds.includes(entry.visitId);
      } catch {
        // Nothing can be proved right now, and a refusal he need not have seen is the worse mistake.
        keepQueuedVisit(storage, ownerHrId, { ...entry, sendingUntilMs: 0 });
        return true;
      }
      const answer = answerToRefusal({ code: failure.code, idIsOnFile, body: entry.body });
      if (answer === "settled") {
        forgetQueuedVisit(storage, ownerHrId, entry.visitId);
        deps.report(entry, "already_saved", queuedSeconds);
        deps.changed();
        return false;
      }
      if (answer === "send_without_voice" && round === 0) {
        entry = { ...entry, body: withoutVoiceNote(entry.body) };
        keepQueuedVisit(storage, ownerHrId, entry);
        continue;
      }
      keepQueuedVisit(storage, ownerHrId, { ...entry, status: "refused", refusalCode: failure.code, refusalMessage: failure.message, sendingUntilMs: 0 });
      deps.report(entry, "refused", queuedSeconds);
      deps.changed();
      return false;
    }
  }
  return false;
}
