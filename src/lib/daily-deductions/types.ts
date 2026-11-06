// Daily Deductions module — the SECOND deductions surface, beside the month-final
// unified module (src/lib/deductions/). Where that module collects a finished
// month, reviews every candidate, and publishes at month-end, THIS module counts
// deductions day by day over an operator-picked date range and publishes a
// running tally the operator can refresh at any time.
//
// It NEVER writes salary_records/salary_batches. Its only output is a snapshot in
// daily_deductions_publications / daily_deductions_lines — a governance/reporting
// figure the owner reads into his payroll sheet, exactly like the month module's
// own publication snapshot. The money is still committed by payroll, from the
// reviewed month module, never from here.
//
// It reuses the month module's detection engines (the CRM/fingerprint/vacation
// connectors) unchanged, then CLIPS each finding to the picked range and to days
// that have fully elapsed — so every incident-driven correctness rule those
// engines carry (the 39,225.73 EGP in-progress-month guard, the CRM suspect-date
// exclusion, the manager/zero-signal exclusions, the vacation double-charge
// guards) is inherited rather than re-implemented.

export type { DeductionsCategory } from "@/lib/deductions/types.ts";

/** The daily module counts every automated category the month module collects. */
export const dailyDeductionCategories = [
  "fingerprint",
  "crm",
  "unpaid_vacation",
  "insufficient_balance_vacation",
  "no_records_activity",
  "no_weekly_plan",
] as const;
export type DailyDeductionCategory = (typeof dailyDeductionCategories)[number];

/** The connectors the daily tally drives, in run order. Mirrors DEDUCTION_COLLECTORS
 * minus the manual-only categories (loan/other are one-at-a-time HR entries, never a
 * day-by-day scan) and minus dsm_no_record / crm_half_day / holiday_bridge, whose whole point is a
 * ledger-relative dedup against the MONTH module's candidate rows — a dedup that has no
 * meaning for a stateless range tally. Fingerprint, CRM and the two vacation engines are
 * the day-granular no-activity/absence sources the owner counts toward his sheet.
 *
 * `no_records_activity` is the daily module's OWN connector (owner, 2026-10-12): a working day on
 * which an active employee left no punch and no other activity. It is not the month module's
 * retired category of the same name — it skips Medical Reps, district managers and the SFE
 * Manager, whose absences the `crm` and `dsm_no_record` connectors already own. */
export const dailyDeductionConnectors = [
  "fingerprint",
  "crm",
  "unpaid_vacation",
  "insufficient_balance_vacation",
  "no_records_activity",
  "no_weekly_plan",
] as const;
export type DailyDeductionConnector = (typeof dailyDeductionConnectors)[number];

export function isDailyDeductionConnector(value: unknown): value is DailyDeductionConnector {
  return typeof value === "string" && (dailyDeductionConnectors as readonly string[]).includes(value);
}

export const dailyDeductionConnectorLabels: Record<DailyDeductionConnector, string> = {
  fingerprint: "Fingerprint attendance",
  crm: "CRM no-activity",
  unpaid_vacation: "Unpaid vacation",
  insufficient_balance_vacation: "Insufficient balance vacation",
  no_records_activity: "No records (no punch, no activity)",
  no_weekly_plan: "No weekly plan (head office)",
};

/** A from/to date window in ISO YYYY-MM-DD, inclusive both ends. */
export type DailyDeductionRange = {
  from: string;
  to: string;
};

/** The range actually counted: the requested window clamped so it never reaches
 * today or a future day (only fully-elapsed days are judgeable). `effectiveTo`
 * is `min(to, yesterday Cairo)`; `truncated` says the clamp bit. */
export type ResolvedDailyRange = {
  requested: DailyDeductionRange;
  from: string;
  effectiveTo: string;
  /** True when the requested `to` was in the future/today and was pulled back. */
  truncated: boolean;
  /** True when even `from` is not yet elapsed — nothing is countable. */
  empty: boolean;
};

/** One employee×category running-tally row, computed from the clipped connector output. */
export type DailyDeductionTallyLine = {
  category: DailyDeductionCategory;
  employeeHrId: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  unit: "days" | "amount";
  /** The connectors' full-month detected day count for this employee×category,
   * summed across the months the range spans — evidence/context, not the charge. */
  rawDaysCount: number;
  /** The clipped, in-range day count — what this tally actually counts. */
  daysCount: number;
  /** EGP, scaled from the connector's own estimate to the clipped days. */
  amount: number;
  /** The specific in-range days behind this row, de-duplicated and sorted. */
  dates: string[];
  sourceSystem: string;
  reason: string | null;
  /** True when part of this row has no computable amount (usually no base salary on file). The
   * `amount` then reads 0 only because nothing could be priced — such a row is never released, so an
   * employee is never emailed "EGP 0.00" or a figure that is silently too low. */
  amountUnknown?: boolean;
};

/** The result of running ONE connector over a range and clipping it. */
export type DailyConnectorTally = {
  connector: DailyDeductionConnector;
  label: string;
  lines: DailyDeductionTallyLine[];
  employeeCount: number;
  lineCount: number;
  totalAmount: number;
  /** Non-fatal notes — a month the connector refused (cutover), a degraded feeder,
   * a boundary-prorated row — surfaced to the operator, never thrown. */
  warnings: string[];
};

export const dailyDeductionsPublicationStatuses = ["published", "superseded"] as const;
export type DailyDeductionsPublicationStatus = (typeof dailyDeductionsPublicationStatuses)[number];

export type DailyDeductionsPublication = {
  id: string;
  rangeStart: string;
  rangeEnd: string;
  status: DailyDeductionsPublicationStatus;
  publishedBy: string;
  publishedAt: string;
  supersededAt: string | null;
  supersededByPublicationId: string | null;
  employeeCount: number;
  lineCount: number;
  categoryTotals: Partial<Record<DailyDeductionCategory, number>>;
  notes: string | null;
  createdAt: string;
};

export type DailyDeductionsLine = {
  id: string;
  publicationId: string;
  category: DailyDeductionCategory;
  employeeHrId: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  unit: "days" | "amount";
  rawDaysCount: number;
  daysCount: number;
  amount: number;
  dates: string[];
  sourceSystem: string;
  reason: string | null;
  hrNote: string;
  createdAt: string;
  /** When THIS line was released into the snapshot (a re-release refreshes it). */
  releasedAt: string;
  releasedBy: string | null;
  /** The window THIS line was counted over; null on a line written before per-line release. */
  rangeStart: string | null;
  rangeEnd: string | null;
};

/** The employee-portal display line (self-only). Latent surface: the RLS self-read
 * policy exists, but the daily tally is an admin/finance aid until the owner decides
 * whether employees should see a running (non-final) figure. */
export type DailyDeductionsPortalLine = {
  id: string;
  publicationId: string;
  employeeCode: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  category: DailyDeductionCategory;
  deductionUnit: "days" | "amount";
  daysCount: number;
  amount: number;
  dates: string[];
  rangeStart: string;
  rangeEnd: string;
  createdAt: string;
};

/** The JSONB line shape phx_publish_daily_deductions consumes (camelCase keys). */
export type DailyDeductionsPublishLineInput = {
  category: DailyDeductionCategory;
  employeeHrId: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  unit: "days" | "amount";
  rawDaysCount: number;
  daysCount: number;
  amount: number;
  dates: string[];
  sourceSystem: string;
  reason: string | null;
  hrNote?: string;
};
