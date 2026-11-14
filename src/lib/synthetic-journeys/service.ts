import { getSupabaseAdmin } from "@/lib/supabase/server";

import { computeOverallStatus, isSkippedOnPurpose, skippedOnPurposeNote, type OverallStatus } from "./overall-status";

export type { OverallStatus } from "./overall-status";

export interface JourneyResult {
  journeyId: string;
  journeyName: string;
  route: string;
  role: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  errors: string[];
  consoleErrors: string[];
  networkErrors: string[];
  screenshotPath?: string;
  recommendation?: string;
  /** The reason a check gave when it skipped itself (tests/synthetic/helpers/skip-reason.ts). */
  skipReason?: string;
}

export interface SyntheticJourneyRunSummary {
  id: string;
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  environment: string | null;
  overallStatus: OverallStatus;
  totalCount: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
  createdBy: string | null;
  createdAt: string;
}

export interface SyntheticJourneyResultRow {
  id: string;
  runId: string;
  journeyId: string;
  journeyName: string;
  route: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  failureReason: string | null;
  recommendation: string | null;
  screenshotPath: string | null;
  tracePath: string | null;
  errors: string[];
  consoleErrors: string[];
  networkErrors: string[];
  createdAt: string;
}

export interface SyntheticJourneyRunDetail extends SyntheticJourneyRunSummary {
  results: SyntheticJourneyResultRow[];
}

export interface IngestSyntheticJourneyReportMeta {
  baseUrl: string;
  startedAt?: string;
  finishedAt?: string;
  createdBy?: string | null;
  environment?: string | null;
}

const AUTH_JOURNEY_NAME = "authenticate as synthetic admin";
const AUTH_JOURNEY_ROUTE = "/login";
const AUTH_JOURNEY_ROLE = "Super Admin";

function normalizeJourneyResult(result: JourneyResult): JourneyResult {
  if (result.journeyName !== AUTH_JOURNEY_NAME) return result;
  return { ...result, route: AUTH_JOURNEY_ROUTE, role: AUTH_JOURNEY_ROLE };
}

function estimateRunWindow(results: JourneyResult[], meta: IngestSyntheticJourneyReportMeta) {
  const finishedAt = meta.finishedAt ? new Date(meta.finishedAt) : new Date();
  if (meta.startedAt) return { startedAt: new Date(meta.startedAt), finishedAt };
  const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  return { startedAt: new Date(finishedAt.getTime() - totalDurationMs), finishedAt };
}

function environmentFromBaseUrl(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).host;
    // The canonical custom domain is the ONLY host that means production.
    //
    // The Cloud Run service-host literal and the blanket Cloud Run suffix match that used to sit
    // beside it were removed on 2026-09-30, the cutover being long finished (AGENTS.md §3: GCP is
    // dead, billing closed, every API answers BILLING_DISABLED). Those hostnames are not ours any
    // more, so reading one as "production" would label a run against a host the company does not
    // control as the real thing. Anything unrecognised now falls through to "preview", which is the
    // honest answer — this value is a display label only (sole caller is the ingest insert below,
    // rendered as a string by the System Issues dashboard), so nothing branches on it.
    //
    // 🔴 Deliberately not written out here: scripts/check-no-stale-domains.mjs scans this file for
    // that hostname pattern, and prose quoting it would trip the very gate that keeps it gone.
    if (host === "phoenix-hr.satopharma.com") {
      return "production";
    }
    if (host.includes("localhost") || host.includes("127.0.0.1")) return "local";
    return "preview";
  } catch {
    return null;
  }
}

