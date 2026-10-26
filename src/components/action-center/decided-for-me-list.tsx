"use client";

import { AlertTriangle, UserCheck } from "lucide-react";

import { adminPanelClassName } from "@/components/admin/admin-design-system";
import { HISTORY_MODULE_LABELS } from "@/components/action-center/types";
import type { DecidedForMeItem } from "@/lib/action-center/decided-for-me";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

// Square corners throughout — house rule, no rounded or semi-round corners anywhere. The
// sibling HistoricalApprovalsList still carries `rounded-full` pills from before that rule;
// do not copy them here.
const DECISION_CLASSES: Record<DecidedForMeItem["decision"], string> = {
  approved: "border-emerald-200/80 bg-emerald-50 text-emerald-700",
  rejected: "border-rose-200/80 bg-rose-50 text-rose-700",
  returned: "border-orange-200/80 bg-orange-50 text-orange-700",
};

const DECISION_LABEL: Record<DecidedForMeItem["decision"], string> = {
  approved: "Approved",
  rejected: "Rejected",
  returned: "Returned",
};

const BASIS_LABEL: Record<DecidedForMeItem["basis"], string> = {
  team: "Your team",
  line: "Your line",
};

type Props = {
  items: DecidedForMeItem[];
  windowDays: number;
  // The lookup failed. Distinct from an empty list on purpose: telling a manager back from leave
  // that "nobody decided anything for you" when the query never ran is the one wrong answer this
  // tab must never give. Measured on production 2026-09-07 — a transient directory failure
  // returned an empty list where the true answer was eight items.
  failed?: boolean;
};

/** Africa/Cairo, never the raw UTC instant — house rule for every time shown to a reader. */
function formatDecidedAt(iso: string): string {
  if (!iso) return "—";
  try {
    return stableEnGbFormatter({
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Africa/Cairo",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function DecidedForMeList({ items, windowDays, failed }: Props) {
  if (failed) {
    return (
      <div className={`flex min-h-[420px] flex-col items-center justify-center gap-5 p-12 text-center ${adminPanelClassName}`}>
        <div className="flex h-20 w-20 items-center justify-center bg-amber-50 text-amber-600 ring-1 ring-amber-200">
          <AlertTriangle className="h-9 w-9" />
        </div>
        <div>
          <p className="text-xl font-black tracking-tight text-slate-900">Could not load this list</p>
          <p className="mt-1.5 max-w-sm text-sm leading-6 text-slate-500">
            Something went wrong fetching what was decided for you, so this is <strong>not</strong> a
            statement that nothing happened. Reload the page, and tell IT if it keeps failing.
          </p>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={`flex min-h-[420px] flex-col items-center justify-center gap-5 p-12 text-center ${adminPanelClassName}`}>
        <div className="flex h-20 w-20 items-center justify-center bg-slate-50 text-slate-400 ring-1 ring-slate-200/70">
          <UserCheck className="h-9 w-9" />
        </div>
        <div>
          <p className="text-xl font-black tracking-tight text-slate-900">Nobody decided anything for you</p>
          <p className="mt-1.5 max-w-sm text-sm leading-6 text-slate-500">
            When someone covers for you — while you are on leave, or when an administrator steps in —
            what they decided on your team and your lines is listed here, so nothing that happened in
            your absence stays invisible.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={adminPanelClassName}>
      <div className="border-b border-[#E5EAF1] px-5 py-3">
        <p className="text-sm font-black tracking-tight text-slate-900">Decided for you</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          {items.length} decision{items.length === 1 ? "" : "s"} taken by someone else on your team and
          your lines in the last {windowDays} days. These are already final — this list is here so you
          know what happened, not because it needs an action from you.
        </p>
      </div>
      <div className="divide-y divide-[#E5EAF1]">
        {items.map((item) => (
          <div key={item.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center border px-2 py-0.5 text-phx-2xs font-black uppercase tracking-wide ${DECISION_CLASSES[item.decision]}`}
                >
                  {DECISION_LABEL[item.decision]}
                </span>
                <span className="border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-2xs font-semibold uppercase tracking-wide text-slate-500">
                  {HISTORY_MODULE_LABELS[item.module]}
                </span>
                <span className="border border-slate-200 bg-white px-1.5 py-0.5 text-phx-2xs font-semibold uppercase tracking-wide text-slate-400">
                  {BASIS_LABEL[item.basis]}
                </span>
              </div>
              <p className="text-sm font-semibold text-slate-900">{item.title}</p>
              <p className="text-xs text-slate-500">{item.employeeName}</p>
              <p className="text-xs font-semibold text-slate-600">
                Decided by {item.decidedByName || item.decidedByHrId}
              </p>
              {item.decidedNote ? (
                // Their words, in full. Never truncated and never ellipsised (house rule), and
                // `whitespace-pre-line` because these notes are typed with real line breaks —
                // collapsing them turns a greeting and an instruction into one run-on sentence.
                <p className="mt-1 border-l-2 border-slate-300 bg-slate-50 px-2.5 py-1.5 text-xs leading-5 text-slate-700 whitespace-pre-line break-words">
                  {item.decidedNote}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <span className="text-xs text-slate-400">{formatDecidedAt(item.decidedAt)}</span>
              {item.href ? (
                <a
                  href={item.href}
                  className="border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  View request
                </a>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
