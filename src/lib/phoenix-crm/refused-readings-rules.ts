/**
 * Phoenix CRM — what the refused-readings board says, and how it groups a rep's refusals.
 *
 * Pure: no database, no clock, no environment. The reader (`server/refused-readings-board.ts`) fetches
 * the rows and hands them here, so every sentence and every count the board prints is tested without
 * a database.
 *
 * WHAT A REFUSED READING IS. A capture the server turned away on its LOCATION — the phone sent no
 * position, or a position too rough for the line (`entry-rules.ts` `refusedReadingOf`). It is written
 * to `phoenix_crm_refused_readings` since 2026-10-03 (owner: "record the refused readings so the next
 * refusal is traceable"), and until this board it was readable only with SQL, so a rep could be turned
 * away eighteen times and nobody who could help would see it.
 *
 * WHAT IT IS NOT. It is not a flag, and nobody is accused of anything. A refusal is the SYSTEM saying
 * no to a phone, and the question the board answers is "who is stuck and can I help", not "who is
 * lying". The wording stays on that side throughout — the same stance as the duplicate-customers list,
 * and the opposite of the integrity board, which is why the two are separate pages.
 *
 * 🔴 A RETRY RESENDS THE SAME PHOTO (measured 2026-10-03: nine refusals in 67 seconds from one rep,
 * the photo's reading 220 m on every one and its coordinates identical to 13 decimals). So the number
 * of attempts alone says "keeps trying", never "keeps failing on a fresh reading" — which is why each
 * attempt prints both readings and why the summary leads with whether he got through afterwards.
 */

export type RefusedReason = "no_fix" | "rough";
export type RefusedSubject = "visit" | "place";

/** One refused capture, as the reader hands it over. Numbers are already numbers; nothing is a code. */
export type RefusedAttempt = {
  id: string;
  subjectKind: RefusedSubject;
  reason: RefusedReason;
  repHrId: string;
  customerId: string | null;
  /** ISO instant the server refused it. */
  refusedAt: string;
  /** The pin's / the phone's reading: the radius it claimed, in metres. Null when it sent none. */
  accuracyMeters: number | null;
  /** The shutter's own reading, kept apart because a place is refused when EITHER number is wide. */
  photoAccuracyMeters: number | null;
  /** The line it had to be inside, stored with the row so an old refusal reads against ITS rule. */
  maxAccuracyMeters: number | null;
};

/** A capture of the same kind that LATER saved, which is how a refusal reads as resolved. */
export type LaterSave = {
  subjectKind: RefusedSubject;
  repHrId: string;
  customerId: string;
  /** ISO instant the save landed. */
  savedAt: string;
};

export type AttemptOutcome = "got_through" | "not_yet" | "unknown";

export const OUTCOME_LABELS: Record<AttemptOutcome, string> = {
  got_through: "Got through afterwards",
  not_yet: "Not through yet",
  unknown: "Not tied to a customer",
};

const SUBJECT_LABELS: Record<RefusedSubject, string> = {
  place: "Validating a place",
  visit: "Saving a visit",
};

export function refusedSubjectLabel(kind: RefusedSubject): string {
  return SUBJECT_LABELS[kind] ?? kind;
}

function metres(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "not reported" : `${Math.round(value)} m`;
}

/**
 * The refusal in plain English, for the SFE.
 *
 * Both readings are named for a place, because that is the question asked first ("was it the pin or
 * the photo?") and because the two can differ by an order of magnitude. A reading the phone did not
 * send reads "not reported" and is never printed as 0 m, which is a rep standing exactly on the pin.
 */
export function refusalSentence(attempt: Pick<RefusedAttempt, "subjectKind" | "reason" | "accuracyMeters" | "photoAccuracyMeters" | "maxAccuracyMeters">): string {
  if (attempt.reason === "no_fix") {
    return "The phone sent no usable position at all — location permission off, or no fix yet.";
  }
  const line = attempt.maxAccuracyMeters !== null && Number.isFinite(attempt.maxAccuracyMeters) ? Math.round(attempt.maxAccuracyMeters) : null;
  const needs = line === null ? "" : attempt.subjectKind === "place" ? ` A place needs both within ${line} m.` : ` A visit needs the position within ${line} m.`;
  if (attempt.subjectKind === "place") {
    return `The position was too rough: the pin read within ${metres(attempt.accuracyMeters)} and the photo within ${metres(attempt.photoAccuracyMeters)}.${needs}`;
  }
  return `The position was too rough: it read within ${metres(attempt.accuracyMeters)}.${needs}`;
}

