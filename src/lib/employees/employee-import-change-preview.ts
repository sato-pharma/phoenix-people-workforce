/**
 * What an employee import will actually change, person by person.
 *
 * WHY THIS EXISTS. The import preview said "247 to update" and offered a Confirm button. That is a
 * count, not information: it does not say whose salary moves, whether a manager is being reassigned,
 * or that one row will quietly rename someone. On an import that touches payroll, being asked to
 * approve a number is being asked to approve nothing.
 *
 * This computes the diff the person is really being asked to approve — the fields that differ
 * between the uploaded row and the record as it stands — so the confirm step shows changes rather
 * than counts.
 *
 * IT TELLS THE TRUTH ABOUT SALARY, which is not free. The validator does not merely warn when a
 * typed salary disagrees with payroll policy; it OVERWRITES `record.compensation` with the policy
 * figure before returning. So the "after" values here are what will really be written, not what was
 * typed — which is the only version worth showing, since the other one would have the preview
 * disagree with the database the moment the import ran.
 *
 * SOCIAL INSURANCE JOB TITLE COMES FROM THE ROUTE, NOT THE DIRECTORY. Every other column on this
 * sheet is a field of the employee record; this one is `employee_hiring_profile.job_title_ar`,
 * which the directory row does not carry. It is NOT added to the directory to fix that — that path
 * is loaded by every command-centre widget on the platform, and it would pay for a second table on
 * every one of them to diff a column only the import screen reads. The dry-run route fetches it for
 * the rows in the file and passes it in, so the cost lands on the one screen that needs it.
 *
 * A BLANK IS NOT A CHANGE. The confirm route omits null fields from its update payload rather than
 * writing them, so clearing a cell leaves the stored value alone. Treating a blank as "change this
 * to nothing" would invent hundreds of changes on any partially filled sheet and bury the real ones.
 */

import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import type { EmployeeImportRecord } from "@/lib/imports/employee-import-types";

export type ImportChangeGroup =
  | "Identity"
  | "Organization"
  | "Contact & Residence"
  | "CRM"
  | "Payroll"
  | "System";

export type ImportFieldChange = {
  /** The column header as the template prints it. */
  label: string;
  group: ImportChangeGroup;
  /** Rendered current value, or an em dash when there is none. */
  before: string;
  /** Rendered value that will be written. */
  after: string;
  /** Money moves get called out separately — they are the ones worth a second look. */
  isMoney: boolean;
};

export type ImportPersonChanges = {
  hrId: string;
  fullName: string;
  rowNumber: number | null;
  changes: ImportFieldChange[];
};

export type ImportChangePreview = {
  /** Only people with at least one real change, in file order. */
  people: ImportPersonChanges[];
  fieldChangeCount: number;
  moneyChangeCount: number;
  /** Matched rows whose every cell already agrees with the record. */
  unchangedPeopleCount: number;
};

const EM_DASH = "—";

type Comparison = "text" | "date" | "money" | "boolean";

/**
 * The "before" values that do NOT come off the employee record.
 *
 * One so far: the insurance job title, which lives in `employee_hiring_profile`. The rest of this
 * diff reads the directory row the page already holds, and this is the seam for anything that
 * cannot.
 */
type PersonContext = { socialInsuranceJobTitle: string | null };

type FieldSpec = {
  label: string;
  group: ImportChangeGroup;
  compare: Comparison;
  from: (record: EmployeeImportRecord) => unknown;
  to: (employee: EmployeeDirectoryRow, context: PersonContext) => unknown;
};

/** The one field whose "before" is not on the employee record — dropped when it was not loaded. */
const SOCIAL_INSURANCE_JOB_TITLE_LABEL = "Social Insurance Job Title";

/**
 * The fields an upload can change, with the header each is called on the sheet.
 *
 * Ordered as the template orders its columns, so a person reading the diff and a person reading
 * the workbook are walking the same list.
 */
