/**
 * The papers this module prints, in the order a career runs through them.
 *
 * JOINING: the employment contract, social-insurance Form 1 (طلب اشتراك مؤمن عليه), and Sato's own
 *   worker-data form (استمارة بيانات العامل) — the service-file intake sheet filled on the day of hire.
 * DURING: a custody receipt (إقرار استلام عهدة) each time a company device is handed over —
 *   one numbered form for a laptop, another for a phone or tablet; and, once a year, ONE of the two
 *   renewal papers — the annex that extends the fixed term (ملحق تجديد سنوي) or the notice that says
 *   the company will not (إخطار بعدم تجديد).
 * LEAVING: social-insurance Form 6 (إخطار بإنتهاء اشتراك مؤمن عليه), ONE of the two Ministry of
 *   Labour exit templates — a resignation request or a mutual-termination agreement — and BOTH
 *   halves of the clearance pair (إخلاء طرف). The clearance pair are complements, not alternatives:
 *   one certifies the employee is clear of the company and he keeps it, the other certifies the
 *   company is clear of him and the company files it. A departure produces both.
 */

import type { CustodyDeviceFacts } from "@/lib/devices/types";
import type { CompanyDetails } from "@/lib/hiring-pack/company-details";
import { isUuid } from "@/lib/http/uuid";

export type HiringPackDocument =
  | "contract"
  | "form1"
  | "workerDataForm"
  | "custodyLaptop"
  | "custodyMobile"
  | "nda"
  | "appointmentDocsReceipt"
  | "socialStatusSheet"
  | "absenceWarning"
  | "deemedResignation"
  | "appointmentDocsReturn"
  | "experienceCertificate"
  | "experienceCertificateEn"
  | "salaryLetterEn"
  | "salaryLetterAr"
  | "disciplinaryWarning"
  | "disciplinaryPenalty"
  | "transferDecision"
  | "salaryAdjustment"
  | "socialInsuranceAuthorization"
  | "healthInsuranceAuthorization"
  | "insurancePrintLetter"
  | "handoverRecord"
  | "exitInterview"
  | "maternityCompensation"
  | "insuranceForm2"
  | "carInsuranceCertificate"
  | "wageProgressSheet"
  | "officialHolidaysSheet"
  | "sickLeaveSheet"
  | "penaltiesSheet"
  | "penaltyRegulationsApproval"
  | "contractRenewal"
  | "contractNonRenewal"
  | "form6"
  | "resignation"
  | "mutualTermination"
  | "clearanceEmployee"
  | "clearanceCompany";

/** The joining half — printed when somebody arrives. */
export const HIRING_DOCUMENTS = ["contract", "form1"] as const;

/**
 * The onboarding forms that are Sato's OWN paperwork rather than a signed instrument or a government
 * form — today just the worker-data form.
 *
 * A GROUP OF ITS OWN, not folded into `HIRING_DOCUMENTS`, and the distinction is the whole point:
 * `HIRING_DOCUMENTS` feeds `SIGNABLE_DOCUMENTS`, and the worker-data form must NOT be signable. It
 * carries a signature on paper but the app records no signed date against the person — like the
 * custody receipts, and for the same reason (see `SIGNABLE_DOCUMENTS`): it is a sheet filed in a
 * drawer, and recording nothing is honest where recording a half-truth is not. That is also why it
 * needed no migration to add.
 */
export const ONBOARDING_FORM_DOCUMENTS = ["workerDataForm"] as const;

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
 * The two renewal papers — printed when a fixed-term contract is coming to its end, which like a
 * device handover is neither arrival nor departure and happens repeatedly during one career.
 *
 * THEY ARE ALTERNATIVES, exactly as the resignation and the mutual-termination agreement are, and
 * for the same reason: they assert incompatible facts. The annex says the contract was extended
 * before it expired; the notice says it was allowed to run out. A file holding both signed for the
 * same term contradicts itself, and it is the signed paper a labour inspector reads.
 *
 * WHICH ONE IS PRINTED IS NOT RECORDED AGAINST THE PERSON, though, and that is the difference from
 * the exit pair. An exit happens once. A renewal happens every year, so one column on the employee
 * row could record only the most recent one while appearing to cover all of them — the identical
 * reasoning that keeps the custody receipts out of `SIGNABLE_DOCUMENTS`. The register that answers
 * this properly already exists and is not here: `contract_renewal_requests` holds one row per
 * renewal, with its own decision, its own dates and its own `signed_at`.
 */
