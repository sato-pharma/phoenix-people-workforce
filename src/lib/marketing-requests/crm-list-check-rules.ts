/**
 * The list check — is this marketing customer on the rep's own Phoenix CRM list?
 *
 * Owner, 2026-10-27: compare by name, tolerating one letter; compare by address and brick; "The line
 * must match"; the two photos "not more than 500 meters away from each other … you must don't block but
 * flag"; "the marketing request is never on a nursery … compare with the AM list, or for a clinic or
 * doctor, compare with the PM list"; "don't guess in something that you feel you are not confident".
 *
 * So nothing here ever guesses. A customer reads `on_list` only when the name agrees AND the place
 * agrees, or his CRM code is already declared. Any doubt reads `check`, which waits for a person: a
 * false match would hide a doctor nobody holds, which is worse than a row someone has to look at.
 *
 * Pure: no database, no React. The server half is `crm-list-check.ts`.
 *
 * 🔴 IT FLAGS AND NEVER BLOCKS. Nothing here may refuse a request, a validation or an approval.
 * 🔴 A PERSON'S ANSWER WINS. A pick at validation is never overwritten, and a decision on the board
 * beats every later re-check, with one exception: a doctor a person confirmed who has since left the
 * rep's list reads `left_list`, because that is a new fact and not a second opinion.
 */

