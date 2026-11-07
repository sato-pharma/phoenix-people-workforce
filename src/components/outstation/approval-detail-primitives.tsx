"use client";

import type { ReactNode } from "react";

/**
 * The Expense Approvals detail layout, shared.
 *
 * Owner request (2026-08-04): a held outstation REQUEST must present its detail exactly as the
 * Expense Approval does. These are the actual components that screen uses, lifted out of
 * expense-approvals-workspace.tsx rather than reimplemented — two lookalike copies is precisely
 * how "exactly the same" stops being true after the first edit to one of them.
 *
 * Presentation only. Neither screen's data or decisions live here.
 */

/** Dark block header with the orange accent bar — the module's premium section divider. */
export function PanelSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="border border-slate-200">
      <div className="flex items-center gap-2 bg-slate-900 px-4 py-2.5">
        <span aria-hidden className="h-4 w-1 bg-orange-500" />
        <span className="text-phx-xs font-black uppercase tracking-wide text-white">{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

/**
 * A PanelSection that folds, with its verdict written in the header (owner, 2026-11-06: the
 * approval panel was one long wall of evidence with the decision at the very bottom).
 *
 * The header carries the answer — "3 days · 1 with no field work", "Needs a look", "2 photos · 1
 * ticket" — so a folded section still says what is inside it, and the reviewer opens only the one
 * he needs. Native `<details>`: keyboard and screen-reader behaviour come with it, and nothing is
 * lost when it folds (the content stays mounted, so a loaded panel never re-fetches).
 */
export function CollapsibleSection({
  children,
  defaultOpen = true,
  summary,
  title,
  tone = "neutral",
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  /** The section's answer in a few words, shown beside the title whether open or folded. */
  summary?: ReactNode;
  title: string;
  /** Colours the summary only: rose for something to look at, emerald for clean. */
  tone?: "danger" | "neutral" | "success" | "warning";
}) {
  const toneClass =
    tone === "danger"
      ? "text-rose-300"
      : tone === "warning"
        ? "text-amber-300"
        : tone === "success"
          ? "text-emerald-300"
          : "text-slate-300";
  return (
    <details className="group border border-slate-200" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 bg-slate-900 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="h-4 w-1 bg-orange-500" />
        <span className="text-phx-xs font-black uppercase tracking-wide text-white">{title}</span>
        {summary ? <span className={`min-w-0 break-words text-phx-xs font-bold ${toneClass}`}>{summary}</span> : null}
        <span className="ml-auto text-phx-2xs font-black uppercase tracking-wide text-slate-400">
          <span className="group-open:hidden">Show</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>
      <div className="p-4">{children}</div>
    </details>
  );
}

/**
 * One label/value cell of the fact grid under the dark header.
 *
 * The value WRAPS. It used to be `whitespace-nowrap`, and a timestamp like "Sep 23, 2026, 12:59 PM"
 * is wider than a quarter of the modal, so it ran straight into the next cell: the owner's own
 * screenshot on 2026-09-28 read "12:59 PMSep 23, 2026, 12:56 PM" across Submitted and Captured time.
 * `min-w-0` lets the grid cell shrink below its content so `break-words` has something to act on.
 */
export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <p className="mt-0.5 break-words text-sm font-semibold text-slate-900" dir="auto">{value || "—"}</p>
    </div>
  );
}

/**
 * The route, as two labelled lines that WRAP — never a line that scrolls sideways.
 *
 * This used to be one unwrappable line inside its own `overflow-x-auto` box, on the reasoning that a
 * 95-character postal address "must not wrap and must not be truncated". The owner overruled that on
 * 2026-09-28 ("the route, make it no horizontal scrolling"), and his golden rule already settles the
 * collision: never truncate, never scroll sideways, and where the two meet WRAPPING WINS. So the
 * address is kept whole and simply allowed to take a second line.
 *
 * It spans the full width of the fact grid, so a long address wraps as little as possible. Each end
 * keeps its own `dir="auto"`: residence addresses are Arabic in 70 of 70 production rows and the
 * destination is Arabic-first in 19, so each resolves on its own rather than from its neighbour.
 */
export function RouteFact({ from, to, toTitle }: { from: string; to: string; toTitle?: string }) {
  return (
    <div className="col-span-2 min-w-0 sm:col-span-4">
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Route</p>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-sm font-semibold text-slate-900">
        <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">From</dt>
        {/* `text-left` beside `dir="auto"` (owner's review, 2026-11-07): an Arabic From still reads
            right to left, but both ends start at the same edge, so the route reads down one line
            instead of zig-zagging — Arabic From on the right, Latin To on the left. */}
        <dd className="m-0 min-w-0 break-words text-left" dir="auto">{from || "—"}</dd>
        <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">To</dt>
        <dd className="m-0 min-w-0 break-words text-left" dir="auto" title={toTitle || undefined}>
          {to || "—"}
        </dd>
      </dl>
    </div>
  );
}

/** Travel / Meeting / Allowance / Other = Total, in the mono equation form the approver reads. */
export function CostBreakdownFact({
  allowance,
  formatCurrency,
  meeting,
  other,
  total,
  travel,
}: {
  allowance: number;
  formatCurrency: (value: number) => string;
  meeting: number;
  other: number;
  total: number;
  travel: number;
}) {
  return (
    <div className="col-span-2 border-t border-slate-200 pt-3 sm:col-span-4">
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Cost breakdown</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-sm text-slate-700">
        <span>
          Travel <b className="text-slate-900">{formatCurrency(travel)}</b>
        </span>
        <span>
          Meeting <b className="text-slate-900">{formatCurrency(meeting)}</b>
        </span>
        <span>
          Allowance <b className="text-slate-900">{formatCurrency(allowance)}</b>
        </span>
        {other ? (
          <span>
            Other <b className="text-slate-900">{formatCurrency(other)}</b>
          </span>
        ) : null}
        <span className="text-slate-400">=</span>
        <span>
          Total <b className="text-slate-900">{formatCurrency(total)}</b>
        </span>
      </div>
    </div>
  );
}
