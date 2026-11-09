"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, PlayCircle, RotateCcw, Search, XCircle } from "lucide-react";

import { dailyDeductionConnectorLabels, dailyDeductionConnectors, type DailyDeductionConnector } from "@/lib/daily-deductions/types.ts";
import { indexReleasedLines, linesToRelease, releaseLineKey, releaseStateOf, type ReleaseState } from "@/lib/daily-deductions/release-state.ts";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import {
  adminChipDepthClassName,
  adminControlDepthClassName,
  adminPanelDepthClassName,
  adminPanelHeaderClassName,
} from "@/components/admin/admin-design-tokens";
import { DeductionsConfirmDialog } from "@/components/admin/deductions-confirm-dialog";
import { phxFieldClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

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
  /** No computable amount (no base salary on file) — shown as such and never released. */
  amountUnknown?: boolean;
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
  /** The releaser's name, resolved by the active route. A raw HR id never reaches the screen. */
  publishedByName?: string | null;
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
  reason?: string | null;
  releasedAt: string;
  releasedBy: string | null;
};

type EmployeeGroup = {
  key: string;
  name: string;
  lines: TallyLine[];
  amount: number;
};

/** The window a tally was computed over — what a release files the lines under, never the inputs. */
type ComputedRange = {
  requestedFrom: string;
  requestedTo: string;
  from: string;
  effectiveTo: string;
  truncated: boolean;
};

type StateFilter = "all" | ReleaseState;

/** A release or withdraw waiting for its confirmation. Nothing is sent while this is set. */
type PendingAction =
  | { kind: "release"; lines: TallyLine[]; label: string }
  | { kind: "withdraw_line"; line: ReleasedLine }
  | { kind: "withdraw_all" };

function lineKey(line: { category: string; employeeHrIdCompact: string }): string {
  return releaseLineKey(line);
}

function money(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value);
}

function sumAmount(lines: ReadonlyArray<{ amount: number }>): number {
  return Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
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

// Date-only arithmetic for the range presets, in UTC so a calendar day never shifts.
function isoOffset(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isoMonthStart(iso: string, monthDelta = 0): string {
  const [year, month] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + monthDelta, 1)).toISOString().slice(0, 10);
}

function isoMonthEnd(iso: string, monthDelta = 0): string {
  const [year, month] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month + monthDelta, 0)).toISOString().slice(0, 10);
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

