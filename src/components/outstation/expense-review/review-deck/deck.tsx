"use client";

import { ArrowLeft, ArrowRight, CheckCircle2, Undo2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ClaimValidationOutcome } from "@/components/outstation/expense-claim-validation-panel";
import type { AttachmentsData } from "@/components/outstation/trip-attachments";
import type { DayOrder, TripWorkloadEvidence } from "@/components/outstation/trip-workload-evidence";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { CrmButton } from "@/components/phoenix-crm/ui";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { useHydrated } from "@/hooks/use-hydrated";
import { formatNumberValue } from "@/lib/i18n/format";
import { expenseApprovalState } from "@/lib/outstation/approval-state";
import { isImportedHistoryTrip } from "@/lib/outstation/imported-history";
import { deckArrowStep } from "@/lib/place-review-deck/slides";
import { cn } from "@/lib/utils";

import { type LoadedRecord, REVIEW_TAB_LABELS, type TripTab, isUnsaved, positionIn } from "../review-model";
import { egp } from "../review-parts";
import { DECK_TABS, type ExpenseReview } from "../use-expense-review";
import { DeckAdjust, DeckDecisionBar } from "./deck-decision";
import { DeckFound } from "./deck-found";
import { type Signal, tripSignals } from "./deck-signals";
import { DeckStage, type StageView } from "./deck-stage";
import { DeckSubject } from "./deck-subject";

/** The last decision made in the reviewer, shown on the trip it moved on to, so it can be undone there. */
type LastDecision = { amount: number; name: string; tripId: string; verb: "Approved" | "Rejected" };

/** Another modal over the reviewer — the zoomed photo — owns the keyboard while it is open. */
function otherDialogOpen(): boolean {
  return document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1;
}

function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.getAttribute("role") === "combobox") return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/**
 * "Review one by one" — the Place checks reviewer, for expense claims (owner, 2026-11-07: "retire the
 * current expense approval and rebuild from scratch, same Phoenix CRM identity").
 *
 * The whole screen, on black: the orange kicker and the title, "N of M", the tabs with their counts, a
 * square close, a 1px orange progress line. Under it the evidence fills the dark stage on the left and
 * the white column on the right holds who and what, what the system found, the reviewer's decision,
 * and — pinned at its foot on a wide screen — Approve / Reject and Save, then Back / Next.
 *
 * The walk is frozen when it opens (use-expense-review.ts), so a decided trip keeps its place and Back
 * returns to it. Approve and Reject move on to the next trip still waiting; ← and → move one trip
 * either way; Esc closes. 🔴 NO KEY DECIDES ANYTHING — a key pressed by mistake must cost nothing, and
 * every decision is a draft until Save.
 */
