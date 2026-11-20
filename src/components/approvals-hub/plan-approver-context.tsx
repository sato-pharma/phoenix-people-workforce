"use client";

import { useEffect, useState } from "react";
import { LANDING_INK, LandingEmpty, LandingPanel } from "@/components/employee-portal/landing-kit";

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

// The kit's tile: a white cell on a hairline grid, the figure in its own colour, the label in small
// capitals under it — never a tinted box.
const STATS: Array<{ key: keyof ContextData["attendance"]; label: string; cls: string }> = [
  { key: "completeDays", label: "Complete", cls: "text-emerald-700" },
  { key: "lateDays", label: "Late", cls: "text-amber-700" },
  { key: "absentDays", label: "Absent", cls: "text-rose-700" },
  { key: "shortDays", label: "Short", cls: LANDING_INK },
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
    <LandingPanel title="Employee context · last 30 days">
      {state === "loading" ? (
        <LandingEmpty>Loading context…</LandingEmpty>
      ) : state === "unavailable" || !data ? (
        <LandingEmpty>Context unavailable for this employee.</LandingEmpty>
      ) : (
        <div className="space-y-3 px-3 py-3 @container sm:px-4">
          <div className="grid grid-cols-2 gap-px border border-slate-200 bg-slate-200 @sm:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.key} className="bg-white px-2 py-2 text-center">
                <p className={`text-base font-black leading-none tabular-nums ${s.cls}`}>{data.attendance[s.key]}</p>
                <p className="mt-1 break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{s.label}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-phx-xs text-slate-600">
            <span>
              <span className={`font-bold tabular-nums ${LANDING_INK}`}>{data.attendance.deductionDays}</span> deduction day
              {data.attendance.deductionDays === 1 ? "" : "s"}
            </span>
            <span>
              <span className={`font-bold tabular-nums ${LANDING_INK}`}>{data.recentLeave.length}</span> recent leave decision
              {data.recentLeave.length === 1 ? "" : "s"}
            </span>
            <span>
              <span className={`font-bold tabular-nums ${LANDING_INK}`}>{data.recentExcuses.length}</span> recent excuse
              {data.recentExcuses.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}
    </LandingPanel>
  );
}
