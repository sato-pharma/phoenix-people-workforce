// Which values on a printed page can be edited ON the page, and where each one is stored.
//
// WHY THIS FILE EXISTS. The nine documents this module prints are built by three different
// mechanisms — the contract fills `{{TOKEN}}` markers into legal prose, the government forms place
// values over artwork by coordinate, and the custody and clearance instruments fill labelled cells —
// and each names its values differently. `nationalId`, `NATIONAL_ID` and the labour templates' own
// `nationalId` are the same fact written three ways. This is the one table that says so, and the one
// table that says where writing it lands.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT IS AN ALLOW-LIST, AND THAT IS THE POINT. A value the paper shows is editable on the paper ONLY
// if it appears below. Everything else — the company's own commercial register, a derived salary in
// words, the department name, today's date — is rendered as read-only, deliberately. Two different
// failures are being prevented and they pull in opposite directions:
//
//   1. Editing something that has nowhere to go. A span that accepts a keystroke and silently
//      discards it is the exact defect the owner reported on 2026-08-31 — "I change and edit and
//      save, but what appears when printing is the value before I changed it". A value that cannot
//      be saved must not look like one that can.
//   2. Editing something that reaches further than the page. `COMPANY_NAME` is not this employee's
//      field; it is the legal entity's, shared by every document and every employee. Typing over it
//      on one contract must never rewrite it FOR THAT ONE EMPLOYEE.
//
// So: bound values are editable and persist. Unbound values are inert unless the operator turns on
// free-text editing explicitly, which marks the page as a one-off and never writes to the database.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE COMPANY STORE — 2026-09-06, and it is the answer to failure 2 rather than an exception to it.
//
// Failure 2 used to be prevented by refusing the edit: `COMPANY_HEAD_OFFICE` and its neighbours had
// no binding, so they rendered locked. That kept the papers consistent and left the company's own
// address correctable only by a code change — which is what the owner asked to end: the address on
// the HR forms must be editable, "every single thing should be editable".
//
// The fix is not to point those tokens at the employee record. It is a FOURTH store whose scope is
// the company: `hiring_pack_company_details`, one row per value, no employee column. An edit there
// reaches every document for every employee at once, which is not a leak — it is what a registered
// address IS. The editor says so in the sentence it reports the save with, and the write is Super
// Admin only, because changing what every future contract states about the company is a different
// act from correcting one person's national ID.
//
// So both failures stay prevented, and the reason each token is locked or open is now a statement
// about WHERE the value lives rather than about whether anyone may ever fix it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// WHAT IS DELIBERATELY NOT HERE. Derived values follow their source rather than being typed over:
// `SALARY_WORDS` is the salary spelled out and has to agree with `SALARY_FIGURES` digit for digit —
// مادة (2) prints both — so editing the words alone would produce a contract that contradicts
// itself. `DURATION`, `DEPARTMENT`, `HR_ID` and `ISSUE_DATE` are the same shape of fact: computed,
// or owned by somewhere else. Today's date on Form 1 (`writtenDay`/`Month`/`Year`) is the day the
// form is filled in and is not anybody's to type.

import {
  flattenCompanyDetails,
  isCompanyDetailKey,
  type CompanyDetailKey,
} from "@/lib/hiring-pack/company-details";
import { splitTaxRegistration } from "@/lib/hiring-pack/render-shared";
import type {
  HiringPackData,
  HiringPackEmployeeFactsInput,
  HiringPackProfileInput,
  OffboardingProfileInput,
} from "@/lib/hiring-pack/types";

/**
 * Which save endpoint a field belongs to.
 *
 * THE FIRST THREE ARE THIS PERSON'S; THE FOURTH IS THE COMPANY'S. That is the only difference that
 * matters when reading a binding: an `employee`, `profile` or `offboarding` edit changes one
 * personnel file, and a `company` edit changes what every document states about the employer. See
 * the header.
 */
export type PaperStore = "employee" | "profile" | "offboarding" | "company";

/**
 * How the typed text becomes a stored value.
 *
 * `date` reads a whole date off one span. `dateDay` / `dateMonth` / `dateYear` each read ONE
 * component of a date that the paper prints in separate boxes — Form 1's start date is three
 * grids, not one rule — and patch that component into the date the other two already agree on.
 *
 * `taxPart1` / `taxPart2` / `taxPart3` are the same idea applied to the tax registration number,
 * which Form 1 and Form 6 print as three separate runs with the form's own "/" between them. One
 * stored number, three printed boxes: editing a box patches its own third and leaves the other two
 * exactly as they are, so correcting a mistyped middle group cannot silently rewrite the whole
 * number.
 */
export type PaperFieldKind =
  | "text"
  | "money"
  | "date"
  | "dateDay"
  | "dateMonth"
  | "dateYear"
  | "taxPart1"
  | "taxPart2"
  | "taxPart3";