export const RENEWAL_DOCUMENTS = ["contractRenewal", "contractNonRenewal"] as const;

/**
 * Sato's own HR papers — the six the owner supplied on 2026-09-05 and the certificate of experience
 * added on 2026-09-06, split by WHEN they are used rather than by what they look like.
 *
 * `HOUSE_JOINING_DOCUMENTS` are signed or completed on the day somebody arrives: the confidentiality
 * undertaking, the appointment-documents receipt, and the Article 92 service-file sheet.
 *
 * `HOUSE_ATTENDANCE_DOCUMENTS` are the two absence notices, which belong to neither end of a career
 * — they are issued while somebody is employed, and only one of them ends anything. THEY ARE NOT
 * ALTERNATIVES the way the exit pair is: the first warning is a PRECONDITION of the second, because
 * Article 166 requires a warning before a worker can be deemed resigned. Printing the second without
 * having served the first is the defect this grouping exists to make visible.
 *
 * `HOUSE_LEAVING_DOCUMENTS` holds two. The first is the exit half of the appointment-documents pair
 * — the employee's receipt for his own certificates coming back. Its sibling is in the joining list;
 * they were supplied as two files with almost the same name, and reading them as alternatives rather
 * than as two ends of one loop would file the wrong one at the wrong end of a career.
 *
 * The second is the CERTIFICATE OF EXPERIENCE, and it is filed here because that is when HR reaches
 * for it, not because it is only issued then: a serving employee can ask for one for a visa or a
 * bank, and the paper prints correctly for him — it says in terms that he is still employed. Filing
 * it under "other" beside the custody receipts would be defensible on that ground and was rejected,
 * because "other" is not a tab: the manager shows a joining package and a leaver package, and a
 * document nobody can find is worse than one filed under the commoner of its two occasions.
 */
export const HOUSE_JOINING_DOCUMENTS = [
  "nda",
  "appointmentDocsReceipt",
  "socialStatusSheet",
] as const;

export const HOUSE_ATTENDANCE_DOCUMENTS = ["absenceWarning", "deemedResignation"] as const;

export const HOUSE_LEAVING_DOCUMENTS = [
  "appointmentDocsReturn",
  "experienceCertificate",
  "experienceCertificateEn",
  "handoverRecord",
  "exitInterview",
] as const;

/**
 * The decisions HR issues about somebody still employed — a warning, a penalty, a transfer, and the
 * memo that sends a salary change to payroll. From the owner's letters pack of 2026-09-13, rebuilt
 * on the house template. Neither arriving nor leaving, so "other", with a drive folder of their own.
 */
export const HOUSE_DECISION_DOCUMENTS = [
  "disciplinaryWarning",
  "disciplinaryPenalty",
  "transferDecision",
  "salaryAdjustment",
] as const;

/**
 * The company's own letters to the insurance offices — two authorisations and the print request.
 * Same pack, same template. Filed beside the Authority's own forms in the insurance folder.
 */
export const HOUSE_INSURANCE_DOCUMENTS = [
  "socialInsuranceAuthorization",
  "healthInsuranceAuthorization",
  "insurancePrintLetter",
] as const;

/** All of Sato's own papers, in the order a career runs through them. */
export const HOUSE_PAPER_DOCUMENTS = [
  ...HOUSE_JOINING_DOCUMENTS,
  ...HOUSE_ATTENDANCE_DOCUMENTS,
  ...HOUSE_DECISION_DOCUMENTS,
  ...HOUSE_INSURANCE_DOCUMENTS,
  ...HOUSE_LEAVING_DOCUMENTS,
] as const;

