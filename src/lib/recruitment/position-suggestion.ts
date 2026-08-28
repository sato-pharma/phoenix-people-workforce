// Recruitment / ATS — which open seat a CV most likely belongs to.
//
// WHY. Sending a CV means picking one of ~49 open seats from a list. The owner asked
// (2026-08-28) for the system to propose the seat and for a person to confirm it:
//
//   "why don't we use the help of the AI to recommend? And that's your confirm. The HR confirm."
//
// So this module RECOMMENDS. It never sends, never files, and never writes. The recruiter's
// confirmation is what stores a position — exactly as before this existed. A suggestion that is
// wrong costs one click; a suggestion acted on without a person costs a real candidate.
//
// RULES, NOT A MODEL — and that is a measured choice, not a preference. This repository has already
// run the identical class of problem (free Egyptian text -> which of N geographic buckets) against
// a paid model: plain address matching scored 85-88%, GPT-4o scored 81.4%, and paid geocoding made
// it WORSE. The inputs here are the same shape and the bucket list is smaller, so opening with a
// model would cost money to be less accurate. It would also make the suggestion depend on an API
// key whose failure mode in this repository is a silent fall back to rules anyway.
//
// NOTHING HERE IS LABELLED AS AI, and no screen may label it. Standing owner rule: assistive
// inference is invisible to users. It is presented as a pre-filled field a person edits, which is
// also the honest description of what it is.
//
// Pure — no React, no database, no network — so the recruiter's screen and the tests fold the same
// way and cannot drift apart. Same discipline as position-folder.ts.

import { placeAliases } from "@/lib/geo/egypt-locations";
import type { VacancyOption } from "@/lib/recruitment/vacancy-options";

/** What the CV knows that bears on the question. A subset of Candidate, so tests need no fixture. */
export type SuggestionInput = {
  address?: string | null;
  governorate?: string | null;
  currentJobTitle?: string | null;
  appliedForJobTitle?: string | null;
  hasMedicalRepExperience?: boolean | null;
};

/**
 * How firmly the place was identified. The ORDER is the whole ranking — a seat matched at a better
 * tier always beats one matched at a worse tier, and seats below the best tier reached are dropped
 * rather than ranked: a shortlist mixing "the address says Nasr City" with "the address says Cairo"
 * reads as several equal options when only one of them was actually named.
 */
export const PLACE_TIERS = ["none", "governorate", "area"] as const;
export type PlaceTier = (typeof PLACE_TIERS)[number];

export type PositionSuggestion = {
  vacancy: VacancyOption;
  placeTier: PlaceTier;
  /** Plain words a recruiter can check against the CV in front of them. Never a score, never "AI". */
  reasons: string[];
};

export type SuggestionResult = {
  /**
   * The one seat to pre-fill, or null. Non-null ONLY when a single seat survived both filters —
   * see suggestPositions for why a tie comes back as a shortlist rather than a coin flip.
   */
  confident: PositionSuggestion | null;
  /** Every seat that survived, best first. Includes `confident` when there is one. */
  shortlist: PositionSuggestion[];
};