export type PaperFieldBinding = {
  store: PaperStore;
  /**
   * The property name on the store's own `*Input` type — or, for the `company` store, the storage
   * key from `COMPANY_DETAIL_FIELDS`.
   */
  field: string;
  kind: PaperFieldKind;
  /** Named in the editor so the operator knows what they are changing, and where it will show up. */
  labelEn: string;
  /**
   * The other documents this same value prints on, named in plain words.
   *
   * Shown when the value is edited, because that is the whole reason these documents share one
   * record: an address corrected on the contract is corrected on Form 1 and Form 6 too, and an
   * operator who does not know that will go and type it again somewhere else.
   */
  alsoOn?: string;
  /**
   * Where the paper reads this value from when the bound field is empty.
   *
   * NOT A CONVENIENCE — it mirrors a `??` chain that already exists in a renderer, and every one of
   * them was found by reading the renderers rather than guessed. A binding without a declared
   * fallback whose renderer has one makes this file disagree with the printed page, silently:
   * `tests/hiring-pack-paper-editor.test.ts` pins the four that exist.
   *
   * ONE LINK IS DELIBERATELY NOT MODELLED. `render-clearance.ts` reads a last working day as
   * `offboarding ?? the resignation record ?? the employee row`; the middle link needs a fourth
   * table. Measured on production 2026-09-04: of 61 leavers, 61 carry `employees.last_working_date`
   * and ZERO hold a date only in `employee_resignations`, so the two links below are exact against
   * today's data. If that ever stops being true the count under-reports, which flags more rows
   * rather than fewer.
   */
  printFallback?: { store: PaperStore; field: string };
};

/**
 * Every editable value, keyed by the marker its renderer emits.
 *
 * SEVERAL KEYS SHARE ONE FIELD ON PURPOSE. `EMPLOYEE_NAME` (contract, custody, clearance),
 * `insuredName` (Forms 1 and 6) and `employeeName` (the labour templates) are one person's Arabic
 * name, and all three write `employees.name_ar`. That is what makes the pack coherent: the name is
 * typed once and every paper agrees.
 */
