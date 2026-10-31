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

import {
  addressNamesArea,
  areaGovernorate,
  governorateNamedBy,
  neighbourhoodMatchStrength,
  normalizePlaceText,
} from "@/lib/recruitment/cv-address-place";
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
export const PLACE_TIERS = ["none", "governorate", "neighbourhood", "area"] as const;
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

// ── Place ────────────────────────────────────────────────────────────────────
//
// Every place helper this file used to define now lives in cv-address-place.ts, moved there
// unchanged on 2026-09-03 with its comments and its corrections intact. Nothing about the matching
// changed; what changed is who can reach it. district-manager-folders.ts asks the identical
// question of the identical string — which area does this CV's own text name — and could not call
// any of it from here, so a CV that plainly said Nasr City was sitting in a folder called
// "No area named". The Egypt vocabulary is still imported and still not copied; it is imported one
// level further out, by the module both callers now share.

/**
 * How firmly this CV points at this seat's area.
 *
 * "area" means the address named it. "governorate" means the address named somewhere in the same
 * governorate — which in this company narrows to a SET of seats, never to one: the sales geography
 * has areas and bricks and no governorate layer, so Cairo alone covers twelve open seats. Saying
 * "governorate" rather than pretending to more is the entire reason there are two tiers.
 */
type PlaceMatch = {
  tier: PlaceTier;
  /**
   * How many words of a neighbourhood name the address satisfied. Zero at every other tier — it
   * ranks seats WITHIN the neighbourhood rung and nowhere else.
   */
  strength: number;
};

function placeMatchFor(input: SuggestionInput, vacancy: VacancyOption): PlaceMatch {
  const address = normalizePlaceText(input.address);
  const governorateText = normalizePlaceText(input.governorate);
  const haystack = [address, governorateText].filter(Boolean).join(" ");
  if (!haystack) return { strength: 0, tier: "none" };

  if (addressNamesArea(haystack, vacancy.areaName)) return { strength: 0, tier: "area" };

  // A NEIGHBOURHOOD IS ITS OWN EVIDENCE, tested before the governorate and independently of it.
  //
  // It was not always. The first version of this matched Arabic to English by consonants alone, put
  // a candidate in Karachi into a Gharbia seat and one in Nigeria into Sohag, and was then patched
  // by refusing to trust the rung unless the governorate already agreed. That patch hid the
  // symptom and kept the fault: "Post Office BOX" and باكوس, Bacos, were still the same word to it,
  // and a CV naming a Cairo governorate would still have taken the wrong Cairo seat.
  //
  // The matcher now reads the vowels Arabic actually writes, so Box is not Bacos, George is not
  // Girga and Matarya is not the airport. That is what makes this rung safe to stand alone — which
  // matters, because a governorate gate would also have thrown away every candidate who named a
  // neighbourhood and left the governorate column blank.
  const strength = neighbourhoodMatchStrength(input.address, vacancy.areaName);
  if (strength > 0) return { strength, tier: "neighbourhood" };

  // The governorate comes from whichever field names one, address first: it is the longer and more
  // specific string, and a governorate column reading "Cairo" beside an address reading
  // "Alexandria, Egypt (willing to relocate to Cairo if available Post)" is a real row on file.
  const candidateGovernorate = governorateNamedBy(input.address) ?? governorateNamedBy(input.governorate);
  if (!candidateGovernorate) return { strength: 0, tier: "none" };
  const seatGovernorate = areaGovernorate(vacancy.areaName);
  if (!seatGovernorate || seatGovernorate !== candidateGovernorate) return { strength: 0, tier: "none" };
  return { strength: 0, tier: "governorate" };
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
    // The Personnel seat (opened 2026-10-31), tested BEFORE the broad HR family below: that family
    // claims any CV saying "HR", and its seat pattern reads no personnel title, so a Personnel
    // requisition would have matched no family at all and a payroll CV would have been told "keep".
    cv: /personnel|payroll|social insurance/,
    family: "personnel",
    seat: /personnel|payroll/,
  },
  {
    cv: /\bhr\b|human resource|recruit|talent|people operations|people partner/,
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
    // MARKETING'S OWN SEATS, AND THEY MUST BE TESTED BEFORE THE REP FAMILY. A product manager in
    // Egyptian pharma is almost always an ex-representative and usually a pharmacy graduate, so the
    // rep family below claims the title on the word "pharmacist" alone: measured 2026-10-16, a CV
    // reading "Product Manager" came back with no family at all, which this file treats as "a job we
    // are not hiring for" — and so both synthetic Product Manager CVs were told "keep" while the
    // Product Manager requisition stood open. Specific before generic, and the senior reading wins.
    cv: /product (group )?manager|brand manager|marketing manager|group marketing/,
    family: "product-manager",
    seat: /product manager|brand manager|marketing manager/,
  },
  {
    // The training seat has the same hole, and the same cause — "Training Manager" named no family.
    // Kept narrow to the managing and specialist forms: a representative who also trains in the
    // field is a representative, and the rep family below must keep that CV.
    cv: /training (manager|specialist|supervisor|head|officer|lead)|learning (and|&) development|\bl ?& ?d\b|sfe (manager|supervisor|specialist)/,
    family: "training",
    seat: /training/,
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
  const text = normalizePlaceText([input.currentJobTitle, input.appliedForJobTitle].filter(Boolean).join(" "));
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
  const text = normalizePlaceText(jobTitle);
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
  else if (tier === "neighbourhood" && where) reasons.push(`Address names a neighbourhood of this area — ${where}`);
  else if (tier === "governorate" && where) reasons.push(`Lives in the same governorate — ${where}`);

  const title = String(input.currentJobTitle ?? "").trim();
  if (family && title) reasons.push(`Currently ${title}`);
  else if (family === "medical-rep" && input.hasMedicalRepExperience === true) {
    reasons.push("Has medical representative experience");
  }
  return reasons;
}

