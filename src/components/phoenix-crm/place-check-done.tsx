"use client";

/**
 * Phoenix CRM — what happens once a decision on Place checks has been saved.
 *
 * On the board it is what every decision control did before this file existed: the page reads itself
 * again (`router.refresh()`), the decided row moves to where it now belongs, and nothing else. Since
 * 2026-11-01 that re-read waits until the decisions have paused, one for a whole run of them — see
 * `place-check-reread.ts` for what each one used to cost everybody else.
 *
 * Inside the one-by-one review (owner, 2026-10-18: "validate from this screen … then press next … like
 * sliding instead of opening") the same control is wrapped in a `PlaceCheckDoneProvider`, and the
 * provider is ALSO told which item was answered and how — so the review can show the outcome at once and
 * slide on to the next photograph by itself.
 *
 * 🔴 IT IS NOT A SECOND DECISION PATH. Every control still posts its own request to its own route and
 * calls this only after the server said yes; the hook decides nothing and sends nothing. A control used
 * outside any provider behaves exactly as it did before.
 *
 * 🔴 A SAVED DECISION RELEASES ITS BUTTON AT ONCE (owner, 2026-10-24: "when i press approve its staled
 * do approving and grey out to forever"). Every control used to keep "Approving…" until the page's own
 * re-read replaced the row — and the Place checks page is the heaviest read in the module, so a slow or
 * failed re-read left the button grey for good over a decision the database already held. A control now
 * marks its outcome with `useSavedOutcome` the moment the server said yes and draws `PlaceCheckSaved`
 * in place of its buttons, until the page's next reading of that row takes over.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { placeCheckReread } from "@/components/phoenix-crm/place-check-reread";
import { CrmPill, type PillTone } from "@/components/phoenix-crm/ui";
import { PLACE_APPROVED_NOT_A_LIST_ADD } from "@/lib/phoenix-crm/validation-feedback";

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

/** Call it after the server accepted a decision. It hands the outcome back, for `useSavedOutcome`. */
export function usePlaceCheckDone(): (outcome: PlaceCheckOutcome) => PlaceCheckOutcome {
  const router = useRouter();
  const scope = useContext(DoneContext);
  return useCallback(
    (outcome: PlaceCheckOutcome): PlaceCheckOutcome => {
      scope?.done(scope.item, outcome);
      placeCheckReread.ask(() => router.refresh());
      return outcome;
    },
    [router, scope],
  );
}

const SAVED_LABEL: Record<PlaceCheckOutcome, { text: string; tone: PillTone }> = {
  approved: { text: "Approved", tone: "good" },
  kept: { text: "Kept", tone: "good" },
  refused: { text: "Refused", tone: "warn" },
  rejected: { text: "Rejected", tone: "warn" },
  reopened: { text: "Reopened", tone: "neutral" },
  restored: { text: "Approved after all", tone: "good" },
  settled: { text: "Settled", tone: "good" },
};

/**
 * The outcome a control saved, held only while the page still shows the row as it was when the button
 * was pressed. `subject` is that row: once the page's re-read brings it back changed — decided, or
 * restorable, or refusable — the server's own view of the row is drawn again, so an undo offered on the
 * fresh row is never hidden behind this. A re-read that never comes leaves the saved outcome showing,
 * which is the truth: the database holds it.
 */
export function useSavedOutcome(subject: unknown): { saved: PlaceCheckOutcome | null; markSaved: (outcome: PlaceCheckOutcome) => void } {
  const snapshot = JSON.stringify(subject);
  const [mark, setMark] = useState<{ outcome: PlaceCheckOutcome; snapshot: string } | null>(null);
  const markSaved = useCallback((outcome: PlaceCheckOutcome) => setMark({ outcome, snapshot }), [snapshot]);
  return { saved: mark !== null && mark.snapshot === snapshot ? mark.outcome : null, markSaved };
}

/**
 * What a decision control draws once its decision is saved: the outcome, and no button to press twice.
 * An approval also says it confirmed the place only (owner, 2026-10-27) — never an add to the rep's list.
 */
export function PlaceCheckSaved({ outcome }: { outcome: PlaceCheckOutcome }) {
  const label = SAVED_LABEL[outcome];
  const approval = outcome === "approved" || outcome === "restored";
  return (
    <div className="min-w-0 space-y-1" role="status">
      <CrmPill tone={label.tone}>{label.text}</CrmPill>
      <p className="break-words text-xs text-slate-500">{approval ? `Saved. ${PLACE_APPROVED_NOT_A_LIST_ADD}` : "Saved."}</p>
    </div>
  );
}
