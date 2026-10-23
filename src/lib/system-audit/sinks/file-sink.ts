import { CSV_BOM, csvLine } from "@/lib/export/spreadsheet-safe";
import { cairoWallClock } from "@/lib/format/cairo-zone";
import { computePeriodCounts, selectPeriod } from "@/lib/system-audit/period-counts";
import {
  ROOT_CAUSE_LEVEL_LABELS,
  SILENT_DATA_MESSAGE,
  SYSTEM_AUDIT_STATUS_LABELS,
  USER_MESSAGE_NOT_CAPTURED,
  type AuditIssueInput,
  type AuditOccurrenceInput,
  type FindingBatch,
  type FindingSink,
  type FindingSinkWriteResult,
  type MergeMode,
  type RootCauseLevel,
  type SystemAuditFamily,
  type SystemAuditStatus,
} from "@/lib/system-audit/types";

/**
 * The ledger, in memory — for the historical runner and the tests, which must produce exactly the
 * rows the database would, without a database.
 *
 * `write` merges by `dedupeKey` the way `system_audit_upsert_occurrences` does, rule for rule:
 * issues are created on first sight and only widen their seen-window afterwards (a root cause
 * set once is never overwritten); an occurrence whose signature has no issue is NOT written (the
 * SQL joins on the issue); `add` sums attempts and page loads and appends source refs to 50,
 * `max` keeps the larger counters and the newer refs; the first event keeps the earliest time, the
 * last the latest; message, evidence and release take the newer value when one is given.
 *
 * Page loads on an `add` UPDATE are taken as given, including 0: collapse.ts emits 0 when every new
 * event fell in a page load the occurrence already counts. repository.ts clamps the column to 1 for
 * the insert, so the SQL adds the true delta from evidence.newPageLoads instead — the database and
 * this sink agree.
 *
 * `readCursor` answers null: a file run always starts from its own beginning.
 */

