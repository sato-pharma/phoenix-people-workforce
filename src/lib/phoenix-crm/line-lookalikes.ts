/**
 * Phoenix CRM — the same customer on another line, written differently: the list the Super Admin confirms
 * one by one (owner, 2026-11-16: "Deep audit and find similar customers in different reps, same area,
 * different lines", then, asked as a choice, "Fix rule + review list" — "put the ready groups on a list for
 * the Super Admin to confirm one by one. Nothing is validated without that confirmation").
 *
 * The three-lines rule (`line-twins.ts`) validates a waiting row on its own only when the name is the same
 * name of three words or more. The audit of 16 Nov 2026 found the same doctor or account written another
 * way on another line of the same area — a word spelled differently, the words in another order, a middle
 * name left out, the same phone number — validated on one line and still waiting on another. Those are
 * NEVER validated by the system: each becomes one row of this list, and only the Super Admin's
 * confirmation validates the waiting row, from the validated line's places, through the same
 * `phoenix_crm_share_line_validation` the three-lines rule uses.
 *
 * Pure and screen-free: the board, the confirmation and the test share ONE rule. Account:
 * docs/phoenix-crm-line-lookalikes.md.
 *
 * 🔴 ONLY WHAT THE RULE DID NOT ALREADY PAIR — a pair `areLineTwins` accepts is the rule's to share, never
 * this list's.
 * 🔴 ONLY CERTAIN AND VERY LIKELY — a looser match (two common names one letter apart, a family name
 * shared by many doctors, a known speciality against it) never reaches the list.
 * 🔴 ONLY A ROW THAT COULD BE VALIDATED — still waiting, no place, nothing waiting on it, and a clinic
 * doctor written with all three names (`waitingRefusal`). Pharmacies are never here: no line shares a
 * pharmacy's validation.
 * 🔴 TWO FACILITIES OF DIFFERENT KINDS ARE NEVER ONE — `sameFacilityKind`, the same guard the rule holds.
 *
 * 🔴 TWO VALIDATED ROWS JOIN ON HIS WORD TOO (owner, 2026-11-17: "if same dr different reps visit but he is in
 * phoenix recognized as 2 … i want phx 2 recognize as 1", then "and also the pedia", then "Yes, add to 482").
 * Where BOTH lines validated the customer under names written differently, the rule never joins them, so he
 * stayed two. `planLineLookalikeJoins` lists such a pair (all three lines, Pedia included) when their own
 * places sit within `AGREE_METERS`; his "Same customer" moves the weaker row's photo and pin places onto the
 * stronger one's point (`planLookalikeJoin`, the rule's own merge), and the answer makes Place checks show
 * them as one reading.
 */

import { AGREE_METERS, specialityFamily } from "@/lib/phoenix-crm/customer-match-groups";
import { distanceMeters } from "@/lib/phoenix-crm/geo";
import {
  areLineTwins,
  compareAnchors,
  isOwnPlace,
  LINE_TWIN_SAME_POINT_METERS,
  pickSharePlaces,
  sameFacilityKind,
  twinNameWords,
  waitingRefusal,
  type LineTwinMove,
  type TwinCustomer,
  type TwinPlace,
  type WaitingRefusal,
} from "@/lib/phoenix-crm/line-twins";
import type { ValidatedPlaceRow } from "@/lib/phoenix-crm/view-types";

/** A row as this list reads it: the three-lines rule's row, with the contact details it compares too. */
export type LookalikeCustomer = TwinCustomer & {
  phone: string | null;
  /** The old CRM's contact this row was imported from. */
  referenceContactId: string | null;
};

export type LookalikeInput = {
  customers: ReadonlyArray<LookalikeCustomer>;
  places: ReadonlyArray<TwinPlace>;
  /** `pairKey`s the Super Admin answered "Not the same" — never asked again. */
  notSame: ReadonlySet<string>;
  /** `pairKey`s he answered "Same customer" — a joined pair is not listed again. */
  confirmed?: ReadonlySet<string>;
};

export type LookalikeConfidence = "certain" | "very_likely";

export const LOOKALIKE_CONFIDENCE_TEXT: Record<LookalikeConfidence, string> = {
  certain: "Certain",
  very_likely: "Very likely",
};

/** How the two names compare, once spelling is folded. */
export type LookalikeNameKind =
  | "same"
  | "same2"
  | "same1"
  | "prefix3"
  | "prefix2"
  | "typo"
  | "typo2"
  | "prefix_typo"
  | "reordered"
  | "middle_dropped"
  | "name_differs";

