import { systemContractDefaults, systemLegalEntity } from "@/config/system-settings";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  HiringPackCandidate,
  HiringPackData,
  HiringPackDocument,
  HiringPackEmployeeFacts,
  HiringPackGap,
  HiringPackProfile,
  HiringPackProfileInput,
  MarkHiringPackSignedInput,
} from "@/lib/hiring-pack/types";

// The hiring pack — assembling everything the employment contract and Form 1 need to print, from
// the two places it lives: what Phoenix already knows about the person (`employees`) and the
// statutory extras HR supplies once (`employee_hiring_profile`).
//
// The design rule this file exists to enforce: THE TEMPLATES NEVER TOUCH THE DATABASE. Both
// documents are rendered from a single resolved `HiringPackData`, so there is exactly one place
// where a value can be wrong, one place to test, and no way for the contract and Form 1 to disagree
// about the same person's salary.

/** Names of the two checklist rows this feature completes when a document is signed. */
const CONTRACT_DOCUMENT_NAME = "Signed employment contract";
const FORM1_DOCUMENT_NAME = "Social insurance form";

type EmployeeDbRow = {
  birth_date: string | null;
  employment_status: string | null;
  full_name: string | null;
  gross_salary: number | string | null;
  hire_date: string | null;
  hr_id: string;
  job_title: string | null;
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

type ProfileDbRow = {
  address_building: string | null;
  address_district: string | null;
  address_governorate: string | null;
  address_markaz: string | null;
  address_street: string | null;
  birth_place: string | null;
  contract_duration_months: number | null;
  contract_end_date: string | null;
  contract_printed_at: string | null;
  contract_signed_date: string | null;
  contract_start_date: string | null;
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

export class HiringPackEmployeeNotFoundError extends Error {
  constructor(hrId: string) {
    super(`No employee record for ${hrId}.`);
    this.name = "HiringPackEmployeeNotFoundError";
  }
}

export function isHiringPackEmployeeMissing(error: unknown) {
  return error instanceof HiringPackEmployeeNotFoundError;
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

function emptyProfile(hrId: string): HiringPackProfile {
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
    contractSignedDate: null,
    form1SignedDate: null,
    contractPrintedAt: null,
    form1PrintedAt: null,
    updatedAt: null,
  };
}

function mapProfile(row: ProfileDbRow): HiringPackProfile {
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
    contractSignedDate: row.contract_signed_date,
    form1SignedDate: row.form1_signed_date,
    contractPrintedAt: row.contract_printed_at,
    form1PrintedAt: row.form1_printed_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Everything the two documents ask for that is still unanswered.
 *
 * `blocking` marks the values without which the document is not merely untidy but wrong to hand
 * over: an unnamed party, a contract with no salary, a Form 1 with no national ID. Everything else
 * is reported so it is visible, and still prints — HR should be able to produce a contract today
 * and chase an occupation code tomorrow.
 */
export function collectHiringPackGaps(
  employee: HiringPackEmployeeFacts,
  profile: HiringPackProfile,
): HiringPackGap[] {
  const gaps: HiringPackGap[] = [];
  const add = (
    field: string,
    labelEn: string,
    labelAr: string,
    document: HiringPackGap["document"],
    blocking: boolean,
    source: HiringPackGap["source"],
  ) => gaps.push({ field, labelEn, labelAr, document, blocking, source });

  // ── From the employee record ────────────────────────────────────────────────────────────────
  if (!employee.nameAr) add("nameAr", "Arabic full name", "الاسم بالعربية", "both", true, "employee-record");
  if (!employee.nationalId) add("nationalId", "National ID", "الرقم القومي", "both", true, "employee-record");
  if (!employee.socialInsuranceNumber) {
    add("socialInsuranceNumber", "Insurance number", "الرقم التأميني", "both", true, "employee-record");
  }
  if (!employee.birthDate) add("birthDate", "Date of birth", "تاريخ الميلاد", "contract", true, "employee-record");
  if (employee.grossSalary === null) {
    add("grossSalary", "Gross monthly salary", "الأجر الشهري الإجمالي", "contract", true, "employee-record");
  }
  if (employee.socialInsuranceWage === null) {
    add("socialInsuranceWage", "Insurance wage", "الأجر التأميني", "both", true, "employee-record");
  }
  if (!employee.hireDate) add("hireDate", "Hire date", "تاريخ الالتحاق", "both", true, "employee-record");
  if (!employee.mobileNumber) add("mobileNumber", "Phone number", "رقم الهاتف", "both", false, "employee-record");
  if (!employee.workEmail) add("workEmail", "Email", "البريد الإلكتروني", "both", false, "employee-record");
  if (!employee.residenceAddress) {
    add("residenceAddress", "Permanent address", "العنوان الدائم", "contract", true, "employee-record");
  }

  // ── From the hiring profile ─────────────────────────────────────────────────────────────────
  if (!profile.nationality) add("nationality", "Nationality", "الجنسية", "both", true, "hiring-profile");
  if (!profile.qualification) add("qualification", "Qualification", "المؤهل", "both", true, "hiring-profile");
  if (!profile.birthPlace) add("birthPlace", "Place of birth", "محل الميلاد", "contract", true, "hiring-profile");
  if (!profile.jobTitleAr) add("jobTitleAr", "Arabic job title", "المسمى الوظيفي بالعربية", "both", true, "hiring-profile");
  if (!profile.occupationCode) add("occupationCode", "Occupation code", "كود المهنة", "form1", false, "hiring-profile");
  // The form prints this employee's office, falling back to the company default — so it is only
  // missing when BOTH are empty. Reporting it while a default exists sends HR chasing a value the
  // printer is about to supply on its own.
  if (!profile.insuranceOffice && !systemLegalEntity.registration.defaultInsuranceOffice) {
    add("insuranceOffice", "Insurance office", "مكتب التأمينات", "form1", false, "hiring-profile");
  }
  if (!profile.addressBuilding) add("addressBuilding", "Building number", "عقار رقم", "form1", false, "hiring-profile");
  if (!profile.addressStreet) add("addressStreet", "Street", "شارع / حارة", "form1", false, "hiring-profile");
  if (!profile.addressGovernorate) add("addressGovernorate", "Governorate", "محافظة", "form1", false, "hiring-profile");

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
  const registration = systemLegalEntity.registration;
  if (!registration.insuranceEstablishmentNumber) {
    add("insuranceEstablishmentNumber", "Establishment number", "رقم المنشأة", "form1", true, "company-settings");
  }
  if (!registration.insuranceSectorCode) {
    add("insuranceSectorCode", "Sector code", "قطاع المنشأة", "form1", true, "company-settings");
  }
  if (!registration.taxRegistrationNumber) {
    add("taxRegistrationNumber", "Tax registration number", "رقم التسجيل الضريبي", "form1", true, "company-settings");
  }

  return gaps;
}

async function loadEmployeeFacts(hrId: string): Promise<HiringPackEmployeeFacts> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select(
      "hr_id, full_name, nickname, name_ar, national_id, social_insurance_number, social_insurance_wage, gross_salary, birth_date, hire_date, job_title, line_id, residence_address, residence_city, mobile_number, work_email, employment_status",
    )
    .eq("hr_id", hrId)
    .maybeSingle<EmployeeDbRow>();

  if (error) throw new Error(error.message);
  if (!data) throw new HiringPackEmployeeNotFoundError(hrId);

  // `employees.line_name` is NULL throughout production, so the department has to come from the
  // lines table by id — reading the column directly would print an empty إدارة/قطاع on every
  // contract.
  let departmentAr: string | null = null;
  if (data.line_id !== null) {
    const { data: line } = await supabase
      .from("lines")
      .select("id, name")
      .eq("id", data.line_id)
      .maybeSingle<{ id: number; name: string | null }>();
    departmentAr = cleanText(line?.name ?? null);
  }

  return {
    hrId: data.hr_id,
    fullName: resolveEmployeeDisplayName(data.full_name ?? "", data.nickname, data.hr_id),
    nameAr: cleanText(data.name_ar),
    nationalId: cleanText(data.national_id),
    socialInsuranceNumber: cleanText(data.social_insurance_number),
    socialInsuranceWage: toNumber(data.social_insurance_wage),
    grossSalary: toNumber(data.gross_salary),
    birthDate: data.birth_date,
    hireDate: data.hire_date,
    jobTitle: cleanText(data.job_title),
    departmentAr,
    residenceAddress: cleanText(data.residence_address),
    residenceCity: cleanText(data.residence_city),
    mobileNumber: cleanText(data.mobile_number),
    workEmail: cleanText(data.work_email),
    employmentStatus: cleanText(data.employment_status),
  };
}

/**
 * The roster the fill screen picks from — newest hires first.
 *
 * Ordered by hire date descending on purpose. This screen exists for the person who started this
 * week, so whoever needs a contract is at the top of the list rather than wherever an alphabetical
 * sort happens to put them. Resigned staff are left out: a leaver does not need a contract printed,
 * and keeping them only makes the list longer.
 */
export async function listHiringPackCandidates(): Promise<HiringPackCandidate[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, full_name, nickname, name_ar, job_title, hire_date, employment_status")
    .neq("employment_status", "resigned")
    .order("hire_date", { ascending: false, nullsFirst: false })
    .limit(2000);

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    hrId: row.hr_id,
    fullName: resolveEmployeeDisplayName(row.full_name ?? "", row.nickname, row.hr_id),
    nameAr: cleanText(row.name_ar),
    jobTitle: cleanText(row.job_title),
    hireDate: row.hire_date,
  }));
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

