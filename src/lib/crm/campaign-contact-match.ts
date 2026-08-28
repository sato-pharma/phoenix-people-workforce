/**
 * Campaign notes matched back to the registered contact list.
 *
 * WHY THIS EXISTS. A campaign visit (`visit_type = -8`) carries no contact record at all — no
 * `contact_crm_id`, no `contact_name`, nothing but the rep's own sentence. The screen therefore
 * labels every one of them "Prospect · not on his list", which is the honest reading of an empty
 * contact column.
 *
 * For a large share of them it is simply WRONG. Measured on production 2026-08-28 across all
 * 31,624 campaign visits: the parser identifies a doctor in 19,596 of them, and 2,391 of those
 * doctors are already on the registered contact list — 5,932 visits, 19% of every campaign call
 * ever logged. The rep visited a doctor he calls on every month, and it was recorded as
 * prospecting. Two things go wrong at once: the doctor's own record misses the visit, and the
 * rep's call rate misses it too, because the rate counts `visit_type = 0` only.
 *
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO. It reads. It matches the name the rep
 * wrote against the names already in the CRM and reports what it found. It never rewrites a visit,
 * never attaches a contact id, and never changes a call rate. A wrong auto-attach would put a real
 * visit on the wrong doctor's record silently, and nobody would ever find it — so the match is
 * shown to a human and the human decides. This module is the evidence, not the edit.
 *
 * THE MATCH IS EXACT, ON PURPOSE. Names are normalised for the ways Arabic is legitimately typed
 * differently (see `normalizeContactName`) and then compared whole. No fuzzy distance, no partial
 * scoring, no "closest match". Exact-after-normalisation finds 2,391 doctors and is defensible
 * name by name; a fuzzy pass would find more and nobody could tell you which of them were wrong.
 * Widening it is a later, measured step — the shape of what is left over is reported by
 * `summarizeCampaignMatches` precisely so that step can be argued from a number.
 */

import { readCampaignNote, type CampaignNoteReading } from "@/lib/crm/campaign-note";

/** Arabic diacritics and the tatweel, which are decoration and never part of the name. */
const ARABIC_MARKS = /[ً-ْٰـ]/g;

/**
 * Honorifics. A rep writes "د/أحمد سمير" one day and "أحمد سمير" the next; the CRM record holds
 * one form or the other. Stripping the title from BOTH sides is what makes those the same person.
 * `prof` and `mr` appear in the English-typed notes.
 */
const TITLE_TOKENS = new Set([
  "د",
  "دكتور",
  "دكتوره",
  "دكتورة",
  "الدكتور",
  "الدكتوره",
  "دكتره",
  "dr",
  "drs",
  "doctor",
  "prof",
  "professor",
  "mr",
  "mrs",
  "ms",
]);

/**
 * The same name, written the way everyone actually types it.
 *
 * Egyptian keyboards and copy-pasted CRM records disagree on four things constantly, and every one
 * of them is a spelling difference rather than a different person:
 *   - the hamza carriers `أ إ آ ٱ`, typed as bare `ا` about as often as not;
 *   - final `ى` versus `ي` (`يحيى` / `يحيي`);
 *   - final `ة` versus `ه` (`سمية` / `سميه`);
 *   - diacritics, which some sources carry and most do not.
 * Punctuation goes too — "د/أحمد" and "د. أحمد" and "د أحمد" are one name — and so does case, for
 * the English-typed minority.
 *
 * Returns "" for anything that normalises away to nothing, which the caller must treat as "no
 * name" rather than as a key. An empty key would collide every unnamed row onto one doctor.
 */
export function normalizeContactName(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0 && !TITLE_TOKENS.has(token))
    .join(" ")
    .trim();
}

/**
 * A single-word name is not evidence.
 *
 * "أحمد" is one of the most common first names in Egypt; matching a bare "أحمد" against a CRM
 * record whose whole name is also "أحمد" would attach a visit to a stranger with a straight face.
 * Two tokens is the floor — a first name and one more thing.
 *
 * It also does the prose filtering for free, which is why there is no blocklist of English filler
 * words in this file. The parser sometimes hands back fragments of the rep's sentence ("need more
 * visits to remember the roya by name"); those simply do not appear in the contact list, so the
 * index lookup rejects them without anyone having to enumerate them. A blocklist would have to be
 * maintained forever and would still be incomplete.
 */
export function isMatchableName(normalized: string): boolean {
  return normalized.split(" ").filter(Boolean).length >= 2;
}

/** One row of the registered contact list, as the matcher needs it. */
export type KnownContactRow = {
  agentHrId: string | null;
  contactCrmId: string | null;
  contactName: string | null;
  speciality: string | null;
};

/** A doctor who is on the list, and the reps who actually call on him. */
export type KnownContact = {
  /** The reps whose own registered list this doctor is on, lower-cased HR ids. */
  agentHrIds: ReadonlySet<string>;
  contactCrmId: string | null;
  /** The name as the CRM holds it — what gets shown, never the normalised key. */
  contactName: string;
  speciality: string | null;
};

export type KnownContactIndex = ReadonlyMap<string, KnownContact>;

