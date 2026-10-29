"use client";

import { PortalDesktopTable, PortalResponsiveDataList } from "@/components/employee-portal/portal-primitives";
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
  const [sourceMonthLabel, setSourceMonthLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/payroll/copilot/${runId}/deductions/expenses`, {
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => ({}))) as {
        candidates?: ExpenseCandidate[];
        sourceMonthLabel?: string;
        message?: string;
      };
      if (!res.ok) throw new Error(data.message ?? "Failed to load.");
      setRows(data.candidates ?? []);
      setSourceMonthLabel(data.sourceMonthLabel ?? null);
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

  const decisionButtons = (row: ExpenseCandidate) => {
    const busy = busyId === row.id;
    const current = row.existingDecision?.decision ?? null;
    return (
      <div className="flex flex-wrap gap-1">
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
    );
  };

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
      {sourceMonthLabel ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          Expenses lag one month: this payroll pays out HR-approved outstation requests from{" "}
          <strong>{sourceMonthLabel}</strong>, not the payroll month itself.
        </div>
      ) : null}
      {!rows ? (
        <p className="px-4 py-6 text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          No HR-approved expense requests for {sourceMonthLabel ?? "the prior month"}.
        </p>
      ) : (
        <PortalResponsiveDataList
          empty={null}
          getKey={(row) => row.id}
          items={rows}
          renderCard={(row) => (
            <div className="space-y-1.5 px-4 py-3 text-sm">
              <p className="break-words font-medium text-slate-800">{row.employeeName ?? "—"}</p>
              <p className="break-words text-xs text-slate-600">
                {row.dateFrom} → {row.dateTo} · {row.locationFrom} → {row.locationTo}
              </p>
              <p className="text-xs text-slate-600">
                {row.type}
                {row.km != null ? ` · ${row.km} km` : ""}
              </p>
              <p className="text-xs text-slate-900">
                Travel cost <span className="font-medium">{egp(row.travelCost)}</span> · Allowance{" "}
                <span className="font-medium">{egp(row.allowance)}</span>
              </p>
              {decisionButtons(row)}
            </div>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[16%]" />
                  <col className="w-[14%]" />
                  <col className="w-[22%]" />
                  <col className="w-[12%]" />
                  <col className="w-[14%]" />
                  <col className="w-[22%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2">Employee</th>
                  <th className="px-4 py-2">Dates</th>
                  <th className="px-4 py-2">Route</th>
                  <th className="px-4 py-2">Type / KM</th>
                  <th className="px-4 py-2">Travel cost / Allowance</th>
                  <th className="px-4 py-2">Decision</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="break-words px-4 py-2 text-slate-700">{row.employeeName ?? "—"}</td>
                    <td className="break-words px-4 py-2 text-slate-600">
                      <p>{row.dateFrom}</p>
                      <p>{row.dateTo}</p>
                    </td>
                    <td className="break-words px-4 py-2 text-slate-600">
                      <p>{row.locationFrom}</p>
                      <p>{row.locationTo}</p>
                    </td>
                    <td className="break-words px-4 py-2 text-slate-600">
                      <p>{row.type}</p>
                      <p>{row.km != null ? `${row.km} km` : "—"}</p>
                    </td>
                    <td className="break-words px-4 py-2 font-medium text-slate-900">
                      <p>{egp(row.travelCost)}</p>
                      <p>{egp(row.allowance)}</p>
                    </td>
                    <td className="px-4 py-2">{decisionButtons(row)}</td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      )}
    </div>
  );
}
