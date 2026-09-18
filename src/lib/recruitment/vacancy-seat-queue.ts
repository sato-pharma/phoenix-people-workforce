// Recruitment / ATS — "screen this vacant seat": every undecided CV for one seat, and WHY each is
// in that seat's pile.
//
// ── WHAT WENT WRONG, MEASURED ───────────────────────────────────────────────────────────────────
//
// On 2026-09-11 the owner screened the vacant Medical Representative seat in Menoufia 1 (Anti
// Infective, Delta (1)). Seventeen CVs, over an hour, roughly four minutes each — and the screening
// workstation, which already puts the CV next to the applicant's own WhatsApp answers and walks the
// queue with one key, showed NONE of them. Three separate reasons, none of them a bug in any one
// place:
//
//   1. EVERY ONE OF THEM HAD BEEN FILED. A CV filed into an area folder is dropped from the pool and
//      from the workstation, deliberately — the shelf exists so a good-but-not-now CV stops being
//      re-offered. But the area folder is exactly where the CVs for an open seat are put, so the
//      shelf was hiding the very pile he was trying to work.
//   2. AN EMAIL APPLICANT IS NEVER ASKED THE WHATSAPP QUESTIONS. Their `applied_for_job_title`,
//      `preferred_area_name`, folder and salary are all empty, so `suggestPositions` — which needs a
//      place signal and deliberately stays silent without one — put them in no seat's pile at all.
//      The strongest of the seventeen wrote "Senior medical rep menofia 1" in a subject line and was
//      invisible on every screen in the module.
//   3. ONE PLACE, SEVERAL SPELLINGS. "Menoufia 1" and "menofia 1" are the same seat to a person and
//      two different strings to a matcher.
//
// ── SO THIS ANSWERS ONE QUESTION, FOUR WAYS, AND SAYS WHICH ─────────────────────────────────────
//
// Given one open seat and one candidate: is this CV for that seat, and in plain words, why? The
// four sources are ranked by how firmly each was STATED, strongest first:
//
//   sent     — a recruiter already picked this seat when sending the CV. Settled; nothing overrules.
//   folder   — a recruiter filed the CV into a folder named for this seat's area. A human act.
//   whatsapp — the applicant chose this area themselves in the WhatsApp intake. THE OWNER'S RULE:
//              what the applicant picked by hand is the number-one source of truth for what they
//              applied to, which is why it outranks anything read off a CV.
//   email    — the email subject, or the job text they applied under, names this seat's area.
//   read     — the existing attribution: `vacanciesForCandidate`, unchanged and re-used, not re-done.
//
// THE REASON IS THE POINT. A queue that silently gains eleven rows is a queue nobody trusts; every
// row says "Filed to the Menoufia 1 folder" or "Chose Menoufia 1 on WhatsApp" in the recruiter's own
// vocabulary. Names, never a folder key, never a vacancy id, never a code.
//
// ── WHAT IT DOES NOT INVENT ─────────────────────────────────────────────────────────────────────
//
// THE JOB GATE IS `suggestPositions`, CALLED WITH THE SEAT'S OWN AREA AS THE ADDRESS. That one trick
// is what stops this file growing a second title-matching rule: feeding the seat its own area name
// guarantees the place half can never be the reason a seat is refused, so the only thing left that
// can refuse is the job-family filter — the same filter the send picker uses. It is also what
// enforces the owner's standing rule that a District Manager never receives a District Manager CV:
// a DM's titles do not belong to the medical-rep family, so a DM CV sitting in a rep's area folder
// is still not offered for a rep's seat.
//
// THE PLACE VOCABULARY IS IMPORTED, ALL OF IT. Folder keys are compared with
// `normalizedAreaMatchKey` — PR #3719's canonical-area helper, the only normaliser this module uses.
// Free text is read through `cv-address-place.ts`, which reads `placeAliases` out of
// `src/lib/geo/egypt-locations.ts`. There is no fourth copy of Egypt's place names here and there
// must never be one.
//
// A MISSPELLING IS RESCUED ONLY AS FAR AS IT CAN BE HONESTLY RESCUED. "menofia" reaches Menoufia
// through the alias table, and the seat index then has to agree: "Menoufia 1" needs the digit 1 in
// the text, because Menoufia 1 and Menoufia 2 are two different territories and territory is never
// inferred from free text. So "kafrelsheikh" with no index matches NEITHER Kafr El-Sheikh seat, and
// that refusal is correct rather than a gap.
//
// PURE. The candidate list is a "use client" component; a database import anywhere in this chain
// would ship the Supabase service-role client to the browser.

