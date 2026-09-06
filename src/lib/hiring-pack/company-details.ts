// The company as its own paperwork states it — a stored record, not a compiled constant.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. `systemLegalEntity` in `src/config/system-settings.ts` holds the company's legal
// identity, and every one of the HR Forms documents prints some of it: the head office address on
// the contract's recital, on Form 1's back-page إقرار and on the Ministry of Labour forms; the
// commercial register on the clearance instruments; the responsible manager over the signature line.
//
// Those values were EDITABLE ONLY BY CHANGING THE CODE. On the paper editor they rendered locked,
// under the tooltip "this value comes from the company record" — which is true, and was no use at
// all to somebody holding a printed contract with the wrong address on it. The owner's instruction,
// 2026-09-06: the address on the HR forms must be editable, and "every single thing should be
// editable".
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT IS STILL NOT A PER-EMPLOYEE FIELD, AND THAT DISTINCTION IS THE WHOLE DESIGN.
//
// `paper-fields.ts` refuses to bind these tokens to the employee record for a stated reason: the
// company's address is not this employee's field, it is the legal entity's, shared by every document
// and every employee. Typing over it on one contract must never rewrite it for one person only —
// that produces a personnel file in which two papers about the same company disagree.
//
// So the answer is not "make the span writable"; it is to give the company its own store. One row
// per value, one value for everybody, and an edit made on any paper reaches every paper at once —
// which is what a company address IS. The editor says so in the words it reports the save with.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE COMPILED CONSTANT REMAINS THE DEFAULT AND THE FALLBACK, deliberately.
//
// The table may not exist yet (a migration is a protected action the owner approves separately), it
// may be empty, and a value may have been reset. In every one of those states the papers print
// exactly what they printed before this module existed. Nothing here can produce a BLANK company on
// a legal document by accident: a blank is only ever what somebody typed on purpose, and typing one
// is a legitimate thing to do — `registration.defaultInsuranceOffice` ships blank precisely so
// Form 1 prints a visible gap for the clerk rather than a plausible wrong value.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE READER IS DELIBERATELY LEFT ON THE CONSTANT. `employee-master-workbook.ts` stamps
// `legalNameEn` into an export's provenance line. That is the software labelling a spreadsheet, not
// the company speaking to an authority, and it is not part of the hiring pack — so it keeps reading
// `systemLegalEntity` directly. Everything a person SIGNS, or a government office RECEIVES, reads
// the resolved record below.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { systemLegalEntity } from "@/config/system-settings";

/**
 * The company, resolved — the same shape `systemLegalEntity` publishes.
 *
 * Kept nested rather than flattened so a renderer reads `company.contractRecital.headOfficeAr`
 * exactly where it used to read `systemLegalEntity.contractRecital.headOfficeAr`. The two head
 * office values are NOT duplicates and must not be merged: `headOfficeAr` is the short form the
 * contract's opening line and the government forms print, and the recital's is the registered
 * address written out in full. `system-settings.ts` explains why the pair exists.
 */
export type CompanyDetails = {
  legalNameAr: string;
  legalNameEn: string;
  headOfficeAr: string;
  contractCityAr: string;
  responsibleManagerAr: string;
  responsibleManagerTitleAr: string;
  registration: {
    insuranceEstablishmentNumber: string;
    insuranceSectorCode: string;
    taxRegistrationNumber: string;
    defaultInsuranceOffice: string;
  };
  contractRecital: {
    legalFormAr: string;
    commercialRegisterNumber: string;
    commercialRegisterOfficeAr: string;
    unifiedRegisterNumber: string;
    taxCardNumber: string;
    headOfficeAr: string;
    branchRegistryAr: string;
    signatoryNameAr: string;
    signatoryTitleAr: string;
  };
};

/**
 * One editable company value.
 *
 * `fallback` is the compiled constant, which is what prints when nothing is stored. `labelEn` is
 * what the operator is told they are changing — written as the thing on the paper, not as the
 * property name, because the person editing is looking at a printed document and not at this file.
 */
export type CompanyDetailField = {
  labelEn: string;
  fallback: string;
  /** What else moves when this one moves. Shown on save; every one of these is company-wide. */
  alsoOn: string;
};

/**
 * Every value of the company's that any HR Forms document prints, keyed by its STORAGE key.
 *
 * THE KEY IS NOT THE PAPER'S TOKEN. Several tokens print one value — Form 1 calls the head office
 * `companyAddress`, the Ministry of Labour forms call it `companyHeadOffice`, and the contract calls
 * it `COMPANY_HEAD_OFFICE` — and binding each token to its own row would let three papers hold three
 * different addresses for one company. `paper-fields.ts` maps token to key; this table is the key.
 *
 * A KEY IS PERMANENT ONCE STORED. Renaming one orphans whatever the table holds for it, which prints
 * as a value silently reverting to the compiled default. Add, never rename.
 */
