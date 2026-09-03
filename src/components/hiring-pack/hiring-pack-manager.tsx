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
  Loader2,
  Printer,
  Save,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { HiringPackPaperEditor } from "@/components/hiring-pack/paper-editor";
import {
  INSURANCE_WAGE_CEILING,
  INSURANCE_WAGE_DIVISOR,
  insuranceWageFromBase,
} from "@/lib/hiring-pack/insurance-wage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { systemContractDefaults } from "@/config/system-settings";
import {
  archivedTemplateVersions,
  findTemplateVersion,
} from "@/lib/hiring-pack/template-registry";
import type {
  ExitRoute,
  HiringPackCandidate,
  HiringPackData,
  HiringPackDocument,
  HiringPackGap,
  HiringPackProfileInput,
  OffboardingProfileInput,
} from "@/lib/hiring-pack/types";
import { cn } from "@/lib/utils";

const inputClassName =
  "h-10 rounded-xl border-phx-line bg-white/95 text-sm shadow-sm focus:border-phx-accent-line focus:ring-phx-accent/15";
const labelClassName =
  "mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";
const factLabelClassName =
  "text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint";

type FieldKind = "text" | "code" | "number" | "date";

type FieldDef<Key extends string = string> = {
  key: Key;
  labelEn: string;
  labelAr: string;
  kind: FieldKind;
  /** Sits under the input. Used where typing the wrong KIND of value is the likely mistake. */
  hint?: string;
  maxLength?: number;
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
    labelEn: "His title",
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
      note: "The employee asked to leave, under مادة 167. He signs; the company accepts; the labour office endorses it.",
    },
    {
      value: "mutualTermination",
      labelEn: "Mutual termination",
      labelAr: "إنهاء بالتوافق",
      note: "Both parties agreed to end the contract. Three pages, seven clauses, signed by both sides.",
    },
  ];

/** What each document is called in a sentence to the user. */
const DOCUMENT_LABELS: Record<HiringPackDocument, string> = {
  contract: "Contract",
  form1: "Form 1",
  workerDataForm: "Worker data form",
  custodyLaptop: "Laptop custody receipt",
  custodyMobile: "Phone/tablet custody receipt",
  form6: "Form 6",
  resignation: "Resignation request",
  mutualTermination: "Mutual termination agreement",
  clearanceEmployee: "Employee clearance",
  clearanceCompany: "Company clearance",
};

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

/** The standing copy count for each document — each one the form's own stated requirement. */
const DEFAULT_COPIES: Record<HiringPackDocument, number> = {
  contract: systemContractDefaults.contractCopies,
  form1: systemContractDefaults.form1Copies,
  workerDataForm: systemContractDefaults.workerDataFormCopies,
  custodyLaptop: systemContractDefaults.custodyLaptopCopies,
  custodyMobile: systemContractDefaults.custodyMobileCopies,
  form6: systemContractDefaults.form6Copies,
  resignation: systemContractDefaults.resignationCopies,
  mutualTermination: systemContractDefaults.mutualTerminationCopies,
  clearanceEmployee: systemContractDefaults.clearanceEmployeeCopies,
  clearanceCompany: systemContractDefaults.clearanceCompanyCopies,
};

/**
 * How many copies a document is about to be produced in, from whatever is in its box.
 *
 * Shared by the print button and the preview so the two cannot disagree: a preview showing one copy
 * of a contract that prints as four is a preview of a different document, and the count is exactly
 * the sort of thing nobody re-checks after reading the page. The clamp matches the route's own —
 * see `resolveCopies` there — because a value the server would reject must not be shown here as
 * though it had been accepted.
 */
