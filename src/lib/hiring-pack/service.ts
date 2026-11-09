import { systemContractDefaults } from "@/config/system-settings";
import { getCustodyDeviceFacts } from "@/lib/devices/service";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import {
  COMPANY_DETAILS_DEFAULT,
  type CompanyDetails,
} from "@/lib/hiring-pack/company-details";
import { loadCompanyDetails } from "@/lib/hiring-pack/company-details-store";
import {
  ACTIVE_EMPLOYMENT_STATUSES_IN_LIST,
  DEPARTED_EMPLOYMENT_STATUSES_IN_LIST,
  hasDepartedEmployment,
} from "@/lib/auth/session-lifecycle";
import {
  getEmployeeDirectory,
  upsertEmployee,
  writeEmployeeResidenceLocation,
  type EmployeeMutationInput,
} from "@/lib/employees/employee-directory";
import { composeResidenceFromHiringAddress } from "@/lib/hiring-pack/residence-address";
import { canonicalHrIdForDisplay, hrIdForStorage, hrIdsMatch } from "@/lib/hr-id";
import { loadReferenceLines } from "@/lib/reference/reference-lists";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { arabicDepartmentName } from "@/lib/hiring-pack/department-names";
import { isRenewalObjectiveReasonCode } from "@/lib/hiring-pack/renewal-reasons";
import { currentTemplateVersion } from "@/lib/hiring-pack/template-registry";
import {
  ASSET_DOCUMENTS,
  CLEARANCE_DOCUMENTS,
  EXIT_DOCUMENTS,
  HIRING_PACK_DOCUMENTS,
} from "@/lib/hiring-pack/types";
import type {
  ContractRenewalFacts,
  ExitFacts,
  ExitRoute,
  HiringPackCandidate,
  HiringPackData,
  HiringPackDocument,
  HiringPackEmployeeFacts,
  HiringPackEmployeeFactsInput,
  HiringPackGap,
  HiringPackProfile,
  HiringPackProfileInput,
  MarkHiringPackSignedInput,
  OffboardingProfile,
  OffboardingProfileInput,
} from "@/lib/hiring-pack/types";

// The HR forms pack — assembling everything the five statutory documents need to print, from the
// places it lives: what Phoenix already knows about the person (`employees`), the statutory extras
// HR supplies at hiring (`employee_hiring_profile`), the extras it supplies at exit
// (`employee_offboarding_profile`), and the departure itself (`employee_resignations`).
//
// The design rule this file exists to enforce: THE TEMPLATES NEVER TOUCH THE DATABASE. Every
// document is rendered from a single resolved `HiringPackData`, so there is exactly one place where
// a value can be wrong, one place to test, and no way for the contract and Form 1 to disagree about
// the same person's salary — or for Form 6 and the Ministry of Labour form to disagree about the
// day he stopped working here.

/**
 * Where each document's state lives, and which checklist row it completes.
 *
 * A TABLE RATHER THAN A CONDITIONAL, DELIBERATELY. This used to be
 * `document === "contract" ? "contract_signed_date" : "form1_signed_date"`, which was correct while
 * there were exactly two documents and became silently wrong the moment there were five: every one
 * of the three exit documents would have stamped Form 1's column and ticked Form 1's checklist row.
 * Keying the union means adding a sixth document is a type error here rather than a wrong row in
 * production.
 */
const DOCUMENT_BINDINGS: Record<
  HiringPackDocument,
  {
    /**
     * Where this document's state lives, or null when it has none.
     *
     * Null is the custody receipts, and it is a decision rather than a gap — see
     * `SIGNABLE_DOCUMENTS` in `types.ts`. One person can hold three devices on three receipts
     * signed on three different days, so a single column against the employee could record only
     * one of them while appearing to cover all three.
     */
    table: "employee_hiring_profile" | "employee_offboarding_profile" | null;
    signedColumn: string | null;
    printedColumn: string | null;
    /** The `hiring_document_definitions` row this signature completes. */
    checklistName: string | null;
  }
> = {
  contract: {
    table: "employee_hiring_profile",
    signedColumn: "contract_signed_date",
    printedColumn: "contract_printed_at",
    checklistName: "Signed employment contract",
  },
  form1: {
    table: "employee_hiring_profile",
    signedColumn: "form1_signed_date",
    printedColumn: "form1_printed_at",
    checklistName: "Social insurance form",
  },
  // The worker-data form carries no stored state either, for the same reason the custody receipts
  // do not (see `SIGNABLE_DOCUMENTS`): it is a sheet filed in the personnel drawer, not a signature
  // Phoenix tracks against the person. A null binding makes `recordHiringPackPrinted` a no-op for it
  // and `markHiringPackSigned` refuse it — both correct, and it needed no migration to add.
  workerDataForm: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  // The two custody receipts carry no stored state at all: they print, and the signed paper is
  // filed. Written out one per form rather than shared, so that giving either one a real register
  // later is an edit to that form's row and cannot silently move the other's.
  custodyLaptop: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  custodyMobile: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  // The two renewal papers carry no stored state HERE, and the register that answers them properly
  // already exists: `contract_renewal_requests` holds one row per renewal with its own decision and
  // its own `signed_at`. A contract is renewed every year, so a single column against the employee
  // could record only the newest one while appearing to cover all of them — the identical reasoning
  // that keeps the custody receipts out (see `SIGNABLE_DOCUMENTS`). A null binding makes
  // `recordHiringPackPrinted` a no-op for them and `markHiringPackSigned` refuse them, both correct,
  // and it is why these needed no migration to add.
  // Sato's own six. Null for the same reason the worker-data form is null: they are papers filed
  // in a drawer, and this system records no signature against the person for them. The NDA is the
  // one that arguably should — it is signed once in a career, like the contract — and giving it a
  // real binding means a column and a migration. Written out one per document rather than shared,
  // so that doing that later is an edit to ONE row and cannot silently move the other five.
  // THE ONE OF THE SIX WITH A REAL REGISTER. Signed once in a career, like the contract, so its
  // date is recorded against the person and its checklist row ticks itself. The other five keep
  // their nulls for the reasons set out beside them.
  nda: {
    table: "employee_hiring_profile",
    signedColumn: "nda_signed_date",
    printedColumn: "nda_printed_at",
    checklistName: "Signed confidentiality undertaking",
  },
  appointmentDocsReceipt: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  socialStatusSheet: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  absenceWarning: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  deemedResignation: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  appointmentDocsReturn: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  // The certificate of experience is null for a reason of its own, and a stronger one than the
  // others': there is no signature to record because nobody signs it back, and it is issued as
  // often as it is asked for — a man can want one for a visa in March and for a job in November.
  // A single date on the employee row could hold only the newest, which is the trap the custody
  // receipts and the renewal papers are kept out of this table for.
  experienceCertificate: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  // The English certificate, for the same reasons and written out separately rather than shared,
  // so that giving either language a real register later cannot silently move the other.
  experienceCertificateEn: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  // The HR letter, for the certificate's reason: nobody signs it back, and it is issued as often as
  // a bank asks for one, so one date on the employee row could hold only the newest. Its Arabic
  // counterpart is the same paper in the other language and carries the same null for the same
  // reason, written out separately so giving either language a real register cannot silently move
  // the other.
  salaryLetterEn: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  salaryLetterAr: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  // The letters pack of 2026-09-13. None records a date against the person: a warning, a penalty or
  // a transfer can be issued many times in a career, the insurance letters are issued whenever an
  // office asks, and the government forms are registers or one-off applications — one date on the
  // employee row could hold only the newest of any of them.
  disciplinaryWarning: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  disciplinaryPenalty: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  transferDecision: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  salaryAdjustment: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  socialInsuranceAuthorization: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  healthInsuranceAuthorization: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  insurancePrintLetter: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  handoverRecord: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  exitInterview: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  maternityCompensation: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  insuranceForm2: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  carInsuranceCertificate: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  wageProgressSheet: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  officialHolidaysSheet: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  sickLeaveSheet: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  penaltiesSheet: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  penaltyRegulationsApproval: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  contractRenewal: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  contractNonRenewal: { table: null, signedColumn: null, printedColumn: null, checklistName: null },
  form6: {
    table: "employee_offboarding_profile",
    signedColumn: "form6_signed_date",
    printedColumn: "form6_printed_at",
    checklistName: "Signed social insurance Form 6",
  },
  resignation: {
    table: "employee_offboarding_profile",
    signedColumn: "resignation_signed_date",
    printedColumn: "resignation_printed_at",
    checklistName: "Signed resignation request",
  },
  mutualTermination: {
    table: "employee_offboarding_profile",
    signedColumn: "mutual_termination_signed_date",
    printedColumn: "mutual_termination_printed_at",
    checklistName: "Signed mutual termination agreement",
  },
  // The clearance pair. Two independent bindings, because unlike the two rows above these are
  // complements rather than alternatives — both get signed, days apart. See `CLEARANCE_DOCUMENTS`.
  clearanceEmployee: {
    table: "employee_offboarding_profile",
    signedColumn: "clearance_employee_signed_date",
    printedColumn: "clearance_employee_printed_at",
    checklistName: "Signed employee clearance",
  },
  clearanceCompany: {
    table: "employee_offboarding_profile",
    signedColumn: "clearance_company_signed_date",
    printedColumn: "clearance_company_printed_at",
    checklistName: "Signed company clearance",
  },
};

