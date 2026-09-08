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
  return tokens[0] ?? fullName.trim();
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

  // `applied_for_job_title` is the role they are in the pipeline FOR — the right thing to name in an
  // interview invitation. `current_job_title` is where they work today and would read as an error in
  // an invitation, so it is only a fallback for templates used outside the pipeline.
  const jobTitle = textOrNull(row.applied_for_job_title) ?? textOrNull(row.current_job_title) ?? "";

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
