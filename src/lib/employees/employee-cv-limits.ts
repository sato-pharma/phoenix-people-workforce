/**
 * What a CV is allowed to be — the half of ./employee-cv.ts that is safe in a browser bundle.
 *
 * SPLIT FROM employee-cv.ts DELIBERATELY, and this is not tidiness. That module imports
 * `node:crypto` and the service-role Supabase client; a client component importing a constant from
 * it would drag both into the browser bundle, and the failure is a webpack build error rather than
 * anything the person editing the component would predict. (The same trap is written up on
 * employee-photo.ts, which is guarded by the same node:crypto import.)
 *
 * These values are also the ONLY copy: the migration's bucket allow-list, the server's validation
 * and the sentence a person reads on the form all resolve to what is here, so the rule enforced and
 * the rule stated cannot drift.
 */

export const MAX_EMPLOYEE_CV_BYTES = 15 * 1024 * 1024;

/**
 * Content type -> the extension a download of it is named with.
 *
 * PDF and the two Word formats because that is what a CV arrives as; the two image types because a
 * CV from an older candidate is sometimes a photograph of a printed page. Deliberately short: this
 * is one kind of document, not a general file store.
 */
export const ALLOWED_CV_TYPES: ReadonlyMap<string, string> = new Map([
  ["application/pdf", "pdf"],
  ["application/msword", "doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

/** The `accept` attribute for a file input, and the extensions the client-side guard matches. */
export const EMPLOYEE_CV_ACCEPT_ATTRIBUTE = ".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp";

/** How the allowed set is said in a sentence to a person. */
export const EMPLOYEE_CV_TYPES_SENTENCE = "a PDF, Word document, JPG, PNG or WebP";

/** How the CV got onto the record. See the migration for why the distinction is kept. */
export type EmployeeCvSource = "upload" | "recruitment";

export function isAllowedCvContentType(contentType: string | null | undefined): boolean {
  return ALLOWED_CV_TYPES.has(String(contentType ?? "").toLowerCase().trim());
}

export function extensionForCvContentType(contentType: string): string {
  return ALLOWED_CV_TYPES.get(contentType.toLowerCase().trim()) ?? "pdf";
}

/**
 * The same-origin route an employee's CV downloads from.
 *
 * Here rather than in employee-cv.ts because a client component needs it too, and a second copy of
 * a URL is how a route rename half-lands.
 */
export function employeeCvHref(hrId: string | null | undefined): string {
  return `/api/employees/${encodeURIComponent(String(hrId ?? "").trim())}/cv`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// What a viewer is told about a CV
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The four answers a `?meta=1` probe of the CV route can produce, for a surface that offers the
 * download — the organogram seat popup today.
 *
 * FOUR, NOT A BOOLEAN, and that is the whole point of this type. A boolean collapses "there is no
 * file on this person's record" into "you may not read CVs" into "the answer has not come back",
 * and those are three different sentences to a person: one is about the record, one is about him,
 * and one is about the network. Collapsed, the popup showed nothing in all three cases — which on
 * production means 189 of 198 seats looked exactly like a seat where the feature does not exist.
 */
export type CvNoticeState = "probing" | "ready" | "empty" | "forbidden";

/**
 * The greyed notice on a seat whose record holds no CV. The owner's own wording, 2026-09-29, when
 * he was shown that a silent seat reads as a missing feature: "show a greyed No CV on file on seats
 * with no CV". Asserted verbatim by tests/organogram-seat-cv-notice.test.ts — a decision, not a
 * label to reword.
 */
export const CV_EMPTY_NOTICE = "No CV on file";

/**
 * Turn one `?meta=1` response into what the viewer is shown.
 *
 * THE ONE RULE THAT MATTERS: only a 200 may produce "empty". `empty` puts a claim about the
 * employee's record on screen ("there is no CV on file for this person"), and a 500, a dropped
 * connection or an aborted fetch is not evidence for that claim — it is the absence of evidence.
 * Those stay "probing", which shows nothing, exactly as the popup behaved before the notice
 * existed. A 401/403 is the CV gate refusing this viewer, so it is "forbidden" and also silent:
 * he is not missing a file, and a notice about a door that is shut to him either way is noise.
 */
export function resolveCvNoticeState(probe: {
  ok: boolean;
  status: number;
  hasCv: boolean;
}): CvNoticeState {
  if (!probe.ok) return probe.status === 401 || probe.status === 403 ? "forbidden" : "probing";
  return probe.hasCv ? "ready" : "empty";
}
