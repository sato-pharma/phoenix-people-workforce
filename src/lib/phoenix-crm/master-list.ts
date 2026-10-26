/**
 * Phoenix CRM — the Master List: every validated customer in the company, one profile per real place
 * (owner, 2026-10-26: "build a master page for only the admin, and the CEO ... the list source of trust
 * ... separate regions and areas ... and bricks, and put in each brick per speciality" — and in his own
 * Arabic: look at the repeated places first, take the nearest point and the best photo, and make it the
 * place's profile in Phoenix, with how many reps visit it, on which lines, its speciality, the usual time
 * of day, from when to when, and on which days).
 *
 * Pure and screen-free, so the loader, the page and the test share ONE rule. It stores nothing.
 *
 * A subject is one validated place of one customer on one rep's list. Subjects fold into ONE PROFILE when
 * their names are one name (`sameName`, the signboard reader's own counting), on the same list (AM, PM and
 * pharmacies are never mixed), no known speciality says otherwise, and their points sit within
 * `PROFILE_REACH_METERS`. The same rep holding a customer twice folds too.
 *
 * 🔴 THE PHOTOGRAPH IS THE ANCHOR (the Place checks' own rule). The profile wears ONE place's photo and
 * point: the owner's pick when he made one ("Master profile only" — the reps' own places are never moved),
 * otherwise the photographed place most of the others agree with, then the sharpest fix.
 *
 * 🔴 CONFIRMED IS EARNED, NEVER ASSUMED. He chose "my click and automatic": his click wins either way;
 * without it a profile is confirmed only when its anchor is a photograph, every point sits within
 * `AGREE_METERS` of it, and either two reps' photographs agree or the visits settle it. Everything else
 * "needs a look", with a neutral reason — a far reading is "not usable", never an accusation.
 */

import { sameName, specialityFamily } from "@/lib/phoenix-crm/customer-match-groups";
import { distanceMeters, type GeoPoint } from "@/lib/phoenix-crm/geo";

// ── The rule ─────────────────────────────────────────────────────────────────────────────────────

/** Two validations of one name further apart than this are two places, two profiles. */
export const PROFILE_REACH_METERS = 500;
/** Points within this of the anchor agree with it. */
export const AGREE_METERS = 150;
/** Visits that settle a single photographed place: at least this many… */
export const SETTLING_VISITS = 3;
/** …with at least this share read at the place. */
export const SETTLING_SHARE = 0.8;
/** How far back the visit timings read. */
export const TIMING_DAYS = 90;

export type MasterListType = "AM" | "PM" | "Pharmacy" | string;

/** One validated place of one customer, as the Master List reads it. */
export type MasterSubject = {
  placeId: string;
  customerId: string;
  seatId: string;
  title: string;
  listType: MasterListType;
  speciality: string | null;
  /** The name counted the signboard reader's way: each compound one word. */
  nameWords: string[];
  /** The kept point (photo, else stored, else pin), or null when the place has none. */
  point: GeoPoint | null;
  /** Whether the kept point is the photograph's own fix. */
  pointIsPhoto: boolean;
  accuracyMeters: number | null;
  photoPath: string | null;
  regionName: string | null;
  areaName: string | null;
  brickName: string | null;
  address: string | null;
  capturedAt: string;
  /** Who validated it — a name, never an id. */
  repName: string;
  lineName: string | null;
};

/** One visit of one of the profile's customers, as the timings read it. */
export type MasterVisit = {
  customerId: string;
  /** The Cairo date of the visit, YYYY-MM-DD. */
  visitDate: string;
  /** Cairo minutes after midnight when it was captured, or null. */
  minuteOfDay: number | null;
  dwellSeconds: number | null;
  /** Read at the place (`location_flag = 'ok'`). Only the count of these leaves this file. */
  atPlace: boolean;
  repHrId: string | null;
};

export type MasterVerdict = "confirmed" | "rejected";

