/**
 * The papers this module prints, in the order a career runs through them.
 *
 * JOINING: the employment contract and social-insurance Form 1 (طلب اشتراك مؤمن عليه).
 * DURING: a custody receipt (إقرار استلام عهدة) each time a company device is handed over —
 *   one numbered form for a laptop, another for a phone or tablet.
 * LEAVING: social-insurance Form 6 (إخطار بإنتهاء اشتراك مؤمن عليه), ONE of the two Ministry of
 *   Labour exit templates — a resignation request or a mutual-termination agreement — and BOTH
 *   halves of the clearance pair (إخلاء طرف). The clearance pair are complements, not alternatives:
 *   one certifies the employee is clear of the company and he keeps it, the other certifies the
 *   company is clear of him and the company files it. A departure produces both.
 */
export type HiringPackDocument =
  | "contract"
  | "form1"
  | "custodyLaptop"
  | "custodyMobile"
  | "form6"
  | "resignation"
  | "mutualTermination"
  | "clearanceEmployee"
  | "clearanceCompany";

/** The joining half — printed when somebody arrives. */
export const HIRING_DOCUMENTS = ["contract", "form1"] as const;

/**
 * The custody receipts — printed whenever a device changes hands, which is not a moment in a
 * career at all but a thing that happens repeatedly during one.
 *
 * TWO FORMS, BOTH CURRENT. The source document numbers them itself (`نموذج رقم 1` for a laptop,
 * `نموذج رقم 2` for a phone or tablet) and which one you print depends on what is in your hand.
 * They are two documents rather than two versions of one for the reason set out in
 * `custody-template.ts`: the archive's rule is exactly one current version per document, and filing
 * the tablet form as an older version of the laptop form would tell HR it had been withdrawn.
 */
export const ASSET_DOCUMENTS = ["custodyLaptop", "custodyMobile"] as const;

/**
 * The two clearance papers — إخلاء طرف — which are Sato's own instruments rather than a government
 * form, and which run in OPPOSITE directions.
 *
 * BOTH ARE SIGNED, unlike the two labour templates. It is easy to read a pair of forms with almost
 * the same title as alternatives, the way the resignation and the mutual-termination agreement are,
 * and they are not: `clearanceEmployee` is the company certifying the employee is clear, signed by
 * seven departments and handed to him; `clearanceCompany` is the employee acknowledging his final
 * settlement and releasing the company, filed in his personnel file. Each protects the party who
 * does NOT keep it, so signing only one leaves somebody unprotected. Nothing constrains them
 * against each other for exactly that reason — see the migration's CHECK, which names only the
 * labour pair.
 */
export const CLEARANCE_DOCUMENTS = ["clearanceEmployee", "clearanceCompany"] as const;

/** The leaving half — printed when somebody goes. */
export const EXIT_DOCUMENTS = [
  "form6",
  "resignation",
  "mutualTermination",
  ...CLEARANCE_DOCUMENTS,
] as const;

/**
 * Every document, in career order.
 *
 * Typed as `readonly HiringPackDocument[]` rather than a `as const` tuple on purpose: it is
 * assignable to the union, so dropping a document from this list is a compile error at every call
 * site that expects the whole set, not a quietly shorter array.
 */
export const HIRING_PACK_DOCUMENTS: readonly HiringPackDocument[] = [
  ...HIRING_DOCUMENTS,
  ...ASSET_DOCUMENTS,
  ...EXIT_DOCUMENTS,
];

/**
 * The documents whose signature Phoenix records against the person.
 *
 * The custody receipts are deliberately NOT here, and that is a statement about the document rather
 * than an omission. Every other paper in this module is signed once in a career: there is one
 * contract, one Form 1, one Form 6, one exit form. A custody receipt is signed once per DEVICE —
 * البند (14) of its own text requires a separate numbered form for each handover — so one person
 * can hold three of them at once, signed on three different days. A single `custody_signed_date`
 * against the employee could only ever record one of the three, and would then read as though it
 * covered all of them: the laptop returned in March would look accounted for by the phone receipt
 * signed in June. Recording nothing is honest; recording one date for three devices is not.
 *
 * The register that WOULD answer this properly is a custody table keyed by device — see the note in
 * `render-custody.ts`. Until that exists the receipt prints, and what it prints is a paper filed in
 * a drawer, which is exactly what it is today.
 */
