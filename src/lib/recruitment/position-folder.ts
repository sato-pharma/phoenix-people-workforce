// Recruitment / ATS — the POSITION a CV was sent for, and the folder that follows from it.
//
// WHY. Until 2026-08-28 a send recorded who the CV went to and, since the night before, that
// manager's own seat. The owner's follow-up named what was still missing:
//
//   "he wants to hire Nasr City Medical Rep. He goes to a folder which is called Nasr City Medical
//    Reps ... automated foldering based on the area, so he can look at the same page when he wants
//    a certain position."
//
// A manager's seat is not the seat he is hiring for, and one manager holds several of the second.
// Measured in production that morning: 35 open vacancies across 34 areas, all but one of them
// Medical Representative. Grouping by manager therefore produces piles of the wrong shape — Ahmed
// Mohamed Nagy alone is the named manager on five open seats in four different areas.
//
// THE LINE IS PART OF THE IDENTITY, not decoration. Nasr City carries TWO open Medical
// Representative seats: Anti Infective reporting to Momen Abdelhady Mohamed Shehata, and Pedia
// reporting to Ahmed Mohamed Nagy. A folder keyed on area and title alone merges two vacancies
// that belong to two different people.
//
// KEYED ON THE TEXT, NOT THE VACANCY ID — deliberately, and this is the whole reason the free-typed
// option is safe. The owner asked (2026-08-28) for both a picked vacancy and a typed one. If the
// key were the vacancy id, a CV filed by picking "Nasr City · Medical Representative · Pedia" and
// one filed by typing the same words would sit in two folders that read identically, which is
// exactly the drift he was promised would not happen. Normalising the text merges them; the
// vacancy id still rides along on the row for traceability back to the org chart.
//
// Pure on purpose — no React, no database — so the recruiter's screen, the manager's screen and the
// tests all fold the same way and cannot drift apart. Same discipline as manager-grouping.ts.

import type { Candidate, SentForPosition } from "@/lib/recruitment/types";

export type { SentForPosition };

export type PositionFolder = {
  /** Stable identity for React keys and for sorting — never shown to a person. */
  key: string;
  position: SentForPosition;
  /** "Nasr City · Medical Representative · Pedia", already deduplicated. */
  label: string;
  candidates: Candidate[];
  /** Most recent send in this folder, so a folder can be ordered by what arrived last. */
  lastSentAt: string | null;
};

/**
 * One position's parts, cleaned: trimmed, inner runs of whitespace collapsed, empties dropped.
 *
 * The collapse is not cosmetic. A free-typed "Medical  Representative" with a double space is a
 * different string from "Medical Representative" and would open a second folder reading exactly
 * like the first — the failure the owner accepted a small risk of when he chose free typing, and
 * the cheapest place to prevent most of it is here, before anything is stored or compared.
 */
export function cleanPositionText(value: string | null | undefined): string | null {
  const cleaned = String(value ?? "").trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

/** The parts of a position, in the order a person reads them, with the empties gone. */
function orderedParts(position: SentForPosition): string[] {
  const parts = [
    cleanPositionText(position.areaName),
    cleanPositionText(position.jobTitle),
    cleanPositionText(position.lineName),
  ];
  const kept: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    // A Head Office seat reads "Head office · Regulatory Affairs · Head Office" — the line repeats
    // the area, and a repeated word in a heading reads as a rendering fault rather than as data.
    if (kept.some((already) => already.toLowerCase() === part.toLowerCase())) continue;
    kept.push(part);
  }
  return kept;
}

/**
 * "Nasr City · Medical Representative · Pedia" — the folder, as a person reads it.
 *
 * AREA FIRST, matching how the owner named it out loud ("Nasr City Medical Reps"): the area is what
 * distinguishes one of these from another, because 34 of the 35 open seats carry the same job
 * title. A missing part is omitted rather than filled in — the standing rule is that no invented
 * value reaches a screen, and "Nasr City · Unknown" reads as a fault to chase when the truth is
 * simply that nobody recorded a line.
 */
export function positionFolderLabel(position: SentForPosition): string {
  return orderedParts(position).join(" · ");
}

/**
 * The joiner between key parts.
 *
 * A control character (unit separator), written as an ESCAPE rather than typed literally: a raw
 * U+001F in source is invisible in every editor, diff and code review, and an editor or a
 * copy-paste that ate it would silently turn "Cairo" + "Medical Rep" and "Cairo Medical" + "Rep"
 * into one key with nothing to see in the change. The escape is the same byte and reads.
 */
const KEY_JOINER = "\u001f";

/**
 * Identity of a position for folding.
 *
 * Case-folded, because a typed "medical representative" and a picked "Medical Representative" are
 * the same job and must not become two folders. Joined on a control character rather than a space
 * or a dot so that an area genuinely containing the joiner cannot forge another position's key —
 * no area name in the organogram contains one, which is exactly why it is safe to join on.
 *
 * Returns "" when every part is empty, and callers read that as "no position given".
 */
