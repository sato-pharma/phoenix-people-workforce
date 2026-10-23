import { AlertTriangle, CircleSlash } from "lucide-react";
import type { ReactNode } from "react";

import { AdminCallout, AdminInsightChip, AdminTableShell } from "@/components/admin/admin-design-system";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import {
  NO_STORED_RUN_MESSAGE,
  detectorLabel,
  exclusionLabel,
  type DetectorRunSummary,
  type IntegrityCheckStatus,
  type IntegrityCheckView,
  type IntegrityOverview,
} from "@/lib/system-audit/integrity-runs";
import { cn } from "@/lib/utils";

/**
 * The Integrity checks tab. For every check of the latest stored nightly reconciliation: what it
 * checks, its domain and severity, whether it holds, and BOTH sides — "Screen" (the figure a person
 * reads) and "Second source" (the same fact derived another way) — with the detail of what differs.
 * Then the last 30 runs, and every other detector's latest run with what it excluded as noise and
 * which sources it could not read.
 *
 * "errored" reads NOT MEASURED, never a pass. Fits its own width: tables from 860px of container,
 * cards below — nothing scrolls sideways and nothing is cut.
 */

const STATUS_TONE: Record<IntegrityCheckStatus, string> = {
  holds: "text-emerald-700",
  breached: "text-rose-700",
  "known-open": "text-amber-800",
  errored: "text-slate-600",
};

const RUN_TONE: Record<string, string> = {
  ok: "text-emerald-700",
  partial: "text-amber-800",
  budget_exhausted: "text-amber-800",
  aborted_db_unhealthy: "text-rose-700",
  errored: "text-rose-700",
  skipped: "text-slate-600",
  running: "text-slate-600",
};

const headCell = "px-3 py-2 text-left align-bottom text-phx-2xs font-bold uppercase tracking-[0.06em] break-words";
const bodyCell = "px-3 py-2 align-top break-words";

function Side({ label, side }: { label: string; side: IntegrityCheckView["screen"] }) {
  return (
    <div className="min-w-0">
      <p className="text-phx-2xs font-bold uppercase text-slate-400">{label}</p>
      {side ? (
        <>
          <p className="break-words font-semibold text-slate-800">{side.value || "—"}</p>
          {side.source ? <p className="break-words text-phx-2xs text-slate-500">{side.source}</p> : null}
        </>
      ) : (
        <p className="text-slate-500">Not measured</p>
      )}
    </div>
  );
}

function CheckDetail({ check }: { check: IntegrityCheckView }) {
  return (
    <div className="space-y-1">
      {check.detail ? <p className="break-words text-slate-700">{check.detail}</p> : null}
      {check.openDefect ? <p className="break-words text-amber-900">Known open: {check.openDefect}</p> : null}
      {check.error ? <p className="break-words font-semibold text-rose-700">{check.error}</p> : null}
    </div>
  );
}

