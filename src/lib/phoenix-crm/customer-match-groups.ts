/**
 * Phoenix CRM — the SAME customer validated by more than one rep at places that do not agree (owner,
 * 2026-10-26: "go deep audit between reps validation and reconciliation of same drs in different reps",
 * then his pick "Build the check": a tab on Place checks, for the deciders only, that lists these pairs
 * and keeps listing new ones).
 *
 * Pure and screen-free, so the loader, the board and the test share ONE rule. It reads; it stores
 * nothing and decides nothing.
 *
 * A subject is one validated place of one customer on one rep's list. Two subjects are THE SAME CUSTOMER
 * when their names are the same name (each compound one word, the signboard reader's own counting), on
 * the same list (an AM hospital and a PM clinic are two places of one person, never a conflict), and no
 * known speciality says otherwise.
 *
 * Two shapes are listed, and only two:
 *
 *   A. SAME AREA, FAR APART — both places name the same area and their kept points sit more than
 *      `SAME_AREA_FAR_METERS` apart. One of them may be a second clinic; one may be wrong. The board
 *      shows which validations agree with each other (within `AGREE_METERS`) so the odd one is visible.
 *   B. A PIN ON ANOTHER REP'S POINT — a rep's pin sits within `PIN_ON_OTHER_METERS` of another rep's
 *      kept point for the same name while his own photograph was taken more than `PIN_FAR_FROM_PHOTO_METERS`
 *      from that pin. No area is needed: the photograph says where he stood.
 *
 * 🔴 THE PHOTOGRAPH IS THE ANCHOR (the Place checks' own rule): a subject's kept point is its photograph's
 * fix when it has one, the stored point otherwise.
 *
 * 🔴 NEUTRAL WORDS. A far pin is "not usable", never an accusation: the board says where each reading
 * sits and how far apart, and the decider reads it.
 */

import { distanceMeters, formatDistance, type GeoPoint } from "@/lib/phoenix-crm/geo";

/** One validated place of one customer, as the comparison reads it. */
export type CustomerSubject = {
  /** `place:<uuid>`. */
  key: string;
  id: string;
  seatId: string;
  repName: string;
  territory: string;
  line: string | null;
  region: string | null;
  /** The customer's name as the list writes it. */
  title: string;
  listType: string;
  speciality: string | null;
  /** The name folded and counted the signboard reader's way: each compound one word. */
  nameWords: string[];
  /** The kept point: the photograph's fix when there is one, otherwise the stored point. */
  point: GeoPoint;
  /** The rep's pin, when he dropped one. */
  pin: GeoPoint | null;
  /** The photograph's own fix, when it had one. */
  photo: GeoPoint | null;
  /** How far the rep's pin sits from his own photograph; null unless he has both. */
  pinGapMeters: number | null;
  areaName: string | null;
  brickName: string | null;
  address: string | null;
  capturedAt: string;
  capturedAtText: string;
  photoPath: string | null;
};

// ── The rule ─────────────────────────────────────────────────────────────────────────────────────

/** Two places of one name in one area further apart than this are listed. */
export const SAME_AREA_FAR_METERS = 1_000;
/** Validations of one customer within this of each other agree. */
export const AGREE_METERS = 150;
/** A pin this close to another rep's kept point sits on that point. */
export const PIN_ON_OTHER_METERS = 50;
/** …and is listed only when his own photograph was taken further than this from it. */
export const PIN_FAR_FROM_PHOTO_METERS = 150;

/**
 * The list's specialities, written many ways ("IM", "im", "Internal Medicine", "باطنه"), folded to one
 * word each. A speciality this does not know is unknown, and an unknown one never separates two names.
 */
const SPECIALITY_FAMILIES: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  ["internal", ["internal medicine", "im", "باطنه", "باطنة", "باطنه عامه", "استشاري الامراض الباطنيه"]],
  ["ent", ["ent", "انف واذن", "انف واذن وحنجره"]],
  ["chest", ["chest", "صدر", "شيست", "استشاري الصدر"]],
  ["neuro", ["neurology", "neuro", "nero", "neurological", "مخ واعصاب"]],
  ["urology", ["urology", "uro", "مسالك", "جراحه مسالك والكلي"]],
  ["surgery", ["general surgery", "جراحه عامه", "جراحة عامة", "جراحه", "استشاري الجراحه العامه"]],
  ["gp", ["general practitioner", "gp"]],
  ["pedia", ["pediatrics", "pedia", "بيديا", "اطفال"]],
  ["psychiatry", ["psychiatry"]],
  ["gastro", ["gastroenterologist"]],
  ["cardio", ["cardiology"]],
];

