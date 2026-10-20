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
import { candidateGreetingName } from "@/lib/recruitment/candidate-greeting";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { offerCanGiveAStartDate } from "@/lib/recruitment/offer-start-date-rule";
import { toWhatsAppDialNumber } from "@/lib/recruitment/whatsapp-templates/send-link";
import { AUTO_VARIABLE_KEYS, type AutoVariableKey } from "@/lib/recruitment/whatsapp-templates/variables";

/**
 * The offer letter pointed at from the CANDIDATE row, or null.
 *
 * This is the pointer a STANDALONE offer uses — one written for somebody with no application behind
 * it, which on production is most of them: 27 offers against 15 applications. See the `offerId` note
 * on `Candidate` for why it sits on the person rather than on the application.
 */
async function candidateOfferId(candidateId: string): Promise<string | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .select("offer_id")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return textOrNull((data as Record<string, unknown> | null)?.offer_id);
}

/**
 * The offer letter reached through one of this candidate's APPLICATIONS, or null.
 *
 * The older half of the pointer, still read because the offer-letter bridge has written it since
 * 2026-09-08 (see `recordApplicationOfferLetter`) and rows carry it. A candidate may have several
 * applications; the most recently updated one carrying a link wins, because that is the offer
 * currently in play.
 */
async function applicationOfferId(candidateId: string): Promise<string | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_applications")
    .select("offer_id,updated_at")
    .eq("candidate_id", candidateId)
    .not("offer_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return textOrNull((data ?? [])[0]?.offer_id);
}

/**
 * 🔒 The owner's ruling of 2026-09-28 — "exclude declined and withdrawn letters from the start date".
 *
 * The rule itself lives in `offer-start-date-rule.ts` and is re-exported here, where it has always
 * been imported from. It had to move out of this file because the candidate record PAGE reads the same
 * rule, and that page is a client component: importing it from here dragged the database client and
 * the offers service — server-only, service-role credential — into the browser bundle. One rule, one
 * copy, two readers.
 */
export { offerCanGiveAStartDate } from "@/lib/recruitment/offer-start-date-rule";

/**
 * The agreed first working day for a candidate, or "" when nothing reliable says.
 *
 * TWO POINTERS, THE CANDIDATE'S FIRST. `ats_candidates.offer_id` is the one that can answer for an
 * offer written to somebody with no application — the ordinary case, and the reason the application
 * column read 0 of 15 rows for as long as it was the only one. The application pointer stays as the
 * fallback: it is written by the bridge, it is already populated, and dropping it would lose the
 * answer for every row that has one.
 *
 * BOTH ARE STORED POINTERS. Neither branch matches an offer to a person by anything a human typed.
 *
 * A DECLINED OR WITHDRAWN LETTER GIVES NO DATE — the owner's ruling, see `offerCanGiveAStartDate`.
 *
 * NEVER THROWS. `getOffer` raises `OfferNotFoundError` for a letter that has since been deleted,
 * and a deleted letter must degrade to "type the date yourself" rather than failing the whole send
 * screen — the recruiter is looking at a candidate, not at an offer.
 */
async function resolveOfferStartDate(candidateId: string): Promise<string> {
  try {
    const offerId = (await candidateOfferId(candidateId)) ?? (await applicationOfferId(candidateId));
    if (!offerId) return "";

    const offer = await getOffer(offerId);
    if (!offerCanGiveAStartDate(offer.status)) return "";
    return textOrNull(offer.startDate) ?? "";
  } catch {
    // Any miss — no pointer on either side, a dead letter, a deleted one, a read failure — is an
    // empty string, and the send screen then asks for the date. Nothing here may invent one.
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

// The first-name rules (honorifics stripped, a shouted name softened) and the "Dr" every candidate
// is greeted with live in candidate-greeting.ts, which is client-safe; re-exported for the callers
// that already read them from here.
export { firstNameOf, softenShoutedName } from "@/lib/recruitment/candidate-greeting";

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

  // The agreed first working day, read through the pointer recruitment stores.
  //
  //   candidate -> ats_candidates.offer_id           -> offers.start_date
  //   candidate -> ats_applications.offer_id         -> offers.start_date   (the fallback)
  //
  // 🔴 THE DIRECTION IS THE DESIGN. `src/lib/offers/types.ts` carries the owner's instruction that
  // the offers module is independent of recruitment — an offer may go to somebody who never entered
  // the ATS, and "the two must not be merged". So nothing here teaches `offers` about candidates: it
  // follows a pointer recruitment already holds, and calls the offers module's own `getOffer`, the
  // same one-way import the bridge uses.
  //
  // EVERY MISS IS AN EMPTY STRING, never a guess. No pointer on either side, a letter since
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
      // "Dear Dr Aya": every candidate is greeted with Dr (owner, 2026-10-20) — see candidate-greeting.ts.
      candidate_first_name: candidateGreetingName(fullName),
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
