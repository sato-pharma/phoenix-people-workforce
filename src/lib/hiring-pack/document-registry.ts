// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT A DOCUMENT IS — one answer, for the ten written in code AND the ones uploaded through the
// screen.
//
// Before company templates existed, "which papers are there" was a closed question with a closed
// answer: ten keys in a union, and half a dozen `Record<HiringPackDocument, …>` tables that the
// compiler forced you to fill in. That was a good design and it is still a good design for the ten.
// What it cannot express is a paper that did not exist when the code was written.
//
// SO THE UNION IS NOT WIDENED. Widening `HiringPackDocument` to admit `custom:<uuid>` would turn
// every one of those tables into something with an index signature, and the compiler would stop
// asking the question those tables exist to force — "an eleventh built-in document cannot be added
// without deciding this". The tables would still be there, silently answering `undefined`. Instead
// there are two types: `HiringPackDocument` still means one of the ten and still keys the exhaustive
// tables, and `PrintableDocument` means anything this system can print. Every lookup below is a
// TOTAL FUNCTION over the wider type, so a custom document has a real answer rather than a hole.
//
// AND THE TABLES ARE CHECKED AT RUNTIME, not by the compiler. `next.config` sets
// `typescript.ignoreBuildErrors`, so a table that has silently lost a key still compiles, still
// builds, and still deploys — the type is not the guard here. `assertBuiltInTablesAreComplete`
// below is, and `tests/hiring-pack-document-registry.test.ts` runs it in the required `validate`
// job. A missing key is a document with no name, no copy count and no surface: it would print as
// `undefined` on a screen, or not print at all.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { systemContractDefaults } from "@/config/system-settings";
// A TYPE only — this module runs in the browser and must not pull the permission matrix in.
import type { PhoenixRole } from "@/lib/auth/permissions";
import {
  isCustomTemplateGroup,
  type CustomTemplateGroup,
} from "@/lib/hiring-pack/custom-templates";
import type { DocumentSurface } from "@/lib/hiring-pack/field-layout";
import {
  ASSET_DOCUMENTS,
  EXIT_DOCUMENTS,
  HIRING_DOCUMENTS,
  HIRING_PACK_DOCUMENTS,
  HOUSE_ATTENDANCE_DOCUMENTS,
  HOUSE_DECISION_DOCUMENTS,
  HOUSE_INSURANCE_DOCUMENTS,
  HOUSE_JOINING_DOCUMENTS,
  HOUSE_LEAVING_DOCUMENTS,
  HOUSE_LETTER_DOCUMENTS,
  OFFICIAL_PACK_FORM_DOCUMENTS,
  ONBOARDING_FORM_DOCUMENTS,
  RENEWAL_DOCUMENTS,
  isBuiltInDocument,
  isCustomDocument,
  type HiringPackDocument,
  type PrintableDocument,
} from "@/lib/hiring-pack/types";

/**
 * Anything this system can print: one of the ten, or a company template somebody uploaded.
 *
 * Declared in types.ts and re-exported here, where it belongs conceptually. See the note there:
 * field-layout.ts needs this type and the registry needs field-layout, so the declaration sits in
 * the one module in this package that imports nothing.
 */
export type { PrintableDocument } from "@/lib/hiring-pack/types";

