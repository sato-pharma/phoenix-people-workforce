"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock, ListChecks, ShieldCheck, SkipForward, XCircle } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import type {
  SyntheticJourneyResultRow,
  SyntheticJourneyRunDetail,
  SyntheticJourneyRunSummary,
} from "@/lib/synthetic-journeys/service";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

const STATUS_TONE: Record<string, string> = {
  passed: "bg-emerald-50 text-emerald-700",
  failed: "bg-rose-50 text-rose-700",
  skipped: "bg-amber-50 text-amber-700",
};

const OVERALL_TONE: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  healthy: { label: "Healthy", className: "bg-emerald-50 text-emerald-700", icon: CheckCircle2 },
  warning: { label: "Warning", className: "bg-amber-50 text-amber-700", icon: AlertTriangle },
  failed: { label: "Failed", className: "bg-rose-50 text-rose-700", icon: XCircle },
  no_data: { label: "No Data", className: "bg-slate-100 text-slate-600", icon: Clock },
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-phx-2xs font-black uppercase tracking-wider", STATUS_TONE[status] ?? "bg-slate-100 text-slate-600")}>
      {status}
    </span>
  );
}

function formatDateTime(value: string): string {
  try {
    return stableEnGbFormatter({
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildDeveloperHandoffText(result: SyntheticJourneyResultRow): string {
  const evidenceParts: string[] = [];
  if (result.screenshotPath) evidenceParts.push(`Screenshot: ${result.screenshotPath}`);
  if (result.consoleErrors.length) evidenceParts.push(`${result.consoleErrors.length} console error(s)`);
  if (result.networkErrors.length) evidenceParts.push(`${result.networkErrors.length} network error(s)`);

  return [
    `Problem:`,
    `Synthetic journey failed.`,
    ``,
    `Journey:`,
    result.journeyName,
    ``,
    `Route:`,
    result.route,
    ``,
    `Error:`,
    result.failureReason || result.errors.join("; ") || "(none captured)",
    ``,
    `Evidence:`,
    evidenceParts.join("; ") || "(none)",
    ``,
    `Suggested next action:`,
    result.recommendation ?? "Investigate manually — no automated recommendation was captured.",
    ``,
    `Production safety:`,
    `No data was created, edited, deleted, uploaded, approved, rejected, or sent.`,
  ].join("\n");
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function JourneyDetailDrawer({ result, onClose }: { result: SyntheticJourneyResultRow; onClose: () => void }) {
  const dialogRef = useDialogA11y<HTMLDivElement>({ open: true, onClose });
  const router = useRouter();
  const [feedback, setFeedback] = useState<string | null>(null);

  async function handleCopy() {
    const text = buildDeveloperHandoffText(result);
    const copied = await copyText(text);
    setFeedback(copied ? "Copied developer handoff text to clipboard." : text);
  }

  // Opens the System Audit, which is where a failed journey is actually investigated: it shows the
  // self-hosted app_error_events as folded issues with their occurrences. It opened System Issues
  // until that page retired into the System Audit on 23 Oct 2026.
  //
  // This pushed `/admin/ai-bug-investigator` until 2026-10-08 — a page that has never existed in
  // this repo, so the button copied the handoff text and then dead-ended on a 404. That name
  // survived in three strings in this file and nowhere else: no route, no component, no navigation
  // entry. `/admin/error-monitor` and `/admin/system-issues` are not the destination either —
  // both are stubs that permanently redirect to the System Audit.
  async function handleOpenInSystemAudit() {
    const text = buildDeveloperHandoffText(result);
    const copied = await copyText(text);
    setFeedback(copied ? "Copied handoff text — opening the System Audit." : text);
    router.push("/admin/system-audit");
  }

  return (
    <div className="fixed inset-0 z-50">
      <button
        aria-label="Close journey details"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
        type="button"
      />
      <div
        ref={dialogRef}
        aria-label="Journey details"
        aria-modal="true"
        className="absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:inset-x-auto sm:right-0 sm:top-0 sm:h-full sm:max-h-none sm:w-full sm:max-w-lg sm:rounded-none"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{result.route} · {result.journeyId}</p>
            <h2 className="text-lg font-black text-slate-900">{result.journeyName}</h2>
            <StatusPill status={result.status} />
          </div>
          <button
            aria-label="Close"
            className="shrink-0 rounded-full border border-phx-line px-3 py-1 text-xs font-bold text-phx-ink-soft hover:bg-phx-paper"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <div className="mt-5 space-y-5 text-sm">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Duration</p>
            <p className="mt-1 text-slate-800">{formatDuration(result.durationMs)}</p>
          </div>

          {result.errors.length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Error</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-rose-700">
                {result.errors.map((error, index) => (
                  <li key={index} className="break-words">{error}</li>
                ))}
              </ul>
            </div>
          )}

          {result.consoleErrors.length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Console errors ({result.consoleErrors.length})</p>
              <ul className="mt-1 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-slate-700">
                {result.consoleErrors.map((error, index) => (
                  <li key={index} className="break-words">{error}</li>
                ))}
              </ul>
            </div>
          )}

          {result.networkErrors.length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Network errors ({result.networkErrors.length})</p>
              <ul className="mt-1 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-slate-700">
                {result.networkErrors.map((error, index) => (
                  <li key={index} className="break-words">{error}</li>
                ))}
              </ul>
            </div>
          )}

          {result.recommendation && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Recommendation</p>
              <p className="mt-1 text-slate-800">{result.recommendation}</p>
            </div>
          )}

          {result.screenshotPath && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Screenshot</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-600">{result.screenshotPath}</p>
            </div>
          )}

          <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 sm:flex-row">
            <button
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
              onClick={handleCopy}
              type="button"
            >
              Copy developer handoff
            </button>
            <button
              className="inline-flex items-center justify-center rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-xs font-bold text-orange-700 hover:bg-orange-100"
              onClick={handleOpenInSystemAudit}
              type="button"
            >
              Open in the System Audit
            </button>
          </div>
          {feedback && <p className="whitespace-pre-wrap text-xs text-slate-500">{feedback}</p>}
        </div>
      </div>
    </div>
  );
}

