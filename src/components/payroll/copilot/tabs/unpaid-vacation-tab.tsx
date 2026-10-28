"use client";

import { PortalDesktopTable, PortalResponsiveDataList } from "@/components/employee-portal/portal-primitives";
import { vacationTypeLabel } from "@/lib/vacation/calculations";
import { useCallback, useEffect, useState } from "react";

type UnpaidVacationCandidate = {
  requestId: string;
  employeeHrId: string;
  employeeName: string | null;
  vacationType: string;
  startDate: string;
  endDate: string;
  unpaidDays: number;
  salaryDeductionAmount: number;
  balanceAvailable: boolean;
  balanceDaysAvailable: number;
  balanceDaysToConsume: number;
  remainingSalaryDays: number;
  remainingSalaryDeductionAmount: number;
  existingSettlement: { method: "salary" | "balance" | "partial_balance" | "defer_to_balance"; decidedAt: string } | null;
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
 * The Unpaid Vacation review tab — 3-way decision per unpaid-leave candidate:
 * deduct from salary (default), deduct from vacation balance instead (only
 * offered when the full amount is actually coverable), or reject (no action
 * this period). Reads/writes payroll_copilot_vacation_settlements — never
 * touches v2_vacation_requests directly.
 */
export function UnpaidVacationTab({ runId }: { runId: string }) {
  const [rows, setRows] = useState<UnpaidVacationCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/payroll/copilot/${runId}/deductions/vacation`, {
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => ({}))) as {
        candidates?: UnpaidVacationCandidate[];
        message?: string;
      };
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

  async function decide(candidate: UnpaidVacationCandidate, method: "salary" | "balance" | "partial_balance" | "defer_to_balance" | "reject") {
    setBusyId(candidate.requestId);
    setError(null);
    try {
      await postJson(`/api/payroll/copilot/${runId}/deductions/vacation`, {
        requestId: candidate.requestId,
        employeeHrId: candidate.employeeHrId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        unpaidDays: candidate.unpaidDays,
        vacationType: candidate.vacationType,
        salaryDeductionAmount: candidate.salaryDeductionAmount,
        balanceAvailable: candidate.balanceAvailable,
        balanceDaysAvailable: candidate.balanceDaysAvailable,
        balanceDaysToConsume: candidate.balanceDaysToConsume,
        remainingSalaryDays: candidate.remainingSalaryDays,
        remainingSalaryDeductionAmount: candidate.remainingSalaryDeductionAmount,
        method,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save decision.");
    } finally {
      setBusyId(null);
    }
  }

  /** Determines the correct method: full balance, partial balance, or salary. */
  function balanceMethod(candidate: UnpaidVacationCandidate): "balance" | "partial_balance" {
    return candidate.balanceDaysToConsume >= candidate.unpaidDays ? "balance" : "partial_balance";
  }

  const decisionPanel = (row: UnpaidVacationCandidate) => {
    const busy = busyId === row.requestId;
    const current = row.existingSettlement?.method ?? null;
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(row, "salary")}
          className={`px-2 py-1 text-left text-xs font-semibold disabled:opacity-50 ${
            current === "salary"
              ? "bg-slate-900 text-white"
              : "border border-slate-300 text-slate-700 hover:bg-slate-100"
          }`}
        >
          Deduct from salary
        </button>
        <button
          type="button"
          disabled={busy || row.balanceDaysAvailable === 0}
          onClick={() => decide(row, balanceMethod(row))}
          className={`px-2 py-1 text-left text-xs font-semibold disabled:opacity-40 ${
            current === "balance" || current === "partial_balance"
              ? "bg-emerald-600 text-white"
              : "border border-slate-300 text-slate-700 hover:bg-slate-100"
          }`}
        >
          Deduct from vacation balance
        </button>
        {row.balanceDaysAvailable === 0 ? (
          <p className="px-2 text-phx-xs text-slate-500">
            No vacation balance available for this employee.
          </p>
        ) : row.remainingSalaryDays > 0 ? (
          <p className="px-2 text-phx-xs text-amber-700">
            Partial: {row.balanceDaysToConsume} day(s) from balance +{" "}
            {egp(row.remainingSalaryDeductionAmount)} ({row.remainingSalaryDays} day(s)) from salary.
          </p>
        ) : null}

        {row.balanceDaysAvailable < row.unpaidDays && (
          <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => decide(row, "defer_to_balance")}
              className={`px-2 py-1 text-left text-xs font-semibold disabled:opacity-40 ${
                current === "defer_to_balance"
                  ? "bg-emerald-600 text-white"
                  : "border border-slate-300 text-slate-700 hover:bg-slate-100"
              }`}
            >
              Defer to future balance
            </button>
            <p className="px-2 text-phx-xs text-amber-700">
              {row.balanceDaysToConsume > 0 ? `${row.balanceDaysToConsume} day(s) now, ` : ""}
              {row.unpaidDays - row.balanceDaysToConsume} day(s) will be deferred to future balance.
            </p>
          </div>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(row, "reject")}
          className={`px-2 py-1 text-left text-xs font-semibold disabled:opacity-50 ${
            current === null
              ? "border border-slate-300 text-slate-700 hover:bg-slate-100"
              : "border border-rose-300 text-rose-700 hover:bg-rose-50"
          }`}
        >
          Reject — no action this period
        </button>
      </div>
    );
  };

  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="h-4 w-1 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
          Unpaid Vacation {rows ? `(${rows.length})` : ""}
        </span>
        <a
          href={`/api/payroll/copilot/${runId}/deductions/vacation?format=xlsx`}
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
        <p className="px-4 py-6 text-sm text-slate-500">No unpaid-vacation candidates for this period.</p>
      ) : (
        <PortalResponsiveDataList
          empty={null}
          getKey={(row) => row.requestId}
          items={rows}
          renderCard={(row) => (
            <div className="space-y-1.5 px-4 py-3 text-sm">
              <p className="break-words font-medium text-slate-800">{row.employeeName ?? "—"}</p>
              <p className="break-words text-xs text-slate-600">
                {vacationTypeLabel(row.vacationType)} · {row.startDate} → {row.endDate}
              </p>
              <p className="text-xs text-slate-700">
                {row.unpaidDays} unpaid day(s) · salary deduction{" "}
                <span className="font-medium text-slate-900">{egp(row.salaryDeductionAmount)}</span>
              </p>
              {decisionPanel(row)}
            </div>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[18%]" />
                  <col className="w-[20%]" />
                  <col className="w-[10%]" />
                  <col className="w-[14%]" />
                  <col className="w-[38%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2">Employee</th>
                  <th className="px-4 py-2">Type / Period</th>
                  <th className="px-4 py-2">Unpaid days</th>
                  <th className="px-4 py-2">Salary deduction</th>
                  <th className="px-4 py-2">Decision</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.requestId}>
                    <td className="break-words px-4 py-2 text-slate-700">{row.employeeName ?? "—"}</td>
                    <td className="break-words px-4 py-2 text-slate-600">
                      {vacationTypeLabel(row.vacationType)} <br />
                      <span className="text-xs text-slate-400">
                        {row.startDate} → {row.endDate}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-700">{row.unpaidDays}</td>
                    <td className="break-words px-4 py-2 font-medium text-slate-900">{egp(row.salaryDeductionAmount)}</td>
                    <td className="px-4 py-2">{decisionPanel(row)}</td>
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
