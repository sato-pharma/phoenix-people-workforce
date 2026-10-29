"use client";

import { PortalDesktopTable, PortalResponsiveDataList } from "@/components/employee-portal/portal-primitives";
import { useCallback, useEffect, useState } from "react";

type HolidayBridgingCandidate = {
  id: string;
  requestId: string;
  employeeHrId: string;
  employeeName: string | null;
  hireDate: string | null;
  vacationType: string;
  bridgingDate: string;
  adjacentTo: "before" | "after";
  holidayName: string;
  holidayStartDate: string;
  holidayEndDate: string;
  salaryDeductionAmount: number;
  excluded: boolean;
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
 * National-holiday-bridging leave review tab — a leave day taken directly
 * before/after a national holiday is a MANDATORY salary deduction (owner
 * rule), so every row here already counts on the payroll sheet by default.
 * The only action is Exclude (this specific bridging day shouldn't count) or
 * Include again (undo an exclusion) — there is nothing to approve or edit,
 * the amount is a fixed one-day rate. Reads/writes
 * payroll_copilot_vacation_settlements (settlement_method =
 * 'holiday_bridge_excluded') — never touches v2_vacation_requests or the
 * employee's vacation balance.
 */
export function HolidayBridgingTab({ runId }: { runId: string }) {
  const [rows, setRows] = useState<HolidayBridgingCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/payroll/copilot/${runId}/deductions/holiday-bridging`, {
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => ({}))) as {
        candidates?: HolidayBridgingCandidate[];
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

  async function toggle(row: HolidayBridgingCandidate) {
    setBusyId(row.id);
    setError(null);
    try {
      await postJson(`/api/payroll/copilot/${runId}/deductions/holiday-bridging`, {
        requestId: row.requestId,
        employeeHrId: row.employeeHrId,
        bridgingDate: row.bridgingDate,
        action: row.excluded ? "include" : "exclude",
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save decision.");
    } finally {
      setBusyId(null);
    }
  }

  const holidayRange = (row: HolidayBridgingCandidate) =>
    row.holidayStartDate === row.holidayEndDate ? row.holidayStartDate : `${row.holidayStartDate} – ${row.holidayEndDate}`;
  const statusAndAction = (row: HolidayBridgingCandidate) => (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`px-2 py-0.5 text-xs font-semibold ${
          row.excluded ? "bg-slate-200 text-slate-600" : "bg-emerald-100 text-emerald-700"
        }`}
      >
        {row.excluded ? "Excluded" : "Mandatory"}
      </span>
      <button
        type="button"
        disabled={busyId === row.id}
        onClick={() => toggle(row)}
        className={`px-2 py-1 text-xs font-semibold disabled:opacity-50 ${
          row.excluded
            ? "bg-emerald-600 text-white hover:bg-emerald-700"
            : "border border-slate-300 text-slate-700 hover:bg-slate-100"
        }`}
      >
        {row.excluded ? "Include again" : "Exclude"}
      </button>
    </div>
  );

  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="h-4 w-1 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
          Holiday Bridging {rows ? `(${rows.length})` : ""}
        </span>
        <a
          href={`/api/payroll/copilot/${runId}/deductions/holiday-bridging?format=xlsx`}
          className="border border-slate-500 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-800"
        >
          Download xlsx
        </a>
      </div>
      {error ? (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div>
      ) : null}
      {rows && rows.length > 0 ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          Leave taken directly before or after a national holiday is a <strong>mandatory salary deduction</strong> —
          it does not touch vacation balance and does not need approval. Click <strong>Exclude</strong> only if a
          specific row shouldn&apos;t count (e.g. the holiday date was wrong).
        </div>
      ) : null}
      {!rows ? (
        <p className="px-4 py-6 text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          No approved leave touches a national holiday&apos;s edge this period.
        </p>
      ) : (
        <PortalResponsiveDataList
          empty={null}
          getKey={(row) => row.id}
          items={rows}
          renderCard={(row) => (
            <div className="space-y-1.5 px-4 py-3 text-sm">
              <p className="break-words font-medium text-slate-800">{row.employeeName ?? "—"}</p>
              <p className="text-xs text-slate-500">Hired {row.hireDate ?? "—"}</p>
              <p className="break-words text-xs text-slate-600">
                {row.bridgingDate} · {row.adjacentTo === "before" ? "day before" : "day after"} {row.holidayName} (
                {holidayRange(row)})
              </p>
              <p className="text-xs text-slate-900">
                {row.excluded ? "—" : <span className="font-medium">{egp(row.salaryDeductionAmount)}</span>}
              </p>
              {statusAndAction(row)}
            </div>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[22%]" />
                  <col className="w-[18%]" />
                  <col className="w-[24%]" />
                  <col className="w-[14%]" />
                  <col className="w-[22%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2">Employee</th>
                  <th className="px-4 py-2">Bridging Date</th>
                  <th className="px-4 py-2">Holiday</th>
                  <th className="px-4 py-2">Amount</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="break-words px-4 py-2 text-slate-700">
                      <div>{row.employeeName ?? "—"}</div>
                      <div className="text-xs text-slate-400">Hired {row.hireDate ?? "—"}</div>
                    </td>
                    <td className="break-words px-4 py-2 text-slate-600">
                      {row.bridgingDate}
                      <div className="text-xs text-slate-400">
                        {row.adjacentTo === "before" ? "Day before" : "Day after"} holiday
                      </div>
                    </td>
                    <td className="break-words px-4 py-2 text-slate-600">
                      {row.holidayName}
                      <div className="text-xs text-slate-400">{holidayRange(row)}</div>
                    </td>
                    <td className="break-words px-4 py-2 font-medium text-slate-900">
                      {row.excluded ? "—" : egp(row.salaryDeductionAmount)}
                    </td>
                    <td className="px-4 py-2">{statusAndAction(row)}</td>
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
