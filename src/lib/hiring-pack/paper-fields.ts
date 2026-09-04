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
//      on one contract must never rewrite it for everyone.
//
// So: bound values are editable and persist. Unbound values are inert unless the operator turns on
// free-text editing explicitly, which marks the page as a one-off and never writes to the database.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// WHAT IS DELIBERATELY NOT HERE. Derived values follow their source rather than being typed over:
// `SALARY_WORDS` is the salary spelled out and has to agree with `SALARY_FIGURES` digit for digit —
// مادة (2) prints both — so editing the words alone would produce a contract that contradicts
// itself. `DURATION`, `DEPARTMENT`, `HR_ID`, `ISSUE_DATE` and the tax and register numbers are the
// same shape of fact: computed, or owned by somewhere else.

import type {
  HiringPackData,
  HiringPackEmployeeFactsInput,
  HiringPackProfileInput,
  OffboardingProfileInput,
} from "@/lib/hiring-pack/types";

/** Which of the three save endpoints a field belongs to. */
export type PaperStore = "employee" | "profile" | "offboarding";

/**
 * How the typed text becomes a stored value.
 *
 * `date` reads a whole date off one span. `dateDay` / `dateMonth` / `dateYear` each read ONE
 * component of a date that the paper prints in separate boxes — Form 1's start date is three
 * grids, not one rule — and patch that component into the date the other two already agree on.
 */
export type PaperFieldKind = "text" | "money" | "date" | "dateDay" | "dateMonth" | "dateYear";

export type PaperFieldBinding = {
  store: PaperStore;
  /** The property name on the store's own `*Input` type. */
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
  insuranceOffice: {
    store: "profile",
    field: "insuranceOffice",
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
 * The three record objects a bound field can read from — and nothing else.
 *
 * A structural slice of `HiringPackData`, so a full pack satisfies it, but so does a bare set of
 * three mapped rows. That matters for the fill-rate count, which needs to read one field across the
 * whole roster and cannot afford to build 108 complete packs to do it: a pack build joins
 * departments, resolves terms, computes gaps and looks up a suggested Arabic job title, none of
 * which a "does this field have a value" question needs.
 */
export type PaperFieldSource = {
  employee: HiringPackData["employee"];
  profile: HiringPackData["profile"];
  offboarding: HiringPackData["offboarding"];
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

  return String(stored);
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
        : (pack.offboarding as unknown as Record<string, unknown>);
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
  } else {
    value = text ? text : null;
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

/** Which endpoint a store saves through, relative to `/api/hiring-pack/<hrId>`. */
export function paperStoreEndpoint(store: PaperStore): string {
  if (store === "employee") return "/facts";
  if (store === "offboarding") return "/offboarding";
  return "";
}
