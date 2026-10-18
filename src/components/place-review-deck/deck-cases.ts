"use client";

/**
 * The one-by-one review — the open location cases, read once per review and again after a settle.
 *
 * The Place checks page never reads them (it would cost every visit a full board read for a tab he may
 * never open), so the review asks for them the first time a tab needs them, through the board's own
 * loader behind `/api/admin/phoenix-crm/integrity/cases`.
 *
 * TWO LISTS, ON PURPOSE. `first` is the cases as the review first read them, and the tab is built from
 * it, so a case he settles keeps its slide and its place in "12 of 87". `latest` is the newest read, and
 * a slide is drawn from it, so a settled case shows as answered rather than as the case it no longer is.
 *
 * A module store read through `useSyncExternalStore`, the shape `photo.tsx` uses for its links, so a
 * read is started from an event or an effect without setting state inside the effect.
 */

import { useSyncExternalStore } from "react";

import { crmGet, messageOf } from "@/components/phoenix-crm/api";
import type { IntegrityCase } from "@/lib/phoenix-crm/server/integrity-board";

export const DECK_CASES_PATH = "/api/admin/phoenix-crm/integrity/cases";

export type DeckCasesState = {
  /** Which review the lists belong to — a new review starts from nothing. */
  session: string | null;
  status: "idle" | "loading" | "ready" | "failed";
  first: ReadonlyArray<IntegrityCase> | null;
  latest: ReadonlyArray<IntegrityCase>;
  canSettle: boolean;
  /** The board stopped at its ceiling; the tab says so rather than presenting a part as the whole. */
  capped: boolean;
  error: string | null;
};

const IDLE: DeckCasesState = { session: null, status: "idle", first: null, latest: [], canSettle: false, capped: false, error: null };

let current: DeckCasesState = IDLE;
const listeners = new Set<() => void>();

function publish(next: DeckCasesState): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read the cases for this review — again, when it already has them (after a settle). */
export function loadDeckCases(session: string): void {
  const base = current.session === session ? current : { ...IDLE, session };
  if (base.status === "loading") return;
  publish({ ...base, status: "loading", error: null });
  crmGet<{ cases: IntegrityCase[]; canSettle: boolean; capped: boolean }>(DECK_CASES_PATH, "board").then(
    (board) => {
      if (current.session !== session) return;
      publish({ session, status: "ready", first: current.first ?? board.cases, latest: board.cases, canSettle: board.canSettle, capped: board.capped, error: null });
    },
    (error: unknown) => {
      if (current.session !== session) return;
      publish({ ...current, status: "failed", error: messageOf(error) });
    },
  );
}

/** Read them once for this review; a review that already asked is left alone. */
export function ensureDeckCases(session: string): void {
  if (current.session !== session) loadDeckCases(session);
}

export function useDeckCases(session: string): DeckCasesState {
  const state = useSyncExternalStore(subscribe, () => current, () => IDLE);
  // Another review's lists are nothing to this one.
  return state.session === session ? state : IDLE;
}