// ── Normalisation ────────────────────────────────────────────────────────────
// Deliberately the same shape as the geography module's own normaliser: lowercase, punctuation to
// spaces, collapse. Kept local and Latin-first because everything compared HERE — area names and CV
// addresses alike — is written in Latin script. Arabic arrives too, and is handled where it is
// actually understood: resolveGovernorate, which carries the Arabic alias tables. Arabic codepoints
// are preserved rather than stripped so that a wholly Arabic address still reaches that function
// with its content intact.
function normalize(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** " nasr city " — padded so a containment test cannot match inside a longer word. */
function padded(value: string): string {
  return ` ${value} `;
}

// ── Place ────────────────────────────────────────────────────────────────────

/**
 * Governorate names, from the geography module's own exported vocabulary.
 *
 * MATCHED ON WHOLE WORDS, which resolveGovernorate does not do — and that difference is not
 * academic. That function tests `candidate.includes(key)` as a bare substring, and several aliases
 * are three or four letters long, so on the first run of this matcher against the real 447 CVs a
 * candidate living at "New Bapunagar, Bhilwara, Rajasthan" was resolved to DAKAHLIA: "bapunAGAr"
 * contains "aga", the alias for the town of Aga. Twelve more followed it. The alias table is
 * written with a leading space for exactly that reason — " aga" — but normalising the key trims the
 * space back off, so the guard never survives to be applied.
 *
 * The vocabulary itself is reused rather than rewritten; only the comparison is stricter. Writing a
 * second copy of Egypt's place names is a documented mistake in this repository and this is not one
 * — `placeAliases` is imported, and if a name is added there it is picked up here for free.
 */
const NORMALIZED_ALIASES: ReadonlyArray<{ label: string; keys: string[] }> = placeAliases.map(
  (entry) => ({
    keys: entry.aliases.map((alias) => normalize(alias)).filter(Boolean),
    label: entry.label,
  }),
);

/** The canonical governorate labels, normalised — used to tell a governorate name from a place name. */
const GOVERNORATE_LABELS = new Set(placeAliases.map((entry) => normalize(entry.label)));

/**
 * Which governorate a string names, on a whole-word match, or null.
 *
 * Order follows the vocabulary's own priority, so an address naming two governorates resolves to the
 * one the geography module ranks first. "Alexandria, Egypt (Willing to relocate to Cairo if
 * available Post)" is a real address on file and resolves to Alexandria — where the person lives,
 * which is the question being asked.
 */
function governorateOf(value: string | null | undefined): string | null {
  const cleaned = normalize(value);
  if (!cleaned) return null;
  const hay = padded(cleaned);
  // The space-free form as well, so "Down town" reaches the alias "downtown" and vice versa.
  const squashedHay = padded(cleaned.replace(/\s+/g, ""));
  for (const { label, keys } of NORMALIZED_ALIASES) {
    for (const key of keys) {
      if (hay.includes(padded(key))) return label;
      const squashedKey = key.replace(/\s+/g, "");
      if (squashedKey !== key && squashedHay.includes(padded(squashedKey))) return label;
    }
  }
  return null;
}

/**
 * Area-name fragments an address could plausibly contain.
 *
 * The WHOLE name is a token, and so is each part after splitting on separators. Both are needed and
 * neither is enough: "Dokki - Mohandseen - Bolak" is three neighbourhoods and a CV names one of
 * them, but "Kafr El-Sheikh 1" carries the same hyphen inside a single name, and splitting it alone
 * leaves the fragments "kafr el" and "sheikh" — neither of which is a place. "Gharbia 1 (Tanta)"
 * yields both "gharbia 1" and "tanta"; the second is what anybody actually writes.
 *
 * A trailing index comes off as well ("Assuit 2" -> "assuit", "Sohag1" -> "sohag"), because the
 * number is the company's way of splitting a governorate between two reps and means nothing on a CV.
 */
function areaTokens(areaName: string | null): string[] {
  if (!areaName) return [];
  const tokens = new Set<string>();
  const add = (raw: string) => {
    const cleaned = normalize(raw);
    // A token has to be long enough, and made of letters, to identify anywhere. "Delta (2)" splits
    // into "delta" and "2"; a street number then matched it, and a sales manager living at "2 St.
    // El Mahata, El Marg" — which is in Cairo — was pre-filled into the Delta district manager's
    // seat because their address happened to start with the right digit.
    if (!cleaned || cleaned.length < 3 || !/[a-z؀-ۿ]/.test(cleaned)) return;
    tokens.add(cleaned);
    const withoutIndex = cleaned.replace(/\s+\d+$/, "").trim();
    if (withoutIndex && withoutIndex !== cleaned) tokens.add(withoutIndex);
    // "Sohag1" carries no separator at all, so the digit has to come off a bare word too.
    const glued = cleaned.replace(/([a-z])\d+$/, "$1").trim();
    if (glued && glued !== cleaned) tokens.add(glued);
  };
  add(areaName);

  // Splitting is only safe when it does not cut a name in half. "Kafr El-Sheikh 1" carries the same
  // hyphen as "Helwan-Maadi" but means something different by it, and splitting it yields "kafr el"
  // and "sheikh" — at which point a candidate living in Al Sheikh Zayed, which is in GIZA, was being
  // matched to Kafr El-Sheikh on the fragment. The tell is the leftover article: a piece ending in a
  // bare "el" or "al" was cut mid-name, so the pieces are thrown away and only the whole name kept.
  const parts = areaName.split(/[-/(),]/).map((part) => normalize(part)).filter(Boolean);
  if (!parts.some((part) => /(^|\s)(el|al)$/.test(part))) {
    for (const part of parts) add(part);
  }
  return [...tokens];
}

/**
 * Tokens that must never match an address.
 *
 * "Egypt" is a real area — the National Sales Manager's seat — and every Egyptian address on file
 * ends with the word. Matching it would hand the country's top sales job to whoever wrote their
 * country down. "Head office" and "office" are the same trap in miniature: an address says "office"
 * for reasons that have nothing to do with a seat at head office.
 */
const NON_PLACE_TOKENS = new Set(["egypt", "head office", "office"]);

/**
 * True when the address names this area outright — by a name that is the AREA's, not merely its
 * governorate's.
 *
 * A GOVERNORATE NAME IS NOT AN AREA HIT, even when an area is named after one. This is the single
 * correction that mattered most: one of the open seats sits in an area called simply "Cairo" and is
 * a District Sales Manager post. On the first run against the real 447 CVs it took 48 of the 81
 * pre-fills — nearly three in five — because "Cairo" is the only area name a plain Cairo address
 * contains, so it won on precision while eleven genuine Cairo seats sat one tier below it. A
 * general accountant in Shubra was being handed a district manager's job. Writing "Cairo" on a CV
 * says which governorate somebody lives in and nothing whatsoever about which seat they want, so it
 * is scored as what it is.
 */
function addressNamesArea(haystack: string, areaName: string | null): boolean {
  const hay = padded(haystack);
  // "Down town" and "downtown" are the same place spelled two ways, and one of them is the area's
  // own name — so the space-free form is compared as well, on both sides.
  const squashedHay = padded(haystack.replace(/\s+/g, ""));
  for (const token of areaTokens(areaName)) {
    if (NON_PLACE_TOKENS.has(token)) continue;
    if (GOVERNORATE_LABELS.has(token)) continue;
    if (hay.includes(padded(token))) return true;
    const squashedToken = token.replace(/\s+/g, "");
    if (squashedToken !== token && squashedHay.includes(padded(squashedToken))) return true;
  }
  return false;
}

/** Which governorate an area sits in, read from its own name through the shared vocabulary. */
function areaGovernorate(areaName: string | null): string | null {
  for (const token of areaTokens(areaName)) {
    if (NON_PLACE_TOKENS.has(token)) continue;
    const label = governorateOf(token);
    if (label) return label;
  }
  return null;
}

/**
 * How firmly this CV points at this seat's area.
 *
 * "area" means the address named it. "governorate" means the address named somewhere in the same
 * governorate — which in this company narrows to a SET of seats, never to one: the sales geography
 * has areas and bricks and no governorate layer, so Cairo alone covers twelve open seats. Saying
 * "governorate" rather than pretending to more is the entire reason there are two tiers.
 */
function placeTierFor(input: SuggestionInput, vacancy: VacancyOption): PlaceTier {
  const address = normalize(input.address);
  const governorateText = normalize(input.governorate);
  const haystack = [address, governorateText].filter(Boolean).join(" ");
  if (!haystack) return "none";

  if (addressNamesArea(haystack, vacancy.areaName)) return "area";

  // The governorate comes from whichever field names one, address first: it is the longer and more
  // specific string, and a governorate column reading "Cairo" beside an address reading
  // "Alexandria, Egypt (willing to relocate to Cairo if available Post)" is a real row on file.
  const candidateGovernorate = governorateOf(input.address) ?? governorateOf(input.governorate);
  if (!candidateGovernorate) return "none";
  const seatGovernorate = areaGovernorate(vacancy.areaName);
  if (seatGovernorate && seatGovernorate === candidateGovernorate) return "governorate";
  return "none";
}

// ── Job title ────────────────────────────────────────────────────────────────

/**
 * A CV's title and a seat's title, reduced to the same handful of families.
 *
 * ORDER IS LOAD-BEARING, and it is why this is a list rather than a map. "HR Coordinator" contains
 * both "hr" and "coordinator"; whichever family is tested first wins, and for that title the right
 * answer is talent acquisition. So the specific families are tested before the generic ones.
 *
 * A title that names two families genuinely is ambiguous — "Medical Representative (assigned as
 * District Manager for 7 months)" is a real title on file — and this resolves it to the senior one.
 * That is a judgement, and it is exactly why the result is a suggestion a person confirms.
 */
const TITLE_FAMILIES: Array<{ family: string; cv: RegExp; seat: RegExp }> = [
  { cv: /regulator|registration|pharmacovigilance/, family: "regulatory", seat: /regulator/ },
  {
    cv: /\bhr\b|human resource|recruit|talent|personnel|people operations|people partner/,
    family: "talent-acquisition",
    seat: /talent|recruit|human resource/,
  },
  {
    cv: /national sales|country manager|sales director|business unit|regional (sales )?manager/,
    family: "national-manager",
    seat: /national sales/,
  },
  {
    cv: /district (sales )?manager|area (sales )?manager|first line manager|sales supervisor|field (sales )?manager/,
    family: "district-manager",
    seat: /district (sales )?manager/,
  },
  {
    // The pharmacy and clinical titles belong here on purpose. In Egypt a medical representative is
    // normally a pharmacy, veterinary or science graduate, and "Pharmacist" is the single commonest
    // current title on file among people who are plainly applying for a rep's job. Leaving it out
    // would silence exactly the candidates this is meant to help.
    cv: /medical rep|med rep|medical sales|pharmaceutical sales|sales rep|product specialist|medical delegate|territory manager|professional medical|pharmacist|pharmacy|veterinar|dentist|physiotherap/,
    family: "medical-rep",
    seat: /medical rep/,
  },
  {
    cv: /office coordinator|office manager|administrat|secretar|receptionist|coordinator/,
    family: "office-coordinator",
    seat: /office coordinator/,
  },
];

/**
 * What the CV's own titles say about which kind of seat this is.
 *
 * THREE ANSWERS, NOT TWO, and the third is the one that matters. "The CV named a job and it is not
 * one we are hiring for" is a different fact from "the CV named no job at all", and collapsing them
 * offered a primary lawyer living in Nasr City two medical representative seats — on the strength of
 * his address alone, because an unrecognised title left every seat eligible. A stated job we have no
 * opening for is a reason to stay quiet.
 */
type FamilyVerdict =
  | { kind: "family"; family: string }
  /** The CV named a job, and no open seat is that job. */
  | { kind: "unmatched" }
  /** The CV named no job at all — 24 rows on file. The address is then the only thing to go on. */
  | { kind: "silent" };

function candidateFamily(input: SuggestionInput): FamilyVerdict {
  const text = normalize([input.currentJobTitle, input.appliedForJobTitle].filter(Boolean).join(" "));
  if (text) {
    for (const entry of TITLE_FAMILIES) {
      if (entry.cv.test(text)) return { family: entry.family, kind: "family" };
    }
  }
  // The extraction judged the person to have carried a bag. That is the same claim a title would
  // have made, and on 154 CVs it is the only one made at all — so it also overrides a title that
  // matched nothing, since a stated rep history outranks an unrecognised job description.
  if (input.hasMedicalRepExperience === true) return { family: "medical-rep", kind: "family" };
  return text ? { kind: "unmatched" } : { kind: "silent" };
}

/** The family a seat belongs to, or null for a title no family claims. */
function seatFamily(jobTitle: string): string | null {
  const text = normalize(jobTitle);
  for (const entry of TITLE_FAMILIES) {
    if (entry.seat.test(text)) return entry.family;
  }
  return null;
}

// ── Reasons ──────────────────────────────────────────────────────────────────

/**
 * Why this seat, in words a recruiter can check against the CV in front of them.
 *
 * A reason is only ever a fact already on the row — where the person lives, what they do now. No
 * score, no percentage, no confidence language: a number invites trusting the number instead of
 * reading the CV, and the whole design puts a person at the end.
 */
function reasonsFor(input: SuggestionInput, tier: PlaceTier, family: string | null): string[] {
  const reasons: string[] = [];
  const where = String(input.address ?? "").trim() || String(input.governorate ?? "").trim();
  if (tier === "area" && where) reasons.push(`Address names this area — ${where}`);
  else if (tier === "governorate" && where) reasons.push(`Lives in the same governorate — ${where}`);

  const title = String(input.currentJobTitle ?? "").trim();
  if (family && title) reasons.push(`Currently ${title}`);
  else if (family === "medical-rep" && input.hasMedicalRepExperience === true) {
    reasons.push("Has medical representative experience");
  }
  return reasons;
}

// ── The answer ───────────────────────────────────────────────────────────────

const TIER_RANK: Record<PlaceTier, number> = { area: 2, governorate: 1, none: 0 };

/**
 * Past this many equally-good seats, the honest answer is nothing.
 *
 * A "shortlist" of twelve is not a shortlist, it is the picker with extra steps — and worse, it
 * carries an air of having been narrowed. Twelve open seats sit in Cairo governorate, so a CV whose
 * whole address reads "Cairo, Egypt" genuinely cannot be placed; showing all twelve would dress
 * that up as help. The recruiter opens the full list instead, which is what they would have done.
 */
const MAX_SHORTLIST = 5;

/**
 * Suggest which open seat a CV was sent for.
 *
 * TITLE FILTERS, PLACE RANKS — in that order, and the order is what keeps the answer honest. Take
 * a Cairo medical rep: one of the open seats sits in an area literally called "Cairo", and it is a
 * District Sales Manager post. Ranking by place first would name that seat outright, because the
 * address says "Cairo" and no other area name does. Filtering by title first drops it from
 * consideration, the address then matches seven Cairo areas equally, and the honest answer comes
 * back instead: a shortlist, with nothing pre-filled.
 *
 * ONE SURVIVOR IS A SUGGESTION; SEVERAL ARE A SHORTLIST. Nothing is pre-filled on a tie. A picker
 * that opens with one of several equally-likely seats already chosen is worse than one that opens
 * empty, because the pre-filled value is the one that gets confirmed — and the wrong seat files a
 * real person under a folder the manager hiring for them will never open.
 */
export function suggestPositions(
  input: SuggestionInput,
  vacancies: readonly VacancyOption[],
): SuggestionResult {
  const verdict = candidateFamily(input);
  // A job we are not hiring for. Say nothing rather than offering the nearest seat to their house.
  if (verdict.kind === "unmatched") return { confident: null, shortlist: [] };
  const family = verdict.kind === "family" ? verdict.family : null;

  // Seats this person could hold. When the CV named no job at all, every seat stays in — the place
  // ranking below still narrows it, and dropping everything would turn "the CV did not say" into
  // "there is nothing for you", which is a different and wrong answer.
  const eligible = family
    ? vacancies.filter((vacancy) => seatFamily(vacancy.jobTitle) === family)
    : [...vacancies];
  if (eligible.length === 0) return { confident: null, shortlist: [] };

  // ONE SEAT OF ITS KIND NEEDS NO ADDRESS. Four of the open seats sit at head office — talent
  // acquisition, regulatory affairs, office coordinator — and one is the national sales manager's,
  // whose area is the whole country. No address on earth names any of those places, so requiring a
  // place signal silenced every one of them: twenty-one HR candidates were being told nothing while
  // the only talent acquisition seat in the company stood open. When the job itself has narrowed the
  // list to a single seat, there is nothing left for an address to decide.
  //
  // AND ONLY WHERE AN ADDRESS COULD NOT HAVE HELPED. The exemption is for seats whose area is not a
  // place a person lives — head office, or the whole country — never merely for a family that
  // happens to have one opening today. Without that condition the rule would pre-fill the last
  // remaining medical representative seat in Aswan for every rep in Egypt, on the strength of the
  // word "representative" and nothing else; and a title regex is a loose thing to hang a real
  // person on. Where the seat has a real area, the address still has to agree.
  if (eligible.length === 1 && areaGovernorate(eligible[0].areaName) === null) {
    const only = eligible[0];
    const placeTier = placeTierFor(input, only);
    const suggestion = { placeTier, reasons: reasonsFor(input, placeTier, family), vacancy: only };
    return { confident: suggestion, shortlist: [suggestion] };
  }

  const scored = eligible.map((vacancy) => ({ placeTier: placeTierFor(input, vacancy), vacancy }));
  const best = scored.reduce((top, entry) => Math.max(top, TIER_RANK[entry.placeTier]), 0);
  // No place signal anywhere. A title alone cannot choose between 39 medical rep seats spread over
  // 20 governorates, and offering all 39 as a "shortlist" is just the picker again.
  if (best === 0) return { confident: null, shortlist: [] };

  const survivors = scored
    .filter((entry) => TIER_RANK[entry.placeTier] === best)
    .map((entry) => ({
      placeTier: entry.placeTier,
      reasons: reasonsFor(input, entry.placeTier, family),
      vacancy: entry.vacancy,
    }))
    .sort(
      (left, right) =>
        (left.vacancy.areaName ?? "").localeCompare(right.vacancy.areaName ?? "") ||
        (left.vacancy.lineName ?? "").localeCompare(right.vacancy.lineName ?? "") ||
        left.vacancy.jobTitle.localeCompare(right.vacancy.jobTitle),
    );

  if (survivors.length > MAX_SHORTLIST) return { confident: null, shortlist: [] };

  return {
    confident: survivors.length === 1 ? survivors[0] : null,
    shortlist: survivors,
  };
}
