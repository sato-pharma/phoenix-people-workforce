import crypto from "node:crypto";

import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { getDeployRevision } from "@/lib/observability/deploy-identity";
import type {
  ReconciliationCheckResult,
  ReconciliationDomain,
  ReconciliationFinding,
  ReconciliationReport,
} from "@/lib/reconciliation/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { createPersonDirectory } from "@/lib/system-audit/person-directory";
import { createDatabaseSink, finishDetectorRun, startDetectorRun } from "@/lib/system-audit/repository";
import { resolveSidebarLabel } from "@/lib/system-audit/sidebar-label";
import {
  SILENT_DATA_MESSAGE,
  type AuditIssueInput,
  type AuditOccurrenceInput,
  type DetectorMode,
  type DetectorResult,
  type DetectorRunStatus,
  type FindingSink,
} from "@/lib/system-audit/types";

/**
 * The nightly reconciliation report, stored — and every disagreement in it turned into ledger rows.
 *
 * Until the ledger, the harness's report lived for exactly as long as the HTTP response that carried
 * it: a breach paged once and was gone, a known-open defect was a line nobody could look back at, and
 * "did this check hold last Tuesday?" had no answer anywhere. This file is the one place the report
 * becomes durable. It runs AFTER `runReconciliationChecks()` in the cron route, never inside it —
 * the harness itself stays read-only (src/lib/reconciliation/service.ts promises that).
 *
 *   BREACHED   → issue `recon:<check-id>` (status INVESTIGATING on first sight), plus one row per
 *                person the check named in `findings`; a breach that names nobody gets ONE system
 *                row per breach EPISODE (consecutive nights with the same detail extend it).
 *   KNOWN-OPEN → the same rows, and the issue starts NOT FIXED with the check's documented open
 *                defect as its PROBABLE root cause — it is a proven defect, not a new mystery.
 *   ERRORED    → no row at all, and never a pass: the run row lists it as not measured and the run
 *                is `partial`.
 *   HOLDS      → nothing. The verifier reads the stored report to see a check holding night after
 *                night (src/lib/system-audit/verifier.ts).
 */

export const RECONCILIATION_DETECTOR = "reconciliation";

/**
 * The ledger refuses a report over 262,144 bytes (`system_audit_detector_runs_report_size`). This is
 * the UTF-8 JSON length, held well under it: `pg_column_size` of jsonb is not the text length, and a
 * refused insert would lose the whole night rather than a little detail.
 */
export const REPORT_BYTE_CAP = 240 * 1024;

/** Each check names the screen its breach is fixed on. Read through the sidebar, never hardcoded. */
const DOMAIN_ROUTES: Record<ReconciliationDomain, string> = {
  payroll: "/payroll",
  "deductions-attendance": "/admin/deductions",
  "crm-sales": "/admin/crm",
  "notifications-integrity": "/admin/notification-confidence",
  recruitment: "/hr/recruitment",
  "direct-orders": "/admin/direct-orders",
};

/** The crm-sales domain holds both CRM and Source of Sales checks; the `sos-` ones live on SoS. */
export function reconciliationCheckRoute(result: Pick<ReconciliationCheckResult, "id" | "domain">): string {
  if (result.domain === "crm-sales" && result.id.startsWith("sos-")) return "/sales/source-of-sales-tools";
  return DOMAIN_ROUTES[result.domain] ?? "/admin/system-audit";
}

type PersonInfo = { hrIdDisplay?: string | null; name?: string | null; role?: string | null };
export type PersonLookup = {
  lookup(ids: string[]): Promise<Map<string, PersonInfo>> | Map<string, PersonInfo>;
};

export type StoredRun = { startedAt: string; report: Record<string, unknown> | null };

/** The run row the report is stored on, and the one before it (which decides an episode). */
export type ReconciliationRunStore = {
  /** `startedAt` is the night's own time; the database ignores it and stamps its own now(). */
  start(input: { mode: DetectorMode; release: string | null; startedAt?: string }): Promise<string>;
  finish(runId: string, result: DetectorResult): Promise<void>;
  /** The newest stored reconciliation run that started before `beforeIso`, or null. */
  previous(beforeIso: string): Promise<StoredRun | null>;
};

