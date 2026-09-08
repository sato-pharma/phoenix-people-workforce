// Recruitment / ATS — the values Phoenix fills in for the recruiter, so the send screen only ever
// asks for what it genuinely cannot know.
//
// Everything here is derived from a candidate row and the signed-in sender. The rest of a template's
// placeholders — a date, a time, an interviewer — are typed at send time, because they are decisions
// nobody has recorded yet.

import { systemLegalEntity } from "@/config/system-settings";
// The hiring-documents domain owns the rule for which papers a person supplies themselves.
// This module asks it; it does not re-derive it, and it must never read the definitions table
// directly — the "no company paper files here" filter has two halves and belongs in one place.
import { candidateSuppliedDocumentList } from "@/lib/hiring-documents/candidate-supplied";
// The offers module's own reader. recruitment -> offers is the permitted direction and the
// only one; nothing under src/lib/offers/ imports anything from recruitment.
import { getOffer } from "@/lib/offers/service";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { toWhatsAppDialNumber } from "@/lib/recruitment/whatsapp-templates/send-link";
import { AUTO_VARIABLE_KEYS, type AutoVariableKey } from "@/lib/recruitment/whatsapp-templates/variables";

/**
 * The agreed first working day for a candidate, or "" when nothing reliable says.
 *
 * Follows `ats_applications.offer_id`, which the offer-letter bridge stores (see
 * `recordApplicationOfferLetter`). A candidate may have several applications; the most recently
 * updated one carrying a link wins, because that is the offer currently in play.
 *
 * NEVER THROWS. `getOffer` raises `OfferNotFoundError` for a letter that has since been deleted,
 * and a deleted letter must degrade to "type the date yourself" rather than failing the whole send
 * screen — the recruiter is looking at a candidate, not at an offer.
 */
async function resolveOfferStartDate(candidateId: string): Promise<string> {
  try {
    const supabase = recruitmentDb();
    const { data, error } = await supabase
      .from("ats_applications")
      .select("offer_id,updated_at")
      .eq("candidate_id", candidateId)
      .not("offer_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);

    const offerId = textOrNull((data ?? [])[0]?.offer_id);
    if (!offerId) return "";

    const offer = await getOffer(offerId);
    return textOrNull(offer.startDate) ?? "";
  } catch {
    // Any miss — no application, no link, a deleted letter, a read failure — is an empty string, and
    // the send screen then asks for the date. Nothing here may invent one.
    return "";
  }
}

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

  // The agreed first working day, read through the link the bridge now stores.
  //
  //   candidate -> ats_applications.offer_id -> offers.start_date
  //
  // 🔴 THE DIRECTION IS THE DESIGN. `src/lib/offers/types.ts` carries the owner's instruction that
  // the offers module is independent of recruitment — an offer may go to somebody who never entered
  // the ATS, and "the two must not be merged". So nothing here teaches `offers` about candidates: it
  // follows a pointer recruitment already holds, and calls the offers module's own `getOffer`, the
  // same one-way import the bridge uses.
  //
  // EVERY MISS IS AN EMPTY STRING, never a guess. No application, no offer_id, a letter since
  // deleted, or a letter with no date — all leave this blank, `renderTemplate` reports it MISSING,
  // and the send is refused until a human types the real day. Guessing a start date is worse than
  // asking for one: it reaches a new hire as the day they are expected at work.
  //
  // NOT MATCHED BY NAME OR EMAIL, deliberately. The offer letters carry `candidate_name` and
  // `candidate_email` as free text with no key, and matching on those was measured on 2026-09-08:
  // 0 of 3 live offers matched a candidate by email and 1 of 3 by name. A wrong match here puts the
  // wrong first working day in a welcome message, so only the stored pointer is trusted.
  const startDate = await resolveOfferStartDate(candidateId);

  // The joining documents, read live from the Hiring Documents checklist every time the send screen
  // opens. Editing that checklist is therefore the ONLY place the list is maintained — the template
  // body carries a placeholder, not a copy, so the two cannot drift apart.
  const documentList = await candidateSuppliedDocumentList();

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
      // A CANDIDATE HAS NO CONTRACT. Empty rather than absent, for the same reason as the
      // probation date: the key is part of the auto-value contract, and a missing one is a type
      // hole that renders as "undefined" for anything reading it outside renderTemplate.
      contract_renewal_date: "",
      document_list: documentList,
      job_title: jobTitle,
      // A CANDIDATE HAS NO PROBATION, so this is empty here and `renderTemplate` reports it missing
      // the moment a probation template is aimed at a CV by mistake. Empty rather than absent: the
      // key is part of the auto-value contract, and a missing key is a type hole that renders as
      // "undefined" if anything ever reads it without going through renderTemplate.
      probation_end_date: "",
      sender_name: senderName ?? "",
      start_date: startDate,
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
 *
 * The document list is the exception, because it is not candidate-derived at all.
 */
export async function manualSendAutoValues(senderName: string | null): Promise<Record<AutoVariableKey, string>> {
  const values = {} as Record<AutoVariableKey, string>;
  for (const key of AUTO_VARIABLE_KEYS) values[key] = "";
  values.company_name = systemLegalEntity.legalNameEn;
  values.sender_name = senderName ?? "";
  // THE DOCUMENT LIST IS NOT CANDIDATE-DERIVED, so it is filled here as well. It is the same list
  // for every person, and leaving it blank on the manual path would make a recruiter retype seven
  // bullet points by hand for the one send that already has no CV to work from.
  values.document_list = await candidateSuppliedDocumentList();
  return values;
}
