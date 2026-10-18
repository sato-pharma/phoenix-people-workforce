"use client";

/**
 * Phoenix CRM — what happens once a decision on Place checks has been saved.
 *
 * On the board it is exactly what every decision control did before this file existed: the page reads
 * itself again (`router.refresh()`), the decided row moves to where it now belongs, and nothing else.
 *
 * Inside the one-by-one review (owner, 2026-10-18: "validate from this screen … then press next … like
 * sliding instead of opening") the same control is wrapped in a `PlaceCheckDoneProvider`, and the
 * provider is ALSO told which item was answered and how — so the review can show the outcome at once and
 * slide on to the next photograph by itself.
 *
 * 🔴 IT IS NOT A SECOND DECISION PATH. Every control still posts its own request to its own route and
 * calls this only after the server said yes; the hook decides nothing and sends nothing. A control used
 * outside any provider behaves exactly as it did before.
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";

/** What a saved decision did, in the review's own words. */
export type PlaceCheckOutcome = "approved" | "rejected" | "refused" | "restored" | "kept" | "settled" | "reopened";

type DoneScope = {
  /** The item the control below answers: `review:…`, `place:…`, `venue:…`, `seat:…` or `case:…`. */
  item: string;
  done: (item: string, outcome: PlaceCheckOutcome) => void;
};

const DoneContext = createContext<DoneScope | null>(null);

/** The review's own provider: every control under it reports what it decided to `onDone`. */
export function PlaceCheckDoneProvider({
  children,
  item,
  onDone,
}: {
  children: ReactNode;
  item: string;
  onDone: (item: string, outcome: PlaceCheckOutcome) => void;
}) {
  const scope = useMemo<DoneScope>(() => ({ item, done: onDone }), [item, onDone]);
  return <DoneContext.Provider value={scope}>{children}</DoneContext.Provider>;
}

/**
 * One part of a slide that is answered on its own — a polyclinic's building, or one customer seated in
 * it. Reports to the provider above it, under its own item.
 */
export function PlaceCheckDoneItem({ children, item }: { children: ReactNode; item: string }) {
  const parent = useContext(DoneContext);
  const scope = useMemo<DoneScope | null>(() => (parent ? { item, done: parent.done } : null), [item, parent]);
  return <DoneContext.Provider value={scope}>{children}</DoneContext.Provider>;
}

/** Call it after the server accepted a decision. */
export function usePlaceCheckDone(): (outcome: PlaceCheckOutcome) => void {
  const router = useRouter();
  const scope = useContext(DoneContext);
  return useCallback(
    (outcome: PlaceCheckOutcome) => {
      scope?.done(scope.item, outcome);
      router.refresh();
    },
    [router, scope],
  );
}
