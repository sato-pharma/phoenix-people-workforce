/**
 * System Error & Data Integrity Audit — everything the row drawer shows about ONE occurrence.
 *
 * The occurrence itself, its issue (title, root cause, evidence), the issue's whole status trail,
 * its fix attempts, and — for an error a person saw — the "repro trail": that person's last five
 * page views before the error, from `activity_events`.
 *
 * Every read throws on failure except the repro trail, which reports itself UNAVAILABLE with the
 * reason (a missing trail must never read as "the person did nothing first"). Service-role reads,
 * so this runs only behind assertSystemAdministratorWorkspaceAccess.
 */

import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  SYSTEM_AUDIT_STATUS_LABELS,
  type ModuleLabelSource,
  type OccurredAtKind,
  type RootCauseLevel,
  type ShellKind,
  type SystemAuditFamily,
  type SystemAuditStatus,
} from "@/lib/system-audit/types";

type Client = ReturnType<typeof getSupabaseAdmin>;

function client(override?: Client): Client {
  return override ?? getSupabaseAdmin({ requestTimeoutMs: 15_000 });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID.test(value);
}

export type OccurrenceDetailOccurrence = {
  id: string;
  issueId: string;
  signatureKey: string;
  family: SystemAuditFamily;
  correlationId: string | null;
  isRootSymptom: boolean;
  hrKey: string | null;
  hrId: string | null;
  employeeName: string | null;
  roleAtEvent: string | null;
  moduleLabel: string;
  moduleLabelSource: ModuleLabelSource;
  shell: ShellKind | null;
  route: string | null;
  occurredAt: string;
  occurredAtKind: OccurredAtKind;
  affectedDate: string | null;
  userMessage: string | null;
  isSilent: boolean;
  technicalMessage: string | null;
  errorCode: string;
  relatedTable: string | null;
  relatedId: string | null;
  attemptCount: number;
  pageLoads: number;
  firstEventAt: string;
  lastEventAt: string;
  sourceRefs: unknown[];
  release: string | null;
  preFixBuild: boolean;
  triageOverride: "no_defect" | "unknown" | null;
  triageReason: string | null;
  evidence: Record<string, unknown>;
  isTest: boolean;
};

export type OccurrenceDetailIssue = {
  id: string;
  title: string;
  family: SystemAuditFamily;
  errorCode: string;
  status: SystemAuditStatus;
  statusLabel: string;
  rootCauseLevel: RootCauseLevel;
  rootCause: string | null;
  rootCauseEvidence: Record<string, unknown>;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type OccurrenceHistoryEntry = {
  id: string;
  at: string;
  fromLabel: string | null;
  toLabel: string;
  /** The person (by name) or the automatic process that made the change. */
  actorName: string;
  reason: string | null;
  evidence: Record<string, unknown>;
  /** "this" when the change named this occurrence, "other" for another occurrence, null for the issue. */
  occurrenceScope: "this" | "other" | null;
  otherOccurrenceRef: string | null;
};

export type OccurrenceFix = {
  id: string;
  generation: number;
  commitSha: string;
  liveAt: string;
  verifiedAt: string | null;
  invalidatedAt: string | null;
  createdByName: string;
};

export type ReproTrailEntry = { at: string; moduleLabel: string; path: string };

export type ReproTrail =
  | { status: "ok"; entries: ReproTrailEntry[]; note: string | null }
  | { status: "not_applicable"; reason: string }
  | { status: "unavailable"; reason: string };

export type OccurrenceDetail = {
  occurrence: OccurrenceDetailOccurrence;
  issue: OccurrenceDetailIssue;
  history: OccurrenceHistoryEntry[];
  fixes: OccurrenceFix[];
  reproTrail: ReproTrail;
};

type Row = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === "string" ? value : value == null ? null : String(value));
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function mapOccurrence(row: Row): OccurrenceDetailOccurrence {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    signatureKey: String(row.signature_key),
    family: row.family as SystemAuditFamily,
    correlationId: str(row.correlation_id),
    isRootSymptom: row.is_root_symptom !== false,
    hrKey: str(row.hr_key),
    hrId: str(row.hr_id_display),
    employeeName: str(row.employee_name),
    roleAtEvent: str(row.role_at_event),
    moduleLabel: String(row.module_label ?? ""),
    moduleLabelSource: (row.module_label_source as ModuleLabelSource) ?? "none",
    shell: (row.shell as ShellKind | null) ?? null,
    route: str(row.route),
    occurredAt: String(row.occurred_at),
    occurredAtKind: row.occurred_at_kind as OccurredAtKind,
    affectedDate: str(row.affected_date),
    userMessage: str(row.user_message),
    isSilent: row.is_silent === true,
    technicalMessage: str(row.technical_message),
    errorCode: String(row.error_code ?? ""),
    relatedTable: str(row.related_table),
    relatedId: str(row.related_id),
    attemptCount: Number(row.attempt_count ?? 1),
    pageLoads: Number(row.page_loads ?? 1),
    firstEventAt: String(row.first_event_at),
    lastEventAt: String(row.last_event_at),
    sourceRefs: Array.isArray(row.source_refs) ? (row.source_refs as unknown[]) : [],
    release: str(row.release),
    preFixBuild: row.pre_fix_build === true,
    triageOverride: (row.triage_override as "no_defect" | "unknown" | null) ?? null,
    triageReason: str(row.triage_reason),
    evidence: obj(row.evidence),
    isTest: row.is_test === true,
  };
}

