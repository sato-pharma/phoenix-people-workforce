"use client";

import { AlertTriangle, ArrowRight, Check, Eye, ShieldCheck, Undo2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmLoadError,
  CrmLoading,
  CrmPill,
  CrmShowMore,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import { expenseApprovalState } from "@/lib/outstation/approval-state";
import { expenseTripAwaitingLabel, expenseTripDaysAwaiting, expenseTripTriage } from "@/lib/outstation/expense-approval-triage";
import { isImportedHistoryTrip } from "@/lib/outstation/imported-history";
import { displayPlace } from "@/lib/outstation/place-label";
import { tripSpan } from "@/lib/outstation/trip-span";
import { cn } from "@/lib/utils";

import {
  type Decision,
  type LoadedRecord,
  REVIEW_TAB_DESCRIPTIONS,
  REVIEW_TAB_LABELS,
  type TripTab,
  distanceFlag,
  rowApproveBlock,
} from "./review-model";
import { DecisionPill, DistanceChip, DuplicateTripFlag, MoneyFigure } from "./review-parts";

/** Rows drawn at a time; "Show 20 more" under the list reaches the rest (Place checks pages the same way). */
const PAGE_ROWS = 20;

const STATE_ACCENT: Record<ReturnType<typeof expenseApprovalState>, string> = {
  approved: "border-l-emerald-500",
  pending: "border-l-orange-400",
  rejected: "border-l-rose-500",
};

type RowActions = {
  canDecide: boolean;
  decisionFor: (record: LoadedRecord) => Decision;
  duplicateFlags: Map<string, string[]>;
  isUnsaved: (record: LoadedRecord) => boolean;
  now: number;
  onOpen: (tripId: string) => void;
  onQuickApprove: (record: LoadedRecord) => void;
  onToggle: (tripId: string) => void;
  onUndo: (tripId: string) => void;
  selectedTripIds: Set<string>;
};

/**
 * The tab's trips, in the Phoenix CRM list identity: a white section card titled with the tab and its
 * count, a fixed table on a desktop (named columns, nothing scrolls sideways) and cards on a phone,
 * twenty at a time. A row opens the one-by-one reviewer on that trip; Approve on a row is offered only
 * where nothing needs writing, and Reject always opens the reviewer, because a rejection the employee
 * is not given a reason for is not defensible.
 */
export function ReviewQueueTable({
  allSelectableSelected,
  bulkBar,
  loadError,
  loading,
  narrowed,
  onRetry,
  onToggleAll,
  rows,
  selectableCount,
  sessionExpired,
  tab,
  ...actions
}: RowActions & {
  allSelectableSelected: boolean;
  bulkBar?: ReactNode;
  loadError: string | null;
  loading: boolean;
  narrowed: boolean;
  onRetry: () => void;
  onToggleAll: () => void;
  rows: LoadedRecord[];
  selectableCount: number;
  sessionExpired: boolean;
  tab: TripTab;
}) {
  const [shown, setShown] = useState(PAGE_ROWS);
  const page = rows.slice(0, shown);
  const title =
    tab === "look" || tab === "clean" || tab === "awaiting"
      ? `Waiting for your decision · ${REVIEW_TAB_LABELS[tab]} (${formatNumberValue(rows.length)})`
      : `${REVIEW_TAB_LABELS[tab]} (${formatNumberValue(rows.length)})`;

  return (
    <div aria-labelledby={`expense-tab-${tab}`} id={`expense-panel-${tab}`} role="tabpanel">
      {/* ONE heading line: the tab and its count on the left, the tick-and-approve controls on the
          right. It was three rows — the title, a sentence restating the tab, and "Tick trips to
          approve together" on a band of its own — about 170px before the first trip (owner,
          2026-11-07: "fold the expense table heading into one line"). The sentence is the title's
          hover now. */}
      <section className="min-w-0 overflow-hidden border border-slate-200 bg-white" data-queue-section>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-slate-200 px-4 py-2" data-table-heading>
          <h2 className="min-w-0 break-words text-sm font-black text-slate-950" title={REVIEW_TAB_DESCRIPTIONS[tab]}>
            <span aria-hidden className="mr-2 inline-block h-2 w-2 bg-orange-500 align-middle" />
            {loading ? REVIEW_TAB_LABELS[tab] : title}
          </h2>
          {!loading && !loadError && rows.length > 0 ? bulkBar : null}
        </div>
        {loading ? (
          <CrmLoading label="Reading the trips" />
        ) : loadError ? (
          sessionExpired ? (
            <div className="px-4 py-4 sm:px-5">
              <p className="flex flex-wrap items-center gap-2 border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm font-semibold text-amber-900">
                <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
                Your session has expired.
                <a className="font-black underline hover:text-amber-950" href="/login">
                  Sign in again
                </a>
              </p>
            </div>
          ) : (
            <CrmLoadError message={loadError} onRetry={onRetry} />
          )
        ) : rows.length === 0 ? (
          <CrmEmpty
            message={
              narrowed
                ? "Nothing in this tab matches the filters. Clear them to see the whole queue."
                : tab === "look" || tab === "clean" || tab === "awaiting"
                  ? "Every trip here has been decided."
                  : "There are no trips in this tab yet."
            }
            title={narrowed ? "Nothing matches" : `Nothing in ${REVIEW_TAB_LABELS[tab]}`}
          />
        ) : (
          <>
            <CrmCardsOnPhone>
              {page.map((record) => (
                <QueueCard actions={actions} key={record.tripId} record={record} />
              ))}
            </CrmCardsOnPhone>
            <CrmTable columns={["3rem", "30%", null, "15%", "19%"]}>
              <thead>
                <tr>
                  <th className={crmThClassName} scope="col">
                    {selectableCount > 0 && actions.canDecide ? (
                      <input
                        aria-label={`Tick all ${selectableCount} waiting in this tab`}
                        checked={allSelectableSelected}
                        className="h-4 w-4 rounded-none accent-orange-600"
                        onChange={onToggleAll}
                        type="checkbox"
                      />
                    ) : (
                      <span className="sr-only">Tick</span>
                    )}
                  </th>
                  <th className={crmThClassName} scope="col">Employee and trip</th>
                  <th className={crmThClassName} scope="col">What the system found</th>
                  <th className={cn(crmThClassName, "text-right")} scope="col">Money</th>
                  <th className={crmThClassName} scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {page.map((record) => (
                  <QueueRow actions={actions} key={record.tripId} record={record} />
                ))}
              </tbody>
            </CrmTable>
            <CrmShowMore left={rows.length - page.length} onMore={() => setShown((current) => current + PAGE_ROWS)} page={PAGE_ROWS} />
          </>
        )}
      </section>
    </div>
  );
}

/** The trip's dates — with its length when it ran over more than one day — and its route in words. */
function TripLine({ record }: { record: LoadedRecord }) {
  const span = tripSpan(record.date, record.toDate);
  const destination = record.location || record.to || "";
  return (
    <>
      <span className="block text-xs font-semibold text-slate-600">
        {formatDateValue(record.date, null, { weekday: "short", year: undefined })}
        {span.multiDay ? (
          <>
            {" → "}
            {formatDateValue(record.toDate, null, { weekday: "short", year: undefined })}
            <span className="font-black text-orange-700"> · {formatNumberValue(span.days)} days</span>
          </>
        ) : null}
      </span>
      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-slate-500">
        <bdi className="min-w-0 break-words" dir="auto">
          {displayPlace(record.from)}
        </bdi>
        <ArrowRight aria-hidden className="h-3 w-3 shrink-0 text-slate-400" />
        <bdi className="min-w-0 break-words font-semibold text-slate-700" dir="auto" title={destination || undefined}>
          {displayPlace(destination)}
        </bdi>
      </span>
    </>
  );
}

/** What the system found, as pills: the triage reasons, how long it has waited, the same-trip flag. */
function FoundCell({ actions, record }: { actions: RowActions; record: LoadedRecord }) {
  const decision = actions.decisionFor(record);
  const state = expenseApprovalState(decision);
  const imported = isImportedHistoryTrip(record.date);
  // Every live trip keeps what the system found, decided or not: a ticked decision used to blank the
  // column, so a row read empty until it was opened (owner, 2026-11-07: "show the system's findings
  // on decided rows too"). Only the wait belongs to a trip still waiting.
  const awaiting = state === "pending" && !imported;
  const reading = imported ? null : expenseTripTriage(record);
  const daysAwaiting = awaiting ? expenseTripDaysAwaiting(record.submittedAt, actions.now) : null;
  const flag = record.km ? distanceFlag(record.km) : null;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <div className="flex min-w-0 flex-wrap gap-1" data-triage-reasons>
        {imported ? <CrmPill tone="neutral">Decided before July</CrmPill> : null}
        {reading?.triage === "look"
          ? reading.reasons.map((reason) => (
              <CrmPill key={reason} tone="bad">
                {reason}
              </CrmPill>
            ))
          : null}
        {reading?.triage === "clean" ? (
          <CrmPill tone="good">
            <ShieldCheck aria-hidden className="h-3 w-3" /> Nothing found
          </CrmPill>
        ) : null}
        {awaiting && !reading ? <CrmPill tone="neutral">No system reading</CrmPill> : null}
        {flag && flag.tone !== "none" ? <DistanceChip km={record.km} /> : null}
      </div>
      {daysAwaiting !== null ? (
        <span className={cn("text-phx-2xs font-black", daysAwaiting >= 7 ? "text-orange-700" : "text-slate-500")} data-days-awaiting={daysAwaiting}>
          {expenseTripAwaitingLabel(daysAwaiting)}
        </span>
      ) : null}
      <DuplicateTripFlag copies={actions.duplicateFlags.get(record.tripId)} />
    </div>
  );
}

