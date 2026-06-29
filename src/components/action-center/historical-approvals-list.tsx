"use client";

import { Clock } from "lucide-react";

import { adminPanelClassName } from "@/components/admin/admin-design-system";
import type { HistoricalApprovalItem } from "@/components/action-center/types";
import { ACTION_HUB_MODULE_LABELS } from "@/components/action-center/types";

const DECISION_CLASSES: Record<HistoricalApprovalItem["decision"], string> = {
  approved: "border-emerald-200/80 bg-emerald-50 text-emerald-700",
  rejected: "border-rose-200/80 bg-rose-50 text-rose-700",
  returned: "border-orange-200/80 bg-orange-50 text-orange-700",
};

const DECISION_DOTS: Record<HistoricalApprovalItem["decision"], string> = {
  approved: "bg-emerald-500",
  rejected: "bg-rose-500",
  returned: "bg-orange-500",
};

const DECISION_LABEL: Record<HistoricalApprovalItem["decision"], string> = {
  approved: "Approved",
  rejected: "Rejected",
  returned: "Returned",
};

type Props = {
  items: HistoricalApprovalItem[];
};

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function HistoricalApprovalsList({ items }: Props) {
  if (items.length === 0) {
    return (
      <div className={`flex min-h-[420px] flex-col items-center justify-center gap-5 p-12 text-center ${adminPanelClassName}`}>
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-slate-50 to-slate-100 text-slate-400 ring-1 ring-slate-200/70 shadow-[0_12px_30px_rgba(15,23,42,0.06)]">
          <Clock className="h-9 w-9" />
        </div>
        <div>
          <p className="text-xl font-black tracking-tight text-slate-900">No approval history yet</p>
          <p className="mt-1.5 max-w-sm text-sm leading-6 text-slate-500">
            Every leave, excuse, plan, or resignation you approve or reject will appear here with the decision date.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`divide-y divide-[#E5EAF1] ${adminPanelClassName}`}>
      {items.map((item) => (
        <div key={item.id} className="flex flex-col gap-1.5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${DECISION_CLASSES[item.decision]}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${DECISION_DOTS[item.decision]}`} />
                {DECISION_LABEL[item.decision]}
              </span>
              <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                {ACTION_HUB_MODULE_LABELS[item.module]}
              </span>
            </div>
            <p className="text-sm font-semibold text-slate-900">{item.title}</p>
            <p className="text-xs text-slate-500">
              {item.employeeName}
              {item.employeeHrId ? <span className="ml-1 text-slate-400">({item.employeeHrId})</span> : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-slate-400 whitespace-nowrap">{formatDate(item.decidedAt)}</span>
            {item.href ? (
              <a
                href={item.href}
                className="inline-flex items-center gap-1 border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-orange-300 hover:text-orange-700 transition-colors"
              >
                View request
              </a>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
