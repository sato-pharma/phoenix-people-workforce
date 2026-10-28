// A PAPER TYPED IN BY HAND — "to be abl to manually write variable data and also fixed data auto
// populates" (the owner, 2026-09-13).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SAME RENDERERS, A DIFFERENT PACK. Every paper in this module is drawn from a `HiringPackData`.
// Normally `getHiringPack` builds one from the employee's rows; here it is built from what somebody
// typed, and the COMPANY half is still the company record — the fixed data, the part nobody should
// retype and nobody can get wrong. Nothing else about the paper differs, so a typed-in contract and
// a record-filled contract cannot come out as two different documents.
//
// NOTHING TYPED HERE IS SAVED to any employee's record. A paper typed in by hand is for somebody the
// system may not hold at all — a candidate, a contractor, a person whose record is still being
// created — and writing it back would put a stranger's national ID onto whichever row happened to
// match. What IS recorded is the paper's number and the name it was issued to, in the register.
//
// THE KEYS ARE `<store>.<field>` and the list is CLOSED. A body can only set a value the renderers
// actually read, so a crafted request cannot plant `employee.departed = true` or a company value.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import type { CompanyDetails } from "@/lib/hiring-pack/company-details";
import { documentFieldInventory } from "@/lib/hiring-pack/document-inventory";
import type { PrintableDocument } from "@/lib/hiring-pack/document-registry";
import { insuranceWageFromBase } from "@/lib/hiring-pack/insurance-wage";
import { paperFieldBinding } from "@/lib/hiring-pack/paper-fields";
import {
  collectHiringPackGaps,
  emptyOffboardingProfile,
  emptyProfile,
  resolveContractTerms,
} from "@/lib/hiring-pack/service";
import type {
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
  OffboardingProfile,
} from "@/lib/hiring-pack/types";

export type ManualFieldKind = "text" | "date" | "money" | "number";

export type ManualPaperInput = {
  key: string;
  labelEn: string;
  kind: ManualFieldKind;
};

type FieldSpec = { labelEn: string; kind: ManualFieldKind };

/** Every value a typed-in paper may set, with what it is called on screen. */
export const MANUAL_FIELDS: Readonly<Record<string, FieldSpec>> = {
  "employee.nameAr": { labelEn: "Name (Arabic)", kind: "text" },
  "employee.fullName": { labelEn: "Name (English)", kind: "text" },
  "employee.hrId": { labelEn: "Employee code", kind: "text" },
  "employee.nationalId": { labelEn: "National ID", kind: "text" },
  "employee.socialInsuranceNumber": { labelEn: "Insurance number", kind: "text" },
  "employee.gender": { labelEn: "Gender (male / female)", kind: "text" },
  "employee.birthDate": { labelEn: "Date of birth", kind: "date" },
  "employee.hireDate": { labelEn: "Hire date", kind: "date" },
  "employee.jobTitle": { labelEn: "Job title (English)", kind: "text" },
  "employee.departmentAr": { labelEn: "Department (Arabic)", kind: "text" },
  "employee.baseSalary": { labelEn: "Base salary", kind: "money" },
  "employee.residenceAddress": { labelEn: "Home address", kind: "text" },
  "employee.residenceCity": { labelEn: "City", kind: "text" },
  "employee.mobileNumber": { labelEn: "Mobile number", kind: "text" },
  "employee.workEmail": { labelEn: "Email", kind: "text" },

  "profile.jobTitleAr": { labelEn: "Job title (Arabic)", kind: "text" },
  "profile.nationality": { labelEn: "Nationality", kind: "text" },
  "profile.qualification": { labelEn: "Qualification", kind: "text" },
  "profile.birthPlace": { labelEn: "Place of birth", kind: "text" },
  "profile.occupationCode": { labelEn: "Occupation code", kind: "text" },
  "profile.insuranceOffice": { labelEn: "Insurance office", kind: "text" },
  "profile.addressBuilding": { labelEn: "Building number", kind: "text" },
  "profile.addressStreet": { labelEn: "Street", kind: "text" },
  "profile.addressDistrict": { labelEn: "Sheyakha / village code", kind: "text" },
  "profile.addressMarkaz": { labelEn: "Qism / markaz code", kind: "text" },
  "profile.addressGovernorate": { labelEn: "Governorate code", kind: "text" },
  "profile.contractStartDate": { labelEn: "Contract start date", kind: "date" },
  "profile.contractEndDate": { labelEn: "Contract end date", kind: "date" },
  "profile.contractDurationMonths": { labelEn: "Contract duration (months)", kind: "number" },
  "profile.underperformanceThresholdPct": { labelEn: "Underperformance %", kind: "number" },
  "profile.underperformanceMonths": { labelEn: "Underperformance months", kind: "number" },
  "profile.trainingBondMonths": { labelEn: "Training bond (months)", kind: "number" },
  "profile.contractSignatoryNameAr": { labelEn: "Signed for the company by", kind: "text" },
  "profile.contractSignatoryTitleAr": { labelEn: "Signatory's capacity", kind: "text" },

  "offboarding.lastWorkingDate": { labelEn: "Last working day", kind: "date" },
  "offboarding.endReasonAr": { labelEn: "Reason for leaving (Arabic)", kind: "text" },
  "offboarding.endReasonCode": { labelEn: "Reason code", kind: "text" },
  "offboarding.agreementDate": { labelEn: "Agreement date", kind: "date" },
  "offboarding.addresseeNameAr": { labelEn: "Addressed to", kind: "text" },
  "offboarding.addresseeTitleAr": { labelEn: "Addressee title", kind: "text" },
  "offboarding.employerRepNameAr": { labelEn: "Signs for the company", kind: "text" },
  "offboarding.employerRepTitleAr": { labelEn: "Company signatory's title", kind: "text" },
};

