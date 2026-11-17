/**
 * Phoenix CRM — the SAME place validated by more than one rep, side by side (owner, 2026-10-17: "a
 * place validated by more than a rep … put the validations beside each other and show me insights and
 * show me data to be able to know which one is the most accurate and which one is not … if you are in
 * doubt, ask — but not every place; what is clear and confident, put it direct").
 *
 * Pure and screen-free, so the loader, the board and the test share ONE rule.
 *
 * A subject is one validation of a physical place: a standalone place a rep validated, or a polyclinic
 * a rep captured. A seated customer is never its own subject — it sits on its building's own point and
 * is represented by that venue.
 *
 * 🔴 THREE ANSWERS PER PAIR, NEVER TWO. The reason this is not a nearest-neighbour join is the owner's
 * own words: a pair is `same` when the system is CONFIDENT (grouped with no question), `different` when
 * it is confident the other way (never shown), and `unsure` in between — and only the third is ever
 * put to him. The band is set by the two readings' own accuracy, not by one fixed radius: two weak fixes
 * 60 m apart are the same door far more often than two sharp ones.
 *
 * 🔴 THE PHOTOGRAPH IS THE ANCHOR (owner, 2026-10-13, and the Place checks' own rule): the point a
 * subject contributes is its photograph's fix when it has one — the shutter took it at the door — and
 * the stored point only when it has none. The pin is not discarded: how far a rep's pin sits from his own
 * photograph is how much he can be trusted to have stood where he said, and it is shown as such.
 *
 * 🔴 "MORE THAN A REP" IS MORE THAN ONE SEAT. Two doctors one rep validated in the same building are
 * one rep's work; a group needs two seats before it is a comparison at all.
 *
 * 🔴 HE ANSWERS A QUESTION READING BY READING WHEN ONE SIDE HOLDS SEVERAL (owner, 2026-11-17: "i want to
 * accept 1 and reject 1"). One side of a question is a place the system grouped by distance, so it can
 * hold a reading he knows is somebody else's door. `splitAnswerPairs` turns his per-reading marks into
 * pairs, and a `different` answer then keeps that reading out of the place he confirmed: no join the
 * system makes on distance alone may put two readings he called different in one place.
 *
 * 🔴 ONE CUSTOMER IS ONE READING (owner, 2026-11-17: "if same dr different reps visit but he is in phoenix
 * recognized as 2 bec everyone separate validate him i want phx 2 recognize as 1"). Where the three-lines
 * rule has already joined two lines' records of one customer — the weaker moved onto the stronger's point
 * with `LINE_TWIN_MOVE_REASON` — the board shows them as ONE reading that names every rep and line
 * (`oneCustomerJoins`, `foldOneCustomer`). Without it each record kept its own photograph's fix, so a customer
 * Phoenix had already joined was put to him again as two (measured 2026-11-17: 210 such pairs). A pair he
 * confirmed as the same customer on the "Same customer, other line" list folds the same way, whatever the
 * spelling (`confirmed`): his word is what joins two names the rule never would.
 */

import { sameName } from "@/lib/phoenix-crm/customer-match-groups";
import { distanceMeters, type GeoPoint } from "@/lib/phoenix-crm/geo";

export type MatchSubjectKind = "place" | "venue";
export type MatchSignboard = "match" | "other_name" | "no_name" | "unjudged" | null;
export type MatchPointSource = "photo" | "pin" | "shared_place" | null;

/** One validation of a physical place, as the comparison reads it. */
export type MatchSubject = {
  /** `place:<uuid>` or `venue:<uuid>` — the key an answer is stored under. */
  key: string;
  kind: MatchSubjectKind;
  id: string;
  /** Who validated it: a seat, because the rep's name is not unique and a seat changes hands. */
  seatId: string;
  repName: string;
  territory: string;
  line: string | null;
  region: string | null;
  /** The customer's name, or the polyclinic's. */
  title: string;
  /** The list type for a place, the venue kind for a venue. */
  subtitle: string | null;
  listType: string;
  speciality: string | null;
  /** The customer's name folded for comparison, or "" for a venue and a name that folds away. */
  nameKey: string;
  /** The anchor: the photograph's fix when there is one, otherwise the stored point. */
  point: GeoPoint;
  /** The anchor's own reported accuracy, or null when the phone gave none. */
  accuracyMeters: number | null;
  /** How far the rep's pin sits from his own photograph; null when he has only one of them. */
  pinGapMeters: number | null;
  pointSource: MatchPointSource;
  signboard: MatchSignboard;
  brickName: string | null;
  areaName: string | null;
  address: string | null;
  capturedAt: string;
  capturedAtText: string;
  /** The sign photograph, shown beside the others. */
  photoPath: string | null;
  /** Customers seated in it — a venue only, 0 for a place. */
  seated: number;
  /** The validation is still waiting for a decision (a held venue, a pending review). */
  waiting: boolean;
  /** The other lines' records of this same customer, folded into this reading (`foldOneCustomer`). */
  sameCustomer?: SameCustomerRecord[];
};

/** Another line's record of the same customer, shown on the reading it was folded into. */
export type SameCustomerRecord = { key: string; repName: string; territory: string; line: string | null };

// ── One customer, one reading ──────────────────────────────────────────────────────────────────────

/** Two stored points this close are the one point the three-lines rule moved a record onto. */
export const ONE_CUSTOMER_SAME_POINT_METERS = 1;

