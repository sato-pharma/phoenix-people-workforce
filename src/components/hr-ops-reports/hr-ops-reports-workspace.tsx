"use client";

// HR Daily & Weekly Reports — the workspace both ends share (app/(admin)/hr-reports/page.tsx).
//
//   reviewer — the HR Operations Specialist: answers every flagged row and submits the report.
//   decider  — the HR Manager: decides each row once it is submitted, sees what the days would
//              cost (fetched from /priced, a route her seat is refused), and builds a report by hand.
//   reader   — a read grant with neither: the report as it stands, no controls.
//
// Everything the reviewer's screen holds came through serialize.ts — days only.

import { useCallback, useEffect, useMemo, useState } from "react";

import { FormError, FormField } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import type { HrOpsQueueReport } from "@/lib/hr-ops-reports/queue";
import type { HrOpsLineView, HrOpsReportView } from "@/lib/hr-ops-reports/serialize";
import { cn } from "@/lib/utils";

import { formatEgp, formatStamp, formatWorkDay, hrOpsApi } from "./format";
import { ReportRows, type DecisionDraft, type ReviewDraft, type RowPrice } from "./report-rows";

export type HrOpsWorkspaceMode = "reviewer" | "decider" | "reader";

type ReportPayload = { lines: HrOpsLineView[]; report: HrOpsReportView };
type Section = "office" | "field";
type Filter = "attention" | "all";

const STATUS_TONE: Record<string, string> = {
  decided: "border-slate-200 bg-slate-50 text-slate-600",
  in_review: "border-amber-200 bg-amber-50 text-amber-800",
  submitted: "border-orange-200 bg-orange-50 text-orange-800",
};

function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <span className={cn("inline-flex border px-1.5 py-0.5 text-phx-xs font-black uppercase tracking-wide", STATUS_TONE[status] ?? STATUS_TONE.decided)}>
      {label}
    </span>
  );
}

function needsAttention(line: HrOpsLineView, mode: HrOpsWorkspaceMode): boolean {
  return mode === "decider" ? line.decidable : line.needsReview || Boolean(line.review);
}