export const PAPER_FIELD_BINDINGS: Readonly<Record<string, PaperFieldBinding>> = {
  // ── The person, on the employee record ──────────────────────────────────────────────────────
  EMPLOYEE_NAME: {
    store: "employee",
    field: "nameAr",
    printFallback: { store: "employee", field: "fullName" },
    kind: "text",
    labelEn: "Employee name (Arabic)",
    alsoOn: "every document in the pack",
  },
  insuredName: {
    store: "employee",
    field: "nameAr",
    printFallback: { store: "employee", field: "fullName" },
    kind: "text",
    labelEn: "Employee name (Arabic)",
    alsoOn: "every document in the pack",
  },
  employeeName: {
    store: "employee",
    field: "nameAr",
    printFallback: { store: "employee", field: "fullName" },
    kind: "text",
    labelEn: "Employee name (Arabic)",
    alsoOn: "every document in the pack",
  },
  NATIONAL_ID: {
    store: "employee",
    field: "nationalId",
    kind: "text",
    labelEn: "National ID",
    alsoOn: "the contract, both insurance forms, custody and clearance",
  },
  nationalId: {
    store: "employee",
    field: "nationalId",
    kind: "text",
    labelEn: "National ID",
    alsoOn: "the contract, both insurance forms, custody and clearance",
  },
  INSURANCE_NUMBER: {
    store: "employee",
    field: "socialInsuranceNumber",
    kind: "text",
    labelEn: "Insurance number",
    alsoOn: "the contract and both insurance forms",
  },
  insuranceNumber: {
    store: "employee",
    field: "socialInsuranceNumber",
    kind: "text",
    labelEn: "Insurance number",
    alsoOn: "the contract and both insurance forms",
  },
  PHONE: { store: "employee", field: "mobileNumber", kind: "text", labelEn: "Mobile number" },
  phone: { store: "employee", field: "mobileNumber", kind: "text", labelEn: "Mobile number" },
  EMAIL: { store: "employee", field: "workEmail", kind: "text", labelEn: "Work email" },
  email: { store: "employee", field: "workEmail", kind: "text", labelEn: "Work email" },
  ADDRESS: {
    store: "employee",
    field: "residenceAddress",
    kind: "text",
    labelEn: "Home address",
    alsoOn: "the contract, custody, clearance and the labour forms",
  },
  address: {
    store: "employee",
    field: "residenceAddress",
    kind: "text",
    labelEn: "Home address",
    alsoOn: "the contract, custody, clearance and the labour forms",
  },
  BIRTH_DATE: { store: "employee", field: "birthDate", kind: "date", labelEn: "Date of birth" },
  HIRE_DATE: { store: "employee", field: "hireDate", kind: "date", labelEn: "Hire date" },
  SALARY_FIGURES: {
    store: "employee",
    field: "baseSalary",
    kind: "money",
    labelEn: "Base salary",
    alsoOn: "the salary in words beside it, and the insurance wage on the contract and Form 1",
  },

  // INSURANCE_WAGE is deliberately absent, so it renders read-only. It is no longer a number anyone
  // types: it is the base salary divided by 1.3 and capped (`insurance-wage.ts`). Binding it would
  // accept a figure, save nothing that affects it, and redraw the derived value over the top —
  // which is precisely the "I edit it and the old value still prints" complaint this screen exists
  // to answer. Edit the base salary and the insurance wage follows.

  // ── The hiring profile ──────────────────────────────────────────────────────────────────────
  JOB_TITLE: {
    store: "profile",
    field: "jobTitleAr",
    kind: "text",
    labelEn: "Job title (Arabic)",
    alsoOn: "the contract, Form 1, custody, clearance and the labour forms",
  },
  jobTitleAr: {
    store: "profile",
    field: "jobTitleAr",
    kind: "text",
    labelEn: "Job title (Arabic)",
    alsoOn: "the contract, Form 1, custody, clearance and the labour forms",
  },
  jobTitle: {
    store: "profile",
    field: "jobTitleAr",
    kind: "text",
    labelEn: "Job title (Arabic)",
    alsoOn: "the contract, Form 1, custody, clearance and the labour forms",
  },
  NATIONALITY: { store: "profile", field: "nationality", kind: "text", labelEn: "Nationality" },
  nationality: { store: "profile", field: "nationality", kind: "text", labelEn: "Nationality" },
  QUALIFICATION: { store: "profile", field: "qualification", kind: "text", labelEn: "Qualification" },
  qualification: { store: "profile", field: "qualification", kind: "text", labelEn: "Qualification" },
  BIRTH_PLACE: { store: "profile", field: "birthPlace", kind: "text", labelEn: "Place of birth" },
  // THE ONE COMPANY-SIDE VALUE THAT IS THIS EMPLOYEE'S. Everything else the company states about
  // itself — its name, its registers, its head office — is the legal entity's and is deliberately
  // read-only here, because typing over it on one contract would rewrite it for everyone. Who
  // SIGNED is different: it is a fact about this instrument, it is stored per employee, and it is
  // NULL until somebody other than the standing signatory signs.
  CONTRACT_SIGNATORY: {
    store: "profile",
    field: "contractSignatoryNameAr",
    kind: "text",
    labelEn: "Signed for the company by",
  },
  CONTRACT_SIGNATORY_TITLE: {
    store: "profile",
    field: "contractSignatoryTitleAr",
    kind: "text",
    labelEn: "Signatory's capacity",
  },
  // The company default is a real link in the printed chain — `render-form1.ts` fills this rule as
  // `profile.insuranceOffice ?? registration.defaultInsuranceOffice` — so the edit box seeds from
  // it rather than opening empty beside a form that visibly shows an office. Writing still lands on
  // THIS employee's profile: choosing an office for one person is not choosing it for everybody.
  insuranceOffice: {
    store: "profile",
    field: "insuranceOffice",
    printFallback: { store: "company", field: "defaultInsuranceOffice" },
    kind: "text",
    labelEn: "Insurance office",
    alsoOn: "Form 1 and Form 6",
  },
  addressBuilding: {
    store: "profile",
    field: "addressBuilding",
    kind: "text",
    labelEn: "Building number",
    alsoOn: "Form 1 and Form 6",
  },
  addressStreet: {
    store: "profile",
    field: "addressStreet",
    printFallback: { store: "employee", field: "residenceAddress" },
    kind: "text",
    labelEn: "Street",
    alsoOn: "Form 1 and Form 6",
  },
  addressDistrict: {
    store: "profile",
    field: "addressDistrict",
    kind: "text",
    labelEn: "Sheyakha / village code",
    alsoOn: "Form 1 and Form 6",
  },
  addressMarkaz: {
    store: "profile",
    field: "addressMarkaz",
    kind: "text",
    labelEn: "Qism / markaz code",
    alsoOn: "Form 1 and Form 6",
  },
  addressGovernorate: {
    store: "profile",
    field: "addressGovernorate",
    kind: "text",
    labelEn: "Governorate code",
    alsoOn: "Form 1 and Form 6",
  },
  // Form 1 prints the contract start date as three separate box grids, so each is bound to its own
  // component of one date rather than to three fields that could disagree.
  startDay: {
    store: "profile",
    field: "contractStartDate",
    kind: "dateDay",
    labelEn: "Start day",
    printFallback: { store: "employee", field: "hireDate" },
  },
  startMonth: {
    store: "profile",
    field: "contractStartDate",
    printFallback: { store: "employee", field: "hireDate" },
    kind: "dateMonth",
    labelEn: "Start month",
  },
  startYear: {
    store: "profile",
    field: "contractStartDate",
    printFallback: { store: "employee", field: "hireDate" },
    kind: "dateYear",
    labelEn: "Start year",
  },
  contractStartDay: {
    store: "profile",
    field: "contractStartDate",
    printFallback: { store: "employee", field: "hireDate" },
    kind: "dateDay",
    labelEn: "Contract start day",
  },
  contractStartMonth: {
    store: "profile",
    field: "contractStartDate",
    printFallback: { store: "employee", field: "hireDate" },
    kind: "dateMonth",
    labelEn: "Contract start month",
  },
  contractStartYear: {
    store: "profile",
    field: "contractStartDate",
    printFallback: { store: "employee", field: "hireDate" },
    kind: "dateYear",
    labelEn: "Contract start year",
  },

  // ── The leaving side ────────────────────────────────────────────────────────────────────────
  endReason: {
    store: "offboarding",
    field: "endReasonAr",
    kind: "text",
    labelEn: "Reason for leaving",
    alsoOn: "Form 6 and the resignation request",
  },
  resignationReason: {
    store: "offboarding",
    field: "endReasonAr",
    kind: "text",
    labelEn: "Reason for leaving",
    alsoOn: "Form 6 and the resignation request",
  },
  endReasonCode: {
    store: "offboarding",
    field: "endReasonCode",
    kind: "text",
    labelEn: "Reason code",
  },
  addresseeName: {
    store: "offboarding",
    field: "addresseeNameAr",
    kind: "text",
    labelEn: "Addressed to",
  },
  addresseeTitle: {
    store: "offboarding",
    field: "addresseeTitleAr",
    kind: "text",
    labelEn: "Addressee title",
  },
  employerRepName: {
    store: "offboarding",
    field: "employerRepNameAr",
    kind: "text",
    labelEn: "Company representative",
    alsoOn: "both exit templates",
  },
  employerRepTitle: {
    store: "offboarding",
    field: "employerRepTitleAr",
    kind: "text",
    labelEn: "Representative title",
    alsoOn: "both exit templates",
  },
  lastWorkingDate: {
    store: "offboarding",
    field: "lastWorkingDate",
    printFallback: { store: "employee", field: "lastWorkingDate" },
    kind: "date",
    labelEn: "Last working day",
    alsoOn: "Form 6 and both exit templates",
  },
  LAST_WORKING_DATE: {
    store: "offboarding",
    field: "lastWorkingDate",
    printFallback: { store: "employee", field: "lastWorkingDate" },
    kind: "date",
    labelEn: "Last working day",
    alsoOn: "Form 6 and both exit templates",
  },
  lastWorkingDay: {
    store: "offboarding",
    field: "lastWorkingDate",
    printFallback: { store: "employee", field: "lastWorkingDate" },
    kind: "dateDay",
    labelEn: "Last working day (day)",
  },
  lastWorkingMonth: {
    store: "offboarding",
    field: "lastWorkingDate",
    printFallback: { store: "employee", field: "lastWorkingDate" },
    kind: "dateMonth",
    labelEn: "Last working day (month)",
  },
  lastWorkingYear: {
    store: "offboarding",
    field: "lastWorkingDate",
    printFallback: { store: "employee", field: "lastWorkingDate" },
    kind: "dateYear",
    labelEn: "Last working day (year)",
  },
  endDay: {
    store: "offboarding",
    field: "lastWorkingDate",
    printFallback: { store: "employee", field: "lastWorkingDate" },
    kind: "dateDay",
    labelEn: "End of subscription (day)",
  },
  endMonth: {
    store: "offboarding",
    field: "lastWorkingDate",
    printFallback: { store: "employee", field: "lastWorkingDate" },
    kind: "dateMonth",
    labelEn: "End of subscription (month)",
  },
  endYear: {
    store: "offboarding",
    field: "lastWorkingDate",
    printFallback: { store: "employee", field: "lastWorkingDate" },
    kind: "dateYear",
    labelEn: "End of subscription (year)",
  },
  agreementDay: {
    store: "offboarding",
    field: "agreementDate",
    kind: "dateDay",
    labelEn: "Agreement date (day)",
  },
  agreementMonth: {
    store: "offboarding",
    field: "agreementDate",
    kind: "dateMonth",
    labelEn: "Agreement date (month)",
  },
  agreementYear: {
    store: "offboarding",
    field: "agreementDate",
    kind: "dateYear",
    labelEn: "Agreement date (year)",
  },

  // ── The company, on the company record ──────────────────────────────────────────────────────
  //
  // EVERY ONE OF THESE CHANGES EVERY EMPLOYEE'S PAPER. That is the point of the store and not a
  // side effect of it — see the header — and `alsoOn` says so in the words the editor reports the
  // save with, on every single binding here, deliberately: an operator who corrects the head office
  // on one contract must be told, in that moment, that they have corrected it on all of them.
  //
  // THE UPPERCASE AND LOWERCASE KEYS ARE THE SAME VALUE. The contract's own tokens are SHOUTED
  // (`COMPANY_HEAD_OFFICE`), the government forms' are not (`companyAddress`), and the Ministry of
  // Labour templates use a third spelling again (`companyHeadOffice`). All three write one row, for
  // the same reason `EMPLOYEE_NAME` / `insuredName` / `employeeName` write one column: the papers in
  // one file must not be able to disagree about the employer.
  COMPANY_NAME: {
    store: "company",
    field: "legalNameAr",
    kind: "text",
    labelEn: "Company legal name (Arabic)",
    alsoOn: "every document in the pack, for every employee",
  },
  companyName: {
    store: "company",
    field: "legalNameAr",
    kind: "text",
    labelEn: "Company legal name (Arabic)",
    alsoOn: "every document in the pack, for every employee",
  },
  COMPANY_HEAD_OFFICE: {
    store: "company",
    field: "headOfficeAr",
    kind: "text",
    labelEn: "Head office address (Arabic)",
    alsoOn: "the contract, Form 1 and the Ministry of Labour forms, for every employee",
  },
  companyAddress: {
    store: "company",
    field: "headOfficeAr",
    kind: "text",
    labelEn: "Head office address (Arabic)",
    alsoOn: "the contract, Form 1 and the Ministry of Labour forms, for every employee",
  },
  companyHeadOffice: {
    store: "company",
    field: "headOfficeAr",
    kind: "text",
    labelEn: "Head office address (Arabic)",
    alsoOn: "the contract, Form 1 and the Ministry of Labour forms, for every employee",
  },
  COMPANY_HEAD_OFFICE_FULL: {
    store: "company",
    field: "recitalHeadOfficeAr",
    kind: "text",
    // NOT the same row as `COMPANY_HEAD_OFFICE`, and merging them would be the obvious tidy-up and
    // the wrong one: the contract's recital states the registered address written out in full
    // ("وحدة رقم 1، عمارة رقم 8، ...") while the short form is what the government forms' address
    // rule has room for. `system-settings.ts` carries both because the company does.
    labelEn: "Head office, written out as the contract's recital states it",
    alsoOn: "the contract, the worker-data form and the custody and clearance papers",
  },
  COMPANY_CITY: {
    store: "company",
    field: "contractCityAr",
    kind: "text",
    labelEn: "City the contract is made in",
    alsoOn: "the contract's opening line, for every employee",
  },
  RESPONSIBLE_MANAGER: {
    store: "company",
    field: "responsibleManagerAr",
    kind: "text",
    // The company's own responsible manager — NOT `CONTRACT_SIGNATORY`, which sits on the hiring
    // profile because the owner's rule of 2026-09-04 is that a delegate sometimes signs one
    // contract. Two names, two scopes, and the pair is why both bindings have to exist.
    labelEn: "Responsible manager (المدير المسئول)",
    alsoOn: "the contract, the exit forms and the offer letter, for every employee",
  },
  RESPONSIBLE_MANAGER_TITLE: {
    store: "company",
    field: "responsibleManagerTitleAr",
    kind: "text",
    labelEn: "Responsible manager's title",
    alsoOn: "the contract, the exit forms and the offer letter, for every employee",
  },
  COMPANY_LEGAL_FORM: {
    store: "company",
    field: "recitalLegalFormAr",
    kind: "text",
    labelEn: "Legal form (الشكل القانوني)",
    alsoOn: "the contract and both clearance instruments, for every employee",
  },
  COMPANY_BRANCH_REGISTRY: {
    store: "company",
    field: "branchRegistryAr",
    kind: "text",
    labelEn: "Registered branch",
    alsoOn: "the contract's recital, for every employee",
  },
  COMMERCIAL_REGISTER: {
    store: "company",
    field: "commercialRegisterNumber",
    kind: "text",
    labelEn: "Commercial register number (السجل التجاري)",
    alsoOn: "the contract and both clearance instruments, for every employee",
  },
  COMMERCIAL_REGISTER_OFFICE: {
    store: "company",
    field: "commercialRegisterOfficeAr",
    kind: "text",
    labelEn: "Commercial register office",
    alsoOn: "the contract and both clearance instruments, for every employee",
  },
  UNIFIED_REGISTER: {
    store: "company",
    field: "unifiedRegisterNumber",
    kind: "text",
    labelEn: "Unified commercial register number (الرقم الموحد)",
    alsoOn: "the contract and both clearance instruments, for every employee",
  },
  TAX_CARD: {
    store: "company",
    field: "taxCardNumber",
    kind: "text",
    labelEn: "Tax card number (البطاقة الضريبية)",
    alsoOn: "the contract and both clearance instruments, for every employee",
  },

  // ── The government identifiers the social-insurance forms print ─────────────────────────────
  establishmentNumber: {
    store: "company",
    field: "insuranceEstablishmentNumber",
    kind: "text",
    labelEn: "Establishment number (رقم المنشأة)",
    alsoOn: "Form 1 and Form 6, for every employee",
  },
  sectorCode: {
    store: "company",
    field: "insuranceSectorCode",
    kind: "text",
    labelEn: "Establishment sector (قطاع المنشأة)",
    alsoOn: "Form 1, for every employee",
  },
  // Three printed runs of ONE stored number — see `PaperFieldKind`. Editing one patches its own
  // third; the other two are left byte for byte alone.
  taxRegPart1: {
    store: "company",
    field: "taxRegistrationNumber",
    kind: "taxPart1",
    labelEn: "Tax registration number — first group",
    alsoOn: "Form 1 and Form 6, for every employee",
  },
  taxRegPart2: {
    store: "company",
    field: "taxRegistrationNumber",
    kind: "taxPart2",
    labelEn: "Tax registration number — middle group",
    alsoOn: "Form 1 and Form 6, for every employee",
  },
  taxRegPart3: {
    store: "company",
    field: "taxRegistrationNumber",
    kind: "taxPart3",
    labelEn: "Tax registration number — last group",
    alsoOn: "Form 1 and Form 6, for every employee",
  },
};

