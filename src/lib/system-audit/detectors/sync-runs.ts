import crypto from "node:crypto";

import { cairoMidnightUtcIso } from "@/lib/attendance/timezone";
import { readCrmCutoverSetting } from "@/lib/crm/cutover";
import { listVisitsSyncRunsInWindow } from "@/lib/crm/admin";
import { CRM_SYNC_RUNS_TABLE } from "@/lib/crm/tables";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { getSupabaseAdmin } from "@/lib/supabase/server";
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
 * iReports360 SYNC RUNS — every pull of the vendor's visits that failed, and every one that never
 * finished.
 *
 * `ireports360_visits_sync_runs` logs one row per attempt with status running / success / failed.
 * A FAILED row is a window of field visits that did not arrive when it should have. A row still
 * RUNNING two hours after it started is worse: the process was killed or hung mid-pull and never
 * wrote an end, which is exactly how the 5 July 2026 reconcile sat "running" for seventeen hours
 * (src/lib/crm/sync.ts). No pull is meant to take more than the route's 300 s ceiling, so two hours
 * is not a slow run — it is a dead one.
 *
 * Both are SYSTEM rows: a sync failure belongs to no employee, it belongs to the pipeline. One issue
 * per normalised error message (so "the vendor login failed" and "the upsert timed out" are two
 * different problems with two different fixes), plus one issue for runs that never finished.
 *
 * A failed window that a later successful run covered completely is still a finding — the failure
 * happened — but it carries `coveredByRunId` as evidence, so whoever triages it can see the visits
 * did arrive in the end.
 *
 * Since the CRM cutover retired the vendor (`vendor_sync_retired_at`), no new run is expected at all.
 * The detector keeps reading the table anyway: every failure from before the cutover is still
 * history, and a run that appears AFTER it means something is still pulling from a retired vendor.
 */

export const SYNC_RUNS_DETECTOR = "sync_runs";
const ROUTE = "/admin/crm";
/** A run older than this that still says "running" was killed or hung. */
export const STUCK_AFTER_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** With no cursor, a cron run looks back this far. */
const FIRST_LOOKBACK_MS = 30 * DAY_MS;
/** Every cron run re-reads this far behind its cursor, so a run that flipped late is not missed. */
const OVERLAP_MS = 7 * DAY_MS;
/** How long after a failure a successful run may come and still count as covering its window. */
const COVERAGE_WINDOW_MS = 7 * DAY_MS;

export type SyncRunRow = {
  id: string;
  trigger: string | null;
  date_from: string;
  date_to: string;
  status: string;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
};

const COLUMNS = "id,trigger,date_from,date_to,status,error_message,started_at,completed_at";

/**
 * The instant range one run reads. Cron: from the cursor minus a week (or thirty days with no
 * cursor) to now. Historical: the window's Cairo days, inclusive. Shared with the job-failures
 * detector, which reads its queue table the same way.
 */
export function scanBounds(
  ctx: Pick<DetectorContext, "mode" | "window" | "now">,
  cursor: Record<string, unknown> | null,
): { fromIso: string; toIso: string | null } {
  if (ctx.window) {
    return {
      fromIso: cairoMidnightUtcIso(ctx.window.from, 0, "Africa/Cairo"),
      toIso: cairoMidnightUtcIso(ctx.window.to, 1, "Africa/Cairo"),
    };
  }
  const nowMs = ctx.now();
  const scannedUntil = typeof cursor?.scannedUntil === "string" ? Date.parse(cursor.scannedUntil) : Number.NaN;
  const fromMs = Number.isFinite(scannedUntil) ? scannedUntil - OVERLAP_MS : nowMs - FIRST_LOOKBACK_MS;
  return { fromIso: new Date(fromMs).toISOString(), toIso: null };
}

/** Sixteen hex characters of a sha256 — enough to keep two different messages apart. */
function shortHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function dateWindow(row: Pick<SyncRunRow, "date_from" | "date_to">): string {
  return row.date_from === row.date_to ? row.date_from : `${row.date_from} to ${row.date_to}`;
}

/** The successful run that later fetched the whole of a failed run's window, if there was one. */
export function findCoveringRun(failed: SyncRunRow, runs: readonly SyncRunRow[]): SyncRunRow | null {
  const failedAt = Date.parse(failed.started_at);
  for (const run of runs) {
    if (run.status !== "success") continue;
    const at = Date.parse(run.started_at);
    if (!(at > failedAt) || at - failedAt > COVERAGE_WINDOW_MS) continue;
    if (run.date_from <= failed.date_from && run.date_to >= failed.date_to) return run;
  }
  return null;
}