type Client = ReturnType<typeof getSupabaseAdmin>;

export function createDatabaseRunStore(override?: Client): ReconciliationRunStore {
  const supabase = () => override ?? getSupabaseAdmin({ requestTimeoutMs: 20_000 });
  return {
    start: ({ mode, release }) =>
      startDetectorRun({ detector: RECONCILIATION_DETECTOR, mode, runGroup: null, release }, override),
    finish: (runId, result) => finishDetectorRun(runId, result, override),
    previous: async (beforeIso) => {
      const { data, error } = await supabase()
        .from("system_audit_detector_runs")
        .select("started_at, report")
        .eq("detector", RECONCILIATION_DETECTOR)
        .lt("started_at", beforeIso)
        .not("report", "is", null)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`The previous reconciliation run could not be read: ${error.message}`);
      if (!data) return null;
      const row = data as { started_at: string; report: Record<string, unknown> | null };
      return { startedAt: row.started_at, report: row.report };
    },
  };
}

/**
 * A run store that keeps everything in memory — the historical dry run, which must write nothing to
 * the ledger, and the tests. `previous` answers the newest run it was given that started earlier.
 */
export function createMemoryRunStore(seed: StoredRun[] = []): ReconciliationRunStore & {
  runs(): Array<{ id: string; startedAt: string; result: DetectorResult | null }>;
} {
  const runs: Array<{ id: string; startedAt: string; result: DetectorResult | null }> = seed.map((run, index) => ({
    id: `seed-${index + 1}`,
    startedAt: run.startedAt,
    result: { ...emptyResult(), report: run.report },
  }));
  return {
    async start(input) {
      const id = `memory-${runs.length + 1}`;
      runs.push({ id, startedAt: input.startedAt ?? new Date().toISOString(), result: null });
      return id;
    },
    async finish(runId, result) {
      const run = runs.find((candidate) => candidate.id === runId);
      if (run) run.result = result;
    },
    async previous(beforeIso) {
      const earlier = runs
        .filter((run) => run.result?.report && run.startedAt < beforeIso)
        .sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1));
      const newest = earlier[0];
      return newest ? { startedAt: newest.startedAt, report: newest.result?.report ?? null } : null;
    },
    runs: () => runs,
  };
}

function emptyResult(): DetectorResult {
  return { status: "ok", scanned: 0, excludedCounts: {}, inserted: 0, updated: 0, unreadableSources: [] };
}

/** One breach episode: the night it started, how many nights it has run, and what it said. */
export type BreachEpisode = { start: string; lastNight: string; nights: number; hash: string };

/** The Cairo calendar day of an instant — the unit an episode and the occurrence dates are in. */
export function cairoDay(iso: string | number | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(iso));
}

