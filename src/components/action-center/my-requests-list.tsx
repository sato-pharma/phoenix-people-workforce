"use client";

import { ClipboardList } from "lucide-react";

import { adminPanelClassName } from "@/components/admin/admin-design-system";
import type { MyRequestItem, MyRequestStatusTone } from "@/components/action-center/types";
import { MY_REQUEST_MODULE_LABELS } from "@/components/action-center/types";

const TONE_CLASSES: Record<MyRequestStatusTone, string> = {
  pending: "border-amber-200/80 bg-amber-50 text-amber-800",
  approved: "border-emerald-200/80 bg-emerald-50 text-emerald-700",
  rejected: "border-rose-200/80 bg-rose-50 text-rose-700",
  returned: "border-orange-200/80 bg-orange-50 text-orange-700",
  neutral: "border-slate-200 bg-slate-50 text-slate-600",
};

const TONE_DOTS: Record<MyRequestStatusTone, string> = {
  pending: "bg-amber-500",
  approved: "bg-emerald-500",
  rejected: "bg-rose-500",
  returned: "bg-orange-500",
  neutral: "bg-slate-400",
};

type Props = {
  initialId?: string | null;
  initialModule?: string | null;
  items: MyRequestItem[];
};

function matchesDeepLink(item: MyRequestItem, module: string | null | undefined, id: string | null | undefined) {
  if (!id) return false;
  return item.id === id || item.id === `${module ?? item.module}:${id}`;
}

export function MyRequestsList({ initialId, initialModule, items }: Props) {
  const linkedItem = initialId ? items.find((item) => matchesDeepLink(item, initialModule, initialId)) ?? null : null;
  const orderedItems = linkedItem ? [linkedItem, ...items.filter((item) => item.id !== linkedItem.id)] : items;

  if (items.length === 0) {
    return (
      <div className={`flex min-h-[420px] flex-col items-center justify-center gap-5 p-12 text-center ${adminPanelClassName}`}>
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-slate-50 to-slate-100 text-slate-400 ring-1 ring-slate-200/70 shadow-[0_12px_30px_rgba(15,23,42,0.06)]">
          <ClipboardList className="h-9 w-9" />
        </div>
        <div>
          <p className="text-xl font-black tracking-tight text-slate-900">No requests yet</p>
          <p className="mt-1.5 max-w-sm text-sm leading-6 text-slate-500">
            Anything you submit — vacation, excuse, outstation, weekly plan, or resignation — shows here with its live approval status.
          </p>
        </div>
      </div>
    );
  }

  if (initialId && !linkedItem) {
    return (
      <div className={`flex min-h-[420px] flex-col items-center justify-center gap-5 p-12 text-center ${adminPanelClassName}`}>
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-amber-50 to-amber-100 text-amber-500 ring-1 ring-amber-200/70 shadow-[0_12px_30px_rgba(245,158,11,0.12)]">
          <ClipboardList className="h-9 w-9" />
        </div>
        <div>
          <p className="text-xl font-black tracking-tight text-slate-900">Request not found</p>
          <p className="mt-1.5 max-w-sm text-sm leading-6 text-slate-500">
            The request from this notification is not available in your current Action Center view.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`overflow-hidden divide-y divide-[#EEF2F7] ${adminPanelClassName}`}>
      {orderedItems.map((item) => (
        <div
          key={item.id}
          className={`flex flex-col gap-2 px-4 py-3.5 transition-colors hover:bg-slate-50/70 sm:flex-row sm:items-start sm:justify-between sm:px-5 ${
            linkedItem?.id === item.id ? "bg-orange-50/70 ring-1 ring-inset ring-orange-200" : ""
          }`}
        >
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center rounded-full border border-phx-line bg-phx-paper px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-[0.08em] text-phx-ink-soft">
                {MY_REQUEST_MODULE_LABELS[item.module]}
              </span>
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-phx-2xs font-bold ${TONE_CLASSES[item.statusTone]}`}>
                <span className={`h-1 w-1 rounded-full ${TONE_DOTS[item.statusTone]}`} />
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
              <p className="mt-1.5 rounded-r-md border-l-2 border-slate-300 bg-slate-50 px-2.5 py-1 text-phx-xs italic text-slate-600">
                &ldquo;{item.decisionNote}&rdquo;
              </p>
            )}
            {item.href && (
              <a
                className="mt-2 inline-flex rounded-sm border border-slate-200 bg-white px-2.5 py-1 text-phx-xs font-bold text-slate-600 transition hover:bg-slate-50"
                href={item.href}
              >
                Open request
              </a>
            )}
          </div>
          <div className="shrink-0 text-phx-xs font-medium text-slate-400">
            {new Date(item.submittedAt).toLocaleDateString("en", { day: "2-digit", month: "short", year: "numeric" })}
          </div>
        </div>
      ))}
    </div>
  );
}