export const SIGNABLE_DOCUMENTS: readonly HiringPackDocument[] = [
  ...HIRING_DOCUMENTS,
  ...EXIT_DOCUMENTS,
];

/** Whether a document's signature can be recorded. See `SIGNABLE_DOCUMENTS`. */
export function isSignableDocument(document: HiringPackDocument): boolean {
  return SIGNABLE_DOCUMENTS.includes(document);
}

/**
 * How an employment relationship ended, and therefore which Ministry of Labour form applies.
 *
 * THE TWO ARE ALTERNATIVES, NEVER BOTH — the owner's instruction, 2026-08-30: "not the two should
 * be signed, either this or this". They assert incompatible facts. A resignation says the employee
 * asked to leave under مادة 167; a mutual termination says both parties agreed to end the contract
 * by consent. A file holding both signed contradicts itself, and it is the signed paper a labour
 * inspector reads, so the choice is recorded rather than left to whoever happens to press print.
 *
 * Form 6 is NOT part of this choice: it goes to a different authority — social insurance, not
 * labour — and it is filed on every exit whichever route was taken.
 */
export type ExitRoute = "resignation" | "mutualTermination";

/**
 * The fields HR fills in, which are the ones Phoenix cannot already answer from `employees`.
 * Every one of them is optional: a half-filled pack still prints, because an HR user who is
 * missing a graduation certificate on Tuesday still needs the contract on Tuesday. What a missing
 * value must never do is print a guess — see `HiringPackGap`.
 */
export type HiringPackProfileInput = {
  nationality?: string | null;
  qualification?: string | null;
  birthPlace?: string | null;
  jobTitleAr?: string | null;
  occupationCode?: string | null;
  insuranceOffice?: string | null;
  addressBuilding?: string | null;
  addressDistrict?: string | null;
  addressStreet?: string | null;
  addressMarkaz?: string | null;
  addressGovernorate?: string | null;
  contractDurationMonths?: number | null;
  contractStartDate?: string | null;
  contractEndDate?: string | null;
  underperformanceThresholdPct?: number | null;
  underperformanceMonths?: number | null;
  trainingBondMonths?: number | null;
  notes?: string | null;
};

/**
 * What "What Phoenix already knows" edits, when it is edited at all.
 *
 * Every field here writes straight to `employees` — there is no second copy, on purpose (see the
 * screen's own note on that). `lineId` is what "Department" actually is: the employee's line
 * assignment, with the Arabic name in `HiringPackEmployeeFacts.departmentAr` derived from it, not
 * a free-text field of its own. `grossSalary` and `socialInsuranceWage` are re-run through the
 * same payroll formula and region derivation the full employee editor uses, and are refused for
 * anyone already resigned or terminated — see `saveHiringPackEmployeeFacts`.
 */
export type HiringPackEmployeeFactsInput = {
  fullName?: string | null;
  nameAr?: string | null;
  nationalId?: string | null;
  socialInsuranceNumber?: string | null;
  socialInsuranceWage?: number | null;
  grossSalary?: number | null;
  birthDate?: string | null;
  hireDate?: string | null;
  jobTitle?: string | null;
  lineId?: number | null;
  mobileNumber?: string | null;
  workEmail?: string | null;
  residenceAddress?: string | null;
};

export type HiringPackProfile = Required<{
  [K in keyof HiringPackProfileInput]: HiringPackProfileInput[K] extends infer V
    ? Exclude<V, undefined>
    : never;
}> & {
  hrId: string;
  contractSignedDate: string | null;
  form1SignedDate: string | null;
  contractPrintedAt: string | null;
  form1PrintedAt: string | null;
  /**
   * WHICH VERSION OF THE CONTRACT THIS PERSON SIGNED — a `template-registry.ts` id.
   *
   * Deliberately NOT part of `HiringPackProfileInput`: it is not something HR types, it is stamped
   * when the contract is marked signed, from whichever version was current at that moment. Letting
   * it be edited would let somebody change, after the fact, which document a signature is against.
   *
   * Null on everybody who signed before this was recorded (2026-08-30) and on everybody who has not
   * signed yet. Null means "print the current version", which is right in both cases: an unsigned
   * contract has no version to be faithful to, and a backfill would be a guess dressed as a record.
   */
  contractTemplateVersion: string | null;
  updatedAt: string | null;
};

