/**
 * System Error & Data Integrity Audit — the shared contract.
 *
 * Every detector writes findings in this shape, the ledger (supabase migrations
 * 20261023051847_system_audit_ledger / 20261023051848_system_audit_functions) stores them, and the
 * Super Admin page at /admin/system-audit reads them back through `system_audit_page`. Nothing in
 * here talks to a database, so the classifiers that use it stay testable without one.
 */

export const SYSTEM_AUDIT_FAMILIES = [
  "app_error",
  "reconciliation",
  "visit_lifecycle",
  "sync_run",
  "job_failure",
  "data_linkage",
  "user_screen",
] as const;
export type SystemAuditFamily = (typeof SYSTEM_AUDIT_FAMILIES)[number];

export const SYSTEM_AUDIT_FAMILY_LABELS: Record<SystemAuditFamily, string> = {
  app_error: "Error shown to a person",
  reconciliation: "Nightly integrity check",
  visit_lifecycle: "Visit not carried through",
  sync_run: "iReports360 sync",
  job_failure: "Background job",
  data_linkage: "Record linkage",
  user_screen: "Error or block a person saw (screenshot)",
};

export const SYSTEM_AUDIT_STATUSES = [
  "fixed_verified",
  "not_fixed",
  "investigating",
  "fix_implemented",
  "no_defect",
  "unknown",
] as const;
export type SystemAuditStatus = (typeof SYSTEM_AUDIT_STATUSES)[number];

/** Column 9, word for word as the owner's brief names each state. */
export const SYSTEM_AUDIT_STATUS_LABELS: Record<SystemAuditStatus, string> = {
  fixed_verified: "FIXED — VERIFIED",
  not_fixed: "NOT FIXED",
  investigating: "INVESTIGATING",
  fix_implemented: "FIX IMPLEMENTED — NOT VERIFIED",
  no_defect: "NO DEFECT — EXPECTED BUSINESS BEHAVIOR",
  unknown: "UNKNOWN — INSUFFICIENT EVIDENCE",
};

/** The statuses a person may set by hand. FIXED — VERIFIED belongs to the verifier alone. */
export const SYSTEM_AUDIT_HUMAN_STATUSES = [
  "investigating",
  "not_fixed",
  "fix_implemented",
  "no_defect",
  "unknown",
] as const satisfies readonly SystemAuditStatus[];

export const ROOT_CAUSE_LEVELS = ["confirmed", "probable", "unknown"] as const;
export type RootCauseLevel = (typeof ROOT_CAUSE_LEVELS)[number];
export const ROOT_CAUSE_LEVEL_LABELS: Record<RootCauseLevel, string> = {
  confirmed: "CONFIRMED",
  probable: "PROBABLE",
  unknown: "UNKNOWN",
};

export const MODULE_LABEL_SOURCES = ["nav_exact", "nav_parent", "page_trail", "api_map", "detector", "none"] as const;
export type ModuleLabelSource = (typeof MODULE_LABEL_SOURCES)[number];

export type OccurredAtKind = "failure" | "event" | "detected";
export type ShellKind = "admin" | "hr" | "portal";

/**
 * Column 6 when the exact words on the screen were never recorded. The brief forbids inventing a
 * message a person did not receive, so these say what is known and no more.
 */
export const USER_MESSAGE_NOT_CAPTURED = "Error screen shown — exact wording not captured";
export const SILENT_DATA_MESSAGE = "Silent data inconsistency — no error was shown";
/** Column 3 when no sidebar row can be found for the address. */
export const NOT_IN_SIDEBAR_PREFIX = "Not in sidebar — ";

export type SharedScope = "only" | "shared" | "system";

/** Column 11. A row with no person is a system row, never counted as an employee. */
export function sharedScopeLabel(people: number, hrKey: string | null | undefined): string {
  if (!hrKey) return "SYSTEM — NO EMPLOYEE ATTRIBUTION";
  if (people <= 1) return "UNIQUE — ONLY THIS EMPLOYEE";
  return `SHARED — ${people} EMPLOYEES AFFECTED`;
}

export type AuditIssueInput = {
  signatureKey: string;
  family: SystemAuditFamily;
  errorCode: string;
  title: string;
  rootCauseLevel?: RootCauseLevel;
  rootCause?: string | null;
  rootCauseEvidence?: Record<string, unknown>;
  /** Initial status on first sight only; later changes go through the transition function. */
  status?: SystemAuditStatus;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
};

export type AuditOccurrenceInput = {
  /** Stable per user-level operation, so re-running a detector is a no-op. */
  dedupeKey: string;
  signatureKey: string;
  correlationId?: string | null;
  isRootSymptom?: boolean;
  /** canonicalHrIdKey of the person, or null for a system row. */
  hrKey?: string | null;
  hrIdDisplay?: string | null;
  employeeName?: string | null;
  roleAtEvent?: string | null;
  moduleLabel: string;
  moduleLabelSource: ModuleLabelSource;
  shell?: ShellKind | null;
  route?: string | null;
  occurredAt: string;
  occurredAtKind: OccurredAtKind;
  affectedDate?: string | null;
  userMessage?: string | null;
  isSilent: boolean;
  technicalMessage?: string | null;
  errorCode: string;
  relatedTable?: string | null;
  relatedId?: string | null;
  attemptCount?: number;
  pageLoads?: number;
  firstEventAt?: string | null;
  lastEventAt?: string | null;
  sourceRefs?: string[];
  release?: string | null;
  preFixBuild?: boolean;
  evidence?: Record<string, unknown>;
  isTest?: boolean;
};