function ChecksTable({ checks }: { checks: IntegrityCheckView[] }) {
  return (
    <div className="@container min-w-0">
      <table className="hidden w-full table-fixed border-collapse text-xs @min-[860px]:table">
        <colgroup>
          <col className="w-[22%]" />
          <col className="w-[11%]" />
          <col className="w-[34%]" />
          <col className="w-[33%]" />
        </colgroup>
        <thead>
          <tr className="bg-[#0B0B0B] text-white">
            <th className={headCell} scope="col">Check · domain · severity</th>
            <th className={headCell} scope="col">Status</th>
            <th className={headCell} scope="col">Screen / Second source</th>
            <th className={headCell} scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr className="border-b border-slate-100" key={check.id}>
              <td className={bodyCell}>
                <p className="break-words font-bold text-slate-900">{check.title}</p>
                <p className="text-slate-500">
                  {check.domain} · {check.severity}
                </p>
              </td>
              <td className={cn(bodyCell, "font-bold", STATUS_TONE[check.status])}>{check.statusLabel}</td>
              <td className={bodyCell}>
                <div className="space-y-2">
                  <Side label="Screen" side={check.screen} />
                  <Side label="Second source" side={check.secondSource} />
                </div>
              </td>
              <td className={bodyCell}>
                <CheckDetail check={check} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-slate-200 @min-[860px]:hidden">
        {checks.map((check) => (
          <li className="space-y-2 px-3 py-3 text-xs" key={check.id}>
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 break-words font-bold text-slate-900">{check.title}</p>
              <p className={cn("max-w-[40%] text-right font-bold", STATUS_TONE[check.status])}>{check.statusLabel}</p>
            </div>
            <p className="text-slate-500">
              {check.domain} · {check.severity}
            </p>
            <div className="grid grid-cols-1 gap-2 @min-[480px]:grid-cols-2">
              <Side label="Screen" side={check.screen} />
              <Side label="Second source" side={check.secondSource} />
            </div>
            <CheckDetail check={check} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function countsLine(run: DetectorRunSummary): string {
  return `${run.scanned.toLocaleString("en-US")} scanned · ${run.inserted.toLocaleString("en-US")} new · ${run.updated.toLocaleString("en-US")} updated`;
}

function Exclusions({ run }: { run: DetectorRunSummary }) {
  const entries = Object.entries(run.excludedCounts).filter(([, count]) => count > 0);
  if (entries.length === 0) return <span className="text-slate-500">Nothing excluded</span>;
  return (
    <span className="break-words">
      {entries.map(([key, count]) => `${exclusionLabel(key)}: ${count.toLocaleString("en-US")}`).join(" · ")}
    </span>
  );
}

function Unreadable({ run }: { run: DetectorRunSummary }) {
  if (run.unreadableSources.length === 0) return <span className="text-slate-500">Every source read</span>;
  return <span className="break-words font-semibold text-rose-700">Could not read: {run.unreadableSources.join(" · ")}</span>;
}

function RunsTable({ runs, showDetector }: { runs: DetectorRunSummary[]; showDetector: boolean }) {
  return (
    <div className="@container min-w-0">
      <table className="hidden w-full table-fixed border-collapse text-xs @min-[860px]:table">
        <colgroup>
          <col className="w-[20%]" />
          <col className="w-[16%]" />
          <col className="w-[20%]" />
          <col className="w-[22%]" />
          <col className="w-[22%]" />
        </colgroup>
        <thead>
          <tr className="bg-slate-50 text-slate-500">
            <th className={headCell} scope="col">{showDetector ? "Detector · started (Cairo)" : "Started (Cairo)"}</th>
            <th className={headCell} scope="col">Status</th>
            <th className={headCell} scope="col">Counts</th>
            <th className={headCell} scope="col">Excluded as noise</th>
            <th className={headCell} scope="col">Sources</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr className="border-b border-slate-100" key={run.id}>
              <td className={bodyCell}>
                {showDetector ? <p className="break-words font-bold text-slate-900">{detectorLabel(run.detector)}</p> : null}
                <p className="text-slate-700">{cairoDateTime(run.startedAt)}</p>
              </td>
              <td className={bodyCell}>
                <p className={cn("font-bold", RUN_TONE[run.status] ?? "text-slate-700")}>{run.statusLabel}</p>
                {run.error ? <p className="mt-0.5 break-words text-rose-700">{run.error}</p> : null}
              </td>
              <td className={cn(bodyCell, "tabular-nums text-slate-700")}>{countsLine(run)}</td>
              <td className={cn(bodyCell, "text-slate-700")}>
                <Exclusions run={run} />
              </td>
              <td className={bodyCell}>
                <Unreadable run={run} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-slate-200 @min-[860px]:hidden">
        {runs.map((run) => (
          <li className="space-y-1 px-3 py-3 text-xs text-slate-700" key={run.id}>
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 break-words font-bold text-slate-900">
                {showDetector ? `${detectorLabel(run.detector)} · ` : ""}
                {cairoDateTime(run.startedAt)}
              </p>
              <p className={cn("max-w-[45%] text-right font-bold", RUN_TONE[run.status] ?? "text-slate-700")}>{run.statusLabel}</p>
            </div>
            {run.error ? <p className="break-words text-rose-700">{run.error}</p> : null}
            <p className="tabular-nums">{countsLine(run)}</p>
            <p>
              <Exclusions run={run} />
            </p>
            <p>
              <Unreadable run={run} />
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-6 text-sm text-slate-500">{children}</p>;
}

export function IntegrityChecks({ overview }: { overview: IntegrityOverview }) {
  const latest = overview.latest;
  const counts = latest?.counts ?? null;
  return (
    <div className="min-w-0 space-y-5">
      {latest ? (
        <AdminTableShell
          action={
            counts ? (
              <div className="flex flex-wrap gap-2">
                <AdminInsightChip tone="emerald">{counts.holding} hold</AdminInsightChip>
                <AdminInsightChip tone={counts.breached > 0 ? "orange" : "neutral"}>{counts.breached} breached</AdminInsightChip>
                <AdminInsightChip tone="slate">{counts.knownOpen} known open</AdminInsightChip>
                <AdminInsightChip tone="slate">{counts.errored} not measured</AdminInsightChip>
              </div>
            ) : undefined
          }
          description={`The nightly run of ${cairoDateTime(latest.run.startedAt)} Cairo (${latest.run.statusLabel.toLowerCase()}), ${latest.checks.length} checks. Each compares the figure a screen shows with the same fact derived a second way.`}
          title="Latest integrity report"
        >
          {latest.reportProblem ? (
            <div className="p-4">
              <AdminCallout tone="warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="break-words">The stored report could not be read: {latest.reportProblem}</p>
              </AdminCallout>
            </div>
          ) : latest.checks.length === 0 ? (
            <Empty>The stored report holds no checks.</Empty>
          ) : (
            <ChecksTable checks={latest.checks} />
          )}
        </AdminTableShell>
      ) : (
        <AdminCallout tone="neutral">
          <CircleSlash className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="break-words">{NO_STORED_RUN_MESSAGE}</p>
        </AdminCallout>
      )}

      <AdminTableShell
        description={`The last ${overview.history.length} nightly integrity runs, newest first, in Cairo time.`}
        title="Integrity run history"
      >
        {overview.history.length === 0 ? <Empty>{NO_STORED_RUN_MESSAGE}</Empty> : <RunsTable runs={overview.history} showDetector={false} />}
      </AdminTableShell>

      <AdminTableShell
        description={`Each other detector's latest run among the last ${overview.otherDetectorWindow.toLocaleString("en-US")} runs: what it scanned, what it excluded as noise (counted per class, never dropped silently), and any source it could not read — a finding from an unread source is unknown, never a pass.`}
        title="Other detectors"
      >
        {overview.otherDetectors.length === 0 ? (
          <Empty>No other detector has a run in the last {overview.otherDetectorWindow.toLocaleString("en-US")} runs.</Empty>
        ) : (
          <RunsTable runs={overview.otherDetectors} showDetector />
        )}
      </AdminTableShell>
    </div>
  );
}