/** A status key from the trail in words; `occurrence` is the triage function's "no override". */
export function historyStatusLabel(status: string | null): string | null {
  if (status === null) return null;
  if (status === "occurrence") return "Occurrence — no override";
  return SYSTEM_AUDIT_STATUS_LABELS[status as SystemAuditStatus] ?? status;
}

/** Automatic actors in words; everything else is an HR ID resolved to a name by the caller. */
export function automaticActorName(actor: string): string | null {
  if (actor === "system:verifier") return "Automatic verifier";
  if (actor.startsWith("seed:")) return "Historical review (reviewed seed)";
  if (actor.startsWith("system:")) return "Automatic process";
  return null;
}

async function resolveActorNames(actors: string[], supabase: Client): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const people: string[] = [];
  for (const actor of actors) {
    const automatic = automaticActorName(actor);
    if (automatic) names.set(actor, automatic);
    else people.push(actor);
  }
  if (people.length === 0) return names;
  const keys = Array.from(new Set(people.flatMap((actor) => hrIdLookupKeys(actor))));
  const { data, error } = await supabase.from("employees").select("hr_id, full_name").in("hr_id", keys);
  if (error) throw new Error(`The names of the people in the status trail could not be read: ${error.message}`);
  const byKey = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ hr_id: string | null; full_name: string | null }>) {
    const key = canonicalHrIdKey(row.hr_id);
    if (key && row.full_name?.trim()) byKey.set(key, row.full_name.trim());
  }
  for (const actor of people) {
    const key = canonicalHrIdKey(actor);
    // A person the employee master no longer holds keeps the id they acted under, labelled as such.
    names.set(actor, (key && byKey.get(key)) || `Unknown person (${actor})`);
  }
  return names;
}

const REPRO_TRAIL_LENGTH = 5;
const ACTIVITY_RETENTION_DAYS = 90;

