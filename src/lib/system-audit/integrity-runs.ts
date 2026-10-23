/**
 * System Error & Data Integrity Audit — the Integrity checks tab.
 *
 * The nightly reconciliation compares, for each of its checks, the figure a SCREEN shows with the
 * same fact derived a SECOND way (src/lib/reconciliation/types.ts). Its report was never stored
 * until the ledger; the reconciliation detector now stores the whole report on its
 * `system_audit_detector_runs` row. This reads:
 *   · the latest stored report — every check, both sides, the detail;
 *   · the last 30 reconciliation runs (when, counts, status);
 *   · every other detector's latest run (scanned, excluded per class, unreadable sources).
 *
 * "errored" is shown as NOT MEASURED — an unknown answer is never a pass. Before the first stored
 * run the tab says so in words. A failed read throws; the tab then says "Unavailable — reason".
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  ReconciliationCheckResult,
  ReconciliationCounts,
  ReconciliationReport,
} from "@/lib/reconciliation/types";

type Client = ReturnType<typeof getSupabaseAdmin>;

function client(override?: Client): Client {
  return override ?? getSupabaseAdmin({ requestTimeoutMs: 15_000 });
}

export const RECONCILIATION_DETECTOR = "reconciliation";
export const RECONCILIATION_HISTORY_LENGTH = 30;
/** How far back "each other detector's latest run" looks. Stated on screen, never silent. */
export const OTHER_DETECTOR_WINDOW = 500;
export const NO_STORED_RUN_MESSAGE = "No stored run yet — the first nightly run stores its report.";

export const RECONCILIATION_DOMAIN_LABELS: Record<string, string> = {
  payroll: "Payroll",
  "deductions-attendance": "Deductions and attendance",
  "crm-sales": "CRM and sales",
  "notifications-integrity": "Notifications",
  recruitment: "Recruitment",
  "direct-orders": "Direct orders",
};

export const RECONCILIATION_SEVERITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
};

export type IntegrityCheckStatus = "holds" | "breached" | "known-open" | "errored";

export const INTEGRITY_CHECK_STATUS_LABELS: Record<IntegrityCheckStatus, string> = {
  holds: "Holds",
  breached: "Breached",
  "known-open": "Known open",
  errored: "Not measured",
};

export const DETECTOR_RUN_STATUS_LABELS: Record<string, string> = {
  running: "Running",
  ok: "Completed",
  partial: "Partly completed",
  budget_exhausted: "Stopped — time budget used up",
  aborted_db_unhealthy: "Stopped — database unhealthy",
  errored: "Failed",
  skipped: "Skipped",
};

export type IntegrityCheckView = {
  id: string;
  title: string;
  domain: string;
  severity: string;
  status: IntegrityCheckStatus;
  statusLabel: string;
  screen: { value: string; source: string } | null;
  secondSource: { value: string; source: string } | null;
  detail: string;
  openDefect: string | null;
  error: string | null;
};

export type DetectorRunSummary = {
  id: string;
  detector: string;
  mode: string;
  status: string;
  statusLabel: string;
  startedAt: string;
  finishedAt: string | null;
  scanned: number;
  inserted: number;
  updated: number;
  excludedCounts: Record<string, number>;
  unreadableSources: string[];
  error: string | null;
};

export type IntegrityOverview = {
  latest: {
    run: DetectorRunSummary;
    /** Null when the stored report could not be read as a reconciliation report. */
    counts: ReconciliationCounts | null;
    generatedAt: string | null;
    checks: IntegrityCheckView[];
    reportProblem: string | null;
  } | null;
  history: DetectorRunSummary[];
  otherDetectors: DetectorRunSummary[];
  otherDetectorWindow: number;
};

type Row = Record<string, unknown>;

function toCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(count);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

export function mapDetectorRun(row: Row): DetectorRunSummary {
  const status = String(row.status ?? "running");
  return {
    id: String(row.id),
    detector: String(row.detector ?? ""),
    mode: String(row.mode ?? ""),
    status,
    statusLabel: DETECTOR_RUN_STATUS_LABELS[status] ?? status,
    startedAt: String(row.started_at),
    finishedAt: typeof row.finished_at === "string" ? row.finished_at : null,
    scanned: Number(row.scanned ?? 0),
    inserted: Number(row.inserted ?? 0),
    updated: Number(row.updated ?? 0),
    excludedCounts: toCounts(row.excluded_counts),
    unreadableSources: Array.isArray(row.unreadable_sources) ? (row.unreadable_sources as unknown[]).map(String) : [],
    error: typeof row.error === "string" ? row.error : null,
  };
}

const CHECK_STATUSES: readonly IntegrityCheckStatus[] = ["holds", "breached", "known-open", "errored"];

function side(value: unknown): { value: string; source: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return { value: String(record.value ?? ""), source: String(record.source ?? "") };
}

