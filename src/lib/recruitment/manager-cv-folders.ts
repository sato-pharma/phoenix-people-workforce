// Recruitment / ATS — every manager's CV folders, filled ONLY by what Talent Acquisition sends.
//
// The owner, 2026-10-16: "no more managers receive CVs automatic. Every manager has an empty folder
// for every area in his region, based on the organogram. The TA or admin pushes a CV whenever
// needed and can any time get it back. When the CV reaches the manager there is no restriction —
// he can download, see the number, do anything."
//
// So the shelves here are the organogram's alone (a folder per area, one catch-all), they start
// EMPTY, and a CV is on one only because a send row says so. Nothing in this file looks at a
// candidate's declared area, address or governorate to decide that a manager should receive them;
// those are used in exactly one place, `chooseFolderForPush`, to suggest which of the manager's
// folders a CV the recruiter has ALREADY chosen to send should be put in.
//
// PURE — no database, no React, for the reason district-manager-folders.ts is: it is reached from a
// "use client" screen, and a database import anywhere in the chain drags the service-role client
// into the browser bundle. The loader is district-manager-folders-db.ts.

import { canonicalHrIdKey } from "@/lib/hr-id";
import { areaGovernedByCv, areaNamedByCv } from "@/lib/recruitment/cv-address-place";
import {
  ancestorSeatIds,
  areaFolderKey,
  districtManagerBoards,
  districtReturnSuppressionKey,
  indexBySeatId,
  type DistrictAreaFolder,
  type DistrictManagerBoard,
  type DistrictSeatRow,
} from "@/lib/recruitment/district-manager-folders";

/**
 * The one folder that catches a CV whose area is none of the manager's.
 *
 * Replaces "No area named", which described a CV the system had filed on its own. A CV in here was
 * sent by a person, and the name says only that it fits none of the areas on the shelf.
 */
export const OTHER_CVS_FOLDER_LABEL = "Other CVs";

/** The fact a folder is built from: a recruiter sent this candidate to this manager. */
export type FolderSend = {
  candidateId: string;
  managerHrId: string;
  sentAt: string;
  /** The area the recruiter sent the CV for — null when none was named. */
  folderArea: string | null;
};

