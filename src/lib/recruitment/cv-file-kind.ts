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