/** One validated place, as the one-customer fold reads it. */
export type OneCustomerCandidate = {
  key: string;
  customerId: string;
  seatId: string;
  /** The seat's line name; two records of one line are never one customer here. */
  line: string | null;
  listType: string;
  /** The customer's name, folded and counted the signboard reader's way. */
  nameWords: ReadonlyArray<string>;
  /** The STORED point — the one the three-lines rule moves — never the photograph's fix. */
  stored: GeoPoint | null;
  /** This place was moved by the three-lines rule onto another line's point. */
  movedByLineRule: boolean;
  capturedAt: string;
};

function isPersonList(listType: string): boolean {
  return listType === "AM" || listType === "PM";
}

/** The key of a pair of customers he confirmed as one, in either order (`oneCustomerJoins`' `confirmed`). */
export function customerPairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * Which records are one customer: `joined key → kept key`. A pair is joined when both sit on one stored point,
 * they are on two different lines of one list (AM or PM), and EITHER the three-lines rule moved one of them
 * there and their names are one name, OR he confirmed the two customers as one (`confirmed`, keys made by
 * `customerPairKey`). The kept record is the one the others were moved onto (not itself moved), then the
 * earliest captured.
 */
export function oneCustomerJoins(candidates: ReadonlyArray<OneCustomerCandidate>, confirmed: ReadonlySet<string> = new Set()): Map<string, string> {
  const usable = candidates.filter((candidate) => candidate.stored && candidate.line && isPersonList(candidate.listType));
  const buckets = new Map<string, OneCustomerCandidate[]>();
  for (const candidate of usable) {
    if (candidate.nameWords.length < 2) continue;
    const bucket = `${candidate.listType}|${candidate.nameWords[0]} ${candidate.nameWords[1]}`;
    const held = buckets.get(bucket);
    if (held) held.push(candidate);
    else buckets.set(bucket, [candidate]);
  }
  const parent = new Map<string, string>();
  const linked = new Set<string>();
  const find = (key: string): string => {
    const up = parent.get(key) ?? key;
    if (up === key) return key;
    const root = find(up);
    parent.set(key, root);
    return root;
  };
  const onOnePoint = (left: OneCustomerCandidate, right: OneCustomerCandidate): boolean =>
    left.customerId !== right.customerId &&
    left.seatId !== right.seatId &&
    left.line !== right.line &&
    left.listType === right.listType &&
    distanceMeters(left.stored as GeoPoint, right.stored as GeoPoint) <= ONE_CUSTOMER_SAME_POINT_METERS;
  const join = (left: OneCustomerCandidate, right: OneCustomerCandidate) => {
    linked.add(left.key);
    linked.add(right.key);
    const rootLeft = find(left.key);
    const rootRight = find(right.key);
    if (rootLeft !== rootRight) parent.set(rootLeft, rootRight);
  };
  for (const group of buckets.values()) {
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        const left = group[a];
        const right = group[b];
        if (!left.movedByLineRule && !right.movedByLineRule) continue;
        if (!onOnePoint(left, right) || !sameName(left.nameWords, right.nameWords)) continue;
        join(left, right);
      }
    }
  }
  // His own word: two customers he confirmed as one, whatever their names, once they share the point.
  if (confirmed.size > 0) {
    const byCustomer = new Map<string, OneCustomerCandidate[]>();
    for (const candidate of usable) {
      const held = byCustomer.get(candidate.customerId);
      if (held) held.push(candidate);
      else byCustomer.set(candidate.customerId, [candidate]);
    }
    for (const key of confirmed) {
      const [first, second] = key.split("|");
      for (const left of byCustomer.get(first) ?? []) {
        for (const right of byCustomer.get(second) ?? []) if (onOnePoint(left, right)) join(left, right);
      }
    }
  }
  const components = new Map<string, OneCustomerCandidate[]>();
  for (const candidate of usable) {
    if (!linked.has(candidate.key)) continue;
    const root = find(candidate.key);
    const held = components.get(root);
    if (held) held.push(candidate);
    else components.set(root, [candidate]);
  }
  const joins = new Map<string, string>();
  for (const members of components.values()) {
    if (members.length < 2) continue;
    const kept = [...members].sort(
      (left, right) =>
        Number(left.movedByLineRule) - Number(right.movedByLineRule) || left.capturedAt.localeCompare(right.capturedAt) || left.key.localeCompare(right.key),
    )[0];
    for (const member of members) if (member.key !== kept.key) joins.set(member.key, kept.key);
  }
  return joins;
}

/**
 * The board's subjects with every joined record folded into the one it was joined to, and the stored answers
 * re-keyed onto the kept record (an answer between two records of one customer says nothing and is dropped).
 */