export const LOOKALIKE_NAME_TEXT: Record<LookalikeNameKind, string> = {
  same: "The same name, spelled another way",
  same2: "The same two-word name",
  same1: "The same one-word name",
  prefix3: "One list writes more of the name",
  prefix2: "A two-word name opens the longer one",
  typo: "One word of the name spelled differently",
  typo2: "A two-word name, one word spelled differently",
  prefix_typo: "A longer name, and one word spelled differently",
  reordered: "The same words in another order",
  middle_dropped: "A middle name left out on one list",
  name_differs: "One name differs",
};

/** One waiting row and one validated row on another line of its area that look like one customer. */
export type LineLookalike = {
  /** `pairKey(waiting, source)`. */
  key: string;
  waitingCustomerId: string;
  sourceCustomerId: string;
  listType: "AM" | "PM";
  confidence: LookalikeConfidence;
  nameKind: LookalikeNameKind | null;
  samePhone: boolean;
  sameOldCrmContact: boolean;
  /** Both rows carry a speciality, of different families. */
  specialityDiffers: boolean;
  /** The waiting rep's own list matches this validated row more than once. */
  twiceOnWaitingList: boolean;
  /** The places the waiting row would take: the best point first, never two within 150 m, at most five. */
  sourcePlaceIds: string[];
};

// ── What the screen shows (built by server/line-lookalikes.ts) ──────────────────────────────────────

/** One side of a pair, as the Super Admin reads it. */
export type LineLookalikeSide = {
  customerId: string;
  name: string;
  speciality: string | null;
  line: string | null;
  repName: string;
  territory: string;
};

/**
 * One place the waiting row would take, with the evidence the other line validated it on: the photograph
 * and what Place checks reads beside it — the signboard or timetable read, where the rep stood, the map
 * (owner, 2026-11-17: "must render the validation photo and details"). The same fields, under the same
 * names, as a Place checks row, so the screen draws it with Place checks' own evidence block.
 */
export type LineLookalikePlace = Pick<
  ValidatedPlaceRow,
  | "placeId"
  | "photoPath"
  | "trustedPoint"
  | "photoKind"
  | "photo"
  | "pin"
  | "placeLabel"
  | "sharedPlaceName"
  | "address"
  | "brickName"
  | "areaName"
  | "mapsLink"
  | "schedule"
  | "signboard"
  | "repName"
  | "validatedAtText"
>;

export type LineLookalikeSource = LineLookalikeSide & {
  validatedByName: string | null;
  validatedAtText: string | null;
  /** The places the waiting row would take. */
  placeCount: number;
  brickName: string | null;
  address: string | null;
  /** Those places, each with its photograph and evidence, the best point first. */
  places: LineLookalikePlace[];
};

export type LineLookalikeRow = {
  key: string;
  /** `validate`: the first row still waits. `join`: both are validated, and "Same customer" joins them. */
  mode: "validate" | "join";
  /** A join: the first row's own places, which move onto the second's point. Empty for `validate`. */
  joiningPlaces: LineLookalikePlace[];
  waitingCustomerId: string;
  sourceCustomerId: string;
  listType: "AM" | "PM";
  confidence: LookalikeConfidence;
  confidenceText: string;
  /** Why the two look like one customer. */
  reasons: string[];
  /** What to look at before confirming. */
  warnings: string[];
  region: string | null;
  areaName: string | null;
  waiting: LineLookalikeSide;
  source: LineLookalikeSource;
};

export type LineLookalikeBoard = {
  rows: LineLookalikeRow[];
  certain: number;
  veryLikely: number;
  /** Pairs answered so far, by answer. */
  confirmed: number;
  notSame: number;
};

/** One pair's key, the waiting row first. */
export function pairKey(waitingCustomerId: string, sourceCustomerId: string): string {
  return `${waitingCustomerId}|${sourceCustomerId}`;
}

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/** The owner's spelling rulings (18 Oct 2026) and the hamza, folded for comparison only. */
function looseLetters(word: string): string {
  return word.replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/ء/g, "").replace(/[ذز]/g, "د").replace(/خ/g, "ح");
}

/** A word without its ال, when what is left still has three letters. */
function looseWord(word: string): string {
  const loose = looseLetters(word);
  return loose.startsWith("ال") && loose.length >= 5 ? loose.slice(2) : loose;
}

