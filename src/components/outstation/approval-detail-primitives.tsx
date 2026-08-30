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

/** One label/value cell of the fact grid under the dark header. */
export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <p className="mt-0.5 whitespace-nowrap text-sm font-semibold text-slate-900" dir="auto">{value || "—"}</p>
    </div>
  );
}

/**
 * The from → to line. Phoenix-submitted trips carry a full postal address here, not a city — one
 * live row is 95 characters. It must not wrap and must not be truncated, so the line scrolls
 * horizontally WITHIN its own box and the page itself never moves.
 */
export function RouteFact({ from, to }: { from: string; to: string }) {
  return (
    <div className="col-span-2 sm:col-span-2">
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Route</p>
      <div className="mt-0.5 -mx-1 overflow-x-auto px-1">
        <p className="flex w-max items-center gap-1.5 text-sm font-semibold text-slate-900">
          <span className="whitespace-nowrap" dir="auto">{from || "—"}</span>
          <span aria-hidden className="shrink-0 text-slate-400">
            →
          </span>
          <span className="whitespace-nowrap" dir="auto">{to || "—"}</span>
        </p>
      </div>
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