const PANEL = cn("border border-slate-200 bg-white", adminPanelDepthClassName);
const PANEL_TITLE = "text-xs font-black uppercase tracking-[0.14em] text-white";
const SMALL_BUTTON =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap border px-3 py-1.5 text-phx-sm font-black uppercase tracking-[0.08em] transition disabled:pointer-events-none disabled:opacity-50";
const SMALL_BUTTON_GHOST = cn(SMALL_BUTTON, "border-slate-300 bg-white text-slate-700 hover:border-slate-500", adminControlDepthClassName, "disabled:shadow-none");
const SMALL_BUTTON_DARK = cn(SMALL_BUTTON, "border-slate-900 bg-slate-900 text-white hover:bg-slate-700", adminControlDepthClassName, "disabled:shadow-none");
const SMALL_BUTTON_DANGER_GHOST = cn(SMALL_BUTTON, "border-slate-300 bg-white text-slate-700 hover:border-rose-400 hover:text-rose-700");

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
  const [computedRange, setComputedRange] = useState<ComputedRange | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [active, setActive] = useState<ActivePublication | null>(null);
  const [releasedLines, setReleasedLines] = useState<ReleasedLine[]>([]);
  const [activeLoading, setActiveLoading] = useState(true);
  // A failed read of the released snapshot is NOT "nothing released". Rendering it as the empty state
  // told the owner nothing was out when it might be — and invited him to release it all again.
  const [activeError, setActiveError] = useState<string | null>(null);
  // Which tally lines are ticked. Every line starts UNTICKED, like the weekly attendance review.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingAction | null>(null);
  // Tally filters. They narrow what is SHOWN; "Release all" still means every line in the tally.
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<DailyDeductionConnector | "all">("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [releasedSearch, setReleasedSearch] = useState("");

  function loadActive() {
    setActiveLoading(true);
    setActiveError(null);
    fetchJson<{ publication: ActivePublication | null; lines?: ReleasedLine[] }>("/api/admin/daily-deductions/active")
      .then((payload) => {
        setActive(payload.publication);
        setReleasedLines(payload.publication ? (payload.lines ?? []) : []);
      })
      .catch((error) => {
        setActive(null);
        setReleasedLines([]);
        setActiveError(error instanceof Error ? error.message : "The released deductions could not be read.");
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
    const employees = new Set(allLines.map((line) => line.employeeHrIdCompact));
    return { amount: sumAmount(allLines), employeeCount: employees.size, lineCount: allLines.length };
  }, [allLines]);

  const releasedTotals = useMemo(() => {
    const employees = new Set(releasedLines.map((line) => line.employeeHrIdCompact));
    return { amount: sumAmount(releasedLines), employeeCount: employees.size, lineCount: releasedLines.length };
  }, [releasedLines]);

  const anyComputed = runs.some((run) => run.state === "done");
  const failedRuns = runs.filter((run) => run.state === "failed");

  const releasedIndex = useMemo(() => indexReleasedLines(releasedLines), [releasedLines]);

  // The range inputs moved after the tally was computed. The figures on screen belong to the OLD
  // window, so releasing them under the new one would file real deductions against days nobody
  // counted — the release is held until the tally is recomputed.
  const rangeIsStale = Boolean(computedRange) && (computedRange!.requestedFrom !== from || computedRange!.requestedTo !== to);
  const rangeInvalid = Boolean(from && to && from > to);

  const categoryCounts = useMemo(() => {
    const counts = new Map<DailyDeductionConnector, number>();
    for (const line of allLines) counts.set(line.category, (counts.get(line.category) ?? 0) + 1);
    return counts;
  }, [allLines]);

  const visibleLines = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return allLines.filter((line) => {
      if (categoryFilter !== "all" && line.category !== categoryFilter) return false;
      if (stateFilter !== "all" && releaseStateOf(line, releasedIndex) !== stateFilter) return false;
      if (needle && !(line.employeeName ?? "").toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [allLines, categoryFilter, releasedIndex, search, stateFilter]);

  // The tally grouped by employee, in the order the connectors returned them (name, then id).
  const groups = useMemo(() => {
    const byEmployee = new Map<string, EmployeeGroup>();
    for (const line of visibleLines) {
      const existing = byEmployee.get(line.employeeHrIdCompact);
      if (existing) {
        existing.lines.push(line);
        existing.amount += line.amount;
      } else {
        byEmployee.set(line.employeeHrIdCompact, {
          key: line.employeeHrIdCompact,
          name: line.employeeName ?? "Name unavailable",
          lines: [line],
          amount: line.amount,
        });
      }
    }
    return [...byEmployee.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [visibleLines]);

  const visibleReleased = useMemo(() => {
    const needle = releasedSearch.trim().toLowerCase();
    const rows = needle
      ? releasedLines.filter((line) => (line.employeeName ?? "").toLowerCase().includes(needle))
      : releasedLines;
    return [...rows].sort((a, b) => (a.employeeName ?? "").localeCompare(b.employeeName ?? ""));
  }, [releasedLines, releasedSearch]);

  const selectedLines = useMemo(() => allLines.filter((line) => selected.has(lineKey(line))), [allLines, selected]);
  const releasableSelected = useMemo(() => linesToRelease(selectedLines, releasedIndex), [selectedLines, releasedIndex]);
  const releasableAll = useMemo(() => linesToRelease(allLines, releasedIndex), [allLines, releasedIndex]);
  const releaseBlocked = publishing || rangeIsStale || !computedRange;

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

  function applyPreset(nextFrom: string, nextTo: string) {
    setFrom(nextFrom);
    setTo(nextTo);
  }

  const presets = useMemo(
    () => [
      { label: "Open cycle", from: defaultFrom, to: defaultTo },
      { label: "This month so far", from: isoMonthStart(defaultTo), to: defaultTo },
      { label: "Last 7 days", from: isoOffset(defaultTo, -7), to: defaultTo },
      { label: "Previous month", from: isoMonthStart(defaultTo, -1), to: isoMonthEnd(defaultTo, -1) },
    ],
    [defaultFrom, defaultTo],
  );

  async function compute() {
    if (computing || rangeInvalid) return;
    setComputing(true);
    setMessage(null);
    setComputedRange(null);
    setSelected(new Set());
    // Reset every connector to pending before the sweep.
    setRuns((prev) => prev.map((run) => ({ ...run, state: "pending", tally: undefined, error: undefined })));

    const requestedFrom = from;
    const requestedTo = to;
    let lastRange: ComputedRange | null = null;
    for (const connector of dailyDeductionConnectors) {
      setRuns((prev) => prev.map((run) => (run.connector === connector ? { ...run, state: "running" } : run)));
      try {
        const payload = await fetchJsonWithTimeout<{ tally: ConnectorTally }>(
          "/api/admin/daily-deductions/compute",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connector, from: requestedFrom, to: requestedTo }),
          },
          COMPUTE_REQUEST_TIMEOUT_MS,
        );
        lastRange = {
          requestedFrom,
          requestedTo,
          from: payload.tally.from,
          effectiveTo: payload.tally.effectiveTo,
          truncated: payload.tally.truncated,
        };
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
  // them into the active snapshot; everything already released stays exactly as it was. The window
  // sent is the one the tally was COMPUTED over — the inputs may have moved since.
  async function release(lines: TallyLine[], label: string) {
    if (!canPublish || publishing || !computedRange || rangeIsStale) return;
    if (lines.length === 0) {
      setMessage({ tone: "error", text: "Nothing to release — those deductions are already released as shown." });
      return;
    }
    setPublishing(true);
    setMessage(null);
    try {
      const payload = await fetchJson<{
        releasedCount: number;
        // ReleaseNoticeOutcome — "sent", "failed", "skipped" or "not_found" per released line.
        notifications?: Array<{ status?: string }>;
      }>("/api/admin/daily-deductions/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rangeStart: computedRange.from, rangeEnd: computedRange.effectiveTo, lines }),
      });
      const notices = payload.notifications ?? [];
      const told = notices.filter((notice) => notice.status === "sent").length;
      const failedNotices = notices.filter((notice) => notice.status === "failed" || notice.status === "not_found").length;
      const noticeText =
        notices.length > 0
          ? told === notices.length
            ? " Each employee has been told."
            : ` ${told} of ${notices.length} employee notice(s) went out${failedNotices > 0 ? ` — ${failedNotices} could not be sent` : ""}.`
          : "";
      setMessage({
        tone: failedNotices > 0 ? "error" : "success",
        text: `Released ${plural(payload.releasedCount, "deduction")} (${label}). Every other released deduction is unchanged.${noticeText}`,
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
      setPending(null);
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
        text: `Withdrew ${line.employeeName ?? "Name unavailable"} · ${dailyDeductionConnectorLabels[line.category]}. The other released deductions are unchanged.`,
      });
      loadActive();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setPublishing(false);
      setPending(null);
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
      setPending(null);
    }
  }

  function confirmPending() {
    if (!pending) return;
    if (pending.kind === "release") void release(pending.lines, pending.label);
    else if (pending.kind === "withdraw_line") void withdrawLine(pending.line);
    else void withdraw();
  }

  function askRelease(lines: TallyLine[], label: string) {
    if (lines.length === 0) {
      setMessage({ tone: "error", text: "Nothing to release — those deductions are already released as shown." });
      return;
    }
    setPending({ kind: "release", lines, label });
  }

  const allWarnings = runs.flatMap((run) => run.tally?.warnings ?? []);
  const notReleased = releasableAll;

  return (
    <div className="space-y-5">
      {/* ── The figures at a glance ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          caption={active ? `${plural(releasedTotals.employeeCount, "employee")} · ${plural(releasedTotals.lineCount, "line")}` : "Nothing released"}
          label="Released"
          loading={activeLoading}
          tone="dark"
          unavailable={Boolean(activeError)}
          value={`${money(releasedTotals.amount)} EGP`}
        />
        <KpiTile
          caption={anyComputed ? `${plural(totals.employeeCount, "employee")} · ${plural(totals.lineCount, "line")}` : "Compute a range"}
          label="Running tally"
          value={anyComputed ? `${money(totals.amount)} EGP` : "—"}
        />
        <KpiTile
          caption={anyComputed ? plural(notReleased.length, "line") : "Compute a range"}
          label="Not yet released"
          tone={notReleased.length > 0 ? "warn" : "plain"}
          value={anyComputed ? `${money(sumAmount(notReleased))} EGP` : "—"}
        />
        <KpiTile
          caption={plural(selectedLines.length, "line") + " ticked"}
          label="Selected"
          value={`${money(sumAmount(selectedLines))} EGP`}
        />
      </div>

      {/* ── The released snapshot ───────────────────────────────────────── */}
      <section className={PANEL}>
        <div className={cn("flex flex-wrap items-center justify-between gap-3 px-4 py-3", adminPanelHeaderClassName)}>
          <h2 className={PANEL_TITLE}>Released to employees</h2>
          {canPublish && active ? (
            <button
              className={cn(SMALL_BUTTON, "border-white/25 bg-white/10 text-white hover:border-rose-300 hover:text-rose-100")}
              disabled={publishing}
              onClick={() => setPending({ kind: "withdraw_all" })}
              type="button"
            >
              Withdraw all
            </button>
          ) : null}
        </div>
        <div className="space-y-3 p-4">
          {activeLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : activeError ? (
            <div className="flex flex-wrap items-center gap-3 border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">
              <XCircle className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                The released deductions could not be read, so this screen cannot say what is out. {activeError}
              </span>
              <button className={SMALL_BUTTON_GHOST} onClick={loadActive} type="button">
                <RotateCcw className="h-3.5 w-3.5" />
                Try again
              </button>
            </div>
          ) : active ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-sm font-bold text-slate-900">
                    {dateChip(active.rangeStart)} — {dateChip(active.rangeEnd)}
                  </p>
                  <p className="text-xs text-slate-500">
                    Last released {cairoStamp(active.publishedAt)} (Cairo)
                    {active.publishedByName ? ` by ${active.publishedByName}` : ""}
                  </p>
                </div>
                <CategoryTotals totals={active.categoryTotals} />
              </div>

              {releasedLines.length > 0 ? (
                <>
                  <SearchField onChange={setReleasedSearch} placeholder="Find an employee" value={releasedSearch} />
                  {visibleReleased.length === 0 ? (
                    <p className="text-sm text-slate-500">No released deduction matches “{releasedSearch}”.</p>
                  ) : null}
                  {/* Desktop: fixed-layout, merged columns, no horizontal scroll. */}
                  <div className="hidden md:block">
                    <table className="w-full table-fixed text-left text-sm">
                      <colgroup>
                        <col className="w-[30%]" />
                        <col className="w-[16%]" />
                        <col className="w-[38%]" />
                        <col className="w-[16%]" />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
                          <th className="px-3 py-2">Employee · type</th>
                          <th className="px-3 py-2 text-right">Days · EGP</th>
                          <th className="px-3 py-2">Days charged · released</th>
                          <th className="px-3 py-2 text-right">&nbsp;</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleReleased.map((line) => (
                          <tr key={line.id} className="border-b border-slate-100 align-top odd:bg-slate-50/60">
                            <td className="px-3 py-2">
                              <p className="break-words font-semibold text-slate-900">{line.employeeName ?? "Name unavailable"}</p>
                              <p className="text-xs text-slate-500">{dailyDeductionConnectorLabels[line.category]}</p>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-slate-900">
                              <p className="font-bold">{money(line.amount)}</p>
                              <p className="text-xs text-slate-500">{plural(line.daysCount, "day")}</p>
                            </td>
                            <td className="px-3 py-2">
                              <DateChips dates={line.dates} />
                              <p className="mt-1 text-xs text-slate-500">{cairoStamp(line.releasedAt)}</p>
                            </td>
                            <td className="px-3 py-2 text-right">
                              {canPublish ? (
                                <button
                                  className={SMALL_BUTTON_DANGER_GHOST}
                                  disabled={publishing}
                                  onClick={() => setPending({ kind: "withdraw_line", line })}
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
                    {visibleReleased.map((line) => (
                      <div key={line.id} className="space-y-1.5 border border-slate-200 bg-white p-3">
                        <div className="flex items-start justify-between gap-2">
                          <span className="min-w-0 break-words font-semibold text-slate-900">{line.employeeName ?? "Name unavailable"}</span>
                          <span className="shrink-0 tabular-nums text-sm font-black text-slate-900">{money(line.amount)} EGP</span>
                        </div>
                        <p className="text-xs font-medium text-slate-500">
                          {dailyDeductionConnectorLabels[line.category]} · {plural(line.daysCount, "day")} · {cairoStamp(line.releasedAt)}
                        </p>
                        <DateChips dates={line.dates} />
                        {canPublish ? (
                          <button
                            className={cn(SMALL_BUTTON_DANGER_GHOST, "w-full")}
                            disabled={publishing}
                            onClick={() => setPending({ kind: "withdraw_line", line })}
                            type="button"
                          >
                            Withdraw
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-slate-500">The snapshot is open but holds no deduction now.</p>
              )}
            </>
          ) : (
            <p className="text-sm text-slate-500">
              {canPublish
                ? "Nothing is released yet. Compute a range below, then release the deductions you choose — one at a time or together."
                : "Nothing is released yet."}
            </p>
          )}
        </div>
      </section>

      {/* ── The range picker + compute ──────────────────────────────────── */}
      {/* Super Admin only: /compute refuses every other role, so a reader never sees a button that
          can only fail. A reader's page is the released snapshot above. */}
      {canPublish ? (
      <section className={PANEL}>
        <div className={cn("px-4 py-3", adminPanelHeaderClassName)}>
          <h2 className={PANEL_TITLE}>Count a date range</h2>
        </div>
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap gap-1.5">
            {presets.map((preset) => {
              const on = preset.from === from && preset.to === to;
              return (
                <button
                  aria-pressed={on}
                  className={cn(
                    SMALL_BUTTON,
                    adminChipDepthClassName,
                    on ? "border-orange-500 bg-orange-50 text-orange-700" : "border-slate-200 bg-white text-slate-600 hover:border-slate-400",
                  )}
                  disabled={computing}
                  key={preset.label}
                  onClick={() => applyPreset(preset.from, preset.to)}
                  type="button"
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">From</span>
              <input
                className={phxFieldClassName}
                disabled={computing}
                onChange={(event) => setFrom(event.target.value)}
                type="date"
                value={from}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">To</span>
              <input
                className={phxFieldClassName}
                disabled={computing}
                onChange={(event) => setTo(event.target.value)}
                type="date"
                value={to}
              />
            </label>
            <button
              className={cn(SMALL_BUTTON_DARK, "px-4 py-2 text-phx-xs")}
              disabled={computing || rangeInvalid || !from || !to}
              onClick={compute}
              type="button"
            >
              <PlayCircle className="h-4 w-4" />
              {computing ? "Computing…" : anyComputed ? "Recompute tally" : "Compute tally"}
            </button>
          </div>

          {rangeInvalid ? (
            <p className="flex items-center gap-1.5 text-xs font-bold text-rose-700">
              <XCircle className="h-3.5 w-3.5 shrink-0" />
              The start date is after the end date.
            </p>
          ) : null}
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

          {/* Per-connector step status. A failure says WHY in the card itself — a tooltip never
              reaches a phone. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {runs.map((run) => (
              <div
                key={run.connector}
                className={cn(
                  "border px-3 py-2",
                  run.state === "failed" ? "border-rose-200 bg-rose-50" : run.state === "done" ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 break-words text-sm font-semibold text-slate-800">{run.label}</span>
                  <ConnectorState run={run} />
                </div>
                {run.state === "failed" && run.error ? (
                  <p className="mt-1 break-words text-xs font-medium text-rose-800">{run.error}</p>
                ) : null}
              </div>
            ))}
          </div>
          {failedRuns.length > 0 && !computing ? (
            <p className="flex items-center gap-1.5 text-xs font-bold text-rose-700">
              <XCircle className="h-3.5 w-3.5 shrink-0" />
              {plural(failedRuns.length, "source")} could not be read, so the tally below is missing them — it is not a zero for those sources.
            </p>
          ) : null}
        </div>
      </section>
      ) : null}

      {message ? (
        <p
          className={cn(
            "flex items-start gap-2 border px-3 py-2 text-sm font-semibold",
            message.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800",
          )}
          role="status"
        >
          {message.tone === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span className="min-w-0 break-words">{message.text}</span>
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
        <section className={PANEL}>
          <div className={cn("flex flex-wrap items-center justify-between gap-3 px-4 py-3", adminPanelHeaderClassName)}>
            <h2 className={PANEL_TITLE}>Running tally</h2>
            <p className="text-xs font-bold text-slate-200">
              {computedRange ? `${dateChip(computedRange.from)} — ${dateChip(computedRange.effectiveTo)} · ` : ""}
              {plural(totals.lineCount, "deduction")} · {plural(totals.employeeCount, "employee")} ·{" "}
              <span className="tabular-nums text-white">{money(totals.amount)} EGP</span>
            </p>
          </div>

          {rangeIsStale ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-900">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                The dates above changed after this tally was counted, so these figures belong to{" "}
                {dateChip(computedRange!.from)} — {dateChip(computedRange!.effectiveTo)}. Recompute before releasing.
              </span>
              <button
                className={SMALL_BUTTON_GHOST}
                onClick={() => applyPreset(computedRange!.requestedFrom, computedRange!.requestedTo)}
                type="button"
              >
                Put the dates back
              </button>
            </div>
          ) : null}

          {allLines.length > 0 ? (
            <div className="space-y-2 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <SearchField onChange={setSearch} placeholder="Find an employee" value={search} />
                <select
                  aria-label="Release state"
                  className={cn(phxSelectClassName, "w-auto")}
                  onChange={(event) => setStateFilter(event.target.value as StateFilter)}
                  value={stateFilter}
                >
                  <option value="all">Every state</option>
                  <option value="not_released">Not released</option>
                  <option value="changed">Changed since release</option>
                  <option value="released">Released</option>
                </select>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <FilterChip active={categoryFilter === "all"} count={allLines.length} label="All types" onClick={() => setCategoryFilter("all")} />
                {dailyDeductionConnectors
                  .filter((connector) => (categoryCounts.get(connector) ?? 0) > 0)
                  .map((connector) => (
                    <FilterChip
                      active={categoryFilter === connector}
                      count={categoryCounts.get(connector) ?? 0}
                      key={connector}
                      label={dailyDeductionConnectorLabels[connector]}
                      onClick={() => setCategoryFilter(connector)}
                    />
                  ))}
              </div>
            </div>
          ) : null}

          {canPublish && allLines.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5">
              <button
                className={SMALL_BUTTON_GHOST}
                disabled={publishing || visibleLines.length === 0}
                onClick={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    for (const line of visibleLines) next.add(lineKey(line));
                    return next;
                  })
                }
                type="button"
              >
                {visibleLines.length === allLines.length ? "Select all" : `Select shown (${visibleLines.length})`}
              </button>
              <button
                className={SMALL_BUTTON_GHOST}
                disabled={publishing || selected.size === 0}
                onClick={() => setSelected(new Set())}
                type="button"
              >
                Clear
              </button>
              <span className="text-xs font-semibold text-slate-600">
                {selected.size} selected · <span className="tabular-nums">{money(sumAmount(selectedLines))} EGP</span>
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button
                  className={SMALL_BUTTON_DARK}
                  disabled={releaseBlocked || releasableSelected.length === 0}
                  onClick={() => askRelease(releasableSelected, "selected")}
                  type="button"
                >
                  {publishing ? "Releasing…" : `Release selected (${releasableSelected.length})`}
                </button>
                <button
                  className={cn(SMALL_BUTTON, "border-orange-600 bg-orange-600 text-white hover:bg-orange-700", adminControlDepthClassName, "disabled:shadow-none")}
                  disabled={releaseBlocked || releasableAll.length === 0}
                  onClick={() => askRelease(releasableAll, "everyone")}
                  type="button"
                >
                  {`Release all (${releasableAll.length})`}
                </button>
              </div>
            </div>
          ) : null}

          <div className="p-4">
            {allLines.length === 0 ? (
              <p className="text-sm text-slate-500">
                {failedRuns.length > 0
                  ? "No deductions found by the sources that could be read. The failed sources above were not counted."
                  : "No deductions found in this range."}
              </p>
            ) : groups.length === 0 ? (
              <p className="text-sm text-slate-500">No deduction matches these filters.</p>
            ) : (
              <>
                {/* Desktop: a fixed-layout table that fits without a horizontal scroll. */}
                <div className="hidden md:block">
                  <table className="w-full table-fixed text-left text-sm">
                    <colgroup>
                      <col className="w-[5%]" />
                      <col className="w-[30%]" />
                      <col className="w-[14%]" />
                      <col className="w-[31%]" />
                      <col className="w-[20%]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
                        <th className="px-3 py-2">&nbsp;</th>
                        <th className="px-3 py-2">Deduction · why</th>
                        <th className="px-3 py-2 text-right">Days · EGP</th>
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
                          onRelease={askRelease}
                          onToggleEmployee={() => toggleEmployee(group)}
                          onToggleLine={toggleLine}
                          publishing={releaseBlocked}
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
                                      {plural(line.daysCount, "day")} ·{" "}
                                      {line.amountUnknown ? (
                                        <span className="font-bold text-amber-700">No salary on file</span>
                                      ) : (
                                        `${money(line.amount)} EGP`
                                      )}
                                    </p>
                                  </div>
                                  <StateBadge state={state} />
                                </div>
                                {line.reason ? <p className="break-words text-xs text-slate-600">{line.reason}</p> : null}
                                <DateChips dates={line.dates} />
                                {canPublish ? (
                                  <ReleaseButton
                                    disabled={releaseBlocked || state === "released" || line.amountUnknown === true}
                                    label={line.amountUnknown ? "Held: no salary" : state === "changed" ? "Update release" : "Release"}
                                    onClick={() => askRelease([line], `${group.name} · ${dailyDeductionConnectorLabels[line.category]}`)}
                                  />
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                        {canPublish && group.lines.length > 1 ? (
                          <div className="border-t border-slate-100 px-3 py-2">
                            <ReleaseButton
                              disabled={releaseBlocked || groupReleasable.length === 0}
                              label={`Release this employee (${groupReleasable.length})`}
                              onClick={() => askRelease(groupReleasable, group.name)}
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </section>
      ) : null}

      <DeductionsConfirmDialog
        busy={publishing}
        confirmLabel={
          pending?.kind === "release" ? `Release ${plural(pending.lines.length, "deduction")}` : pending?.kind === "withdraw_all" ? "Withdraw everything" : "Withdraw"
        }
        facts={pendingFacts(pending, releasedTotals, computedRange)}
        onCancel={() => setPending(null)}
        onConfirm={confirmPending}
        open={pending !== null}
        title={
          pending?.kind === "release"
            ? "Release these deductions?"
            : pending?.kind === "withdraw_all"
              ? "Withdraw every released deduction?"
              : "Withdraw this deduction?"
        }
        tone={pending?.kind === "release" ? "commit" : "danger"}
      >
        {pending?.kind === "release" ? (
          <p>
            Each employee is emailed the amount, the reason and the days, and their manager is told in the app. Every
            deduction already released stays exactly as it is.
          </p>
        ) : pending?.kind === "withdraw_all" ? (
          <p>The whole released snapshot is taken back out of the employee portal. Nothing stays released afterwards.</p>
        ) : (
          <p>Only this one deduction is taken back out. Every other released deduction stays exactly as it is.</p>
        )}
      </DeductionsConfirmDialog>
    </div>
  );
}

function pendingFacts(
  pending: PendingAction | null,
  releasedTotals: { amount: number; employeeCount: number; lineCount: number },
  computedRange: ComputedRange | null,
): Array<{ label: string; value: string }> {
  if (!pending) return [];
  if (pending.kind === "release") {
    const employees = new Set(pending.lines.map((line) => line.employeeHrIdCompact));
    return [
      { label: "Amount", value: `${money(sumAmount(pending.lines))} EGP` },
      { label: "People", value: plural(employees.size, "employee") },
      { label: "Deductions", value: `${plural(pending.lines.length, "line")} · ${pending.label}` },
      {
        label: "Days counted",
        value: computedRange ? `${dateChip(computedRange.from)} — ${dateChip(computedRange.effectiveTo)}` : "—",
      },
    ];
  }
  if (pending.kind === "withdraw_line") {
    return [
      { label: "Employee", value: pending.line.employeeName ?? "Name unavailable" },
      { label: "Type", value: dailyDeductionConnectorLabels[pending.line.category] },
      { label: "Amount", value: `${money(pending.line.amount)} EGP` },
      { label: "Days", value: plural(pending.line.daysCount, "day") },
    ];
  }
  return [
    { label: "Amount", value: `${money(releasedTotals.amount)} EGP` },
    { label: "People", value: plural(releasedTotals.employeeCount, "employee") },
  ];
}

function KpiTile({
  caption,
  label,
  loading = false,
  tone = "plain",
  unavailable = false,
  value,
}: {
  caption: string;
  label: string;
  loading?: boolean;
  tone?: "plain" | "dark" | "warn";
  unavailable?: boolean;
  value: string;
}) {
  const dark = tone === "dark";
  return (
    <div
      className={cn(
        "border p-3 sm:p-4",
        adminPanelDepthClassName,
        dark ? cn("border-slate-900", adminPanelHeaderClassName) : tone === "warn" ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white",
      )}
    >
      <p className={cn("text-phx-sm font-black uppercase tracking-[0.12em]", dark ? "text-orange-300" : tone === "warn" ? "text-amber-700" : "text-slate-500")}>
        {label}
      </p>
      <p className={cn("mt-1 break-words text-lg font-black tabular-nums sm:text-2xl", dark ? "text-white" : tone === "warn" ? "text-amber-900" : "text-slate-900")}>
        {loading ? "…" : unavailable ? "Unavailable" : value}
      </p>
      <p className={cn("mt-0.5 text-xs font-semibold", dark ? "text-slate-300" : tone === "warn" ? "text-amber-700" : "text-slate-500")}>
        {loading ? "Loading" : unavailable ? "Could not be read" : caption}
      </p>
    </div>
  );
}

function CategoryTotals({ totals }: { totals: Partial<Record<DailyDeductionConnector, number>> }) {
  const entries = dailyDeductionConnectors.filter((connector) => Number(totals[connector] ?? 0) > 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map((connector) => (
        <span
          className={cn("border border-slate-200 bg-slate-50 px-2 py-1 text-phx-sm font-bold text-slate-700", adminChipDepthClassName)}
          key={connector}
        >
          {dailyDeductionConnectorLabels[connector]} · <span className="tabular-nums">{money(Number(totals[connector] ?? 0))}</span>
        </span>
      ))}
    </div>
  );
}

function SearchField({ onChange, placeholder, value }: { onChange: (value: string) => void; placeholder: string; value: string }) {
  return (
    <label className="relative block min-w-0 flex-1 sm:max-w-xs">
      <span className="sr-only">{placeholder}</span>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      <input
        className={cn(phxFieldClassName, "pl-8")}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
    </label>
  );
}

function FilterChip({ active, count, label, onClick }: { active: boolean; count: number; label: string; onClick: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 border px-2.5 py-1 text-phx-sm font-black uppercase tracking-[0.06em] transition",
        adminChipDepthClassName,
        active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-400",
      )}
      onClick={onClick}
      type="button"
    >
      {label}
      <span className={cn("tabular-nums", active ? "text-orange-300" : "text-slate-400")}>{count}</span>
    </button>
  );
}

function DateChips({ dates }: { dates: string[] }) {
  if (dates.length === 0) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {[...dates].sort().map((date) => (
        <span key={date} className="whitespace-nowrap border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-sm tabular-nums text-slate-600">
          {dateChip(date)}
        </span>
      ))}
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
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />Changed since release
      </span>
    );
  }
  return <span className="whitespace-nowrap text-xs font-medium text-slate-400">Not released</span>;
}

function ReleaseButton({ disabled, label, onClick }: { disabled: boolean; label: string; onClick: () => void }) {
  return (
    <button className={cn(SMALL_BUTTON_DARK, "w-full whitespace-normal px-2.5")} disabled={disabled} onClick={onClick} type="button">
      {label}
    </button>
  );
}

// One employee's block in the desktop table: a header row with the employee's own select-all and
// Release button, then one row per deduction, each with its own tick, its reason and Release button.
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
              onChange={onToggleEmployee}
              type="checkbox"
            />
          ) : null}
        </td>
        <td className="px-3 py-2 font-semibold text-slate-900">
          <span className="break-words">{group.name}</span>
        </td>
        <td className="px-3 py-2 text-right text-sm font-black tabular-nums text-slate-900">{money(group.amount)}</td>
        <td className="px-3 py-2 text-xs text-slate-500">{plural(group.lines.length, "deduction")}</td>
        <td className="px-3 py-2">
          {canPublish && group.lines.length > 1 ? (
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
          <tr key={lineKey(line)} className="border-b border-slate-100 align-top">
            <td className="px-3 py-2">
              {canPublish ? (
                <input
                  aria-label={`Select ${dailyDeductionConnectorLabels[line.category]} for ${group.name}`}
                  checked={selected.has(lineKey(line))}
                  className="h-4 w-4 accent-slate-900"
                  onChange={() => onToggleLine(line)}
                  type="checkbox"
                />
              ) : null}
            </td>
            <td className="px-3 py-2">
              <p className="font-semibold text-slate-700">{dailyDeductionConnectorLabels[line.category]}</p>
              {line.reason ? <p className="mt-0.5 break-words text-xs text-slate-500">{line.reason}</p> : null}
            </td>
            <td className="px-3 py-2 text-right tabular-nums text-slate-900">
              {line.amountUnknown ? (
                <p className="text-xs font-bold text-amber-700">No salary on file</p>
              ) : (
                <p className="font-bold">{money(line.amount)}</p>
              )}
              <p className="text-xs text-slate-500">{plural(line.daysCount, "day")}</p>
            </td>
            <td className="px-3 py-2">
              <DateChips dates={line.dates} />
            </td>
            <td className="px-3 py-2">
              <div className="space-y-1">
                <StateBadge state={state} />
                {canPublish ? (
                  <ReleaseButton
                    disabled={publishing || state === "released" || line.amountUnknown === true}
                    label={line.amountUnknown ? "Held: no salary" : state === "changed" ? "Update release" : "Release"}
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
    return <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-slate-400"><Clock3 className="h-3.5 w-3.5" />Waiting</span>;
  }
  if (run.state === "running") {
    return <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-orange-600"><Clock3 className="h-3.5 w-3.5 animate-spin" />Counting…</span>;
  }
  if (run.state === "failed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-rose-700">
        <XCircle className="h-3.5 w-3.5" />Failed
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-semibold text-emerald-700">
      <CheckCircle2 className="h-3.5 w-3.5" />
      {run.tally ? `${plural(run.tally.lineCount, "line")} · ${money(run.tally.totalAmount)}` : "Done"}
    </span>
  );
}