export function foldOneCustomer(
  subjects: ReadonlyArray<MatchSubject>,
  answers: ReadonlyArray<MatchAnswerRow>,
  joins: ReadonlyMap<string, string>,
): { subjects: MatchSubject[]; answers: MatchAnswerRow[] } {
  if (joins.size === 0) return { subjects: [...subjects], answers: [...answers] };
  const present = new Set(subjects.map((subject) => subject.key));
  const live = new Map([...joins].filter(([joined, kept]) => present.has(joined) && present.has(kept)));
  const folded = new Map<string, SameCustomerRecord[]>();
  for (const subject of subjects) {
    const kept = live.get(subject.key);
    if (!kept) continue;
    const held = folded.get(kept) ?? [];
    held.push({ key: subject.key, repName: subject.repName, territory: subject.territory, line: subject.line });
    folded.set(kept, held);
  }
  const outSubjects = subjects
    .filter((subject) => !live.has(subject.key))
    .map((subject) => (folded.has(subject.key) ? { ...subject, sameCustomer: [...(subject.sameCustomer ?? []), ...(folded.get(subject.key) ?? [])] } : subject));
  const seen = new Set<string>();
  const outAnswers: MatchAnswerRow[] = [];
  for (const answer of answers) {
    const [a, b] = orderedPair(live.get(answer.a) ?? answer.a, live.get(answer.b) ?? answer.b);
    if (a === b || seen.has(`${a}|${b}`)) continue;
    seen.add(`${a}|${b}`);
    outAnswers.push({ a, b, answer: answer.answer });
  }
  return { subjects: outSubjects, answers: outAnswers };
}

export type MatchAnswer = "same" | "different";
export type MatchAnswerRow = { a: string; b: string; answer: MatchAnswer };

// ── The pair rule ────────────────────────────────────────────────────────────────────────────────

/** The accuracy assumed for a reading that reported none — the module's own median is about 17 m. */
export const UNKNOWN_ACCURACY_METERS = 25;
/** Two readings closer than this are one door whatever their accuracy says. */
export const SAME_PLACE_FLOOR_METERS = 30;
/** …and however weak they are, more than this apart is never "confidently the same". */
export const SAME_PLACE_CEILING_METERS = 60;
/** Beyond this the two are confidently different places even for the weakest pair. */
export const DIFFERENT_PLACE_FLOOR_METERS = 100;
export const DIFFERENT_PLACE_CEILING_METERS = 200;
/** No group the system builds on its own is wider than this — a campus, never a street. */
export const SAME_GROUP_DIAMETER_METERS = 120;
/** A member is called the most accurate only when it clearly beats the next one. */
export const BEST_MARGIN = 0.8;
/** The nearest OTHER rep must be at least this far for a member to be an outlier. */
export const OUTLIER_FLOOR_METERS = 30;
/** …and at least this many times as far as the typical member's nearest other rep. */
export const OUTLIER_RATIO = 2;
/** One answer covers every pair that raised its question; the route takes at most this many per request, and the screen sends a bigger question in several. */
export const MAX_ANSWER_PAIRS = 80;
/** A phone that reported worse than this is weak, and the card says so. */
export const WEAK_GPS_METERS = 50;
/** A pin this far from the rep's own photograph is a pin he moved. */
export const MOVED_PIN_METERS = 50;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** The accuracy a subject contributes: its own report, held to a sane range. */
export function subjectAccuracy(subject: Pick<MatchSubject, "accuracyMeters">): number {
  const reported = subject.accuracyMeters;
  return clamp(reported !== null && Number.isFinite(reported) && reported > 0 ? reported : UNKNOWN_ACCURACY_METERS, 5, 100);
}

export type PairRelation = "same" | "unsure" | "different";

export function pairLimits(left: Pick<MatchSubject, "accuracyMeters">, right: Pick<MatchSubject, "accuracyMeters">): { same: number; different: number } {
  const sigma = Math.hypot(subjectAccuracy(left), subjectAccuracy(right));
  return {
    same: clamp(sigma, SAME_PLACE_FLOOR_METERS, SAME_PLACE_CEILING_METERS),
    different: clamp(3 * sigma, DIFFERENT_PLACE_FLOOR_METERS, DIFFERENT_PLACE_CEILING_METERS),
  };
}

/**
 * Whether two validations are for two DIFFERENT named customers — both are places, both carry a name that
 * means something, and the names are not the same. The one case where the middle band is not worth a
 * question: two doctors 50 m apart on one street are two doors far more often than one door read twice,
 * and asking about every such pair would bury the pairs that are genuinely in doubt (261 questions on the
 * live data before this rule, almost all of them neighbours).
 */
function namedDifferently(left: MatchSubject, right: MatchSubject): boolean {
  return left.kind === "place" && right.kind === "place" && left.nameKey !== "" && right.nameKey !== "" && left.nameKey !== right.nameKey;
}

export function classifyPair(left: MatchSubject, right: MatchSubject): { relation: PairRelation; meters: number } {
  const meters = distanceMeters(left.point, right.point);
  const limits = pairLimits(left, right);
  if (meters <= limits.same) return { relation: "same", meters };
  if (meters > limits.different || namedDifferently(left, right)) return { relation: "different", meters };
  return { relation: "unsure", meters };
}

/** A pair's identity, the same whichever way round it is asked. */
export function orderedPair(first: string, second: string): [string, string] {
  return first < second ? [first, second] : [second, first];
}

export function pairId(first: string, second: string): string {
  const [low, high] = orderedPair(first, second);
  return `${low}|${high}`;
}

// ── What a group and a question carry ────────────────────────────────────────────────────────────

export type MemberFlag = "most_accurate" | "outlier" | "weak_gps" | "moved_pin" | "sign_other_name" | "sign_no_name";

export type MatchMember = MatchSubject & {
  /** Distance to the nearest validation by ANOTHER rep — how well the others bear this one out. */
  nearestOtherMeters: number | null;
  /** The likely error: the rep's own precision and his pin/photo gap, taken with how far the others sit. */
  likelyErrorMeters: number;
  /** 1 = the most accurate. */
  rank: number;
  flags: MemberFlag[];
};

