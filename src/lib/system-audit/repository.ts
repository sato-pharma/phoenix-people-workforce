import { getSupabaseAdmin } from "@/lib/supabase/server";
import { currentPersonNames, withCurrentPersonNames } from "@/lib/system-audit/person-names";
import type {
  AuditIssueInput,
  AuditOccurrenceInput,
  DetectorMode,
  DetectorResult,
  FindingBatch,
  FindingSink,
  FindingSinkWriteResult,
  SystemAuditExportBatch,
  SystemAuditFilters,
  SystemAuditPage,
  SystemAuditSort,
  SystemAuditStatus,
} from "@/lib/system-audit/types";

/**
 * Every read and write of the System Audit ledger. The ledger is service-role only (RLS on, no
 * anon/authenticated grant), so these run only on the server, and only behind
 * assertSystemAdministratorWorkspaceAccess or a CRON_SECRET-checked route.
 *
 * A failed call THROWS. Nothing here turns a failure into an empty page or a zero — the page says
 * "unavailable" instead, which is the whole point of replacing the old dashboards.
 */

type Client = ReturnType<typeof getSupabaseAdmin>;

function client(override?: Client): Client {
  return override ?? getSupabaseAdmin({ requestTimeoutMs: 20_000 });
}

function failure(what: string, error: { message?: string; code?: string } | null): Error {
  const code = error?.code ? ` (${error.code})` : "";
  return new Error(`System audit ${what} failed${code}: ${error?.message ?? "unknown error"}`);
}

function issueRow(issue: AuditIssueInput) {
  return {
    signature_key: issue.signatureKey,
    family: issue.family,
    error_code: issue.errorCode,
    title: issue.title,
    root_cause_level: issue.rootCauseLevel ?? "unknown",
    root_cause: issue.rootCause ?? null,
    root_cause_evidence: issue.rootCauseEvidence ?? {},
    status: issue.status ?? "investigating",
    first_seen_at: issue.firstSeenAt ?? null,
    last_seen_at: issue.lastSeenAt ?? null,
  };
}

function occurrenceRow(row: AuditOccurrenceInput) {
  return {
    dedupe_key: row.dedupeKey,
    signature_key: row.signatureKey,
    correlation_id: row.correlationId ?? null,
    is_root_symptom: row.isRootSymptom ?? true,
    hr_key: row.hrKey ?? null,
    hr_id_display: row.hrIdDisplay ?? null,
    employee_name: row.employeeName ?? null,
    role_at_event: row.roleAtEvent ?? null,
    module_label: row.moduleLabel,
    module_label_source: row.moduleLabelSource,
    shell: row.shell ?? null,
    route: row.route ?? null,
    occurred_at: row.occurredAt,
    occurred_at_kind: row.occurredAtKind,
    affected_date: row.affectedDate ?? null,
    user_message: row.userMessage ?? null,
    is_silent: row.isSilent,
    technical_message: row.technicalMessage ? row.technicalMessage.slice(0, 1000) : null,
    error_code: row.errorCode,
    related_table: row.relatedTable ?? null,
    related_id: row.relatedId ?? null,
    attempt_count: Math.max(1, row.attemptCount ?? 1),
    page_loads: Math.max(1, row.pageLoads ?? 1),
    first_event_at: row.firstEventAt ?? row.occurredAt,
    last_event_at: row.lastEventAt ?? row.occurredAt,
    source_refs: (row.sourceRefs ?? []).slice(0, 50),
    release: row.release ?? null,
    pre_fix_build: row.preFixBuild ?? false,
    evidence: row.evidence ?? {},
    is_test: row.isTest ?? false,
  };
}

/** Rows per RPC call: big enough to keep transatlantic round trips few, small enough for 8 s. */
const WRITE_CHUNK = 500;

export async function upsertFindings(
  detector: string,
  runId: string | null,
  batch: FindingBatch,
  override?: Client,
): Promise<FindingSinkWriteResult> {
  const supabase = client(override);
  const total: FindingSinkWriteResult = { issues: 0, inserted: 0, updated: 0 };
  const issues = batch.issues.map(issueRow);
  const rows = batch.occurrences.map(occurrenceRow);
  // Issues go first and alone, so every occurrence chunk finds its issue already there.
  const chunks = Math.max(1, Math.ceil(rows.length / WRITE_CHUNK));
  for (let index = 0; index < chunks; index += 1) {
    const isLast = index === chunks - 1;
    const { data, error } = await supabase.rpc("system_audit_upsert_occurrences", {
      p_detector: detector,
      p_run_id: runId,
      p_issues: index === 0 ? issues : [],
      p_rows: rows.slice(index * WRITE_CHUNK, (index + 1) * WRITE_CHUNK),
      p_merge: batch.merge,
      // The watermark moves only with the LAST chunk: a run that dies mid-batch re-reads it.
      p_cursor: isLast ? (batch.cursor ?? null) : null,
    });
    if (error) throw failure("write", error);
    const result = (data ?? {}) as Partial<FindingSinkWriteResult>;
    total.issues += result.issues ?? 0;
    total.inserted += result.inserted ?? 0;
    total.updated += result.updated ?? 0;
  }
  return total;
}

