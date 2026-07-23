"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type PunchInfo = { checkIn: string; checkOut: string; worked: string };

type Candidate = {
  id: string;
  employeeHrId: string;
  employeeName: string | null;
  baseSalary: number | null;
  reason: string;
  deductionUnit: string;
  deductionValue: number;
  estimatedAmount: number | null;
  dates: string[];
  punches: (PunchInfo | null)[];
  decisionStatus: string;
  appliedDeductionValue: number | null;
  appliedAmount: number | null;
};

type CyclePunchRow = {
  employeeHrId: string;
  employeeName: string;
  date: string;
  checkIn: string;
  checkOut: string;
  worked: string;
  status: string;
};

function egp(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

/** "Tue, Jun 30" — day-of-week computed from the Y-M-D components directly so it never shifts with the viewer's timezone. */
function shortDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const utcDate = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const weekday = WEEKDAYS[utcDate.getUTCDay()];
  return `${weekday}, ${MONTHS[Number(mo) - 1] ?? mo} ${Number(d)}`;
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return shortDay(iso.slice(0, 10));
}

/** "07:30" -> "7h 30m"; passes "—" through. */
function formatWorked(hhmm: string | undefined): string {
  if (!hhmm || hhmm === "—") return "—";
  const m = /^(\d{1,3}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  return `${Number(m[1])}h ${m[2]}m`;
}

/** One readable line instead of three separate columns: "10:20 AM → 5:00 PM · 6h 40m". */
function formatAttendance(punch: PunchInfo | null | undefined): string {
  if (!punch || (punch.checkIn === "—" && punch.checkOut === "—")) return "No punch";
  return `${punch.checkIn} → ${punch.checkOut} · ${formatWorked(punch.worked)}`;
}

/** Live estimate = base salary / 30 x the (possibly just-edited) day count — same formula the server applies on Confirm, so the number never lies about what will be saved. */
function liveAmount(row: Candidate, editedValue: string | undefined): number | null {
  const days = editedValue?.trim() ? Number(editedValue) : row.appliedDeductionValue ?? row.deductionValue;
  if (Number.isFinite(days) && row.baseSalary != null) {
    return Math.round((row.baseSalary / 30) * days * 100) / 100;
  }
  return row.appliedAmount ?? row.estimatedAmount;
}

/** Cycle window math mirrored client-side from `src/lib/payroll/copilot/cycle-window.ts` (day-24 -> day-24, no server round-trip needed just to label the dropdown). */
function cycleWindowFor(month: number, year: number): { startIso: string; endIso: string } {
  let startMonth = month - 1;
  let startYear = year;
  if (startMonth < 1) {
    startMonth = 12;
    startYear -= 1;
  }
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return {
    startIso: `${startYear}-${pad2(startMonth)}-24`,
    endIso: `${year}-${pad2(month)}-23`,
  };
}

const CYCLE_OPTIONS_COUNT = 18;

function buildCycleOptions(baseMonth: number, baseYear: number) {
  const options: { month: number; year: number; label: string }[] = [];
  let m = baseMonth;
  let y = baseYear;
  for (let i = 0; i < CYCLE_OPTIONS_COUNT; i++) {
    const { startIso, endIso } = cycleWindowFor(m, y);
    options.push({ month: m, year: y, label: `${shortDate(startIso)} → ${shortDate(endIso)}` });
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
  }
  return options;
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

export function FingerprintDeductionsReview({
  initialMonth,
  initialYear,
}: {
  initialMonth: number;
  initialYear: number;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [year, setYear] = useState(initialYear);
  const [tab, setTab] = useState<"deductions" | "punches">("deductions");
  const [rows, setRows] = useState<Candidate[] | null>(null);
  const [allPunches, setAllPunches] = useState<CyclePunchRow[] | null>(null);
  const [cycle, setCycle] = useState<{ startIso: string; endIso: string } | null>(null);
  const [rosterCount, setRosterCount] = useState<number | null>(null);
  const [scopedCount, setScopedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [punchesTruncated, setPunchesTruncated] = useState(false);

  const load = useCallback(async (m: number, y: number) => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/fingerprint-deductions?month=${m}&year=${y}`, {
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => ({}))) as {
        candidates?: Candidate[];
        allPunches?: CyclePunchRow[];
        punchesTruncated?: boolean;
        cycle?: { startIso: string; endIso: string };
        rosterCount?: number | null;
        scopedCount?: number | null;
        message?: string;
      };
      if (!res.ok) throw new Error(data.message ?? "Failed to load.");
      setRows(data.candidates ?? []);
      setAllPunches(data.allPunches ?? []);
      setPunchesTruncated(Boolean(data.punchesTruncated));
      setCycle(data.cycle ?? null);
      setRosterCount(typeof data.rosterCount === "number" ? data.rosterCount : null);
      setScopedCount(typeof data.scopedCount === "number" ? data.scopedCount : null);
      setEditedValues({});
      // Reset the date-range filter to the freshly loaded cycle's own bounds — an old
      // sub-range from a different month/year would just show zero results here.
      setDateFrom(data.cycle?.startIso ?? "");
      setDateTo(data.cycle?.endIso ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, matches the established pattern elsewhere in this codebase
    void load(month, year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function syncNow() {
    setSyncing(true);
    setSyncNotice(null);
    setError(null);
    try {
      const data = await postJson("/api/admin/fingerprint-deductions/sync", { month, year });
      const created = typeof data.created === "number" ? data.created : 0;
      const sourceTotal = typeof data.sourceTotal === "number" ? data.sourceTotal : 0;
      setSyncNotice(
        created > 0
          ? `Synced — ${created} new candidate${created === 1 ? "" : "s"} added from the latest punches.`
          : `Synced — already up to date (${sourceTotal} eligible punch rows checked).`,
      );
      await load(month, year);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  const sortedPunches = useMemo(() => {
    return [...(allPunches ?? [])].sort((a, b) => {
      const byName = a.employeeName.localeCompare(b.employeeName);
      return byName !== 0 ? byName : a.date.localeCompare(b.date);
    });
  }, [allPunches]);

  const employeeQuery = employeeFilter.trim().toLowerCase();
  const matchesEmployee = useCallback(
    (name: string | null, hrId: string) =>
      !employeeQuery ||
      (name ?? "").toLowerCase().includes(employeeQuery) ||
      hrId.toLowerCase().includes(employeeQuery),
    [employeeQuery],
  );

  const filteredRows = useMemo(() => {
    return (rows ?? []).filter(
      (row) =>
        matchesEmployee(row.employeeName, row.employeeHrId) &&
        (!dateFrom || !dateTo || row.dates.some((d) => d >= dateFrom && d <= dateTo)),
    );
  }, [rows, matchesEmployee, dateFrom, dateTo]);

  const filteredPunches = useMemo(() => {
    return sortedPunches.filter(
      (p) =>
        matchesEmployee(p.employeeName, p.employeeHrId) &&
        (!dateFrom || !dateTo || (p.date >= dateFrom && p.date <= dateTo)),
    );
  }, [sortedPunches, matchesEmployee, dateFrom, dateTo]);

  /** One row per employee summing every flagged date this cycle — a single employee often has several (e.g. 4 dates for one HR ID isn't rare), and adding those up by eye across the detail table gets error-prone. */
  const employeeTotals = useMemo(() => {
    const map = new Map<string, { employeeHrId: string; employeeName: string; rowCount: number; days: number; amount: number }>();
    for (const row of filteredRows) {
      const editedValue = editedValues[row.id];
      const days = editedValue?.trim() ? Number(editedValue) : row.appliedDeductionValue ?? row.deductionValue;
      const amount = liveAmount(row, editedValue) ?? 0;
      const existing = map.get(row.employeeHrId) ?? {
        employeeHrId: row.employeeHrId,
        employeeName: row.employeeName ?? row.employeeHrId,
        rowCount: 0,
        days: 0,
        amount: 0,
      };
      existing.rowCount += 1;
      existing.days += Number.isFinite(days) ? days : 0;
      existing.amount += amount;
      map.set(row.employeeHrId, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.amount - a.amount);
  }, [filteredRows, editedValues]);

  async function decide(candidateId: string, decisionStatus: "Approved for Payroll" | "Do Not Take Action") {
    setBusyId(candidateId);
    setError(null);
    try {
      const editedValue = editedValues[candidateId];
      await postJson("/api/admin/fingerprint-deductions", {
        candidateId,
        decisionStatus,
        appliedDeductionValue: editedValue?.trim() ? Number(editedValue) : undefined,
        month,
        year,
      });
      await load(month, year);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save decision.");
    } finally {
      setBusyId(null);
    }
  }

  async function decideAllPending(decisionStatus: "Approved for Payroll" | "Do Not Take Action") {
    // Acts on the currently FILTERED set only, so narrowing to one employee before
    // clicking "Confirm all" never touches anyone outside that filter.
    const pending = filteredRows.filter((row) => row.decisionStatus === "Pending");
    if (pending.length === 0) return;
    setBulkBusy(true);
    setError(null);
    try {
      await Promise.all(
        pending.map((row) => {
          const editedValue = editedValues[row.id];
          return postJson("/api/admin/fingerprint-deductions", {
            candidateId: row.id,
            decisionStatus,
            appliedDeductionValue: editedValue?.trim() ? Number(editedValue) : undefined,
            month,
            year,
          });
        }),
      );
      await load(month, year);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save decisions.");
    } finally {
      setBulkBusy(false);
    }
  }

  const pendingCount = filteredRows.filter((row) => row.decisionStatus === "Pending").length;
  const confirmedCount = filteredRows.filter((row) => row.decisionStatus === "Approved for Payroll").length;
  const filtersActive = Boolean(employeeFilter) || (cycle != null && (dateFrom !== cycle.startIso || dateTo !== cycle.endIso));
  const cycleOptions = useMemo(() => buildCycleOptions(initialMonth, initialYear), [initialMonth, initialYear]);

  function clearFilters() {
    setEmployeeFilter("");
    setDateFrom(cycle?.startIso ?? "");
    setDateTo(cycle?.endIso ?? "");
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <AdminPageHero
        eyebrow="Attendance"
        title="Fingerprint Deductions"
        description="Review each field employee's fingerprint attendance deductions for the month and confirm them. Confirmed rows are exactly what Automated Payroll's Part 1 → Fingerprint deductions step will show."
      />

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col text-xs font-semibold text-slate-500">
          Cycle
          <select
            value={`${month}-${year}`}
            onChange={(event) => {
              const [m, y] = event.target.value.split("-").map(Number);
              setMonth(m);
              setYear(y);
              void load(m, y);
            }}
            className="mt-1 h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
          >
            {cycleOptions.map((option) => (
              <option key={`${option.month}-${option.year}`} value={`${option.month}-${option.year}`}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-semibold text-slate-500">
          Month
          <select
            value={month}
            onChange={(event) => {
              const m = Number(event.target.value);
              setMonth(m);
              void load(m, year);
            }}
            className="mt-1 h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
          >
            {MONTHS.map((label, index) => (
              <option key={label} value={index + 1}>{label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-semibold text-slate-500">
          Year
          <select
            value={year}
            onChange={(event) => {
              const y = Number(event.target.value);
              setYear(y);
              void load(month, y);
            }}
            className="mt-1 h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
          >
            {[year - 1, year, year + 1].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <Button variant="outline" onClick={() => void load(month, year)}>Reload</Button>
        {cycle ? (
          <span className="text-xs text-slate-500">
            Cycle: {shortDate(cycle.startIso)} → {shortDate(cycle.endIso)}
          </span>
        ) : null}
        <Button variant="outline" size="sm" className="ml-auto" disabled={syncing} onClick={() => void syncNow()}>
          {syncing ? "Syncing…" : "Sync latest punches"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => (window.location.href = `/api/admin/fingerprint-deductions?month=${month}&year=${year}&format=xlsx`)}
        >
          Download xlsx
        </Button>
        <a href="/admin/automated-payroll" className="text-xs font-semibold text-orange-600 hover:underline">
          Open Automated Payroll →
        </a>
      </Card>

      {syncNotice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">{syncNotice}</div>
      ) : null}

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col text-xs font-semibold text-slate-500">
          Employee
          <input
            type="search"
            value={employeeFilter}
            onChange={(event) => setEmployeeFilter(event.target.value)}
            placeholder="Search name or HR ID…"
            className="mt-1 h-9 w-56 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
          />
        </label>
        <label className="flex flex-col text-xs font-semibold text-slate-500">
          From
          <input
            type="date"
            value={dateFrom}
            min={cycle?.startIso}
            max={cycle?.endIso}
            onChange={(event) => setDateFrom(event.target.value)}
            className="mt-1 h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
          />
        </label>
        <label className="flex flex-col text-xs font-semibold text-slate-500">
          To
          <input
            type="date"
            value={dateTo}
            min={cycle?.startIso}
            max={cycle?.endIso}
            onChange={(event) => setDateTo(event.target.value)}
            className="mt-1 h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
          />
        </label>
        {filtersActive ? (
          <Button variant="outline" onClick={clearFilters}>Clear filters</Button>
        ) : null}
      </Card>

      {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}

      {punchesTruncated ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-800">
          The punch data for this cycle hit the safety cap and was cut off — some check-in/check-out details below
          may be incomplete. Contact engineering before relying on attendance evidence from this cycle for a
          payroll decision.
        </div>
      ) : null}

      {rosterCount != null && scopedCount != null && scopedCount < rosterCount ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          Only <strong>{scopedCount} of {rosterCount}</strong> employees on the attendance roster have a
          minimum-hours policy configured this period — deductions can only apply to that smaller group
          until more employees are migrated onto a flexible-hours policy in Attendance settings.
        </div>
      ) : null}

      <div className="flex gap-1 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setTab("deductions")}
          className={`px-3 py-2 text-sm font-semibold ${
            tab === "deductions" ? "border-b-2 border-orange-500 text-slate-900" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Deductions
        </button>
        <button
          type="button"
          onClick={() => setTab("punches")}
          className={`px-3 py-2 text-sm font-semibold ${
            tab === "punches" ? "border-b-2 border-orange-500 text-slate-900" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          All Punches (cycle){allPunches ? ` (${filteredPunches.length})` : ""}
        </button>
      </div>

      {tab === "deductions" ? (
        rows === null ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-black text-slate-900">Fingerprint deductions</h3>
                <p className="text-sm text-slate-500">
                  {filteredRows.length} row{filteredRows.length === 1 ? "" : "s"} this cycle
                  {confirmedCount > 0 ? ` · ${confirmedCount} confirmed` : ""}
                </p>
              </div>
              {pendingCount > 0 ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={bulkBusy || busyId !== null} onClick={() => void decideAllPending("Approved for Payroll")}>
                    Confirm all {pendingCount}
                  </Button>
                  <Button variant="outline" size="sm" disabled={bulkBusy || busyId !== null} onClick={() => void decideAllPending("Do Not Take Action")}>
                    Reject all {pendingCount}
                  </Button>
                </div>
              ) : null}
            </div>

            {employeeTotals.some((e) => e.rowCount > 1) ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Per-employee totals</p>
                <div className="overflow-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[520px] border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-900 text-left text-xs font-semibold uppercase tracking-wide text-white">
                      <th className="px-3 py-2">Employee</th>
                      <th className="px-3 py-2 text-right">Rows</th>
                      <th className="px-3 py-2 text-right">Total days</th>
                      <th className="px-3 py-2 text-right">Total amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employeeTotals.map((total, index) => (
                      <tr key={total.employeeHrId} className={index % 2 ? "bg-slate-50/60" : "bg-white"}>
                        <td className="px-3 py-1.5">
                          <div className="font-medium text-slate-800 whitespace-nowrap">{total.employeeName}</div>
                          <div className="font-mono text-xs text-slate-500">{total.employeeHrId}</div>
                        </td>
                        <td className="px-3 py-1.5 text-right text-slate-600">{total.rowCount}</td>
                        <td className="px-3 py-1.5 text-right text-slate-600">{total.days.toFixed(2)}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-slate-900">{egp(total.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            ) : null}

            <div className="overflow-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[900px] border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-900 text-left text-xs font-semibold uppercase tracking-wide text-white">
                    <th className="px-3 py-2">Employee</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Reason</th>
                    <th className="px-3 py-2">Attendance</th>
                    <th className="px-3 py-2 text-right">Days</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2 text-center">Approve</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-slate-400">
                        {rows.length === 0 ? "No fingerprint deduction candidates for this month." : "No rows match the current filters."}
                      </td>
                    </tr>
                  ) : null}
                  {filteredRows.map((row, index) => {
                    const amount = liveAmount(row, editedValues[row.id]);
                    const dateEntries = row.dates.map((date, i) => ({ date, punch: row.punches[i] ?? null }));
                    return (
                      <tr key={row.id} className={index % 2 ? "bg-slate-50/60" : "bg-white"}>
                        <td className="px-3 py-1.5">
                          <div className="font-medium text-slate-800 whitespace-nowrap">{row.employeeName ?? row.employeeHrId}</div>
                          <div className="font-mono text-xs text-slate-500">{row.employeeHrId}</div>
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">
                          {dateEntries.map((e) => <div key={e.date}>{shortDay(e.date)}</div>)}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">{row.reason}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">
                          {dateEntries.map((e) => <div key={e.date}>{formatAttendance(e.punch)}</div>)}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <Input
                            key={`${row.id}:${row.decisionStatus}:${row.appliedDeductionValue ?? row.deductionValue}`}
                            type="number"
                            step="0.01"
                            defaultValue={row.appliedDeductionValue ?? row.deductionValue}
                            onChange={(event) => setEditedValues((prev) => ({ ...prev, [row.id]: event.target.value }))}
                            className="ml-auto h-8 w-20 text-right"
                          />
                        </td>
                        <td className="px-3 py-1.5 text-right font-medium text-slate-900 whitespace-nowrap">
                          {amount != null ? egp(amount) : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-center align-top">
                          <input
                            type="checkbox"
                            checked={row.decisionStatus === "Approved for Payroll"}
                            disabled={busyId === row.id || bulkBusy}
                            onChange={(event) =>
                              void decide(row.id, event.target.checked ? "Approved for Payroll" : "Do Not Take Action")
                            }
                            className="h-5 w-5 cursor-pointer accent-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          {row.decisionStatus === "Do Not Take Action" ? (
                            <div className="text-[10px] font-semibold text-rose-600">Rejected</div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : allPunches === null ? (
        <div className="p-6 text-sm text-slate-500">Loading…</div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-black text-slate-900">All punches this cycle</h3>
            <p className="text-sm text-slate-500">Every punched day — not just deduction days. {filteredPunches.length} rows.</p>
          </div>

          <div className="max-h-[70vh] overflow-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead className="sticky top-0">
                <tr className="bg-slate-900 text-left text-xs font-semibold uppercase tracking-wide text-white">
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Attendance</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredPunches.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-slate-400">
                      {allPunches.length === 0 ? "No punches recorded for this cycle." : "No punches match the current filters."}
                    </td>
                  </tr>
                ) : null}
                {filteredPunches.map((p, index) => (
                  <tr key={`${p.employeeHrId}-${p.date}`} className={index % 2 ? "bg-slate-50/60" : "bg-white"}>
                    <td className="px-3 py-1.5">
                      <div className="font-medium text-slate-800 whitespace-nowrap">{p.employeeName}</div>
                      <div className="font-mono text-xs text-slate-500">{p.employeeHrId}</div>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">{shortDay(p.date)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">{formatAttendance(p)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-slate-600">{p.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
