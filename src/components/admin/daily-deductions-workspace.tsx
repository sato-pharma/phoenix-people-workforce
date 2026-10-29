"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, PlayCircle, XCircle } from "lucide-react";

import { dailyDeductionConnectorLabels, dailyDeductionConnectors, type DailyDeductionConnector } from "@/lib/daily-deductions/types.ts";
import { indexReleasedLines, linesToRelease, releaseLineKey, releaseStateOf, type ReleaseState } from "@/lib/daily-deductions/release-state.ts";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { phxFieldClassName } from "@/components/ui/form-tokens";

// The tally line the compute route returns (DailyDeductionTallyLine). Sent back
// verbatim to the release route as the reviewed lines — no reshaping in between.
type TallyLine = {
  category: DailyDeductionConnector;
  employeeHrId: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  unit: "days" | "amount";
  rawDaysCount: number;
  daysCount: number;
  amount: number;
  dates: string[];
  sourceSystem: string;
  reason: string | null;
};

type ConnectorTally = {
  connector: DailyDeductionConnector;
  label: string;
  lines: TallyLine[];
  employeeCount: number;
  lineCount: number;
  totalAmount: number;
  warnings: string[];
  effectiveTo: string;
  from: string;
  truncated: boolean;
};

type ConnectorRun = {
  connector: DailyDeductionConnector;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  tally?: ConnectorTally;
  error?: string;
};

type ActivePublication = {
  id: string;
  rangeStart: string;
  rangeEnd: string;
  publishedBy: string;
  publishedAt: string;
  employeeCount: number;
  lineCount: number;
  categoryTotals: Partial<Record<DailyDeductionConnector, number>>;
};

// A line already released into the active snapshot (DailyDeductionsLine, as the active route returns it).
type ReleasedLine = {
  id: string;
  category: DailyDeductionConnector;
  employeeHrId: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  daysCount: number;
  amount: number;
  dates: string[];
  releasedAt: string;
  releasedBy: string | null;
};

type EmployeeGroup = {
  key: string;
  name: string;
  lines: TallyLine[];
  amount: number;
};

function lineKey(line: { category: string; employeeHrIdCompact: string }): string {
  return releaseLineKey(line);
}

function money(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value);
}