export type EmployeeDbRow = {
  base_salary: number | string | null;
  birth_date: string | null;
  department_id: number | null;
  employment_status: string | null;
  full_name: string | null;
  gender: string | null;
  gross_salary: number | string | null;
  hire_date: string | null;
  hr_id: string;
  job_title: string | null;
  last_working_date: string | null;
  line_id: number | null;
  mobile_number: string | null;
  name_ar: string | null;
  national_id: string | null;
  nickname: string | null;
  residence_address: string | null;
  residence_city: string | null;
  social_insurance_number: string | null;
  social_insurance_wage: number | string | null;
  work_email: string | null;
};

export type ProfileDbRow = {
  address_building: string | null;
  address_district: string | null;
  address_governorate: string | null;
  address_markaz: string | null;
  address_street: string | null;
  birth_place: string | null;
  contract_duration_months: number | null;
  contract_end_date: string | null;
  contract_printed_at: string | null;
  contract_signatory_name_ar: string | null;
  contract_signatory_title_ar: string | null;
  contract_objective_reason_code: string | null;
  nda_signed_date: string | null;
  nda_printed_at: string | null;
  contract_signed_date: string | null;
  contract_start_date: string | null;
  contract_template_version: string | null;
  form1_printed_at: string | null;
  form1_signed_date: string | null;
  hr_id: string;
  insurance_office: string | null;
  job_title_ar: string | null;
  nationality: string | null;
  notes: string | null;
  occupation_code: string | null;
  qualification: string | null;
  training_bond_months: number | null;
  underperformance_months: number | null;
  underperformance_threshold_pct: number | string | null;
  updated_at: string | null;
};

export type OffboardingDbRow = {
  addressee_name_ar: string | null;
  addressee_title_ar: string | null;
  agreement_date: string | null;
  clearance_company_printed_at: string | null;
  clearance_company_signed_date: string | null;
  clearance_employee_printed_at: string | null;
  clearance_employee_signed_date: string | null;
  employer_rep_name_ar: string | null;
  employer_rep_title_ar: string | null;
  end_reason_ar: string | null;
  end_reason_code: string | null;
  exit_route: string | null;
  form6_printed_at: string | null;
  form6_signed_date: string | null;
  hr_id: string;
  last_working_date: string | null;
  mutual_termination_printed_at: string | null;
  mutual_termination_signed_date: string | null;
  notes: string | null;
  resignation_printed_at: string | null;
  resignation_signed_date: string | null;
  updated_at: string | null;
};

type ResignationDbRow = {
  effective_date: string | null;
  exit_status: string | null;
  job_title: string | null;
  last_working_date: string | null;
  resignation_date: string | null;
};

type RenewalRequestDbRow = {
  area_name: string | null;
  id: string;
  proposed_end_date: string | null;
  proposed_start_date: string | null;
  signed_at: string | null;
  status: string;
};

export class HiringPackEmployeeNotFoundError extends Error {
  constructor(hrId: string) {
    super(`No employee record for ${hrId}.`);
    this.name = "HiringPackEmployeeNotFoundError";
  }
}

export function isHiringPackEmployeeMissing(error: unknown) {
  return error instanceof HiringPackEmployeeNotFoundError;
}

/**
 * A refusal the caller can fix, as opposed to a fault.
 *
 * Today it means one thing: an attempt to sign a second exit form when one is already signed. It is
 * a 409 rather than a 500 because nothing is broken — the request contradicts a rule, and the
 * message says which one and what is already on file.
 */
export class HiringPackConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HiringPackConflictError";
  }
}

export function isHiringPackConflict(error: unknown) {
  return error instanceof HiringPackConflictError;
}

export function isHiringPackSchemaMissing(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist")) ||
    (message.includes("column") && message.includes("does not exist"))
  );
}

export function hiringPackErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Unable to load the hiring pack.";
}