const FIELDS: FieldSpec[] = [
  { compare: "text", from: (r) => r.fullName, group: "Identity", label: "Full English Name", to: (e) => e.fullName },
  { compare: "text", from: (r) => r.nickname, group: "Identity", label: "Nickname", to: (e) => e.nickname },
  { compare: "text", from: (r) => r.nameAr, group: "Identity", label: "Full Arabic Name", to: (e) => e.nameAr },
  { compare: "text", from: (r) => r.nationalId, group: "Identity", label: "National ID", to: (e) => e.nationalId },
  { compare: "text", from: (r) => r.gender, group: "Identity", label: "Gender", to: (e) => e.gender },
  { compare: "date", from: (r) => r.birthDate, group: "Identity", label: "Birth Date", to: (e) => e.birthDate },
  { compare: "text", from: (r) => r.birthPlace, group: "Identity", label: "Birth Place", to: (e) => e.birthPlace },
  { compare: "text", from: (r) => r.qualification, group: "Identity", label: "Qualification (Bachelor - license)", to: (e) => e.qualification },
  // "College Name" is employees.education — the college, which is what that column has always held.
  { compare: "text", from: (r) => r.education, group: "Identity", label: "College Name", to: (e) => e.education },
  { compare: "text", from: (r) => r.universityName, group: "Identity", label: "University Name", to: (e) => e.universityName },
  { compare: "text", from: (r) => r.collegeMajor, group: "Identity", label: "College major", to: (e) => e.collegeMajor },
  { compare: "text", from: (r) => r.seniorYear, group: "Identity", label: "senior year", to: (e) => e.seniorYear },
  // A number on both sides, already rounded to one decimal, so "text" compares it exactly: 2 and 2.0
  // both render "2". Not "money" — that would format it with two decimals and count it as a pay move.
  { compare: "text", from: (r) => r.totalExperienceYears, group: "Identity", label: "Total years of experience", to: (e) => e.totalExperienceYears },

  { compare: "text", from: (r) => r.departmentName, group: "Organization", label: "Department", to: (e) => e.departmentName },
  { compare: "text", from: (r) => r.lineName, group: "Organization", label: "Line", to: (e) => e.lineName },
  { compare: "text", from: (r) => r.areaName, group: "Organization", label: "Area", to: (e) => e.areaName },
  { compare: "text", from: (r) => r.regionName, group: "Organization", label: "Region", to: (e) => e.regionName },
  { compare: "text", from: (r) => r.teamName, group: "Organization", label: "Team", to: (e) => e.teamName },
  { compare: "text", from: (r) => r.jobTitle, group: "Organization", label: "Title", to: (e) => e.jobTitle },
  { compare: "text", from: (r) => r.positionTitle, group: "Organization", label: "Position", to: (e) => e.positionTitle },
  { compare: "text", from: (r) => r.managerHrId, group: "Organization", label: "Manager HR_ID", to: (e) => e.managerHrId },
  { compare: "date", from: (r) => r.hireDate, group: "Organization", label: "Hiring Date", to: (e) => e.hireDate },
  { compare: "date", from: (r) => r.probationEndDate, group: "Organization", label: "End date of probation period", to: (e) => e.probationEndDate },
  { compare: "text", from: (r) => r.employmentStatus, group: "Organization", label: "Employment Status", to: (e) => e.employmentStatus },
  { compare: "text", from: (r) => r.contractType, group: "Organization", label: "Contract Type", to: (e) => e.contractType },
  { compare: "text", from: (r) => r.contractDuration, group: "Organization", label: "contract duration", to: (e) => e.contractDuration },
  { compare: "date", from: (r) => r.contractRenewalDate, group: "Organization", label: "Contract Renewal Date", to: (e) => e.contractRenewalDate },

  { compare: "text", from: (r) => r.workEmail, group: "Contact & Residence", label: "Email", to: (e) => e.workEmail },
  { compare: "text", from: (r) => r.mobileNumber, group: "Contact & Residence", label: "Phone", to: (e) => e.mobileNumber },
  { compare: "text", from: (r) => r.residenceAddress, group: "Contact & Residence", label: "Residence Address", to: (e) => e.residenceAddress },
  { compare: "text", from: (r) => r.residenceCity, group: "Contact & Residence", label: "Residence City", to: (e) => e.residenceCity },
  { compare: "text", from: (r) => r.residenceArea, group: "Contact & Residence", label: "Residence Area", to: (e) => e.residenceArea },

  { compare: "text", from: (r) => r.crmId, group: "CRM", label: "CRM ID", to: (e) => e.crmId },
  { compare: "text", from: (r) => r.crmUsername, group: "CRM", label: "CRM Username", to: (e) => e.crmUsername },

  { compare: "money", from: (r) => r.compensation.basicSalary, group: "Payroll", label: "Basic Salary", to: (e) => e.basicSalary },
  { compare: "money", from: (r) => r.compensation.baseSalary, group: "Payroll", label: "Base Salary", to: (e) => e.baseSalary },
  { compare: "money", from: (r) => r.compensation.grossSalary, group: "Payroll", label: "Gross Salary", to: (e) => e.grossSalary },
  { compare: "money", from: (r) => r.compensation.netSalary, group: "Payroll", label: "Net Salary", to: (e) => e.netSalary },
  { compare: "money", from: (r) => r.compensation.fuelAllowance, group: "Payroll", label: "Fuel Allowance", to: (e) => e.fuelAllowance },
  { compare: "money", from: (r) => r.compensation.extraCostOfLiving, group: "Payroll", label: "Extra Cost Of Living", to: (e) => e.extraCostOfLiving },
  { compare: "money", from: (r) => r.compensation.medicalInsurance, group: "Payroll", label: "Medical Insurance", to: (e) => e.medicalInsurance },
  { compare: "money", from: (r) => r.compensation.socialInsurance, group: "Payroll", label: "Social Insurance", to: (e) => e.socialInsurance },
  { compare: "money", from: (r) => r.compensation.taxes, group: "Payroll", label: "Taxes", to: (e) => e.taxes },
  { compare: "text", from: (r) => r.compensation.paymentMode, group: "Payroll", label: "Payment Mode", to: (e) => e.salaryPaymentMode },
  { compare: "text", from: (r) => r.hasBankAccount, group: "Payroll", label: "Has Bank Account", to: (e) => e.hasBankAccount },
  { compare: "text", from: (r) => r.bankName, group: "Payroll", label: "Bank Name", to: (e) => e.bankName },
  { compare: "text", from: (r) => r.bankAccount, group: "Payroll", label: "Bank Account", to: (e) => e.bankAccount },
  { compare: "boolean", from: (r) => r.payrollEligible, group: "Payroll", label: "Payroll Eligible", to: (e) => e.payrollEligible },

  { compare: "text", from: (r) => r.medicalInsuranceNumber, group: "Payroll", label: "Medical Insurance Card Number", to: (e) => e.medicalInsuranceNumber },
  { compare: "date", from: (r) => r.medicalInsuranceCardReceivedDate, group: "Payroll", label: "Medical Insurance Card Receipt Date", to: (e) => e.medicalInsuranceCardReceivedDate },
  { compare: "text", from: (r) => r.medicalInsuranceStatus, group: "Payroll", label: "Medical Insurance Card Received (Yes-No)", to: (e) => e.medicalInsuranceStatus },

  // The GOVERNMENT booklet, never the private card above it — the owner drew that line himself.
  { compare: "text", from: (r) => r.healthCardNumber, group: "Payroll", label: "Health Insurance Card Number", to: (e) => e.healthCardNumber },
  { compare: "date", from: (r) => r.healthCardReceivedDate, group: "Payroll", label: "Health Insurance Card Receipt Date", to: (e) => e.healthCardReceivedDate },
  { compare: "text", from: (r) => r.healthCardStatus, group: "Payroll", label: "Health Insurance Card Received (Yes-No)", to: (e) => e.healthCardStatus },

  { compare: "text", from: (r) => r.socialInsuranceStatus, group: "Payroll", label: "In Social Insurance", to: (e) => e.socialInsuranceStatus },
  { compare: "text", from: (r) => r.socialInsuranceNumber, group: "Payroll", label: "Social Insurance Number", to: (e) => e.socialInsuranceNumber },
  { compare: "text", from: (r) => r.socialInsuranceJobTitle, group: "Payroll", label: SOCIAL_INSURANCE_JOB_TITLE_LABEL, to: (_employee, context) => context.socialInsuranceJobTitle },
  { compare: "date", from: (r) => r.socialInsuranceStartDate, group: "Payroll", label: "Social insurance start date", to: (e) => e.socialInsuranceStartDate },

  { compare: "text", from: (r) => r.kaabElamaalNumber, group: "Payroll", label: "Kaab Elamaal Number", to: (e) => e.kaabElamaalNumber },
  { compare: "text", from: (r) => r.kaabElamaalIssuer, group: "Payroll", label: "Kaab Elamaal Issuer", to: (e) => e.kaabElamaalIssuer },
  { compare: "date", from: (r) => r.kaabElamaalIssueDate, group: "Payroll", label: "Kaab Elamaal Issue Date", to: (e) => e.kaabElamaalIssueDate },
  { compare: "text", from: (r) => r.kaabElamaalRefund, group: "Payroll", label: "Kaab Elamaal refund (Yes-No)", to: (e) => e.kaabElamaalRefund },

  { compare: "boolean", from: (r) => r.organogramVisible, group: "System", label: "Organogram Visible", to: (e) => e.organogramVisible },
];

