// Recruitment — what the CV viewer tells the error monitor when a CV fails to open.
//
// On 2026-09-14 managers across the field got "Promise.withResolvers is not a function" on EVERY
// PDF CV (fixed in #3833 by serving pdf.js's legacy build), and production `app_error_events` held
// ZERO rows for it. The viewer caught the failure and showed it in the modal — and that catch was
// the end of it: a caught error never reaches the window.onerror/unhandledrejection net in
// global-error-reporter.tsx, so the one screen failing for everyone was the one screen silent.
//
// Pure, no browser APIs, so the whole decision — report or not, and what the row carries — is
// testable without a DOM (tests/cv-preview-failure-report.test.ts).
//
// A CV IS PERSONAL DATA. The row carries the CV KIND, the stage that failed and the HTTP status,
// never the file name and never who the candidate is. The user agent is not added here because the
// ingest route already stores the request's own User-Agent header in `app_error_events.user_agent`
// (app/api/errors/client/route.ts) — a second copy in the stack text would be the same string twice.

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import type { ReportClientErrorInput } from "@/lib/error-monitor/report-client-error";
import { isUuid } from "@/lib/http/uuid";
import type { CvFileKind } from "@/lib/recruitment/cv-file-kind";

/**
 * A DESIGNED answer shown in place of the document, not a failure: a photographed CV that cannot be
 * redacted for a manager, or a legacy .doc the browser cannot render. Thrown through the same catch
 * so the reader sees it in the same place, but never reported — it fires on every such CV by design,
 * and an error monitor full of decisions would bury the next real failure the way silence buried
 * this one.
 */
export class CvPreviewNotice extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CvPreviewNotice";
  }
}

/**
 * Where in the load the failure happened. Narrows a row without needing the stack.
 *
 * "text-layer" is the one stage that does NOT fail the preview: the PDF page is already on screen
 * and only its selectable text is lost, so it is reported and the reader keeps the document.
 */
export type CvPreviewStage = "fetch" | "decode" | "render" | "text-layer";

export type CvPreviewFailureInput = {
  caught: unknown;
  kind: CvFileKind;
  stage: CvPreviewStage;
  /** The byte route's HTTP status, when the fetch got that far. */
  httpStatus?: number | null;
  /** The page the viewer sits on. Identifiers in it are stripped before it is reported. */
  route?: string | null;
  /**
   * Taken ONLY to scrub it: a renderer that ever echoes the document's name into its message must
   * not carry that name into the monitor. Never itself written anywhere.
   */
  fileName?: string | null;
};

const FILE_NAME_PLACEHOLDER = "[cv file]";
const ID_PLACEHOLDER = "[id]";

// A whole path segment that is a uuid (the shared isUuid — tests/malformed-uuid-id-guards.test.ts
// refuses a private copy of the regex) or a run of 6+ digits (an HR id, a phone number, a numeric
// record id). The route names the SCREEN; which candidate was on it is exactly what must not travel.
function isIdentifierSegment(segment: string): boolean {
  return isUuid(segment) || /^\d{6,}$/.test(segment);
}

function stripIdentifiersFromRoute(route: string | null | undefined): string | null {
  if (!route) return null;
  // Path only: a query string on this screen can name a candidate or a file, and none of it is
  // needed to find the failing screen.
  const path = route.split(/[?#]/, 1)[0] ?? "";
  return path
    .split("/")
    .map((segment) => (isIdentifierSegment(segment) ? ID_PLACEHOLDER : segment))
    .join("/");
}

function scrubFileName(text: string, fileName: string | null | undefined): string {
  const name = (fileName ?? "").trim();
  // A one- or two-character name would scrub ordinary letters out of the message.
  if (name.length < 3) return text;
  return text.split(name).join(FILE_NAME_PLACEHOLDER);
}

/** True when this caught value is a real failure the monitor should hear about. */
export function shouldReportCvPreviewFailure(caught: unknown): boolean {
  return !(caught instanceof CvPreviewNotice);
}

/**
 * The report for one failed CV load, ready for reportClientError — or null for a designed notice.
 *
 * The message is the thrown one, verbatim apart from the file-name scrub: it is what groups every
 * manager's failure into one row family ("Promise.withResolvers is not a function"), so it is not
 * rewritten into a generic sentence.
 */
export function buildCvPreviewFailureReport(input: CvPreviewFailureInput): ReportClientErrorInput | null {
  if (!shouldReportCvPreviewFailure(input.caught)) return null;

  const message = scrubFileName(describeThrown(input.caught), input.fileName);
  const error = new Error(message);
  if (input.caught instanceof Error) {
    error.name = input.caught.name;
    error.stack = input.caught.stack ? scrubFileName(input.caught.stack, input.fileName) : undefined;
  } else {
    // A thrown non-Error has no stack of its own; the one `new Error` just minted points at this
    // helper, which would send every such row to the wrong file.
    error.stack = undefined;
  }

  const context = [`feature=cv-preview`, `cvKind=${input.kind}`, `stage=${input.stage}`];
  if (typeof input.httpStatus === "number" && Number.isFinite(input.httpStatus)) {
    context.push(`httpStatus=${input.httpStatus}`);
  }

  return {
    context: context.join(" "),
    error,
    route: stripIdentifiersFromRoute(input.route),
  };
}
