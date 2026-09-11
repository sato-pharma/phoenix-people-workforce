import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";

import type { StepKey, StepRow } from "./types.ts";

/**
 * Has the Deductions module changed its mind since this step was confirmed?
 *
 * WHY THIS EXISTS. Confirming a step copies the figure the module is proposing onto the run's own
 * row, and the payroll engine then reads that row — not the module — when it works out what
 * everybody is paid. That copy is load-bearing and must stay: clearing it does not fall back to the
 * module, it reads as zero, which would wipe every deduction HR accepted rather than typed.
 *
 * The cost of the copy is that it is taken once and never looked at again. Mark a candidate "Do Not
 * Take Action" in the module after the step was confirmed and the employee is still charged, with
 * the breakdown underneath showing no lines at all — the money stopped coming from the module and
 * nothing said so. Approve a candidate afterwards and it contributes nothing, because the copy
 * outranks it. Your rule is that payroll pays what was approved in the module; a copy taken once
 * quietly changes that to what was approved at one particular past moment.
 *
 * WHY A SNAPSHOT AND NOT A PLAIN COMPARISON. Comparing the stored figure against what the module
 * says now cannot tell two very different things apart: a figure HR deliberately overrode, which
 * must be left exactly alone, and a figure the module has since changed, which is the one worth
 * raising. Both simply "differ". So the confirm records what it was proposing at the time, and the
 * comparison is then between the module's answer THEN and its answer NOW — which is a fact about
 * the module, not about the person editing.
 *
 * Without that, every deliberate override shows up as a warning, the warning is always on, and it
 * stops being read — which is the failure that matters most for a check that only pays off on the
 * rare month something moved.
 */

/**
 * The steps whose figures come from the Deductions module.
 *
 * Exactly the ones that call `loadConfirmedDeductions` in recommend.ts. Every other step proposes
 * from the employee master or from the run itself, and neither can change behind the run's back in
 * the way this check exists to catch.
 */
export const MODULE_SOURCED_STEP_KEYS: readonly StepKey[] = [
  "p1_fingerprint",
  "p1_crm",
  "p1_resignation_crm",
  "p1_unpaid_vacation",
  "p1_other_deductions",
  "p2_vacation",
  "p2_crm",
  "p2_manual_deductions",
];

/** The key the snapshot is stored under, inside the step state's existing jsonb summary. */
export const RECOMMENDED_AT_CONFIRM_KEY = "recommendedAtConfirm";

/** compact HR id -> field key -> what the system was proposing when the step was confirmed. */
export type RecommendationSnapshot = Record<string, Record<string, number>>;

export type ModuleDriftRow = {
  hrId: string;
  fullName: string;
  stepKey: StepKey;
  /** The step field that moved, e.g. "crm". */
  field: string;
  /** What the module was saying when the step was confirmed. */
  proposedAtConfirm: number;
  /** What the module says now. */
  proposedNow: number;
  /** What the run will actually charge — the figure on its own row. */
  charged: number;
  /**
   * True when the charged figure is not the one the module proposed at confirm, i.e. a human typed
   * it. Their decision still stands and still wins; this row is context, not a problem.
   */
  overridden: boolean;
};

export type ModuleDriftReport = {
  rows: ModuleDriftRow[];
  /**
   * Rows where the run is about to charge a figure the module no longer proposes AND nobody chose
   * it by hand. These are the ones that need a decision.
   */
  staleCharges: number;
  /** Rows where the module moved but a human's own figure is in force. Shown, never counted as a problem. */
  overriddenButMoved: number;
};

/** What the system proposed for each employee, to be stored alongside the confirm. */
export function snapshotRecommendations(rows: StepRow[]): RecommendationSnapshot {
  const snapshot: RecommendationSnapshot = {};
  for (const row of rows) {
    if (row.readOnly) continue;
    const compact = compactHrKey(row.hrId);
    if (!compact) continue;
    const fields: Record<string, number> = {};
    for (const [field, value] of Object.entries(row.recommended ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) fields[field] = value;
    }
    // An employee the step proposed nothing numeric for contributes no entry rather than an empty
    // object: absent and "proposed nothing" must stay distinguishable when the snapshot is read
    // back, because only the first means "this step predates the snapshot".
    if (Object.keys(fields).length > 0) snapshot[compact] = fields;
  }
  return snapshot;
}