/** His stored word on a profile, keyed by the place whose photo the profile wears. */
export type MasterDecision = {
  anchorPlaceId: string;
  verdict: MasterVerdict;
  note: string | null;
  decidedByName: string;
  decidedAt: string;
};

export type MasterStatus = "confirmed" | "needs_look" | "rejected";
export type MasterStatusSource = "owner" | "automatic";

export type MasterTimings = {
  visits: number;
  repsVisiting: number;
  /** The middle half of the capture times, Cairo minutes after midnight. */
  usualFrom: number | null;
  usualTo: number | null;
  earliest: number | null;
  latest: number | null;
  /** Visit length from the phone's own time at the door: shortest, typical, longest, in minutes. */
  shortestMinutes: number | null;
  typicalMinutes: number | null;
  longestMinutes: number | null;
  /** Sunday first: [Sun, Mon, Tue, Wed, Thu, Fri, Sat]. */
  weekdays: number[];
};

export type MasterProfile = {
  /** The anchor place's id — stable while the anchor stands, and what a decision keys on. */
  id: string;
  title: string;
  listType: MasterListType;
  speciality: string | null;
  /** The group the profile is filed under in its brick. */
  groupLabel: string;
  anchor: MasterSubject;
  members: MasterSubject[];
  /** Every place's photo path, the anchor's first. */
  photoPaths: string[];
  regionName: string;
  areaName: string;
  brickName: string;
  /** The reps whose lists hold the customer, and their lines. */
  holders: Array<{ repName: string; lineName: string | null }>;
  lines: string[];
  /** How far the furthest point sits from the anchor, metres; null when only one point. */
  spreadMeters: number | null;
  status: MasterStatus;
  statusSource: MasterStatusSource;
  /** Why it is where it is, in plain neutral words. */
  reason: string;
  decision: MasterDecision | null;
  timings: MasterTimings;
};

export const NOT_SET = "Not set";
export const PHARMACIES_GROUP = "Pharmacies";

const FAMILY_LABEL: Record<string, string> = {
  internal: "Internal Medicine",
  ent: "ENT",
  chest: "Chest",
  neuro: "Neurology",
  urology: "Urology",
  surgery: "General Surgery",
  gp: "General Practice",
  pedia: "Pediatrics",
  psychiatry: "Psychiatry",
  gastro: "Gastroenterology",
  cardio: "Cardiology",
};

/** The brick group a profile is filed under: its speciality family, or Pharmacies. */
export function groupLabelOf(listType: string, speciality: string | null): string {
  if (listType === "Pharmacy") return PHARMACIES_GROUP;
  const family = specialityFamily(speciality);
  if (family) return FAMILY_LABEL[family] ?? family;
  const raw = (speciality ?? "").replace(/\s+/g, " ").trim();
  return raw ? raw : "Speciality not set";
}

function compatible(left: MasterSubject, right: MasterSubject): boolean {
  if (left.listType !== right.listType) return false;
  if (!sameName(left.nameWords, right.nameWords)) return false;
  if (!left.point || !right.point) return false;
  const leftFamily = specialityFamily(left.speciality);
  const rightFamily = specialityFamily(right.speciality);
  if (leftFamily !== null && rightFamily !== null && leftFamily !== rightFamily) return false;
  return distanceMeters(left.point, right.point) <= PROFILE_REACH_METERS;
}

