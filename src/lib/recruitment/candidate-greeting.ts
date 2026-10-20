// Recruitment — the name a message to a CANDIDATE opens with.
//
// PURE AND CLIENT-SAFE: no database, no clock. One place decides how a candidate is greeted, so
// every message that speaks to one says it the same way — the HR WhatsApp templates
// (`candidate_first_name`), the interview invitation, the "Ask again" WhatsApp template and the
// careers-form confirmation.
//
// "DR" BEFORE THE FIRST NAME, FOR EVERY CANDIDATE (owner, 2026-10-20: "add dr before any name when
// sending a candidate", and "Every candidate" when asked which ones). ONLY THE GREETING: the stored
// `full_name` is evidence and stays exactly as recorded, `candidate_name` still renders it whole,
// and an EMPLOYEE (a contract renewal, a salary increase) is greeted by the plain first name.

/**
 * The candidate's first name.
 *
 * Egyptian names are given-name-first, so the first token is the right one — the owner's own example
 * opens "Dear Aya". A single-token name returns itself rather than an empty string, which is the
 * difference between "Dear Aya" and "Dear ,".
 *
 * Honorifics are stripped because CV headers routinely carry them and "Dear Mr. Ahmed Nour" read as
 * a first name gives "Dear Mr.". It is also what keeps a CV's own "Dr." from becoming "Dr Dr.".
 */
const HONORIFICS = new Set(["mr", "mr.", "mrs", "mrs.", "ms", "ms.", "dr", "dr.", "eng", "eng.", "miss"]);

export function firstNameOf(fullName: string): string {
  const tokens = fullName
    .trim()
    .split(/\s+/u)
    .filter((token) => !HONORIFICS.has(token.toLowerCase()));
  return softenShoutedName(tokens[0] ?? fullName.trim());
}

/**
 * "SHAABAN" -> "Shaaban", for the greeting only.
 *
 * 18% of the candidate pool — 160 of 890, measured on production 2026-09-08 — carries an ALL-CAPS
 * first name, because that is how the CV said it or how the importer received it. Left alone, nearly
 * one applicant in five opens an interview invitation that begins "Dear SHAABAN", which reads as
 * shouting at somebody you are trying to hire. This is the one place a stored name is spoken TO a
 * person rather than displayed, so it is the one place the shape matters.
 *
 * ONLY THE GREETING. The stored `full_name` is untouched and `candidate_name` still renders exactly
 * as recorded — an identity field is evidence and must not be rewritten to look tidy. This softens a
 * copy of the first token on its way into one sentence.
 *
 * IT ONLY FIRES ON A SHOUT. A name already carrying a lower-case letter is left exactly as typed, so
 * "McDonald", "van der Berg" and "eSSam" survive — the failure a blanket title-caser produces is
 * mangling the names it was not aimed at, which is why this refuses to touch anything that is not
 * uniformly upper case. Arabic and other uncased scripts have no upper case to detect and fall
 * through unchanged.
 *
 * Internal separators keep their capital: "ABDEL-RAHMAN" -> "Abdel-Rahman", not "Abdel-rahman".
 */
export function softenShoutedName(token: string): string {
  if (!/[A-Z]/u.test(token) || /[a-z]/u.test(token)) return token;
  return token
    .toLowerCase()
    .replace(/(^|[-'’])([a-z])/gu, (_whole, sep: string, letter: string) => sep + letter.toUpperCase());
}

/** The title every candidate is greeted with (owner, 2026-10-20). */
export const CANDIDATE_TITLE = "Dr";

/**
 * "Nevin" -> "Dr Nevin". An empty name stays EMPTY, so a template still refuses to send without one
 * and a caller's own fallback ("Hello there") is never titled.
 */
export function titledFirstName(firstName: string): string {
  const name = firstName.trim();
  return name ? `${CANDIDATE_TITLE} ${name}` : "";
}

/** The name a message to a candidate opens with: "AYA Mohamed Hassan" -> "Dr Aya"; "" with no name. */
export function candidateGreetingName(fullName: string | null | undefined): string {
  return titledFirstName(firstNameOf(String(fullName ?? "")));
}
