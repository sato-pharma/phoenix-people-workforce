import { systemLegalEntity } from "@/config/system-settings";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";

/**
 * Who signs a CEO email, and where that name is allowed to come from.
 *
 * 🔴 THE SIGNATURE IS RESOLVED ON THE SERVER AND NEVER POSTED BY THE BROWSER. That is the whole
 * reason this file exists rather than a `signature` field on the draft. The Sato composer has a
 * free-typed "Signed" field, which is correct there — an HR announcement is signed by whoever wrote
 * it. Here the letterhead says "Office of the Chief Executive" and prints a name under a signature
 * rule: if the browser could choose that name, the Super Admin seat (which may also open this
 * screen, see ./access) could mail a distribution list signed as somebody who never saw the email.
 * So the name comes out of the live employee directory, by job title, on every render.
 *
 * The CLOSING LINE is the sender's — "Sincerely", "With appreciation" — and that one does travel on
 * the draft, because it carries no identity.
 */

/** The seat, as the directory spells it. The letter prints CEO_TITLE_EN instead — see below. */
const CEO_JOB_TITLE = "CEO";

/**
 * What the letter prints under the name.
 *
 * The directory records the seat as "CEO" because that is what every roster, org chart and payroll
 * row calls it. A letter does not abbreviate the signatory's office, so the full title is a constant
 * here rather than the directory string — this is the one place in the system where the two differ
 * on purpose.
 */
export const CEO_TITLE_EN = "Chief Executive Officer";

/** The same office in Arabic, for the bilingual foot. A TITLE, never a transliterated name. */
export const CEO_TITLE_AR = "الرئيس التنفيذي";

/** The masthead's label line: what this channel is. */
export const CEO_DOCUMENT_KICKER = "Office of the Chief Executive";

/**
 * The fallback name, used only when the directory cannot be read at all.
 *
 * Read from production on 2026-10-06: HR id `AA`, job title `CEO`, work email
 * `anwar.gaweesh@satopharma.com`, active. It is a fallback and not the source: a change of chief
 * executive is a directory change, and this constant must never be what the letter actually prints
 * when the directory is answering.
 */
const CEO_FALLBACK_NAME = "Anwar Gaweesh";

export type CeoSignature = {
  /** True when the directory answered. False means the letter is printing the fallback name. */
  fromDirectory: boolean;
  name: string;
  titleAr: string;
  titleEn: string;
  companyEn: string;
  companyAr: string;
};

function signatureFor(name: string, fromDirectory: boolean): CeoSignature {
  return {
    companyAr: systemLegalEntity.legalNameAr,
    companyEn: systemLegalEntity.legalNameEn,
    fromDirectory,
    name,
    titleAr: CEO_TITLE_AR,
    titleEn: CEO_TITLE_EN,
  };
}

/** The signature the letterhead prints, from the live directory. Pure, so it can be tested. */
export function pickCeoSignature(
  employees: ReadonlyArray<{ displayName?: string | null; fullName?: string | null; jobTitle?: string | null }>,
): CeoSignature {
  const seat = employees.find(
    (employee) => String(employee.jobTitle ?? "").trim().toLowerCase() === CEO_JOB_TITLE.toLowerCase(),
  );
  const name = String(seat?.displayName || seat?.fullName || "").trim();
  // A seat with no name on it is the same state as no seat: the letter must still be signable, and
  // a blank line under a signature rule reads as a rendering fault rather than a missing record.
  return name ? signatureFor(name, true) : signatureFor(CEO_FALLBACK_NAME, false);
}

/**
 * Reads the directory and returns the signature. Never throws: a letter that cannot be signed
 * because a directory read failed is worse than one signed from the fallback and reported.
 */
export async function resolveCeoSignature(): Promise<CeoSignature> {
  try {
    const directory = await getEmployeeDirectory();
    return pickCeoSignature(directory.employees);
  } catch {
    return signatureFor(CEO_FALLBACK_NAME, false);
  }
}

/** The default closing line, used when the sender clears the field. An executive letter has one. */
export const CEO_DEFAULT_CLOSING = "Sincerely";

/** A closing line is a short phrase, not a paragraph, and never markup. */
export const CEO_MAX_CLOSING_CHARS = 60;

export function normalizeCeoClosing(value: string): string {
  const cleaned = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,،]+$/, "")
    .trim();
  if (!cleaned) return CEO_DEFAULT_CLOSING;
  return cleaned.slice(0, CEO_MAX_CLOSING_CHARS).trim();
}