/** The row's decision controls: Approve and Review while waiting, Undo once decided, nothing for history. */
function DecisionCell({ actions, record }: { actions: RowActions; record: LoadedRecord }) {
  const decision = actions.decisionFor(record);
  const state = expenseApprovalState(decision);
  const imported = isImportedHistoryTrip(record.date);
  // planBulkApproval's own rule, row by row: a changed amount needs its reason before it can go, and
  // a trip with idle days goes only from the opened trip, where its pre-cut is shown and applied.
  const blocked = rowApproveBlock(record, decision);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <DecisionPill decision={decision} record={record} unsaved={actions.isUnsaved(record)} />
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {actions.canDecide && !imported && state === "pending" ? (
          <CrmButton
            data-quick-approve
            data-row-block={blocked ?? undefined}
            disabled={blocked !== null}
            onClick={() => actions.onQuickApprove(record)}
            size="sm"
            title={
              blocked === "reason"
                ? "A changed amount needs its reason — open the trip to write it"
                : blocked === "pre-cut"
                  ? "Days with no visit and no meeting — open the trip to approve it with its pre-cut"
                  : "Approve as it stands; Save commits it"
            }
            variant="success"
          >
            <Check aria-hidden className="h-3.5 w-3.5" /> Approve
          </CrmButton>
        ) : null}
        {actions.canDecide && !imported && state !== "pending" ? (
          <CrmButton onClick={() => actions.onUndo(record.tripId)} size="sm" variant="secondary">
            <Undo2 aria-hidden className="h-3.5 w-3.5" />
            {state === "approved" ? "Unapprove" : "Undo rejection"}
          </CrmButton>
        ) : null}
        <CrmButton data-open-trip onClick={() => actions.onOpen(record.tripId)} size="sm" variant="secondary">
          <Eye aria-hidden className="h-3.5 w-3.5" /> Review
        </CrmButton>
      </div>
    </div>
  );
}