export function ExpenseReviewDeck({ review }: { review: ExpenseReview }) {
  const hydrated = useHydrated();
  const titleId = useId();
  const { closeDeck, deck, moveDeck } = review;
  const [lastDecision, setLastDecision] = useState<LastDecision | null>(null);
  const [now] = useState(() => Date.now());
  // Trips whose idle-day pre-cut was set aside ("Keep full claim", or a figure typed in) while the
  // reviewer is open. Screen state only: nothing is written for a trip until Approve and Save.
  const [keptFull, setKeptFull] = useState<Record<string, true>>({});
  // Map first or data first: chosen once, kept from trip to trip while the reviewer is open.
  const [dayOrder, setDayOrder] = useState<DayOrder>("map-first");
  const keepFull = useCallback((tripId: string) => setKeptFull((current) => (current[tripId] ? current : { ...current, [tripId]: true })), []);

  const close = useCallback(() => {
    // The zoomed photo answers Escape first; the reviewer closes only when nothing is open over it.
    if (otherDialogOpen()) return;
    closeDeck();
  }, [closeDeck]);
  const dialogRef = useDialogA11y<HTMLDivElement>({ open: hydrated && deck !== null, onClose: close });

  const move = useCallback(
    (step: -1 | 1) => {
      setLastDecision(null);
      moveDeck(step);
    },
    [moveDeck],
  );

  // ← and → between trips; never while typing, never with the zoom open, never a decision.
  useEffect(() => {
    if (!deck) return;
    function onKey(event: KeyboardEvent) {
      const step = deckArrowStep({
        key: event.key,
        modifier: event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
        otherDialogOpen: otherDialogOpen(),
        typing: typingIn(event.target),
      });
      if (step === 0) return;
      event.preventDefault();
      move(step);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deck, move]);

  if (!hydrated || !deck) return null;

  const total = review.deckRows.length;
  const at = positionIn(review.deckRows, deck.open);
  const shown = at ? at.index : total;
  const progress = total === 0 ? 0 : Math.round((shown / total) * 100);
  const record = review.selected;

  // `paid` is what Approve pays — the pre-cut figure when one was applied in the same click, which the
  // decision on screen does not hold yet.
  const decide = (verb: LastDecision["verb"], paid?: number) => {
    if (!record) return;
    const decision = review.decisionFor(record);
    setLastDecision({ amount: paid ?? decision.approvedAmount, name: record.specialist || record.tripId, tripId: record.tripId, verb });
    if (verb === "Approved") review.decisionHandlers.onApprove();
    else review.decisionHandlers.onReject();
  };

  const body = (() => {
    if (total === 0) {
      return (
        <DeckMessage
          lines={[deck.tab === "employee" ? "This employee has no trips with the filters as they are." : `Nothing is in ${REVIEW_TAB_LABELS[deck.tab]} with the filters as they are.`]}
          title="Nothing here"
        >
          <OtherTabs counts={review.tabCounts} current={deck.tab} onChoose={review.chooseDeckTab} />
        </DeckMessage>
      );
    }
    if (!record) {
      return <DeckDone onBack={() => move(-1)} onChoose={review.chooseDeckTab} onClose={closeDeck} review={review} />;
    }
    return (
      <DeckTrip
        key={record.tripId}
        keptFull={keptFull}
        lastDecision={lastDecision && lastDecision.tripId !== record.tripId ? lastDecision : null}
        now={now}
        dayOrder={dayOrder}
        onApprove={(paid) => decide("Approved", paid)}
        onDayOrder={setDayOrder}
        onKeepFull={keepFull}
        onMove={move}
        onReject={() => decide("Rejected")}
        onUndoLast={(tripId) => {
          review.undoDecision(tripId);
          setLastDecision(null);
          review.openTripInDeck(tripId);
        }}
        position={shown}
        record={record}
        review={review}
        total={total}
      />
    );
  })();

  return createPortal(
    <CrmSurfaceProvider surface="admin">
      <div aria-labelledby={titleId} aria-modal="true" className="fixed inset-0 z-[200] flex flex-col bg-slate-950 text-white" data-expense-deck ref={dialogRef} role="dialog">
        <header className="min-w-0 border-b border-white/10 bg-slate-950">
          <div className="flex min-w-0 items-center gap-3 px-4 pt-3 lg:px-6">
            <div className="min-w-0 flex-1">
              <p className="break-words text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-400">Expense approvals</p>
              <h2 className="break-words text-base font-black text-white lg:text-lg" id={titleId}>
                Review one by one
              </h2>
            </div>
            {review.dirtyCount > 0 ? (
              <CrmButton busy={review.saving} className="hidden sm:inline-flex" onClick={() => void review.save()} size="sm" variant="primary">
                Save {formatNumberValue(review.dirtyCount)}
              </CrmButton>
            ) : null}
            {total > 0 ? (
              <p className="shrink-0 text-sm font-black tabular-nums text-white" data-deck-position>
                {formatNumberValue(shown)} <span className="font-semibold text-slate-400">of {formatNumberValue(total)}</span>
              </p>
            ) : null}
            <button
              aria-label="Close the review"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center border border-white/15 text-white transition hover:bg-white/10"
              onClick={close}
              type="button"
            >
              <X aria-hidden className="h-5 w-5" />
            </button>
          </div>
          <div aria-label="What to review" className="flex min-w-0 flex-wrap px-4 pt-2 lg:px-6" role="tablist">
            {DECK_TABS.filter((one) => one === deck.tab || review.tabCounts[one] > 0).map((one) => (
              <button
                aria-selected={deck.tab === one}
                className={cn(
                  "-mb-px inline-flex min-h-11 min-w-0 items-center gap-2 border-b-2 px-3 py-2 text-left text-sm font-black transition",
                  deck.tab === one ? "border-orange-500 text-white" : "border-transparent text-slate-400 hover:text-slate-200",
                )}
                data-deck-tab={one}
                key={one}
                onClick={() => {
                  setLastDecision(null);
                  review.chooseDeckTab(one);
                }}
                role="tab"
                type="button"
              >
                <span className="break-words">{REVIEW_TAB_LABELS[one]}</span>
                <span className={cn("px-1.5 py-0.5 text-phx-2xs tabular-nums", deck.tab === one ? "bg-orange-500 text-white" : "bg-white/10 text-slate-300")}>
                  {formatNumberValue(review.tabCounts[one])}
                </span>
              </button>
            ))}
            {deck.tab === "employee" ? (
              <span aria-selected className="-mb-px inline-flex min-h-11 min-w-0 items-center gap-2 border-b-2 border-orange-500 px-3 py-2 text-sm font-black text-white" role="tab">
                <span className="break-words">{record ? record.specialist || "One employee" : "One employee"}</span>
                <span className="bg-orange-500 px-1.5 py-0.5 text-phx-2xs tabular-nums text-white">{formatNumberValue(total)}</span>
              </span>
            ) : null}
          </div>
          <div aria-hidden className="h-1 bg-white/10">
            <div className="h-full bg-orange-500 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${progress}%` }} />
          </div>
        </header>
        {body}
      </div>
    </CrmSurfaceProvider>,
    document.body,
  );
}

/**
 * One trip in the reviewer. Keyed by the trip, so its evidence and its stage view start fresh each time
 * — the three evidence panels read once when it mounts, and the column words its findings from them.
 */
function DeckTrip({
  dayOrder,
  keptFull,
  lastDecision,
  now,
  onApprove,
  onDayOrder,
  onKeepFull,
  onMove,
  onReject,
  onUndoLast,
  position,
  record,
  review,
  total,
}: {
  dayOrder: DayOrder;
  keptFull: Readonly<Record<string, true>>;
  lastDecision: LastDecision | null;
  now: number;
  onApprove: (paid: number) => void;
  onDayOrder: (order: DayOrder) => void;
  onKeepFull: (tripId: string) => void;
  onMove: (step: -1 | 1) => void;
  onReject: () => void;
  onUndoLast: (tripId: string) => void;
  position: number;
  record: LoadedRecord;
  review: ExpenseReview;
  total: number;
}) {
  // `undefined` is "still loading"; null is "nothing came back".
  const [workload, setWorkload] = useState<TripWorkloadEvidence | null | undefined>(undefined);
  const [attachments, setAttachments] = useState<AttachmentsData | null | undefined>(undefined);
  const [claimOutcome, setClaimOutcome] = useState<ClaimValidationOutcome | undefined>(undefined);
  // Phoenix CRM on this trip — the sentence its section words from the reading (crm-trip-section.tsx).
  const [crm, setCrm] = useState<Signal>({ line: "Reading Phoenix CRM", tone: "loading" });
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const decision = review.decisionFor(record);
  const valuesOnly = isImportedHistoryTrip(record.date);
  const signals = useMemo(() => tripSignals({ attachments, claimOutcome, crm, record, workload }), [attachments, claimOutcome, crm, record, workload]);
  // The stage opens on the field work — the day maps, and where the idle days the decision offers a
  // share for come from. The findings beside it switch to the photos or the checks in one click.
  const [view, setView] = useState<StageView>("field");
  const duplicateOf = review.duplicateFlags.get(record.tripId);
  const idle = review.idleByTrip[record.tripId] ?? null;
  const unsaved = isUnsaved(record, review.decisions);
  const { decisionHandlers } = review;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto lg:flex lg:overflow-hidden" data-deck-trip={record.tripId}>
      <section aria-label="The evidence" className="relative h-[55svh] min-h-0 min-w-0 bg-slate-950 lg:h-auto lg:flex-1">
        <DeckStage
          attachments={attachments}
          dayOrder={dayOrder}
          onAttachments={setAttachments}
          onDayOrder={onDayOrder}
          onClaimOutcome={setClaimOutcome}
          onCrmSignal={setCrm}
          onIdleDays={review.recordIdleDays}
          onView={setView}
          onWorkload={setWorkload}
          record={record}
          signals={signals}
          view={view}
          workload={workload}
        />
      </section>
      <aside aria-label="Everything to decide on" className="flex min-w-0 flex-col bg-white text-slate-900 lg:min-h-0 lg:w-[460px] lg:flex-none xl:w-[500px]">
        <div className="min-w-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto" data-deck-column>
          {lastDecision ? (
            <div
              className={cn(
                "flex min-w-0 flex-wrap items-center gap-2 border-b px-5 py-3",
                lastDecision.verb === "Approved" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900",
              )}
              data-last-decision
              role="status"
            >
              <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0" />
              <p className="min-w-0 flex-1 break-words text-sm font-black">
                {lastDecision.verb} · <bdi dir="auto">{lastDecision.name}</bdi>
                {lastDecision.verb === "Approved" ? <span className="tabular-nums"> · {egp(lastDecision.amount)}</span> : null}
                <span className="font-semibold"> — a draft until you save</span>
              </p>
              <CrmButton onClick={() => onUndoLast(lastDecision.tripId)} size="sm" variant="ghost">
                <Undo2 aria-hidden className="h-3.5 w-3.5" /> Undo
              </CrmButton>
            </div>
          ) : null}
          <DeckSubject decision={decision} duplicateOf={duplicateOf} record={record} unsaved={unsaved} valuesOnly={valuesOnly} />
          <DeckFound decision={decision} now={now} onView={setView} record={record} signals={signals} view={view} />
          <DeckAdjust
            canDecide={review.canDecide}
            decision={decision}
            duplicateOf={duplicateOf}
            idle={idle}
            keptFull={keptFull}
            onChangeAmount={decisionHandlers.onChangeAmount}
            onChangeReason={decisionHandlers.onChangeReason}
            onKeepFull={onKeepFull}
            reasonRef={reasonRef}
            record={record}
            valuesOnly={valuesOnly}
          />
        </div>
        {/* On a wide screen the decision is pinned under the facts, as on Place checks; on a phone it
            follows them and only Back / Next is pinned. */}
        <div className="min-w-0 border-t border-slate-200 bg-white lg:shadow-[0_-10px_30px_-12px_rgba(15,23,42,0.25)]">
          <div className="min-w-0 px-5 py-3 lg:max-h-[45vh] lg:overflow-y-auto">
            <DeckDecisionBar
              canDecide={review.canDecide}
              decision={decision}
              dirtyCount={review.dirtyCount}
              idle={idle}
              keptFull={keptFull}
              onApprove={onApprove}
              onChangeAmount={decisionHandlers.onChangeAmount}
              onChangeReason={decisionHandlers.onChangeReason}
              onReject={onReject}
              onSave={decisionHandlers.onSave}
              onUnapprove={decisionHandlers.onUnapprove}
              onUnreject={decisionHandlers.onUnreject}
              reasonRef={reasonRef}
              record={record}
              saving={review.saving}
              valuesOnly={valuesOnly}
            />
          </div>
        </div>
        <nav
          aria-label="Move between trips"
          className="sticky bottom-0 z-10 flex min-w-0 items-center gap-2 border-t border-slate-200 bg-slate-50 px-5 py-2.5 shadow-[0_-10px_30px_-12px_rgba(15,23,42,0.25)] lg:static lg:shadow-none"
        >
          <CrmButton aria-keyshortcuts="ArrowLeft" disabled={position <= 1} onClick={() => onMove(-1)} size="sm">
            <ArrowLeft aria-hidden className="h-4 w-4" />
            Back
          </CrmButton>
          <p className="min-w-0 flex-1 break-words text-center text-xs font-black tabular-nums text-slate-500">
            {formatNumberValue(position)} of {formatNumberValue(total)}
            {expenseApprovalState(decision) === "pending" && !valuesOnly ? " · waiting" : ""}
          </p>
          <CrmButton aria-keyshortcuts="ArrowRight" onClick={() => onMove(1)} size="sm" variant="primary">
            Next
            <ArrowRight aria-hidden className="h-4 w-4" />
          </CrmButton>
        </nav>
      </aside>
    </div>
  );
}

