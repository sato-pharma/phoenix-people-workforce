import { getRequiredEnv } from "@/lib/env";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST, hasDepartedEmployment } from "@/lib/auth/session-lifecycle";
import {
  normalizePayrollPaymentMode,
  resolveFixedSalaryAmounts,
  type PayrollPaymentMode,
} from "@/lib/payroll/policy";
import { googleGeocodeAddress } from "@/lib/google-maps/server";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { sharedIdentityGroups } from "@/lib/auth/identity-aliases";
import { canonicalHrIdForDisplay, canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getEmployeeCvHrIdSet } from "@/lib/employees/employee-cv";
import { getEmployeePhotoMap } from "@/lib/employees/employee-photo";
import {
  residenceCoordinateColumns,
  residenceGeocodeQuery,
  residenceUnchanged,
} from "@/lib/employees/residence-geocode-policy";
import { employeeRegionFields, resolveRegionByIds } from "@/lib/employees/region-resolver";
import { quotedInList } from "@/lib/supabase/search-filter";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import { classifyEmployeeNode } from "@/lib/workforce-classification";
import { logError } from "@/lib/observability/log";
import { forgetReferenceEmployees } from "@/lib/reference/reference-lists";
import { generateNextHrIdForLine } from "./hr-id-helper";
import { isMissingRequiredManager } from "./hierarchy-governance";
import { isMissingColumnError } from "./missing-column";
import { resolveEmployeeDisplayName } from "./display-name";
import { storedPayFlagsFromRow, type StoredPayFlags } from "./salary-blind-pay-flags";

const hrIdPattern = /^[A-Z0-9][A-Z0-9_-]*$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const activeLifecycleStatuses = new Set(["active", "on_leave"]);
const statusOptions = ["active", "inactive", "on_leave", "terminated", "resigned", "declined_offer"];
const employeeSalaryDetailCategories = new Set([
  "earning",
  "deduction",
  "reference",
  "other",
]);
const employeeSalaryDetailValueTypes = new Set(["amount", "text"]);

export type EmployeeSalaryDetailCategory =
  | "earning"
  | "deduction"
  | "reference"
  | "other";

export type EmployeeSalaryDetailValueType = "amount" | "text";

export type EmployeeSalaryDetail = {
  category: EmployeeSalaryDetailCategory;
  id: string;
  label: string;
  notes: string | null;
  value: string;
  valueType: EmployeeSalaryDetailValueType;
};

export type EmployeeDirectoryRow = {
  areaId: number | null;
  areaName: string | null;
  birthDate: string | null;
  bankName: string | null;
  bankAccount: string | null;
  baseSalary: number | null;
  basicSalary: number | null;
  contractRenewalDate: string | null;
  contractType: string | null;
  createdAt: string;
  crmId: string | null;
  crmUsername: string | null;
  departmentId: number | null;
  departmentName: string | null;
  education: string | null;
  employmentStatus: string | null;
  extraCostOfLiving: number | null;
  fullName: string;
  // Nickname-aware display name (nickname when set, else fullName). Use this
  // for live UI/report rendering; use fullName for legal/payroll documents,
  // persisted workflow audit snapshots, and identity-matching logic.
  displayName: string;
  nickname: string | null;
  gender: string | null;
  fuelAllowance: number | null;
  grossSalary: number | null;
  hasBankAccount: string | null;
  // Whether a CV is on this person's master record — from the cached index in
  // src/lib/employees/employee-cv.ts, never a column on this query. A boolean and not the file
  // name: the directory lists people, and the name of the document is for the panel of the one
  // person somebody opens. It is what the CV filter reads.
  hasCv: boolean;
  // Whether this employee has an uploaded profile photo (from the cached photo
  // map, see src/lib/employees/employee-photo.ts) — lets avatar UI skip the
  // /api/employees/[hrId]/photo request entirely when there's nothing to fetch.
  hasPhoto: boolean;
  // The GOVERNMENT health insurance booklet — دفتر التأمين الصحى الحكومى, which HR calls
  // "استلام بطاقة صحية". Deliberately NOT the company's private medical insurance: that is the
  // medicalInsuranceStatus / medicalInsuranceNumber pair below, and conflating the two would have
  // somebody read a private policy number as a state booklet number.
  healthCardStatus: string | null;
  healthCardNumber: string | null;
  healthCardReceivedDate: string | null;
  // The HR record fields the Employee Master carries since 2026-09-29. Records, not rules: nothing
  // derives a payroll figure, an eligibility or a statutory filing from any of them.
  birthPlace: string | null;
  // THE QUALIFICATION, not the college — `education` above is the college (Science, Pharmacy, Vet).
  qualification: string | null;
  universityName: string | null;
  collegeMajor: string | null;
  seniorYear: string | null;
  contractDuration: string | null;
  probationEndDate: string | null;
  // The day the COMPANY's private medical insurance card was received. The government booklet's
  // own date is healthCardReceivedDate above.
  medicalInsuranceCardReceivedDate: string | null;
  socialInsuranceStartDate: string | null;
  kaabElamaalNumber: string | null;
  kaabElamaalIssuer: string | null;
  kaabElamaalIssueDate: string | null;
  kaabElamaalRefund: string | null;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lastWorkingDate: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  // Seat-continuity key: when this person's manager resigned and has not been
  // replaced, this holds the departed manager's HR_ID (see
  // src/lib/workforce/hierarchy-resolver.ts). Null in the normal case.
  pendingManagerReplacementForHrId: string | null;
  medicalInsurance: number | null;
  medicalInsuranceStatus: string | null;
  medicalInsuranceNumber: string | null;
  mobileNumber: string | null;
  nameAr: string | null;
  nationalId: string | null;
  netSalary: number | null;
  organogramVisible: boolean;
  payrollEligible: boolean;
  salaryPaymentMode: PayrollPaymentMode;
  positionId: number | null;
  positionTitle: string | null;
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
  residenceGeocodeStatus: string | null;
  residenceLatitude: number | null;
  residenceLongitude: number | null;
  regionName: string | null;
  regionCode?: string | null;
  resignationDate: string | null;
  salaryDetails?: EmployeeSalaryDetail[] | null;
  socialInsurance: number | null;
  socialInsuranceStatus: string | null;
  socialInsuranceNumber: string | null;
  socialInsuranceWage: number | null;
  teamId: number | null;
  teamName: string | null;
  taxes: number | null;
  updatedAt: string;
  workEmail: string | null;
};

import {
  closeVacancyOnHire,
  getOpenMedicalRepVacancies,
  getOpenWorkforceVacancies,
  type VacancyLookupRow,
} from "@/lib/employees/vacancy-closer";

export type EmployeeLookupOption = {
  id?: number;
  label: string;
  value: string;
  areaId?: number | null;
  lineId?: number | null;
  positionId?: number | null;
  managerHrId?: string | null;
  departmentId?: number | null;
};

export type EmployeeDirectoryData = {
  employees: EmployeeDirectoryRow[];
  lookups: {
    areas: EmployeeLookupOption[];
    departments: EmployeeLookupOption[];
    lines: EmployeeLookupOption[];
    managers: EmployeeLookupOption[];
    positions: EmployeeLookupOption[];
    teams: EmployeeLookupOption[];
    statuses: EmployeeLookupOption[];
    medicalRepVacancies: VacancyLookupRow[];
    workforceVacancies: VacancyLookupRow[];
  };
  summary: {
    activeEmployees: number;
    employeesWithoutManagers: number;
    totalEmployees: number;
    uniqueAreas: number;
    uniqueLines: number;
  };
};

export type EmployeeMutationInput = {
  areaId?: number | null;
  crmId?: string | null;
  crmUsername?: string | null;
  departmentId?: number | null;
  education?: string | null;
  bankAccount?: string | null;
  bankName?: string | null;
  baseSalary?: number | null;
  basicSalary?: number | null;
  birthDate?: string | null;
  contractType?: string | null;
  gender?: string | null;
  extraCostOfLiving?: number | null;
  employmentStatus?: string | null;
  fuelAllowance?: number | null;
  fullName?: string | null;
  nickname?: string | null;
  grossSalary?: number | null;
  hasBankAccount?: string | null;
  healthCardNumber?: string | null;
  healthCardReceivedDate?: string | null;
  healthCardStatus?: string | null;
  birthPlace?: string | null;
  qualification?: string | null;
  universityName?: string | null;
  collegeMajor?: string | null;
  seniorYear?: string | null;
  contractDuration?: string | null;
  contractRenewalDate?: string | null;
  probationEndDate?: string | null;
  medicalInsuranceCardReceivedDate?: string | null;
  socialInsuranceStartDate?: string | null;
  kaabElamaalNumber?: string | null;
  kaabElamaalIssuer?: string | null;
  kaabElamaalIssueDate?: string | null;
  kaabElamaalRefund?: string | null;
  hireDate?: string | null;
  hrId?: string | null;
  jobTitle?: string | null;
  lineId?: number | null;
  managerHrId?: string | null;
  mobileNumber?: string | null;
  nameAr?: string | null;
  nationalId?: string | null;
  netSalary?: number | null;
  medicalInsurance?: number | null;
  medicalInsuranceStatus?: string | null;
  medicalInsuranceNumber?: string | null;
  originalHrId?: string | null;
  /**
   * The joiner's own private email, typed by him on the offer joining form (2026-10-08). Only a
   * caller that SENDS it writes it: HR's form does not carry it, so an edit there leaves it alone.
   */
  personalEmail?: string | null;
  payrollEligible?: boolean | null;
  positionId?: number | null;
  residenceAddress?: string | null;
  residenceArea?: string | null;
  residenceCity?: string | null;
  regionName?: string | null;
  salaryDetails?: EmployeeSalaryDetail[] | null;
  salaryPaymentMode?: string | null;
  socialInsurance?: number | null;
  socialInsuranceStatus?: string | null;
  socialInsuranceNumber?: string | null;
  socialInsuranceWage?: number | null;
  taxes?: number | null;
  teamId?: number | null;
  workEmail?: string | null;
};

type EmployeeDbRow = {
  area_id: number | null;
  birth_date?: string | null;
  bank_account?: string | null;
  bank_name?: string | null;
  base_salary?: number | null;
  basic_salary?: number | null;
  contract_renewal_date?: string | null;
  contract_type?: string | null;
  created_at: string;
  crm_id: string | null;
  crm_username: string | null;
  department_id: number | null;
  education: string | null;
  employment_status: string | null;
  full_name: string;
  nickname?: string | null;
  gender?: string | null;
  has_bank_account?: string | null;
  health_card_number?: string | null;
  health_card_received_date?: string | null;
  health_card_status?: string | null;
  birth_place?: string | null;
  qualification?: string | null;
  university_name?: string | null;
  college_major?: string | null;
  senior_year?: string | null;
  contract_duration?: string | null;
  probation_end_date?: string | null;
  medical_insurance_card_received_date?: string | null;
  social_insurance_start_date?: string | null;
  kaab_elamaal_number?: string | null;
  kaab_elamaal_issuer?: string | null;
  kaab_elamaal_issue_date?: string | null;
  kaab_elamaal_refund?: string | null;
  extra_cost_of_living?: number | null;
  fuel_allowance?: number | null;
  gross_salary?: number | null;
  hire_date: string | null;
  hr_id: string;
  job_title: string | null;
  last_working_date?: string | null;
  line_id: number | null;
  manager_hr_id: string | null;
  pending_manager_replacement_for_hr_id?: string | null;
  mobile_number: string | null;
  name_ar: string | null;
  national_id?: string | null;
  net_salary?: number | null;
  medical_insurance_number?: string | null;
  medical_insurance?: number | null;
  medical_insurance_status?: string | null;
  organogram_visible?: boolean | null;
  payroll_eligible?: boolean | null;
  payment_mode?: string | null;
  position_id: number | null;
  region_name?: string | null;
  region_code?: string | null;
  resignation_date?: string | null;
  residence_address?: string | null;
  residence_area?: string | null;
  residence_city?: string | null;
  social_insurance?: number | null;
  social_insurance_wage?: number | null;
  social_insurance_status?: string | null;
  social_insurance_number?: string | null;
  team_id: number | null;
  taxes?: number | null;
  updated_at: string;
  work_email: string | null;
};

type LookupRow = {
  code?: string;
  full_name?: string | null;
  hr_id?: string;
  id: number;
  line_id?: number | null;
  name?: string | null;
  nickname?: string | null;
  title?: string | null;
  employment_status?: string | null;
};

type EmployeeCompensationDbRow = {
  employee_hr_id: string;
  extra_cost_of_living: number | null;
  fuel_allowance: number | null;
  gross_salary: number | null;
  medical_insurance: number | null;
  net_salary: number | null;
  payment_mode?: string | null;
  salary_details?: unknown;
  social_insurance: number | null;
  taxes: number | null;
};

type EmployeeResidenceDbRow = {
  employee_hr_id: string;
  geocode_status: string | null;
  residence_address: string | null;
  residence_area: string | null;
  residence_city: string | null;
  residence_latitude: number | null;
  residence_longitude: number | null;
};

type JoinedEmployeeDbRow = EmployeeDbRow & {
  areas?: { name: string | null } | null;
  departments?: { name: string | null } | null;
  employee_compensation?: EmployeeCompensationDbRow | EmployeeCompensationDbRow[] | null;
  lines?: { name: string | null } | null;
  positions?: { title: string | null } | null;
  teams?: { name: string | null } | null;
};

const databaseQueryTimeoutMs = 15000;
const databaseQueryRetryMs = 30000;
const DATABASE_QUERY_MAX_ATTEMPTS = 2;

let directoryCache: {
  data: EmployeeDirectoryData;
  timestamp: number;
} | null = null;

// Shared in-flight directory load. Concurrent callers (e.g. the parallel
// command-center widgets) await this single promise instead of each issuing a
// full directory query, collapsing the N+1 reference fan-out into one load.
let inFlightDirectory: Promise<EmployeeDirectoryData> | null = null;

// 60 s fresh + 30 s refresh-behind (2026-10-23, performance phase 1). The sidebar polls every 30 s, so a 30 s TTL
// reloaded the whole directory — seven reads — on every second poll, around the clock (~4,200 loads a day in the
// edge logs, a floor of ~100 an hour at night). The worst age a caller can see is unchanged at 90 s.
const CACHE_TTL = 60000; // 60 seconds

/**
 * After CACHE_TTL a copy is not thrown away at once: for this much longer it is still handed to the caller while a
 * fresh load runs behind it. The total age any caller can see is therefore CACHE_TTL + this (90 s) — a roster that is
 * a minute and a half old at worst, and never the multi-second wait of a cold load on a poll.
 * A write in this process (`invalidateEmployeeDirectoryCache`) still drops the copy, so every writer that changes a
 * field payroll or an approval chain reads must call it (a pass at probation does). A caller that joins a load already
 * running when the write lands can still be handed its older answer once; it is just never saved into the cache.
 */
export const DIRECTORY_REFRESH_BEHIND_MS = 30000;

export type DirectoryCacheDisposition = "fresh" | "refresh-behind" | "reload";

/** What to do with a cached directory of this age: serve it, serve it and reload behind it, or reload and wait. */
export function directoryCacheDisposition(ageMs: number): DirectoryCacheDisposition {
  if (Number.isNaN(ageMs)) return "reload";
  if (ageMs < CACHE_TTL) return "fresh";
  if (ageMs < CACHE_TTL + DIRECTORY_REFRESH_BEHIND_MS) return "refresh-behind";
  return "reload";
}

// Bumped by every invalidation, so a load that STARTED before a write cannot stamp its older answer over the
// invalidated cache when it finishes.
let directoryGeneration = 0;