/**
 * GOVERNMENT FORMS FROM THE SAME PACK, printed exactly as issued — owner, 2026-09-13: "governmental
 * leave as is". Page surfaces with no compiled placements, like an uploaded company template: the
 * artwork prints, and anything written on it is a field somebody placed. None is signable here.
 */
export const OFFICIAL_INSURANCE_FORM_DOCUMENTS = [
  "maternityCompensation",
  "insuranceForm2",
  "carInsuranceCertificate",
] as const;

/** The Labour Office registers and the penalty-regulations approval request. */
export const LABOUR_OFFICE_DOCUMENTS = [
  "wageProgressSheet",
  "officialHolidaysSheet",
  "sickLeaveSheet",
  "penaltiesSheet",
  "penaltyRegulationsApproval",
] as const;

/** Every government form from the 2026-09-13 pack. */
export const OFFICIAL_PACK_FORM_DOCUMENTS = [
  ...OFFICIAL_INSURANCE_FORM_DOCUMENTS,
  ...LABOUR_OFFICE_DOCUMENTS,
] as const;

export type OfficialPackFormDocument = (typeof OFFICIAL_PACK_FORM_DOCUMENTS)[number];

/** Whether a document is one of the pack's government forms. */
export function isOfficialPackFormDocument(document: string): document is OfficialPackFormDocument {
  return (OFFICIAL_PACK_FORM_DOCUMENTS as readonly string[]).includes(document);
}

/**
 * The HR letters an employee asks for while he works here — the salary letter, which states the
 * BASE salary on record in both languages (the Arabic since 2026-09-20, the English since 2026-10-28).
 * Neither arriving nor leaving, so both are filed under "other" with a folder of their own on the drive.
 *
 * NEITHER IS IN `HOUSE_PAPER_DOCUMENTS`, though for opposite reasons. `salaryLetterEn` has its own
 * English renderer, the way the English certificate of experience does. `salaryLetterAr`'s words ARE
 * an `HrPaperTemplate` — drawn since 2026-10-28 by its own renderer in the certificate's design, as the
 * Arabic certificate of experience is — but it is listed here rather than spread into `HOUSE_PAPER_DOCUMENTS`,
 * because that list is already spread into `HIRING_PACK_DOCUMENTS` separately from this one, and
 * adding it to both would enter it twice. See `HR_PAPER_SALARY_LETTER_AR_V1` in `hr-paper-text.ts`.
 */
export const HOUSE_LETTER_DOCUMENTS = ["salaryLetterEn", "salaryLetterAr"] as const;

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
  ...ONBOARDING_FORM_DOCUMENTS,
  ...ASSET_DOCUMENTS,
  ...HOUSE_PAPER_DOCUMENTS,
  ...HOUSE_LETTER_DOCUMENTS,
  ...OFFICIAL_PACK_FORM_DOCUMENTS,
  ...RENEWAL_DOCUMENTS,
  ...EXIT_DOCUMENTS,
];

/**
 * A COMPANY TEMPLATE'S DOCUMENT IDENTITY — the second half of what a document can be.
 *
 * The ten above are compiled in: their artwork, their placements and their renderers are code. A
 * company template is a ROW — uploaded through the UI, given a name and a page size, and printed by
 * the same page-surface machinery. It needs a document identity all the same, because every part of
 * this module keys on one: the field layer, the copy count, the print route, the editor.
 *
 * `custom:<uuid>` is that identity, and the shape is deliberate on two counts. It cannot collide
 * with a built-in key, now or ever, because no built-in contains a colon. And it is a STRING that
 * survives a round trip through a query parameter, a JSON body and a database column without needing
 * a second field beside it saying which kind of document this is — the prefix says so.
 *
 * The uuid is the template's `key`, which is stable across versions, NOT the version's own id. That
 * is the same relationship the built-ins have: `contract` is the document, `contract-v3` is the
 * version, and the field layer scopes to the version while everything else names the document.
 */
export const CUSTOM_DOCUMENT_PREFIX = "custom:";

export type CustomHiringPackDocument = `custom:${string}`;