/** What each of the ten is called in a sentence to the user. */
const BUILT_IN_LABELS: Readonly<Record<HiringPackDocument, string>> = {
  contract: "Contract",
  form1: "Form 1",
  workerDataForm: "Worker data form",
  custodyLaptop: "Laptop custody receipt",
  custodyMobile: "Phone/tablet custody receipt",
  nda: "Confidentiality undertaking",
  appointmentDocsReceipt: "Appointment documents receipt",
  socialStatusSheet: "Social status sheet",
  absenceWarning: "Absence warning (first)",
  deemedResignation: "Deemed resignation notice",
  appointmentDocsReturn: "Appointment documents returned",
  experienceCertificate: "Certificate of experience (Arabic)",
  experienceCertificateEn: "Certificate of experience (English)",
  salaryLetterEn: "HR letter — basic salary (English)",
  salaryLetterAr: "HR letter — base salary (Arabic)",
  disciplinaryWarning: "Disciplinary warning",
  disciplinaryPenalty: "Administrative penalty",
  transferDecision: "Transfer decision",
  salaryAdjustment: "Salary adjustment memo",
  socialInsuranceAuthorization: "Social insurance authorisation letter",
  healthInsuranceAuthorization: "Health insurance authorisation letter",
  insurancePrintLetter: "Insurance record print request",
  handoverRecord: "Handover record",
  exitInterview: "Exit interview",
  maternityCompensation: "Maternity leave compensation request",
  insuranceForm2: "Social insurance Form 2",
  carInsuranceCertificate: "Car insurance certificate — registration request",
  wageProgressSheet: "Labour Office — wage progression sheet",
  officialHolidaysSheet: "Labour Office — official holidays sheet",
  sickLeaveSheet: "Labour Office — sick leave sheet",
  penaltiesSheet: "Labour Office — penalties sheet",
  penaltyRegulationsApproval: "Labour Office — penalty regulations approval request",
  contractRenewal: "Contract renewal annex",
  contractNonRenewal: "Non-renewal notice",
  form6: "Form 6",
  resignation: "Resignation request",
  mutualTermination: "Mutual termination agreement",
  clearanceEmployee: "Employee clearance",
  clearanceCompany: "Company clearance",
};

/** The standing copy count for each of the ten — each one the form's own stated requirement. */
const BUILT_IN_COPIES: Readonly<Record<HiringPackDocument, number>> = {
  contract: systemContractDefaults.contractCopies,
  form1: systemContractDefaults.form1Copies,
  workerDataForm: systemContractDefaults.workerDataFormCopies,
  custodyLaptop: systemContractDefaults.custodyLaptopCopies,
  custodyMobile: systemContractDefaults.custodyMobileCopies,
  nda: systemContractDefaults.ndaCopies,
  appointmentDocsReceipt: systemContractDefaults.appointmentDocsReceiptCopies,
  socialStatusSheet: systemContractDefaults.socialStatusSheetCopies,
  absenceWarning: systemContractDefaults.absenceWarningCopies,
  deemedResignation: systemContractDefaults.deemedResignationCopies,
  appointmentDocsReturn: systemContractDefaults.appointmentDocsReturnCopies,
  experienceCertificate: systemContractDefaults.experienceCertificateCopies,
  experienceCertificateEn: systemContractDefaults.experienceCertificateCopies,
  salaryLetterEn: systemContractDefaults.salaryLetterCopies,
  salaryLetterAr: systemContractDefaults.salaryLetterCopies,
  disciplinaryWarning: systemContractDefaults.disciplinaryWarningCopies,
  disciplinaryPenalty: systemContractDefaults.disciplinaryPenaltyCopies,
  transferDecision: systemContractDefaults.transferDecisionCopies,
  salaryAdjustment: systemContractDefaults.salaryAdjustmentCopies,
  socialInsuranceAuthorization: systemContractDefaults.socialInsuranceAuthorizationCopies,
  healthInsuranceAuthorization: systemContractDefaults.healthInsuranceAuthorizationCopies,
  insurancePrintLetter: systemContractDefaults.insurancePrintLetterCopies,
  handoverRecord: systemContractDefaults.handoverRecordCopies,
  exitInterview: systemContractDefaults.exitInterviewCopies,
  maternityCompensation: systemContractDefaults.maternityCompensationCopies,
  insuranceForm2: systemContractDefaults.insuranceForm2Copies,
  carInsuranceCertificate: systemContractDefaults.carInsuranceCertificateCopies,
  wageProgressSheet: systemContractDefaults.wageProgressSheetCopies,
  officialHolidaysSheet: systemContractDefaults.officialHolidaysSheetCopies,
  sickLeaveSheet: systemContractDefaults.sickLeaveSheetCopies,
  penaltiesSheet: systemContractDefaults.penaltiesSheetCopies,
  penaltyRegulationsApproval: systemContractDefaults.penaltyRegulationsApprovalCopies,
  contractRenewal: systemContractDefaults.contractRenewalCopies,
  contractNonRenewal: systemContractDefaults.contractNonRenewalCopies,
  form6: systemContractDefaults.form6Copies,
  resignation: systemContractDefaults.resignationCopies,
  mutualTermination: systemContractDefaults.mutualTerminationCopies,
  clearanceEmployee: systemContractDefaults.clearanceEmployeeCopies,
  clearanceCompany: systemContractDefaults.clearanceCompanyCopies,
};