export async function readWatermark(detector: string, override?: Client): Promise<Record<string, unknown> | null> {
  const { data, error } = await client(override)
    .from("system_audit_watermarks")
    .select("cursor")
    .eq("detector", detector)
    .maybeSingle();
  if (error) throw failure("watermark read", error);
  const cursor = (data as { cursor?: Record<string, unknown> } | null)?.cursor ?? null;
  return cursor && Object.keys(cursor).length > 0 ? cursor : null;
}

/** The database sink every cron detector writes through. */
export function createDatabaseSink(override?: Client): FindingSink {
  return {
    kind: "database",
    write: (detector, runId, batch) => upsertFindings(detector, runId, batch, override),
    readCursor: (detector) => readWatermark(detector, override),
  };
}

export async function startDetectorRun(
  input: { detector: string; mode: DetectorMode; runGroup: string | null; release: string | null },
  override?: Client,
): Promise<string> {
  const { data, error } = await client(override)
    .from("system_audit_detector_runs")
    .insert({ detector: input.detector, mode: input.mode, run_group: input.runGroup, release: input.release, status: "running" })
    .select("id")
    .single();
  if (error) throw failure("run start", error);
  return (data as { id: string }).id;
}

export async function finishDetectorRun(runId: string, result: DetectorResult, override?: Client): Promise<void> {
  const { error } = await client(override)
    .from("system_audit_detector_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: result.status,
      watermark_from: result.watermarkFrom ?? null,
      watermark_to: result.watermarkTo ?? null,
      scanned: result.scanned,
      excluded_counts: result.excludedCounts,
      inserted: result.inserted,
      updated: result.updated,
      unreadable_sources: result.unreadableSources,
      report: result.report ?? null,
      error: result.error ? result.error.slice(0, 2000) : null,
    })
    .eq("id", runId);
  if (error) throw failure("run finish", error);
}

export async function acquireSweepLease(detector: string, holder: string, seconds: number, override?: Client): Promise<boolean> {
  const { data, error } = await client(override).rpc("system_audit_acquire_lease", {
    p_detector: detector,
    p_holder: holder,
    p_seconds: seconds,
  });
  if (error) throw failure("lease", error);
  return data === true;
}

export async function releaseSweepLease(detector: string, holder: string, override?: Client): Promise<void> {
  const { error } = await client(override).rpc("system_audit_release_lease", { p_detector: detector, p_holder: holder });
  if (error) throw failure("lease release", error);
}

function filtersPayload(filters: SystemAuditFilters): Record<string, unknown> {
  return {
    from: filters.from ?? null,
    to: filters.to ?? null,
    hrKeys: filters.hrKeys ?? [],
    modules: filters.modules ?? [],
    statuses: filters.statuses ?? [],
    rootCauseLevels: filters.rootCauseLevels ?? [],
    families: filters.families ?? [],
    scope: filters.scope ?? null,
    search: filters.search ?? null,
    includeSilent: filters.includeSilent ?? true,
    includeTest: filters.includeTest ?? false,
  };
}

export async function loadSystemAuditPage(
  input: { filters: SystemAuditFilters; sort: SystemAuditSort; limit: number; offset: number },
  override?: Client,
): Promise<SystemAuditPage> {
  const supabase = client(override);
  const { data, error } = await supabase.rpc("system_audit_page", {
    p_filters: filtersPayload(input.filters),
    p_sort: input.sort,
    p_limit: input.limit,
    p_offset: input.offset,
    p_after: null,
  });
  if (error) throw failure("page read", error);
  const page = data as SystemAuditPage;
  return { ...page, rows: await withCurrentPersonNames(page.rows, supabase) };
}

/**
 * Every filtered row, in 5,000-row keyset batches — the export never stops at a page or at
 * PostgREST's 1,000-row cap. The caller streams each batch out as it arrives.
 */
export async function* iterateSystemAuditExport(
  filters: SystemAuditFilters,
  override?: Client,
): AsyncGenerator<SystemAuditExportBatch, void, void> {
  const supabase = client(override);
  let after: Record<string, unknown> = {};
  for (let guard = 0; guard < 1000; guard += 1) {
    const { data, error } = await supabase.rpc("system_audit_page", {
      p_filters: filtersPayload(filters),
      p_sort: "occurred_desc",
      p_limit: 5000,
      p_offset: 0,
      p_after: after,
    });
    if (error) throw failure("export read", error);
    const page = data as SystemAuditExportBatch;
    yield { ...page, rows: await withCurrentPersonNames(page.rows, supabase) };
    if (!page.next || page.rows.length === 0) return;
    after = page.next;
  }
  throw new Error("System audit export did not finish within 1,000 batches.");
}

