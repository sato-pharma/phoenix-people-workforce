import crypto from "node:crypto";

import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { readJobHeartbeats } from "@/lib/observability/job-heartbeat";
import {
  assessJobHeartbeats,
  type JobHeartbeatProblem,
  type JobHeartbeatRow,
} from "@/lib/observability/job-heartbeat-assess";
import { JOB_SCHEDULES } from "@/lib/observability/job-schedule";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { scanBounds } from "@/lib/system-audit/detectors/sync-runs";
import { createPersonDirectory, type PersonDirectory } from "@/lib/system-audit/person-directory";
import { resolveSidebarLabel } from "@/lib/system-audit/sidebar-label";
import { messageTemplate } from "@/lib/system-audit/signature";
import {
  SILENT_DATA_MESSAGE,
  emptyDetectorResult,
  type AuditDetector,
  type AuditIssueInput,
  type AuditOccurrenceInput,
  type DetectorContext,
  type DetectorResult,
} from "@/lib/system-audit/types";

/**
 * BACKGROUND JOB FAILURES — the two places a job's failure is recorded and nobody reads afterwards.
 *
 *   1. `job_heartbeats`, the in-house dead-man's switch. Every declared scheduled job reports its
 *      last outcome there, and `assessJobHeartbeats` judges it: STRANDED (a fire plus its grace
 *      passed with no success), FAILING (it ran and said it failed), MISDECLARED (its declaration
 *      cannot be judged). The quarter-hourly sweep pages on these; nothing kept them.
 *   2. `background_jobs`, the durable export/import queue. A FAILED row is somebody's export that
 *      never arrived, and `requested_by` names who asked for it — the one family here with a person.
 *
 * READ-ONLY. The heartbeat side reads the register and judges it with the same pure function the
 * sweep uses, never `sweepJobHeartbeats`: that one bootstraps rows and its caller pages people, and
 * an audit that wrote to the register it is auditing would be measuring itself.
 *
 * WHAT IT CANNOT SEE: the register keeps only each job's LAST outcome. A job that failed at 02:00
 * and succeeded at 03:00 left nothing behind for this to find. The report says so on every run.
 */

export const JOB_FAILURES_DETECTOR = "job_failures";
const HEARTBEAT_COVERAGE_NOTE =
  "job_heartbeats keeps only each job's last outcome, so a failure followed by a success before this run left no trace and is not counted.";

/** Words a person reads for each piece of a job slug. Anything not listed is lower-cased as is. */
const SLUG_WORDS: Record<string, string> = {
  crm: "CRM",
  cv: "CV",
  db: "database",
  fx: "FX",
  ireports360: "iReports360",
  sos: "Source of Sales",
};

/** `phoenix-crm-daily-digest` → "CRM daily digest". The slug itself stays in the evidence. */
export function jobDisplayName(slug: string): string {
  const parts = slug.replace(/^phoenix-/, "").split("-").filter(Boolean);
  if (parts.length === 0) return "Unnamed job";
  const words = parts.map((word) => SLUG_WORDS[word] ?? word.toLowerCase());
  // A listed word keeps its own spelling ("iReports360"); only a plain first word is capitalised.
  if (!SLUG_WORDS[parts[0]]) words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.join(" ");
}

/** The page a queued job's requester works from, when there is one. */
const BACKGROUND_JOB_ROUTES: Record<string, string> = {
  data_backup_export: "/admin/data-backup",
};

const BACKGROUND_JOB_NAMES: Record<string, string> = {
  data_backup_export: "Data backup export",
};

export type BackgroundJobRow = {
  id: string;
  job_type: string;
  status: string;
  requested_by: string | null;
  error: string | null;
  attempts: number | null;
  created_at: string;
  finished_at: string | null;
  updated_at: string | null;
};

function shortHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

type PersonInfo = { hrIdDisplay?: string | null; name?: string | null; role?: string | null };