export type MatchGroup = {
  id: string;
  /** Best first. */
  members: MatchMember[];
  seats: number;
  reps: string[];
  /** The widest distance between any two of its readings. */
  spreadMeters: number;
  centre: GeoPoint;
  /** The member the data clearly favours, or null — "too close to call" is an honest answer. */
  bestKey: string | null;
  /** The pairs the Super Admin confirmed as one place inside this group, so he can take his answer back. */
  confirmedPairs: Array<[string, string]>;
  waiting: boolean;
};

/** A reading put to him in a question, with how far it sits from the other side. */
export type QuestionReading = MatchSubject & {
  /** Metres to the nearest reading on the other side — what "same place or not" turns on for this one. */
  otherSideMeters: number;
};

export type MatchQuestion = {
  id: string;
  /** The readings on either side, closest to the other side first; at most a handful each. */
  left: QuestionReading[];
  right: QuestionReading[];
  /** The readings a side holds beyond the ones drawn; drawn only while he answers reading by reading. */
  leftMore: QuestionReading[];
  rightMore: QuestionReading[];
  moreLeft: number;
  moreRight: number;
  /** The widest distance between two readings on each side — 0 when a side is one reading. */
  leftSpreadMeters: number;
  rightSpreadMeters: number;
  /** How far apart the closest two readings are. */
  closestMeters: number;
  /** Every unsure pair that raised it — an answer is stored for all of them, so it is not asked twice. */
  pairs: Array<[string, string]>;
  /** The same customer's name sits on both sides. */
  sameName: boolean;
};

export type MatchRepAccuracy = {
  seatId: string;
  repName: string;
  territory: string;
  groups: number;
  validations: number;
  medianReportedMeters: number | null;
  medianPinGapMeters: number | null;
  medianNearestOtherMeters: number | null;
  mostAccurate: number;
  outliers: number;
  signsRead: number;
  signsMatching: number;
};

export type MatchInsights = {
  groups: number;
  validations: number;
  reps: number;
  confirmed: number;
  medianSpreadMeters: number | null;
  withOutlier: number;
  tooCloseToCall: number;
  byRep: MatchRepAccuracy[];
};

export type AnsweredDifferent = {
  id: string;
  left: MatchSubject;
  right: MatchSubject;
  meters: number;
  pairs: Array<[string, string]>;
};

export type PlaceMatchBoard = {
  groups: MatchGroup[];
  questions: MatchQuestion[];
  answeredDifferent: AnsweredDifferent[];
  insights: MatchInsights;
};

// ── Small numeric helpers ────────────────────────────────────────────────────────────────────────

export function median(values: ReadonlyArray<number | null | undefined>): number | null {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((left, right) => left - right);
  if (usable.length === 0) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 === 1 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

function weightedCentre(subjects: ReadonlyArray<MatchSubject>): GeoPoint {
  let weight = 0;
  let lat = 0;
  let lon = 0;
  for (const subject of subjects) {
    const accuracy = subjectAccuracy(subject);
    const share = 1 / (accuracy * accuracy);
    weight += share;
    lat += subject.point.lat * share;
    lon += subject.point.lon * share;
  }
  return weight === 0 ? { lat: 0, lon: 0 } : { lat: lat / weight, lon: lon / weight };
}

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    let walk = index;
    while (this.parent[walk] !== root) {
      const next = this.parent[walk];
      this.parent[walk] = root;
      walk = next;
    }
    return root;
  }

  union(left: number, right: number): void {
    const first = this.find(left);
    const second = this.find(right);
    if (first !== second) this.parent[Math.max(first, second)] = Math.min(first, second);
  }
}

/** A neighbour search by grid: the widest pair limit is 200 m, and a 0.003° cell is never narrower. */
const CELL_DEGREES = 0.003;

function neighbourPairs(subjects: ReadonlyArray<MatchSubject>): Array<[number, number]> {
  const cells = new Map<string, number[]>();
  const cellOf = (subject: MatchSubject): [number, number] => [Math.floor(subject.point.lat / CELL_DEGREES), Math.floor(subject.point.lon / CELL_DEGREES)];
  subjects.forEach((subject, index) => {
    const [row, column] = cellOf(subject);
    const key = `${row}:${column}`;
    const held = cells.get(key);
    if (held) held.push(index);
    else cells.set(key, [index]);
  });
  const pairs: Array<[number, number]> = [];
  subjects.forEach((subject, index) => {
    const [row, column] = cellOf(subject);
    for (let dRow = -1; dRow <= 1; dRow += 1) {
      for (let dColumn = -1; dColumn <= 1; dColumn += 1) {
        for (const other of cells.get(`${row + dRow}:${column + dColumn}`) ?? []) {
          if (other > index) pairs.push([index, other]);
        }
      }
    }
  });
  return pairs;
}

// ── Ranking one group ────────────────────────────────────────────────────────────────────────────

