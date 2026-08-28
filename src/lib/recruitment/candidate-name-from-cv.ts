// Recruitment / ATS — which string is allowed to become a candidate's NAME.
//
// Every field this module's neighbours write honours the extraction's own `confidence`:
// cv-auto-apply.ts refuses to write an unsure value unattended, contact-review.ts only ever
// proposes one for a human to accept. Candidate CREATION did not. `ats_candidates.full_name` is
// NOT NULL and is written exactly once, at intake, from whatever the model put in the name slot —
// so the one write with no second chance was also the one write with no gate.
//
// What that let through, live in production on 2026-08-24 (candidate 097778c9-…):
//
//   full_name          = "Suez Canal University Engineering Department"
//   extracted fullName = { value: "Suez Canal University Engineering Department", confidence: "low" }
//   applied_fields     = null            <- the confidence gate DID hold for every later write
//   cv file            = "Karim _Nabil _CV (2).pdf"
//   email              = karimnabil3@example.org
//
// (The applicant's real name, filename and address stood here until 2026-08-28. The candidate id
// is kept so the incident stays traceable; the identity is not, and must not come back.)
//
// The model was unsure and said so, and it had handed back the letterhead rather than the author —
// a CV names the university the applicant attended, and a header-heavy first page gives a reader
// with no world knowledge two equally plausible "names" to choose between.
//
// The fallback is the CV's own FILE NAME, deliberately in preference to the sender. For a bulk
// forward the sender is the FORWARDER, which is the exact error fixed on 2026-08-15 — "Sherif
// Adel" forwarding his cousin's CV became a candidate called Sherif Adel. The file travels
// with the document, so it still describes the applicant when the page defeats the model, which is
// precisely the case above: the filename and the email local part independently say Karim Nabil.
//
// Pure (no DB, no AI imports) for the same reason cv-auto-apply.ts and contact-review.ts are — the
// rules are the thing worth testing, and they must be testable without the extraction stack.

/** The extraction's own hedge, as stored in ats_candidate_cv_extractions.extracted_fields. */
export type ExtractionConfidence = "high" | "low";

/**
 * Words that make a "name" an organisation rather than a person.
 *
 * Matched as whole words, case-insensitively. Kept to terms that cannot plausibly be part of an
 * Egyptian applicant's own name — a list that reaches further starts rejecting real people, which
 * is the more expensive mistake: a wrongly-rejected name silently becomes the sender's.
 */
const institutionWords = new Set([
  "university",
  "faculty",
  "department",
  "institute",
  "college",
  "academy",
  "hospital",
  "ministry",
  "corporation",
  "pharmaceuticals",
]);

/**
 * True when a name names an organisation. Not a person, at any confidence.
 *
 * Matched word by word rather than with a regular expression built from a string. The first cut of
 * this built the pattern inside a TEMPLATE LITERAL, where a lone backslash-b is the BACKSPACE
 * character rather than a word boundary — so the regex compiled, ran, and matched nothing at all.
 * Splitting on non-letters gives whole-word matching by construction, with no escape sequence
 * left to get wrong.
 */
export function isInstitutionName(value: string | null | undefined): boolean {
  const words = String(value ?? "")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  return words.some((word) => institutionWords.has(word));
}


/**
 * Tokens a CV's filename carries that are about the DOCUMENT, not about the person.
 *
 * Everything here is a word nobody is called. `cv`, `resume` and `vitae` are what the file is;
 * `final`, `updated` and `new` are which copy it is; the format words arrive when a sender renames
 * an attachment by hand.
 */
const documentWords = new Set([
  "cv",
  "cvs",
  "resume",
  "resumee",
  "curriculum",
  "vitae",
  "final",
  "updated",
  "update",
  "new",
  "latest",
  "copy",
  "doc",
  "docx",
  "pdf",
  "file",
  "my",
  "the",
]);

/**
 * A person's name read off a CV's filename, or null when the filename does not carry one.
 *
 * Conservative on purpose. It strips the extension, the "(2)" a second download adds, and the
 * document words above, then requires what is left to look like a name: at least two words, all
 * of them letters. "Karim _Nabil _CV (2).pdf" gives "Karim Nabil"; "Default Resume.pdf" collapses to
 * one word and is refused; "Cv.pdf" empties out entirely. Refusing is safe — the caller falls back
 * to the sender, which is where it stood before this existed.
 */
export function personNameFromFileName(fileName: string | null | undefined): string | null {
  const raw = String(fileName ?? "").trim();
  if (!raw) return null;

  const withoutExtension = raw.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  // "(2)", "(1)" — the marker a repeat download or a re-forward appends.
  const withoutDuplicateMarker = withoutExtension.replace(/\(\s*\d+\s*\)/g, " ");

  const words = withoutDuplicateMarker
    .replace(/[_\-.]+/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => !documentWords.has(word.toLowerCase()));

  if (words.length < 2) return null;
  // Every remaining word must be letters — a phone number, a date or an id in the filename means
  // this is not a name and guessing at the rest of it is not worth the wrong answer.
  if (!words.every((word) => /^\p{L}+$/u.test(word))) return null;

  const name = words.join(" ");
  // A plausible ceiling for a person's full name; past it this is a sentence, not a name.
  if (name.length > 80) return null;
  return name;
}

/**
 * Whether an extracted name may be written to a candidate record as-is.
 *
 * Both gates, together: the model has to have been sure, AND the string has to be a person.
 */
export function isTrustworthyExtractedName(
  value: string | null | undefined,
  confidence: ExtractionConfidence | null | undefined,
): boolean {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return false;
  if (confidence !== "high") return false;
  return !isInstitutionName(trimmed);
}

/**
 * The name a newly-created candidate gets, in order of how much it can be trusted.
 *
 *   1. the extracted name, when the model was sure and it names a person;
 *   2. the CV's filename, when that names a person;
 *   3. the sender's name — unchanged, and still correct for a direct applicant, who IS the sender;
 *   4. the extracted name after all, rather than nothing: full_name is NOT NULL, and a bad name a
 *      recruiter can see and correct beats a failed intake that drops the CV on the floor.
 *
 * Only step 1's second condition and step 2 are new. An extraction that produced no name at all
 * still falls straight through to the sender, exactly as it did before.
 */
export function resolveCandidateFullNameFromCv(input: {
  extractedName: string | null | undefined;
  extractedConfidence: ExtractionConfidence | null | undefined;
  fileName: string | null | undefined;
  senderFullName: string;
}): string {
  const extracted = String(input.extractedName ?? "").trim();

  if (isTrustworthyExtractedName(extracted, input.extractedConfidence)) return extracted;

  const fromFile = personNameFromFileName(input.fileName);
  if (fromFile) return fromFile;

  const sender = input.senderFullName.trim();
  if (sender) return sender;

  return extracted;
}