import { isMatchableName, normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { metresBetween } from "@/lib/crm/location-confidence";
import { CRM_LIST_SAME_PLACE_METRES } from "@/lib/marketing-requests/crm-doctor-pick";

export type ListCheckState = "on_list" | "check" | "not_on_list" | "no_holder" | "left_list" | "no_location";
export type ListCheckNameMatch = "same" | "one_letter" | "part" | "none";
export type ListCheckListType = "AM" | "PM";
export type CrmListSource = "picked" | "typed" | "checked";

/** The owner's own number: within it, two photos stand at the same place. */
export const SAME_PLACE_METRES = CRM_LIST_SAME_PLACE_METRES;

/**
 * How close a DIFFERENT name must stand to be worth a person's look. His 500 m is for a name that already
 * agrees. In a city almost every customer has some other doctor within 500 m: measured 2026-11-03, that
 * reading sent 15 unrelated names to the queue and hid the real questions in it.
 */
export const DIFFERENT_NAME_SAME_PLACE_METRES = 100;

/** Readable states, in the order every screen lists them. */
export const LIST_CHECK_STATE_LABELS: Record<ListCheckState, string> = {
  left_list: "Left the rep's list",
  check: "Needs a person to check",
  not_on_list: "Not on the rep's list",
  no_holder: "No rep holds this area on this line",
  no_location: "No location captured",
  on_list: "On the rep's list",
};
export const LIST_CHECK_STATE_ORDER: readonly ListCheckState[] = ["left_list", "check", "not_on_list", "no_holder", "no_location", "on_list"];

/**
 * Which of the rep's two lists holds this kind of customer. A clinic or a doctor is on the PM list, a
 * hospital or an account on the AM list. `other` could be either, so it searches both and can never
 * reach `on_list` without a person.
 */
export function listTypesForCustomerType(customerType: string | null | undefined): { listTypes: ListCheckListType[]; certain: boolean } {
  const type = String(customerType ?? "").trim().toLowerCase();
  if (type === "clinic" || type === "doctor") return { listTypes: ["PM"], certain: true };
  if (type === "hospital" || type === "account") return { listTypes: ["AM"], certain: true };
  return { listTypes: ["PM", "AM"], certain: false };
}

/** "حضان" is the root of every spelling of nursery on the data: حضانة, حضانه, الحضانات. */
export function looksLikeNursery(name: string | null | undefined): boolean {
  return String(name ?? "").includes("حضان");
}

/** At most one letter added, removed or changed. Early-outs keep it cheap over a whole area's list. */
export function withinOneLetter(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let at = 0;
  while (at < left.length && at < right.length && left[at] === right[at]) at += 1;
  const leftRest = left.slice(at);
  const rightRest = right.slice(at);
  return (
    leftRest.slice(1) === rightRest.slice(1) ||
    leftRest.slice(1) === rightRest ||
    leftRest === rightRest.slice(1)
  );
}

/**
 * The words of a name, the way it is compared. A glued "ابوربع" or "عبدالحميد" is two words, and the
 * article is not a letter of the name ("اللوفي" and "لوفي" are one family).
 */
function comparableWords(key: string): string[] {
  const words = key.split(" ").flatMap((word) => {
    const glued = /^(ابو|عبد)(.{2,})$/u.exec(word);
    return glued ? [glued[1], glued[2]] : [word];
  });
  return words.map((word) => (word.length > 4 && word.startsWith("ال") ? word.slice(2) : word));
}

/**
 * Given names that sit one letter from another real name. His one-letter tolerance is for a typing slip,
 * and أحمد and محمد are two people: measured 2026-11-03, it read "احمد علي" as "محمد علي موسي". Two
 * DIFFERENT words from this set are never the same word. The set holds the folded spelling
 * (`normalizeContactName`), so ى is ي, ة is ه and أ is ا.
 */
const NEAR_TWIN_NAMES: ReadonlySet<string> = new Set([
  "احمد", "محمد", "محمود", "حامد", "حمد", "حمدي", "حسن", "حسين", "حسني", "حسام", "سعد", "سعيد", "سعدي",
  "علي", "علا", "عمر", "عمرو", "عمار", "جمال", "كمال", "كريم", "كرم", "كرمي", "سمير", "سمر", "سميره", "امير", "اميره",
  "امين", "ايمن", "ايمان", "امل", "هاني", "هانيه", "هاله", "هبه", "رامي", "رامز", "سامي", "ساميه", "سامح", "سالم",
  "سليم", "سلامه", "نادر", "ناصر", "نادي", "ناديه", "نبيل", "نبيله", "عادل", "عاطف", "عاصم", "عبد", "عيد", "عبيد",
  "مصطفي", "منير", "منى", "مني", "ماجد", "مجدي", "مجد", "وليد", "خالد", "خليل", "طارق", "طاهر", "ياسر", "ياسين",
  "يسري", "يسرا", "فتحي", "فتحيه", "فوزي", "فوزيه", "شريف", "شريفه", "اشرف", "رشاد", "راشد", "رشيد", "رشدي",
]);

/** A word of one or two letters has no spare letter to tolerate: "لي" and "لو" are not one word. */
function sameWord(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 3 || right.length < 3) return false;
  if (NEAR_TWIN_NAMES.has(left) && NEAR_TWIN_NAMES.has(right)) return false;
  return withinOneLetter(left, right);
}

/** Every word of `few` finds its own word in `many`, an exact word taken first. */
function everyWordFound(few: readonly string[], many: readonly string[]): boolean {
  const left = [...many];
  const take = (test: (other: string) => boolean): boolean => {
    const at = left.findIndex(test);
    if (at >= 0) left.splice(at, 1);
    return at >= 0;
  };
  const inexact = few.filter((word) => !take((other) => other === word));
  return inexact.every((word) => take((other) => sameWord(word, other)));
}

/**
 * How two names compare, after the folding every Arabic comparison in this repo uses.
 *
 *  - `same`: identical, spaces aside ("عبدالحميد" and "عبد الحميد" are one spelling).
 *  - `one_letter`: the same number of words, each within one letter.
 *  - `part`: every word of the shorter name is in the longer one, or the same single word on both
 *    sides, which is never evidence on its own (`isMatchableName`).
 *  - `none`: anything else.
 */