import { addressNamesArea, areaGovernorate, governorateNamedBy, normalizePlaceText } from "@/lib/recruitment/cv-address-place";
import { normalizedAreaMatchKey } from "@/lib/recruitment/candidate-folder";
import { suggestPositions, type SuggestionInput } from "@/lib/recruitment/position-suggestion";
import { vacanciesForCandidate } from "@/lib/recruitment/vacancy-applicants";
import type { VacancyOption } from "@/lib/recruitment/vacancy-options";

/** How we know this CV belongs to the seat. Ranked strongest-stated first — see the header. */
export type SeatQueueSource = "sent" | "folder" | "whatsapp" | "email" | "read";

/** The answer: which source claimed this CV for the seat, and the sentence the screen prints. */
export type SeatQueueMatch = {
  source: SeatQueueSource;
  /** Plain words, naming the place. Never a code, an id, a folder key or a percentage. */
  reason: string;
};

/**
 * Everything the attribution needs off one candidate.
 *
 * Structural rather than `Candidate`, exactly as `VacancyApplicantInput` and `WorkQueueInput` are:
 * a fixture is eight fields instead of sixty, and none of it reaches a database.
 */
export type SeatQueueCandidate = SuggestionInput & {
  /** The seat the recruiter picked at send time. Outranks every read below it. */
  sentForVacancyId?: number | null;
  /** Where the CV was filed, if it was. The KEY is the claim; the kind is only how it was filed. */
  folderKey?: string | null;
  /** The area the applicant TAPPED in the WhatsApp intake — `ats_candidates.preferred_area_name`. */
  preferredAreaName?: string | null;
  /** The subject line of the email the CV arrived on, when it arrived by email. */
  emailSubject?: string | null;
  /**
   * The job they are asking us for, as the applied-for ladder resolved it — which for an email
   * applicant is often the subject line itself. Read for a PLACE here, never for a title.
   */
  appliedForText?: string | null;
};

/**
 * The seat's place, in the words a recruiter uses for it.
 *
 * The area is the name that tells two seats with the same job title apart. A seat with no area at
 * all — head office, or the national seat whose area is the whole country — falls back to its region
 * and then to the job title, so the sentence never reads "Filed to the  folder".
 */
export function seatPlaceName(vacancy: Pick<VacancyOption, "areaName" | "jobTitle" | "regionName">): string {
  return String(vacancy.areaName ?? "").trim() || String(vacancy.regionName ?? "").trim() || vacancy.jobTitle;
}

// ── THE TWO PLACE READS ARE MEMOISED, AND THAT IS NOT PREMATURE ──────────────────────────────────
//
// The vacancy rail asks this question once for every candidate against every open seat, so the
// loader's cross-product is roughly 780 x 50 on production. Both functions below are pure reads of
// a fixed vocabulary — the same string always gives the same answer — and `governorateNamedBy`
// walks all 27 governorates and their aliases every call. Without this the rail would pay for that
// walk 39,000 times over about 800 distinct strings. Bounded so a long-lived server process cannot
// grow a map without limit; past the bound it simply stops caching and still answers correctly.
const MEMO_LIMIT = 5000;
const normalizedMemo = new Map<string, string>();
const governorateMemo = new Map<string, string | null>();
const areaGovernorateMemo = new Map<string, string | null>();

