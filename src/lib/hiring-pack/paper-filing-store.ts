// Filing a confirmed paper into the employee's hiring documents.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SIGNATURE IS ALREADY RECORDED BY THE TIME ANY OF THIS RUNS, and that ordering is the whole
// design. `POST /sign` writes the date first and only then files, so filing can fail — Chromium
// unavailable, a slot retired, an artwork file unreadable — without costing the owner the thing he
// actually did, which was confirm that a paper was signed. Every failure below is REPORTED, in
// words, with what to do about it. None of them undoes the signature.
//
// The one thing that is never done is filing something unverified. A blank form, a paper filed into
// a slot nobody chose, a second copy of a paper already filed — each is worse than not filing,
// because a wrong document in the record looks exactly like a right one.

import { PDFDocument } from "pdf-lib";

import { attachHiringDocumentFiles } from "@/lib/hiring-documents/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "@/lib/auth/permissions";
import type { PrintableDocument } from "@/lib/hiring-pack/document-registry";
import { documentCarriesHousePageNumbers } from "@/lib/hiring-pack/house-identity";
import {
  buildIssuedFileName,
  isFilingSchemaMissing,
  resolveBuiltInFilingSlot,
  resolveCustomFilingSlot,
  SCHEMA_NOT_READY,
  type FilingSlotRow,
} from "@/lib/hiring-pack/paper-filing";
import {
  ChromiumUnavailableError,
  PaperArtworkMissingError,
  renderHiringPaperPdf,
} from "@/lib/hiring-pack/paper-pdf";
import { renderHiringPaper } from "@/lib/hiring-pack/render-paper";
import { isBuiltInDocument } from "@/lib/hiring-pack/types";

/** What happened to the copy, said the way it will be said on screen. */
export type FilingOutcome =
  | { filed: true; fileName: string; slotName: string }
  | { filed: false; why: string };

/**
 * Every checklist slot, with the paper each one is pinned to.
 *
 * READS INACTIVE ONES TOO, deliberately. A retired slot has to come back so the decision can say
 * "the slot is retired" instead of "no slot names this paper" — two different problems with two
 * different fixes, and the second sends somebody looking for something that is already there.
 *
 * Null means the columns are not there yet, which is a different answer from an empty list: an
 * empty list would be reported as "no slot names this paper", sending somebody to configure a
 * screen that cannot help them.
 */
async function loadFilingSlots(): Promise<FilingSlotRow[] | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("hiring_document_definitions")
    .select("id,name,is_active,hiring_pack_document");
  if (error) {
    if (isFilingSchemaMissing(error)) return null;
    throw new Error(error.message);
  }
  return (data ?? []) as FilingSlotRow[];
}

/**
 * Whether this paper has already been filed for this employee on this date.
 *
 * WHY THE FILE NAME AND NOT A FLAG. Confirming a signature twice is an ordinary thing to do — the
 * date was mistyped, the screen was reloaded, two people were looking at it — and the second
 * confirm should not add a second identical PDF to the employee's record. The name carries the
 * paper, the employee and the signed date, which is exactly the identity that would make a second
 * copy a duplicate rather than a new document. A confirm with a CORRECTED date therefore files
 * again, and should: it is a different claim about a different piece of paper.
 */
async function alreadyFiled(input: {
  documentId: string;
  employeeHrId: string;
  fileName: string;
}): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("hiring_document_files")
    .select("id", { count: "exact", head: true })
    .eq("document_id", input.documentId)
    .eq("employee_hr_id", input.employeeHrId)
    .eq("file_name", input.fileName)
    .eq("source", "issued");
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

/**
 * File the confirmed copy of one paper into the employee's hiring documents.
 *
 * ONE COPY, ALWAYS, whatever the paper prints. Four contracts and three Form 1s exist because four
 * and three pieces of paper get signed; the record wants the document, not the stack. Passing
 * `copies: "1"` also keeps the rendered HTML small enough that inlining the artwork is cheap.
 *
 * NEVER THROWS FOR AN ORDINARY REFUSAL. The caller has already recorded the signature and is going
 * to open the print tab regardless; what it needs back is a sentence to show the owner, not an
 * exception to translate. Genuine faults — a database error, an unreadable employee — do throw,
 * because those are not states anybody can act on from a banner.
 */