export function compareNames(left: string | null | undefined, right: string | null | undefined): ListCheckNameMatch {
  const leftKey = normalizeContactName(left);
  const rightKey = normalizeContactName(right);
  if (!leftKey || !rightKey) return "none";
  const leftWords = comparableWords(leftKey);
  const rightWords = comparableWords(rightKey);
  const bothMatchable = isMatchableName(leftKey) && isMatchableName(rightKey);
  if (leftWords.join("") === rightWords.join("")) return bothMatchable ? "same" : "part";
  if (!bothMatchable) return "none";
  if (leftWords.length === rightWords.length) return everyWordFound(leftWords, rightWords) ? "one_letter" : "none";
  const [few, many] = leftWords.length < rightWords.length ? [leftWords, rightWords] : [rightWords, leftWords];
  return everyWordFound(few, many) ? "part" : "none";
}

export type ListCheckPoint = { lat: number; lon: number };

/** One validated place of a doctor: his photo's fix when he has one, the brick it was filed in. */
export type ListCheckPlace = { brickId: string | null; photoPath: string | null; point: ListCheckPoint };

/** One row of a rep's AM or PM list in the customer's area and line. */
export type ListCheckCandidate = {
  /** The brick the old contact record was filed in, for a doctor with no validated place yet. */
  contactBrickId: string | null;
  contactId: number | null;
  crmCustomerId: string;
  listType: ListCheckListType;
  name: string;
  /** A doctor may hold more than one place (a morning and an evening clinic). */
  places: readonly ListCheckPlace[];
  seatId: string;
};

/** A row the customer is already tied to, with whether it is still on the list. */
export type ListCheckLinkedRow = ListCheckCandidate & { onList: boolean };

export type ListCheckPrior = {
  decidedState: "on_list" | "not_on_list" | null;
  leftListAt: string | null;
  matchedCrmCustomerId: string | null;
  state: ListCheckState | null;
};

export type ListCheckInput = {
  /** Null when the point fell in no brick we can place. */
  areaCode: string | null;
  brickId: string | null;
  candidates: readonly ListCheckCandidate[];
  crmListSource: CrmListSource | null;
  crmListStatus: "on_list" | "not_on_list" | null;
  customerType: string | null;
  declaredCrmCodes: readonly string[];
  displayName: string;
  /** The row a pick or a past match points at, read whether or not it is still on the list. */
  linkedRow: ListCheckLinkedRow | null;
  /** Whether anyone sits on a rep seat of this area and line. A vacant seat's list still counts as a list. */
  holderOccupied: boolean;
  lineKnown: boolean;
  now: string;
  point: ListCheckPoint | null;
  prior: ListCheckPrior | null;
};

export type ListCheckVerdict = {
  leftListAt: string | null;
  listType: ListCheckListType | null;
  looksLikeNursery: boolean;
  matched: ListCheckCandidate | null;
  metresApart: number | null;
  nameMatch: ListCheckNameMatch | null;
  reason: string;
  sameBrick: boolean | null;
  state: ListCheckState;
};

/** The source a stored row really has. A row saved by code older than the column still tells by its status. */
export function effectiveListSource(row: { crmListSource: CrmListSource | null; crmListStatus: string | null }): CrmListSource | null {
  if (row.crmListSource) return row.crmListSource;
  if (row.crmListStatus === "on_list") return "picked";
  if (row.crmListStatus === "not_on_list") return "typed";
  return null;
}

function metresTo(point: ListCheckPoint, other: ListCheckPoint): number {
  return Math.round(metresBetween(point.lat, point.lon, other.lat, other.lon));
}

/** The doctor's place nearest the customer's: the one the two photos should be compared at. */
export function nearestListCheckPlace(point: ListCheckPoint | null, places: readonly ListCheckPlace[]): { metres: number; place: ListCheckPlace } | null {
  if (!point) return null;
  let best: { metres: number; place: ListCheckPlace } | null = null;
  for (const place of places) {
    const metres = metresTo(point, place.point);
    if (!best || metres < best.metres) best = { metres, place };
  }
  return best;
}

type Scored = {
  candidate: ListCheckCandidate;
  codeDeclared: boolean;
  metres: number | null;
  nameMatch: ListCheckNameMatch;
  sameBrick: boolean | null;
};