function rankMembers(subjects: ReadonlyArray<MatchSubject>): { members: MatchMember[]; bestKey: string | null; seats: number } {
  const seats = new Set(subjects.map((subject) => subject.seatId)).size;
  const nearest = subjects.map((subject) => {
    let best: number | null = null;
    for (const other of subjects) {
      if (other.seatId === subject.seatId) continue;
      const meters = distanceMeters(subject.point, other.point);
      if (best === null || meters < best) best = meters;
    }
    return best;
  });
  const typical = median(nearest);
  const unranked = subjects.map((subject, index) => {
    const own = Math.hypot(subjectAccuracy(subject), subject.pinGapMeters ?? 0);
    const likely = Math.hypot(nearest[index] ?? 0, own);
    const flags: MemberFlag[] = [];
    if ((subject.accuracyMeters ?? 0) > WEAK_GPS_METERS) flags.push("weak_gps");
    if ((subject.pinGapMeters ?? 0) > MOVED_PIN_METERS) flags.push("moved_pin");
    if (subject.signboard === "other_name") flags.push("sign_other_name");
    if (subject.signboard === "no_name") flags.push("sign_no_name");
    const near = nearest[index];
    if (seats >= 3 && near !== null && near >= OUTLIER_FLOOR_METERS && typical !== null && near >= OUTLIER_RATIO * Math.max(typical, 1)) flags.push("outlier");
    return { subject, nearest: near, likely, flags };
  });
  unranked.sort((left, right) => left.likely - right.likely || left.subject.key.localeCompare(right.subject.key));
  const first = unranked[0];
  const second = unranked[1];
  const clear = first !== undefined && second !== undefined && first.likely <= BEST_MARGIN * second.likely;
  const members = unranked.map((entry, index): MatchMember => {
    const flags = [...entry.flags];
    if (clear && index === 0) flags.unshift("most_accurate");
    return {
      ...entry.subject,
      nearestOtherMeters: entry.nearest === null ? null : Math.round(entry.nearest),
      likelyErrorMeters: Math.round(entry.likely),
      rank: index + 1,
      flags,
    };
  });
  return { members, bestKey: clear && first ? first.subject.key : null, seats };
}

function spreadOf(subjects: ReadonlyArray<MatchSubject>): number {
  let widest = 0;
  for (let left = 0; left < subjects.length; left += 1) {
    for (let right = left + 1; right < subjects.length; right += 1) {
      widest = Math.max(widest, distanceMeters(subjects[left].point, subjects[right].point));
    }
  }
  return widest;
}

// ── The board ────────────────────────────────────────────────────────────────────────────────────

/** How many readings a question shows on each side before it says "and N more". */
const SIDE_SHOWN = 3;