/** The values every typed-in paper asks for first, whatever the paper. */
const BASELINE_KEYS = [
  "employee.nameAr",
  "employee.nationalId",
  "profile.jobTitleAr",
  "employee.departmentAr",
  "employee.hireDate",
] as const;

/**
 * What the ENGLISH papers print that the field inventory cannot offer a box for.
 *
 * Their tokens — `EMPLOYEE_NAME_EN`, `JOB_TITLE_EN`, `BASE_SALARY_EN` — carry no binding (they are
 * English-only or derived), so without this a typed-in English paper would have no box for the name
 * it certifies. The salary letter asks for the BASE salary, and since 2026-10-28 it prints that figure
 * as it is.
 */
const DOCUMENT_KEYS: Readonly<Partial<Record<string, readonly string[]>>> = {
  experienceCertificateEn: ["employee.fullName", "employee.gender", "employee.hrId", "employee.jobTitle"],
  salaryLetterEn: [
    "employee.fullName",
    "employee.gender",
    "employee.hrId",
    "employee.jobTitle",
    "employee.baseSalary",
  ],
  // The Arabic letter uses BASELINE_KEYS like every other Arabic HR paper; the one thing baseline
  // does not already cover is the base salary it states.
  salaryLetterAr: ["employee.baseSalary"],
};

export type ManualPaperValues = Readonly<Record<string, string>>;

/** Keep only the keys a typed-in paper may set, each trimmed and bounded. */
export function sanitizeManualValues(raw: unknown): Record<string, string> {
  const values: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return values;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(key in MANUAL_FIELDS) || typeof value !== "string") continue;
    values[key] = value.slice(0, 500);
  }
  return values;
}

function text(values: ManualPaperValues, key: string): string | null {
  const value = (values[key] ?? "").trim();
  return value ? value : null;
}