/** The `custom:<key>` document identity for a company template. */
export function customDocumentFor(templateKey: string): CustomHiringPackDocument {
  return `${CUSTOM_DOCUMENT_PREFIX}${templateKey}`;
}

// Re-exported, not redefined: this module's callers have imported `isUuid` from here since before
// there was anywhere else to put it, and the definition now lives in one place.
export { isUuid };

/**
 * The uuid inside a `custom:<uuid>` document, or null for anything else.
 *
 * VALIDATES THE UUID rather than splitting on the colon and trusting what follows. This value is
 * about to be used to look up a row, and the caller's alternative to a null here is a query built
 * from whatever came after the prefix.
 */
export function customTemplateKeyOf(document: string): string | null {
  if (!document.startsWith(CUSTOM_DOCUMENT_PREFIX)) return null;
  const key = document.slice(CUSTOM_DOCUMENT_PREFIX.length);
  return isUuid(key) ? key : null;
}

/** Whether this document is a company template rather than one of the ten compiled in. */
export function isCustomDocument(document: string): document is CustomHiringPackDocument {
  return customTemplateKeyOf(document) !== null;
}

/** Whether this is one of the ten documents that are code. */
export function isBuiltInDocument(document: string): document is HiringPackDocument {
  return (HIRING_PACK_DOCUMENTS as readonly string[]).includes(document);
}

/**
 * Anything this system can print: one of the ten written in code, or a company template.
 *
 * IT LIVES HERE RATHER THAN IN document-registry.ts, and only because of an import cycle that is
 * worth stating out loud. The registry is where the question "what is this document" belongs and
 * where every lookup over this type is written; but `field-layout.ts` needs the type to describe a
 * stored row, and the registry needs `DocumentSurface` FROM field-layout. Declaring it in types.ts
 * — which imports nothing — breaks that cycle and costs nothing, since the registry re-exports it.
 *
 * THE UNION IS NOT WIDENED. `HiringPackDocument` still means one of the ten and still keys the
 * exhaustive `Record` tables; this is the wider type, used where a value may be either kind.
 */
export type PrintableDocument = HiringPackDocument | CustomHiringPackDocument;

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
 *
 * THE TWO RENEWAL PAPERS ARE ABSENT FOR THE SAME REASON AND WITH THE ANSWER ALREADY BUILT: a
 * contract is renewed every year, so one date against the employee could record only the newest of
 * them. `contract_renewal_requests` is the register — one row per renewal, carrying its own
 * decision and its own `signed_at` — so a date here would be a second, worse copy of it. See
 * `RENEWAL_DOCUMENTS`.
 *
 * FIVE OF SATO'S SIX OWN PAPERS ARE ABSENT, and each of those five is a decision. The two absence
 * notices are issued repeatedly; the checklist, the service-file sheet and the appointment-documents
 * receipt are sheets filed in a drawer — the worker-data form's reasoning exactly.
 *
 * THE NDA IS NOT ONE OF THEM ANY MORE. It is signed once in a career, like the contract, so it has
 * its own `nda_signed_date` and its own checklist row as of 2026-09-05. It is listed explicitly
 * below rather than folded into a group, because the group it belongs to by SHAPE — Sato's own
 * papers — is precisely the group whose other members must stay out.
 */