/**
 * Pure: the issues and occurrences one read of the table produces. Exported for the test.
 */
export function buildSyncRunFindings(input: {
  /** The runs to judge. */
  runs: readonly SyncRunRow[];
  /** Every successful run read, which may reach past the judged window — coverage looks ahead. */
  successes?: readonly SyncRunRow[];
  nowMs: number;
  vendorSyncRetiredAt: string | null;
  label: { label: string; shell: AuditOccurrenceInput["shell"] };
}): { issues: AuditIssueInput[]; occurrences: AuditOccurrenceInput[]; failed: number; stuck: number } {
  const issues = new Map<string, AuditIssueInput>();
  const occurrences: AuditOccurrenceInput[] = [];
  let failed = 0;
  let stuck = 0;
  const successes = [...(input.successes ?? input.runs)]
    .filter((run) => run.status === "success")
    .sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at));

  for (const run of input.runs) {
    const startedMs = Date.parse(run.started_at);
    const isStuck = run.status === "running" && Number.isFinite(startedMs) && input.nowMs - startedMs > STUCK_AFTER_MS;
    if (run.status !== "failed" && !isStuck) continue;

    const afterRetirement =
      input.vendorSyncRetiredAt !== null && Number.isFinite(startedMs) && startedMs > Date.parse(input.vendorSyncRetiredAt);
    const evidence: Record<string, unknown> = {
      runId: run.id,
      trigger: run.trigger,
      dateFrom: run.date_from,
      dateTo: run.date_to,
      ...(afterRetirement ? { afterVendorRetirement: input.vendorSyncRetiredAt } : {}),
    };

    let signatureKey: string;
    let title: string;
    let technicalMessage: string;
    let occurredAt: string;
    if (isStuck) {
      stuck += 1;
      signatureKey = "sync:ireports360:never-finished";
      title = "iReports360 visits sync started and never finished";
      occurredAt = run.started_at;
      technicalMessage =
        `Started ${cairoDateTime(run.started_at)} Cairo for visits ${dateWindow(run)} and still reads "running" ` +
        `${Math.floor((input.nowMs - startedMs) / 3_600_000)} hours later — the pull was killed or hung and never recorded an end.`;
    } else {
      failed += 1;
      const template = messageTemplate(run.error_message);
      signatureKey = `sync:ireports360:failed:${shortHash(template)}`;
      title = `iReports360 visits sync failed — ${template === "empty-message" ? "no error recorded" : template.slice(0, 120)}`;
      occurredAt = run.completed_at ?? run.started_at;
      const covering = findCoveringRun(run, successes);
      if (covering) {
        evidence.coveredByRunId = covering.id;
        evidence.coveredAt = covering.started_at;
      }
      technicalMessage =
        `Visits ${dateWindow(run)}: ${run.error_message?.trim() || "the run failed with no error message"}` +
        (covering ? ` — a later successful run (${cairoDateTime(covering.started_at)} Cairo) fetched the whole window.` : "");
    }
    if (afterRetirement) {
      technicalMessage += " This run started after iReports360 was retired, so something is still pulling from it.";
    }

    if (!issues.has(signatureKey)) {
      issues.set(signatureKey, {
        signatureKey,
        family: "sync_run",
        errorCode: isStuck ? "SYNC-NEVER-FINISHED" : `SYNC-FAILED-${signatureKey.slice(-6).toUpperCase()}`,
        title,
        firstSeenAt: occurredAt,
        lastSeenAt: occurredAt,
      });
    } else {
      const issue = issues.get(signatureKey)!;
      if (Date.parse(occurredAt) < Date.parse(issue.firstSeenAt ?? occurredAt)) issue.firstSeenAt = occurredAt;
      if (Date.parse(occurredAt) > Date.parse(issue.lastSeenAt ?? occurredAt)) issue.lastSeenAt = occurredAt;
    }

    occurrences.push({
      // One row per sync run: a run is found again on every overlapping read, and lands on itself.
      dedupeKey: `sync:${run.id}`,
      signatureKey,
      hrKey: null,
      moduleLabel: input.label.label,
      moduleLabelSource: "detector",
      shell: input.label.shell,
      route: ROUTE,
      occurredAt,
      occurredAtKind: isStuck ? "event" : "failure",
      affectedDate: run.date_from,
      userMessage: SILENT_DATA_MESSAGE,
      isSilent: true,
      technicalMessage,
      errorCode: isStuck ? "SYNC-NEVER-FINISHED" : `SYNC-FAILED-${signatureKey.slice(-6).toUpperCase()}`,
      relatedTable: CRM_SYNC_RUNS_TABLE,
      relatedId: run.id,
      firstEventAt: run.started_at,
      lastEventAt: occurredAt,
      evidence,
    });
  }

  return { issues: [...issues.values()], occurrences, failed, stuck };
}