function cleanText(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * The "who last edited this" stamp — or NOTHING AT ALL when nobody is known.
 *
 * Both profile savers take the actor as OPTIONAL and the routes pass `access.hrId ?? null`, so a
 * signed-in person with no linked HR id — the `admin-HR` account carries a NULL `hr_id` by design —
 * arrives here as null. Writing the column unconditionally then stamped NULL over whoever was
 * recorded before, with no error and no history: measured on production 2026-09-05, Nada Saed's
 * hiring profile lost its previous editor at 15:27 Cairo that way.
 *
 * Returning an EMPTY OBJECT is the fix, not `?? "system"` or the old value re-read. An absent key
 * is left out of the upsert's SET clause, so the stored value survives untouched — the same
 * mechanism `versionStamp` below already relies on to stamp a contract's template version once and
 * never rewrite it. A marker like "system" would be worse than the erase: it reads as a fact.
 *
 * This is the pattern rather than the two call sites. An optional field written unconditionally is
 * a silent erase, and it regenerates — the next satellite table with an actor column will be
 * written by somebody copying one of these upserts.
 */
export function updatedByStamp(actorHrId: string | null | undefined): { updated_by_hr_id?: string } {
  const stored = hrIdForStorage(cleanText(actorHrId));
  return stored ? { updated_by_hr_id: stored } : {};
}

function toNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveInt(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : null;
}

/** Add whole months to an ISO date, clamping the day so 31 Jan + 1 month is not 3 March. */
/**
 * The company's own registration numbers, and which documents each one blocks when it is blank.
 *
 * A LIST rather than three `if`s, so a test can walk it. `testEveryCompanySettingsGapReachesThePage`
 * guarded itself with "at least one of these is blank", which quietly tied the strength of the pin
 * to the company being half-configured: supplying the last number — the sector code, 2026-09-03 —
 * would have turned that guard red, and the check it protected would have iterated nothing at all.
 * A pin that only holds while the data is incomplete is not a pin. Walking this list holds either
 * way, and the blank-versus-reported direction is still read from the live settings.
 */
export const COMPANY_REGISTRATION_GAPS: readonly {
  readonly field: "insuranceEstablishmentNumber" | "insuranceSectorCode" | "taxRegistrationNumber";
  readonly labelEn: string;
  readonly labelAr: string;
  readonly documents: readonly HiringPackDocument[];
}[] = [
  {
    field: "insuranceEstablishmentNumber",
    labelEn: "Establishment number",
    labelAr: "رقم المنشأة",
    documents: ["form1", "form6"],
  },
  // قطاع المنشأة is a Form 1 question only — Form 6 identifies the establishment by its number and
  // tax registration and never asks which sector it trades in.
  { field: "insuranceSectorCode", labelEn: "Sector code", labelAr: "قطاع المنشأة", documents: ["form1"] },
  {
    field: "taxRegistrationNumber",
    labelEn: "Tax registration number",
    labelAr: "رقم التسجيل الضريبي",
    documents: ["form1", "form6"],
  },
];

export function addMonthsToIsoDate(iso: string | null, months: number | null): string | null {
  if (!iso || !months) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  // Day 0 of the following month is the last day of this one — the clamp, without a date library.
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();

  const clampedDay = Math.min(day, lastDay);
  const mm = String(normalizedMonth + 1).padStart(2, "0");
  const dd = String(clampedDay).padStart(2, "0");
  return `${targetYear}-${mm}-${dd}`;
}

export function emptyProfile(hrId: string): HiringPackProfile {
  return {
    hrId,
    nationality: null,
    qualification: null,
    birthPlace: null,
    jobTitleAr: null,
    occupationCode: null,
    insuranceOffice: null,
    addressBuilding: null,
    addressDistrict: null,
    addressStreet: null,
    addressMarkaz: null,
    addressGovernorate: null,
    contractDurationMonths: null,
    contractStartDate: null,
    contractEndDate: null,
    underperformanceThresholdPct: null,
    underperformanceMonths: null,
    trainingBondMonths: null,
    notes: null,
    contractSignatoryNameAr: null,
    contractSignatoryTitleAr: null,
    contractObjectiveReasonCode: null,
    ndaSignedDate: null,
    ndaPrintedAt: null,
    contractSignedDate: null,
    form1SignedDate: null,
    contractPrintedAt: null,
    form1PrintedAt: null,
    contractTemplateVersion: null,
    updatedAt: null,
  };
}

export function mapProfile(row: ProfileDbRow): HiringPackProfile {
  return {
    hrId: row.hr_id,
    nationality: cleanText(row.nationality),
    qualification: cleanText(row.qualification),
    birthPlace: cleanText(row.birth_place),
    jobTitleAr: cleanText(row.job_title_ar),
    occupationCode: cleanText(row.occupation_code),
    insuranceOffice: cleanText(row.insurance_office),
    addressBuilding: cleanText(row.address_building),
    addressDistrict: cleanText(row.address_district),
    addressStreet: cleanText(row.address_street),
    addressMarkaz: cleanText(row.address_markaz),
    addressGovernorate: cleanText(row.address_governorate),
    contractDurationMonths: row.contract_duration_months,
    contractStartDate: row.contract_start_date,
    contractEndDate: row.contract_end_date,
    underperformanceThresholdPct: toNumber(row.underperformance_threshold_pct),
    underperformanceMonths: row.underperformance_months,
    trainingBondMonths: row.training_bond_months,
    notes: cleanText(row.notes),
    contractSignatoryNameAr: cleanText(row.contract_signatory_name_ar),
    contractSignatoryTitleAr: cleanText(row.contract_signatory_title_ar),
    // An unrecognised code reads as NOTHING CHOSEN rather than being passed through. The column
    // is plain text with no check constraint, so a hand-written or newer-build value can be in
    // there, and the one thing that must never happen is a raw code reaching an Arabic legal
    // instrument. `renewalObjectiveReasonClause` refuses it again at print time; this is the
    // first of the two gates, and it is the one that also keeps the dropdown honest — the
    // select shows nothing selected rather than a blank option nobody can name.
    contractObjectiveReasonCode: isRenewalObjectiveReasonCode(row.contract_objective_reason_code)
      ? cleanText(row.contract_objective_reason_code)
      : null,
    ndaSignedDate: row.nda_signed_date,
    ndaPrintedAt: row.nda_printed_at,
    contractSignedDate: row.contract_signed_date,
    form1SignedDate: row.form1_signed_date,
    contractPrintedAt: row.contract_printed_at,
    form1PrintedAt: row.form1_printed_at,
    contractTemplateVersion: cleanText(row.contract_template_version),
    updatedAt: row.updated_at,
  };
}

/**
 * An exit nobody has started — every column null.
 *
 * EXPORTED FOR THE TESTS, deliberately. Four test files build an offboarding profile by hand, and
 * before this they each held their own copy of the literal: adding a document meant editing five
 * places, and the only thing that caught the miss was the type checker refusing four files at once.
 * Sharing the app's own empty shape means a test fixture cannot drift from what the app builds,
 * which is the whole reason a fixture exists.
 */
export function emptyOffboardingProfile(hrId: string): OffboardingProfile {
  return {
    hrId,
    exitRoute: null,
    lastWorkingDate: null,
    endReasonAr: null,
    endReasonCode: null,
    addresseeNameAr: null,
    addresseeTitleAr: null,
    agreementDate: null,
    employerRepNameAr: null,
    employerRepTitleAr: null,
    notes: null,
    form6SignedDate: null,
    resignationSignedDate: null,
    mutualTerminationSignedDate: null,
    clearanceEmployeeSignedDate: null,
    clearanceCompanySignedDate: null,
    form6PrintedAt: null,
    resignationPrintedAt: null,
    mutualTerminationPrintedAt: null,
    clearanceEmployeePrintedAt: null,
    clearanceCompanyPrintedAt: null,
    updatedAt: null,
  };
}

/** The two values `exit_route` may hold. Anything else is read as "nobody has decided yet". */
function toExitRoute(value: string | null): ExitRoute | null {
  return value === "resignation" || value === "mutualTermination" ? value : null;
}

export function mapOffboardingProfile(row: OffboardingDbRow): OffboardingProfile {
  return {
    hrId: row.hr_id,
    exitRoute: toExitRoute(cleanText(row.exit_route)),
    lastWorkingDate: row.last_working_date,
    endReasonAr: cleanText(row.end_reason_ar),
    endReasonCode: cleanText(row.end_reason_code),
    addresseeNameAr: cleanText(row.addressee_name_ar),
    addresseeTitleAr: cleanText(row.addressee_title_ar),
    agreementDate: row.agreement_date,
    employerRepNameAr: cleanText(row.employer_rep_name_ar),
    employerRepTitleAr: cleanText(row.employer_rep_title_ar),
    notes: cleanText(row.notes),
    form6SignedDate: row.form6_signed_date,
    resignationSignedDate: row.resignation_signed_date,
    mutualTerminationSignedDate: row.mutual_termination_signed_date,
    clearanceEmployeeSignedDate: row.clearance_employee_signed_date,
    clearanceCompanySignedDate: row.clearance_company_signed_date,
    form6PrintedAt: row.form6_printed_at,
    resignationPrintedAt: row.resignation_printed_at,
    mutualTerminationPrintedAt: row.mutual_termination_printed_at,
    clearanceEmployeePrintedAt: row.clearance_employee_printed_at,
    clearanceCompanyPrintedAt: row.clearance_company_printed_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Is anybody actually working on this person's exit?
 *
 * This gates the exit gaps below. Without it, every new hire's screen would list "last working day
 * missing" as an outstanding item on the day he joined — which is not a gap, it is a career. A gap
 * list that reports things nobody is waiting for is a gap list people stop reading, and this whole
 * feature exists because forms were being filled in without anybody checking what was blank.
 */
function hasExitContext(
  employee: HiringPackEmployeeFacts,
  offboarding: OffboardingProfile,
  exit: ExitFacts | null,
) {
  return Boolean(
    exit ||
      // The employee record is the widest of the three signals: 3 of the 57 people who have left
      // carry no resignation row at all (production, 2026-08-30), and without this they would have
      // read as still employed on the one screen that prints their Form 6.
      hasDepartedEmployment(employee.employmentStatus) ||
      employee.lastWorkingDate ||
      offboarding.exitRoute ||
      offboarding.lastWorkingDate ||
      offboarding.endReasonAr ||
      offboarding.agreementDate ||
      offboarding.form6SignedDate ||
      offboarding.resignationSignedDate ||
      offboarding.mutualTerminationSignedDate ||
      // A signed clearance is a departure whoever else has noticed. In practice the employee's
      // clearance is the FIRST paper of an exit to be signed — it starts circulating the moment
      // somebody hands in notice, well before a resignation row is created — so leaving it out
      // would mean the one screen that prints the rest of the pack showed no exit context on
      // exactly the people whose exit is furthest along.
      offboarding.clearanceEmployeeSignedDate ||
      offboarding.clearanceCompanySignedDate,
  );
}

/**
 * Everything the documents ask for that is still unanswered.
 *
 * `blocking` marks the values without which the document is not merely untidy but wrong to hand
 * over: an unnamed party, a contract with no salary, a Form 1 with no national ID. Everything else
 * is reported so it is visible, and still prints — HR should be able to produce a contract today
 * and chase an occupation code tomorrow.
 */
export function collectHiringPackGaps(
  employee: HiringPackEmployeeFacts,
  profile: HiringPackProfile,
  offboarding: OffboardingProfile = emptyOffboardingProfile(employee.hrId),
  exit: ExitFacts | null = null,
  // The company as it will PRINT, so a registration number somebody typed on the paper stops being
  // reported as a gap the moment it is stored. Defaulted to the compiled record because most callers
  // — every test, and the fill-rate count — are asking about one person and not about the company.
  company: CompanyDetails = COMPANY_DETAILS_DEFAULT,
): HiringPackGap[] {
  const gaps: HiringPackGap[] = [];
  const add = (
    field: string,
    labelEn: string,
    labelAr: string,
    documents: readonly HiringPackDocument[],
    blocking: boolean,
    source: HiringPackGap["source"],
  ) => gaps.push({ field, labelEn, labelAr, documents, blocking, source });

  // The document sets a value can be missing from. Named rather than repeated, because the sets
  // are the interesting part: an insurance number is a social-insurance concern and the Ministry of
  // Labour never asks for one, while a national ID is asked for by all five.
  const ALL = HIRING_PACK_DOCUMENTS;
  const HIRING: readonly HiringPackDocument[] = ["contract", "form1"];
  const LABOUR: readonly HiringPackDocument[] = ["resignation", "mutualTermination"];
  const INSURANCE: readonly HiringPackDocument[] = ["form1", "form6"];
  const CUSTODY: readonly HiringPackDocument[] = [...ASSET_DOCUMENTS];
  const CLEARANCE: readonly HiringPackDocument[] = [...CLEARANCE_DOCUMENTS];

  // ── From the employee record ────────────────────────────────────────────────────────────────
  if (!employee.nameAr) add("nameAr", "Arabic full name", "الاسم بالعربية", ALL, true, "employee-record");
  if (!employee.nationalId) add("nationalId", "National ID", "الرقم القومي", ALL, true, "employee-record");
  if (!employee.socialInsuranceNumber) {
    add("socialInsuranceNumber", "Insurance number", "الرقم التأميني", ["contract", ...INSURANCE], true, "employee-record");
  }
  if (!employee.birthDate) add("birthDate", "Date of birth", "تاريخ الميلاد", ["contract"], true, "employee-record");
  // One number now stands behind both: the contract prints the base salary and the insurance wage
  // on the contract and Form 1 is derived from it, so a missing base blanks all three at once. It
  // is reported against the hiring documents as a whole for that reason.
  if (employee.baseSalary === null) {
    add("baseSalary", "Base monthly salary", "الأجر الأساسي", HIRING, true, "employee-record");
  }
  // The hire date reaches the mutual-termination agreement too: its تمهيد states when the contract
  // being ended began, and that date falls back to the hire date exactly as the contract's does.
  if (!employee.hireDate) {
    add(
      "hireDate",
      "Hire date",
      "تاريخ الالتحاق",
      [...HIRING, "mutualTermination", "clearanceEmployee"],
      true,
      "employee-record",
    );
  }
  // The employee's clearance names the department that has to sign the top row of its table, so a
  // blank one leaves the paper asking a desk nobody identified. Non-blocking: the six rows below it
  // are named by the form itself, and the office accepts it filled in by hand.
  if (!employee.departmentAr) {
    add(
      "departmentAr",
      "Department (Arabic)",
      "الإدارة / القطاع",
      ["clearanceEmployee"],
      false,
      "employee-record",
    );
  }
  if (!employee.mobileNumber) add("mobileNumber", "Phone number", "رقم الهاتف", ALL, false, "employee-record");
  if (!employee.workEmail) add("workEmail", "Email", "البريد الإلكتروني", [...HIRING, "form6"], false, "employee-record");
  if (!employee.residenceAddress) {
    add(
      "residenceAddress",
      "Permanent address",
      "العنوان الدائم",
      // The company's copy of the clearance prints محل الإقامة — it is the address a claim would be
      // served to if the release it carries were ever disputed. The employee's copy does not.
      ["contract", ...LABOUR, ...CUSTODY, "clearanceCompany"],
      true,
      "employee-record",
    );
  }

  // ── From the hiring profile ─────────────────────────────────────────────────────────────────
  // NOT BLOCKING since 2026-09-03: every paper now prints `DEFAULT_NATIONALITY_AR` when this is
  // empty (see `hiring-pack/nationality.ts`), so refusing to print would be refusing over a value
  // the form is going to carry regardless. It stays REPORTED, because "we assumed Egyptian" is
  // exactly the kind of thing somebody must be able to notice and correct before a contract is
  // signed — a default that nothing mentions is how the wrong nationality reaches a signature.
  if (!profile.nationality) add("nationality", "Nationality", "الجنسية", HIRING, false, "hiring-profile");
  if (!profile.qualification) add("qualification", "Qualification", "المؤهل", HIRING, true, "hiring-profile");
  if (!profile.birthPlace) add("birthPlace", "Place of birth", "محل الميلاد", ["contract"], true, "hiring-profile");
  // The Arabic job title is what both labour templates print in "بوظيفة .........." — the English
  // one in `employees.job_title` is a fallback so a form is not blank, never the right answer on an
  // Arabic-language legal document.
  if (!profile.jobTitleAr) {
    add(
      "jobTitleAr",
      "Arabic job title",
      "المسمى الوظيفي بالعربية",
      [...HIRING, ...LABOUR, ...CUSTODY, ...CLEARANCE],
      true,
      "hiring-profile",
    );
  }
  if (!profile.occupationCode) add("occupationCode", "Occupation code", "كود المهنة", ["form1"], false, "hiring-profile");
  // The form prints this employee's office, falling back to the company default — so it is only
  // missing when BOTH are empty. Reporting it while a default exists sends HR chasing a value the
  // printer is about to supply on its own.
  if (!profile.insuranceOffice && !company.registration.defaultInsuranceOffice) {
    add("insuranceOffice", "Insurance office", "مكتب التأمينات", INSURANCE, false, "hiring-profile");
  }
  // The address block Form 1 captured at hiring is the one Form 6 reprints at exit — one address,
  // asked for once.
  if (!profile.addressBuilding) add("addressBuilding", "Building number", "عقار رقم", INSURANCE, false, "hiring-profile");
  if (!profile.addressStreet) add("addressStreet", "Street", "شارع / حارة", INSURANCE, false, "hiring-profile");
  if (!profile.addressGovernorate) add("addressGovernorate", "Governorate", "محافظة", INSURANCE, false, "hiring-profile");

  // ── From company settings ───────────────────────────────────────────────────────────────────
  // These are the company's own registration numbers. They are blank until the owner supplies them
  // once, and a Form 1 without them is not a form an insurance office will accept — so they are
  // blocking, and reported against every employee rather than hidden in a settings screen nobody
  // opens.
  //
  // Only settings that actually reach the printed page belong here. The company insurance number
  // used to block from this list while its only placement sat on page 2 — which Phoenix does not
  // write on — so HR would have been told the form was incomplete because of a value the form never
  // shows. `testEveryCompanySettingsGapReachesThePage` now pins that both ways.
  const registration = company.registration;
  for (const entry of COMPANY_REGISTRATION_GAPS) {
    if (!registration[entry.field]) {
      add(entry.field, entry.labelEn, entry.labelAr, entry.documents, true, "company-settings");
    }
  }

  // ── The exit documents ──────────────────────────────────────────────────────────────────────
  // Reported only once somebody is actually working on this person's exit — see `hasExitContext`.
  if (hasExitContext(employee, offboarding, exit)) {
    // THE ONE VALUE THAT MUST NOT BE WRONG. تاريخ انتهاء الاشتراك is what the Authority calculates
    // the final contribution from, and Form 6's own back page charges the employer 20% per month
    // for filing it late — so a Form 6 that goes out with a blank or guessed date costs money.
    if (!(offboarding.lastWorkingDate ?? exit?.lastWorkingDate ?? employee.lastWorkingDate)) {
      add("lastWorkingDate", "Last working day", "تاريخ انتهاء الخدمة", EXIT_DOCUMENTS, true, "resignation-record");
    }
    // سبب انتهاء الاشتراك — Form 6 asks for it in words, and the resignation repeats it on its
    // "ونظراً لـ" rule. Blocking on Form 6: an insurance office will not close a file without one.
    if (!offboarding.endReasonAr) {
      add(
        "endReasonAr",
        "Reason for leaving (Arabic)",
        "سبب انتهاء الاشتراك",
        ["form6", "resignation"],
        true,
        "offboarding-profile",
      );
    }
    // The Authority's own numeric code. The office accepts the written reason on its own, so this
    // is visible rather than blocking — the same treatment the occupation code gets on Form 1.
    if (!offboarding.endReasonCode) {
      add("endReasonCode", "Reason code", "كود سبب الانتهاء", ["form6"], false, "offboarding-profile");
    }
    // Which of the two Ministry of Labour templates applies. Blocking, because there is no safe
    // default: printing the wrong one asserts a legal basis for the departure that did not happen.
    // The two are alternatives — only one is ever signed — so this is a decision, not a preference.
    if (!offboarding.exitRoute) {
      add("exitRoute", "Exit route", "طريقة إنهاء العلاقة", LABOUR, true, "offboarding-profile");
    }
    // Dated the day it is signed, which is not the last working day. Left non-blocking because the
    // renderer falls back to today in Cairo — a sensible default for a paper signed today, and the
    // only value on either exit form that has one.
    if (offboarding.exitRoute === "mutualTermination" && !offboarding.agreementDate) {
      add("agreementDate", "Agreement date", "تاريخ الاتفاق", ["mutualTermination"], false, "offboarding-profile");
    }
  }

  return gaps;
}

/**
 * Every column the printed papers read off an employee.
 *
 * EXPORTED so the roster-wide fill-rate count selects the same set. Two select lists over one table
 * is exactly the "a narrowed SELECT disarms every gate downstream of it" shape: the count would
 * report a field as blank for everybody purely because its column was missing from the second list,
 * and nothing would error.
 */
export const HIRING_PACK_EMPLOYEE_COLUMNS =
  "hr_id, full_name, nickname, name_ar, national_id, gender, social_insurance_number, social_insurance_wage, base_salary, gross_salary, birth_date, hire_date, job_title, department_id, line_id, residence_address, residence_city, mobile_number, work_email, employment_status, last_working_date";

async function loadEmployeeFacts(hrId: string): Promise<HiringPackEmployeeFacts> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select(HIRING_PACK_EMPLOYEE_COLUMNS)
    .eq("hr_id", hrId)
    .maybeSingle<EmployeeDbRow>();

  if (error) throw new Error(error.message);
  if (!data) throw new HiringPackEmployeeNotFoundError(hrId);

  // THE DEPARTMENT IS NOT THE LINE — owner, 2026-08-31, in those words.
  //
  // This read used to resolve `lines.name` by `line_id`, so a contract for a medical rep printed
  // "CNS" or "Pedia" as his إدارة. That is his product line, not the department that employs him:
  // in production 140 of the 162 people carrying a department are in Sales, across all three lines.
  // The department is `employees.department_id` against the `departments` table — the same nine
  // names the rest of the HR module uses. `department_name` on the row is NULL for every employee
  // (measured: 0 of 180), exactly as `line_name` was, so it has to be joined by id either way.
  let departmentName: string | null = null;
  if (data.department_id !== null) {
    const { data: department } = await supabase
      .from("departments")
      .select("id, name")
      .eq("id", data.department_id)
      .maybeSingle<{ id: number; name: string | null }>();
    departmentName = department?.name ?? null;
  }

  return mapEmployeeFacts(data, departmentName);
}

/**
 * One employee row, as the papers read it.
 *
 * `departmentName` is the RAW `departments.name`, passed in rather than joined here because the
 * caller decides how to GET it: the single-employee load joins one department by id, the roster-wide
 * fill-rate count reads the whole department table once. Both then produce the identical shape,
 * which is what lets the fill-rate count answer "how many people would this field print for" with
 * the same reader that prints it.
 *
 * THE ARABIC LOOKUP HAPPENS HERE, NOT AT THE CALLERS, and that is the whole point of taking the raw
 * name. It used to sit at the call sites: the print path translated, the roster path did not, so the
 * same field held "Sales" when the fill-rate count loaded it and "المبيعات" when the contract did.
 * Nothing caught it, because `DEPARTMENT` is an unbound key so the count never read the field, and
 * the fallback returns the English name rather than null so the two agreed on emptiness. One feature
 * reading `departmentAr` off this path would have printed an English إدارة on a signed instrument —
 * the defect the owner corrected on 2026-08-31 ("the department is not the line"), by another road.
 * Pinned by `tests/hiring-pack-department-name.test.ts`.
 */
export function mapEmployeeFacts(
  row: EmployeeDbRow,
  departmentName: string | null,
): HiringPackEmployeeFacts {
  return {
    hrId: row.hr_id,
    // The papers are legal documents: the full name, never the nickname (owner, 2026-11-03).
    fullName: row.full_name?.trim() || row.hr_id,
    nameAr: cleanText(row.name_ar),
    nationalId: cleanText(row.national_id),
    gender: cleanText(row.gender),
    socialInsuranceNumber: cleanText(row.social_insurance_number),
    socialInsuranceWage: toNumber(row.social_insurance_wage),
    baseSalary: toNumber(row.base_salary),
    grossSalary: toNumber(row.gross_salary),
    birthDate: row.birth_date,
    hireDate: row.hire_date,
    jobTitle: cleanText(row.job_title),
    departmentAr: arabicDepartmentName(cleanText(departmentName)),
    departmentId: row.department_id,
    lineId: row.line_id,
    residenceAddress: cleanText(row.residence_address),
    residenceCity: cleanText(row.residence_city),
    mobileNumber: cleanText(row.mobile_number),
    workEmail: cleanText(row.work_email),
    employmentStatus: cleanText(row.employment_status),
    departed: hasDepartedEmployment(row.employment_status),
    lastWorkingDate: row.last_working_date,
  };
}

type CandidateDbRow = {
  hr_id: string;
  full_name: string | null;
  nickname: string | null;
  name_ar: string | null;
  job_title: string | null;
  hire_date: string | null;
  employment_status: string | null;
  last_working_date: string | null;
};

/**
 * The roster the fill screen picks from — current staff, newest hires first, then the people who
 * have left, most recent departure first.
 *
 * TWO POPULATIONS, BECAUSE THIS MODULE PRINTS AT BOTH ENDS OF A CAREER. The list was current staff
 * only, which was right when the screen printed a contract and Form 1 and nothing else. It is wrong
 * now: Form 6 is the notification that a subscription has ENDED, filed after the person has gone
 * and after `employment_status` has already flipped to "resigned" — so the one screen that prints
 * it could not find any of the 57 people it exists for (production, 2026-08-30). Form 6's own back
 * page charges the employer 20% per month of delay, which makes "the employee is not in the list"
 * an expensive way to fail.
 *
 * WHAT IS STILL EXCLUDED, and why this is not a return to the old bug. The owner's 2026-08-24
 * decision was that neither hiring screen may invent its own status list, after two screens
 * disagreed by 46 people: the roster then excluded only "resigned" and so carried 15 historical
 * payroll records and 2 system placeholders — ledger rows, not people, in a list whose purpose is
 * printing an employment contract. Those 17 are still excluded. What is added is the DEPARTED set,
 * named once in `session-lifecycle.ts` beside the active one, because "has left" is not the same
 * question as "may hold a session" and only the first has a last working day.
 *
 * Nulls are kept: a legacy row with no status is not evidence that someone left.
 */
export async function listHiringPackCandidates(): Promise<HiringPackCandidate[]> {
  // Read in full, page by page (hr_id is the tiebreak under the hire-date order): a fixed row count
  // here would drop the OLDEST hires first, and a leaver's Form 6 is filed for exactly those people.
  const admin = getSupabaseAdmin();
  let data: CandidateDbRow[];
  try {
    data = await fetchAllRows<CandidateDbRow>(
      () =>
        admin
          .from("employees")
          .select(
            "hr_id, full_name, nickname, name_ar, job_title, hire_date, employment_status, last_working_date",
          )
          .or(
            `employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST},employment_status.in.${DEPARTED_EMPLOYMENT_STATUSES_IN_LIST}`,
          )
          .order("hire_date", { ascending: false, nullsFirst: false }),
      "hr_id",
    );
  } catch (error) {
    throw new Error((error as { message?: string } | null)?.message ?? String(error));
  }

  const candidates = data.map((row) => ({
    hrId: row.hr_id,
    fullName: resolveEmployeeDisplayName(row.full_name ?? "", row.nickname, row.hr_id),
    nameAr: cleanText(row.name_ar),
    jobTitle: cleanText(row.job_title),
    hireDate: row.hire_date,
    departed: hasDepartedEmployment(row.employment_status),
    lastWorkingDate: row.last_working_date,
  }));

  // Current staff keep the hire-date order the query applied — this screen exists for the person
  // who started this week. Leavers are re-sorted by DEPARTURE, because for them the relevant date
  // is the one at the other end: somebody whose Form 6 is due left recently, whenever they joined.
  const current = candidates.filter((candidate) => !candidate.departed);
  const departed = candidates
    .filter((candidate) => candidate.departed)
    .sort((a, b) => (b.lastWorkingDate ?? "").localeCompare(a.lastWorkingDate ?? ""));

  return [...current, ...departed];
}

async function loadProfile(hrId: string): Promise<HiringPackProfile> {
  const { data, error } = await getSupabaseAdmin()
    .from("employee_hiring_profile")
    .select("*")
    .eq("hr_id", hrId)
    .maybeSingle<ProfileDbRow>();

  if (error) throw new Error(error.message);
  return data ? mapProfile(data) : emptyProfile(hrId);
}

async function loadOffboardingProfile(hrId: string): Promise<OffboardingProfile> {
  const { data, error } = await getSupabaseAdmin()
    .from("employee_offboarding_profile")
    .select("*")
    .eq("hr_id", hrId)
    .maybeSingle<OffboardingDbRow>();

  if (error) throw new Error(error.message);
  return data ? mapOffboardingProfile(data) : emptyOffboardingProfile(hrId);
}

/**
 * The Arabic job title someone else already typed for the same English job title.
 *
 * There is no title translation table — this reads the one that already exists, spread across
 * everybody's own hiring profile, and offers the most recently saved match as a one-click fill.
 * It is a suggestion only: nothing here writes anything, and a miss (no match, or a Supabase
 * hiccup) must never block the rest of the pack from loading, so every failure resolves to `null`
 * rather than throwing.
 */
async function loadSuggestedJobTitleAr(jobTitle: string | null): Promise<string | null> {
  const trimmed = jobTitle?.trim();
  if (!trimmed) return null;

  try {
    const admin = getSupabaseAdmin();
    // Every peer with this title, paged (a fixed count would leave later hires out of the match).
    const peers = await fetchAllRows<{ hr_id: string | null }>(
      () => admin.from("employees").select("hr_id").ilike("job_title", trimmed),
      "hr_id",
    );
    if (!peers.length) return null;

    const hrIds = peers.map((row) => row.hr_id).filter((id): id is string => Boolean(id));
    if (!hrIds.length) return null;

    const { data: rows, error: rowsError } = await admin
      .from("employee_hiring_profile")
      .select("job_title_ar, updated_at")
      .in("hr_id", hrIds)
      .not("job_title_ar", "is", null)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (rowsError || !rows?.length) return null;

    return cleanText(rows[0].job_title_ar as string | null);
  } catch {
    return null;
  }
}

/**
 * The departure as the system already records it.
 *
 * `null` for anybody who has not resigned, which is almost everybody — and that is not an error
 * state. The exit documents still print for somebody whose last day is Thursday and whose
 * resignation row lands on Friday; what they must never do is invent a departure date.
 *
 * NEWEST ROW WINS. There is no uniqueness constraint on `employee_hr_id`, and a rehired employee
 * who later leaves again has two. Ordering by the last working day descending means the exit forms
 * describe this departure rather than one from three years ago.
 *
 * A plain `.eq` is correct here, unusually for an HR_ID column in this database. Measured on
 * production 2026-08-30: all 54 `employee_resignations` rows hold an uppercase `employee_hr_id`,
 * the exact join against `employees` returns all 54, and the case-insensitive join returns the same
 * 54 — so lowering both sides would buy nothing. If that ever stops being true the symptom is a
 * missing departure rather than a wrong one, which the gap list reports.
 */
async function loadExitFacts(hrId: string): Promise<ExitFacts | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("employee_resignations")
    .select("last_working_date, resignation_date, effective_date, exit_status, job_title")
    .eq("employee_hr_id", hrId)
    .order("last_working_date", { ascending: false, nullsFirst: false })
    .limit(1);

  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as ResignationDbRow | undefined;
  if (!row) return null;

  return {
    lastWorkingDate: row.last_working_date,
    resignationDate: row.resignation_date,
    effectiveDate: row.effective_date,
    status: cleanText(row.exit_status),
    jobTitle: cleanText(row.job_title),
  };
}

/**
 * The newest contract-renewal request for this person, narrowed to what the renewal papers print.
 *
 * NEWEST BY `created_at`, and there is no uniqueness constraint on `employee_hr_id` because there
 * should not be: an employee renewed four times has four rows, and the paper being printed is
 * always about the current term. Ordering the other way would print an annex carrying the dates of
 * a renewal that was agreed three years ago, which is a wrong date on a signed instrument rather
 * than a missing one.
 *
 * A MISSING TABLE IS NOT A FAILURE HERE. `contract_renewal_requests` is created by the contracts
 * module's own migration, and a deploy that reaches this code before that migration lands would
 * otherwise 500 the whole hiring pack — every document, for everybody — over a paper most people
 * never print. Both codes are caught because a missing table answers PGRST205 through PostgREST and
 * 42P01 through SQL, and only one of those is the obvious one to guard.
 *
 * `ilike` RATHER THAN `eq`, and unlike `loadExitFacts` this one is not backed by a measurement:
 * the table held zero rows on production when this was written (2026-09-05), so nothing can be
 * said about how the workflow will case an HR_ID once it starts writing them. HR_IDs in this
 * database are mixed case, and a plain `.eq` against one silently under-returns — which here would
 * print an annex with DERIVED dates while a real approved renewal sat in the table unread, and
 * nothing on the page would say so. A case-insensitive exact match cannot fail that way. There are
 * no wildcards in `hrId`; it has been through `requireHrId`.
 */
async function loadRenewalFacts(hrId: string): Promise<ContractRenewalFacts | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("contract_renewal_requests")
    .select("id, status, proposed_start_date, proposed_end_date, area_name, signed_at")
    .ilike("employee_hr_id", hrId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") return null;
    throw new Error(error.message);
  }
  const row = (data ?? [])[0] as RenewalRequestDbRow | undefined;
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    proposedStartDate: row.proposed_start_date,
    proposedEndDate: row.proposed_end_date,
    areaName: cleanText(row.area_name),
    signedAt: row.signed_at,
  };
}