/**
 * ONE COPY, for a paper nobody has told us about yet.
 *
 * Every built-in count is the form's own stated requirement — Form 1 goes to the insurance office in
 * a set number of copies because the office says so. An uploaded template has said nothing, so the
 * only honest default is the one that wastes nothing and surprises nobody. Whoever prints it can
 * type a different number, and that number is what prints.
 */
export const CUSTOM_DOCUMENT_DEFAULT_COPIES = 1;

/**
 * What to call a company template when its name is not to hand.
 *
 * NEVER THE KEY ITSELF. `custom:1857bafe-d3f9-4576-a850-abe82f884f0d` is a raw identifier, and this
 * system does not show people raw identifiers — the owner's standing rule, and a uuid on a screen is
 * exactly the kind of thing that gets read out over the phone. This phrase appears only when a
 * reference outlives the template it points at, which is a stale row rather than a normal state.
 */
export const CUSTOM_DOCUMENT_FALLBACK_LABEL = "Company template";

/** Names for the uploaded templates, keyed by their document — `custom:<uuid>` — or by bare key. */
export type CustomDocumentNames = Readonly<Record<string, string>>;

/**
 * What this document is called.
 *
 * `names` carries the uploaded templates' own names, which live in a database row rather than in
 * this file — that is the entire point of a template you can upload. It is looked up by the full
 * document (`custom:<uuid>`) and by the bare key, because both spellings are natural at the call
 * sites and neither is worth a bug.
 */
export function documentLabel(document: PrintableDocument, names?: CustomDocumentNames): string {
  if (isBuiltInDocument(document)) return BUILT_IN_LABELS[document];
  if (names) {
    const direct = names[document];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const bare = names[document.slice("custom:".length)];
    if (typeof bare === "string" && bare.trim()) return bare.trim();
  }
  return CUSTOM_DOCUMENT_FALLBACK_LABEL;
}

/** How many copies this document prints by default. */
export function documentDefaultCopies(document: PrintableDocument): number {
  return isBuiltInDocument(document) ? BUILT_IN_COPIES[document] : CUSTOM_DOCUMENT_DEFAULT_COPIES;
}

/**
 * The surfaces again, and DELIBERATELY a second copy of what `field-layout.ts` holds.
 *
 * A single shared table would be tidier and would also make this file import the renderer's module
 * into every caller that only wants a label. The duplication is safe because it is CHECKED: the
 * registry test compares this table against `DOCUMENT_SURFACES` key by key, so the two cannot drift
 * without a red build. Duplication nobody verifies is a bug waiting; duplication a test pins is a
 * boundary.
 */
const BUILT_IN_SURFACE_HINT: Readonly<Record<HiringPackDocument, DocumentSurface>> = {
  contract: "flow",
  form1: "page",
  workerDataForm: "flow",
  custodyLaptop: "flow",
  custodyMobile: "flow",
  nda: "flow",
  appointmentDocsReceipt: "flow",
  socialStatusSheet: "flow",
  absenceWarning: "flow",
  deemedResignation: "flow",
  appointmentDocsReturn: "flow",
  experienceCertificate: "flow",
  experienceCertificateEn: "flow",
  salaryLetterEn: "flow",
  salaryLetterAr: "flow",
  disciplinaryWarning: "flow",
  disciplinaryPenalty: "flow",
  transferDecision: "flow",
  salaryAdjustment: "flow",
  socialInsuranceAuthorization: "flow",
  healthInsuranceAuthorization: "flow",
  insurancePrintLetter: "flow",
  handoverRecord: "flow",
  exitInterview: "flow",
  maternityCompensation: "page",
  insuranceForm2: "page",
  carInsuranceCertificate: "page",
  wageProgressSheet: "page",
  officialHolidaysSheet: "page",
  sickLeaveSheet: "page",
  penaltiesSheet: "page",
  penaltyRegulationsApproval: "page",
  contractRenewal: "flow",
  contractNonRenewal: "flow",
  form6: "page",
  resignation: "page",
  mutualTermination: "page",
  clearanceEmployee: "flow",
  clearanceCompany: "flow",
};