/** Speciality words a list writes into a doctor's name ("احمد علي باطنه") — not part of the name. */
const SPECIALITY_WORDS: ReadonlySet<string> = new Set(
  [
    "باطنه", "باطنيه", "اطفال", "انف", "واذن", "اذن", "حنجره", "وحنجره", "مخ", "واعصاب", "اعصاب", "صدر", "صدريه",
    "جلديه", "جلد", "عظام", "مسالك", "نسا", "ونسا", "توليد", "وتوليد", "قلب", "جراحه", "نفسيه", "نفسي", "سكر",
    "روماتيزم", "اسنان", "عيون", "رمد", "استشاري", "اخصائي", "ممارس", "عام", "neuro", "im", "ent", "gp", "pedia",
  ].map(looseLetters),
);

/** A doctor's name words: folded, each compound one word, speciality words after the given name dropped. */
function doctorWords(name: string): string[] {
  const words = twinNameWords(name)
    .map(looseWord)
    .filter((word) => word.length > 1 && !/^\d+$/.test(word));
  return words.filter((word, at) => at === 0 || !SPECIALITY_WORDS.has(word));
}

/** Words every hospital name carries. */
const ACCOUNT_GENERIC: ReadonlySet<string> = new Set(
  ["مستشفي", "مستشفيات", "م", "مسشتفي", "hospital", "تعاقد", "شركه"].map(looseLetters),
);
/** Which hospital of its kind — compared by `sameFacilityKind`, not as a name word. */
const ACCOUNT_DESCRIPTORS: ReadonlySet<string> = new Set(
  ["عام", "عامه", "مركزي", "مركزيه", "تخصصي", "خاص", "شامل", "شامله", "دولي", "استثماري", "حكومي"].map(looseLetters),
);

/** An account's name words: folded, the generic hospital words and the descriptors left out. */
export function accountWords(name: string): string[] {
  return String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(looseWord)
    .filter((word) => word.length > 1 && !ACCOUNT_GENERIC.has(word) && !ACCOUNT_DESCRIPTORS.has(word));
}

/** Damerau–Levenshtein distance (optimal string alignment); 9 when the lengths are more than two apart. */
function editDistance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 2) return 9;
  const grid = Array.from({ length: left.length + 1 }, (_, row) => [row, ...Array<number>(right.length).fill(0)]);
  for (let column = 0; column <= right.length; column += 1) grid[0][column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      grid[row][column] = Math.min(grid[row - 1][column] + 1, grid[row][column - 1] + 1, grid[row - 1][column - 1] + cost);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        grid[row][column] = Math.min(grid[row][column], grid[row - 2][column - 2] + 1);
      }
    }
  }
  return grid[left.length][right.length];
}

/**
 * One word slipped in the typing — never a long vowel added or dropped: محمد/محمود, سعد/سعيد and حسن/حسين
 * are different men (the owner's ruling, 18 Oct 2026).
 */
export function nearWord(left: string, right: string): boolean {
  if (left === right) return true;
  const shorter = Math.min(left.length, right.length);
  if (shorter < 4) return false;
  if (left.length !== right.length) {
    const [short, long] = left.length < right.length ? [left, right] : [right, left];
    for (let at = 0; at < long.length; at += 1) {
      if ("اوي".includes(long[at]) && long.slice(0, at) + long.slice(at + 1) === short) return false;
    }
  }
  const distance = editDistance(left, right);
  return distance === 1 || (distance === 2 && shorter >= 7);
}