/**
 * What HR fills in for the three EXIT documents, and nothing else.
 *
 * A separate input from `HiringPackProfileInput` on purpose. The two are captured months or years
 * apart, by different people, for different authorities — and an exit is not a certainty when
 * somebody is hired. Keeping them apart means an exit form can never silently rewrite a value the
 * signed contract was printed from.
 *
 * Every field is optional, for the same reason the hiring profile's are: a half-filled exit pack
 * still prints, because an employee whose last day is Thursday needs his Form 6 on Thursday.
 */
export type OffboardingProfileInput = {
  /** Which Ministry of Labour route was taken. See `ExitRoute` — the two are alternatives. */
  exitRoute?: ExitRoute | null;
  /**
   * The last working day. Defaults from the employee's resignation record, and is overridable
   * because that record copies one date into four columns and is not always the date on the paper.
   */
  lastWorkingDate?: string | null;
  /** سبب انتهاء الاشتراك, in Arabic — printed on Form 6 and on the resignation's "ونظراً لـ" rule. */
  endReasonAr?: string | null;
  /** The Authority's own one-digit reason code, for Form 6's single code box. */
  endReasonCode?: string | null;
  /** Who the resignation letter is addressed to, and his title on the "مدير /" line. */
  addresseeNameAr?: string | null;
  addresseeTitleAr?: string | null;
  /** The date the mutual-termination agreement is signed — NOT the last working day. */
  agreementDate?: string | null;
  /** The employer's signatory on the mutual-termination agreement. Defaults from company settings. */
  employerRepNameAr?: string | null;
  employerRepTitleAr?: string | null;
  notes?: string | null;
};

export type OffboardingProfile = Required<{
  [K in keyof OffboardingProfileInput]: OffboardingProfileInput[K] extends infer V
    ? Exclude<V, undefined>
    : never;
}> & {
  hrId: string;
  form6SignedDate: string | null;
  resignationSignedDate: string | null;
  mutualTerminationSignedDate: string | null;
  /**
   * The clearance pair, recorded independently of each other.
   *
   * Independent because they are complements — see `CLEARANCE_DOCUMENTS`. In practice one is
   * signed days before the other: the departmental sign-offs on the employee's copy have to be
   * complete before finance will release a settlement, and the company's copy is signed when that
   * settlement is actually handed over. Two dates, and the gap between them is the thing HR is
   * chasing.
   */
  clearanceEmployeeSignedDate: string | null;
  clearanceCompanySignedDate: string | null;
  form6PrintedAt: string | null;
  resignationPrintedAt: string | null;
  mutualTerminationPrintedAt: string | null;
  clearanceEmployeePrintedAt: string | null;
  clearanceCompanyPrintedAt: string | null;
  updatedAt: string | null;
};

/**
 * What Phoenix already knows about the person, resolved once so the two templates never reach into
 * the database themselves.
 */
export type HiringPackEmployeeFacts = {
  hrId: string;
  fullName: string;
  nameAr: string | null;
  nationalId: string | null;
  socialInsuranceNumber: string | null;
  socialInsuranceWage: number | null;
  grossSalary: number | null;
  birthDate: string | null;
  hireDate: string | null;
  jobTitle: string | null;
  departmentAr: string | null;
  /** The line `departmentAr` was derived from — the value an edit to "Department" actually writes. */
  lineId: number | null;
  residenceAddress: string | null;
  residenceCity: string | null;
  mobileNumber: string | null;
  workEmail: string | null;
  employmentStatus: string | null;
  /**
   * Whether this person has left, mirroring `HiringPackCandidate.departed`.
   *
   * Salary and department are edited by rerunning the same payroll-formula-and-region path the
   * full employee editor uses (see `saveHiringPackEmployeeFacts`), and that path refuses anyone
   * already resigned or terminated. This flag is what the screen uses to lock those two fields —
   * a departed person's pay is governed by the resignation/settlement workflow from here on, not
   * by this screen.
   */
  departed: boolean;
  /**
   * The last working day as the EMPLOYEE RECORD holds it.
   *
   * A third source for the same fact, and the widest of the three: measured on production
   * 2026-08-30, all 57 people who have left carry it, while 3 of them have no `employee_resignations`
   * row at all — so reading only the resignation table would tell those three that their last
   * working day is missing while the date sat on the row already being fetched. Where both exist
   * they agreed in 54 of 54, so this is a wider source, not a competing one.
   */
  lastWorkingDate: string | null;
};

