"use client";

import { ChevronDown, ChevronRight } from "lucide-react";

import { TripAttachments } from "@/components/outstation/trip-attachments";
import { rowDetailToggleProps } from "@/components/ui/table-row-detail";
import { isImportedHistoryTrip } from "@/lib/outstation/imported-history";

import { DeckSubject } from "./review-deck/deck-subject";
import type { Decision, LoadedRecord } from "./review-model";
import { EmployeeNote } from "./review-parts";

/** The id the toggle's aria-controls names — one per trip, so every row's panel is addressable. */
export function rowDetailsId(tripId: string): string {
  return `expense-row-details-${tripId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * The chevron that opens and closes one trip in the "Waiting for your decision" list (owner,
 * 2026-11-09: "MAKE THIS COLLAPSABLE AND EXPANDABLE: I EXPAND, THE DETAILS AND PICS APPEAR; I COLLAPSE,
 * COLLAPSED"). A native button, so Enter and Space work; rowDetailToggleProps gives it aria-expanded
 * (which way it is) and aria-controls (the panel it opens).
 */
export function RowExpandToggle({ expanded, onToggle, tripId }: { expanded: boolean; onToggle: () => void; tripId: string }) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      {...rowDetailToggleProps(rowDetailsId(tripId), expanded)}
      aria-label={expanded ? `Collapse ${tripId}` : `Expand ${tripId}: details and pictures`}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-slate-300 bg-white text-slate-700 transition hover:border-orange-400 hover:text-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
      data-row-expand={expanded ? "open" : "closed"}
      onClick={onToggle}
      title={expanded ? "Collapse" : "Expand: details and pictures"}
      type="button"
    >
      <Icon aria-hidden className="h-4 w-4" />
    </button>
  );
}

/**
 * What an expanded trip shows under its row: every fact of the claim (the reviewer's own subject
 * block), the allowance lines, the employee's own words, and the photos, stops and tickets.
 *
 * 🔴 Mounted ONLY while the trip is expanded — the photos are fetched when it opens, never for every
 * row of a collapsed list. It writes nothing and holds no decision: the decision lives in
 * use-expense-review.ts, so collapsing a row can never undo an Approve, a Reject or a typed amount.
 * The day maps, Phoenix CRM and the claim checks stay in "Review", the full-screen reviewer.
 */
export function ReviewRowDetails({ decision, duplicateOf, record, unsaved }: { decision: Decision; duplicateOf?: string[]; record: LoadedRecord; unsaved: boolean }) {
  const valuesOnly = isImportedHistoryTrip(record.date);
  const notices = record.allowanceNotices ?? [];
  return (
    <div className="min-w-0 border-t border-slate-200 bg-white" data-row-details={record.tripId} id={rowDetailsId(record.tripId)}>
      <DeckSubject decision={decision} duplicateOf={duplicateOf} record={record} unsaved={unsaved} valuesOnly={valuesOnly} />
      {notices.length > 0 || record.employeeNote ? (
        <div className="min-w-0 space-y-3 border-b border-slate-200 px-5 py-3">
          {notices.length > 0 ? (
            <div className="min-w-0 space-y-1 border-l-[3px] border-l-amber-500 bg-amber-50 px-3 py-2 text-xs">
              {notices.map((notice) => (
                <p className="break-words text-amber-900" key={notice}>
                  <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-amber-700">Allowance</span>
                  {" · "}
                  {notice}
                </p>
              ))}
            </div>
          ) : null}
          <EmployeeNote note={record.employeeNote} wide />
        </div>
      ) : null}
      <section aria-label="Photos, stops and tickets" className="min-w-0 px-5 py-4" data-row-photos>
        <p className="mb-3 break-words text-sm font-black uppercase tracking-wide text-slate-900">Photos, stops and tickets</p>
        {valuesOnly ? <p className="break-words text-sm text-slate-500">An imported trip carries no photos.</p> : <TripAttachments tripId={record.tripId} />}
      </section>
    </div>
  );
}
