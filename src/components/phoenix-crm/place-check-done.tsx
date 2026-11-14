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
import { errorCodeOf } from "@/components/phoenix-crm/api";
import { CrmPill, type PillTone } from "@/components/phoenix-crm/ui";
import { PLACE_APPROVED_NOT_A_LIST_ADD } from "@/lib/phoenix-crm/validation-feedback";

/** What a saved decision did, in the review's own words. */
export type PlaceCheckOutcome =
  | "approved"
  | "waiting_building"
  | "rejected"
  | "refused"
  | "restored"
  | "kept"
  | "settled"
  | "reopened"
  | "already";

/**
 * What an approval did, from the server's own answer. 🔴 A CUSTOMER BEHIND A BUILDING STILL BEING CHECKED
 * IS APPROVED AND WAITS (owner, 14 Nov 2026): the review is settled, and he is counted only once his
 * building is approved. The control says so, instead of "Approved" over a customer still under To validate.
 */
export function approvalOutcome(answer: unknown, plain: "approved" | "restored"): PlaceCheckOutcome {
  const waiting = answer !== null && typeof answer === "object" && (answer as { waitingForBuilding?: unknown }).waitingForBuilding === true;
  return waiting ? "waiting_building" : plain;
}

/** Under an approval that waits for its building. */
export const APPROVED_WAITS_FOR_BUILDING = "Saved. The customer is counted once the building is approved.";

/**
 * What a bulk run did, in the words each row's own control says (owner, 14 Nov 2026: "fix the bulk approve
 * wording"). 🔴 The bar used to read only whether each request threw, so ticking twelve rows said nothing
 * about the three customers whose building was still being checked: those approvals settle the review and
 * the customer waits, exactly as one pressed alone. Each outcome is counted once, in the order it first came.
 */
export function bulkOutcomeSummary(outcomes: ReadonlyArray<PlaceCheckOutcome>): string {
  const counts = new Map<PlaceCheckOutcome, number>();
  for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  const said = [...counts].map(([outcome, count]) => `${SAVED_LABEL[outcome].text}: ${count}`).join(" · ");
  const waiting = counts.get("waiting_building") ?? 0;
  const notes = [
    counts.has("approved") || counts.has("restored") ? PLACE_APPROVED_NOT_A_LIST_ADD : "",
    waiting === 0 ? "" : waiting === 1 ? "The customer waiting is counted once the building is approved." : `The ${waiting} customers waiting are each counted once their building is approved.`,
  ].filter((note) => note !== "");
  return [`Saved. ${said}.`, ...notes].join(" ");
}

/**
 * 🔴 "ALREADY DECIDED" IS AN ANSWER, NOT AN ERROR (owner, 2026-11-08: "places checks is stale … many
 * error"). The SFE Manager met "This place was already decided. Reload the page." and "This name was
 * already decided" three times in one morning, each on a row the database had already settled — his own
 * earlier press, or another decider's. The decision he wanted is the one that stands, so the control
 * draws "Already decided" in place of its buttons and the page re-reads itself; nothing turns red.
 */
const ALREADY_DECIDED_CODES: ReadonlySet<string> = new Set([
  "phoenix_crm_review_decided",
  "phoenix_crm_review_not_found",
  "phoenix_crm_review_not_rejected",
  "phoenix_crm_full_name_not_held",
  "phoenix_crm_place_not_retired",
  "phoenix_crm_shared_place_not_retired",
  "phoenix_crm_shared_place_retired",
]);

export function isAlreadyDecided(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code !== null && ALREADY_DECIDED_CODES.has(code);
}

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
  waiting_building: { text: "Approved, waits for the building", tone: "good" },
  kept: { text: "Kept", tone: "good" },
  refused: { text: "Refused", tone: "warn" },
  rejected: { text: "Rejected", tone: "warn" },
  reopened: { text: "Reopened", tone: "neutral" },
  restored: { text: "Approved after all", tone: "good" },
  settled: { text: "Settled", tone: "good" },
  already: { text: "Already decided", tone: "neutral" },
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
  const [, redraw] = useState(0);
  const markSaved = useCallback(
    (outcome: PlaceCheckOutcome) => {
      rememberSaved(snapshot, outcome);
      redraw((count) => count + 1);
    },
    [snapshot],
  );
  const mark = SAVED_MARKS.get(snapshot) ?? null;
  return { saved: mark !== null && mark.snapshot === snapshot ? mark.outcome : null, markSaved };
}

/**
 * 🔴 THE SAVED MARK OUTLIVES THE CONTROL (owner, 2026-11-08: "places checks is stale"). It was component
 * state, so a list that remounted — a tab change, a filter, Show more, the one-by-one review closing —
 * forgot it, and the decided row stood there with live buttons until the page's re-read, up to 30 seconds
 * later: the next press answered "This place was already decided". Kept for the tab, keyed by the row as
 * it was pressed, every control drawing that same row reads it; the re-read's changed row no longer
 * matches, so the server's own view takes over exactly as before.
 */
const SAVED_MARKS = new Map<string, { outcome: PlaceCheckOutcome; snapshot: string }>();
const SAVED_MARKS_KEPT = 500;

function rememberSaved(snapshot: string, outcome: PlaceCheckOutcome) {
  SAVED_MARKS.delete(snapshot);
  SAVED_MARKS.set(snapshot, { outcome, snapshot });
  while (SAVED_MARKS.size > SAVED_MARKS_KEPT) {
    const oldest = SAVED_MARKS.keys().next().value;
    if (oldest === undefined) break;
    SAVED_MARKS.delete(oldest);
  }
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
      <p className="break-words text-xs text-slate-500">
        {approval
          ? `Saved. ${PLACE_APPROVED_NOT_A_LIST_ADD}`
          : outcome === "waiting_building"
            ? APPROVED_WAITS_FOR_BUILDING
            : outcome === "already"
              ? "This was decided already. The page updates itself."
              : "Saved."}
      </p>
    </div>
  );
}
