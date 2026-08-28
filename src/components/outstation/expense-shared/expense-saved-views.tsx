"use client";

import { useState } from "react";
import { BookmarkPlus, X } from "lucide-react";

import { useExpenseSavedViews } from "@/components/outstation/expense-shared/use-expense-saved-views";
import type { ExpenseCommandFilters } from "@/components/outstation/expense-shared/types";

export function ExpenseSavedViews({
  currentFilters,
  onLoad,
}: {
  currentFilters: ExpenseCommandFilters;
  onLoad: (filters: ExpenseCommandFilters) => void;
}) {
  const { views, addView, removeView } = useExpenseSavedViews();
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");

  function commitSave() {
    const name = draftName.trim();
    if (!name) return;
    addView(name, currentFilters);
    setDraftName("");
    setNaming(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[18px] border border-phx-line bg-white px-4 py-3 shadow-[0_8px_22px_rgba(15,23,42,0.04)]">
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">
        Saved views
      </span>

      {views.length === 0 && !naming ? (
        <span className="text-xs italic text-slate-400">None yet</span>
      ) : null}

      {views.map((view) => (
        <span
          key={view.name}
          className="inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-50/80 pl-3 pr-1 text-xs font-semibold text-orange-700"
        >
          <button
            type="button"
            className="py-1 transition-colors hover:text-orange-900"
            onClick={() => onLoad(view.filters)}
            title={`Load "${view.name}"`}
          >
            {view.name}
          </button>
          <button
            type="button"
            className="rounded-full p-1 text-orange-400 transition-colors hover:bg-orange-100 hover:text-rose-600"
            onClick={() => removeView(view.name)}
            title={`Delete "${view.name}"`}
            aria-label={`Delete view ${view.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {naming ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            maxLength={40}
            onBlur={() => {
              if (!draftName.trim()) setNaming(false);
            }}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitSave();
              else if (event.key === "Escape") {
                setDraftName("");
                setNaming(false);
              }
            }}
            placeholder="Name this view"
            value={draftName}
          />
          <button
            type="button"
            className="rounded-full bg-phx-accent px-3 py-1 text-xs font-bold text-white transition-colors hover:bg-phx-accent-hover"
            onClick={commitSave}
          >
            Save
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600 transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
          onClick={() => setNaming(true)}
          title="Save current filters as a view"
        >
          <BookmarkPlus className="h-3.5 w-3.5" /> Save current view
        </button>
      )}
    </div>
  );
}
