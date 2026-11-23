"use client";

/**
 * Phoenix CRM — Place checks: the tab strip.
 *
 * A real tab list on a desktop: one tab stop, arrow keys between the tabs, and only the open tab's panel
 * on the page. On a phone the same tabs are one dropdown (the rebuild, 23 Nov 2026): twelve tabs wrapped
 * into six rows above the first waiting place. The picker says what it is by its own option ("Your call
 * (38)"), so its label is a screen reader's, and on the Super Admin's board the Filters button shares its
 * row (`PlaceCheckFilterToggle`): the label and the folded filter box were 140 px above the first place.
 *
 * On the Super Admin's board the folded Filters line ends the strip's last row (`filter-bar.tsx`). The
 * tab list is `contents`, so its tabs and that line wrap as one row and the line is no tab.
 */

import { PlaceCheckFilterLine, PlaceCheckFilterToggle } from "@/components/phoenix-crm/place-checks/filter-bar";
import type { PlaceCheckBoard } from "@/components/phoenix-crm/place-checks/use-place-check-board";
import { CrmPill, CrmSelect } from "@/components/phoenix-crm/ui";
import { cn } from "@/lib/utils";

const withCount = (label: string, count: number | null) => `${label}${count === null ? "" : ` (${count})`}`;

export function PlaceCheckTabStrip({ board }: { board: PlaceCheckBoard }) {
  const { lanes, moveTab, selectView, tabs, team, view } = board;
  return (
    <div className="min-w-0 scroll-mt-4" id="vr-tabs">
      <div className="flex min-w-0 items-center gap-2 sm:hidden" data-tab-picker>
        <label className="sr-only" htmlFor="vr-tab-select">
          Showing
        </label>
        <div className="min-w-0 flex-1">
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
        </div>
        {lanes ? <PlaceCheckFilterToggle board={board} /> : null}
      </div>
      <div className="hidden min-w-0 flex-wrap items-center border-b border-slate-200 sm:flex">
        <div aria-label="Place checks" className="contents" role="tablist">
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
        {lanes ? (
          <div className="ml-auto flex min-w-0 max-w-full items-center gap-x-3 py-1 pl-3" data-filters-in-strip>
            <PlaceCheckFilterLine board={board} inStrip />
          </div>
        ) : null}
      </div>
    </div>
  );
}