function dayBefore(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function detailHash(detail: string): string {
  return crypto.createHash("sha256").update(detail).digest("hex").slice(0, 16);
}

/**
 * Pure: carry an episode forward or start a new one.
 *
 * Same detail on the night before (or earlier the same night, for a re-run) → the same episode, one
 * night longer. A different detail, a gap of a night, or no stored episode → a new episode tonight.
 * A gap means the check either held or was not measured in between, and both end an episode: a
 * breach that comes back is a new row, never silently glued onto last week's.
 */
export function nextEpisode(previous: BreachEpisode | null | undefined, tonight: string, hash: string): BreachEpisode {
  if (previous && previous.hash === hash) {
    if (previous.lastNight === tonight) return previous;
    if (previous.lastNight === dayBefore(tonight)) {
      return { start: previous.start, lastNight: tonight, nights: previous.nights + 1, hash };
    }
  }
  return { start: tonight, lastNight: tonight, nights: 1, hash };
}

function storedEpisodes(report: Record<string, unknown> | null | undefined): Record<string, BreachEpisode> {
  const ledger = report?.ledger;
  if (!ledger || typeof ledger !== "object") return {};
  const episodes = (ledger as { episodes?: unknown }).episodes;
  if (!episodes || typeof episodes !== "object") return {};
  const out: Record<string, BreachEpisode> = {};
  for (const [id, value] of Object.entries(episodes as Record<string, unknown>)) {
    const episode = value as Partial<BreachEpisode>;
    if (
      typeof episode?.start === "string" &&
      typeof episode.lastNight === "string" &&
      typeof episode.hash === "string" &&
      Number.isFinite(Number(episode.nights))
    ) {
      out[id] = { start: episode.start, lastNight: episode.lastNight, nights: Number(episode.nights), hash: episode.hash };
    }
  }
  return out;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Pure: fit the stored report under the row cap, dropping the least useful thing first and SAYING
 * what was dropped on the report itself. Per-finding detail goes first (every finding is still in the
 * ledger with its detail), then the finding lists (their counts stay), and only as a last resort the
 * per-check text. A report is never refused for size: losing the night is the one unacceptable result.
 */
export function capStoredReport(report: Record<string, unknown>, cap = REPORT_BYTE_CAP): Record<string, unknown> {
  if (byteLength(report) <= cap) return report;
  const results = Array.isArray(report.results) ? (report.results as Array<Record<string, unknown>>) : [];

  const withoutDetail = {
    ...report,
    results: results.map((result) =>
      Array.isArray(result.findings)
        ? {
            ...result,
            findings: (result.findings as Array<Record<string, unknown>>).map((finding) =>
              Object.fromEntries(Object.entries(finding).filter(([key]) => key !== "detail")),
            ),
          }
        : result,
    ),
    capped: "Per-finding detail was dropped to fit the 256 KB report row. Every finding is still in the ledger with its detail.",
  };
  if (byteLength(withoutDetail) <= cap) return withoutDetail;

  const withoutFindings = {
    ...report,
    results: results.map((result) => {
      if (!Array.isArray(result.findings)) return result;
      const { findings, ...rest } = result;
      return { ...rest, findingsCount: (findings as unknown[]).length };
    }),
    capped:
      "The per-check finding lists were dropped to fit the 256 KB report row; each check keeps its finding count. Every finding is still in the ledger.",
  };
  if (byteLength(withoutFindings) <= cap) return withoutFindings;

  return {
    generatedAt: report.generatedAt,
    durationMs: report.durationMs,
    counts: report.counts,
    alerting: report.alerting,
    ledger: report.ledger,
    results: results.map((result) => ({
      id: result.id,
      title: result.title,
      domain: result.domain,
      severity: result.severity,
      expectation: result.expectation,
      status: result.status,
      holds: result.holds,
      detail: "The full text of this check did not fit the 256 KB report row. Its ledger rows carry it.",
      error: result.error ?? null,
      openDefect: result.openDefect,
    })),
    capped:
      "Even without findings the report was over the 256 KB row, so each check's text was replaced by a pointer to its ledger rows.",
  };
}

export type RecordReconciliationOptions = {
  sink?: FindingSink;
  runStore?: ReconciliationRunStore;
  people?: PersonLookup;
  /** When the run happened. Defaults to now; injected so a test can pin the night. */
  now?: Date;
  release?: string | null;
  mode?: DetectorMode;
  /** Sidebar label lookup; injected so the classifier can be tested without the navigation. */
  label?: (route: string) => { label: string; shell: AuditOccurrenceInput["shell"] };
};

export type RecordReconciliationResult = {
  runId: string;
  status: DetectorRunStatus;
  issues: number;
  inserted: number;
  updated: number;
  /** Checks that errored — recorded as NOT MEASURED, never as a pass. */
  notMeasured: string[];
};

function defaultLabel(route: string): { label: string; shell: AuditOccurrenceInput["shell"] } {
  const resolved = resolveSidebarLabel({ route });
  return { label: resolved.label, shell: resolved.shell ?? null };
}

function findingDedupeKey(checkId: string, hrKey: string | null, finding: ReconciliationFinding): string {
  const date = finding.affectedDate || "-";
  const table = finding.relatedTable || "-";
  // A finding with no person and no record would otherwise collide with every other such finding of
  // the same check, so its own words keep it apart.
  const id = finding.relatedId || (hrKey ? "-" : detailHash(finding.detail).slice(0, 12));
  return `recon:${checkId}:${hrKey ?? "system"}:${date}:${table}:${id}`;
}

/**
 * Pure: the issues and occurrences one report produces. Exported for the test; the IO is
 * recordReconciliationRun below.
 */
export function buildReconciliationFindings(input: {
  report: ReconciliationReport;
  runAt: string;
  release: string | null;
  episodes: Record<string, BreachEpisode>;
  people: Map<string, PersonInfo>;
  label: (route: string) => { label: string; shell: AuditOccurrenceInput["shell"] };
}): { issues: AuditIssueInput[]; occurrences: AuditOccurrenceInput[] } {
  const issues: AuditIssueInput[] = [];
  const occurrences: AuditOccurrenceInput[] = [];

  for (const result of input.report.results) {
    if (result.status !== "breached" && result.status !== "known-open") continue;
    const signatureKey = `recon:${result.id}`;
    const errorCode = `RECON-${result.id.toUpperCase()}`;
    const knownOpen = result.status === "known-open";

    issues.push({
      signatureKey,
      family: "reconciliation",
      errorCode,
      title: result.title,
      firstSeenAt: input.runAt,
      lastSeenAt: input.runAt,
      ...(knownOpen
        ? {
            // A documented, still-unfixed defect is NOT FIXED from the first night, with its own
            // write-up as the probable cause. Calling it "investigating" would hide that we know.
            status: "not_fixed" as const,
            rootCauseLevel: "probable" as const,
            rootCause: result.openDefect ?? "Documented as an open defect on the reconciliation check.",
            rootCauseEvidence: { checkId: result.id, expectation: "known-open" },
          }
        : {}),
    });

    const route = reconciliationCheckRoute(result);
    const evidenceBase = { checkId: result.id, severity: result.severity, status: result.status };
    const findings = result.findings ?? [];

    if (findings.length > 0) {
      // Two findings can name the same person, day and record (a check that lists one row per
      // mismatching field, say). The ledger refuses a batch that repeats a key, so the repeat folds
      // into the first row as an extra attempt instead of failing the whole night's write.
      const seen = new Map<string, AuditOccurrenceInput>();
      for (const finding of findings) {
        const hrKey = canonicalHrIdKey(finding.hrId);
        const dedupeKey = findingDedupeKey(result.id, hrKey, finding);
        const repeat = seen.get(dedupeKey);
        if (repeat) {
          repeat.attemptCount = (repeat.attemptCount ?? 1) + 1;
          continue;
        }
        const person = hrKey ? input.people.get(hrKey) : undefined;
        const findingRoute = finding.moduleHref || route;
        const { label, shell } = input.label(findingRoute);
        const row: AuditOccurrenceInput = {
          dedupeKey,
          signatureKey,
          hrKey,
          hrIdDisplay: hrKey ? (person?.hrIdDisplay ?? canonicalHrIdForDisplay(finding.hrId)) : null,
          employeeName: person?.name ?? null,
          roleAtEvent: person?.role ?? null,
          moduleLabel: label,
          moduleLabelSource: "detector",
          shell,
          route: findingRoute,
          occurredAt: input.runAt,
          occurredAtKind: "detected",
          affectedDate: finding.affectedDate ?? null,
          userMessage: SILENT_DATA_MESSAGE,
          isSilent: true,
          technicalMessage: finding.detail,
          errorCode,
          relatedTable: finding.relatedTable ?? null,
          relatedId: finding.relatedId ?? null,
          release: input.release,
          evidence: evidenceBase,
        };
        seen.set(dedupeKey, row);
        occurrences.push(row);
      }
      continue;
    }

    // No person named: one system row per breach EPISODE. Consecutive nights with the same detail
    // land on the same row (its last-seen time and night count move); a changed detail or a gap
    // starts a new row, so a breach that was fixed and came back is never mistaken for one long one.
    const episode = input.episodes[result.id];
    if (!episode) continue;
    const { label, shell } = input.label(route);
    const sides =
      result.left && result.right ? `Screen: ${result.left.value} · Second source: ${result.right.value} · ` : "";
    occurrences.push({
      dedupeKey: `recon:${result.id}:${episode.start}`,
      signatureKey,
      hrKey: null,
      moduleLabel: label,
      moduleLabelSource: "detector",
      shell,
      route,
      occurredAt: input.runAt,
      occurredAtKind: "detected",
      userMessage: SILENT_DATA_MESSAGE,
      isSilent: true,
      technicalMessage: `${sides}${result.detail}`,
      errorCode,
      attemptCount: episode.nights,
      release: input.release,
      evidence: { ...evidenceBase, episodeStart: episode.start, nights: episode.nights, detailHash: episode.hash },
    });
  }

  return { issues, occurrences };
}

/**
 * Store one night's report and write its findings. THROWS on a failed write (after marking the run
 * row errored, so it is never left "running"); the cron route catches it and logs, because the
 * report is the deliverable and a ledger failure must not turn the run into a 500.
 */
export async function recordReconciliationRun(
  report: ReconciliationReport,
  options: RecordReconciliationOptions = {},
): Promise<RecordReconciliationResult> {
  const sink = options.sink ?? createDatabaseSink();
  const runStore = options.runStore ?? createDatabaseRunStore();
  const now = options.now ?? new Date();
  const runAt = now.toISOString();
  const tonight = cairoDay(now);
  const release = options.release === undefined ? getDeployRevision() : options.release;
  const label = options.label ?? defaultLabel;

  // The night before decides whether a breach is a new episode. Read BEFORE this night's row exists.
  let previous: StoredRun | null = null;
  let previousProblem: string | null = null;
  try {
    previous = await runStore.previous(runAt);
  } catch (error) {
    previousProblem = error instanceof Error ? error.message : String(error);
  }
  const before = storedEpisodes(previous?.report);

  const episodes: Record<string, BreachEpisode> = {};
  for (const result of report.results) {
    if (result.status !== "breached" && result.status !== "known-open") continue;
    episodes[result.id] = nextEpisode(before[result.id], tonight, detailHash(result.detail));
  }
  const notMeasured = report.results.filter((result) => result.status === "errored").map((result) => result.id);

  const hrIds = new Set<string>();
  for (const result of report.results) {
    if (result.status !== "breached" && result.status !== "known-open") continue;
    for (const finding of result.findings ?? []) {
      const key = canonicalHrIdKey(finding.hrId);
      if (key) hrIds.add(key);
    }
  }
  const people = hrIds.size > 0
    ? await (options.people ?? createPersonDirectory(getSupabaseAdmin())).lookup([...hrIds])
    : new Map<string, PersonInfo>();

  const { issues, occurrences } = buildReconciliationFindings({ report, runAt, release, episodes, people, label });

  const stored = capStoredReport({
    ...(report as unknown as Record<string, unknown>),
    ledger: {
      recordedAt: runAt,
      night: tonight,
      episodes,
      // NOT MEASURED, by id: an errored check is never a pass, and the page shows it as such.
      notMeasured,
      // Every check's verdict, by id, in a few hundred bytes. The verifier reads only this to count
      // the nights a fixed check has held, never the whole 240 KB report.
      checks: Object.fromEntries(report.results.map((result) => [result.id, result.status])),
      ...(previousProblem
        ? { previousRunUnreadable: `${previousProblem} — every breach was treated as a new episode tonight.` }
        : {}),
    },
  });

  const runId = await runStore.start({ mode: options.mode ?? "cron", release, startedAt: runAt });
  const status: DetectorRunStatus = notMeasured.length > 0 ? "partial" : "ok";
  try {
    const written =
      issues.length > 0 || occurrences.length > 0
        ? await sink.write(RECONCILIATION_DETECTOR, runId, { issues, occurrences, merge: "max", cursor: null })
        : { issues: 0, inserted: 0, updated: 0 };
    await runStore.finish(runId, {
      status,
      scanned: report.results.length,
      excludedCounts: {},
      inserted: written.inserted,
      updated: written.updated,
      unreadableSources: notMeasured.map((id) => `reconciliation:${id}`),
      report: stored,
      error: notMeasured.length > 0 ? `Not measured: ${notMeasured.join(", ")}` : null,
    });
    return { runId, status, issues: written.issues, inserted: written.inserted, updated: written.updated, notMeasured };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await runStore
      .finish(runId, {
        status: "errored",
        scanned: report.results.length,
        excludedCounts: {},
        inserted: 0,
        updated: 0,
        unreadableSources: notMeasured.map((id) => `reconciliation:${id}`),
        report: stored,
        error: `The findings could not be written: ${message}`,
      })
      .catch(() => undefined);
    throw error;
  }
}
