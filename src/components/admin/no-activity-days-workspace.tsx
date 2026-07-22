"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Ban, CheckCircle2 } from "lucide-react";

export type AdminNoActivityRow = {
  clarification: {
    activityDate: string;
    adminNote: string | null;
    clarificationText: string | null;
    confirmedNoActivity: boolean;
    resolution: "deducted" | "not_deducted" | null;
    sourcePointerText: string | null;
    status: "pending_review" | "resolved";
  } | null;
  date: string;
  description: string;
  employeeHrId: string;
  employeeName: string;
  existingDecision: { decisionStatus: string; sourceModule: string } | null;
  relatedDispute: { claimText: string; id: string; status: "accepted" | "pending_review" | "rejected" } | null;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatDate(iso: string) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", timeZone: "UTC", weekday: "short" }).format(date);
}

function rowKey(row: { date: string; employeeHrId: string }) {
  return `${row.employeeHrId}|${row.date}`;
}

export function NoActivityDaysWorkspace({
  initialCycle,
  initialError,
  initialMonth,
  initialRows,
  initialYear,
}: {
  initialCycle: { cycleKey: string; endIso: string; startIso: string } | null;
  initialError: string | null;
  initialMonth: number;
  initialRows: AdminNoActivityRow[];
  initialYear: number;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [year, setYear] = useState(initialYear);
  const [cycle, setCycle] = useState(initialCycle);
  const [rows, setRows] = useState(initialRows);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const decidable = useMemo(() => rows.filter((row) => !row.existingDecision && row.clarification?.status !== "resolved"), [rows]);
  const unclarifiedCount = useMemo(() => decidable.filter((row) => !row.clarification).length, [decidable]);

  async function reload(nextMonth: number, nextYear: number) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/private-calendar/no-activity/report?month=${nextMonth}&year=${nextYear}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to load the report.");
      setRows(payload.data);
      setCycle(payload.cycle);
      setMonth(nextMonth);
      setYear(nextYear);
      setSelected(new Set());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load the report.");
    } finally {
      setLoading(false);
    }
  }

  function toggle(row: AdminNoActivityRow) {
    const key = rowKey(row);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleAllUnclarified() {
    const unclarifiedKeys = decidable.filter((row) => !row.clarification).map(rowKey);
    setSelected((current) => {
      const allSelected = unclarifiedKeys.every((key) => current.has(key));
      return allSelected ? new Set() : new Set(unclarifiedKeys);
    });
  }

  async function decide(targetRows: AdminNoActivityRow[], resolution: "deducted" | "not_deducted") {
    if (!note.trim()) {
      setError("A decision note is required.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/private-calendar/no-activity/decide", {
        body: JSON.stringify({
          adminNote: note,
          items: targetRows.map((row) => ({ activityDate: row.date, employeeHrId: row.employeeHrId, employeeName: row.employeeName })),
          resolution,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to decide these days.");
      const failed = Array.isArray(payload.data)
        ? (payload.data as Array<{ activityDate: string; employeeHrId: string; error: string | null; ok: boolean }>).filter((result) => !result.ok)
        : [];
      if (failed.length > 0) {
        setError(`${failed.length} day(s) could not be decided: ${failed[0].error}`);
      }
      const decidedKeys = new Set(targetRows.map(rowKey).filter((key) => !failed.some((result) => `${result.employeeHrId}|${result.activityDate}` === key)));
      setRows((current) => current.filter((row) => !decidedKeys.has(rowKey(row))));
      setSelected(new Set());
      setNote("");
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "Unable to decide these days.");
    } finally {
      setSubmitting(false);
    }
  }

  const selectedRows = rows.filter((row) => selected.has(rowKey(row)));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <label className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.1em] text-slate-500">
          Month
          <select
            className="rounded-sm border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-900"
            onChange={(event) => reload(Number(event.target.value), year)}
            value={month}
          >
            {MONTHS.map((label, index) => (
              <option key={label} value={index + 1}>{label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.1em] text-slate-500">
          Year
          <input
            className="w-20 rounded-sm border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-900"
            onBlur={(event) => reload(month, Number(event.target.value) || year)}
            defaultValue={year}
            type="number"
          />
        </label>
        {cycle ? (
          <span className="ml-auto text-xs font-semibold text-slate-500">
            Payroll cycle: {cycle.startIso} to {cycle.endIso}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="flex items-center gap-2 border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      <div className="border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-900 px-5 py-3">
          <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
            {loading ? "Loading…" : `${rows.length} no-activity day${rows.length === 1 ? "" : "s"} · ${unclarifiedCount} unclarified`}
          </h2>
          <button
            className="rounded-sm border border-white/30 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.1em] text-white transition hover:bg-white/10"
            onClick={toggleAllUnclarified}
            type="button"
          >
            Select all unclarified
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-bold text-slate-500">No no-activity days for this cycle.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((row) => {
              const key = rowKey(row);
              const alreadyDecidedElsewhere = Boolean(row.existingDecision);
              const alreadyResolved = row.clarification?.status === "resolved";
              const disabled = alreadyDecidedElsewhere || alreadyResolved;
              return (
                <div className={["flex flex-wrap items-start gap-3 px-5 py-3", disabled ? "bg-slate-50/70" : ""].join(" ")} key={key}>
                  <input
                    checked={selected.has(key)}
                    className="mt-1"
                    disabled={disabled}
                    onChange={() => toggle(row)}
                    type="checkbox"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="whitespace-nowrap font-mono text-[11px] font-semibold text-slate-500">{formatDate(row.date)}</span>
                      <span className="whitespace-nowrap rounded-sm bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                        {row.employeeName} ({row.employeeHrId})
                      </span>
                      {row.clarification ? (
                        <span className="whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-amber-700">
                          clarified
                        </span>
                      ) : (
                        <span className="whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-red-700">
                          no response
                        </span>
                      )}
                      {alreadyDecidedElsewhere ? (
                        <span className="whitespace-nowrap rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700">
                          already {row.existingDecision?.decisionStatus} via {row.existingDecision?.sourceModule}
                        </span>
                      ) : null}
                      {alreadyResolved ? (
                        <span className="whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-emerald-700">
                          resolved: {row.clarification?.resolution}
                        </span>
                      ) : null}
                      {row.relatedDispute ? (
                        <span
                          className={[
                            "whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em]",
                            row.relatedDispute.status === "accepted"
                              ? "bg-sky-100 text-sky-700"
                              : row.relatedDispute.status === "rejected"
                                ? "bg-slate-200 text-slate-700"
                                : "bg-sky-50 text-sky-600",
                          ].join(" ")}
                          title={row.relatedDispute.claimText}
                        >
                          also has a data review request ({row.relatedDispute.status.replace("_", " ")})
                        </span>
                      ) : null}
                    </div>
                    {row.clarification ? (
                      <div className="mt-1.5 text-xs font-semibold text-slate-700">
                        {row.clarification.confirmedNoActivity && !row.clarification.clarificationText
                          ? "Employee confirmed: no activity that day."
                          : row.clarification.clarificationText}
                        {row.clarification.sourcePointerText ? ` — verify via: ${row.clarification.sourcePointerText}` : ""}
                      </div>
                    ) : null}
                    {row.relatedDispute ? (
                      <div className="mt-1 text-xs font-medium italic text-sky-700">
                        Review request: &ldquo;{row.relatedDispute.claimText}&rdquo;
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedRows.length > 0 ? (
        <div className="sticky bottom-4 border border-slate-300 bg-white p-4 shadow-lg">
          <p className="text-xs font-black uppercase tracking-[0.1em] text-slate-500">{selectedRows.length} day(s) selected</p>
          <textarea
            className="mt-2 w-full rounded-sm border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-orange-400 focus:outline-none"
            onChange={(event) => setNote(event.target.value)}
            placeholder="Decision note (required)"
            rows={2}
            value={note}
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              className="inline-flex items-center gap-1.5 rounded-sm bg-red-600 px-4 py-1.5 text-xs font-black text-white transition hover:bg-red-700 disabled:opacity-50"
              disabled={submitting}
              onClick={() => decide(selectedRows, "deducted")}
              type="button"
            >
              <Ban className="h-3.5 w-3.5" />
              Deduct {selectedRows.length}
            </button>
            <button
              className="inline-flex items-center gap-1.5 rounded-sm bg-emerald-600 px-4 py-1.5 text-xs font-black text-white transition hover:bg-emerald-700 disabled:opacity-50"
              disabled={submitting}
              onClick={() => decide(selectedRows, "not_deducted")}
              type="button"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Don&apos;t deduct {selectedRows.length}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