/**
 * Resolve every term the documents print: the per-person override where one exists, the company
 * default or the system's own record otherwise.
 *
 * The offboarding arguments are optional so the contract half of this function can still be called
 * — and tested — without inventing an exit for somebody who has not left.
 */
export function resolveContractTerms(
  employee: HiringPackEmployeeFacts,
  profile: HiringPackProfile,
  offboarding: OffboardingProfile = emptyOffboardingProfile(employee.hrId),
  exit: ExitFacts | null = null,
  // Who signs for the company when the offboarding record names nobody. Defaulted for the same
  // reason as `collectHiringPackGaps`: a caller resolving one person's dates is not asking the
  // database who the responsible manager is today.
  company: CompanyDetails = COMPANY_DETAILS_DEFAULT,
): HiringPackData["terms"] {
  const durationMonths = profile.contractDurationMonths ?? systemContractDefaults.durationMonths;
  // A contract that does not say when it starts is not a contract. Falling back to the hire date is
  // safe because that is what the paper version has always been filled in with.
  const contractStartDate = profile.contractStartDate ?? employee.hireDate;

  return {
    durationMonths,
    probationMonths: systemContractDefaults.probationMonths,
    underperformanceThresholdPct:
      profile.underperformanceThresholdPct ?? systemContractDefaults.underperformanceThresholdPct,
    underperformanceMonths: profile.underperformanceMonths ?? systemContractDefaults.underperformanceMonths,
    trainingBondMonths: profile.trainingBondMonths ?? systemContractDefaults.trainingBondMonths,
    contractStartDate,
    // The end date is derived, not stored, unless somebody has deliberately overridden it — so a
    // corrected start date cannot leave a stale end date behind it.
    contractEndDate: profile.contractEndDate ?? addMonthsToIsoDate(contractStartDate, durationMonths),
    /**
     * THE DAY SERVICE ENDED, RESOLVED EXACTLY ONCE.
     *
     * Form 6 and whichever Ministry of Labour form applies both state this date, to two different
     * authorities, and the two of them disagreeing is the kind of defect nobody notices until an
     * inspector does. Resolving it here means there is one answer and both forms print it.
     *
     * The confirmed override outranks the resignation record, because that record is not the
     * observation it looks like: the exit form that writes it copies a single date into
     * `submitted_date`, `resignation_date`, `last_working_date` and `effective_date` in nearly every
     * row, so all four agreeing is one value repeated four times, not four confirmations of it.
     */
    lastWorkingDate:
      offboarding.lastWorkingDate ?? exit?.lastWorkingDate ?? employee.lastWorkingDate ?? null,
    // Who signs for the company on the mutual-termination agreement. Defaults to the manager who
    // signs the employment contract as الطرف الأول — the same authority, at the other end.
    employerRepNameAr: offboarding.employerRepNameAr ?? company.responsibleManagerAr,
    employerRepTitleAr: offboarding.employerRepTitleAr ?? company.responsibleManagerTitleAr,
  };
}