export async function transitionIssueStatus(
  input: {
    issueId: string;
    to: SystemAuditStatus;
    actor: string;
    reason?: string | null;
    fixSha?: string | null;
    fixLiveAt?: string | null;
    evidence?: Record<string, unknown>;
    occurrenceId?: string | null;
  },
  override?: Client,
): Promise<{ from: SystemAuditStatus; to: SystemAuditStatus; fixId: string | null }> {
  const { data, error } = await client(override).rpc("system_audit_transition_status", {
    p_issue_id: input.issueId,
    p_to: input.to,
    p_actor: input.actor,
    p_reason: input.reason ?? null,
    p_fix_sha: input.fixSha ?? null,
    p_fix_live_at: input.fixLiveAt ?? null,
    p_evidence: input.evidence ?? {},
    p_occurrence_id: input.occurrenceId ?? null,
  });
  if (error) throw failure("status change", error);
  return data as { from: SystemAuditStatus; to: SystemAuditStatus; fixId: string | null };
}

export async function triageOccurrence(
  input: { occurrenceId: string; override: "no_defect" | "unknown" | null; actor: string; reason: string | null },
  override?: Client,
): Promise<void> {
  const { error } = await client(override).rpc("system_audit_triage_occurrence", {
    p_occurrence_id: input.occurrenceId,
    p_override: input.override,
    p_actor: input.actor,
    p_reason: input.reason,
  });
  if (error) throw failure("triage", error);
}

export type AlertCandidate = {
  issueId: string;
  title: string;
  family: string;
  status: SystemAuditStatus;
  people: number;
  operations: number;
  lastOccurredAt: string;
  reason: "new" | "newly_shared" | "reopened";
};

export async function loadAlertCandidates(override?: Client): Promise<AlertCandidate[]> {
  const { data, error } = await client(override).rpc("system_audit_alert_candidates");
  if (error) throw failure("alert read", error);
  return (data ?? []) as AlertCandidate[];
}

/** What the daily message says about one issue beyond its stored title: who met it, where, in whose words. */
export type AlertDetail = {
  /** Distinct people in the order they last met it, most recent first. */
  people: Array<{ name: string; role: string | null }>;
  /** The sidebar module of the most recent occurrence. */
  module: string | null;
  /** The words the person saw (or, for a silent finding, the system's own text) — whole, never the cut title. */
  text: string | null;
};

type DetailRow = {
  issue_id: string;
  hr_key: string | null;
  employee_name: string | null;
  role_at_event: string | null;
  module_label: string | null;
  user_message: string | null;
  is_silent: boolean | null;
  technical_message: string | null;
};

/** Reads the live (non-test, not triaged away) occurrences of the issues the message lists. */
export async function loadAlertDetails(issueIds: string[], override?: Client): Promise<Map<string, AlertDetail>> {
  const details = new Map<string, AlertDetail>();
  if (issueIds.length === 0) return details;
  const supabase = client(override);
  const { data, error } = await supabase
    .from("system_audit_occurrences")
    .select("issue_id, hr_key, employee_name, role_at_event, module_label, user_message, is_silent, technical_message")
    .in("issue_id", issueIds)
    .eq("is_test", false)
    .is("triage_override", null)
    .order("occurred_at", { ascending: false })
    .limit(1000);
  if (error) throw failure("alert detail read", error);
  const rows = (data ?? []) as DetailRow[];
  const names = await currentPersonNames(rows.map((row) => row.hr_key), supabase);
  for (const row of rows) {
    let detail = details.get(row.issue_id);
    if (!detail) {
      const spoken = !row.is_silent && row.user_message?.trim() ? row.user_message.trim() : null;
      detail = { people: [], module: row.module_label?.trim() || null, text: spoken ?? (row.technical_message?.trim() || null) };
      details.set(row.issue_id, detail);
    }
    const name = names.get(row.hr_key) ?? row.employee_name?.trim();
    if (name && !detail.people.some((person) => person.name === name)) {
      detail.people.push({ name, role: row.role_at_event?.trim() || null });
    }
  }
  return details;
}

export async function markIssuesAlerted(issueIds: string[], override?: Client): Promise<number> {
  if (issueIds.length === 0) return 0;
  const { data, error } = await client(override).rpc("system_audit_mark_alerted", { p_issue_ids: issueIds });
  if (error) throw failure("alert mark", error);
  return Number(data ?? 0);
}