export async function fileSignedPaper(input: {
  access: AccessContext;
  document: PrintableDocument;
  hrId: string;
  signedDate: string;
  uploadedByHrId: string | null;
  version?: string | null;
}): Promise<FilingOutcome> {
  const paper = await renderHiringPaper({
    access: input.access,
    copies: "1",
    document: input.document,
    hrId: input.hrId,
    version: input.version ?? null,
  });
  if (!paper.ok) return { filed: false, why: paper.message };

  const slots = await loadFilingSlots();
  if (!slots) return { filed: false, why: SCHEMA_NOT_READY };
  // The two kinds resolve by two different mechanisms pointing in two directions, and neither can
  // reach the other's answer — see the note in `paper-filing.ts`.
  const decision = isBuiltInDocument(input.document)
    ? resolveBuiltInFilingSlot(input.document, slots)
    : resolveCustomFilingSlot(paper.template?.filesUnderDocumentId ?? null, slots);
  if (!decision.filed) return { filed: false, why: decision.why };

  const fileName = buildIssuedFileName({
    hrId: input.hrId,
    label: paper.template ? paper.template.name : documentLabelFor(input.document),
    signedDate: input.signedDate,
  });

  if (await alreadyFiled({ documentId: decision.definitionId, employeeHrId: input.hrId, fileName })) {
    return {
      filed: false,
      why: `This copy is already filed under "${decision.slotName}". Nothing was filed a second time.`,
    };
  }

  let pdf: Uint8Array;
  try {
    // Numbered for the papers Phoenix authors, never for the Authority's own forms — the policy
    // lives beside the identity it belongs to, so the filed copy and the downloaded one can never
    // disagree about which documents may carry a footer.
    pdf = await renderHiringPaperPdf(paper.html, {
      pageNumbers: documentCarriesHousePageNumbers(input.document),
    });
  } catch (error) {
    // Both of these are worth saying in full rather than collapsing to "could not file". One is an
    // environment that cannot render at all; the other is a specific file that could not be read,
    // and naming it is the difference between a fixable report and a mystery.
    if (error instanceof PaperArtworkMissingError) return { filed: false, why: error.message };
    if (error instanceof ChromiumUnavailableError) {
      return {
        filed: false,
        why: "The signature was recorded, but this runtime cannot render a PDF, so no copy was filed.",
      };
    }
    throw error;
  }

  // READ BACK WHAT WAS JUST BUILT, for two reasons at once. The page count is shown in the file
  // list, and "3 pages" beside a filed contract is how somebody sees at a glance that the whole
  // document is there. And parsing it is a last check on the bytes: if Chromium ever produced
  // something malformed, this throws here rather than storing a file that opens as nothing.
  const pageCount = (await PDFDocument.load(pdf)).getPageCount();

  let file;
  try {
    // The write itself is the last thing that can meet an unmigrated database: until 20260904233000
    // is applied, the `source` CHECK still refuses 'issued' and this is a 23514.
    [file] = await attachHiringDocumentFiles(input.access, {
      documentId: decision.definitionId,
      employeeHrId: input.hrId,
      mode: "issued",
      pages: [{ bytes: Buffer.from(pdf), contentType: "application/pdf", fileName, pageCount }],
      uploadedByHrId: input.uploadedByHrId,
    });
  } catch (error) {
    if (isFilingSchemaMissing(error)) return { filed: false, why: SCHEMA_NOT_READY };
    throw error;
  }

  return { filed: true, fileName: file?.fileName ?? fileName, slotName: decision.slotName };
}

/**
 * The human name of a built-in paper, for the filed file's name.
 *
 * Deliberately short and English: this becomes a filename that people will see in a downloads
 * folder, sorted beside files from every other system they use.
 */
function documentLabelFor(document: string): string {
  switch (document) {
    case "contract":
      return "Employment contract";
    case "form1":
      return "Social insurance Form 1";
    case "form6":
      return "Social insurance Form 6";
    case "nda":
      return "Confidentiality undertaking";
    case "resignation":
      return "Resignation request";
    case "mutualTermination":
      return "Mutual termination agreement";
    case "clearanceEmployee":
      return "Employee clearance";
    case "clearanceCompany":
      return "Company clearance";
    default:
      return "Document";
  }
}