async function loadReproTrail(occurrence: OccurrenceDetailOccurrence, supabase: Client): Promise<ReproTrail> {
  if (occurrence.family !== "app_error") {
    return { status: "not_applicable", reason: "Only an error shown to a person has a page trail before it." };
  }
  if (!occurrence.hrKey) {
    return { status: "not_applicable", reason: "No employee was signed in, so there is no personal page trail." };
  }
  try {
    // Every accepted spelling of the HR ID: activity_events holds both `B-10` and `b-10`.
    const { data, error } = await supabase
      .from("activity_events")
      .select("created_at, module_label, path")
      .in("hr_id", hrIdLookupKeys(occurrence.hrId ?? occurrence.hrKey))
      .lt("created_at", occurrence.firstEventAt)
      .order("created_at", { ascending: false })
      .limit(REPRO_TRAIL_LENGTH);
    if (error) throw new Error(error.message);
    const entries = ((data ?? []) as Array<{ created_at: string; module_label: string | null; path: string | null }>).map(
      (row) => ({ at: row.created_at, moduleLabel: row.module_label?.trim() || "Page not named", path: row.path ?? "" }),
    );
    const ageDays = (Date.now() - Date.parse(occurrence.firstEventAt)) / 86_400_000;
    const note =
      entries.length === 0
        ? ageDays > ACTIVITY_RETENTION_DAYS
          ? `Page views are kept for ${ACTIVITY_RETENTION_DAYS} days and this error is older, so its trail has been pruned.`
          : "No page view was recorded for this person before the error."
        : null;
    return { status: "ok", entries, note };
  } catch (error) {
    return {
      status: "unavailable",
      reason: `The page trail could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Null when no occurrence has this id. */
export async function loadOccurrenceDetail(id: string, override?: Client): Promise<OccurrenceDetail | null> {
  if (!isUuid(id)) return null;
  const supabase = client(override);
  const { data: occurrenceRow, error: occurrenceError } = await supabase
    .from("system_audit_occurrences")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (occurrenceError) throw new Error(`The occurrence could not be read: ${occurrenceError.message}`);
  if (!occurrenceRow) return null;
  const occurrence = mapOccurrence(occurrenceRow as Row);

  const [issueResult, historyResult, fixesResult, reproTrail] = await Promise.all([
    supabase
      .from("system_audit_issues")
      .select("id, title, family, error_code, status, root_cause_level, root_cause, root_cause_evidence, first_seen_at, last_seen_at")
      .eq("id", occurrence.issueId)
      .maybeSingle(),
    supabase
      .from("system_audit_status_history")
      .select("id, occurrence_id, from_status, to_status, actor, reason, evidence, created_at")
      .eq("issue_id", occurrence.issueId)
      .order("created_at", { ascending: true })
      .limit(500),
    supabase
      .from("system_audit_issue_fixes")
      .select("id, generation, fix_commit_sha, fix_live_at, verified_at, invalidated_at, created_by")
      .eq("issue_id", occurrence.issueId)
      .order("generation", { ascending: true }),
    loadReproTrail(occurrence, supabase),
  ]);
  if (issueResult.error) throw new Error(`The issue could not be read: ${issueResult.error.message}`);
  if (!issueResult.data) throw new Error(`The occurrence points at an issue that is missing (${occurrence.issueId}).`);
  if (historyResult.error) throw new Error(`The status trail could not be read: ${historyResult.error.message}`);
  if (fixesResult.error) throw new Error(`The fixes could not be read: ${fixesResult.error.message}`);

  const issueRow = issueResult.data as Row;
  const historyRows = (historyResult.data ?? []) as Row[];
  const fixRows = (fixesResult.data ?? []) as Row[];
  const actors = Array.from(
    new Set([...historyRows.map((row) => String(row.actor ?? "")), ...fixRows.map((row) => String(row.created_by ?? ""))].filter(Boolean)),
  );
  const actorNames = await resolveActorNames(actors, supabase);

  const status = issueRow.status as SystemAuditStatus;
  return {
    occurrence,
    issue: {
      id: String(issueRow.id),
      title: String(issueRow.title ?? ""),
      family: issueRow.family as SystemAuditFamily,
      errorCode: String(issueRow.error_code ?? ""),
      status,
      statusLabel: SYSTEM_AUDIT_STATUS_LABELS[status] ?? status,
      rootCauseLevel: (issueRow.root_cause_level as RootCauseLevel) ?? "unknown",
      rootCause: str(issueRow.root_cause),
      rootCauseEvidence: obj(issueRow.root_cause_evidence),
      firstSeenAt: str(issueRow.first_seen_at),
      lastSeenAt: str(issueRow.last_seen_at),
    },
    history: historyRows.map((row) => {
      const occurrenceId = str(row.occurrence_id);
      const actor = String(row.actor ?? "");
      return {
        id: String(row.id),
        at: String(row.created_at),
        fromLabel: historyStatusLabel(str(row.from_status)),
        toLabel: historyStatusLabel(str(row.to_status)) ?? "",
        actorName: actorNames.get(actor) ?? actor,
        reason: str(row.reason),
        evidence: obj(row.evidence),
        occurrenceScope: occurrenceId === null ? null : occurrenceId === occurrence.id ? "this" : "other",
        otherOccurrenceRef: occurrenceId && occurrenceId !== occurrence.id ? occurrenceId.slice(0, 8) : null,
      };
    }),
    fixes: fixRows.map((row) => {
      const createdBy = String(row.created_by ?? "");
      return {
        id: String(row.id),
        generation: Number(row.generation ?? 0),
        commitSha: String(row.fix_commit_sha ?? ""),
        liveAt: String(row.fix_live_at),
        verifiedAt: str(row.verified_at),
        invalidatedAt: str(row.invalidated_at),
        createdByName: actorNames.get(createdBy) ?? createdBy,
      };
    }),
    reproTrail,
  };
}

/**
 * The database function's own refusal sentence, without the repository's "System audit … failed
 * (code):" wrapper — the person sees exactly what Postgres refused and why ("commit … is not a
 * released build"). `code` is the SQLSTATE when the wrapper carried one.
 */
export function databaseRefusal(error: unknown): { message: string; code: string | null } {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const match = /^System audit [^:]*? failed(?: \(([^)]+)\))?: ([\s\S]*)$/.exec(text);
  if (!match) return { message: text, code: null };
  return { message: match[2].trim(), code: match[1] ?? null };
}

/** The HTTP status a refusal deserves: the function's own checks are the caller's mistake. */
export function refusalHttpStatus(code: string | null): number {
  if (code === "22023") return 400;
  if (code === "42501") return 403;
  if (code === "P0002") return 404;
  return 500;
}