/** How two names compare; null when they are not one name. `commonGiven`: given names too common to be a slip. */
export function compareLookalikeNames(
  leftWords: ReadonlyArray<string>,
  rightWords: ReadonlyArray<string>,
  commonGiven: ReadonlySet<string>,
): LookalikeNameKind | null {
  if (leftWords.length === 0 || rightWords.length === 0) return null;
  const [short, long] = leftWords.length <= rightWords.length ? [leftWords, rightWords] : [rightWords, leftWords];
  const equal = short.length === long.length && short.every((word, at) => word === long[at]);
  if (equal) return short.length >= 3 ? "same" : short.length === 2 ? "same2" : "same1";
  if (short.length >= 2 && short.every((word, at) => long[at] === word)) return short.length >= 3 ? "prefix3" : "prefix2";
  const slips: number[] = short.map((word, at) => (word === long[at] ? 0 : nearWord(word, long[at]) ? 1 : 9));
  const slipped = slips.reduce((total, slip) => total + slip, 0);
  if (short.length === long.length && short.length >= 2) {
    if (slipped === 1 && (slips[0] === 0 || short[0].length >= 5)) {
      const at = slips.indexOf(1);
      // محمد / احمد are two common names, not a slip: a different father's name may be a relative.
      if (commonGiven.has(short[at]) && commonGiven.has(long[at])) return "name_differs";
      return short.length >= 3 ? "typo" : "typo2";
    }
    if (short.length >= 3 && [...short].sort().join(" ") === [...long].sort().join(" ")) return "reordered";
  }
  if (short.length >= 3 && long.length > short.length && slipped === 1 && slips[0] === 0) return "prefix_typo";
  // The given and the family name kept, a middle name left out: "احمد حسن" / "احمد محمد حسن".
  if (short.length >= 2 && long.length >= 3 && short[0] === long[0] && short[short.length - 1] === long[long.length - 1]) {
    let next = 1;
    for (let at = 1; at < short.length - 1; at += 1) {
      while (next < long.length - 1 && long[next] !== short[at]) next += 1;
      if (next >= long.length - 1) return null;
      next += 1;
    }
    return "middle_dropped";
  }
  return null;
}

/** The last ten digits of a phone number, Arabic digits read as Western; null when shorter. */
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x660))
    .replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// ── How sure ─────────────────────────────────────────────────────────────────────────────────────

/** A first word this many doctors share across the country is a common given name. */
const COMMON_GIVEN_AT = 15;
/** A family name this rare backs a "middle name left out" match. */
const RARE_FAMILY_NAME_AT = 15;
/** An account's one-word name this rare is one account. */
const RARE_ACCOUNT_WORD_AT = 12;

const STRONG_DOCTOR_NAMES: ReadonlySet<LookalikeNameKind> = new Set(["same", "prefix3", "typo", "prefix_typo", "reordered"]);
const ACCOUNT_NAMES: ReadonlySet<LookalikeNameKind> = new Set(["same", "same2", "typo", "typo2", "reordered", "prefix3"]);

type Tier = "A" | "B" | "C";

function demote(tier: Tier | null): Tier | null {
  return tier === "A" ? "B" : tier === "B" ? "C" : tier;
}

/** A gp or unknown speciality never separates two doctors. */
function hardFamily(speciality: string | null): string | null {
  const family = specialityFamily(speciality);
  return family === null || family === "gp" ? null : family;
}

type Indexed = {
  customers: LookalikeCustomer[];
  words: Map<string, string[]>;
  liveWords: Map<string, string[]>;
  ownPlaces: Map<string, TwinPlace[]>;
  activePlaces: Map<string, number>;
  wordCounts: Record<"AM" | "PM", Map<string, number>>;
  commonGiven: Set<string>;
};

function isDoctorList(listType: string): listType is "AM" | "PM" {
  return listType === "AM" || listType === "PM";
}

function indexLookalikes(input: Pick<LookalikeInput, "customers" | "places">): Indexed {
  const byId = new Map<string, LookalikeCustomer>();
  for (const customer of input.customers) if (isDoctorList(customer.listType) && !byId.has(customer.id)) byId.set(customer.id, customer);
  const customers = [...byId.values()];
  const words = new Map(customers.map((customer) => [customer.id, customer.listType === "AM" ? accountWords(customer.name) : doctorWords(customer.name)]));
  const liveWords = new Map(customers.map((customer) => [customer.id, twinNameWords(customer.name)]));
  const ownPlaces = new Map<string, TwinPlace[]>();
  const activePlaces = new Map<string, number>();
  const seen = new Set<string>();
  for (const place of input.places) {
    if (seen.has(place.id) || !byId.has(place.customerId)) continue;
    seen.add(place.id);
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) continue;
    activePlaces.set(place.customerId, (activePlaces.get(place.customerId) ?? 0) + 1);
    if (!isOwnPlace(place)) continue;
    const held = ownPlaces.get(place.customerId);
    if (held) held.push(place);
    else ownPlaces.set(place.customerId, [place]);
  }
  const wordCounts: Indexed["wordCounts"] = { AM: new Map(), PM: new Map() };
  const firstWords = new Map<string, number>();
  for (const customer of customers) {
    const held = words.get(customer.id) ?? [];
    const counts = wordCounts[customer.listType as "AM" | "PM"];
    for (const word of new Set(held)) counts.set(word, (counts.get(word) ?? 0) + 1);
    if (customer.listType === "PM" && held[0]) firstWords.set(held[0], (firstWords.get(held[0]) ?? 0) + 1);
  }
  const commonGiven = new Set([...firstWords].filter(([, count]) => count >= COMMON_GIVEN_AT).map(([word]) => word));
  return { customers, words, liveWords, ownPlaces, activePlaces, wordCounts, commonGiven };
}

