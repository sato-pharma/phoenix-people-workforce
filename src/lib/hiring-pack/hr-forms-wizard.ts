// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE HR FORMS WIZARD — which papers a person walks through, in which order, and which are done.
//
// The owner, 2026-11-27: "make it the same form as the report. I choose: is this a new hire or a
// leaver? Then I choose the name. Then the form begins — the contract, and after I finish, the next
// form... On the left are all the things that should be filled, and each one gets a tick — once I
// print it, it is ticked. And give the system administrator an option to edit any form; he is not
// forced into anything."
//
// So HR Forms is the Adverse Drug Reaction report's wizard (`FormWizard`, src/components/ui/form-kit):
//   1. New hire, leaver, or another paper
//   2. The person
//   3… One step per paper, in the order they are handed over — each with its own fields above it,
//      in the order the Control tab arranged (`forms-layout.ts`)
//   last: what was printed, and the next person
//
// A PAPER IS DONE WHEN IT WAS PRINTED OR SIGNED for this person — read from the paper register
// (every real print writes a numbered row there, `issuePaperNumber`) and the signed dates on the
// pack. Never from a step having been passed: walking past a paper is not printing it.
//
// Pure and browser-safe — the screen reads it, and `tests/hr-forms-wizard.test.ts` pins it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { HiringPackDocument } from "@/lib/hiring-pack/types";

export type HrFormsPath = "newHire" | "leaver" | "other";

/** The three answers to step 1, in the order the screen offers them. */
export const HR_FORMS_PATHS: readonly {
  value: HrFormsPath;
  labelEn: string;
  labelAr: string;
  note: string;
}[] = [
  {
    value: "newHire",
    labelEn: "New hire",
    labelAr: "تعيين جديد",
    note: "Contract, Form 1 and every paper signed on the first day, one after another.",
  },
  {
    value: "leaver",
    labelEn: "Leaver",
    labelAr: "انتهاء خدمة",
    note: "Form 6, the exit form, the clearances, the handover and the certificates of experience.",
  },
  {
    value: "other",
    labelEn: "Another paper",
    labelAr: "نموذج آخر",
    note: "A letter, a renewal, a warning or a government sheet for one person.",
  },
];

/**
 * THE JOINER'S PAPERS, in the order they cross the desk on the first day: the contract and Form 1
 * first (the two the law and the insurance office need), then the service-file sheet, the
 * confidentiality undertaking, the receipt for the certificates handed in, the social status sheet,
 * and the custody receipts for whatever device is issued.
 */
export const NEW_HIRE_PAPERS: readonly HiringPackDocument[] = [
  "contract",
  "form1",
  "workerDataForm",
  "nda",
  "appointmentDocsReceipt",
  "socialStatusSheet",
  "custodyLaptop",
  "custodyMobile",
];

/**
 * THE EXIT FORM IS ONE STEP, NOT TWO. The resignation request and the mutual termination agreement
 * are alternatives — one is signed, never both (owner, 2026-08-30) — so the leaver walks through one
 * step that asks which, and then prints only that one.
 */
export const EXIT_FORM_STEP = "exitForm" as const;

export type LeaverStep = HiringPackDocument | typeof EXIT_FORM_STEP;

/**
 * THE LEAVER'S PAPERS. Form 6 first (it is what the insurance office files), then the exit form, then
 * BOTH clearances — complements, never alternatives: each protects the party that does not keep it,
 * so neither may hang on the exit-route choice — then the handover, the exit interview, the
 * certificates handed back, and the two certificates of experience.
 */
export const LEAVER_PAPERS: readonly LeaverStep[] = [
  "form6",
  EXIT_FORM_STEP,
  "clearanceEmployee",
  "clearanceCompany",
  "handoverRecord",
  "exitInterview",
  "appointmentDocsReturn",
  "experienceCertificate",
  "experienceCertificateEn",
];

/** The exit form a chosen route prints. Null until the route is chosen. */
export function exitFormDocument(
  exitRoute: "resignation" | "mutualTermination" | null,
): "resignation" | "mutualTermination" | null {
  return exitRoute;
}

/**
 * The paper steps of one path, for one viewer.
 *
 * `paperScope` — the papers a seat is limited to (SEAT_PRINTABLE_DOCUMENTS; none today), or null for
 * every paper. A paper outside the scope is not a step at all, rather than a step the server refuses.
 * The exit-form step stays while EITHER of its two papers is in scope.
 *
 * `arranged` — the package's papers as the Control tab arranged them (`forms-layout.ts`); absent, the
 * standard order below.
 */
export function hrFormsPaperSteps(
  path: HrFormsPath,
  paperScope: readonly HiringPackDocument[] | null = null,
  arranged?: { newHire: readonly LeaverStep[]; leaver: readonly LeaverStep[] },
): LeaverStep[] {
  const inScope = (document: HiringPackDocument) => paperScope === null || paperScope.includes(document);
  if (path === "newHire") {
    return (arranged?.newHire ?? NEW_HIRE_PAPERS).filter(
      (step): step is HiringPackDocument => step !== EXIT_FORM_STEP && inScope(step),
    );
  }
  if (path === "leaver") {
    return (arranged?.leaver ?? LEAVER_PAPERS).filter((step) =>
      step === EXIT_FORM_STEP ? inScope("resignation") || inScope("mutualTermination") : inScope(step),
    );
  }
  return [];
}

/** Every paper the two packages walk through, so "another paper" can offer the rest. */
export function papersInPackages(): ReadonlySet<HiringPackDocument> {
  return new Set<HiringPackDocument>([
    ...NEW_HIRE_PAPERS,
    ...LEAVER_PAPERS.filter((step): step is HiringPackDocument => step !== EXIT_FORM_STEP),
    "resignation",
    "mutualTermination",
  ]);
}

/** One row of the paper register, as the screen receives it. */
export type PrintedPaperRow = { document: string; issuedAt: string; reference: string };

export type PrintedPaper = { issuedAt: string; reference: string };

/**
 * The newest print of each paper, from the register rows for one person.
 *
 * NEWEST BY THE TIMESTAMP, NOT BY THE ORDER THE ROWS ARRIVED IN — the route sorts them, and a caller
 * that merges a print made this minute must not depend on that.
 */
export function latestPrintByDocument(rows: readonly PrintedPaperRow[]): Record<string, PrintedPaper> {
  const latest: Record<string, PrintedPaper> = {};
  for (const row of rows) {
    if (!row || typeof row.document !== "string" || typeof row.issuedAt !== "string") continue;
    const current = latest[row.document];
    if (!current || Date.parse(row.issuedAt) > Date.parse(current.issuedAt)) {
      latest[row.document] = { issuedAt: row.issuedAt, reference: row.reference };
    }
  }
  return latest;
}

export type PaperStatus =
  | { state: "signed"; on: string }
  | { state: "printed"; on: string }
  | { state: "open" };

/**
 * Where one paper stands for this person: signed beats printed, printed beats nothing.
 *
 * `signedOn` is the signed date saved on the pack (never the date typed in a box and not yet
 * recorded); `printedOn` is the newest register row, or a print sent from this screen this session.
 */
export function paperStatus(signedOn: string | null | undefined, printedOn: string | null | undefined): PaperStatus {
  if (signedOn) return { state: "signed", on: signedOn };
  if (printedOn) return { state: "printed", on: printedOn };
  return { state: "open" };
}

export function isPaperDone(status: PaperStatus): boolean {
  return status.state !== "open";
}