function RowTick({ actions, record }: { actions: RowActions; record: LoadedRecord }) {
  const decision = actions.decisionFor(record);
  // Only an undecided trip carries a tick box — the bulk approval can approve nothing else, and a box
  // that ticks into nothing invites a click that silently does nothing.
  if (!actions.canDecide || isImportedHistoryTrip(record.date) || expenseApprovalState(decision) !== "pending") return null;
  return (
    <input
      aria-label={`Tick ${record.specialist || "Unassigned"}, ${record.tripId}`}
      checked={actions.selectedTripIds.has(record.tripId)}
      className="mt-0.5 h-4 w-4 rounded-none accent-orange-600"
      onChange={() => actions.onToggle(record.tripId)}
      type="checkbox"
    />
  );
}

function QueueRow({ actions, record }: { actions: RowActions; record: LoadedRecord }) {
  const decision = actions.decisionFor(record);
  const state = expenseApprovalState(decision);
  const ticked = actions.selectedTripIds.has(record.tripId);
  return (
    <tr className={cn("transition-colors", ticked ? "bg-orange-50/70" : "hover:bg-slate-50")} data-trip-id={record.tripId}>
      <td className={cn(crmTdClassName, "border-l-[3px]", STATE_ACCENT[state])}>
        <RowTick actions={actions} record={record} />
      </td>
      <td className={crmTdClassName}>
        <button
          className="block w-full min-w-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
          onClick={() => actions.onOpen(record.tripId)}
          type="button"
        >
          <span className="block break-words text-sm font-black text-slate-950 hover:text-orange-700">{record.specialist || "Unassigned"}</span>
          <span className="block text-phx-2xs font-bold tracking-wide text-slate-400">{record.tripId}</span>
          <TripLine record={record} />
        </button>
      </td>
      <td className={crmTdClassName}>
        <FoundCell actions={actions} record={record} />
      </td>
      <td className={cn(crmTdClassName, "text-right")}>
        <MoneyFigure approved={decision.approvedAmount} claimed={record.total} />
      </td>
      <td className={crmTdClassName}>
        <DecisionCell actions={actions} record={record} />
      </td>
    </tr>
  );
}

function QueueCard({ actions, record }: { actions: RowActions; record: LoadedRecord }) {
  const decision = actions.decisionFor(record);
  const state = expenseApprovalState(decision);
  return (
    <CrmCard
      accent={STATE_ACCENT[state]}
      className={actions.selectedTripIds.has(record.tripId) ? "bg-orange-50/70" : undefined}
      meta={
        <>
          <span className="block text-phx-2xs font-bold tracking-wide text-slate-400">{record.tripId}</span>
          <TripLine record={record} />
        </>
      }
      status={
        <span className="text-right">
          <MoneyFigure approved={decision.approvedAmount} claimed={record.total} />
        </span>
      }
      title={
        <span className="flex min-w-0 items-start gap-2">
          <RowTick actions={actions} record={record} />
          <button className="min-w-0 break-words text-left hover:text-orange-700" onClick={() => actions.onOpen(record.tripId)} type="button">
            {record.specialist || "Unassigned"}
          </button>
        </span>
      }
    >
      <div className="space-y-2">
        <FoundCell actions={actions} record={record} />
        <DecisionCell actions={actions} record={record} />
      </div>
    </CrmCard>
  );
}