/** The binding for a marker, or null when the value is not editable on the page. */
export function paperFieldBinding(key: string | null | undefined): PaperFieldBinding | null {
  if (!key) return null;
  return PAPER_FIELD_BINDINGS[key] ?? null;
}

/**
 * Strip the invisible direction controls back off a value read out of the DOM.
 *
 * `pinLtr` wraps Latin and numeric values in U+2066 / U+2069 so the bidirectional algorithm does not
 * reorder them inside Arabic prose — see `render-shared.ts`. They are part of the rendered text and
 * therefore part of `textContent`, so a value read back without this would be stored with two
 * invisible characters welded to it and would never compare equal to what was typed.
 */
export function stripDirectionMarks(value: string): string {
  return value.replace(/[⁦-⁩‪-‮‎‏]/gu, "");
}

/**
 * The record objects a bound field can read from — and nothing else.
 *
 * A structural slice of `HiringPackData`, so a full pack satisfies it, but so does a bare set of
 * mapped rows. That matters for the fill-rate count, which needs to read one field across the whole
 * roster and cannot afford to build 108 complete packs to do it: a pack build joins departments,
 * resolves terms, computes gaps and looks up a suggested Arabic job title, none of which a "does
 * this field have a value" question needs.
 *
 * `company` IS ONE VALUE SHARED BY EVERY RECORD, not one per person — the caller reads it once and
 * hands the same object to all of them. It is required rather than optional on purpose: defaulting
 * it to the compiled constant here would let a caller silently read the company as it ships while
 * the paper prints the company as it was edited, which is precisely the disagreement between the
 * edit box and the page that this module exists to prevent.
 */