export function buildPlaceMatchBoard(input: { subjects: ReadonlyArray<MatchSubject>; answers: ReadonlyArray<MatchAnswerRow> }): PlaceMatchBoard {
  const seen = new Set<string>();
  const subjects = input.subjects.filter((subject) => {
    if (seen.has(subject.key)) return false;
    seen.add(subject.key);
    return Number.isFinite(subject.point.lat) && Number.isFinite(subject.point.lon);
  });
  const indexByKey = new Map(subjects.map((subject, index) => [subject.key, index] as const));

  // What the Super Admin has already said. An answer about a subject that is gone is simply inert.
  const answered = new Map<string, MatchAnswer>();
  for (const row of input.answers) {
    if (indexByKey.has(row.a) && indexByKey.has(row.b) && row.a !== row.b) answered.set(pairId(row.a, row.b), row.answer);
  }

  // 🔴 HIS "DIFFERENT" IS A WALL, NOT ONLY A SKIPPED PAIR (owner, 2026-11-17: "i want to accept 1 and
  // reject 1"). Skipping the pair alone let a third reading carry it back in: he confirmed one customer's
  // two readings 34 m apart and rejected the other customer, whose reading sat 3 m from the first one, and
  // that 3 m join put the rejected reading in the confirmed place anyway. So a join made on distance is
  // refused when it would put two readings he called different in one place.
  //
  // `eventual` is the place each reading WILL end in: seeded with every "same" answer (which join after
  // the distance joins), and joined again on every distance join that is accepted. A distance join is
  // checked against the two eventual places, so a wall cannot be reached through any chain of distance
  // joins and "same" answers, in whatever order they fall.
  const eventual = new DisjointSet(subjects.length);
  const walledBy = new Map<number, number[]>();
  answered.forEach((verdict, id) => {
    const [first, second] = id.split("|");
    const left = indexByKey.get(first);
    const right = indexByKey.get(second);
    if (left === undefined || right === undefined) return;
    if (verdict === "same") {
      eventual.union(left, right);
      return;
    }
    walledBy.set(left, [...(walledBy.get(left) ?? []), right]);
    walledBy.set(right, [...(walledBy.get(right) ?? []), left]);
  });
  /** The readings in each eventual place that carry a "different" answer, by the place's root. */
  const walledByPlace = new Map<number, number[]>();
  walledBy.forEach((_, index) => {
    const root = eventual.find(index);
    walledByPlace.set(root, [...(walledByPlace.get(root) ?? []), index]);
  });
  const walledApart = (left: number, right: number): boolean => {
    const first = eventual.find(left);
    const second = eventual.find(right);
    if (first === second) return false;
    const across = new Set(walledByPlace.get(second) ?? []);
    return (walledByPlace.get(first) ?? []).some((one) => (walledBy.get(one) ?? []).some((other) => across.has(other)));
  };
  const joinEventually = (left: number, right: number): void => {
    const first = eventual.find(left);
    const second = eventual.find(right);
    if (first === second) return;
    eventual.union(first, second);
    const root = eventual.find(first);
    walledByPlace.set(root, [...(walledByPlace.get(first) ?? []), ...(walledByPlace.get(second) ?? [])]);
    walledByPlace.delete(root === first ? second : first);
  };

  const sets = new DisjointSet(subjects.length);
  const unsure: Array<{ left: number; right: number; meters: number }> = [];
  const confirmed: Array<[number, number]> = [];
  const close: Array<{ left: number; right: number; meters: number }> = [];

  // 🔴 A GROUP IS TIGHT, NOT A CHAIN. Joining every pair that is "confidently the same" would let a
  // street of doctors 40 m apart run into one 24-reading "place" 220 m long, and the comparison of
  // readings inside it would mean nothing. So the closest pairs join first and a join is refused when it
  // would make the group wider than SAME_GROUP_DIAMETER_METERS. His own "same" answer is the one thing
  // that is never refused.
  const members: number[][] = subjects.map((_, index) => [index]);
  const diameter: number[] = subjects.map(() => 0);
  const join = (left: number, right: number, capped: boolean): void => {
    const first = sets.find(left);
    const second = sets.find(right);
    if (first === second) return;
    if (capped && walledApart(first, second)) return;
    let widest = Math.max(diameter[first], diameter[second]);
    for (const one of members[first]) {
      for (const other of members[second]) widest = Math.max(widest, distanceMeters(subjects[one].point, subjects[other].point));
    }
    if (capped && widest > SAME_GROUP_DIAMETER_METERS) return;
    if (capped) joinEventually(first, second);
    sets.union(first, second);
    const root = sets.find(first);
    const gone = root === first ? second : first;
    members[root] = members[root].concat(members[gone]);
    diameter[root] = widest;
  };

  for (const [left, right] of neighbourPairs(subjects)) {
    const verdict = answered.get(pairId(subjects[left].key, subjects[right].key));
    if (verdict === "different") continue;
    if (verdict === "same") continue; // joined below, whatever their distance now says
    const { relation, meters } = classifyPair(subjects[left], subjects[right]);
    if (relation === "same") close.push({ left, right, meters });
    else if (relation === "unsure" && subjects[left].seatId !== subjects[right].seatId) unsure.push({ left, right, meters });
  }
  close.sort((a, b) => a.meters - b.meters || a.left - b.left || a.right - b.right);
  for (const edge of close) join(edge.left, edge.right, true);
  answered.forEach((verdict, id) => {
    if (verdict !== "same") return;
    const [first, second] = id.split("|");
    const left = indexByKey.get(first);
    const right = indexByKey.get(second);
    if (left === undefined || right === undefined) return;
    join(left, right, false);
    confirmed.push([left, right]);
  });

  // The components, and the ones that are a comparison at all.
  const components = new Map<number, number[]>();
  subjects.forEach((_, index) => {
    const root = sets.find(index);
    const held = components.get(root);
    if (held) held.push(index);
    else components.set(root, [index]);
  });

  const groups: MatchGroup[] = [];
  const groupRoots = new Set<number>();
  components.forEach((indexes, root) => {
    if (indexes.length < 2) return;
    const members = indexes.map((index) => subjects[index]);
    if (new Set(members.map((member) => member.seatId)).size < 2) return;
    groupRoots.add(root);
    const ranked = rankMembers(members);
    const keys = new Set(members.map((member) => member.key));
    const confirmedPairs = confirmed
      .filter(([left, right]) => keys.has(subjects[left].key) && keys.has(subjects[right].key))
      .map(([left, right]): [string, string] => orderedPair(subjects[left].key, subjects[right].key));
    groups.push({
      id: [...keys].sort()[0],
      members: ranked.members,
      seats: ranked.seats,
      reps: [...new Set(ranked.members.map((member) => member.repName))],
      spreadMeters: Math.round(spreadOf(members)),
      centre: weightedCentre(members),
      bestKey: ranked.bestKey,
      confirmedPairs,
      waiting: members.some((member) => member.waiting),
    });
  });
  // The widest disagreement first — that is where "which one is wrong" is worth reading.
  groups.sort((left, right) => right.spreadMeters - left.spreadMeters || right.members.length - left.members.length || left.id.localeCompare(right.id));

  // The questions: an unsure pair joining two components that are not already one.
  type Side = { root: number; indexes: number[] };
  const byPair = new Map<string, { sides: [Side, Side]; pairs: Array<{ left: number; right: number; meters: number }> }>();
  for (const edge of unsure) {
    const leftRoot = sets.find(edge.left);
    const rightRoot = sets.find(edge.right);
    if (leftRoot === rightRoot) continue;
    const [lowRoot, highRoot] = leftRoot < rightRoot ? [leftRoot, rightRoot] : [rightRoot, leftRoot];
    const id = `${lowRoot}:${highRoot}`;
    let entry = byPair.get(id);
    if (!entry) {
      entry = {
        sides: [
          { root: lowRoot, indexes: components.get(lowRoot) ?? [] },
          { root: highRoot, indexes: components.get(highRoot) ?? [] },
        ],
        pairs: [],
      };
      byPair.set(id, entry);
    }
    // Keep each pair oriented low side first, so the two sides read the same way round every time.
    entry.pairs.push(leftRoot === lowRoot ? edge : { left: edge.right, right: edge.left, meters: edge.meters });
  }
  const questions: MatchQuestion[] = [];
  byPair.forEach((entry) => {
    const closest = Math.min(...entry.pairs.map((pair) => pair.meters));
    // Each reading says how far it sits from the nearest reading on the other side — drawn or counted —
    // and each side is drawn closest first by that same number, so he can answer reading by reading
    // (owner, 2026-11-17: "tell me the diff in m between what we are checking").
    const nearestTo = (index: number, partners: ReadonlyArray<number>): number => {
      let best = Number.POSITIVE_INFINITY;
      for (const partner of partners) best = Math.min(best, distanceMeters(subjects[index].point, subjects[partner].point));
      return best;
    };
    const side = (indexes: number[], otherSide: number[]): QuestionReading[] =>
      indexes
        .map((index) => ({ index, meters: nearestTo(index, otherSide) }))
        .sort((a, b) => a.meters - b.meters)
        .map(({ index, meters }) => ({ ...subjects[index], otherSideMeters: Math.round(meters) }));
    const leftAll = side(entry.sides[0].indexes, entry.sides[1].indexes);
    const rightAll = side(entry.sides[1].indexes, entry.sides[0].indexes);
    const names = (indexes: number[]): Set<string> => new Set(indexes.map((index) => subjects[index].nameKey).filter((key) => key !== ""));
    const leftNames = names(entry.sides[0].indexes);
    const sameName = [...names(entry.sides[1].indexes)].some((key) => leftNames.has(key));
    questions.push({
      id: `${subjects[entry.sides[0].indexes[0]].key}~${subjects[entry.sides[1].indexes[0]].key}`,
      left: leftAll.slice(0, SIDE_SHOWN),
      right: rightAll.slice(0, SIDE_SHOWN),
      leftMore: leftAll.slice(SIDE_SHOWN),
      rightMore: rightAll.slice(SIDE_SHOWN),
      moreLeft: Math.max(leftAll.length - SIDE_SHOWN, 0),
      moreRight: Math.max(rightAll.length - SIDE_SHOWN, 0),
      leftSpreadMeters: Math.round(spreadOf(entry.sides[0].indexes.map((index) => subjects[index]))),
      rightSpreadMeters: Math.round(spreadOf(entry.sides[1].indexes.map((index) => subjects[index]))),
      closestMeters: closest,
      pairs: entry.pairs
        .slice()
        .sort((a, b) => a.meters - b.meters)
        .map((pair): [string, string] => orderedPair(subjects[pair.left].key, subjects[pair.right].key)),
      sameName,
    });
  });
  // The ones most likely to be a yes first: the same name, then the closest.
  questions.sort((left, right) => Number(right.sameName) - Number(left.sameName) || left.closestMeters - right.closestMeters || left.id.localeCompare(right.id));

  // What he said "different" to, so he can take it back.
  const answeredDifferent: AnsweredDifferent[] = [];
  const differentByPair = new Map<string, AnsweredDifferent>();
  answered.forEach((verdict, id) => {
    if (verdict !== "different") return;
    const [first, second] = id.split("|");
    const left = indexByKey.get(first);
    const right = indexByKey.get(second);
    if (left === undefined || right === undefined) return;
    differentByPair.set(id, {
      id,
      left: subjects[left],
      right: subjects[right],
      meters: Math.round(distanceMeters(subjects[left].point, subjects[right].point)),
      pairs: [[first, second]],
    });
  });
  differentByPair.forEach((entry) => answeredDifferent.push(entry));
  answeredDifferent.sort((left, right) => left.meters - right.meters || left.id.localeCompare(right.id));

  return { groups, questions, answeredDifferent, insights: insightsOf(groups) };
}

