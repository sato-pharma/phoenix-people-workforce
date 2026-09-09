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
