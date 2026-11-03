import type { ExitRoute } from "@/lib/hiring-pack/types";

export type HiringDocumentStatus = "pending" | "submitted" | "missing";

/**
 * How hard the scanner step works on a photographed page.
 *
 * Declared here rather than beside the pipeline on purpose: this file is imported by a client
 * component, and `document-scan.ts` pulls in sharp and pdf-lib. A type-only import would be erased,
 * but nothing then stops the next edit from reaching for a value out of that module and dragging an
 * image library towards the browser bundle. Keeping the type in the leaf file removes the question.
 */
export type HiringDocumentScanMode = "colour" | "greyscale" | "high-contrast";

/**
 * How a stored file arrived.
 *
 * `upload` — the file came in as it was: the scanner's own PDF, a photo, a picture of a page.
 * `scan`   — pages were photographed in Phoenix, polished, and assembled into one PDF by us.
 * `issued` — Phoenix generated this paper for this employee and filed it when the owner confirmed
 *            the signature. It is the document that was put in front of them, never a photograph
 *            of the ink on it.
 *
 * The distinction is shown to HR, because a `scan` has been through contrast and tone correction,
 * and anyone judging whether a stamp looks right should know that before they judge it. `issued`
 * matters for a sharper reason: these land in slots named "Signed employment contract", and
 * somebody opening one is entitled to know they are looking at the unsigned original rather than
 * at evidence that anybody signed anything.
 *
 * ONLY THE SERVER MAY WRITE `issued`. `app/api/hiring-documents/files/route.ts` deliberately
 * narrows whatever a client sends to `scan` or `upload`, so a hand-uploaded file can never claim
 * to have been issued by the system.
 */
export const HIRING_DOCUMENT_FILE_SOURCES = ["upload", "scan", "issued"] as const;

export type HiringDocumentFileSource = (typeof HIRING_DOCUMENT_FILE_SOURCES)[number];

/**
 * The stored `source` as the union, defaulting to `upload` for anything unrecognised.
 *
 * `upload` is the right default because it claims the least: it says only "this file arrived", with
 * no assertion about polishing or about who produced it.
 *
 * READS THE LIST, so a fourth source can never be silently narrowed away. The shape to avoid is
 * `value === "scan" ? "scan" : "upload"`, which reads every issued paper back as "Uploaded as-is" —
 * correct in the database and wrong on every screen. It lives here rather than in the service
 * because the decision is about a string and nothing else, and this file is the one both the server
 * and the client component already import.
 */
export function readHiringDocumentFileSource(value: string | null): HiringDocumentFileSource {
  const known = HIRING_DOCUMENT_FILE_SOURCES.find((source) => source === value);
  return known ?? "upload";
}

export type HiringDocumentFile = {
  contentType: string;
  documentId: string;
  employeeHrId: string;
  fileName: string;
  id: string;
  /** Only known for PDFs this system assembled; an uploaded PDF is never parsed to count pages. */
  pageCount: number | null;
  sizeBytes: number;
  source: HiringDocumentFileSource;
  uploadedAt: string;
  uploadedByHrId: string | null;
  uploadedByName: string | null;
};

export type AttachHiringDocumentFilesInput = {
  documentId: string;
  employeeHrId: string;
  /**
   * `upload` stores each page as it arrived, one row per file. `scan` polishes every page and
   * assembles them into a single PDF — one row for the whole document.
   */
  mode: HiringDocumentFileSource;
  /**
   * `pageCount` is only for a caller that already knows it — the filing path counts the pages of
   * the PDF it just built. A plain upload leaves it null, because counting the pages of an
   * arbitrary uploaded file is a different job with different failure modes, and a wrong count is
   * worse than none: the list prints it as fact.
   */
  pages: Array<{ bytes: Buffer; contentType: string; fileName: string; pageCount?: number | null }>;
  /**
   * Tick the checklist cell as submitted (the default). `false` files the evidence and leaves the
   * cell as it was — for a file that is not yet the whole document, like the joining form's one
   * photo against "(6) personal photos", where HR still collects the six prints (owner, 2026-10-08).
   */
  markSubmitted?: boolean;
  scanMode?: HiringDocumentScanMode;
  uploadedByHrId: string | null;
};

export type HiringDocumentGroup = "required" | "onboarding" | "offboarding";

export type HiringDocumentDefinition = {
  createdAt: string;
  description: string | null;
  displayOrder: number;
  id: string;
  /**
   * True for a document that only applies once somebody LEAVES — the two clearances, the
   * resignation request, the mutual termination agreement and social insurance Form 6.
   *
   * Owner ruling, 2026-09-29, and it is not cosmetic: before it a resignation request was counted
   * as outstanding against every active employee, which on Pedia alone was 160 slots of paperwork
   * nobody should ever chase — and while they are counted, no active employee can reach 100%
   * however much they hand in. `hiringDocumentApplies` is the one place that decides.
   *
   * FORM 6 IS AN EXIT DOCUMENT AND FORM 1 IS NOT: نموذج ١ tells the insurance authority somebody
   * has started, نموذج ٦ tells it somebody has stopped. "Social insurance form" is Form 1 and
   * stays an onboarding document.
   */
  isExitDocument: boolean;
  /**
   * Which block of the personnel file this paper belongs to.
   *
   * HR reads the checklist as three lists, not one: what the candidate BRINGS ("required"), what is
   * signed ON JOINING ("onboarding") and what is signed ON LEAVING ("offboarding"). They are
   * collected by different people at different times, and the Employee Master bands them
   * separately. Distinct from `isExitDocument`, which decides whether a paper is CHASED against an
   * active employee at all — every offboarding document is an exit document, but the grouping is
   * about where a paper is filed, not about who is chased for it.
   *
   * Defaults to "required" for a row written before the column existed.
   */
  documentGroup: HiringDocumentGroup;
  /**
   * What the Employee Master sheet prints as this document's column header, when it differs from
   * the computed `<name> (document)`. Null for almost every document; see `documentColumnHeader`,
   * which refuses an override that drops the "(document)" suffix.
   */
  sheetHeader: string | null;
  name: string;
};

