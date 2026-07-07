"use client";

import { useCallback, useEffect, useState } from "react";

type ExpenseCandidate = {
  id: string;
  employeeHrId: string;
  employeeName: string | null;
  dateFrom: string;
  dateTo: string;
  locationFrom: string;
  locationTo: string;
  km: number | null;
  type: string;
  travelCost: number;
  allowance: number;
  existingDecision: { decision: "include" | "defer"; decidedAt: string } | null;
};

function egp(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Request failed.");
  return data;
}

/**
 * The Expenses review tab — full detail per HR-approved outstation expense
 * request (date range, locations, distance, type, cost breakdown), with a
 * 2-way decision: include this payroll run, or defer to next month. Reads
 * from outstation_expense_requests (the live system, status='approved'
 * only), writes to payroll_copilot_expense_decisions — never touches the
 * source request. Replaces the old vague "has an expense not yet approved"
 * chat question.
 */
export function ExpensesTab({ runId }: { runId: string }) {
  const [rows, setRows] = useState<ExpenseCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/payroll/copilot/${runId}/deductions/expenses`, {
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => ({}))) as { candidates?: ExpenseCandidate[]; message?: string };
      if (!res.ok) throw new Error(data.message ?? "Failed to load.");
      setRows(data.candidates ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, [runId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, matches the established pattern elsewhere in this codebase
    void load();
  }, [load]);

  async function decide(candidate: ExpenseCandidate, decision: "include" | "defer") {
    setBusyId(candidate.id);
    setError(null);
    try {
      await postJson(`/api/payroll/copilot/${runId}/deductions/expenses`, {
        requestId: candidate.id,
        employeeHrId: candidate.employeeHrId,
        dateFrom: candidate.dateFrom,
        dateTo: candidate.dateTo,
        locationFrom: candidate.locationFrom,
        locationTo: candidate.locationTo,
        km: candidate.km,
        type: candidate.type,
        travelCost: candidate.travelCost,
        allowance: candidate.allowance,
        decision,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save decision.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="h-4 w-1 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
          Expenses {rows ? `(${rows.length})` : ""}
        </span>
        <a
          href={`/api/payroll/copilot/${runId}/deductions/expenses?format=xlsx`}
          className="border border-slate-500 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-800"
        >
          Download xlsx
        </a>
      </div>
      {error ? (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div>
      ) : null}
      {!rows ? (
        <p className="px-4 py-6 text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">No HR-approved expense requests for this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2">Employee</th>
                <th className="px-4 py-2">Date From</th>
                <th className="px-4 py-2">Date To</th>
                <th className="px-4 py-2">Location From</th>
                <th className="px-4 py-2">Location To</th>
                <th className="px-4 py-2">KM</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Travel Cost</th>
                <th className="px-4 py-2">Allowance</th>
                <th className="px-4 py-2">Decision</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const busy = busyId === row.id;
                const current = row.existingDecision?.decision ?? null;
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-2 text-slate-700">
                      {row.employeeName ?? row.employeeHrId}{" "}
                      <span className="text-slate-400">({row.employeeHrId})</span>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{row.dateFrom}</td>
                    <td className="px-4 py-2 text-slate-600">{row.dateTo}</td>
                    <td className="px-4 py-2 text-slate-600">{row.locationFrom}</td>
                    <td className="px-4 py-2 text-slate-600">{row.locationTo}</td>
                    <td className="px-4 py-2 text-slate-600">{row.km ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-600">{row.type}</td>
                    <td className="px-4 py-2 font-medium text-slate-900">{egp(row.travelCost)}</td>
                    <td className="px-4 py-2 font-medium text-slate-900">{egp(row.allowance)}</td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => decide(row, "include")}
                          className={`px-2 py-1 text-xs font-semibold disabled:opacity-50 ${
                            current === "include"
                              ? "bg-emerald-600 text-white"
                              : "border border-slate-300 text-slate-700 hover:bg-slate-100"
                          }`}
                        >
                          Include this run
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => decide(row, "defer")}
                          className={`px-2 py-1 text-xs font-semibold disabled:opacity-50 ${
                            current === "defer"
                              ? "bg-slate-900 text-white"
                              : "border border-slate-300 text-slate-700 hover:bg-slate-100"
                          }`}
                        >
                          Defer to next month
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