function ReportList({
  reports,
  selectedId,
  mode,
  onSelect,
}: {
  reports: HrOpsQueueReport[];
  selectedId: string | null;
  mode: HrOpsWorkspaceMode;
  onSelect: (id: string) => void;
}) {
  if (reports.length === 0) {
    return (
      <p className="border border-slate-200 bg-white p-4 text-sm text-slate-600">
        No report has been built yet. The first one appears the morning after a working day.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {reports.map((report) => {
        const waiting = mode === "decider" ? report.progress.toDecide : report.progress.toReview;
        const active = report.id === selectedId;
        return (
          <li key={report.id}>
            <button
              type="button"
              aria-current={active ? "true" : undefined}
              className={cn(
                "w-full border bg-white px-3 py-2.5 text-left transition hover:border-orange-300",
                active ? "border-orange-500 shadow-[inset_4px_0_0_#F97316]" : "border-slate-200",
              )}
              onClick={() => onSelect(report.id)}
            >
              <span className="block text-sm font-black text-slate-900">{report.title}</span>
              <span className="mt-1 flex flex-wrap items-center gap-2">
                <StatusBadge label={report.statusLabel} status={report.status} />
                {report.status !== "decided" ? (
                  <span className={cn("text-xs font-bold", waiting > 0 ? "text-amber-700" : "text-slate-500")}>
                    {waiting > 0
                      ? `${waiting} ${waiting === 1 ? "row" : "rows"} ${mode === "decider" ? "to decide" : "to answer"}`
                      : report.status === "in_review"
                        ? "Every flagged row answered"
                        : "Nothing left to decide"}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Progress({ report }: { report: HrOpsReportView }) {
  const progress = report.progress;
  if (!progress) return null;
  const cells: Array<[string, number]> = [
    ["Rows", progress.total],
    ["Flagged", progress.flagged],
    ["To answer", progress.toReview],
    ["Answered", progress.reviewed],
    ["To decide", progress.toDecide],
    ["Decided", progress.decided],
  ];
  return (
    <dl className="grid grid-cols-3 gap-px border border-slate-200 bg-slate-200 @min-[640px]:grid-cols-6">
      {cells.map(([label, value]) => (
        <div key={label} className="bg-white px-3 py-2">
          <dt className="text-phx-xs font-black uppercase tracking-wide text-slate-500">{label}</dt>
          <dd className="text-lg font-black text-slate-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function windowLabel(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  return from === to ? formatWorkDay(from) : `${formatWorkDay(from)} to ${formatWorkDay(to)}`;
}

function RebuildForm({ busy, onBuild }: { busy: boolean; onBuild: (kind: "daily" | "weekly", date: string) => Promise<void> }) {
  const [kind, setKind] = useState<"daily" | "weekly">("daily");
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3 border border-slate-200 bg-white p-4">
      <p className="text-phx-xs font-black uppercase tracking-wide text-slate-500">Build or refresh a report</p>
      <div className="grid grid-cols-1 gap-3 @min-[520px]:grid-cols-[160px_minmax(0,1fr)_auto] @min-[520px]:items-end">
        <FormField label="Report">
          <select className={phxSelectClassName} value={kind} onChange={(event) => setKind(event.target.value as "daily" | "weekly")}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </FormField>
        <FormField label={kind === "daily" ? "Day" : "Any day of the week"} hint="Only a day that has ended. A submitted report is never changed.">
          <input className={phxFieldClassName} type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </FormField>
        <button
          type="button"
          className={phxButtonPrimaryClassName}
          disabled={busy || !date}
          onClick={async () => {
            setError(null);
            try {
              await onBuild(kind, date);
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : "The report could not be built.");
            }
          }}
        >
          Build
        </button>
      </div>
      <FormError>{error}</FormError>
    </div>
  );
}

export function HrOpsReportsWorkspace({
  initialReports,
  initialReport,
  mode,
}: {
  initialReports: HrOpsQueueReport[];
  initialReport: ReportPayload | null;
  mode: HrOpsWorkspaceMode;
}) {
  const [reports, setReports] = useState(initialReports);
  const [payload, setPayload] = useState<ReportPayload | null>(initialReport);
  const [section, setSection] = useState<Section>(() => (initialReport?.lines.some((line) => line.section === "office") ? "office" : "field"));
  const [filter, setFilter] = useState<Filter>("attention");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prices, setPrices] = useState<Map<string, RowPrice> | null>(null);
  const [priceTotal, setPriceTotal] = useState<number | null>(null);
  // Why there is no total, in words — a total that could not be worked out is never shown as EGP 0.00.
  const [priceTotalNote, setPriceTotalNote] = useState<string | null>(null);

  const reportId = payload?.report.id ?? null;

  const loadPrices = useCallback(
    async (id: string) => {
      if (mode !== "decider") return;
      try {
        const priced = await hrOpsApi<{ prices: RowPrice[]; total: number | null; totalNote: string | null }>("GET", `/api/hr-ops-reports/${id}/priced`);
        setPrices(new Map(priced.prices.map((price) => [price.lineId, price])));
        setPriceTotal(priced.total);
        setPriceTotalNote(priced.total === null ? (priced.totalNote ?? "No total: some rows could not be priced.") : null);
      } catch {
        setPrices(null);
        setPriceTotal(null);
        setPriceTotalNote("No total: the amounts could not be read.");
      }
    },
    [mode],
  );

  useEffect(() => {
    if (!reportId) return;
    // Defer out of the synchronous effect body to satisfy react-hooks/set-state-in-effect.
    const id = setTimeout(() => void loadPrices(reportId), 0);
    return () => clearTimeout(id);
  }, [loadPrices, reportId]);

  const refresh = useCallback(async (id: string | null) => {
    const list = await hrOpsApi<{ reports: HrOpsQueueReport[] }>("GET", "/api/hr-ops-reports");
    setReports(list.reports);
    if (id) setPayload(await hrOpsApi<ReportPayload>("GET", `/api/hr-ops-reports/${id}`));
  }, []);

  const select = async (id: string) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const next = await hrOpsApi<ReportPayload>("GET", `/api/hr-ops-reports/${id}`);
      setPayload(next);
      setSection(next.lines.some((line) => line.section === "office") ? "office" : "field");
      try {
        window.history.replaceState(null, "", `?report=${encodeURIComponent(id)}`);
      } catch {
        // The address bar is a convenience; the report is already open.
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The report could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  const run = async (work: () => Promise<string | null>) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const message = await work();
      if (message) setNotice(message);
    } finally {
      setBusy(false);
    }
  };

  const onReview = async (lineId: string, draft: ReviewDraft) => {
    if (!reportId) return;
    await run(async () => {
      await hrOpsApi("POST", `/api/hr-ops-reports/${reportId}/review`, {
        action: draft.action,
        comment: draft.comment,
        lineId,
        reason: draft.reason,
        recommendedDays: draft.action === "recommend_edit" ? draft.recommendedDays : null,
      });
      await refresh(reportId);
      return null;
    });
  };

  const onDecide = async (lineId: string, draft: DecisionDraft) => {
    if (!reportId) return;
    await run(async () => {
      const result = await hrOpsApi<{ bridgeError: string | null }>("POST", `/api/hr-ops-reports/${reportId}/decide`, {
        days: draft.decision === "approved" ? draft.days : null,
        decision: draft.decision,
        lineId,
      });
      await refresh(reportId);
      await loadPrices(reportId);
      return result.bridgeError ? `Saved. The weekly attendance review could not be reached just now and will be retried: ${result.bridgeError}` : null;
    });
  };

  const lines = useMemo(() => payload?.lines ?? [], [payload]);
  const sectionLines = useMemo(() => lines.filter((line) => line.section === section), [lines, section]);
  const visible = useMemo(
    () => (filter === "all" ? sectionLines : sectionLines.filter((line) => needsAttention(line, mode))),
    [filter, mode, sectionLines],
  );
  const counts = useMemo(
    () => ({
      field: lines.filter((line) => line.section === "field").length,
      office: lines.filter((line) => line.section === "office").length,
    }),
    [lines],
  );

  const report = payload?.report ?? null;
  const toAnswer = report?.progress?.toReview ?? 0;
  const undecided = lines.filter((line) => line.decidable && !line.decision);
  // The one-click pass takes only rows with a figure to stand on — HR's recommended days or the
  // policy's. A row with neither waits for its own decision rather than being approved at zero.
  const bulkReady = undecided.filter((line) => line.defaultDecisionDays !== null);

  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-6 @min-[1100px]:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <ReportList mode={mode} reports={reports} selectedId={reportId} onSelect={(id) => void select(id)} />
          {mode === "decider" ? (
            <RebuildForm
              busy={busy}
              onBuild={async (kind, date) => {
                setBusy(true);
                try {
                  const built = await hrOpsApi<{ result: { reportId: string; title: string; skipped: string | null; lineCount: number } }>(
                    "POST",
                    "/api/hr-ops-reports/rebuild",
                    { date, kind },
                  );
                  await refresh(built.result.reportId);
                  setNotice(
                    built.result.skipped === "frozen"
                      ? `${built.result.title} has been submitted, so it was left exactly as it was.`
                      : `${built.result.title} is up to date: ${built.result.lineCount} rows.`,
                  );
                } finally {
                  setBusy(false);
                }
              }}
            />
          ) : null}
        </aside>

        <section className="min-w-0 space-y-4">
          {error ? <FormError>{error}</FormError> : null}
          {notice ? <p className="border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-900">{notice}</p> : null}

          {!report ? (
            <p className="border border-slate-200 bg-white p-5 text-sm text-slate-600">Choose a report to open it.</p>
          ) : (
            <>
              <header className="space-y-3 border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <h2 className="text-lg font-black text-slate-900">{report.title}</h2>
                    <p className="text-xs text-slate-600">
                      {[
                        windowLabel(report.officeFrom, report.officeTo) ? `Head office ${windowLabel(report.officeFrom, report.officeTo)}` : null,
                        windowLabel(report.fieldFrom, report.fieldTo) ? `Field force ${windowLabel(report.fieldFrom, report.fieldTo)}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <p className="text-xs text-slate-500">
                      Built {formatStamp(report.rebuiltAt ?? report.builtAt)}
                      {report.submittedAt ? ` · Submitted ${formatStamp(report.submittedAt)}` : ""}
                      {report.decidedAt ? ` · Decided ${formatStamp(report.decidedAt)}` : ""}
                    </p>
                  </div>
                  <StatusBadge label={report.statusLabel} status={report.status} />
                </div>
                <Progress report={report} />
                {report.submitBlockedReason ? (
                  <p className="border border-rose-200 bg-rose-50 p-3 text-xs font-black text-rose-900">{report.submitBlockedReason}</p>
                ) : null}
                {report.warnings.length ? (
                  <ul className="space-y-1 border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-900">
                    {report.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
                {mode === "decider" && priceTotal !== null ? (
                  <p className="text-sm text-slate-700">
                    Approved and proposed days in this report come to <span className="font-black text-slate-900">{formatEgp(priceTotal)}</span>.
                  </p>
                ) : null}
                {mode === "decider" && priceTotal === null && priceTotalNote ? (
                  <p className="text-sm font-semibold text-rose-700">{priceTotalNote}</p>
                ) : null}

                {mode === "reviewer" && report.status === "in_review" ? (
                  <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      className={phxButtonAccentClassName}
                      disabled={busy || toAnswer > 0 || report.submitBlockedReason !== null}
                      onClick={() =>
                        void run(async () => {
                          await hrOpsApi("POST", `/api/hr-ops-reports/${report.id}/submit`);
                          await refresh(report.id);
                          return "Submitted to the HR Manager.";
                        }).catch((failure) => setError(failure instanceof Error ? failure.message : "The report could not be submitted."))
                      }
                    >
                      Submit to the HR Manager
                    </button>
                    <span className="text-xs text-slate-600">
                      {report.submitBlockedReason
                        ? "This report waits for a clean rebuild before it can be submitted."
                        : toAnswer > 0
                          ? `${toAnswer} flagged ${toAnswer === 1 ? "row still needs" : "rows still need"} your answer.`
                          : "Every flagged row has your answer. Once submitted the report cannot be changed."}
                    </span>
                  </div>
                ) : null}

                {mode === "decider" && report.status !== "in_review" && bulkReady.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      className={phxButtonGhostClassName}
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Decide ${bulkReady.length} ${bulkReady.length === 1 ? "row" : "rows"} as HR answered them? A row HR rejected is approved with no days; every other row is approved with HR's recommended days, or the policy's.`)) return;
                        void run(async () => {
                          await hrOpsApi("POST", `/api/hr-ops-reports/${report.id}/decide`, {
                            decisions: bulkReady.map((line) => ({ days: line.defaultDecisionDays ?? 0, decision: "approved", lineId: line.id })),
                          });
                          await refresh(report.id);
                          await loadPrices(report.id);
                          return null;
                        }).catch((failure) => setError(failure instanceof Error ? failure.message : "The decisions could not be saved."));
                      }}
                    >
                      Decide every open row as HR answered
                    </button>
                    <span className="text-xs text-slate-600">
                      {undecided.length} {undecided.length === 1 ? "row waits" : "rows wait"} for your decision
                      {bulkReady.length < undecided.length ? `; ${undecided.length - bulkReady.length} with no figure to stand on must be decided on its own` : ""}. Each can also be decided on its own below.
                    </span>
                  </div>
                ) : null}
                {mode === "decider" && report.status === "in_review" ? (
                  <p className="border-t border-slate-100 pt-3 text-xs text-slate-600">
                    HR is still reviewing this report. It can be decided once it has been submitted.
                  </p>
                ) : null}
              </header>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2" role="tablist" aria-label="Section">
                  {(["office", "field"] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={section === key}
                      className={cn(phxButtonGhostClassName, section === key && "border-slate-900 bg-slate-900 text-white hover:bg-slate-800")}
                      onClick={() => setSection(key)}
                    >
                      {key === "office" ? "Head office" : "Field force"} ({counts[key]})
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Rows shown">
                  {(["attention", "all"] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={filter === key}
                      className={cn(phxButtonGhostClassName, "px-3 py-1.5 text-xs", filter === key && "border-orange-500 bg-orange-50 text-orange-800")}
                      onClick={() => setFilter(key)}
                    >
                      {key === "attention" ? (mode === "decider" ? "To decide" : "Flagged") : "Every row"}
                    </button>
                  ))}
                </div>
              </div>

              {filter === "attention" && visible.length === 0 && sectionLines.length > 0 ? (
                <p className="border border-slate-200 bg-white p-5 text-sm font-semibold text-emerald-800">
                  Nothing in this section needs {mode === "decider" ? "a decision" : "an answer"}. Choose Every row to see the whole day.
                </p>
              ) : (
                <ReportRows
                  busy={busy}
                  decisionOpen={report.status !== "in_review"}
                  lines={visible}
                  mode={mode}
                  prices={prices}
                  reviewOpen={report.status === "in_review"}
                  onDecide={onDecide}
                  onReview={onReview}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