// ── His answer, reading by reading ──────────────────────────────────────────────────────────────

type QuestionSides = Pick<MatchQuestion, "left" | "right" | "leftMore" | "rightMore">;

/** Every reading on each side of a question: the drawn ones, then the ones only counted. */
export function questionSides(question: QuestionSides): { left: QuestionReading[]; right: QuestionReading[] } {
  return { left: [...question.left, ...question.leftMore], right: [...question.right, ...question.rightMore] };
}

/**
 * Whether a question is answered reading by reading: one of its sides holds several readings, and every
 * pair across fits in the one request the answer must be saved in.
 */
export function answersEachReading(question: QuestionSides): boolean {
  const { left, right } = questionSides(question);
  return (left.length > 1 || right.length > 1) && left.length * right.length <= MAX_ANSWER_PAIRS;
}

/**
 * His answer to one question, reading by reading (owner, 2026-11-17: "i want to accept 1 and reject 1").
 *
 * A side of two or more readings is marked one reading at a time: `same`, this reading is the place on
 * the other side; `different`, it is not. A side of one reading is what the other side is compared with
 * and takes no mark. A pair is `same` only when both of its readings are, and `different` when either is
 * not, so a reading he rejects is a different place from every reading on the other side.
 *
 * Every reading is marked, the counted ones too ("and 2 more" are drawn while he answers this way), so
 * no pair that raised the question is left unanswered. Null while a reading that needs a mark has none.
 */
