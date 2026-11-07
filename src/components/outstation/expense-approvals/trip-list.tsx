"use client";

import { AlertTriangle, CheckCircle2, ChevronDown, X, XCircle } from "lucide-react";
import { type ReactNode, useState } from "react";

import { formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import { expenseApprovalState, isAdjustedAmount } from "@/lib/outstation/approval-state";
import {
  type ExpenseApprovalSort,
  type ExpenseTripTriageFilter,
  expenseTripAwaitingLabel,
  expenseTripDaysAwaiting,
  expenseTripTriage,
  expenseTripTriageLabel,
} from "@/lib/outstation/expense-approval-triage";
import { isImportedHistoryTrip } from "@/lib/outstation/imported-history";
import { displayPlace } from "@/lib/outstation/place-label";
import { tripSpan } from "@/lib/outstation/trip-span";
import { cn } from "@/lib/utils";

import { type Decision, DuplicateTripFlag, type LoadedRecord, PANEL_CLASS, egp } from "./shared";

/**
 * The rail: every trip in the queue as one narrow list, the chosen one highlighted (owner,
 * 2026-11-07: "one trip fills the screen" — the list stays narrow on the left and the trip itself
 * is the page).
 *
 * Desktop: window-high and sticky, with its own vertical scroll, so the trip page can be as long
 * as its evidence while the list never leaves the screen; the decision block sits under the list
 * in the same box, so nothing is ever fixed over the trip on the right. Phone: one bar, "Trips · 163 awaiting",
 * that opens the list as a full-height sheet; choosing a trip closes it. The old page scrolled the
 * panel into view with `scrollIntoView` instead; the sheet needs no scrolling at all.
 */
export function TripList({
  activeList,
  allVisibleSelected,
  decisionFor,
  duplicateFlags,
  effectiveSelectedId,
  footer,
  loadError,
  loading,
  narrowed,
  onOpen,
  onRetry,
  onSort,
  onTriage,
  pendingCount,
  selectedTripIds,
  sessionExpired,
  sort,
  toggleAllVisible,
  toggleTrip,
  totalCount,
  triage,
  triageCounts,
}: {
  activeList: LoadedRecord[];
  allVisibleSelected: boolean;
  decisionFor: (record: LoadedRecord) => Decision;
  duplicateFlags: Map<string, string[]>;
  effectiveSelectedId: string | null;
  /**
   * The decision block, under the list in the same sticky box on a desktop (owner, 2026-11-07:
   * "put it in the left side, make the full right side for reviewing"). Hidden inside the phone
   * sheet, where the slim bottom row takes over.
   */
  footer?: ReactNode;
  loadError: string | null;
  loading: boolean;
  narrowed: boolean;
  onOpen: (tripId: string) => void;
  onRetry: () => void;
  onSort: (sort: ExpenseApprovalSort) => void;
  onTriage: (triage: ExpenseTripTriageFilter) => void;
  pendingCount: number;
  selectedTripIds: Set<string>;
  sessionExpired: boolean;
  sort: ExpenseApprovalSort;
  toggleAllVisible: () => void;
  toggleTrip: (tripId: string) => void;
  totalCount: number;
  /** "Needs a look" / "Clean" (owner, 2026-11-07). Empty = every trip. */
  triage: ExpenseTripTriageFilter;
  /** Trips AWAITING a decision under each choice, within the other filters and the search. */
  triageCounts: Record<"all" | "clean" | "look", number>;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  // Read once per mount: "awaiting N days" counts whole days, so a page left open for an hour
  // never needs to re-render to stay right.
  const [now] = useState(() => Date.now());
  const selected = activeList.find((record) => record.tripId === effectiveSelectedId) ?? null;

  const header = (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-slate-900 px-4 py-2.5">
      <span className="flex items-center gap-2">
        <span aria-hidden className="h-4 w-1 bg-orange-500" />
        <span className="text-phx-xs font-black uppercase tracking-wide text-white">Trips</span>
        {loading ? null : (
          // "109 awaiting · 185 of 632 trips": the awaiting figure is the SAME list the chosen
          // filter button counts, so the header and the buttons never show two different numbers
          // side by side (it used to read "632 of 632 shown" beside "163 awaiting").
          <span className="text-phx-xs font-bold text-slate-300" data-rail-count>
            <span className="text-white">{formatNumberValue(pendingCount)} awaiting</span> ·{" "}
            {formatNumberValue(activeList.length)} of {formatNumberValue(totalCount)} trips
          </span>
        )}
      </span>
      <button
        aria-label="Close the trip list"
        className="inline-flex items-center gap-1 text-phx-xs font-bold text-slate-300 hover:text-white lg:hidden"
        onClick={() => setSheetOpen(false)}
        type="button"
      >
        <X className="h-4 w-4" /> Close
      </button>
    </div>
  );

  // Owner, 2026-11-07 ~01:45: "Rail filter: Needs a look / Clean" and "Oldest first + awaiting
  // N days". Each choice says how many trips await a decision under it, so "Clean · 0" is read
  // before it is clicked. Square, flat, the same slate as the rail.
  const choiceClassName = (active: boolean) =>
    cn(
      "border px-2 py-1.5 text-center text-phx-xs font-bold leading-tight transition-colors",
      active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100",
    );
  const controls = (
    <div className="shrink-0 space-y-1.5 border-b border-slate-200 bg-white px-3 py-2" data-rail-controls>
      <div aria-label="Show trips" className="grid grid-cols-3 gap-1" role="group">
        {(["", "look", "clean"] as const).map((choice) => (
          <button
            aria-pressed={triage === choice}
            className={choiceClassName(triage === choice)}
            data-triage-choice={choice || "all"}
            key={choice || "all"}
            onClick={() => onTriage(choice)}
            type="button"
          >
            <span className="block break-words">{expenseTripTriageLabel(choice)}</span>
            <span className={cn("block text-phx-2xs tabular-nums", triage === choice ? "text-slate-300" : "text-slate-500")}>
              {formatNumberValue(triageCounts[choice || "all"])} awaiting
            </span>
          </button>
        ))}
      </div>
      <div aria-label="Order" className="grid grid-cols-2 gap-1" role="group">
        {([
          ["value", "Biggest first"],
          ["oldest", "Oldest first"],
        ] as const).map(([choice, label]) => (
          <button
            aria-pressed={sort === choice}
            className={choiceClassName(sort === choice)}
            data-sort-choice={choice}
            key={choice}
            onClick={() => onSort(choice)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    // `phx-expense-rail` (globals.css) pins the WHOLE aside under the frozen chrome on a desktop.
    // It must sit here, not on the box inside: the row holding the aside is as tall as the trip,
    // so the aside can travel; the box inside could not, the aside being exactly its height.
    <aside className="phx-expense-rail min-w-0 lg:w-[19rem] lg:shrink-0">
      {/* Phone: the bar that opens the sheet. It names the chosen trip, so the reviewer knows
          which page he is on without opening the list. */}
      <button
        className={cn(PANEL_CLASS, "flex w-full items-center justify-between gap-3 px-4 py-3 text-left lg:hidden")}
        onClick={() => setSheetOpen(true)}
        type="button"
      >
        <span className="min-w-0">
          <span className="block text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
            Trips · {formatNumberValue(pendingCount)} awaiting
          </span>
          <span className="block break-words text-sm font-bold text-slate-900">
            {selected ? selected.specialist || "Unassigned" : "Choose a trip"}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />
      </button>

      <div
        className={cn(
          PANEL_CLASS,
          "flex-col",
          // The phone sheet: fixed over the page, full height, no portal. At `lg` the same box is
          // the sticky rail; the sheet state is simply ignored.
          sheetOpen ? "fixed inset-0 z-40 flex" : "hidden",
          "phx-expense-rail-box lg:z-auto lg:flex",
        )}
      >
        {header}
        {loading ? null : controls}
        {loading ? (
          <div aria-busy="true" className="divide-y divide-slate-200">
            <p className="sr-only">Loading trips…</p>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div className="flex items-start justify-between gap-3 px-4 py-3" key={index}>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-3.5 w-2/3 animate-pulse bg-slate-200" />
                  <div className="h-3 w-1/2 animate-pulse bg-slate-100" />
                  <div className="h-2.5 w-1/3 animate-pulse bg-slate-100" />
                </div>
                <div className="h-3.5 w-20 animate-pulse bg-slate-200" />
              </div>
            ))}
          </div>
        ) : loadError ? (
          // An expired session gets a sign-in, not a Retry — retrying just fails again, and
          // calling it a permissions problem sends the reviewer hunting through roles.
          sessionExpired ? (
            <div className="flex flex-wrap items-center gap-2 bg-amber-50 px-4 py-6 text-sm font-semibold text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Your session has expired.
              <a className="font-bold underline hover:text-amber-950" href="/login">
                Sign in again
              </a>
            </div>
          ) : (
            <div className="bg-rose-50 px-4 py-6 text-sm text-rose-700">
              {loadError}
              <button className="ml-2 font-bold underline" onClick={onRetry} type="button">
                Retry
              </button>
            </div>
          )
        ) : activeList.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            {/* An empty list because of a filter is a different fact from an empty queue —
                "nothing waiting" while a month is selected reads as "this month is done". */}
            {narrowed ? "No trips match these filters." : "No trips in the queue yet."}
          </p>
        ) : (
          <>
            {/* Scoped to the PENDING rows, not to everything on screen: "select all" over 400
                trips would tick hundreds already decided, which planBulkApproval refuses. */}
            {pendingCount > 0 ? (
              <label className="flex shrink-0 cursor-pointer items-center gap-2.5 border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-xs font-black uppercase tracking-wide text-slate-600 transition-colors hover:bg-slate-100">
                <input
                  checked={allVisibleSelected}
                  className="h-4 w-4 shrink-0 accent-orange-500"
                  onChange={toggleAllVisible}
                  type="checkbox"
                />
                Select all {formatNumberValue(pendingCount)} awaiting
              </label>
            ) : null}
            <div className="min-h-[6rem] flex-1 divide-y divide-slate-200 overflow-y-auto">
              {activeList.map((record) => {
                const decision = decisionFor(record);
                const adjusted = isAdjustedAmount(decision.approvedAmount, record.total);
                // Compare against the EFFECTIVE selection, not the raw click state — otherwise the
                // trip already open on first load is highlighted nowhere.
                const isSelected = record.tripId === effectiveSelectedId;
                const isTicked = selectedTripIds.has(record.tripId);
                const state = expenseApprovalState(decision);
                const span = tripSpan(record.date, record.toDate);
                const place = record.location || record.to || "";
                // Only a trip still waiting on a decision carries its reasons and its wait: a
                // decided row already says what happened in its own chip.
                const awaiting = state === "pending" && !isImportedHistoryTrip(record.date);
                const reading = awaiting ? expenseTripTriage(record) : null;
                const daysAwaiting = awaiting ? expenseTripDaysAwaiting(record.submittedAt, now) : null;
                return (
                  // A row is a div, not a button: a checkbox nested inside a button is invalid
                  // HTML and the browser swallows one of the two clicks.
                  <div
                    className={cn(
                      "group flex w-full items-stretch transition-colors",
                      isSelected ? "bg-orange-50" : isTicked ? "bg-orange-50/50" : "bg-white hover:bg-slate-50",
                    )}
                    data-trip-id={record.tripId}
                    key={record.tripId}
                  >
                    {/* Decision state, readable in one glance without reading a word. */}
                    <span
                      aria-hidden
                      className={cn(
                        "w-[3px] shrink-0",
                        state === "approved"
                          ? "bg-emerald-500"
                          : state === "rejected"
                            ? "bg-rose-500"
                            : isSelected
                              ? "bg-orange-500"
                              : "bg-slate-200 group-hover:bg-orange-400",
                      )}
                    />
                    {/* Only an undecided trip carries a tick box — the bulk action can approve
                        nothing else. Reversing a decision brings the box back. */}
                    {state === "pending" && !isImportedHistoryTrip(record.date) ? (
                      <label className="flex shrink-0 cursor-pointer items-center pl-3">
                        <input
                          aria-label={`Select ${record.specialist || "Unassigned"} ${record.tripId}`}
                          checked={isTicked}
                          className="h-4 w-4 accent-orange-500"
                          onChange={() => toggleTrip(record.tripId)}
                          type="checkbox"
                        />
                      </label>
                    ) : null}
                    <button
                      aria-current={isSelected ? "true" : undefined}
                      className="flex min-w-0 flex-1 items-start justify-between gap-3 py-2.5 pl-3 pr-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-orange-500"
                      onClick={() => {
                        onOpen(record.tripId);
                        setSheetOpen(false);
                      }}
                      type="button"
                    >
                      {/* Wraps, never an ellipsis (AGENTS.md §4). The dates and the trip's length
                          on one line, the place in plain words under it. */}
                      <div className="min-w-0">
                        <p className="break-words text-sm font-bold leading-tight text-slate-900">
                          {record.specialist || "Unassigned"}
                        </p>
                        <p className="mt-0.5 text-phx-xs text-slate-600">
                          {formatDateValue(record.date, null, { weekday: "short", year: undefined })}
                          {span.multiDay ? (
                            <>
                              {" → "}
                              {formatDateValue(record.toDate, null, { weekday: "short", year: undefined })}
                              <span className="font-black text-orange-700"> · {formatNumberValue(span.days)} days</span>
                            </>
                          ) : null}
                        </p>
                        <p className="break-words text-phx-xs text-slate-500" dir="auto" title={place || undefined}>
                          {displayPlace(place)}
                        </p>
                        {reading?.triage === "look" ? (
                          <p className="mt-0.5 flex items-start gap-1 text-phx-2xs font-black uppercase tracking-wide text-rose-600" data-triage-reasons>
                            <AlertTriangle aria-hidden className="mt-px h-3 w-3 shrink-0" />
                            <span className="min-w-0 break-words">{reading.reasons.join(" · ")}</span>
                          </p>
                        ) : null}
                        {daysAwaiting !== null ? (
                          <p
                            className={cn("text-phx-2xs font-bold", daysAwaiting >= 7 ? "text-orange-700" : "text-slate-500")}
                            data-days-awaiting={daysAwaiting}
                          >
                            {expenseTripAwaitingLabel(daysAwaiting)}
                          </p>
                        ) : null}
                        {/* No employee note here (owner, 2026-11-07: "comment already written in the
                            right panel, remove from here"): it is printed once, on the trip page. */}
                        <DuplicateTripFlag copies={duplicateFlags.get(record.tripId)} />
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-mono text-sm font-bold tabular-nums text-slate-900">{egp(decision.approvedAmount)}</p>
                        {adjusted ? (
                          <p className="font-mono text-phx-2xs text-orange-600 line-through">{egp(record.total)}</p>
                        ) : null}
                        {state === "approved" ? (
                          <span className="mt-0.5 inline-flex items-center gap-1 text-phx-2xs font-black uppercase tracking-wide text-emerald-600">
                            <CheckCircle2 className="h-3 w-3" /> Approved
                          </span>
                        ) : state === "rejected" ? (
                          <span className="mt-0.5 inline-flex items-center gap-1 text-phx-2xs font-black uppercase tracking-wide text-rose-600">
                            <XCircle className="h-3 w-3" /> Rejected
                          </span>
                        ) : null}
                        {isImportedHistoryTrip(record.date) ? (
                          <span className="mt-0.5 block text-phx-2xs font-black uppercase tracking-wide text-slate-400">
                            Imported
                          </span>
                        ) : null}
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {footer ? <div className="phx-expense-rail-footer hidden shrink-0 lg:block">{footer}</div> : null}
      </div>
    </aside>
  );
}
