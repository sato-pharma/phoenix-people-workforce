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
 */

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
};

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

export type MatchQuestion = {
  id: string;
  /** The readings on either side, closest to the other side first; at most a handful each. */
  left: MatchSubject[];
  right: MatchSubject[];
  moreLeft: number;
  moreRight: number;
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
    let widest = Math.max(diameter[first], diameter[second]);
    for (const one of members[first]) {
      for (const other of members[second]) widest = Math.max(widest, distanceMeters(subjects[one].point, subjects[other].point));
    }
    if (capped && widest > SAME_GROUP_DIAMETER_METERS) return;
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
    const involvedLeft = new Set(entry.pairs.map((pair) => pair.left));
    const involvedRight = new Set(entry.pairs.map((pair) => pair.right));
    const nearestTo = (index: number, partners: Set<number>): number => {
      let best = Number.POSITIVE_INFINITY;
      for (const partner of partners) best = Math.min(best, distanceMeters(subjects[index].point, subjects[partner].point));
      return best;
    };
    const leftAll = entry.sides[0].indexes.slice().sort((a, b) => nearestTo(a, involvedRight) - nearestTo(b, involvedRight));
    const rightAll = entry.sides[1].indexes.slice().sort((a, b) => nearestTo(a, involvedLeft) - nearestTo(b, involvedLeft));
    const names = (indexes: number[]): Set<string> => new Set(indexes.map((index) => subjects[index].nameKey).filter((key) => key !== ""));
    const leftNames = names(entry.sides[0].indexes);
    const sameName = [...names(entry.sides[1].indexes)].some((key) => leftNames.has(key));
    questions.push({
      id: `${subjects[entry.sides[0].indexes[0]].key}~${subjects[entry.sides[1].indexes[0]].key}`,
      left: leftAll.slice(0, SIDE_SHOWN).map((index) => subjects[index]),
      right: rightAll.slice(0, SIDE_SHOWN).map((index) => subjects[index]),
      moreLeft: Math.max(leftAll.length - SIDE_SHOWN, 0),
      moreRight: Math.max(rightAll.length - SIDE_SHOWN, 0),
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
