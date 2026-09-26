// Recruitment / ATS — where one WhatsApp application lives, and what its saved file is called.
//
// PURE, with nothing imported, because both halves need it: the two buttons on the list and the print
// page are client components, and the route that sends the file is server code. The server module that
// draws the PDF (whatsapp-application-pdf.ts) pulls in Chromium, sharp and mammoth, none of which may
// reach a browser bundle, so these small facts live here instead of there.

/** The header the route puts the saved file's name in, percent-encoded because a name may be Arabic. */
export const APPLICATION_FILE_NAME_HEADER = "X-Application-File-Name";
/** How many CV pages come first in the file. Zero when the CV could not be included. */
export const APPLICATION_CV_PAGES_HEADER = "X-Application-Cv-Pages";
export const APPLICATION_SHEET_PAGES_HEADER = "X-Application-Sheet-Pages";

/** The endpoint that builds the application PDF for one WhatsApp conversation. */
export function whatsAppApplicationApiPath(sessionId: string): string {
  return `/api/recruitment/whatsapp-applicants/${encodeURIComponent(sessionId)}/application`;
}

/**
 * The same file as text, for the in-page renderer. A response that looks like a downloadable PDF is
 * what a download-manager extension cancels, so the browser is asked for base64 instead. The reason is
 * written out in src/lib/recruitment/file-response.ts.
 */
export function whatsAppApplicationTextPath(sessionId: string): string {
  return `${whatsAppApplicationApiPath(sessionId)}?format=base64`;
}

/** The page that draws the application for the printer. Outside both shells, so nothing else is on the paper. */
export function whatsAppApplicationPrintPath(sessionId: string): string {
  return `/print/whatsapp-application/${encodeURIComponent(sessionId)}`;
}

// ── The candidate-keyed forms, for the screening page's "Download application" on ANY CV ─────────────
//
// The owner, 2026-09-26: the button reaches every CV on the screening page, not only the WhatsApp
// applicants. The id in these is a CANDIDATE, and the route behind them builds the same application PDF —
// the CV plus the Job application form from the record, with the WhatsApp Q&A when the person had a
// conversation. The WhatsApp-conversation forms above stay exactly as they are for WhatsApp Applicants.

/** The endpoint that builds the application PDF for one candidate. */
export function candidateApplicationApiPath(candidateId: string): string {
  return `/api/recruitment/candidates/${encodeURIComponent(candidateId)}/application`;
}

/** The same, as text for the in-page renderer — see `whatsAppApplicationTextPath` for why base64. */
export function candidateApplicationTextPath(candidateId: string): string {
  return `${candidateApplicationApiPath(candidateId)}?format=base64`;
}

/** The print page for one candidate's application. Outside both shells, like the WhatsApp one. */
export function candidateApplicationPrintPath(candidateId: string): string {
  return `/print/candidate-application/${encodeURIComponent(candidateId)}`;
}

/** The cleaned, file-system-safe form of an applicant's name, capped at 80 characters. */
function safeApplicantName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

/**
 * The saved file's name, from the applicant's own name: "Sara Ahmed - WhatsApp application.pdf".
 * Anything a file system refuses is dropped, and an all-Arabic name stays Arabic. The route sends it
 * as a UTF-8 `filename*`, since a header value cannot carry those letters as they are.
 */
export function applicationFileName(name: string): string {
  return `${safeApplicantName(name) || "Applicant"} - WhatsApp application.pdf`;
}

/**
 * The candidate-application file's name: "Sara Ahmed - application.pdf". Plain "application", because a
 * candidate reached from the screening page may never have applied on WhatsApp; the WhatsApp form keeps
 * its own name above.
 */
export function candidateApplicationFileName(name: string): string {
  return `${safeApplicantName(name) || "Applicant"} - application.pdf`;
}

/** `Content-Disposition` for a download whose name may hold any letters: an ASCII fallback and the real name. */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = /[a-z0-9]/i.test(ascii) ? ascii : "WhatsApp application.pdf";
  // encodeURIComponent leaves ' ( ) * alone, and RFC 5987 does not allow them unescaped.
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