/**
 * The stored report's checks, as the tab shows them. Defensive by design: the report is JSON from
 * a run, and a check this cannot read becomes a NOT MEASURED row naming what was wrong — never a
 * dropped row.
 */
export function mapReconciliationReport(report: unknown): {
  counts: ReconciliationCounts | null;
  generatedAt: string | null;
  checks: IntegrityCheckView[];
  problem: string | null;
} {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { counts: null, generatedAt: null, checks: [], problem: "The stored report is empty or not an object." };
  }
  const value = report as Partial<ReconciliationReport> & { openDefects?: Record<string, string> };
  if (!Array.isArray(value.results)) {
    return { counts: null, generatedAt: null, checks: [], problem: "The stored report carries no list of checks." };
  }
  const checks = (value.results as Array<Partial<ReconciliationCheckResult> & { openDefect?: string }>).map(
    (result, index): IntegrityCheckView => {
      const rawStatus = String(result.status ?? "");
      const known = (CHECK_STATUSES as readonly string[]).includes(rawStatus);
      const status: IntegrityCheckStatus = known ? (rawStatus as IntegrityCheckStatus) : "errored";
      const domain = String(result.domain ?? "");
      const severity = String(result.severity ?? "");
      return {
        id: String(result.id ?? `check-${index + 1}`),
        title: String(result.title ?? result.id ?? `Check ${index + 1}`),
        domain: RECONCILIATION_DOMAIN_LABELS[domain] ?? (domain || "Not stated"),
        severity: RECONCILIATION_SEVERITY_LABELS[severity] ?? (severity || "Not stated"),
        status,
        statusLabel: INTEGRITY_CHECK_STATUS_LABELS[status],
        screen: side(result.left),
        secondSource: side(result.right),
        detail: String(result.detail ?? ""),
        openDefect: typeof result.openDefect === "string" ? result.openDefect : null,
        error: known
          ? typeof result.error === "string"
            ? result.error
            : null
          : `The stored status "${rawStatus || "none"}" is not one this page knows, so it is shown as not measured.`,
      };
    },
  );
  const counts = value.counts && typeof value.counts === "object" ? (value.counts as ReconciliationCounts) : null;
  return {
    counts,
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : null,
    checks,
    problem: null,
  };
}

const RUN_COLUMNS =
  "id, detector, mode, status, started_at, finished_at, scanned, inserted, updated, excluded_counts, unreadable_sources, error";

export async function loadIntegrityOverview(override?: Client): Promise<IntegrityOverview> {
  const supabase = client(override);
  const [latestResult, historyResult, othersResult] = await Promise.all([
    supabase
      .from("system_audit_detector_runs")
      .select(`${RUN_COLUMNS}, report`)
      .eq("detector", RECONCILIATION_DETECTOR)
      .not("report", "is", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("system_audit_detector_runs")
      .select(RUN_COLUMNS)
      .eq("detector", RECONCILIATION_DETECTOR)
      .order("started_at", { ascending: false })
      .limit(RECONCILIATION_HISTORY_LENGTH),
    supabase
      .from("system_audit_detector_runs")
      .select(RUN_COLUMNS)
      .neq("detector", RECONCILIATION_DETECTOR)
      .order("started_at", { ascending: false })
      .limit(OTHER_DETECTOR_WINDOW),
  ]);
  if (latestResult.error) throw new Error(`The latest integrity report could not be read: ${latestResult.error.message}`);
  if (historyResult.error) throw new Error(`The integrity run history could not be read: ${historyResult.error.message}`);
  if (othersResult.error) throw new Error(`The other detectors' runs could not be read: ${othersResult.error.message}`);

  let latest: IntegrityOverview["latest"] = null;
  if (latestResult.data) {
    const row = latestResult.data as Row;
    const mapped = mapReconciliationReport(row.report);
    latest = {
      run: mapDetectorRun(row),
      counts: mapped.counts,
      generatedAt: mapped.generatedAt,
      checks: mapped.checks,
      reportProblem: mapped.problem,
    };
  }

  const seen = new Set<string>();
  const otherDetectors: DetectorRunSummary[] = [];
  for (const row of (othersResult.data ?? []) as Row[]) {
    const run = mapDetectorRun(row);
    if (seen.has(run.detector)) continue;
    seen.add(run.detector);
    otherDetectors.push(run);
  }
  otherDetectors.sort((a, b) => a.detector.localeCompare(b.detector));

  return {
    latest,
    history: ((historyResult.data ?? []) as Row[]).map(mapDetectorRun),
    otherDetectors,
    otherDetectorWindow: OTHER_DETECTOR_WINDOW,
  };
}

/** A detector id in words: `visit_lifecycle` → "Visit lifecycle". */
export function detectorLabel(detector: string): string {
  const words = detector.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unnamed detector";
}

/** An excluded-noise class in words: `bot_traffic` → "Bot traffic". */
export function exclusionLabel(key: string): string {
  return detectorLabel(key);
}