export type PaperFieldSource = {
  employee: HiringPackData["employee"];
  profile: HiringPackData["profile"];
  offboarding: HiringPackData["offboarding"];
  company: HiringPackData["company"];
};

/**
 * What the operator sees when they click a value: the stored form, ready to be retyped.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ONLY THE THREE DATE-PART KINDS GO THROUGH `splitIso`, AND THAT ORDER IS THE WHOLE CORRECTNESS
 * OF THIS FUNCTION. It used to fall through to `splitIso` for every kind it had not already
 * returned for, and bail with "" when the parse failed — so a `text` field returned the empty
 * string for anything that was not coincidentally an ISO date. `NATIONAL_ID` and
 * `INSURANCE_NUMBER` are `text` AND render as digit grids, and the grid branch of the paper editor
 * is the one place that calls this: clicking a national ID that was on file opened the edit bar
 * EMPTY, so the obvious next action — type it and save — would have written over a correct number
 * with whatever was retyped. Found 2026-09-04 by the roster fill-rate count, which reported the
 * national ID as stored for 0 of 169 people while the form was printing it.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export function paperFieldCurrentValue(
  pack: PaperFieldSource,
  binding: PaperFieldBinding,
): string {
  const stored = readStored(pack, binding);
  if (stored === null) return "";

  if (
    binding.kind === "dateDay" ||
    binding.kind === "dateMonth" ||
    binding.kind === "dateYear"
  ) {
    // A date part can only come out of a real ISO date — a half-written one has no day to show,
    // and guessing is how a wrong date reaches a form somebody signs.
    const parts = splitIso(String(stored));
    if (!parts) return "";
    if (binding.kind === "dateDay") return parts.day;
    if (binding.kind === "dateMonth") return parts.month;
    return parts.year;
  }

  if (
    binding.kind === "taxPart1" ||
    binding.kind === "taxPart2" ||
    binding.kind === "taxPart3"
  ) {
    // THE SAME SPLIT THE FORM PRINTS, not a second one written to look like it. `render-form1.ts`
    // and `render-form6.ts` both fill their three runs from `splitTaxRegistration`, which reads
    // Arabic-Indic digits as digits — so a number stored as "٣١٨-١٠٨-٤٧٧" opens the edit box showing
    // the group that is actually on the paper rather than an empty one.
    const parts = splitTaxRegistration(String(stored));
    return parts[taxPartIndex(binding.kind)];
  }

  return String(stored);
}

/** Which of the three printed runs a tax-part kind addresses. */
function taxPartIndex(kind: "taxPart1" | "taxPart2" | "taxPart3"): 0 | 1 | 2 {
  if (kind === "taxPart1") return 0;
  if (kind === "taxPart2") return 1;
  return 2;
}

