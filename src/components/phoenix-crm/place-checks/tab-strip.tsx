"use client";

/**
 * Phoenix CRM — Place checks: the tab strip.
 *
 * A real tab list on a desktop: one tab stop, arrow keys between the tabs, and only the open tab's panel
 * on the page. On a phone the same tabs are one dropdown (the rebuild, 23 Nov 2026): twelve tabs wrapped
 * into six rows above the first waiting place.
 */

import type { PlaceCheckBoard } from "@/components/phoenix-crm/place-checks/use-place-check-board";
import { CrmField, CrmPill, CrmSelect } from "@/components/phoenix-crm/ui";
import { cn } from "@/lib/utils";

const withCount = (label: string, count: number | null) => `${label}${count === null ? "" : ` (${count})`}`;

export function PlaceCheckTabStrip({ board }: { board: PlaceCheckBoard }) {
  const { moveTab, selectView, tabs, team, view } = board;
  return (
    <div className="min-w-0 scroll-mt-4" id="vr-tabs">
      <div className="min-w-0 sm:hidden">
        <CrmField htmlFor="vr-tab-select" label="Showing">
          <CrmSelect
            id="vr-tab-select"
            onChange={(event) => {
              const next = tabs.find((tab) => tab.key === event.target.value);
              if (next) selectView(next.key);
            }}
            value={view}
          >
            {tabs.map(({ key, label, count }) => (
              <option key={key} value={key}>
                {withCount(label, count)}
              </option>
            ))}
          </CrmSelect>
        </CrmField>
      </div>
      <div aria-label="Place checks" className="hidden min-w-0 flex-wrap border-b border-slate-200 sm:flex" role="tablist">
        {tabs.map(({ key, label, count, open = 0 }, index) => (
          <button
            key={key}
            aria-controls={view === key ? `vr-panel-${key}` : undefined}
            aria-selected={view === key}
            className={cn(
              "-mb-px inline-flex min-h-11 min-w-0 flex-wrap items-center gap-2 rounded-none border-b-2 px-3 py-2.5 text-left text-sm font-black",
              view === key ? "border-orange-500 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700",
            )}
            id={`vr-tab-${key}`}
            onClick={() => selectView(key)}
            onKeyDown={(event) => moveTab(event, index)}
            role="tab"
            tabIndex={view === key ? 0 : -1}
            type="button"
          >
            <span className="break-words">{withCount(label, count)}</span>
            {open > 0 ? (
              <CrmPill tone="warn">
                {open} {team ? "being checked" : "waiting"}
              </CrmPill>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
