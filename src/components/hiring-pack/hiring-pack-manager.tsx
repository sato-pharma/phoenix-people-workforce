"use client";

// The fill screen for the HR forms pack — the one place HR types what the five statutory documents
// ask for, and then prints them ready to sign.
//
// TWO ENDS OF ONE EMPLOYMENT. The joining documents (the contract and social-insurance Form 1) and
// the leaving documents (social-insurance Form 6 and one of the two Ministry of Labour exit
// templates) sit on one screen because they ask the same person the same questions, years apart. An
// address typed at hiring is the address Form 6 prints at exit; asking for it twice is how the two
// come to disagree.
//
// "WHAT PHOENIX ALREADY KNOWS" WRITES STRAIGHT TO THE EMPLOYEE RECORD. Arabic name, national ID,
// insurance number, salary, department, address — every other screen reads the same row, so a fix
// made here is not a second copy that can drift; it is the one the payroll and organogram tools also
// read. Form 1's own address boxes (below, in "What you fill in") are still typed separately because
// they are not the same shape — building number, sheyakha/qism/governorate codes are boxes the form
// prints, not free text — but the street line can be copied over with one click rather than retyped.
//
// The design identity is taken from the hiring documents tracker next door — same rounded shell,
// same field labels, same button sizes. The two screens are one workflow seen from two ends: this
// one produces the paper, that one tracks the paper coming back.

import {
  AlertTriangle,
  Archive,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  DoorOpen,
  FileSignature,
  FileText,
  Landmark,
  Loader2,
  PencilLine,
  Printer,
  Save,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  AdminCallout,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { FormsDrive } from "@/components/hiring-pack/forms-drive";
import { issuePaperReference } from "@/components/hiring-pack/issue-paper-reference";
import { PrintOptionsDialog, type PrintAnswer } from "@/components/hiring-pack/print-options-dialog";
import { HiringPackPaperEditor } from "@/components/hiring-pack/paper-editor";
import { candidateOptionLabel, type FormsDriveEntry } from "@/lib/hiring-pack/forms-drive";
import { TemplateStudio } from "@/components/hiring-pack/template-studio";
import {
  templateNamesOf,
  useCompanyTemplates,
  type StoredTemplate,
} from "@/components/hiring-pack/use-company-templates";
import type { PaperStore } from "@/lib/hiring-pack/paper-fields";
import {
  asPrintableDocument,
  documentDefaultCopies,
  documentLabel,
  type CustomDocumentNames,
  type PrintableDocument,
} from "@/lib/hiring-pack/document-registry";
import { describePrintInstruction } from "@/lib/hiring-pack/custom-templates";
import { documentTakesAddressChoice, type PrintAddressChoice } from "@/lib/hiring-pack/print-address";
import {
  INSURANCE_WAGE_CEILING,
  INSURANCE_WAGE_DIVISOR,
  insuranceWageFromBase,
} from "@/lib/hiring-pack/insurance-wage";
import { todayInCairo } from "@/lib/date-only";
import { renewalObjectiveReasonOptions } from "@/lib/hiring-pack/renewal-reasons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  archivedTemplateVersions,
  currentTemplateVersion,
  findTemplateVersion,
} from "@/lib/hiring-pack/template-registry";
import {
  marksPlacedOn,
  type DocumentMark,
} from "@/lib/hiring-pack/document-marks";
import { isBuiltInDocument } from "@/lib/hiring-pack/types";
import type {
  CustomHiringPackDocument,
  ExitRoute,
  HiringPackCandidate,
  HiringPackData,
  HiringPackDocument,
  HiringPackGap,
  HiringPackProfileInput,
  OffboardingProfileInput,
} from "@/lib/hiring-pack/types";
import { cn } from "@/lib/utils";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";

const inputClassName =
  "h-10 border-phx-line bg-white text-sm focus:border-phx-accent-line focus:ring-phx-accent/15";
const labelClassName =
  "mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";
const factLabelClassName =
  "text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint";

type FieldKind = "text" | "code" | "number" | "date" | "select";

type FieldDef<Key extends string = string> = {
  key: Key;
  labelEn: string;
  labelAr: string;
  kind: FieldKind;
  /** Sits under the input. Used where typing the wrong KIND of value is the likely mistake. */
  hint?: string;
  maxLength?: number;
  /**
   * The choices, on a `select` field. The first option is always "not chosen" and is added by the
   * renderer rather than listed here, so no field has to remember to offer it — a required-looking
   * dropdown with no way back to blank is how a value nobody meant to set gets set.
   */
  options?: ReadonlyArray<{ value: string; labelEn: string; labelAr: string }>;
};

/** A field on the joining side, writing `employee_hiring_profile`. */
type HiringFieldDef = FieldDef<keyof HiringPackProfileInput & string>;
/** A field on the leaving side, writing `employee_offboarding_profile`. */
type ExitFieldDef = FieldDef<keyof OffboardingProfileInput & string>;

/** Values both joining documents ask for. */
const IDENTITY_FIELDS: readonly HiringFieldDef[] = [
  { key: "nationality", labelEn: "Nationality", labelAr: "الجنسية", kind: "text" },
  { key: "qualification", labelEn: "Qualification", labelAr: "المؤهل", kind: "text" },
  { key: "birthPlace", labelEn: "Place of birth", labelAr: "محل الميلاد", kind: "text" },
  { key: "jobTitleAr", labelEn: "Job title (Arabic)", labelAr: "المسمى الوظيفي", kind: "text" },
];

/**
 * Form 1 only. Four of these are BOXED CODE FIELDS on the government form — two or three printed
 * cells that hold a number, not a name — so they are labelled as codes and length-capped here. The
 * form has no room for "القاهرة" and will not grow one.
 */
const FORM1_FIELDS: readonly HiringFieldDef[] = [
  {
    key: "insuranceOffice",
    labelEn: "Insurance office",
    labelAr: "مكتب التأمينات",
    kind: "text",
    hint: "The NOSI branch office holding the file.",
  },
  {
    key: "occupationCode",
    labelEn: "Occupation code",
    labelAr: "كود المهنة",
    kind: "code",
    hint: "Six digits, printed across two groups of three.",
    maxLength: 6,
  },
  {
    key: "addressBuilding",
    labelEn: "Building no.",
    labelAr: "عقار رقم",
    kind: "code",
    maxLength: 4,
  },
  { key: "addressStreet", labelEn: "Street", labelAr: "شارع / حارة", kind: "text" },
  {
    key: "addressDistrict",
    labelEn: "Sheyakha / village code",
    labelAr: "شياخة / قرية",
    kind: "code",
    hint: "Two digits — the form prints boxes, not a name.",
    maxLength: 2,
  },
  {
    key: "addressMarkaz",
    labelEn: "Qism / markaz code",
    labelAr: "قسم / مركز",
    kind: "code",
    hint: "Two digits — a different grid from شياخة / قرية above.",
    maxLength: 2,
  },
  {
    key: "addressGovernorate",
    labelEn: "Governorate code",
    labelAr: "محافظة",
    kind: "code",
    hint: "Two digits — the form prints boxes, not a name.",
    maxLength: 2,
  },
];

/**
 * Contract terms. Every one of these already has a company default in `systemContractDefaults`, so
 * they are left blank unless this particular hire differs — an empty box means "the standard term",
 * which is what the printed contract will then say.
 */
const TERM_FIELDS: readonly HiringFieldDef[] = [
  {
    key: "contractStartDate",
    labelEn: "Contract start",
    labelAr: "تاريخ بدء العقد",
    kind: "date",
    hint: "Blank uses the hire date.",
  },
  {
    key: "contractEndDate",
    labelEn: "Contract end",
    labelAr: "تاريخ انتهاء العقد",
    kind: "date",
    hint: "Blank is calculated from the duration.",
  },
  {
    key: "contractDurationMonths",
    labelEn: "Duration (months)",
    labelAr: "مدة العقد بالشهور",
    kind: "number",
  },
  {
    key: "underperformanceThresholdPct",
    labelEn: "Underperformance %",
    labelAr: "نسبة الإنجاز",
    kind: "number",
  },
  {
    key: "underperformanceMonths",
    labelEn: "Underperformance months",
    labelAr: "عدد الشهور",
    kind: "number",
  },
  {
    key: "trainingBondMonths",
    labelEn: "Training bond (months)",
    labelAr: "مدة الالتزام بعد التدريب",
    kind: "number",
  },
  {
    key: "contractSignatoryNameAr",
    labelEn: "Signed for the company by",
    labelAr: "يوقّع عن الطرف الأول",
    kind: "text",
    hint: "Blank uses the company's standing signatory. Fill it only when someone else signs.",
  },
  {
    key: "contractSignatoryTitleAr",
    labelEn: "Signatory's capacity",
    labelAr: "صفة الموقّع",
    kind: "text",
    hint: "Blank uses the standing signatory's capacity.",
  },
  {
    key: "contractObjectiveReasonCode",
    labelEn: "Why this post is fixed-term",
    labelAr: "السبب الموضوعي لتحديد المدة",
    kind: "select",
    options: renewalObjectiveReasonOptions(),
    hint: "Printed on the renewal annex. Article 87 allows a fixed term only where the nature of the work requires it. Blank prints a blank for a pen.",
  },
];

const NUMBER_KEYS = new Set<keyof HiringPackProfileInput>([
  "contractDurationMonths",
  "underperformanceThresholdPct",
  "underperformanceMonths",
  "trainingBondMonths",
]);

const ALL_FIELDS: readonly HiringFieldDef[] = [...IDENTITY_FIELDS, ...FORM1_FIELDS, ...TERM_FIELDS];

/**
 * What the three exit documents ask for on top of everything already on file.
 *
 * Short by design. Everything else Form 6 and the labour templates need — name, national ID,
 * address, job title, insurance number — was typed once at hiring and is reused, so this section
 * asks only what genuinely cannot be known until somebody leaves.
 */
const EXIT_FIELDS: readonly ExitFieldDef[] = [
  {
    key: "lastWorkingDate",
    labelEn: "Last working day",
    labelAr: "آخر يوم عمل",
    kind: "date",
    hint: "Blank uses the resignation record. This is the date Form 6 files with the Authority.",
  },
  {
    key: "endReasonAr",
    labelEn: "Reason for leaving (Arabic)",
    labelAr: "سبب انتهاء الاشتراك",
    kind: "text",
    hint: "Printed as written — e.g. ظروف خاصة, دواعي السفر, نقل محل اقامتي.",
  },
  {
    key: "endReasonCode",
    labelEn: "Reason code",
    labelAr: "كود سبب الانتهاء",
    kind: "code",
    hint: "One digit — Form 6 prints a single box.",
    maxLength: 1,
  },
  {
    key: "agreementDate",
    labelEn: "Agreement date",
    labelAr: "تاريخ الاتفاق",
    kind: "date",
    hint: "Mutual termination only. The day it is signed, not the last working day.",
  },
];

/** Who signs, on each side of the paper. Blank uses the company defaults. */
const EXIT_PARTY_FIELDS: readonly ExitFieldDef[] = [
  {
    key: "addresseeNameAr",
    labelEn: "Resignation addressed to",
    labelAr: "السيد الأستاذ الفاضل",
    kind: "text",
    hint: "Blank uses the manager who signs contracts as الطرف الأول.",
  },
  {
    key: "addresseeTitleAr",
    labelEn: "Addressee title",
    labelAr: "مدير",
    kind: "text",
  },
  {
    key: "employerRepNameAr",
    labelEn: "Signs for the company",
    labelAr: "ممثل صاحب العمل",
    kind: "text",
    hint: "Mutual termination only. Blank uses the same manager.",
  },
  {
    key: "employerRepTitleAr",
    labelEn: "Their title",
    labelAr: "الصفة",
    kind: "text",
  },
];

const ALL_EXIT_FIELDS: readonly ExitFieldDef[] = [...EXIT_FIELDS, ...EXIT_PARTY_FIELDS];

/**
 * The two Ministry of Labour routes, and what choosing one asserts.
 *
 * ONE IS SIGNED, NEVER BOTH — the owner's instruction, 2026-08-30. The descriptions are here rather
 * than in a tooltip because the choice is a legal one and the person making it at 4pm on somebody's
 * last day should not have to remember which form says what.
 */
const EXIT_ROUTES: readonly { value: ExitRoute; labelEn: string; labelAr: string; note: string }[] =
  [
    {
      value: "resignation",
      labelEn: "Resignation",
      labelAr: "طلب استقالة",
      note: "The employee asked to leave, under مادة 167. They sign; the company accepts; the labour office endorses it.",
    },
    {
      value: "mutualTermination",
      labelEn: "Mutual termination",
      labelAr: "إنهاء بالتوافق",
      note: "Both parties agreed to end the contract. Three pages, seven clauses, signed by both sides.",
    },
  ];

/**
 * The two ends of one employment, shown one at a time. A person is only ever arriving or leaving on
 * the day HR prints, so the screen offers one package rather than one long scroll that mixes a
 * joining form with a departure form. Labels stay short so the two-segment switcher never has to
 * scroll sideways on a phone — the fits-the-screen rule (AGENTS.md §4).
 */
const PACKAGE_TABS = [
  { label: "New hires package", value: "newHire" },
  { label: "Leaver package", value: "leaver" },
] as const satisfies ReadonlyArray<{ label: string; value: "newHire" | "leaver" }>;

/**
 * How many copies a document is about to be produced in, from whatever is in its box.
 *
 * Shared by the print button and the preview so the two cannot disagree: a preview showing one copy
 * of a contract that prints as four is a preview of a different document, and the count is exactly
 * the sort of thing nobody re-checks after reading the page. The clamp matches the route's own —
 * see `resolveCopies` there — because a value the server would reject must not be shown here as
 * though it had been accepted.
 */
/**
 * A PAPER, FOR THE PURPOSES OF REMEMBERING SOMETHING ABOUT IT — the document and the template
 * version together, because two versions of the same paper can carry different mark positions and a
 * tick remembered against one of them would be describing the other. One function, used by both the
 * availability lookup and the remembered ticks, so the two can never key the same print differently.
 */
function printKeyOf(document: PrintableDocument, versionId?: string): string {
  return `${document}@${versionId ?? ""}`;
}

function resolveCopyCount(raw: string | undefined, document: PrintableDocument): number {
  const requested = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(requested) || requested < 1) return documentDefaultCopies(document);
  return Math.min(requested, 20);
}

type FormState = Record<string, string>;

function emptyForm(): FormState {
  const state: FormState = { notes: "" };
  for (const field of ALL_FIELDS) state[field.key] = "";
  return state;
}

function formFromPack(pack: HiringPackData): FormState {
  const state = emptyForm();
  for (const field of ALL_FIELDS) {
    const value = pack.profile[field.key];
    state[field.key] = value === null || value === undefined ? "" : String(value);
  }
  state.notes = pack.profile.notes ?? "";
  return state;
}