export const SIGNABLE_DOCUMENTS: readonly HiringPackDocument[] = [
  ...HIRING_DOCUMENTS,
  // Named on its own, deliberately. Spreading `HOUSE_JOINING_DOCUMENTS` here would sweep in the
  // appointment-documents receipt and the service-file sheet with it, and both must stay out.
  "nda",
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
/**
 * The contract's own terms on the hiring profile. The HR Operations Specialist prints them and does
 * not change them (owner, 2026-11-02: "lock contract terms for aya, she only prints them").
 */
export const HIRING_CONTRACT_TERM_FIELDS = [
  "contractStartDate",
  "contractEndDate",
  "contractDurationMonths",
  "underperformanceThresholdPct",
  "underperformanceMonths",
  "trainingBondMonths",
  "contractSignatoryNameAr",
  "contractSignatoryTitleAr",
  "contractObjectiveReasonCode",
] as const;

export function isContractTermField(field: string): boolean {
  return (HIRING_CONTRACT_TERM_FIELDS as readonly string[]).includes(field);
}

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
  /**
   * WHO SIGNS FOR THE COMPANY, when it is not the standing signatory.
   *
   * Both are overrides and both are normally NULL, which means "use the signatory in
   * `system-settings`" — the usual contract needs nothing typed. A value states who signed THIS
   * instrument, and it moves all three places the contract names him at once: the recital, the
   * signature grid's الاسم cell, and the note beneath the grid.
   *
   * They live here, per employee, and not in settings: settings are shared by every document and
   * every person, so typing a delegate's name there to print one contract would rewrite the
   * company's representative on everybody else's paper. See `paper-fields.ts`.
   */
  contractSignatoryNameAr?: string | null;
  contractSignatoryTitleAr?: string | null;
  /**
   * WHY THIS POST IS ON A FIXED TERM — one of the standard grounds in `renewal-reasons.ts`.
   *
   * Stored as a CODE, resolved to its Arabic clause at print time. Article 87 of Labour Law 14/2025
   * permits a fixed term only where the nature of the work requires it, so this is the sentence that
   * makes the term lawful rather than a formality, and the renewal annex prints it in its preamble.
   *
   * It describes the POST and not the person, which is the reason it is a closed list: two people in
   * the same job whose annexes state different grounds have written a contradiction into their own
   * paperwork. Null prints the dotted rule, exactly as before the list existed — a blank somebody
   * still has to answer is honest, and a guess here would be signed.
   */
  contractObjectiveReasonCode?: string | null;
};

/**
 * What "What Phoenix already knows" edits, when it is edited at all.
 *
 * Every field here writes straight to `employees` — there is no second copy, on purpose (see the
 * screen's own note on that). `baseSalary` is re-run through the same payroll formula the full
 * employee editor uses, and `lineId` through the same region derivation; both are refused for
 * anyone already resigned or terminated — see `saveHiringPackEmployeeFacts`.
 *
 * `lineId` is the product line. It is NOT the department: that used to be the same field, and the
 * owner corrected it on 2026-08-31. The department comes from `employees.department_id` and is not
 * edited here.
 *
 * There is no insurance wage to submit. It is derived from the base salary now
 * (`insurance-wage.ts`), so an editable box for it would take a number and then ignore it.
 */
