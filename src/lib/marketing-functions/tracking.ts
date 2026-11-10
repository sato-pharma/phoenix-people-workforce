// Field Visit Feedback — the tracking her email asks for, computed from the signed forms. Pure.
//
// "The main objective is to make this a continuous tracking and development tool, rather than just a
// feedback sheet." So each rep gets: the latest rating on every call remark and whether it moved since
// the visit before; the key strengths (Excellent or Good on each of the last two visits that rated
// the remark); and the recurring gaps (Average or Poor on at least two of the last three), which are
// the ones that "may require a specific development plan or training intervention". Across the team,
// the gaps are grouped under her three addressees: Marketing, the Sales Manager, and selling skills
// with Dr. Salma.

import {
  CALL_REMARKS,
  callRatingRank,
  isGapRating,
  isStrengthRating,
  type CallRating,
  type CallRemarkKey,
  type FieldActionOwner,
} from "./vocabulary";

export type TrackedForm = {
  id: string;
  repHrId: string;
  repName: string;
  repArea: string | null;
  visitDate: string;
  signedAt: string | null;
  ratings: Partial<Record<CallRemarkKey, CallRating>>;
};

export type RemarkTrend = "up" | "down" | "same" | "new";

export type RemarkTrack = {
  key: CallRemarkKey;
  latest: CallRating | null;
  previous: CallRating | null;
  trend: RemarkTrend | null;
  strength: boolean;
  recurringGap: boolean;
};

export type RepTrack = {
  repHrId: string;
  repName: string;
  repArea: string | null;
  visits: number;
  lastVisitDate: string;
  remarks: RemarkTrack[];
  strengths: CallRemarkKey[];
  recurringGaps: CallRemarkKey[];
  /** Gaps on the latest visit that are not (yet) recurring. */
  latestGaps: CallRemarkKey[];
};

export type TeamGap = {
  key: CallRemarkKey;
  owner: FieldActionOwner;
  /** Reps whose latest rating on this remark is Average or Poor. */
  reps: number;
  /** Of those, how many have it as a recurring gap. */
  recurring: number;
};

/** Newest first: by visit date, then by when it was signed, then by id so the order is stable. */
function newestFirst(left: TrackedForm, right: TrackedForm): number {
  if (left.visitDate !== right.visitDate) return left.visitDate < right.visitDate ? 1 : -1;
  const leftSigned = left.signedAt ?? "";
  const rightSigned = right.signedAt ?? "";
  if (leftSigned !== rightSigned) return leftSigned < rightSigned ? 1 : -1;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

function trendOf(latest: CallRating | null, previous: CallRating | null): RemarkTrend | null {
  if (!latest) return null;
  if (!previous) return "new";
  const delta = callRatingRank(latest) - callRatingRank(previous);
  return delta > 0 ? "up" : delta < 0 ? "down" : "same";
}

/** One rep's history, newest first, already filtered to this rep and to signed forms. */
export function trackRemark(history: readonly TrackedForm[], key: CallRemarkKey): RemarkTrack {
  const rated = history.map((form) => form.ratings[key]).filter((rating): rating is CallRating => Boolean(rating));
  const latest = rated[0] ?? null;
  const previous = rated[1] ?? null;
  const strength = rated.length >= 2 && isStrengthRating(rated[0]) && isStrengthRating(rated[1]);
  const recurringGap = rated.slice(0, 3).filter((rating) => isGapRating(rating)).length >= 2;
  return { key, latest, previous, trend: trendOf(latest, previous), strength, recurringGap };
}

/** Only signed forms count: an unsigned draft is not yet feedback. */
export function buildRepTracks(forms: readonly TrackedForm[]): RepTrack[] {
  const byRep = new Map<string, TrackedForm[]>();
  for (const form of forms) {
    if (!form.signedAt) continue;
    const key = form.repHrId.trim().toUpperCase();
    if (!key) continue;
    const list = byRep.get(key) ?? [];
    list.push(form);
    byRep.set(key, list);
  }

  const tracks: RepTrack[] = [];
  for (const history of byRep.values()) {
    history.sort(newestFirst);
    const latestForm = history[0];
    const remarks = CALL_REMARKS.map((remark) => trackRemark(history, remark.key));
    tracks.push({
      repHrId: latestForm.repHrId,
      repName: latestForm.repName,
      repArea: latestForm.repArea,
      visits: history.length,
      lastVisitDate: latestForm.visitDate,
      remarks,
      strengths: remarks.filter((remark) => remark.strength).map((remark) => remark.key),
      recurringGaps: remarks.filter((remark) => remark.recurringGap).map((remark) => remark.key),
      latestGaps: remarks
        .filter((remark) => !remark.recurringGap && isGapRating(latestForm.ratings[remark.key] ?? null))
        .map((remark) => remark.key),
    });
  }

  // Most recurring gaps first, so the rep who needs a development plan is at the top; then by name.
  return tracks.sort(
    (left, right) =>
      right.recurringGaps.length - left.recurringGaps.length ||
      left.repName.localeCompare(right.repName),
  );
}

/** Team view: how many reps are currently below Good on each remark, most common first. */
export function buildTeamGaps(tracks: readonly RepTrack[]): TeamGap[] {
  return CALL_REMARKS.map((remark) => {
    let reps = 0;
    let recurring = 0;
    for (const track of tracks) {
      const entry = track.remarks.find((candidate) => candidate.key === remark.key);
      if (entry && isGapRating(entry.latest)) reps += 1;
      if (entry?.recurringGap) recurring += 1;
    }
    return { key: remark.key, owner: remark.owner, reps, recurring };
  })
    .filter((gap) => gap.reps > 0 || gap.recurring > 0)
    .sort((left, right) => right.reps - left.reps || right.recurring - left.recurring);
}
