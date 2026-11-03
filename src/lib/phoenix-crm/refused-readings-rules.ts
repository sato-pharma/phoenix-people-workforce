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

/**
 * 🔴 `off_listing` IS NOT ABOUT THE POSITION'S QUALITY, AND THE BOARD MUST NOT READ IT AS ONE. The two
 * original reasons are the phone's own fault — no fix, or a fix too rough for the line — and both
 * readings are precise on an `off_listing` row. What refused it is the ACCOUNT: Google's pin for the
 * customer sits 150 m - 1 km from where the rep stood (google-place-rules.ts). It is the one refusal a
 * rep may be unable to pass by moving at all, which is why the second one is HELD for the Super Admin
 * rather than refused again, and why the metres that matter are the distance to the listing, never the
 * accuracy radius.
 */
/**
 * 🔴 `blocked` IS THE ONLY REASON THE SERVER DID NOT DECIDE, AND IT IS THE REASON NOTHING USED TO
 * REACH THIS BOARD AT ALL. The other three are refusals: the phone sent a reading and a door turned
 * it away. A permission the BROWSER blocks never produces a reading, never reaches a door and never
 * reached a row — the rep read the message, the capture ended on her screen, and the only trace
 * anywhere was the touch trail, and only if she pressed the message.
 *
 * What that cost, on 2026-10-13: Norhan Gamal could not validate on her iPhone on 10 and 12 October.
 * Her phone answered PERMISSION_DENIED within ~5 s of each press, this table held ZERO rows for her
 * seat, and finding her took a forensic dig through a trail that across 4-12 October carried 42
 * location and 30 camera refusal messages from four reps — every one of them invisible here.
 *
 * So a blocked permission is REPORTED by the browser rather than refused by the server, and the row
 * names WHICH permission (`blockedPermission`). It carries no reading at all, which is correct and is
 * not a gap: there was nothing to read. Nothing a rep sees changes (golden rule #1) — the message is
 * byte-for-byte the one she read before, and this row exists only so somebody can help her.
 */
/**
 * 🔴 `timetable_unreadable` AND `timetable_missing` ARE THE ONLY TWO A REP IS TOLD ABOUT (owner,
 * 2026-10-17: the polyclinic timetable is read on the spot "like a scanner", "3 tries then held to
 * confirmation by admin"). The reader answered, and what it saw was not a readable timetable — a
 * street, a floor, a board too far away to read. They carry the BUILDING (`shared_place_id`), because
 * the tries are counted per rep, per building, per Cairo day, and the photograph's pointer. Never a
 * position: both say nothing about where the rep stood.
 */
/**
 * `signboard_unreadable` and `signboard_no_plate` (2026-10-18) are the signboard's twins of the two
 * timetable reasons: the door read the signboard photo, found no name it could read, and told the rep what
 * to fix. They carry `signboard_key` (the place, the customer, or a new customer's folded name) instead of
 * a building, because the tries are counted per rep, per customer, per Cairo day.
 */
/**
 * 🔴 `far_from_place` (owner, 2026-10-20: "not accept medical reps visits logged away from the
 * validated picture of the customer with maximum 300 m apart") is a VISIT turned away for where it was
 * logged, not for how well the phone read it: the reading was good enough to measure, and it sat past
 * the line from the customer's validated photograph. It carries the metres (`distance_meters`) and the
 * place they were measured to (`place_id`), and `max_accuracy_meters` holds the far LINE the save was
 * refused against, so an old row reads against its own rule. Never printed as "too rough". Since
 * 3 Nov 2026 a row of `subject_kind` "place" is a SEATING refused the same way: its metres are to the
 * building, which it names in `shared_place_id`, and its `place_id` stays null.
 */
export type RefusedReason =
  | "no_fix"
  | "rough"
  | "off_listing"
  | "blocked"
  | "timetable_unreadable"
  | "timetable_missing"
  | "signboard_unreadable"
  | "signboard_no_plate"
  | "far_from_place";
export type RefusedSubject = "visit" | "place";
/** Which permission the browser blocked. Only these two are capable of ending a capture. */
export type BlockedPermission = "location" | "camera";

/** Every reason the table's own CHECK allows, in the order it was taught them. */
export const REFUSED_REASONS: readonly RefusedReason[] = [
  "no_fix",
  "rough",
  "off_listing",
  "blocked",
  "timetable_unreadable",
  "timetable_missing",
  "signboard_unreadable",
  "signboard_no_plate",
  "far_from_place",
];

/**
 * The stored reason, read EXHAUSTIVELY.
 *
 * 🔴 THE READER USED TO ASK ONE QUESTION AND ASSUME THE REST: `row.reason === "no_fix" ? "no_fix" :
 * "rough"`. That is correct for exactly two of the four, so from 5 October every `off_listing` row
 * on the board printed the "the position was too rough" sentence — the one thing that refusal is
 * NOT, with both its readings precise and the account's own pin at fault. Two of 13 October's
 * refusals were being told that about reps who were standing within 5 m.
 *
 * An unrecognised value falls back to `rough` because the type admits nothing else, and that branch
 * is unreachable by construction: `tests/phoenix-crm-refused-readings-board.test.ts` reads the
 * CHECK constraint out of the migrations and asserts this function recognises every value it
 * allows, so teaching the table a fifth reason without teaching this function fails the suite.
 */
export function parseRefusedReason(value: unknown): RefusedReason {
  return typeof value === "string" && (REFUSED_REASONS as readonly string[]).includes(value)
    ? (value as RefusedReason)
    : "rough";
}