export function SyntheticJourneysDashboard({
  latestRun,
  runs,
}: {
  latestRun: SyntheticJourneyRunDetail | null;
  runs: SyntheticJourneyRunSummary[];
}) {
  const [activeRun, setActiveRun] = useState<SyntheticJourneyRunDetail | null>(latestRun);
  const [selectedResult, setSelectedResult] = useState<SyntheticJourneyResultRow | null>(null);
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);

  const overall = OVERALL_TONE[activeRun?.overallStatus ?? "no_data"];
  const OverallIcon = overall.icon;

  const viewingLatest = useMemo(() => !activeRun || !latestRun || activeRun.id === latestRun.id, [activeRun, latestRun]);

  async function viewRun(runId: string) {
    setHistoryLoading(runId);
    try {
      const response = await fetch(`/api/admin/synthetic-journeys/runs/${runId}`);
      const body = await response.json();
      if (response.ok && body.run) {
        setActiveRun(body.run);
      }
    } finally {
      setHistoryLoading(null);
    }
  }

  return (
    <div className="space-y-6">
      <AdminCallout tone="warning">
        Synthetic journeys are read-only smoke checks. Do not use real mutation flows without explicit approval.
      </AdminCallout>

      {!activeRun ? (
        <Card className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6">
          <p className="text-sm font-semibold text-slate-700">
            No synthetic journey runs found yet. Run <code className="rounded bg-slate-100 px-1.5 py-0.5">pnpm run synthetic:test</code>, then save or ingest the report.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
{`cd "F:/Phoenix Workforce/_wt-synthetic-user-journeys"
pnpm run synthetic:test
pnpm run synthetic:save-report`}
          </pre>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <AdminStatCard
              description={viewingLatest ? "Most recent run" : "Selected run"}
              icon={<OverallIcon className="h-5 w-5" />}
              label="Latest run status"
              tone={activeRun.overallStatus === "failed" ? "rose" : activeRun.overallStatus === "warning" ? "blue" : "emerald"}
              value={overall.label}
            />
            <AdminStatCard
              description="Journeys in this run"
              icon={<ListChecks className="h-5 w-5" />}
              label="Total journeys"
              tone="orange"
              value={activeRun.totalCount}
            />
            <AdminStatCard
              description="Passed / Failed / Skipped"
              icon={<CheckCircle2 className="h-5 w-5" />}
              label="Passed"
              tone="emerald"
              value={activeRun.passedCount}
            />
            <AdminStatCard
              description="Needs investigation"
              icon={<XCircle className="h-5 w-5" />}
              label="Failed"
              tone="rose"
              value={activeRun.failedCount}
            />
            <AdminStatCard
              description="Skipped by design (e.g. mutation-gated)"
              icon={<SkipForward className="h-5 w-5" />}
              label="Skipped"
              tone="blue"
              value={activeRun.skippedCount}
            />
            <AdminStatCard
              description={`Started ${formatDateTime(activeRun.startedAt)}`}
              icon={<Clock className="h-5 w-5" />}
              label="Last run time"
              tone="violet"
              value={formatDateTime(activeRun.finishedAt)}
            />
            <AdminStatCard
              description={`${activeRun.baseUrl}${activeRun.environment ? ` (${activeRun.environment})` : ""}`}
              icon={<Clock className="h-5 w-5" />}
              label="Total duration"
              tone="violet"
              value={formatDuration(activeRun.durationMs)}
            />
            <AdminStatCard
              description="No mutations performed"
              icon={<ShieldCheck className="h-5 w-5" />}
              label="Read-only"
              tone="emerald"
              value="Production-safe"
            />
          </div>

          <AdminTableShell description={`${activeRun.results.length} journeys checked ${formatDateTime(activeRun.finishedAt)}`} title="Journey Results">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-3">Journey</th>
                    <th className="px-3 py-3">Route</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Duration</th>
                    <th className="px-3 py-3">Last checked</th>
                    <th className="px-3 py-3">Failure reason</th>
                    <th className="px-3 py-3">Recommendation</th>
                    <th className="px-3 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {activeRun.results.map((result) => (
                    <tr key={result.id} className={result.status === "failed" ? "cursor-pointer hover:bg-rose-50/60" : ""} onClick={() => result.status === "failed" && setSelectedResult(result)}>
                      <td className="px-3 py-3 font-semibold text-slate-800">{result.journeyName}</td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-500">{result.route}</td>
                      <td className="px-3 py-3"><StatusPill status={result.status} /></td>
                      <td className="px-3 py-3 text-slate-600">{formatDuration(result.durationMs)}</td>
                      <td className="px-3 py-3 text-slate-600">{formatDateTime(result.createdAt)}</td>
                      <td className="max-w-xs truncate px-3 py-3 text-slate-600">{result.failureReason ?? "—"}</td>
                      <td className="max-w-xs truncate px-3 py-3 text-slate-600">{result.recommendation ?? "—"}</td>
                      <td className="px-3 py-3">
                        {result.status === "failed" ? (
                          <button
                            className="rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-bold text-rose-700 hover:bg-rose-100"
                            onClick={(event) => { event.stopPropagation(); setSelectedResult(result); }}
                            type="button"
                          >
                            View details
                          </button>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AdminTableShell>

          {runs.length > 0 && (
            <AdminTableShell description="Last 20 saved runs" title="Run History">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-3">Run</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3">Passed / Failed / Skipped</th>
                      <th className="px-3 py-3">Duration</th>
                      <th className="px-3 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {runs.map((run) => (
                      <tr key={run.id} className={run.id === activeRun.id ? "bg-orange-50/60" : ""}>
                        <td className="px-3 py-3 text-slate-700">{formatDateTime(run.createdAt)}</td>
                        <td className="px-3 py-3"><AdminInsightChip tone={run.overallStatus === "failed" ? "orange" : run.overallStatus === "healthy" ? "emerald" : "slate"} surface="light">{OVERALL_TONE[run.overallStatus].label}</AdminInsightChip></td>
                        <td className="px-3 py-3 text-slate-600">{run.passedCount} / {run.failedCount} / {run.skippedCount}</td>
                        <td className="px-3 py-3 text-slate-600">{formatDuration(run.durationMs)}</td>
                        <td className="px-3 py-3">
                          <button
                            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            disabled={run.id === activeRun.id || historyLoading === run.id}
                            onClick={() => viewRun(run.id)}
                            type="button"
                          >
                            {historyLoading === run.id ? "Loading…" : run.id === activeRun.id ? "Viewing" : "View"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AdminTableShell>
          )}
        </>
      )}

      {selectedResult && <JourneyDetailDrawer result={selectedResult} onClose={() => setSelectedResult(null)} />}
    </div>
  );
}