function mapRunRow(row: Record<string, unknown>): SyntheticJourneyRunSummary {
  return {
    id: row.id as string,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string,
    baseUrl: row.base_url as string,
    environment: (row.environment as string | null) ?? null,
    overallStatus: row.overall_status as OverallStatus,
    totalCount: row.total_count as number,
    passedCount: row.passed_count as number,
    failedCount: row.failed_count as number,
    skippedCount: row.skipped_count as number,
    durationMs: row.duration_ms as number,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

function mapResultRow(row: Record<string, unknown>): SyntheticJourneyResultRow {
  const errors = (row.errors as { errors?: string[]; consoleErrors?: string[]; networkErrors?: string[] } | null) ?? {};
  return {
    id: row.id as string,
    runId: row.run_id as string,
    journeyId: row.journey_id as string,
    journeyName: row.journey_name as string,
    route: row.route as string,
    status: row.status as "passed" | "failed" | "skipped",
    durationMs: row.duration_ms as number,
    failureReason: (row.failure_reason as string | null) ?? null,
    recommendation: (row.recommendation as string | null) ?? null,
    screenshotPath: (row.screenshot_path as string | null) ?? null,
    tracePath: (row.trace_path as string | null) ?? null,
    errors: errors.errors ?? [],
    consoleErrors: errors.consoleErrors ?? [],
    networkErrors: errors.networkErrors ?? [],
    createdAt: row.created_at as string,
  };
}

export async function ingestSyntheticJourneyReport(
  journeyResults: JourneyResult[],
  meta: IngestSyntheticJourneyReportMeta,
): Promise<SyntheticJourneyRunDetail> {
  if (!Array.isArray(journeyResults) || journeyResults.length === 0) {
    throw new Error("journeyResults must be a non-empty array.");
  }
  if (!meta.baseUrl) {
    throw new Error("baseUrl is required.");
  }

  const normalized = journeyResults.map(normalizeJourneyResult);
  const { startedAt, finishedAt } = estimateRunWindow(normalized, meta);
  const durationMs = normalized.reduce((sum, r) => sum + r.durationMs, 0);
  const overallStatus = computeOverallStatus(normalized);

  const supabase = getSupabaseAdmin();

  const { data: run, error: runError } = await supabase
    .from("synthetic_journey_runs")
    .insert({
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      base_url: meta.baseUrl,
      environment: meta.environment ?? environmentFromBaseUrl(meta.baseUrl),
      overall_status: overallStatus,
      total_count: normalized.length,
      passed_count: normalized.filter((r) => r.status === "passed").length,
      failed_count: normalized.filter((r) => r.status === "failed").length,
      skipped_count: normalized.filter((r) => r.status === "skipped").length,
      duration_ms: durationMs,
      report_json: normalized,
      created_by: meta.createdBy ?? null,
    })
    .select("id")
    .single();
  if (runError) throw runError;

  const resultRows = normalized.map((r) => ({
    run_id: run.id as string,
    journey_id: r.journeyId,
    journey_name: r.journeyName,
    route: r.route,
    status: r.status,
    duration_ms: r.durationMs,
    failure_reason: r.errors[0] ?? null,
    // A check that skipped itself has no advice to carry; the page prints its own reason in that place.
    recommendation: r.recommendation ?? (isSkippedOnPurpose(r) && r.skipReason ? skippedOnPurposeNote(r.skipReason) : null),
    screenshot_path: r.screenshotPath ?? null,
    trace_path: null,
    errors: { errors: r.errors, consoleErrors: r.consoleErrors, networkErrors: r.networkErrors },
  }));
  const { error: resultsError } = await supabase.from("synthetic_journey_results").insert(resultRows);
  if (resultsError) throw resultsError;

  const inserted = await getRunById(run.id as string);
  if (!inserted) throw new Error(`Failed to read back the just-inserted run "${run.id}".`);
  return inserted;
}

export async function getLatestRun(): Promise<SyntheticJourneyRunDetail | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("synthetic_journey_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return getRunById(data.id as string);
}

export async function listRuns(limit = 20): Promise<SyntheticJourneyRunSummary[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("synthetic_journey_runs")
    .select("id, started_at, finished_at, base_url, environment, overall_status, total_count, passed_count, failed_count, skipped_count, duration_ms, created_by, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(mapRunRow);
}

export async function getRunById(runId: string): Promise<SyntheticJourneyRunDetail | null> {
  const supabase = getSupabaseAdmin();
  const { data: run, error: runError } = await supabase
    .from("synthetic_journey_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (runError) throw runError;
  if (!run) return null;

  const { data: results, error: resultsError } = await supabase
    .from("synthetic_journey_results")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (resultsError) throw resultsError;

  return {
    ...mapRunRow(run),
    results: (results ?? []).map(mapResultRow),
  };
}