/**
 * The registered contact list, keyed by normalised name.
 *
 * Built from the rep's own normal visits (`visit_type = 0`) rather than from a contacts table,
 * because a contact nobody has ever visited is not evidence that this campaign call was
 * mis-coded — the question being answered is "does this rep already call on this doctor
 * normally?", and only a real visit answers it.
 *
 * Collapsing by name is deliberate and slightly lossy: 10,915 distinct normalised names sit behind
 * more contact ids than that, because the same doctor is registered more than once. The first id
 * seen wins as the display id; every owning rep is kept, because "whose list is he on" is the
 * question the screen has to answer and it can legitimately have more than one answer.
 */
export function buildKnownContactIndex(rows: readonly KnownContactRow[]): KnownContactIndex {
  // Built mutable and handed back read-only. The owner set genuinely grows as rows arrive — a
  // doctor two reps share is one entry with two owners — so the alternative is casting the readonly
  // set away on every append, which is the same mutation with the type system switched off.
  const index = new Map<string, KnownContact & { agentHrIds: Set<string> }>();
  for (const row of rows) {
    const name = row.contactName?.trim();
    if (!name) continue;
    const key = normalizeContactName(name);
    if (!key || !isMatchableName(key)) continue;
    const owner = row.agentHrId?.toLowerCase();

    const existing = index.get(key);
    if (existing) {
      if (owner) existing.agentHrIds.add(owner);
      continue;
    }
    index.set(key, {
      agentHrIds: new Set(owner ? [owner] : []),
      contactCrmId: row.contactCrmId,
      contactName: name,
      speciality: row.speciality,
    });
  }
  return index;
}

/**
 * Whose list the doctor turned out to be on.
 *
 * The distinction carries the whole meaning, and the two cases want opposite responses:
 *   - `own`   — the rep visits this doctor normally and logged THIS call as a campaign. A coding
 *               mistake, his own to correct, and the visit belongs on the doctor's record.
 *   - `other` — the doctor is on a colleague's list. Not a coding mistake at all; it is either a
 *               shared customer or a territory question, and telling the rep to "fix his coding"
 *               would be wrong.
 */
export type CampaignMatchScope = "other" | "own";

export type CampaignContactMatch = {
  /** Reps who hold this doctor on their registered list, other than the one who logged the visit. */
  alsoVisitedBy: readonly string[];
  contactCrmId: string | null;
  /** The CRM's spelling of the name — shown to the reader, so they can see WHY it matched. */
  contactName: string;
  /** The rep's own spelling, straight out of his note. Never rewritten. */
  writtenName: string;
  scope: CampaignMatchScope;
  speciality: string | null;
};

/**
 * Match one campaign note against the list.
 *
 * A note can name several people (the parser reads them all). The first that matches wins, and
 * `own` beats `other`: if a note names two doctors and one of them is the rep's own contact, the
 * actionable reading is the coding mistake, not the colleague's customer.
 */
export function matchCampaignNote(
  reading: CampaignNoteReading | null,
  agentHrId: string | null,
  index: KnownContactIndex,
): CampaignContactMatch | null {
  if (!reading) return null;
  const me = agentHrId ? agentHrId.toLowerCase() : null;
  let fallback: CampaignContactMatch | null = null;

  for (const person of reading.people) {
    const key = normalizeContactName(person.name);
    if (!key || !isMatchableName(key)) continue;
    const hit = index.get(key);
    if (!hit) continue;

    const mine = me != null && hit.agentHrIds.has(me);
    const match: CampaignContactMatch = {
      alsoVisitedBy: [...hit.agentHrIds].filter((id) => id !== me).sort(),
      contactCrmId: hit.contactCrmId,
      contactName: hit.contactName,
      scope: mine ? "own" : "other",
      speciality: hit.speciality,
      writtenName: person.name,
    };
    if (mine) return match;
    fallback ??= match;
  }
  return fallback;
}

/** Convenience for callers holding the raw comment rather than a parsed reading. */
export function matchCampaignComment(
  comment: string | null | undefined,
  agentHrId: string | null,
  index: KnownContactIndex,
): CampaignContactMatch | null {
  const text = comment?.trim();
  if (!text) return null;
  return matchCampaignNote(readCampaignNote(text), agentHrId, index);
}

export type CampaignMatchSummary = {
  /** Campaign visits whose doctor is on a colleague's list — a territory question, not a fix. */
  onAnotherList: number;
  /** Campaign visits whose doctor the rep already visits normally. These are the mis-coded ones. */
  onHisOwnList: number;
  /** Campaign visits naming a doctor who is on nobody's list — genuine prospecting. */
  trueProspect: number;
  /** Campaign visits where no name could be read at all. Not a failure to match; nothing to match. */
  unnamed: number;
};

/**
 * The counts behind the screen's summary strip.
 *
 * `unnamed` is kept separate from `trueProspect` on purpose. Folding them together would report a
 * parsing gap as a prospecting achievement, and the two need opposite follow-ups: one is a note
 * the rep should write more clearly, the other is a doctor worth adding to his list.
 */
export function summarizeCampaignMatches(
  matches: readonly (CampaignContactMatch | null)[],
  namedFlags: readonly boolean[],
): CampaignMatchSummary {
  const summary: CampaignMatchSummary = { onAnotherList: 0, onHisOwnList: 0, trueProspect: 0, unnamed: 0 };
  matches.forEach((match, i) => {
    if (match?.scope === "own") summary.onHisOwnList += 1;
    else if (match?.scope === "other") summary.onAnotherList += 1;
    else if (namedFlags[i]) summary.trueProspect += 1;
    else summary.unnamed += 1;
  });
  return summary;
}
