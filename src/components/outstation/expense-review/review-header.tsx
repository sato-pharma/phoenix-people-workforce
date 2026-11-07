"use client";

import { Download, Layers, Wallet } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { formatNumberValue } from "@/lib/i18n/format";

/**
 * The page's title line, in the Phoenix CRM list identity (Place checks): the orange rail, the
 * kicker, the title, one sentence, and the two actions on the right — the orange "Review one by one"
 * and the export. No dark band: the trips start right under it.
 *
 * Owner, 2026-11-07, circling everything above the first trip: "the screen is consumed in irrelevant
 * place". So the hero is compact and its one sentence is the ADVICE — what is waiting, what it is
 * worth, what can be done in one go — not a description of the page; the separate advice box is gone.
 */
export function ReviewHeader({
  advice,
  canReview,
  exportCount,
  exportHref,
  loading,
  onReview,
  reviewCount,
}: {
  /** The one live sentence: what is waiting and what can be done in one go (reviewAdvice). */
  advice: string;
  canReview: boolean;
  exportCount: number;
  exportHref: string;
  loading: boolean;
  onReview: () => void;
  /** How many trips "Review one by one" would walk: the tab on screen. */
  reviewCount: number;
}) {
  return (
    <AdminPageHero
      actions={
        <>
          <button
            className="inline-flex min-h-11 items-center gap-2 rounded-none border border-orange-600 bg-orange-600 px-4 py-2 text-sm font-black text-white transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
            data-review-one-by-one
            disabled={!canReview}
            onClick={onReview}
            type="button"
          >
            <Layers aria-hidden className="h-4 w-4" />
            Review one by one
            {canReview ? <span className="bg-white/20 px-1.5 py-0.5 text-phx-2xs tabular-nums">{formatNumberValue(reviewCount)}</span> : null}
          </button>
          {loading || exportCount === 0 ? (
            <span className="inline-flex min-h-11 cursor-not-allowed items-center gap-2 rounded-none border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-400">
              <Download aria-hidden className="h-4 w-4" /> Export XLSX
            </span>
          ) : (
            <a
              className="inline-flex min-h-11 items-center gap-2 rounded-none border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
              href={exportHref}
              title={`${formatNumberValue(exportCount)} trips: the month, the employee and the search as chosen, every decision state`}
            >
              <Download aria-hidden className="h-4 w-4" /> Export XLSX
              <span className="tabular-nums text-slate-400">{formatNumberValue(exportCount)}</span>
            </a>
          )}
        </>
      }
      compact
      description={advice}
      eyebrow="Expenses"
      icon={<Wallet aria-hidden className="h-3.5 w-3.5" />}
      title="Expense approvals"
    />
  );
}
