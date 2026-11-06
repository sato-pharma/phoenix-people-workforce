// Unified Deductions module: deterministic candidate-key + normalization helpers.
// Pure functions. No DB I/O. Ported from deductions-governance/candidate-key.ts,
// keyed by category instead of source_module+deduction_type.

import { canonicalHrIdKey } from "../hr-id.ts";
import type { DeductionsCategory } from "./types.ts";

const MONTH_KEY_PATTERN = /^(\d{4})[-/](\d{1,2})$/;
const DATE_ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function normalizeMonthKey(input: string): string {
  if (typeof input !== "string") {
    throw new Error("Validation: monthKey must be a string");
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Validation: monthKey must not be blank");
  }
  const match = MONTH_KEY_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(`Validation: monthKey "${input}" is not in YYYY-MM or YYYY/MM form`);
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Validation: monthKey "${input}" has out-of-range year`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Validation: monthKey "${input}" has out-of-range month`);
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`;
}

export function normalizeDates(dates: readonly string[]): string[] {
  if (!Array.isArray(dates)) {
    throw new Error("dates must be an array of YYYY-MM-DD strings");
  }
  const seen = new Set<string>();
  for (const entry of dates) {
    if (typeof entry !== "string") {
      throw new Error("dates entries must be strings");
    }
    const trimmed = entry.trim();
    if (!DATE_ISO_PATTERN.test(trimmed)) {
      throw new Error(`date "${entry}" is not a YYYY-MM-DD ISO date`);
    }
    const [yStr, mStr, dStr] = trimmed.split("-");
    const y = Number.parseInt(yStr, 10);
    const m = Number.parseInt(mStr, 10);
    const d = Number.parseInt(dStr, 10);
    if (
      !Number.isInteger(y) ||
      !Number.isInteger(m) ||
      !Number.isInteger(d) ||
      m < 1 ||
      m > 12 ||
      d < 1 ||
      d > 31
    ) {
      throw new Error(`date "${entry}" is not a valid calendar date`);
    }
    seen.add(trimmed);
  }
  return [...seen].sort();
}

// FNV-1a 32-bit hash. Deterministic, pure, no deps.
export function hashStable(input: string): string {
  if (typeof input !== "string") {
    throw new Error("hashStable requires a string input");
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sanitizeSourceRecordId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

// Ported verbatim from deductions-governance/service.ts's compactDeductionHrId
// so employee_hr_id_compact stays comparable across both the legacy and new
// tables during the transition (dual-read/reconciliation phases rely on this).
export function compactDeductionsHrId(value: string | null | undefined): string | null {
  const canonical = canonicalHrIdKey(value);
  if (!canonical) return null;
  const compact = canonical.replace(/[^a-z0-9]/g, "");
  return compact ? compact : null;
}

export function buildDeductionsCandidateKey(input: {
  sourceSystem: string;
  sourceRecordId: string;
  employeeHrId: string;
  monthKey: string;
  category: DeductionsCategory;
  dates: readonly string[];
}): string {
  const normalizedHr = canonicalHrIdKey(input.employeeHrId);
  if (!normalizedHr) {
    throw new Error("employeeHrId is required for candidate key");
  }
  if (typeof input.sourceSystem !== "string" || !input.sourceSystem.trim()) {
    throw new Error("sourceSystem is required for candidate key");
  }
  if (typeof input.sourceRecordId !== "string" || !input.sourceRecordId.trim()) {
    throw new Error("sourceRecordId is required for candidate key");
  }
  const month = normalizeMonthKey(input.monthKey);
  const safeRecordId = sanitizeSourceRecordId(input.sourceRecordId.trim());
  const datesHash = hashStable(normalizeDates(input.dates).join("|"));
  return [
    input.sourceSystem.trim(),
    safeRecordId,
    normalizedHr,
    month,
    input.category,
    datesHash,
  ].join(":");
}

/**
 * A candidate's identity WITHOUT its day set — everything the key joins except the trailing
 * dates hash.
 *
 * WHY THIS EXISTS. The dates hash means a re-collect whose day set changed produces a DIFFERENT
 * candidate_key, so the ledger cannot tell "this is the same finding, recalculated" from "this is a
 * brand new finding". That is why superseded rows carry a NULL superseded_by_candidate_id, and why
 * 21 Super-Admin approvals worth 9,306.42 EGP were retired on a re-collect with no successor:
 * nothing could pair the old row to the new one.
 *
 * Everything before the hash IS stable across re-collects, because `source_record_id` is
 * deterministic in every connector (`vacation:{requestId}:{category}`,
 * `holiday-bridge:{hrId}:{date}`, `{hrId}:{dateIso}` for fingerprint). This is the join that lets a
 * correction be recognised as a correction rather than as a second charge.
 *
 * Splitting on the LAST colon is safe: the hash is always exactly 8 hex characters (hashStable
 * pads), and sanitizeSourceRecordId has already stripped every colon out of the one free-text
 * segment.
 */
export function deductionsCandidateIdentityKey(candidateKey: string): string {
  const key = String(candidateKey ?? "");
  const lastColon = key.lastIndexOf(":");
  if (lastColon <= 0) return key;
  return key.slice(0, lastColon);
}