function payloadFromForm(state: FormState): HiringPackProfileInput {
  const payload: Record<string, string | number | null> = {};
  for (const field of ALL_FIELDS) {
    const raw = (state[field.key] ?? "").trim();
    if (!raw) {
      payload[field.key] = null;
      continue;
    }
    if (NUMBER_KEYS.has(field.key)) {
      const parsed = Number(raw);
      // A number field holding something unparseable is stored as nothing rather than as NaN, which
      // would otherwise reach the contract as the literal text "NaN months".
      payload[field.key] = Number.isFinite(parsed) ? parsed : null;
      continue;
    }
    payload[field.key] = raw;
  }
  payload.notes = state.notes.trim() ? state.notes.trim() : null;
  return payload as HiringPackProfileInput;
}

function emptyExitForm(): FormState {
  const state: FormState = { exitRoute: "", notes: "" };
  for (const field of ALL_EXIT_FIELDS) state[field.key] = "";
  return state;
}

function exitFormFromPack(pack: HiringPackData): FormState {
  const state = emptyExitForm();
  for (const field of ALL_EXIT_FIELDS) {
    const value = pack.offboarding[field.key];
    state[field.key] = value === null || value === undefined ? "" : String(value);
  }
  state.exitRoute = pack.offboarding.exitRoute ?? "";
  state.notes = pack.offboarding.notes ?? "";
  return state;
}

function exitPayloadFromForm(state: FormState): OffboardingProfileInput {
  const payload: Record<string, string | null> = {};
  for (const field of ALL_EXIT_FIELDS) {
    const raw = (state[field.key] ?? "").trim();
    payload[field.key] = raw ? raw : null;
  }
  // An unrecognised route is stored as nothing rather than as itself: the value decides which legal
  // template prints, so a typo must leave the choice unmade rather than make it wrongly.
  const route = (state.exitRoute ?? "").trim();
  payload.exitRoute = route === "resignation" || route === "mutualTermination" ? route : null;
  payload.notes = state.notes.trim() ? state.notes.trim() : null;
  return payload as OffboardingProfileInput;
}

/** The keys the facts editor writes — "What Phoenix already knows", once it stopped being read-only. */
const FACTS_KEYS = [
  "fullName",
  "nameAr",
  "nationalId",
  "socialInsuranceNumber",
  "birthDate",
  "hireDate",
  "jobTitle",
  "lineId",
  "baseSalary",
  "mobileNumber",
  "workEmail",
  "residenceAddress",
] as const;

/** Text/date fields on the facts editor. Salary and line get their own JSX — see below. */
const FACTS_TEXT_FIELDS: readonly {
  key: (typeof FACTS_KEYS)[number];
  labelEn: string;
  labelAr: string;
  kind: "text" | "date" | "email";
}[] = [
  { key: "fullName", labelAr: "الاسم", labelEn: "Name", kind: "text" },
  { key: "nameAr", labelAr: "الاسم بالعربية", labelEn: "Name (Arabic)", kind: "text" },
  { key: "nationalId", labelAr: "الرقم القومي", labelEn: "National ID", kind: "text" },
  {
    key: "socialInsuranceNumber",
    labelAr: "رقم التأمينات",
    labelEn: "Insurance no.",
    kind: "text",
  },
  { key: "birthDate", labelAr: "تاريخ الميلاد", labelEn: "Date of birth", kind: "date" },
  { key: "hireDate", labelAr: "تاريخ التعيين", labelEn: "Hire date", kind: "date" },
  { key: "jobTitle", labelAr: "المسمى الوظيفي", labelEn: "Job title", kind: "text" },
  { key: "mobileNumber", labelAr: "رقم الموبايل", labelEn: "Mobile", kind: "text" },
  { key: "workEmail", labelAr: "البريد الإلكتروني", labelEn: "Work email", kind: "email" },
  { key: "residenceAddress", labelAr: "العنوان", labelEn: "Address", kind: "text" },
];

function emptyFactsForm(): FormState {
  const state: FormState = {};
  for (const key of FACTS_KEYS) state[key] = "";
  return state;
}

function factsFormFromPack(pack: HiringPackData): FormState {
  const { employee } = pack;
  return {
    baseSalary: employee.baseSalary === null ? "" : String(employee.baseSalary),
    birthDate: employee.birthDate ?? "",
    fullName: employee.fullName,
    hireDate: employee.hireDate ?? "",
    jobTitle: employee.jobTitle ?? "",
    lineId: employee.lineId === null ? "" : String(employee.lineId),
    mobileNumber: employee.mobileNumber ?? "",
    nameAr: employee.nameAr ?? "",
    nationalId: employee.nationalId ?? "",
    residenceAddress: employee.residenceAddress ?? "",
    socialInsuranceNumber: employee.socialInsuranceNumber ?? "",
    workEmail: employee.workEmail ?? "",
  };
}

/** What the facts editor sends. Blank text clears the field; blank numbers and the line clear too. */
function factsPayloadFromForm(state: FormState) {
  const line = Number.parseInt(state.lineId ?? "", 10);
  const base = Number.parseFloat(state.baseSalary ?? "");
  return {
    baseSalary: Number.isFinite(base) ? base : null,
    birthDate: state.birthDate?.trim() || null,
    fullName: state.fullName?.trim() || null,
    hireDate: state.hireDate?.trim() || null,
    jobTitle: state.jobTitle?.trim() || null,
    lineId: Number.isFinite(line) ? line : null,
    mobileNumber: state.mobileNumber?.trim() || null,
    nameAr: state.nameAr?.trim() || null,
    nationalId: state.nationalId?.trim() || null,
    residenceAddress: state.residenceAddress?.trim() || null,
    socialInsuranceNumber: state.socialInsuranceNumber?.trim() || null,
    workEmail: state.workEmail?.trim() || null,
  };
}

/** A stored date, shown the way the owner reads dates.
 *
 * DATE-ONLY (hire / birth / contract dates, all `date` columns), pinned to UTC midnight. UTC
 * here is CORRECT and must stay: it is what stops the calendar day being shifted by a zone
 * offset. formatStamp below is the true INSTANT and correctly renders in Cairo. */
function formatDate(iso: string | null): string {
  if (!iso) return "Not recorded";
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return formatStableEnGb(parsed, {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });
}