export type HiringPackEmployeeFactsInput = {
  fullName?: string | null;
  nameAr?: string | null;
  nationalId?: string | null;
  socialInsuranceNumber?: string | null;
  /** «الأجر الأساسي» — the figure the contract prints and the insurance wage is derived from. */
  baseSalary?: number | null;
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
  /**
   * The confidentiality undertaking's signature, recorded like the contract's.
   *
   * NOT part of `HiringPackProfileInput`: it is not something HR types into the terms form, it is
   * stamped when the paper is marked signed — the same rule `contractSignedDate` follows.
   */
  ndaSignedDate: string | null;
  ndaPrintedAt: string | null;
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
  /**
   * `male` / `female` as `employees.gender` stores it — NOT printed on any paper.
   *
   * It is here for one reason: Arabic inflects nationality for gender, so the papers need to know
   * which of مصري / مصرية to print when nobody recorded a nationality. Required rather than
   * optional on purpose — optional lets a loader quietly forget to select it, and the failure that
   * causes is invisible and lands on a signed contract. See `nationality.ts`.
   */
  gender: string | null;
  socialInsuranceNumber: string | null;
  socialInsuranceWage: number | null;
  /**
   * The contract's salary — «الأجر الأساسي», the figure مادة (2) names and مادة (10) spells out.
   *
   * The pack printed `grossSalary` here until 2026-08-31, when the owner corrected it: "the salary
   * and department we use is the base salary". Gross is base plus its allowances (measured across
   * production it runs about 1.29× base), so every contract printed to date overstates the salary
   * it commits the company to.
   */
  baseSalary: number | null;
  grossSalary: number | null;
  birthDate: string | null;
  hireDate: string | null;
  jobTitle: string | null;
  /** Arabic for the department that employs this person — NOT his product line. */
  departmentAr: string | null;
  /** The department `departmentAr` was resolved from. */
  departmentId: number | null;
  /** The product line. Sales geography, never the contract's إدارة — see `departmentAr`. */
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

/**
 * The part of a contract-renewal request the renewal papers print from.
 *
 * A NARROW LOCAL TYPE, NOT `ContractRenewalRecord` FROM `@/lib/contracts/types`, and that is not
 * duplication for its own sake. This module's `types.ts` imports NOTHING — deliberately, so it can
 * be imported by every other file here without a cycle (see the note on `PrintableDocument`) — and
 * reaching into another domain's types from it would end that property for the sake of twenty-five
 * fields of which the papers use four. The loader in `service.ts` narrows the full row down to this
 * on the way in, which is also the place a change to the contracts domain would surface.
 *
 * `status` travels because it decides WHICH paper is the honest one to print: a request decided
 * `not_renewed` has proposed dates on it, and printing an annex from those would produce a renewal
 * agreement for a term the company has already declined to grant.
 */
export type ContractRenewalFacts = {
  id: string;
  status: string;
  /** The first day of the new term, as HR and the manager approved it. */
  proposedStartDate: string | null;
  /** The last day of the new term. */
  proposedEndDate: string | null;
  /** The territory recorded on the request — the annex's النطاق الجغرافي, never the product line. */
  areaName: string | null;
  /** When the signed annex was filed against the request, if it has been. */
  signedAt: string | null;
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
  /**
   * The company as the papers will print it — the stored record, or the compiled default.
   *
   * ON THE PACK RATHER THAN IMPORTED BY EACH RENDERER, and that is what makes it editable at all.
   * Nine renderers used to read `systemLegalEntity` directly, which is a module constant: there is
   * no point in that chain where a stored correction could enter. Carrying it here means the
   * company is resolved once, in `getHiringPack`, and every document in the pack necessarily
   * agrees — which is the property that matters, because the contract, Form 1 and the Ministry of
   * Labour forms state the same company to three different readers.
   *
   * IT IS THE COMPANY'S RECORD, NOT THIS EMPLOYEE'S. Editing it on one person's paper changes it on
   * everybody's. `company-details.ts` explains why that is the correct behaviour and not a leak.
   */
  company: CompanyDetails;
  /** The departure as the system records it, or null when nobody has recorded one. */
  exit: ExitFacts | null;
  /**
   * The device this custody receipt is being printed FOR, or null when none has been chosen.
   *
   * NULL IS THE NORMAL CASE and must stay printable. The pack is very often run the evening before
   * a joiner arrives, with no machine allocated yet — a receipt printed then carries ruled blanks
   * through the technical block, exactly as it did before the device register existed, and somebody
   * completes them at the desk with the device in hand.
   *
   * When it IS set, the serial and the IMEI on the paper come from the `company_devices` row that
   * will carry them afterwards, so the number somebody signs for and the number the company can
   * hand to the police are the same number by construction rather than by transcription.
   * `render-custody.ts` resolves the tokens; `custody-template.ts` carries the fuller note.
   */
  custodyDevice: CustodyDeviceFacts | null;
  /**
   * The newest contract-renewal request for this person, or null when none was ever raised.
   *
   * THE RENEWAL PAPERS PREFER IT TO THEIR OWN ARITHMETIC, and the distinction is the point. This
   * row carries dates a manager and HR both reviewed and a decision was taken against — it is a
   * RECORD. The alternative the renderer falls back on, "the day after the old term, for the same
   * number of months", is a SUGGESTION. Printing the record means the annex bears the dates
   * somebody actually approved; the derivation only fills a page printed ahead of the workflow.
   *
   * NEWEST, not "the one being decided". A person renewed four times has four rows, and the paper
   * being printed is always about the current term — so the ordering is `created_at desc` and the
   * shape stays one row rather than a list, which is what every caller of this type wants.
   */
  renewal: ContractRenewalFacts | null;
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
