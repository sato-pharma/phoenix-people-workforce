"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { formatDateValue } from "@/lib/i18n/format";
import { evaluatorRoleLabel } from "@/lib/probation/intelligence/evaluator-role-label";
import type { FeedbackSlaState } from "@/lib/probation/intelligence/feedback-sla";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

// Manager feedback inbox (Enhancement E2; retargeted in module completion C2). A "My feedback tasks"
// section on the probation portal page. Owner UX rule (2026-07-17): DO NOT list one flat row per
// Double-Visit day — that repeats the same 2 probationer names 20+ times. Instead show ONE card per
// PROBATIONER, and under it the numbered list of that person's still-missing DV-Day feedbacks, each
// deep-linking into the structured DV-Day feedback form (/employee-portals/probation/feedback/[dvDayId]).
//
// Owner rule (2026-07-18): Training Manager feedback is OPTIONAL — a TM-evaluated DV-day is shown as
// "Optional" (a TM may still submit if they want) and is NEVER counted as overdue or SLA-pressured.

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

// Evaluator roles whose feedback is OPTIONAL (no SLA / not required). Training Manager only, per owner.
const OPTIONAL_EVALUATOR_ROLES = new Set(["tm"]);
function isOptional(t: FeedbackTaskView): boolean {
  return t.evaluatorRole != null && OPTIONAL_EVALUATOR_ROLES.has(t.evaluatorRole);
}

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
  if (t.slaState === "overdue") {
    const hours = Math.round(t.hoursOverdue);
    if (hours < 24) return `${hours}h overdue`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} overdue`;
  }
  if (t.hoursUntilDue <= 0) return "due now";
  const h = Math.round(t.hoursUntilDue);
  return h >= 24 ? `${Math.round(h / 24)}d left` : `${h}h left`;
}

type ProbationerGroup = {
  employeeHrId: string;
  employeeName: string | null;
  items: FeedbackTaskView[];
  overdue: number;
  worst: FeedbackSlaState;
};

function groupByProbationer(tasks: FeedbackTaskView[]): ProbationerGroup[] {
  const byEmployee = new Map<string, FeedbackTaskView[]>();
  for (const task of tasks) {
    const arr = byEmployee.get(task.employeeHrId) ?? [];
    arr.push(task);
    byEmployee.set(task.employeeHrId, arr);
  }
  const groups: ProbationerGroup[] = [];
  for (const [employeeHrId, items] of byEmployee) {
    // Required (SLA) tasks first — by SLA severity; optional (TM) tasks always sort last.
    items.sort(
      (a, b) =>
        Number(isOptional(a)) - Number(isOptional(b)) ||
        SLA_ORDER[a.slaState] - SLA_ORDER[b.slaState] ||
        a.dvDate.localeCompare(b.dvDate),
    );
    // Worst SLA + overdue count are computed over REQUIRED tasks only — an optional TM task must never
    // make a probationer look overdue.
    const required = items.filter((t) => !isOptional(t));
    const worst = required.reduce<FeedbackSlaState>(
      (acc, t) => (SLA_ORDER[t.slaState] < SLA_ORDER[acc] ? t.slaState : acc),
      "pending",
    );
    groups.push({
      employeeHrId,
      employeeName: items.find((t) => t.employeeName)?.employeeName ?? null,
      items,
      overdue: required.filter((t) => t.slaState === "overdue").length,
      worst,
    });
  }
  // Worst-SLA probationer first, then by name.
  groups.sort(
    (a, b) =>
      SLA_ORDER[a.worst] - SLA_ORDER[b.worst] ||
      (a.employeeName ?? a.employeeHrId).localeCompare(b.employeeName ?? b.employeeHrId),
  );
  return groups;
}

export function ProbationFeedbackTasksPanel({ tasks }: { tasks: FeedbackTaskView[] }) {
  const [open, setOpen] = useState(true);
  const groups = useMemo(() => groupByProbationer(tasks), [tasks]);

  if (tasks.length === 0) return null;
  // Optional (TM) tasks never count as overdue.
  const overdue = tasks.filter((t) => !isOptional(t) && t.slaState === "overdue").length;

  return (
    <section className={`rounded-lg border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          My feedback tasks
          <span className="rounded-full bg-phx-ink px-2 py-0.5 text-xs font-medium text-white">
            {groups.length} {groups.length === 1 ? "rep" : "reps"} · {tasks.length} pending
          </span>
          {overdue > 0 && (
            <span className="rounded-full bg-phx-danger px-2 py-0.5 text-xs font-medium text-white">{overdue} overdue</span>
          )}
        </span>
        <span className="text-xs text-slate-400">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {groups.map((group) => (
            <li key={group.employeeHrId} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-800">{group.employeeName ?? group.employeeHrId}</span>
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-slate-500">
                    {group.items.length} feedback{group.items.length === 1 ? "" : "s"} pending
                  </span>
                  {group.overdue > 0 && (
                    <span className="rounded-full bg-rose-600 px-2 py-0.5 font-medium text-white">{group.overdue} overdue</span>
                  )}
                </span>
              </div>

              <ol className="mt-2 space-y-1.5">
                {group.items.map((t, index) => {
                  const optional = isOptional(t);
                  return (
                    <li
                      key={t.dvDayId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-100 bg-slate-50/60 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-700">
                            Feedback {index + 1} — {optional ? "optional" : "missing"}
                          </span>
                          {optional ? (
                            <span className="inline-flex items-center rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-phx-2xs font-medium text-slate-600">
                              Optional
                            </span>
                          ) : (
                            <span
                              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-phx-2xs font-medium ${SLA_STYLE[t.slaState]}`}
                            >
                              {SLA_LABEL[t.slaState]} · {timing(t)}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500">
                          {/* visit_count 0 = a scorecard opened by hand (manual-dv-day.ts), not a
                              captured field day that found nothing. */}
                          {t.visitCount === 0
                            ? `Scorecard opened ${formatDateValue(t.dvDate)}`
                            : `Double-Visit ${formatDateValue(t.dvDate)} · ${t.visitCount} visit${t.visitCount === 1 ? "" : "s"}`}
                          {t.evaluatorRole ? ` · as ${evaluatorRoleLabel(t.evaluatorRole)}` : ""}
                        </div>
                      </div>
                      <Link
                        href={`/employee-portals/probation/feedback/${encodeURIComponent(t.dvDayId)}`}
                        className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
                      >
                        Give feedback
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