function date(values: ManualPaperValues, key: string): string | null {
  const value = text(values, key);
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function number(values: ManualPaperValues, key: string): number | null {
  const value = text(values, key);
  if (!value) return null;
  const parsed = Number(value.replace(/[,\s]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * A complete pack built from typed values and the company record.
 *
 * `departed` follows the last working day: a typed-in paper with one prints as somebody who has left
 * (the certificate of experience then states that his service ENDED), and without one as somebody
 * still employed — the same reading the record-filled papers make.
 */
export function buildManualHiringPack(
  values: ManualPaperValues,
  company: CompanyDetails,
): HiringPackData {
  const hrId = text(values, "employee.hrId") ?? "";
  const nameAr = text(values, "employee.nameAr");
  const baseSalary = number(values, "employee.baseSalary");
  const lastWorkingDate = date(values, "offboarding.lastWorkingDate");

  const employee: HiringPackEmployeeFacts = {
    hrId,
    fullName: text(values, "employee.fullName") ?? nameAr ?? "",
    nameAr,
    nationalId: text(values, "employee.nationalId"),
    gender: text(values, "employee.gender"),
    socialInsuranceNumber: text(values, "employee.socialInsuranceNumber"),
    socialInsuranceWage: insuranceWageFromBase(baseSalary),
    baseSalary,
    grossSalary: null,
    birthDate: date(values, "employee.birthDate"),
    hireDate: date(values, "employee.hireDate"),
    jobTitle: text(values, "employee.jobTitle"),
    departmentAr: text(values, "employee.departmentAr"),
    departmentId: null,
    lineId: null,
    residenceAddress: text(values, "employee.residenceAddress"),
    residenceCity: text(values, "employee.residenceCity"),
    mobileNumber: text(values, "employee.mobileNumber"),
    workEmail: text(values, "employee.workEmail"),
    employmentStatus: lastWorkingDate ? "resigned" : "active",
    departed: Boolean(lastWorkingDate),
    lastWorkingDate,
  };

  const profile: HiringPackProfile = {
    ...emptyProfile(hrId),
    jobTitleAr: text(values, "profile.jobTitleAr"),
    nationality: text(values, "profile.nationality"),
    qualification: text(values, "profile.qualification"),
    birthPlace: text(values, "profile.birthPlace"),
    occupationCode: text(values, "profile.occupationCode"),
    insuranceOffice: text(values, "profile.insuranceOffice"),
    addressBuilding: text(values, "profile.addressBuilding"),
    addressStreet: text(values, "profile.addressStreet"),
    addressDistrict: text(values, "profile.addressDistrict"),
    addressMarkaz: text(values, "profile.addressMarkaz"),
    addressGovernorate: text(values, "profile.addressGovernorate"),
    contractStartDate: date(values, "profile.contractStartDate"),
    contractEndDate: date(values, "profile.contractEndDate"),
    contractDurationMonths: number(values, "profile.contractDurationMonths"),
    underperformanceThresholdPct: number(values, "profile.underperformanceThresholdPct"),
    underperformanceMonths: number(values, "profile.underperformanceMonths"),
    trainingBondMonths: number(values, "profile.trainingBondMonths"),
    contractSignatoryNameAr: text(values, "profile.contractSignatoryNameAr"),
    contractSignatoryTitleAr: text(values, "profile.contractSignatoryTitleAr"),
  };

  const offboarding: OffboardingProfile = {
    ...emptyOffboardingProfile(hrId),
    lastWorkingDate,
    endReasonAr: text(values, "offboarding.endReasonAr"),
    endReasonCode: text(values, "offboarding.endReasonCode"),
    agreementDate: date(values, "offboarding.agreementDate"),
    addresseeNameAr: text(values, "offboarding.addresseeNameAr"),
    addresseeTitleAr: text(values, "offboarding.addresseeTitleAr"),
    employerRepNameAr: text(values, "offboarding.employerRepNameAr"),
    employerRepTitleAr: text(values, "offboarding.employerRepTitleAr"),
  };

  return {
    employee,
    profile,
    offboarding,
    company,
    exit: null,
    custodyDevice: null,
    renewal: null,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, null, company),
    terms: resolveContractTerms(employee, profile, offboarding, null, company),
  };
}

/**
 * The boxes to show for one paper: the baseline first, then every value this paper actually prints,
 * in the order it prints them.
 *
 * READ FROM THE RENDERED PAPER, not from a list kept beside it, so a new field on a paper appears as
 * a box without anybody editing this file. Company values are left out on purpose — they are the
 * fixed data and fill themselves. A date the paper prints as three boxes is ONE box here.
 */
export function manualPaperInputs(
  document: PrintableDocument,
  data: HiringPackData,
  html: string,
  leaving: boolean,
): ManualPaperInput[] {
  const keys: string[] = [...BASELINE_KEYS];
  if (leaving) keys.push("offboarding.lastWorkingDate");
  for (const key of DOCUMENT_KEYS[document] ?? []) {
    if (!keys.includes(key)) keys.push(key);
  }

  for (const entry of documentFieldInventory(document, data, html)) {
    const binding = paperFieldBinding(entry.key);
    if (!binding || binding.store === "company") continue;
    const key = `${binding.store}.${binding.field}`;
    if (key in MANUAL_FIELDS && !keys.includes(key)) keys.push(key);
  }

  return keys.map((key) => ({ key, ...MANUAL_FIELDS[key] }));
}

/** The name a typed-in paper was issued to, for the register. */
export function manualSubjectName(values: ManualPaperValues): string | null {
  return text(values, "employee.nameAr") ?? text(values, "employee.fullName");
}