const SPECIALITY_BY_TEXT = new Map<string, string>(SPECIALITY_FAMILIES.flatMap(([family, spellings]) => spellings.map((spelling) => [spelling, family] as const)));

/** One family for a speciality the list writes several ways, or null when it is not one this knows. */
export function specialityFamily(value: string | null | undefined): string | null {
  const folded = String(value ?? "")
    .normalize("NFKC")
    .replace(/[‎‏؜]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return SPECIALITY_BY_TEXT.get(folded) ?? null;
}

/**
 * Whether two name word lists are one name: the same words, or — when the shorter has three words or
 * more — the shorter opening the longer ("احمد صبري مشعل" and "احمد صبري مشعل حسن"). A two-word name is
 * matched only whole: "محمد احمد" opens far too many other names to be evidence.
 */
export function sameName(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length < 2 || right.length < 2) return false;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (short.length < long.length && short.length < 3) return false;
  return short.every((word, index) => long[index] === word);
}

function sameArea(left: CustomerSubject, right: CustomerSubject): boolean {
  const fold = (value: string | null) => (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return fold(left.areaName) !== "" && fold(left.areaName) === fold(right.areaName);
}

/** The same customer on two reps' lists: one name, one list, and no known speciality against it. */
export function sameCustomer(left: CustomerSubject, right: CustomerSubject): boolean {
  if (left.seatId === right.seatId || left.listType !== right.listType) return false;
  if (!sameName(left.nameWords, right.nameWords)) return false;
  const leftFamily = specialityFamily(left.speciality);
  const rightFamily = specialityFamily(right.speciality);
  return leftFamily === null || rightFamily === null || leftFamily === rightFamily;
}

/** A rep's pin on another rep's kept point: how close it sits there, and how far from his own photograph. */
export type PinOnOther = { otherKey: string; otherRepName: string; pinToOtherMeters: number; pinToPhotoMeters: number };

export function pinOnOther(subject: CustomerSubject, other: CustomerSubject): PinOnOther | null {
  if (!subject.pin || !subject.photo) return null;
  const pinToPhoto = distanceMeters(subject.pin, subject.photo);
  if (pinToPhoto <= PIN_FAR_FROM_PHOTO_METERS) return null;
  const pinToOther = distanceMeters(subject.pin, other.point);
  if (pinToOther > PIN_ON_OTHER_METERS) return null;
  return { otherKey: other.key, otherRepName: other.repName, pinToOtherMeters: Math.round(pinToOther), pinToPhotoMeters: Math.round(pinToPhoto) };
}

export type CustomerPairReason = "same_area_far" | "pin_on_other";

/** Why a pair is listed, or null when it is not. */
export function pairReasons(left: CustomerSubject, right: CustomerSubject): CustomerPairReason[] {
  if (!sameCustomer(left, right)) return [];
  const reasons: CustomerPairReason[] = [];
  if (sameArea(left, right) && distanceMeters(left.point, right.point) > SAME_AREA_FAR_METERS) reasons.push("same_area_far");
  if (pinOnOther(left, right) || pinOnOther(right, left)) reasons.push("pin_on_other");
  return reasons;
}

// ── What the board carries ───────────────────────────────────────────────────────────────────────

export type CustomerMember = CustomerSubject & {
  /** 1, 2, … — validations with the same number sit within `AGREE_METERS` of each other. */
  point_group: number;
  /** How many validations of this customer sit at its point, itself included. */
  agreeing: number;
  /** Its pin sits on another rep's point for this customer, while its photograph is elsewhere. */
  pinOnOther: PinOnOther | null;
};

export type CustomerConflict = {
  id: string;
  /** The customer's name, as the longest validation writes it. */
  title: string;
  listType: string;
  areaName: string | null;
  /** Grouped by point, the largest point first. */
  members: CustomerMember[];
  seats: number;
  reasons: CustomerPairReason[];
  /** How many separate points the validations make. */
  points: number;
  /** The widest distance between two of its validations. */
  spreadMeters: number;
};

export type CustomerMatchInsights = {
  conflicts: number;
  sameAreaFar: number;
  pinOnOther: number;
  validations: number;
  reps: number;
};

export type CustomerMatchBoard = { conflicts: CustomerConflict[]; insights: CustomerMatchInsights };

// ── Building it ──────────────────────────────────────────────────────────────────────────────────

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

/** Validations of one conflict, numbered by the point they sit at — closest pairs join first. */
function pointGroups(members: ReadonlyArray<CustomerSubject>): number[] {
  const sets = new DisjointSet(members.length);
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) {
      if (distanceMeters(members[left].point, members[right].point) <= AGREE_METERS) sets.union(left, right);
    }
  }
  const sizes = new Map<number, number>();
  members.forEach((_, index) => sizes.set(sets.find(index), (sizes.get(sets.find(index)) ?? 0) + 1));
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([root]) => root);
  return members.map((_, index) => order.indexOf(sets.find(index)) + 1);
}

