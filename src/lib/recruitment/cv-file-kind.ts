// Recruitment / ATS — CV file-kind detection (pure, no dependencies). Kept in its own module
// (not cv-extraction.ts, which imports pdf-parse/mammoth) so client components — e.g. the CV
// preview modal, which needs to know whether to render an iframe or fetch extracted text —
// can use it without pulling server-only document-parsing packages into the browser bundle.

export function detectCvFileKind(mimeType: string, fileName: string): "pdf" | "docx" | "unsupported" {
  const normalizedMime = (mimeType || "").toLowerCase();
  const lowerName = (fileName || "").toLowerCase();
  if (normalizedMime.includes("pdf") || lowerName.endsWith(".pdf")) return "pdf";
  if (normalizedMime.includes("wordprocessingml") || normalizedMime.includes("msword") || lowerName.endsWith(".docx")) {
    return "docx";
  }
  return "unsupported";
}
