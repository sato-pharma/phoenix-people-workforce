// ─────────────────────────────────────────────────────────────────────────────────────────────
// Which active employees have a bank or insurance detail missing from their record (owner,
// 2026-11-03: "build 6"), as pure functions. Free of Supabase so the client component imports it.
//
// 🔴 A STANDING IS ALL THAT LEAVES THE SERVER. `recordGapRow` reads the account and insurance numbers to
// say whether they exist, and the row it returns holds no number, so none can reach a browser.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { buildEmployeeMasterHref } from "@/lib/employees/employee-master-link";
import { daysBetweenKeys } from "@/lib/hr/talent-acquisition-logic";

/** A number on the record proves the account, whatever the yes-or-no beside it says. */
export type RecordGapBankStanding = "marked_yes_no_number" | "no" | "yes";

/** The status is HR's word and the number can come from an earlier employer, so neither stands for the other. */
export type RecordGapInsuranceStanding = "marked_no" | "marked_yes_no_number" | "not_recorded" | "number_no_status" | "pending" | "yes";

export type RecordGapInsurance = { hasNumber: boolean; standing: RecordGapInsuranceStanding };

export type EmployeeRecordGapRow = {
  bank: RecordGapBankStanding;
  displayName: string;
  gaps: number;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  joinedRecently: boolean;
  lineName: string | null;
  medicalInsurance: RecordGapInsurance;
  payrollEligible: boolean;
  socialInsurance: RecordGapInsurance;
};

export type EmployeeRecordGapsData = {
  activeEmployees: number;
  rows: EmployeeRecordGapRow[];
  todayKey: string;
};

export type RecordGapFilter = "all" | "bank" | "medical" | "social";

export type RecordGapSource = {
  bankAccount: string | null;
  displayName: string;
  hasBankAccount: string | null;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  medicalInsuranceNumber: string | null;
  medicalInsuranceStatus: string | null;
  payrollEligible: boolean;
  socialInsuranceNumber: string | null;
  socialInsuranceStatus: string | null;
};

/** A bank account and an insurance number normally arrive after the first day, so this is said on the row. */
export const RECORD_GAP_RECENT_JOINER_DAYS = 30;

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function wordOf(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function recordGapBankStanding(source: Pick<RecordGapSource, "bankAccount" | "hasBankAccount">): RecordGapBankStanding {
  if (hasText(source.bankAccount)) return "yes";
  return wordOf(source.hasBankAccount) === "yes" ? "marked_yes_no_number" : "no";
}

export function recordGapInsurance(status: string | null | undefined, number: string | null | undefined): RecordGapInsurance {
  const hasNumber = hasText(number);
  const word = wordOf(status);
  if (word === "yes") return { hasNumber, standing: hasNumber ? "yes" : "marked_yes_no_number" };
  if (word === "pending") return { hasNumber, standing: "pending" };
  if (word === "no") return { hasNumber, standing: "marked_no" };
  return { hasNumber, standing: hasNumber ? "number_no_status" : "not_recorded" };
}

export function recordGapRow(source: RecordGapSource, todayKey: string): EmployeeRecordGapRow {
  const bank = recordGapBankStanding(source);
  const socialInsurance = recordGapInsurance(source.socialInsuranceStatus, source.socialInsuranceNumber);
  const medicalInsurance = recordGapInsurance(source.medicalInsuranceStatus, source.medicalInsuranceNumber);
  const hireKey = source.hireDate?.slice(0, 10) ?? null;
  return {
    bank,
    displayName: source.displayName,
    gaps: [bank !== "yes", socialInsurance.standing !== "yes", medicalInsurance.standing !== "yes"].filter(Boolean).length,
    hireDate: hireKey,
    hrId: source.hrId,
    jobTitle: source.jobTitle,
    joinedRecently: hireKey ? daysBetweenKeys(hireKey, todayKey) <= RECORD_GAP_RECENT_JOINER_DAYS : false,
    lineName: source.lineName,
    medicalInsurance,
    payrollEligible: source.payrollEligible,
    socialInsurance,
  };
}

/** Most gaps first, then whoever has been here longest, so a recent joiner still waiting on a bank sits low. */
export function recordGapOrder(left: EmployeeRecordGapRow, right: EmployeeRecordGapRow): number {
  return (
    right.gaps - left.gaps ||
    (left.hireDate ?? "").localeCompare(right.hireDate ?? "") ||
    left.displayName.localeCompare(right.displayName)
  );
}

/** Only the people with something missing; the count of everyone read stays beside them. */
export function buildEmployeeRecordGaps(sources: readonly RecordGapSource[], todayKey: string): EmployeeRecordGapsData {
  return {
    activeEmployees: sources.length,
    rows: sources.map((source) => recordGapRow(source, todayKey)).filter((row) => row.gaps > 0).sort(recordGapOrder),
    todayKey,
  };
}

export function rowHasRecordGap(row: EmployeeRecordGapRow, filter: RecordGapFilter): boolean {
  if (filter === "bank") return row.bank !== "yes";
  if (filter === "social") return row.socialInsurance.standing !== "yes";
  if (filter === "medical") return row.medicalInsurance.standing !== "yes";
  return row.gaps > 0;
}

export function recordGapCounts(rows: readonly EmployeeRecordGapRow[]): Record<RecordGapFilter, number> {
  const count = (filter: RecordGapFilter) => rows.filter((row) => rowHasRecordGap(row, filter)).length;
  return { all: count("all"), bank: count("bank"), medical: count("medical"), social: count("social") };
}

export function recordGapBankWord(standing: RecordGapBankStanding): string {
  if (standing === "yes") return "Yes";
  return standing === "marked_yes_no_number" ? "Marked yes, no account number" : "No";
}

export function recordGapInsuranceWord({ hasNumber, standing }: RecordGapInsurance): string {
  if (standing === "yes") return "Yes";
  if (standing === "marked_yes_no_number") return "Marked yes, no number";
  if (standing === "number_no_status") return "Number on file, status not set";
  if (standing === "not_recorded") return "Not recorded";
  const word = standing === "pending" ? "Pending" : "Marked no";
  return `${word}, ${hasNumber ? "number on file" : "no number"}`;
}

/** HR's own "no" or "pending" may well be right, so only what nobody has recorded reads as a warning. Never red. */
export function recordGapTone(standing: RecordGapBankStanding | RecordGapInsuranceStanding): "muted" | "ok" | "warn" {
  if (standing === "yes") return "ok";
  return standing === "pending" || standing === "marked_no" ? "muted" : "warn";
}

/** Stays in the shell it came from, because the redirect off a bare address is not trusted to carry the person. */
export function recordGapRecordHref(pathname: string | null, hrId: string): string {
  const suffix = "/record-gaps";
  const base = pathname?.endsWith(suffix) ? pathname.slice(0, -suffix.length) : "/employees";
  return buildEmployeeMasterHref(base, "edit", hrId);
}

export function recordGapBankLetterHref(pathname: string | null): string {
  return `${pathname?.startsWith("/hr/") ? "/hr" : ""}/hiring-pack/bank-account-letter`;
}

export function matchesRecordGapSearch(row: EmployeeRecordGapRow, query: string): boolean {
  const words = query.trim().toLowerCase();
  if (!words) return true;
  return [row.displayName, row.jobTitle, row.lineName].some((value) => value?.toLowerCase().includes(words));
}