/** The value as it sits in the store today — before this edit. */
function readField(
  pack: PaperFieldSource,
  store: PaperStore,
  field: string,
): string | number | null {
  const source =
    store === "employee"
      ? (pack.employee as unknown as Record<string, unknown>)
      : store === "profile"
        ? (pack.profile as unknown as Record<string, unknown>)
        : store === "offboarding"
          ? (pack.offboarding as unknown as Record<string, unknown>)
          : // The company is read FLAT, through the one function that is the declared inverse of the
            // resolver the renderers use — never by walking `pack.company` by hand, which would put
            // a second spelling of the nesting in this file and let the two drift.
            (flattenCompanyDetails(pack.company) as unknown as Record<string, unknown>);
  const value = source[field];
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  return String(value);
}

/**
 * What the paper would print for this binding — the bound field, or its fallback when it is empty.
 *
 * READING HAS TO AGREE WITH PRINTING, and until now it did not. `render-form1.ts` prints
 * `profile.addressStreet ?? employee.residenceAddress`; this function read only the first half, so
 * clicking Street on a Form 1 that visibly showed an address opened an EMPTY edit box — the same
 * shape of defect as the boxed national ID above, and an invitation to retype a value that was
 * already correct. It also made the fill count say "fills for 0 of 169" beside a row displaying a
 * real street.
 *
 * WRITING IS UNAFFECTED. A save still goes to `store`/`field`; the fallback is a read. So editing a
 * start day seeded from the hire date writes an explicit `contractStartDate`, which is exactly what
 * an operator who changed it meant — and `resolveDateBase` already measured that write against the
 * resolved date, so this only brings the read into line with the write.
 */
function readStored(pack: PaperFieldSource, binding: PaperFieldBinding): string | number | null {
  const stored = readField(pack, binding.store, binding.field);
  if (stored !== null && stored !== "") return stored;
  if (!binding.printFallback) return stored;
  return readField(pack, binding.printFallback.store, binding.printFallback.field);
}

function splitIso(iso: string): { day: string; month: string; year: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  return { year: match[1], month: match[2], day: match[3] };
}

/**
 * A date typed on paper, back as ISO.
 *
 * Accepts what the documents actually PRINT — "24 / 08 / 2026", the order a date is written by hand
 * in Egypt — as well as plain ISO, because that is what a keyboard-minded operator types. Anything
 * else is refused rather than guessed: a date is the one value on these papers where a wrong
 * interpretation is invisible and consequential, and "03/04/2026" is genuinely ambiguous between
 * two readings only the operator can settle.
 */
export function parsePaperDate(raw: string): string | null {
  const text = stripDirectionMarks(raw).trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return buildIso(iso[1], iso[2], iso[3]);

  const dmy = /^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{4})$/.exec(text);
  if (dmy) return buildIso(dmy[3], dmy[2], dmy[1]);

  return null;
}