export const COMPANY_DETAIL_FIELDS = {
  legalNameAr: {
    labelEn: "Company legal name (Arabic)",
    fallback: systemLegalEntity.legalNameAr,
    alsoOn: "every document in the pack, for every employee",
  },
  legalNameEn: {
    labelEn: "Company legal name (English)",
    fallback: systemLegalEntity.legalNameEn,
    alsoOn: "the letterhead of every typeset document, for every employee",
  },
  headOfficeAr: {
    labelEn: "Head office address (Arabic)",
    fallback: systemLegalEntity.headOfficeAr,
    alsoOn: "the contract, Form 1 and the Ministry of Labour forms, for every employee",
  },
  contractCityAr: {
    labelEn: "City the contract is made in",
    fallback: systemLegalEntity.contractCityAr,
    alsoOn: "the contract's opening line, for every employee",
  },
  responsibleManagerAr: {
    labelEn: "Responsible manager (المدير المسئول)",
    fallback: systemLegalEntity.responsibleManagerAr,
    alsoOn: "the contract, the exit forms and the offer letter, for every employee",
  },
  responsibleManagerTitleAr: {
    labelEn: "Responsible manager's title",
    fallback: systemLegalEntity.responsibleManagerTitleAr,
    alsoOn: "the contract, the exit forms and the offer letter, for every employee",
  },

  // ── The government identifiers, printed into boxed grids ────────────────────────────────────
  insuranceEstablishmentNumber: {
    labelEn: "Establishment number (رقم المنشأة)",
    fallback: systemLegalEntity.registration.insuranceEstablishmentNumber,
    alsoOn: "Form 1 and Form 6, for every employee",
  },
  insuranceSectorCode: {
    labelEn: "Establishment sector (قطاع المنشأة)",
    fallback: systemLegalEntity.registration.insuranceSectorCode,
    alsoOn: "Form 1, for every employee",
  },
  taxRegistrationNumber: {
    labelEn: "Tax registration number (رقم التسجيل الضريبي)",
    fallback: systemLegalEntity.registration.taxRegistrationNumber,
    alsoOn: "Form 1 and Form 6, for every employee",
  },
  defaultInsuranceOffice: {
    labelEn: "Default social-insurance office",
    fallback: systemLegalEntity.registration.defaultInsuranceOffice,
    alsoOn: "Form 1 and Form 6 for every employee with no office of their own recorded",
  },

  // ── The contract's own recital of the company ───────────────────────────────────────────────
  recitalLegalFormAr: {
    labelEn: "Legal form (الشكل القانوني)",
    fallback: systemLegalEntity.contractRecital.legalFormAr,
    alsoOn: "the contract and both clearance instruments, for every employee",
  },
  commercialRegisterNumber: {
    labelEn: "Commercial register number (السجل التجاري)",
    fallback: systemLegalEntity.contractRecital.commercialRegisterNumber,
    alsoOn: "the contract and both clearance instruments, for every employee",
  },
  commercialRegisterOfficeAr: {
    labelEn: "Commercial register office",
    fallback: systemLegalEntity.contractRecital.commercialRegisterOfficeAr,
    alsoOn: "the contract and both clearance instruments, for every employee",
  },
  unifiedRegisterNumber: {
    labelEn: "Unified commercial register number (الرقم الموحد)",
    fallback: systemLegalEntity.contractRecital.unifiedRegisterNumber,
    alsoOn: "the contract and both clearance instruments, for every employee",
  },
  taxCardNumber: {
    labelEn: "Tax card number (البطاقة الضريبية)",
    fallback: systemLegalEntity.contractRecital.taxCardNumber,
    alsoOn: "the contract and both clearance instruments, for every employee",
  },
  recitalHeadOfficeAr: {
    labelEn: "Head office, written out as the contract's recital states it",
    fallback: systemLegalEntity.contractRecital.headOfficeAr,
    alsoOn: "the contract, the worker-data form and the custody and clearance papers",
  },
  branchRegistryAr: {
    labelEn: "Registered branch",
    fallback: systemLegalEntity.contractRecital.branchRegistryAr,
    alsoOn: "the contract's recital, for every employee",
  },
  signatoryNameAr: {
    labelEn: "Contract signatory — the company default",
    fallback: systemLegalEntity.contractRecital.signatoryNameAr,
    alsoOn: "every contract that does not name its own signatory",
  },
  signatoryTitleAr: {
    labelEn: "Contract signatory's title — the company default",
    fallback: systemLegalEntity.contractRecital.signatoryTitleAr,
    alsoOn: "every contract that does not name its own signatory",
  },
} as const satisfies Readonly<Record<string, CompanyDetailField>>;

export type CompanyDetailKey = keyof typeof COMPANY_DETAIL_FIELDS;

