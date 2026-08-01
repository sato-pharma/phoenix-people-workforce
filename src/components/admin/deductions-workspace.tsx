"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, PlayCircle, XCircle } from "lucide-react";

import { DEDUCTIONS_CATEGORY_CONFIG } from "@/lib/deductions/calculations.ts";
import { deductionsCategories, type DeductionsCategory } from "@/lib/deductions/types.ts";

type CandidateApiRow = {
  id: string;
  category: DeductionsCategory;
  employeeHrId: string;
  employeeName: string | null;
  monthKey: string;
  unit: "days" | "amount";
  rawValue: number;
  estimatedAmount: number | null;
  calculationStatus: "calculated" | "requires_review";
  severity: "Low" | "Medium" | "High" | "Review" | null;
  reason: string | null;
  dates: string[];
  decision: {
    id: string;
    decisionStatus: string;
    decisionReason: string;
    hrNote: string;
    appliedValue: number | null;
    appliedAmount: number | null;
    decidedBy: string | null;
    decidedAt: string | null;
  } | null;
};

type CategoryBucket = { candidateCount: number; employeeCount: number; totalAmount: number };
type CompanySummary = {
  willPublish: Record<DeductionsCategory, CategoryBucket>;
  pending: Record<DeductionsCategory, CategoryBucket>;
  willPublishTotal: number;
  pendingTotal: number;
};

type EmployeeSummary = {
  employeeHrId: string;
  employeeName: string | null;
  monthKey: string;
  byCategory: Partial<Record<DeductionsCategory, { days: number; amount: number; candidateCount: number }>>;
  totalAmount: number;
} | null;

const DECISION_STATUSES = ["Approved for Payroll", "Do Not Take Action", "Needs Follow-up", "Disputed"] as const;

function money(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value);
}

function monthLabel(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return monthKey;
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || payload?.message || `Request failed (${response.status})`);
  }
  return payload;
}

// Each collection request runs one company-wide scan. Give it the platform's own
// 300s ceiling plus a little slack, then fail with a message — the original cut of
// this screen left the button spinning with nothing shown when the request was
// killed at the gateway (#1377).
const COLLECT_REQUEST_TIMEOUT_MS = 310_000;

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

type CollectorRun = {
  key: string;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  created?: number;
  skippedExisting?: number;
  warnings?: string[];
  error?: string;
};

function StatusBadge({ status }: { status: string | null }) {
  const label = status ?? "Pending";
  const tone =
    label === "Approved for Payroll"
      ? "bg-emerald-100 text-emerald-700"
      : label === "Do Not Take Action"
        ? "bg-slate-200 text-slate-700"
        : label === "Disputed"
          ? "bg-red-100 text-red-700"
          : label === "Needs Follow-up"
            ? "bg-amber-100 text-amber-700"
            : "bg-sky-50 text-sky-700";
  return (
    <span className={["whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em]", tone].join(" ")}>
      {label}
    </span>
  );
}