// Cairo, always — a raw UTC timestamp reads an hour or two off for the owner.
// Formatted through formatStableEnGb so the month token ships with the code
// (CAIRO_MONTHS): a bare en-GB "short" month is CLDR-version-dependent
// ("Sep" vs "Sept") and hydration-error #418 in a client component.
function cairoStamp(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  return formatStableEnGb(value, {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// A YYYY-MM-DD date shown as "1 Sep" — the day list can span two months, so the
// month stays on every entry. Rendered as wrapping chips, never truncated.
function dateChip(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  // UTC-pinned (a date-only value must not shift a calendar day) and routed
  // through formatStableEnGb for the same CLDR month reason as cairoStamp.
  return formatStableEnGb(new Date(Date.UTC(year, month - 1, day)), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || payload?.message || `Request failed (${response.status})`);
  }
  return payload as T;
}

async function fetchJsonWithTimeout<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchJson<T>(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s — the scan is too slow to finish in one request.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Each connector runs one company-wide scan; give it the platform's 300s ceiling plus slack.
const COMPUTE_REQUEST_TIMEOUT_MS = 310_000;

export function DailyDeductionsWorkspace({
  canPublish,
  defaultFrom,
  defaultTo,
}: {
  canPublish: boolean;
  defaultFrom: string;
  defaultTo: string;
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [runs, setRuns] = useState<ConnectorRun[]>(
    dailyDeductionConnectors.map((connector) => ({
      connector,
      label: dailyDeductionConnectorLabels[connector],
      state: "pending",
    })),
  );
  const [computing, setComputing] = useState(false);
  const [computedRange, setComputedRange] = useState<{ from: string; effectiveTo: string; truncated: boolean } | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [active, setActive] = useState<ActivePublication | null>(null);
  const [releasedLines, setReleasedLines] = useState<ReleasedLine[]>([]);
  const [activeLoading, setActiveLoading] = useState(true);
  // Which tally lines are ticked. Every line starts UNTICKED, like the weekly attendance review.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function loadActive() {
    setActiveLoading(true);
    fetchJson<{ publication: ActivePublication | null; lines?: ReleasedLine[] }>("/api/admin/daily-deductions/active")
      .then((payload) => {
        setActive(payload.publication);
        setReleasedLines(payload.publication ? (payload.lines ?? []) : []);
      })
      .catch(() => {
        setActive(null);
        setReleasedLines([]);
      })
      .finally(() => setActiveLoading(false));
  }

  useEffect(() => {
    loadActive();
  }, []);

  // Every reviewed line across the connectors, flattened. A release click sends
  // exactly these rows — no reshaping, so what the owner sees is what is stored.
  const allLines = useMemo(() => {
    const lines: TallyLine[] = [];
    for (const run of runs) {
      if (run.tally) lines.push(...run.tally.lines);
    }
    return lines;
  }, [runs]);

  const totals = useMemo(() => {
    const employees = new Set<string>();
    let amount = 0;
    for (const line of allLines) {
      employees.add(line.employeeHrIdCompact);
      amount += line.amount;
    }
    return { amount: Math.round(amount * 100) / 100, employeeCount: employees.size, lineCount: allLines.length };
  }, [allLines]);

  const anyComputed = runs.some((run) => run.state === "done");

  const releasedIndex = useMemo(() => indexReleasedLines(releasedLines), [releasedLines]);

  // The tally grouped by employee, in the order the connectors returned them (name, then id).
  const groups = useMemo(() => {
    const byEmployee = new Map<string, EmployeeGroup>();
    for (const line of allLines) {
      const existing = byEmployee.get(line.employeeHrIdCompact);
      if (existing) {
        existing.lines.push(line);
        existing.amount += line.amount;
      } else {
        byEmployee.set(line.employeeHrIdCompact, {
          key: line.employeeHrIdCompact,
          name: line.employeeName ?? "—",
          lines: [line],
          amount: line.amount,
        });
      }
    }
    return [...byEmployee.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [allLines]);

  const selectedLines = useMemo(() => allLines.filter((line) => selected.has(lineKey(line))), [allLines, selected]);
  const releasableSelected = useMemo(() => linesToRelease(selectedLines, releasedIndex), [selectedLines, releasedIndex]);
  const releasableAll = useMemo(() => linesToRelease(allLines, releasedIndex), [allLines, releasedIndex]);

  function toggleLine(line: TallyLine) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = lineKey(line);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleEmployee(group: EmployeeGroup) {
    setSelected((prev) => {
      const next = new Set(prev);
      const everyTicked = group.lines.every((line) => next.has(lineKey(line)));
      for (const line of group.lines) {
        if (everyTicked) next.delete(lineKey(line));
        else next.add(lineKey(line));
      }
      return next;
    });
  }

  async function compute() {
    if (computing) return;
    setComputing(true);
    setMessage(null);
    setComputedRange(null);
    setSelected(new Set());
    // Reset every connector to pending before the sweep.
    setRuns((prev) => prev.map((run) => ({ ...run, state: "pending", tally: undefined, error: undefined })));

    let lastRange: { from: string; effectiveTo: string; truncated: boolean } | null = null;
    for (const connector of dailyDeductionConnectors) {
      setRuns((prev) => prev.map((run) => (run.connector === connector ? { ...run, state: "running" } : run)));
      try {
        const payload = await fetchJsonWithTimeout<{ tally: ConnectorTally }>(
          "/api/admin/daily-deductions/compute",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connector, from, to }),
          },
          COMPUTE_REQUEST_TIMEOUT_MS,
        );
        lastRange = { from: payload.tally.from, effectiveTo: payload.tally.effectiveTo, truncated: payload.tally.truncated };
        setRuns((prev) => prev.map((run) => (run.connector === connector ? { ...run, state: "done", tally: payload.tally } : run)));
      } catch (error) {
        setRuns((prev) =>
          prev.map((run) =>
            run.connector === connector ? { ...run, state: "failed", error: error instanceof Error ? error.message : String(error) } : run,
          ),
        );
      }
    }
    setComputedRange(lastRange);
    setComputing(false);
  }

  // Release some of the tally's lines (one, an employee's, the ticked ones, or all). The server MERGES
  // them into the active snapshot; everything already released stays exactly as it was.
  async function release(lines: TallyLine[], label: string) {
    if (!canPublish || publishing) return;
    if (lines.length === 0) {
      setMessage({ tone: "error", text: "Nothing to release — those deductions are already released as shown." });
      return;
    }
    setPublishing(true);
    setMessage(null);
    try {
      const payload = await fetchJson<{ releasedCount: number }>("/api/admin/daily-deductions/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rangeStart: from, rangeEnd: to, lines }),
      });
      setMessage({
        tone: "success",
        text: `Released ${payload.releasedCount} deduction${payload.releasedCount === 1 ? "" : "s"} (${label}). Every other released deduction is unchanged.`,
      });
      setSelected((prev) => {
        const next = new Set(prev);
        for (const line of lines) next.delete(lineKey(line));
        return next;
      });
      loadActive();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setPublishing(false);
    }
  }

  // Take ONE released deduction back out of the published snapshot.
  async function withdrawLine(line: ReleasedLine) {
    if (!canPublish || publishing) return;
    setPublishing(true);
    setMessage(null);
    try {
      await fetchJson("/api/admin/daily-deductions/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineId: line.id }),
      });
      setMessage({
        tone: "success",
        text: `Withdrew ${line.employeeName ?? "—"} · ${dailyDeductionConnectorLabels[line.category]}. The other released deductions are unchanged.`,
      });
      loadActive();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setPublishing(false);
    }
  }

  async function withdraw() {
    if (!canPublish || !active) return;
    setPublishing(true);
    setMessage(null);
    try {
      await fetchJson("/api/admin/daily-deductions/supersede", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicationId: active.id }),
      });
      setMessage({ tone: "success", text: "The active tally was withdrawn. Nothing is published now." });
      loadActive();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setPublishing(false);
    }
  }

  const allWarnings = runs.flatMap((run) => run.tally?.warnings ?? []);

  return (
    <div className="space-y-6">
      {/* ── The released snapshot ───────────────────────────────────────── */}
      <section className="space-y-3 border border-slate-200 bg-white p-4">
        <h2 className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">Released</h2>
        {activeLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : active ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-900">
                  {dateChip(active.rangeStart)} — {dateChip(active.rangeEnd)}
                  <span className="ml-2 text-xs font-medium text-slate-500">
                    {active.lineCount} deduction(s) · {active.employeeCount} employee(s)
                  </span>
                </p>
                <p className="text-xs text-slate-500">Last released {cairoStamp(active.publishedAt)} (Cairo)</p>
              </div>
              {canPublish ? (
                <button
                  className="whitespace-nowrap border border-slate-300 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-red-400 hover:text-red-600 disabled:opacity-50"
                  disabled={publishing}
                  onClick={withdraw}
                  type="button"
                >
                  Withdraw all
                </button>
              ) : null}
            </div>

            {releasedLines.length > 0 ? (
              <>
                {/* Desktop: fixed-layout, merged columns, no horizontal scroll. */}
                <div className="hidden md:block">
                  <table className="w-full table-fixed text-left text-sm">
                    <colgroup>
                      <col className="w-[34%]" />
                      <col className="w-[20%]" />
                      <col className="w-[28%]" />
                      <col className="w-[18%]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
                        <th className="px-3 py-2">Employee · type</th>
                        <th className="px-3 py-2">Days · EGP</th>
                        <th className="px-3 py-2">Released</th>
                        <th className="px-3 py-2 text-right">&nbsp;</th>
                      </tr>
                    </thead>
                    <tbody>
                      {releasedLines.map((line) => (
                        <tr key={line.id} className="border-b border-slate-100 odd:bg-slate-50/60">
                          <td className="px-3 py-2">
                            <p className="font-semibold text-slate-900">{line.employeeName ?? "—"}</p>
                            <p className="text-xs text-slate-500">{dailyDeductionConnectorLabels[line.category]}</p>
                          </td>
                          <td className="px-3 py-2 tabular-nums text-slate-900">
                            {line.daysCount} d · {money(line.amount)}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-600">{cairoStamp(line.releasedAt)}</td>
                          <td className="px-3 py-2 text-right">
                            {canPublish ? (
                              <button
                                className="whitespace-nowrap border border-slate-300 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-red-400 hover:text-red-600 disabled:opacity-50"
                                disabled={publishing}
                                onClick={() => withdrawLine(line)}
                                type="button"
                              >
                                Withdraw
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile: one card per released deduction. */}
                <div className="space-y-2 md:hidden">
                  {releasedLines.map((line) => (
                    <div key={line.id} className="space-y-1.5 border border-slate-200 bg-white p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">{line.employeeName ?? "—"}</span>
                        <span className="tabular-nums text-sm font-black text-slate-900">{money(line.amount)} EGP</span>
                      </div>
                      <p className="text-xs font-medium text-slate-500">
                        {dailyDeductionConnectorLabels[line.category]} · {line.daysCount} day(s) · {cairoStamp(line.releasedAt)}
                      </p>
                      {canPublish ? (
                        <button
                          className="w-full whitespace-nowrap border border-slate-300 px-2.5 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-red-400 hover:text-red-600 disabled:opacity-50"
                          disabled={publishing}
                          onClick={() => withdrawLine(line)}
                          type="button"
                        >
                          Withdraw
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-slate-500">Nothing is released yet. Compute a range below, then release the deductions you choose — one at a time or together.</p>
        )}
      </section>

      {/* ── The range picker + compute ──────────────────────────────────── */}
      <section className="space-y-4 border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">From</span>
            <input
              className={phxFieldClassName}
              onChange={(event) => setFrom(event.target.value)}
              type="date"
              value={from}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">To</span>
            <input
              className={phxFieldClassName}
              onChange={(event) => setTo(event.target.value)}
              type="date"
              value={to}
            />
          </label>
          <button
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm bg-slate-900 px-3 py-2 text-phx-xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
            disabled={computing}
            onClick={compute}
            type="button"
          >
            <PlayCircle className="h-4 w-4" />
            {computing ? "Computing…" : "Compute tally"}
          </button>
        </div>

        {/* Only fully-elapsed days are counted — say so plainly. */}
        <p className="text-xs text-slate-500">
          The tally counts only days that have fully ended (Cairo). Today and any later day you pick are never counted.
        </p>
        {computedRange?.truncated ? (
          <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Counted through {dateChip(computedRange.effectiveTo)} only — today is not yet elapsed.
          </p>
        ) : null}

        {/* Per-connector step status. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {runs.map((run) => (
            <div
              key={run.connector}
              className="flex items-center justify-between gap-2 rounded-sm border border-slate-200 bg-slate-50 px-3 py-2"
            >
              <span className="text-sm font-semibold text-slate-800">{run.label}</span>
              <ConnectorState run={run} />
            </div>
          ))}
        </div>
      </section>

      {message ? (
        <p
          className={[
            "flex items-center gap-2 border px-3 py-2 text-sm font-semibold",
            message.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800",
          ].join(" ")}
        >
          {message.tone === "success" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
          {message.text}
        </p>
      ) : null}

      {allWarnings.length > 0 ? (
        <ul className="list-disc space-y-1 border border-amber-200 bg-amber-50 py-2 pl-8 pr-3 text-xs font-medium text-amber-900">
          {allWarnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {/* ── The running tally ───────────────────────────────────────────── */}
      {anyComputed ? (
        <section className="space-y-3 border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">Running tally</h2>
            <p className="text-sm font-semibold text-slate-900">
              {totals.lineCount} deduction(s) · {totals.employeeCount} employee(s) ·{" "}
              <span className="tabular-nums">{money(totals.amount)} EGP</span>
            </p>
          </div>

          {canPublish && allLines.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-slate-50 px-3 py-2">
              <button
                className="whitespace-nowrap border border-slate-300 bg-white px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-slate-500 disabled:opacity-50"
                disabled={publishing}
                onClick={() => setSelected(new Set(allLines.map(lineKey)))}
                type="button"
              >
                Select all
              </button>
              <button
                className="whitespace-nowrap border border-slate-300 bg-white px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-slate-500 disabled:opacity-50"
                disabled={publishing || selected.size === 0}
                onClick={() => setSelected(new Set())}
                type="button"
              >
                Clear
              </button>
              <span className="text-xs font-semibold text-slate-600">{selected.size} selected</span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button
                  className="whitespace-nowrap bg-slate-900 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
                  disabled={publishing || releasableSelected.length === 0}
                  onClick={() => release(releasableSelected, "selected")}
                  type="button"
                >
                  {publishing ? "Releasing…" : `Release selected (${releasableSelected.length})`}
                </button>
                <button
                  className="whitespace-nowrap border border-slate-900 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-900 transition hover:bg-slate-100 disabled:opacity-50"
                  disabled={publishing || releasableAll.length === 0}
                  onClick={() => release(releasableAll, "everyone")}
                  type="button"
                >
                  {`Release all (${releasableAll.length})`}
                </button>
              </div>
            </div>
          ) : null}

          {allLines.length === 0 ? (
            <p className="text-sm text-slate-500">No deductions found in this range yet.</p>
          ) : (
            <>
              {/* Desktop: a fixed-layout table that fits without a horizontal scroll. */}
              <div className="hidden md:block">
                <table className="w-full table-fixed text-left text-sm">
                  <colgroup>
                    <col className="w-[6%]" />
                    <col className="w-[24%]" />
                    <col className="w-[16%]" />
                    <col className="w-[30%]" />
                    <col className="w-[24%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
                      <th className="px-3 py-2">&nbsp;</th>
                      <th className="px-3 py-2">Deduction</th>
                      <th className="px-3 py-2">Days · EGP</th>
                      <th className="px-3 py-2">In-range days</th>
                      <th className="px-3 py-2">Release</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => (
                      <GroupRows
                        key={group.key}
                        canPublish={canPublish}
                        group={group}
                        onRelease={release}
                        onToggleEmployee={() => toggleEmployee(group)}
                        onToggleLine={toggleLine}
                        publishing={publishing}
                        releasedIndex={releasedIndex}
                        selected={selected}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile: one card per employee, a block per deduction. */}
              <div className="space-y-3 md:hidden">
                {groups.map((group) => {
                  const groupReleasable = linesToRelease(group.lines, releasedIndex);
                  const groupTicked = group.lines.every((line) => selected.has(lineKey(line)));
                  return (
                    <div key={group.key} className="border border-slate-200 bg-white">
                      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
                        {canPublish ? (
                          <input
                            aria-label={`Select every deduction for ${group.name}`}
                            checked={groupTicked}
                            className="h-4 w-4 shrink-0 accent-slate-900"
                            disabled={publishing}
                            onChange={() => toggleEmployee(group)}
                            type="checkbox"
                          />
                        ) : null}
                        <span className="min-w-0 flex-1 break-words font-semibold text-slate-900">{group.name}</span>
                        <span className="tabular-nums text-sm font-black text-slate-900">{money(group.amount)} EGP</span>
                      </div>
                      <div className="divide-y divide-slate-100">
                        {group.lines.map((line) => {
                          const state = releaseStateOf(line, releasedIndex);
                          return (
                            <div key={lineKey(line)} className="space-y-1.5 px-3 py-2.5">
                              <div className="flex items-start gap-2">
                                {canPublish ? (
                                  <input
                                    aria-label={`Select ${dailyDeductionConnectorLabels[line.category]} for ${group.name}`}
                                    checked={selected.has(lineKey(line))}
                                    className="mt-0.5 h-4 w-4 shrink-0 accent-slate-900"
                                    disabled={publishing}
                                    onChange={() => toggleLine(line)}
                                    type="checkbox"
                                  />
                                ) : null}
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-semibold text-slate-800">{dailyDeductionConnectorLabels[line.category]}</p>
                                  <p className="text-xs font-medium text-slate-500">
                                    {line.daysCount} day(s) · {money(line.amount)} EGP
                                  </p>
                                </div>
                                <StateBadge state={state} />
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {line.dates.map((date) => (
                                  <span key={date} className="whitespace-nowrap bg-slate-100 px-1.5 py-0.5 text-phx-2xs tabular-nums text-slate-600">
                                    {dateChip(date)}
                                  </span>
                                ))}
                              </div>
                              {canPublish ? (
                                <ReleaseButton
                                  disabled={publishing || state === "released"}
                                  label={state === "changed" ? "Update release" : "Release"}
                                  onClick={() => release([line], `${group.name} · ${dailyDeductionConnectorLabels[line.category]}`)}
                                />
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                      {canPublish && group.lines.length > 1 ? (
                        <div className="border-t border-slate-100 px-3 py-2">
                          <ReleaseButton
                            disabled={publishing || groupReleasable.length === 0}
                            label={`Release this employee (${groupReleasable.length})`}
                            onClick={() => release(groupReleasable, group.name)}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

function StateBadge({ state }: { state: ReleaseState }) {
  if (state === "released") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" />Released
      </span>
    );
  }
  if (state === "changed") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5" />Changed since release
      </span>
    );
  }
  return <span className="whitespace-nowrap text-xs font-medium text-slate-400">Not released</span>;
}

function ReleaseButton({ disabled, label, onClick }: { disabled: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className="w-full whitespace-nowrap bg-slate-900 px-2.5 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:bg-slate-200 disabled:text-slate-500"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

// One employee's block in the desktop table: a header row with the employee's own select-all and
// Release button, then one row per deduction, each with its own tick and Release button.
function GroupRows({
  canPublish,
  group,
  onRelease,
  onToggleEmployee,
  onToggleLine,
  publishing,
  releasedIndex,
  selected,
}: {
  canPublish: boolean;
  group: EmployeeGroup;
  onRelease: (lines: TallyLine[], label: string) => void;
  onToggleEmployee: () => void;
  onToggleLine: (line: TallyLine) => void;
  publishing: boolean;
  releasedIndex: Map<string, ReleasedLine>;
  selected: Set<string>;
}) {
  const releasable = linesToRelease(group.lines, releasedIndex);
  const everyTicked = group.lines.every((line) => selected.has(lineKey(line)));
  return (
    <>
      <tr className="border-b border-slate-200 bg-slate-100">
        <td className="px-3 py-2">
          {canPublish ? (
            <input
              aria-label={`Select every deduction for ${group.name}`}
              checked={everyTicked}
              className="h-4 w-4 accent-slate-900"
              disabled={publishing}
              onChange={onToggleEmployee}
              type="checkbox"
            />
          ) : null}
        </td>
        <td className="px-3 py-2 font-semibold text-slate-900" colSpan={2}>
          <span className="break-words">{group.name}</span>
          <span className="ml-2 text-xs font-medium tabular-nums text-slate-500">{money(group.amount)} EGP</span>
        </td>
        <td className="px-3 py-2 text-xs text-slate-500">{group.lines.length} deduction(s)</td>
        <td className="px-3 py-2">
          {canPublish ? (
            <ReleaseButton
              disabled={publishing || releasable.length === 0}
              label={`Release this employee (${releasable.length})`}
              onClick={() => onRelease(releasable, group.name)}
            />
          ) : null}
        </td>
      </tr>
      {group.lines.map((line) => {
        const state = releaseStateOf(line, releasedIndex);
        return (
          <tr key={lineKey(line)} className="border-b border-slate-100">
            <td className="px-3 py-2">
              {canPublish ? (
                <input
                  aria-label={`Select ${dailyDeductionConnectorLabels[line.category]} for ${group.name}`}
                  checked={selected.has(lineKey(line))}
                  className="h-4 w-4 accent-slate-900"
                  disabled={publishing}
                  onChange={() => onToggleLine(line)}
                  type="checkbox"
                />
              ) : null}
            </td>
            <td className="px-3 py-2 text-slate-700">{dailyDeductionConnectorLabels[line.category]}</td>
            <td className="px-3 py-2 tabular-nums text-slate-900">
              {line.daysCount} d · {money(line.amount)}
            </td>
            <td className="px-3 py-2">
              <div className="flex flex-wrap gap-1">
                {line.dates.map((date) => (
                  <span key={date} className="whitespace-nowrap bg-slate-100 px-1.5 py-0.5 text-phx-2xs tabular-nums text-slate-600">
                    {dateChip(date)}
                  </span>
                ))}
              </div>
            </td>
            <td className="px-3 py-2">
              <div className="space-y-1">
                <StateBadge state={state} />
                {canPublish ? (
                  <ReleaseButton
                    disabled={publishing || state === "released"}
                    label={state === "changed" ? "Update release" : "Release"}
                    onClick={() => onRelease([line], `${group.name} · ${dailyDeductionConnectorLabels[line.category]}`)}
                  />
                ) : null}
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}

function ConnectorState({ run }: { run: ConnectorRun }) {
  if (run.state === "pending") {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400"><Clock3 className="h-3.5 w-3.5" />Pending</span>;
  }
  if (run.state === "running") {
    return <span className="inline-flex items-center gap-1 text-xs font-semibold text-sky-600"><Clock3 className="h-3.5 w-3.5" />Running…</span>;
  }
  if (run.state === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600" title={run.error}>
        <XCircle className="h-3.5 w-3.5" />Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-emerald-700">
      <CheckCircle2 className="h-3.5 w-3.5" />
      {run.tally ? `${run.tally.lineCount} line(s)` : "Done"}
    </span>
  );
}