/** The widest radius any reading of this attempt claimed, or null when none was reported. */
export function widestReading(attempt: Pick<RefusedAttempt, "accuracyMeters" | "photoAccuracyMeters">): number | null {
  const readings = [attempt.accuracyMeters, attempt.photoAccuracyMeters].filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  return readings.length === 0 ? null : Math.max(...readings);
}

/**
 * Did this refusal end with the same rep saving the same kind of thing for the same customer?
 *
 * "Afterwards" is strict: a save BEFORE the refusal proves nothing about it. A refusal that is not
 * tied to a customer (a new customer, one met outside the list) cannot be matched, and says so rather
 * than guess either way.
 */
export function attemptOutcome(attempt: RefusedAttempt, saves: readonly LaterSave[]): AttemptOutcome {
  if (attempt.customerId === null) return "unknown";
  const refusedAt = Date.parse(attempt.refusedAt);
  const through = saves.some(
    (save) =>
      save.subjectKind === attempt.subjectKind &&
      save.customerId === attempt.customerId &&
      save.repHrId.toUpperCase() === attempt.repHrId.toUpperCase() &&
      Date.parse(save.savedAt) >= refusedAt,
  );
  return through ? "got_through" : "not_yet";
}

export type RepRefusals = {
  repHrId: string;
  attempts: number;
  places: number;
  visits: number;
  /** Distinct customers this rep was refused on and then saved, out of those he was refused on. */
  targets: number;
  gotThrough: number;
  /** Refusals tied to no customer — counted apart, never as stuck and never as through. */
  untied: number;
  widestMeters: number | null;
  lastRefusedAt: string;
  /** Plain "no position at all" refusals, apart from the rough ones. */
  noFix: number;
};

/**
 * One line per rep, the rep with the most still-blocked customers first.
 *
 * A rep who was refused and got through is still listed — a phone that is refused ten times a day and
 * always gets through on the eleventh is a phone worth knowing about — but he sorts below the one who
 * has not got through, because that one cannot do his work and the other can.
 */
export function summariseByRep(attempts: readonly RefusedAttempt[], saves: readonly LaterSave[]): RepRefusals[] {
  const perRep = new Map<string, RepRefusals & { stuckKeys: Set<string>; doneKeys: Set<string> }>();
  for (const attempt of attempts) {
    const key = attempt.repHrId.toUpperCase();
    const entry =
      perRep.get(key) ??
      {
        repHrId: attempt.repHrId,
        attempts: 0,
        places: 0,
        visits: 0,
        targets: 0,
        gotThrough: 0,
        untied: 0,
        widestMeters: null,
        lastRefusedAt: attempt.refusedAt,
        noFix: 0,
        stuckKeys: new Set<string>(),
        doneKeys: new Set<string>(),
      };
    entry.attempts += 1;
    if (attempt.subjectKind === "place") entry.places += 1;
    else entry.visits += 1;
    if (attempt.reason === "no_fix") entry.noFix += 1;
    const widest = widestReading(attempt);
    if (widest !== null && (entry.widestMeters === null || widest > entry.widestMeters)) entry.widestMeters = widest;
    if (Date.parse(attempt.refusedAt) > Date.parse(entry.lastRefusedAt)) entry.lastRefusedAt = attempt.refusedAt;
    const outcome = attemptOutcome(attempt, saves);
    if (outcome === "unknown") entry.untied += 1;
    else {
      const target = `${attempt.subjectKind}:${attempt.customerId}`;
      (outcome === "got_through" ? entry.doneKeys : entry.stuckKeys).add(target);
    }
    perRep.set(key, entry);
  }
  return [...perRep.values()]
    .map(({ stuckKeys, doneKeys, ...entry }) => {
      // A target refused twice, once before and once after a save, is through: only the ones with no
      // later save at all are still stuck.
      const stuck = [...stuckKeys].filter((target) => !doneKeys.has(target)).length;
      return { ...entry, targets: stuck + doneKeys.size, gotThrough: doneKeys.size };
    })
    .sort((left, right) => {
      const leftStuck = left.targets - left.gotThrough;
      const rightStuck = right.targets - right.gotThrough;
      return rightStuck - leftStuck || right.attempts - left.attempts || Date.parse(right.lastRefusedAt) - Date.parse(left.lastRefusedAt);
    });
}

/** How many customers a rep is still blocked on, by the same arithmetic as the sort. */
export function stillBlocked(entry: Pick<RepRefusals, "targets" | "gotThrough">): number {
  return entry.targets - entry.gotThrough;
}