/**
 * Whether this document places fields by page coordinate or by anchor in the flow.
 *
 * A COMPANY TEMPLATE IS ALWAYS A PAGE, and that is not a default — it is what an uploaded template
 * is. The artwork is a fixed image of a fixed sheet, so a field dropped 180pt down page 2 is 180pt
 * down page 2 for every employee, permanently. The flow surface exists for documents this system
 * TYPESETS, where a longer name reflows the text and a stored coordinate lands mid-sentence. Nothing
 * about an uploaded image reflows, so there is nothing for an anchor to hang from.
 *
 * Kept as a re-export shape rather than importing `documentSurface` and widening it there, so that
 * `field-layout.ts` keeps its exhaustive table keyed on the ten and this file owns the wider
 * question. Both answers agree for the ten, and the test asserts they do.
 */
export function documentSurfaceOf(document: PrintableDocument): DocumentSurface {
  return isBuiltInDocument(document) ? BUILT_IN_SURFACE_HINT[document] : "page";
}

/**
 * WHICH PACKAGE A DOCUMENT PRINTS IN — the same question for the ten and for an uploaded template.
 *
 * The ten answer it from the lists in types.ts, which is where the answer already lives and is not
 * a preference: Form 1 is a joining form because the insurance office says so, and Form 6 is a
 * leaving form for the same reason. THE CUSTODY RECEIPTS ARE THE INTERESTING CASE — a laptop is
 * handed over on the first day and just as often three years later, so they are neither, and
 * "other" is the honest answer rather than filing them under joining because that is when most of
 * them are printed.
 *
 * An uploaded template answers it from its row, because nothing in the code knows what it is.
 */
const BUILT_IN_GROUPS: Readonly<Record<HiringPackDocument, CustomTemplateGroup>> = {
  ...fromList(HIRING_DOCUMENTS, "joining"),
  ...fromList(ONBOARDING_FORM_DOCUMENTS, "joining"),
  ...fromList(EXIT_DOCUMENTS, "leaving"),
  ...fromList(ASSET_DOCUMENTS, "other"),
  ...fromList(RENEWAL_DOCUMENTS, "other"),
  ...fromList(HOUSE_JOINING_DOCUMENTS, "joining"),
  ...fromList(HOUSE_ATTENDANCE_DOCUMENTS, "other"),
  ...fromList(HOUSE_LEAVING_DOCUMENTS, "leaving"),
  ...fromList(HOUSE_LETTER_DOCUMENTS, "other"),
  // The letters pack of 2026-09-13: decisions and insurance letters are served on somebody still
  // employed, and the government forms are registers and applications of the working life. The
  // handover record and the exit interview are in HOUSE_LEAVING_DOCUMENTS above.
  ...fromList(HOUSE_DECISION_DOCUMENTS, "other"),
  ...fromList(HOUSE_INSURANCE_DOCUMENTS, "other"),
  ...fromList(OFFICIAL_PACK_FORM_DOCUMENTS, "other"),
} as Readonly<Record<HiringPackDocument, CustomTemplateGroup>>;

function fromList(
  documents: readonly HiringPackDocument[],
  group: CustomTemplateGroup,
): Partial<Record<HiringPackDocument, CustomTemplateGroup>> {
  const built: Partial<Record<HiringPackDocument, CustomTemplateGroup>> = {};
  for (const document of documents) built[document] = group;
  return built;
}

/** Which package's groups an uploaded template belongs to, keyed by document or by bare key. */
export type CustomDocumentGroups = Readonly<Record<string, string>>;

/**
 * Which package this document prints in.
 *
 * `groups` carries the uploaded templates' own answers, which live in a database row. An uploaded
 * template with no answer on file is "other" — that is what an unsorted paper IS, not a guess.
 */
export function documentGroup(
  document: PrintableDocument,
  groups?: CustomDocumentGroups,
): CustomTemplateGroup {
  if (isBuiltInDocument(document)) return BUILT_IN_GROUPS[document];
  if (groups) {
    const direct = groups[document];
    if (isCustomTemplateGroup(direct)) return direct;
    const bare = groups[document.slice("custom:".length)];
    if (isCustomTemplateGroup(bare)) return bare;
  }
  return "other";
}

/**
 * Every built-in table has an entry for every built-in document, and nothing else.
 *
 * THIS IS THE GUARD THE TYPE SYSTEM CANNOT BE. Returns the problems it found rather than throwing,
 * so a test can report all of them at once instead of one per run.
 */
