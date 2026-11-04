﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿"use client";

import { humanizeCode } from "@/lib/format/code-label";
import {
  AlertCircle,
  ArrowLeftRight,
  Building2,
  Check,
  CircleAlert,
  Download,
  Info,
  Pencil,
  Plus,
  Users,
  RefreshCw,
  Search,
  Upload,
  UserCheck2,
  UserMinus,
  UserPlus,
  UserX,
  X,
} from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import * as React from "react";

import {
  AdminCallout,
  AdminPageHero,
  AdminSectionHeader,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { EmployeeImportReview } from "@/components/employees/employee-import-review";
import { EmployeeCvBulkUpload } from "@/components/employees/employee-cv-bulk-upload";
import { EmployeeCvManager, EmployeeCvPicker, type StagedCv } from "@/components/employees/employee-cv-controls";
import { EmployeeHiringDocumentsCard } from "@/components/employees/employee-hiring-documents-card";
import { EmployeePhotoManager } from "@/components/employees/employee-photo-manager";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { totalExperienceMaxYears } from "@/lib/employees/total-experience-rules";
import type { EmployeeImportDryRunResponse } from "@/lib/imports/employee-import-types";
import { suggestOrgTitleCasing } from "@/lib/imports/org-title-case";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { formatNumberValue } from "@/lib/i18n/format";
import type {
  EmployeeDirectoryData,
  EmployeeDirectoryRow,
  EmployeeLookupOption,
  EmployeeMutationInput,
  EmployeeSalaryDetail,
  EmployeeSalaryDetailCategory,
  EmployeeSalaryDetailValueType,
} from "@/lib/employees/employee-directory";
import { lineIdAfterAreaPick, operatingAreaOptions } from "@/lib/employees/area-line-options";
import {
  getMissingEmployeeRecordFields,
  hasMissingEmployeeRecordData,
  missingEmployeeRecordSummary,
} from "@/lib/employees/employee-record-health";
import type { SeatTransferOptions } from "@/lib/employees/seat-transfer";
import { employeeMasterArrivalKey, readEmployeeMasterArrival } from "@/lib/employees/employee-master-link";
import { readVacancyHireSeat, vacancyHireSeatKey } from "@/lib/employees/vacancy-hire-link";
import { hrIdsMatch } from "@/lib/hr-id";
import {
  applyNationalIdRead,
  nationalIdNotes,
  type NationalIdDerivedField,
  type NationalIdNote,
} from "@/lib/employees/national-id-autofill";
import type { SeatHireCandidate } from "@/lib/recruitment/seat-hire-candidates";
import { FROM_CANDIDATE_PARAM, workspaceCandidateHref } from "@/lib/recruitment/workspace/links";
import { formatVacancyOptionLabel } from "@/lib/employees/vacancy-option-label";
import { deriveSalaryFromNet } from "@/lib/payroll/salary-autofill";
import { todayInCairo } from "@/lib/date-only";
import { DECLINE_OFFER_WINDOW_DAYS, isDeclineOfferEligible } from "@/lib/resignations/decline-offer-eligibility";
import { COMPANY_MAIL_DOMAIN } from "@/lib/new-hire-mailbox/address";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { CrmWorkAfterWarning, dayBefore } from "@/components/resignations/crm-work-after-warning";


type EmployeeManagementProps = {
  /**
   * False for a viewer who may READ the directory but not change it — today that is the HR
   * Business Partner, whose grant is employees:[read, export].
   *
   * This screen used to take no capability props at all, which is why the sidebar row for it was
   * gated on `employees:update` rather than `read`: with no read-only mode, offering it to a
   * reader meant offering Save buttons the API refuses. The API is unchanged and remains the
   * boundary — POST /api/employees asserts employees:update — so this prop hides controls that
   * would fail, and grants nothing.
   */
  canEdit?: boolean;
  /**
   * False for a viewer who may change an employee but not ADD one — the HR Operations Specialist,
   * whose grant is employees:[read, update, export, import]. POST /api/employees asserts
   * employees:create on a save with no original Employee ID, so this hides the Add Employee doors
   * that would fail and grants nothing. Defaults to false for the same reason canEdit does.
   */
  canCreate?: boolean;
  /**
   * resignations:create, resolved by the page. Resign and Declined call routes that assert
   * employees:update AND resignations:create AND vacancies:create, so canEdit alone offered both
   * buttons to the HR Operations Specialist (update, no resignations:create — the owner submits a
   * resignation and she follows it up) and 403'd her on press. Hides the two doors; grants nothing.
   */
  canStartResignation?: boolean;
  initialData?: EmployeeDirectoryData | null;
  initialError?: string | null;
  /**
   * True for the salary-blind seat (isSalaryBlindRole). The server already sends this viewer no
   * money and drops any money she sends; this hides the boxes that would only ever be empty, skips
   * the net-salary calculation, and makes the save carry no money key at all. Bank name, bank
   * account and has-bank-account are not money and stay editable. Payment mode and payroll
   * eligible stay VISIBLE but read only (owner, 2026-10-20: "can change bank account but never a
   * paymode"); the server writes the stored values back whatever is sent.
   */
  salaryBlind?: boolean;
};

type EmployeeSaveResponse = EmployeeDirectoryData & {
  accessProvisioning?: {
    created: number;
    failed: number;
    results: Array<{
      hrId: string;
      message?: string;
      status: "created" | "failed" | "skipped";
    }>;
    skipped: number;
  };
  /** What happened to the CV on a CREATE. Absent on an edit, and on a create that carried none. */
  cvAttachment?: {
    attached: boolean;
    fileName: string | null;
    source: "upload" | "recruitment" | null;
    warnings: string[];
  };
};

type ResignationFormState = {
  effectiveDate: string;
  employeeStatus: string;
  reason: string;
  submittedDate: string;
  workflowNotes: string;
};

type DeclineOfferFormState = {
  lastWorkingDate: string;
  note: string;
  /** "yes" or "no" — kept as a SelectField-friendly string, resolved to a boolean at submit. */
  includeInPayroll: string;
};

/**
 * The dry run's response, as it really is.
 *
 * This was a hand-written subset — `rowsToUpdate?: unknown[]`, findings as `{ message?, rowNumber? }`
 * — which is why the preview could only ever print counts and message strings. The route returns
 * `EmployeeImportValidationResult`; naming it lets the review below diff the actual records. It is
 * the DRY-RUN shape rather than the plan's, because the route also sends the insurance job titles
 * the page cannot work out for itself — the directory it holds does not carry them.
 */
type EmployeeImportPreview = EmployeeImportDryRunResponse;

type EmployeeSalaryDetailFormRow = {
  category: EmployeeSalaryDetailCategory;
  id: string;
  label: string;
  notes: string;
  value: string;
  valueType: EmployeeSalaryDetailValueType;
};

type EmployeeFormState = {
  areaId: string;
  bankAccount: string;
  bankName: string;
  baseSalary: string;
  basicSalary: string;
  birthDate: string;
  contractType: string;
  crmId: string;
  crmUsername: string;
  departmentId: string;
  education: string;
  employmentStatus: string;
  extraCostOfLiving: string;
  fuelAllowance: string;
  fullName: string;
  nickname: string;
  gender: string;
  grossSalary: string;
  hasBankAccount: string;
  healthCardNumber: string;
  healthCardReceivedDate: string;
  healthCardStatus: string;
  birthPlace: string;
  qualification: string;
  universityName: string;
  collegeMajor: string;
  seniorYear: string;
  // HR's total years of experience (owner, 2026-10-31), and the value it was opened with — the save
  // sends the field only when HR changed it, so an ordinary save never touches it.
  totalExperienceYears: string;
  totalExperienceYearsSaved: string;
  contractDuration: string;
  contractRenewalDate: string;
  probationEndDate: string;
  medicalInsuranceCardReceivedDate: string;
  socialInsuranceStartDate: string;
  kaabElamaalNumber: string;
  kaabElamaalIssuer: string;
  kaabElamaalIssueDate: string;
  kaabElamaalRefund: string;
  hireDate: string;
  hrId: string;
  jobTitle: string;
  lineId: string;
  managerHrId: string;
  medicalInsurance: string;
  medicalInsuranceNumber: string;
  medicalInsuranceStatus: string;
  mobileNumber: string;
  nameAr: string;
  nationalId: string;
  netSalary: string;
  payrollEligible: string;
  positionId: string;
  residenceAddress: string;
  residenceArea: string;
  residenceCity: string;
  regionName: string;
  salaryDetails: EmployeeSalaryDetailFormRow[];
  salaryPaymentMode: string;
  socialInsurance: string;
  socialInsuranceNumber: string;
  socialInsuranceStatus: string;
  socialInsuranceWage: string;
  taxes: string;
  teamId: string;
  workEmail: string;
};

type EmployeeNotice = React.ReactNode;

type EmployeeDirectoryTab = "all" | "missing";

// The directory header freezes to the top of the table now that PortalDesktopTable is capped.
// Both halves of its look had to move onto the CELLS to survive that: a `<tr>` background does
// not travel with a sticky `<th>` — the row stays where it was while the cell slides over it, so
// the header would have been transparent with employee rows running through it — and Tailwind's
// preflight collapses table borders, so a `border-b` belongs to the row boundary and stays behind
// for the same reason. Painted as an inset shadow, the divider travels with the cell.
const frozenHeaderCellClassName = "sticky top-0 z-10 bg-phx-paper px-6 py-4";
const frozenHeaderCellStyle: React.CSSProperties = { boxShadow: "inset 0 -1px 0 var(--phx-line)" };

const emptyForm: EmployeeFormState = {
  areaId: "",
  bankAccount: "",
  bankName: "",
  baseSalary: "",
  basicSalary: "",
  birthDate: "",
  contractType: "",
  crmId: "",
  crmUsername: "",
  departmentId: "",
  education: "",
  employmentStatus: "active",
  extraCostOfLiving: "",
  fuelAllowance: "",
  fullName: "",
  nickname: "",
  gender: "",
  grossSalary: "",
  hasBankAccount: "",
  healthCardNumber: "",
  healthCardReceivedDate: "",
  healthCardStatus: "",
  birthPlace: "",
  qualification: "",
  universityName: "",
  collegeMajor: "",
  seniorYear: "",
  totalExperienceYears: "",
  totalExperienceYearsSaved: "",
  contractDuration: "",
  contractRenewalDate: "",
  probationEndDate: "",
  medicalInsuranceCardReceivedDate: "",
  socialInsuranceStartDate: "",
  kaabElamaalNumber: "",
  kaabElamaalIssuer: "",
  kaabElamaalIssueDate: "",
  kaabElamaalRefund: "",
  hireDate: "",
  hrId: "",
  jobTitle: "",
  lineId: "",
  managerHrId: "",
  medicalInsurance: "",
  medicalInsuranceNumber: "",
  medicalInsuranceStatus: "",
  mobileNumber: "",
  nameAr: "",
  nationalId: "",
  netSalary: "",
  payrollEligible: "yes",
  positionId: "",
  residenceAddress: "",
  residenceArea: "",
  residenceCity: "",
  regionName: "",
  salaryDetails: [],
  salaryPaymentMode: "two_parts",
  socialInsurance: "",
  socialInsuranceNumber: "",
  socialInsuranceStatus: "",
  socialInsuranceWage: "",
  taxes: "",
  teamId: "",
  workEmail: "",
};

const salaryPaymentModeOptions = [
  {
    label: "One Part",
    value: "one_part",
  },
  {
    label: "Two Parts",
    value: "two_parts",
  },
];

const salaryDetailCategoryOptions: Array<{
  label: string;
  value: EmployeeSalaryDetailCategory;
}> = [
  { label: "Earning", value: "earning" },
  { label: "Deduction", value: "deduction" },
  { label: "Reference", value: "reference" },
  { label: "Other", value: "other" },
];

const salaryDetailValueTypeOptions: Array<{
  label: string;
  value: EmployeeSalaryDetailValueType;
}> = [
  { label: "Amount", value: "amount" },
  { label: "Text", value: "text" },
];

const genderOptions = [
  { label: "Male", value: "male" },
  { label: "Female", value: "female" },
  { label: "Other / Not specified", value: "other" },
];

const contractTypeOptions = [
  { label: "Full time", value: "full time" },
  { label: "Semi-full time", value: "semi-full time" },
  { label: "Part time", value: "part time" },
];

const yesNoOptions = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

const enrollmentStatusOptions = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
  { label: "Pending", value: "pending" },
];

const resignationStatusOptions = [
  { label: "Resigned", value: "resigned" },
  { label: "Terminated", value: "terminated" },
  { label: "Inactive", value: "inactive" },
];

const emptyResignationForm: ResignationFormState = {
  effectiveDate: new Date().toISOString().slice(0, 10),
  employeeStatus: "resigned",
  reason: "",
  submittedDate: new Date().toISOString().slice(0, 10),
  workflowNotes: "",
};

const declineOfferPayrollOptions = [
  { label: "No — exclude from payroll entirely", value: "no" },
  { label: "Yes — prorate base pay for days worked (no allowances)", value: "yes" },
];

const emptyDeclineOfferForm: DeclineOfferFormState = {
  lastWorkingDate: "",
  note: "",
  includeInPayroll: "no",
};

const panelClassName =
  "rounded-[28px] border border-phx-line bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

function EmployeePageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-[34px] border border-phx-line bg-phx-paper p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6 lg:p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-96 w-96 rounded-full bg-phx-accent/5 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/4 h-80 w-80 rounded-full bg-[#3B82F6]/5 blur-3xl"
      />
      <div className="relative z-10 space-y-6 max-w-[1720px] mx-auto">{children}</div>
    </div>
  );
}

