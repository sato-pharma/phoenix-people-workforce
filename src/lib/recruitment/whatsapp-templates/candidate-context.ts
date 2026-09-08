// Recruitment / ATS — the values Phoenix fills in for the recruiter, so the send screen only ever
// asks for what it genuinely cannot know.
//
// Everything here is derived from a candidate row and the signed-in sender. The rest of a template's
// placeholders — a date, a time, an interviewer — are typed at send time, because they are decisions
// nobody has recorded yet.

import { systemLegalEntity } from "@/config/system-settings";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { toWhatsAppDialNumber } from "@/lib/recruitment/whatsapp-templates/send-link";
import { AUTO_VARIABLE_KEYS, type AutoVariableKey } from "@/lib/recruitment/whatsapp-templates/variables";

export type CandidateSendContext = {
  candidateId: string;
  fullName: string;
  /** Digits-only dialable number, or null when nothing on file can be read with confidence. */
  dialNumber: string | null;
  /** Which stored column the number came from — shown on screen so the sender can sanity-check it. */
  numberSource: "whatsapp" | "phone" | null;
  autoValues: Record<AutoVariableKey, string>;
};

/**
 * The candidate's first name.
 *
 * Egyptian names are given-name-first, so the first token is the right one — the owner's own example
 * opens "Dear Aya". A single-token name returns itself rather than an empty string, which is the
 * difference between "Dear Aya" and "Dear ,".
 *
 * Honorifics are stripped because CV headers routinely carry them and "Dear Mr. Ahmed Nour" read as
 * a first name gives "Dear Mr.".
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
    .replace(/(^|[-'\u2019])([a-z])/gu, (_whole, sep: string, letter: string) => sep + letter.toUpperCase());
}

/**
 * Load one candidate and work out everything that can be answered without asking.
 *
 * THE NUMBER IS READ FROM `whatsapp` FIRST, THEN `phone`. They are different columns and they
 * disagree: `whatsapp` is what an applicant told us to reach them on, `phone` is whatever the CV
 * carried. Preferring the CV's number would message the landline on a fair number of rows.
 *
 * A candidate whose number cannot be read confidently returns `dialNumber: null` rather than a
 * best guess — the send screen then asks the sender to type one. The organogram's rule applies
 * unchanged: no chat is always better than the wrong chat.
 */
export async function loadCandidateSendContext(
  candidateId: string,
  senderName: string | null,
): Promise<CandidateSendContext | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .select("id,full_name,phone,whatsapp,applied_for_job_title,current_job_title")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as Record<string, unknown>;
  const fullName = String(row.full_name ?? "").trim();

  const whatsappColumn = toWhatsAppDialNumber(textOrNull(row.whatsapp));
  const phoneColumn = toWhatsAppDialNumber(textOrNull(row.phone));
  const dialNumber = whatsappColumn ?? phoneColumn;
  const numberSource = whatsappColumn ? "whatsapp" : phoneColumn ? "phone" : null;

  // 🔴 `applied_for_job_title` ONLY. NEVER fall back to `current_job_title`.
  //
  // `current_job_title` is where the candidate works TODAY, at somebody else's company. Used as a
  // fallback it produces "Thank you for your interest in the Senior Product Specialist position at
  // Sato Pharma" for a man whose CURRENT job is Senior Product Specialist somewhere else — a
  // rejection notice that names, as the role we turned him down for, the job he already has.
  // Observed exactly that way on 2026-09-08 against a real staging record while testing the
  // rejection template, and it reaches 338 of 890 production candidates (38%) — every one of them
  // silently, because the sentence is grammatical and the title is real.
  //
  // The fallback was written into this file with a comment saying current_job_title "would read as
  // an error in an invitation", and then used anyway. Both halves of that sentence were true; only
  // the second half was acted on.
  //
  // WITH NO FALLBACK, an absent applied-for title leaves this empty, `renderTemplate` reports it
  // MISSING, and the send is refused until the recruiter types the real one. That is the intended
  // outcome: asking a human for one field beats telling a candidate something false about himself,
  // and it is the same reasoning the number repair follows — no chat is better than the wrong chat.
  const jobTitle = textOrNull(row.applied_for_job_title) ?? "";

  return {
    autoValues: {
      candidate_first_name: firstNameOf(fullName),
      candidate_name: fullName,
      company_name: systemLegalEntity.legalNameEn,
      job_title: jobTitle,
      sender_name: senderName ?? "",
    },
    candidateId: String(row.id),
    dialNumber,
    fullName,
    numberSource,
  };
}

/**
 * The auto values for a MANUAL send — a number typed by hand with no candidate behind it.
 *
 * Every candidate-derived key resolves to an empty string, which makes it a normal unfilled
 * placeholder: the send screen shows it as a box to type in, and the send is refused until it has a
 * value. That is deliberate — a manual send to a number with no CV still says "Dear <somebody>", and
 * the sender is the only one who knows who that is.
 */
export function manualSendAutoValues(senderName: string | null): Record<AutoVariableKey, string> {
  const values = {} as Record<AutoVariableKey, string>;
  for (const key of AUTO_VARIABLE_KEYS) values[key] = "";
  values.company_name = systemLegalEntity.legalNameEn;
  values.sender_name = senderName ?? "";
  return values;
}