export const BLOCKED_PERMISSIONS: readonly BlockedPermission[] = ["location", "camera"];

/** A permission name from a browser, or null for anything else — the row's own CHECK allows two. */
export function parseBlockedPermission(value: unknown): BlockedPermission | null {
  return typeof value === "string" && (BLOCKED_PERMISSIONS as readonly string[]).includes(value)
    ? (value as BlockedPermission)
    : null;
}

/** What the browser posts when a permission it needed was blocked. */
export type BlockedPermissionReport = {
  subjectKind: RefusedSubject;
  permission: BlockedPermission;
  /** The territory's seat, when the screen names one in its path. Null is correct, never missing. */
  seatId: string | null;
  test: boolean;
};

/**
 * Read one report off the wire.
 *
 * Bounded and total: a body that is not this shape answers null and the route files nothing. The
 * SEAT is the only free text it accepts, at 120 characters — the rep is the SESSION's, never the
 * body's.
 */
export function parseBlockedPermissionReport(raw: unknown): BlockedPermissionReport | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const permission = parseBlockedPermission(body.permission);
  if (permission === null) return null;
  const subjectKind: RefusedSubject | null =
    body.subjectKind === "place" ? "place" : body.subjectKind === "visit" ? "visit" : null;
  if (subjectKind === null) return null;
  const seat = typeof body.seatId === "string" ? body.seatId.trim() : "";
  return {
    subjectKind,
    permission,
    seatId: seat.length === 0 ? null : seat.slice(0, 120),
    test: body.test === true,
  };
}

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
  /** Which permission the browser blocked, for `blocked` only. Null for every server refusal. */
  blockedPermission: BlockedPermission | null;
  /**
   * For `far_from_place` only: the metres from the visit's reading to the customer's validated
   * photograph. Absent or null for every other reason, and never printed as 0 m when unknown.
   */
  distanceMeters?: number | null;
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
export function refusalSentence(
  attempt: Pick<RefusedAttempt, "subjectKind" | "reason" | "accuracyMeters" | "photoAccuracyMeters" | "maxAccuracyMeters" | "blockedPermission" | "distanceMeters">,
): string {
  if (attempt.reason === "far_from_place") {
    // Never the accuracy radius: the reading was good enough to measure. What refused it was WHERE it
    // was, so the SFE reads the metres and the line, and can tell a rep in the car outside from one
    // across town (owner, 2026-10-20).
    const line = attempt.maxAccuracyMeters !== null && Number.isFinite(attempt.maxAccuracyMeters) ? Math.round(attempt.maxAccuracyMeters) : null;
    const distance = attempt.distanceMeters;
    const away =
      distance === null || distance === undefined || !Number.isFinite(distance)
        ? "away"
        : distance < 1000
          ? `${Math.round(distance)} m away`
          : `${(distance / 1000).toFixed(1)} km away`;
    // A seating refused the same way (owner, 3 Nov 2026): the metres are to the BUILDING he chose.
    if (attempt.subjectKind === "place") {
      const seatingRule = line === null ? "" : ` A rep adds a customer to a building only within ${line} m of it.`;
      return `The rep stood ${away} from the building this customer was being added to, so it was not saved.${seatingRule}`;
    }
    const rule = line === null ? "" : ` A medical rep's visit is taken only within ${line} m of it.`;
    return `The visit was logged ${away} from this customer's validated photo, so it was not saved.${rule}`;
  }
  if (attempt.reason === "blocked") {
    // Never a radius here: the capture never produced one. What the SFE needs is the one sentence
    // that tells him this is a phone SETTING and not a place, a line or a reading — and which of the
    // two settings it is, because the rep is looking for that exact switch in her own browser.
    return attempt.blockedPermission === "camera"
      ? "The browser on this phone blocked the camera, so the capture never reached Phoenix and there is no reading to read. The camera has to be allowed for this site in that browser's own settings."
      : "The browser on this phone blocked the location, so the capture never reached Phoenix and there is no reading to read. Location has to be allowed for this site in that browser's own settings.";
  }
  if (attempt.reason === "no_fix") {
    return "The phone sent no usable position at all — location permission off, or no fix yet.";
  }
  if (attempt.reason === "timetable_missing") {
    return "The photo seating a customer in a polyclinic did not show the building's timetable, so the rep was asked to photograph it again. The third failed photo of the same building in one day is saved and held for the Super Admin.";
  }
  if (attempt.reason === "timetable_unreadable") {
    return "The photo of the polyclinic's timetable could not be read — too far, blurred, glare or cut off — so the rep was asked to take it again. The third failed photo of the same building in one day is saved and held for the Super Admin.";
  }
  if (attempt.reason === "signboard_no_plate") {
    return "The signboard photo did not show the customer's nameplate, so the rep was asked to photograph it again. The third failed photo of the same customer in one day is saved and held for the Super Admin.";
  }
  if (attempt.reason === "signboard_unreadable") {
    return "The customer's name could not be read in the signboard photo — too far, blurred, dark or cut off — so the rep was asked to take it again. The third failed photo of the same customer in one day is saved and held for the Super Admin.";
  }
  if (attempt.reason === "off_listing") {
    // Never the accuracy radius here: both readings were precise, and printing them would read as a
    // phone problem when the account is what did not match.
    // "the place", never "the account": Phoenix CRM says AM and PM and nothing else on a screen
    // (owner, 2026-09-23), and tests/phoenix-crm-am-pm-words.test.ts enforces it on this very line.
    return "The position was precise, but it was not at this customer's own Google Maps pin — the place may have moved, or the pin is old. A second refusal on the same customer is held for the Super Admin to decide.";
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