/**
 * Canonicalize an HR_ID, refusing a blank one.
 *
 * `canonicalHrIdForDisplay` answers `null` for an empty or whitespace-only value. Passing that on
 * would send every entry point below to look up the employee whose HR_ID is nothing — which fails
 * eventually, as a confusing "employee not found" for an id nobody typed. Failing here names it.
 */
function requireHrId(value: string | null | undefined): string {
  const hrId = canonicalHrIdForDisplay(value);
  if (!hrId) throw new HiringPackEmployeeNotFoundError(String(value ?? "").trim());
  return hrId;
}

/**
 * `custodyDeviceId` names the device a custody receipt is being printed FOR.
 *
 * OPTIONAL, AND ABSENT IS THE NORMAL CASE. Every other document in the pack ignores it, and a
 * custody receipt printed without it prints exactly what it always printed — ruled blanks through
 * the technical block, completed at the desk. It exists so that when the machine IS known, the
 * serial and IMEI on the paper come from the register row that will carry them afterwards.
 */
export async function getHiringPack(
  hrIdInput: string,
  custodyDeviceId?: string | null,
): Promise<HiringPackData> {
  const hrId = requireHrId(hrIdInput);
  // The company is read alongside the person, not after: it is on the critical path of every print,
  // and a missing table answers `{}` rather than throwing, so this adds a query and no failure mode.
  const [employee, profile, offboarding, exit, renewal, company, custodyDevice] = await Promise.all([
    loadEmployeeFacts(hrId),
    loadProfile(hrId),
    loadOffboardingProfile(hrId),
    loadExitFacts(hrId),
    loadRenewalFacts(hrId),
    loadCompanyDetails(),
    // Returns null for an absent id AND for one that names nothing — see `getCustodyDeviceFacts`.
    // A custody receipt must always print; refusing to render a signed instrument because a lookup
    // missed would be a worse failure than the blanks it falls back to.
    getCustodyDeviceFacts(custodyDeviceId),
  ]);
  const suggestedJobTitleAr = await loadSuggestedJobTitleAr(employee.jobTitle);

  return {
    employee,
    profile,
    offboarding,
    company,
    exit,
    custodyDevice,
    renewal,
    suggestedJobTitleAr,
    // Both take the RESOLVED company, so a registration number typed onto a form stops being
    // reported as a blocking gap, and the exit agreement is signed by whoever the record now names.
    gaps: collectHiringPackGaps(employee, profile, offboarding, exit, company),
    terms: resolveContractTerms(employee, profile, offboarding, exit, company),
  };
}