function memoNormalized(raw: string): string {
  const hit = normalizedMemo.get(raw);
  if (hit !== undefined) return hit;
  const answer = normalizePlaceText(raw);
  if (normalizedMemo.size < MEMO_LIMIT) normalizedMemo.set(raw, answer);
  return answer;
}

function memoGovernorate(normalized: string): string | null {
  const hit = governorateMemo.get(normalized);
  if (hit !== undefined) return hit;
  const answer = governorateNamedBy(normalized);
  if (governorateMemo.size < MEMO_LIMIT) governorateMemo.set(normalized, answer);
  return answer;
}

function memoAreaGovernorate(area: string): string | null {
  const hit = areaGovernorateMemo.get(area);
  if (hit !== undefined) return hit;
  const answer = areaGovernorate(area);
  if (areaGovernorateMemo.size < MEMO_LIMIT) areaGovernorateMemo.set(area, answer);
  return answer;
}

/**
 * The company's index on an area name — the `1` in "Menoufia 1" — or null where there is none.
 *
 * The number is how one governorate is split between two reps, so it is the whole difference between
 * two seats that a governorate alias cannot tell apart. "Sohag1" carries no separator and is read
 * the same way.
 */
function seatAreaIndex(areaName: string | null | undefined): string | null {
  const cleaned = normalizePlaceText(areaName);
  if (!cleaned) return null;
  const spaced = /(?:^|\s)(\d+)$/.exec(cleaned);
  if (spaced) return spaced[1];
  const glued = /[a-z](\d+)$/.exec(cleaned);
  return glued ? glued[1] : null;
}

/** Does this normalised text carry that index as a number of its own, rather than inside another? */
function namesIndex(normalized: string, index: string): boolean {
  return ` ${normalized} `.includes(` ${index} `) || new RegExp(`[a-z]${index}(?:\\s|$)`).test(normalized);
}

/**
 * Does this piece of text name THIS seat's area?
 *
 * Four routes, narrowest first, and each of them is a rule that already exists somewhere in the
 * repository:
 *
 *   1. The canonical folder-key comparison from PR #3719 — the same string, modulo case, spacing and
 *      smart quotes. This is the look-alike folder rule, and it is deliberately not fuzzy.
 *   2. The area's own name tokens, through `addressNamesArea` — so "Tanta" reaches "Gharbia 1
 *      (Tanta)" the same way it does in the send picker.
 *   3. The governorate alias table, through `governorateNamedBy` — the route that rescues a
 *      misspelling, because "menofia" is an alias of Menoufia in the shared place vocabulary.
 *   4. …and when the seat's area carries an index, that index has to appear too. Without this, a
 *      subject line saying "menofia" would claim Menoufia 1 AND Menoufia 2, which is a guess about
 *      somebody's territory dressed up as a match.
 */
export function textNamesSeatArea(value: string | null | undefined, areaName: string | null | undefined): boolean {
  const area = String(areaName ?? "").trim();
  if (!area) return false;
  const raw = String(value ?? "").trim();
  if (!raw) return false;

  const areaKey = normalizedAreaMatchKey(area);
  if (areaKey && normalizedAreaMatchKey(raw) === areaKey) return true;

  const normalized = memoNormalized(raw);
  if (!normalized) return false;
  if (addressNamesArea(normalized, area)) return true;

  const seatGovernorate = memoAreaGovernorate(area);
  if (!seatGovernorate || memoGovernorate(normalized) !== seatGovernorate) return false;
  const index = seatAreaIndex(area);
  return index === null || namesIndex(normalized, index);
}

/**
 * Are this person's job titles right for this seat?
 *
 * ASKED OF `suggestPositions`, WITH THE SEAT'S OWN AREA HANDED IN AS THE ADDRESS. That is the whole
 * design: the place half of that function can then never be the reason a seat is refused, so the
 * only thing left that can refuse is its job-family filter — the same filter the send picker shows
 * the recruiter. Re-implementing the family rule here is how the rail and the picker would come to
 * disagree about which seat a CV is for, with nothing on either screen to say which one is lying.
 *
 * A CV that names no job at all still passes, because that function treats silence as "every seat
 * stays eligible" — and for the three stated sources above, somebody has already answered the
 * question this gate is asking.
 */
