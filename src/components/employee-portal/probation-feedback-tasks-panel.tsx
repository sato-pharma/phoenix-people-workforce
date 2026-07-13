"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type { FeedbackSlaState } from "@/lib/probation/intelligence/feedback-sla";

// Manager feedback inbox (Enhancement E2; retargeted in module completion C2). A "My feedback tasks"
// section on the probation portal page: each open, validated Double-Visit day the signed-in manager
// still owes structured feedback on, with an SLA countdown, deep-linking into the structured DV-Day
// feedback form (/employee-portals/probation/feedback/[dvDayId]). Read-only list; capture happens there.

export type FeedbackTaskView = {
  dvDayId: string;
  employeeHrId: string;
  employeeName: string | null;
  evaluatorRole: string | null;
  dvDate: string;
  visitCount: number;
  slaState: FeedbackSlaState;
  hoursUntilDue: number;
  hoursOverdue: number;
};

const SLA_STYLE: Record<FeedbackSlaState, string> = {
  pending: "bg-slate-100 text-slate-600 border-slate-200",
  due: "bg-amber-50 text-amber-700 border-amber-200",
  escalated: "bg-orange-50 text-orange-700 border-orange-200",
  overdue: "bg-rose-50 text-rose-700 border-rose-200",
};

const SLA_LABEL: Record<FeedbackSlaState, string> = {
  pending: "On time",
  due: "Due",
  escalated: "Escalated",
  overdue: "Overdue",
};

// Rank overdue → escalated → due → pending, then soonest-due first.
const SLA_ORDER: Record<FeedbackSlaState, number> = { overdue: 0, escalated: 1, due: 2, pending: 3 };

function timing(t: FeedbackTaskView): string {
  if (t.slaState === "overdue") return `${Math.round(t.hoursOverdue)}h overdue`;
  if (t.hoursUntilDue <= 0) return "due now";
  const h = Math.round(t.hoursUntilDue);
  return h >= 24 ? `${Math.round(h / 24)}d left` : `${h}h left`;
}

export function ProbationFeedbackTasksPanel({ tasks }: { tasks: FeedbackTaskView[] }) {
  const [open, setOpen] = useState(true);

  const sorted = useMemo(
    () =>
      [...tasks].sort(
        (a, b) => SLA_ORDER[a.slaState] - SLA_ORDER[b.slaState] || a.dvDate.localeCompare(b.dvDate),
      ),
    [tasks],
  );

  if (tasks.length === 0) return null;
  const overdue = tasks.filter((t) => t.slaState === "overdue").length;

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          My feedback tasks
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-medium text-white">{tasks.length}</span>
          {overdue > 0 && (
            <span className="rounded-full bg-rose-600 px-2 py-0.5 text-xs font-medium text-white">{overdue} overdue</span>
          )}
        </span>
        <span className="text-xs text-slate-400">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {sorted.map((t) => (
            <li key={t.dvDayId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-800">{t.employeeName ?? t.employeeHrId}</span>
                  <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${SLA_STYLE[t.slaState]}`}>
                    {SLA_LABEL[t.slaState]} · {timing(t)}
                  </span>
                </div>
                <div className="text-xs text-slate-500">
                  Double-Visit {t.dvDate} · {t.visitCount} visit{t.visitCount === 1 ? "" : "s"}
                  {t.evaluatorRole ? ` · as ${t.evaluatorRole}` : ""}
                </div>
              </div>
              <Link
                href={`/employee-portals/probation/feedback/${encodeURIComponent(t.dvDayId)}`}
                className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
              >
                Give feedback
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