/** Every sales line, for the "Department" picker on the facts editor — from the shared one-minute
 *  copy (src/lib/reference/reference-lists.ts). It still THROWS on a failed read, because a picker
 *  silently offering no lines is how a line gets left blank on a signed contract. Sorted here
 *  instead of by the database: the same four names in the same order. */
export async function listHiringPackLines(): Promise<{ id: number; name: string }[]> {
  const rows = await loadReferenceLines();
  return rows
    .filter((row): row is typeof row & { id: number; name: string } => Boolean(row.name) && row.id != null)
    .map((row) => ({ id: row.id, name: row.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which compensation fields to hand `upsertEmployee` when only the facts screen's base-salary
 * input may have changed.
 *
 * EXPORTED FOR THE TESTS, deliberately. `upsertEmployee` does not store one salary on its own — it
 * re-derives base, basic, gross and net together from whichever ONE of them is supplied, and base
 * outranks the others in that priority (`calculateBaseSalary` in `payroll/policy.ts`). Passing null
 * for basic/gross/net makes the submitted base the anchor; an empty field falls back to the
 * employee's current values so a blank submission can never zero out a real salary.
 *
 * THIS FIELD WAS GROSS SALARY UNTIL 2026-08-31 and the two are not interchangeable. Submitting the
 * employee's UNCHANGED base alongside a freshly typed gross made the formula rebuild gross from
 * that untouched base and silently discard what the screen sent — a save that reported success
 * while the stored figure never moved, which is what printed a stale salary. Anchoring on base
 * cannot fail that way, because base is what the derivation reads first rather than what it
 * overwrites.
 */
export function resolveFactsCompensationFields(
  current: Pick<EmployeeMutationInput, "baseSalary" | "basicSalary" | "netSalary" | "grossSalary">,
  baseSalaryInput: number | null,
): Pick<EmployeeMutationInput, "baseSalary" | "basicSalary" | "netSalary" | "grossSalary"> {
  if (baseSalaryInput === null) {
    return {
      baseSalary: current.baseSalary,
      basicSalary: current.basicSalary,
      grossSalary: current.grossSalary,
      netSalary: current.netSalary,
    };
  }
  return { baseSalary: baseSalaryInput, basicSalary: null, grossSalary: null, netSalary: null };
}

/**
 * Save "What Phoenix already knows" — the facts block was read-only until 2026-08-31, when the
 * owner asked for every field on this screen to be editable, salary and department included.
 *
 * TWO WRITE PATHS, SPLIT ON WHETHER THE PERSON HAS LEFT.
 *
 * Everyone gets the identity/contact fields — name, Arabic name, national ID, insurance number,
 * birth date, hire date, job title, mobile, email, address — written directly to `employees`.
 * These have no formula behind them, so a narrow update is enough and it works for a leaver too,
 * which matters because this is also the screen that fills a departed person's Form 6.
 *
 * Salary and department are different: `grossSalary` is not an independent number, it is one
 * output of the same base→basic→net→gross derivation the full employee editor computes together
 * (see `resolveFactsCompensationFields` for how the other three are resolved so that derivation
 * anchors on the newly typed gross rather than silently discarding it), and "department" is not
 * free text at all — it is the employee's line assignment, which also re-derives their sales
 * region. So for those two fields this function re-runs the exact path the employee editor uses
 * (`upsertEmployee`), carrying every OTHER field on the record through unchanged. That function
 * refuses anyone already resigned or terminated outright ("Use the resignation workflow for
 * resigned or terminated employees") — so for a leaver, salary and department are left exactly as
 * they were, and only the identity fields above are saved. The UI locks those two inputs once
 * `pack.employee.departed` is true, for the same reason.
 */
export async function saveHiringPackEmployeeFacts(
  hrIdInput: string,
  input: HiringPackEmployeeFactsInput,
  // `employees` has no `updated_by_hr_id` column to stamp, unlike `saveHiringPackProfile`'s and
  // `saveOffboardingProfile`'s satellite tables — it names who re-stated any pre-hire deduction lines.
  actorHrId?: string | null,
): Promise<HiringPackData> {
  const hrId = requireHrId(hrIdInput);
  const employee = await loadEmployeeFacts(hrId);

  const fullName = cleanText(input.fullName);
  if (!fullName) throw new Error("Full name is required.");

  if (employee.departed) {
    const { error } = await getSupabaseAdmin()
      .from("employees")
      .update({
        birth_date: cleanText(input.birthDate),
        full_name: fullName,
        hire_date: cleanText(input.hireDate),
        job_title: cleanText(input.jobTitle),
        mobile_number: cleanText(input.mobileNumber),
        name_ar: cleanText(input.nameAr),
        national_id: cleanText(input.nationalId),
        residence_address: cleanText(input.residenceAddress),
        social_insurance_number: cleanText(input.socialInsuranceNumber),
        updated_at: new Date().toISOString(),
        work_email: cleanText(input.workEmail)?.toLowerCase() ?? null,
      })
      .eq("hr_id", hrId);
    if (error) throw new Error(error.message);
    // A leaver's hire date moved later strands his pre-hire lines just the same (pre-hire.ts).
    const { restatePreHireDeductionsAfterHireDateSave } = await import("@/lib/deductions/pre-hire");
    await restatePreHireDeductionsAfterHireDateSave({
      employeeHrId: hrId,
      previousHireDate: employee.hireDate,
      savedHireDate: cleanText(input.hireDate),
      actorHrId: hrIdForStorage(actorHrId),
    });
    return getHiringPack(hrId);
  }

  const directory = await getEmployeeDirectory();
  const current = directory.employees.find((row) => hrIdsMatch(row.hrId, hrId));
  if (!current) throw new HiringPackEmployeeNotFoundError(hrId);

  const compensation = resolveFactsCompensationFields(current, toNumber(input.baseSalary));

  // Every field below either carries the current row through untouched or applies exactly what
  // this screen's facts form edits — never a blend of the two for the same field, so a value the
  // form does not show can never be silently dropped by omission.
  const merged: EmployeeMutationInput = {
    areaId: current.areaId,
    bankAccount: current.bankAccount,
    bankName: current.bankName,
    baseSalary: compensation.baseSalary,
    basicSalary: compensation.basicSalary,
    birthDate: cleanText(input.birthDate),
    contractType: current.contractType,
    crmId: current.crmId,
    crmUsername: current.crmUsername,
    departmentId: current.departmentId,
    education: current.education,
    employmentStatus: current.employmentStatus,
    extraCostOfLiving: current.extraCostOfLiving,
    fuelAllowance: current.fuelAllowance,
    fullName,
    gender: current.gender,
    grossSalary: compensation.grossSalary,
    hasBankAccount: current.hasBankAccount,
    // CARRIED THROUGH, NOT DERIVED. This object is a WHOLE employee record — `upsertEmployee` writes
    // every column it names — so a field left out here is written as NULL. The government health
    // card is nothing to do with the hiring pack, and saving one would otherwise silently erase it.
    healthCardNumber: current.healthCardNumber,
    healthCardReceivedDate: current.healthCardReceivedDate,
    healthCardStatus: current.healthCardStatus,
    hireDate: cleanText(input.hireDate),
    hrId: current.hrId,
    jobTitle: cleanText(input.jobTitle),
    lineId: input.lineId ?? null,
    managerHrId: current.managerHrId,
    medicalInsurance: current.medicalInsurance,
    medicalInsuranceNumber: current.medicalInsuranceNumber,
    medicalInsuranceStatus: current.medicalInsuranceStatus,
    mobileNumber: cleanText(input.mobileNumber),
    nameAr: cleanText(input.nameAr),
    nationalId: cleanText(input.nationalId),
    netSalary: compensation.netSalary,
    nickname: current.nickname,
    originalHrId: current.hrId,
    payrollEligible: current.payrollEligible,
    positionId: current.positionId,
    regionName: current.regionName,
    residenceAddress: cleanText(input.residenceAddress),
    residenceArea: current.residenceArea,
    residenceCity: current.residenceCity,
    salaryDetails: current.salaryDetails ?? null,
    salaryPaymentMode: current.salaryPaymentMode,
    socialInsurance: current.socialInsurance,
    socialInsuranceNumber: cleanText(input.socialInsuranceNumber),
    socialInsuranceStatus: current.socialInsuranceStatus,
    // Carried through, never submitted. The pack derives the insurance wage it PRINTS from the base
    // salary and no longer edits this column; writing `input.socialInsuranceWage` here would send
    // undefined and blank a real payroll figure on every save.
    socialInsuranceWage: current.socialInsuranceWage,
    taxes: current.taxes,
    teamId: current.teamId,
    workEmail: cleanText(input.workEmail)?.toLowerCase() ?? null,
  };

  await upsertEmployee(merged, { actorHrId: hrIdForStorage(actorHrId) });
  return getHiringPack(hrId);
}

export async function saveHiringPackProfile(
  hrIdInput: string,
  input: HiringPackProfileInput,
  actorHrId?: string | null,
): Promise<HiringPackData> {
  const hrId = requireHrId(hrIdInput);
  // Prove the employee exists before writing a profile row for them: the satellite table has no
  // foreign key (hr_id is text and `employees` is edited by several other paths), so nothing at the
  // database level would stop a typo creating an orphan.
  await loadEmployeeFacts(hrId);

  const threshold = Number(input.underperformanceThresholdPct);
  const { error } = await getSupabaseAdmin()
    .from("employee_hiring_profile")
    .upsert(
      {
        hr_id: hrId,
        nationality: cleanText(input.nationality),
        qualification: cleanText(input.qualification),
        birth_place: cleanText(input.birthPlace),
        job_title_ar: cleanText(input.jobTitleAr),
        occupation_code: cleanText(input.occupationCode),
        insurance_office: cleanText(input.insuranceOffice),
        address_building: cleanText(input.addressBuilding),
        address_district: cleanText(input.addressDistrict),
        address_street: cleanText(input.addressStreet),
        address_markaz: cleanText(input.addressMarkaz),
        address_governorate: cleanText(input.addressGovernorate),
        contract_duration_months: toPositiveInt(input.contractDurationMonths),
        contract_start_date: cleanText(input.contractStartDate),
        contract_end_date: cleanText(input.contractEndDate),
        underperformance_threshold_pct:
          Number.isFinite(threshold) && threshold > 0 && threshold <= 100 ? threshold : null,
        underperformance_months: toPositiveInt(input.underperformanceMonths),
        training_bond_months: toPositiveInt(input.trainingBondMonths),
        notes: cleanText(input.notes),
        contract_signatory_name_ar: cleanText(input.contractSignatoryNameAr),
        contract_signatory_title_ar: cleanText(input.contractSignatoryTitleAr),
        // Validated on the way IN as well as on the way out: this column feeds a printed legal
        // ground, and an unknown code stored here would resolve to the dotted rule silently,
        // which reads on screen as a saved choice and on paper as an unanswered one.
        contract_objective_reason_code: isRenewalObjectiveReasonCode(input.contractObjectiveReasonCode)
          ? cleanText(input.contractObjectiveReasonCode)
          : null,
        ...updatedByStamp(actorHrId),
      },
      { onConflict: "hr_id" },
    );

  if (error) throw new Error(error.message);

  // The address block this pack collects for Form 1 describes the same place the outstation
  // distance is measured FROM. Until now the two lived in separate tables with nothing between
  // them, so an address typed here never reached the residence record and never became a
  // coordinate. Do it on the way out of the save, where the address is already in hand.
  await syncResidenceFromHiringAddress(hrId, input);

  return getHiringPack(hrId);
}

/**
 * Push a saved hiring address into the residence record, when it says something new.
 *
 * Three things this must not do, each of which has already gone wrong somewhere in this repo:
 *
 * 1. It must not re-geocode an address that has not changed. `residenceUnchanged` exists because
 *    the Employee Management form re-geocoded and rewrote every residence on every save of any
 *    field. A contract save touches a dozen unrelated fields, so the same trap is open here.
 * 2. It must not overwrite a specific stored address with a vaguer one --
 *    `composeResidenceFromHiringAddress` returns null for a block with no street or building.
 * 3. It must not fail the caller. The profile row is already written and that is what the HR user
 *    asked for; a geocoder outage is not a reason to reject a contract. But it says so out loud,
 *    because the 2026-08-01 Maps billing failure went unnoticed for days on a silent failure path.
 */
async function syncResidenceFromHiringAddress(hrId: string, input: HiringPackProfileInput) {
  const composed = composeResidenceFromHiringAddress(input);
  if (!composed) return;

  try {
    const { data } = await getSupabaseAdmin()
      .from("employee_locations")
      .select("residence_address")
      .eq("employee_hr_id", hrId)
      .maybeSingle();

    if (cleanText(data?.residence_address) === composed.residenceAddress) return;

    await writeEmployeeResidenceLocation(hrId, composed);
  } catch (syncError) {
    console.warn(
      `[hiring-pack] saved ${hrId}'s profile, but could not sync the residence address: `
      + (syncError instanceof Error ? syncError.message : String(syncError)),
    );
  }
}

/**
 * Save the exit-side fields.
 *
 * Separate from `saveHiringPackProfile` because they write different tables for different reasons —
 * see the migration's own note. An exit form must never be able to rewrite a value the signed
 * contract was printed from.
 */
export async function saveOffboardingProfile(
  hrIdInput: string,
  input: OffboardingProfileInput,
  actorHrId?: string | null,
): Promise<HiringPackData> {
  const hrId = requireHrId(hrIdInput);
  // Same reason as the hiring profile: the satellite table has no foreign key, so nothing at the
  // database level would stop a typo creating an orphan row for an employee who does not exist.
  await loadEmployeeFacts(hrId);

  const exitRoute = toExitRoute(cleanText(input.exitRoute ?? null));

  const { error } = await getSupabaseAdmin()
    .from("employee_offboarding_profile")
    .upsert(
      {
        hr_id: hrId,
        exit_route: exitRoute,
        last_working_date: cleanText(input.lastWorkingDate),
        agreement_date: cleanText(input.agreementDate),
        end_reason_ar: cleanText(input.endReasonAr),
        // The form prints one box for the code, so anything that is not a digit cannot reach paper.
        // Stripping here rather than at render time means what is stored is what will print.
        end_reason_code: cleanText((input.endReasonCode ?? "").replace(/[^0-9]/gu, "")),
        addressee_name_ar: cleanText(input.addresseeNameAr),
        addressee_title_ar: cleanText(input.addresseeTitleAr),
        employer_rep_name_ar: cleanText(input.employerRepNameAr),
        employer_rep_title_ar: cleanText(input.employerRepTitleAr),
        notes: cleanText(input.notes),
        ...updatedByStamp(actorHrId),
      },
      { onConflict: "hr_id" },
    );

  if (error) throw new Error(error.message);
  return getHiringPack(hrId);
}

/** Stamp the print time so a reprint is visible rather than silent. Never blocks the print itself. */
export async function recordHiringPackPrinted(hrIdInput: string, document: HiringPackDocument) {
  const hrId = requireHrId(hrIdInput);
  const binding = DOCUMENT_BINDINGS[document];

  // A document with nowhere to record itself records nothing, and says so rather than reporting a
  // write it never attempted. `recorded: false` here is not a failure — the caller ignores it, and
  // treating it as one would put a spurious error in front of somebody printing a custody receipt.
  if (!binding.table || !binding.printedColumn) {
    return { recorded: false, message: null };
  }

  const { error } = await getSupabaseAdmin()
    .from(binding.table)
    .upsert({ hr_id: hrId, [binding.printedColumn]: new Date().toISOString() }, { onConflict: "hr_id" });

  // A failure here must not stop the document reaching the printer: the audit value of knowing
  // when a contract was printed is real, but it is far below the cost of an HR user staring at an
  // error instead of a contract.
  if (error) return { recorded: false, message: error.message };
  return { recorded: true, message: null };
}

/**
 * Record that a document was signed, and light up the matching checklist row.
 *
 * The second half is the point. The Hiring Documents tracker has always been a set of tick-boxes
 * somebody had to remember to tick; wiring the signature to it means the contract and Form 1 mark
 * themselves off, and "who is still missing what" stops depending on anyone's memory.
 */
export async function markHiringPackSigned(input: MarkHiringPackSignedInput): Promise<HiringPackData> {
  const hrId = requireHrId(input.hrId);
  const signedDate = cleanText(input.signedDate);
  if (!signedDate || !/^\d{4}-\d{2}-\d{2}$/.test(signedDate)) {
    throw new Error("A signature date in YYYY-MM-DD form is required.");
  }

  await loadEmployeeFacts(hrId);
  const supabase = getSupabaseAdmin();
  const binding = DOCUMENT_BINDINGS[input.document];

  // Refused rather than silently dropped. A screen that accepts a signature date and stores it
  // nowhere is worse than one that refuses: HR would believe the custody receipt was on file.
  if (!binding.table || !binding.signedColumn) {
    throw new Error(
      `${input.document} does not record a signature against the employee. ` +
        "A custody receipt is signed once per device, so one date on the person could not say which.",
    );
  }

  // THE OWNER'S RULE, CHECKED BEFORE THE DATABASE CHECKS IT. One exit form is signed, never both.
  // The table's own CHECK constraint refuses this too — that is the guarantee — but a constraint
  // violation surfaces as a Postgres error string, and the person reading it needs to be told which
  // form is already signed, not `violates check constraint`.
  if (input.document === "resignation" || input.document === "mutualTermination") {
    const existing = await loadOffboardingProfile(hrId);
    const other =
      input.document === "resignation"
        ? { date: existing.mutualTerminationSignedDate, name: "mutual termination agreement" }
        : { date: existing.resignationSignedDate, name: "resignation request" };
    if (other.date) {
      throw new HiringPackConflictError(
        `A signed ${other.name} is already recorded for ${hrId} (${other.date}). ` +
          "Only one exit form is ever signed — clear that date first if it was recorded in error.",
      );
    }
  }

  // WHICH TEXT WAS SIGNED, stamped once and never rewritten.
  //
  // Only on the first recording of a contract signature. A later correction to the DATE must not
  // move the version: somebody fixing a typo in March would otherwise silently re-file a contract
  // signed in August as though it were against whatever text is current in March, and a reprint
  // would then produce a document that person never saw. Stamping it here rather than at print
  // time is the same reasoning — printing is not signing, and a draft can be printed many times.
  const versionStamp =
    input.document === "contract" && !(await loadProfile(hrId)).contractTemplateVersion
      ? { contract_template_version: currentTemplateVersion("contract").id }
      : {};

  const { error } = await supabase
    .from(binding.table)
    .upsert(
      {
        hr_id: hrId,
        [binding.signedColumn]: signedDate,
        ...updatedByStamp(input.actorHrId),
        ...versionStamp,
      },
      { onConflict: "hr_id" },
    );
  if (error) throw new Error(error.message);

  // WHICH CHECKLIST SLOT THIS SIGNATURE TICKS, resolved by the paper it is pinned to and only then
  // by its name.
  //
  // It used to be the name alone, matched with `ilike`, which made every checklist name a load-
  // bearing string nobody could see from the Hiring Documents screen: HR renaming "Social insurance
  // form" to "Social insurance form 1" — a change the screen invites, and one HR asked for on
  // 2026-09-29 — would have stopped Form 1 ticking its own row, silently, with the signature still
  // recorded and the checklist still reading Pending. `hiring_pack_document` is the column that
  // exists for exactly this, carries the same key as `binding`, and no screen can edit it.
  const byPaper = await supabase
    .from("hiring_document_definitions")
    .select("id, name")
    .eq("hiring_pack_document", input.document)
    .maybeSingle<{ id: string; name: string }>();

  const byName =
    !byPaper.data && binding.checklistName
      ? await supabase
          .from("hiring_document_definitions")
          .select("id, name")
          .ilike("name", binding.checklistName)
          .maybeSingle<{ id: string; name: string }>()
      : null;

  const definition = byPaper.data ?? byName?.data ?? null;

  if (definition?.id) {
    await supabase.from("hiring_document_statuses").upsert(
      {
        employee_hr_id: hrId,
        document_id: definition.id,
        status: "submitted",
        notes: `Signed ${signedDate} — recorded from the hiring pack.`,
      },
      { onConflict: "employee_hr_id,document_id" },
    );
  }

  return getHiringPack(hrId);
}