function text(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function emptyFolder<T>(areaName: string, kind: DistrictAreaFolder<T>["kind"]): DistrictAreaFolder<T> {
  return { areaName, candidates: [] as T[], fromCvText: [], fromGovernorate: [], kind };
}

/** The tiers above a district that get a folder per area beneath them. The CEO never does. */
const ABOVE_DISTRICT_TIERS = new Set(["RSM", "NSM"]);

/**
 * Every manager's empty shelves, straight off the organogram.
 *
 * A district manager (or the acting one) holds the areas of his own district. A regional or national
 * sales manager holds EVERY area beneath him, merged into one board — the owner's "every area in
 * his region" — and a vacant district's manager seat climbs to whoever covers it, exactly as the
 * district boards always did. A person who holds a regional or national board does not also get a
 * second board for a vacant district he covers, because its areas are already on the first.
 */
export function managerFolderShelves<T>(rows: readonly DistrictSeatRow[]): DistrictManagerBoard<T>[] {
  const bySeatId = indexBySeatId(rows);
  const districts = districtManagerBoards<T>(rows);

  const districtBoards: DistrictManagerBoard<T>[] = districts.map((board) => ({
    ...board,
    folders: board.folders.map((folder) =>
      folder.kind === "region" ? emptyFolder<T>(OTHER_CVS_FOLDER_LABEL, "region") : folder,
    ),
  }));

  const areasByManagerSeat = new Map<string, Map<string, string>>();
  for (const district of districts) {
    const areaNames = district.folders.filter((folder) => folder.kind === "area").map((folder) => folder.areaName);
    for (const ancestorId of ancestorSeatIds(district.seatId, bySeatId)) {
      const seat = bySeatId.get(ancestorId);
      if (!seat) continue;
      if (!ABOVE_DISTRICT_TIERS.has(text(seat.seat_tier).toUpperCase())) continue;
      if (!text(seat.occupant_hr_id) || seat.is_vacant === true) continue;
      const held = areasByManagerSeat.get(ancestorId) ?? new Map<string, string>();
      for (const areaName of areaNames) {
        const key = areaFolderKey(areaName);
        if (key && !held.has(key)) held.set(key, areaName);
      }
      areasByManagerSeat.set(ancestorId, held);
    }
  }

  const managerBoards: DistrictManagerBoard<T>[] = [];
  for (const [seatId, areas] of areasByManagerSeat) {
    const seat = bySeatId.get(seatId);
    if (!seat) continue;
    const names = [...areas.values()].sort((left, right) => left.localeCompare(right));
    managerBoards.push({
      candidateCount: 0,
      coveringVacantSeat: null,
      folders: [...names.map((name) => emptyFolder<T>(name, "area")), emptyFolder<T>(OTHER_CVS_FOLDER_LABEL, "region")],
      intake: "reps",
      lineName: text(seat.line_name) || null,
      managerHrId: text(seat.occupant_hr_id),
      regionName: text(seat.region_name) || null,
      seatId,
      seatLabel: text(seat.seat_display_label) || seatId,
      seatTier: text(seat.seat_tier).toUpperCase() || null,
    });
  }

  const holdsAboveDistrictBoard = new Set(
    managerBoards.map((board) => canonicalHrIdKey(board.managerHrId)).filter((key): key is string => Boolean(key)),
  );
  const keptDistrictBoards = districtBoards.filter((board) => {
    if (!board.coveringVacantSeat) return true;
    const key = canonicalHrIdKey(board.managerHrId);
    return !(key && holdsAboveDistrictBoard.has(key));
  });

  return [...keptDistrictBoards, ...managerBoards].sort(
    (left, right) =>
      (left.lineName ?? "").localeCompare(right.lineName ?? "") ||
      (left.regionName ?? "").localeCompare(right.regionName ?? "") ||
      left.seatLabel.localeCompare(right.seatLabel),
  );
}

/** The boards that belong to one manager, matched the way every other HR_ID comparison here is. */
function boardsOf<T>(boards: readonly DistrictManagerBoard<T>[], managerHrId: string | null | undefined) {
  const key = canonicalHrIdKey(managerHrId);
  if (!key) return [];
  return boards.filter((board) => canonicalHrIdKey(board.managerHrId) === key);
}

/**
 * Put each sent CV on the shelf it was sent for.
 *
 * Newest send first, so a folder opens on the CV that arrived last. A send whose area matches none
 * of the manager's folders goes to the catch-all of his first board, and a send to somebody with no
 * shelf at all (a head-office manager) is simply not filed — those CVs stay on "Sent to you".
 * Returns NEW boards; the shelves passed in are not touched.
 */
export function fillShelvesFromSends<T extends { id: string }>(input: {
  shelves: readonly DistrictManagerBoard<T>[];
  sends: readonly FolderSend[];
  candidates: ReadonlyMap<string, T>;
}): DistrictManagerBoard<T>[] {
  const boards: DistrictManagerBoard<T>[] = input.shelves.map((board) => ({
    ...board,
    candidateCount: 0,
    folders: board.folders.map((folder) => ({ ...folder, candidates: [] as T[] })),
  }));
  const filed = new Map<DistrictManagerBoard<T>, Set<string>>();

  const newestFirst = [...input.sends].sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt));
  for (const send of newestFirst) {
    const candidate = input.candidates.get(send.candidateId);
    if (!candidate) continue;
    const mine = boardsOf(boards, send.managerHrId);
    if (mine.length === 0) continue;

    const wanted = areaFolderKey(send.folderArea);
    let target: { board: DistrictManagerBoard<T>; folder: DistrictAreaFolder<T> } | null = null;
    if (wanted) {
      for (const board of mine) {
        const folder = board.folders.find((entry) => entry.kind === "area" && areaFolderKey(entry.areaName) === wanted);
        if (folder) {
          target = { board, folder };
          break;
        }
      }
    }
    if (!target) {
      const board = mine[0]!;
      const folder = board.folders.find((entry) => entry.kind === "region");
      if (!folder) continue;
      target = { board, folder };
    }

    const seen = filed.get(target.board) ?? new Set<string>();
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    filed.set(target.board, seen);
    target.folder.candidates.push(candidate);
    target.board.candidateCount += 1;
  }
  return boards;
}

