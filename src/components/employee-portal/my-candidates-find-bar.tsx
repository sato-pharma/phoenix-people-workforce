"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { BellDot, Inbox, Layers, PhoneCall, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import {
  RecruitmentTabBar,
  recruitmentStackedToolbarClassName,
  type RecruitmentTab,
} from "@/components/recruitment/recruitment-premium";
import {
  MY_CANDIDATES_VIEW_LABELS,
  type MyCandidatesView,
} from "@/lib/recruitment/my-candidates-find";
import { adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { cn } from "@/lib/utils";

const kbdClassName = `border border-slate-300 bg-white px-1 font-mono text-phx-xs text-slate-700 ${adminRecessedDepthClassName}`;

const VIEW_ICONS: Record<MyCandidatesView, ReactNode> = {
  all: <Layers className="h-3.5 w-3.5" />,
  calling: <PhoneCall className="h-3.5 w-3.5" />,
  unopened: <BellDot className="h-3.5 w-3.5" />,
  waiting: <Inbox className="h-3.5 w-3.5" />,
};

/**
 * The tray over the manager's own lists: one search box and the four quick views, each with how
 * many different people it holds. Built from the module's kit — the stacked toolbar tray and the
 * tab bar every recruitment screen uses — so it reads as the workspace's own filter bar, not a
 * new widget. "/" puts the cursor in the box from anywhere on the page.
 */
export function MyCandidatesFindBar({
  counts,
  onQueryChange,
  onViewChange,
  query,
  shown,
  total,
  view,
}: {
  counts: Record<MyCandidatesView, number>;
  onQueryChange: (query: string) => void;
  onViewChange: (view: MyCandidatesView) => void;
  query: string;
  /** How many different people the lists below now show. */
  shown: number;
  /** How many different people are on his lists at all. */
  total: number;
  view: MyCandidatesView;
}) {
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      box.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tabs: RecruitmentTab<MyCandidatesView>[] = (Object.keys(MY_CANDIDATES_VIEW_LABELS) as MyCandidatesView[]).map((key) => ({
    count: counts[key],
    icon: VIEW_ICONS[key],
    key,
    label: MY_CANDIDATES_VIEW_LABELS[key],
  }));
  const narrowed = view !== "all" || query.trim().length > 0;

  return (
    <div className={recruitmentStackedToolbarClassName}>
      <label className="relative block">
        <span className="sr-only">Find a CV</span>
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className={cn(phxFieldClassName, "pl-9 pr-9")}
          dir="auto"
          enterKeyHint="search"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) onQueryChange("");
          }}
          placeholder="Find a CV — name, phone, town, university, employer"
          ref={box}
          type="search"
          value={query}
        />
        {query ? (
          <button
            aria-label="Clear the search"
            className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-slate-400 hover:text-slate-700"
            onClick={() => {
              onQueryChange("");
              box.current?.focus();
            }}
            type="button"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
      </label>
      <RecruitmentTabBar label="Quick views" onChange={onViewChange} tabs={tabs} value={view} />
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-slate-500">
        <p aria-live="polite" className="break-words">
          {narrowed ? (
            <>
              Showing <span className="font-black tabular-nums text-slate-900">{shown}</span> of{" "}
              <span className="font-bold tabular-nums">{total}</span> {total === 1 ? "CV" : "CVs"}
            </>
          ) : (
            <>
              <span className="font-black tabular-nums text-slate-900">{total}</span> {total === 1 ? "CV" : "CVs"} on your lists.
              Press <kbd className={kbdClassName}>/</kbd> to search;
              in an open CV, <kbd className={kbdClassName}>J</kbd>{" "}
              and <kbd className={kbdClassName}>K</kbd> move to the
              next and previous.
            </>
          )}
        </p>
        {narrowed ? (
          <Button
            onClick={() => {
              onQueryChange("");
              onViewChange("all");
            }}
            size="sm"
            variant="outline"
          >
            Show everything
          </Button>
        ) : null}
      </div>
    </div>
  );
}