function score(input: ListCheckInput, candidate: ListCheckCandidate): Scored {
  const contact = candidate.contactId === null ? null : String(candidate.contactId);
  const bricks = [...candidate.places.map((place) => place.brickId), candidate.contactBrickId].filter((brick): brick is string => Boolean(brick));
  return {
    candidate,
    codeDeclared: contact !== null && input.declaredCrmCodes.includes(contact),
    metres: nearestListCheckPlace(input.point, candidate.places)?.metres ?? null,
    nameMatch: compareNames(input.displayName, candidate.name),
    sameBrick: input.brickId && bricks.length > 0 ? bricks.includes(input.brickId) : null,
  };
}

const nameAgrees = (row: Scored) => row.nameMatch === "same" || row.nameMatch === "one_letter";
const near = (row: Scored) => row.metres !== null && row.metres <= SAME_PLACE_METRES;
/** Part of a name is thinner evidence, so it must stand at the door, not in the same neighbourhood. */
const partlyNear = (row: Scored) => row.nameMatch === "part" && row.metres !== null && row.metres <= DIFFERENT_NAME_SAME_PLACE_METRES;
/**
 * A brick speaks only when there is no distance to read. A brick is a neighbourhood, and two places
 * measured over 500 m apart are his flag whatever brick they share (7.5 km apart read as proven before this).
 */
const nameAndPlace = (row: Scored) => nameAgrees(row) && (near(row) || (row.metres === null && row.sameBrick === true));
const proven = (row: Scored) => row.codeDeclared || partlyNear(row) || nameAndPlace(row);

/** One person may stand on two rows of an area (two reps of a line): they are one match, not two doctors. */
function personOf(row: Scored): string {
  return row.candidate.contactId !== null ? `c:${row.candidate.contactId}` : `n:${normalizeContactName(row.candidate.name)}`;
}

/** Closest first, so the row shown beside the customer is the one a person would compare him with. */
function closest(rows: readonly Scored[]): Scored {
  return [...rows].sort((left, right) => (left.metres ?? Number.MAX_SAFE_INTEGER) - (right.metres ?? Number.MAX_SAFE_INTEGER))[0];
}

/**
 * The verdict for one customer on one line.
 *
 * In order: a person's decision; a pick at validation; then what the place and the list can say. A
 * customer who was on the list and is no longer found reads `left_list`, the case worth acting on.
 */