/**
 * One value the document asks for and nobody has supplied.
 *
 * This exists because the alternative — printing a blank line and hoping somebody notices — is
 * precisely the hand-filled-form failure this feature was built to end. A gap is surfaced in the UI
 * BEFORE printing, and its `blocking` flag separates "the document is legally incomplete without
 * this" from "the office will accept it and you can fill it later".
 */
export type HiringPackGap = {
  field: string;
  labelEn: string;
  labelAr: string;
  /**
   * Which documents this value is missing from — one entry per document that prints it.
   *
   * A LIST RATHER THAN A SINGLE VALUE, because the previous shape could not survive the exit forms.
   * It was `HiringPackDocument | "both"`, where "both" meant the contract and Form 1 — the only two
   * documents that existed. With five, "both" no longer names a set: an address is missing from the
   * contract, the resignation and the mutual-termination agreement but not from Form 6, and there is
   * no single token for that. Listing them means the screen shows each document exactly the values
   * that document is waiting for, instead of a warning about a form nobody is printing.
   */
  documents: readonly HiringPackDocument[];
  blocking: boolean;
  /** Where the value has to come from, so the reader knows who to chase. */
  source:
    | "employee-record"
    | "hiring-profile"
    | "company-settings"
    | "offboarding-profile"
    | "resignation-record";
};

/**
 * What the system already records about a departure, read from `employee_resignations`.
 *
 * `null` when there is no resignation row at all — which is the normal state for an active
 * employee, and the reason every exit document treats a missing departure as a gap rather than an
 * error. The exit forms can still be printed for somebody leaving today whose row lands tomorrow.
 *
 * TREAT `lastWorkingDate` AS A DEFAULT, NOT AS THE TRUTH. The exit form that writes this table
 * copies a single date into `submitted_date`, `resignation_date`, `last_working_date` and
 * `effective_date` in nearly every record, so the four agreeing proves nothing about any of them.
 * The offboarding profile can override it, and what prints is what a person confirmed.
 */
export type ExitFacts = {
  lastWorkingDate: string | null;
  resignationDate: string | null;
  effectiveDate: string | null;
  status: string | null;
  jobTitle: string | null;
};

/** One row in the employee picker on the fill screen. Deliberately thin — it is a chooser, not a record. */
export type HiringPackCandidate = {
  hrId: string;
  fullName: string;
  nameAr: string | null;
  jobTitle: string | null;
  hireDate: string | null;
  /**
   * True when this person has left. The picker groups on it, because the two halves of this module
   * are about two different populations: the contract and Form 1 are for somebody who just arrived,
   * and Form 6 and the exit forms are for somebody who has just gone.
   */
  departed: boolean;
  /** Their last working day, so a leaver can be recognised by the date rather than by memory. */
  lastWorkingDate: string | null;
};

export type HiringPackData = {
  employee: HiringPackEmployeeFacts;
  profile: HiringPackProfile;
  offboarding: OffboardingProfile;
  /** The departure as the system records it, or null when nobody has recorded one. */
  exit: ExitFacts | null;
  /**
   * The Arabic job title someone else already typed for the same English job title, most recently
   * saved first. A suggestion only — never persisted here, never overwrites `profile.jobTitleAr`.
   */
  suggestedJobTitleAr: string | null;
  gaps: HiringPackGap[];
  /** Resolved terms — the profile override where present, the company default otherwise. */
  terms: {
    durationMonths: number;
    probationMonths: number;
    underperformanceThresholdPct: number;
    underperformanceMonths: number;
    trainingBondMonths: number;
    contractStartDate: string | null;
    contractEndDate: string | null;
    /**
     * The last working day the exit documents actually print: the confirmed override where one
     * exists, the resignation record otherwise. Resolved once, here, so Form 6 and the Ministry of
     * Labour form can never disagree about the date service ended.
     */
    lastWorkingDate: string | null;
    /** The employer's signatory, resolved from the profile override or company settings. */
    employerRepNameAr: string;
    employerRepTitleAr: string;
  };
};

export type MarkHiringPackSignedInput = {
  hrId: string;
  document: HiringPackDocument;
  /** The date written on the paper. Not the moment the button was pressed. */
  signedDate: string;
  actorHrId?: string | null;
};
