/**
 * The "one fact, one number" reconciliation contract.
 *
 * Every defect this harness exists to catch was a READ-PATH defect: the database held the right
 * rows and the service that read them returned something else, silently, for months. A check
 * written as plain SQL over tables would have caught almost none of them — the database agreed
 * with itself the whole time. So a check here is always a COMPARISON of two independently-derived
 * answers to the same question:
 *
 *   left  — what the real domain service returns (the number a human actually reads on screen)
 *   right — the same fact derived another way (raw rows, or a second service that must agree)
 *
 * and it breaches when they differ. That is what catches "the screen disagrees with the database"
 * and "two screens disagree with each other", which is the actual failure class.
 */

export const reconciliationDomains = [
  "payroll",
  "deductions-attendance",
  "crm-sales",
  "notifications-integrity",
  "recruitment",
  "direct-orders",
] as const;

export type ReconciliationDomain = (typeof reconciliationDomains)[number];

/**
 * critical — money or membership a person is paid on, or a delivery claimed as made.
 * high     — a figure a manager decides on.
 * medium   — a figure that misleads without directly moving money.
 */
export const reconciliationSeverities = ["critical", "high", "medium"] as const;
export type ReconciliationSeverity = (typeof reconciliationSeverities)[number];

/**
 * What this check is expected to report against production TODAY.
 *
 * `known-open` exists so a proven, still-unfixed defect can ship as a documented finding instead
 * of as a permanently-red alarm. A false alarm is worse than no check: an invariant that fires
 * spuriously every night trains everyone to ignore the whole harness, including the checks that
 * are telling the truth. Known-open checks are reported but never paged on; the day one of them
 * starts holding, its status flips to "holds" and the expectation should be tightened.
 */
export type ReconciliationExpectation = "holds" | "known-open";

/** One side of a comparison, with where it came from stated in words a non-engineer can act on. */
export type ReconciliationSide = {
  /** The service call or query that produced `value` — named precisely enough to re-run by hand. */
  source: string;
  /**
   * The derived answer, already formatted for reading. Compound facts (a row count AND a money
   * total AND a set of HR_IDs) are rendered into one line rather than split into more fields:
   * the reader's question is only ever "do these two say the same thing".
   */
  value: string;
};

/**
 * One row behind a disagreement — the person (or record) it lands on, so the System Audit ledger
 * can say WHO a breach touches instead of only that it happened. Optional on every check: a check
 * that cannot name a person yields none, and the ledger then records one system row per breach
 * episode instead (src/lib/system-audit/reconciliation-ledger.ts).
 */
export type ReconciliationFinding = {
  /** The HR id as the check read it; null for a record no person owns. */
  hrId: string | null;
  /** The Cairo calendar day the disagreement is about (YYYY-MM-DD), when it is about one. */
  affectedDate?: string | null;
  relatedTable?: string | null;
  relatedId?: string | null;
  /** What is wrong for this one row, in words a non-engineer can act on. */
  detail: string;
  /** The screen where this row is fixed, when the check knows it better than its domain does. */
  moduleHref?: string | null;
};

export type ReconciliationOutcome = {
  left: ReconciliationSide;
  right: ReconciliationSide;
  holds: boolean;
  /**
   * What differs, in full. Never truncated with an ellipsis and never a bare count — the reader
   * must be able to act on this line without opening the database. When a list is long it is
   * capped by naming the cap ("first 10 of 46"), which is a statement, not a truncation.
   */
  detail: string;
  /** The rows behind the disagreement. Optional, so every existing check is unchanged. */
  findings?: ReconciliationFinding[];
};

export type ReconciliationCheck = {
  /** Stable across releases — it is the key an alert is deduplicated and searched on. */
  id: string;
  title: string;
  domain: ReconciliationDomain;
  severity: ReconciliationSeverity;
  expectation: ReconciliationExpectation;
  /** Required when `expectation` is "known-open": the evidence that it is a real open defect. */
  openDefect?: string;
  /**
   * Checks that share a lane never run at the same time as each other, nor beside any check without a
   * lane: lanes run one check after another, only once every other check has finished (runner.ts). For checks
   * too heavy to run side by side — the monthly sales truth checks each load three closings per line,
   * and three at once took 25-60 s each against 10-14 s alone (14 Nov 2026). Each check keeps its own
   * time limit, timed from when it starts, never from when the lane reached the runner.
   */
  lane?: string;
  run: () => Promise<ReconciliationOutcome>;
};

/**
 * holds      — the two sides agree.
 * breached   — they disagree and were expected to agree. This is the one that pages a human.
 * known-open — they disagree exactly as documented; reported, not paged.
 * errored    — the check itself failed. Recorded as a result, never thrown: one broken check
 *              must not blind the others (every check in checks/index.ts).
 */
export type ReconciliationStatus = "holds" | "breached" | "known-open" | "errored";

export type ReconciliationCheckResult = {
  id: string;
  title: string;
  domain: ReconciliationDomain;
  severity: ReconciliationSeverity;
  expectation: ReconciliationExpectation;
  status: ReconciliationStatus;
  /** null only when the check errored — an unknown answer is never reported as a passing one. */
  holds: boolean | null;
  left: ReconciliationSide | null;
  right: ReconciliationSide | null;
  detail: string;
  durationMs: number;
  error: string | null;
  /** The check's documented open defect, carried so the stored report and the ledger can name it. */
  openDefect?: string;
  /** The first RECONCILIATION_FINDINGS_CAP findings the check returned. */
  findings?: ReconciliationFinding[];
  /** How many findings were left off by the cap — said as a number, never dropped in silence. */
  findingsTruncated?: number;
};

/** Per check, so one runaway check cannot bloat the stored report past the ledger's 256 KB row. */
export const RECONCILIATION_FINDINGS_CAP = 500;

export type ReconciliationCounts = {
  total: number;
  holding: number;
  breached: number;
  knownOpen: number;
  errored: number;
};

export type ReconciliationReport = {
  /** Africa/Cairo, because every time the owner reads is Cairo local time. */
  generatedAt: string;
  durationMs: number;
  counts: ReconciliationCounts;
  /**
   * True when a human must look today — a breach, or a check that could not answer. Known-open
   * findings deliberately do NOT raise this; see the note on ReconciliationExpectation.
   */
  alerting: boolean;
  results: ReconciliationCheckResult[];
};