function spreadOf(members: ReadonlyArray<CustomerSubject>): number {
  let widest = 0;
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) widest = Math.max(widest, distanceMeters(members[left].point, members[right].point));
  }
  return widest;
}

export function buildCustomerMatchBoard(input: { subjects: ReadonlyArray<CustomerSubject> }): CustomerMatchBoard {
  const seen = new Set<string>();
  const subjects = input.subjects.filter((subject) => {
    if (seen.has(subject.key) || subject.nameWords.length < 2) return false;
    seen.add(subject.key);
    return Number.isFinite(subject.point.lat) && Number.isFinite(subject.point.lon);
  });

  // Only names that open the same way can be one name, so the pairs are drawn inside those buckets.
  const buckets = new Map<string, number[]>();
  subjects.forEach((subject, index) => {
    const key = `${subject.listType}|${subject.nameWords[0]} ${subject.nameWords[1]}`;
    const held = buckets.get(key);
    if (held) held.push(index);
    else buckets.set(key, [index]);
  });

  const sets = new DisjointSet(subjects.length);
  const flagged = new Set<number>();
  const reasonsByRoot = new Map<number, Set<CustomerPairReason>>();
  const edges: Array<{ left: number; right: number; reasons: CustomerPairReason[] }> = [];
  buckets.forEach((indexes) => {
    for (let a = 0; a < indexes.length; a += 1) {
      for (let b = a + 1; b < indexes.length; b += 1) {
        const reasons = pairReasons(subjects[indexes[a]], subjects[indexes[b]]);
        if (reasons.length === 0) continue;
        edges.push({ left: indexes[a], right: indexes[b], reasons });
        sets.union(indexes[a], indexes[b]);
        flagged.add(indexes[a]);
        flagged.add(indexes[b]);
      }
    }
  });
  for (const edge of edges) {
    const root = sets.find(edge.left);
    const held = reasonsByRoot.get(root) ?? new Set<CustomerPairReason>();
    edge.reasons.forEach((reason) => held.add(reason));
    reasonsByRoot.set(root, held);
  }

  // A conflict carries every validation of that customer, not only the two that raised it: the ones
  // that agree are what show which reading is the odd one. 🔴 Only from the same area or right beside a
  // listed reading — a common two-word name elsewhere in the country is somebody else.
  const byRoot = new Map<number, Set<number>>();
  for (const index of flagged) {
    const root = sets.find(index);
    const held = byRoot.get(root) ?? new Set<number>();
    held.add(index);
    byRoot.set(root, held);
  }
  byRoot.forEach((held) => {
    const first = subjects[[...held][0]];
    const bucket = buckets.get(`${first.listType}|${first.nameWords[0]} ${first.nameWords[1]}`) ?? [];
    for (const other of bucket) {
      if (held.has(other)) continue;
      const beside = (index: number) =>
        sameArea(subjects[index], subjects[other]) || distanceMeters(subjects[index].point, subjects[other].point) <= AGREE_METERS;
      if ([...held].some((index) => sameName(subjects[index].nameWords, subjects[other].nameWords) && sameCustomerIgnoringSeat(subjects[index], subjects[other]) && beside(index))) {
        held.add(other);
      }
    }
  });

  const conflicts: CustomerConflict[] = [];
  byRoot.forEach((held, root) => {
    const members = [...held].map((index) => subjects[index]);
    const groups = pointGroups(members);
    const agreeing = groups.map((group) => groups.filter((other) => other === group).length);
    const pins = members.map((member) => {
      for (const other of members) {
        if (other.seatId === member.seatId) continue;
        const found = pinOnOther(member, other);
        if (found) return found;
      }
      return null;
    });
    const drawn = members
      .map((member, index): CustomerMember => ({ ...member, point_group: groups[index], agreeing: agreeing[index], pinOnOther: pins[index] }))
      .sort((left, right) => left.point_group - right.point_group || left.repName.localeCompare(right.repName) || left.key.localeCompare(right.key));
    const longest = members.reduce((best, member) => (member.nameWords.length > best.nameWords.length ? member : best), members[0]);
    const areas = [...new Set(members.map((member) => member.areaName).filter((area): area is string => Boolean(area)))];
    conflicts.push({
      id: [...members.map((member) => member.key)].sort()[0],
      title: longest.title,
      listType: longest.listType,
      areaName: areas.length === 1 ? areas[0] : areas.length > 1 ? areas.join(" · ") : null,
      members: drawn,
      seats: new Set(members.map((member) => member.seatId)).size,
      reasons: [...(reasonsByRoot.get(root) ?? new Set<CustomerPairReason>())].sort(),
      points: Math.max(...groups),
      spreadMeters: Math.round(spreadOf(members)),
    });
  });
  // A pin on another rep's point first — it is the sharper signal — then the widest disagreement.
  conflicts.sort(
    (left, right) =>
      Number(right.reasons.includes("pin_on_other")) - Number(left.reasons.includes("pin_on_other")) ||
      right.spreadMeters - left.spreadMeters ||
      left.id.localeCompare(right.id),
  );
  return { conflicts, insights: customerInsightsOf(conflicts) };
}

