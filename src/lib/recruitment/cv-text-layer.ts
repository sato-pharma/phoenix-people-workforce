// Recruitment / ATS — is a PDF's text layer real, or is this a photograph wearing a .pdf?
//
// Why this exists: detectCvFileKind decides by MIME type and file extension alone, so a CV that
// was photographed or scanned and then saved as a PDF answers "pdf" and goes down the local
// text-extraction path — where there is no text to find. The vision path that CAN read it already
// existed, but only a file whose extension said .jpg/.png ever reached it.
//
// The real one that cost an applicant (careers inbox, 2026-08-11, `Zaher Halawa-1.pdf`,
// 493,190 bytes, subject "Zaher halawa cv District manager upper Egypt"): pdf-parse recovered
// exactly sixteen characters from it —
//
//     -- 1 of 1 --
//
// a page marker and nothing else. The merged classify+extract call was handed those sixteen
// characters, correctly answered is_cv:false, and the intake dropped a real District Manager
// applicant with no dead letter and no retry.
//
// Note the inversion that made it worse, and that the threshold below removes: a text layer of
// ZERO characters made extractRawTextFromFile throw, which cv-intake-service.ts catches and fails
// OPEN — so the candidate was created anyway. Sixteen characters of junk was not empty, so it took
// the confident-rejection path instead. A PDF with LESS in it was treated BETTER. The fix is to
// stop asking "is there any text" and start asking "is there enough text to be a CV".
//
// Pure and dependency-free for the same reason cv-file-kind.ts is: cv-extraction.ts pulls in
// pdf-parse, mammoth, the OpenAI client and the Supabase admin client, and none of that belongs
// in a decision this small.

import type { CvFileKind } from "@/lib/recruitment/cv-file-kind";

// Below this many letters/digits, a PDF is treated as a scan and sent to the model as a file
// rather than as text. A real CV's text layer runs to thousands; the observed failure carried 4.
// The gap between those two numbers is wide enough that the exact threshold does not matter much,
// so it is set where a false "this is a scan" is cheap (the model reads a text PDF from its
// rendering perfectly well, just for more tokens) and a false "this is text" is expensive (a
// silently discarded applicant).
export const MIN_PDF_TEXT_LAYER_CHARS = 200;

// A PDF larger than this is left on the text path. Base64 inflates by a third, and the intake cap
// (maxInboundCvBytes, 15 MB) is high enough to build a request the model would reject outright —
// at which point failing open to "candidate created, fields empty" beats failing the whole call.
export const MAX_PDF_VISION_BYTES = 12 * 1024 * 1024;

export type CvExtractionRoute = "text" | "vision_image" | "vision_pdf";

// Letters and digits only, Unicode-aware: page furniture ("-- 1 of 1 --", rule characters, form
// feeds) contributes almost nothing, while an Arabic CV — most of what arrives here — counts the
// same as a Latin one. A \w-based count would score Arabic as zero and send every Arabic text CV
// down the expensive path.
export function countReadableCharacters(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

export function chooseCvExtractionRoute(input: {
  byteLength: number;
  extractedText: string;
  fileKind: CvFileKind;
}): CvExtractionRoute {
  if (input.fileKind === "image") return "vision_image";
  if (
    input.fileKind === "pdf" &&
    input.byteLength <= MAX_PDF_VISION_BYTES &&
    countReadableCharacters(input.extractedText) < MIN_PDF_TEXT_LAYER_CHARS
  ) {
    return "vision_pdf";
  }
  // Everything else keeps the behaviour it had: DOCX and text PDFs go to the model as text, and an
  // unsupported kind never gets this far — extractRawTextFromFile has already thrown.
  return "text";
}