/**
 * How old a cached directory may be and still be served when a fresh load FAILS.
 *
 * The fresh path has always been bounded by CACHE_TTL. The failure paths were not bounded at all:
 * they returned `cache.data` on a timeout without looking at `timestamp`, so an entry from minutes
 * or hours ago was handed back as current. The directory carries headcount, managers, job titles
 * and salary figures, and every page that renders them states them as fact — there is nothing on
 * screen that distinguishes "as of now" from "as of this morning".
 *
 * Ten minutes is the judgement: long enough to ride out a transient timeout or a PostgREST schema
 * hiccup without turning a blip into an outage, short enough that nobody makes a decision on a
 * roster that has since changed. Past it we throw, and the pages already render a thrown directory
 * load as a visible "could not load" — which is honest in a way a confidently stale page is not.
 */
export const STALE_CACHE_MAX_AGE = 10 * 60 * 1000; // 10 minutes

/**
 * The age rule on its own, exported so it can be tested without a database.
 *
 * `true` means a cache entry stamped at `timestamp` may stand in for a load that failed at `now`.
 * A future timestamp (a clock step) reads as age 0 and is allowed — refusing there would turn a
 * clock adjustment into an outage, and the entry is by definition not old.
 */
export function mayServeStaleDirectory(timestamp: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(timestamp)) return false;
  return now - timestamp <= STALE_CACHE_MAX_AGE;
}

/**
 * May this cache entry stand in for a load that failed?
 *
 * Returns the data when the entry is inside STALE_CACHE_MAX_AGE, and null otherwise — including
 * when there is no entry at all. Both outcomes are logged, because "the page is showing you
 * something slightly old" and "the page gave up" are each worth seeing in the logs, and neither
 * used to leave any trace whatsoever.
 */
function serveStaleOnFailure<T>(
  entry: { data: T; timestamp: number } | null | undefined,
  context: { surface: string; error: unknown },
): T | null {
  if (!entry) return null;
  const now = Date.now();
  const ageMs = now - entry.timestamp;
  if (mayServeStaleDirectory(entry.timestamp, now)) {
    console.log("Employee directory load failed; serving a recent cached copy", {
      level: "warning",
      tags: { component: "employee-directory", action: context.surface },
      extra: { ageMs, maxAgeMs: STALE_CACHE_MAX_AGE, message: employeeDirectoryErrorMessage(context.error) },
    });
    return entry.data;
  }
  logError("Employee directory load failed and the cached copy is too old to stand in for it", {
    labels: { event: "employee_directory_stale_cache_refused", component: "employee-directory", action: context.surface },
    error: context.error,
  });
  return null;
}

// Same TTL + in-flight-dedupe pattern as directoryCache/inFlightDirectory above, applied to
// getEmployeeDirectoryRows(). Keyed by includeInactive since callers legitimately need two
// different result sets (active-only vs. full history) that must never be served
// interchangeably — see double-visit-analytics/service.ts for a callsite that depends on the
// includeInactive:true set containing resigned/terminated employees.
const directoryRowsCache = new Map<boolean, { data: EmployeeDirectoryRow[]; timestamp: number }>();
const inFlightDirectoryRows = new Map<boolean, Promise<EmployeeDirectoryRow[]>>();

function isClassifiedActiveEmployee(employee: DirectoryMembershipFields) {
  return classifyEmployeeNode({ ...employee }).eligible_for_headcount;
}

export function invalidateEmployeeDirectoryCache() {
  directoryGeneration += 1;
  directoryCache = null;
  directoryRowsCache.clear();
  invalidateReferenceLists();
  // The minute-old employee reference list (src/lib/reference/reference-lists.ts) answers the same
  // question as this cache — "who is in the company, where are they placed" — so it is dropped by
  // the same call rather than by a second one every writer would have to remember. Fourteen call
  // sites already invalidate here: the importer, access provisioning, the probation decision, every
  // resignation path and this module's own writes. One line covers all of them, and the next one
  // someone adds.
  forgetReferenceEmployees("employee directory invalidated");
}

function normalizeHrId(value: string | null | undefined) {
  return canonicalHrIdForDisplay(value);
}

function normalizeIdentityText(value: string | null | undefined) {
  return compact(value)?.toLowerCase() ?? "";
}

function normalizeLifecycleStatus(value: string | null | undefined) {
  return compact(value)?.toLowerCase() ?? "active";
}

export function isActiveLifecycleStatus(value: string | null | undefined) {
  return activeLifecycleStatuses.has(normalizeLifecycleStatus(value));
}

// System/console accounts never belong in the employee directory or organogram. Matched by HR_ID
// first — every declared system-admin alias plus the RLS sandbox account — with the name+title
// check kept as a fallback for rows that predate the alias list.
//
// `normalizeHrId` returns a LOWERCASE key, so the previous "ADMIN-HR"/"RLS-ADMIN-HR" comparisons
// here could never match and the fallback was doing all the work on its own.
const systemAdminDirectoryHrIdKeys = new Set(
  [...sharedIdentityGroups.flatMap((group) => group.aliasHrIds), "RLS-ADMIN-HR"]
    .map((hrId) => normalizeHrId(hrId))
    .filter((hrId): hrId is string => Boolean(hrId)),
);

function isSystemAdminDirectoryEmployee(employee: DirectoryMembershipFields) {
  const hrId = normalizeHrId(employee.hrId);

  return (
    (hrId !== null && systemAdminDirectoryHrIdKeys.has(hrId)) ||
    (normalizeIdentityText(employee.fullName) === "phoenix system administrator" &&
      normalizeIdentityText(employee.jobTitle) === "system administrator")
  );
}

function normalizeYesNo(value: string | null | undefined) {
  const normalized = compact(value)?.toLowerCase();
  return normalized === "yes" || normalized === "no" ? normalized : null;
}

function normalizeEnrollmentStatus(value: string | null | undefined) {
  const normalized = compact(value)?.toLowerCase();
  return normalized === "yes" || normalized === "no" || normalized === "pending"
    ? normalized
    : null;
}

export function isActiveDirectoryEmployee(employee: DirectoryMembershipFields) {
  return (
    isActiveLifecycleStatus(employee.employmentStatus) &&
    employee.organogramVisible !== false &&
    !isSystemAdminDirectoryEmployee(employee) &&
    isClassifiedActiveEmployee(employee)
  );
}

/**
 * The last day a departed employee could still have worked: the LATER of the last working date and
 * the resignation date, or null when the row carries neither.
 *
 * The later of the two deliberately. When a record holds both and they differ, the later one is the
 * day the person was still at work, and a surface that cut at the earlier one would drop someone who
 * had not left yet — the whole defect {@link isWithinNoticePeriod} exists to stop.
 */