/** A Phoenix validation another line may take: active, validated, with a place of its own. */
function isSource(index: Indexed, customer: LookalikeCustomer): boolean {
  return customer.status === "active" && customer.validatedAt !== null && (index.ownPlaces.get(customer.id)?.length ?? 0) > 0;
}

/** The two rows could be one customer at all: one world, one area, one list, two lines, two seats. */
function comparable(waiting: LookalikeCustomer, source: LookalikeCustomer): boolean {
  if (waiting.id === source.id || waiting.isTest !== source.isTest || waiting.seatId === source.seatId) return false;
  if (!waiting.lineCode || !source.lineCode || waiting.lineCode === source.lineCode) return false;
  if (!waiting.areaCode || waiting.areaCode !== source.areaCode) return false;
  return waiting.listType === source.listType && isDoctorList(waiting.listType);
}

type Judged = Omit<LineLookalike, "key" | "waitingCustomerId" | "sourceCustomerId" | "listType" | "twiceOnWaitingList" | "sourcePlaceIds">;

/** How sure the list is that two comparable rows are one customer; null below Very likely. */
function judge(index: Indexed, waiting: LookalikeCustomer, source: LookalikeCustomer): Judged | null {
  const leftWords = index.words.get(waiting.id) ?? [];
  const rightWords = index.words.get(source.id) ?? [];
  const samePhone = phoneKey(waiting.phone) !== null && phoneKey(waiting.phone) === phoneKey(source.phone);
  const sameOldCrmContact = waiting.referenceContactId !== null && waiting.referenceContactId === source.referenceContactId;
  const nameKind = compareLookalikeNames(leftWords, rightWords, index.commonGiven);
  const leftFamily = specialityFamily(waiting.speciality);
  const rightFamily = specialityFamily(source.speciality);
  const specialityDiffers = leftFamily !== null && rightFamily !== null && leftFamily !== rightFamily;
  let tier: Tier | null = null;

  if (waiting.listType === "PM") {
    const firstAgrees = leftWords[0] !== undefined && leftWords[0] === rightWords[0];
    const shorter = leftWords.length <= rightWords.length ? leftWords : rightWords;
    const familyName = shorter[shorter.length - 1];
    if (nameKind === "name_differs") tier = null;
    else if ((samePhone || sameOldCrmContact) && (nameKind !== null || firstAgrees)) tier = "A";
    else if (nameKind !== null && STRONG_DOCTOR_NAMES.has(nameKind)) tier = "B";
    else if (nameKind === "middle_dropped" && (index.wordCounts.PM.get(familyName) ?? 0) <= RARE_FAMILY_NAME_AT) tier = "B";
    const hardClash = hardFamily(waiting.speciality) !== null && hardFamily(source.speciality) !== null && hardFamily(waiting.speciality) !== hardFamily(source.speciality);
    if (hardClash) tier = demote(tier);
  } else {
    if (!sameFacilityKind(waiting.name, source.name)) return null;
    if ((samePhone || sameOldCrmContact) && nameKind !== null) tier = "A";
    else if (nameKind !== null && ACCOUNT_NAMES.has(nameKind)) tier = "B";
    else if (nameKind === "same1" && (index.wordCounts.AM.get(leftWords[0]) ?? 0) <= RARE_ACCOUNT_WORD_AT) tier = "B";
  }

  if (tier !== "A" && tier !== "B") return null;
  return { confidence: tier === "A" ? "certain" : "very_likely", nameKind, samePhone, sameOldCrmContact, specialityDiffers };
}

/** Why a waiting row is not on the list, or cannot be confirmed now. */
export type LookalikeRefusal =
  | WaitingRefusal
  | "not_found"
  | "source_not_validated"
  | "not_comparable"
  | "rule_pairs_them"
  | "answered_not_same"
  | "not_validated"
  | "too_far"
  | "cannot_move";