export function judgeListCheck(input: ListCheckInput): ListCheckVerdict {
  const nursery = looksLikeNursery(input.displayName);
  const source = effectiveListSource(input);
  const { certain } = listTypesForCustomerType(input.customerType);
  const verdict = (
    state: ListCheckState,
    reason: string,
    row: Scored | null = null,
  ): ListCheckVerdict => ({
    leftListAt: state === "left_list" ? (input.prior?.leftListAt ?? input.now) : null,
    listType: row?.candidate.listType ?? null,
    looksLikeNursery: nursery,
    matched: row?.candidate ?? null,
    metresApart: row?.metres ?? null,
    nameMatch: row?.nameMatch ?? null,
    reason,
    sameBrick: row?.sameBrick ?? null,
    state,
  });
  const linked = input.linkedRow ? score(input, input.linkedRow) : null;

  if (input.prior?.decidedState === "not_on_list") {
    return verdict("not_on_list", "A person decided this is not the same doctor.", linked);
  }
  if (input.prior?.decidedState === "on_list") {
    return input.linkedRow?.onList
      ? verdict("on_list", "A person confirmed this is the same doctor.", linked)
      : verdict("left_list", "A person confirmed this doctor, who has since left the rep's list.", linked);
  }
  if (source === "picked") {
    return input.linkedRow?.onList
      ? verdict("on_list", "Picked from the rep's list at validation.", linked)
      : verdict("left_list", "Picked from the rep's list at validation, and no longer on it.", linked);
  }
  const nurseryCheck = (row: Scored | null = null) =>
    verdict("check", "The name says this is a nursery, not a doctor. A marketing request is never on a nursery.", row);
  if (nursery && !input.point) return nurseryCheck();
  if (!input.point) return verdict("no_location", "This customer was captured with no GPS, so no area can be read.");
  if (!input.lineKnown) return verdict("check", "This customer has no request and no line, so no rep's list can be chosen.");
  if (!input.areaCode) return verdict("check", "The GPS point could not be placed in any area.");

  const scored = input.candidates.map((candidate) => score(input, candidate));
  const wasOnList = input.prior?.state === "on_list" || input.prior?.state === "left_list";
  const noLongerFound = () =>
    input.linkedRow?.onList
      ? verdict("check", "Matched on the rep's list before, and the name and place no longer agree.", linked)
      : verdict("left_list", "Was on the rep's list, and that list no longer holds this doctor.", linked);

  const nobodyHolds = () =>
    input.holderOccupied ? verdict("no_holder", "This area and line have no list of this kind.") : verdict("no_holder", "No rep holds this area on this line.");

  if (scored.length === 0) {
    if (nursery) return nurseryCheck();
    return wasOnList ? noLongerFound() : nobodyHolds();
  }

  const provenRows = scored.filter(proven);
  const people = new Set(provenRows.map(personOf));
  if (people.size > 1) return verdict("check", "More than one doctor on the list fits this customer.", closest(provenRows));
  if (provenRows.length > 0) {
    const row = closest(provenRows);
    if (nursery) return nurseryCheck(row);
    if (source === "typed") return verdict("check", "The name was typed by hand at validation, but this doctor looks to be on the rep's list.", row);
    if (!certain) return verdict("check", "This customer's type could be either list, so a person has to confirm it.", row);
    const named = row.nameMatch === "same" ? "Same name" : "Nearly the same name";
    const how = row.codeDeclared
      ? "The CRM code is already declared on this customer."
      : near(row)
        ? `${named}, and the two places are ${row.metres} m apart.`
        : `${named}, and the same brick.`;
    return verdict("on_list", how, row);
  }

  const nameRows = scored.filter(nameAgrees);
  if (nameRows.length > 0) {
    const row = closest(nameRows);
    if (row.metres !== null) return verdict("check", `Same name, but the two places are ${row.metres} m apart.`, row);
    if (row.sameBrick === false) return verdict("check", "Same name, but filed in a different brick.", row);
    return verdict("check", "Same name, but the doctor has no validated place to compare with.", row);
  }

  const partRows = scored.filter((row) => row.nameMatch === "part");
  if (partRows.length > 0) {
    const row = closest(partRows);
    if (row.sameBrick === true) return verdict("check", "Part of the name matches, in the same brick, with no photo to compare.", row);
    if (row.metres !== null) return verdict("check", `Part of the name matches, but the two places are ${row.metres} m apart.`, row);
    return verdict("check", "Part of the name matches, and the doctor has no validated place to compare with.", row);
  }

  const nearRows = scored.filter((row) => row.metres !== null && row.metres <= DIFFERENT_NAME_SAME_PLACE_METRES);
  if (nearRows.length > 0) {
    const row = closest(nearRows);
    return verdict("check", `A different name at the same place, ${row.metres} m apart.`, row);
  }

  if (nursery) return nurseryCheck();
  if (wasOnList) return noLongerFound();
  if (!input.holderOccupied) return nobodyHolds();
  if (source === "typed") return verdict("not_on_list", "Typed by hand at validation, and nobody on the rep's list matches.");
  return verdict("not_on_list", "Nobody on the rep's list matches, by name or by place.");
}

export type ListCheckCustomerWrite = {
  crm_list_source: CrmListSource;
  crm_list_status: "on_list" | "not_on_list" | null;
  phoenix_crm_customer_id: string | null;
};

/**
 * What the verdict writes on the customer's own columns, or null to leave them alone.
 *
 * 🔴 A PICK IS NEVER TOUCHED, AND A TYPED NAME CHANGES ONLY ON A PERSON'S "SAME DOCTOR". Everything else
 * is the check's own earlier answer, so the check may restate it.
 */