/**
 * Pure: heartbeat problems and failed queue rows → ledger rows. Exported for the test.
 */
export function buildJobFailureFindings(input: {
  stranded: readonly JobHeartbeatProblem[];
  failing: readonly JobHeartbeatProblem[];
  misdeclared: readonly JobHeartbeatProblem[];
  heartbeats: readonly JobHeartbeatRow[];
  backgroundJobs: readonly BackgroundJobRow[];
  people: Map<string, PersonInfo>;
  nowIso: string;
  label: (route: string | null, jobName: string) => { label: string; shell: AuditOccurrenceInput["shell"]; route: string | null };
}): { issues: AuditIssueInput[]; occurrences: AuditOccurrenceInput[] } {
  const issues = new Map<string, AuditIssueInput>();
  const occurrences: AuditOccurrenceInput[] = [];
  const bySlug = new Map(input.heartbeats.map((row) => [row.slug, row] as const));

  function addIssue(issue: AuditIssueInput, at: string) {
    const existing = issues.get(issue.signatureKey);
    if (!existing) {
      issues.set(issue.signatureKey, { ...issue, firstSeenAt: at, lastSeenAt: at });
      return;
    }
    if (Date.parse(at) < Date.parse(existing.firstSeenAt ?? at)) existing.firstSeenAt = at;
    if (Date.parse(at) > Date.parse(existing.lastSeenAt ?? at)) existing.lastSeenAt = at;
  }

  const heartbeatRow = (problem: JobHeartbeatProblem, kind: "stranded" | "failing" | "misdeclared") => {
    const name = jobDisplayName(problem.slug);
    const where = input.label(null, name);
    const row = bySlug.get(problem.slug);
    let occurredAt: string;
    let dedupeKey: string;
    let title: string;
    let occurredAtKind: AuditOccurrenceInput["occurredAtKind"];
    if (kind === "stranded") {
      occurredAt = problem.overdueSince ?? input.nowIso;
      // One row per missed fire: a job that stays stranded all night is ONE row, a second strand
      // after it recovered is another.
      dedupeKey = `job:${problem.slug}:stranded:${problem.overdueSince ?? "unknown"}`;
      title = `Scheduled job stopped reporting — ${name}`;
      occurredAtKind = "failure";
    } else if (kind === "failing") {
      occurredAt = row?.lastFailAt ?? input.nowIso;
      dedupeKey = `job:${problem.slug}:fail:${row?.lastFailAt ?? "unknown"}`;
      title = `Scheduled job reported a failure — ${name}`;
      occurredAtKind = "failure";
    } else {
      occurredAt = input.nowIso;
      // A declaration that cannot be judged is a STATE, re-found every night until it is fixed.
      dedupeKey = `job:${problem.slug}:misdeclared`;
      title = `Scheduled job cannot be judged — ${name}`;
      occurredAtKind = "detected";
    }
    const signatureKey = `job:${problem.slug}:${kind}`;
    addIssue(
      {
        signatureKey,
        family: "job_failure",
        errorCode: `JOB-${kind.toUpperCase()}`,
        title,
        ...(kind === "misdeclared"
          ? {
              rootCauseLevel: "confirmed" as const,
              rootCause: "The job's declaration in src/lib/observability/job-schedule.ts cannot be evaluated.",
              rootCauseEvidence: { slug: problem.slug, detail: problem.detail },
            }
          : {}),
      },
      occurredAt,
    );
    occurrences.push({
      dedupeKey,
      signatureKey,
      hrKey: null,
      moduleLabel: where.label,
      moduleLabelSource: "detector",
      shell: where.shell,
      route: where.route,
      occurredAt,
      occurredAtKind,
      userMessage: SILENT_DATA_MESSAGE,
      isSilent: true,
      technicalMessage: problem.detail,
      errorCode: `JOB-${kind.toUpperCase()}`,
      relatedTable: "job_heartbeats",
      relatedId: problem.slug,
      evidence: {
        slug: problem.slug,
        lastSuccessAt: problem.lastSuccessAt,
        lastFailAt: row?.lastFailAt ?? null,
        overdueSince: problem.overdueSince,
      },
    });
  };

  for (const problem of input.stranded) heartbeatRow(problem, "stranded");
  for (const problem of input.failing) heartbeatRow(problem, "failing");
  for (const problem of input.misdeclared) heartbeatRow(problem, "misdeclared");

  for (const job of input.backgroundJobs) {
    if (job.status !== "failed") continue;
    const template = messageTemplate(job.error);
    const signatureKey = `bgjob:${job.job_type}:${shortHash(template)}`;
    const name = BACKGROUND_JOB_NAMES[job.job_type] ?? jobDisplayName(job.job_type.replace(/_/g, "-"));
    const occurredAt = job.finished_at ?? job.updated_at ?? job.created_at;
    const route = BACKGROUND_JOB_ROUTES[job.job_type] ?? null;
    const where = input.label(route, name);
    // `requested_by` is a login id or an HR id; "system" and blanks are nobody.
    const requester = String(job.requested_by ?? "").trim();
    const hrKey = requester && requester.toLowerCase() !== "system" ? canonicalHrIdKey(requester) : null;
    const person = hrKey ? input.people.get(hrKey) : undefined;
    // The directory answers under the HR id the login resolved to as well, so prefer its key.
    const personKey = person?.hrIdDisplay ? canonicalHrIdKey(person.hrIdDisplay) : hrKey;
    addIssue(
      {
        signatureKey,
        family: "job_failure",
        errorCode: `BGJOB-${shortHash(signatureKey).slice(0, 6).toUpperCase()}`,
        title: `${name} failed — ${template === "empty-message" ? "no error recorded" : template.slice(0, 120)}`,
      },
      occurredAt,
    );
    occurrences.push({
      dedupeKey: `bgjob:${job.id}`,
      signatureKey,
      hrKey: personKey,
      hrIdDisplay: personKey ? (person?.hrIdDisplay ?? canonicalHrIdForDisplay(requester)) : null,
      employeeName: person?.name ?? null,
      roleAtEvent: person?.role ?? null,
      moduleLabel: where.label,
      moduleLabelSource: "detector",
      shell: where.shell,
      route: where.route,
      occurredAt,
      occurredAtKind: "failure",
      // The requester watched the job on its page and saw it fail; the exact words were not kept.
      userMessage: null,
      isSilent: false,
      technicalMessage: job.error?.trim() || "The job failed with no error recorded.",
      errorCode: `BGJOB-${shortHash(signatureKey).slice(0, 6).toUpperCase()}`,
      relatedTable: "background_jobs",
      relatedId: job.id,
      attemptCount: Math.max(1, Number(job.attempts ?? 1)),
      firstEventAt: job.created_at,
      lastEventAt: occurredAt,
      evidence: { jobType: job.job_type, attempts: job.attempts ?? null },
    });
  }

  return { issues: [...issues.values()], occurrences };
}