export const LOOKALIKE_REFUSAL_TEXT: Record<LookalikeRefusal, string> = {
  not_waiting: "This customer is no longer waiting — it was validated or placed meanwhile.",
  in_review: "A validation of this customer already waits for the Super Admin.",
  drop_requested: "A request to drop this customer waits.",
  full_name_held: "This customer's full name waits for the Super Admin.",
  needs_full_name: "A PM customer needs all three names before validation.",
  not_found: "One of the two customers is no longer on a list.",
  source_not_validated: "The other line's customer is no longer validated with a place of its own.",
  not_comparable: "The two customers are not on two lines of one area's same list.",
  rule_pairs_them: "The three-lines rule already pairs these two; it validates the waiting row by itself.",
  answered_not_same: "These two were answered Not the same.",
  not_validated: "One of the two customers is no longer validated with a place of its own.",
  too_far: "Their places are more than 150 m apart — that may be two clinics, so they are not joined.",
  cannot_move: "Both places were set by hand (moved, trusted or a polyclinic), so neither is moved.",
};

/** Every pair on the list: waiting rows a Very likely or Certain look-alike on another line validated. */
export function planLineLookalikes(input: LookalikeInput): LineLookalike[] {
  const index = indexLookalikes(input);
  const sourcesByArea = new Map<string, LookalikeCustomer[]>();
  for (const customer of index.customers) {
    if (!customer.areaCode || !isSource(index, customer)) continue;
    const key = `${customer.isTest ? "t" : "r"}|${customer.listType}|${customer.areaCode}`;
    const held = sourcesByArea.get(key);
    if (held) held.push(customer);
    else sourcesByArea.set(key, [customer]);
  }

  const found: Array<Omit<LineLookalike, "twiceOnWaitingList">> = [];
  for (const waiting of index.customers) {
    if (!waiting.areaCode || waitingRefusal(waiting, index.activePlaces.get(waiting.id) ?? 0) !== null) continue;
    const candidates = sourcesByArea.get(`${waiting.isTest ? "t" : "r"}|${waiting.listType}|${waiting.areaCode}`) ?? [];
    for (const source of candidates) {
      if (!comparable(waiting, source)) continue;
      // Answered EITHER way round: a join card stores (joining, anchor), so when the anchor later waits the key is reversed.
      if (answeredEitherWay(input.notSame, waiting.id, source.id)) continue;
      if (areLineTwins(waiting, source, index.liveWords.get(waiting.id) ?? [], index.liveWords.get(source.id) ?? [])) continue;
      const judged = judge(index, waiting, source);
      if (!judged) continue;
      const sourcePlaceIds = pickSharePlaces(index.ownPlaces.get(source.id) ?? []).map((place) => place.id);
      if (sourcePlaceIds.length === 0) continue;
      found.push({
        key: pairKey(waiting.id, source.id),
        waitingCustomerId: waiting.id,
        sourceCustomerId: source.id,
        listType: waiting.listType as "AM" | "PM",
        ...judged,
        sourcePlaceIds,
      });
    }
  }

  // One validated row matched by two waiting rows of ONE seat: that rep's list holds the customer twice.
  const perSeatSource = new Map<string, number>();
  const seatOf = new Map(index.customers.map((customer) => [customer.id, customer.seatId]));
  for (const pair of found) {
    const key = `${seatOf.get(pair.waitingCustomerId)}|${pair.sourceCustomerId}`;
    perSeatSource.set(key, (perSeatSource.get(key) ?? 0) + 1);
  }
  const confidenceOrder: Record<LookalikeConfidence, number> = { certain: 0, very_likely: 1 };
  return found
    .map((pair) => ({ ...pair, twiceOnWaitingList: (perSeatSource.get(`${seatOf.get(pair.waitingCustomerId)}|${pair.sourceCustomerId}`) ?? 0) > 1 }))
    .sort(
      (left, right) =>
        confidenceOrder[left.confidence] - confidenceOrder[right.confidence] ||
        String(seatOf.get(left.waitingCustomerId)).localeCompare(String(seatOf.get(right.waitingCustomerId))) ||
        left.key.localeCompare(right.key),
    );
}

export type LookalikeConfirmPlan =
  | { ok: true; sourcePlaceIds: string[]; validatedByHrId: string | null; waiting: LookalikeCustomer; source: LookalikeCustomer }
  | { ok: false; refusal: LookalikeRefusal };