export function positionFolderKey(position: SentForPosition): string {
  const parts = [
    cleanPositionText(position.areaName),
    cleanPositionText(position.jobTitle),
    cleanPositionText(position.lineName),
  ];
  if (parts.every((part) => part === null)) return "";
  return parts.map((part) => (part ?? "").toLowerCase()).join(KEY_JOINER);
}

const EMPTY_POSITION: SentForPosition = {
  areaName: null,
  jobTitle: null,
  lineName: null,
  regionName: null,
  vacancyId: null,
};

/** True when a candidate carries no position at all — sent before one could be chosen, or sent bare. */
export function hasSentForPosition(candidate: Candidate): boolean {
  return positionFolderKey(candidate.sentFor ?? EMPTY_POSITION) !== "";
}


/**
 * Which of two sends should give a folder its heading.
 *
 * A PICKED VACANCY ALWAYS BEATS A TYPED ONE, whatever the dates say. The two land in the same
 * folder because the key is case-folded and whitespace-collapsed — that is the whole point — but
 * the heading is the one thing a person reads, and "nasr city · medical representative · PEDIA"
 * typed at 11am should not overwrite the organogram's own "Nasr City · Medical Representative ·
 * Pedia" merely for being newer. The picked spelling is the company's; the typed one is somebody's
 * keyboard at 4am.
 *
 * Between two of the same kind, the newer wins — an older stamp can carry less than a newer one,
 * and preferring it would hide a line we do know.
 */
function outranksForLabel(
  position: SentForPosition,
  sentAt: string,
  currentPosition: SentForPosition,
  currentSentAt: string,
): boolean {
  const fromVacancy = position.vacancyId !== null;
  const currentFromVacancy = currentPosition.vacancyId !== null;
  if (fromVacancy !== currentFromVacancy) return fromVacancy;
  return sentAt > currentSentAt;
}

/**
 * Fold candidates into one folder per position.
 *
 * Candidates carrying no position come back SEPARATELY rather than in a folder of their own. They
 * are real and must never be hidden — the 24 sends already on record when this shipped all predate
 * the picker, and quietly dropping them would remove people a manager has actually been asked to
 * review. But they are also not a position, and inventing a folder called "No position" inside the
 * folder list would make a placeholder sort and read like a real vacancy. The caller renders them
 * under their own heading and decides how loud to be about it.
 *
 * Folders are ordered by area, then job title, then line — the order the picker offers them in, so
 * the list a recruiter reads back is in the order they chose from. Within a folder, newest send
 * first: the reason to open a pile is almost always what just landed in it.
 */
export function groupCandidatesByPosition(
  candidates: readonly Candidate[],
): { folders: PositionFolder[]; unfiled: Candidate[] } {
  const folders = new Map<string, PositionFolder>();
  /** When each folder's CURRENT heading was sent, which is not the same as its newest send. */
  const labelledAt = new Map<string, string>();
  const unfiled: Candidate[] = [];

  for (const candidate of candidates) {
    const position = candidate.sentFor ?? null;
    const key = position ? positionFolderKey(position) : "";
    if (!position || !key) {
      unfiled.push(candidate);
      continue;
    }

    const sentAt = candidate.managerNotified?.sentAt ?? "";
    const existing = folders.get(key);
    if (existing) {
      existing.candidates.push(candidate);
      if (!existing.lastSentAt || sentAt > existing.lastSentAt) existing.lastSentAt = sentAt;
      if (outranksForLabel(position, sentAt, existing.position, labelledAt.get(key) ?? "")) {
        existing.position = position;
        existing.label = positionFolderLabel(position);
        labelledAt.set(key, sentAt);
      }
      continue;
    }

    labelledAt.set(key, sentAt);
    folders.set(key, {
      candidates: [candidate],
      key,
      label: positionFolderLabel(position),
      lastSentAt: sentAt || null,
      position,
    });
  }

  for (const folder of folders.values()) {
    folder.candidates.sort((left, right) =>
      (right.managerNotified?.sentAt ?? "").localeCompare(left.managerNotified?.sentAt ?? ""),
    );
  }
  unfiled.sort((left, right) =>
    (right.managerNotified?.sentAt ?? "").localeCompare(left.managerNotified?.sentAt ?? ""),
  );

  const ordered = [...folders.values()].sort(
    (left, right) =>
      // A folder with no area goes LAST. An empty string sorts before every real name, so the plain
      // comparison would head the manager's page with the one folder that cannot be told apart by
      // the thing the list is ordered by — the same trap the vacancy picker's sort has.
      Number(!left.position.areaName) - Number(!right.position.areaName) ||
      (left.position.areaName ?? "").localeCompare(right.position.areaName ?? "") ||
      (left.position.jobTitle ?? "").localeCompare(right.position.jobTitle ?? "") ||
      (left.position.lineName ?? "").localeCompare(right.position.lineName ?? ""),
  );

  return { folders: ordered, unfiled };
}
