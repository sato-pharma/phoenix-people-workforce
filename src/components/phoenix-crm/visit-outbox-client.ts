"use client";

/**
 * Phoenix CRM — the browser's half of the visit retry: the hook the screens read, the press the form
 * keeps, and the report of how a held visit ended. The rules are in `visit-resend-rules.ts`, and the storage
 * and the sending pass in `visit-outbox.ts`.
 */

import { useMemo, useSyncExternalStore } from "react";

import { browserLocalStorage, ownerScopedStorageKey, VISIT_OUTBOX_CHANGED_EVENT, VISIT_OUTBOX_KEY_BASE } from "@/lib/browser-storage/owner-scoped";
import { forgetQueuedVisit, keepQueuedVisit, readQueuedVisits } from "@/lib/phoenix-crm/visit-outbox";
import { VISIT_RESEND_IN_FLIGHT_MS, queuedSecondsAt, type QueuedVisit, type VisitResendOutcome } from "@/lib/phoenix-crm/visit-resend-rules";

export const VISIT_RESEND_REPORT_PATH = "/api/phoenix-crm/visit-resend-report";

export function notifyVisitOutboxChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(VISIT_OUTBOX_CHANGED_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(VISIT_OUTBOX_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(VISIT_OUTBOX_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** One person's held visits, live. Nothing held, or no person, is an empty list and costs one storage read. */
export function useHeldVisits(ownerHrId: string | null): QueuedVisit[] {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      const key = ownerScopedStorageKey(VISIT_OUTBOX_KEY_BASE, ownerHrId);
      try {
        return key ? (browserLocalStorage()?.getItem(key) ?? null) : null;
      } catch {
        return null;
      }
    },
    () => null,
  );
  // `raw` is what tells it to read again: the parsed list is stable until the stored text changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (raw === null ? [] : readQueuedVisits(browserLocalStorage(), ownerHrId)), [raw, ownerHrId]);
}

/**
 * The press, written BEFORE the request goes, so it survives a reload, a dead battery or a browser that kills
 * the page in flight. False means it was not kept, and the form then behaves as it did before this queue.
 */
export function holdVisitPress(input: {
  ownerHrId: string;
  visitId: string;
  seatId: string;
  customerId: string;
  customerName: string;
  pressedDay: string;
  pressedAtMs: number;
  body: Record<string, unknown>;
}): boolean {
  return keepQueuedVisit(browserLocalStorage(), input.ownerHrId, {
    ...input,
    // Marked in flight, so a pass that wakes this very moment leaves the form's own request alone.
    sendingUntilMs: input.pressedAtMs + VISIT_RESEND_IN_FLIGHT_MS,
    attempts: 1,
    status: "waiting",
    refusalCode: null,
    refusalMessage: null,
  });
}

/** The form's own request found no signal: the entry is free for the next pass to send. */
export function leaveVisitWaiting(ownerHrId: string, visitId: string): void {
  const storage = browserLocalStorage();
  const entry = readQueuedVisits(storage, ownerHrId).find((held) => held.visitId === visitId);
  if (entry) keepQueuedVisit(storage, ownerHrId, { ...entry, sendingUntilMs: 0 });
  notifyVisitOutboxChanged();
}

export function restoreHeldVisit(ownerHrId: string, entry: QueuedVisit): void {
  keepQueuedVisit(browserLocalStorage(), ownerHrId, entry);
  notifyVisitOutboxChanged();
}

export function forgetHeldVisit(ownerHrId: string, visitId: string): void {
  forgetQueuedVisit(browserLocalStorage(), ownerHrId, visitId);
  notifyVisitOutboxChanged();
}

/**
 * Files how a held visit ended. Fire and forget: the route answers 204 whatever it does with it, and a report
 * lost to a dropped signal costs one row of a count, never the rep anything.
 */
export function reportVisitResend(entry: QueuedVisit, outcome: VisitResendOutcome, queuedSeconds: number | null = queuedSecondsAt(entry, Date.now())): void {
  if (typeof fetch !== "function") return;
  void fetch(VISIT_RESEND_REPORT_PATH, {
    body: JSON.stringify({
      visitId: entry.visitId,
      seatId: entry.seatId,
      customerId: entry.customerId,
      pressedAtDevice: new Date(entry.pressedAtMs).toISOString(),
      outcome,
      refusalCode: entry.refusalCode,
      queuedSeconds,
      attempts: entry.attempts,
    }),
    headers: { "content-type": "application/json" },
    keepalive: true,
    method: "POST",
  }).catch(() => undefined);
}