/**
 * The Super Admin confirmed one pair: whether it can still be validated, and from which places. The
 * confidence is not asked again — a person has looked — but every guard that keeps a validation honest is.
 */
export function planLookalikeConfirm(input: LookalikeInput, waitingCustomerId: string, sourceCustomerId: string): LookalikeConfirmPlan {
  const index = indexLookalikes(input);
  const waiting = index.customers.find((customer) => customer.id === waitingCustomerId);
  const source = index.customers.find((customer) => customer.id === sourceCustomerId);
  if (!waiting || !source) return { ok: false, refusal: "not_found" };
  const refusal = waitingRefusal(waiting, index.activePlaces.get(waiting.id) ?? 0);
  if (refusal) return { ok: false, refusal };
  if (!isSource(index, source)) return { ok: false, refusal: "source_not_validated" };
  if (!comparable(waiting, source)) return { ok: false, refusal: "not_comparable" };
  if (waiting.listType === "AM" && !sameFacilityKind(waiting.name, source.name)) return { ok: false, refusal: "not_comparable" };
  if (answeredEitherWay(input.notSame, waiting.id, source.id)) return { ok: false, refusal: "answered_not_same" };
  if (areLineTwins(waiting, source, index.liveWords.get(waiting.id) ?? [], index.liveWords.get(source.id) ?? [])) return { ok: false, refusal: "rule_pairs_them" };
  const sourcePlaceIds = pickSharePlaces(index.ownPlaces.get(source.id) ?? []).map((place) => place.id);
  if (sourcePlaceIds.length === 0) return { ok: false, refusal: "source_not_validated" };
  return { ok: true, sourcePlaceIds, validatedByHrId: source.validatedByHrId, waiting, source };
}

// ── Two validated rows: the join ─────────────────────────────────────────────────────────────────────

/** Two validated rows on two lines that look like one customer; his "Same customer" joins them on one point. */
export type LineLookalikeJoin = {
  /** `pairKey(joining, anchor)`. */
  key: string;
  /** The row whose places move. */
  joiningCustomerId: string;
  /** The row whose point they move onto. */
  anchorCustomerId: string;
  listType: "AM" | "PM";
  confidence: LookalikeConfidence;
  nameKind: LookalikeNameKind | null;
  samePhone: boolean;
  sameOldCrmContact: boolean;
  specialityDiffers: boolean;
  /** The anchor place, as the card draws it. */
  anchorPlaceIds: string[];
  joiningPlaceIds: string[];
  /** The moves the join makes — empty when the two already sit on one point. */
  moves: LineTwinMove[];
  /** Whole metres between the two rows' closest places. */
  gapMeters: number;
};

type JoinShape =
  | { ok: true; joining: LookalikeCustomer; anchor: LookalikeCustomer; anchorPlace: TwinPlace; moves: LineTwinMove[]; gapMeters: number }
  | { ok: false; refusal: LookalikeRefusal };

/** Which of two validated rows moves onto which, and how; the order the two are named in does not matter. */
function joinShape(index: Indexed, left: LookalikeCustomer, right: LookalikeCustomer): JoinShape {
  const leftPlaces = index.ownPlaces.get(left.id) ?? [];
  const rightPlaces = index.ownPlaces.get(right.id) ?? [];
  let closest: { a: TwinPlace; b: TwinPlace; meters: number } | null = null;
  for (const a of leftPlaces) {
    for (const b of rightPlaces) {
      const meters = distanceMeters(a, b);
      if (!closest || meters < closest.meters) closest = { a, b, meters };
    }
  }
  if (!closest) return { ok: false, refusal: "not_validated" };
  if (closest.meters > AGREE_METERS) return { ok: false, refusal: "too_far" };
  const pair = [closest.a, closest.b];
  const anchorPlace = [...pair].sort((one, two) => compareAnchors(one, two, pair))[0];
  const [anchor, joining] = anchorPlace.customerId === left.id ? [left, right] : [right, left];
  const joiningPlaces = anchorPlace.customerId === left.id ? rightPlaces : leftPlaces;
  const moves: LineTwinMove[] = [];
  for (const place of joiningPlaces) {
    const gap = distanceMeters(place, anchorPlace);
    if (gap <= LINE_TWIN_SAME_POINT_METERS || gap > AGREE_METERS) continue;
    if (place.pointSource !== "photo" && place.pointSource !== "pin") continue;
    moves.push({
      placeId: place.id,
      customerId: joining.id,
      seatId: place.seatId,
      isTest: joining.isTest,
      fromPointSource: place.pointSource,
      anchorPlaceId: anchorPlace.id,
      anchorCustomerId: anchor.id,
      anchorSeatId: anchorPlace.seatId,
      distanceMeters: Math.round(gap),
    });
  }
  // Nothing can move and they are not on one point yet: both were set by hand, and a join would be a word only.
  if (moves.length === 0 && closest.meters > LINE_TWIN_SAME_POINT_METERS) return { ok: false, refusal: "cannot_move" };
  return { ok: true, joining, anchor, anchorPlace, moves, gapMeters: Math.round(closest.meters) };
}