/** Absent means "the cell was left blank", which the upload skips rather than writes. */
function isAbsent(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}

function asText(value: unknown): string {
  if (isAbsent(value)) return "";
  return String(value).trim();
}

function asDate(value: unknown): string {
  const text = asText(value);
  return text ? text.slice(0, 10) : "";
}

function asNumber(value: unknown): number | null {
  if (isAbsent(value)) return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * "Yes"/"No" on the sheet, a boolean in the record.
 *
 * Returns null for anything that is neither, so an unrecognised word reads as "not provided" and
 * cannot flip a flag by accident.
 */
function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const text = asText(value).toLowerCase();
  if (["yes", "true", "1", "y"].includes(text)) return true;
  if (["no", "false", "0", "n"].includes(text)) return false;
  return null;
}

function formatMoney(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function renderValue(value: unknown, compare: Comparison): string {
  if (compare === "money") {
    const number = asNumber(value);
    return number === null ? EM_DASH : formatMoney(number);
  }
  if (compare === "boolean") {
    const flag = asBoolean(value);
    return flag === null ? EM_DASH : flag ? "Yes" : "No";
  }
  if (compare === "date") {
    const date = asDate(value);
    return date || EM_DASH;
  }
  const text = asText(value);
  return text || EM_DASH;
}

/** Null when the field is unchanged (or was left blank), otherwise the rendered before/after. */
function diffField(
  spec: FieldSpec,
  record: EmployeeImportRecord,
  employee: EmployeeDirectoryRow,
  context: PersonContext,
): ImportFieldChange | null {
  const uploaded = spec.from(record);
  if (isAbsent(uploaded)) return null;

  const current = spec.to(employee, context);

  if (spec.compare === "money") {
    const next = asNumber(uploaded);
    const now = asNumber(current);
    if (next === null) return null;
    // Half a piastre: two values that render identically must not be reported as a change.
    if (now !== null && Math.abs(next - now) < 0.005) return null;
  } else if (spec.compare === "boolean") {
    const next = asBoolean(uploaded);
    if (next === null) return null;
    if (asBoolean(current) === next) return null;
  } else if (spec.compare === "date") {
    if (asDate(uploaded) === asDate(current)) return null;
  } else if (asText(uploaded) === asText(current)) {
    return null;
  }

  return {
    after: renderValue(uploaded, spec.compare),
    before: renderValue(current, spec.compare),
    group: spec.group,
    isMoney: spec.compare === "money",
    label: spec.label,
  };
}

export type BuildImportChangePreviewInput = {
  /** The dry run's `rowsToUpdate` — rows matched to an employee that already exists. */
  records: EmployeeImportRecord[];
  /** The directory the page already holds. No extra fetch. */
  employees: EmployeeDirectoryRow[];
  /**
   * HR id -> the insurance job title on file, from the dry-run route.
   *
   * ITS ABSENCE IS MEANINGFUL, not a default. Leave it out and the insurance title row is dropped
   * from the diff entirely, because the "before" side is then unknown — and an unknown rendered as
   * blank would report every filled cell in that column as a change from nothing, on every upload
   * of a sheet that simply carries the titles it was exported with. An hr id MISSING from a map
   * that WAS supplied is different: it means no profile row, which really is blank.
   */
  socialInsuranceJobTitles?: Record<string, string | null>;
};

/**
 * Diffs each matched row against the record it will update.
 *
 * HR_IDs are matched case-insensitively, the same way the importer resolves them — a sheet typed
 * as "a-12" against a stored "A-12" is the same person, and treating it as unmatched would drop
 * that person's changes out of the preview entirely while the import still applied them.
 */
export function buildImportChangePreview(input: BuildImportChangePreviewInput): ImportChangePreview {
  const byHrId = new Map<string, EmployeeDirectoryRow>();
  for (const employee of input.employees) {
    if (employee.hrId) byHrId.set(employee.hrId.trim().toLowerCase(), employee);
  }

  // The insurance titles are matched on the same lower-cased key as the employees, because the
  // route that loads them reads `employee_hiring_profile`, whose HR ids are canonicalised for
  // display while the directory's are not.
  const titles = input.socialInsuranceJobTitles;
  const titleByHrId = new Map<string, string | null>();
  for (const [hrId, title] of Object.entries(titles ?? {})) {
    titleByHrId.set(hrId.trim().toLowerCase(), title);
  }

  const specs = titles
    ? FIELDS
    : FIELDS.filter((spec) => spec.label !== SOCIAL_INSURANCE_JOB_TITLE_LABEL);

  const people: ImportPersonChanges[] = [];
  let fieldChangeCount = 0;
  let moneyChangeCount = 0;
  let unchangedPeopleCount = 0;

  for (const record of input.records) {
    const key = record.hrId?.trim().toLowerCase() ?? "";
    const employee = key ? byHrId.get(key) : undefined;
    // No match means the row creates someone rather than changing them; that is not a diff.
    if (!employee) continue;

    const context: PersonContext = { socialInsuranceJobTitle: titleByHrId.get(key) ?? null };

    const changes: ImportFieldChange[] = [];
    for (const spec of specs) {
      const change = diffField(spec, record, employee, context);
      if (change) changes.push(change);
    }

    if (changes.length === 0) {
      unchangedPeopleCount += 1;
      continue;
    }

    fieldChangeCount += changes.length;
    moneyChangeCount += changes.filter((change) => change.isMoney).length;
    people.push({
      changes,
      fullName: employee.fullName || record.fullName || record.hrId || "Unknown",
      hrId: employee.hrId,
      rowNumber: typeof record.rowNumber === "number" ? record.rowNumber : null,
    });
  }

  return { fieldChangeCount, moneyChangeCount, people, unchangedPeopleCount };
}
