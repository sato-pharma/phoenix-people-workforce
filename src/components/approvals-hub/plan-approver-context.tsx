"use client";

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";

// Decision-support panel for the approver: the employee's recent attendance + leave/excuse history,
// so a plan is judged in context. Reuses the existing /api/approvals-hub/employee-context endpoint
// (no new backend). Shown to approvers only — never to the submitter viewing their own plan.

type ContextData = {
  attendance: {
    completeDays: number;
    lateDays: number;
    absentDays: number;
    shortDays: number;
    deductionDays: number;
    dateFrom: string;
    dateTo: string;
  };
  recentLeave: Array<{ vacationType: string; startDate: string; endDate: string }>;
  recentExcuses: Array<{ excuseDate: string; excuseType: string }>;
};

const STATS: Array<{ key: keyof ContextData["attendance"]; label: string; cls: string }> = [
  { key: "completeDays", label: "Complete", cls: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  { key: "lateDays", label: "Late", cls: "border-amber-200 bg-amber-50 text-amber-800" },
  { key: "absentDays", label: "Absent", cls: "border-rose-200 bg-rose-50 text-rose-800" },
  { key: "shortDays", label: "Short", cls: "border-slate-200 bg-white text-slate-700" },
];

export function PlanApproverContext({ employeeHrId }: { employeeHrId: string }) {
  const [data, setData] = useState<ContextData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/approvals-hub/employee-context?hrId=${encodeURIComponent(employeeHrId)}`, {
          headers: { Accept: "application/json" },
        });
        const json = (await res.json().catch(() => null)) as (ContextData & { error?: string }) | null;
        if (!alive) return;
        if (!res.ok || !json || json.error || !json.attendance) {
          setState("unavailable");
          return;
        }
        setData(json);
        setState("ready");
      } catch {
        if (alive) setState("unavailable");
      }
    })();
    return () => {
      alive = false;
    };
  }, [employeeHrId]);

  return (
    <section className="border border-phx-line bg-white">
      <header className="flex items-center gap-1.5 border-b border-phx-line bg-slate-900 px-4 py-2.5">
        <Activity className="h-3.5 w-3.5 text-white" />
        <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">Employee context · last 30 days</h3>
      </header>
      <div className="px-4 py-3">
        {state === "loading" ? (
          <p className="text-sm text-slate-400">Loading context…</p>
        ) : state === "unavailable" || !data ? (
          <p className="text-sm text-slate-400">Context unavailable for this employee.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2">
              {STATS.map((s) => (
                <div key={s.key} className={`border px-2 py-1.5 text-center ${s.cls}`}>
                  <p className="text-base font-black leading-none">{data.attendance[s.key]}</p>
                  <p className="mt-1 text-[10px] font-bold uppercase tracking-wide opacity-80">{s.label}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
              <span>
                <span className="font-bold text-slate-900">{data.attendance.deductionDays}</span> deduction day
                {data.attendance.deductionDays === 1 ? "" : "s"}
              </span>
              <span>
                <span className="font-bold text-slate-900">{data.recentLeave.length}</span> recent leave decision
                {data.recentLeave.length === 1 ? "" : "s"}
              </span>
              <span>
                <span className="font-bold text-slate-900">{data.recentExcuses.length}</span> recent excuse
                {data.recentExcuses.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