/** Folds the subjects into groups of one customer at one place. Each subject lands in exactly one group. */
export function foldSubjects(subjects: ReadonlyArray<MasterSubject>): MasterSubject[][] {
  const parent = subjects.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  // Every name sameName can match shares its first two words — the only pairs worth measuring.
  const buckets = new Map<string, number[]>();
  subjects.forEach((subject, index) => {
    if (subject.nameWords.length < 2 || !subject.point) return;
    const key = `${subject.listType}|${subject.nameWords[0]}|${subject.nameWords[1]}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
  });
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        if (compatible(subjects[bucket[i]], subjects[bucket[j]])) parent[find(bucket[i])] = find(bucket[j]);
      }
    }
  }
  const groups = new Map<number, MasterSubject[]>();
  subjects.forEach((subject, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(subject);
    groups.set(root, group);
  });
  return [...groups.values()];
}

function accuracyOf(subject: MasterSubject): number {
  return subject.accuracyMeters ?? Number.POSITIVE_INFINITY;
}

/**
 * The automatic anchor: among the photographed places, the one most of the others agree with, then the
 * sharpest fix, then the earliest. With no photograph, the sharpest point; with no point, the earliest.
 */
export function automaticAnchor(members: ReadonlyArray<MasterSubject>): MasterSubject {
  const photographed = members.filter((member) => member.pointIsPhoto && member.point);
  const pool = photographed.length > 0 ? photographed : members.filter((member) => member.point);
  if (pool.length === 0) return [...members].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.placeId.localeCompare(b.placeId))[0];
  const agreeing = (subject: MasterSubject) =>
    members.filter((other) => other.point && subject.point && distanceMeters(subject.point, other.point) <= AGREE_METERS).length;
  return [...pool].sort(
    (a, b) =>
      agreeing(b) - agreeing(a) ||
      accuracyOf(a) - accuracyOf(b) ||
      a.capturedAt.localeCompare(b.capturedAt) ||
      a.placeId.localeCompare(b.placeId),
  )[0];
}

function quantile(sorted: ReadonlyArray<number>, share: number): number {
  const position = (sorted.length - 1) * share;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (position - low));
}

/** The weekday of a YYYY-MM-DD date, Sunday 0 — read off the date itself, never a clock. */
export function weekdayOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function timingsOf(visits: ReadonlyArray<MasterVisit>): MasterTimings {
  const minutes = visits.map((visit) => visit.minuteOfDay).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const dwell = visits
    .map((visit) => visit.dwellSeconds)
    .filter((value): value is number => value !== null && value > 0)
    .sort((a, b) => a - b);
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  for (const visit of visits) weekdays[weekdayOf(visit.visitDate)] += 1;
  const toMinutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));
  return {
    visits: visits.length,
    repsVisiting: new Set(visits.map((visit) => visit.repHrId).filter(Boolean)).size,
    usualFrom: minutes.length ? quantile(minutes, 0.25) : null,
    usualTo: minutes.length ? quantile(minutes, 0.75) : null,
    earliest: minutes.length ? minutes[0] : null,
    latest: minutes.length ? minutes[minutes.length - 1] : null,
    shortestMinutes: dwell.length ? toMinutes(dwell[0]) : null,
    typicalMinutes: dwell.length ? toMinutes(quantile(dwell, 0.5)) : null,
    longestMinutes: dwell.length ? toMinutes(dwell[dwell.length - 1]) : null,
    weekdays,
  };
}

/** The automatic status of a profile and its plain reason. */
export function automaticStatus(
  anchor: MasterSubject,
  members: ReadonlyArray<MasterSubject>,
  visits: ReadonlyArray<MasterVisit>,
): { status: Exclude<MasterStatus, "rejected">; reason: string } {
  if (!anchor.point) return { status: "needs_look", reason: "No point was kept for this place" };
  if (!anchor.pointIsPhoto) return { status: "needs_look", reason: "No photograph of the door yet" };
  const far = members.filter((member) => !member.point || distanceMeters(anchor.point as GeoPoint, member.point) > AGREE_METERS);
  if (far.length > 0) return { status: "needs_look", reason: "The reps' points do not all sit together" };
  const photoSeats = new Set(members.filter((member) => member.pointIsPhoto).map((member) => member.seatId));
  if (photoSeats.size >= 2) return { status: "confirmed", reason: `${photoSeats.size} reps' photographs agree` };
  const atPlace = visits.filter((visit) => visit.atPlace).length;
  if (visits.length >= SETTLING_VISITS && atPlace / visits.length >= SETTLING_SHARE) {
    return { status: "confirmed", reason: `The photograph and ${visits.length} visits agree` };
  }
  if (visits.length < SETTLING_VISITS) return { status: "needs_look", reason: "One photograph, and too few visits yet to settle it" };
  return { status: "needs_look", reason: "The visits have not settled the point yet" };
}

function firstText(...values: ReadonlyArray<string | null | undefined>): string {
  for (const value of values) {
    const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
    if (cleaned) return cleaned;
  }
  return NOT_SET;
}

/**
 * Builds every profile: fold, take the anchor (his pick when a decision names a place in the group),
 * read the timings of the group's customers, and settle the status.
 */
export function buildMasterProfiles(input: {
  subjects: ReadonlyArray<MasterSubject>;
  visits: ReadonlyArray<MasterVisit>;
  decisions: ReadonlyArray<MasterDecision>;
}): MasterProfile[] {
  const decisionByPlace = new Map(input.decisions.map((decision) => [decision.anchorPlaceId, decision]));
  const visitsByCustomer = new Map<string, MasterVisit[]>();
  for (const visit of input.visits) {
    const list = visitsByCustomer.get(visit.customerId) ?? [];
    list.push(visit);
    visitsByCustomer.set(visit.customerId, list);
  }

  const profiles: MasterProfile[] = [];
  for (const members of foldSubjects(input.subjects)) {
    const decided = members.find((member) => decisionByPlace.has(member.placeId)) ?? null;
    const decision = decided ? (decisionByPlace.get(decided.placeId) as MasterDecision) : null;
    const anchor = decided ?? automaticAnchor(members);
    const customerIds = new Set(members.map((member) => member.customerId));
    const visits = [...customerIds].flatMap((id) => visitsByCustomer.get(id) ?? []);
    const automatic = automaticStatus(anchor, members, visits);
    const status: MasterStatus = decision ? decision.verdict : automatic.status;
    const ordered = [anchor, ...members.filter((member) => member !== anchor).sort((a, b) => accuracyOf(a) - accuracyOf(b) || a.placeId.localeCompare(b.placeId))];
    const spread = members.length > 1 && anchor.point
      ? Math.round(Math.max(0, ...members.map((member) => (member.point ? distanceMeters(anchor.point as GeoPoint, member.point) : 0))))
      : null;
    const holders = ordered.map((member) => ({ repName: member.repName, lineName: member.lineName }));
    const lines = [...new Set(ordered.map((member) => member.lineName).filter((line): line is string => Boolean(line)))].sort();
    const speciality = ordered.map((member) => member.speciality).find(Boolean) ?? null;
    profiles.push({
      id: anchor.placeId,
      title: anchor.title,
      listType: anchor.listType,
      speciality,
      groupLabel: groupLabelOf(anchor.listType, speciality),
      anchor,
      members: ordered,
      photoPaths: ordered.map((member) => member.photoPath).filter((path): path is string => Boolean(path)),
      regionName: firstText(anchor.regionName, ...ordered.map((member) => member.regionName)),
      areaName: firstText(anchor.areaName, ...ordered.map((member) => member.areaName)),
      brickName: firstText(anchor.brickName, ...ordered.map((member) => member.brickName)),
      holders,
      lines,
      spreadMeters: spread,
      status,
      statusSource: decision ? "owner" : "automatic",
      reason: decision
        ? decision.verdict === "confirmed"
          ? `Confirmed by ${decision.decidedByName}`
          : `Not confirmed by ${decision.decidedByName}`
        : automatic.reason,
      decision,
      timings: timingsOf(visits),
    });
  }
  return profiles.sort(
    (a, b) =>
      a.regionName.localeCompare(b.regionName) ||
      a.areaName.localeCompare(b.areaName) ||
      a.brickName.localeCompare(b.brickName) ||
      a.groupLabel.localeCompare(b.groupLabel) ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id),
  );
}

// ── The page's grouping and counts ───────────────────────────────────────────────────────────────

export type MasterCounts = { profiles: number; confirmed: number; needsLook: number; rejected: number; folded: number };

export function countsOf(profiles: ReadonlyArray<MasterProfile>): MasterCounts {
  return {
    profiles: profiles.length,
    confirmed: profiles.filter((profile) => profile.status === "confirmed").length,
    needsLook: profiles.filter((profile) => profile.status === "needs_look").length,
    rejected: profiles.filter((profile) => profile.status === "rejected").length,
    folded: profiles.filter((profile) => profile.members.length > 1).length,
  };
}

export type MasterAreaRow = { regionName: string; areaName: string; bricks: number; counts: MasterCounts };

/** One row per region × area, for the overview. */
export function areaRowsOf(profiles: ReadonlyArray<MasterProfile>): MasterAreaRow[] {
  const byArea = new Map<string, MasterProfile[]>();
  for (const profile of profiles) {
    const key = `${profile.regionName}|${profile.areaName}`;
    const list = byArea.get(key) ?? [];
    list.push(profile);
    byArea.set(key, list);
  }
  return [...byArea.values()]
    .map((list) => ({
      regionName: list[0].regionName,
      areaName: list[0].areaName,
      bricks: new Set(list.map((profile) => profile.brickName)).size,
      counts: countsOf(list),
    }))
    .sort((a, b) => a.regionName.localeCompare(b.regionName) || a.areaName.localeCompare(b.areaName));
}

export type MasterBrick = { brickName: string; groups: Array<{ label: string; profiles: MasterProfile[] }> };

/** One area's bricks, each with its speciality groups and Pharmacies last. */
export function bricksOf(profiles: ReadonlyArray<MasterProfile>): MasterBrick[] {
  const byBrick = new Map<string, Map<string, MasterProfile[]>>();
  for (const profile of profiles) {
    const groups = byBrick.get(profile.brickName) ?? new Map<string, MasterProfile[]>();
    const list = groups.get(profile.groupLabel) ?? [];
    list.push(profile);
    groups.set(profile.groupLabel, list);
    byBrick.set(profile.brickName, groups);
  }
  const groupOrder = (label: string) => (label === PHARMACIES_GROUP ? 1 : 0);
  return [...byBrick.entries()]
    .sort(([a], [b]) => Number(a === NOT_SET) - Number(b === NOT_SET) || a.localeCompare(b))
    .map(([brickName, groups]) => ({
      brickName,
      groups: [...groups.entries()]
        .sort(([a], [b]) => groupOrder(a) - groupOrder(b) || a.localeCompare(b))
        .map(([label, list]) => ({ label, profiles: list })),
    }));
}

export type MasterFilter = { region?: string | null; area?: string | null; brick?: string | null; status?: string | null; q?: string | null };

export function filterProfiles(profiles: ReadonlyArray<MasterProfile>, filter: MasterFilter): MasterProfile[] {
  const query = (filter.q ?? "").normalize("NFKC").trim().toLowerCase();
  return profiles.filter(
    (profile) =>
      (!filter.region || profile.regionName === filter.region) &&
      (!filter.area || profile.areaName === filter.area) &&
      (!filter.brick || profile.brickName === filter.brick) &&
      (!filter.status || profile.status === filter.status) &&
      (!query || profile.title.normalize("NFKC").toLowerCase().includes(query)),
  );
}

// ── What the screen words ────────────────────────────────────────────────────────────────────────

export const STATUS_TEXT: Record<MasterStatus, string> = {
  confirmed: "Confirmed",
  needs_look: "Needs a look",
  rejected: "Not confirmed",
};

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "10:30 am" from Cairo minutes after midnight. */
export function clockText(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const half = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${half}`;
}

/** The days the visits fall on, busiest first: "Sun 4 · Tue 2". */
export function weekdaysText(weekdays: ReadonlyArray<number>): string {
  const days = weekdays
    .map((count, index) => ({ count, index }))
    .filter((day) => day.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index);
  return days.length ? days.map((day) => `${WEEKDAY_NAMES[day.index]} ${day.count}`).join(" · ") : "No visits yet";
}