// ── The answer ───────────────────────────────────────────────────────────────

/**
 * The ranking, and the reason PLACE_TIERS is exported beside it.
 *
 * An exhaustive `Record<Union, X>` does NOT gate the build in this repository — next.config sets
 * `typescript: { ignoreBuildErrors: true }`, so adding a tier and forgetting to rank it compiles,
 * builds and deploys, and every seat at the new tier then sorts on `undefined`. That has happened
 * here before, in a different Record, and it scattered 63 real candidates through a screening queue
 * at random. Both are exported so a registered test can walk the union at RUNTIME and prove every
 * member has a real number — see the position suggestion test.
 */
export const TIER_RANK: Record<PlaceTier, number> = { area: 3, neighbourhood: 2, governorate: 1, none: 0 };

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
 * A TIE-BREAK, NOT A GATE. Used only to choose between seats that are already tied, and it can
 * never be the reason a candidate is told nothing.
 *
 * Two candidates on file land on a shortlist purely because one Arabic name is two places on the
 * map: "Dayrout, Asyut" reaches Dayrout in Assiut and the other one in Beheira, and "Matarya"
 * reaches Cairo and Dakahlia both, which is the behaviour the owner asked for. In each case the CV
 * had already said which — "Asyut" is in the address itself, and the governorate column reads
 * Dakahlia — so offering the second seat is offering something the candidate has contradicted.
 *
 * WHY THIS IS SAFE WHERE A GATE WAS NOT. An earlier version refused any neighbourhood match whose
 * governorate disagreed, and measuring it showed that deleted 52 candidates' answers: plenty of CVs
 * name a neighbourhood and leave the governorate blank, and plenty more state it wrongly — one
 * address on file reads "Zagazig, sharkia" beside a governorate column saying Cairo. So the rule
 * here narrows ONLY when some seats agree and others do not. If none agree the list is returned
 * untouched, which is what keeps Bahteem — a Qalyubia address that this company serves from Cairo
 * West, deliberately — pointing at the seat that actually covers it.
 *
 * It is also inert at the governorate tier by construction: every seat there matched BECAUSE its
 * governorate is the stated one, so they all agree and nothing is dropped.
 */
function settleByGovernorate<T extends { vacancy: VacancyOption }>(
  input: SuggestionInput,
  survivors: readonly T[],
): readonly T[] {
  if (survivors.length < 2) return survivors;
  // Address first, for the same reason placeMatchFor reads it first: it is the longer and more
  // specific string, and it is where a candidate writes the truth when the column is wrong.
  const stated = governorateNamedBy(input.address) ?? governorateNamedBy(input.governorate);
  if (!stated) return survivors;
  const agreeing = survivors.filter((entry) => areaGovernorate(entry.vacancy.areaName) === stated);
  // NOTHING AGREES is the load-bearing half: without it a disagreeing governorate would empty the
  // list, which is the gate this deliberately is not. EVERYTHING AGREES returns the same set either
  // way and is here to say so plainly rather than to change an outcome.
  if (agreeing.length === 0 || agreeing.length === survivors.length) return survivors;
  return agreeing;
}

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
    const placeTier = placeMatchFor(input, only).tier;
    const suggestion = { placeTier, reasons: reasonsFor(input, placeTier, family), vacancy: only };
    return { confident: suggestion, shortlist: [suggestion] };
  }

  const scored = eligible.map((vacancy) => {
    const match = placeMatchFor(input, vacancy);
    return { placeTier: match.tier, strength: match.strength, vacancy };
  });
  const best = scored.reduce((top, entry) => Math.max(top, TIER_RANK[entry.placeTier]), 0);
  // No place signal anywhere. A title alone cannot choose between 39 medical rep seats spread over
  // 20 governorates, and offering all 39 as a "shortlist" is just the picker again.
  if (best === 0) return { confident: null, shortlist: [] };

  // Within the winning tier, the most specific reading of the address wins outright — see
  // neighbourhoodMatchStrength for why "Dar Al-Salam, Sohag" is one seat and not two.
  const bestStrength = scored.reduce(
    (top, entry) => (TIER_RANK[entry.placeTier] === best ? Math.max(top, entry.strength) : top),
    0,
  );

  const survivors = scored
    .filter((entry) => TIER_RANK[entry.placeTier] === best && entry.strength === bestStrength)
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

  // Last, and only among seats that are otherwise equal: the governorate the CV itself states.
  const settled = settleByGovernorate(input, survivors);

  if (settled.length > MAX_SHORTLIST) return { confident: null, shortlist: [] };

  return {
    confident: settled.length === 1 ? settled[0] : null,
    shortlist: [...settled],
  };
}