/**
 * `add` — counters add up (each source event is processed exactly once, the watermark moves in the
 * same transaction). `max` — a state finding seen again keeps the larger counters and the newest
 * evidence, never doubles.
 */
export type MergeMode = "add" | "max";

export type FindingBatch = {
  issues: AuditIssueInput[];
  occurrences: AuditOccurrenceInput[];
  merge: MergeMode;
  /** Written in the same transaction as the rows; null leaves the watermark where it is. */
  cursor?: Record<string, unknown> | null;
};

export type FindingSinkWriteResult = { issues: number; inserted: number; updated: number };

export interface FindingSink {
  readonly kind: "database" | "file";
  write(detector: string, runId: string | null, batch: FindingBatch): Promise<FindingSinkWriteResult>;
  readCursor(detector: string): Promise<Record<string, unknown> | null>;
}

export type DetectorMode = "cron" | "historical" | "manual";

export type DetectorRunStatus = "ok" | "partial" | "budget_exhausted" | "aborted_db_unhealthy" | "errored" | "skipped";

export type DetectorContext = {
  mode: DetectorMode;
  /** Epoch ms after which the detector must stop starting new work and return. */
  deadline: number;
  sink: FindingSink;
  runId: string | null;
  now: () => number;
  /** Historical mode only: inclusive Cairo date bounds (YYYY-MM-DD). */
  window?: { from: string; to: string } | null;
};

export type DetectorResult = {
  status: DetectorRunStatus;
  scanned: number;
  /** Noise excluded on purpose, counted per class — never dropped silently. */
  excludedCounts: Record<string, number>;
  inserted: number;
  updated: number;
  /** Sources that could not be read; their findings are UNKNOWN, never a pass. */
  unreadableSources: string[];
  watermarkFrom?: Record<string, unknown> | null;
  watermarkTo?: Record<string, unknown> | null;
  error?: string | null;
  /** Free-form, stored on the run row (the reconciliation detector stores its whole report). */
  report?: Record<string, unknown> | null;
};

export interface AuditDetector {
  readonly id: string;
  readonly family: SystemAuditFamily;
  readonly version: number;
  run(ctx: DetectorContext): Promise<DetectorResult>;
}

export function emptyDetectorResult(status: DetectorRunStatus = "ok"): DetectorResult {
  return { status, scanned: 0, excludedCounts: {}, inserted: 0, updated: 0, unreadableSources: [] };
}

/** One row as `system_audit_page` returns it. */
export type SystemAuditPageRow = {
  id: string;
  issueId: string;
  signatureKey: string;
  family: SystemAuditFamily;
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
  title: string;
  rootCauseLevel: RootCauseLevel;
  rootCause: string | null;
  status: SystemAuditStatus;
  issueStatus: SystemAuditStatus;
  personOps: number;
  people: number;
  attemptCount: number;
  pageLoads: number;
  firstEventAt: string;
  lastEventAt: string;
  correlationId: string | null;
  isRootSymptom: boolean;
  relatedTable: string | null;
  relatedId: string | null;
  release: string | null;
  preFixBuild: boolean;
  triageOverride: "no_defect" | "unknown" | null;
  triageReason: string | null;
  isTest: boolean;
};

/** One page of the screen: the filtered total, and the rows at this offset (offset capped at 10,000). */
export type SystemAuditPage = {
  total: number;
  limit: number;
  offset: number;
  rows: SystemAuditPageRow[];
  next: null;
};

/**
 * One export batch: up to 5,000 rows in (occurred_at desc, id desc) order, and the cursor for the
 * next batch (null on the last). It carries NO total — counting every row on every batch is what
 * made the export slow; the export counts what it wrote.
 */
export type SystemAuditExportBatch = {
  total: null;
  limit: number;
  offset: 0;
  rows: SystemAuditPageRow[];
  next: { occurredAt: string; id: string } | null;
};

export const SYSTEM_AUDIT_SORTS = ["occurred_desc", "occurred_asc", "employee", "module", "person_ops", "people"] as const;
export type SystemAuditSort = (typeof SYSTEM_AUDIT_SORTS)[number];

export type SystemAuditFilters = {
  /** Cairo calendar dates, YYYY-MM-DD, inclusive. */
  from?: string | null;
  to?: string | null;
  hrKeys?: string[];
  modules?: string[];
  statuses?: SystemAuditStatus[];
  rootCauseLevels?: RootCauseLevel[];
  families?: SystemAuditFamily[];
  scope?: SharedScope | null;
  search?: string | null;
  includeSilent?: boolean;
  includeTest?: boolean;
};