export type JobFailuresDetectorDeps = {
  readHeartbeats?: () => Promise<JobHeartbeatRow[]>;
  readBackgroundJobs?: (bounds: { fromIso: string; toIso: string | null }) => Promise<BackgroundJobRow[]>;
  people?: PersonDirectory;
};

function defaultLabel(route: string | null, jobName: string) {
  if (route) {
    const resolved = resolveSidebarLabel({ route });
    return { label: resolved.label, shell: resolved.shell ?? null, route };
  }
  // The convention sidebar-label.ts uses for a structured-log row: a job is not a sidebar module.
  return { label: `Background job — ${jobName}`, shell: null, route: null };
}

export function createJobFailuresDetector(deps: JobFailuresDetectorDeps = {}): AuditDetector {
  const readHeartbeats = deps.readHeartbeats ?? readJobHeartbeats;
  const readBackgroundJobs =
    deps.readBackgroundJobs ??
    (async ({ fromIso, toIso }) => {
      const supabase = getSupabaseAdmin({ requestTimeoutMs: 20_000 });
      return fetchAllRows<BackgroundJobRow>(() => {
        let query = supabase
          .from("background_jobs")
          .select("id,job_type,status,requested_by,error,attempts,created_at,finished_at,updated_at")
          .eq("status", "failed")
          .gte("created_at", fromIso);
        if (toIso) query = query.lt("created_at", toIso);
        return query.order("created_at", { ascending: true });
      }, "id");
    });

  return {
    id: JOB_FAILURES_DETECTOR,
    family: "job_failure",
    version: 1,
    async run(ctx: DetectorContext): Promise<DetectorResult> {
      const result = emptyDetectorResult();
      const cursor = ctx.mode === "cron" ? await ctx.sink.readCursor(JOB_FAILURES_DETECTOR) : null;
      const bounds = scanBounds(ctx, cursor);
      const now = new Date(ctx.now());
      const nowIso = now.toISOString();

      // The register is a snapshot of NOW, so a historical window cannot replay it: a historical run
      // reads it once, as of tonight, exactly like a cron run.
      let heartbeats: JobHeartbeatRow[] = [];
      let verdict: ReturnType<typeof assessJobHeartbeats> | null = null;
      try {
        heartbeats = await readHeartbeats();
        verdict = assessJobHeartbeats({ declarations: JOB_SCHEDULES, now, rows: heartbeats });
      } catch (error) {
        result.unreadableSources.push("job_heartbeats");
        result.error = `The job heartbeat register could not be read: ${error instanceof Error ? error.message : String(error)}`;
      }

      let backgroundJobs: BackgroundJobRow[] = [];
      try {
        backgroundJobs = await readBackgroundJobs(bounds);
      } catch (error) {
        result.unreadableSources.push("background_jobs");
        const message = `The background job queue could not be read: ${error instanceof Error ? error.message : String(error)}`;
        result.error = result.error ? `${result.error} ${message}` : message;
      }
      // Both sources unreadable is not a partial answer — it is no answer at all.
      if (result.unreadableSources.length === 2) {
        result.status = "errored";
        return result;
      }
      result.scanned = heartbeats.length + backgroundJobs.length;

      const requesters = backgroundJobs
        .map((job) => String(job.requested_by ?? "").trim())
        .filter((value) => value && value.toLowerCase() !== "system");
      const people =
        requesters.length > 0
          ? await (deps.people ?? createPersonDirectory(getSupabaseAdmin())).lookup([...new Set(requesters)])
          : new Map<string, PersonInfo>();

      const { issues, occurrences } = buildJobFailureFindings({
        stranded: verdict?.stranded ?? [],
        failing: verdict?.failing ?? [],
        misdeclared: verdict?.misdeclared ?? [],
        heartbeats,
        backgroundJobs,
        people,
        nowIso,
        label: defaultLabel,
      });

      const watermark = { scannedUntil: nowIso };
      result.watermarkFrom = cursor;
      result.watermarkTo = watermark;
      if (issues.length > 0 || ctx.mode === "cron") {
        const written = await ctx.sink.write(JOB_FAILURES_DETECTOR, ctx.runId, {
          issues,
          occurrences,
          merge: "max",
          cursor: ctx.mode === "cron" ? watermark : null,
        });
        result.inserted = written.inserted;
        result.updated = written.updated;
      }
      if (result.unreadableSources.length > 0) result.status = "partial";
      result.report = {
        window: bounds,
        stranded: verdict?.stranded.length ?? null,
        failing: verdict?.failing.length ?? null,
        misdeclared: verdict?.misdeclared.length ?? null,
        failedBackgroundJobs: backgroundJobs.length,
        coverage: HEARTBEAT_COVERAGE_NOTE,
      };
      return result;
    },
  };
}

export const jobFailuresDetector = createJobFailuresDetector();