export const COMPANY_DETAIL_KEYS = Object.keys(COMPANY_DETAIL_FIELDS) as CompanyDetailKey[];

export function isCompanyDetailKey(value: unknown): value is CompanyDetailKey {
  return typeof value === "string" && Object.hasOwn(COMPANY_DETAIL_FIELDS, value);
}

/** Every value as the code ships it — what prints when the table is empty, absent, or reset. */
export function companyDetailDefaults(): Record<CompanyDetailKey, string> {
  const defaults = {} as Record<CompanyDetailKey, string>;
  for (const key of COMPANY_DETAIL_KEYS) defaults[key] = COMPANY_DETAIL_FIELDS[key].fallback;
  return defaults;
}

/**
 * The company as the papers should print it today.
 *
 * AN EMPTY STRING IS A REAL ANSWER, not a missing one. Blanking a value on the paper is a thing an
 * operator may legitimately mean — a company with no branch registered, a line the insurance office
 * wants left open — so `""` is stored and printed as typed. "Print the compiled default instead" is
 * expressed by having NO row for the key, which is exactly what the reset path writes.
 */
export function resolveCompanyDetails(
  overrides: Readonly<Partial<Record<CompanyDetailKey, string>>> = {},
): CompanyDetails {
  const read = (key: CompanyDetailKey): string => {
    const override = overrides[key];
    return typeof override === "string" ? override : COMPANY_DETAIL_FIELDS[key].fallback;
  };

  return {
    legalNameAr: read("legalNameAr"),
    legalNameEn: read("legalNameEn"),
    headOfficeAr: read("headOfficeAr"),
    contractCityAr: read("contractCityAr"),
    responsibleManagerAr: read("responsibleManagerAr"),
    responsibleManagerTitleAr: read("responsibleManagerTitleAr"),
    registration: {
      insuranceEstablishmentNumber: read("insuranceEstablishmentNumber"),
      insuranceSectorCode: read("insuranceSectorCode"),
      taxRegistrationNumber: read("taxRegistrationNumber"),
      defaultInsuranceOffice: read("defaultInsuranceOffice"),
    },
    contractRecital: {
      legalFormAr: read("recitalLegalFormAr"),
      commercialRegisterNumber: read("commercialRegisterNumber"),
      commercialRegisterOfficeAr: read("commercialRegisterOfficeAr"),
      unifiedRegisterNumber: read("unifiedRegisterNumber"),
      taxCardNumber: read("taxCardNumber"),
      headOfficeAr: read("recitalHeadOfficeAr"),
      branchRegistryAr: read("branchRegistryAr"),
      signatoryNameAr: read("signatoryNameAr"),
      signatoryTitleAr: read("signatoryTitleAr"),
    },
  };
}

/**
 * The resolved company back as the flat key map the store and the editor speak.
 *
 * The inverse of `resolveCompanyDetails`, and it has to STAY the inverse: the editor reads a key's
 * current value out of the pack it already holds rather than re-fetching the store, so a key that
 * resolved from one place and flattened from another would open the edit box showing a value the
 * paper is not printing. `tests/hiring-pack-company-details.test.ts` pins the round trip.
 */
export function flattenCompanyDetails(details: CompanyDetails): Record<CompanyDetailKey, string> {
  return {
    legalNameAr: details.legalNameAr,
    legalNameEn: details.legalNameEn,
    headOfficeAr: details.headOfficeAr,
    contractCityAr: details.contractCityAr,
    responsibleManagerAr: details.responsibleManagerAr,
    responsibleManagerTitleAr: details.responsibleManagerTitleAr,
    insuranceEstablishmentNumber: details.registration.insuranceEstablishmentNumber,
    insuranceSectorCode: details.registration.insuranceSectorCode,
    taxRegistrationNumber: details.registration.taxRegistrationNumber,
    defaultInsuranceOffice: details.registration.defaultInsuranceOffice,
    recitalLegalFormAr: details.contractRecital.legalFormAr,
    commercialRegisterNumber: details.contractRecital.commercialRegisterNumber,
    commercialRegisterOfficeAr: details.contractRecital.commercialRegisterOfficeAr,
    unifiedRegisterNumber: details.contractRecital.unifiedRegisterNumber,
    taxCardNumber: details.contractRecital.taxCardNumber,
    recitalHeadOfficeAr: details.contractRecital.headOfficeAr,
    branchRegistryAr: details.contractRecital.branchRegistryAr,
    signatoryNameAr: details.contractRecital.signatoryNameAr,
    signatoryTitleAr: details.contractRecital.signatoryTitleAr,
  };
}

/**
 * The company with nothing stored — what a pack built outside the database prints.
 *
 * Used by the fill-rate count and by any caller holding a partial pack, so neither has to reach the
 * database to render a token map. Computed once, and never mutated.
 */
export const COMPANY_DETAILS_DEFAULT: CompanyDetails = resolveCompanyDetails();
