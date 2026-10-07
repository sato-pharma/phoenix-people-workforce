"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  actorLabel,
  cairoTimeLabel,
  columnLabel,
  isTypedByHand,
  reasonLabel,
  valueLabel,
} from "@/lib/automated-payroll/cell-history-labels";
import type { DraftCellChange } from "@/lib/automated-payroll/types";
import { cn } from "@/lib/utils";

import { CardSection, SectionHeading } from "./section-shell";

/**
 * The card's "Edit history" block: every recorded change to this person's figures on the run —
 * which figure, from what to what, who, why, and when (Cairo time). Collapsed until asked for, and
 * fetched only then, so a step of a hundred cards makes no extra request on load.
 *
 * Shaped exactly like the per-line breakdown strip above it: a bordered strip when shut, a
 * CardSection when open, so the card keeps its rhythm.
 */
export function CellHistorySection({ runId, hrId }: { runId: string; hrId: string }) {
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState<DraftCellChange[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/automated-payroll/runs/${runId}/cell-history?hrId=${encodeURIComponent(hrId)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load the history.");
      setChanges((data.changes ?? []) as DraftCellChange[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load the history.");
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Re-read every time it opens: a save or confirm since the last look has added entries.
    if (next) void load();
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-expanded={false}
        className="flex items-center justify-between gap-2 border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-left transition hover:border-slate-300 hover:bg-slate-100"
      >
        <SectionHeading title="Edit history" className="min-w-0" />
        <ChevronRight className="size-3.5 shrink-0 text-orange-600" />
      </button>
    );
  }

  return (
    <CardSection
      title="Edit history"
      action={
        <button
          type="button"
          onClick={toggle}
          aria-expanded
          className="flex items-center gap-0.5 whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-orange-600 transition hover:text-orange-700"
        >
          Hide
          <ChevronDown className="size-3.5" />
        </button>
      }
    >
      {loading ? <div className="text-xs text-slate-400">Loading…</div> : null}
      {error ? <div className="text-xs text-rose-700">{error}</div> : null}
      {!loading && !error && changes && changes.length === 0 ? (
        <div className="text-xs text-slate-500">
          No recorded changes. History is kept from 7 October 2026; a figure written before then has no entry.
        </div>
      ) : null}
      {!loading && !error
        ? (changes ?? []).map((change, index) => (
            <div
              key={`${change.changedAt}-${change.column}-${index}`}
              className={cn(
                "flex flex-col gap-1 border border-slate-200 bg-slate-50 p-2 text-xs",
                isTypedByHand(change) && "border-l-4 border-l-amber-400",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="font-semibold text-slate-800">{columnLabel(change.column)}</span>
                <span dir="ltr" className="text-right tabular-nums text-slate-700">
                  {valueLabel(change.oldValue)} → <span className="font-semibold">{valueLabel(change.newValue)}</span>
                </span>
              </div>
              <div className="flex items-start justify-between gap-3 text-slate-500">
                <span>{actorLabel(change)}</span>
                <span className="text-right">{cairoTimeLabel(change.changedAt)}</span>
              </div>
              <div className="text-slate-500">{reasonLabel(change)}</div>
            </div>
          ))
        : null}
    </CardSection>
  );
}
