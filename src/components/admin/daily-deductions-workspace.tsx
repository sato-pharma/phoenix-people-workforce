"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, PlayCircle, XCircle } from "lucide-react";

import { dailyDeductionConnectorLabels, dailyDeductionConnectors, type DailyDeductionConnector } from "@/lib/daily-deductions/types.ts";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";

// The tally line the compute route returns (DailyDeductionTallyLine). Sent back
// verbatim to the publish route as the reviewed lines — no reshaping in between.
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
  const [activeLoading, setActiveLoading] = useState(true);

  function loadActive() {
    setActiveLoading(true);
    fetchJson<{ publication: ActivePublication | null }>("/api/admin/daily-deductions/active")
      .then((payload) => setActive(payload.publication))
      .catch(() => setActive(null))
      .finally(() => setActiveLoading(false));
  }

  useEffect(() => {
    loadActive();
  }, []);

  // Every reviewed line across the four connectors, flattened. This is exactly
  // what the publish click sends — no reshaping, so what the owner sees is what
  // is stored.
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

  async function compute() {
    if (computing) return;
    setComputing(true);
    setMessage(null);
    setComputedRange(null);
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

  async function publish() {
    if (!canPublish || publishing || allLines.length === 0) return;
    setPublishing(true);
    setMessage(null);
    try {
      const payload = await fetchJson<{ publication: ActivePublication; lineCount: number; employeeCount: number }>(
        "/api/admin/daily-deductions/publish",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rangeStart: from, rangeEnd: to, lines: allLines }),
        },
      );
      setMessage({
        tone: "success",
        text: `Published — ${payload.lineCount} line(s) across ${payload.employeeCount} employee(s). This is now the active tally.`,
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
      {/* ── The active snapshot ─────────────────────────────────────────── */}
      <section className="space-y-3 border border-slate-200 bg-white p-4">
        <h2 className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">Currently published</h2>
        {activeLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : active ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-slate-900">
                {dateChip(active.rangeStart)} — {dateChip(active.rangeEnd)}
                <span className="ml-2 text-xs font-medium text-slate-500">
                  {active.lineCount} line(s) · {active.employeeCount} employee(s)
                </span>
              </p>
              <p className="text-xs text-slate-500">Published {cairoStamp(active.publishedAt)} (Cairo)</p>
            </div>
            {canPublish ? (
              <button
                className="whitespace-nowrap rounded-sm border border-slate-300 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-red-400 hover:text-red-600 disabled:opacity-50"
                disabled={publishing}
                onClick={withdraw}
                type="button"
              >
                Withdraw
              </button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-500">Nothing is published yet. Compute a range below and publish it.</p>
        )}
      </section>

      {/* ── The range picker + compute ──────────────────────────────────── */}
      <section className="space-y-4 border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">From</span>
            <input
              className="rounded-sm border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-orange-400 focus:outline-none"
              onChange={(event) => setFrom(event.target.value)}
              type="date"
              value={from}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">To</span>
            <input
              className="rounded-sm border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-orange-400 focus:outline-none"
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
              {totals.lineCount} line(s) · {totals.employeeCount} employee(s) ·{" "}
              <span className="tabular-nums">{money(totals.amount)} EGP</span>
            </p>
          </div>

          {allLines.length === 0 ? (
            <p className="text-sm text-slate-500">No deductions found in this range yet.</p>
          ) : (
            <>
              {/* Desktop: a fixed-layout table that fits without a horizontal scroll. */}
              <div className="hidden md:block">
                <table className="w-full table-fixed text-left text-sm">
                  <colgroup>
                    <col className="w-[26%]" />
                    <col className="w-[18%]" />
                    <col className="w-[10%]" />
                    <col className="w-[16%]" />
                    <col className="w-[30%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
                      <th className="px-3 py-2">Employee</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">Days</th>
                      <th className="px-3 py-2">Amount (EGP)</th>
                      <th className="px-3 py-2">In-range days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allLines.map((line, index) => (
                      <tr key={`${line.category}-${line.employeeHrIdCompact}-${index}`} className="border-b border-slate-100 odd:bg-slate-50/60">
                        <td className="px-3 py-2 font-semibold text-slate-900">{line.employeeName ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-700">{dailyDeductionConnectorLabels[line.category]}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-700">{line.daysCount}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-900">{money(line.amount)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {line.dates.map((date) => (
                              <span key={date} className="whitespace-nowrap rounded-sm bg-slate-100 px-1.5 py-0.5 text-phx-2xs tabular-nums text-slate-600">
                                {dateChip(date)}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile: one card per line. */}
              <div className="space-y-2 md:hidden">
                {allLines.map((line, index) => (
                  <div key={`${line.category}-${line.employeeHrIdCompact}-${index}`} className="space-y-1.5 border border-slate-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">{line.employeeName ?? "—"}</span>
                      <span className="tabular-nums text-sm font-black text-slate-900">{money(line.amount)} EGP</span>
                    </div>
                    <p className="text-xs font-medium text-slate-500">
                      {dailyDeductionConnectorLabels[line.category]} · {line.daysCount} day(s)
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {line.dates.map((date) => (
                        <span key={date} className="whitespace-nowrap rounded-sm bg-slate-100 px-1.5 py-0.5 text-phx-2xs tabular-nums text-slate-600">
                          {dateChip(date)}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {canPublish ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm bg-slate-900 px-4 py-2 text-phx-xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
                disabled={publishing || allLines.length === 0}
                onClick={publish}
                type="button"
              >
                {publishing ? "Publishing…" : "Publish this tally"}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
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