function resolveCopyCount(raw: string | undefined, document: HiringPackDocument): number {
  const requested = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_COPIES[document];
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
  return parsed.toLocaleDateString("en-GB", {
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
  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

/**
 * Today, in Cairo.
 *
 * Computed on demand rather than at render, so the server and the browser never disagree about what
 * day it is during hydration — and read in Cairo rather than off the machine's clock, because a
 * signature recorded at 1am from a laptop left on UTC would otherwise be dated to yesterday.
 */
function todayInCairo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
}

function candidateLabel(candidate: HiringPackCandidate): string {
  const parts = [candidate.hrId, candidate.fullName];
  if (candidate.nameAr) parts.push(candidate.nameAr);
  if (candidate.jobTitle) parts.push(candidate.jobTitle);
  // A leaver carries the date they left, because that is what identifies them here: two people can
  // share a job title, and the one whose Form 6 is due is the one who left last week.
  if (candidate.departed && candidate.lastWorkingDate) {
    parts.push(`left ${candidate.lastWorkingDate}`);
  }
  return parts.join(" · ");
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

type Props = {
  canManage: boolean;
  candidates: HiringPackCandidate[];
  initialError: string | null;
  initialPack: HiringPackData | null;
  /** Every sales line, for the "Department" picker on the facts editor. */
  lines: { id: number; name: string }[];
};

export function HiringPackManager({
  canManage,
  candidates,
  initialError,
  initialPack,
  lines,
}: Props) {
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
  const [copies, setCopies] = useState<Record<HiringPackDocument, string>>(() =>
    signDatesShape((document) => String(DEFAULT_COPIES[document])),
  );
  const [signDates, setSignDates] = useState<Record<HiringPackDocument, string>>(() =>
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
   * `versionId` is only ever set from the Archive, where the point is to look at a SUPERSEDED
   * template. Null means the same thing it means to the print route: not "the current text", but
   * "whichever version this employee's signature resolves to".
   */
  const [preview, setPreview] = useState<{
    document: HiringPackDocument;
    versionId: string | null;
  } | null>(null);
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

  const selectEmployee = useCallback(
    async (hrId: string) => {
      setSelectedHrId(hrId);
      setNotice(null);
      setError(null);
      // A preview is one person's paper. Leaving it open across a change of employee would show the
      // previous person's document under the new person's name until it happened to reload.
      setPreview(null);
      if (!hrId) {
        setPack(null);
        setForm(emptyForm());
        return;
      }
      setBusy("load");
      try {
        const response = await fetch(`/api/hiring-pack/${encodeURIComponent(hrId)}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          setPack(null);
          setError(await readError(response));
          return;
        }
        applyPack((await response.json()) as HiringPackData);
      } catch (cause) {
        setPack(null);
        setError(cause instanceof Error ? cause.message : "Could not load this employee.");
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
        applyPack((await response.json()) as HiringPackData);
        setNotice(`${DOCUMENT_LABELS[document]} recorded as signed on ${formatDate(signedDate)}.`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not record the signature.");
      } finally {
        setBusy("");
      }
    },
    [applyPack, pack, readError, signDates],
  );

  /**
   * Printing opens the rendered document in its own tab, where the browser's own print dialog does
   * the rest. That is on purpose: the browser is the only thing in the stack that lays Arabic out
   * correctly, and "Print → Save as PDF" from that tab produces a real PDF with selectable text.
   */
  const openPrint = useCallback(
    (document: HiringPackDocument, versionId?: string) => {
      if (!pack) return;
      const count = resolveCopyCount(copies[document], document);
      // No `version` parameter is the normal case, and it does NOT mean "print the current text":
      // the route resolves the version this employee signed. The parameter is only for deliberately
      // asking for a superseded template from the Archive.
      const version = versionId ? `&version=${encodeURIComponent(versionId)}` : "";
      const url = `/api/hiring-pack/${encodeURIComponent(pack.employee.hrId)}/print?document=${document}&copies=${count}${version}`;
      window.open(url, "_blank", "noopener,noreferrer");
    },
    [copies, pack],
  );

  /**
   * Open a document on screen as the page it prints as.
   *
   * Deliberately does NOT go through `openPrint`: the preview asks the same route for the same
   * bytes but with `preview=1`, which is what stops a look at the paper being recorded as a print.
   */
  const openPreview = useCallback((document: HiringPackDocument, versionId?: string) => {
    setError(null);
    setNotice(null);
    setPreview({ document, versionId: versionId ?? null });
  }, []);

  const setCopiesFor = useCallback((document: HiringPackDocument, value: string) => {
    setCopies((current) => ({ ...current, [document]: value }));
  }, []);

  const setSignDateFor = useCallback((document: HiringPackDocument, value: string) => {
    setSignDates((current) => ({ ...current, [document]: value }));
  }, []);

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
    <div className="relative overflow-clip rounded-[34px] border border-phx-line bg-phx-paper p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div className="flex flex-col gap-5">
        <AdminPageHero
          badges={
            <>
              <AdminInsightChip tone="orange">{currentCount} on staff</AdminInsightChip>
              <AdminInsightChip tone="orange">{departedCount} left</AdminInsightChip>
              <AdminInsightChip>
                Joining · contract + Form 1
              </AdminInsightChip>
              <AdminInsightChip>
                Leaving · Form 6 + one exit form
              </AdminInsightChip>
            </>
          }
          description="Fill the five statutory documents from the employee record, print them ready to sign, and record the date they were signed. Nothing is filled in by hand."
          eyebrow="Employee documents"
          icon={<FileSignature className="h-5 w-5" />}
          title="HR Forms"
        />

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

        {/*
          THE OPEN DOCUMENT SITS AT THE TOP, above the fill boxes rather than beside the card it was
          opened from. Whichever of the nine is open, it appears in the same place — and the values
          in it are the same values the boxes below hold, so having both on screen at once is what
          makes the connection between them obvious instead of something to be learned.
        */}
        {pack && preview ? (
          <HiringPackPaperEditor
            copies={resolveCopyCount(copies[preview.document], preview.document)}
            documentKey={preview.document}
            documentLabel={DOCUMENT_LABELS[preview.document]}
            hrId={pack.employee.hrId}
            key={`${pack.employee.hrId}-${preview.document}-${preview.versionId ?? "current"}`}
            onClose={() => setPreview(null)}
            onPackChange={applyPack}
            pack={pack}
            versionId={preview.versionId}
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
        <div className="sticky top-2 z-30 rounded-2xl border border-slate-200/90 bg-white/95 px-4 py-3 shadow-[0_12px_32px_rgba(15,23,42,0.10)] backdrop-blur-sm sm:px-5">
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
                {candidates.map((candidate) => (
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
            <div className="rounded-2xl border border-slate-200/90 bg-white/95 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.08)] sm:p-5">
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
                <div className="mt-4 flex flex-col gap-3 border-t border-slate-200/80 pt-4">
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
                    className="h-11 gap-2 rounded-2xl"
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
                <div className="rounded-xl border border-phx-line bg-white/95 px-3.5 py-2.5 shadow-sm sm:max-w-xs">
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
                    <div>
                      <label className={labelClassName} htmlFor="hiring-pack-fact-baseSalary">
                        Base salary <span className="text-phx-ink-faint">الأجر الأساسي · EGP</span>
                      </label>
                      <Input
                        className={inputClassName}
                        disabled={!canManage || employee.departed}
                        id="hiring-pack-fact-baseSalary"
                        inputMode="decimal"
                        onChange={(event) =>
                          setFactsForm((current) => ({ ...current, baseSalary: event.target.value }))
                        }
                        type="number"
                        value={factsForm.baseSalary ?? ""}
                      />
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
                <AdminTableShell
                  action={
                    canManage ? (
                      <Button
                        className="h-11 gap-2 rounded-2xl"
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
                      disabled={!canManage}
                      fields={TERM_FIELDS}
                      form={form}
                      onChange={setForm}
                      subtitle={`Blank uses the standard term — ${pack.terms.durationMonths} months, ${pack.terms.probationMonths}-month probation, ${pack.terms.underperformanceThresholdPct}% over ${pack.terms.underperformanceMonths} months, ${pack.terms.trainingBondMonths}-month training bond.`}
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

                <div className="grid gap-3 lg:grid-cols-2">
                  <DocumentCard
                    busy={busy === "sign-contract"}
                    canManage={canManage}
                    copies={copies.contract}
                    gaps={gapsFor(pack.gaps, "contract")}
                    onCopiesChange={(value) => setCopiesFor("contract", value)}
                    footnote={contractVersionNote(pack.profile.contractTemplateVersion)}
                    onPreview={() => openPreview("contract")}
                    onPrint={() => openPrint("contract")}
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
                    copies={copies.form1}
                    gaps={gapsFor(pack.gaps, "form1")}
                    onCopiesChange={(value) => setCopiesFor("form1", value)}
                    onPreview={() => openPreview("form1")}
                    onPrint={() => openPrint("form1")}
                    onSign={() => void recordSignature("form1")}
                    onSignDateChange={(value) => setSignDateFor("form1", value)}
                    printedAt={pack.profile.form1PrintedAt}
                    printingNote="MUST be printed double-sided. Set the printer to two-sided, flip on the long edge, US Legal paper."
                    signDate={signDates.form1}
                    signedDate={pack.profile.form1SignedDate}
                    subtitle="نموذج ١ — طلب اشتراك مؤمن عليه"
                    title="Social insurance Form 1"
                  />
                </div>

                {/*
                  The worker-data form — استمارة بيانات العامل — is Sato's own service-file intake sheet,
                  filled on the first day and kept in the personnel file (its header says "تُحفظ بملف
                  الخدمة"). It is not signature-tracked, for the same reason the custody receipts are not:
                  a paper filed in a drawer, where the honest record is none. See `SIGNABLE_DOCUMENTS`.
                */}
                <div className="grid gap-3">
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    copies={copies.workerDataForm}
                    gaps={gapsFor(pack.gaps, "workerDataForm")}
                    onCopiesChange={(value) => setCopiesFor("workerDataForm", value)}
                    footnote="A service-file sheet, not a government form. Everything Phoenix already knows — name, national ID, job, insurance number — is filled; the fields it holds no record of (marital status, military-service position, bank and IBAN, next of kin) print blank for a pen."
                    onPreview={() => openPreview("workerDataForm")}
                    onPrint={() => openPrint("workerDataForm")}
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
                </div>

                {/*
                  THE CUSTODY RECEIPTS SIT BETWEEN THE TWO HALVES, because that is where they belong in
                  a career: they are printed whenever a device changes hands, which is neither arrival
                  nor departure and is usually both at least once in between.

                  Both are always offered, unlike the two exit forms. The exit forms are alternatives —
                  one is signed and the other must not be — while these two are simply different
                  devices, and somebody who is handed a laptop and a phone on his first morning needs
                  both papers on his first morning.
                */}
                <div className="grid gap-3 lg:grid-cols-2">
                  <DocumentCard
                    busy={false}
                    canManage={canManage}
                    copies={copies.custodyLaptop}
                    gaps={gapsFor(pack.gaps, "custodyLaptop")}
                    onCopiesChange={(value) => setCopiesFor("custodyLaptop", value)}
                    footnote="The device details, values and handover date print blank — Phoenix holds no asset register, and a serial number is read off the machine rather than recalled. The name, ID, job title and address are filled."
                    onPreview={() => openPreview("custodyLaptop")}
                    onPrint={() => openPrint("custodyLaptop")}
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
                    copies={copies.custodyMobile}
                    gaps={gapsFor(pack.gaps, "custodyMobile")}
                    onCopiesChange={(value) => setCopiesFor("custodyMobile", value)}
                    footnote="Same paper as the laptop receipt, with the phone's own item list and an IMEI and SIM block in place of the Windows fields."
                    onPreview={() => openPreview("custodyMobile")}
                    onPrint={() => openPrint("custodyMobile")}
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
                </div>
              </div>
            ) : null}

            {activePackage === "leaver" ? (
              <div className="flex flex-col gap-5">
                <AdminTableShell
                  action={
                    canManage ? (
                      <Button
                        className="h-11 gap-2 rounded-2xl"
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
                      <div className="rounded-xl border border-phx-line bg-phx-paper px-3.5 py-2.5">
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
                                "rounded-2xl border px-4 py-3 text-left transition",
                                selected
                                  ? "border-phx-accent-line bg-phx-accent/10 shadow-sm"
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

                <div className="grid gap-3 lg:grid-cols-2">
                  <DocumentCard
                    busy={busy === "sign-form6"}
                    canManage={canManage}
                    copies={copies.form6}
                    gaps={gapsFor(pack.gaps, "form6")}
                    onCopiesChange={(value) => setCopiesFor("form6", value)}
                    onPreview={() => openPreview("form6")}
                    onPrint={() => openPrint("form6")}
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
                      copies={copies.resignation}
                      gaps={gapsFor(pack.gaps, "resignation")}
                      onCopiesChange={(value) => setCopiesFor("resignation", value)}
                      onPreview={() => openPreview("resignation")}
                      onPrint={() => openPrint("resignation")}
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
                      copies={copies.mutualTermination}
                      gaps={gapsFor(pack.gaps, "mutualTermination")}
                      onCopiesChange={(value) => setCopiesFor("mutualTermination", value)}
                      onPreview={() => openPreview("mutualTermination")}
                      onPrint={() => openPrint("mutualTermination")}
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
                    copies={copies.clearanceEmployee}
                    gaps={gapsFor(pack.gaps, "clearanceEmployee")}
                    onCopiesChange={(value) => setCopiesFor("clearanceEmployee", value)}
                    onPreview={() => openPreview("clearanceEmployee")}
                    onPrint={() => openPrint("clearanceEmployee")}
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
                    copies={copies.clearanceCompany}
                    gaps={gapsFor(pack.gaps, "clearanceCompany")}
                    onCopiesChange={(value) => setCopiesFor("clearanceCompany", value)}
                    onPreview={() => openPreview("clearanceCompany")}
                    onPrint={() => openPrint("clearanceCompany")}
                    onSign={() => void recordSignature("clearanceCompany")}
                    onSignDateChange={(value) => setSignDateFor("clearanceCompany", value)}
                    printedAt={pack.offboarding.clearanceCompanyPrintedAt}
                    printingNote="Single-sided, A4, background graphics ON. The settlement amount prints blank on purpose — this paper is a release of claims, so the figure has to be the one finance actually paid."
                    signDate={signDates.clearanceCompany}
                    signedDate={pack.offboarding.clearanceCompanySignedDate}
                    subtitle="إخلاء طرف شركة — يقر به الموظف، وتحتفظ به الشركة"
                    title="Company clearance"
                  />
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <AdminCallout>
            <UserRound className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Choose an employee above to fill and print the hiring pack.</span>
          </AdminCallout>
        )}

        <TemplateArchive
          employeeSelected={Boolean(pack)}
          onPreview={(document, versionId) => openPreview(document, versionId)}
          onPrint={(document, versionId) => openPrint(document, versionId)}
        />
      </div>
    </div>
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
              <Input
                className={inputClassName}
                disabled={disabled}
                id={`hiring-pack-${field.key}`}
                inputMode={field.kind === "code" || field.kind === "number" ? "numeric" : undefined}
                maxLength={field.maxLength}
                onChange={(event) =>
                  onChange((current) => ({ ...current, [field.key]: event.target.value }))
                }
                type={field.kind === "date" ? "date" : field.kind === "number" ? "number" : "text"}
                value={currentValue}
              />
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
          className="h-10 gap-2 rounded-xl"
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
                      {DOCUMENT_LABELS[entry.document]}
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
                    className="h-10 gap-2 rounded-xl"
                    disabled={!employeeSelected}
                    onClick={() => onPreview(entry.document, entry.id)}
                    type="button"
                    variant="outline"
                  >
                    <FileText className="h-4 w-4" />
                    Read it
                  </Button>
                  <Button
                    className="h-10 gap-2 rounded-xl"
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
        "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold ring-1 ring-inset",
        signed
          ? "border-phx-ok-line bg-phx-ok-bg text-phx-ok ring-phx-ok-line"
          : "border-phx-warn-line bg-phx-warn-bg text-phx-warn ring-phx-warn-line",
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

function DocumentCard({
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

  return (
    <AdminTableShell description={subtitle} title={title}>
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          {!signable ? null : signedDate ? (
            <Badge variant="success">Signed {formatDate(signedDate)}</Badge>
          ) : (
            <Badge variant="warning">Not signed</Badge>
          )}
          {blocking > 0 ? (
            <Badge variant="danger">{blocking} missing</Badge>
          ) : (
            <Badge variant="success">Complete</Badge>
          )}
          <span className="text-xs font-semibold text-phx-ink-soft">
            Last printed: {formatStamp(printedAt)}
          </span>
        </div>

        <p className="rounded-xl border border-phx-line bg-phx-paper px-3.5 py-2.5 text-xs font-bold text-phx-ink-2">
          {printingNote}
        </p>

        {footnote ? (
          <p className="flex items-start gap-2 rounded-xl border border-phx-info-line bg-phx-info-bg px-3.5 py-2.5 text-xs font-bold text-phx-info">
            <Archive className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{footnote}</span>
          </p>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelClassName} htmlFor={`hiring-pack-copies-${slug}`}>
              Copies
            </label>
            <Input
              className={cn(inputClassName, "w-24")}
              id={`hiring-pack-copies-${slug}`}
              inputMode="numeric"
              max={20}
              min={1}
              onChange={(event) => onCopiesChange(event.target.value)}
              type="number"
              value={copies}
            />
          </div>
          {/*
            PREVIEW LEADS, PRINT FOLLOWS. The preview is the same page the printer gets, so reading
            it costs nothing and catches a wrong value while it is still free to fix — which is the
            whole reason it exists. Print stays one click away for the case where nothing needs
            checking, and it is the button that stamps the document as printed.
          */}
          <Button className="h-11 gap-2 rounded-2xl" onClick={onPreview} type="button">
            <FileText className="h-4 w-4" />
            Preview &amp; edit
          </Button>
          <Button
            className="h-11 gap-2 rounded-2xl"
            onClick={onPrint}
            type="button"
            variant="outline"
          >
            <Printer className="h-4 w-4" />
            Print
          </Button>
        </div>

        {canManage && signable ? (
          <div className="flex flex-wrap items-end gap-3 border-t border-phx-line pt-4">
            <div>
              <label className={labelClassName} htmlFor={`hiring-pack-signed-${slug}`}>
                Date signed
              </label>
              <Input
                className={cn(inputClassName, "w-44")}
                id={`hiring-pack-signed-${slug}`}
                onChange={(event) => onSignDateChange(event.target.value)}
                type="date"
                value={signDate}
              />
            </div>
            <Button
              className="h-10 rounded-xl"
              onClick={() => onSignDateChange(todayInCairo())}
              type="button"
              variant="outline"
            >
              Today
            </Button>
            <Button className="h-11 gap-2 rounded-2xl" disabled={busy} onClick={onSign}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileSignature className="h-4 w-4" />
              )}
              {signedDate ? "Update signature date" : "Record signature"}
            </Button>
          </div>
        ) : null}
      </div>
    </AdminTableShell>
  );
}
