"use client";

import { useCallback, useEffect, useState } from "react";

type DeductionCandidate = {
  id: string;
  employeeHrId: string;
  employeeName: string | null;
  deductionType: string;
  deductionUnit: string;
  deductionValue: number;
  estimatedAmount: number | null;
  severity: string | null;
  decisionStatus: string;
  appliedDeductionValue: number | null;
  appliedAmount: number | null;
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

const STATUS_STYLES: Record<string, string> = {
  "Approved for Payroll": "bg-emerald-100 text-emerald-700",
  "Do Not Take Action": "bg-slate-200 text-slate-600",
  Pending: "bg-amber-100 text-amber-700",
};

/**
 * Simplified approve/reject/edit-value review table shared by the Fingerprint
 * and CRM tabs — both read/write the same underlying deduction_candidates/
 * deduction_decisions rows the full HR Deductions Governance workspace uses.
 */
export function DeductionReviewTable({
  runId,
  endpoint,
  title,
  valueLabel,
}: {
  runId: string;
  endpoint: "fingerprint" | "crm";
  title: string;
  valueLabel: string;
}) {
  const [rows, setRows] = useState<DeductionCandidate[] | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [rosterCount, setRosterCount] = useState<number | null>(null);
  const [scopedCount, setScopedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/payroll/copilot/${runId}/deductions/${endpoint}`, {
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => ({}))) as {
        candidates?: DeductionCandidate[];
        dryRun?: boolean;
        rosterCount?: number | null;
        scopedCount?: number | null;
        message?: string;
      };
      if (!res.ok) throw new Error(data.message ?? "Failed to load.");
      setRows(data.candidates ?? []);
      setDryRun(Boolean(data.dryRun));
      setRosterCount(typeof data.rosterCount === "number" ? data.rosterCount : null);
      setScopedCount(typeof data.scopedCount === "number" ? data.scopedCount : null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, [runId, endpoint]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, matches the established pattern elsewhere in this codebase
    void load();
  }, [load]);

  async function decide(candidateId: string, decisionStatus: "Approved for Payroll" | "Do Not Take Action") {
    setBusyId(candidateId);
    setError(null);
    try {
      const editedValue = editedValues[candidateId];
      await postJson(`/api/payroll/copilot/${runId}/deductions/${endpoint}`, {
        candidateId,
        decisionStatus,
        appliedDeductionValue: editedValue?.trim() ? Number(editedValue) : undefined,
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
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
        <span aria-hidden="true" className="h-4 w-1 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
        {title} {rows ? `(${rows.length})` : ""}
      </div>
      {error ? (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div>
      ) : null}
      {dryRun ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          Attendance deductions are currently in <strong>dry-run mode</strong> — the weekly-digest
          engine is computing recommendations but not yet pushing real candidates into payroll. Zero
          candidates here is expected until dry-run is turned off in Attendance settings.
        </div>
      ) : null}
      {rosterCount != null && scopedCount != null && scopedCount < rosterCount ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          Only <strong>{scopedCount} of {rosterCount}</strong> employees on the attendance roster have a
          minimum-hours (required_minutes) policy configured this period — attendance deductions can
          only ever apply to that smaller group until more employees are migrated onto a flexible-hours
          policy in Attendance settings, even with dry-run off.
        </div>
      ) : null}
      {!rows ? (
        <p className="px-4 py-6 text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          {dryRun ? "No candidates while dry-run is on." : "No candidates for this period."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2">Employee</th>
                <th className="px-4 py-2">{valueLabel}</th>
                <th className="px-4 py-2">Amount</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const amount = row.appliedAmount ?? row.estimatedAmount;
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-2 text-slate-700">
                      {row.employeeName ?? row.employeeHrId}{" "}
                      <span className="text-slate-400">({row.employeeHrId})</span>
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="number"
                        step="0.5"
                        className="w-20 border border-slate-300 px-2 py-1 text-xs"
                        defaultValue={row.appliedDeductionValue ?? row.deductionValue}
                        onChange={(event) =>
                          setEditedValues((prev) => ({ ...prev, [row.id]: event.target.value }))
                        }
                      />{" "}
                      {row.deductionUnit}
                    </td>
                    <td className="px-4 py-2 font-medium text-slate-900">
                      {amount != null ? egp(amount) : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`px-2 py-0.5 text-xs font-semibold ${
                          STATUS_STYLES[row.decisionStatus] ?? STATUS_STYLES.Pending
                        }`}
                      >
                        {row.decisionStatus}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          disabled={busyId === row.id}
                          onClick={() => decide(row.id, "Approved for Payroll")}
                          className="bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={busyId === row.id}
                          onClick={() => decide(row.id, "Do Not Take Action")}
                          className="border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          Reject
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