type Client = ReturnType<typeof getSupabaseAdmin>;

export type SyncRunsDetectorDeps = {
  readRuns?: (bounds: { fromIso: string; toIso: string | null }) => Promise<SyncRunRow[]>;
  readRetiredAt?: () => Promise<string | null>;
  client?: Client;
};

export function createSyncRunsDetector(deps: SyncRunsDetectorDeps = {}): AuditDetector {
  const readRuns =
    deps.readRuns ??
    // Coverage needs the successes too, so the read is every row in the window, narrow columns,
    // through the CRM module's own door (tests/crm-single-source.test.ts).
    (({ fromIso, toIso }) =>
      listVisitsSyncRunsInWindow<SyncRunRow>({
        columns: COLUMNS,
        fromIso,
        beforeIso: toIso ? new Date(Date.parse(toIso) + COVERAGE_WINDOW_MS).toISOString() : null,
        client: deps.client,
      }));
  const readRetiredAt = deps.readRetiredAt ?? (async () => (await readCrmCutoverSetting()).vendorSyncRetiredAt);

  return {
    id: SYNC_RUNS_DETECTOR,
    family: "sync_run",
    version: 1,
    async run(ctx: DetectorContext): Promise<DetectorResult> {
      const result = emptyDetectorResult();
      const cursor = ctx.mode === "cron" ? await ctx.sink.readCursor(SYNC_RUNS_DETECTOR) : null;
      const bounds = scanBounds(ctx, cursor);
      const nowIso = new Date(ctx.now()).toISOString();

      // The cutover date only shapes the wording; an unreadable setting is noted, never fatal.
      let vendorSyncRetiredAt: string | null = null;
      try {
        vendorSyncRetiredAt = await readRetiredAt();
      } catch (error) {
        result.unreadableSources.push("crm_cutover_setting");
        result.error = `The CRM cutover setting could not be read: ${error instanceof Error ? error.message : String(error)}`;
      }

      const rows = await readRuns(bounds);
      // A historical window reads a week past its end for coverage; only runs inside it are judged.
      const toMs = bounds.toIso ? Date.parse(bounds.toIso) : Number.POSITIVE_INFINITY;
      const inWindow = rows.filter((row) => Date.parse(row.started_at) < toMs);
      result.scanned = inWindow.length;
      const label = resolveSidebarLabel({ route: ROUTE });
      const { issues, occurrences, failed, stuck } = buildSyncRunFindings({
        runs: inWindow,
        successes: rows,
        nowMs: ctx.now(),
        vendorSyncRetiredAt,
        label: { label: label.label, shell: label.shell },
      });

      const watermark = { scannedUntil: nowIso };
      result.watermarkFrom = cursor;
      result.watermarkTo = watermark;
      if (issues.length > 0 || ctx.mode === "cron") {
        const written = await ctx.sink.write(SYNC_RUNS_DETECTOR, ctx.runId, {
          issues,
          occurrences,
          // A run is a state the table holds; reading it again must never double it.
          merge: "max",
          // Historical runs leave the watermark to the runner, which sets it once the seed is in.
          cursor: ctx.mode === "cron" ? watermark : null,
        });
        result.inserted = written.inserted;
        result.updated = written.updated;
      }
      if (result.unreadableSources.length > 0) result.status = "partial";
      result.report = {
        window: bounds,
        failedRuns: failed,
        neverFinishedRuns: stuck,
        vendorSyncRetiredAt,
        coverage:
          "Every row of ireports360_visits_sync_runs in the window. A failed run whose whole window a later successful run fetched within a week carries coveredByRunId.",
      };
      return result;
    },
  };
}

export const syncRunsDetector = createSyncRunsDetector();