/**
 * Past the last trip: what this walk decided, Save if anything is unsaved, the other tabs with what they
 * hold, and Back to the last trip.
 */
function DeckDone({
  onBack,
  onChoose,
  onClose,
  review,
}: {
  onBack: () => void;
  onChoose: (tab: TripTab) => void;
  onClose: () => void;
  review: ExpenseReview;
}) {
  const { deck, deckRows } = review;
  const walked = deckRows.map((record) => expenseApprovalState(review.decisionFor(record)));
  const approved = walked.filter((state) => state === "approved").length;
  const rejected = walked.filter((state) => state === "rejected").length;
  const waiting = deckRows.filter((record, index) => walked[index] === "pending" && !isImportedHistoryTrip(record.date)).length;
  const label = deck && deck.tab !== "employee" ? REVIEW_TAB_LABELS[deck.tab] : "this employee's trips";
  return (
    <DeckMessage lines={[`You have been through all ${formatNumberValue(deckRows.length)} in ${label}.`]} title="Done">
      <ul className="flex min-w-0 flex-wrap justify-center gap-2" data-deck-summary>
        {(
          [
            [approved, "approved"],
            [rejected, "rejected"],
            [waiting, "still waiting"],
          ] as const
        ).map(([count, words]) => (
          <li className="border border-white/15 px-3 py-1.5 text-sm font-black tabular-nums text-white" key={words}>
            {formatNumberValue(count)} <span className="font-semibold text-slate-300">{words}</span>
          </li>
        ))}
      </ul>
      {review.dirtyCount > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center justify-center gap-3">
          <p className="text-sm font-bold text-orange-300">{formatNumberValue(review.dirtyCount)} decisions are not saved yet.</p>
          <CrmButton busy={review.saving} onClick={() => void review.save()} variant="primary">
            Save {formatNumberValue(review.dirtyCount)}
          </CrmButton>
        </div>
      ) : null}
      {deck ? <OtherTabs counts={review.tabCounts} current={deck.tab} onChoose={onChoose} /> : null}
      <div className="flex min-w-0 flex-wrap justify-center gap-2">
        <CrmButton onClick={onBack}>Back to the last one</CrmButton>
        <CrmButton onClick={onClose} variant="secondary">
          Close the review
        </CrmButton>
      </div>
    </DeckMessage>
  );
}

/** A whole-screen message: a tab with nothing in it, or a walk finished. */
function DeckMessage({ children, lines, title }: { children?: ReactNode; lines: ReadonlyArray<string>; title: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-10 text-center">
      <p className="max-w-xl break-words text-2xl font-black text-white">{title}</p>
      {lines.map((line) => (
        <p className="max-w-xl break-words text-sm text-slate-400" key={line}>
          {line}
        </p>
      ))}
      {children}
    </div>
  );
}

/** The other tabs, each with what it holds, from the panel that closes one. */
function OtherTabs({ counts, current, onChoose }: { counts: Record<TripTab, number>; current: TripTab | "employee"; onChoose: (tab: TripTab) => void }) {
  return (
    <div className="flex min-w-0 flex-wrap justify-center gap-2">
      {DECK_TABS.filter((one) => one !== current && counts[one] > 0).map((one) => (
        <CrmButton key={one} onClick={() => onChoose(one)} size="sm">
          {REVIEW_TAB_LABELS[one]} ({formatNumberValue(counts[one])})
        </CrmButton>
      ))}
    </div>
  );
}