/** A second validation of a listed customer by the SAME rep still belongs on the card beside the others. */
function sameCustomerIgnoringSeat(left: CustomerSubject, right: CustomerSubject): boolean {
  if (left.listType !== right.listType) return false;
  const leftFamily = specialityFamily(left.speciality);
  const rightFamily = specialityFamily(right.speciality);
  return leftFamily === null || rightFamily === null || leftFamily === rightFamily;
}

export function customerInsightsOf(conflicts: ReadonlyArray<CustomerConflict>): CustomerMatchInsights {
  return {
    conflicts: conflicts.length,
    sameAreaFar: conflicts.filter((conflict) => conflict.reasons.includes("same_area_far")).length,
    pinOnOther: conflicts.filter((conflict) => conflict.reasons.includes("pin_on_other")).length,
    validations: conflicts.reduce((total, conflict) => total + conflict.members.length, 0),
    reps: new Set(conflicts.flatMap((conflict) => conflict.members.map((member) => member.seatId))).size,
  };
}

// ── What the screen words ────────────────────────────────────────────────────────────────────────

export const CUSTOMER_REASON_TEXT: Record<CustomerPairReason, string> = {
  same_area_far: "One area, places far apart",
  pin_on_other: "A pin on another rep's point",
};

/** One sentence on what the conflict's own numbers say, in neutral words. */
export function conflictSentence(conflict: CustomerConflict): string {
  const parts: string[] = [];
  const pinned = conflict.members.find((member) => member.pinOnOther !== null);
  if (pinned?.pinOnOther) {
    parts.push(
      `${pinned.repName}'s pin sits ${formatDistance(pinned.pinOnOther.pinToOtherMeters)} from ${pinned.pinOnOther.otherRepName}'s validation of this customer, and ${formatDistance(pinned.pinOnOther.pinToPhotoMeters)} from ${pinned.repName}'s own photograph.`,
    );
  }
  if (conflict.reasons.includes("same_area_far")) {
    parts.push(
      `${conflict.areaName ? `In ${conflict.areaName}, the` : "The"} validations make ${conflict.points} separate points, up to ${formatDistance(conflict.spreadMeters)} apart: a second clinic, or a place that is not usable.`,
    );
  }
  return parts.join(" ");
}