type CandidateAreaHints = {
  address?: string | null;
  governorate?: string | null;
  preferencesDeclaredAt?: string | null;
  preferredAreaName?: string | null;
};

/**
 * Which of the manager's folders a CV that is being sent should go in — or null for "Other CVs".
 *
 * Only ever called with a CV a person has already decided to send. Strongest first: the folder the
 * recruiter named, the area of the position he sent it for, the area the applicant declared, then
 * the area their CV's own text names. Every answer must be one of the manager's real area folders,
 * so nothing here can invent a folder; an unclear answer is null rather than a guess.
 */
export function chooseFolderForPush(input: {
  boards: readonly DistrictManagerBoard<unknown>[];
  candidate?: CandidateAreaHints | null;
  positionArea?: string | null;
  requested?: string | null;
}): string | null {
  const areaNames = new Map<string, string>();
  for (const board of input.boards) {
    for (const folder of board.folders) {
      if (folder.kind !== "area") continue;
      const key = areaFolderKey(folder.areaName);
      if (key && !areaNames.has(key)) areaNames.set(key, folder.areaName);
    }
  }
  if (areaNames.size === 0) return null;

  const named = (value: string | null | undefined): string | null => areaNames.get(areaFolderKey(value)) ?? null;

  const requested = named(input.requested);
  if (requested) return requested;
  const fromPosition = named(input.positionArea);
  if (fromPosition) return fromPosition;

  const candidate = input.candidate;
  if (candidate?.preferencesDeclaredAt) {
    const declared = named(candidate.preferredAreaName);
    if (declared) return declared;
  }
  if (candidate) {
    const place = { address: candidate.address, governorate: candidate.governorate };
    const names = [...areaNames.values()];
    const evidence = areaNamedByCv(place, names) ?? areaGovernedByCv(place, names);
    if (evidence) return named(evidence.areaName);
  }
  return null;
}

/**
 * Has the CV not been opened since it was sent to him? `lastSeenAt` is his last open of it, if any.
 * Unreadable on either side counts as unseen: a CV nobody can prove he opened is one he is still owed.
 */
export function isSendUnseen(sentAt: string | null | undefined, lastSeenAt: string | null | undefined): boolean {
  const sent = Date.parse(String(sentAt ?? ""));
  const seen = Date.parse(String(lastSeenAt ?? ""));
  if (!Number.isFinite(seen)) return true;
  if (!Number.isFinite(sent)) return false;
  return seen < sent;
}

/** Ids of the CVs on these boards the viewer has not opened since they were sent to him. */
export function unseenIdsOnBoards<T extends { id: string; managerNotified?: { sentAt?: string | null } | null }>(
  boards: readonly DistrictManagerBoard<T>[],
  lastSeenAt: (candidateId: string) => string | null | undefined,
): string[] {
  const unseen = new Set<string>();
  for (const board of boards) {
    for (const folder of board.folders) {
      for (const candidate of folder.candidates) {
        if (isSendUnseen(candidate.managerNotified?.sentAt, lastSeenAt(candidate.id))) unseen.add(candidate.id);
      }
    }
  }
  return [...unseen];
}

/** One chip on the overview: a folder that holds CVs, and how many of them are still unopened. */
export type ManagerFolderChip = {
  count: number;
  lineName: string | null;
  name: string;
  unseen: number;
};

export type ManagerFolderSummary = {
  chips: ManagerFolderChip[];
  emptyFolders: number;
  totalCandidates: number;
  totalFolders: number;
  unseenCandidates: number;
};

/**
 * The overview row's numbers. `isUnseen` is asked per candidate: the manager has not yet opened the
 * CV sent to him. Folders holding nothing are only counted, never listed — the row is a prompt to
 * open the ones that matter, and a screen of eight empty chips hides the one with a CV in it.
 */