function CandidateDecideRow({
  row,
  canDecide,
  onDecided,
}: {
  row: CandidateApiRow;
  canDecide: boolean;
  onDecided: (candidateId: string, decision: CandidateApiRow["decision"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(row.decision?.decisionReason ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(status: (typeof DECISION_STATUSES)[number]) {
    // Every non-Pending decision needs a reason — the server enforces this
    // (service.ts's validation) and so does a DB CHECK constraint. The UI used
    // to exempt "Approved for Payroll", which meant clicking Approve with an
    // empty box failed server-side every single time. Prefill a sensible
    // default for approvals rather than blocking on an empty field.
    const effectiveReason =
      reason.trim() || (status === "Approved for Payroll" ? `Approved for payroll after review (${row.monthKey})` : "");
    if (!effectiveReason) {
      setError("A decision reason is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = await fetchJson<{ decision: CandidateApiRow["decision"] }>("/api/admin/deductions/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: row.id, decisionStatus: status, decisionReason: effectiveReason }),
      });
      onDecided(row.id, payload.decision);
      setOpen(false);
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "Unable to record this decision.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!canDecide) return null;

  return (
    <div className="mt-1.5">
      {open ? (
        <div className="space-y-1.5 rounded-sm border border-slate-200 bg-slate-50 p-2">
          <input
            className="w-full rounded-sm border border-slate-200 px-2 py-1 text-xs text-slate-900 focus:border-orange-400 focus:outline-none"
            onChange={(event) => setReason(event.target.value)}
            placeholder="Decision reason"
            value={reason}
          />
          {error ? <p className="text-[11px] font-semibold text-red-700">{error}</p> : null}
          <div className="flex flex-wrap gap-1.5">
            {DECISION_STATUSES.map((status) => (
              <button
                className="rounded-sm bg-slate-900 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
                disabled={submitting}
                key={status}
                onClick={() => decide(status)}
                type="button"
              >
                {status}
              </button>
            ))}
            <button
              className="rounded-sm px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-slate-500"
              disabled={submitting}
              onClick={() => setOpen(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="rounded-sm border border-slate-300 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-orange-400 hover:text-orange-600"
          onClick={() => setOpen(true)}
          type="button"
        >
          Decide
        </button>
      )}
    </div>
  );
}

function CategoryTab({ category, monthKey, canDecide }: { category: DeductionsCategory; monthKey: string; canDecide: boolean }) {
  const [rows, setRows] = useState<CandidateApiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetchJson<{ candidates: CandidateApiRow[] }>(`/api/admin/deductions/candidates?monthKey=${monthKey}&category=${category}`)
      .then((payload) => {
        if (!cancelled) setRows(payload.candidates);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load candidates.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [category, monthKey]);

  function handleDecided(candidateId: string, decision: CandidateApiRow["decision"]) {
    setRows((current) => current.map((row) => (row.id === candidateId ? { ...row, decision } : row)));
  }

  const config = DEDUCTIONS_CATEGORY_CONFIG[category];

  return (
    <div className="border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-900 px-5 py-3">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
          {loading ? "Loading…" : `${rows.length} ${config.label} candidate${rows.length === 1 ? "" : "s"}`}
        </h2>
        <div className="flex items-center gap-2">
          {!config.requiresApproval ? (
            <span className="whitespace-nowrap rounded-full bg-orange-500/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-orange-300">
              Mandatory unless cleared
            </span>
          ) : null}
          <a
            className="inline-flex items-center gap-1.5 whitespace-nowrap border border-orange-500 bg-orange-500 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-orange-600"
            download
            href={`/api/admin/deductions/export?category=${category}&monthKey=${monthKey}`}
          >
            <Download className="h-3.5 w-3.5" />
            Download XLSX
          </a>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      {!loading && rows.length === 0 ? (
        <div className="p-10 text-center">
          <p className="text-sm font-bold text-slate-500">No {config.label.toLowerCase()} candidates for {monthLabel(monthKey)}.</p>
        </div>
      ) : (
        <>
          {/* Desktop: table. Mobile: stacked cards — never horizontal-scroll a table. */}
          <div className="hidden overflow-hidden sm:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-black uppercase tracking-[0.08em] text-slate-500">
                  <th className="px-4 py-2">Employee</th>
                  <th className="px-4 py-2">Days</th>
                  <th className="px-4 py-2">Amount</th>
                  <th className="px-4 py-2">Reason</th>
                  <th className="px-4 py-2">Status</th>
                  {canDecide ? <th className="px-4 py-2">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr className="border-b border-slate-100 odd:bg-slate-50/60 hover:bg-orange-50/40" key={row.id}>
                    <td className="px-4 py-2.5 font-semibold text-slate-900">
                      {row.employeeName ?? row.employeeHrId}
                      <span className="ml-1.5 font-mono text-[11px] font-medium text-slate-400">{row.employeeHrId}</span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{row.unit === "days" ? row.rawValue : "—"}</td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {row.estimatedAmount != null ? money(row.estimatedAmount) : "requires review"}
                    </td>
                    <td className="max-w-xs px-4 py-2.5 text-xs text-slate-600">{row.reason ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={row.decision?.decisionStatus ?? null} />
                    </td>
                    {canDecide ? (
                      <td className="px-4 py-2.5">
                        <CandidateDecideRow canDecide={canDecide} onDecided={handleDecided} row={row} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="divide-y divide-slate-100 sm:hidden">
            {rows.map((row, index) => (
              <div className={["px-4 py-3", index % 2 === 1 ? "bg-slate-50/60" : ""].join(" ")} key={row.id}>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-slate-900">{row.employeeName ?? row.employeeHrId}</p>
                  <StatusBadge status={row.decision?.decisionStatus ?? null} />
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {row.unit === "days" ? `${row.rawValue} day(s)` : ""} ·{" "}
                  {row.estimatedAmount != null ? `${money(row.estimatedAmount)} EGP` : "requires review"}
                </p>
                {row.reason ? <p className="mt-1 text-xs text-slate-600">{row.reason}</p> : null}
                <CandidateDecideRow canDecide={canDecide} onDecided={handleDecided} row={row} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type PublicationApiRow = {
  id: string;
  status: "published" | "superseded";
  publishedBy: string;
  publishedAt: string;
  candidateCount: number;
  employeeCount: number;
};

function PublicationPanel({ monthKey, canDecide }: { monthKey: string; canDecide: boolean }) {
  const [publications, setPublications] = useState<PublicationApiRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  function reload() {
    setLoading(true);
    fetchJson<{ publications: PublicationApiRow[] }>(`/api/admin/deductions/publish?monthKey=${monthKey}`)
      .then((payload) => setPublications(payload.publications))
      .catch(() => setPublications([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey]);

  async function publish() {
    setPublishing(true);
    setMessage(null);
    try {
      const payload = await fetchJson<{ candidateCount: number; employeeCount: number }>("/api/admin/deductions/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthKey }),
      });
      setMessage({
        tone: "success",
        text: `Published ${payload.candidateCount} candidate(s) across ${payload.employeeCount} employee(s) for ${monthLabel(monthKey)}.`,
      });
      reload();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Publish failed." });
    } finally {
      setPublishing(false);
    }
  }

  const active = publications?.find((publication) => publication.status === "published") ?? null;

  return (
    <div className="border border-slate-200 bg-white p-4 shadow-sm sm:col-span-2 lg:col-span-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">Publish status — {monthLabel(monthKey)}</p>
          {loading ? (
            <p className="mt-1 text-sm font-semibold text-slate-500">Loading…</p>
          ) : active ? (
            <p className="mt-1 text-sm font-semibold text-emerald-700">
              Published by {active.publishedBy} · {active.candidateCount} candidate(s) · {active.employeeCount} employee(s) ·{" "}
              {new Date(active.publishedAt).toLocaleString()}
            </p>
          ) : (
            <p className="mt-1 text-sm font-semibold text-slate-500">Not yet published for this month.</p>
          )}
        </div>
        {canDecide ? (
          <button
            className="whitespace-nowrap rounded-sm bg-slate-900 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
            disabled={publishing}
            onClick={publish}
            type="button"
          >
            {publishing ? "Publishing…" : active ? "Republish (supersedes current)" : "Publish this month"}
          </button>
        ) : null}
      </div>
      {message ? (
        <p className={["mt-2 text-xs font-semibold", message.tone === "success" ? "text-emerald-700" : "text-red-700"].join(" ")}>
          {message.text}
        </p>
      ) : null}
      {publications && publications.length > 1 ? (
        <p className="mt-2 text-[11px] text-slate-400">{publications.length - 1} prior publication(s) superseded — full history preserved for audit.</p>
      ) : null}
    </div>
  );
}

function OverviewTab({ monthKey, canDecide }: { monthKey: string; canDecide: boolean }) {
  const [summary, setSummary] = useState<CompanySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetchJson<{ summary: CompanySummary }>(`/api/admin/deductions/summary/company?monthKey=${monthKey}`)
      .then((payload) => {
        if (!cancelled) setSummary(payload.summary);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load the overview.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [monthKey]);

  if (loading) return <p className="p-6 text-sm font-semibold text-slate-500">Loading…</p>;
  if (error) return <p className="p-6 text-sm font-semibold text-red-700">{error}</p>;
  if (!summary) return null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <PublicationPanel canDecide={canDecide} monthKey={monthKey} />

      {/* Two totals, never one. "Will publish" uses the exact predicate
          publishMonth uses; "Pending" is everything detected but not yet
          approved, which will NOT be deducted. Showing a single combined figure
          is how HR ended up reading ~3x what publish would actually commit. */}
      <div className="border border-slate-900 bg-slate-900 p-4 shadow-sm sm:col-span-2">
        <p className="text-[11px] font-black uppercase tracking-[0.1em] text-orange-400">Will publish</p>
        <p className="mt-1 text-3xl font-black text-white">{money(summary.willPublishTotal)} EGP</p>
        <p className="mt-0.5 text-xs font-semibold text-slate-400">This is what pressing Publish commits.</p>
      </div>
      <div className="border border-amber-300 bg-amber-50 p-4 shadow-sm sm:col-span-2">
        <p className="text-[11px] font-black uppercase tracking-[0.1em] text-amber-700">Pending — will NOT publish</p>
        <p className="mt-1 text-3xl font-black text-amber-900">{money(summary.pendingTotal)} EGP</p>
        <p className="mt-0.5 text-xs font-semibold text-amber-700">
          Detected but awaiting your decision. Not deducted until approved.
        </p>
      </div>

      {deductionsCategories.map((category) => {
        const config = DEDUCTIONS_CATEGORY_CONFIG[category];
        const willPublish = summary.willPublish[category];
        const pending = summary.pending[category];
        return (
          <div className="border border-slate-200 bg-white p-4 shadow-sm" key={category}>
            <p className="text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">{config.label}</p>
            <p className="mt-1 text-2xl font-black text-slate-900">{money(willPublish?.totalAmount ?? 0)}</p>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              {willPublish?.candidateCount ?? 0} candidate(s) · {willPublish?.employeeCount ?? 0} employee(s)
            </p>
            {(pending?.candidateCount ?? 0) > 0 ? (
              <p className="mt-1 text-xs font-bold text-amber-700">
                + {pending.candidateCount} pending ({money(pending.totalAmount)} EGP) — not publishing
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ByEmployeeTab({ monthKey }: { monthKey: string }) {
  const [employeeHrId, setEmployeeHrId] = useState("");
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState<EmployeeSummary>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSummary(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchJson<{ summary: EmployeeSummary }>(
      `/api/admin/deductions/summary/employee?monthKey=${monthKey}&employeeHrId=${encodeURIComponent(query.trim())}`,
    )
      .then((payload) => {
        if (!cancelled) setSummary(payload.summary);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load this employee's summary.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [monthKey, query]);

  return (
    <div className="border border-slate-200 bg-white p-5 shadow-sm">
      <label className="flex max-w-sm items-center gap-2 text-xs font-black uppercase tracking-[0.1em] text-slate-500">
        Employee HR_ID
        <input
          className="w-full rounded-sm border border-slate-200 px-2 py-1.5 text-sm font-semibold text-slate-900 focus:border-orange-400 focus:outline-none"
          onChange={(event) => setEmployeeHrId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") setQuery(employeeHrId);
          }}
          placeholder="e.g. B-1"
          value={employeeHrId}
        />
        <button
          className="whitespace-nowrap rounded-sm bg-slate-900 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700"
          onClick={() => setQuery(employeeHrId)}
          type="button"
        >
          Look up
        </button>
      </label>

      {loading ? <p className="mt-4 text-sm font-semibold text-slate-500">Loading…</p> : null}
      {error ? <p className="mt-4 text-sm font-semibold text-red-700">{error}</p> : null}
      {!loading && query.trim() && !summary && !error ? (
        <p className="mt-4 text-sm font-semibold text-slate-500">No deductions found for {query} in {monthLabel(monthKey)}.</p>
      ) : null}

      {summary ? (
        <div className="mt-5">
          <h3 className="text-sm font-black text-slate-900">
            {summary.employeeName ?? summary.employeeHrId} <span className="font-mono text-xs font-medium text-slate-400">{summary.employeeHrId}</span>
          </h3>
          <div className="mt-3 divide-y divide-slate-100 border border-slate-200">
            {deductionsCategories
              .filter((category) => summary.byCategory[category])
              .map((category, index) => {
                const config = DEDUCTIONS_CATEGORY_CONFIG[category];
                const bucket = summary.byCategory[category]!;
                return (
                  <div className={["flex items-center justify-between px-4 py-2.5", index % 2 === 1 ? "bg-slate-50/60" : ""].join(" ")} key={category}>
                    <span className="text-sm font-semibold text-slate-800">{config.label}</span>
                    <span className="text-sm font-black text-slate-900">
                      {bucket.days > 0 ? `${bucket.days} day(s) · ` : ""}
                      {money(bucket.amount)} EGP
                    </span>
                  </div>
                );
              })}
          </div>
          <div className="mt-3 flex items-center justify-between border border-slate-900 bg-slate-900 px-4 py-2.5">
            <span className="text-xs font-black uppercase tracking-[0.1em] text-orange-400">Total</span>
            <span className="text-lg font-black text-white">{money(summary.totalAmount)} EGP</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DeductionsWorkspace({ canDecide, initialMonthKey }: { canDecide: boolean; initialMonthKey: string }) {
  const [monthKey, setMonthKey] = useState(initialMonthKey);
  const [activeTab, setActiveTab] = useState<"overview" | "by_employee" | DeductionsCategory>("overview");
  const [collecting, setCollecting] = useState(false);
  const [collectMessage, setCollectMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [collectorRuns, setCollectorRuns] = useState<CollectorRun[]>([]);

  const [year, month] = useMemo(() => monthKey.split("-").map(Number), [monthKey]);

  // Connectors are run ONE PER REQUEST. Bundling all five into a single call is
  // what blew the 300s Cloud Run limit and got this module reverted (#1377);
  // stepping through them keeps every request bounded and lets a slow connector
  // fail on its own instead of taking the whole run down with it.
  async function runCollection() {
    setCollecting(true);
    setCollectMessage(null);
    setCollectorRuns([]);
    try {
      const { plan } = await fetchJson<{ plan: Array<{ key: string; label: string }> }>("/api/admin/deductions/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, year }),
      });

      let runs: CollectorRun[] = plan.map((entry) => ({ ...entry, state: "pending" }));
      setCollectorRuns(runs);

      for (const entry of plan) {
        runs = runs.map((run) => (run.key === entry.key ? { ...run, state: "running" } : run));
        setCollectorRuns(runs);
        try {
          const payload = await fetchJsonWithTimeout<{
            result: { created: number; skippedExisting: number; warnings: string[] };
          }>(
            "/api/admin/deductions/collect",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ month, year, connector: entry.key }),
            },
            COLLECT_REQUEST_TIMEOUT_MS,
          );
          runs = runs.map((run) =>
            run.key === entry.key ? { ...run, state: "done" as const, ...payload.result } : run,
          );
        } catch (error) {
          runs = runs.map((run) =>
            run.key === entry.key
              ? { ...run, state: "failed" as const, error: error instanceof Error ? error.message : "Connector failed." }
              : run,
          );
        }
        setCollectorRuns(runs);
      }

      const created = runs.reduce((sum, run) => sum + (run.created ?? 0), 0);
      const warnings = runs.flatMap((run) => run.warnings ?? []);
      const failed = runs.filter((run) => run.state === "failed");
      setCollectMessage({
        tone: failed.length > 0 || warnings.length > 0 ? "error" : "success",
        text:
          `Collection complete: ${created} new candidate(s).` +
          (failed.length > 0 ? ` ${failed.length} connector(s) failed — see the breakdown below.` : "") +
          (warnings.length > 0 ? ` ${warnings.length} warning(s) — see server logs.` : ""),
      });
    } catch (error) {
      setCollectMessage({ tone: "error", text: error instanceof Error ? error.message : "Collection run failed." });
    } finally {
      setCollecting(false);
    }
  }

  const tabs: Array<{ key: "overview" | "by_employee" | DeductionsCategory; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "by_employee", label: "By Employee" },
    ...deductionsCategories.map((category) => ({ key: category, label: DEDUCTIONS_CATEGORY_CONFIG[category].label })),
  ];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <label className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.1em] text-slate-500">
          Month
          <input
            className="rounded-sm border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-900 focus:border-orange-400 focus:outline-none"
            onChange={(event) => setMonthKey(event.target.value)}
            type="month"
            value={monthKey}
          />
        </label>
        {canDecide ? (
          <button
            className="ml-auto inline-flex items-center gap-1.5 rounded-sm bg-orange-500 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-orange-600 disabled:opacity-50"
            disabled={collecting}
            onClick={runCollection}
            type="button"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            {collecting ? "Running…" : `Run collection for ${monthLabel(monthKey)}`}
          </button>
        ) : null}
      </div>

      {collectMessage ? (
        <div
          className={[
            "flex items-center gap-2 border px-4 py-2.5 text-sm font-semibold",
            collectMessage.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800",
          ].join(" ")}
        >
          {collectMessage.tone === "success" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
          {collectMessage.text}
        </div>
      ) : null}

      {collectorRuns.length > 0 ? (
        <div className="divide-y divide-slate-200 border border-slate-200 bg-white">
          {collectorRuns.map((run) => (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5" key={run.key}>
              <span className="text-sm font-semibold text-slate-800">{run.label}</span>
              <span className="ml-auto text-sm font-semibold">
                {run.state === "pending" ? <span className="text-slate-400">Waiting…</span> : null}
                {run.state === "running" ? <span className="text-orange-600">Running…</span> : null}
                {run.state === "done" ? (
                  <span className="text-emerald-700">
                    {run.created ?? 0} new · {run.skippedExisting ?? 0} already live
                    {run.warnings && run.warnings.length > 0 ? ` · ${run.warnings.length} warning(s)` : ""}
                  </span>
                ) : null}
                {run.state === "failed" ? <span className="text-red-700">{run.error}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1 border-b border-slate-200 pb-px">
        {tabs.map((tab) => (
          <button
            className={[
              "whitespace-nowrap rounded-t-sm px-3 py-2 text-[11px] font-black uppercase tracking-[0.08em] transition",
              activeTab === tab.key
                ? "border border-b-0 border-slate-200 bg-white text-orange-600"
                : "text-slate-500 hover:text-slate-800",
            ].join(" ")}
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" ? <OverviewTab canDecide={canDecide} monthKey={monthKey} /> : null}
      {activeTab === "by_employee" ? <ByEmployeeTab monthKey={monthKey} /> : null}
      {activeTab !== "overview" && activeTab !== "by_employee" ? (
        <CategoryTab canDecide={canDecide} category={activeTab} monthKey={monthKey} />
      ) : null}
    </section>
  );
}