export function employeeExitDay(employee: Pick<EmployeeDirectoryRow, "lastWorkingDate" | "resignationDate">): string | null {
  const days = [employee.lastWorkingDate, employee.resignationDate]
    .map((value) => String(value ?? "").slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();
  return days.at(-1) ?? null;
}

/**
 * A departed employee whose exit day has NOT passed — someone serving out a notice period: still at
 * work, still logging visits, and already carrying a resignation row.
 *
 * 🔴 THE CUT IS THE RESIGNATION DATE, NEVER THE SUBMISSION DATE (owner, 2026-10-23: "drop after his
 * resignation date not submission date"). `employees.employment_status` flips to `resigned` and
 * `organogram_visible` to false the moment a resignation is SUBMITTED, so every surface built on
 * {@link isActiveDirectoryEmployee} loses the person while they are still working — measured that day
 * on a Medical Representative whose resignation was submitted on 18 October for a last working day of
 * 31 October, who had already dropped off the Private Calendar while logging 10 and 12 customer
 * visits on the 21st and the 22nd.
 *
 * A departed row carrying NEITHER date is not covered: there is no day to compare, and treating that
 * as open-ended would quietly restore the whole inactive roster to every caller.
 *
 * It says nothing about whether those days should be CHARGED. The no-activity and deduction engines
 * keep their own active-only roster on purpose, and widening this predicate does not widen theirs.
 */
export function isWithinNoticePeriod(employee: EmployeeDirectoryRow, onDate: string): boolean {
  if (!hasDepartedEmployment(employee.employmentStatus)) return false;
  if (isSystemAdminDirectoryEmployee(employee)) return false;
  const day = String(onDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const exit = employeeExitDay(employee);
  return exit !== null && exit >= day;
}

// ── Names only, for a caller that holds HR ids and owes the reader names ─────────────────────────

/**
 * Exactly the fields that decide whether somebody is IN the employee directory.
 *
 * A Pick rather than the whole row, so the lean name roster below cannot drift from the real
 * filter: add a field to this membership rule and the roster's own select stops compiling until it
 * reads that field too.
 */
export type DirectoryMembershipFields = Pick<
  EmployeeDirectoryRow,
  | "hrId"
  | "fullName"
  | "jobTitle"
  | "employmentStatus"
  | "organogramVisible"
  | "payrollEligible"
  | "positionTitle"
  | "lineName"
>;

/** An HR id to match on and the name to print — all a `liveEmployeeName`-style lookup ever reads. */
export type EmployeeNameRosterRow = Pick<EmployeeDirectoryRow, "hrId" | "displayName">;

const NAME_ROSTER_SELECT = [
  "hr_id,full_name,nickname,job_title,employment_status,payroll_eligible,organogram_visible,position_id,line_id",
  "positions!employees_position_id_fkey(title)",
  "lines!employees_line_id_fkey(name)",
].join(",");

type NameRosterDbRow = {
  hr_id: string;
  full_name: string;
  nickname?: string | null;
  job_title?: string | null;
  employment_status?: string | null;
  payroll_eligible?: boolean | null;
  organogram_visible?: boolean | null;
  position_id?: number | null;
  line_id?: number | null;
  positions?: { title?: string | null } | Array<{ title?: string | null }> | null;
  lines?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

/** PostgREST hands back a to-one embed as an object or a one-element array, depending on how it resolves. */
function embeddedText(embed: unknown, key: "title" | "name"): string | null {
  const one = Array.isArray(embed) ? embed[0] : embed;
  if (!one || typeof one !== "object") return null;
  return compact((one as Record<string, unknown>)[key] as string | null | undefined) ?? null;
}

let nameRosterCache: { data: EmployeeNameRosterRow[]; timestamp: number; generation: number } | null = null;
let inFlightNameRoster: Promise<EmployeeNameRosterRow[]> | null = null;

function directoryNameRoster(data: EmployeeDirectoryData): EmployeeNameRosterRow[] {
  return data.employees.map((employee) => ({ hrId: employee.hrId, displayName: employee.displayName }));
}

async function fetchEmployeeNameRoster(): Promise<EmployeeNameRosterRow[]> {
  let rows: NameRosterDbRow[];
  try {
    rows = await supabaseRest<NameRosterDbRow[]>(
      `employees?${new URLSearchParams({ select: NAME_ROSTER_SELECT, order: "full_name.asc" })}`,
    );
  } catch (error) {
    // A LAXER FILTER IS THE ONE FALLBACK THIS MUST NEVER TAKE. Without the two embeds a vacancy or
    // placeholder node named only in its position title classifies as a live employee and starts
    // supplying a name the directory withholds. Pay for the full directory instead.
    console.log("Employee name roster select failed; falling back to the full directory", {
      level: "warning",
      tags: { component: "employee-directory", action: "fetchEmployeeNameRoster" },
      extra: { message: employeeDirectoryErrorMessage(error) },
    });
    return directoryNameRoster(await getEmployeeDirectory());
  }

  const roster: EmployeeNameRosterRow[] = [];
  for (const row of rows) {
    const active = isActiveLifecycleStatus(row.employment_status);
    const candidate: DirectoryMembershipFields = {
      hrId: row.hr_id,
      fullName: row.full_name,
      jobTitle: row.job_title ?? null,
      employmentStatus: row.employment_status ?? null,
      // Both defaults are the directory's own (see the row mapping in fetchEmployeeDirectory): a
      // NULL column means "whatever the lifecycle status implies", never false.
      organogramVisible: row.organogram_visible ?? active,
      payrollEligible: row.payroll_eligible ?? active,
      positionTitle: row.position_id ? embeddedText(row.positions, "title") : null,
      lineName: row.line_id ? embeddedText(row.lines, "name") : null,
    };
    if (!isActiveDirectoryEmployee(candidate)) continue;
    roster.push({
      hrId: row.hr_id,
      displayName: resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
    });
  }
  return roster;
}

/**
 * The directory's HR ids and display names — one small query instead of twelve.
 *
 * 🔴 WHY THIS EXISTS BESIDE getEmployeeDirectory(), AND WHY IT IS NOT A SECOND FILTER.
 * `getEmployeeDirectory()` is twelve reads: a ~70-column `employees` select with six embedded FK
 * joins (the whole of `employee_compensation` among them), then residence, pending-manager-
 * replacement, photo, CV and five lookup loads side by side. A caller that only ever asks it "what
 * is this person called" pays every one of them — and `src/lib/action-center/service.ts` had three
 * such callers, one of them loading the directory to name a SINGLE deep-linked item.
 *
 * 🔴 MEMBERSHIP IS NOT RE-DECIDED HERE. The rows run through the same `isActiveDirectoryEmployee`
 * the directory itself filters on (`directory-active-filter-gate`: a module that bypasses the
 * directory misses that gate), and here it matters more than it looks — a resigned employee is
 * absent from the directory ON PURPOSE, so a resignation item deliberately falls back to the name
 * stored on the request. A roster that quietly included leavers would RENAME people on the one
 * screen where they are leaving.
 *
 * 🔴 AND IT IS NOT `namesByHrId`, WHICH WOULD LOSE NAMES HERE. That helper filters by id, so it
 * matches on `canonicalHrIdKey` alone; the lookup these callers use is `hrIdsMatch`, which ALSO
 * matches with punctuation stripped (`B-10` ≡ `B10`), and `hrIdLookupKeys` never generates that
 * spelling. Reading the roster whole keeps the looser match intact and needs no `.in("hr_id", …)`
 * filter at all, which is the trap that rule guards.
 *
 * Same name for the same person as the directory, the same people in it, the same 30-second TTL and
 * in-flight de-duplication, and `invalidateEmployeeDirectoryCache()` drops this too — it shares the
 * directory's generation counter.
 */
export async function getEmployeeNameRoster(): Promise<EmployeeNameRosterRow[]> {
  // A directory somebody else already paid for answers this for free, and answers it identically.
  if (directoryCache && directoryCacheDisposition(Date.now() - directoryCache.timestamp) === "fresh") {
    return directoryNameRoster(directoryCache.data);
  }
  if (
    nameRosterCache &&
    nameRosterCache.generation === directoryGeneration &&
    Date.now() - nameRosterCache.timestamp < CACHE_TTL
  ) {
    return nameRosterCache.data;
  }
  if (!inFlightNameRoster) {
    const generation = directoryGeneration;
    inFlightNameRoster = fetchEmployeeNameRoster()
      .then((data) => {
        // A load that started before an invalidation must not put its older answer back.
        if (generation === directoryGeneration) {
          nameRosterCache = { data, timestamp: Date.now(), generation };
        }
        return data;
      })
      .catch((error) => {
        const stale = serveStaleOnFailure(nameRosterCache, { surface: "getEmployeeNameRoster", error });
        if (stale) return stale;
        throw error;
      })
      .finally(() => {
        inFlightNameRoster = null;
      });
  }
  return inFlightNameRoster;
}

function activeStatusOptions(employees: EmployeeDirectoryRow[]) {
  const statuses = new Set(
    employees
      .map((employee) => normalizeLifecycleStatus(employee.employmentStatus))
      .filter((status) => activeLifecycleStatuses.has(status)),
  );

  return Array.from(statuses.size ? statuses : activeLifecycleStatuses)
    .sort()
    .map((status) => ({
      label: status.replace(/_/g, " "),
      value: status,
    }));
}

export function employeeDirectoryErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isEmployeeDirectoryEnvMissing(error: unknown) {
  const message = employeeDirectoryErrorMessage(error);

  return (
    message.includes("NEXT_PUBLIC_SUPABASE_URL is required") ||
    message.includes("SUPABASE_SERVICE_ROLE_KEY is required")
  );
}

export function isEmployeeDirectorySchemaMissing(error: unknown) {
  const message = employeeDirectoryErrorMessage(error).toLowerCase();

  return (
    message.includes("could not find the table") ||
    (message.includes("column") && message.includes("does not exist")) ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function isMissingRelationMessage(error: unknown) {
  return isEmployeeDirectorySchemaMissing(error);
}

export function isEmployeeDirectoryTimeout(error: unknown) {
  return employeeDirectoryErrorMessage(error).toLowerCase().includes("timed out");
}

function compact(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function normalizeEmployeeSalaryDetails(value: unknown): EmployeeSalaryDetail[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const row = item as Record<string, unknown>;
      const label =
        compact(typeof row.label === "string" ? row.label : null) ??
        compact(typeof row.name === "string" ? row.name : null);
      const notes = compact(typeof row.notes === "string" ? row.notes : null);
      const rawValue =
        row.value === null || row.value === undefined ? "" : String(row.value).trim();
      const category = employeeSalaryDetailCategories.has(String(row.category))
        ? (String(row.category) as EmployeeSalaryDetailCategory)
        : "other";
      const valueType = employeeSalaryDetailValueTypes.has(String(row.valueType))
        ? (String(row.valueType) as EmployeeSalaryDetailValueType)
        : (numberOrNull(rawValue) !== null ? "amount" : "text");

      if (!label && !rawValue && !notes) {
        return null;
      }

      return {
        category,
        id: compact(typeof row.id === "string" ? row.id : null) ?? `salary-detail-${index + 1}`,
        label: label ?? (valueType === "amount" ? "Salary item" : "Salary note"),
        notes,
        value: rawValue,
        valueType,
      };
    })
    .filter((item): item is EmployeeSalaryDetail => item !== null);
}

function compensationSelect(includeSalaryDetails = true) {
  const fields = [
    "employee_hr_id",
    "net_salary",
    "social_insurance",
    "taxes",
    "medical_insurance",
    "fuel_allowance",
    "extra_cost_of_living",
    "gross_salary",
    "payment_mode",
  ];

  if (includeSalaryDetails) {
    fields.push("salary_details");
  }

  return fields.join(",");
}

function textInFilter(values: string[]) {
  return `in.(${quotedInList(values)})`;
}

async function supabaseRest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/g, "");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  let lastError: unknown;

  for (let attempt = 0; attempt < DATABASE_QUERY_MAX_ATTEMPTS; attempt++) {
    const timeoutMs =
      attempt === 0 ? databaseQueryTimeoutMs : databaseQueryRetryMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${url}/rest/v1/${path}`, {
        ...init,
        cache: "no-store",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const isTransientServerError = [502, 503, 504].includes(response.status);
        if (isTransientServerError && attempt < DATABASE_QUERY_MAX_ATTEMPTS - 1) {
          lastError = new Error(
            typeof payload?.message === "string"
              ? payload.message
              : `Supabase request failed with ${response.status}.`,
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        const message =
          typeof payload?.message === "string"
            ? payload.message
            : `Supabase request failed with ${response.status}.`;
        const err = new Error(message);
        (err as Error & { pgrst_code?: string }).pgrst_code =
          typeof payload?.code === "string" ? payload.code : undefined;
        throw err;
      }

      return payload as T;
    } catch (error) {
      lastError = error;
      const isTimeout =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.toLowerCase().includes("timed out"));
      const isSchemaCache =
        error instanceof Error &&
        (error as Error & { pgrst_code?: string }).pgrst_code === "PGRST002";
      const shouldRetry =
        (isTimeout || isSchemaCache) && attempt < DATABASE_QUERY_MAX_ATTEMPTS - 1;

      if (!shouldRetry) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Supabase request timed out.");
        }
        throw error;
      }

      // Use a longer back-off for schema cache errors so PostgREST has time to reload.
      const backOffMs = isSchemaCache ? 800 : 250;
      await new Promise((resolve) => setTimeout(resolve, backOffMs));
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastError instanceof Error && lastError.name === "AbortError") {
    throw new Error("Supabase request timed out.");
  }
  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Supabase request failed.");
}

function uniqueNumberValues(rows: EmployeeDbRow[], key: keyof EmployeeDbRow) {
  return Array.from(
    new Set(
      rows
        .map((row) => row[key])
        .filter((value): value is number => typeof value === "number"),
    ),
  );
}

function uniqueTextValues(rows: EmployeeDbRow[], key: keyof EmployeeDbRow) {
  return Array.from(
    new Set(
      rows
        .map((row) => row[key])
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );
}

/**
 * The reference lists — departments, lines, areas, positions, teams — read once per REFERENCE_LIST_TTL_MS per
 * process and shared by every directory load (performance phase 1, 2026-10-23). They are org-wide labels with no
 * per-viewer visibility, so one copy serves everyone; the edge logs had them re-read thousands of times a day.
 * `invalidateEmployeeDirectoryCache()` drops them with the directory, and a load a write overtook is never kept.
 */
export const REFERENCE_LIST_TTL_MS = 60_000;

const referenceListCache = new Map<string, { value: unknown; storedAt: number }>();
const referenceListInFlight = new Map<string, Promise<unknown>>();
let referenceListGeneration = 0;

async function cachedReferenceList<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = referenceListCache.get(key);
  if (cached && Date.now() - cached.storedAt < REFERENCE_LIST_TTL_MS) return cached.value as T;

  let pending = referenceListInFlight.get(key) as Promise<T> | undefined;
  if (!pending) {
    const startedGeneration = referenceListGeneration;
    pending = load().then((value) => {
      if (startedGeneration === referenceListGeneration) {
        referenceListCache.set(key, { value, storedAt: Date.now() });
      }
      return value;
    });
    referenceListInFlight.set(key, pending);
    pending.then(
      () => referenceListInFlight.delete(key),
      () => referenceListInFlight.delete(key),
    );
  }
  return pending;
}

function invalidateReferenceLists() {
  referenceListGeneration += 1;
  referenceListCache.clear();
}

/** Every row of one reference table as id → label, shared through the reference-list cache. */
function loadReferenceNameMap(table: string, label: string) {
  return cachedReferenceList(`names:${table}:${label}`, async () => {
    const rows = await supabaseRest<LookupRow[]>(`${table}?${new URLSearchParams({ select: `id,${label}` })}`);
    return new Map(
      rows.map((row) => [
        row.id,
        String(label === "title" ? row.title ?? "" : row.name ?? ""),
      ]),
    );
  });
}

async function loadLookup(table: string, ids: number[], label = "name") {
  if (ids.length === 0) {
    return new Map<number, string>();
  }

  // The same answer the old `id=in.(...)` read gave — the asked ids that exist — cut from the shared full list.
  const all = await loadReferenceNameMap(table, label);
  const names = new Map<number, string>();
  for (const id of ids) {
    const name = all.get(id);
    if (name !== undefined) names.set(id, name);
  }
  return names;
}

async function loadAllOptions(table: string, label = "name") {
  const options = await cachedReferenceList(`options:${table}:${label}`, () => fetchAllOptions(table, label));
  // Fresh option objects per load: a directory caller may decorate its lookups without reaching the shared copy.
  return options.map((option) => ({ ...option }));
}

async function fetchAllOptions(table: string, label = "name") {
  if (table === "departments") {
    const params = new URLSearchParams({
      select: `id,${label},is_active`,
      order: `${label}.asc`,
    });

    try {
      const rows = await supabaseRest<Array<LookupRow & { is_active?: boolean | null }>>(`${table}?${params}`);

      return rows
        .filter((row) => row.is_active !== false)
        .map((row) => ({
          id: row.id,
          label: String(label === "title" ? row.title ?? "" : row.name ?? ""),
          value: String(row.id),
        }));
    } catch (error) {
      const message = employeeDirectoryErrorMessage(error).toLowerCase();
      if (!message.includes("is_active") && !message.includes("schema cache")) {
        throw error;
      }
    }
  }

  const select =
    table === "areas"
      ? `id,${label},line_id,is_active`
      : table === "teams"
        ? `id,${label},area_id,is_active`
        : `id,${label}`;
  const params = new URLSearchParams({
    select,
    order: `${label}.asc`,
  });
  let rows: Array<LookupRow & { area_id?: number | null; is_active?: boolean | null }>;

  try {
    rows = await supabaseRest<Array<LookupRow & { area_id?: number | null; is_active?: boolean | null }>>(`${table}?${params}`);
  } catch (error) {
    const message = employeeDirectoryErrorMessage(error).toLowerCase();
    if (table !== "teams") throw error;

    const isColumnIssue = message.includes("is_active") || message.includes("area_id") || message.includes("schema cache");
    const isTableMissing = !isColumnIssue && isMissingRelationMessage(error);

    if (isTableMissing) return [];
    if (!isColumnIssue) throw error;

    const fallbackParams = new URLSearchParams({
      select: `id,${label}`,
      order: `${label}.asc`,
    });
    try {
      rows = await supabaseRest<LookupRow[]>(`${table}?${fallbackParams}`);
    } catch (fallbackError) {
      if (isMissingRelationMessage(fallbackError)) return [];
      throw fallbackError;
    }
  }

  return rows
    .filter((row) => row.is_active !== false)
    .map((row) => ({
      areaId: row.area_id ?? null,
      id: row.id,
      label: String(label === "title" ? row.title ?? "" : row.name ?? ""),
      lineId: row.line_id ?? null,
      value: String(row.id),
    }));
}

/**
 * Manager display names, built from the employee rows the directory load ALREADY holds (performance phase 1,
 * 2026-10-23). The directory selects every employee, so every manager is in `rows`; the separate
 * `employees?hr_id=in.(...)` re-read this replaced cost ~4,200 calls a day at ~374 ms for names already in hand.
 * Keys match the old lookup: the raw hr_id, its normalized form and every `hrIdLookupKeys` variant.
 */
export function managerNamesFromEmployeeRows(
  rows: ReadonlyArray<{ hr_id: string; full_name?: string | null; nickname?: string | null; employment_status?: string | null }>,
) {
  const names = new Map<string, string>();
  rows.forEach((row) => {
    // A leaver's name is never surfaced as a live manager label (owner, 2026-09-29: a resigned/
    // terminated employee shows only in the Resignations module). The row still nests by manager_hr_id
    // — only the NAME is withheld — so an active report of a departed manager renders no manager name
    // until the seat is reassigned (pendingManagerReplacementForHrId already flags that gap).
    if (!isActiveLifecycleStatus(row.employment_status)) return;
    const hrId = String(row.hr_id);
    const name = resolveEmployeeDisplayName(String(row.full_name ?? ""), row.nickname, hrId);
    names.set(hrId, name);
    const normalizedHrId = normalizeHrId(hrId);
    if (normalizedHrId) names.set(normalizedHrId, name);
    hrIdLookupKeys(hrId).forEach((key) => names.set(key, name));
  });

  return names;
}

/** One write path's manager lookup (a new hire's vacancy close): a fresh read, never the directory cache. */
async function loadManagerNames(hrIds: string[]) {
  const lookupHrIds = Array.from(
    new Set(
      hrIds
        .flatMap((hrId) => {
          const trimmed = compact(hrId);
          const normalized = normalizeHrId(hrId);
          return [
            ...hrIdLookupKeys(hrId),
            trimmed,
            normalized,
            trimmed?.toLowerCase(),
          ].filter(Boolean) as string[];
        })
        .filter(Boolean),
    ),
  );

  if (lookupHrIds.length === 0) {
    return new Map<string, string>();
  }

  const params = new URLSearchParams({
    select: "hr_id,full_name,nickname,employment_status",
    hr_id: textInFilter(lookupHrIds),
  });
  const rows = await supabaseRest<Array<{ hr_id: string; full_name?: string | null; nickname?: string | null; employment_status?: string | null }>>(
    `employees?${params}`,
  );
  return managerNamesFromEmployeeRows(rows);
}

function managerNameFromLookup(managerNames: Map<string, string>, managerHrId: string | null | undefined) {
  if (!managerHrId) return null;
  for (const key of hrIdLookupKeys(managerHrId)) {
    const name = managerNames.get(key);
    if (name) return name;
  }
  return managerNames.get(managerHrId) ?? managerNames.get(normalizeHrId(managerHrId) ?? "") ?? null;
}

async function loadCompensationByHrId(hrIds: string[]) {
  if (hrIds.length === 0) {
    return new Map<string, EmployeeCompensationDbRow>();
  }

  const params = new URLSearchParams({
    select: compensationSelect(),
    employee_hr_id: textInFilter(hrIds),
  });

  try {
    const rows = await supabaseRest<EmployeeCompensationDbRow[]>(
      `employee_compensation?${params}`,
    );

    return new Map(rows.map((row) => [row.employee_hr_id, row]));
  } catch (error) {
    // Only when one of those two columns is genuinely ABSENT. Any other failure that merely names
    // them — a constraint, a bad value, a permission denial — must not be answered by retrying
    // without them, which would hand back rows with the payment mode silently missing.
    if (
      isMissingColumnError(error, "payment_mode") ||
      isMissingColumnError(error, "salary_details")
    ) {
      console.log("Employee compensation payment_mode/salary_details column missing, retrying without it (schema cache)", {
        level: "warning",
        tags: { component: "employee-directory", action: "loadCompensationByHrId" },
        extra: { message: employeeDirectoryErrorMessage(error) },
      });

      const fallbackParams = new URLSearchParams({
        select: compensationSelect(false).replace(",payment_mode", ""),
        employee_hr_id: textInFilter(hrIds),
      });
      const rows = await supabaseRest<EmployeeCompensationDbRow[]>(
        `employee_compensation?${fallbackParams}`,
      );

      return new Map(rows.map((row) => [row.employee_hr_id, row]));
    }

    if (isMissingRelationMessage(error)) {
      return new Map<string, EmployeeCompensationDbRow>();
    }

    throw error;
  }
}

/**
 * One employee's payment mode and payroll eligibility, read FRESH from the database (never the
 * directory cache) and derived exactly as the directory derives them. Null when the employee is
 * not there. The salary-blind seat's save writes these straight back (salary-blind-pay-flags.ts),
 * so a stale read would quietly undo a change the HR Manager had just made.
 */
export async function readStoredPayFlags(hrId: string): Promise<StoredPayFlags | null> {
  const storedHrId = normalizeHrId(hrId);
  if (!storedHrId) return null;

  const rows = await supabaseRest<
    Array<{ employment_status: string | null; payment_mode: string | null; payroll_eligible: boolean | null }>
  >(`employees?hr_id=eq.${encodeURIComponent(storedHrId)}&select=employment_status,payment_mode,payroll_eligible`);
  if (rows.length === 0) return null;

  const compensation = (await loadCompensationByHrId([storedHrId])).get(storedHrId);
  return storedPayFlagsFromRow(rows[0], compensation?.payment_mode);
}

const PENDING_REPLACEMENT_COLUMN = "pending_manager_replacement_for_hr_id";

/**
 * The main employee select, asked WITH the seat-continuity column first (performance phase 1, 2026-10-23): the
 * separate `hr_id=in.(every employee)` read it replaced cost ~4,200 calls a day at ~388 ms. Only a genuinely
 * absent column (`isMissingColumnError`) re-asks without it; the caller then falls back to the defensive
 * loader below, so an environment without the column still degrades to an empty map exactly as before.
 */
async function selectEmployeesWithPendingReplacement<T>(
  path: (withPendingReplacement: boolean) => string,
): Promise<{ rows: T[]; pendingReplacementInRows: boolean }> {
  try {
    return { rows: await supabaseRest<T[]>(path(true)), pendingReplacementInRows: true };
  } catch (error) {
    if (!isMissingColumnError(error, PENDING_REPLACEMENT_COLUMN)) throw error;
    return { rows: await supabaseRest<T[]>(path(false)), pendingReplacementInRows: false };
  }
}

/** The seat-continuity map, read off rows that already carry the column. Keyed by raw `hr_id`, like the loader. */
function pendingReplacementFromRows(rows: ReadonlyArray<{ hr_id: string }>) {
  return new Map(
    rows.map((row) => [
      row.hr_id,
      (row as { pending_manager_replacement_for_hr_id?: string | null }).pending_manager_replacement_for_hr_id ?? null,
    ]),
  );
}

/**
 * Defensive loader for the seat-continuity column
 * `pending_manager_replacement_for_hr_id`. Fetched separately (not in the main
 * employee select) so the directory keeps working in any environment/project
 * where the column has not been provisioned yet — there it simply degrades to an
 * empty map and the seat-continuity feature no-ops. Keyed by raw `hr_id`.
 */
async function loadPendingManagerReplacementByHrId(hrIds: string[]) {
  const cleanedHrIds = Array.from(new Set(hrIds.map(compact).filter(Boolean))) as string[];
  if (cleanedHrIds.length === 0) {
    return new Map<string, string | null>();
  }

  const params = new URLSearchParams({
    select: "hr_id,pending_manager_replacement_for_hr_id",
    hr_id: textInFilter(cleanedHrIds),
  });

  try {
    const rows = await supabaseRest<
      Array<{ hr_id: string; pending_manager_replacement_for_hr_id?: string | null }>
    >(`employees?${params}`);

    return new Map(
      rows.map((row) => [row.hr_id, row.pending_manager_replacement_for_hr_id ?? null]),
    );
  } catch (error) {
    if (isEmployeeDirectorySchemaMissing(error)) {
      return new Map<string, string | null>();
    }
    throw error;
  }
}

async function loadResidenceByHrId(hrIds: string[]) {
  const cleanedHrIds = Array.from(new Set(hrIds.map(compact).filter(Boolean))) as string[];
  if (cleanedHrIds.length === 0) {
    return new Map<string, EmployeeResidenceDbRow>();
  }

  try {
    const rows = await supabaseRest<EmployeeResidenceDbRow[]>(
      `employee_locations?employee_hr_id=${encodeURIComponent(
        textInFilter(cleanedHrIds),
      )}&select=employee_hr_id,residence_address,residence_city,residence_area,residence_latitude,residence_longitude,geocode_status`,
    );

    return new Map(
      rows.map((row) => [row.employee_hr_id.trim().toUpperCase(), row]),
    );
  } catch (error) {
    if (isMissingRelationMessage(error)) {
      return new Map<string, EmployeeResidenceDbRow>();
    }
    throw error;
  }
}

// De-duplicate concurrent loads: callers that arrive while a fetch is already
// running share the same promise instead of each issuing their own full
// directory query. This is what collapses the parallel command-center widget
// fan-out (~10 reference-table reads per widget) down to a single load.
function loadDirectoryShared(): Promise<EmployeeDirectoryData> {
  if (!inFlightDirectory) {
    const generation = directoryGeneration;
    inFlightDirectory = fetchEmployeeDirectory()
      .then((result) => {
        // A write that invalidated the cache while this load was running must not be undone by it.
        if (generation === directoryGeneration) {
          directoryCache = {
            data: result,
            timestamp: Date.now(),
          };
        }
        return result;
      })
      .finally(() => {
        inFlightDirectory = null;
      });
  }
  return inFlightDirectory;
}

export async function getEmployeeDirectory(): Promise<EmployeeDirectoryData> {
  const now = Date.now();
  if (directoryCache) {
    const disposition = directoryCacheDisposition(now - directoryCache.timestamp);
    if (disposition === "fresh") return directoryCache.data;
    if (disposition === "refresh-behind") {
      // Answer now from the copy that is only seconds past its TTL and reload for the NEXT caller. A sidebar poll
      // every 30 s used to land just after the 30 s TTL expired and wait out the whole multi-table load itself.
      loadDirectoryShared().catch(() => undefined);
      return directoryCache.data;
    }
  }

  try {
    return await loadDirectoryShared();
  } catch (error) {
    // The ONE place that decides whether a stale copy may answer for a failed load.
    //
    // It is no longer narrowed to `isEmployeeDirectoryTimeout`: the fallback-select branch inside
    // fetchEmployeeDirectory now throws instead of quietly returning stale rows into the success
    // path, and that branch's old behaviour — serve what we have rather than crash the page — is
    // preserved here, where it is age-bounded and cannot re-stamp the cache as fresh.
    const stale = serveStaleOnFailure(directoryCache, { surface: "getEmployeeDirectory", error });
    if (stale) return stale;

    throw error;
  }
}

async function fetchEmployeeDirectory(): Promise<EmployeeDirectoryData> {
  const baseEmployeeSelect =
    "hr_id,full_name,nickname,name_ar,national_id,gender,has_bank_account,bank_name,bank_account,health_card_status,health_card_number,health_card_received_date,social_insurance_status,social_insurance_number,medical_insurance_status,medical_insurance_number,basic_salary,base_salary,gross_salary,net_salary,fuel_allowance,extra_cost_of_living,medical_insurance,social_insurance,social_insurance_wage,taxes,payment_mode,residence_address,residence_city,residence_area,contract_type,contract_renewal_date,contract_duration,probation_end_date,birth_place,qualification,university_name,college_major,senior_year,medical_insurance_card_received_date,social_insurance_start_date,kaab_elamaal_number,kaab_elamaal_issuer,kaab_elamaal_issue_date,kaab_elamaal_refund,crm_id,crm_username,work_email,mobile_number,job_title,hire_date,resignation_date,last_working_date,employment_status,education,manager_hr_id,department_id,line_id,area_id,team_id,position_id,payroll_eligible,organogram_visible,created_at,updated_at";

  // Try to join compensation and other lookups in a single query to reduce N+1 and massive IN filters.
  // Built as a flat array + join (not a multi-line template literal) so the encoded `select` param
  // never contains embedded newline/indentation whitespace, and each embed carries an explicit
  // `!constraint_name` FK hint so relationship resolution never depends on PostgREST's schema cache.
  const joinedSelect = [
    baseEmployeeSelect,
    "region_name",
    "region_code",
    "birth_date",
    `employee_compensation!employee_compensation_employee_hr_id_fkey(${compensationSelect()})`,
    "departments!employees_department_id_fkey(name)",
    "lines!employees_line_id_fkey(name)",
    "areas!employees_area_id_fkey(name)",
    "positions!employees_position_id_fkey(title)",
    "teams!employees_team_id_fkey(name)",
  ].join(",");

  let employeeRows: JoinedEmployeeDbRow[];
  let pendingReplacementInRows = false;

  try {
    const selected = await selectEmployeesWithPendingReplacement<JoinedEmployeeDbRow>((withPendingReplacement) =>
      `employees?${new URLSearchParams({
        select: withPendingReplacement ? `${joinedSelect},${PENDING_REPLACEMENT_COLUMN}` : joinedSelect,
        order: "full_name.asc",
      })}`,
    );
    employeeRows = selected.rows;
    pendingReplacementInRows = selected.pendingReplacementInRows;
  } catch (error) {
    console.log("Employee directory joined select failed, using fallback (schema cache / PostgREST)", {
      level: "warning",
      tags: { component: "employee-directory", action: "fetchEmployeeDirectory" },
      extra: { message: employeeDirectoryErrorMessage(error) },
    });

    // Fallback if joined query fails due to schema/relationship issues.
    // Only selects columns confirmed present in the employees table — do NOT add
    // columns here that belong to a feature branch or migration that may be reverted.
    const FALLBACK_EMPLOYEE_SELECT = `${baseEmployeeSelect},region_name,region_code,birth_date`;
    const fallbackParams = new URLSearchParams({
      select: FALLBACK_EMPLOYEE_SELECT,
      order: "full_name.asc",
    });
    try {
      employeeRows = await supabaseRest<EmployeeDbRow[]>(`employees?${fallbackParams}`);
    } catch (fallbackError) {
      logError("Employee directory fallback select failed", {
        labels: { event: "employee_directory_fallback_failed", component: "employee-directory", action: "fetchEmployeeDirectory-fallback" },
        error: fallbackError,
      });
      // Deliberately THROW here rather than returning `directoryCache.data`, which is what this
      // branch used to do.
      //
      // Returning stale rows from inside the fetch handed them back as a SUCCESSFUL load, and the
      // `.then()` in getEmployeeDirectory writes every successful load into the cache with a fresh
      // `Date.now()`. So a failing fallback re-stamped the old data as new, on every call: the
      // 30-second TTL could never expire while the query kept failing, and the cache was renewed
      // indefinitely off its own contents. Nothing aged, and nothing said so.
      //
      // The single decision about whether stale data may stand in now lives in ONE place — the
      // catch in getEmployeeDirectory — where it is bounded by STALE_CACHE_MAX_AGE and where
      // serving it cannot refresh the timestamp.
      throw fallbackError;
    }
  }

  const employeeHrIds = uniqueTextValues(employeeRows, "hr_id");
  const [residenceByHrId, pendingReplacementByHrId, photoMap, cvHrIds] = await Promise.all([
    loadResidenceByHrId(employeeHrIds),
    pendingReplacementInRows
      ? Promise.resolve(pendingReplacementFromRows(employeeRows))
      : loadPendingManagerReplacementByHrId(employeeHrIds),
    getEmployeePhotoMap(),
    getEmployeeCvHrIdSet(),
  ]);

  // Check if we got joined data
  const hasJoinedData = employeeRows.length > 0 && (employeeRows[0].employee_compensation || employeeRows[0].departments);

  let departmentNames: Map<number, string>;
  let lineNames: Map<number, string>;
  let areaNames: Map<number, string>;
  let positionTitles: Map<number, string>;
  let managerNames: Map<string, string>;
  let compensationByHrId: Map<string, EmployeeCompensationDbRow>;
  let departments: EmployeeLookupOption[];
  let lines: EmployeeLookupOption[];
  let areas: EmployeeLookupOption[];
  let positions: EmployeeLookupOption[];
  let teams: EmployeeLookupOption[] = [];

  if (hasJoinedData) {
    // Extract lookups from joined data to avoid extra requests
    departmentNames = new Map();
    lineNames = new Map();
    areaNames = new Map();
    positionTitles = new Map();
    const teamNames = new Map<number, string>();
    compensationByHrId = new Map();

    employeeRows.forEach(row => {
      if (row.departments && row.department_id !== null) departmentNames.set(row.department_id, row.departments.name ?? "");
      if (row.lines && row.line_id !== null) lineNames.set(row.line_id, row.lines.name ?? "");
      if (row.areas && row.area_id !== null) areaNames.set(row.area_id, row.areas.name ?? "");
      if (row.positions && row.position_id !== null) positionTitles.set(row.position_id, row.positions.title ?? "");
      if (row.teams && row.team_id !== null) teamNames.set(row.team_id, row.teams.name ?? "");
      if (row.employee_compensation) {
        const comp = Array.isArray(row.employee_compensation) ? row.employee_compensation[0] : row.employee_compensation;
        if (comp) compensationByHrId.set(row.hr_id, comp);
      }
    });

    // Still need these for the filter dropdowns, but these are small tables usually
    const [managerNamesResult, departmentsResult, linesResult, areasResult, positionsResult, teamsResult, medicalRepVacancies, workforceVacancies] = await Promise.all([
      Promise.resolve(managerNamesFromEmployeeRows(employeeRows)),
      loadAllOptions("departments"),
      loadAllOptions("lines"),
      loadAllOptions("areas"),
      loadAllOptions("positions", "title"),
      loadAllOptions("teams"),
      getOpenMedicalRepVacancies(),
      getOpenWorkforceVacancies(),
    ]);

    managerNames = managerNamesResult;
    departments = departmentsResult;
    lines = linesResult;
    areas = areasResult;
    positions = positionsResult;
    teams = teamsResult;

    const employeesData = employeeRows.map((row) => {
      const compensation = compensationByHrId.get(row.hr_id);
      const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());
      const departmentName = row.department_id ? departmentNames.get(row.department_id) ?? null : null;
      const lineName = row.line_id ? lineNames.get(row.line_id) ?? null : null;
      const positionTitle = row.position_id ? positionTitles.get(row.position_id) ?? null : null;
      const standardAllowances = resolveStandardSalaryAllowances({
        departmentName,
        employeeHrId: row.hr_id,
        jobTitle: row.job_title,
        lineName,
        positionTitle,
      });

      return {
        areaId: row.area_id,
        areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
        bankName: row.bank_name ?? null,
        bankAccount: row.bank_account ?? null,
        baseSalary: row.base_salary ?? null,
        basicSalary: row.basic_salary ?? null,
        birthDate: row.birth_date ?? null,
        contractRenewalDate: row.contract_renewal_date ?? null,
        contractType: row.contract_type ?? null,
        createdAt: row.created_at,
        crmId: row.crm_id,
        crmUsername: row.crm_username,
        departmentId: row.department_id,
        departmentName,
        education: row.education,
        employmentStatus: row.employment_status,
        extraCostOfLiving: row.extra_cost_of_living ?? compensation?.extra_cost_of_living ?? standardAllowances.extraCostOfLiving,
        fullName: row.full_name,
        displayName: resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
        nickname: row.nickname ?? null,
        gender: row.gender ?? null,
        fuelAllowance: row.fuel_allowance ?? compensation?.fuel_allowance ?? standardAllowances.fuelAllowance,
        grossSalary: row.gross_salary ?? compensation?.gross_salary ?? null,
        hasBankAccount: row.has_bank_account ?? (row.bank_account ? "yes" : "no"),
        hasCv: cvHrIds.has(canonicalHrIdKey(row.hr_id) ?? ""),
        hasPhoto: photoMap.has(canonicalHrIdKey(row.hr_id) ?? ""),
        healthCardStatus: row.health_card_status ?? null,
        healthCardNumber: row.health_card_number ?? null,
        healthCardReceivedDate: row.health_card_received_date ?? null,
        birthPlace: row.birth_place ?? null,
        qualification: row.qualification ?? null,
        universityName: row.university_name ?? null,
        collegeMajor: row.college_major ?? null,
        seniorYear: row.senior_year ?? null,
        contractDuration: row.contract_duration ?? null,
        probationEndDate: row.probation_end_date ?? null,
        medicalInsuranceCardReceivedDate: row.medical_insurance_card_received_date ?? null,
        socialInsuranceStartDate: row.social_insurance_start_date ?? null,
        kaabElamaalNumber: row.kaab_elamaal_number ?? null,
        kaabElamaalIssuer: row.kaab_elamaal_issuer ?? null,
        kaabElamaalIssueDate: row.kaab_elamaal_issue_date ?? null,
        kaabElamaalRefund: row.kaab_elamaal_refund ?? null,
        hireDate: row.hire_date,
        hrId: row.hr_id,
        jobTitle: row.job_title,
        lastWorkingDate: row.last_working_date ?? null,
        lineId: row.line_id,
        lineName,
        managerHrId: row.manager_hr_id,
        managerName: managerNameFromLookup(managerNames, row.manager_hr_id),
        pendingManagerReplacementForHrId: pendingReplacementByHrId.get(row.hr_id) ?? null,
        medicalInsurance: row.medical_insurance ?? compensation?.medical_insurance ?? null,
        medicalInsuranceStatus: row.medical_insurance_status ?? null,
        medicalInsuranceNumber: row.medical_insurance_number ?? null,
        mobileNumber: row.mobile_number,
        nameAr: row.name_ar,
        nationalId: row.national_id ?? null,
        netSalary: row.net_salary ?? compensation?.net_salary ?? null,
        organogramVisible: row.organogram_visible ?? isActiveLifecycleStatus(row.employment_status),
        payrollEligible: row.payroll_eligible ?? isActiveLifecycleStatus(row.employment_status),
        salaryDetails: normalizeEmployeeSalaryDetails(compensation?.salary_details),
        salaryPaymentMode: normalizePayrollPaymentMode(row.payment_mode ?? compensation?.payment_mode),
        positionId: row.position_id,
        positionTitle,
        residenceAddress: row.residence_address ?? residence?.residence_address ?? null,
        residenceArea: row.residence_area ?? residence?.residence_area ?? null,
        residenceCity: row.residence_city ?? residence?.residence_city ?? null,
        residenceGeocodeStatus: residence?.geocode_status ?? null,
        residenceLatitude: residence?.residence_latitude ?? null,
        residenceLongitude: residence?.residence_longitude ?? null,
        regionName: row.region_name ?? null,
        regionCode: row.region_code ?? null,
        resignationDate: row.resignation_date ?? null,
        socialInsurance: row.social_insurance ?? compensation?.social_insurance ?? null,
        socialInsuranceWage: row.social_insurance_wage ?? null,
        socialInsuranceStatus: row.social_insurance_status ?? null,
        socialInsuranceNumber: row.social_insurance_number ?? null,
        taxes: row.taxes ?? compensation?.taxes ?? null,
        teamId: row.team_id,
        teamName: row.team_id ? teamNames.get(row.team_id) ?? null : null,
        updatedAt: row.updated_at,
        workEmail: row.work_email,
      };
    });

    const activeEmployees = employeesData.filter(isActiveDirectoryEmployee);

    return {
      employees: activeEmployees,
      lookups: {
        areas,
        departments,
        lines,
        managers: activeEmployees
          .map((employee) => ({
            departmentId: employee.departmentId,
            label: employee.displayName,
            lineId: employee.lineId,
            positionId: employee.positionId,
            value: employee.hrId,
          }))
          .sort((left, right) => left.label.localeCompare(right.label)),
        medicalRepVacancies,
        positions,
        statuses: activeStatusOptions(activeEmployees),
        teams,
        workforceVacancies,
      },
      summary: {
        activeEmployees: activeEmployees.length,
        employeesWithoutManagers: activeEmployees.filter(isMissingRequiredManager).length,
        totalEmployees: activeEmployees.length,
        uniqueAreas: new Set(activeEmployees.map((employee) => employee.areaId).filter(Boolean)).size,
        uniqueLines: new Set(activeEmployees.map((employee) => employee.lineId).filter(Boolean)).size,
      },
    };
  } else {
    // Fallback to original slow method if join failed
    const [
      departmentNamesRes,
      lineNamesRes,
      areaNamesRes,
      positionTitlesRes,
      teamNamesRes,
      managerNamesRes,
      compensationByHrIdRes,
      departmentsRes,
      linesRes,
      areasRes,
      positionsRes,
      teamsRes,
      medicalRepVacancies,
      workforceVacancies
    ] = await Promise.all([
      loadLookup("departments", uniqueNumberValues(employeeRows, "department_id")),
      loadLookup("lines", uniqueNumberValues(employeeRows, "line_id")),
      loadLookup("areas", uniqueNumberValues(employeeRows, "area_id")),
      loadLookup("positions", uniqueNumberValues(employeeRows, "position_id"), "title"),
      loadLookup("teams", uniqueNumberValues(employeeRows, "team_id")),
      Promise.resolve(managerNamesFromEmployeeRows(employeeRows)),
      loadCompensationByHrId(uniqueTextValues(employeeRows, "hr_id")),
      loadAllOptions("departments"),
      loadAllOptions("lines"),
      loadAllOptions("areas"),
      loadAllOptions("positions", "title"),
      loadAllOptions("teams"),
      getOpenMedicalRepVacancies(),
      getOpenWorkforceVacancies(),
    ]);

    departmentNames = departmentNamesRes;
    lineNames = lineNamesRes;
    areaNames = areaNamesRes;
    positionTitles = positionTitlesRes;
    const teamNames = teamNamesRes;
    managerNames = managerNamesRes;
    compensationByHrId = compensationByHrIdRes;
    departments = departmentsRes;
    lines = linesRes;
    areas = areasRes;
    positions = positionsRes;
    teams = teamsRes;

    const employeesData = employeeRows.map((row) => {
      const comp = compensationByHrId.get(row.hr_id);
      const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());
      const departmentName = row.department_id ? departmentNames.get(row.department_id) ?? null : null;
      const lineName = row.line_id ? lineNames.get(row.line_id) ?? null : null;
      const positionTitle = row.position_id ? positionTitles.get(row.position_id) ?? null : null;
      const standardAllowances = resolveStandardSalaryAllowances({
        departmentName,
        employeeHrId: row.hr_id,
        jobTitle: row.job_title,
        lineName,
        positionTitle,
      });

      return {
        areaId: row.area_id,
        areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
        bankName: row.bank_name ?? null,
        bankAccount: row.bank_account ?? null,
        baseSalary: row.base_salary ?? null,
        basicSalary: row.basic_salary ?? null,
        birthDate: row.birth_date ?? null,
        contractRenewalDate: row.contract_renewal_date ?? null,
        contractType: row.contract_type ?? null,
        createdAt: row.created_at,
        crmId: row.crm_id,
        crmUsername: row.crm_username,
        departmentId: row.department_id,
        departmentName,
        education: row.education,
        employmentStatus: row.employment_status,
        extraCostOfLiving: row.extra_cost_of_living ?? comp?.extra_cost_of_living ?? standardAllowances.extraCostOfLiving,
        fullName: row.full_name,
        displayName: resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
        nickname: row.nickname ?? null,
        gender: row.gender ?? null,
        fuelAllowance: row.fuel_allowance ?? comp?.fuel_allowance ?? standardAllowances.fuelAllowance,
        grossSalary: row.gross_salary ?? comp?.gross_salary ?? null,
        hasBankAccount: row.has_bank_account ?? (row.bank_account ? "yes" : "no"),
        hasCv: cvHrIds.has(canonicalHrIdKey(row.hr_id) ?? ""),
        hasPhoto: photoMap.has(canonicalHrIdKey(row.hr_id) ?? ""),
        healthCardStatus: row.health_card_status ?? null,
        healthCardNumber: row.health_card_number ?? null,
        healthCardReceivedDate: row.health_card_received_date ?? null,
        birthPlace: row.birth_place ?? null,
        qualification: row.qualification ?? null,
        universityName: row.university_name ?? null,
        collegeMajor: row.college_major ?? null,
        seniorYear: row.senior_year ?? null,
        contractDuration: row.contract_duration ?? null,
        probationEndDate: row.probation_end_date ?? null,
        medicalInsuranceCardReceivedDate: row.medical_insurance_card_received_date ?? null,
        socialInsuranceStartDate: row.social_insurance_start_date ?? null,
        kaabElamaalNumber: row.kaab_elamaal_number ?? null,
        kaabElamaalIssuer: row.kaab_elamaal_issuer ?? null,
        kaabElamaalIssueDate: row.kaab_elamaal_issue_date ?? null,
        kaabElamaalRefund: row.kaab_elamaal_refund ?? null,
        hireDate: row.hire_date,
        hrId: row.hr_id,
        jobTitle: row.job_title,
        lastWorkingDate: row.last_working_date ?? null,
        lineId: row.line_id,
        lineName,
        managerHrId: row.manager_hr_id,
        managerName: managerNameFromLookup(managerNames, row.manager_hr_id),
        pendingManagerReplacementForHrId: pendingReplacementByHrId.get(row.hr_id) ?? null,
        medicalInsurance: row.medical_insurance ?? comp?.medical_insurance ?? null,
        medicalInsuranceStatus: row.medical_insurance_status ?? null,
        medicalInsuranceNumber: row.medical_insurance_number ?? null,
        mobileNumber: row.mobile_number,
        nameAr: row.name_ar,
        nationalId: row.national_id ?? null,
        netSalary: row.net_salary ?? comp?.net_salary ?? null,
        organogramVisible: row.organogram_visible ?? isActiveLifecycleStatus(row.employment_status),
        payrollEligible: row.payroll_eligible ?? isActiveLifecycleStatus(row.employment_status),
        salaryDetails: normalizeEmployeeSalaryDetails(comp?.salary_details),
        salaryPaymentMode: normalizePayrollPaymentMode(row.payment_mode ?? comp?.payment_mode),
        positionId: row.position_id,
        positionTitle,
        residenceAddress: row.residence_address ?? residence?.residence_address ?? null,
        residenceArea: row.residence_area ?? residence?.residence_area ?? null,
        residenceCity: row.residence_city ?? residence?.residence_city ?? null,
        residenceGeocodeStatus: residence?.geocode_status ?? null,
        residenceLatitude: residence?.residence_latitude ?? null,
        residenceLongitude: residence?.residence_longitude ?? null,
        regionName: row.region_name ?? null,
        regionCode: row.region_code ?? null,
        resignationDate: row.resignation_date ?? null,
        socialInsurance: row.social_insurance ?? comp?.social_insurance ?? null,
        socialInsuranceWage: row.social_insurance_wage ?? null,
        socialInsuranceStatus: row.social_insurance_status ?? null,
        socialInsuranceNumber: row.social_insurance_number ?? null,
        taxes: row.taxes ?? comp?.taxes ?? null,
        teamId: row.team_id,
        teamName: row.team_id ? teamNames.get(row.team_id) ?? null : null,
        updatedAt: row.updated_at,
        workEmail: row.work_email,
      };
    });

    const activeEmployees = employeesData.filter(isActiveDirectoryEmployee);

    return {
      employees: activeEmployees,
      lookups: {
        areas,
        departments,
        lines,
        managers: activeEmployees
          .map((employee) => ({
            departmentId: employee.departmentId,
            label: employee.displayName,
            lineId: employee.lineId,
            positionId: employee.positionId,
            value: employee.hrId,
          }))
          .sort((left, right) => left.label.localeCompare(right.label)),
        medicalRepVacancies,
        positions,
        statuses: activeStatusOptions(activeEmployees),
        teams,
        workforceVacancies,
      },
      summary: {
        activeEmployees: activeEmployees.length,
        employeesWithoutManagers: activeEmployees.filter(isMissingRequiredManager).length,
        totalEmployees: activeEmployees.length,
        uniqueAreas: new Set(activeEmployees.map((employee) => employee.areaId).filter(Boolean)).size,
        uniqueLines: new Set(activeEmployees.map((employee) => employee.lineId).filter(Boolean)).size,
      },
    };
  }

  const employees = employeeRows.map((row) => {
    const compensation = compensationByHrId.get(row.hr_id);
    const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());
    const departmentName = row.department_id
      ? departmentNames.get(row.department_id) ?? null
      : null;
    const lineName = row.line_id ? lineNames.get(row.line_id) ?? null : null;
    const positionTitle = row.position_id
      ? positionTitles.get(row.position_id) ?? null
      : null;
    const standardAllowances = resolveStandardSalaryAllowances({
      departmentName,
      employeeHrId: row.hr_id,
      jobTitle: row.job_title,
      lineName,
      positionTitle,
    });

    return {
      areaId: row.area_id,
      areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
      bankName: row.bank_name ?? null,
      bankAccount: row.bank_account ?? null,
      baseSalary: row.base_salary ?? null,
      basicSalary: row.basic_salary ?? null,
      birthDate: row.birth_date ?? null,
      contractRenewalDate: row.contract_renewal_date ?? null,
      contractType: row.contract_type ?? null,
      createdAt: row.created_at,
      crmId: row.crm_id,
      crmUsername: row.crm_username,
      departmentId: row.department_id,
      departmentName,
      education: row.education,
      employmentStatus: row.employment_status,
      extraCostOfLiving: row.extra_cost_of_living ?? compensation?.extra_cost_of_living ?? standardAllowances.extraCostOfLiving,
      fullName: row.full_name,
      displayName: resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
      nickname: row.nickname ?? null,
      gender: row.gender ?? null,
      fuelAllowance: row.fuel_allowance ?? compensation?.fuel_allowance ?? standardAllowances.fuelAllowance,
      grossSalary: row.gross_salary ?? compensation?.gross_salary ?? null,
      hasBankAccount: row.has_bank_account ?? (row.bank_account ? "yes" : "no"),
      hasCv: cvHrIds.has(canonicalHrIdKey(row.hr_id) ?? ""),
      hasPhoto: photoMap.has(canonicalHrIdKey(row.hr_id) ?? ""),
      healthCardStatus: row.health_card_status ?? null,
      healthCardNumber: row.health_card_number ?? null,
      healthCardReceivedDate: row.health_card_received_date ?? null,
      birthPlace: row.birth_place ?? null,
      qualification: row.qualification ?? null,
      universityName: row.university_name ?? null,
      collegeMajor: row.college_major ?? null,
      seniorYear: row.senior_year ?? null,
      contractDuration: row.contract_duration ?? null,
      probationEndDate: row.probation_end_date ?? null,
      medicalInsuranceCardReceivedDate: row.medical_insurance_card_received_date ?? null,
      socialInsuranceStartDate: row.social_insurance_start_date ?? null,
      kaabElamaalNumber: row.kaab_elamaal_number ?? null,
      kaabElamaalIssuer: row.kaab_elamaal_issuer ?? null,
      kaabElamaalIssueDate: row.kaab_elamaal_issue_date ?? null,
      kaabElamaalRefund: row.kaab_elamaal_refund ?? null,
      hireDate: row.hire_date,
      hrId: row.hr_id,
      jobTitle: row.job_title,
      lastWorkingDate: row.last_working_date ?? null,
      lineId: row.line_id,
      lineName,
      managerHrId: row.manager_hr_id,
      managerName: managerNameFromLookup(managerNames, row.manager_hr_id),
      pendingManagerReplacementForHrId: pendingReplacementByHrId.get(row.hr_id) ?? null,
      medicalInsurance: row.medical_insurance ?? compensation?.medical_insurance ?? null,
      medicalInsuranceStatus: row.medical_insurance_status ?? null,
      medicalInsuranceNumber: row.medical_insurance_number ?? null,
      mobileNumber: row.mobile_number,
      nameAr: row.name_ar,
      nationalId: row.national_id ?? null,
      netSalary: row.net_salary ?? compensation?.net_salary ?? null,
      organogramVisible: row.organogram_visible ?? isActiveLifecycleStatus(row.employment_status),
      payrollEligible: row.payroll_eligible ?? isActiveLifecycleStatus(row.employment_status),
      salaryDetails: normalizeEmployeeSalaryDetails(compensation?.salary_details),
      salaryPaymentMode: normalizePayrollPaymentMode(row.payment_mode ?? compensation?.payment_mode),
      positionId: row.position_id,
      positionTitle,
      residenceAddress: row.residence_address ?? residence?.residence_address ?? null,
      residenceArea: row.residence_area ?? residence?.residence_area ?? null,
      residenceCity: row.residence_city ?? residence?.residence_city ?? null,
      residenceGeocodeStatus: residence?.geocode_status ?? null,
      residenceLatitude: residence?.residence_latitude ?? null,
      residenceLongitude: residence?.residence_longitude ?? null,
      regionName: row.region_name ?? null,
      regionCode: row.region_code ?? null,
      resignationDate: row.resignation_date ?? null,
      socialInsurance: row.social_insurance ?? compensation?.social_insurance ?? null,
      socialInsuranceWage: row.social_insurance_wage ?? null,
      socialInsuranceStatus: row.social_insurance_status ?? null,
      socialInsuranceNumber: row.social_insurance_number ?? null,
      taxes: row.taxes ?? compensation?.taxes ?? null,
      teamId: row.team_id,
      teamName: null,
      updatedAt: row.updated_at,
      workEmail: row.work_email,
    };
  });
  const activeEmployees = employees.filter(isActiveDirectoryEmployee);

  return {
    employees: activeEmployees,
    lookups: {
      areas,
      departments,
      lines,
      managers: activeEmployees
        .map((employee) => ({
          departmentId: employee.departmentId,
          label: employee.displayName,
          lineId: employee.lineId,
          positionId: employee.positionId,
          value: employee.hrId,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      medicalRepVacancies: [],
      positions,
      statuses: activeStatusOptions(activeEmployees),
      teams,
      workforceVacancies: [],
    },
    summary: {
      activeEmployees: activeEmployees.length,
      employeesWithoutManagers: activeEmployees.filter(isMissingRequiredManager).length,
      totalEmployees: activeEmployees.length,
      uniqueAreas: new Set(activeEmployees.map((employee) => employee.areaId).filter(Boolean)).size,
      uniqueLines: new Set(activeEmployees.map((employee) => employee.lineId).filter(Boolean)).size,
    },
  };
}

// Page past the PostgREST db-max-rows cap (~1000) so a large headcount is never silently
// truncated. A total order (full_name + hr_id tiebreaker) keeps offset paging exact.
async function fetchAllEmployeeRows(params: URLSearchParams): Promise<EmployeeDbRow[]> {
  const pageSize = 1000;
  const all: EmployeeDbRow[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", String(pageSize));
    pageParams.set("offset", String(offset));
    const page = await supabaseRest<EmployeeDbRow[]>(`employees?${pageParams.toString()}`);
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

async function fetchEmployeeDirectoryRows(includeInactive: boolean): Promise<EmployeeDirectoryRow[]> {
  const baseEmployeeSelect =
    "hr_id,full_name,nickname,name_ar,national_id,gender,has_bank_account,bank_name,bank_account,health_card_status,health_card_number,health_card_received_date,social_insurance_status,social_insurance_number,medical_insurance_status,medical_insurance_number,basic_salary,base_salary,gross_salary,net_salary,fuel_allowance,extra_cost_of_living,medical_insurance,social_insurance,social_insurance_wage,taxes,payment_mode,residence_address,residence_city,residence_area,contract_type,contract_renewal_date,contract_duration,probation_end_date,birth_place,qualification,university_name,college_major,senior_year,medical_insurance_card_received_date,social_insurance_start_date,kaab_elamaal_number,kaab_elamaal_issuer,kaab_elamaal_issue_date,kaab_elamaal_refund,crm_id,crm_username,work_email,mobile_number,job_title,hire_date,resignation_date,last_working_date,employment_status,education,manager_hr_id,department_id,line_id,area_id,team_id,position_id,payroll_eligible,organogram_visible,created_at,updated_at";
  const employeeParams = new URLSearchParams({
    select: `${baseEmployeeSelect},region_name,birth_date`,
    order: "full_name.asc,hr_id.asc",
  });
  let employeeRows: EmployeeDbRow[];
  let pendingReplacementInRows = false;

  try {
    const withPendingReplacement = new URLSearchParams(employeeParams);
    withPendingReplacement.set("select", `${employeeParams.get("select")},${PENDING_REPLACEMENT_COLUMN}`);
    try {
      employeeRows = await fetchAllEmployeeRows(withPendingReplacement);
      pendingReplacementInRows = true;
    } catch (pendingError) {
      if (!isMissingColumnError(pendingError, PENDING_REPLACEMENT_COLUMN)) throw pendingError;
      employeeRows = await fetchAllEmployeeRows(employeeParams);
    }
  } catch (error) {
    if (!isMissingRelationMessage(error)) {
      throw error;
    }

    const fallbackParams = new URLSearchParams({
      select: baseEmployeeSelect,
      order: "full_name.asc,hr_id.asc",
    });
    employeeRows = await fetchAllEmployeeRows(fallbackParams);
  }

  // ONE ROUND, NOT FIVE (2026-10-01, "slow to transfer between page and page"): the residence,
  // pending-replacement, photo and CV loads used to wait for the lookups and then for each other,
  // though every one of them reads only `employeeRows` (or nothing at all) — the same four that
  // fetchEmployeeDirectory above already runs side by side. Each still returns the same map.
  const [
    departmentNames,
    lineNames,
    areaNames,
    positionTitles,
    teamNames,
    managerNames,
    compensationByHrId,
    residenceByHrId,
    pendingReplacementByHrId,
    photoMap,
    cvHrIds,
  ] = await Promise.all([
    loadLookup("departments", uniqueNumberValues(employeeRows, "department_id")),
    loadLookup("lines", uniqueNumberValues(employeeRows, "line_id")),
    loadLookup("areas", uniqueNumberValues(employeeRows, "area_id")),
    loadLookup("positions", uniqueNumberValues(employeeRows, "position_id"), "title"),
    loadLookup("teams", uniqueNumberValues(employeeRows, "team_id")),
    Promise.resolve(managerNamesFromEmployeeRows(employeeRows)),
    loadCompensationByHrId(uniqueTextValues(employeeRows, "hr_id")),
    loadResidenceByHrId(uniqueTextValues(employeeRows, "hr_id")),
    pendingReplacementInRows
      ? Promise.resolve(pendingReplacementFromRows(employeeRows))
      : loadPendingManagerReplacementByHrId(uniqueTextValues(employeeRows, "hr_id")),
    getEmployeePhotoMap(),
    getEmployeeCvHrIdSet(),
  ]);

  return employeeRows.map((row) => {
    const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());
    const compensation = compensationByHrId.get(row.hr_id);

    return {
      areaId: row.area_id,
      areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
      bankName: row.bank_name ?? null,
      bankAccount: row.bank_account ?? null,
      baseSalary: row.base_salary ?? null,
      basicSalary: row.basic_salary ?? null,
      birthDate: row.birth_date ?? null,
      contractRenewalDate: row.contract_renewal_date ?? null,
      contractType: row.contract_type ?? null,
      createdAt: row.created_at,
      crmId: row.crm_id,
      crmUsername: row.crm_username,
      departmentId: row.department_id,
      departmentName: row.department_id
        ? departmentNames.get(row.department_id) ?? null
        : null,
      education: row.education,
      employmentStatus: row.employment_status,
      extraCostOfLiving: row.extra_cost_of_living ?? null,
      fullName: row.full_name,
      displayName: resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
      nickname: row.nickname ?? null,
      gender: row.gender ?? null,
      fuelAllowance: row.fuel_allowance ?? null,
      grossSalary: row.gross_salary ?? null,
      hasBankAccount: row.has_bank_account ?? (row.bank_account ? "yes" : "no"),
      hasCv: cvHrIds.has(canonicalHrIdKey(row.hr_id) ?? ""),
      hasPhoto: photoMap.has(canonicalHrIdKey(row.hr_id) ?? ""),
      healthCardStatus: row.health_card_status ?? null,
      healthCardNumber: row.health_card_number ?? null,
      healthCardReceivedDate: row.health_card_received_date ?? null,
      birthPlace: row.birth_place ?? null,
      qualification: row.qualification ?? null,
      universityName: row.university_name ?? null,
      collegeMajor: row.college_major ?? null,
      seniorYear: row.senior_year ?? null,
      contractDuration: row.contract_duration ?? null,
      probationEndDate: row.probation_end_date ?? null,
      medicalInsuranceCardReceivedDate: row.medical_insurance_card_received_date ?? null,
      socialInsuranceStartDate: row.social_insurance_start_date ?? null,
      kaabElamaalNumber: row.kaab_elamaal_number ?? null,
      kaabElamaalIssuer: row.kaab_elamaal_issuer ?? null,
      kaabElamaalIssueDate: row.kaab_elamaal_issue_date ?? null,
      kaabElamaalRefund: row.kaab_elamaal_refund ?? null,
      hireDate: row.hire_date,
      hrId: row.hr_id,
      jobTitle: row.job_title,
      lastWorkingDate: row.last_working_date ?? null,
      lineId: row.line_id,
      lineName: row.line_id ? lineNames.get(row.line_id) ?? null : null,
      managerHrId: row.manager_hr_id,
      managerName: managerNameFromLookup(managerNames, row.manager_hr_id),
      pendingManagerReplacementForHrId: pendingReplacementByHrId.get(row.hr_id) ?? null,
      medicalInsurance: row.medical_insurance ?? null,
      medicalInsuranceStatus: row.medical_insurance_status ?? null,
      medicalInsuranceNumber: row.medical_insurance_number ?? null,
      mobileNumber: row.mobile_number,
      nameAr: row.name_ar,
      nationalId: row.national_id ?? null,
      netSalary: row.net_salary ?? null,
      organogramVisible: row.organogram_visible ?? isActiveLifecycleStatus(row.employment_status),
      payrollEligible: row.payroll_eligible ?? isActiveLifecycleStatus(row.employment_status),
      salaryDetails: normalizeEmployeeSalaryDetails(compensation?.salary_details),
      salaryPaymentMode: normalizePayrollPaymentMode(row.payment_mode ?? compensation?.payment_mode),
      positionId: row.position_id,
      positionTitle: row.position_id
        ? positionTitles.get(row.position_id) ?? null
        : null,
      residenceAddress: row.residence_address ?? residence?.residence_address ?? null,
      residenceArea: row.residence_area ?? residence?.residence_area ?? null,
      residenceCity: row.residence_city ?? residence?.residence_city ?? null,
      residenceGeocodeStatus: residence?.geocode_status ?? null,
      residenceLatitude: residence?.residence_latitude ?? null,
      residenceLongitude: residence?.residence_longitude ?? null,
      regionName: row.region_name ?? null,
      regionCode: row.region_code ?? null,
      resignationDate: row.resignation_date ?? null,
      socialInsurance: row.social_insurance ?? null,
      socialInsuranceWage: row.social_insurance_wage ?? null,
      socialInsuranceStatus: row.social_insurance_status ?? null,
      socialInsuranceNumber: row.social_insurance_number ?? null,
      taxes: row.taxes ?? null,
      teamId: row.team_id,
      teamName: row.team_id ? teamNames.get(row.team_id) ?? null : null,
      updatedAt: row.updated_at,
      workEmail: row.work_email,
    };
  }).filter((employee) => includeInactive || isActiveDirectoryEmployee(employee));
}

export async function getEmployeeDirectoryRows(
  options: { includeInactive?: boolean } = {},
): Promise<EmployeeDirectoryRow[]> {
  const includeInactive = options.includeInactive ?? false;
  const now = Date.now();
  const cached = directoryRowsCache.get(includeInactive);

  // Same de-dupe rationale as inFlightDirectory above: concurrent callers requesting the
  // SAME includeInactive value share one in-flight fetch instead of each issuing their own
  // full paginated directory query.
  const loadShared = (): Promise<EmployeeDirectoryRow[]> => {
    let inFlight = inFlightDirectoryRows.get(includeInactive);
    if (!inFlight) {
      const generation = directoryGeneration;
      inFlight = fetchEmployeeDirectoryRows(includeInactive)
        .then((result) => {
          if (generation === directoryGeneration) {
            directoryRowsCache.set(includeInactive, { data: result, timestamp: Date.now() });
          }
          return result;
        })
        .finally(() => {
          inFlightDirectoryRows.delete(includeInactive);
        });
      inFlightDirectoryRows.set(includeInactive, inFlight);
    }
    return inFlight;
  };

  if (cached) {
    const disposition = directoryCacheDisposition(now - cached.timestamp);
    if (disposition === "fresh") return cached.data;
    if (disposition === "refresh-behind") {
      loadShared().catch(() => undefined);
      return cached.data;
    }
  }

  try {
    return await loadShared();
  } catch (error) {
    // Same rule as getEmployeeDirectory, same bound. This read is keyed by includeInactive, so the
    // age test applies to the entry for THIS key — the two result sets must never stand in for one
    // another, and a fresh active-only entry says nothing about how old the full-history one is.
    const stale = serveStaleOnFailure(directoryRowsCache.get(includeInactive), {
      surface: `getEmployeeDirectoryRows(includeInactive=${includeInactive})`,
      error,
    });
    if (stale) return stale;

    throw error;
  }
}

async function ensureManagerIsValid(managerHrId: string | null, employeeHrId: string) {
  if (!managerHrId) {
    return;
  }

  if (managerHrId === employeeHrId) {
    throw new Error("An employee cannot be assigned as their own manager.");
  }

  const managers = await supabaseRest<EmployeeDbRow[]>(
    `employees?hr_id=eq.${encodeURIComponent(managerHrId)}&select=hr_id,employment_status,payroll_eligible,organogram_visible,full_name,name_ar,crm_id,crm_username,work_email,mobile_number,job_title,hire_date,education,manager_hr_id,department_id,line_id,area_id,team_id,position_id,created_at,updated_at`,
  );

  if (managers.length === 0) {
    throw new Error(`Manager HR_ID ${managerHrId} was not found.`);
  }

  const manager = managers[0];
  if (
    !isActiveLifecycleStatus(manager.employment_status) ||
    manager.organogram_visible === false
  ) {
    throw new Error(`Manager HR_ID ${managerHrId} is not active for hierarchy assignment.`);
  }
}

async function ensureCrmIdIsUnique(crmId: string | null, employeeHrId: string) {
  if (!crmId) {
    return;
  }

  const matches = await supabaseRest<Array<{ hr_id: string }>>(
    `employees?crm_id=eq.${encodeURIComponent(crmId)}&select=hr_id`,
  );
  const conflict = matches.find(
    (row) => normalizeHrId(row.hr_id) !== employeeHrId,
  );

  if (conflict) {
    throw new Error(`CRM ID ${crmId} is already assigned to HR_ID ${conflict.hr_id}.`);
  }
}

async function ensureCrmUsernameIsUnique(crmUsername: string | null, employeeHrId: string) {
  if (!crmUsername) {
    return;
  }

  // The value is percent-encoded and NOT quoted. `crm_username=ilike.VALUE` is a plain query
  // parameter: PostgREST takes everything after `ilike.` as the pattern, and nothing in it is
  // structural — double quotes are an escape only inside `in.(…)` lists and `or`/`and` groups.
  // Quoting it here (#6350, 23 Oct 2026) made PostgREST match two literal `"` characters, so the
  // read found NO holder and a taken username reached the unique index as a raw 23505. Measured on
  // production the same day: unquoted 1 row, quoted 0 rows.
  //
  // `%`, `*` and `_` are deliberately left as wildcards. They can only WIDEN this read, and the
  // exact comparison below is what decides a conflict — whereas blanking them would narrow the
  // query and could let a duplicate username through, which is the one outcome this function
  // exists to prevent.
  const matches = await supabaseRest<Array<{ crm_username: string | null; hr_id: string }>>(
    `employees?crm_username=ilike.${encodeURIComponent(crmUsername)}&select=hr_id,crm_username`,
  );
  const normalizedUsername = crmUsername.trim().toLowerCase();
  const conflict = matches.find(
    (row) =>
      row.crm_username?.trim().toLowerCase() === normalizedUsername &&
      normalizeHrId(row.hr_id) !== employeeHrId,
  );

  if (conflict) {
    throw new Error(`CRM username ${crmUsername} is already assigned to HR_ID ${conflict.hr_id}.`);
  }
}

function resolveEmployeeCompensationInput(input: EmployeeMutationInput) {
  const baseSalary = numberOrNull(input.baseSalary);
  const basicSalary = numberOrNull(input.basicSalary);
  const grossSalary = numberOrNull(input.grossSalary);
  const netSalary = numberOrNull(input.netSalary);
  const socialInsurance = numberOrNull(input.socialInsurance);
  const taxes = numberOrNull(input.taxes);
  const explicitExtraCostOfLiving = numberOrNull(input.extraCostOfLiving);
  const explicitFuelAllowance = numberOrNull(input.fuelAllowance);
  const standardAllowances = resolveStandardSalaryAllowances({
    employeeHrId: input.hrId,
    jobTitle: input.jobTitle,
  });
  const extraCostOfLiving = explicitExtraCostOfLiving ?? standardAllowances.extraCostOfLiving;
  const fuelAllowance = explicitFuelAllowance ?? standardAllowances.fuelAllowance;
  const fixedSalary = resolveFixedSalaryAmounts({
    baseSalary,
    basicSalary,
    employmentIncomeTax: taxes,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary,
    netSalary,
    socialInsurance,
  });

  if (fixedSalary.baseSalary <= 0) {
    return {
      baseSalary,
      basicSalary,
      extraCostOfLiving: explicitExtraCostOfLiving,
      fuelAllowance: explicitFuelAllowance,
      grossSalary,
      netSalary,
    };
  }

  return {
    baseSalary: fixedSalary.baseSalary,
    basicSalary: fixedSalary.basicSalary,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary: fixedSalary.grossSalary,
    netSalary: fixedSalary.netSalary,
  };
}

/**
 * THE MONEY COLUMNS — WRITTEN ONLY WHEN THE CALLER ACTUALLY SUPPLIED ONE.
 *
 * Every column below holds real salary data with no history table behind it: an overwrite is
 * silent, produces no audit row, and cannot be recovered from this database. Writing them
 * unconditionally meant any caller whose payload simply did not carry pay — a partial API save, a
 * script, a client that never rendered the salary section, or a viewer whose read of those figures
 * was redacted — blanked every one of them as a side effect of editing something else entirely,
 * such as a phone number.
 *
 * So the write is keyed on the PAYLOAD, not on who is sending it. A money column is written only
 * when this save actually carries a value for it; otherwise the key is omitted from the upsert body
 * and PostgREST leaves that column out of its `DO UPDATE SET` list, so the stored figure survives
 * untouched.
 *
 * `numberOrNull` collapses "absent" and "explicitly cleared" into the same `null` — the edit form
 * (`formToPayload`) posts `null` for an empty box, so the two are genuinely indistinguishable here.
 * Both therefore preserve. That is the same call the employee IMPORT already makes for these exact
 * columns (`employeeValues` in app/api/imports/employees/confirm/route.ts guards each one with
 * `!== null`), and it is the safe direction: failing to clear a salary is a visible no-op the user
 * can retry, while failing to preserve one destroys payroll data nobody notices until payday.
 * Clearing a salary outright is not reachable from this path any more, by design — it is a
 * deliberate act that belongs in a governed flow, not a side effect of a blank box.
 *
 * Only on an UPDATE. On a create there is no stored figure to protect, so the columns are written
 * exactly as before and a new row's pay is never left implicit.
 *
 * EXPORTED FOR THE TESTS, deliberately: `employeePayload` reaches the network on every call
 * (manager validation, CRM uniqueness, region derivation), so the one rule worth pinning here —
 * which money columns a given payload writes — is only reachable in isolation.
 */
export function employeeCompensationColumns(input: EmployeeMutationInput, isUpdate: boolean) {
  const compensation = resolveEmployeeCompensationInput(input);
  const columns = {
    base_salary: compensation.baseSalary,
    basic_salary: compensation.basicSalary,
    extra_cost_of_living: compensation.extraCostOfLiving,
    fuel_allowance: compensation.fuelAllowance,
    gross_salary: compensation.grossSalary,
    medical_insurance: numberOrNull(input.medicalInsurance),
    net_salary: compensation.netSalary,
    social_insurance: numberOrNull(input.socialInsurance),
    // The insurance WAGE alone decides the statutory filing — payroll never reads
    // social_insurance_status — so blanking it silently changes what is filed for this employee
    // with the Authority. It is protected on exactly the same terms as the salary columns.
    social_insurance_wage: numberOrNull(input.socialInsuranceWage),
    taxes: numberOrNull(input.taxes),
  };

  if (!isUpdate) {
    return columns;
  }

  return Object.fromEntries(
    Object.entries(columns).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<typeof columns>;
}

async function employeePayload(
  input: EmployeeMutationInput,
  isUpdate: boolean,
  previousManagerHrId: string | null = null,
) {
  const fullName = compact(input.fullName);
  if (!fullName) {
    throw new Error("Full name is required.");
  }

  const lineId = numberOrNull(input.lineId);
  let hrId = normalizeHrId(input.hrId);
  const employmentStatus = normalizeLifecycleStatus(input.employmentStatus);
  const workEmail = compact(input.workEmail)?.toLowerCase();

  if (!statusOptions.includes(employmentStatus)) {
    throw new Error(`Employment status ${employmentStatus} is not allowed.`);
  }

  if (employmentStatus === "resigned" || employmentStatus === "terminated") {
    throw new Error("Use the resignation workflow for resigned or terminated employees.");
  }
  if (employmentStatus === "declined_offer") {
    throw new Error("Use the decline-offer workflow for an employee who declined the offer after hire.");
  }

  if (hrId && !hrIdPattern.test(hrId)) {
    throw new Error(`Invalid HR_ID format: ${hrId}.`);
  }

  if (workEmail && !emailPattern.test(workEmail)) {
    throw new Error("Work email format is invalid.");
  }

  // 1. Handle HR_ID based on operation type
  if (isUpdate) {
    // When updating, HR_ID must be provided and stable
    if (!hrId) {
      throw new Error("HR_ID is required for updates.");
    }
  } else {
    // When creating a NEW employee
    if (!hrId) {
      // Auto-generate if missing
      hrId = await generateNextHrIdForLine(lineId);
    } else {
      // Validate uniqueness if manually entered
      const existing = await supabaseRest<Array<{ hr_id: string }>>(
        `employees?hr_id=eq.${hrId}&select=hr_id`,
      );
      if (existing.length > 0) {
        throw new Error(`HR_ID ${hrId} already exists.`);
      }
    }
  }

  if (!hrId) {
    throw new Error("HR_ID is required.");
  }

  const managerHrId = normalizeHrId(input.managerHrId);
  // Only validate the manager when it is actually being assigned or changed (or on create).
  // Re-validating an UNCHANGED manager on every save would block unrelated edits (phone,
  // salary, etc.) for any employee whose manager has since resigned or been hidden from the
  // organogram — a stale reference the seat-continuity flow reconciles separately, not a
  // reason to reject an edit that never touched the manager field.
  if (!isUpdate || managerHrId !== previousManagerHrId) {
    await ensureManagerIsValid(managerHrId, hrId);
  }
  const crmId = compact(input.crmId);
  const crmUsername = compact(input.crmUsername);
  await ensureCrmIdIsUnique(crmId, hrId);
  await ensureCrmUsernameIsUnique(crmUsername, hrId);

  const lifecycleActive = isActiveLifecycleStatus(employmentStatus);
  const payrollEligible = lifecycleActive ? input.payrollEligible !== false : false;

  // Region is authoritative from the au sales geography: derive it from (line, area) and persist the
  // code + precise name so an employee's region can never drift from their sales area. Non-sales
  // rows (e.g. Head Office) keep the submitted free-text region and store no code.
  const areaId = numberOrNull(input.areaId);
  const derivedRegion = await resolveRegionByIds(lineId, areaId);
  const regionFields = employeeRegionFields(derivedRegion, compact(input.regionName));

  return {
    ...employeeCompensationColumns(input, isUpdate),
    area_id: areaId,
    bank_account: compact(input.bankAccount),
    bank_name: compact(input.bankName),
    birth_date: compact(input.birthDate),
    contract_type: compact(input.contractType),
    crm_id: crmId,
    crm_username: crmUsername,
    department_id: numberOrNull(input.departmentId),
    education: compact(input.education),
    employment_status: employmentStatus,
    full_name: fullName,
    nickname: compact(input.nickname),
    gender: compact(input.gender)?.toLowerCase(),
    has_bank_account: normalizeYesNo(input.hasBankAccount),
    health_card_status: normalizeEnrollmentStatus(input.healthCardStatus),
    health_card_number: compact(input.healthCardNumber),
    health_card_received_date: compact(input.healthCardReceivedDate),
    // The HR record fields the Employee Master carries. Written the same way as everything else
    // here, which on an UPDATE means a field the caller did not send is FILTERED OUT rather than
    // nulled (see the `isUpdate` filter above) — so a flow that saves an employee without these,
    // the way the resignation and offer flows do, leaves them exactly as HR typed them.
    birth_place: compact(input.birthPlace),
    qualification: compact(input.qualification),
    university_name: compact(input.universityName),
    college_major: compact(input.collegeMajor),
    senior_year: compact(input.seniorYear),
    contract_duration: compact(input.contractDuration),
    contract_renewal_date: compact(input.contractRenewalDate),
    probation_end_date: compact(input.probationEndDate),
    medical_insurance_card_received_date: compact(input.medicalInsuranceCardReceivedDate),
    social_insurance_start_date: compact(input.socialInsuranceStartDate),
    kaab_elamaal_number: compact(input.kaabElamaalNumber),
    kaab_elamaal_issuer: compact(input.kaabElamaalIssuer),
    kaab_elamaal_issue_date: compact(input.kaabElamaalIssueDate),
    kaab_elamaal_refund: normalizeYesNo(input.kaabElamaalRefund),
    hire_date: compact(input.hireDate),
    hr_id: hrId,
    job_title: compact(input.jobTitle),
    line_id: lineId,
    manager_hr_id: managerHrId,
    mobile_number: compact(input.mobileNumber),
    name_ar: compact(input.nameAr),
    national_id: compact(input.nationalId),
    medical_insurance_status: normalizeEnrollmentStatus(input.medicalInsuranceStatus),
    medical_insurance_number: compact(input.medicalInsuranceNumber),
    organogram_visible: lifecycleActive,
    payroll_eligible: payrollEligible,
    position_id: numberOrNull(input.positionId),
    payment_mode: normalizePayrollPaymentMode(input.salaryPaymentMode),
    residence_address: compact(input.residenceAddress),
    residence_area: compact(input.residenceArea),
    residence_city: compact(input.residenceCity),
    region_name: regionFields.region_name,
    region_code: regionFields.region_code,
    social_insurance_status: normalizeEnrollmentStatus(input.socialInsuranceStatus),
    social_insurance_number: compact(input.socialInsuranceNumber),
    team_id: numberOrNull(input.teamId),
    updated_at: new Date().toISOString(),
    work_email: workEmail,
    // Written only when the caller sent it. Every other save path (HR's form, the import, the
    // resignation and offer flows) has no such field, and writing `null` for it would wipe the
    // address the joiner gave on every unrelated edit of his record.
    ...(input.personalEmail !== undefined ? { personal_email: compact(input.personalEmail)?.toLowerCase() ?? null } : {}),
  };
}

async function upsertEmployeeCompensation(
  hrId: string,
  input: Pick<EmployeeMutationInput, "salaryDetails" | "salaryPaymentMode">,
) {
  if (input.salaryPaymentMode === undefined && input.salaryDetails === undefined) {
    return;
  }

  const payload = {
    employee_hr_id: hrId,
    updated_at: new Date().toISOString(),
    ...(input.salaryPaymentMode !== undefined
      ? { payment_mode: normalizePayrollPaymentMode(input.salaryPaymentMode) }
      : {}),
    ...(input.salaryDetails !== undefined
      ? { salary_details: normalizeEmployeeSalaryDetails(input.salaryDetails) }
      : {}),
  };

  try {
    await supabaseRest<EmployeeCompensationDbRow[]>(
      "employee_compensation?on_conflict=employee_hr_id",
      {
      body: JSON.stringify(payload),
      headers: {
        Prefer: "resolution=merge-duplicates",
      },
      method: "POST",
      },
    );
  } catch (error) {
    // 🔴 THIS BRANCH ENDS IN A SILENT `return`, so its test decides whether a failed SALARY write is
    // degraded or swallowed. It fires only for a genuinely absent relation or column; anything else
    // — a constraint, an invalid payment mode, a permission denial — now throws, as it always should
    // have, instead of reporting a save that never happened.
    if (
      isMissingRelationMessage(error) ||
      isMissingColumnError(error, "salary_details") ||
      isMissingColumnError(error, "payment_mode")
    ) {
      if (input.salaryPaymentMode === undefined) {
        return;
      }

      try {
        await supabaseRest<EmployeeCompensationDbRow[]>(
          "employee_compensation?on_conflict=employee_hr_id",
          {
            body: JSON.stringify({
              employee_hr_id: hrId,
              payment_mode: normalizePayrollPaymentMode(input.salaryPaymentMode),
              updated_at: new Date().toISOString(),
            }),
            headers: {
              Prefer: "resolution=merge-duplicates",
            },
            method: "POST",
          },
        );
      } catch (fallbackError) {
        // Same test on the last resort: give up quietly only when the column or the table is not
        // there to write to.
        if (
          isMissingRelationMessage(fallbackError) ||
          isMissingColumnError(fallbackError, "payment_mode")
        ) {
          return;
        }

        throw fallbackError;
      }

      return;
    }

    throw error;
  }
}

async function upsertEmployeeResidenceLocation(
  input: EmployeeMutationInput,
  hrId: string,
) {
  // The three rules below are in residence-geocode-policy.ts so they can be asserted without a
  // Supabase client -- see the notes there for what each one cost.
  if (residenceUnchanged(input)) return;

  await writeEmployeeResidenceLocation(hrId, {
    residenceAddress: input.residenceAddress ?? null,
    residenceArea: input.residenceArea ?? null,
    residenceCity: input.residenceCity ?? null,
  });
}

/**
 * Write one employee's residence, geocoding the address first.
 *
 * Exported because the hiring pack writes this same record from its structured address block --
 * see src/lib/hiring-pack/residence-address.ts. That caller goes through HERE rather than carrying
 * its own copy, because the rule below has already destroyed data once: under
 * `resolution=merge-duplicates` a null coordinate OVERWRITES a good stored one, so
 * `residenceCoordinateColumns` omits those columns entirely when the geocode produced nothing. A
 * second copy of that would drift, and the drift would stay silent until an outstation claim failed.
 */
export async function writeEmployeeResidenceLocation(
  hrId: string,
  parts: {
    residenceAddress: string | null;
    residenceArea: string | null;
    residenceCity: string | null;
  },
) {
  const residenceAddress = compact(parts.residenceAddress);
  const residenceArea = compact(parts.residenceArea);
  const residenceCity = compact(parts.residenceCity);
  const geocodeQuery = residenceGeocodeQuery([residenceAddress, residenceArea, residenceCity]);
  const geocoded = geocodeQuery
    ? await googleGeocodeAddress(geocodeQuery).catch(() => null)
    : null;

  await supabaseRest<EmployeeResidenceDbRow[]>(
    "employee_locations?on_conflict=employee_hr_id",
    {
      body: JSON.stringify({
        employee_hr_id: hrId,
        geocode_status: residenceAddress
          ? geocoded
            ? "success"
            : "failed"
          : "missing_address",
        residence_address: residenceAddress,
        residence_area: residenceArea,
        residence_city: residenceCity,
        // Omits the coordinate columns entirely when the geocode produced nothing -- under
        // merge-duplicates a null would OVERWRITE a good stored value. See the policy module.
        ...residenceCoordinateColumns(geocoded),
        updated_at: new Date().toISOString(),
      }),
      headers: {
        Prefer: "resolution=merge-duplicates",
      },
      method: "POST",
    },
  );
}

function shouldIgnoreOptionalCascadeError(error: unknown) {
  return isMissingRelationMessage(error) || isEmployeeDirectorySchemaMissing(error);
}

function isMissingReplacementOwnershipRpc(error: unknown) {
  const message = employeeDirectoryErrorMessage(error).toLowerCase();

  return (
    message.includes("phx_reassign_replacement_ownership") ||
    message.includes("could not find the function") ||
    message.includes("schema cache")
  );
}

async function patchOptionalTable(path: string, payload: Record<string, unknown>) {
  try {
    await supabaseRest(path, {
      body: JSON.stringify(payload),
      headers: {
        Prefer: "return=minimal",
      },
      method: "PATCH",
    });
  } catch (error) {
    if (!shouldIgnoreOptionalCascadeError(error)) {
      throw error;
    }
  }
}

async function replacementForVacancy(vacancyId: number | null | undefined) {
  if (!vacancyId) {
    return null;
  }

  try {
    const rows = await supabaseRest<Array<{
      effective_date?: string | null;
      employee_hr_id: string | null;
      last_working_date?: string | null;
    }>>(
      `employee_resignations?${new URLSearchParams({
        limit: "1",
        order: "created_at.desc",
        select: "employee_hr_id,effective_date,last_working_date",
        vacancy_id: `eq.${vacancyId}`,
      })}`,
    );
    const row = rows[0];
    return row?.employee_hr_id
      ? {
          effectiveDate: row.effective_date ?? row.last_working_date ?? null,
          hrId: normalizeHrId(row.employee_hr_id),
        }
      : null;
  } catch (error) {
    if (shouldIgnoreOptionalCascadeError(error)) {
      return null;
    }
    throw error;
  }
}

async function reassignLiveManagerOwnership(input: {
  effectiveDate?: string | null;
  newManagerHrId: string;
  previousManagerHrId: string;
}) {
  const previousManagerHrId = normalizeHrId(input.previousManagerHrId);
  const newManagerHrId = normalizeHrId(input.newManagerHrId);

  if (!previousManagerHrId || !newManagerHrId || previousManagerHrId === newManagerHrId) {
    return;
  }

  const effectiveDate = compact(input.effectiveDate);
  try {
    await supabaseRest<unknown>("rpc/phx_reassign_replacement_ownership", {
      body: JSON.stringify({
        p_effective_date: effectiveDate ? effectiveDate.slice(0, 10) : null,
        p_previous_hr_id: previousManagerHrId,
        p_replacement_hr_id: newManagerHrId,
      }),
      headers: {
        Prefer: "return=minimal",
      },
      method: "POST",
    });
    return;
  } catch (error) {
    if (!isMissingReplacementOwnershipRpc(error)) {
      throw error;
    }
  }

  const now = new Date().toISOString();
  const previous = encodeURIComponent(previousManagerHrId);
  const nextPayload = {
    manager_hr_id: newManagerHrId,
    updated_at: now,
  };

  await patchOptionalTable(
    `employees?manager_hr_id=eq.${previous}&or=(employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST})`,
    nextPayload,
  );

  await patchOptionalTable(
    `app_auth_users?manager_hr_id=eq.${previous}&is_active=is.true`,
    nextPayload,
  );

  await patchOptionalTable(
    `user_access_profiles?manager_hr_id=eq.${previous}&is_active=is.true`,
    nextPayload,
  );

  await patchOptionalTable(
    `position_vacancies?manager_hr_id=eq.${previous}&status=eq.open`,
    nextPayload,
  );

  // NEITHER sales table is cascaded here, for two different reasons. The cascade ends above.
  //
  // `sales_records` is FROZEN. The Rule #1 migration revoked service_role's INSERT/UPDATE on it,
  // so a PATCH returns `permission denied for table sales_records` (42501). patchOptionalTable
  // swallows only missing-relation / schema-cache messages, so that error THREW — and it threw
  // part-way through, leaving earlier rows on the OLD manager: a half-applied cascade plus a failed
  // manager change. It is also HISTORY. Those rows are the only record of what H1 was actually paid
  // on, and rewriting manager_hr_id across them would restate settled payouts to match today's org
  // chart. Sales attribution now comes from SoS Monthly Closing, which resolves the manager from
  // the seat model per period, so there is nothing left here to keep in sync.
  //
  // `sales_targets` is GONE. It and sales_target_batches were dropped on 2026-09-06
  // (supabase/migrations/20260906001400_drop_the_empty_legacy_sales_target_tables.sql) after
  // holding zero rows for their entire life. The live sales targets are `au.monthly_targets`
  // (src/lib/sales/monthly-targets.ts). The two PATCHes that used to sit here matched nothing.
}

// Server-side backstop: an area_id must reference an existing, ACTIVE area (the 42 canonical areas).
// The picker only offers active areas, but a raw API call could still send a retired/unknown id — reject it.
// null is allowed (managers/office staff carry no sales area).
async function assertActiveCanonicalArea(areaId: number | null | undefined): Promise<void> {
  if (areaId == null) return;
  const rows = await supabaseRest<Array<{ id: number; is_active: boolean | null }>>(
    `areas?id=eq.${areaId}&select=id,is_active`,
  );
  const found = rows[0];
  if (!found) throw new Error(`Area ${areaId} does not exist.`);
  if (found.is_active === false) {
    throw new Error(`Area ${areaId} is inactive (retired) and cannot be assigned.`);
  }
}

// The acting user, threaded down to the `employees` write so the salary-change
// audit trigger can attribute the edit. It travels as request headers on the
// PostgREST call; the trigger reads them back via current_setting('request.headers').
// See supabase/migrations/*_employee_salary_change_log.sql. Absent actor (a system
// or out-of-band write) is recorded too — just without a name.
export type EmployeeMutationActor = {
  actorLoginId?: string | null;
  actorHrId?: string | null;
};

function salaryAuditActorHeaders(actor?: EmployeeMutationActor): Record<string, string> {
  const headers: Record<string, string> = {};
  const loginId = actor?.actorLoginId?.trim();
  const hrId = actor?.actorHrId?.trim();
  // Header values must be ASCII; HR/login ids already are (e.g. "B-10").
  if (loginId) headers["x-phoenix-actor-login-id"] = loginId;
  if (hrId) headers["x-phoenix-actor-hr-id"] = hrId;
  return headers;
}

export async function upsertEmployee(input: EmployeeMutationInput, actor?: EmployeeMutationActor) {
  const hrId = normalizeHrId(input.hrId);
  const originalHrId = normalizeHrId(input.originalHrId);
  const isUpdate = Boolean(originalHrId);
  let previousManagerHrId: string | null = null;

  if (isUpdate) {
    if (!hrId) {
      throw new Error("HR_ID is required for updates.");
    }

    if (hrId !== originalHrId) {
      throw new Error("HR_ID is immutable after employee creation. Use a governed HR_ID rename workflow.");
    }

    const existing = await supabaseRest<Array<{ hr_id: string; manager_hr_id: string | null }>>(
      `employees?hr_id=eq.${encodeURIComponent(originalHrId as string)}&select=hr_id,manager_hr_id`,
    );
    if (existing.length === 0) {
      throw new Error(`Employee ${originalHrId} was not found.`);
    }
    previousManagerHrId = normalizeHrId(existing[0].manager_hr_id);
  } else if (hrId) {
    const existing = await supabaseRest<Array<{ hr_id: string }>>(
      `employees?hr_id=eq.${encodeURIComponent(hrId)}&select=hr_id`,
    );
    if (existing.length > 0) {
      throw new Error(`HR_ID ${hrId} already exists. Open the employee record before editing.`);
    }
  }

  const payload = await employeePayload(input, isUpdate, previousManagerHrId);
  await assertActiveCanonicalArea(payload.area_id);
  const params = new URLSearchParams({
    on_conflict: "hr_id",
  });

  const rows = await supabaseRest<EmployeeDbRow[]>(`employees?${params}`, {
    body: JSON.stringify(payload),
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
      ...salaryAuditActorHeaders(actor),
    },
    method: "POST",
  });

  await Promise.all([
    upsertEmployeeCompensation(payload.hr_id, input),
    upsertEmployeeResidenceLocation(input, payload.hr_id),
  ]);

  // Requirement: closeVacancyOnHire should only run after a NEW employee is created
  if (!isUpdate) {
    const managerName = payload.manager_hr_id
      ? (await loadManagerNames([payload.manager_hr_id])).get(payload.manager_hr_id) ?? null
      : null;
    const closedVacancy = await closeVacancyOnHire({
      area_id: payload.area_id,
      department_id: payload.department_id,
      filled_by_hr_id: payload.hr_id,
      line_id: payload.line_id,
      manager_name: managerName,
      manager_hr_id: payload.manager_hr_id,
      position_id: payload.position_id,
    });

    const resignationReplacement = await replacementForVacancy(closedVacancy?.id);
    const vacancyReplacement = {
      effectiveDate: resignationReplacement?.effectiveDate ?? null,
      hrId: normalizeHrId(closedVacancy?.replacementForHrId) ?? resignationReplacement?.hrId ?? null,
    };

    if (vacancyReplacement?.hrId) {
      await reassignLiveManagerOwnership({
        effectiveDate: vacancyReplacement.effectiveDate,
        newManagerHrId: payload.hr_id,
        previousManagerHrId: vacancyReplacement.hrId,
      });
    }
  }

  invalidateEmployeeDirectoryCache();
  invalidateExecutiveDashboardCache("employee upsert", ["employees", "vacancies", "payroll"]);

  return rows;
}

/**
 * Write ONLY an employee's CRM identity — the account name and code that every CRM read resolves a
 * visit, a check-in or a double visit against (src/lib/crm/identity.ts).
 *
 * This exists so the New Hire CRM Setup tab does not have to go through upsertEmployee. That path
 * takes a whole EmployeeMutationInput and rewrites the row from it, so handing it a two-field form
 * would blank everything the form did not carry — and the person filling this in is the SFE
 * Manager, who does not hold `employees:update` and has no business editing salary or status. A
 * PATCH of two columns cannot damage a field it never names.
 *
 * Both uniqueness guards still run, unchanged: a CRM id or username already assigned to somebody
 * else is refused here exactly as it is on the employee form. Reusing a resigned rep's slot is how
 * an ACTIVE rep gets hidden, so this is the check that matters most on this path.
 */
export async function setEmployeeCrmIdentity(input: {
  crmId: string | null;
  crmUsername: string | null;
  hrId: string;
}) {
  const hrId = normalizeHrId(input.hrId);
  if (!hrId) {
    throw new Error("HR_ID is required.");
  }

  const existing = await supabaseRest<Array<{ hr_id: string }>>(
    `employees?hr_id=eq.${encodeURIComponent(hrId)}&select=hr_id`,
  );
  if (existing.length === 0) {
    throw new Error(`Employee ${hrId} was not found.`);
  }

  const crmId = compact(input.crmId);
  const crmUsername = compact(input.crmUsername);
  await ensureCrmIdIsUnique(crmId, hrId);
  await ensureCrmUsernameIsUnique(crmUsername, hrId);

  const rows = await supabaseRest<EmployeeDbRow[]>(
    `employees?hr_id=eq.${encodeURIComponent(hrId)}`,
    {
      body: JSON.stringify({
        crm_id: crmId,
        crm_username: crmUsername,
        updated_at: new Date().toISOString(),
      }),
      headers: {
        Prefer: "return=representation",
      },
      method: "PATCH",
    },
  );

  invalidateEmployeeDirectoryCache();

  return rows[0] ?? null;
}

/**
 * Write ONLY an employee's company email address — for the New Hire Mailboxes page, once Turbify has
 * accepted an app password for that address. A PATCH of one column, for the same reason as
 * setEmployeeCrmIdentity above: upsertEmployee would rewrite the whole row from a one-field form.
 *
 * `employees.work_email` is UNIQUE, but case-sensitively, so "Ahmed.Ali@" and "ahmed.ali@" would
 * both pass it. This refuses a match in any case first, naming the person who holds the address.
 */
export async function setEmployeeWorkEmail(input: { hrId: string; workEmail: string }) {
  const hrId = normalizeHrId(input.hrId);
  if (!hrId) {
    throw new Error("HR_ID is required.");
  }
  const workEmail = input.workEmail.trim().toLowerCase();
  if (!workEmail) {
    throw new Error("A work email is required.");
  }

  const existing = await supabaseRest<Array<{ hr_id: string }>>(
    `employees?hr_id=eq.${encodeURIComponent(hrId)}&select=hr_id`,
  );
  if (existing.length === 0) {
    throw new Error(`Employee ${hrId} was not found.`);
  }

  // ilike treats `_` as a wildcard, so it can over-match; the exact comparison below narrows it.
  // Percent-encoded and NOT quoted, for the reason given in ensureCrmUsernameIsUnique: a plain
  // query parameter has no structural characters, and quoting it makes the read match nothing.
  // Over-matching here is safe; under-matching would admit a duplicate.
  const holders = await supabaseRest<Array<{ full_name: string | null; hr_id: string; work_email: string | null }>>(
    `employees?work_email=ilike.${encodeURIComponent(workEmail)}&select=hr_id,full_name,work_email`,
  );
  const conflict = holders.find(
    (row) => (row.work_email ?? "").trim().toLowerCase() === workEmail && normalizeHrId(row.hr_id) !== hrId,
  );
  if (conflict) {
    throw new Error(`${workEmail} is already the work email of ${conflict.full_name?.trim() || conflict.hr_id}.`);
  }

  const rows = await supabaseRest<EmployeeDbRow[]>(
    `employees?hr_id=eq.${encodeURIComponent(hrId)}`,
    {
      body: JSON.stringify({ updated_at: new Date().toISOString(), work_email: workEmail }),
      headers: { Prefer: "return=representation" },
      method: "PATCH",
    },
  );

  invalidateEmployeeDirectoryCache();

  return rows[0] ?? null;
}

export async function bulkUpdateEmployees(
  hrIds: string[],
  values: Pick<
    EmployeeMutationInput,
    | "areaId"
    | "departmentId"
    | "employmentStatus"
    | "lineId"
    | "managerHrId"
    | "positionId"
  >,
) {
  const cleanedHrIds = Array.from(new Set(hrIds.map(compact).filter(Boolean))) as string[];

  if (cleanedHrIds.length === 0) {
    throw new Error("Select at least one employee.");
  }

  const employmentStatus = values.employmentStatus === undefined
    ? undefined
    : normalizeLifecycleStatus(values.employmentStatus);

  if (employmentStatus !== undefined && !statusOptions.includes(employmentStatus)) {
    throw new Error(`Employment status ${employmentStatus} is not allowed.`);
  }

  if (values.areaId !== undefined) {
    await assertActiveCanonicalArea(numberOrNull(values.areaId));
  }

  // When a bulk edit sets BOTH line and area, every selected employee lands on the same sales seat,
  // so derive the region once and apply it. If only one of the two changes, the region can't be
  // derived uniformly (the other varies per employee) and is left untouched.
  const bulkDerivedRegion =
    values.areaId !== undefined && values.lineId !== undefined
      ? await resolveRegionByIds(numberOrNull(values.lineId), numberOrNull(values.areaId))
      : null;

  const payload = {
    ...(values.areaId !== undefined ? { area_id: numberOrNull(values.areaId) } : {}),
    ...(values.departmentId !== undefined
      ? { department_id: numberOrNull(values.departmentId) }
      : {}),
    ...(employmentStatus !== undefined
      ? {
          employment_status: employmentStatus,
          organogram_visible: isActiveLifecycleStatus(employmentStatus),
          ...(!isActiveLifecycleStatus(employmentStatus) ? { payroll_eligible: false } : {}),
        }
      : {}),
    ...(values.lineId !== undefined ? { line_id: numberOrNull(values.lineId) } : {}),
    ...(bulkDerivedRegion
      ? {
          region_code: bulkDerivedRegion.regionCode,
          ...(bulkDerivedRegion.regionName ? { region_name: bulkDerivedRegion.regionName } : {}),
        }
      : {}),
    ...(values.managerHrId !== undefined
      ? { manager_hr_id: normalizeHrId(values.managerHrId) }
      : {}),
    ...(values.positionId !== undefined
      ? { position_id: numberOrNull(values.positionId) }
      : {}),
    updated_at: new Date().toISOString(),
  };

  const rows = await supabaseRest<EmployeeDbRow[]>(
    `employees?hr_id=${encodeURIComponent(textInFilter(cleanedHrIds))}`,
    {
      body: JSON.stringify(payload),
      headers: {
        Prefer: "return=representation",
      },
      method: "PATCH",
    },
  );

  invalidateEmployeeDirectoryCache();
  invalidateExecutiveDashboardCache("employee bulk update", ["employees", "vacancies", "payroll"]);

  return rows;
}
