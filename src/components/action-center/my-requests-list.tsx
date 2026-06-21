"use client";

import { CheckCircle2 } from "lucide-react";

import { adminPanelClassName } from "@/components/admin/admin-design-system";
import type { MyRequestItem, MyRequestStatusTone } from "@/components/action-center/types";
import { MY_REQUEST_MODULE_LABELS } from "@/components/action-center/types";

const TONE_CLASSES: Record<MyRequestStatusTone, string> = {
  pending: "border-amber-300 bg-amber-50 text-amber-800",
  approved: "border-emerald-300 bg-emerald-50 text-emerald-800",
  rejected: "border-rose-300 bg-rose-50 text-rose-800",
  returned: "border-orange-300 bg-orange-50 text-orange-800",
  neutral: "border-slate-300 bg-slate-50 text-slate-700",
};

export function MyRequestsList({ items }: { items: MyRequestItem[] }) {
  if (items.length === 0) {
    return (
      <div className={`flex min-h-[420px] flex-col items-center justify-center gap-4 p-12 text-center ${adminPanelClassName}`}>
        <div className="flex h-16 w-16 items-center justify-center border border-emerald-200 bg-emerald-50 text-emerald-600">
          <CheckCircle2 className="h-9 w-9" />
        </div>
        <div>
          <p className="text-lg font-black text-slate-900">No requests yet</p>
          <p className="mt-1 max-w-sm text-sm text-slate-500">
            Anything you submit — vacation, excuse, outstation, weekly plan, or resignation — shows here with its live approval status.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`divide-y divide-slate-100 ${adminPanelClassName}`}>
      {items.map((item) => (
        <div key={item.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-600">
                {MY_REQUEST_MODULE_LABELS[item.module]}
              </span>
              <span className={`inline-flex items-center border px-2 py-0.5 text-[10px] font-bold ${TONE_CLASSES[item.statusTone]}`}>
                {item.statusLabel}
              </span>
            </div>
            <p className="text-sm font-bold text-slate-900">{item.title}</p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
              {item.lines.map((line) => (
                <span key={line.label}>
                  <span className="font-semibold text-slate-600">{line.label}:</span> {line.value}
                </span>
              ))}
            </div>
            {item.decisionNote && (
              <p className="mt-1.5 border-l-2 border-slate-300 bg-slate-50 px-2 py-1 text-[11px] italic text-slate-600">
                &ldquo;{item.decisionNote}&rdquo;
              </p>
            )}
          </div>
          <div className="shrink-0 text-[11px] text-slate-400">
            {new Date(item.submittedAt).toLocaleDateString("en", { day: "2-digit", month: "short", year: "numeric" })}
          </div>
        </div>
      ))}
    </div>
  );
}
