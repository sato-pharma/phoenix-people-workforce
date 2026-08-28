"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import type { StuckApprovalManagerOption } from "@/lib/approvals-hub/service";
import type { WeeklyPlanManagerGapRecord } from "@/lib/weekly-planning/drift-check";
import type { ExcuseManagerGapRecord } from "@/lib/excuses/drift-check";

type StuckApprovalsPanelProps = {
  weeklyPlans: WeeklyPlanManagerGapRecord[];
  excuses: ExcuseManagerGapRecord[];
  managerOptions: StuckApprovalManagerOption[];
};

// A single reassignable row: current (dead) approver + a picker for the new active manager. The
// row calls the module's reassign route — reassignment only, it never decides the request.
function ReassignRow(props: {
  primary: string;
  secondary: string;
  currentApprover: string;
  endpoint: string;
  managerOptions: StuckApprovalManagerOption[];
}) {
  const router = useRouter();
  const [newManagerHrId, setNewManagerHrId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function reassign() {
    if (!newManagerHrId) {
      setError("Choose a new manager first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(props.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newManagerHrId }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not reassign this request. It may have already moved on.");
        setBusy(false);
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="border border-phx-line bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900">{props.primary}</p>
          <p className="truncate text-xs text-slate-500">{props.secondary}</p>
          <p className="mt-0.5 text-xs text-rose-600">Stuck on: {props.currentApprover}</p>
        </div>
        {done ? (
          <p className="text-sm font-bold text-emerald-600">Reassigned ✓</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={newManagerHrId}
              onChange={(e) => setNewManagerHrId(e.target.value)}
              disabled={busy}
              className="max-w-[220px] border border-slate-300 px-2 py-1.5 text-sm focus:border-orange-500 focus:outline-none"
            >
              <option value="">Select new manager…</option>
              {props.managerOptions.map((option) => (
                <option key={option.hrId} value={option.hrId}>
                  {option.name} ({option.hrId})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={reassign}
              disabled={busy}
              className="bg-orange-500 px-4 py-1.5 text-sm font-bold text-white hover:bg-orange-600 disabled:opacity-60"
            >
              {busy ? "Reassigning…" : "Reassign"}
            </button>
          </div>
        )}
      </div>
      {error ? <p className="mt-2 text-sm font-semibold text-rose-600">{error}</p> : null}
    </div>
  );
}

function Section(props: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="border border-phx-line bg-white">
      <header className="flex items-center justify-between border-b border-phx-line bg-slate-900 px-4 py-2.5">
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{props.title}</h3>
        <span className="text-phx-xs font-bold text-slate-300">{props.count}</span>
      </header>
      <div className="space-y-2 p-3">{props.children}</div>
    </section>
  );
}

export function StuckApprovalsPanel({ weeklyPlans, excuses, managerOptions }: StuckApprovalsPanelProps) {
  const empty = weeklyPlans.length === 0 && excuses.length === 0;
  if (empty) {
    return (
      <section className="border border-phx-line bg-white px-4 py-8 text-center">
        <p className="text-sm font-bold text-slate-900">No stuck approvals.</p>
        <p className="mt-1 text-xs text-slate-500">
          Every pending plan and excuse currently has an active approver. This surface fills in
          when a manager resigns before deciding.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <Section title="Weekly / Monthly plans" count={weeklyPlans.length}>
        {weeklyPlans.length === 0 ? (
          <p className="px-1 py-2 text-xs text-slate-500">No stuck plans.</p>
        ) : (
          weeklyPlans.map((plan) => (
            <ReassignRow
              key={plan.planId}
              primary={`${plan.employeeName} (${plan.employeeHrId})`}
              secondary={`Status: ${plan.status.replace(/_/g, " ")}`}
              currentApprover={plan.managerName || plan.managerHrId || "no manager on record"}
              endpoint={`/api/weekly-plans/${encodeURIComponent(plan.planId)}/reassign`}
              managerOptions={managerOptions}
            />
          ))
        )}
      </Section>

      <Section title="Excuses" count={excuses.length}>
        {excuses.length === 0 ? (
          <p className="px-1 py-2 text-xs text-slate-500">No stuck excuses.</p>
        ) : (
          excuses.map((excuse) => (
            <ReassignRow
              key={excuse.requestId}
              primary={`${excuse.employeeName} (${excuse.employeeHrId})`}
              secondary={`Excuse date: ${excuse.excuseDate ?? "n/a"}`}
              currentApprover={excuse.managerName || excuse.managerHrId || "no manager on record"}
              endpoint={`/api/excuses/${encodeURIComponent(excuse.requestId)}/reassign`}
              managerOptions={managerOptions}
            />
          ))
        )}
      </Section>
    </div>
  );
}