function buildIso(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Rejects 31 February rather than letting Date roll it into March — a date nobody typed.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A money figure typed on paper — "12,750" or "12750.50" — back as a number. */
export function parsePaperMoney(raw: string): number | null {
  const text = stripDirectionMarks(raw).replace(/[,\s ]/gu, "").trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** What went wrong, in words an operator can act on. */
export type PaperEditRejection = { ok: false; message: string };
export type PaperEditPatch = { ok: true; store: PaperStore; body: Record<string, unknown> };

/**
 * The complete request body for one edit made on the paper.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE BODY IS ALWAYS COMPLETE, NEVER JUST THE CHANGED FIELD. All three save endpoints write with a
 * hand-listed object literal, so a key absent from the body is written as NULL rather than left
 * alone — the "optional field written unconditionally is a silent erase" trap this repository has
 * already paid for once. Sending one field would therefore blank every other field on that record.
 * The whole current record is rebuilt from `pack` and the single edited value overrides it.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Rebuilt from `pack.profile` and NOT from `pack.terms`: the terms object is the resolved view, in
 * which an unset duration reads as the company default. Writing that back would silently pin the
 * default onto this employee, turning "blank means the standard term" into an explicit value that no
 * longer follows the company setting.
 */
export function buildPaperEditPatch(
  pack: HiringPackData,
  binding: PaperFieldBinding,
  typed: string,
): PaperEditPatch | PaperEditRejection {
  const text = stripDirectionMarks(typed).trim();

  let value: string | number | null;
  if (binding.kind === "money") {
    if (!text) {
      value = null;
    } else {
      const parsed = parsePaperMoney(text);
      if (parsed === null) return { ok: false, message: `“${text}” is not an amount.` };
      value = parsed;
    }
  } else if (binding.kind === "date") {
    if (!text) {
      value = null;
    } else {
      const parsed = parsePaperDate(text);
      if (parsed === null) {
        return {
          ok: false,
          message: `“${text}” is not a date. Write it as 24 / 08 / 2026 or 2026-08-24.`,
        };
      }
      value = parsed;
    }
  } else if (
    binding.kind === "dateDay" ||
    binding.kind === "dateMonth" ||
    binding.kind === "dateYear"
  ) {
    const patched = patchDateComponent(pack, binding, text);
    if (!patched.ok) return patched;
    value = patched.value;
  } else if (
    binding.kind === "taxPart1" ||
    binding.kind === "taxPart2" ||
    binding.kind === "taxPart3"
  ) {
    const patched = patchTaxPart(pack, binding, text);
    if (!patched.ok) return patched;
    value = patched.value;
  } else {
    value = text ? text : null;
  }

  // ── THE COMPANY STORE SENDS ONE VALUE, AND THAT IS NOT AN INCONSISTENCY ─────────────────────
  //
  // The rule above — always the whole record — exists because the three employee endpoints write a
  // hand-listed object literal, so a key missing from the body is written as NULL. The company store
  // is not shaped that way: `hiring_pack_company_details` holds ONE ROW PER VALUE, so a write names
  // the row it changes and cannot reach any other. Sending all nineteen would be strictly worse —
  // two operators editing two different values would each write back their stale copy of the
  // other's, and the second save would silently undo the first.
  if (binding.store === "company") {
    if (!isCompanyDetailKey(binding.field)) {
      // Unreachable through the table above, which is the point of saying it out loud: a binding
      // added later with a mistyped key would otherwise POST a key the route rejects, and a 400 on
      // a legal document reads as the save being broken rather than as a typo in one line.
      return {
        ok: false,
        message: `“${binding.field}” is not a company value this system stores.`,
      };
    }
    return {
      ok: true,
      store: "company",
      // `value` is a string or null here — the company bindings are `text` and the tax parts, never
      // `money`, so there is no number to widen. Null means RESET: delete the row and print the
      // compiled default again. See `saveCompanyDetail`.
      body: { key: binding.field satisfies CompanyDetailKey, value },
    };
  }

  const body =
    binding.store === "employee"
      ? factsPayload(pack)
      : binding.store === "profile"
        ? profilePayload(pack)
        : offboardingPayload(pack);

  return { ok: true, store: binding.store, body: { ...body, [binding.field]: value } };
}

/**
 * One printed run of the tax registration number, written back into the number as a whole.
 *
 * THE OTHER TWO GROUPS ARE CARRIED THROUGH UNTOUCHED, read with the same `splitTaxRegistration` the
 * form itself prints with — so correcting a mistyped middle group cannot quietly restate the first
 * and last ones, and a number stored in Arabic-Indic digits is split the way the paper splits it
 * rather than read as one long separator.
 *
 * The result is stored joined with "-" in ASCII digits, which is the form `system-settings.ts`
 * documents as canonical: the renderer decides how the number is DRAWN, and every other consumer —
 * a CSV, a search, a comparison against the tax card — expects 0-9.
 */
function patchTaxPart(
  pack: HiringPackData,
  binding: PaperFieldBinding,
  text: string,
): { ok: true; value: string | null } | PaperEditRejection {
  const digits = text.replace(/[^0-9]/gu, "");
  if (text && !digits) {
    return { ok: false, message: `“${text}” is not a number.` };
  }

  const stored = readStored(pack, binding);
  const parts = splitTaxRegistration(String(stored ?? ""));
  const next = [...parts] as [string, string, string];
  next[
    taxPartIndex(binding.kind as "taxPart1" | "taxPart2" | "taxPart3")
  ] = digits;

  const joined = next.filter(Boolean).join("-");
  // Emptying all three groups is a reset, not a number of length zero — the row goes away and the
  // compiled default prints again, which is the only way back from a mistake here.
  return { ok: true, value: joined ? joined : null };
}

/**
 * One component of a date, written into the date the other two components already agree on.
 *
 * The base date is the RESOLVED one, not the stored one: Form 1 prints the start date whether or not
 * anybody pinned it, falling back to the hire date, so an operator correcting the printed day is
 * correcting the date they can see. Writing the result back to the stored field pins it, which is
 * exactly what editing a printed value should mean.
 */
function patchDateComponent(
  pack: HiringPackData,
  binding: PaperFieldBinding,
  text: string,
): { ok: true; value: string | null } | PaperEditRejection {
  if (!text) return { ok: true, value: null };

  const digits = text.replace(/[^0-9]/gu, "");
  if (!digits) return { ok: false, message: `“${text}” is not a number.` };

  const base = resolveDateBase(pack, binding);
  if (!base) {
    return {
      ok: false,
      message:
        "There is no date here yet to change one part of. Set the whole date in the fields above first.",
    };
  }

  const parts = splitIso(base);
  if (!parts) return { ok: false, message: "The stored date is not readable." };

  const next =
    binding.kind === "dateDay"
      ? buildIso(parts.year, parts.month, digits)
      : binding.kind === "dateMonth"
        ? buildIso(parts.year, digits, parts.day)
        : buildIso(digits, parts.month, parts.day);

  if (!next) {
    return { ok: false, message: `“${text}” does not make a real date with the other two boxes.` };
  }
  return { ok: true, value: next };
}

/** The date a component edit is measured against — resolved, so it matches what is on the paper. */
function resolveDateBase(pack: HiringPackData, binding: PaperFieldBinding): string | null {
  const stored = readStored(pack, binding);
  if (typeof stored === "string" && stored) return stored;
  if (binding.field === "contractStartDate") return pack.terms.contractStartDate;
  if (binding.field === "lastWorkingDate") return pack.terms.lastWorkingDate;
  return null;
}

/**
 * The employee record as it stands, in the shape its endpoint writes.
 *
 * Mirrors what the fill screen sends when its own Save button is pressed. `residenceCity`,
 * `employmentStatus` and the department name are absent because the endpoint does not accept them —
 * they are read-only on this screen and are carried through server-side.
 */
function factsPayload(pack: HiringPackData): HiringPackEmployeeFactsInput {
  const { employee } = pack;
  return {
    baseSalary: employee.baseSalary,
    birthDate: employee.birthDate,
    fullName: employee.fullName,
    hireDate: employee.hireDate,
    jobTitle: employee.jobTitle,
    lineId: employee.lineId,
    mobileNumber: employee.mobileNumber,
    nameAr: employee.nameAr,
    nationalId: employee.nationalId,
    residenceAddress: employee.residenceAddress,
    socialInsuranceNumber: employee.socialInsuranceNumber,
    workEmail: employee.workEmail,
  };
}

function profilePayload(pack: HiringPackData): HiringPackProfileInput {
  const { profile } = pack;
  return {
    addressBuilding: profile.addressBuilding,
    addressDistrict: profile.addressDistrict,
    addressGovernorate: profile.addressGovernorate,
    addressMarkaz: profile.addressMarkaz,
    addressStreet: profile.addressStreet,
    birthPlace: profile.birthPlace,
    contractDurationMonths: profile.contractDurationMonths,
    contractSignatoryNameAr: profile.contractSignatoryNameAr,
    contractSignatoryTitleAr: profile.contractSignatoryTitleAr,
    contractEndDate: profile.contractEndDate,
    contractStartDate: profile.contractStartDate,
    insuranceOffice: profile.insuranceOffice,
    jobTitleAr: profile.jobTitleAr,
    nationality: profile.nationality,
    notes: profile.notes,
    occupationCode: profile.occupationCode,
    qualification: profile.qualification,
    trainingBondMonths: profile.trainingBondMonths,
    underperformanceMonths: profile.underperformanceMonths,
    underperformanceThresholdPct: profile.underperformanceThresholdPct,
  };
}

function offboardingPayload(pack: HiringPackData): OffboardingProfileInput {
  const { offboarding } = pack;
  return {
    addresseeNameAr: offboarding.addresseeNameAr,
    addresseeTitleAr: offboarding.addresseeTitleAr,
    agreementDate: offboarding.agreementDate,
    employerRepNameAr: offboarding.employerRepNameAr,
    employerRepTitleAr: offboarding.employerRepTitleAr,
    endReasonAr: offboarding.endReasonAr,
    endReasonCode: offboarding.endReasonCode,
    exitRoute: offboarding.exitRoute,
    lastWorkingDate: offboarding.lastWorkingDate,
    notes: offboarding.notes,
  };
}

/**
 * Which endpoint a store saves through, relative to `/api/hiring-pack/<hrId>`.
 *
 * THE COMPANY STORE HAS NO ANSWER HERE, and returning `""` for it — the shape of this function
 * before the fourth store existed — would have posted the company's address to the employee's own
 * profile endpoint, which accepts the body, returns 200, and stores nothing. Use `paperStoreUrl`,
 * which is the total function; this one is kept only for the three per-employee endpoints and
 * refuses the fourth rather than guessing.
 */
export function paperStoreEndpoint(store: Exclude<PaperStore, "company">): string {
  if (store === "employee") return "/facts";
  if (store === "offboarding") return "/offboarding";
  return "";
}

/**
 * The full path one edit is saved to.
 *
 * The company's own record is NOT under `/<hrId>/`, because it is not this employee's — the route
 * would then be a lie about the scope of the write, and the next reader would reasonably assume the
 * value could differ per person. One function so the editor never has to decide.
 */
export function paperStoreUrl(store: PaperStore, hrId: string): string {
  if (store === "company") return "/api/hiring-pack/company-details";
  return `/api/hiring-pack/${encodeURIComponent(hrId)}${paperStoreEndpoint(store)}`;
}