function answeredEitherWay(set: ReadonlySet<string> | undefined, left: string, right: string): boolean {
  return Boolean(set && (set.has(pairKey(left, right)) || set.has(pairKey(right, left))));
}

/** Every pair of two validated rows, on two lines of one area, that look like one customer and can be joined. */
export function planLineLookalikeJoins(input: LookalikeInput): LineLookalikeJoin[] {
  const index = indexLookalikes(input);
  const byArea = new Map<string, LookalikeCustomer[]>();
  for (const customer of index.customers) {
    if (!customer.areaCode || !isSource(index, customer)) continue;
    const key = `${customer.isTest ? "t" : "r"}|${customer.listType}|${customer.areaCode}`;
    const held = byArea.get(key);
    if (held) held.push(customer);
    else byArea.set(key, [customer]);
  }
  const found: LineLookalikeJoin[] = [];
  for (const group of byArea.values()) {
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        const left = group[a];
        const right = group[b];
        if (!comparable(left, right)) continue;
        if (answeredEitherWay(input.notSame, left.id, right.id) || answeredEitherWay(input.confirmed, left.id, right.id)) continue;
        if (areLineTwins(left, right, index.liveWords.get(left.id) ?? [], index.liveWords.get(right.id) ?? [])) continue;
        const judged = judge(index, left, right);
        if (!judged) continue;
        const shape = joinShape(index, left, right);
        if (!shape.ok) continue;
        found.push({
          key: pairKey(shape.joining.id, shape.anchor.id),
          joiningCustomerId: shape.joining.id,
          anchorCustomerId: shape.anchor.id,
          listType: left.listType as "AM" | "PM",
          ...judged,
          anchorPlaceIds: [shape.anchorPlace.id],
          joiningPlaceIds: (index.ownPlaces.get(shape.joining.id) ?? []).map((place) => place.id),
          moves: shape.moves,
          gapMeters: shape.gapMeters,
        });
      }
    }
  }
  const confidenceOrder: Record<LookalikeConfidence, number> = { certain: 0, very_likely: 1 };
  return found.sort((left, right) => confidenceOrder[left.confidence] - confidenceOrder[right.confidence] || left.key.localeCompare(right.key));
}

export type LookalikeJoinPlan =
  | { ok: true; joining: LookalikeCustomer; anchor: LookalikeCustomer; moves: LineTwinMove[] }
  | { ok: false; refusal: LookalikeRefusal };

/**
 * He confirmed two validated rows are one customer: every guard is asked again on a fresh read, and the moves
 * are planned on the places as they stand. The confidence is not asked again — a person has looked.
 */
export function planLookalikeJoin(input: LookalikeInput, firstCustomerId: string, secondCustomerId: string): LookalikeJoinPlan {
  const index = indexLookalikes(input);
  const first = index.customers.find((customer) => customer.id === firstCustomerId);
  const second = index.customers.find((customer) => customer.id === secondCustomerId);
  if (!first || !second) return { ok: false, refusal: "not_found" };
  if (!isSource(index, first) || !isSource(index, second)) return { ok: false, refusal: "not_validated" };
  if (!comparable(first, second)) return { ok: false, refusal: "not_comparable" };
  if (first.listType === "AM" && !sameFacilityKind(first.name, second.name)) return { ok: false, refusal: "not_comparable" };
  if (answeredEitherWay(input.notSame, first.id, second.id)) return { ok: false, refusal: "answered_not_same" };
  if (areLineTwins(first, second, index.liveWords.get(first.id) ?? [], index.liveWords.get(second.id) ?? [])) return { ok: false, refusal: "rule_pairs_them" };
  const shape = joinShape(index, first, second);
  if (!shape.ok) return shape;
  return { ok: true, joining: shape.joining, anchor: shape.anchor, moves: shape.moves };
}