export function splitAnswerPairs(
  question: QuestionSides,
  marks: Readonly<Record<string, MatchAnswer | undefined>>,
): { same: Array<[string, string]>; different: Array<[string, string]> } | null {
  const sides = questionSides(question);
  const markOf = (side: ReadonlyArray<MatchSubject>, subject: MatchSubject): MatchAnswer | null => (side.length < 2 ? "same" : (marks[subject.key] ?? null));
  if ([...sides.left.map((subject) => markOf(sides.left, subject)), ...sides.right.map((subject) => markOf(sides.right, subject))].includes(null)) return null;
  const same: Array<[string, string]> = [];
  const different: Array<[string, string]> = [];
  for (const left of sides.left) {
    for (const right of sides.right) {
      if (left.key === right.key) continue;
      const both = markOf(sides.left, left) === "same" && markOf(sides.right, right) === "same";
      (both ? same : different).push(orderedPair(left.key, right.key));
    }
  }
  return { same, different };
}

/**
 * What the screen hides a question by once he has answered it: its id AND the pairs that raised it. A
 * question the board raises again over pairs still open carries other pairs, so it shows at once instead
 * of staying hidden until the page is reloaded.
 */
export function questionSignature(question: Pick<MatchQuestion, "id" | "pairs">): string {
  return `${question.id}#${question.pairs.map(([first, second]) => `${first}|${second}`).join(",")}`;
}

// ── The insights ─────────────────────────────────────────────────────────────────────────────────

export function insightsOf(groups: ReadonlyArray<MatchGroup>): MatchInsights {
  const perRep = new Map<string, { entry: MatchRepAccuracy; reported: number[]; gaps: number[]; nearest: number[]; groupIds: Set<string> }>();
  for (const group of groups) {
    for (const member of group.members) {
      let held = perRep.get(member.seatId);
      if (!held) {
        held = {
          entry: {
            seatId: member.seatId,
            repName: member.repName,
            territory: member.territory,
            groups: 0,
            validations: 0,
            medianReportedMeters: null,
            medianPinGapMeters: null,
            medianNearestOtherMeters: null,
            mostAccurate: 0,
            outliers: 0,
            signsRead: 0,
            signsMatching: 0,
          },
          reported: [],
          gaps: [],
          nearest: [],
          groupIds: new Set<string>(),
        };
        perRep.set(member.seatId, held);
      }
      held.entry.validations += 1;
      held.groupIds.add(group.id);
      if (member.accuracyMeters !== null) held.reported.push(member.accuracyMeters);
      if (member.pinGapMeters !== null) held.gaps.push(member.pinGapMeters);
      if (member.nearestOtherMeters !== null) held.nearest.push(member.nearestOtherMeters);
      if (member.flags.includes("most_accurate")) held.entry.mostAccurate += 1;
      if (member.flags.includes("outlier")) held.entry.outliers += 1;
      if (member.signboard === "match" || member.signboard === "other_name" || member.signboard === "no_name") {
        held.entry.signsRead += 1;
        if (member.signboard === "match") held.entry.signsMatching += 1;
      }
    }
  }
  const byRep = [...perRep.values()].map((held): MatchRepAccuracy => ({
    ...held.entry,
    groups: held.groupIds.size,
    medianReportedMeters: roundOrNull(median(held.reported)),
    medianPinGapMeters: roundOrNull(median(held.gaps)),
    medianNearestOtherMeters: roundOrNull(median(held.nearest)),
  }));
  // The most trustworthy first: the reps whose validations the others bear out most closely.
  byRep.sort(
    (left, right) =>
      (left.medianNearestOtherMeters ?? Number.POSITIVE_INFINITY) - (right.medianNearestOtherMeters ?? Number.POSITIVE_INFINITY) ||
      right.validations - left.validations ||
      left.repName.localeCompare(right.repName),
  );
  return {
    groups: groups.length,
    validations: groups.reduce((total, group) => total + group.members.length, 0),
    reps: byRep.length,
    confirmed: groups.filter((group) => group.confirmedPairs.length > 0).length,
    medianSpreadMeters: roundOrNull(median(groups.map((group) => group.spreadMeters))),
    withOutlier: groups.filter((group) => group.members.some((member) => member.flags.includes("outlier"))).length,
    tooCloseToCall: groups.filter((group) => group.bestKey === null).length,
    byRep,
  };
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

// ── What the screen words ────────────────────────────────────────────────────────────────────────

export const MEMBER_FLAG_TEXT: Record<MemberFlag, string> = {
  most_accurate: "Most accurate",
  outlier: "Far from every other rep",
  weak_gps: "Weak GPS signal",
  moved_pin: "Pin moved from the photo",
  sign_other_name: "Sign names somebody else",
  sign_no_name: "Sign names nobody",
};

/** One sentence on why the data favours (or does not favour) a member, from its own numbers. */
export function accuracySentence(group: MatchGroup): string {
  const best = group.members.find((member) => member.key === group.bestKey);
  if (!best) {
    return group.seats === 2
      ? "Too close to call: the two readings are about as precise as each other."
      : "Too close to call: no reading is clearly more precise than the rest.";
  }
  const parts: string[] = [];
  if (best.accuracyMeters !== null) parts.push(`its phone reported about ${Math.round(best.accuracyMeters)} m`);
  if (best.pinGapMeters !== null) parts.push(`the rep's pin and photo agree within ${Math.round(best.pinGapMeters)} m`);
  if (best.nearestOtherMeters !== null) parts.push(`the nearest other rep sits ${best.nearestOtherMeters} m away`);
  return parts.length > 0 ? `Most accurate: ${best.repName} — ${parts.join(", ")}.` : `Most accurate: ${best.repName}.`;
}