export type StoredIssue = {
  signatureKey: string;
  family: SystemAuditFamily;
  errorCode: string;
  title: string;
  status: SystemAuditStatus;
  rootCauseLevel: RootCauseLevel;
  rootCause: string | null;
  rootCauseEvidence: Record<string, unknown>;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type StoredOccurrence = Omit<
  AuditOccurrenceInput,
  "attemptCount" | "pageLoads" | "firstEventAt" | "lastEventAt" | "sourceRefs" | "isTest" | "evidence"
> & {
  family: SystemAuditFamily;
  attemptCount: number;
  pageLoads: number;
  firstEventAt: string;
  lastEventAt: string;
  sourceRefs: string[];
  isTest: boolean;
  evidence: Record<string, unknown>;
};

export type FileSinkEntry = { occurrence: StoredOccurrence; issue: StoredIssue };

export type MasterRowStatus = { status: SystemAuditStatus; rootCauseLevel: RootCauseLevel; rootCause: string | null };

/** The eleven columns of the owner's brief, in his order, then the technical columns. */
export const MASTER_CSV_HEADERS = [
  "HR ID",
  "Employee Name",
  "Module Name",
  "Error Date",
  "Error Time",
  "Error Encountered",
  "Error Code / Incident Ref",
  "Why",
  "Fixed status",
  "Occurrences for this employee",
  "Unique vs Shared",
  "Signature",
  "Family",
  "Route",
  "Technical message",
  "Attempts",
  "Page loads",
  "First event (Cairo)",
  "Last event (Cairo)",
  "Module label source",
  "Dedupe key",
] as const;

export type FileSink = FindingSink & {
  readonly kind: "file";
  entries(): FileSinkEntry[];
  issues(): StoredIssue[];
  /** The cursor the last write carried — kept for inspection, never served back by readCursor. */
  lastCursor(detector: string): Record<string, unknown> | null;
  toMasterCsvLines(statusFor?: (entry: FileSinkEntry) => MasterRowStatus, options?: { includeTest?: boolean }): string[];
  toMasterCsv(statusFor?: (entry: FileSinkEntry) => MasterRowStatus, options?: { includeTest?: boolean }): string;
};

function laterOf(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function earlierOf(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function isEmptyObject(value: Record<string, unknown> | undefined | null): boolean {
  return !value || Object.keys(value).length === 0;
}

/** `2026-10-23` and `14:05:09` in Cairo. */
export function cairoDateAndTime(iso: string): { date: string; time: string } {
  const wall = cairoWallClock(new Date(iso)).toISOString();
  return { date: wall.slice(0, 10), time: wall.slice(11, 19) };
}

function cairoStamp(iso: string): string {
  const { date, time } = cairoDateAndTime(iso);
  return `${date} ${time}`;
}

/** The status the ledger itself would show when no verifier has spoken: the issue's own. */
export function issueStatusFor(entry: FileSinkEntry): MasterRowStatus {
  return { status: entry.issue.status, rootCauseLevel: entry.issue.rootCauseLevel, rootCause: entry.issue.rootCause };
}

function mergeIssue(existing: StoredIssue | undefined, incoming: AuditIssueInput): StoredIssue {
  const incomingLevel = incoming.rootCauseLevel ?? "unknown";
  if (!existing) {
    return {
      signatureKey: incoming.signatureKey,
      family: incoming.family,
      errorCode: incoming.errorCode,
      title: incoming.title,
      status: incoming.status ?? "investigating",
      rootCauseLevel: incomingLevel,
      rootCause: incoming.rootCause ?? null,
      rootCauseEvidence: incoming.rootCauseEvidence ?? {},
      firstSeenAt: incoming.firstSeenAt ?? null,
      lastSeenAt: incoming.lastSeenAt ?? null,
    };
  }
  // As the SQL: status, title and a root cause already established are never overwritten here.
  const wasUnknown = existing.rootCauseLevel === "unknown";
  return {
    ...existing,
    firstSeenAt: earlierOf(existing.firstSeenAt, incoming.firstSeenAt ?? null),
    lastSeenAt: laterOf(existing.lastSeenAt, incoming.lastSeenAt ?? null),
    rootCauseLevel: wasUnknown ? incomingLevel : existing.rootCauseLevel,
    rootCause: wasUnknown && incoming.rootCause != null ? incoming.rootCause : existing.rootCause,
    rootCauseEvidence:
      wasUnknown && !isEmptyObject(incoming.rootCauseEvidence) ? (incoming.rootCauseEvidence ?? {}) : existing.rootCauseEvidence,
  };
}

function insertOccurrence(row: AuditOccurrenceInput, family: SystemAuditFamily): StoredOccurrence {
  return {
    ...row,
    family,
    technicalMessage: row.technicalMessage ? row.technicalMessage.slice(0, 1000) : null,
    attemptCount: Math.max(1, row.attemptCount ?? 1),
    pageLoads: Math.max(1, row.pageLoads ?? 1),
    firstEventAt: row.firstEventAt ?? row.occurredAt,
    lastEventAt: row.lastEventAt ?? row.occurredAt,
    sourceRefs: (row.sourceRefs ?? []).slice(0, 50),
    isTest: row.isTest ?? false,
    evidence: row.evidence ?? {},
  };
}

function updateOccurrence(existing: StoredOccurrence, row: AuditOccurrenceInput, merge: MergeMode): StoredOccurrence {
  const attempts = Math.max(1, row.attemptCount ?? 1);
  const incomingRefs = row.sourceRefs ?? [];
  return {
    ...existing,
    attemptCount: merge === "add" ? existing.attemptCount + attempts : Math.max(existing.attemptCount, attempts),
    // See the header: an `add` extension may truthfully carry 0 new page loads.
    pageLoads:
      merge === "add"
        ? existing.pageLoads + Math.max(0, row.pageLoads ?? 1)
        : Math.max(existing.pageLoads, Math.max(1, row.pageLoads ?? 1)),
    firstEventAt: earlierOf(existing.firstEventAt, row.firstEventAt ?? row.occurredAt) ?? existing.firstEventAt,
    lastEventAt: laterOf(existing.lastEventAt, row.lastEventAt ?? row.occurredAt) ?? existing.lastEventAt,
    sourceRefs:
      merge === "add"
        ? [...existing.sourceRefs, ...incomingRefs].slice(0, 50)
        : incomingRefs.length > 0
          ? incomingRefs.slice(0, 50)
          : existing.sourceRefs,
    technicalMessage: row.technicalMessage ? row.technicalMessage.slice(0, 1000) : existing.technicalMessage,
    evidence: isEmptyObject(row.evidence) ? existing.evidence : (row.evidence ?? {}),
    release: row.release ?? existing.release,
  };
}

function whyText(level: RootCauseLevel, cause: string | null): string {
  const label = ROOT_CAUSE_LEVEL_LABELS[level];
  return cause && cause.trim() ? `${label} — ${cause.trim()}` : label;
}

function incidentRef(occurrence: StoredOccurrence): string {
  if (occurrence.sourceRefs.length > 0) return `${occurrence.errorCode} / ${occurrence.sourceRefs[0]}`;
  if (occurrence.relatedId) return `${occurrence.errorCode} / ${occurrence.relatedTable ?? "record"} ${occurrence.relatedId}`;
  return occurrence.errorCode;
}

export function createFileSink(): FileSink {
  const issues = new Map<string, StoredIssue>();
  const occurrences = new Map<string, StoredOccurrence>();
  const cursors = new Map<string, Record<string, unknown> | null>();

  function entries(): FileSinkEntry[] {
    const out: FileSinkEntry[] = [];
    for (const occurrence of occurrences.values()) {
      const issue = issues.get(occurrence.signatureKey);
      if (issue) out.push({ occurrence, issue });
    }
    return out;
  }

  function toMasterCsvLines(statusFor: (entry: FileSinkEntry) => MasterRowStatus = issueStatusFor, options: { includeTest?: boolean } = {}) {
    const all = entries();
    const periodRows = selectPeriod(
      all.map((entry) => ({ ...entry.occurrence, id: entry.occurrence.dedupeKey, hrKey: entry.occurrence.hrKey ?? null, entry })),
      { includeTest: options.includeTest ?? false },
    );
    const counts = computePeriodCounts(periodRows);
    const ordered = [...periodRows].sort((left, right) => {
      const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
      if (byTime !== 0) return byTime;
      return left.dedupeKey < right.dedupeKey ? 1 : left.dedupeKey > right.dedupeKey ? -1 : 0;
    });

    const lines = [csvLine(MASTER_CSV_HEADERS)];
    for (const row of ordered) {
      const { occurrence, issue } = row.entry;
      const status = statusFor(row.entry);
      const when = cairoDateAndTime(occurrence.occurredAt);
      const hrKey = occurrence.hrKey ?? null;
      lines.push(
        csvLine([
          occurrence.hrIdDisplay ?? "",
          occurrence.employeeName ?? "",
          occurrence.moduleLabel,
          when.date,
          when.time,
          // Column 6 is what the person was SHOWN. Never the stack, never a guess at the wording.
          occurrence.userMessage?.trim() || (occurrence.isSilent ? SILENT_DATA_MESSAGE : USER_MESSAGE_NOT_CAPTURED),
          incidentRef(occurrence),
          whyText(status.rootCauseLevel, status.rootCause),
          SYSTEM_AUDIT_STATUS_LABELS[status.status],
          counts.personOps(occurrence.signatureKey, hrKey),
          counts.scopeLabel(occurrence.signatureKey, hrKey),
          occurrence.signatureKey,
          issue.family,
          occurrence.route ?? "",
          occurrence.technicalMessage ?? "",
          occurrence.attemptCount,
          occurrence.pageLoads,
          cairoStamp(occurrence.firstEventAt),
          cairoStamp(occurrence.lastEventAt),
          occurrence.moduleLabelSource,
          occurrence.dedupeKey,
        ]),
      );
    }
    return lines;
  }

  return {
    kind: "file",
    async write(detector: string, _runId: string | null, batch: FindingBatch): Promise<FindingSinkWriteResult> {
      const result: FindingSinkWriteResult = { issues: 0, inserted: 0, updated: 0 };
      // Postgres refuses an upsert that touches one row twice in a statement ("ON CONFLICT DO
      // UPDATE command cannot affect row a second time"), so a batch repeating a key fails there.
      // It fails here too, rather than passing a test the database would not.
      for (const [what, keys] of [
        ["signature", batch.issues.map((issue) => issue.signatureKey)],
        ["dedupe key", batch.occurrences.map((row) => row.dedupeKey)],
      ] as const) {
        const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
        if (repeated !== undefined) throw new Error(`File sink write refused: ${what} ${repeated} appears twice in one batch.`);
      }
      for (const incoming of batch.issues) {
        issues.set(incoming.signatureKey, mergeIssue(issues.get(incoming.signatureKey), incoming));
        result.issues += 1;
      }
      for (const row of batch.occurrences) {
        const issue = issues.get(row.signatureKey);
        // The SQL joins each row to its issue; a row with none is not written.
        if (!issue) continue;
        const existing = occurrences.get(row.dedupeKey);
        if (existing) {
          occurrences.set(row.dedupeKey, updateOccurrence(existing, row, batch.merge));
          result.updated += 1;
        } else {
          occurrences.set(row.dedupeKey, insertOccurrence(row, issue.family));
          result.inserted += 1;
        }
      }
      if (batch.cursor) cursors.set(detector, batch.cursor);
      return result;
    },
    async readCursor() {
      return null;
    },
    entries,
    issues: () => [...issues.values()],
    lastCursor: (detector) => cursors.get(detector) ?? null,
    toMasterCsvLines,
    toMasterCsv: (statusFor, options) => `${CSV_BOM}${toMasterCsvLines(statusFor, options).join("\r\n")}\r\n`,
  };
}
