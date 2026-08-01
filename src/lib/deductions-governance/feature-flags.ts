/**
 * Deductions Governance — payroll-handoff feature flags.
 *
 * The legacy governance module can push its finalized monthly summary straight
 * into `salary_records.crm / finger_print / unpaid_vacations`. That import is
 * strictly ADD-ON-TOP, and payroll-handoff.ts's own type doc already states the
 * hazard plainly: the RPC "blocks re-running the SAME finalized summary twice,
 * but it cannot see whether a DIFFERENT path (e.g. Automated Payroll's own live
 * pull of the same deduction_candidates/decisions data) already baked an
 * equivalent amount into this row — since import is strictly add-on-top, that
 * would double the deduction."
 *
 * The unified Deductions module (`src/lib/deductions/`) is becoming the single
 * place deductions are decided, and Automated Payroll will consume its published
 * snapshot. For the whole shadow-and-cutover period BOTH systems are computing
 * the same money at the same time. A second live writer into the same three
 * columns is therefore the one failure that cannot be allowed: it would not
 * error, it would silently pay twice.
 *
 * So this path is closed FIRST — before any category cuts over — and stays
 * closed. It is deliberately a compile-time constant rather than a database
 * flag: a DB flag could flip mid-run and produce a payroll month assembled from
 * two different truths.
 *
 * Precedent for the shape: src/lib/workflow-control/feature-flags.ts.
 */

export const DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_ENABLED = false;

export const DEDUCTIONS_GOVERNANCE_PAYROLL_IMPORT_DISABLED_MESSAGE =
  "The Deductions Governance payroll import is disabled. Deductions are now decided in the " +
  "Deductions module (/admin/deductions) and reach payroll from its published month, so importing " +
  "here would add the same money a second time. Publish the month in /admin/deductions instead.";