export type HiringDocumentEntry = {
  documentId: string;
  dueDate: string | null;
  /**
   * How many scans or uploads are on file for this employee x document pair.
   *
   * This is what turns a tick-box into evidence: a cell can read "submitted" with zero files, and
   * that combination is exactly the one worth looking at — somebody ticked it from memory. Always
   * 0 rather than null when the file table is not yet deployed, so the grid never renders a gap it
   * cannot explain.
   */
  fileCount: number;
  notes: string | null;
  status: HiringDocumentStatus;
  updatedAt: string | null;
};

export type HiringDocumentEmployeeRow = {
  employmentStatus: string | null;
  fullName: string;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  notes: string | null;
  documents: Record<string, HiringDocumentEntry>;
};

export type HiringDocumentsDashboardData = {
  documents: HiringDocumentDefinition[];
  employees: HiringDocumentEmployeeRow[];
  summary: {
    completeDocuments: number;
    dueDocuments: number;
    employees: number;
    missingDocuments: number;
    pendingDocuments: number;
    /** Submitted documents with a scan or upload actually filed. Never the same as the tick. */
    scannedDocuments: number;
    submittedDocuments: number;
    totalDocumentSlots: number;
  };
};

export type UpdateHiringDocumentStatusInput = {
  documentId: string;
  dueDate?: string | null;
  employeeHrId: string;
  notes?: string | null;
  status: HiringDocumentStatus;
};

export type UpdateHiringDocumentNotesInput = {
  employeeHrId: string;
  notes: string | null;
};

/**
 * One person arriving: an ACCEPTED offer whose joining day is today or later, with what HR agreed
 * with them. No money: the letter's figures never reach this screen.
 */
/**
 * What else has to be in place by their first day, read beside the papers. NULL MEANS THE READ FAILED,
 * which the screen says in words: it must never read as "no account" or "no device".
 */
export type HiringJoinerDayOne = {
  /** Handed-over devices still out to them. No device is not a gap: not everyone is issued one. */
  devicesOutstanding: number | null;
  hasActiveLogin: boolean | null;
  /** "none" means no mailbox task was ever opened for them. */
  mailbox: "connected" | "none" | "not_needed" | "pending" | null;
  /** Whether each is on their record. Only ever yes or no: the numbers themselves stay on the server. */
  details: HiringJoinerDetails | null;
};

export type HiringJoinerDetails = {
  bankAccount: boolean;
  insuranceNumber: boolean;
  nationalId: boolean;
};

export type HiringJoiner = {
  /** The day HR agreed they attend, `YYYY-MM-DD`. Null until it is agreed. */
  attendanceDate: string | null;
  /** The time HR agreed they attend, `HH:MM` on the 24-hour clock, Cairo local. */
  attendanceTime: string | null;
  dayOne: HiringJoinerDayOne;
  email: string | null;
  /** Null until the joining form or Add Employee creates the record; papers are filed against it. */
  employeeHrId: string | null;
  mobile: string | null;
  name: string;
  notes: string | null;
  offerId: string;
  /** HR confirmed with the joiner which papers to bring. */
  papersConfirmed: boolean;
  /** The joining day, `YYYY-MM-DD`: the employee record's hire date once there is one, else the letter's. */
  startKey: string;
  territory: string | null;
  title: string | null;
  /** When the last confirmation was saved. Null means nobody has recorded contact yet. */
  updatedAt: string | null;
  updatedByName: string | null;
};

export type HiringJoinersData = {
  joiners: HiringJoiner[];
  todayKey: string;
};

/** What the mailbox register says for one leaver. "none" means it holds no task for them. */
export type HiringLeaverMailbox = "in_progress" | "none" | "not_needed" | "pending" | "revoked";

/**
 * One person who has left. NULL MEANS THE READ FAILED, which the screen says in words: it must never
 * read as "no device" or "no task". Count and status only, and no money.
 */
export type HiringLeaver = HiringDocumentEmployeeRow & {
  devicesOutstanding: number | null;
  /** What HR Forms recorded, null when nobody has, or when that read failed. Greys the other labour paper. */
  exitRoute: ExitRoute | null;
  /** `YYYY-MM-DD`. Null when the record holds no last working day. */
  lastWorkingDate: string | null;
  mailbox: HiringLeaverMailbox | null;
};

export type HiringLeaversData = {
  leavers: HiringLeaver[];
  todayKey: string;
};

export type UpdateHiringJoinerInput = {
  attendanceDate: string | null;
  attendanceTime: string | null;
  notes: string | null;
  offerId: string;
  papersConfirmed: boolean;
};

export type CreateHiringDocumentDefinitionInput = {
  description?: string | null;
  name: string;
};
