// Deductions Governance Center: deterministic candidate-key + normalization helpers.
// Pure functions. No DB I/O. No payroll/leave mutation.

import { canonicalHrIdKey } from "../hr-id.ts";
import type { DeductionType } from "./types.ts";

const MONTH_KEY_PATTERN = /^(\d{4})[-/](\d{1,2})$/;
const DATE_ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function normalizeMonthKey(input: string): string {
  if (typeof input !== "string") {
    throw new Error("monthKey must be a string");
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("monthKey must not be blank");
  }
  const match = MONTH_KEY_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(`monthKey "${input}" is not in YYYY-MM or YYYY/MM form`);
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`monthKey "${input}" has out-of-range year`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`monthKey "${input}" has out-of-range month`);
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

export function buildDeductionCandidateKey(input: {
  sourceModule: string;
  sourceRecordId: string;
  employeeCode: string;
  monthKey: string;
  deductionType: DeductionType;
  dates: readonly string[];
}): string {
  const normalizedHr = canonicalHrIdKey(input.employeeCode);
  if (!normalizedHr) {
    throw new Error("employeeCode is required for candidate key");
  }
  if (typeof input.sourceModule !== "string" || !input.sourceModule.trim()) {
    throw new Error("sourceModule is required for candidate key");
  }
  if (typeof input.sourceRecordId !== "string" || !input.sourceRecordId.trim()) {
    throw new Error("sourceRecordId is required for candidate key");
  }
  const month = normalizeMonthKey(input.monthKey);
  const safeRecordId = sanitizeSourceRecordId(input.sourceRecordId.trim());
  const datesHash = hashStable(normalizeDates(input.dates).join("|"));
  return [
    input.sourceModule.trim(),
    safeRecordId,
    normalizedHr,
    month,
    input.deductionType,
    datesHash,
  ].join(":");
}