function jobFitsSeat(candidate: SeatQueueCandidate, vacancy: VacancyOption): boolean {
  return (
    suggestPositions(
      {
        address: vacancy.areaName,
        appliedForJobTitle: candidate.appliedForJobTitle ?? null,
        currentJobTitle: candidate.currentJobTitle ?? null,
        governorate: candidate.governorate ?? null,
        hasMedicalRepExperience: candidate.hasMedicalRepExperience ?? null,
      },
      [vacancy],
    ).shortlist.length > 0
  );
}

/**
 * Is this CV in this seat's pile, and why?
 *
 * Returns null when no source claims it — which is the common answer and not a failure. Ordered by
 * how firmly the claim was stated, and the first claim wins: a CV already sent for this seat is not
 * also described as "the email subject names Menoufia 1", because the recruiter settled that
 * question themselves and the weaker sentence underneath would only invite doubting it.
 *
 * DECIDING IS NOT THIS FUNCTION'S JOB. A rejected CV still matches: which verdict a CV carries is the
 * decision tabs' question (candidate-decision-tabs.ts), asked by the page over the whole seat pile,
 * so a seat's Rejected tab can still show who was turned down for it.
 */
export function statedSeatQueueMatch(
  candidate: SeatQueueCandidate,
  vacancy: VacancyOption,
): SeatQueueMatch | null {
  const place = seatPlaceName(vacancy);

  if (candidate.sentForVacancyId === vacancy.id) {
    return { reason: `Already sent to a manager for the ${place} seat`, source: "sent" };
  }

  // WHICH SOURCE, BEFORE WHETHER THE JOB FITS. The job gate runs `suggestPositions`, which is the
  // expensive half; the place tests are string work over a memoised vocabulary. Reversing these two
  // costs the rail one title match per candidate per seat for an answer that is almost always no.
  const stated: Array<{ claim: string | null | undefined; reason: string; source: SeatQueueSource }> = [
    { claim: candidate.folderKey, reason: `Filed to the ${place} folder`, source: "folder" },
    { claim: candidate.preferredAreaName, reason: `Chose ${place} on WhatsApp`, source: "whatsapp" },
    { claim: candidate.emailSubject, reason: `Email subject names ${place}`, source: "email" },
    { claim: candidate.appliedForText, reason: `The job they applied for names ${place}`, source: "email" },
  ];
  for (const entry of stated) {
    if (!textNamesSeatArea(entry.claim, vacancy.areaName)) continue;
    return jobFitsSeat(candidate, vacancy) ? { reason: entry.reason, source: entry.source } : null;
  }
  return null;
}

/**
 * The whole answer: the stated sources above, and then the attribution the rail has always used.
 *
 * `vacanciesForCandidate` is imported rather than repeated — see vacancy-applicants.ts for why
 * there must only ever be one place that answers "which seat is this CV for". A caller that has
 * already computed that answer for every seat at once (which is how the loader does it, in one call
 * per candidate instead of one per pair) should call `statedSeatQueueMatch` and fall back to its
 * own copy rather than paying for it a second time here.
 */
export function seatQueueMatch(
  candidate: SeatQueueCandidate,
  vacancy: VacancyOption,
): SeatQueueMatch | null {
  const stated = statedSeatQueueMatch(candidate, vacancy);
  if (stated) return stated;
  if (vacanciesForCandidate(candidate, [vacancy]).includes(vacancy.id)) {
    return { reason: readSeatQueueReason(vacancy), source: "read" };
  }
  return null;
}

/** The sentence for a CV the existing place reader claimed. Exported so the loader can reuse it. */
export function readSeatQueueReason(
  vacancy: Pick<VacancyOption, "areaName" | "jobTitle" | "regionName">,
): string {
  return `Their address and job title match ${seatPlaceName(vacancy)}`;
}