/** A stored timestamp, in Cairo local time — never raw UTC. */
function formatStamp(iso: string | null): string {
  if (!iso) return "Not printed yet";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return formatStableEnGb(parsed, {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

/** One line per person — shared with the drive so both lists read the same. See `candidateOptionLabel`. */
function candidateLabel(candidate: HiringPackCandidate): string {
  return candidateOptionLabel(candidate);
}

function gapsFor(gaps: HiringPackGap[], document: HiringPackDocument): HiringPackGap[] {
  return gaps.filter((gap) => gap.documents.includes(document));
}

/**
 * Build a per-document record from one function.
 *
 * Written as an explicit object literal rather than a loop over the document list, because TypeScript
 * can then check that every document has an entry — which is the whole reason the copy counts and
 * signature dates are keyed this way. A `reduce` would type as a partial record and lose that.
 */
function signDatesShape(value: (document: HiringPackDocument) => string): Record<
  HiringPackDocument,
  string
> {
  return {
    contract: value("contract"),
    form1: value("form1"),
    workerDataForm: value("workerDataForm"),
    custodyLaptop: value("custodyLaptop"),
    custodyMobile: value("custodyMobile"),
    contractRenewal: value("contractRenewal"),
    contractNonRenewal: value("contractNonRenewal"),
    nda: value("nda"),
    appointmentDocsReceipt: value("appointmentDocsReceipt"),
    socialStatusSheet: value("socialStatusSheet"),
    absenceWarning: value("absenceWarning"),
    deemedResignation: value("deemedResignation"),
    appointmentDocsReturn: value("appointmentDocsReturn"),
    experienceCertificate: value("experienceCertificate"),
    experienceCertificateEn: value("experienceCertificateEn"),
    salaryLetterEn: value("salaryLetterEn"),
    salaryLetterAr: value("salaryLetterAr"),
    disciplinaryWarning: value("disciplinaryWarning"),
    disciplinaryPenalty: value("disciplinaryPenalty"),
    transferDecision: value("transferDecision"),
    salaryAdjustment: value("salaryAdjustment"),
    socialInsuranceAuthorization: value("socialInsuranceAuthorization"),
    healthInsuranceAuthorization: value("healthInsuranceAuthorization"),
    insurancePrintLetter: value("insurancePrintLetter"),
    handoverRecord: value("handoverRecord"),
    exitInterview: value("exitInterview"),
    maternityCompensation: value("maternityCompensation"),
    insuranceForm2: value("insuranceForm2"),
    carInsuranceCertificate: value("carInsuranceCertificate"),
    wageProgressSheet: value("wageProgressSheet"),
    officialHolidaysSheet: value("officialHolidaysSheet"),
    sickLeaveSheet: value("sickLeaveSheet"),
    penaltiesSheet: value("penaltiesSheet"),
    penaltyRegulationsApproval: value("penaltyRegulationsApproval"),
    form6: value("form6"),
    resignation: value("resignation"),
    mutualTermination: value("mutualTermination"),
    clearanceEmployee: value("clearanceEmployee"),
    clearanceCompany: value("clearanceCompany"),
  };
}

/** The signature dates already on file, ready to be edited. */
function signedDatesFromPack(pack: HiringPackData | null): Record<HiringPackDocument, string> {
  return {
    contract: pack?.profile.contractSignedDate ?? "",
    form1: pack?.profile.form1SignedDate ?? "",
    // The worker data form and the custody receipts store no signature date. The worker form is a
    // data-capture sheet, not a signable instrument (null binding, excluded from `SIGNABLE_DOCUMENTS`);
    // the custody receipts have no single date because one person can hold three devices on three
    // receipts. See `SIGNABLE_DOCUMENTS`.
    workerDataForm: "",
    custodyLaptop: "",
    custodyMobile: "",
    // The renewal papers store no signature date here either, and the register that answers them
    // properly already exists: `contract_renewal_requests` holds one row per renewal with its own
    // `signed_at`. A contract is renewed every year, so one date on the employee row could record
    // only the newest of them. See `RENEWAL_DOCUMENTS`.
    contractRenewal: "",
    contractNonRenewal: "",
    // Sato's own six store no signature date here either. Five are sheets filed in a drawer, and
    // the two absence notices are issued repeatedly. The NDA is the one worth a real register some
    // day — see the note in `SIGNABLE_DOCUMENTS`.
    // The NDA is the one of Sato's six with a real register — signed once in a career, like the
    // contract. The other five keep "" for the reasons in `SIGNABLE_DOCUMENTS`.
    nda: pack?.profile.ndaSignedDate ?? "",
    appointmentDocsReceipt: "",
    socialStatusSheet: "",
    absenceWarning: "",
    deemedResignation: "",
    appointmentDocsReturn: "",
    // Nobody signs a certificate of experience back — the company certifies it and hands it over —
    // and it is reissued whenever it is asked for, so one date here could hold only the newest.
    experienceCertificate: "",
    experienceCertificateEn: "",
    // The HR letter likewise: the company certifies it, nobody signs it back. Same for its Arabic
    // counterpart.
    salaryLetterEn: "",
    salaryLetterAr: "",
    // The letters pack of 2026-09-13: none records a date against the person — see DOCUMENT_BINDINGS.
    disciplinaryWarning: "",
    disciplinaryPenalty: "",
    transferDecision: "",
    salaryAdjustment: "",
    socialInsuranceAuthorization: "",
    healthInsuranceAuthorization: "",
    insurancePrintLetter: "",
    handoverRecord: "",
    exitInterview: "",
    maternityCompensation: "",
    insuranceForm2: "",
    carInsuranceCertificate: "",
    wageProgressSheet: "",
    officialHolidaysSheet: "",
    sickLeaveSheet: "",
    penaltiesSheet: "",
    penaltyRegulationsApproval: "",
    form6: pack?.offboarding.form6SignedDate ?? "",
    resignation: pack?.offboarding.resignationSignedDate ?? "",
    mutualTermination: pack?.offboarding.mutualTerminationSignedDate ?? "",
    // Two dates, not one. The clearance pair are complements, and in practice they are signed days
    // apart — the departmental sign-offs finish first, the release is signed when the settlement is
    // handed over. See `CLEARANCE_DOCUMENTS`.
    clearanceEmployee: pack?.offboarding.clearanceEmployeeSignedDate ?? "",
    clearanceCompany: pack?.offboarding.clearanceCompanySignedDate ?? "",
  };
}

/**
 * The paper open on screen, shaped as the two props the editor reads it through.
 *
 * SHAPED THAT WAY DELIBERATELY, so it can be spread straight into `HiringPackPaperEditor` and the
 * two fields stay CORRELATED. `documentKey` and `versionId` are not independent — an uploaded
 * company template must carry its version and one of the ten need not — and passing them as two
 * separate props hands the compiler two separate questions it cannot relate. Spread as one object,
 * the union is checked as the single fact it is.
 */
type OpenPaper =
  | { documentKey: HiringPackDocument; versionId: string | null }
  | { documentKey: CustomHiringPackDocument; versionId: string };

type Props = {
  canManage: boolean;
  candidates: HiringPackCandidate[];
  initialError: string | null;
  initialPack: HiringPackData | null;
  /** Every sales line, for the "Department" picker on the facts editor. */
  lines: { id: number; name: string }[];
  /**
   * The papers this viewer is limited to, or null (the default) for every paper. Set for a seat
   * named in SEAT_PRINTABLE_DOCUMENTS (none today) from `hrFormsAccessFor` on the server. Every card, the drive and the package lists show only these;
   * the company templates, the Archive, the Template Studio, the contract's own "What you fill in"
   * and the layout editor are not offered. The server refuses everything else regardless — this is
   * so nothing on her screen 403s her halfway.
   */
  paperScope?: readonly HiringPackDocument[] | null;
  /** True for the salary-blind seat: the salary shows and prints, and its box does not take a change. */
  salaryReadOnly?: boolean;
  /** True for the same seat: the contract terms show and print, and take no change. */
  contractTermsReadOnly?: boolean;
  /**
   * Where the bank account-opening letter lives, or null to offer no link. Passed only by the admin
   * page, and only for a viewer the letter's own gate admits (not a paper-scoped seat).
   */
  bankLetterHref?: string | null;
};

/**
 * The hiring profile is the contract's own terms, and its route stays employee_documents:update —
 * so a seat limited to its own papers sees those values locked on the page rather than typing over
 * them and being refused. Module scope so the editor's frame wiring is not re-run every render.
 */
const SCOPED_SEAT_READ_ONLY_STORES: readonly PaperStore[] = ["profile"];

/** What a seat limited to its own papers is offered of the company templates: nothing. Stable. */
const NO_TEMPLATES: StoredTemplate[] = [];

/**
 * Which papers this screen offers — null for every paper. Read by `DocumentCard`, so a card outside
 * the viewer's papers renders nothing and each call site stays exactly as it was.
 */
const PaperScopeContext = createContext<readonly HiringPackDocument[] | null>(null);

export function HiringPackManager({
  bankLetterHref = null,
  canManage,
  candidates,
  initialError,
  initialPack,
  lines,
  paperScope = null,
  salaryReadOnly = false,
  contractTermsReadOnly = false,
}: Props) {
  const scoped = paperScope !== null;
  const [pack, setPack] = useState<HiringPackData | null>(initialPack);
  const [selectedHrId, setSelectedHrId] = useState(initialPack?.employee.hrId ?? "");
  const [form, setForm] = useState<FormState>(initialPack ? formFromPack(initialPack) : emptyForm());
  const [exitForm, setExitForm] = useState<FormState>(
    initialPack ? exitFormFromPack(initialPack) : emptyExitForm(),
  );
  const [factsForm, setFactsForm] = useState<FormState>(
    initialPack ? factsFormFromPack(initialPack) : emptyFactsForm(),
  );
  // What the papers will print as the insurance wage, off the base salary AS TYPED — not off the
  // saved record. Someone correcting a base salary should see the insurance wage move with it
  // before they press Save, because that figure goes on Form 1 and they cannot edit it directly.
  const typedInsuranceWage = insuranceWageFromBase(Number.parseFloat(factsForm.baseSalary ?? ""));
  // KEYED BY STRING, SEEDED EXHAUSTIVELY. The seed is still the explicit ten-key literal, so the
  // compiler still refuses a built-in document with no starting value — that check is the whole
  // reason `signDatesShape` is written as a literal. What the wider key type buys is a company
  // template being able to carry a copy count and a signed date like any other paper, without
  // every uploaded document having to exist at compile time, which is impossible by construction.
  const [copies, setCopies] = useState<Record<string, string>>(() =>
    signDatesShape((document) => String(documentDefaultCopies(document))),
  );
  const [signDates, setSignDates] = useState<Record<string, string>>(() =>
    signedDatesFromPack(initialPack),
  );
  const [busy, setBusy] = useState<
    "" | "load" | "save" | "save-exit" | "save-facts" | `sign-${HiringPackDocument}`
  >("");
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Which document is open on screen as the page it prints as, if any.
   *
   * AS WIDE AS `openPrint` NOW — an uploaded company template opens in the editor like any of the
   * ten. It was deliberately narrower until the editor could resolve a version for one: the paper
   * editor scopes its whole field layer to a version id, and the ten have a COMPILED answer
   * (`currentTemplateVersion`) that an uploaded template has no entry in and cannot have one in.
   * Opening one before that was settled would have dropped boxes against a version of `undefined`
   * — saved with a 200, read back by nothing, and shown as an empty paper.
   *
   * `PaperEditorProps` now carries that rule in its own type: a company template cannot be handed
   * to the editor without its version, so this state can be as wide as printing is.
   *
   * `versionId` is set from the Archive, where the point is to look at a SUPERSEDED template, and
   * for every company template, where it is the template row's own id. Null means what it means to
   * the print route: not "the current text", but "whichever version this employee's signature
   * resolves to".
   */
  const [preview, setPreview] = useState<OpenPaper | null>(null);
  /**
   * The uploaded company templates — read ONCE here and shared with everything that shows them.
   *
   * This screen, the Studio at the foot of it, and each package tab all list the same papers. The
   * list used to belong to the Studio and load when that panel was opened, which was right while
   * the Studio was the only place they appeared; it stopped being right when a template filed under
   * "New hires package" had to sit in that tab whether or not anybody opened the Studio today.
   */
  const companyTemplates = useCompanyTemplates();
  /**
   * What the uploaded templates are CALLED, so a company paper opens under its own name.
   *
   * The ten have their labels compiled in; an uploaded template's name is a database row, which is
   * the entire point of being able to upload one. `documentLabel` falls back to "Company template"
   * while the list is still in flight — a fallback, never a wrong name.
   */
  const customTemplateNames: CustomDocumentNames = useMemo(
    () => templateNamesOf(companyTemplates.templates),
    [companyTemplates.templates],
  );
  /**
   * The uploaded templates each package tab shows.
   *
   * CURRENT VERSIONS ONLY. An archived row is a superseded edition of a paper the company has since
   * replaced — it stays readable through the Archive, where the version being asked for is the whole
   * point, but offering it here would put two spellings of the same form side by side with nothing
   * on screen saying which one is in force.
   *
   * `other` IS FILED IN NEITHER, on purpose. A paper the uploader declined to put in a package is
   * exactly a paper that belongs to no package; listing it in both would make the two packages stop
   * meaning anything. It stays in the Studio under its own heading.
   */
  const joiningTemplates = useMemo(
    () =>
      companyTemplates.templates.filter(
        (template) => template.group === "joining" && template.status === "current",
      ),
    [companyTemplates.templates],
  );
  const leavingTemplates = useMemo(
    () =>
      companyTemplates.templates.filter(
        (template) => template.group === "leaving" && template.status === "current",
      ),
    [companyTemplates.templates],
  );
  /**
   * Which package is on screen. The joining papers and the leaving papers are one workflow seen from
   * two ends (see the file header), but a person is only ever at one end on the day HR prints, so the
   * screen shows one package at a time rather than a single scroll that mixes an arrival form with a
   * departure form. The facts editors, their Save buttons and every document card keep their own
   * state regardless of which package is showing — switching is a view, it saves and discards nothing.
   */
  const [activePackage, setActivePackage] = useState<"newHire" | "leaver">("newHire");

  const blockingGaps = useMemo(() => (pack?.gaps ?? []).filter((gap) => gap.blocking), [pack]);
  const advisoryGaps = useMemo(() => (pack?.gaps ?? []).filter((gap) => !gap.blocking), [pack]);

  /**
   * Which exit route is in play right now — what has been typed, falling back to what is saved.
   *
   * Read from the unsaved form rather than from the pack so the two labour cards swap the moment
   * the choice is made, instead of only after a save. The chosen route is what decides which of the
   * two templates can be printed at all: they are alternatives, and only one is ever signed.
   */
  const exitRoute: ExitRoute | null =
    exitForm.exitRoute === "resignation" || exitForm.exitRoute === "mutualTermination"
      ? exitForm.exitRoute
      : null;

  const applyPack = useCallback((next: HiringPackData) => {
    setPack(next);
    setForm(formFromPack(next));
    setExitForm(exitFormFromPack(next));
    setFactsForm(factsFormFromPack(next));
    setSignDates(signedDatesFromPack(next));
  }, []);

  const readError = useCallback(async (response: Response) => {
    try {
      const body = (await response.json()) as { message?: string };
      return body.message ?? `Request failed (${response.status}).`;
    } catch {
      return `Request failed (${response.status}).`;
    }
  }, []);

  // Answers whether the employee's pack is now loaded, so the drive knows whether to open a paper.
  const selectEmployee = useCallback(
    async (hrId: string): Promise<boolean> => {
      setSelectedHrId(hrId);
      setNotice(null);
      setError(null);
      // A preview is one person's paper. Leaving it open across a change of employee would show the
      // previous person's document under the new person's name until it happened to reload.
      setPreview(null);
      if (!hrId) {
        setPack(null);
        setForm(emptyForm());
        return false;
      }
      setBusy("load");
      try {
        const response = await fetch(`/api/hiring-pack/${encodeURIComponent(hrId)}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          setPack(null);
          setError(await readError(response));
          return false;
        }
        applyPack((await response.json()) as HiringPackData);
        return true;
      } catch (cause) {
        setPack(null);
        setError(cause instanceof Error ? cause.message : "Could not load this employee.");
        return false;
      } finally {
        setBusy("");
      }
    },
    [applyPack, readError],
  );

  const save = useCallback(async () => {
    if (!pack) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/hiring-pack/${encodeURIComponent(pack.employee.hrId)}`, {
        body: JSON.stringify(payloadFromForm(form)),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      applyPack((await response.json()) as HiringPackData);
      setNotice("Saved. The documents will print with these values.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setBusy("");
    }
  }, [applyPack, form, pack, readError]);

  /**
   * Save the exit fields.
   *
   * A separate request to a separate endpoint writing a separate table — see the offboarding route's
   * own note. Nothing typed in the end-of-service section can reach a value the signed employment
   * contract was printed from.
   */
  const saveExit = useCallback(async () => {
    if (!pack) return;
    setBusy("save-exit");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/hiring-pack/${encodeURIComponent(pack.employee.hrId)}/offboarding`,
        {
          body: JSON.stringify(exitPayloadFromForm(exitForm)),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        },
      );
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      applyPack((await response.json()) as HiringPackData);
      setNotice("Saved. The exit documents will print with these values.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setBusy("");
    }
  }, [applyPack, exitForm, pack, readError]);

  /**
   * Save "What Phoenix already knows" — the employee record itself, not a hiring-pack satellite
   * table. See `saveHiringPackEmployeeFacts` for why departed employees only get the identity and
   * contact fields written: salary and department go through the same full-record path the
   * employee editor uses, and that path refuses anyone already resigned or terminated.
   */
  const saveFacts = useCallback(async () => {
    if (!pack) return;
    setBusy("save-facts");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/hiring-pack/${encodeURIComponent(pack.employee.hrId)}/facts`, {
        body: JSON.stringify(factsPayloadFromForm(factsForm)),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      applyPack((await response.json()) as HiringPackData);
      setNotice("Saved to the employee record.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setBusy("");
    }
  }, [applyPack, factsForm, pack, readError]);

  /**
   * Printing opens the rendered document in its own tab, where the browser's own print dialog does
   * the rest. That is on purpose: the browser is the only thing in the stack that lays Arabic out
   * correctly, and "Print → Save as PDF" from that tab produces a real PDF with selectable text.
   *
   * RETURNS WHETHER A TAB ACTUALLY OPENED. `window.open` answers null when a popup blocker stops
   * it, and that silence is the difference between "your paper is printing" and nothing visibly
   * happening at all. Confirming a signature reports it as its own outcome.
   */
  const openPrint = useCallback(
    (
      document: PrintableDocument,
      versionId?: string,
      copiesOverride?: number,
      address?: PrintAddressChoice | null,
      marks?: readonly DocumentMark[],
    ): boolean => {
      if (!pack) return false;
      // AN EXPLICIT COUNT WINS, and it has to, because this function ALWAYS sends `copies` in the
      // URL. The server has a default of its own — a company template's is on its row — but a
      // parameter that is always present means the server's default is never reached. A caller with
      // no Copies box on screen, which is every company-template row, passes the template's own
      // number here rather than letting the box's absence silently mean one.
      const count = copiesOverride ?? resolveCopyCount(copies[document], document);
      // No `version` parameter is the normal case, and it does NOT mean "print the current text":
      // the route resolves the version this employee signed. The parameter is only for deliberately
      // asking for a superseded template from the Archive.
      const version = versionId ? `&version=${encodeURIComponent(versionId)}` : "";
      // The company address chosen at the desk travels the same way. Absent — the automatic print after
      // a signature, an old link — is the registered head office, as it always was.
      const addressPart = address ? `&address=${address}` : "";
      // THE MARKS TICKED FOR THIS PRINT, and nothing when none were - which is the usual answer and
      // the safe one. Absent means the server stamps nothing, so every link that predates this
      // parameter, including the automatic print after a signature, prints the paper unstamped
      // exactly as it always did.
      const marksPart = marks && marks.length > 0 ? `&marks=${marks.join(",")}` : "";
      const url = `/api/hiring-pack/${encodeURIComponent(pack.employee.hrId)}/print?document=${document}&copies=${count}${addressPart}${marksPart}${version}`;
      return window.open(url, "_blank", "noopener,noreferrer") !== null;
    },
    [copies, pack],
  );

  /**
   * EVERY PRINT BUTTON ASKS FIRST — how many copies, and which company address (owner, 2026-09-20).
   * The click only records what is being printed; `PrintOptionsDialog` below puts the two questions
   * to the desk, and only its Print button reaches `openPrint`. The count is written back into the
   * row's Copies box so the preview, the box and the paper agree about how many were asked for.
   */
  const [printRequest, setPrintRequest] = useState<{
    copiesOverride?: number;
    document: PrintableDocument;
    versionId?: string;
  } | null>(null);
  // Kept across prints in this session as the dialog's starting point — never as an answer: Print
  // stays disabled until the desk has picked an address at least once.
  const [lastAddress, setLastAddress] = useState<PrintAddressChoice | null>(null);

  /**
   * WHAT WAS TICKED LAST TIME EACH PAPER WAS PRINTED, keyed by paper and version.
   *
   * The owner, 2026-09-29: "make the print dialog remember the last tick for the same paper."
   * PER PAPER and not one global answer, because the papers genuinely differ - a certificate of
   * experience going to a third party wants the seal, an internal data sheet does not - and a single
   * remembered tick would carry the wrong one across.
   *
   * IN SESSION STATE, NOT STORAGE, exactly like `lastAddress` above. A tick that survived a reload
   * would be a standing instruction to stamp, which is the thing he ruled against; one that lives as
   * long as the tab is a convenience that cannot outlast the person using it.
   */
  const [lastMarks, setLastMarks] = useState<Record<string, DocumentMark[]>>({});

  /**
   * WHICH MARKS THE PAPER BEING PRINTED HAS A POSITION FOR — read when the dialog opens, and reset
   * to none the moment it closes.
   *
   * Fetched rather than remembered, because the answer belongs to the paper and the layout can have
   * changed since the last print. It starts EMPTY for every new request, so a paper whose layout
   * cannot be read offers no tick-boxes at all rather than inheriting the last one's — the failure
   * that matters here is offering a stamp that lands nowhere, not failing to offer one.
   */
  const [markLookup, setMarkLookup] = useState<{ key: string; marks: DocumentMark[] } | null>(null);

  /**
   * DERIVED, NOT RESET. The lookup carries the paper it belongs to, and anything that is not the
   * paper on screen reads as "no marks offered" without a state write — which is what keeps the
   * effect below free of a synchronous setState (`react-hooks/set-state-in-effect` is an error in
   * this repo) and, more usefully, makes a stale answer structurally impossible rather than
   * something a cleanup has to remember to clear.
   */
  const printRequestKey = printRequest ? printKeyOf(printRequest.document, printRequest.versionId) : "";
  const availableMarks =
    printRequest && markLookup?.key === printRequestKey ? markLookup.marks : [];

  useEffect(() => {
    if (!printRequest) return;
    const { document, versionId } = printRequest;
    // A built-in prints the version the employee signed unless one was named; the layout is keyed to
    // that same version, so the two have to be resolved the same way or the tick-box would describe
    // a different paper from the one about to print.
    const version =
      versionId ?? (isBuiltInDocument(document) ? currentTemplateVersion(document).id : null);
    if (!version) return;
    let live = true;
    void fetch(
      `/api/hiring-pack/document-fields?document=${encodeURIComponent(document)}` +
        `&templateVersionId=${encodeURIComponent(version)}`,
      { cache: "no-store" },
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { fields?: unknown } | null) => {
        if (!live || !body || !Array.isArray(body.fields)) return;
        setMarkLookup({ key: `${document}@${versionId ?? ""}`, marks: marksPlacedOn(body.fields) });
      })
      .catch(() => {
        // Offer nothing rather than guess. See the note above.
      });
    return () => {
      live = false;
    };
  }, [printRequest]);
  const requestPrint = useCallback(
    (document: PrintableDocument, versionId?: string, copiesOverride?: number) =>
      setPrintRequest({ copiesOverride, document, versionId }),
    [setPrintRequest],
  );
  const recordSignature = useCallback(
    async (document: HiringPackDocument) => {
      if (!pack) return;
      const signedDate = signDates[document];
      if (!signedDate) {
        setError("Enter the date written on the signed paper first.");
        return;
      }
      setBusy(`sign-${document}`);
      setError(null);
      setNotice(null);
      try {
        const response = await fetch(
          `/api/hiring-pack/${encodeURIComponent(pack.employee.hrId)}/sign`,
          {
            body: JSON.stringify({ document, signedDate }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        if (!response.ok) {
          setError(await readError(response));
          return;
        }
        const result = (await response.json()) as {
          filing: { filed: true; fileName: string; slotName: string } | { filed: false; why: string };
          pack: HiringPackData;
        };
        applyPack(result.pack);

        // ─────────────────────────────────────────────────────────────────────────────────────
        // THE SECOND OUTCOME. The signature is recorded by the time this runs, so everything
        // below is about telling the truth about the other two things — whether a copy reached
        // the employee's file, and whether the paper is on its way to a printer.
        //
        // The print tab is opened AFTER the response rather than before it. Opening first would
        // feel faster, and would put a tab in front of somebody a moment before telling them
        // their signature failed to record.
        // ─────────────────────────────────────────────────────────────────────────────────────
        const printed = openPrint(document);
        const signedLine = `${documentLabel(document)} recorded as signed on ${formatDate(signedDate)}.`;
        const printLine = printed
          ? "The print tab is open."
          : "The print tab was blocked by your browser — use Print on the row to open it.";

        if (result.filing.filed) {
          setNotice(`${signedLine} A copy is filed under "${result.filing.slotName}". ${printLine}`);
        } else {
          // NOT `setError`. Nothing failed that the person did: the signature is recorded and the
          // paper prints. Putting this in the error banner would report a successful confirm as a
          // failure, and the next thing somebody does with a failed confirm is do it again.
          setNotice(`${signedLine} ${result.filing.why} ${printLine}`);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not record the signature.");
      } finally {
        setBusy("");
      }
    },
    [applyPack, openPrint, pack, readError, signDates],
  );

  /**
   * Open a document on screen as the page it prints as.
   *
   * Deliberately does NOT go through `openPrint`: the preview asks the same route for the same
   * bytes but with `preview=1`, which is what stops a look at the paper being recorded as a print.
   */
  const openPreview = useCallback((document: PrintableDocument, versionId?: string) => {
    setError(null);
    setNotice(null);

    if (isBuiltInDocument(document)) {
      setPreview({ documentKey: document, versionId: versionId ?? null });
      return;
    }

    /*
      A COMPANY TEMPLATE WITHOUT ITS VERSION CANNOT BE OPENED, and this is the one place that has
      to say so out loud. Every caller that offers one has just listed it and holds the row, so
      this is unreachable in practice — but "unreachable in practice" is exactly the kind of claim
      that stops being true when a new caller is added, and the failure it would cause is silent:
      boxes saved against a scope nothing reads back, on a paper that then renders empty.
    */
    if (!versionId) {
      setError("That company template could not be opened — its version is not known.");
      return;
    }

    setPreview({ documentKey: document, versionId });
  }, []);

  /**
   * Open or print one uploaded company template against the employee on screen.
   *
   * NARROWED, NEVER CAST. `template.document` arrives as a plain string from the database, and
   * `asPrintableDocument` is the one thing that decides whether it names a paper this build can
   * render. A cast would compile identically and then hand `openPrint` a document key the route has
   * no case for — which returns an empty page rather than an error, on a form somebody signs.
   *
   * THE ROW'S OWN ID IS THE VERSION. A template's `key` is its identity across every edition; the
   * `id` is this edition. Printing without a version asks the route to resolve the one the employee
   * signed, which is right for the built-ins and wrong here: the operator has just clicked a
   * specific row in a specific list, so that is the paper to open.
   */
  const openTemplate = useCallback(
    (template: StoredTemplate, how: "preview" | "print") => {
      const document = asPrintableDocument(template.document);
      if (!document) {
        setError(
          `"${template.name}" cannot be opened — its document id is not one this system recognises.`,
        );
        return;
      }
      if (how === "print") requestPrint(document, template.id, template.defaultCopies);
      else openPreview(document, template.id);
    },
    [openPreview, requestPrint],
  );

  /**
   * A paper pressed in the drive, for one employee: load them (unless already loaded) and open the
   * paper in the editor, which sits directly under the drive.
   */
  const editorRef = useRef<HTMLDivElement>(null);
  const openForEmployee = useCallback(
    async (entry: FormsDriveEntry, hrId: string) => {
      const loaded = pack?.employee.hrId === hrId && selectedHrId === hrId ? true : await selectEmployee(hrId);
      if (!loaded) return;
      openPreview(entry.document, entry.versionId ?? undefined);
      window.requestAnimationFrame(() =>
        editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    },
    [openPreview, pack, selectEmployee, selectedHrId],
  );

  const setCopiesFor = useCallback((document: PrintableDocument, value: string) => {
    setCopies((current) => ({ ...current, [document]: value }));
  }, []);

  const confirmPrint = useCallback(
    (answer: PrintAnswer) => {
      if (!printRequest) return;
      const { document, versionId } = printRequest;
      setPrintRequest(null);
      if (answer.address) setLastAddress(answer.address);
      // Remembered against the paper the dialog was opened for, so the next print of THIS paper
      // starts where this one ended. Recorded even when empty: unticking is an answer too, and a
      // deliberate "no stamp this time" must not be overwritten by the previous yes.
      setLastMarks((current) => ({ ...current, [printKeyOf(document, versionId)]: answer.marks }));
      setCopiesFor(document, String(answer.copies));
      if (!openPrint(document, versionId, answer.copies, answer.address, answer.marks)) {
        setError("The print tab was blocked by your browser — allow pop-ups for this site and print again.");
      }
    },
    [openPrint, printRequest, setCopiesFor, setPrintRequest],
  );

  const setSignDateFor = useCallback((document: HiringPackDocument, value: string) => {
    setSignDates((current) => ({ ...current, [document]: value }));
  }, []);

  /**
   * THE LEAVING TAB LISTS LEAVERS — the owner's bug report, 2026-09-13: "if i choose a document
   * related to resignations the drop list of employees who resigned appear". Every paper on that tab
   * is a leaving paper, so the list follows it. The person already loaded stays in the list, or the
   * box would empty itself the moment the tab is switched while their pack is still on screen.
   * (A certificate of experience for somebody still employed is issued from the drive's Leaving
   * folder, which lists everyone for those two papers.)
   */
  const pickerCandidates = useMemo(
    () =>
      activePackage === "leaver"
        ? candidates.filter((candidate) => candidate.departed || candidate.hrId === selectedHrId)
        : candidates,
    [activePackage, candidates, selectedHrId],
  );

  const departedCount = candidates.filter((candidate) => candidate.departed).length;
  const currentCount = candidates.length - departedCount;

  const employee = pack?.employee ?? null;

  // THE OUTER WRAPPER IS `overflow-clip`, NOT `overflow-hidden`, AND THE STICKY PICKER IS THE
  // WHOLE REASON. Both clip a child to the rounded corners and both paint identically. The
  // difference is that `hidden` makes the div a SCROLL CONTAINER and `clip` does not — and
  // `position: sticky` sticks to the nearest scroll container. With `hidden` the picker stuck to
  // a box that never scrolls, which looks exactly like sticky being broken: measured, the bar's own
  // top read -1183px at a scroll of 1500. With `clip` the nearest scroll container is the page, so
  // it sticks to the viewport, and the corners are still clipped.
  return (
    <PaperScopeContext.Provider value={paperScope}>
    <div className="relative overflow-clip">
      <div className="flex flex-col gap-5">
        <AdminPageHero
          actions={
            bankLetterHref ? (
              <Button asChild className="h-10" variant="secondary">
                <Link href={bankLetterHref}>
                  <Landmark />
                  Bank account letter
                </Link>
              </Button>
            ) : null
          }
          description={`Open a folder and press the paper you need. Fill it from an employee's record or type it in; every print is numbered. ${currentCount} on staff, ${departedCount} left.`}
          eyebrow="Employee documents"
          icon={<FileSignature className="h-5 w-5" />}
          title="HR Forms"
        />

        {error || notice ? (
          <div aria-live="polite" className="sticky top-28 z-20 flex flex-col gap-2">
            {error ? (
              <AdminCallout tone="danger">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </AdminCallout>
            ) : null}
            {notice ? (
              <AdminCallout tone="success">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{notice}</span>
              </AdminCallout>
            ) : null}
          </div>
        ) : null}

        {/*
          THE OPEN DOCUMENT SITS AT THE TOP, above the fill boxes rather than beside the card it was
          opened from. Whichever of the nine is open, it appears in the same place — and the values
          in it are the same values the boxes below hold, so having both on screen at once is what
          makes the connection between them obvious instead of something to be learned.
        */}
        <FormsDrive
          candidates={candidates}
          loadingEmployee={busy === "load"}
          onOpenForEmployee={(entry, hrId) => void openForEmployee(entry, hrId)}
          paperScope={paperScope}
          selectedHrId={selectedHrId}
          templates={scoped ? NO_TEMPLATES : companyTemplates.templates}
        />

        <div className="scroll-mt-4" ref={editorRef} />
        {pack && preview ? (
          <HiringPackPaperEditor
            // THE SAME AUTHORITY THE COMPANY-TEMPLATE UPLOAD USES, and the same one the
            // company-details route enforces: Super Admin, answered by the SERVER rather than
            // guessed from a role in the browser. Changing what every future contract states about
            // the employer is that class of act, not the class of correcting one person's ID.
            canEditCompany={companyTemplates.canManage}
            // A seat limited to its own papers: no layout editing and the hiring profile locked.
            // The salary is locked on the salary-blind seat, which sees and prints it.
            canEditLayout={!scoped}
            readOnlyStores={scoped ? SCOPED_SEAT_READ_ONLY_STORES : undefined}
            salaryReadOnly={salaryReadOnly}
            contractTermsReadOnly={contractTermsReadOnly}
            copies={resolveCopyCount(copies[preview.documentKey], preview.documentKey)}
            documentLabel={documentLabel(preview.documentKey, customTemplateNames)}
            hrId={pack.employee.hrId}
            key={`${pack.employee.hrId}-${preview.documentKey}-${preview.versionId ?? "current"}`}
            onClose={() => setPreview(null)}
            onIssueReference={() =>
              issuePaperReference({
                copies: resolveCopyCount(copies[preview.documentKey], preview.documentKey),
                document: preview.documentKey,
                documentLabel: documentLabel(preview.documentKey, customTemplateNames),
                hrId: pack.employee.hrId,
                mode: "employee",
                subjectName: pack.employee.nameAr ?? pack.employee.fullName,
              })
            }
            onPackChange={applyPack}
            pack={pack}
            {...preview}
          />
        ) : null}

        {/*
          THE PICKER IS A BAR, NOT A SECTION.

          It used to be a full card: a heading, a two-line description of how the list is sorted, a
          label, and then the one control — 230px of chrome around a dropdown, measured at 1440px,
          on a page that runs past 4,000px. Everything the description explained is visible in the
          list itself the moment it opens, so it was being paid for twice. As a bar it is 66px, and
          the name sitting in the box now does the job the heading used to: it says who you are
          printing for.

          IT FOLLOWS THE PAGE, because the work here is one person's papers and then the next
          person's, and from the foot of a 4,000px page changing person meant scrolling all the way
          back up. What stopped it sticking was not this bar and not a shared component — it was
          this page's OWN outer wrapper being `overflow-hidden`, which makes it a scroll container
          for sticky purposes. That is now `overflow-clip`: same clipping, no scroll container, and
          nothing outside this file was touched. See the note on the wrapper above.

          `z-30` sits above the page body and below the SearchableSelect's dropdown, which portals
          to the document and carries its own stacking.
        */}
        <div className="sticky top-2 z-30 border border-phx-line bg-white px-4 py-3 shadow-none sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <label
              className="flex shrink-0 items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft"
              htmlFor="hiring-pack-employee"
            >
              <UserRound className="h-4 w-4 text-phx-accent-press" />
              Employee
            </label>
            {/*
              THE `flex-1` GOES ON THIS WRAPPER, NOT ON THE CONTROL, and that is not a tidy-up.
              `SearchableSelect` puts `className` on its INPUT and renders its own
              `<div className="relative">` around it — so a `flex-1` passed in landed on a
              `w-full` child of a plain block, and the block sized itself to its content. Measured
              at a 1440px viewport: the box came out 207px wide in a row with room for over 1100,
              and the value read "AI-0018 · SamahAshraf · M" with the job title simply gone.
            */}
            <div className="min-w-0 flex-1">
              <SearchableSelect
                className={cn(inputClassName, "w-full")}
                disabled={busy === "load"}
                id="hiring-pack-employee"
                onValueChange={(value) => void selectEmployee(value)}
                placeholder="Search by HR ID, name, job title or the date they left"
                value={selectedHrId}
              >
                <option value="">Select an employee</option>
                {pickerCandidates.map((candidate) => (
                  <option key={candidate.hrId} value={candidate.hrId}>
                    {candidateLabel(candidate)}
                  </option>
                ))}
              </SearchableSelect>
            </div>
            {busy === "load" ? (
              <p className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-phx-ink-soft">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </p>
            ) : null}
          </div>
        </div>

        {pack && employee ? (
          <>
            {/*
              ONE STATUS BAND WHERE THERE WERE FOUR CARDS AND A CALLOUT UNDER THEM.

              Two of those cards were counts — "Blocking gaps 7", "To fill later 3" — sitting
              directly above a callout that said "7 values … are still missing" and then listed all
              seven by name. A number beside the list it counts is the number read twice, and it
              cost 322px to do it.

              So the counts are now the headings of the lists themselves: the chips ARE the count,
              and they say which values rather than how many. Nothing was dropped — the advisory
              gaps were never listed anywhere before, only counted, so this band shows strictly more
              than the row it replaces, in under half the height.
            */}
            <div className="border border-phx-line bg-white p-4 shadow-none sm:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <SignaturePill
                  icon={<FileText className="h-4 w-4" />}
                  label="Contract"
                  signedDate={pack.profile.contractSignedDate}
                />
                <SignaturePill
                  icon={<ShieldCheck className="h-4 w-4" />}
                  label="Form 1"
                  signedDate={pack.profile.form1SignedDate}
                />
              </div>

              {blockingGaps.length > 0 || advisoryGaps.length > 0 ? (
                <div className="mt-4 flex flex-col gap-3 border-t border-phx-line pt-4">
                  {blockingGaps.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      <p className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-rose-700">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {blockingGaps.length} value{blockingGaps.length === 1 ? "" : "s"} the
                        documents ask for — they print blank rather than guessed
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {blockingGaps.map((gap) => (
                          <Badge key={gap.field} tone="danger">
                            {gap.labelEn} · {gap.labelAr}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {advisoryGaps.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      <p className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-sky-700">
                        <CalendarCheck className="h-3.5 w-3.5" />
                        {advisoryGaps.length} to fill in later — the documents print without them
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {advisoryGaps.map((gap) => (
                          <Badge key={gap.field} tone="info">
                            {gap.labelEn} · {gap.labelAr}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <p className="text-xs leading-5 text-phx-ink-faint">
                    Employee-record values are fixed on the employee below. Company-settings values
                    are the company&apos;s own registration numbers, and are missing for every
                    employee until they are supplied once.
                  </p>
                </div>
              ) : null}
            </div>

            <AdminTableShell
              action={
                canManage ? (
                  <Button
                    className="h-10 gap-2"
                    disabled={busy === "save-facts"}
                    onClick={() => void saveFacts()}
                  >
                    {busy === "save-facts" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    Save
                  </Button>
                ) : undefined
              }
              description="Editing here writes straight to the employee record — every other screen reads the change from the same place."
              title={`What Phoenix already knows · ${employee.fullName}`}
            >
              <div className="flex flex-col gap-6 px-5 py-5 sm:px-6">
                <div className="border-l-[3px] border-phx-accent pl-3 sm:max-w-xs">
                  <span className={factLabelClassName}>HR ID</span>
                  <p className="mt-1 text-sm font-bold text-phx-ink" dir="auto">
                    {employee.hrId}
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {FACTS_TEXT_FIELDS.map((field) => (
                    <div key={field.key}>
                      <label className={labelClassName} htmlFor={`hiring-pack-fact-${field.key}`}>
                        {field.labelEn} <span className="text-phx-ink-faint">{field.labelAr}</span>
                      </label>
                      <Input
                        className={inputClassName}
                        disabled={!canManage}
                        id={`hiring-pack-fact-${field.key}`}
                        onChange={(event) =>
                          setFactsForm((current) => ({ ...current, [field.key]: event.target.value }))
                        }
                        type={field.kind}
                        value={factsForm[field.key] ?? ""}
                      />
                    </div>
                  ))}
                </div>

                <div>
                  <h3 className="text-sm font-black uppercase tracking-[0.1em] text-phx-ink">
                    Salary, line and department
                  </h3>
                  <p className="mt-0.5 text-xs font-semibold text-phx-ink-soft">
                    {employee.departed
                      ? "This person has left, so these stay locked here — pay after departure runs through the resignation/settlement workflow, not this screen."
                      : "Changes here go through the same record the payroll and organogram tools read."}
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {/*
                      READ ONLY ON THE SALARY-BLIND SEAT. The HR Operations Specialist sees and prints
                      the salary here (owner, 2026-11-02, "FULL MODULE"), but payroll reads this field
                      and changing pay was not named, so the server drops one she sends
                      (factsInputForViewer) and the box says so by being locked.
                    */}
                    <div>
                      <label className={labelClassName} htmlFor="hiring-pack-fact-baseSalary">
                        Base salary <span className="text-phx-ink-faint">الأجر الأساسي · EGP</span>
                      </label>
                      <Input
                        className={inputClassName}
                        disabled={!canManage || employee.departed || salaryReadOnly}
                        id="hiring-pack-fact-baseSalary"
                        inputMode="decimal"
                        onChange={(event) =>
                          setFactsForm((current) => ({ ...current, baseSalary: event.target.value }))
                        }
                        type="number"
                        value={factsForm.baseSalary ?? ""}
                      />
                      {salaryReadOnly ? (
                        <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">
                          You print this figure. Only the HR Manager changes it.
                        </p>
                      ) : null}
                    </div>
                    <div>
                      <label className={labelClassName} htmlFor="hiring-pack-fact-insuranceWage">
                        Insurance wage <span className="text-phx-ink-faint">الأجر التأميني · EGP</span>
                      </label>
                      <Input
                        className={inputClassName}
                        disabled
                        id="hiring-pack-fact-insuranceWage"
                        value={
                          typedInsuranceWage === null ? "" : typedInsuranceWage.toLocaleString("en-US")
                        }
                      />
                      <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">
                        Base ÷ {INSURANCE_WAGE_DIVISOR}, up to the{" "}
                        {INSURANCE_WAGE_CEILING.toLocaleString("en-US")} ceiling. Change the base
                        salary and this follows.
                      </p>
                    </div>
                    <div>
                      <label className={labelClassName} htmlFor="hiring-pack-fact-lineId">
                        Line <span className="text-phx-ink-faint">الخط</span>
                      </label>
                      {lines.length > 0 ? (
                        <SearchableSelect
                          className={cn(inputClassName, "w-full")}
                          disabled={!canManage || employee.departed}
                          id="hiring-pack-fact-lineId"
                          onValueChange={(value) =>
                            setFactsForm((current) => ({ ...current, lineId: value }))
                          }
                          placeholder="Select a line"
                          value={factsForm.lineId ?? ""}
                        >
                          <option value="">Not set</option>
                          {lines.map((line) => (
                            <option key={line.id} value={String(line.id)}>
                              {line.name}
                            </option>
                          ))}
                        </SearchableSelect>
                      ) : (
                        <>
                          <Input className={inputClassName} disabled id="hiring-pack-fact-lineId" value="" />
                          <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">
                            The line list did not load — reload the page to edit this.
                          </p>
                        </>
                      )}
                    </div>
                    <div>
                      <label className={labelClassName} htmlFor="hiring-pack-fact-department">
                        Department <span className="text-phx-ink-faint">الإدارة</span>
                      </label>
                      <Input
                        className={inputClassName}
                        disabled
                        id="hiring-pack-fact-department"
                        value={employee.departmentAr ?? ""}
                      />
                      <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">
                        This is what the papers print, and it is not the line. Change it on the
                        employee record.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </AdminTableShell>

            <ChoiceGroup
              aria-label="Which package to prepare"
              className="grid-cols-2"
              onChange={setActivePackage}
              options={PACKAGE_TABS}
              value={activePackage}
            />

            {activePackage === "newHire" ? (
              <div className="flex flex-col gap-5">
                {/*
                  The contract's and Form 1's own values — not offered to a seat limited to its own
                  papers: neither paper is hers, and the hiring profile they save to stays
                  employee_documents:update on the server.
                */}
                {scoped ? null : (
                <AdminTableShell
                  action={
                    canManage ? (
                      <Button
                        className="h-10 gap-2"
                        disabled={busy === "save"}
                        onClick={() => void save()}
                      >
                        {busy === "save" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4" />
                        )}
                        Save
                      </Button>
                    ) : undefined
                  }
                  description="Everything the two documents ask for that the employee record cannot answer."
                  title="What you fill in"
                >
                  <div className="flex flex-col gap-6 px-5 py-5 sm:px-6">
                    <FieldGroup
                      disabled={!canManage}
                      fields={IDENTITY_FIELDS}
                      form={form}
                      onChange={setForm}
                      subtitle="Printed on both documents."
                      suggestions={
                        pack.suggestedJobTitleAr ? { jobTitleAr: pack.suggestedJobTitleAr } : undefined
                      }
                      title="Identity and job"
                    />
                    <FieldGroup
                      action={
                        canManage && factsForm.residenceAddress?.trim() ? (
                          <Button
                            onClick={() =>
                              setForm((current) => ({
                                ...current,
                                addressStreet: factsForm.residenceAddress ?? "",
                              }))
                            }
                            size="xs"
                            type="button"
                            variant="ghost"
                          >
                            <Copy className="h-3 w-3" />
                            Copy the address on file
                          </Button>
                        ) : undefined
                      }
                      disabled={!canManage}
                      fields={FORM1_FIELDS}
                      form={form}
                      onChange={setForm}
                      subtitle="Printed on Form 1 only. The code fields are boxes on the government form and hold numbers. Street can be copied from the address on file above — building, sheyakha, qism and governorate codes still need typing."
                      title="Form 1 details"
                    />
                    <FieldGroup
                      disabled={!canManage || contractTermsReadOnly}
                      fields={TERM_FIELDS}
                      form={form}
                      onChange={setForm}
                      subtitle={contractTermsReadOnly ? "You print these terms. Only the HR Manager changes them." : `Blank uses the standard term — ${pack.terms.durationMonths} months, ${pack.terms.probationMonths}-month probation, ${pack.terms.underperformanceThresholdPct}% over ${pack.terms.underperformanceMonths} months, ${pack.terms.trainingBondMonths}-month training bond.`}
                      title="Contract terms"
                    />
                    <div>
                      <label className={labelClassName} htmlFor="hiring-pack-notes">
                        Notes <span className="text-phx-ink-faint">ملاحظات</span>
                      </label>
                      <textarea
                        className={cn(inputClassName, "h-24 w-full resize-y px-3 py-2 leading-relaxed")}
                        disabled={!canManage}
                        id="hiring-pack-notes"
                        onChange={(event) =>
                          setForm((current) => ({ ...current, notes: event.target.value }))
                        }
                        placeholder="Internal only. Never printed on either document."
                        value={form.notes}
                      />
                    </div>
                  </div>
                </AdminTableShell>
                )}

                <PaperGroup title="Contract and Form 1">
                  <DocumentCard
                    busy={busy === "sign-contract"}
                    canManage={canManage}
                    document="contract"
                    copies={copies.contract}
                    gaps={gapsFor(pack.gaps, "contract")}
                    onCopiesChange={(value) => setCopiesFor("contract", value)}
                    footnote={contractVersionNote(pack.profile.contractTemplateVersion)}
                    onPreview={() => openPreview("contract")}
                    onPrint={() => requestPrint("contract")}
                    onSign={() => void recordSignature("contract")}
                    onSignDateChange={(value) => setSignDateFor("contract", value)}
                    printedAt={pack.profile.contractPrintedAt}
                    printingNote="One page per sheet — single-sided. Five pages per copy, on A4."
                    signDate={signDates.contract}
                    signedDate={pack.profile.contractSignedDate}
                    subtitle="عقد عمل محدد المدة"
                    title="Employment contract"
                  />
                  <DocumentCard
                    busy={busy === "sign-form1"}
                    canManage={canManage}
                    document="form1"
                    copies={copies.form1}
                    gaps={gapsFor(pack.gaps, "form1")}
                    onCopiesChange={(value) => setCopiesFor("form1", value)}
                    onPreview={() => openPreview("form1")}
                    onPrint={() => requestPrint("form1")}
                    onSign={() => void recordSignature("form1")}
                    onSignDateChange={(value) => setSignDateFor("form1", value)}
                    printedAt={pack.profile.form1PrintedAt}
                    printingNote="MUST be printed double-sided. Set the printer to two-sided, flip on the long edge, US Legal paper."
                    signDate={signDates.form1}
                    signedDate={pack.profile.form1SignedDate}
                    subtitle="نموذج ١ — طلب اشتراك مؤمن عليه"
                    title="Social insurance Form 1"
                  />
                </PaperGroup>

                {/*
                  The worker-data form — استمارة بيانات العامل — is Sato's own service-file intake sheet,
                  filled on the first day and kept in the personnel file (its header says "تُحفظ بملف
                  الخدمة"). It is not signature-tracked, for the same reason the custody receipts are not:
                  a paper filed in a drawer, where the honest record is none. See `SIGNABLE_DOCUMENTS`.
                */}
                <PaperGroup title="Service file">
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="workerDataForm"
                    copies={copies.workerDataForm}
                    gaps={gapsFor(pack.gaps, "workerDataForm")}
                    onCopiesChange={(value) => setCopiesFor("workerDataForm", value)}
                    footnote="A service-file sheet, not a government form. Everything Phoenix already knows — name, national ID, job, insurance number — is filled; the fields it holds no record of (marital status, military-service position, bank and IBAN, next of kin) print blank for a pen."
                    onPreview={() => openPreview("workerDataForm")}
                    onPrint={() => requestPrint("workerDataForm")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="One copy, single-sided A4. Kept in the service file — not attached to the contract copies."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="استمارة بيانات العامل — تُحفظ بملف الخدمة"
                    title="Worker data form"
                  />
                </PaperGroup>

                {/*
                  THE CUSTODY RECEIPTS SIT BETWEEN THE TWO HALVES, because that is where they belong in
                  a career: they are printed whenever a device changes hands, which is neither arrival
                  nor departure and is usually both at least once in between.

                  Both are always offered, unlike the two exit forms. The exit forms are alternatives —
                  one is signed and the other must not be — while these two are simply different
                  devices, and somebody who is handed a laptop and a phone on his first morning needs
                  both papers on his first morning.
                */}
                <PaperGroup title="Custody receipts">
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="custodyLaptop"
                    copies={copies.custodyLaptop}
                    gaps={gapsFor(pack.gaps, "custodyLaptop")}
                    onCopiesChange={(value) => setCopiesFor("custodyLaptop", value)}
                    footnote="The device details, values and handover date print blank — Phoenix holds no asset register, and a serial number is read off the machine rather than recalled. The name, ID, job title and address are filled."
                    onPreview={() => openPreview("custodyLaptop")}
                    onPrint={() => requestPrint("custodyLaptop")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="Two copies — the form says so itself. Single-sided A4; the return protocol is the last sheet of each copy."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="إقرار استلام عهدة — نموذج رقم ١ (حاسب محمول)"
                    title="Custody receipt — laptop"
                  />
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="custodyMobile"
                    copies={copies.custodyMobile}
                    gaps={gapsFor(pack.gaps, "custodyMobile")}
                    onCopiesChange={(value) => setCopiesFor("custodyMobile", value)}
                    footnote="Same paper as the laptop receipt, with the phone's own item list and an IMEI and SIM block in place of the Windows fields."
                    onPreview={() => openPreview("custodyMobile")}
                    onPrint={() => requestPrint("custodyMobile")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="Two copies. Single-sided A4. Print one form per device — البند (14) requires a separate numbered receipt for each."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="إقرار استلام عهدة — نموذج رقم ٢ (هاتف / جهاز لوحي)"
                    title="Custody receipt — phone or tablet"
                  />
                </PaperGroup>

                {/*
                  THE RENEWAL PAIR SITS BESIDE THE CUSTODY RECEIPTS, for the same reason: a contract
                  is renewed every year, which is neither arrival nor departure.

                  UNLIKE the custody receipts, only ONE of these two is ever issued for a given term
                  — the annex if the contract is extended, the notice if it is not. They are shown
                  together because the choice is made once, by one person, at one moment, and putting
                  the notice in the leaver tab would hide it until after the decision it announces.
                */}
                <PaperGroup title="Renewal">
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="contractRenewal"
                    copies={copies.contractRenewal}
                    gaps={gapsFor(pack.gaps, "contractRenewal")}
                    onCopiesChange={(value) => setCopiesFor("contractRenewal", value)}
                    footnote="The new term is taken from the approved renewal request where one exists, and derived from the expiring contract where it does not. The annex number and the objective reason for keeping the term fixed print blank — the number comes from the company's own register, and the reason is a legal judgement about the post."
                    onPreview={() => openPreview("contractRenewal")}
                    onPrint={() => requestPrint("contractRenewal")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="Four copies, matching the contract it amends — one for the employee, one for the file, one for the labour office, one for social insurance. SIGN IT BEFORE THE CURRENT TERM EXPIRES: under مادة (88) of Law 14/2025, carrying on after expiry with no written agreement makes the contract indefinite from the day it was made."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="ملحق تجديد سنوي لعقد عمل محدد المدة"
                    title="Contract renewal annex"
                  />
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="contractNonRenewal"
                    copies={copies.contractNonRenewal}
                    gaps={gapsFor(pack.gaps, "contractNonRenewal")}
                    onCopiesChange={(value) => setCopiesFor("contractNonRenewal", value)}
                    footnote="The alternative to the annex, never a companion to it. The last working day is the contract's own end date and nothing else — this notice exists to say the contract expired rather than that anybody resigned or was dismissed."
                    onPreview={() => openPreview("contractNonRenewal")}
                    onPrint={() => requestPrint("contractNonRenewal")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="Two copies — one handed over, one filed with the employee's acknowledgment on it. Serve it before the term ends. If they will not sign, the witness block at the foot is the record."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="إخطار بعدم تجديد عقد عمل محدد المدة"
                    title="Non-renewal notice"
                  />
                </PaperGroup>

                {/*
                  SATO'S OWN JOINING PAPERS — signed or completed on the day somebody arrives, beside
                  the contract and Form 1 rather than after them, because that is when they are used.
                */}
                <PaperGroup title="First-day papers">
                  <DocumentCard
                    busy={busy === "sign-nda"}
                    canManage={canManage}
                    document="nda"
                    copies={copies.nda}
                    gaps={gapsFor(pack.gaps, "nda")}
                    onCopiesChange={(value) => setCopiesFor("nda", value)}
                    footnote="Supplements مادة (7) of the contract and now names it. Everything about the person is filled; the paper is signed by both sides."
                    onPreview={() => openPreview("nda")}
                    onPrint={() => requestPrint("nda")}
                    onSign={() => void recordSignature("nda")}
                    onSignDateChange={(value) => setSignDateFor("nda", value)}
                    printedAt={pack.profile.ndaPrintedAt}
                    printingNote="Two copies — one filed, one handed over. Sign it on the first day, alongside the contract."
                    signDate={signDates.nda}
                    signedDate={pack.profile.ndaSignedDate}
                    signable
                    subtitle="إقرار وتعهد بعدم إفشاء المعلومات والأسرار التجارية"
                    title="Confidentiality undertaking"
                  />
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="appointmentDocsReceipt"
                    copies={copies.appointmentDocsReceipt}
                    gaps={gapsFor(pack.gaps, "appointmentDocsReceipt")}
                    onCopiesChange={(value) => setCopiesFor("appointmentDocsReceipt", value)}
                    footnote="Every verdict box prints blank by design: Phoenix holds no register of which certificates were handed over, and a ticked box on a signed form asserts that a document was seen."
                    onPreview={() => openPreview("appointmentDocsReceipt")}
                    onPrint={() => requestPrint("appointmentDocsReceipt")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="Two copies. Complete it with the certificates on the desk, and set the deadline for anything missing."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="إيصال استلام مسوغات التعيين — 12 مستندًا"
                    title="Appointment documents receipt"
                  />
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="socialStatusSheet"
                    copies={copies.socialStatusSheet}
                    gaps={gapsFor(pack.gaps, "socialStatusSheet")}
                    onCopiesChange={(value) => setCopiesFor("socialStatusSheet", value)}
                    footnote="The service-file sheet the law requires the employer to keep. Name, ID, job, dates and insurance number are filled; religion, military status and marital status print blank because this system holds none of them."
                    onPreview={() => openPreview("socialStatusSheet")}
                    onPrint={() => requestPrint("socialStatusSheet")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="One copy, one sheet. Filed — never handed over. The dependants table is completed by the employee, who signs that it is true."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="صحيفة الحالة الاجتماعية — المادة (92)"
                    title="Social status sheet"
                  />
                </PaperGroup>

                {/*
                  THE TWO ABSENCE NOTICES. They are NOT alternatives the way the exit forms are —
                  Article 166 requires a warning BEFORE a worker can be deemed resigned, so the first
                  is a precondition of the second. Both are shown so that is visible, and neither
                  carries a date Phoenix guessed.
                */}
                <PaperGroup title="Attendance">
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="absenceWarning"
                    copies={copies.absenceWarning}
                    gaps={gapsFor(pack.gaps, "absenceWarning")}
                    onCopiesChange={(value) => setCopiesFor("absenceWarning", value)}
                    footnote="Issued after five consecutive days, as مادة (8) of the contract provides. The absence dates print blank: attendance is not resolved here, and a wrong date on this page cannot be walked back."
                    onPreview={() => openPreview("absenceWarning")}
                    onPrint={() => requestPrint("absenceWarning")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="Two copies. Serve it and take their signature; if they refuse, the witness block at the foot is the record."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="إنذار أول بالتغيب عن العمل — المادة (166)"
                    title="Absence warning — first"
                  />
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="deemedResignation"
                    copies={copies.deemedResignation}
                    gaps={gapsFor(pack.gaps, "deemedResignation")}
                    onCopiesChange={(value) => setCopiesFor("deemedResignation", value)}
                    footnote="Only after MORE THAN ten consecutive days, and only once the first warning has been served — Article 166 requires both. It declares a deemed resignation; it does not accept one, because the employee wrote none."
                    onPreview={() => openPreview("deemedResignation")}
                    onPrint={() => requestPrint("deemedResignation")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="Two copies. This one ends service — check the dates against attendance before it leaves the desk."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="إخطار باعتبار العامل مستقيلًا حكمًا — المادة (166)"
                    title="Deemed resignation notice"
                  />
                </PaperGroup>

                {/*
                  THE HR LETTER, in both languages. Asked for by somebody still employed — a bank, an
                  embassy — so it sits with the papers of a working life. Both state the BASE salary
                  on record (the Arabic one since 2026-09-20, the English one since 2026-10-28: "PUT
                  THE BASE NOT THE BASIC SALARY"), so a pair printed together states one figure.
                */}
                <PaperGroup title="HR letters">
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="salaryLetterEn"
                    copies={copies.salaryLetterEn}
                    gaps={gapsFor(pack.gaps, "salaryLetterEn")}
                    onCopiesChange={(value) => setCopiesFor("salaryLetterEn", value)}
                    footnote="For a bank, an embassy or a landlord. It states the BASE monthly salary on record, in figures and in words — never the basic, the net or the gross."
                    onPreview={() => openPreview("salaryLetterEn")}
                    onPrint={() => requestPrint("salaryLetterEn")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="Two copies. One is handed over; the other is filed as the record of the salary the company certified."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="شهادة راتب — باللغة الإنجليزية"
                    title="HR letter — base salary (English)"
                  />
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="salaryLetterAr"
                    copies={copies.salaryLetterAr}
                    gaps={gapsFor(pack.gaps, "salaryLetterAr")}
                    onCopiesChange={(value) => setCopiesFor("salaryLetterAr", value)}
                    footnote="لبنك أو سفارة أو مالك عقار. تُبيّن الأجر الشهري المسجَّل، رقمًا وكتابةً — دون الأجر الأساسي أو الصافي أو الإجمالي."
                    onPreview={() => openPreview("salaryLetterAr")}
                    onPrint={() => requestPrint("salaryLetterAr")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="عدد النسخ يُسأل عنه قبل الطباعة، وتكتبه الشهادة على نفسها. بدون خاتم."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="شهادة راتب — باللغة العربية"
                    title="HR letter — base salary (Arabic)"
                  />
                </PaperGroup>

                <PackageCompanyTemplates
                  employeeSelected={Boolean(pack)}
                  onOpen={(template) => openTemplate(template, "preview")}
                  onPrint={(template) => openTemplate(template, "print")}
                  // A company template may print anything at all, so a seat limited to its own
                  // papers is offered none (the server refuses `custom:<uuid>` to her too).
                  templates={scoped ? NO_TEMPLATES : joiningTemplates}
                />
              </div>
            ) : null}

            {activePackage === "leaver" ? (
              <div className="flex flex-col gap-5">
                <AdminTableShell
                  action={
                    canManage ? (
                      <Button
                        className="h-10 gap-2"
                        disabled={busy === "save-exit"}
                        onClick={() => void saveExit()}
                      >
                        {busy === "save-exit" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4" />
                        )}
                        Save exit details
                      </Button>
                    ) : undefined
                  }
                  description="Filled in when somebody leaves. Everything else on these forms — name, national ID, address, job title — is reused from what was typed at hiring."
                  title="End of service"
                >
                  <div className="flex flex-col gap-6 px-5 py-5 sm:px-6">
                    {pack.exit ? (
                      <div className="border-l-[3px] border-phx-accent pl-3">
                        <span className={factLabelClassName}>Recorded departure</span>
                        <p className="mt-1 text-sm font-bold text-phx-ink">
                          Last working day {formatDate(pack.exit.lastWorkingDate)}
                          {pack.exit.status ? ` · ${pack.exit.status}` : ""}
                        </p>
                        <p className="mt-1 text-xs font-semibold text-phx-ink-soft">
                          From the resignation record. Type a date below only if the paper says something
                          different — that record copies one date into four columns, so it is a starting
                          point rather than a confirmation.
                        </p>
                      </div>
                    ) : null}

                    <div>
                      <div className="mb-3">
                        <h3 className="text-sm font-black uppercase tracking-[0.1em] text-phx-ink">
                          Which exit form
                        </h3>
                        <p className="mt-0.5 text-xs font-semibold text-phx-ink-soft">
                          One is signed, never both. Form 6 is filed with social insurance either way.
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {EXIT_ROUTES.map((route) => {
                          const selected = exitRoute === route.value;
                          return (
                            <button
                              className={cn(
                                "border px-4 py-3 text-left transition",
                                selected
                                  ? "border-phx-accent-line bg-phx-accent/10"
                                  : "border-phx-line bg-white/95 hover:border-phx-accent-line",
                              )}
                              disabled={!canManage}
                              key={route.value}
                              onClick={() =>
                                setExitForm((current) => ({
                                  ...current,
                                  // Pressing the chosen route again clears it, which is the only way
                                  // back to "not decided yet" once somebody has clicked the wrong one.
                                  exitRoute: selected ? "" : route.value,
                                }))
                              }
                              type="button"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-black text-phx-ink">{route.labelEn}</span>
                                <span className="text-sm font-bold text-phx-ink-soft" dir="rtl">
                                  {route.labelAr}
                                </span>
                              </div>
                              <p className="mt-1 text-xs font-semibold text-phx-ink-soft">{route.note}</p>
                              {selected ? (
                                <Badge className="mt-2" variant="success">
                                  Chosen
                                </Badge>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <FieldGroup
                      disabled={!canManage}
                      fields={EXIT_FIELDS}
                      form={exitForm}
                      onChange={setExitForm}
                      subtitle="The last working day is what Form 6 files with the Authority — it is the value on these forms that costs money if it is wrong."
                      title="Departure"
                    />
                    <FieldGroup
                      disabled={!canManage}
                      fields={EXIT_PARTY_FIELDS}
                      form={exitForm}
                      onChange={setExitForm}
                      subtitle="Blank uses the manager who signs employment contracts as الطرف الأول."
                      title="Who signs"
                    />
                    <div>
                      <label className={labelClassName} htmlFor="hiring-pack-exit-notes">
                        Exit notes <span className="text-phx-ink-faint">ملاحظات</span>
                      </label>
                      <textarea
                        className={cn(inputClassName, "h-24 w-full resize-y px-3 py-2 leading-relaxed")}
                        disabled={!canManage}
                        id="hiring-pack-exit-notes"
                        onChange={(event) =>
                          setExitForm((current) => ({ ...current, notes: event.target.value }))
                        }
                        placeholder="Internal only. Never printed on any exit document."
                        value={exitForm.notes}
                      />
                    </div>
                  </div>
                </AdminTableShell>

                <PaperGroup title="Filing the departure">
                  <DocumentCard
                    busy={busy === "sign-form6"}
                    canManage={canManage}
                    document="form6"
                    copies={copies.form6}
                    gaps={gapsFor(pack.gaps, "form6")}
                    onCopiesChange={(value) => setCopiesFor("form6", value)}
                    onPreview={() => openPreview("form6")}
                    onPrint={() => requestPrint("form6")}
                    onSign={() => void recordSignature("form6")}
                    onSignDateChange={(value) => setSignDateFor("form6", value)}
                    printedAt={pack.offboarding.form6PrintedAt}
                    printingNote="MUST be printed double-sided, three copies. Set the printer to two-sided, flip on the long edge, US Legal paper."
                    signDate={signDates.form6}
                    signedDate={pack.offboarding.form6SignedDate}
                    subtitle="نموذج ٦ — إخطار بإنتهاء اشتراك مؤمن عليه"
                    title="Social insurance Form 6"
                  />
                  {/*
                    Only the chosen route's card is offered. Showing both would invite printing both,
                    and the two forms assert incompatible facts about the same departure — the owner's
                    rule is that one is signed, never both.
                  */}
                  {exitRoute === "resignation" ? (
                    <DocumentCard
                      busy={busy === "sign-resignation"}
                      canManage={canManage}
                      document="resignation"
                      copies={copies.resignation}
                      gaps={gapsFor(pack.gaps, "resignation")}
                      onCopiesChange={(value) => setCopiesFor("resignation", value)}
                      onPreview={() => openPreview("resignation")}
                      onPrint={() => requestPrint("resignation")}
                      onSign={() => void recordSignature("resignation")}
                      onSignDateChange={(value) => setSignDateFor("resignation", value)}
                      printedAt={pack.offboarding.resignationPrintedAt}
                      printingNote="One page, single-sided, US Letter. The right-hand endorsement column is filled at the labour office."
                      signDate={signDates.resignation}
                      signedDate={pack.offboarding.resignationSignedDate}
                      subtitle="طلب استقالة — مادة ١٦٧"
                      title="Resignation request"
                    />
                  ) : exitRoute === "mutualTermination" ? (
                    <DocumentCard
                      busy={busy === "sign-mutualTermination"}
                      canManage={canManage}
                      document="mutualTermination"
                      copies={copies.mutualTermination}
                      gaps={gapsFor(pack.gaps, "mutualTermination")}
                      onCopiesChange={(value) => setCopiesFor("mutualTermination", value)}
                      onPreview={() => openPreview("mutualTermination")}
                      onPrint={() => requestPrint("mutualTermination")}
                      onSign={() => void recordSignature("mutualTermination")}
                      onSignDateChange={(value) => setSignDateFor("mutualTermination", value)}
                      printedAt={pack.offboarding.mutualTerminationPrintedAt}
                      printingNote="Three pages per copy, single-sided, US Letter. Both parties sign every copy."
                      signDate={signDates.mutualTermination}
                      signedDate={pack.offboarding.mutualTerminationSignedDate}
                      subtitle="إنهاء علاقة العمل بالتوافق بين الطرفين"
                      title="Mutual termination agreement"
                    />
                  ) : (
                    <AdminCallout>
                      <DoorOpen className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        Choose an exit form above — a resignation or a mutual termination — and it
                        appears here ready to print. Only one is ever signed.
                      </span>
                    </AdminCallout>
                  )}
                  {/*
                    The clearance pair, and note the contrast with the two cards above: BOTH are shown,
                    always, because they are complements rather than alternatives. One certifies the
                    employee is clear of the company and he keeps it; the other certifies the company is
                    clear of him and the company files it. Hiding either would leave the party who does
                    not keep it unprotected.
                  */}
                  <DocumentCard
                    busy={busy === "sign-clearanceEmployee"}
                    canManage={canManage}
                    document="clearanceEmployee"
                    copies={copies.clearanceEmployee}
                    gaps={gapsFor(pack.gaps, "clearanceEmployee")}
                    onCopiesChange={(value) => setCopiesFor("clearanceEmployee", value)}
                    onPreview={() => openPreview("clearanceEmployee")}
                    onPrint={() => requestPrint("clearanceEmployee")}
                    onSign={() => void recordSignature("clearanceEmployee")}
                    onSignDateChange={(value) => setSignDateFor("clearanceEmployee", value)}
                    printedAt={pack.offboarding.clearanceEmployeePrintedAt}
                    printingNote="Single-sided, A4, background graphics ON. Seven departments sign it by hand and the company stamps it — it is not valid until all of them are on it, and final dues are not released before that."
                    signDate={signDates.clearanceEmployee}
                    signedDate={pack.offboarding.clearanceEmployeeSignedDate}
                    subtitle="إخلاء طرف موظف — تشهد به الشركة، ويحتفظ به الموظف"
                    title="Employee clearance"
                  />
                  <DocumentCard
                    busy={busy === "sign-clearanceCompany"}
                    canManage={canManage}
                    document="clearanceCompany"
                    copies={copies.clearanceCompany}
                    gaps={gapsFor(pack.gaps, "clearanceCompany")}
                    onCopiesChange={(value) => setCopiesFor("clearanceCompany", value)}
                    onPreview={() => openPreview("clearanceCompany")}
                    onPrint={() => requestPrint("clearanceCompany")}
                    onSign={() => void recordSignature("clearanceCompany")}
                    onSignDateChange={(value) => setSignDateFor("clearanceCompany", value)}
                    printedAt={pack.offboarding.clearanceCompanyPrintedAt}
                    printingNote="Single-sided, A4, background graphics ON. The settlement amount prints blank on purpose — this paper is a release of claims, so the figure has to be the one finance actually paid."
                    signDate={signDates.clearanceCompany}
                    signedDate={pack.offboarding.clearanceCompanySignedDate}
                    subtitle="إخلاء طرف شركة — يقر به الموظف، وتحتفظ به الشركة"
                    title="Company clearance"
                  />
                </PaperGroup>

                {/*
                  THE OTHER END OF THE APPOINTMENT-DOCUMENTS LOOP. Its sibling — the receipt taken
                  when the certificates came IN — is in the joining tab. They were supplied as two
                  files with almost the same name, and the one mistake worth designing against is
                  filing the wrong one at the wrong end of a career.
                */}
                <PaperGroup title="Handing back and certifying">
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="appointmentDocsReturn"
                    copies={copies.appointmentDocsReturn}
                    gaps={gapsFor(pack.gaps, "appointmentDocsReturn")}
                    onCopiesChange={(value) => setCopiesFor("appointmentDocsReturn", value)}
                    footnote="The employee's receipt for their own original certificates coming back. It carries the last working day, and says in terms that it covers the papers only — it is not a release of any statutory or financial entitlement."
                    onPreview={() => openPreview("appointmentDocsReturn")}
                    onPrint={() => requestPrint("appointmentDocsReturn")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="Two copies. Print it when the certificates are physically handed back, not before — it is the proof they were."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="إقرار استلام مسوغات التعيين — عند انتهاء الخدمة"
                    title="Appointment documents returned"
                  />
                  {/*
                    THE CERTIFICATE OF EXPERIENCE. It sits in the leaver package because that is
                    when HR reaches for it, NOT because it is only issued then — somebody still at
                    his desk can ask for one for a visa or a bank, and the paper prints correctly
                    for him, saying in terms that he is still employed. The footnote below says
                    which of the two this employee will get, because the two readings are what a
                    certificate can be wrong about in a way that costs him the job.
                  */}
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="experienceCertificate"
                    copies={copies.experienceCertificate}
                    gaps={gapsFor(pack.gaps, "experienceCertificate")}
                    onCopiesChange={(value) => setCopiesFor("experienceCertificate", value)}
                    footnote={
                      pack.employee.departed
                        ? "Issued on request, to be read by their next employer. It will state that their service ENDED — check the last working day above. No salary, no reason for leaving and no statement of conduct: each is left out on purpose."
                        : "Issued on request — for a visa, a bank or an application. This employee has not left, so it will state that they are STILL EMPLOYED and close the period at today's date. No salary, no statement of conduct: each is left out on purpose."
                    }
                    onPreview={() => openPreview("experienceCertificate")}
                    onPrint={() => requestPrint("experienceCertificate")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="Two copies. Nobody signs it back — one is handed over, one is the company's record of what it certified about them."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="شهادة خبرة — تُصرف بناءً على طلب صاحب الشأن"
                    title="Certificate of experience — Arabic"
                  />
                  {/*
                    THE ENGLISH COUNTERPART. Both are current at once and HR prints whichever is
                    being asked for — the Arabic one for an Egyptian reader, this one for an embassy,
                    a Gulf employer or a bank. They state the same period from the same resolver, so
                    somebody handed both cannot be given two different lengths of service.
                  */}
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    document="experienceCertificateEn"
                    copies={copies.experienceCertificateEn}
                    gaps={gapsFor(pack.gaps, "experienceCertificateEn")}
                    onCopiesChange={(value) => setCopiesFor("experienceCertificateEn", value)}
                    footnote={
                      pack.employee.departed
                        ? "For an embassy, a foreign employer or a bank. It will state that this employee's service ENDED. Same three omissions as the Arabic copy — no salary, no reason for leaving, no statement of conduct."
                        : "For an embassy, a foreign employer or a bank. This employee has not left, so it will state that they are STILL EMPLOYED and close the period at today's date."
                    }
                    onPreview={() => openPreview("experienceCertificateEn")}
                    onPrint={() => requestPrint("experienceCertificateEn")}
                    onSign={() => undefined}
                    onSignDateChange={() => undefined}
                    printedAt={null}
                    printingNote="Two copies. Use Download PDF on the print view — that file keeps its text editable if it is later opened in a design tool. Do not flatten it to an image."
                    signDate=""
                    signedDate={null}
                    signable={false}
                    subtitle="Certificate of Experience — English, for use abroad"
                    title="Certificate of experience — English"
                  />
                </PaperGroup>

                <PackageCompanyTemplates
                  employeeSelected={Boolean(pack)}
                  onOpen={(template) => openTemplate(template, "preview")}
                  onPrint={(template) => openTemplate(template, "print")}
                  templates={scoped ? NO_TEMPLATES : leavingTemplates}
                />
              </div>
            ) : null}
          </>
        ) : (
          <AdminCallout>
            <UserRound className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Choose an employee above to fill and print the hiring pack.</span>
          </AdminCallout>
        )}

        {/*
          The Archive reprints superseded versions of every paper and the Studio uploads and prints
          company templates — neither is offered to a seat limited to its own papers.
        */}
        {scoped ? null : (
          <>
            <TemplateArchive
              employeeSelected={Boolean(pack)}
              onPreview={(document, versionId) => openPreview(document, versionId)}
              onPrint={(document, versionId) => requestPrint(document, versionId)}
            />

            <TemplateStudio
              companyTemplates={companyTemplates}
              employeeSelected={Boolean(pack)}
              onPreview={(document, versionId) => openPreview(document, versionId)}
              onPrint={(document, versionId) => requestPrint(document, versionId)}
            />
          </>
        )}

        {printRequest ? (
          <PrintOptionsDialog
            availableMarks={availableMarks}
            initialMarks={lastMarks[printRequestKey] ?? []}
            askAddress={documentTakesAddressChoice(printRequest.document)}
            defaultCopies={
              printRequest.copiesOverride ??
              resolveCopyCount(copies[printRequest.document], printRequest.document)
            }
            initialAddress={lastAddress}
            onCancel={() => setPrintRequest(null)}
            onConfirm={confirmPrint}
            registeredAddress={pack?.company.contractRecital.headOfficeAr ?? ""}
            title={documentLabel(printRequest.document, customTemplateNames)}
          />
        ) : null}
      </div>
    </div>
    </PaperScopeContext.Provider>
  );
}

function FieldGroup({
  action,
  disabled,
  fields,
  form,
  onChange,
  subtitle,
  suggestions,
  title,
}: {
  action?: ReactNode;
  disabled: boolean;
  fields: readonly FieldDef[];
  form: FormState;
  onChange: (updater: (current: FormState) => FormState) => void;
  subtitle: string;
  /** A previously-typed value worth offering as a one-click fill, keyed by field key. */
  suggestions?: Partial<Record<string, string>>;
  title: string;
}) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-black uppercase tracking-[0.1em] text-phx-ink">{title}</h3>
          <p className="mt-0.5 text-xs font-semibold text-phx-ink-soft">{subtitle}</p>
        </div>
        {action ?? null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {fields.map((field) => {
          const suggestion = suggestions?.[field.key];
          const currentValue = form[field.key] ?? "";
          const showSuggestion = Boolean(
            !disabled && suggestion && suggestion.trim() && suggestion !== currentValue,
          );
          return (
            <div key={field.key}>
              <label className={labelClassName} htmlFor={`hiring-pack-${field.key}`}>
                {field.labelEn} <span className="text-phx-ink-faint">{field.labelAr}</span>
              </label>
              {field.kind === "select" ? (
                /*
                  A NATIVE SELECT, and it stays native on purpose. The fits-the-screen golden rule
                  names this as the one control that cannot be narrowed, so its options carry SHORT
                  labels while the full legal sentence lives in `renewal-reasons.ts` and prints on
                  the annex — clipped legal text on a chooser is how the wrong ground gets picked.

                  The empty option is rendered here rather than listed in the field definition, so
                  every select gets a way back to "not chosen" without any field remembering to
                  offer one. Blank is a real answer: it prints the dotted rule for a pen.
                */
                <select
                  className={phxSelectClassName}
                  disabled={disabled}
                  id={`hiring-pack-${field.key}`}
                  onChange={(event) =>
                    onChange((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                  value={currentValue}
                >
                  <option value="">— not chosen —</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.labelEn} · {option.labelAr}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  className={inputClassName}
                  disabled={disabled}
                  id={`hiring-pack-${field.key}`}
                  inputMode={
                    field.kind === "code" || field.kind === "number" ? "numeric" : undefined
                  }
                  maxLength={field.maxLength}
                  onChange={(event) =>
                    onChange((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                  type={field.kind === "date" ? "date" : field.kind === "number" ? "number" : "text"}
                  value={currentValue}
                />
              )}
              {showSuggestion ? (
                <button
                  className="mt-1 text-phx-xs font-semibold text-phx-accent underline decoration-dotted underline-offset-2 hover:text-phx-accent-press"
                  onClick={() =>
                    onChange((current) => ({ ...current, [field.key]: suggestion ?? "" }))
                  }
                  type="button"
                >
                  Use &ldquo;{suggestion}&rdquo;
                </button>
              ) : field.hint ? (
                <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">{field.hint}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * What the contract card says about which text THIS employee's contract is.
 *
 * Silent in the ordinary case, which is nearly every case — a new hire signing today's contract
 * needs no explanation, and a card that explains the obvious teaches people to stop reading it. It
 * speaks only when the answer is surprising: this person signed a text that has since been
 * replaced, so the Print button above reproduces THAT text and not the one a colleague hired this
 * morning would get. Without the line, two contracts printed from the same screen on the same day
 * come out different and nothing on the screen says why.
 */
function contractVersionNote(signedVersionId: string | null): string | null {
  if (!signedVersionId) return null;
  const signed = findTemplateVersion(signedVersionId);
  if (!signed || signed.status === "current") return null;
  return (
    `Signed against ${signed.labelEn}, archived ${formatDate(signed.supersededOn)}. ` +
    "Printing reproduces the text this employee actually signed, not the current one."
  );
}

/**
 * THE ARCHIVE — every version of every paper that has been replaced, still printable.
 *
 * The owner's instruction, 2026-08-30: "make the other contract go to archived instead of removing
 * it from system. Make a thing called archived … and any paper I replace, it goes to the archive."
 *
 * WHY IT IS ON THE SCREEN AND NOT ONLY IN THE CODE. The registry alone would keep old versions
 * printable, and that would satisfy the mechanism while missing the point: HR has to be able to SEE
 * that the previous contract still exists, when it stopped being used and what replaced it. A
 * superseded contract is not dead paper — an employee signed it, a labour office may ask for it,
 * and a dispute is argued on the text that was signed. So the record is shown, dated, and printable
 * by anyone who can print the live one.
 *
 * It stays visible with no employee chosen, because the question "what did the old contract say"
 * is asked about the document, not about a person. Only the Print button waits for an employee —
 * printing needs somebody's details to type into it.
 */
function TemplateArchive({
  employeeSelected,
  onPreview,
  onPrint,
}: {
  employeeSelected: boolean;
  /** Read a superseded template on screen before committing it to paper. */
  onPreview: (document: HiringPackDocument, versionId: string) => void;
  onPrint: (document: HiringPackDocument, versionId: string) => void;
}) {
  const archived = archivedTemplateVersions();

  // CLOSED UNTIL ASKED FOR, because of who asks and how often. The archive is 441px of superseded
  // contracts at the foot of the screen, and it is read when a labour office or a dispute asks what
  // the old text said — rarely, deliberately, and never in the middle of printing today's papers.
  // It stays a section with its own heading and its count on the outside, so it is still obviously
  // there; what changes is that it no longer occupies a tenth of the page to say so.
  const [open, setOpen] = useState(false);

  return (
    <AdminTableShell
      action={
        <Button
          aria-expanded={open}
          className="h-10 gap-2"
          onClick={() => setOpen((current) => !current)}
          type="button"
          variant="outline"
        >
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {open ? "Hide" : `Show ${archived.length} archived`}
        </Button>
      }
      description="Every paper that has been replaced. Nothing is ever deleted — a document somebody signed has to stay reproducible as the document they signed."
      title="Archive"
    >
      {!open ? null : archived.length === 0 ? (
        <div className="px-5 py-5 sm:px-6">
          <AdminCallout>
            <Archive className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Nothing archived yet. When a form is replaced, the version it replaced lands here and
              stays printable.
            </span>
          </AdminCallout>
        </div>
      ) : (
        <div className="divide-y divide-phx-line">
          {archived.map((entry) => {
            const replacement = entry.supersededBy ? findTemplateVersion(entry.supersededBy) : null;
            return (
              <div
                className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6"
                key={entry.id}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-black text-phx-ink">{entry.labelEn}</span>
                    <Badge size="sm" tone="neutral">
                      Archived
                    </Badge>
                    <Badge size="sm" tone="info">
                      {documentLabel(entry.document)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-phx-xs font-bold text-phx-ink-soft" dir="auto">
                    {entry.labelAr}
                  </p>
                  {/* Two lines, not one that wraps: the dates and the replacement are separate
                      facts, and a single line carrying both breaks mid-sentence at this width. */}
                  <p className="mt-2 text-xs font-semibold text-phx-ink-2">
                    In use {formatDate(entry.effectiveFrom)} → {formatDate(entry.supersededOn)}
                  </p>
                  {replacement ? (
                    <p className="mt-0.5 text-xs font-semibold text-phx-ink-2">
                      Replaced by {replacement.labelEn}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs leading-5 text-phx-ink-faint">{entry.note}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    className="h-10 gap-2"
                    disabled={!employeeSelected}
                    onClick={() => onPreview(entry.document, entry.id)}
                    type="button"
                    variant="outline"
                  >
                    <FileText className="h-4 w-4" />
                    Read it
                  </Button>
                  <Button
                    className="h-10 gap-2"
                    disabled={!employeeSelected}
                    onClick={() => onPrint(entry.document, entry.id)}
                    type="button"
                    variant="outline"
                  >
                    <Printer className="h-4 w-4" />
                    Print this version
                  </Button>
                </div>
              </div>
            );
          })}
          {!employeeSelected ? (
            <div className="px-5 py-4 sm:px-6">
              <AdminCallout>
                <UserRound className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Choose an employee above to print an archived version — it is typed with their
                  details, the same as the current one.
                </span>
              </AdminCallout>
            </div>
          ) : null}
        </div>
      )}
    </AdminTableShell>
  );
}

/**
 * Whether one signable document has been signed, and when — as a pill rather than a stat card.
 *
 * It replaces a 169px card carrying the same two facts. The date is the whole point of the state:
 * "Signed" with no date would be a claim nobody can check, and this is the value Form 6 files with
 * the Authority later, so it is shown in full rather than abbreviated.
 */
function SignaturePill({
  icon,
  label,
  signedDate,
}: {
  icon: ReactNode;
  label: string;
  signedDate: string | null;
}) {
  const signed = Boolean(signedDate);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 border px-3 py-2 text-sm font-bold",
        signed
          ? "border-phx-ok-line bg-phx-ok-bg text-phx-ok"
          : "border-phx-warn-line bg-phx-warn-bg text-phx-warn",
      )}
    >
      {icon}
      <span>{label}</span>
      <span className="font-black">{signed ? "signed" : "not signed yet"}</span>
      {signedDate ? (
        <span className="font-semibold opacity-80">{formatDate(signedDate)}</span>
      ) : null}
    </span>
  );
}

/**
 * The uploaded templates filed in ONE package, shown beside the built-in papers of that package.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT IS HERE AND NOT ONLY IN THE STUDIO. The Studio at the foot of this screen is where a
 * template is ADDED. This is where one is USED. Somebody printing a leaver's papers on their last
 * day works down the Leaver package tab; a company exit form that only appears in a panel further
 * down, behind a Show button, is a paper they will not find on the day they need it — and the
 * screen would look complete without it, which is the failure mode that matters.
 *
 * RENDERS NOTHING WHEN THERE ARE NONE, deliberately. An empty heading on a screen most companies
 * will never upload anything to is a permanent invitation to wonder what is missing.
 *
 * `other` NEVER APPEARS HERE. A paper filed as "Other papers" is by definition not part of either
 * package, and putting it in both tabs would make the two packages stop meaning anything. It is
 * listed in the Studio, under its own heading.
 */
function PackageCompanyTemplates({
  employeeSelected,
  onOpen,
  onPrint,
  templates,
}: {
  employeeSelected: boolean;
  onOpen: (template: StoredTemplate) => void;
  onPrint: (template: StoredTemplate) => void;
  templates: readonly StoredTemplate[];
}) {
  if (templates.length === 0) return null;
  return (
    <AdminTableShell
      description="Uploaded through the Company templates panel below, and filed in this package. They print from the employee record exactly as the papers above do."
      title="Company templates"
    >
      <ul className="flex flex-col gap-2">
        {templates.map((template) => (
          <li
            className="flex flex-col gap-2 border border-phx-line bg-white p-3 shadow-none sm:flex-row sm:items-center sm:gap-3"
            key={template.id}
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-phx-ink">{template.name}</p>
              {template.nameAr ? (
                <p className="text-phx-xs text-phx-ink-soft" dir="auto">
                  {template.nameAr}
                </p>
              ) : null}
              <p className="text-phx-xs text-phx-ink-faint">
                {template.pages.length} {template.pages.length === 1 ? "page" : "pages"} · v
                {template.version}
              </p>
              {/* WHAT COMES OUT OF THE PRINTER, said before the button is pressed rather than
                  discovered afterwards. Whoever set the template up answered both questions at
                  upload; this is where that answer reaches the person holding the paper. */}
              <p className="text-phx-xs font-semibold text-phx-ink-soft">
                {describePrintInstruction({
                  defaultCopies: template.defaultCopies,
                  pageCount: template.pages.length,
                  printSides: template.printSides,
                })}
              </p>
            </div>
            {/*
              DISABLED, NOT HIDDEN, and told why. A template is a blank form: opening one means
              filling it WITH somebody, so the missing piece is an employee. A control that
              disappears teaches nothing; one that explains itself teaches the next step.
            */}
            <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
              <Button
                className="h-9 gap-2"
                disabled={!employeeSelected}
                onClick={() => onOpen(template)}
                title={employeeSelected ? undefined : "Choose an employee above first."}
                variant="outline"
              >
                <PencilLine className="h-4 w-4" />
                Open
              </Button>
              <Button
                className="h-9 gap-2"
                disabled={!employeeSelected}
                onClick={() => onPrint(template)}
                title={employeeSelected ? undefined : "Choose an employee above first."}
                variant="outline"
              >
                <Printer className="h-4 w-4" />
                Print
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </AdminTableShell>
  );
}

/** A heading over related papers. Gone when a paper scope leaves it none, so no heading sits over nothing. */
function PaperGroup({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="space-y-2 [&:not(:has(h3))]:hidden">
      <h2 className={factLabelClassName}>{title}</h2>
      <div className="grid gap-2">{children}</div>
    </section>
  );
}

type DocumentCardProps = Parameters<typeof DocumentCardBody>[0] & {
  /** The paper this card prints — compared with the viewer's papers (`PaperScopeContext`). */
  document: HiringPackDocument;
};

/** One paper's card, or nothing when the paper is outside this viewer's papers. */
function DocumentCard({ document, ...props }: DocumentCardProps) {
  const scope = useContext(PaperScopeContext);
  if (scope && !scope.includes(document)) return null;
  return <DocumentCardBody {...props} />;
}

function DocumentCardBody({
  busy,
  canManage,
  copies,
  footnote,
  gaps,
  onCopiesChange,
  onPreview,
  onPrint,
  onSign,
  onSignDateChange,
  printedAt,
  printingNote,
  signDate,
  signedDate,
  signable = true,
  subtitle,
  title,
}: {
  busy: boolean;
  canManage: boolean;
  copies: string;
  /** Said only when the answer is surprising — see `contractVersionNote`. Usually null. */
  footnote?: string | null;
  gaps: HiringPackGap[];
  onCopiesChange: (value: string) => void;
  /** Open this document on screen as the page it prints as, with its values editable in place. */
  onPreview: () => void;
  onPrint: () => void;
  onSign: () => void;
  onSignDateChange: (value: string) => void;
  printedAt: string | null;
  printingNote: string;
  signDate: string;
  signedDate: string | null;
  /**
   * Whether this document's signature is recorded against the person.
   *
   * False on the custody receipts, and what it hides is a control that would have LIED: a date box
   * whose value has nowhere to be stored would report "Signed 30 Aug" for somebody holding three
   * devices signed for on three different days. Better to show no signature state at all than a
   * state that cannot be true. See `SIGNABLE_DOCUMENTS`.
   */
  signable?: boolean;
  subtitle: string;
  title: string;
}) {
  const blocking = gaps.filter((gap) => gap.blocking).length;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-");

  /*
    THE EMPTY-DATE REFUSAL IS SAID HERE, ON THE CARD, AND NOT ONLY AT THE TOP OF THE PAGE.
    `recordSignature` has always refused an empty date and called `setError` — and that banner
    renders beside the employee picker, several hundred pixels ABOVE the document cards. So pressing
    "Record signature" with an empty box did exactly nothing that the person pressing it could see:
    no request, no spinner, no message in view. Measured 2026-09-05, it cost four rounds of "I
    signed it" / "nothing was written", and the owner asked for the message to be where the button
    is. The page-level guard stays as the backstop; this one is what anybody actually reads.
  */
  const [emptyDateWarning, setEmptyDateWarning] = useState(false);
  // The signature line stays folded until it is wanted, or until the date it holds needs saying.
  const [signOpen, setSignOpen] = useState(false);
  const canSign = canManage && signable;
  const SignChevron = signOpen ? ChevronUp : ChevronDown;

  return (
    <div className="border border-phx-line bg-white shadow-none">
      <div className="flex flex-col gap-3 px-4 py-3 xl:flex-row xl:items-center xl:gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-black text-phx-ink">{title}</h3>
          <p className="break-words text-left text-phx-xs font-semibold text-phx-ink-soft" dir="auto">{subtitle}</p>
          <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">{printingNote}</p>
          {footnote ? (
            <p className="mt-1 flex items-start gap-1.5 text-phx-xs font-semibold text-phx-info">
              <Archive className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{footnote}</span>
            </p>
          ) : null}
        </div>

        <div className="text-phx-xs font-bold xl:w-44 xl:shrink-0">
          {!signable ? null : signedDate ? (
            <p className="text-phx-ok">Signed {formatDate(signedDate)}</p>
          ) : (
            <p className="text-phx-warn">Not signed</p>
          )}
          {blocking > 0 ? (
            <p className="text-phx-danger">{blocking} missing</p>
          ) : (
            <p className="text-phx-ok">Complete</p>
          )}
          <p className="font-semibold text-phx-ink-soft">Last printed: {formatStamp(printedAt)}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 xl:shrink-0">
          <label className="flex items-center gap-2 text-phx-xs font-bold text-phx-ink-soft" htmlFor={`hiring-pack-copies-${slug}`}>
            Copies
            <Input
              className={cn(inputClassName, "w-16")}
              id={`hiring-pack-copies-${slug}`}
              inputMode="numeric"
              max={20}
              min={1}
              onChange={(event) => onCopiesChange(event.target.value)}
              type="number"
              value={copies}
            />
          </label>
          {/*
            PREVIEW LEADS, PRINT FOLLOWS. The preview is the same page the printer gets, so reading
            it costs nothing and catches a wrong value while it is still free to fix — which is the
            whole reason it exists. Print stays one click away for the case where nothing needs
            checking, and it is the button that stamps the document as printed.
          */}
          <Button className="h-10 gap-2" onClick={onPreview} type="button">
            <FileText className="h-4 w-4" />
            Preview &amp; edit
          </Button>
          <Button className="h-10 gap-2" onClick={onPrint} type="button" variant="secondary">
            <Printer className="h-4 w-4" />
            Print
          </Button>
          {canSign ? (
            <Button
              aria-expanded={signOpen}
              className="h-10 gap-1.5"
              onClick={() => setSignOpen((open) => !open)}
              type="button"
              variant="ghost"
            >
              Signature
              <SignChevron className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      {canSign && signOpen ? (
        <div className="flex flex-wrap items-end gap-3 border-t border-phx-line px-4 py-3">
          <div>
            <label className={labelClassName} htmlFor={`hiring-pack-signed-${slug}`}>
              Date signed
            </label>
            <Input
              aria-describedby={emptyDateWarning ? `hiring-pack-signed-${slug}-error` : undefined}
              aria-invalid={emptyDateWarning || undefined}
              className={cn(inputClassName, "w-44", emptyDateWarning && "border-phx-danger-line")}
              id={`hiring-pack-signed-${slug}`}
              onChange={(event) => {
                if (event.target.value) setEmptyDateWarning(false);
                onSignDateChange(event.target.value);
              }}
              type="date"
              value={signDate}
            />
          </div>
          <Button
            className="h-10"
            onClick={() => {
              setEmptyDateWarning(false);
              onSignDateChange(todayInCairo());
            }}
            type="button"
            variant="secondary"
          >
            Today
          </Button>
          <Button
            className="h-10 gap-2"
            disabled={busy}
            onClick={() => {
              // Focus lands ON the empty box, so the fix is where the eye already went.
              if (!signDate) {
                setEmptyDateWarning(true);
                document.getElementById(`hiring-pack-signed-${slug}`)?.focus();
                return;
              }
              setEmptyDateWarning(false);
              onSign();
            }}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileSignature className="h-4 w-4" />
            )}
            {signedDate ? "Update signature date" : "Record signature"}
          </Button>
          {emptyDateWarning ? (
            <p
              className="w-full text-phx-xs font-semibold text-phx-danger"
              id={`hiring-pack-signed-${slug}-error`}
              role="alert"
            >
              Enter the date written on the signed paper first — or press Today. Nothing is
              recorded until this box has a date.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
