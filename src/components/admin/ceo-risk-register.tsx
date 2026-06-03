import { AlertCircle, ShieldCheck } from "lucide-react";

import { adminPanelClassName } from "@/components/admin/admin-design-tokens";
import type { RiskRegister, RiskRow, RiskSeverity } from "@/lib/ceo/risk";
import { formatDateShort, formatNumber } from "@/lib/ceo/format";

const SEVERITY_STYLES: Record<RiskSeverity, { label: string; badge: string; bar: string }> = {
  critical: { label: "Critical", badge: "border-rose-200 bg-rose-100 text-rose-700", bar: "bg-rose-500" },
  warning: { label: "Warning", badge: "border-amber-200 bg-amber-100 text-amber-700", bar: "bg-amber-500" },
  watch: { label: "Watch", badge: "border-sky-200 bg-sky-100 text-sky-700", bar: "bg-sky-500" },
};

function RiskCard({ row }: { row: RiskRow }) {
  const severity = SEVERITY_STYLES[row.severity];
  return (
    <div className="relative min-w-0 overflow-hidden rounded-[16px] border border-[#E5EAF1] bg-gradient-to-br from-white to-slate-50/40 p-4 shadow-[0_6px_18px_rgba(15,23,42,0.035)] transition-shadow hover:shadow-[0_12px_28px_rgba(15,23,42,0.08)]">
      <div className={`absolute inset-y-0 left-0 w-1 ${severity.bar}`} />
      <div className="flex flex-wrap items-start justify-between gap-2 pl-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${severity.badge}`}>
              {severity.label}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">{row.category}</span>
          </div>
          <p className="mt-2 text-sm font-semibold text-slate-900">{row.title}</p>
          {row.entity ? <p className="truncate text-xs text-slate-500">{row.entity}</p> : null}
          <p className="mt-1 text-xs text-slate-500">{row.impact}</p>
        </div>
        <div className="shrink-0 text-right">
          {row.dueDate ? <p className="text-xs font-medium text-slate-700">Due {formatDateShort(row.dueDate)}</p> : null}
          {typeof row.days === "number" ? (
            <p className="text-[11px] text-slate-400">
              {row.days >= 0 ? `${formatNumber(row.days)} day(s) left` : `${formatNumber(Math.abs(row.days))} day(s) overdue`}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pl-2 pt-2 text-[11px] text-slate-500">
        <span>
          Owner: <span className="font-medium text-slate-700">{row.owner}</span>
        </span>
        <span>{row.source}</span>
      </div>
    </div>
  );
}

export function CeoRiskRegister({ register }: { register: RiskRegister }) {
  return (
    <section className={`group relative min-w-0 overflow-hidden ${adminPanelClassName} bg-gradient-to-br from-white to-slate-50/40 p-5`}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-orange-400/0 via-orange-400/40 to-orange-400/0" />
      <header className="mb-4 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-50 text-orange-600">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Strategic Risk Register</h2>
      </header>
      {register.rows.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-[16px] border border-emerald-200 bg-emerald-50 py-8 text-sm text-emerald-600">
          <ShieldCheck className="h-4 w-4" /> No active strategic risks detected.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {register.rows.map((row) => (
            <RiskCard key={row.id} row={row} />
          ))}
        </div>
      )}
      {register.unavailableSources.length > 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <span>Unavailable risk feeds (shown as unavailable, not zero): {register.unavailableSources.join(" · ")}</span>
        </div>
      ) : null}
    </section>
  );
}
