// Recruitment / ATS — CV file-kind detection (pure, no dependencies). Kept in its own module
// (not cv-extraction.ts, which imports pdf-parse/mammoth) so client components — e.g. the CV
// preview modal, which needs to know whether to render an iframe or fetch extracted text —
// can use it without pulling server-only document-parsing packages into the browser bundle.

export type CvFileKind = "pdf" | "docx" | "image" | "unsupported";

export function detectCvFileKind(mimeType: string, fileName: string): CvFileKind {
  const normalizedMime = (mimeType || "").toLowerCase();
  const lowerName = (fileName || "").toLowerCase();
  if (normalizedMime.includes("pdf") || lowerName.endsWith(".pdf")) return "pdf";
  if (normalizedMime.includes("wordprocessingml") || normalizedMime.includes("msword") || lowerName.endsWith(".docx")) {
    return "docx";
  }
  // Scanned/photographed CVs — no local text extraction, read directly via OpenAI vision
  // (see cv-extraction.ts's "image" branch). This only catches a scan whose FILE TYPE says image;
  // the same photograph saved as a PDF answers "pdf" above and is caught later, by the text-layer
  // check in cv-text-layer.ts, once we have seen how little text the PDF actually holds.
  if (
    normalizedMime.startsWith("image/") ||
    lowerName.endsWith(".jpg") ||
    lowerName.endsWith(".jpeg") ||
    lowerName.endsWith(".png")
  ) {
    return "image";
  }
  return "unsupported";
}

// ---------------------------------------------------------------------------
// Byte-level Word format check.
//
// detectCvFileKind above answers "docx" for BOTH Word formats, and it has to: it sees only a
// MIME type and a file name, and in this corpus that label is wrong in both directions. Four
// stored CVs are labelled application/msword and really are the legacy Word 97-2003 binary;
// a fifth is labelled application/msword and is really a modern OOXML .docx (it extracts
// fine). So the label decides nothing — only the first bytes do.
//
// A modern .docx is a ZIP archive, magic "PK\x03\x04". The legacy .doc is an OLE2 compound
// file, magic D0 CF 11 E0 A1 B1 1A E1. mammoth reads only the former; word-extractor reads
// the latter. Kept here (pure, no imports) so the client-side preview can use the same test
// as the server-side extractor and the two cannot drift apart.
// ---------------------------------------------------------------------------

const OLE2_COMPOUND_FILE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

/** True when these bytes are a Word 97-2003 binary .doc (OLE2), which mammoth cannot read. */
export function isLegacyDocBytes(bytes: Uint8Array): boolean {
  if (bytes.length < OLE2_COMPOUND_FILE_SIGNATURE.length) return false;
  return OLE2_COMPOUND_FILE_SIGNATURE.every((byte, index) => bytes[index] === byte);
}