export function summarizeManagerFolders<T extends { id: string }>(
  boards: readonly DistrictManagerBoard<T>[],
  isUnseen: (candidateId: string) => boolean,
): ManagerFolderSummary {
  const chips: ManagerFolderChip[] = [];
  let totalFolders = 0;
  let emptyFolders = 0;
  const everyone = new Set<string>();
  const unseenEveryone = new Set<string>();

  for (const board of boards) {
    for (const folder of board.folders) {
      totalFolders += 1;
      if (folder.candidates.length === 0) {
        emptyFolders += 1;
        continue;
      }
      let unseen = 0;
      for (const candidate of folder.candidates) {
        everyone.add(candidate.id);
        if (isUnseen(candidate.id)) {
          unseen += 1;
          unseenEveryone.add(candidate.id);
        }
      }
      chips.push({ count: folder.candidates.length, lineName: board.lineName, name: folder.areaName, unseen });
    }
  }

  chips.sort((left, right) => right.unseen - left.unseen || right.count - left.count || left.name.localeCompare(right.name));
  return {
    chips,
    emptyFolders,
    totalCandidates: everyone.size,
    totalFolders,
    unseenCandidates: unseenEveryone.size,
  };
}

/**
 * The sends a manager has not yet opened, grouped by manager — what the reminder cron works from.
 *
 * `lastSeenByKey` is keyed with `districtReturnSuppressionKey(manager, candidate)`, the one key every
 * per-manager fact about a CV uses. A CV counts as seen when his last open is at or after the send,
 * so a re-push after an old open is unseen again — the manager is being asked again.
 */
export function unseenSendsByManager(input: {
  lastSeenByKey: ReadonlyMap<string, string>;
  sends: readonly FolderSend[];
}): Map<string, { candidateIds: string[]; managerHrId: string }> {
  const grouped = new Map<string, { candidateIds: string[]; managerHrId: string }>();
  for (const send of input.sends) {
    const managerKey = canonicalHrIdKey(send.managerHrId);
    if (!managerKey) continue;
    const lastSeen = Date.parse(input.lastSeenByKey.get(districtReturnSuppressionKey(send.managerHrId, send.candidateId)) ?? "");
    const sentAt = Date.parse(send.sentAt);
    if (Number.isFinite(lastSeen) && Number.isFinite(sentAt) && lastSeen >= sentAt) continue;
    const entry = grouped.get(managerKey) ?? { candidateIds: [], managerHrId: send.managerHrId };
    if (!entry.candidateIds.includes(send.candidateId)) entry.candidateIds.push(send.candidateId);
    grouped.set(managerKey, entry);
  }
  return grouped;
}

/** The first and last Cairo clock hours at which a reminder may go out. Outside them it waits. */
export const REMINDER_FIRST_HOUR_CAIRO = 8;
export const REMINDER_LAST_HOUR_CAIRO = 21;

/**
 * How long a CV keeps reminding after it reaches a folder (owner, 2026-10-16: "stop the folder
 * reminder after 7 days"). The CV itself stays in the folder; only the nag ends. One number, read by
 * the job and by nothing that decides who holds a CV.
 */
export const REMINDER_MAX_DAYS = 7;

/**
 * True while a send is young enough to remind about. Strictly under {@link REMINDER_MAX_DAYS} days
 * old, and a send whose time cannot be read is NOT reminded: a nag with no clock on it is exactly
 * what the cap exists to stop.
 */
export function isWithinReminderWindow(sentAt: string, now: Date): boolean {
  const sent = Date.parse(sentAt);
  if (!Number.isFinite(sent)) return false;
  return now.getTime() - sent < REMINDER_MAX_DAYS * 24 * 60 * 60 * 1000;
}

/** The Cairo wall-clock hour (0-23) of an instant. */
export function cairoHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Africa/Cairo" }).format(now);
  return Number(hour) % 24;
}

/** Reminders go out hourly through the working day, and wait through the night. */
export function isReminderHour(now: Date): boolean {
  const hour = cairoHour(now);
  return hour >= REMINDER_FIRST_HOUR_CAIRO && hour <= REMINDER_LAST_HOUR_CAIRO;
}

/** The start of the hour an instant falls in, ISO — the reminder's identity within a run. */
export function reminderHourBucket(now: Date): string {
  const bucket = new Date(now);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket.toISOString();
}
