"use client";

/**
 * Phoenix CRM — last month's iReports360 plan, shown as a reference while building the new month.
 *
 * Owner, 2026-09-25: the rep can pull his old plan in as a starting point. This is read-only — it never
 * changes iReports360 — and "Copy last month" only pre-fills the new month's drafts (the parent does the
 * writing, through the ordinary weekly save). A doctor who has since left the list shows by name, greyed,
 * and is not copied. The panel is collapsed by default so the builder stays uncluttered on a phone.
 */

import { useState } from "react";

import { countText, plural } from "@/components/phoenix-crm/format";
import { CrmButton, CrmNote, CrmPill } from "@/components/phoenix-crm/ui";
import { PHOENIX_CRM_WEEKDAY_NAMES, PHOENIX_CRM_WEEKDAY_ORDER } from "@/lib/phoenix-crm/timings";
import type { PlanHistoryView } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/** "Saturday, Monday" — the days he was on last month, in the field-week's own order. */
function weekdayList(weekdays: ReadonlyArray<number>): string {
  const order = new Map<number, number>(PHOENIX_CRM_WEEKDAY_ORDER.map((weekday, index) => [weekday, index]));
  return [...weekdays]
    .sort((left, right) => (order.get(left) ?? 7) - (order.get(right) ?? 7))
    .map((weekday) => PHOENIX_CRM_WEEKDAY_NAMES[weekday])
    .join(", ");
}

export function PlanHistoryReference({
  canCopy,
  copyBusy = false,
  history,
  onCopy,
}: {
  /** The month is the rep's own and open to edit — a copy would land somewhere. */
  canCopy: boolean;
  copyBusy?: boolean;
  history: PlanHistoryView | null;
  onCopy?: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!history || !history.available || history.entries.length === 0) {
    return (
      <p className="break-words text-sm font-medium leading-6 text-slate-500">
        No {history?.historyMonthLabel ?? "earlier"} plan to copy from{history?.sourceName ? ` for ${history.sourceName}` : ""}.
      </p>
    );
  }

  const mapped = history.entries.filter((entry) => entry.onNativeList && entry.nativeCustomerId);
  const gone = history.entries.length - mapped.length;

  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid min-w-0 gap-2">
        <p className="break-words text-sm font-medium leading-6 text-slate-600">
          {history.sourceName ? `${history.sourceName} planned ` : "Planned "}
          {plural(history.entries.length, "customer", "customers")} in {history.historyMonthLabel}.
          {gone > 0 ? ` ${countText(gone)} ${gone === 1 ? "is" : "are"} no longer on the list and cannot be copied.` : ""}
        </p>
        <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
          {canCopy && onCopy ? (
            <CrmButton busy={copyBusy} disabled={mapped.length === 0} onClick={onCopy} variant="primary">
              Copy last month
            </CrmButton>
          ) : null}
          <CrmButton onClick={() => setOpen((current) => !current)} size="sm" variant="ghost">
            {open ? "Hide the list" : `Show the ${countText(history.entries.length)}`}
          </CrmButton>
        </div>
        {canCopy && onCopy ? (
          <p className="break-words text-xs font-semibold leading-5 text-slate-500">
            Copying places each customer on the days he had last month, on days you can still change. Nothing is sent — review and adjust it, then send the month.
          </p>
        ) : null}
      </div>

      {open ? (
        <div className="divide-y divide-slate-100 border border-slate-200">
          {history.entries.map((entry) => {
            const placeable = entry.onNativeList && Boolean(entry.nativeCustomerId);
            const meta = [entry.listType, entry.grade ? `Grade ${entry.grade}` : null, entry.speciality].filter(Boolean).join(" · ");
            return (
              <article className={cn("min-w-0 bg-white px-3.5 py-2.5", placeable ? undefined : "bg-slate-50")} key={entry.contactCrmId}>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 basis-56">
                    <h4 className="break-words text-sm font-black text-slate-950">{entry.name}</h4>
                    {meta ? <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">{meta}</p> : null}
                    <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-600">
                      {entry.weekdays.length > 0 ? weekdayList(entry.weekdays) : `${plural(entry.frequency, "visit", "visits")} a month`}
                    </p>
                  </div>
                  {placeable ? null : <CrmPill tone="warn">Left the list</CrmPill>}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {mapped.length === 0 ? <CrmNote tone="warn">None of last month&apos;s customers are still on the list, so there is nothing to copy.</CrmNote> : null}
    </div>
  );
}
