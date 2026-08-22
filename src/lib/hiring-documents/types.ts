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
 *
 * The distinction is shown to HR, because a `scan` has been through contrast and tone correction,
 * and anyone judging whether a stamp looks right should know that before they judge it.
 */
export type HiringDocumentFileSource = "upload" | "scan";

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
  pages: Array<{ bytes: Buffer; contentType: string; fileName: string }>;
  scanMode?: HiringDocumentScanMode;
  uploadedByHrId: string | null;
};

export type HiringDocumentDefinition = {
  createdAt: string;
  description: string | null;
  displayOrder: number;
  id: string;
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

export type CreateHiringDocumentDefinitionInput = {
  description?: string | null;
  name: string;
};
