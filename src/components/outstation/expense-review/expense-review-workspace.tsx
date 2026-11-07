"use client";

import { useMemo, useState } from "react";

import { expenseTripTriage } from "@/lib/outstation/expense-approval-triage";

import { EmployeeRollUp } from "./employee-roll-up";
import { ReviewAdvice, ReviewBulkResult, ReviewSaveResult } from "./review-banners";
import { ReviewBulkBar } from "./review-bulk-bar";
import { ExpenseReviewDeck } from "./review-deck/deck";
import { ReviewFilters, ReviewLoadingLine, ReviewSaveStrip } from "./review-filters";
import { ReviewHeader } from "./review-header";
import { TRIP_TABS, type TripTab, inReviewTab, isUnsaved, reviewAdvice } from "./review-model";
import { egp } from "./review-parts";
import { ReviewQueueTable } from "./review-queue-table";
import { ReviewStatTiles } from "./review-stats";
import { ReviewTabs } from "./review-tabs";
import { useExpenseReview } from "./use-expense-review";

/**
 * Expense approvals — retired and rebuilt from scratch in the Phoenix CRM identity (owner, 2026-11-07:
 * "retire the current expense approval and rebuild from scratch, same Phoenix CRM identity").
 *
 * The list page is drawn as Place checks draws its own: the orange-rail header with "Review one by
 * one", six live tiles, the page tabs with their counts, the filter bar, one sentence of advice, and
 * the tab's trips as a fixed table on a desktop and cards on a phone. Every trip is decided in the
 * full-screen reviewer (review-deck/), which walks the tab one trip at a time.
 *
 * Nothing on this screen holds a rule of its own: the state, the save and every count are
 * use-expense-review.ts, the logic is review-model.ts, and the money rules are the domain modules in
 * src/lib/outstation/ they call. A decision is a DRAFT until Save — kept in the browser for the viewer
 * who made it, restored after a reload, and posted only for the trips it changed.
 */
export function ExpenseReviewWorkspace({ canDecide, viewerHrId }: { canDecide: boolean; viewerHrId: string | null }) {
  const review = useExpenseReview({ canDecide, viewerHrId });
  const [now] = useState(() => Date.now());
  const { decisions, visible } = review;

  // The unsaved pill on each tab: how many of its trips carry a decision not yet saved.
  const unsavedByTab = useMemo(() => {
    const counts: Partial<Record<TripTab, number>> = {};
    const unsaved = visible.filter((record) => isUnsaved(record, decisions));
    if (unsaved.length === 0) return counts;
    for (const tab of TRIP_TABS) {
      const count = unsaved.filter((record) => inReviewTab(record, tab)).length;
      if (count > 0) counts[tab] = count;
    }
    return counts;
  }, [visible, decisions]);

  // "Tick all 34 clean" — offered as one pick when every waiting trip in the tab is clean.
  const cleanCount = useMemo(() => review.selectable.filter((record) => expenseTripTriage(record)?.triage === "clean").length, [review.selectable]);

  const listTab: TripTab = review.tab === "employees" ? "all" : review.tab;
  const reviewCount = review.tab === "employees" ? review.visible.length : review.rows.length;

  return (
    <div className="min-w-0 space-y-5" data-expense-review>
      <ReviewHeader
        canReview={reviewCount > 0}
        exportCount={review.exportCount}
        exportHref={review.exportHref}
        loading={review.loading}
        onReview={() => review.openDeck(review.tab === "employees" ? { ids: review.visible.map((record) => record.tripId), tab: "all" } : {})}
        reviewCount={reviewCount}
      />

      <ReviewStatTiles
        loading={review.loading}
        narrowed={review.narrowed}
        onOpenTab={review.chooseTab}
        overall={review.overallStats}
        stats={review.stats}
      />

      <ReviewTabs
        counts={review.tabCounts}
        employeeCount={review.employeeSummaries.length}
        onChoose={review.chooseTab}
        tab={review.tab}
        unsavedByTab={unsavedByTab}
      />

      <ReviewFilters
        activeFilterCount={review.activeFilterCount}
        employee={review.filters.employee}
        employees={review.filterOptions.employees}
        month={review.filters.month}
        months={review.filterOptions.months}
        narrowed={review.narrowed}
        onClear={review.clearFilters}
        onEmployee={review.setEmployee}
        onMonth={review.setMonth}
        onSearch={review.setSearch}
        onSort={review.chooseSort}
        search={review.search}
        shown={review.visible.length}
        sort={review.filters.sort ?? "value"}
        total={review.records.length}
      />

      <ReviewSaveStrip dirtyCount={review.dirtyCount} onSave={() => void review.save()} restoredDraftCount={review.restoredDraftCount} saving={review.saving} />
      <ReviewSaveResult saveMessage={review.saveMessage} savePayrollWarnings={review.savePayrollWarnings} saveSkipped={review.saveSkipped} />
      <ReviewBulkResult bulkMessage={review.bulkMessage} />

      {review.loading && review.records.length === 0 ? <ReviewLoadingLine /> : null}
      {!review.loading && !review.loadError && review.records.length > 0 ? <ReviewAdvice advice={reviewAdvice(review.stats, egp)} /> : null}

      {review.tab === "employees" ? (
        <EmployeeRollUp
          canDecide={canDecide}
          expanded={review.expandedEmployees}
          narrowed={review.narrowed}
          onOpenTrips={(tripIds, tripId) => review.openDeck({ ids: tripIds, tab: "employee", tripId })}
          onToggle={review.toggleEmployee}
          onUndo={review.undoDecision}
          summaries={review.employeeSummaries}
          totals={review.summaryTotals}
        />
      ) : (
        <ReviewQueueTable
          allSelectableSelected={review.allSelectableSelected}
          bulkBar={
            canDecide ? (
              <ReviewBulkBar
                approvableCount={review.bulkPlan.approvableTripIds.length}
                cleanCount={cleanCount}
                needsReasonCount={review.bulkPlan.needsReasonTripIds.length}
                onApprove={review.approveSelected}
                onClear={review.clearSelection}
                onPickAll={review.toggleAllSelectable}
                selectableCount={review.selectable.length}
                selectedCount={review.selectedVisible.length}
                selectedValue={review.selectedValue}
              />
            ) : null
          }
          canDecide={canDecide}
          decisionFor={review.decisionFor}
          duplicateFlags={review.duplicateFlags}
          isUnsaved={(record) => isUnsaved(record, decisions)}
          loadError={review.loadError}
          loading={review.loading}
          narrowed={review.narrowed}
          now={now}
          onOpen={(tripId) => review.openDeck({ tripId })}
          onQuickApprove={review.quickApprove}
          onRetry={review.retry}
          onToggle={review.toggleTrip}
          onToggleAll={review.toggleAllSelectable}
          onUndo={review.undoDecision}
          rows={review.rows}
          selectableCount={review.selectable.length}
          selectedTripIds={review.selectedTripIds}
          sessionExpired={review.sessionExpired}
          tab={listTab}
        />
      )}

      <ExpenseReviewDeck review={review} />
    </div>
  );
}
