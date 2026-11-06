// Daily Deductions module: the pure validation of tally lines that come back from the browser.
//
// Shared by the replace-everything publish (publish.ts) and the per-line release (release.ts) so
// both refuse exactly the same malformed input. No database, no server-only import - the unit
// tests load this file directly.

import { compactDeductionsHrId } from "../deductions/candidate-key.ts";
import {
  dailyDeductionCategories,
  type DailyDeductionCategory,
  type DailyDeductionsPublishLineInput,
} from "./types.ts";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function assertNonNegativeNumber(value: unknown, label: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Validation: ${label} must be a number ≥ 0 (got ${JSON.stringify(value)}).`);
  }
  return round2(num);
}

/**
 * Turn one client-supplied tally row into the exact jsonb shape the RPC consumes,
 * failing loudly on anything malformed. The compact HR id is RE-DERIVED server-side
 * from the raw HR id rather than trusted from the client, so the unique key the
 * publication enforces cannot be spoofed into a collision or a split.
 */
export function normalizeDailyLine(raw: unknown, index: number): DailyDeductionsPublishLineInput {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Validation: line ${index + 1} is not an object.`);
  }
  const line = raw as Record<string, unknown>;

  const category = String(line.category ?? "") as DailyDeductionCategory;
  if (!(dailyDeductionCategories as readonly string[]).includes(category)) {
    throw new Error(`Validation: line ${index + 1} has an unknown category ${JSON.stringify(line.category)}.`);
  }

  const employeeHrId = String(line.employeeHrId ?? "").trim();
  const compact = compactDeductionsHrId(employeeHrId);
  if (!employeeHrId || !compact) {
    throw new Error(`Validation: line ${index + 1} has no resolvable employee HR id.`);
  }

  // A row the tally could not price is never released — the employee would be emailed "EGP 0.00".
  if (line.amountUnknown === true) {
    throw new Error(
      `Validation: line ${index + 1} (${typeof line.employeeName === "string" && line.employeeName.trim() ? line.employeeName.trim() : "an employee with no name on file"}) has no computable amount — usually no base salary on file. Put the salary on file and compute again before releasing it.`,
    );
  }

  const unit = line.unit === "amount" ? "amount" : "days";
  const dates = Array.isArray(line.dates) ? line.dates.filter((d): d is string => typeof d === "string") : [];
  const employeeName = typeof line.employeeName === "string" && line.employeeName.trim() ? line.employeeName.trim() : null;

  return {
    category,
    employeeHrId,
    employeeHrIdCompact: compact,
    employeeName,
    unit,
    rawDaysCount: assertNonNegativeNumber(line.rawDaysCount, `line ${index + 1} rawDaysCount`),
    daysCount: assertNonNegativeNumber(line.daysCount, `line ${index + 1} daysCount`),
    amount: assertNonNegativeNumber(line.amount, `line ${index + 1} amount`),
    dates,
    sourceSystem: String(line.sourceSystem ?? ""),
    reason: typeof line.reason === "string" ? line.reason : null,
    hrNote: typeof line.hrNote === "string" ? line.hrNote : undefined,
  };
}

/** The identity of a tally line inside a snapshot: one per employee x category. */
export function dailyLineKey(line: { category: string; employeeHrIdCompact: string }): string {
  return `${line.category}|${line.employeeHrIdCompact}`;
}

/**
 * Refuse a batch that carries the same employee x category twice - the snapshot's unique index
 * enforces this too, but a friendly error beats a raw 23505 from the RPC.
 */
export function assertNoDuplicateDailyLines(lines: DailyDeductionsPublishLineInput[]): void {
  const seen = new Set<string>();
  for (const line of lines) {
    const key = dailyLineKey(line);
    if (seen.has(key)) {
      throw new Error(
        `Validation: ${line.employeeName ?? line.employeeHrId} appears twice for ${line.category}. Each employee×category is one tally line.`,
      );
    }
    seen.add(key);
  }
}