function emptyText(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function masterText(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function dateText(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "Not provided";
}

function optionName(value: string) {
  return humanizeCode(value);
}

function isMedicalRepTitle(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (
    normalized.includes("medical representative") ||
    normalized.includes("medical rep") ||
    normalized === "mr"
  );
}

function isSalesPositionTitle(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (
    isMedicalRepTitle(normalized) ||
    normalized.includes("district sales manager") ||
    // "Senior District Manager" carries neither the word "sales" nor the "district sales manager"
    // phrase, so without this clause the promotion would have taken a real district manager out of
    // the sales branch of this form (B-94, 2026-09-29).
    normalized.includes("district manager") ||
    normalized === "dsm" ||
    normalized.includes("sales")
  );
}

function isManagerPositionTitle(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().includes("manager");
}

function normalizeForMatch(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * The line under a box that the national ID filled (or disagrees with). A disagreement carries a
 * click that writes the ID's value — HR's own typing is never replaced without it.
 */
function IdNote({ note, onUse }: { note: NationalIdNote | undefined; onUse: (note: NationalIdNote) => void }) {
  if (!note) return null;
  const differs = note.kind === "differs";
  return (
    <span className={cn("mt-1.5 block text-xs", differs ? "text-amber-700" : "text-text-tertiary")}>
      {note.text}
      {differs ? (
        <button className="ml-1.5 font-bold underline" onClick={() => onUse(note)} type="button">
          Use it
        </button>
      ) : null}
    </span>
  );
}

function SelectField({
  className,
  disabled = false,
  label,
  note,
  onChange,
  onUseNote,
  options,
  placeholder,
  value,
  tone = "blue",
}: {
  className?: string;
  disabled?: boolean;
  label: string;
  note?: NationalIdNote;
  onChange: (value: string) => void;
  onUseNote?: (note: NationalIdNote) => void;
  options: EmployeeLookupOption[];
  placeholder?: string;
  value: string;
  tone?: "blue" | "emerald" | "orange" | "violet" | "slate";
}) {
  const isSelected = value !== "";

  // The FIELD's box is the shared token now (form-tokens.ts), so a tone no longer carries a
  // border, a ground or a focus outline: five accent focus rings in one form were five
  // disagreements with the one design. What a tone still carries is the SELECTED state — a
  // tint on the box and the ink on the label, value and chevron — because that is a state
  // indicator rather than the skin.
  const toneStyles = {
    blue: {
      selected: "border-blue-200 bg-blue-50/50",
      text: isSelected ? "text-blue-700" : "text-text",
      label: isSelected ? "text-blue-600" : "text-text-secondary",
      icon: "text-blue-500",
    },
    emerald: {
      selected: "border-emerald-200 bg-emerald-50/50",
      text: isSelected ? "text-emerald-700" : "text-text",
      label: isSelected ? "text-emerald-600" : "text-text-secondary",
      icon: "text-emerald-500",
    },
    orange: {
      selected: "border-orange-200 bg-orange-50/50",
      text: isSelected ? "text-orange-700" : "text-text",
      label: isSelected ? "text-orange-600" : "text-text-secondary",
      icon: "text-orange-500",
    },
    violet: {
      selected: "border-violet-200 bg-violet-50/50",
      text: isSelected ? "text-violet-700" : "text-text",
      label: isSelected ? "text-violet-600" : "text-text-secondary",
      icon: "text-violet-500",
    },
    slate: {
      selected: "border-slate-300 bg-slate-50/50",
      text: isSelected ? "text-slate-700" : "text-text",
      label: isSelected ? "text-slate-600" : "text-text-secondary",
      icon: "text-slate-500",
    },
  }[tone];

  return (
    <label className={cn("block group", className)}>
      <div className="mb-1.5 flex items-center px-0.5">
        <span className={cn("block text-phx-2xs font-black uppercase tracking-[0.15em] transition-colors break-words", toneStyles.label)}>
          {label}
        </span>
      </div>
      <div className="relative">
        <SearchableSelect
          className={cn(
            "w-full px-3 text-xs",
            // SearchableSelect renders an <input> (searchable-select.tsx:295). An input is a
            // single-line control that cannot wrap whatever we do to it, so dropping `truncate`
            // here would not give the text room — it would only swap the ellipsis for a silent
            // clip, which is strictly worse for the reader. This is the same exception the
            // fits-the-screen rule already makes for a native <select>. Left deliberately, and it
            // stays counted by tests/no-ellipsis-truncation-ratchet.test.ts rather than hidden.
            "appearance-none hover:shadow-md cursor-pointer whitespace-nowrap truncate pr-8",
            isSelected && toneStyles.selected,
            toneStyles.text,
            disabled && "opacity-50 cursor-not-allowed"
          )}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          value={value}
        >
          <option value="">{placeholder ?? `Select ${label.toLowerCase()}`}</option>
          {options.map((option) => (
            <option key={`${option.value}-${option.label}`} value={option.value}>
              {option.label}
            </option>
          ))}
        </SearchableSelect>
        <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
          <svg className={cn("h-4 w-4 transition-transform group-hover:translate-y-0.5", toneStyles.icon)} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
          </svg>
        </div>
      </div>
      {onUseNote ? <IdNote note={note} onUse={onUseNote} /> : null}
    </label>
  );
}

function TextField({
  disabled = false,
  label,
  note,
  onChange,
  onUseNote,
  placeholder,
  type = "text",
  value,
}: {
  disabled?: boolean;
  label: string;
  note?: NationalIdNote;
  onChange: (value: string) => void;
  onUseNote?: (note: NationalIdNote) => void;
  placeholder?: string;
  type?: string;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-text-secondary">
        {label}
      </span>
      <Input
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        value={value}
      />
      {onUseNote ? <IdNote note={note} onUse={onUseNote} /> : null}
    </label>
  );
}

/**
 * The company address, typed as the LOCAL PART ONLY.
 *
 * 🔴 WHY THE DOMAIN IS NOT TYPEABLE (owner, 2026-10-03): the address stored here is the one the
 * mailbox robot creates in Turbify, verbatim. It must never be derived from the name — a derivation
 * turned "El Sayed Rady" into `el.sayed@satopharma.com`, splitting a first name that is one word,
 * and created a real mailbox at the wrong address. So the owner types `elsayed.ramdan` and the
 * domain is fixed: one less thing to mistype, and no path to a mailbox on another domain.
 *
 * An address already on the record that is NOT on the company domain keeps a plain full-width input,
 * because showing only its local part beside a fixed @satopharma.com would silently move somebody's
 * address to another domain the next time this form is saved.
 */
function CompanyEmailField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const suffix = `@${COMPANY_MAIL_DOMAIN}`;
  const current = value.trim();
  const foreign = current.length > 0 && !current.toLowerCase().endsWith(suffix);

  if (foreign) {
    return (
      <div className="block">
        <TextField label={label} onChange={onChange} placeholder="employee@company.com" type="email" value={value} />
        <span className="mt-1.5 block text-xs text-text-tertiary">
          This address is not on {COMPANY_MAIL_DOMAIN}, so it stays editable in full.
        </span>
      </div>
    );
  }

  const local = current.toLowerCase().endsWith(suffix) ? current.slice(0, current.length - suffix.length) : current;

  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-text-secondary">{label}</span>
      <div className="flex h-11 w-full items-stretch overflow-hidden rounded-2xl border border-[#D7E0EA] bg-white/95 shadow-sm focus-within:border-phx-blue">
        <input
          className="h-full min-w-0 flex-1 border-0 bg-transparent px-3 text-sm text-text-primary outline-none"
          // A pasted full address is accepted and its domain dropped, rather than ending up as
          // "elsayed.ramdan@satopharma.com@satopharma.com".
          onChange={(event) => {
            const typed = event.target.value.trim().toLowerCase().replace(/\s+/g, "");
            const localPart = (typed.includes("@") ? typed.slice(0, typed.indexOf("@")) : typed)
              .replace(/[^a-z0-9._-]/g, "");
            onChange(localPart ? `${localPart}${suffix}` : "");
          }}
          placeholder="elsayed.ramdan"
          value={local}
        />
        <span className="flex shrink-0 items-center border-l border-[#D7E0EA] bg-phx-paper px-3 text-sm text-phx-ink-soft">
          {suffix}
        </span>
      </div>
    </label>
  );
}

/**
 * The salary boxes the Employee Master derives once a net salary is typed.
 * Every one of them stays editable afterwards.
 */
const SALARY_AUTOFILL_KEYS = [
  "extraCostOfLiving",
  "fuelAllowance",
  "baseSalary",
  "basicSalary",
  "socialInsuranceWage",
  "socialInsurance",
  "taxes",
  "grossSalary",
] as const;

type SalaryAutofillKey = (typeof SALARY_AUTOFILL_KEYS)[number];

/**
 * Cost of living and fuel FEED the chain (they are subtracted from the net to
 * reach the base), so editing one has to recompute everything below it. The rest
 * are pure outputs: editing one only pins it.
 */
const SALARY_AUTOFILL_INPUT_KEYS: ReadonlySet<SalaryAutofillKey> = new Set([
  "extraCostOfLiving",
  "fuelAllowance",
]);

/**
 * Refill everything the net salary implies, leaving alone any box the owner has
 * typed into himself. Called from the change handlers rather than an effect:
 * react-hooks/set-state-in-effect is an error in this repo.
 */
function withSalaryAutofill(
  form: EmployeeFormState,
  overridden: ReadonlySet<SalaryAutofillKey>,
): EmployeeFormState {
  const derived = deriveSalaryFromNet({
    employeeHrId: form.hrId,
    extraCostOfLiving: overridden.has("extraCostOfLiving") ? Number(form.extraCostOfLiving) : null,
    fuelAllowance: overridden.has("fuelAllowance") ? Number(form.fuelAllowance) : null,
    jobTitle: form.jobTitle,
    netSalary: Number(form.netSalary),
  });

  if (!derived) return form;

  const derivedValues: Record<SalaryAutofillKey, number> = {
    baseSalary: derived.baseSalary,
    basicSalary: derived.basicSalary,
    extraCostOfLiving: derived.extraCostOfLiving,
    fuelAllowance: derived.fuelAllowance,
    grossSalary: derived.grossSalary,
    socialInsurance: derived.socialInsurance,
    socialInsuranceWage: derived.insuranceWage,
    taxes: derived.taxes,
  };

  const next = { ...form };
  for (const key of SALARY_AUTOFILL_KEYS) {
    if (overridden.has(key)) continue;
    next[key] = String(derivedValues[key]);
  }

  return next;
}

function employeeToForm(employee: EmployeeDirectoryRow): EmployeeFormState {
  const numberToText = (value: number | null | undefined) =>
    value === null || value === undefined ? "" : String(value);

  return {
    areaId: employee.areaId ? String(employee.areaId) : "",
    bankAccount: employee.bankAccount ?? "",
    bankName: employee.bankName ?? "",
    baseSalary: numberToText(employee.baseSalary),
    basicSalary: numberToText(employee.basicSalary),
    birthDate: employee.birthDate ?? "",
    contractType: employee.contractType ?? "",
    crmId: employee.crmId ?? "",
    crmUsername: employee.crmUsername ?? "",
    departmentId: employee.departmentId ? String(employee.departmentId) : "",
    education: employee.education ?? "",
    employmentStatus: employee.employmentStatus ?? "active",
    extraCostOfLiving: numberToText(employee.extraCostOfLiving),
    fuelAllowance: numberToText(employee.fuelAllowance),
    fullName: employee.fullName,
    nickname: employee.nickname ?? "",
    gender: employee.gender ?? "",
    grossSalary: numberToText(employee.grossSalary),
    hasBankAccount: employee.hasBankAccount ?? (employee.bankAccount ? "yes" : ""),
    healthCardNumber: employee.healthCardNumber ?? "",
    healthCardReceivedDate: employee.healthCardReceivedDate ?? "",
    healthCardStatus: employee.healthCardStatus ?? "",
    birthPlace: employee.birthPlace ?? "",
    qualification: employee.qualification ?? "",
    universityName: employee.universityName ?? "",
    collegeMajor: employee.collegeMajor ?? "",
    seniorYear: employee.seniorYear ?? "",
    totalExperienceYears: employee.totalExperienceYears == null ? "" : String(employee.totalExperienceYears),
    totalExperienceYearsSaved: employee.totalExperienceYears == null ? "" : String(employee.totalExperienceYears),
    contractDuration: employee.contractDuration ?? "",
    contractRenewalDate: employee.contractRenewalDate ?? "",
    probationEndDate: employee.probationEndDate ?? "",
    medicalInsuranceCardReceivedDate: employee.medicalInsuranceCardReceivedDate ?? "",
    socialInsuranceStartDate: employee.socialInsuranceStartDate ?? "",
    kaabElamaalNumber: employee.kaabElamaalNumber ?? "",
    kaabElamaalIssuer: employee.kaabElamaalIssuer ?? "",
    kaabElamaalIssueDate: employee.kaabElamaalIssueDate ?? "",
    kaabElamaalRefund: employee.kaabElamaalRefund ?? "",
    hireDate: employee.hireDate ?? "",
    hrId: employee.hrId,
    jobTitle: employee.jobTitle ?? employee.positionTitle ?? "",
    lineId: employee.lineId ? String(employee.lineId) : "",
    managerHrId: employee.managerHrId ?? "",
    medicalInsurance: numberToText(employee.medicalInsurance),
    medicalInsuranceNumber: employee.medicalInsuranceNumber ?? "",
    medicalInsuranceStatus: employee.medicalInsuranceStatus ?? "",
    mobileNumber: employee.mobileNumber ?? "",
    nameAr: employee.nameAr ?? "",
    nationalId: employee.nationalId ?? "",
    netSalary: numberToText(employee.netSalary),
    payrollEligible: employee.payrollEligible === false ? "no" : "yes",
    positionId: employee.positionId ? String(employee.positionId) : "",
    residenceAddress: employee.residenceAddress ?? "",
    residenceArea: employee.residenceArea ?? "",
    residenceCity: employee.residenceCity ?? "",
    regionName: employee.regionName ?? "",
    salaryDetails: salaryDetailsToFormRows(employee.salaryDetails),
    salaryPaymentMode: employee.salaryPaymentMode,
    socialInsurance: numberToText(employee.socialInsurance),
    socialInsuranceNumber: employee.socialInsuranceNumber ?? "",
    socialInsuranceStatus: employee.socialInsuranceStatus ?? "",
    socialInsuranceWage: numberToText(employee.socialInsuranceWage),
    taxes: numberToText(employee.taxes),
    teamId: employee.teamId ? String(employee.teamId) : "",
    workEmail: employee.workEmail ?? "",
  };
}

function employeeRowKey(employee: EmployeeDirectoryRow, index: number) {
  return [
    employee.hrId,
    employee.createdAt,
    employee.updatedAt,
    employee.fullName,
    index,
  ].join(":");
}

/**
 * The keys a salary-blind save leaves out entirely. OMITTED, never sent as null: the server reads
 * an absent money key as "this save says nothing about pay" and keeps the stored figure, and the
 * flexible salary details in particular are WIPED by an empty array. The server drops them for
 * this seat anyway (app/api/employees/route.ts) — this is so the request never carries them.
 */
const SALARY_BLIND_OMITTED_KEYS = [
  "baseSalary",
  "basicSalary",
  "extraCostOfLiving",
  "fuelAllowance",
  "grossSalary",
  "medicalInsurance",
  "netSalary",
  "salaryDetails",
  "socialInsurance",
  "socialInsuranceWage",
  "taxes",
] as const satisfies ReadonlyArray<keyof EmployeeMutationInput>;

/** Said instead of opening Add Employee for a viewer without employees:create, whichever door she used. */
const ADD_EMPLOYEE_NOT_IN_SEAT =
  "Adding a new employee is not part of your seat — you can edit the people already in the master.";

/** The Payroll Reference rows the salary-blind seat is not shown — every money figure, nothing else. */
const SALARY_BLIND_HIDDEN_MASTER_LABELS: ReadonlySet<string> = new Set([
  "Basic Salary",
  "Base Salary",
  "Gross Salary",
  "Net Salary",
  "Fuel Allowance",
  "Extra Cost of Living",
  "Medical Insurance",
  "Social Insurance",
  "Taxes",
]);

function formToPayload(
  form: EmployeeFormState,
  originalHrId: string | null,
  options: { salaryBlind?: boolean } = {},
): EmployeeMutationInput {
  const payload = formToFullPayload(form, originalHrId);
  if (options.salaryBlind) {
    for (const key of SALARY_BLIND_OMITTED_KEYS) delete payload[key];
  }
  return payload;
}

function formToFullPayload(form: EmployeeFormState, originalHrId: string | null): EmployeeMutationInput {
  const optionalNumber = (value: string) => (value ? Number(value) : null);
  const optionalText = (value: string) => value.trim() || null;

  return {
    areaId: optionalNumber(form.areaId),
    bankAccount: optionalText(form.bankAccount),
    bankName: optionalText(form.bankName),
    baseSalary: optionalNumber(form.baseSalary),
    basicSalary: optionalNumber(form.basicSalary),
    birthDate: optionalText(form.birthDate),
    contractType: optionalText(form.contractType),
    crmId: optionalText(form.crmId),
    crmUsername: optionalText(form.crmUsername),
    departmentId: optionalNumber(form.departmentId),
    education: optionalText(form.education),
    employmentStatus: optionalText(form.employmentStatus),
    extraCostOfLiving: optionalNumber(form.extraCostOfLiving),
    fuelAllowance: optionalNumber(form.fuelAllowance),
    fullName: optionalText(form.fullName),
    nickname: optionalText(form.nickname),
    gender: optionalText(form.gender),
    grossSalary: optionalNumber(form.grossSalary),
    hasBankAccount: optionalText(form.hasBankAccount),
    healthCardNumber: optionalText(form.healthCardNumber),
    healthCardReceivedDate: optionalText(form.healthCardReceivedDate),
    healthCardStatus: optionalText(form.healthCardStatus),
    birthPlace: optionalText(form.birthPlace),
    qualification: optionalText(form.qualification),
    universityName: optionalText(form.universityName),
    collegeMajor: optionalText(form.collegeMajor),
    seniorYear: optionalText(form.seniorYear),
    ...(form.totalExperienceYears.trim() !== form.totalExperienceYearsSaved
      ? { totalExperienceYears: optionalText(form.totalExperienceYears) }
      : {}),
    contractDuration: optionalText(form.contractDuration),
    contractRenewalDate: optionalText(form.contractRenewalDate),
    probationEndDate: optionalText(form.probationEndDate),
    medicalInsuranceCardReceivedDate: optionalText(form.medicalInsuranceCardReceivedDate),
    socialInsuranceStartDate: optionalText(form.socialInsuranceStartDate),
    kaabElamaalNumber: optionalText(form.kaabElamaalNumber),
    kaabElamaalIssuer: optionalText(form.kaabElamaalIssuer),
    kaabElamaalIssueDate: optionalText(form.kaabElamaalIssueDate),
    kaabElamaalRefund: optionalText(form.kaabElamaalRefund),
    hireDate: optionalText(form.hireDate),
    hrId: optionalText(form.hrId),
    jobTitle: optionalText(form.jobTitle),
    lineId: optionalNumber(form.lineId),
    managerHrId: optionalText(form.managerHrId),
    medicalInsurance: optionalNumber(form.medicalInsurance),
    medicalInsuranceNumber: optionalText(form.medicalInsuranceNumber),
    medicalInsuranceStatus: optionalText(form.medicalInsuranceStatus),
    mobileNumber: optionalText(form.mobileNumber),
    nameAr: optionalText(form.nameAr),
    nationalId: optionalText(form.nationalId),
    netSalary: optionalNumber(form.netSalary),
    originalHrId,
    payrollEligible: form.payrollEligible !== "no",
    positionId: optionalNumber(form.positionId),
    residenceAddress: optionalText(form.residenceAddress),
    residenceArea: optionalText(form.residenceArea),
    residenceCity: optionalText(form.residenceCity),
    regionName: optionalText(form.regionName),
    salaryDetails: form.salaryDetails
      .map((detail) => ({
        category: detail.category,
        id: detail.id,
        label: detail.label.trim(),
        notes: detail.notes.trim() || null,
        value: detail.value.trim(),
        valueType: detail.valueType,
      }))
      .filter((detail) => detail.label || detail.value || detail.notes),
    salaryPaymentMode: optionalText(form.salaryPaymentMode),
    socialInsurance: optionalNumber(form.socialInsurance),
    socialInsuranceNumber: optionalText(form.socialInsuranceNumber),
    socialInsuranceStatus: optionalText(form.socialInsuranceStatus),
    socialInsuranceWage: optionalNumber(form.socialInsuranceWage),
    taxes: optionalNumber(form.taxes),
    teamId: optionalNumber(form.teamId),
    workEmail: optionalText(form.workEmail),
  };
}

function createSalaryDetailFormRow(
  overrides: Partial<EmployeeSalaryDetailFormRow> = {},
): EmployeeSalaryDetailFormRow {
  return {
    category: overrides.category ?? "earning",
    id:
      overrides.id ??
      (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `salary-detail-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    label: overrides.label ?? "",
    notes: overrides.notes ?? "",
    value: overrides.value ?? "",
    valueType: overrides.valueType ?? "amount",
  };
}

function salaryDetailsToFormRows(
  salaryDetails: EmployeeSalaryDetail[] | null | undefined,
) {
  return (salaryDetails ?? []).map((detail) =>
    createSalaryDetailFormRow({
      category: detail.category,
      id: detail.id,
      label: detail.label,
      notes: detail.notes ?? "",
      value: detail.value,
      valueType: detail.valueType,
    }),
  );
}

function organogramHrefForEmployee(
  employee: Pick<EmployeeFormState, "hrId" | "lineId">,
  directory: EmployeeDirectoryData | null,
) {
  const params = new URLSearchParams();
  const lineName = directory?.lookups.lines.find((line) => line.value === employee.lineId)?.label;

  if (lineName) params.set("line", lineName);
  if (employee.hrId.trim()) params.set("search", employee.hrId.trim().toUpperCase());

  return `/organogram${params.toString() ? `?${params.toString()}` : ""}`;
}

function DirectoryAvatar({
  hrId,
  fullName,
  hasPhoto,
}: {
  hrId: string;
  fullName: string;
  hasPhoto?: boolean;
}) {
  const staticUrl = employeeProfileImageForHrId(hrId);
  const initials =
    fullName
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p.charAt(0))
      .join("")
      .toUpperCase() || "EM";
  // Only attempt the uploaded-photo route when the directory data says one
  // exists — otherwise every row without a photo fires a guaranteed-404
  // request, and a full page of rows does it all at once (see the Cloud Run
  // p95-latency alert this was tripping).
  const [mode, setMode] = React.useState<"uploaded" | "static" | "initials">(
    hasPhoto ? "uploaded" : staticUrl ? "static" : "initials",
  );

  function handleError() {
    setMode((m) => (m === "uploaded" ? (staticUrl ? "static" : "initials") : "initials"));
  }

  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-orange-50">
      {mode !== "initials" ? (
        <ZoomablePhoto
          alt=""
          ariaHidden
          className="h-full w-full object-cover"
          onError={handleError}
          src={mode === "uploaded" ? `/api/employees/${encodeURIComponent(hrId)}/photo` : (staticUrl ?? "")}
        />
      ) : (
        <span className="text-phx-2xs font-black text-orange-600">{initials}</span>
      )}
    </div>
  );
}

export function EmployeeManagement({
  // FAILS CLOSED. This defaulted to `true`, so a page that forgot the prop handed every viewer
  // Save and Add controls the API then refuses — which is what happened to the portal copy of the
  // employees page for as long as it has existed. Both call sites now pass it explicitly, so the
  // default is only ever reached by a THIRD page that forgets, and read-only is the safe way for
  // that to be wrong.
  canEdit = false,
  canCreate = false,
  canStartResignation = false,
  initialData = null,
  initialError = null,
  salaryBlind = false,
}: EmployeeManagementProps) {
  const [data, setData] = React.useState<EmployeeDirectoryData | null>(
    initialData,
  );
  const [error, setError] = React.useState<string | null>(initialError);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isImportingTemplate, setIsImportingTemplate] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [directoryTab, setDirectoryTab] = React.useState<EmployeeDirectoryTab>("all");
  const [areaFilter, setAreaFilter] = React.useState("");
  /**
   * Who has a CV on their master record. "No" is the one this exists for — the list of who still
   * needs chasing, which on production 2026-09-29 was 96 active people out of 198. It reads the
   * row's own `hasCv`, which the directory service fills from one cached index rather than a
   * column on every row (employee-cv.ts, getEmployeeCvHrIdSet).
   */
  const [cvFilter, setCvFilter] = React.useState("");
  const [departmentFilter, setDepartmentFilter] = React.useState("");
  const [hasBankAccountFilter, setHasBankAccountFilter] = React.useState("");
  const [medicalInsuranceStatusFilter, setMedicalInsuranceStatusFilter] = React.useState("");
  const [lineFilter, setLineFilter] = React.useState("");
  const [positionFilter, setPositionFilter] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [regionFilter, setRegionFilter] = React.useState("");
  const [salaryPaymentModeFilter, setSalaryPaymentModeFilter] = React.useState("");
  const [socialInsuranceStatusFilter, setSocialInsuranceStatusFilter] = React.useState("");
  const [form, setForm] = React.useState<EmployeeFormState>(emptyForm);
  /**
   * Salary boxes the owner has typed into himself. Auto-fill writes every other
   * derived box and never touches these -- until he clears one, which hands it
   * back to auto-fill. Reset whenever the form is opened or closed, so an
   * override never leaks from one employee into the next.
   */
  const salaryOverridesRef = React.useRef<Set<SalaryAutofillKey>>(new Set());
  const [autoGeneratedHrId, setAutoGeneratedHrId] = React.useState<string | null>(null);
  const [editingHrId, setEditingHrId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<EmployeeNotice | null>(null);
  const [isFormOpen, setIsFormOpen] = React.useState(false);
  // The CV chosen on the Add Employee form. Already uploaded to the staging area by the time this
  // holds anything — all that travels with the save is the draft id.
  const [stagedCv, setStagedCv] = React.useState<StagedCv | null>(null);
  // Set when a recruiter arrives from an application to hire someone. Drives the pre-fill below and
  // the way back afterwards, so the new HR_ID does not have to be carried across by hand.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const hireApplicationId = searchParams.get("fromApplication");
  const appliedHireDraftRef = React.useRef<string | null>(null);
  // Set when somebody pressed "Add employee" on an ACCEPTED job offer. A second door into the same
  // form, with its own id and its own ref rather than sharing the application's: an offer letter
  // can go to anybody, including somebody who never entered the ATS, which is the whole reason the
  // offers module exists apart from recruitment.
  const hireOfferId = searchParams.get("fromOffer");
  const appliedOfferDraftRef = React.useRef<string | null>(null);
  // The letter the OPEN form was actually filled from. Held apart from `hireOfferId` on purpose: the
  // query string outlives the form (closing the drawer and pressing Add Employee starts a blank hire
  // while `?fromOffer=` is still in the bar), so reading the URL at save time would point a letter at
  // whoever was typed next. Set only once the letter's draft landed in the form, cleared the moment
  // the form closes or is reopened for anyone else.
  const [offerLinkId, setOfferLinkId] = React.useState<string | null>(null);
  // Set when "Mark as hired" in the recruitment workspace opened this form (?fromCandidate=<id>,
  // beside the seat's own ?hireVacancy=1&...). The seat fills WHERE they sit; this fills WHO.
  const hireCandidateId = searchParams.get(FROM_CANDIDATE_PARAM);
  const appliedCandidateDraftRef = React.useRef<string | null>(null);
  // The candidate the OPEN form was filled for — held in state for the same reason as `offerLinkId`:
  // the query string outlives the form, and the save marks THIS person hired. Set once their draft
  // landed, cleared with the seat's candidate picker whenever the form closes or opens for anyone else.
  const [candidateLinkId, setCandidateLinkId] = React.useState<string | null>(null);
  // Set when somebody pressed an OPEN SEAT on the organogram. Everything the seat knows —
  // line, area, department, position, manager, region — travels in the query string, so the
  // form opens on that seat instead of making them retype the box they just looked at.
  const vacancySeatDraft = React.useMemo(
    () => readVacancyHireSeat((key) => searchParams.get(key)),
    [searchParams],
  );
  const appliedVacancySeatRef = React.useRef<string | null>(null);
  // The seat the OPEN FORM was opened for. Held in state rather than read straight off the
  // URL so the banner belongs to this form and not to the query string: closing the drawer
  // and pressing Add Employee again starts a blank hire, and the params are still in the bar.
  const [vacancySeatLabel, setVacancySeatLabel] = React.useState<string | null>(null);
  /**
   * Who this seat could be filled with. Add Employee has two doors and they used to be
   * separate: a SEAT filled the placement and left the person blank, an APPLICATION filled the
   * person and left the placement blank, so a real hire meant typing one half by hand. Loaded
   * only when the form was opened from a seat, and left EMPTY on any failure — a viewer who
   * holds employees:update but not recruitment:read simply gets the form as before, with no
   * error about a capability they were never offered.
   */
  const [seatHireCandidates, setSeatHireCandidates] = React.useState<SeatHireCandidate[]>([]);
  const [pickedApplicationId, setPickedApplicationId] = React.useState<string | null>(null);
  const [pickedCandidateName, setPickedCandidateName] = React.useState<string | null>(null);
  const [isPickingCandidate, setIsPickingCandidate] = React.useState(false);
  /**
   * Set when the offer's job title and the seat's disagree. NOT resolved silently: the seat is
   * what is being filled so its title stays, but the two disagreeing is a real thing somebody
   * has to look at, and picking one quietly is how a person ends up filed under a title they
   * never signed for.
   */
  const [offerTitleConflict, setOfferTitleConflict] = React.useState<string | null>(null);
  // The application this save belongs to, whichever door it came through. Drives the CV copy on
  // the server and the way back to recruitment afterwards.
  const activeApplicationId = hireApplicationId ?? pickedApplicationId;
  const [isResigning, setIsResigning] = React.useState(false);
  const [isResignationOpen, setIsResignationOpen] = React.useState(false);
  const [masterDetailsEmployee, setMasterDetailsEmployee] = React.useState<EmployeeDirectoryRow | null>(null);
  const [isDownloadingFixList, setIsDownloadingFixList] = React.useState(false);
  const [pendingImportFile, setPendingImportFile] = React.useState<File | null>(null);
  const [pendingImportPreview, setPendingImportPreview] = React.useState<EmployeeImportPreview | null>(null);
  const [resignationError, setResignationError] = React.useState<string | null>(null);
  const [resigningEmployee, setResigningEmployee] = React.useState<EmployeeDirectoryRow | null>(null);
  const [transferEmployee, setTransferEmployee] = React.useState<EmployeeDirectoryRow | null>(null);
  const [isTransferOpen, setIsTransferOpen] = React.useState(false);
  const [transferOptions, setTransferOptions] = React.useState<SeatTransferOptions | null>(null);
  const [isLoadingTransferOptions, setIsLoadingTransferOptions] = React.useState(false);
  const [transferForm, setTransferForm] = React.useState({ effectiveDate: "", fromSeatId: "", reason: "", toSeatId: "" });
  const [isTransferring, setIsTransferring] = React.useState(false);
  const [transferError, setTransferError] = React.useState<string | null>(null);
  const [resignationForm, setResignationForm] = React.useState<ResignationFormState>(emptyResignationForm);
  const [isDeclineOfferOpen, setIsDeclineOfferOpen] = React.useState(false);
  const [decliningEmployee, setDecliningEmployee] = React.useState<EmployeeDirectoryRow | null>(null);
  const [declineOfferForm, setDeclineOfferForm] = React.useState<DeclineOfferFormState>(emptyDeclineOfferForm);
  const [isDecliningOffer, setIsDecliningOffer] = React.useState(false);
  const [declineOfferError, setDeclineOfferError] = React.useState<string | null>(null);
  const templateInputRef = React.useRef<HTMLInputElement | null>(null);

  const employees = React.useMemo(() => data?.employees ?? [], [data?.employees]);
  const missingRecordEmployees = React.useMemo(
    () => employees.filter(hasMissingEmployeeRecordData),
    [employees],
  );
  const tabEmployees = React.useMemo(
    () => (directoryTab === "missing" ? missingRecordEmployees : employees),
    [directoryTab, employees, missingRecordEmployees],
  );
  const lookups = React.useMemo(
    () =>
      data?.lookups ?? {
        areas: [],
        departments: [],
        lines: [],
        managers: [],
        medicalRepVacancies: [],
        positions: [],
        statuses: [],
        teams: [],
        workforceVacancies: [],
      },
    [data?.lookups],
  );

  const selectedPositionTitle = React.useMemo(() => {
    return lookups.positions.find((position) => position.value === form.positionId)?.label ?? "";
  }, [lookups.positions, form.positionId]);

  const openWorkforceVacancies = React.useMemo(
    () => lookups.workforceVacancies?.length ? lookups.workforceVacancies : (lookups.medicalRepVacancies ?? []),
    [lookups.medicalRepVacancies, lookups.workforceVacancies],
  );

  const salesDepartmentId = React.useMemo(() => {
    return lookups.departments.find((department) => normalizeForMatch(department.label) === "sales")?.value ?? "";
  }, [lookups.departments]);

  const selectedPositionRequiresVacancy = React.useMemo(() => {
    return Boolean(form.positionId || form.jobTitle || selectedPositionTitle);
  }, [form.jobTitle, form.positionId, selectedPositionTitle]);

  const filteredWorkforceVacancies = React.useMemo(() => {
    const selectedTitle = normalizeForMatch(selectedPositionTitle || form.jobTitle);

    return openWorkforceVacancies.filter((vacancy) => {
      const positionMatches =
        !form.positionId ||
        String(vacancy.positionId) === String(form.positionId) ||
        normalizeForMatch(vacancy.positionTitle) === selectedTitle ||
        normalizeForMatch(vacancy.jobTitle) === selectedTitle;
      const lineMatches = !form.lineId || String(vacancy.lineId) === String(form.lineId);

      return positionMatches && lineMatches;
    });
  }, [form.jobTitle, form.lineId, form.positionId, openWorkforceVacancies, selectedPositionTitle]);

  // Every row in the picker repeats the position, which is already chosen two fields above it --
  // and that repetition is what pushed the option panel into a sideways scroll (708px of row in a
  // 491px panel, measured 2026-09-09). It is only redundant while the rows AGREE, though: with a
  // Title typed and no Job Position picked, filteredWorkforceVacancies matches every open vacancy
  // on the line, and then the position is the half that tells the rows apart. So ask the rows.
  const vacancyPositionsAgree = React.useMemo(() => {
    const titles = new Set(
      filteredWorkforceVacancies
        .map((vacancy) => normalizeForMatch(vacancy.positionTitle || vacancy.jobTitle))
        .filter(Boolean),
    );
    return titles.size <= 1;
  }, [filteredWorkforceVacancies]);

  // A MANAGER vacancy carries the area its leaver personally sat in, one arbitrary area out of the
  // whole district that seat runs -- so leading with it names the wrong thing, which is how the
  // Alex-BHR-KFS district read as absent on 2026-09-09. Lead with the district for those rows and
  // keep the area in brackets, since the area is what the new hire own record will carry. A REP
  // vacancy is the opposite: the area IS the job. Ask the rows rather than the chosen position, so
  // a mixed list never puts a rep row into district-first order.
  const vacancyRowsAreManagerSeats = React.useMemo(() => {
    if (filteredWorkforceVacancies.length === 0) return false;
    return filteredWorkforceVacancies.every((vacancy) =>
      isManagerPositionTitle(vacancy.positionTitle || vacancy.jobTitle),
    );
  }, [filteredWorkforceVacancies]);

  const filteredWorkforceLines = React.useMemo(() => {
    if (!selectedPositionRequiresVacancy) return lookups.lines;

    const vacancyLines = Array.from(
      new Map(
        filteredWorkforceVacancies
          .filter((vacancy) => vacancy.lineId !== null)
          .map((vacancy) => [
            String(vacancy.lineId),
            {
              label: vacancy.lineName ?? `Line ${vacancy.lineId}`,
              value: String(vacancy.lineId),
            },
          ]),
      ).values(),
    ).sort((a, b) => a.label.localeCompare(b.label));

    return vacancyLines.length ? vacancyLines : lookups.lines;
  }, [filteredWorkforceVacancies, lookups.lines, selectedPositionRequiresVacancy]);

  const filteredTeamOptions = React.useMemo(() => {
    return (lookups.teams ?? []).filter(
      (team) => !form.areaId || !team.areaId || String(team.areaId) === form.areaId,
    );
  }, [form.areaId, lookups.teams]);

  const regionOptions = React.useMemo(() => {
    return Array.from(
      new Set(employees.map((employee) => employee.regionName).filter(Boolean)),
    )
      .sort((a, b) => String(a).localeCompare(String(b)))
      .map((region) => ({ label: String(region), value: String(region) }));
  }, [employees]);

  const loadEmployees = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/employees", { cache: "no-store" });
      const payload = (await response.json()) as EmployeeDirectoryData & {
        error?: string;
        message?: string;
      };

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "employee_load_failed");
        return;
      }

      setData(payload);
    } catch {
      setError("Unable to load employees.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const filteredEmployees = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return tabEmployees.filter((employee) => {
      const searchable = [
        employee.hrId,
        employee.fullName,
        employee.nickname,
        employee.nameAr,
        employee.workEmail,
        employee.mobileNumber,
        employee.jobTitle,
        employee.positionTitle,
        employee.departmentName,
        employee.lineName,
        employee.areaName,
        employee.managerName,
        employee.managerHrId,
        employee.crmId,
        employee.crmUsername,
        employee.regionName,
        employee.salaryPaymentMode === "two_parts" ? "two parts" : "one part",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (!departmentFilter || String(employee.departmentId ?? "") === departmentFilter) &&
        (!lineFilter || String(employee.lineId ?? "") === lineFilter) &&
        (!areaFilter || String(employee.areaId ?? "") === areaFilter) &&
        (!positionFilter || String(employee.positionId ?? "") === positionFilter) &&
        (!regionFilter || employee.regionName === regionFilter) &&
        (!hasBankAccountFilter || employee.hasBankAccount === hasBankAccountFilter) &&
        // `hasCv` is a real boolean, not the "yes"/"no" string the bank-account column stores, so
        // it is compared against the chosen value rather than matched to it.
        (!cvFilter || employee.hasCv === (cvFilter === "yes")) &&
        (!medicalInsuranceStatusFilter ||
          employee.medicalInsuranceStatus === medicalInsuranceStatusFilter) &&
        (!socialInsuranceStatusFilter ||
          employee.socialInsuranceStatus === socialInsuranceStatusFilter) &&
        (!salaryPaymentModeFilter ||
          employee.salaryPaymentMode === salaryPaymentModeFilter)
      );
    });
  }, [
    areaFilter,
    cvFilter,
    departmentFilter,
    hasBankAccountFilter,
    lineFilter,
    medicalInsuranceStatusFilter,
    positionFilter,
    query,
    regionFilter,
    salaryPaymentModeFilter,
    socialInsuranceStatusFilter,
    tabEmployees,
  ]);
  const hasActiveFilters = Boolean(
    areaFilter ||
      cvFilter ||
      departmentFilter ||
      hasBankAccountFilter ||
      lineFilter ||
      medicalInsuranceStatusFilter ||
      positionFilter ||
      query ||
      regionFilter ||
      salaryPaymentModeFilter ||
      socialInsuranceStatusFilter,
  );
  const activeFilterCount = [
    areaFilter,
    cvFilter,
    departmentFilter,
    hasBankAccountFilter,
    lineFilter,
    medicalInsuranceStatusFilter,
    positionFilter,
    query,
    regionFilter,
    salaryPaymentModeFilter,
    socialInsuranceStatusFilter,
  ].filter(Boolean).length;
  const canSelectPayrollEligibility =
    form.employmentStatus === "active" || form.employmentStatus === "on_leave";

  function updateForm(key: keyof EmployeeFormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  // The national ID states the gender, the date of birth and the governorate: typing it fills the
  // blanks (and what the previous reading of the ID placed), and never overwrites what HR typed.
  function updateNationalId(value: string) {
    setForm((current) => applyNationalIdRead(current, value));
  }

  const idNotes = React.useMemo(() => {
    const byField = new Map<NationalIdDerivedField, NationalIdNote>();
    for (const note of nationalIdNotes(form)) byField.set(note.field, note);
    return byField;
  }, [form]);

  function adoptIdNote(note: NationalIdNote) {
    setForm((current) => ({ ...current, [note.field]: note.value }));
  }

  /** The net salary and the job title drive the whole salary block. */
  // The casing correction to OFFER for a hand-typed title, or null to stay quiet. Suggestion only:
  // the person's typing stands unless they take it. `suggestOrgTitleCasing` returns null for
  // anything outside this company's org vocabulary, so "QA/QC Supervisor" and "eCommerce Manager"
  // never raise a hint that would make them worse.
  const jobTitleSuggestion = React.useMemo(
    () => suggestOrgTitleCasing(form.jobTitle),
    [form.jobTitle],
  );

  function updateSalaryDriver(key: "netSalary" | "jobTitle", value: string) {
    // The salary-blind seat edits the title as a plain field: no salary is derived from it.
    setForm((current) =>
      salaryBlind
        ? { ...current, [key]: value }
        : withSalaryAutofill({ ...current, [key]: value }, salaryOverridesRef.current),
    );
  }

  /**
   * A derived box edited by hand: the owner's number wins from here on, and
   * emptying it hands the box back to auto-fill.
   */
  function updateSalaryField(key: SalaryAutofillKey, value: string) {
    // Unreachable for the salary-blind seat (no money box renders), and refused if it ever were.
    if (salaryBlind) return;
    const pinned = value.trim().length > 0;
    if (pinned) salaryOverridesRef.current.add(key);
    else salaryOverridesRef.current.delete(key);

    setForm((current) => {
      const next = { ...current, [key]: value };
      // Allowances feed the base, so they cascade; so does clearing any box.
      return pinned && !SALARY_AUTOFILL_INPUT_KEYS.has(key)
        ? next
        : withSalaryAutofill(next, salaryOverridesRef.current);
    });
  }

  function addSalaryDetailRow() {
    setForm((current) => ({
      ...current,
      salaryDetails: [...current.salaryDetails, createSalaryDetailFormRow()],
    }));
  }

  function removeSalaryDetailRow(id: string) {
    setForm((current) => ({
      ...current,
      salaryDetails: current.salaryDetails.filter((detail) => detail.id !== id),
    }));
  }

  function updateSalaryDetailRow(
    id: string,
    key: keyof EmployeeSalaryDetailFormRow,
    value: string,
  ) {
    const nextValue =
      key === "category"
        ? (value as EmployeeSalaryDetailCategory)
        : key === "valueType"
          ? (value as EmployeeSalaryDetailValueType)
          : value;

    setForm((current) => ({
      ...current,
      salaryDetails: current.salaryDetails.map((detail) =>
        detail.id === id
          ? {
              ...detail,
              [key]: nextValue,
            }
          : detail,
      ),
    }));
  }

  async function generateEmployeeId(lineId: string, forceCreate = false) {
    try {
      const params = lineId ? `?lineId=${encodeURIComponent(lineId)}` : "";
      const response = await fetch(`/api/employees/next-hr-id${params}`, { cache: "no-store" });
      const payload = (await response.json()) as {
        error?: string;
        hrId?: string;
        message?: string;
      };

      if (!response.ok || !payload.hrId) {
        setError(payload.message ?? "Unable to generate Employee ID.");
        return;
      }

      const generatedHrId = payload.hrId;
      setAutoGeneratedHrId(generatedHrId);
      setForm((current) => {
        if ((!forceCreate && editingHrId) || (current.hrId && current.hrId !== autoGeneratedHrId)) {
          return current;
        }

        return { ...current, hrId: generatedHrId };
      });
    } catch {
      setError("Unable to generate Employee ID.");
    }
  }

  function updateLine(value: string) {
    setForm((current) => ({
      ...current,
      areaId: "",
      lineId: value,
      managerHrId: "",
      teamId: "",
    }));

    if (!editingHrId) {
      void generateEmployeeId(value);
    }
  }

  function applyVacancySelection(areaId: string) {
    const vacancy = filteredWorkforceVacancies.find(
      (item) => String(item.areaId) === String(areaId),
    );

    if (!vacancy) {
      updateForm("areaId", areaId);
      return;
    }

    setForm((prev) => ({
      ...prev,
      areaId,
      departmentId: String(vacancy.departmentId ?? prev.departmentId),
      jobTitle: vacancy.positionTitle || vacancy.jobTitle || prev.jobTitle,
      lineId: String(vacancy.lineId ?? prev.lineId),
      managerHrId: vacancy.managerHrId ?? prev.managerHrId,
      positionId: String(vacancy.positionId ?? prev.positionId),
      regionName: vacancy.regionName ?? prev.regionName,
      teamId: "",
    }));
  }

  function validateEmployeeForm() {
    // None for the salary-blind seat: her save carries no money, so there is nothing to check and a
    // message naming a salary box she cannot see would only confuse.
    const numericFields: Array<[keyof EmployeeFormState, string]> = salaryBlind
      ? []
      : [
        ["basicSalary", "Basic Salary"],
        ["baseSalary", "Base Salary"],
        ["grossSalary", "Gross Salary"],
        ["netSalary", "Net Salary"],
        ["fuelAllowance", "Fuel Allowance"],
        ["extraCostOfLiving", "Extra Cost of Living"],
        ["medicalInsurance", "Medical Insurance"],
        ["socialInsurance", "Social Insurance"],
        ["taxes", "Taxes"],
      ];

    if (!form.hrId.trim()) return "Employee ID is required.";
    if (!form.fullName.trim()) return "Full Name is required.";
    if (form.managerHrId && form.managerHrId.trim().toUpperCase() === form.hrId.trim().toUpperCase()) {
      return "Direct Manager cannot be the same employee.";
    }
    if (form.workEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.workEmail)) {
      return "Work email format is invalid.";
    }

    for (const [key, label] of numericFields) {
      const value = (form[key] as string).trim();
      if (value && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
        return `${label} must be a valid positive number.`;
      }
    }

    const totalExperience = form.totalExperienceYears.trim();
    if (totalExperience && !(Number(totalExperience) >= 0 && Number(totalExperience) <= totalExperienceMaxYears)) {
      return `Total years of experience must be a number from 0 to ${totalExperienceMaxYears}, for example 2 or 0.5.`;
    }

    return null;
  }

  function clearFilters() {
    setAreaFilter("");
    setCvFilter("");
    setDepartmentFilter("");
    setHasBankAccountFilter("");
    setLineFilter("");
    setMedicalInsuranceStatusFilter("");
    setPositionFilter("");
    setQuery("");
    setRegionFilter("");
    setSalaryPaymentModeFilter("");
    setSocialInsuranceStatusFilter("");
  }

  function startCreate() {
    setEditingHrId(null);
    setOfferLinkId(null);
    setVacancySeatLabel(null);
    if (!canCreate) {
      setError(ADD_EMPLOYEE_NOT_IN_SEAT);
      return;
    }
    clearSeatCandidatePicker();
    salaryOverridesRef.current = new Set();
    setForm(emptyForm);
    setAutoGeneratedHrId(null);
    setNotice(null);
    setIsFormOpen(true);
    void generateEmployeeId("", true);
  }

  /**
   * Arriving here from a recruitment application (?fromApplication=<id>): fetch what the CV and
   * the offer already say and open Add Employee pre-filled, instead of making someone retype a
   * candidate into a form standing right next to their record.
   *
   * The employee is still created HERE, by the real form. Recruitment does not know a salary
   * breakdown, a bank account, an insurance number or a contract type, and a half-filled employee
   * is one that payroll then runs on.
   */
  React.useEffect(() => {
    if (!hireApplicationId) return;
    if (appliedHireDraftRef.current === hireApplicationId) return;
    appliedHireDraftRef.current = hireApplicationId;

    let cancelled = false;
    // Scheduled rather than run inline: react-hooks/set-state-in-effect is an ERROR in this repo,
    // so every setState below has to sit inside the callback.
    const timer = setTimeout(async () => {
      // Every arrival below opens ADD Employee, so a viewer who may not add one is told so instead.
      if (!canCreate) {
        setError(ADD_EMPLOYEE_NOT_IN_SEAT);
        return;
      }
      try {
        const response = await fetch(
          `/api/recruitment/applications/${encodeURIComponent(hireApplicationId)}/hire-draft`,
          { cache: "no-store" },
        );
        const payload = (await response.json().catch(() => ({}))) as {
          draft?: Partial<EmployeeFormState>;
          message?: string;
        };
        if (cancelled) return;
        if (!response.ok || !payload.draft) {
          setError(payload.message ?? "Could not load the candidate's details — fill the form in by hand.");
          return;
        }
        setEditingHrId(null);
        setOfferLinkId(null);
        setAutoGeneratedHrId(null);
        setNotice(null);
        salaryOverridesRef.current = new Set();
        setForm({ ...emptyForm, ...payload.draft });
        setIsFormOpen(true);
        void generateEmployeeId(payload.draft.lineId ?? "", true);
      } catch {
        if (!cancelled) {
          setError("Could not load the candidate's details — fill the form in by hand.");
        }
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // generateEmployeeId is a stable function declaration in this component body, and re-running
    // this on anything but a new application id would reopen a form the user just closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hireApplicationId]);

  /**
   * Arriving here from an ACCEPTED job offer (?fromOffer=<id>): open Add Employee with the letter's
   * own facts in it — the candidate's name, the job title, the agreed monthly package, the first
   * working day — and with the open seat the offer was written against already chosen.
   *
   * ── Why this is a second effect and not a branch of the one above ──
   * They read different endpoints, under different grants, and fail differently. Folding them
   * together would mean one sentence for two failures and one shape for two sources.
   *
   * ── The CV now arrives through this door too, when there is one ──
   * A letter itself knows no national id, date of birth, address or university, and never will.
   * But the candidate record POINTS AT the letter, so the route reads that pointer backwards and
   * lays the CV underneath — the letter's own facts always win. It is `null` for the nine of
   * production's 27 letters issued to people who never entered the ATS, and this form then opens
   * exactly as it did before. `carriedFromCv` names what actually came across, so the notice can
   * say it instead of implying a full form.
   *
   * Everything neither the letter nor the CV can know — the salary breakdown, the bank account, the
   * insurance numbers, the contract type — is still typed here, and the record is still written by
   * this form. `seatTaken` is the one thing worth saying out loud: the seat named on the letter was
   * filled by somebody else while it was out, so the picker below is blank on purpose rather than by
   * accident.
   */
  React.useEffect(() => {
    if (!hireOfferId) return;
    if (appliedOfferDraftRef.current === hireOfferId) return;
    appliedOfferDraftRef.current = hireOfferId;

    let cancelled = false;
    // Scheduled, not inline, for the same reason as the effect above: react-hooks/set-state-in-effect
    // is an ERROR in this repo.
    const timer = setTimeout(async () => {
      if (!canCreate) {
        setError(ADD_EMPLOYEE_NOT_IN_SEAT);
        return;
      }
      try {
        const response = await fetch(`/api/offers/${encodeURIComponent(hireOfferId)}/hire-draft`, {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => ({}))) as {
          candidateName?: string;
          carriedFromCv?: string[];
          draft?: Partial<EmployeeFormState>;
          message?: string;
          reference?: string;
          seat?: { id: number; label: string } | null;
          seatTaken?: boolean;
        };
        if (cancelled) return;
        if (!response.ok || !payload.draft) {
          setError(payload.message ?? "Could not load this offer's details — fill the form in by hand.");
          return;
        }
        setEditingHrId(null);
        setAutoGeneratedHrId(null);
        salaryOverridesRef.current = new Set();
        // Run the form's OWN salary chain over the prefill, exactly as typing the net by hand
        // would. The offer's total monthly package is the NET (measured across five hires whose
        // letters and records both exist), and `deriveSalaryFromNet` is this system's single
        // authority on what that implies — base, basic, cost of living, fuel, the insurance wage,
        // social insurance, taxes and gross all fall out of it. Nothing here computes any of them:
        // "grab as much as it can" means handing the one agreed number to the existing chain, not
        // opening a second opinion on payroll's arithmetic. An empty override set, because a form
        // that has just been filled from a letter has nothing the owner has typed into yet, and
        // every box stays editable afterwards.
        // Held, rather than passed straight to setForm, so the notice below can report what this
        // form ACTUALLY holds instead of what the response carried. The two should never differ —
        // but on 2026-09-29 the owner reported the salary boxes blank on a prefill whose notice had
        // appeared, and the notice appearing proves this very line ran. Everything from the
        // database to here was verified correct that evening and the figure still was not on his
        // screen, so the one thing missing was a statement of what landed in the state. A notice
        // that names the net and a box that is empty is a rendering fault and nothing else; a
        // notice that says no salary is a data fault. Before this, the two were indistinguishable.
        const filled = withSalaryAutofill({ ...emptyForm, ...payload.draft }, new Set());
        setForm(filled);
        setIsFormOpen(true);
        setOfferLinkId(hireOfferId);

        const opening = `Filled in from offer ${payload.reference ?? ""} for ${payload.candidateName ?? "this candidate"}.`.trim();
        const seatSentence = payload.seatTaken
          ? "The seat that offer named has since been filled by somebody else — choose the seat again below."
          : payload.seat
            ? `Seat: ${payload.seat.label}.`
            : "No seat was chosen on the offer — choose one below.";
        // Read off `filled`, never off the draft: this sentence exists to describe the form.
        const netFilled = Number(filled.netSalary);
        const salarySentence =
          Number.isFinite(netFilled) && netFilled > 0
            ? `Net salary ${netFilled.toLocaleString("en-US")} — base, basic, allowances, insurance and gross are derived from it.`
            : "The offer carried no salary, so every salary box is blank — type the net salary yourself.";
        // What the CV added, named. Silent when there was no candidate behind the letter or their
        // record was bare: a sentence about a CV nobody read would be the worst of both, telling
        // somebody the personal boxes are filled when they are the ones still to type.
        const carried = payload.carriedFromCv ?? [];
        const cvSentence =
          carried.length > 0 ? `From their CV: ${carried.join(", ")} — check each one before saving.` : "";
        setNotice([opening, seatSentence, salarySentence, cvSentence].filter(Boolean).join(" "));
        void generateEmployeeId(payload.draft.lineId ?? "", true);
      } catch {
        if (!cancelled) {
          setError("Could not load this offer's details — fill the form in by hand.");
        }
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Same reasoning as the effect above: re-running on anything but a new offer id would reopen a
    // form somebody just closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hireOfferId]);

  /**
   * Who could fill the seat that was just pressed. Swallows every failure into an empty list on
   * purpose: this is an offer, not a requirement, and a viewer without recruitment:read must get
   * the form exactly as it was rather than an error about a door they cannot open.
   */
  async function loadSeatHireCandidates(seat: {
    areaId: string;
    lineId: string;
    positionId: string;
  }) {
    try {
      const params = new URLSearchParams();
      if (seat.lineId) params.set("lineId", seat.lineId);
      if (seat.areaId) params.set("areaId", seat.areaId);
      if (seat.positionId) params.set("positionId", seat.positionId);
      const response = await fetch(
        `/api/recruitment/applications/hireable?${params.toString()}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => ({}))) as {
        candidates?: SeatHireCandidate[];
      };
      setSeatHireCandidates(payload.candidates ?? []);
    } catch {
      // Deliberately silent — see the doc comment.
    }
  }

  /**
   * Arriving here from an OPEN SEAT on the organogram (?hireVacancy=1&…): open Add Employee
   * with the seat's line, area, department, position, manager and region already in the boxes.
   *
   * No round-trip — unlike the recruitment draft above, every value came across in the URL,
   * because the organogram row on the other end already held all of it. They are defaults the
   * person filling the form can see and change, and the SEAT itself is still resolved
   * server-side by the vacancy-autofill chain on the employees insert; nothing here binds a
   * person to a seat.
   */
  React.useEffect(() => {
    if (!vacancySeatDraft) return;
    const seatKey = vacancyHireSeatKey(vacancySeatDraft);
    if (appliedVacancySeatRef.current === seatKey) return;
    appliedVacancySeatRef.current = seatKey;

    // Scheduled rather than run inline for the same reason as the draft effect above:
    // react-hooks/set-state-in-effect is an ERROR in this repo.
    const timer = setTimeout(() => {
      if (!canCreate) {
        setError(ADD_EMPLOYEE_NOT_IN_SEAT);
        return;
      }
      setEditingHrId(null);
      setOfferLinkId(null);
      setAutoGeneratedHrId(null);
      setNotice(null);
      setError(null);
      salaryOverridesRef.current = new Set();
      setForm({
        ...emptyForm,
        areaId: vacancySeatDraft.areaId,
        departmentId: vacancySeatDraft.departmentId,
        jobTitle: vacancySeatDraft.jobTitle,
        lineId: vacancySeatDraft.lineId,
        managerHrId: vacancySeatDraft.managerHrId,
        positionId: vacancySeatDraft.positionId,
        regionName: vacancySeatDraft.regionName,
      });
      setVacancySeatLabel(vacancySeatDraft.seatLabel || null);
      setIsFormOpen(true);
      void generateEmployeeId(vacancySeatDraft.lineId, true);
      void loadSeatHireCandidates(vacancySeatDraft);
    }, 0);

    return () => clearTimeout(timer);
    // generateEmployeeId is a stable function declaration in this component body, and the ref
    // guard above already makes this apply once per seat — depending on more would reopen a
    // form that was just closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vacancySeatDraft]);

  /**
   * Arriving here from "Mark as hired" in the recruitment workspace (?fromCandidate=<id>): lay the
   * candidate's identity into the form the SEAT effect above just opened.
   *
   * DECLARED AFTER THE SEAT EFFECT, AND MERGED, NEVER REPLACED. The seat effect resets the form to the
   * seat on its own timer; this one runs after it and only fills the person's boxes (`pickSeatCandidate`'s
   * identity list — no work email, no salary, no seat), so neither half can wipe the other. The draft
   * is built from `cv-hire-facts.ts` on the server, the one mapping from a CV to these boxes.
   */
  React.useEffect(() => {
    if (!hireCandidateId) return;
    if (appliedCandidateDraftRef.current === hireCandidateId) return;
    appliedCandidateDraftRef.current = hireCandidateId;

    let cancelled = false;
    // Scheduled, not inline: react-hooks/set-state-in-effect is an ERROR in this repo.
    const timer = setTimeout(async () => {
      if (!canCreate) {
        setError(ADD_EMPLOYEE_NOT_IN_SEAT);
        return;
      }
      try {
        const response = await fetch(
          `/api/recruitment/candidates/${encodeURIComponent(hireCandidateId)}/hire-draft`,
          { cache: "no-store" },
        );
        const payload = (await response.json().catch(() => ({}))) as {
          candidateName?: string;
          carriedFromCv?: string[];
          draft?: Partial<EmployeeFormState>;
          message?: string;
        };
        if (cancelled) return;
        if (!response.ok || !payload.draft) {
          setError(payload.message ?? "Could not load the candidate's details — fill the form in by hand.");
          return;
        }
        const draft = payload.draft;
        setForm((current) => ({
          ...current,
          birthDate: draft.birthDate || current.birthDate,
          birthPlace: draft.birthPlace || current.birthPlace,
          education: draft.education || current.education,
          fullName: draft.fullName || current.fullName,
          gender: draft.gender || current.gender,
          mobileNumber: draft.mobileNumber || current.mobileNumber,
          nationalId: draft.nationalId || current.nationalId,
          qualification: draft.qualification || current.qualification,
          residenceAddress: draft.residenceAddress || current.residenceAddress,
          residenceCity: draft.residenceCity || current.residenceCity,
          seniorYear: draft.seniorYear || current.seniorYear,
          universityName: draft.universityName || current.universityName,
        }));
        setCandidateLinkId(hireCandidateId);
        setIsFormOpen(true);
        // No seat came with the link (it always does from the workspace, but a hand-typed URL may
        // not): give the form its new Employee ID the way Add Employee would.
        if (!vacancySeatDraft) {
          setEditingHrId(null);
          setAutoGeneratedHrId(null);
          void generateEmployeeId("", true);
        }
        const carried = payload.carriedFromCv ?? [];
        const cvSentence =
          carried.length > 0 ? ` From their CV: ${carried.join(", ")} — check each one before saving.` : "";
        setNotice(`Hiring ${payload.candidateName ?? "this candidate"} from Recruitment.${cvSentence}`);
      } catch {
        if (!cancelled) {
          setError("Could not load the candidate's details — fill the form in by hand.");
        }
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Same reasoning as the effects above: the ref guard applies it once per candidate, and
    // re-running on anything else would reopen a form somebody just closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hireCandidateId]);

  /**
   * Arriving here from a PERSON's tile on the organogram (?edit=<hr id> or ?resign=<hr id>): open
   * that employee's edit form, or their resignation dialog, on the real screens below — the chart
   * holds neither form.
   *
   * Only the HR id travels. The person is looked up in the directory this page already loaded for
   * the viewer, so somebody outside the viewer's scope finds no row and is told so, rather than
   * the id opening anything. A viewer without `employees:update` gets a sentence instead of a form
   * the Save and Resign endpoints would refuse anyway.
   */
  const masterArrival = React.useMemo(
    () => readEmployeeMasterArrival((key) => searchParams.get(key)),
    [searchParams],
  );
  const appliedMasterArrivalRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!masterArrival) return;
    const arrivalKey = employeeMasterArrivalKey(masterArrival);
    if (appliedMasterArrivalRef.current === arrivalKey) return;
    appliedMasterArrivalRef.current = arrivalKey;

    // Scheduled rather than run inline: react-hooks/set-state-in-effect is an ERROR in this repo.
    const timer = setTimeout(() => {
      if (!canEdit) {
        setError("You can view the employee master but not change it, so Edit and Resign are not available to you.");
        return;
      }
      const person = employees.find((employee) => hrIdsMatch(employee.hrId, masterArrival.hrId));
      if (!person) {
        setError(
          `${masterArrival.hrId} is not in the employee directory you can open, so there is nothing to ${
            masterArrival.action === "edit" ? "edit" : "resign"
          }.`,
        );
        return;
      }
      if (masterArrival.action === "edit") {
        startEdit(person);
      } else if (!canStartResignation) {
        // The organogram's Resign link, followed by a viewer who may edit but not record a departure.
        setError("Recording a resignation is not part of your seat, so the resignation form is not available to you.");
      } else {
        startResignation(person);
      }
    }, 0);

    return () => clearTimeout(timer);
    // startEdit and startResignation are function declarations in this component body, and the ref
    // guard above already makes this apply once per arrival — depending on more would reopen a
    // form that was just closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterArrival]);

  function clearSeatCandidatePicker() {
    setCandidateLinkId(null);
    setSeatHireCandidates([]);
    setPickedApplicationId(null);
    setPickedCandidateName(null);
    setOfferTitleConflict(null);
  }

  /**
   * Put a recruitment candidate into the form the seat already filled.
   *
   * IDENTITY ONLY. The draft carries the requisition's own line, area, department, position,
   * team and manager too, and every one of those is dropped here: the SEAT is what is being
   * filled, and a requisition opened months ago against a neighbouring area must not silently
   * move this hire. The candidate brings who they are and what they were offered; the seat
   * keeps where they sit.
   *
   * WHICH MEANS THE EDUCATION AND BIRTH BOXES TRAVEL. They are identity — a university and a
   * graduation year belong to the person, not to the chair — and this list is spelled out field by
   * field rather than spread, so each new one has to be added here on purpose. Every field named
   * below is `CvHireFacts` plus the four the offer states; if that set grows again,
   * `cv-hire-facts.ts` is the one place it is defined and this is the one place it is let through.
   */
  async function pickSeatCandidate(applicationId: string) {
    if (!applicationId) {
      setPickedApplicationId(null);
      setPickedCandidateName(null);
      setOfferTitleConflict(null);
      return;
    }

    setIsPickingCandidate(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/recruitment/applications/${encodeURIComponent(applicationId)}/hire-draft`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        candidateName?: string;
        draft?: Partial<EmployeeFormState>;
        message?: string;
      };
      if (!response.ok || !payload.draft) {
        setError(payload.message ?? "Could not load that candidate — fill the form in by hand.");
        return;
      }

      const draft = payload.draft;
      setForm((current) => ({
        ...current,
        birthDate: draft.birthDate || current.birthDate,
        birthPlace: draft.birthPlace || current.birthPlace,
        education: draft.education || current.education,
        fullName: draft.fullName || current.fullName,
        gender: draft.gender || current.gender,
        grossSalary: draft.grossSalary || current.grossSalary,
        hireDate: draft.hireDate || current.hireDate,
        mobileNumber: draft.mobileNumber || current.mobileNumber,
        nationalId: draft.nationalId || current.nationalId,
        qualification: draft.qualification || current.qualification,
        residenceAddress: draft.residenceAddress || current.residenceAddress,
        residenceCity: draft.residenceCity || current.residenceCity,
        seniorYear: draft.seniorYear || current.seniorYear,
        universityName: draft.universityName || current.universityName,
        workEmail: draft.workEmail || current.workEmail,
      }));
      setPickedApplicationId(applicationId);
      setPickedCandidateName(payload.candidateName ?? null);
      // A different person was picked for the seat: the workspace candidate this form opened for is
      // no longer the one being hired, so the save must not mark them hired.
      setCandidateLinkId(null);

      const offerTitle = (draft.jobTitle ?? "").trim();
      const seatTitle = form.jobTitle.trim();
      setOfferTitleConflict(
        offerTitle && seatTitle && offerTitle.toLowerCase() !== seatTitle.toLowerCase()
          ? `The offer says "${offerTitle}"; this seat is "${seatTitle}". The seat's title is kept.`
          : null,
      );
    } catch {
      setError("Could not load that candidate — fill the form in by hand.");
    } finally {
      setIsPickingCandidate(false);
    }
  }

  function startEdit(employee: EmployeeDirectoryRow) {
    setEditingHrId(employee.hrId);
    setOfferLinkId(null);
    setVacancySeatLabel(null);
    clearSeatCandidatePicker();
    salaryOverridesRef.current = new Set();
    // Opening a record that has a readable ID but a blank gender, birth date or birth place fills
    // those boxes from the ID — visibly, and nothing is saved until HR saves.
    const stored = employeeToForm(employee);
    setForm(applyNationalIdRead(stored, stored.nationalId));
    setAutoGeneratedHrId(null);
    setNotice(null);
    setIsFormOpen(true);
  }

  function closeForm() {
    setIsFormOpen(false);
    setOfferLinkId(null);
    clearSeatCandidatePicker();
    // Dropped on close, so re-opening the form for the NEXT hire cannot silently carry the
    // previous person's CV across. The staged object itself is swept a day later
    // (purgeStaleStagedCvs) rather than deleted here — a discarded form is often re-opened.
    setStagedCv(null);
  }

  function startResignation(employee: EmployeeDirectoryRow) {
    setResigningEmployee(employee);
    setResignationForm({
      ...emptyResignationForm,
      effectiveDate: new Date().toISOString().slice(0, 10),
      submittedDate: new Date().toISOString().slice(0, 10),
    });
    setNotice(null);
    setError(null);
    setResignationError(null);
    setIsResignationOpen(true);
  }

  function closeResignation() {
    setIsResignationOpen(false);
    setResigningEmployee(null);
    setResignationError(null);
  }

  function updateResignationForm(key: keyof ResignationFormState, value: string) {
    setResignationForm((current) => ({ ...current, [key]: value }));
  }

  function startDeclineOffer(employee: EmployeeDirectoryRow) {
    setDecliningEmployee(employee);
    setDeclineOfferForm({
      ...emptyDeclineOfferForm,
      lastWorkingDate: employee.hireDate ? employee.hireDate.slice(0, 10) : todayInCairo(),
    });
    setNotice(null);
    setError(null);
    setDeclineOfferError(null);
    setIsDeclineOfferOpen(true);
  }

  function closeDeclineOffer() {
    setIsDeclineOfferOpen(false);
    setDecliningEmployee(null);
    setDeclineOfferError(null);
  }

  function updateDeclineOfferForm(key: keyof DeclineOfferFormState, value: string) {
    setDeclineOfferForm((current) => ({ ...current, [key]: value }));
  }

  function startSeatTransfer(employee: EmployeeDirectoryRow) {
    setTransferEmployee(employee);
    setTransferOptions(null);
    setTransferForm({
      effectiveDate: new Date().toISOString().slice(0, 10),
      fromSeatId: "",
      reason: "",
      toSeatId: "",
    });
    setNotice(null);
    setError(null);
    setTransferError(null);
    setIsTransferOpen(true);
    setIsLoadingTransferOptions(true);

    void (async () => {
      try {
        const response = await fetch(`/api/employees/${encodeURIComponent(employee.hrId)}/seat-transfer`, {
          cache: "no-store",
        });
        const payload = await response.json();
        if (!response.ok) {
          setTransferError(payload.message ?? payload.error ?? "seat_transfer_options_failed");
          return;
        }
        setTransferOptions(payload.data as SeatTransferOptions);
      } catch {
        setTransferError("Unable to load seat options.");
      } finally {
        setIsLoadingTransferOptions(false);
      }
    })();
  }

  function closeSeatTransfer() {
    setIsTransferOpen(false);
    setTransferEmployee(null);
    setTransferOptions(null);
    setTransferError(null);
  }

  async function submitSeatTransfer() {
    if (!transferEmployee) return;
    if (!transferForm.toSeatId) {
      setTransferError("Choose the destination seat first.");
      return;
    }
    setIsTransferring(true);
    setError(null);
    setNotice(null);
    setTransferError(null);
    const otherLineSeat =
      transferOptions?.otherLineVacantSeats.find((seat) => seat.seatId === transferForm.toSeatId) ?? null;

    try {
      const response = await fetch(`/api/employees/${encodeURIComponent(transferEmployee.hrId)}/seat-transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transfer: {
            toSeatId: transferForm.toSeatId,
            effectiveDate: transferForm.effectiveDate || null,
            fromSeatId: transferForm.fromSeatId || null,
            reason: transferForm.reason || null,
            moveLine: Boolean(otherLineSeat),
          },
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setTransferError(payload.message ?? payload.error ?? "seat_transfer_failed");
        return;
      }

      const targetLabel =
        (otherLineSeat ?? transferOptions?.vacantSeats.find((seat) => seat.seatId === transferForm.toSeatId))?.label ??
        transferForm.toSeatId;
      const lineMove = payload.data?.lineMove as { toLine?: string; vacancyOpened?: string | null } | undefined;
      setNotice(
        lineMove
          ? `${transferEmployee.displayName} moved to the ${lineMove.toLine ?? otherLineSeat?.lineName ?? "new"} line on ${targetLabel}. Area, region and manager follow the new seat${lineMove.vacancyOpened ? `, and vacancy ${lineMove.vacancyOpened} is open for the seat they left` : ""}.`
          : payload.data?.mode === "seated"
            ? `${transferEmployee.displayName} is now seated on ${targetLabel}.`
            : `${transferEmployee.displayName} moved to ${targetLabel}. Area, region and manager follow the new seat.`,
      );
      closeSeatTransfer();
      await loadEmployees();
    } catch {
      setTransferError("Unable to process the seat transfer.");
    } finally {
      setIsTransferring(false);
    }
  }

  async function saveEmployee() {
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const validationError = validateEmployeeForm();
      if (validationError) {
        setError(validationError);
        return;
      }

      const response = await fetch("/api/employees", {
        body: JSON.stringify({
          // Siblings of `employee`, never fields inside it — see the POST handler for why.
          // Both are sent on a CREATE only: an edit routes through the CV manager, which writes
          // directly, and sending a stale draft id here would re-attach a file on every save.
          ...(editingHrId
            ? {}
            : {
              ...(stagedCv ? { cvDraftFileName: stagedCv.fileName, cvDraftId: stagedCv.draftId } : {}),
              // When the hire started from an application and nothing was chosen by hand, the
              // server copies the candidate's own CV across.
              ...(activeApplicationId ? { fromApplicationId: activeApplicationId } : {}),
              // The accepted letter this form was filled from, so the server can point the letter
              // (and the candidate behind it) at the employee this save creates.
              ...(offerLinkId ? { offerId: offerLinkId } : {}),
              // The workspace candidate this form was filled for: marked hired, the seat's
              // requisition closed and their CV copied, in this same save.
              ...(candidateLinkId ? { fromCandidateId: candidateLinkId } : {}),
            }),
          employee: formToPayload(form, editingHrId, { salaryBlind }),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as EmployeeSaveResponse & {
        error?: string;
        message?: string;
      };

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "employee_save_failed");
        return;
      }

      const savedEmployee = {
        hrId: form.hrId,
        lineId: form.lineId,
      };
      setData(payload);
      const accessProvisioning = payload.accessProvisioning;
      // A CV that was chosen and did NOT land has to be said at the moment of the save. HR closes
      // this dialog and does not come back, so a silent miss is discovered weeks later by the
      // person who needed the document — which is the whole failure this feature exists to remove.
      const cv = payload.cvAttachment;
      const cvNote = !cv
        ? ""
        : cv.attached
          ? ` CV filed: ${cv.fileName}${cv.source === "recruitment" ? " (copied from the candidate record)." : "."}`
          : cv.warnings.length > 0
            ? ` The CV was NOT attached — ${cv.warnings.join(" ")}`
            : "";
      const noticeText = editingHrId
        ? "Employee updated."
        : accessProvisioning && accessProvisioning.created > 0
          ? "Employee created and Users & Access account added."
          : accessProvisioning && accessProvisioning.failed > 0
            ? `Employee created. Users & Access needs review: ${accessProvisioning.results.find((result) => result.status === "failed")?.message ?? "access account was not created."}`
            : accessProvisioning && accessProvisioning.skipped > 0
              ? "Employee created. Users & Access account was not created because the employee is not active in the directory."
              : "Employee created.";
      const createdNotice = `${noticeText}${cvNote}`;

      setNotice(
        editingHrId
          ? noticeText
          : (
            <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>{createdNotice}</span>
              <span className="flex flex-wrap items-center gap-2">
                {activeApplicationId ? (
                  // The way back. Carries the HR_ID that was just generated, so the last step of a
                  // hire is a click rather than copying an id between two pages.
                  <a
                    className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-xl border border-orange-200 bg-white px-3 text-xs font-bold text-orange-700 shadow-sm transition hover:bg-orange-50"
                    href={`${pathname?.startsWith("/employee-portals") ? "/employee-portals/recruitment" : "/recruitment"}?application=${encodeURIComponent(activeApplicationId)}&hiredHrId=${encodeURIComponent(savedEmployee.hrId)}`}
                  >
                    Back to the application
                  </a>
                ) : null}
                {candidateLinkId ? (
                  <a
                    className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-none border border-orange-200 bg-white px-3 text-xs font-bold text-orange-700 shadow-sm transition hover:bg-orange-50"
                    href={workspaceCandidateHref(candidateLinkId, null, {
                      basePath: pathname?.startsWith("/employee-portals") ? "/employee-portals/recruitment" : "/recruitment",
                    })}
                  >
                    Back to the candidate
                  </a>
                ) : null}
                <a
                  className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-xl border border-emerald-200 bg-white px-3 text-xs font-bold text-emerald-700 shadow-sm transition hover:bg-emerald-50"
                  href={organogramHrefForEmployee(savedEmployee, payload)}
                >
                  View in organogram
                </a>
              </span>
            </div>
          ),
      );
      setEditingHrId(null);
      salaryOverridesRef.current = new Set();
      setForm(emptyForm);
      closeForm();
    } catch {
      setError("Unable to save employee.");
    } finally {
      setIsSaving(false);
    }
  }

  async function uploadTemplate(file: File | null) {
    if (!file) {
      return;
    }

    setIsImportingTemplate(true);
    setError(null);
    setNotice(null);
    setPendingImportFile(null);
    setPendingImportPreview(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/imports/employees/dry-run", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "template_import_failed");
        return;
      }

      setPendingImportFile(file);
      setPendingImportPreview(payload);
      setNotice(
        `Import preview ready: ${payload.rowsToInsert?.length ?? 0} to create, ${
          payload.rowsToUpdate?.length ?? 0
        } to update, ${payload.failedRows ?? 0} blocked${
          payload.failedRows ? " (blocked rows will be skipped on confirm)" : ""
        }.`,
      );
    } catch {
      setError("Unable to upload employee template.");
    } finally {
      if (templateInputRef.current) {
        templateInputRef.current.value = "";
      }

      setIsImportingTemplate(false);
    }
  }

  function cancelPendingImport() {
    setPendingImportFile(null);
    setPendingImportPreview(null);
    setNotice(null);
  }

  /**
   * The findings, as a workbook.
   *
   * Posts the SAME file back rather than the preview it already has: the preview is the browser's
   * copy of a judgement, and what someone works from has to be the server's. Re-running it costs
   * one parse and removes any chance of handing over findings that no longer match the file.
   */
  async function downloadImportFixList() {
    if (!pendingImportFile) return;

    setIsDownloadingFixList(true);
    setError(null);

    const formData = new FormData();
    formData.append("file", pendingImportFile);

    try {
      const response = await fetch("/api/imports/employees/fix-list", {
        body: formData,
        method: "POST",
      });

      if (!response.ok) {
        setError("Unable to build the list of things to fix.");
        return;
      }

      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "employee-import-what-to-fix.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Unable to build the list of things to fix.");
    } finally {
      setIsDownloadingFixList(false);
    }
  }

  async function confirmPendingImport() {
    if (!pendingImportFile) return;

    setIsImportingTemplate(true);
    setError(null);
    setNotice(null);

    const formData = new FormData();
    formData.append("file", pendingImportFile);

    try {
      const response = await fetch("/api/imports/employees/confirm", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "template_import_failed");
        return;
      }

      setPendingImportFile(null);
      setPendingImportPreview(null);
      await loadEmployees();
      setNotice(
        `Template processed: ${payload.importedEmployees ?? 0} created, ${
          payload.updatedEmployees ?? 0
        } updated, ${payload.accessUsersCreated ?? 0} access accounts added${
          payload.accessUsersFailed ? `, ${payload.accessUsersFailed} access accounts need review` : ""
        }${
          payload.blockedRows ? `, ${payload.blockedRows} row(s) skipped (fix and re-upload to apply them)` : ""
        }.`,
      );
    } catch {
      setError("Unable to confirm employee import.");
    } finally {
      setIsImportingTemplate(false);
    }
  }

  async function submitResignation() {
    if (!resigningEmployee) return;
    setIsResigning(true);
    setError(null);
    setNotice(null);
    setResignationError(null);

    try {
      const response = await fetch(`/api/employees/${encodeURIComponent(resigningEmployee.hrId)}/resign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resignation: {
            employeeHrId: resigningEmployee.hrId,
            effectiveDate: resignationForm.effectiveDate,
            employeeStatus: resignationForm.employeeStatus,
            reason: resignationForm.reason,
            submittedDate: resignationForm.submittedDate,
            workflowNotes: resignationForm.workflowNotes,
          },
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setResignationError(payload.message ?? payload.error ?? "employee_resign_failed");
        return;
      }

      setData((current) =>
        current
          ? {
              ...current,
              employees: current.employees.filter((employee) => employee.hrId !== resigningEmployee.hrId),
            }
          : current,
      );
      setNotice(`Resignation recorded for ${resigningEmployee.displayName}. Vacancy ${payload.data?.vacancyCode ?? "opened"} created and employee moved to ${resignationForm.employeeStatus}.`);
      closeResignation();
    } catch {
      setResignationError("Unable to process employee resignation.");
    } finally {
      setIsResigning(false);
    }
  }

  async function submitDeclineOffer() {
    if (!decliningEmployee) return;
    setIsDecliningOffer(true);
    setError(null);
    setNotice(null);
    setDeclineOfferError(null);

    try {
      const includeInPayroll = declineOfferForm.includeInPayroll === "yes";
      const response = await fetch(`/api/employees/${encodeURIComponent(decliningEmployee.hrId)}/decline-offer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          declineOffer: {
            employeeHrId: decliningEmployee.hrId,
            lastWorkingDate: declineOfferForm.lastWorkingDate,
            note: declineOfferForm.note,
            includeInPayroll,
          },
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setDeclineOfferError(payload.message ?? payload.error ?? "employee_decline_offer_failed");
        return;
      }

      setData((current) =>
        current
          ? {
              ...current,
              employees: current.employees.filter((employee) => employee.hrId !== decliningEmployee.hrId),
            }
          : current,
      );
      setNotice(
        `Declined offer recorded for ${decliningEmployee.displayName}. Vacancy ${payload.data?.vacancyCode ?? "opened"} created${includeInPayroll ? " and the employee was entered into this month's payroll for days worked." : "; no payroll entry was created."}`,
      );
      closeDeclineOffer();
    } catch {
      setDeclineOfferError("Unable to process the declined offer.");
    } finally {
      setIsDecliningOffer(false);
    }
  }

  return (
    <EmployeePageShell>
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-2xl border border-white/20 bg-white/10 p-1 shadow-sm backdrop-blur-sm">
              <a
                className="inline-flex h-10 items-center justify-center gap-2.5 rounded-xl px-5 text-xs font-semibold text-slate-200 transition-all hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                href="/api/employees/template"
                title="Export active employee master data"
              >
                <Download className="h-4 w-4 text-phx-accent" />
                <span className="hidden sm:inline">Export</span>
              </a>
              {/* Export stays for a read-only viewer — employees:export is a separate grant she
                  holds. Upload writes the whole directory from a sheet and is hidden without it. */}
              {canEdit ? <div className="h-5 w-px bg-white/15" /> : null}
              {canEdit ? (
              <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2.5 rounded-xl px-5 text-xs font-semibold text-slate-200 transition-all hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1">
                {isImportingTemplate ? (
                  <LoadingSpinner />
                ) : (
                  <Upload className="h-4 w-4 text-phx-accent" />
                )}
                <span className="hidden sm:inline">Upload</span>
                <input
                  accept=".xlsx"
                  className="sr-only"
                  onChange={(event) => void uploadTemplate(event.target.files?.[0] ?? null)}
                  ref={templateInputRef}
                  type="file"
                />
              </label>
              ) : null}
            </div>
            <Button
              className="h-10 gap-2 rounded-2xl border border-white/20 bg-white/10 px-4 text-xs font-semibold text-slate-100 backdrop-blur transition-all hover:border-phx-accent-line hover:bg-white/[0.16] hover:text-white focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
              disabled={isLoading}
              onClick={() => void loadEmployees()}
              variant="secondary"
            >
              {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-4 w-4" />}
              <span className="hidden lg:inline">Sync</span>
            </Button>
            {canEdit && canCreate ? (
              <Button className="h-11 gap-2 rounded-2xl bg-phx-accent px-6 text-xs font-bold text-white shadow-[0_14px_30px_rgba(249,115,22,0.3)] transition-all hover:bg-phx-accent-hover hover:shadow-[0_18px_36px_rgba(249,115,22,0.4)] focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1" onClick={startCreate}>
                <UserPlus className="h-4 w-4" />
                Add Employee
              </Button>
            ) : canEdit ? null : (
              <span className="inline-flex h-10 items-center rounded-2xl border border-white/20 bg-white/10 px-4 text-xs font-bold uppercase tracking-[0.12em] text-slate-200">
                View only
              </span>
            )}
          </div>
        }
        description=""
        eyebrow="Workforce Intelligence"
        icon={<Building2 className="h-3.5 w-3.5" />}
        title="Employee Master Data"
      />

      {error ? (
        <AdminCallout tone="danger">
            <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
            <div>
              <h2 className="text-base font-semibold text-text">
                Employee management unavailable
              </h2>
              <p className="mt-1 text-sm text-text-secondary">{error}</p>
            </div>
        </AdminCallout>
      ) : null}

      {notice ? (
        <AdminCallout tone="success">
            <Check className="h-5 w-5 text-success" />
            {notice}
        </AdminCallout>
      ) : null}

      {pendingImportPreview && pendingImportFile ? (
        <EmployeeImportReview
          employees={data?.employees ?? []}
          fileName={pendingImportFile.name}
          isConfirming={isImportingTemplate}
          isDownloading={isDownloadingFixList}
          onCancel={cancelPendingImport}
          onConfirm={() => void confirmPendingImport()}
          onDownloadFixList={() => void downloadImportFixList()}
          preview={pendingImportPreview}
        />
      ) : null}

      {data ? (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <AdminStatCard
              description="Active workforce currently in system."
              icon={<Users className="h-4 w-4" />}
              label="Total Headcount"
              tone="blue"
              value={formatNumberValue(data.summary.totalEmployees)}
            />
            <AdminStatCard
              description="Records flagged as active and available for payroll."
              icon={<UserCheck2 className="h-4 w-4" />}
              label="Active Workforce"
              tone="emerald"
              value={formatNumberValue(data.summary.activeEmployees)}
            />
            <AdminStatCard
              description="Unique operating lines represented in the directory."
              icon={<CircleAlert className="h-4 w-4" />}
              label="Lines Coverage"
              tone="violet"
              value={formatNumberValue(data.summary.uniqueLines)}
            />
            <AdminStatCard
              description="Employees missing direct manager linkage and require assignment."
              icon={<Building2 className="h-4 w-4" />}
              label="Pending Assignment"
              tone="orange"
              value={formatNumberValue(data.summary.employeesWithoutManagers)}
            />
          </section>

          <AdminTableShell
            action={
              <div className="flex items-center gap-3">
                <Badge className="bg-white text-phx-ink-2 border-phx-line shadow-sm" variant="neutral">
                  {formatNumberValue(filteredEmployees.length)} results
                </Badge>
              </div>
            }
            description="Access and manage comprehensive employee records with real-time filters."
            title="Workforce Directory"
          >
            <div className="h-1 w-full bg-gradient-to-r from-phx-accent via-[#3B82F6] to-[#8B5CF6] opacity-80" />
            <div className="border-b border-phx-line bg-white px-4 py-3">
              <div
                aria-label="Employee directory views"
                className="inline-flex flex-wrap items-center gap-1 rounded-2xl border border-phx-line bg-phx-paper p-1 shadow-sm"
                role="tablist"
              >
                {[
                  {
                    count: employees.length,
                    icon: Users,
                    label: "Employees",
                    value: "all" as const,
                  },
                  {
                    count: missingRecordEmployees.length,
                    icon: AlertCircle,
                    label: "Employees Missing Records",
                    value: "missing" as const,
                  },
                ].map((tab) => {
                  const Icon = tab.icon;
                  const isActive = directoryTab === tab.value;

                  return (
                    <button
                      aria-selected={isActive}
                      className={cn(
                        "inline-flex h-10 items-center gap-2 rounded-xl px-4 text-xs font-bold transition-all focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1",
                        isActive
                          ? "bg-white text-phx-ink shadow-sm"
                          : "text-phx-ink-soft hover:bg-white/70 hover:text-phx-ink",
                      )}
                      key={tab.value}
                      onClick={() => setDirectoryTab(tab.value)}
                      role="tab"
                      type="button"
                    >
                      <Icon className={cn("h-4 w-4", tab.value === "missing" ? "text-phx-accent" : "text-[#3B82F6]")} />
                      <span>{tab.label}</span>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-phx-2xs font-black",
                          isActive ? "bg-phx-paper-2 text-phx-ink" : "bg-white text-phx-ink-soft",
                        )}
                      >
                        {formatNumberValue(tab.count)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col gap-4 border-b border-phx-line bg-phx-paper/50 p-4">
              <div className="grid gap-4 xl:grid-cols-[1fr_auto]">
                <label className="relative">
                  <span className="sr-only">Search employees</span>
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-faint" />
                  <Input
                    className="w-full pl-11"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by name, ID, email, or manager..."
                    value={query}
                  />
                </label>
                <Button
                  className="h-12 gap-2 rounded-2xl border-phx-line bg-white px-6 text-sm font-semibold text-phx-ink-2 shadow-sm transition-all hover:bg-phx-paper focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1 disabled:opacity-40"
                  disabled={!hasActiveFilters}
                  onClick={clearFilters}
                  variant="outline"
                >
                  <X className="h-4 w-4" />
                  Reset Filters {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-9">
                <SelectField
                  label="Department"
                  onChange={setDepartmentFilter}
                  options={lookups.departments}
                  placeholder="All Departments"
                  tone="blue"
                  value={departmentFilter}
                />
                <SelectField
                  label="Business Line"
                  onChange={setLineFilter}
                  options={lookups.lines}
                  placeholder="All Lines"
                  tone="blue"
                  value={lineFilter}
                />
                <SelectField
                  label="Operating Area"
                  onChange={setAreaFilter}
                  options={lookups.areas}
                  placeholder="All Areas"
                  tone="blue"
                  value={areaFilter}
                />
                <SelectField
                  label="Job Position"
                  onChange={setPositionFilter}
                  options={lookups.positions}
                  placeholder="All Positions"
                  tone="blue"
                  value={positionFilter}
                />
                <SelectField
                  label="Region"
                  onChange={setRegionFilter}
                  options={regionOptions}
                  placeholder="All Regions"
                  tone="violet"
                  value={regionFilter}
                />
                {/* "CV on File" rather than "Has CV": the panel on the record and the organogram
                    seat popup both say "No CV on file", and one wording across the three places a
                    person meets this fact is worth more than a shorter label. */}
                <SelectField
                  label="CV on File"
                  onChange={setCvFilter}
                  options={yesNoOptions}
                  placeholder="All"
                  tone="orange"
                  value={cvFilter}
                />
                <SelectField
                  label="Has Bank Account"
                  onChange={setHasBankAccountFilter}
                  options={yesNoOptions}
                  placeholder="All"
                  tone="orange"
                  value={hasBankAccountFilter}
                />
                <SelectField
                  label="In Medical Insurance"
                  onChange={setMedicalInsuranceStatusFilter}
                  options={enrollmentStatusOptions}
                  placeholder="All"
                  tone="emerald"
                  value={medicalInsuranceStatusFilter}
                />
                <SelectField
                  label="In Social Insurance"
                  onChange={setSocialInsuranceStatusFilter}
                  options={enrollmentStatusOptions}
                  placeholder="All"
                  tone="emerald"
                  value={socialInsuranceStatusFilter}
                />
                <SelectField
                  label="Payout Mode"
                  onChange={setSalaryPaymentModeFilter}
                  options={salaryPaymentModeOptions}
                  placeholder="All Modes"
                  tone="orange"
                  value={salaryPaymentModeFilter}
                />
              </div>
            </div>

            {/* Filing a folder of CVs at once, directly under the CV on File filter that shows who
                is still missing one — find the 96, then fill them. It is a full-width block rather
                than a button in the header because the open panel is a table of file → person that
                somebody reads before pressing anything. Gated on canEdit, the same grant
                (employees:update) the per-employee CV route asserts. */}
            {canEdit ? (
              <div className="border-b border-phx-line px-4 py-3">
                <EmployeeCvBulkUpload
                  employees={employees.map((employee) => ({
                    displayName: employee.displayName,
                    fullName: employee.fullName,
                    hasCv: employee.hasCv,
                    hrId: employee.hrId,
                  }))}
                  onUploaded={loadEmployees}
                />
              </div>
            ) : null}

            {/* Mobile Card View */}
            <div className="divide-y divide-slate-100 md:hidden">
              {filteredEmployees.length === 0 ? (
                <PortalEmptyState
                  message={
                    directoryTab === "missing" && !hasActiveFilters
                      ? "No employee records are missing master data."
                      : "No employee records match your current filter criteria."
                  }
                  title="No employees found"
                />
              ) : (
                filteredEmployees.map((employee, index) => {
                  const missingFields = getMissingEmployeeRecordFields(employee);

                  return (
                    <PortalRecordCard
                      accent={missingFields.length > 0 ? "amber" : "slate"}
                      actions={
                        <>
                          <Button
                            className="h-9 flex-1 gap-1.5 rounded-xl border-phx-line text-xs font-bold text-phx-ink-2 hover:bg-phx-paper-2 hover:text-phx-ink"
                            onClick={() => setMasterDetailsEmployee(employee)}
                            variant="outline"
                          >
                            <Info className="h-3.5 w-3.5" />
                            View
                          </Button>
                          {canEdit ? (
                          <Button
                            className="h-9 flex-1 gap-1.5 rounded-xl border-phx-line text-xs font-bold text-phx-ink-2 hover:bg-phx-paper-2 hover:text-phx-ink"
                            onClick={() => startEdit(employee)}
                            variant="outline"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit
                          </Button>
                          ) : null}
                          {canEdit ? (
                          <Button
                            className="h-9 flex-1 gap-1.5 rounded-xl border-phx-line text-xs font-bold text-phx-ink-2 hover:bg-phx-paper-2 hover:text-phx-ink"
                            onClick={() => startSeatTransfer(employee)}
                            variant="outline"
                          >
                            <ArrowLeftRight className="h-3.5 w-3.5" />
                            Seat
                          </Button>
                          ) : null}
                          {canEdit && canStartResignation && isDeclineOfferEligible(employee, todayInCairo()) ? (
                          <Button
                            className="h-9 flex-1 gap-1.5 rounded-xl border-amber-200 bg-amber-50 text-xs font-bold text-amber-800 hover:bg-amber-100"
                            onClick={() => startDeclineOffer(employee)}
                            title={`Declined offer / did not join — available within ${DECLINE_OFFER_WINDOW_DAYS} days of hiring`}
                            variant="outline"
                          >
                            <UserMinus className="h-3.5 w-3.5" />
                            Declined
                          </Button>
                          ) : null}
                          {canEdit && canStartResignation ? (
                          <Button
                            className="h-9 flex-1 gap-1.5 rounded-xl border-rose-200 bg-rose-50 text-xs font-bold text-rose-700 hover:bg-rose-100"
                            onClick={() => startResignation(employee)}
                            variant="outline"
                          >
                            <UserX className="h-3.5 w-3.5" />
                            Resign
                          </Button>
                          ) : null}
                        </>
                      }
                      key={employeeRowKey(employee, index)}
                      meta={
                        <div className="flex flex-wrap items-center gap-2">
                          {employee.employmentStatus === "active" ? (
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          ) : null}
                        </div>
                      }
                      status={
                        <Badge
                          className={cn(
                            "border-none px-2.5 py-0.5 text-phx-2xs font-bold uppercase tracking-tight whitespace-nowrap",
                            employee.salaryPaymentMode === "two_parts"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-emerald-100 text-emerald-700"
                          )}
                          variant="neutral"
                        >
                          {employee.salaryPaymentMode === "two_parts" ? "2 Parts" : "1 Part"}
                        </Badge>
                      }
                      title={employee.displayName}
                    >
                      {directoryTab === "missing" && missingFields.length > 0 ? (
                        <div
                          className="mb-2 flex items-start gap-1.5 rounded-full border border-phx-warn-line bg-phx-warn-bg px-2 py-1 text-phx-2xs font-bold text-phx-warn"
                          title={missingFields.join(", ")}
                        >
                          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>{missingEmployeeRecordSummary(employee)}</span>
                        </div>
                      ) : null}
                      <PortalRecordFields
                        fields={[
                          {
                            label: "Position",
                            value: emptyText(employee.positionTitle ?? employee.jobTitle),
                          },
                          {
                            label: "Department / Line",
                            value: `${emptyText(employee.departmentName)} · ${emptyText(employee.lineName)}`,
                          },
                          {
                            label: "Hired",
                            value: employee.hireDate ? employee.hireDate.slice(0, 10) : "—",
                          },
                          {
                            label: "Manager",
                            value: employee.managerHrId ? (
                              emptyText(employee.managerName)
                            ) : (
                              <span className="inline-flex rounded-full border border-phx-warn-line bg-phx-warn-bg px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-tighter text-phx-warn">
                                Unassigned
                              </span>
                            ),
                          },
                          { label: "Email", value: emptyText(employee.workEmail) },
                          { label: "Phone", value: emptyText(employee.mobileNumber) },
                        ]}
                      />
                    </PortalRecordCard>
                  );
                })
              )}
            </div>

            {/* Desktop Table View */}
            {/* These seven cells have said `sticky top-0` since they were written and have never
                frozen anything: sticky resolves against the nearest scrollport, and the wrapper
                had no height cap, so the PAGE did the vertical scrolling and the header went with
                it. The cap is what makes the existing intent real. */}
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[24%]" />
                  <col className="w-[10%]" />
                  <col className="w-[16%]" />
                  <col className="w-[14%]" />
                  <col className="w-[10%]" />
                  <col className="w-[16%]" />
                  <col className="w-[10%]" />
                </colgroup>
              }
              maxHeight="70vh"
            >
              <thead>
                <tr className="text-phx-xs font-bold uppercase tracking-wider text-phx-ink-soft">
                  <th className={frozenHeaderCellClassName} style={frozenHeaderCellStyle}>Employee Information</th>
                  <th className={`${frozenHeaderCellClassName}`} style={frozenHeaderCellStyle}>Hiring Date</th>
                  <th className={frozenHeaderCellClassName} style={frozenHeaderCellStyle}>Organization</th>
                  <th className={frozenHeaderCellClassName} style={frozenHeaderCellStyle}>Direct Manager</th>
                  <th className={`${frozenHeaderCellClassName} text-center`} style={frozenHeaderCellStyle}>Payout</th>
                  <th className={frozenHeaderCellClassName} style={frozenHeaderCellStyle}>Contact Details</th>
                  <th className={`${frozenHeaderCellClassName} text-right`} style={frozenHeaderCellStyle}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-phx-paper-2">
                {filteredEmployees.length === 0 ? (
                  <tr>
                    <td
                      className="px-3 py-16 text-center text-sm text-phx-ink-faint"
                      colSpan={7}
                    >
                      <div className="flex flex-col items-center gap-3">
                        <div className="h-12 w-12 rounded-full bg-phx-paper-2 flex items-center justify-center">
                          <Users className="h-6 w-6 text-phx-line-strong" />
                        </div>
                        <span>
                          {directoryTab === "missing" && !hasActiveFilters
                            ? "No employee records are missing master data."
                            : "No employee records match your current filter criteria."}
                        </span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredEmployees.map((employee, index) => {
                    const missingFields = getMissingEmployeeRecordFields(employee);

                    return (
                      <tr
                        className="group transition-all duration-200 hover:bg-phx-paper data-[state=selected]:bg-phx-accent-soft"
                        key={employeeRowKey(employee, index)}
                      >
                      <td className="px-3 py-4">
                        {/* A reader clicking a name gets the Master Details drawer rather than an
                            edit form she cannot save: the same gesture, sent where it can land. */}
                        <button
                          className="flex items-center gap-3 rounded-lg text-left group/name focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                          onClick={() => (canEdit ? startEdit(employee) : setMasterDetailsEmployee(employee))}
                          type="button"
                        >
                          <DirectoryAvatar
                            fullName={employee.displayName}
                            hasPhoto={employee.hasPhoto}
                            hrId={employee.hrId}
                          />
                          <div className="flex flex-col">
                          <span className="font-bold text-phx-ink group-hover/name:text-phx-accent transition-colors leading-tight">
                            {employee.displayName}
                          </span>
                          <div className="mt-1.5 flex items-center gap-2">
                            {employee.employmentStatus === "active" && (
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            )}
                          </div>
                          {directoryTab === "missing" && missingFields.length > 0 ? (
                            <span
                              className="mt-2 inline-flex max-w-[280px] items-center gap-1.5 rounded-full border border-phx-warn-line bg-phx-warn-bg px-2 py-0.5 text-phx-2xs font-bold text-phx-warn"
                              title={missingFields.join(", ")}
                            >
                              <AlertCircle className="h-3 w-3 shrink-0" />
                              <span className="min-w-0 break-words">
                                {missingEmployeeRecordSummary(employee)}
                              </span>
                            </span>
                          ) : null}
                          </div>
                        </button>
                      </td>
                      <td className="px-3 py-4">
                        <span className="font-mono text-xs text-phx-ink-2">
                          {employee.hireDate ? employee.hireDate.slice(0, 10) : "—"}
                        </span>
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex flex-col gap-1">
                          <span className="text-xs font-semibold text-phx-ink leading-tight">
                            {emptyText(employee.positionTitle ?? employee.jobTitle)}
                          </span>
                          <span className="text-phx-2xs text-phx-ink-soft">
                            {emptyText(employee.departmentName)} · {emptyText(employee.lineName)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-4">
                        {employee.managerHrId ? (
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-phx-ink">
                              {emptyText(employee.managerName)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-phx-2xs font-bold uppercase tracking-tighter text-phx-warn bg-phx-warn-bg px-2 py-0.5 rounded-full border border-phx-warn-line">
                            Unassigned
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-4 text-center">
                        <Badge
                          className={cn(
                            "border-none px-2.5 py-0.5 text-phx-2xs font-bold uppercase tracking-tight whitespace-nowrap",
                            employee.salaryPaymentMode === "two_parts"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-emerald-100 text-emerald-700"
                          )}
                          variant="neutral"
                        >
                          {employee.salaryPaymentMode === "two_parts"
                            ? "2 Parts"
                            : "1 Part"}
                        </Badge>
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex flex-col gap-1">
                          <span className="break-words text-xs font-medium text-phx-ink leading-tight">
                            {emptyText(employee.workEmail)}
                          </span>
                          <span className="font-mono text-phx-2xs tracking-tight text-phx-ink-soft">
                            {emptyText(employee.mobileNumber)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-4 text-right">
                        <div className="flex justify-end gap-1.5 transition-all duration-200">
                          <Button
                            className="h-8 w-8 rounded-xl p-0 text-phx-ink-soft hover:bg-phx-paper-2 hover:text-phx-ink hover:scale-110 transition-all focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                            onClick={() => setMasterDetailsEmployee(employee)}
                            title="View Master Details"
                            variant="ghost"
                          >
                            <Info className="h-4 w-4" />
                          </Button>
                          {canEdit ? (
                          <>
                          <Button
                            className="h-8 w-8 rounded-xl p-0 text-phx-ink-soft hover:bg-phx-paper-2 hover:text-phx-ink hover:scale-110 transition-all focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                            onClick={() => startEdit(employee)}
                            title="Edit Record"
                            variant="ghost"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            className="h-8 w-8 rounded-xl p-0 text-phx-ink-soft hover:bg-phx-paper-2 hover:text-phx-ink hover:scale-110 transition-all focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                            onClick={() => startSeatTransfer(employee)}
                            title="Transfer Seat"
                            variant="ghost"
                          >
                            <ArrowLeftRight className="h-4 w-4" />
                          </Button>
                          {canStartResignation && isDeclineOfferEligible(employee, todayInCairo()) ? (
                          <Button
                            className="h-8 w-8 rounded-xl p-0 text-phx-ink-soft hover:bg-amber-50 hover:text-amber-700 hover:scale-110 transition-all focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                            onClick={() => startDeclineOffer(employee)}
                            title={`Declined offer / did not join — available within ${DECLINE_OFFER_WINDOW_DAYS} days of hiring`}
                            variant="ghost"
                          >
                            <UserMinus className="h-4 w-4" />
                          </Button>
                          ) : null}
                          {canStartResignation ? (
                          <Button
                            className="h-8 w-8 rounded-xl p-0 text-phx-ink-soft hover:bg-rose-50 hover:text-rose-600 hover:scale-110 transition-all focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                            onClick={() => startResignation(employee)}
                            title="Mark as Resigned"
                            variant="ghost"
                          >
                            <UserX className="h-4 w-4" />
                          </Button>
                          ) : null}
                          </>
                          ) : null}
                        </div>
                      </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </PortalDesktopTable>
          </AdminTableShell>
        </>
      ) : null}

      {masterDetailsEmployee ? (
        <div 
          className="fixed inset-0 z-50 flex justify-end bg-phx-ink/40 backdrop-blur-sm transition-opacity duration-300" 
          onClick={() => setMasterDetailsEmployee(null)}
          role="dialog" 
          aria-modal="true" 
          aria-labelledby="master-details-title"
        >
          <Card 
            className="h-full w-full max-w-[640px] overflow-hidden rounded-l-3xl border-l border-phx-line bg-white shadow-[-24px_0_60px_rgba(15,23,42,0.15)] flex flex-col transition-transform duration-300 translate-x-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-phx-line bg-gradient-to-r from-phx-paper to-white px-6 py-5">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-phx-accent to-[#FB923C] text-white shadow-lg shadow-orange-200">
                  <span className="text-lg font-bold">{masterDetailsEmployee.displayName.charAt(0).toUpperCase()}</span>
                </div>
                <div>
                  <h2 className="text-xl font-bold tracking-tight text-phx-ink" id="master-details-title">{masterDetailsEmployee.displayName}</h2>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="font-mono text-phx-2xs font-black tracking-wider text-phx-ink-soft bg-slate-100 px-2 py-0.5 rounded uppercase">{masterDetailsEmployee.hrId}</span>
                    <span className="text-phx-2xs text-phx-ink-faint">·</span>
                    <span className="text-sm text-phx-ink-soft">{masterText(masterDetailsEmployee.positionTitle ?? masterDetailsEmployee.jobTitle)}</span>
                  </div>
                </div>
              </div>
              <Button
                className="h-10 w-10 rounded-xl p-0 text-phx-ink-soft hover:bg-phx-line hover:text-phx-ink transition-all focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                onClick={() => setMasterDetailsEmployee(null)}
                variant="ghost"
                aria-label="Close details panel"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <EmployeePhotoManager
                fullName={masterDetailsEmployee.displayName}
                hrId={masterDetailsEmployee.hrId}
                key={masterDetailsEmployee.hrId}
              />
              {/* The CV lives beside the photo because they are the same kind of thing: two files
                  hanging off one master record, both stored privately and both read through a
                  route rather than a URL. It renders nothing at all for a reader without the
                  grant — see EmployeeCvManager. */}
              <EmployeeCvManager
                employeeName={masterDetailsEmployee.fullName}
                hrId={masterDetailsEmployee.hrId}
                key={`cv-${masterDetailsEmployee.hrId}`}
              />
              {/* The checklist beside the record it belongs to — the same join the Employee Master
                  workbook makes, on the screen somebody is actually looking at. Read-only, and it
                  renders nothing at all without the employee_documents grant. */}
              <EmployeeHiringDocumentsCard hrId={masterDetailsEmployee.hrId} key={`docs-${masterDetailsEmployee.hrId}`} />
              {[
                {
                  title: "Identity",
                  accent: "bg-phx-accent",
                  rows: [
                    ["Employee ID", masterDetailsEmployee.hrId],
                    ["Full Name", masterDetailsEmployee.fullName],
                    ["Nickname", masterDetailsEmployee.nickname],
                    ["Arabic Name", masterDetailsEmployee.nameAr],
                    ["National ID", masterDetailsEmployee.nationalId],
                    ["Gender", masterDetailsEmployee.gender],
                    ["Birth Date", dateText(masterDetailsEmployee.birthDate)],
                    ["Birth Place", masterDetailsEmployee.birthPlace],
                    ["Qualification", masterDetailsEmployee.qualification],
                    // employees.education, which has always held the COLLEGE.
                    ["College Name", masterDetailsEmployee.education],
                    ["University Name", masterDetailsEmployee.universityName],
                    ["College Major", masterDetailsEmployee.collegeMajor],
                    ["Graduation Year", masterDetailsEmployee.seniorYear],
                  ],
                },
                {
                  title: "Organization",
                  accent: "bg-[#3B82F6]",
                  rows: [
                    ["Department", masterDetailsEmployee.departmentName],
                    ["Line", masterDetailsEmployee.lineName],
                    ["Area", masterDetailsEmployee.areaName],
                    ["Area ID", masterDetailsEmployee.areaId],
                    ["Team", masterDetailsEmployee.teamName],
                    ["Title", masterDetailsEmployee.jobTitle],
                    ["Position", masterDetailsEmployee.positionTitle],
                    ["Direct Manager", masterDetailsEmployee.managerName],
                    ["Manager HR_ID", masterDetailsEmployee.managerHrId],
                    ["Hiring Date", dateText(masterDetailsEmployee.hireDate)],
                    ["Probation End Date", dateText(masterDetailsEmployee.probationEndDate)],
                    ["Employment Status", optionName(masterDetailsEmployee.employmentStatus ?? "active")],
                    ["Contract Type", optionName(masterDetailsEmployee.contractType ?? "")],
                    ["Contract Duration", masterDetailsEmployee.contractDuration],
                    ["Contract Renewal Date", dateText(masterDetailsEmployee.contractRenewalDate)],
                  ],
                },
                {
                  title: "Contact & Residence",
                  accent: "bg-[#8B5CF6]",
                  rows: [
                    ["Email", masterDetailsEmployee.workEmail],
                    ["Phone", masterDetailsEmployee.mobileNumber],
                    ["Residence Address", masterDetailsEmployee.residenceAddress],
                    ["Residence City", masterDetailsEmployee.residenceCity],
                    ["Residence Area", masterDetailsEmployee.residenceArea],
                  ],
                },
                {
                  title: "CRM",
                  accent: "bg-[#14B8A6]",
                  rows: [
                    ["CRM ID", masterDetailsEmployee.crmId],
                    ["CRM Username", masterDetailsEmployee.crmUsername],
                  ],
                },
                {
                  title: "Payroll Reference",
                  accent: "bg-[#F43F5E]",
                  rows: [
                    ["Basic Salary", masterDetailsEmployee.basicSalary],
                    ["Base Salary", masterDetailsEmployee.baseSalary],
                    ["Gross Salary", masterDetailsEmployee.grossSalary],
                    ["Net Salary", masterDetailsEmployee.netSalary],
                    ["Fuel Allowance", masterDetailsEmployee.fuelAllowance],
                    ["Extra Cost of Living", masterDetailsEmployee.extraCostOfLiving],
                    ["Medical Insurance", masterDetailsEmployee.medicalInsurance],
                    ["In Medical Insurance", optionName(masterDetailsEmployee.medicalInsuranceStatus ?? "")],
                    ["Social Insurance", masterDetailsEmployee.socialInsurance],
                    ["In Social Insurance", optionName(masterDetailsEmployee.socialInsuranceStatus ?? "")],
                    ["Taxes", masterDetailsEmployee.taxes],
                    ["Payment Mode", masterDetailsEmployee.salaryPaymentMode],
                    ["Has Bank Account", optionName(masterDetailsEmployee.hasBankAccount ?? "")],
                    ["Bank Name", masterDetailsEmployee.bankName],
                    ["Bank Account", masterDetailsEmployee.bankAccount],
                    ["Medical Insurance Number", masterDetailsEmployee.medicalInsuranceNumber],
                    ["Social Insurance Number", masterDetailsEmployee.socialInsuranceNumber],
                    ["Medical Insurance Card Receipt Date", dateText(masterDetailsEmployee.medicalInsuranceCardReceivedDate)],
                    ["Social Insurance Start Date", dateText(masterDetailsEmployee.socialInsuranceStartDate)],
                    ["Health Card Received", optionName(masterDetailsEmployee.healthCardStatus ?? "")],
                    ["Health Card Number", masterDetailsEmployee.healthCardNumber],
                    ["Health Card Receipt Date", masterDetailsEmployee.healthCardReceivedDate],
                    ["Kaab Elamaal Number", masterDetailsEmployee.kaabElamaalNumber],
                    ["Kaab Elamaal Issuer", masterDetailsEmployee.kaabElamaalIssuer],
                    ["Kaab Elamaal Issue Date", dateText(masterDetailsEmployee.kaabElamaalIssueDate)],
                    ["Kaab Elamaal Refunded", optionName(masterDetailsEmployee.kaabElamaalRefund ?? "")],
                  ],
                },
                {
                  title: "Lifecycle/System",
                  accent: "bg-phx-ink-soft",
                  rows: [
                    ["Payroll Eligible", masterDetailsEmployee.payrollEligible],
                    ["Organogram Visible", masterDetailsEmployee.organogramVisible],
                    ["Region", masterDetailsEmployee.regionName],
                    ["Region Code", masterDetailsEmployee.regionCode],
                    ["Last Updated", dateText(masterDetailsEmployee.updatedAt)],
                  ],
                },
              ].map((group) => (
                <section className="rounded-2xl border border-phx-line bg-white p-4 shadow-sm transition-all hover:shadow-md hover:border-phx-line/80" key={group.title}>
                  <div className="flex items-center gap-2 mb-3">
                    <div className={cn("h-1.5 w-1.5 rounded-full", group.accent)} />
                    <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">{group.title}</h3>
                  </div>
                  <dl className="grid gap-1.5">
                    {group.rows
                      .filter(([label]) => !(salaryBlind && SALARY_BLIND_HIDDEN_MASTER_LABELS.has(String(label))))
                      .map(([label, value]) => (
                      <div className="grid grid-cols-[140px_1fr] gap-3 border-b border-phx-paper py-2 last:border-0" key={String(label)}>
                        <dt className="text-xs font-medium text-phx-ink-faint">{label}</dt>
                        <dd className="text-sm font-medium text-phx-ink" dir="auto">{masterText(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
              {!salaryBlind && masterDetailsEmployee?.salaryDetails?.length ? (
                <section className="rounded-2xl border border-phx-line bg-white p-4 shadow-sm transition-all hover:shadow-md hover:border-phx-line/80">
                  <div className="mb-3 flex items-center gap-2">
                    <div className="h-1.5 w-1.5 rounded-full bg-[#0EA5E9]" />
                    <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">
                      Flexible Salary Details
                    </h3>
                  </div>
                  <div className="space-y-3">
                    {masterDetailsEmployee.salaryDetails.map((detail) => (
                      <div
                        className="rounded-2xl border border-phx-line bg-phx-paper p-3"
                        key={detail.id}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-phx-ink">{detail.label}</p>
                            <p className="text-phx-xs uppercase tracking-[0.12em] text-phx-ink-soft">
                              {humanizeCode(detail.category)} · {detail.valueType}
                            </p>
                          </div>
                          <p className="text-sm font-semibold text-phx-ink">{detail.value || "-"}</p>
                        </div>
                        {detail.notes ? (
                          <p className="mt-2 text-xs leading-relaxed text-phx-ink-2">{detail.notes}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
            <div className="border-t border-phx-line bg-phx-paper px-6 py-4 flex justify-end">
              <Button
                className="h-11 rounded-2xl px-8 text-sm font-bold text-white bg-phx-ink hover:bg-[#1E293B] shadow-lg transition-all focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                onClick={() => setMasterDetailsEmployee(null)}
              >
                Close Details
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {isFormOpen && (
        <div 
          className="fixed inset-0 z-50 flex justify-end bg-phx-ink/40 backdrop-blur-sm transition-all duration-300" 
          onClick={closeForm}
          role="dialog" 
          aria-modal="true" 
          aria-labelledby="form-drawer-title"
        >
          <Card 
            className="h-full w-full max-w-[680px] overflow-hidden rounded-l-3xl border-l border-phx-line bg-white shadow-[-24px_0_60px_rgba(15,23,42,0.15)] flex flex-col transition-transform duration-300 translate-x-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-phx-line bg-gradient-to-r from-phx-paper to-white px-6 py-5">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-phx-ink" id="form-drawer-title">
                  {editingHrId ? "Employee Profile" : "New Employee Onboarding"}
                </h2>
                <p className="mt-1 text-sm text-phx-ink-soft">
                  {editingHrId ? `Editing master record for ${form.fullName || "..."}` : "Create a new workforce master data record."}
                </p>
                {/* Names the seat that was pressed on the organogram, so whoever lands here from
                    a chart box can see the form opened on the right one before typing a name. */}
                {!editingHrId && vacancySeatLabel ? (
                  <p className="mt-2 border border-phx-accent-line bg-orange-50 px-2.5 py-1.5 text-xs font-semibold text-phx-accent-hover">
                    Filling the open seat — {vacancySeatLabel}
                  </p>
                ) : null}
              </div>
              <Button
                className="h-10 w-10 rounded-xl p-0 text-phx-ink-soft hover:bg-phx-line hover:text-phx-ink transition-all focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                onClick={closeForm}
                variant="ghost"
                aria-label="Close form panel"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto bg-white p-6 space-y-8">
              {/* The other half of the hire. The seat above filled where this person will sit;
                  this fills WHO they are, from a candidate recruitment already holds — name,
                  national ID, phone, birth date, education, the offer's start date and gross,
                  and the candidate's own CV, copied server-side on save.

                  Shown only when the form was opened from a seat AND there is somebody to pick:
                  an empty list means either no candidate is at a hireable stage or this viewer
                  has no recruitment access, and neither is worth an empty dropdown.

                  🔒 SEAT-ONLY IS THE OWNER'S RULING (2026-09-29), asked and answered — do NOT
                  widen it to every Add Employee form. The obvious-looking improvement is to drop
                  `vacancySeatLabel` from this condition, and it is refused for a reason: the list
                  is only useful because it can be RANKED, and the seat is what ranks it (the
                  candidate whose requisition points at this seat is marked and sorted first). On
                  a blank form there is nothing to rank against, so it degrades to an unordered
                  list of everyone at offer stage — a worse way to find a person than typing their
                  name — while adding a field to skip on every head-office hire, re-hire and
                  correction, which is what the blank form is mostly used for. Anyone filling a
                  vacancy reaches this form from the seat in one press anyway.
                  Pinned by tests/seat-hire-candidate-picker.test.ts. */}
              {!editingHrId && vacancySeatLabel && seatHireCandidates.length > 0 ? (
                <div className="space-y-3 border border-phx-accent-line bg-orange-50/60 p-4">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 bg-phx-accent" />
                    <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">
                      Fill from recruitment
                    </h3>
                  </div>
                  <SelectField
                    disabled={isPickingCandidate}
                    label="Candidate"
                    onChange={(value) => void pickSeatCandidate(value)}
                    options={seatHireCandidates.map((candidate) => ({
                      // A candidate whose own requisition points at this seat is marked, and
                      // sorted first — but the rest stay listed, because a requisition opened
                      // against one area routinely ends up filling a neighbouring one.
                      label: [
                        candidate.candidateName,
                        candidate.jobTitle ? `· ${candidate.jobTitle}` : "",
                        candidate.matchesSeat ? "· this seat" : "",
                      ]
                        .filter(Boolean)
                        .join(" "),
                      value: candidate.applicationId,
                    }))}
                    placeholder={
                      isPickingCandidate ? "Loading the candidate…" : "Pick a candidate (optional)"
                    }
                    value={pickedApplicationId ?? ""}
                  />
                  {pickedCandidateName ? (
                    <p className="text-xs font-semibold text-phx-ink-soft">
                      {pickedCandidateName}&apos;s details are in the form. Their CV is filed
                      automatically when you save. The seat above is unchanged — salary, bank and
                      insurance are still yours to complete.
                    </p>
                  ) : null}
                  {offerTitleConflict ? (
                    <p className="border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-800">
                      {offerTitleConflict}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* Section 1: Identity Information */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-phx-paper-2 pb-2">
                  <div className="h-2 w-2 rounded-full bg-phx-accent" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">Identity Information</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    disabled={Boolean(editingHrId)}
                    label="Employee ID"
                    onChange={(value) => {
                      setAutoGeneratedHrId(null);
                      updateForm("hrId", value);
                    }}
                    placeholder="Auto-generated"
                    value={form.hrId}
                  />
                  <TextField
                    label="Full Name (English)"
                    onChange={(value) => updateForm("fullName", value)}
                    placeholder="Enter full legal name"
                    value={form.fullName}
                  />
                  <TextField
                    label="Nickname"
                    onChange={(value) => updateForm("nickname", value)}
                    placeholder="Shown system-wide instead of the full name (optional)"
                    value={form.nickname}
                  />
                  <TextField
                    label="Full Name (Arabic)"
                    onChange={(value) => updateForm("nameAr", value)}
                    placeholder="الاسم بالكامل"
                    value={form.nameAr}
                  />
                  <TextField
                    label="National ID"
                    onChange={updateNationalId}
                    placeholder="National identity number"
                    value={form.nationalId}
                  />
                  <SelectField
                    label="Gender"
                    note={idNotes.get("gender")}
                    onChange={(value) => updateForm("gender", value)}
                    onUseNote={adoptIdNote}
                    options={genderOptions}
                    placeholder="Select gender"
                    value={form.gender}
                  />
                  <TextField
                    label="Birth Date"
                    note={idNotes.get("birthDate")}
                    onChange={(value) => updateForm("birthDate", value)}
                    onUseNote={adoptIdNote}
                    type="date"
                    value={form.birthDate}
                  />
                  <TextField
                    label="Birth Place"
                    note={idNotes.get("birthPlace")}
                    onChange={(value) => updateForm("birthPlace", value)}
                    onUseNote={adoptIdNote}
                    placeholder="As written on the national ID"
                    value={form.birthPlace}
                  />
                  {/*
                    FIVE EDUCATION FIELDS WHERE THERE WAS ONE, and the old one is unchanged
                    underneath. `education` has always held the COLLEGE — its live values are
                    Science, Pharmacy, Vet, Commerce, Dentist — and it is what the eligible-degree
                    rule scores, so it keeps its column and simply reads "College Name" now, which
                    is what HR calls it. The qualification itself is the separate field above it.
                  */}
                  <TextField
                    label="Qualification"
                    onChange={(value) => updateForm("qualification", value)}
                    placeholder="e.g. Bachelor - license"
                    value={form.qualification}
                  />
                  <TextField
                    label="College Name"
                    onChange={(value) => updateForm("education", value)}
                    placeholder="e.g. Pharmacy, Science, Vet"
                    value={form.education}
                  />
                  <TextField
                    label="University Name"
                    onChange={(value) => updateForm("universityName", value)}
                    placeholder="e.g. Cairo University"
                    value={form.universityName}
                  />
                  <TextField
                    label="College Major"
                    onChange={(value) => updateForm("collegeMajor", value)}
                    placeholder="Specialisation"
                    value={form.collegeMajor}
                  />
                  <TextField
                    label="Graduation Year"
                    onChange={(value) => updateForm("seniorYear", value)}
                    placeholder="e.g. 2019"
                    value={form.seniorYear}
                  />
                  {/* HR's field (owner, 2026-10-31) — the Team Coaching Skills Survey reads it as Years in Role. */}
                  <TextField
                    label="Total years of experience"
                    onChange={(value) => updateForm("totalExperienceYears", value)}
                    placeholder="All years in the role, at Sato and before. e.g. 2.5"
                    type="number"
                    value={form.totalExperienceYears}
                  />
                </div>
              </div>

              {/* Section 2: Organizational Assignment */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-phx-paper-2 pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#3B82F6]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">Organizational Assignment</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField
                    label="Job Position"
                    onChange={(value) => {
                      const selected = lookups.positions.find((p) => p.value === value);
                      const nextJobTitle = selected?.label ?? form.jobTitle;
                      setForm((prev) => {
                        const next = {
                          ...prev,
                          areaId: "",
                          departmentId: isSalesPositionTitle(nextJobTitle) && salesDepartmentId ? salesDepartmentId : prev.departmentId,
                          managerHrId: "",
                          positionId: value,
                          jobTitle: nextJobTitle,
                        };
                        // The position sets the title, and the title sets the allowances — except for
                        // the salary-blind seat, whose save carries no allowance to set.
                        return salaryBlind ? next : withSalaryAutofill(next, salaryOverridesRef.current);
                      });
                    }}
                    options={lookups.positions}
                    placeholder="Select position"
                    value={form.positionId}
                  />
                  <div>
                    <TextField
                      label="Title"
                      onChange={(value) => updateSalaryDriver("jobTitle", value)}
                      placeholder="Auto-filled from selected position"
                      value={form.jobTitle}
                    />
                    {jobTitleSuggestion ? (
                      <div
                        className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 border border-phx-warn-line bg-phx-warn-bg px-2 py-1 text-phx-2xs font-bold text-phx-warn"
                        role="status"
                      >
                        <span className="break-words">Did you mean &ldquo;{jobTitleSuggestion}&rdquo;?</span>
                        <button
                          className="underline underline-offset-2"
                          onClick={() => updateSalaryDriver("jobTitle", jobTitleSuggestion)}
                          type="button"
                        >
                          Use it
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <SelectField
                    label="Department"
                    onChange={(value) => updateForm("departmentId", value)}
                    options={lookups.departments}
                    placeholder="Select department"
                    value={form.departmentId}
                  />
                  <SelectField
                    label="Business Line"
                    onChange={updateLine}
                    options={filteredWorkforceLines}
                    placeholder="Select business line"
                    value={form.lineId}
                  />
                  <SelectField
                    disabled={selectedPositionRequiresVacancy && !form.lineId}
                    label="Operating Area"
                    onChange={(value) => {
                      if (value === "empty") return;
                      if (selectedPositionRequiresVacancy) {
                        applyVacancySelection(value);
                      } else {
                        const selectedArea = lookups.areas.find((a) => String(a.value) === String(value));
                        if (selectedArea) {
                          setForm((prev) => ({
                            ...prev,
                            areaId: String(value),
                            lineId: lineIdAfterAreaPick(selectedArea, prev.lineId),
                            managerHrId: selectedArea.managerHrId ?? prev.managerHrId,
                            positionId: String(selectedArea.positionId ?? prev.positionId),
                            teamId: "",
                          }));
                        } else {
                          setForm((prev) => ({ ...prev, areaId: value, teamId: "" }));
                        }
                      }
                    }}
                    options={
                      selectedPositionRequiresVacancy
                        ? filteredWorkforceVacancies.length > 0
                          ? filteredWorkforceVacancies.map((v) => ({
                              label: formatVacancyOptionLabel(v, {
                                omitPositionTitle: vacancyPositionsAgree,
                                leadWithRegion: vacancyRowsAreManagerSeats,
                              }),
                              value: String(v.areaId),
                            }))
                          : form.lineId
                            ? [{ label: "No open vacancy for this position and line", value: "empty" }]
                            : []
                        : operatingAreaOptions(lookups.areas)
                    }
                    placeholder={selectedPositionRequiresVacancy && !form.lineId ? "Select line first" : "Select area"}
                    value={form.areaId}
                  />
                  <SelectField
                    label="Team"
                    onChange={(value) => updateForm("teamId", value)}
                    options={filteredTeamOptions}
                    placeholder={form.areaId ? "Select team" : "Select area first or choose a global team"}
                    value={form.teamId}
                  />
                  <SelectField
                    label="Direct Manager"
                    onChange={(value) => updateForm("managerHrId", value)}
                    options={lookups.managers.filter(
                      (manager) => manager.value !== form.hrId,
                    )}
                    placeholder="Select manager"
                    value={form.managerHrId}
                  />
                  <TextField
                    disabled
                    label="Manager Employee ID"
                    onChange={() => undefined}
                    placeholder="Linked via manager selection"
                    value={form.managerHrId}
                  />
                </div>
              </div>

              {/* Section 3: Employment Details */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-phx-paper-2 pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#10B981]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">Employment Details</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Official Hire Date"
                    onChange={(value) => updateForm("hireDate", value)}
                    type="date"
                    value={form.hireDate}
                  />
                  {/*
                    THE PROBATION WORKFLOW DOES NOT READ THIS. Probation cases carry their own
                    `probation_end_date` and the Day 30/60/75 milestones count from the hiring date,
                    so leaving this blank changes nothing anywhere — it is HR's record of what the
                    contract says, which is why it can be typed freely here.
                  */}
                  <TextField
                    label="Probation End Date"
                    onChange={(value) => updateForm("probationEndDate", value)}
                    type="date"
                    value={form.probationEndDate}
                  />
                  <SelectField
                    disabled={salaryBlind}
                    label="Employment Status"
                    onChange={(value) => updateForm("employmentStatus", value)}
                    options={lookups.statuses}
                    value={form.employmentStatus}
                  />
                  <SelectField
                    label="Contract Type"
                    onChange={(value) => updateForm("contractType", value)}
                    options={contractTypeOptions}
                    placeholder="Select contract type"
                    value={form.contractType}
                  />
                  <TextField
                    label="Contract Duration"
                    onChange={(value) => updateForm("contractDuration", value)}
                    placeholder="e.g. 1 Year"
                    value={form.contractDuration}
                  />
                  <TextField
                    label="Contract Renewal Date"
                    onChange={(value) => updateForm("contractRenewalDate", value)}
                    type="date"
                    value={form.contractRenewalDate}
                  />
                  {/* Shown to the salary-blind seat, never changed by her (owner, 2026-10-20: "can
                      change bank account but never a paymode"). The server writes the stored value
                      back whatever this sends (app/api/employees/route.ts). */}
                  <SelectField
                    disabled={salaryBlind}
                    label="Salary Payout Mode"
                    onChange={(value) => updateForm("salaryPaymentMode", value)}
                    options={salaryPaymentModeOptions}
                    value={form.salaryPaymentMode}
                  />
                </div>
              </div>

              {/* Section 4: Contact & CRM */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-phx-paper-2 pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#8B5CF6]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">Contact & System Access</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <CompanyEmailField
                    label="Work Email Address"
                    onChange={(value) => updateForm("workEmail", value)}
                    value={form.workEmail}
                  />
                  <TextField
                    label="Mobile Number"
                    onChange={(value) => updateForm("mobileNumber", value)}
                    placeholder="+20..."
                    value={form.mobileNumber}
                  />
                  <TextField
                    label="CRM Username"
                    onChange={(value) => updateForm("crmUsername", value)}
                    placeholder="System username"
                    value={form.crmUsername}
                  />
                  <TextField
                    label="CRM System ID"
                    onChange={(value) => updateForm("crmId", value)}
                    placeholder="External system ID"
                    value={form.crmId}
                  />
                </div>
              </div>

              {/* Section 5: Residence & Location */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-phx-paper-2 pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#F43F5E]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">Residence & Geography</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Residence Address"
                    onChange={(value) => updateForm("residenceAddress", value)}
                    placeholder="Full address as per ID"
                    value={form.residenceAddress}
                  />
                  <TextField
                    label="City"
                    onChange={(value) => updateForm("residenceCity", value)}
                    placeholder="e.g. Cairo"
                    value={form.residenceCity}
                  />
                  <TextField
                    label="Area / District"
                    onChange={(value) => updateForm("residenceArea", value)}
                    placeholder="e.g. Maadi"
                    value={form.residenceArea}
                  />
                </div>
                <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4 text-phx-xs leading-relaxed text-phx-ink-2">
                  <p className="font-bold text-[#1E40AF] mb-1 uppercase tracking-tight">Geocoding Information</p>
                  Residence address is automatically geocoded upon saving. Coordinates are used for distance-based expense validation and workforce heatmaps.
                </div>
              </div>

              {/* Section 6: Payroll Reference */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-phx-paper-2 pb-2">
                  <div className="h-2 w-2 rounded-full bg-[#14B8A6]" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">Payroll Reference</h3>
                </div>
                {/* The salary-blind seat sees none of the money boxes — her save carries no money
                    and the server drops any it is sent. The statuses, numbers, dates and bank
                    details below are not money and stay. */}
                {salaryBlind ? (
                  <div className="rounded-xl border border-teal-100 bg-teal-50/50 p-4 text-phx-xs leading-relaxed text-phx-ink-2">
                    <p className="font-bold text-[#0F766E] mb-1 uppercase tracking-tight">No salary figures</p>
                    Salary, allowance, insurance and tax amounts are kept by the HR Manager and are not
                    shown in this seat. The bank details and the insurance records below are yours to keep up
                    to date.
                  </div>
                ) : (
                <div className="rounded-xl border border-teal-100 bg-teal-50/50 p-4 text-phx-xs leading-relaxed text-phx-ink-2">
                  <p className="font-bold text-[#0F766E] mb-1 uppercase tracking-tight">Type the Net Salary</p>
                  Base, basic, gross, fuel, extra cost of living, insurance wage, social insurance and taxes are
                  filled in from the net salary and the job title, using the Egyptian income tax brackets and the
                  social insurance ceiling. Every box stays editable: type your own number into any of them and it
                  is kept, clear it to hand it back to the calculation.
                </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  {salaryBlind ? null : (
                  <>
                  <TextField
                    label="Basic Salary"
                    onChange={(value) => updateSalaryField("basicSalary", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.basicSalary}
                  />
                  <TextField
                    label="Base Salary"
                    onChange={(value) => updateSalaryField("baseSalary", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.baseSalary}
                  />
                  <TextField
                    label="Gross Salary"
                    onChange={(value) => updateSalaryField("grossSalary", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.grossSalary}
                  />
                  <TextField
                    label="Net Salary"
                    onChange={(value) => updateSalaryDriver("netSalary", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.netSalary}
                  />
                  <TextField
                    label="Fuel Allowance"
                    onChange={(value) => updateSalaryField("fuelAllowance", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.fuelAllowance}
                  />
                  <TextField
                    label="Extra Cost of Living"
                    onChange={(value) => updateSalaryField("extraCostOfLiving", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.extraCostOfLiving}
                  />
                  <TextField
                    label="Medical Insurance"
                    onChange={(value) => updateForm("medicalInsurance", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.medicalInsurance}
                  />
                  </>
                  )}
                  <SelectField
                    label="In Medical Insurance"
                    onChange={(value) => updateForm("medicalInsuranceStatus", value)}
                    options={enrollmentStatusOptions}
                    placeholder="Select status"
                    value={form.medicalInsuranceStatus}
                  />
                  {salaryBlind ? null : (
                  <>
                  <TextField
                    label="Social Insurance"
                    onChange={(value) => updateSalaryField("socialInsurance", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.socialInsurance}
                  />
                  <TextField
                    label="Insurance Wage (subject wage)"
                    onChange={(value) => updateSalaryField("socialInsuranceWage", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.socialInsuranceWage}
                  />
                  </>
                  )}
                  <SelectField
                    label="In Social Insurance"
                    onChange={(value) => updateForm("socialInsuranceStatus", value)}
                    options={enrollmentStatusOptions}
                    placeholder="Select status"
                    value={form.socialInsuranceStatus}
                  />
                  {salaryBlind ? null : (
                  <TextField
                    label="Taxes"
                    onChange={(value) => updateSalaryField("taxes", value)}
                    placeholder="0.00"
                    type="number"
                    value={form.taxes}
                  />
                  )}
                  <SelectField
                    label="Has Bank Account"
                    onChange={(value) => updateForm("hasBankAccount", value)}
                    options={yesNoOptions}
                    placeholder="Select"
                    value={form.hasBankAccount}
                  />
                  <TextField
                    label="Bank Name"
                    onChange={(value) => updateForm("bankName", value)}
                    placeholder="Bank name"
                    value={form.bankName}
                  />
                  <TextField
                    label="Bank Account"
                    onChange={(value) => updateForm("bankAccount", value)}
                    placeholder="Account or IBAN"
                    value={form.bankAccount}
                  />
                  <TextField
                    label="Medical Insurance Number"
                    onChange={(value) => updateForm("medicalInsuranceNumber", value)}
                    placeholder="Reference number"
                    value={form.medicalInsuranceNumber}
                  />
                  <TextField
                    label="Medical Insurance Card Receipt Date"
                    onChange={(value) => updateForm("medicalInsuranceCardReceivedDate", value)}
                    type="date"
                    value={form.medicalInsuranceCardReceivedDate}
                  />
                  <TextField
                    label="Social Insurance Number"
                    onChange={(value) => updateForm("socialInsuranceNumber", value)}
                    placeholder="Reference number"
                    value={form.socialInsuranceNumber}
                  />
                  {/*
                    A RECORD, NOT A RULE. Payroll reads `social_insurance_wage` and nothing else —
                    neither this date nor the status beside it changes a single figure, and neither
                    reduces anybody's take-home pay.
                  */}
                  <TextField
                    label="Social Insurance Start Date"
                    onChange={(value) => updateForm("socialInsuranceStartDate", value)}
                    type="date"
                    value={form.socialInsuranceStartDate}
                  />
                  {/*
                    The GOVERNMENT health insurance booklet — دفتر التأمين الصحى الحكومى. It sits
                    below the private medical insurance fields rather than beside them because it is
                    a different thing entirely, and the owner said so himself on 2026-09-29.
                  */}
                  <SelectField
                    label="Health Card Received"
                    onChange={(value) => updateForm("healthCardStatus", value)}
                    options={enrollmentStatusOptions}
                    placeholder="Select status"
                    value={form.healthCardStatus}
                  />
                  <TextField
                    label="Health Card Number"
                    onChange={(value) => updateForm("healthCardNumber", value)}
                    placeholder="Booklet number"
                    value={form.healthCardNumber}
                  />
                  <TextField
                    label="Health Card Receipt Date"
                    onChange={(value) => updateForm("healthCardReceivedDate", value)}
                    type="date"
                    value={form.healthCardReceivedDate}
                  />
                  {/*
                    كعب العمل — the labour registration stub. The refund flag is a receipt fact HR
                    records after the fee comes back; it moves no money and no payroll run reads it.
                  */}
                  <TextField
                    label="Kaab Elamaal Number"
                    onChange={(value) => updateForm("kaabElamaalNumber", value)}
                    placeholder="Stub number"
                    value={form.kaabElamaalNumber}
                  />
                  <TextField
                    label="Kaab Elamaal Issuer"
                    onChange={(value) => updateForm("kaabElamaalIssuer", value)}
                    placeholder="Issuing labour office"
                    value={form.kaabElamaalIssuer}
                  />
                  <TextField
                    label="Kaab Elamaal Issue Date"
                    onChange={(value) => updateForm("kaabElamaalIssueDate", value)}
                    type="date"
                    value={form.kaabElamaalIssueDate}
                  />
                  <SelectField
                    label="Kaab Elamaal Refunded"
                    onChange={(value) => updateForm("kaabElamaalRefund", value)}
                    options={yesNoOptions}
                    placeholder="Select"
                    value={form.kaabElamaalRefund}
                  />
                </div>
                {salaryBlind ? null : (
                <div className="rounded-2xl border border-[#D7EAF8] bg-[#F8FCFF] p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h4 className="text-sm font-bold text-phx-ink">Flexible Salary Details</h4>
                      <p className="mt-1 text-xs leading-relaxed text-phx-ink-soft">
                        Add any extra salary line you need without changing the code again. These rows are stored with the employee compensation record.
                      </p>
                    </div>
                    <Button
                      className="h-10 rounded-2xl border border-[#BFDBFE] bg-white px-4 text-xs font-bold text-[#1D4ED8] hover:bg-[#EFF6FF]"
                      onClick={addSalaryDetailRow}
                      type="button"
                      variant="ghost"
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add Salary Detail
                    </Button>
                  </div>
                  <div className="mt-4 space-y-3">
                    {form.salaryDetails.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-[#BFDBFE] bg-white/70 px-4 py-5 text-xs text-phx-ink-soft">
                        No flexible salary details added yet.
                      </div>
                    ) : null}
                    {form.salaryDetails.map((detail, index) => (
                      <div
                        className="rounded-2xl border border-[#D7EAF8] bg-white p-4 shadow-sm"
                        key={detail.id}
                      >
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-phx-ink">
                              Salary Detail {index + 1}
                            </p>
                            <p className="text-phx-xs uppercase tracking-[0.12em] text-phx-ink-soft">
                              Flexible compensation row
                            </p>
                          </div>
                          <Button
                            className="h-9 rounded-xl border border-[#FECACA] bg-white px-3 text-xs font-bold text-[#DC2626] hover:bg-[#FEF2F2]"
                            onClick={() => removeSalaryDetailRow(detail.id)}
                            type="button"
                            variant="ghost"
                          >
                            <X className="mr-1.5 h-4 w-4" />
                            Remove
                          </Button>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <SelectField
                            label="Category"
                            onChange={(value) => updateSalaryDetailRow(detail.id, "category", value)}
                            options={salaryDetailCategoryOptions}
                            value={detail.category}
                          />
                          <SelectField
                            label="Value Type"
                            onChange={(value) => updateSalaryDetailRow(detail.id, "valueType", value)}
                            options={salaryDetailValueTypeOptions}
                            value={detail.valueType}
                          />
                          <TextField
                            label="Detail Label"
                            onChange={(value) => updateSalaryDetailRow(detail.id, "label", value)}
                            placeholder="e.g. Mobile allowance"
                            value={detail.label}
                          />
                          <TextField
                            label={detail.valueType === "amount" ? "Amount" : "Value"}
                            onChange={(value) => updateSalaryDetailRow(detail.id, "value", value)}
                            placeholder={detail.valueType === "amount" ? "0.00" : "Enter value"}
                            type={detail.valueType === "amount" ? "number" : "text"}
                            value={detail.value}
                          />
                          <div className="sm:col-span-2">
                            <TextField
                              label="Notes"
                              onChange={(value) => updateSalaryDetailRow(detail.id, "notes", value)}
                              placeholder="Optional note or explanation"
                              value={detail.notes}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                )}
              </div>

              {/* Section 7: Lifecycle / System */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-phx-paper-2 pb-2">
                  <div className="h-2 w-2 rounded-full bg-phx-ink-soft" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">Lifecycle / System</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {/* Held with the HR Manager for the salary-blind seat, like the payout mode. */}
                  <SelectField
                    disabled={salaryBlind || !canSelectPayrollEligibility}
                    label="Payroll Eligible"
                    onChange={(value) => updateForm("payrollEligible", value)}
                    options={yesNoOptions}
                    value={canSelectPayrollEligibility ? form.payrollEligible : "no"}
                  />
                  <TextField
                    disabled
                    label="Organogram Visible"
                    onChange={() => undefined}
                    value={form.employmentStatus === "active" || form.employmentStatus === "on_leave" ? "Yes" : "No"}
                  />
                  <TextField
                    label="Region"
                    onChange={(value) => updateForm("regionName", value)}
                    placeholder="Auto-filled from vacancy when available"
                    value={form.regionName}
                  />
                  <TextField
                    disabled
                    label="Last Updated"
                    onChange={() => undefined}
                    value={editingHrId ? "Updated on save" : "Created on save"}
                  />
                </div>
              </div>

              {/* The CV. Two different controls, because the two cases are different: an existing
                  record can be read back and replaced, while a record being CREATED has nothing to
                  read and instead stages the file so the save can attach it before the SFE
                  Manager's notice is composed (src/lib/employees/employee-cv.ts). */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-phx-ink-soft" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-phx-ink-2">CV</h3>
                </div>
                {editingHrId ? (
                  <EmployeeCvManager employeeName={form.fullName} hrId={editingHrId} />
                ) : (
                  <EmployeeCvPicker onChange={setStagedCv} staged={stagedCv} />
                )}
              </div>

              {/* Payroll Information Note */}
              <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-4 text-phx-xs leading-relaxed text-phx-ink-2">
                <p className="font-bold text-[#92400E] mb-1 uppercase tracking-tight">Payroll Payout Structure</p>
                <span className="font-bold text-[#92400E]">1 Part:</span> Net salary on Day 1, expenses on Day 10.<br/>
                <span className="font-bold text-[#92400E]">2 Parts:</span> 70% Basic on Day 1. Remaining 30%, Cost of Living, Fuel, and Expenses on Day 10.
              </div>
            </div>

            <div className="border-t border-phx-line bg-gradient-to-r from-phx-paper to-white px-6 py-4 flex justify-between items-center">
              <div className="text-xs text-phx-ink-faint">
                {editingHrId ? "Editing existing master record" : "Creating new employee record"}
              </div>
              <div className="flex gap-3">
                <Button
                  className="h-11 rounded-2xl px-6 text-sm font-semibold text-phx-ink-2 hover:bg-phx-line transition-all focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                  onClick={closeForm}
                  variant="ghost"
                >
                  Discard Changes
                </Button>
                <Button
                  className="h-11 gap-2 rounded-2xl bg-phx-ink px-8 text-sm font-bold text-white shadow-lg transition-all hover:bg-[#1E293B] hover:shadow-xl disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-phx-accent focus-visible:outline-offset-1"
                  disabled={isSaving}
                  onClick={() => void saveEmployee()}
                >
                  {isSaving ? <LoadingSpinner /> : <Check className="h-4 w-4" />}
                  {editingHrId ? "Update Record" : "Create Master Record"}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
      {isResignationOpen && resigningEmployee ? (
        <div 
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-phx-ink/60 px-4 py-6 backdrop-blur-md"
          onClick={closeResignation}
        >
          <Card 
            className={`${panelClassName} w-full max-w-3xl overflow-hidden`}
            onClick={(e) => e.stopPropagation()}
          >
            <AdminSectionHeader
              action={
                <Button
                  className="h-9 rounded-xl px-3 text-xs"
                  onClick={closeResignation}
                  variant="secondary"
                >
                  <X className="h-4 w-4" />
                </Button>
              }
              description="Update employee status and create the corresponding vacancy record for payroll and headcount continuity."
              title="Mark As Resigned"
            />

            <div className="grid gap-4 p-5 md:grid-cols-2">
              {resignationError ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 md:col-span-2">
                  <div className="flex gap-3">
                    <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
                    <div>
                      <h3 className="text-sm font-semibold text-text">Unable to confirm resignation</h3>
                      <p className="mt-1 text-sm text-text-secondary">{resignationError}</p>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 md:col-span-2">
                <p className="font-semibold text-rose-900">{resigningEmployee.displayName}</p>
                <p className="mt-1 text-sm text-rose-800">
                  {resigningEmployee.hrId} · {emptyText(resigningEmployee.positionTitle ?? resigningEmployee.jobTitle)} · {emptyText(resigningEmployee.areaName)}
                </p>
              </div>

              <TextField
                label="submitted_date"
                onChange={(value) => updateResignationForm("submittedDate", value)}
                type="date"
                value={resignationForm.submittedDate}
              />
              <TextField
                label="effective_date"
                onChange={(value) => updateResignationForm("effectiveDate", value)}
                type="date"
                value={resignationForm.effectiveDate}
              />
              <CrmWorkAfterWarning
                className="md:col-span-2"
                date={resignationForm.effectiveDate}
                hrId={resigningEmployee.hrId}
              />
              <SelectField
                label="employee_status"
                onChange={(value) => updateResignationForm("employeeStatus", value)}
                options={resignationStatusOptions}
                value={resignationForm.employeeStatus}
              />
              <TextField
                label="reason"
                onChange={(value) => updateResignationForm("reason", value)}
                placeholder="Employee resignation reason"
                value={resignationForm.reason}
              />
              <label className="block md:col-span-2">
                <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                  workflow_notes
                </span>
                <textarea
                  className={cn(phxTextareaClassName, "min-h-28")}
                  onChange={(event) => updateResignationForm("workflowNotes", event.target.value)}
                  placeholder="Optional workflow note for the resignation report."
                  value={resignationForm.workflowNotes}
                />
              </label>
            </div>

            <div className="flex justify-end gap-3 p-5">
              <Button onClick={closeResignation} variant="secondary">
                Cancel
              </Button>
              <Button
                className="gap-2 rounded-2xl bg-[#B91C1C] text-white hover:bg-[#B91C1C]/90"
                disabled={isResigning}
                onClick={() => void submitResignation()}
              >
                {isResigning ? <LoadingSpinner /> : <UserX className="h-4 w-4" />}
                Confirm Resignation
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {isDeclineOfferOpen && decliningEmployee ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-phx-ink/60 px-4 py-6 backdrop-blur-md"
          onClick={closeDeclineOffer}
        >
          <Card
            className={`${panelClassName} w-full max-w-3xl overflow-hidden`}
            onClick={(e) => e.stopPropagation()}
          >
            <AdminSectionHeader
              action={
                <Button
                  className="h-9 rounded-xl px-3 text-xs"
                  onClick={closeDeclineOffer}
                  variant="secondary"
                >
                  <X className="h-4 w-4" />
                </Button>
              }
              description={`For an employee who accepted the offer but backed out shortly after — usable up to ${DECLINE_OFFER_WINDOW_DAYS} days from their hire date. Reopens the vacancy the same way a resignation would; you choose separately whether they're entered into payroll.`}
              title="Declined Offer / Did Not Join"
            />

            <div className="grid gap-4 p-5 md:grid-cols-2">
              {declineOfferError ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 md:col-span-2">
                  <div className="flex gap-3">
                    <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
                    <div>
                      <h3 className="text-sm font-semibold text-text">Unable to record this exit</h3>
                      <p className="mt-1 text-sm text-text-secondary">{declineOfferError}</p>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 md:col-span-2">
                <p className="font-semibold text-amber-900">{decliningEmployee.displayName}</p>
                <p className="mt-1 text-sm text-amber-800">
                  {decliningEmployee.hrId} · {emptyText(decliningEmployee.positionTitle ?? decliningEmployee.jobTitle)} · {emptyText(decliningEmployee.areaName)}
                  {decliningEmployee.hireDate ? ` · Hired ${decliningEmployee.hireDate.slice(0, 10)}` : ""}
                </p>
              </div>

              <TextField
                label="last_day_worked"
                onChange={(value) => updateDeclineOfferForm("lastWorkingDate", value)}
                type="date"
                value={declineOfferForm.lastWorkingDate}
              />
              <SelectField
                label="enter_into_payroll"
                onChange={(value) => updateDeclineOfferForm("includeInPayroll", value)}
                options={declineOfferPayrollOptions}
                tone="orange"
                value={declineOfferForm.includeInPayroll}
              />
              <CrmWorkAfterWarning
                className="md:col-span-2"
                date={declineOfferForm.lastWorkingDate}
                hrId={decliningEmployee.hrId}
              />
              {declineOfferForm.includeInPayroll === "yes" ? null : (
                <CrmWorkAfterWarning
                  className="md:col-span-2"
                  date={dayBefore(decliningEmployee.hireDate)}
                  hrId={decliningEmployee.hrId}
                  variant="since-hire-unpaid"
                />
              )}
              <label className="block md:col-span-2">
                <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                  note (optional)
                </span>
                <textarea
                  className={cn(phxTextareaClassName, "min-h-20")}
                  onChange={(event) => updateDeclineOfferForm("note", event.target.value)}
                  placeholder="Why the offer was declined (optional)."
                  value={declineOfferForm.note}
                />
              </label>
              <p className="text-xs text-text-secondary md:col-span-2">
                {declineOfferForm.includeInPayroll === "yes"
                  ? "Prorates base pay for the days worked and adds them to this month's Ready-Payroll sheet (no cost-of-living or fuel allowance)."
                  : "No payroll entry will be created for this exit."}
              </p>
            </div>

            <div className="flex justify-end gap-3 p-5">
              <Button onClick={closeDeclineOffer} variant="secondary">
                Cancel
              </Button>
              <Button
                className="gap-2 rounded-2xl bg-amber-600 text-white hover:bg-amber-600/90"
                disabled={isDecliningOffer || !declineOfferForm.lastWorkingDate}
                onClick={() => void submitDeclineOffer()}
              >
                {isDecliningOffer ? <LoadingSpinner /> : <UserMinus className="h-4 w-4" />}
                Confirm Declined Offer
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {isTransferOpen && transferEmployee ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-phx-ink/60 px-4 py-6 backdrop-blur-md"
          onClick={closeSeatTransfer}
        >
          <Card
            className={`${panelClassName} w-full max-w-3xl overflow-hidden`}
            onClick={(e) => e.stopPropagation()}
          >
            <AdminSectionHeader
              action={
                <Button
                  className="h-9 rounded-xl px-3 text-xs"
                  onClick={closeSeatTransfer}
                  variant="secondary"
                >
                  <X className="h-4 w-4" />
                </Button>
              }
              description="Move the employee onto a vacant organogram seat. Area, region and manager follow the seat, and the move is recorded in the audit log."
              title="Transfer Seat"
            />

            <div className="grid gap-4 p-5 md:grid-cols-2">
              {transferError ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 md:col-span-2">
                  <div className="flex gap-3">
                    <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
                    <div>
                      <h3 className="text-sm font-semibold text-text">Unable to transfer the seat</h3>
                      <p className="mt-1 text-sm text-text-secondary">{transferError}</p>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 md:col-span-2">
                <p className="font-semibold text-slate-900">{transferEmployee.displayName}</p>
                <p className="mt-1 text-sm text-slate-700">
                  {transferEmployee.hrId} · {emptyText(transferOptions?.employee.lineName ?? transferEmployee.lineName)} · currently{" "}
                  {isLoadingTransferOptions
                    ? "loading seat…"
                    : transferOptions && transferOptions.currentSeats.length > 0
                      ? transferOptions.currentSeats.map((seat) => seat.label).join(", ")
                      : "not seated (will be seated directly)"}
                </p>
              </div>

              {!isLoadingTransferOptions &&
              transferOptions &&
              transferOptions.vacantSeats.length === 0 &&
              transferOptions.otherLineVacantSeats.length === 0 ? (
                <div className="md:col-span-2">
                  <AdminCallout tone="warning">
                    No vacant seats exist right now, so there is nowhere to move this employee.
                  </AdminCallout>
                </div>
              ) : null}

              <SelectField
                disabled={
                  isLoadingTransferOptions ||
                  !transferOptions ||
                  transferOptions.vacantSeats.length + transferOptions.otherLineVacantSeats.length === 0
                }
                label="destination_seat"
                onChange={(value) => setTransferForm((current) => ({ ...current, toSeatId: value }))}
                options={[...(transferOptions?.vacantSeats ?? []), ...(transferOptions?.otherLineVacantSeats ?? [])].map(
                  (seat) => ({
                    label: `${seat.lineName ? `${seat.lineName} line · ` : ""}${seat.label}${seat.areaName ? ` · ${seat.areaName}` : ""}${seat.regionName ? ` · ${seat.regionName}` : ""}`,
                    value: seat.seatId,
                  }),
                )}
                placeholder={isLoadingTransferOptions ? "Loading vacant seats…" : "Choose the vacant seat"}
                value={transferForm.toSeatId}
              />
              {(() => {
                const otherLineSeat = transferOptions?.otherLineVacantSeats.find(
                  (seat) => seat.seatId === transferForm.toSeatId,
                );
                return otherLineSeat ? (
                  <div className="md:col-span-2">
                    <AdminCallout tone="warning">
                      This moves {transferEmployee.displayName} from the{" "}
                      {emptyText(transferOptions?.employee.lineName ?? transferEmployee.lineName)} line to the{" "}
                      {otherLineSeat.lineName} line. Line, area, region and manager follow the new seat, the seat&apos;s
                      open vacancy is filled, and a vacancy opens for the seat they leave. Salary, HR ID and history
                      stay the same — this is not a resignation.
                    </AdminCallout>
                  </div>
                ) : null;
              })()}
              <TextField
                label="effective_date"
                onChange={(value) => setTransferForm((current) => ({ ...current, effectiveDate: value }))}
                type="date"
                value={transferForm.effectiveDate}
              />
              {transferOptions && transferOptions.currentSeats.length > 1 ? (
                <SelectField
                  label="seat_to_vacate"
                  onChange={(value) => setTransferForm((current) => ({ ...current, fromSeatId: value }))}
                  options={transferOptions.currentSeats.map((seat) => ({ label: seat.label, value: seat.seatId }))}
                  placeholder="They hold more than one seat - choose which one to vacate"
                  value={transferForm.fromSeatId}
                />
              ) : null}
              <TextField
                label="reason"
                onChange={(value) => setTransferForm((current) => ({ ...current, reason: value }))}
                placeholder="Why this move (kept in the audit log)"
                value={transferForm.reason}
              />
            </div>

            <div className="flex justify-end gap-3 p-5">
              <Button onClick={closeSeatTransfer} variant="secondary">
                Cancel
              </Button>
              <Button
                className="gap-2 rounded-2xl"
                disabled={isTransferring || isLoadingTransferOptions || !transferForm.toSeatId}
                onClick={() => void submitSeatTransfer()}
              >
                {isTransferring ? <LoadingSpinner /> : <ArrowLeftRight className="h-4 w-4" />}
                Confirm Transfer
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
    </EmployeePageShell>
  );
}