export function planListCheckCustomerWrite(input: {
  current: { crmListSource: CrmListSource | null; crmListStatus: "on_list" | "not_on_list" | null; phoenixCrmCustomerId: string | null };
  decidedState: "on_list" | "not_on_list" | null;
  verdict: ListCheckVerdict;
}): ListCheckCustomerWrite | null {
  const source = effectiveListSource(input.current);
  if (source === "picked") return null;
  if (source === "typed" && input.decidedState !== "on_list") return null;
  const { state, matched } = input.verdict;
  const write: ListCheckCustomerWrite =
    state === "on_list"
      ? { crm_list_source: "checked", crm_list_status: "on_list", phoenix_crm_customer_id: matched?.crmCustomerId ?? null }
      : state === "not_on_list" || state === "no_holder" || state === "left_list"
        ? { crm_list_source: "checked", crm_list_status: "not_on_list", phoenix_crm_customer_id: null }
        : { crm_list_source: "checked", crm_list_status: null, phoenix_crm_customer_id: null };
  const unchanged =
    input.current.crmListSource === write.crm_list_source &&
    input.current.crmListStatus === write.crm_list_status &&
    input.current.phoenixCrmCustomerId === write.phoenix_crm_customer_id;
  return unchanged ? null : write;
}

/** The validation states the check covers. A customer outside them leaves the board. */
export const LIST_CHECKED_VALIDATION_STATUSES = ["system_validated", "sfe_validated", "admin_approved"] as const;

/**
 * A customer's rows from his newest pass. Every row of one pass shares `checked_at`, so a row left behind when
 * a customer's only request moved to another line reads older, and can never raise a flag or a board row.
 */
export function currentListCheckRows<Row extends { checked_at?: unknown; customer_id?: unknown }>(rows: readonly Row[]): Row[] {
  const at = (row: Row) => Date.parse(String(row.checked_at ?? "")) || 0;
  const newest = new Map<string, number>();
  for (const row of rows) {
    const customerId = String(row.customer_id);
    newest.set(customerId, Math.max(newest.get(customerId) ?? 0, at(row)));
  }
  return rows.filter((row) => at(row) === newest.get(String(row.customer_id)));
}

const CUSTOMER_WRITE_ORDER: readonly string[] = ["left_list", "check", "not_on_list", "no_holder", "no_location"];

/**
 * Which of a customer's lines speaks for his own three list columns: a person's "same doctor", then any line
 * on a list, then the worst of the rest. One answer per customer, or two lines would overwrite each other
 * every hour and undo a person's answer within the hour.
 */
export function listCheckSpokesmanIndex(rows: ReadonlyArray<{ decidedState: "on_list" | "not_on_list" | null; state: string }>): number {
  const rank = (row: { decidedState: "on_list" | "not_on_list" | null; state: string }) => {
    if (row.decidedState === "on_list") return 0;
    if (row.state === "on_list") return 1;
    const at = CUSTOMER_WRITE_ORDER.indexOf(row.state);
    return 2 + (at < 0 ? CUSTOMER_WRITE_ORDER.length : at);
  };
  return rows.reduce((best, row, at) => (rank(row) < rank(rows[best]) ? at : best), 0);
}

/** Who reads the board. The money on it is estimated cost on approved requests, never sales. */
export function canReadListCheckBoard(role: string | null | undefined): boolean {
  return role === "Super Admin" || role === "SFE Manager" || role === "CEO" || role === "Marketing Manager";
}

/** Who answers an unsure row (owner, 2026-11-03): the SFE Manager, and the Super Admin too. */
export function canDecideListCheck(role: string | null | undefined): boolean {
  return role === "Super Admin" || role === "SFE Manager";
}

/** The two photos stand further apart than his number: a flag on the approval window, never a block. */
export function listCheckIsFar(metresApart: number | null | undefined): boolean {
  return typeof metresApart === "number" && metresApart > SAME_PLACE_METRES;
}