/** Read a snapshot back out of a step state's summary, tolerating a step confirmed before it existed. */
export function snapshotFromSummary(summary: Record<string, unknown> | null | undefined): RecommendationSnapshot | null {
  const raw = summary?.[RECOMMENDED_AT_CONFIRM_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const snapshot: RecommendationSnapshot = {};
  for (const [compact, fields] of Object.entries(raw as Record<string, unknown>)) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) continue;
    const numeric: Record<string, number> = {};
    for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) numeric[field] = asNumber;
    }
    if (Object.keys(numeric).length > 0) snapshot[compact] = numeric;
  }
  return snapshot;
}

/**
 * Compare what the module proposed at confirm against what it proposes now.
 *
 * Pure, so the rule is testable without a database — the caller supplies the freshly computed rows
 * and the snapshot that was stored.
 *
 * A step confirmed before snapshots existed passes a null snapshot and reports nothing. Silence is
 * correct there: with no record of what was proposed at the time, every comparison would be a
 * guess, and a guess presented as a finding is worse than no finding.
 */
export function detectModuleDrift(input: {
  stepKey: StepKey;
  rows: StepRow[];
  snapshot: RecommendationSnapshot | null;
}): ModuleDriftReport {
  const rows: ModuleDriftRow[] = [];
  if (!input.snapshot) return { rows, staleCharges: 0, overriddenButMoved: 0 };

  for (const row of input.rows) {
    if (row.readOnly) continue;
    const compact = compactHrKey(row.hrId);
    const proposedThen = compact ? input.snapshot[compact] : undefined;
    if (!proposedThen) continue;

    for (const [field, atConfirm] of Object.entries(proposedThen)) {
      const now = row.recommended?.[field];
      if (typeof now !== "number" || !Number.isFinite(now)) continue;
      if (now === atConfirm) continue;

      const charged = typeof row.values?.[field] === "number" ? (row.values[field] as number) : atConfirm;
      rows.push({
        hrId: row.hrId,
        fullName: row.fullName,
        stepKey: input.stepKey,
        field,
        proposedAtConfirm: atConfirm,
        proposedNow: now,
        charged,
        overridden: charged !== atConfirm,
      });
    }
  }

  // Biggest change first — the figure that moved furthest is the one to look at, and the order is
  // stable between loads so a list read twice reads the same way.
  rows.sort(
    (left, right) =>
      Math.abs(right.proposedNow - right.proposedAtConfirm) -
        Math.abs(left.proposedNow - left.proposedAtConfirm) ||
      left.fullName.localeCompare(right.fullName),
  );

  return {
    rows,
    staleCharges: rows.filter((row) => !row.overridden).length,
    overriddenButMoved: rows.filter((row) => row.overridden).length,
  };
}

/** Merge per-step reports into one, for a whole run. */
export function mergeModuleDrift(reports: ModuleDriftReport[]): ModuleDriftReport {
  const rows = reports.flatMap((report) => report.rows);
  return {
    rows,
    staleCharges: rows.filter((row) => !row.overridden).length,
    overriddenButMoved: rows.filter((row) => row.overridden).length,
  };
}

/** One line for a banner, an error message or the audit log. */
export function describeModuleDrift(report: ModuleDriftReport): string {
  if (report.staleCharges === 0 && report.overriddenButMoved === 0) {
    return "Every confirmed figure still matches the Deductions module.";
  }
  const stale = report.rows.filter((row) => !row.overridden);
  const sample = stale
    .slice(0, 5)
    .map(
      (row) =>
        `${row.fullName} (${row.hrId}): confirmed at ${row.proposedAtConfirm.toFixed(2)}, the module now says ${row.proposedNow.toFixed(2)}`,
    );
  const more = stale.length > 5 ? ` …and ${stale.length - 5} more.` : "";
  const overridden =
    report.overriddenButMoved > 0
      ? ` ${report.overriddenButMoved} more moved but carry a figure someone entered by hand, which still stands.`
      : "";
  if (stale.length === 0) return `No confirmed figure is stale.${overridden}`;
  return `${stale.length} confirmed figure(s) no longer match the Deductions module. ${sample.join(" | ")}${more}${overridden}`;
}