export function assertBuiltInTablesAreComplete(): string[] {
  const problems: string[] = [];
  const expected = new Set<string>(HIRING_PACK_DOCUMENTS);

  const tables: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
    ["labels", BUILT_IN_LABELS],
    ["default copies", BUILT_IN_COPIES],
    ["surfaces", BUILT_IN_SURFACE_HINT],
    ["packages", BUILT_IN_GROUPS],
  ];

  for (const [name, table] of tables) {
    for (const document of expected) {
      if (!(document in table)) problems.push(`the ${name} table has no entry for "${document}"`);
    }
    for (const key of Object.keys(table)) {
      if (!expected.has(key)) problems.push(`the ${name} table has "${key}", which is not a document`);
    }
  }

  for (const document of HIRING_PACK_DOCUMENTS) {
    const label = BUILT_IN_LABELS[document];
    if (typeof label !== "string" || !label.trim()) {
      problems.push(`"${document}" has no readable name`);
    }
    const copies = BUILT_IN_COPIES[document];
    if (!Number.isInteger(copies) || copies < 1) {
      problems.push(`"${document}" has a copy count of ${String(copies)}, which cannot be printed`);
    }
  }

  return problems;
}

/**
 * The document a stored key refers to, or null if it refers to nothing this system prints.
 *
 * Used where a document arrives as a plain string — a request body, a database column, a URL — and
 * must be narrowed before anything is looked up against it. Returning null rather than throwing
 * keeps the caller in charge of what an unknown document means, which differs: on a print route it
 * is a 404, on a list it is a row to skip.
 */
export function asPrintableDocument(value: string): PrintableDocument | null {
  if (isBuiltInDocument(value)) return value;
  if (isCustomDocument(value)) return value;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHICH PAPERS A SEAT MAY PRINT — for a seat that prints papers WITHOUT holding employee_documents.
//
// The HR Operations Specialist (`HR Administration`, owner, 2026-10-20) prepares the contract
// renewal and follows a resignation up "until he comes to office to fulfil the resignation cycle",
// so she prints the papers of those two moments and nothing else. She is outside
// `hrAuthorityRoles`, so `hardBoundaryAllowedActions` strips employee_documents from her and the
// key cannot be the answer: it would open every paper, the company templates and the template
// studio with it. A seat named here therefore prints exactly its listed BUILT-IN papers — never a
// company template (`custom:<uuid>`), which may print anything at all — and every seat NOT named
// here keeps the employee_documents check it had before.
//
// The renewal annex prints the salary, and that is the owner's one money exception for her. None of
// the other seven prints an amount: the non-renewal notice, the deemed-resignation notice, the
// handover record and the resignation carry no money field, the mutual-termination agreement fills
// names, dates and the contract's start but no figure, and both clearances leave the settlement
// line blank by design.
//
// Pure and dependency-free on purpose (a TYPE import only): the HR Forms screen reads it in the
// browser, and the print, sign and paper-register routes read it on the server — one list, both
// sides.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SEAT_PRINTABLE_DOCUMENTS: Readonly<Partial<Record<PhoenixRole, readonly HiringPackDocument[]>>> = {
  "HR Administration": [
    "contractRenewal",
    "contractNonRenewal",
    "resignation",
    "clearanceEmployee",
    "clearanceCompany",
    "handoverRecord",
    // Added the same day by the owner: the absence-based notice that ends a service, and the
    // agreed-exit alternative to a resignation.
    "deemedResignation",
    "mutualTermination",
  ],
};

/**
 * The papers `role` is limited to, or null when the role has no entry — which means "this table
 * does not decide for you; employee_documents does", NOT "nothing".
 */
export function seatPapersFor(role: PhoenixRole | string | null | undefined): readonly HiringPackDocument[] | null {
  if (!role) return null;
  return SEAT_PRINTABLE_DOCUMENTS[role as PhoenixRole] ?? null;
}

/**
 * Whether `document` is open to `role` AS FAR AS THIS TABLE IS CONCERNED. True for every role the
 * table does not name (their employee_documents check still runs, elsewhere). For a named seat:
 * true only for a listed built-in paper — a company template is always false.
 */
export function isPaperOpenToRole(role: PhoenixRole | string | null | undefined, document: string): boolean {
  const papers = seatPapersFor(role);
  if (!papers) return true;
  if (!isBuiltInDocument(document)) return false;
  return papers.includes(document);
}
