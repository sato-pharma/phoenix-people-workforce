"use client";

import type { KeyboardEvent } from "react";

import { CrmPill } from "@/components/phoenix-crm/ui";
import { formatNumberValue } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

import { REVIEW_TAB_LABELS, type ReviewTab, TRIP_TABS, type TripTab } from "./review-model";

const PAGE_TABS: ReadonlyArray<ReviewTab> = [...TRIP_TABS, "employees"];

/**
 * The page's tabs, drawn exactly as Place checks draws its own: an orange underline on the open tab,
 * the count beside each name, and the arrow keys, Home and End moving between them. Which tab a trip
 * sits in is read from its STORED decision, so a trip decided in a tab stays in it until Save.
 */
export function ReviewTabs({
  counts,
  employeeCount,
  onChoose,
  tab,
  unsavedByTab,
}: {
  counts: Record<TripTab, number>;
  employeeCount: number;
  onChoose: (tab: ReviewTab) => void;
  tab: ReviewTab;
  /** Decisions on screen not yet saved, per tab — a warn pill, so unsaved work is never out of sight. */
  unsavedByTab: Partial<Record<TripTab, number>>;
}) {
  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = PAGE_TABS.length - 1;
    const target =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    onChoose(PAGE_TABS[target]);
    document.getElementById(`expense-tab-${PAGE_TABS[target]}`)?.focus();
  }

  return (
    <div aria-label="Expense approvals" className="flex min-w-0 flex-wrap border-b border-slate-200" role="tablist">
      {PAGE_TABS.map((key, index) => {
        const count = key === "employees" ? employeeCount : counts[key];
        const unsaved = key === "employees" ? 0 : (unsavedByTab[key] ?? 0);
        return (
          <button
            aria-controls={tab === key ? `expense-panel-${key}` : undefined}
            aria-selected={tab === key}
            className={cn(
              "-mb-px inline-flex min-h-11 min-w-0 flex-wrap items-center gap-2 rounded-none border-b-2 px-4 py-2.5 text-left text-sm font-black",
              tab === key ? "border-orange-500 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700",
            )}
            data-tab={key}
            id={`expense-tab-${key}`}
            key={key}
            onClick={() => onChoose(key)}
            onKeyDown={(event) => move(event, index)}
            role="tab"
            tabIndex={tab === key ? 0 : -1}
            type="button"
          >
            <span className="break-words">
              {REVIEW_TAB_LABELS[key]} <span className="tabular-nums">({formatNumberValue(count)})</span>
            </span>
            {unsaved > 0 ? <CrmPill tone="warn">{formatNumberValue(unsaved)} unsaved</CrmPill> : null}
          </button>
        );
      })}
    </div>
  );
}