/** Resolve the four policy terms: the per-hire override where one exists, the company default otherwise. */
export function resolveContractTerms(
  employee: HiringPackEmployeeFacts,
  profile: HiringPackProfile,
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

export async function getHiringPack(hrIdInput: string): Promise<HiringPackData> {
  const hrId = requireHrId(hrIdInput);
  const [employee, profile] = await Promise.all([loadEmployeeFacts(hrId), loadProfile(hrId)]);

  return {
    employee,
    profile,
    gaps: collectHiringPackGaps(employee, profile),
    terms: resolveContractTerms(employee, profile),
  };
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
        updated_by_hr_id: cleanText(actorHrId),
      },
      { onConflict: "hr_id" },
    );

  if (error) throw new Error(error.message);
  return getHiringPack(hrId);
}

/** Stamp the print time so a reprint is visible rather than silent. Never blocks the print itself. */
export async function recordHiringPackPrinted(hrIdInput: string, document: HiringPackDocument) {
  const hrId = requireHrId(hrIdInput);
  const column = document === "contract" ? "contract_printed_at" : "form1_printed_at";

  const { error } = await getSupabaseAdmin()
    .from("employee_hiring_profile")
    .upsert({ hr_id: hrId, [column]: new Date().toISOString() }, { onConflict: "hr_id" });

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
  const column = input.document === "contract" ? "contract_signed_date" : "form1_signed_date";

  const { error } = await supabase
    .from("employee_hiring_profile")
    .upsert(
      { hr_id: hrId, [column]: signedDate, updated_by_hr_id: cleanText(input.actorHrId) },
      { onConflict: "hr_id" },
    );
  if (error) throw new Error(error.message);

  const documentName = input.document === "contract" ? CONTRACT_DOCUMENT_NAME : FORM1_DOCUMENT_NAME;
  const { data: definition } = await supabase
    .from("hiring_document_definitions")
    .select("id, name")
    .ilike("name", documentName)
    .maybeSingle<{ id: string; name: string }>();

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
