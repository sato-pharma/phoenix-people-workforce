/**
 * Phoenix CRM — the integrity board, for the Super Admin and the SFE Manager.
 *
 * FIVE DETECTORS FILE HERE, and from 2026-09-27 the row says which. The position checks judge where
 * the phone said it was; the photo sweep judges whether the picture is a new picture; the signboard
 * pass judges whether the sign on the building names the customer it was validated for; the
 * capture-trust check judges a place's two readings against each other; and the behaviour pass judges
 * a rep's whole month, in its own table. They share this table and nothing else — a capture can carry
 * one verdict from each, which is why `source` is part of the unique key rather than a label bolted
 * on afterwards.
 *
 * 🔴 AND THE READER MUST KNOW ALL FIVE BY NAME. `signboard` began filing on 2026-10-08 and was not
 * added to `IntegritySource`, so for a day its cases printed as **Position** on the owner's board and
 * the detector tally hid them — five real cases about five named people, labelled as the one kind of
 * evidence they are not. `capture_trust` shipped in the SAME migration with the same omission and
 * escaped only by having filed nothing yet: it files on a place validation rather than nightly, so
 * the defect was waiting on the next rep whose two readings disagree. Both are in `INTEGRITY_SOURCES`
 * now, and the type, the labels, the row's own coercion and the tally are all derived from that one
 * list — so a sixth detector cannot be half-added again.
 *
 * SETTLING ONE IS THE SUPER ADMIN'S, AND IT DELETES NOTHING. He writes why, and the row keeps the
 * flags it was settled on (`settled_flags`). A case is settled only while those still equal the row's
 * current flags, so a fresh finding on the same subject reopens it — see `settlementOf`.
 *
 * This is the only reader of the EVIDENCE on `phoenix_crm_location_integrity` — the coordinates, the
 * signals, the flags in words. It lives behind `/admin`, which no rep can open at all, so the evidence
 * cannot leak into the field app through a role mistake in a tab or a component: the rep-facing bundle
 * does not import this file and has no route that reaches it.
 *
 * 🔴 IT IS NOT THE ONLY READER OF THE TABLE, which this comment claimed until 2026-10-12 and which a
 * session believed. Two others read it, both for a yes/no about a rep and neither for the evidence:
 * `server/behaviour.ts` (`readStrongCaseReps` — which reps carry a strong case this month, so a
 * save-time pattern is held back) and `rep-ranks/server/compute.ts` (the Integrity score). Both ask
 * for `rep_hr_id` and `flags` and nothing a rep could be shown. A fourth read — anything that selects
 * `lat`, `lon`, `signals` or the labels — belongs HERE, behind this file's audience check.
 *
 * WHO READS IT (owner, 2026-09-26, Golden Rule #1): "every violation is then recorded in the admin
 * and the SFE account". The SFE Manager joined the Super Admin that day. It is still the narrowest
 * audience in the module, and narrow is the point rather than tidiness — the rep is never told he was
 * flagged, so the fewer people who can open this, the longer it keeps working.
 *
 * 🔴 AND THE MOCK-LOCATION EVIDENCE IS THE SUPER ADMIN'S ALONE ON THIS BOARD (owner, 2026-10-02). The
 * position cases (`source = 'gps'`) and the phone's own mock-location answer (`device_mocked`) are never
 * read for the SFE Manager — not filtered out of a screen, never QUERIED. The SFE keeps the photo cases
 * and the behaviour months, which judge a picture and a month's shape rather than where a phone said it
 * was.
 *
 * 🔴 ONE SURFACE OUTSIDE THIS BOARD NOW READS THE SAME EVIDENCE, BY HIS OWN WORD (owner, 2026-10-13:
 * "system and device evidence the dm can see"): a district manager's own Place checks board, through
 * `loadPlaceCheckIntegrity` at the end of this file, for the places of HIS team only. That function is
 * in this file precisely because of the line below — the evidence does not leave it. Nothing about the
 * board above changed, and the REP is still told nothing at all.
 *
 * WHAT A FLAG IS AND IS NOT. It is a reason for a human to look — at the photo, at the day, at the
 * rep. It is not a verdict, it triggers nothing, and nobody is told they were flagged. Acting on one
 * is the owner's decision, made after he has looked, exactly as a flagged expense is.
 *
 * WHY THE REFUSAL IS A 404 AND NOT A 403. A message reading "the location integrity board is the
 * Super Admin's" tells the person asking that a board exists and what it watches — which is the one
 * thing Golden Rule #1 says he must never learn. To everybody outside the audience this is simply not
 * a thing that is here.
 */

import {
  CASE_READING_LABELS,
  INTEGRITY_SUBJECT_KINDS,
  integritySubjectKindLabel,
  type CaseVisitPoint,
  type IntegritySubjectKind,
} from "@/lib/crm-integrity/integrity-case-story";
import { notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { PHOENIX_CRM_BEHAVIOUR_LABELS, type PhoenixCrmBehaviourFlag } from "@/lib/phoenix-crm/behaviour-integrity";
import { PHOENIX_CRM_PHOTO_LABELS, type PhoenixCrmPhotoFlag } from "@/lib/phoenix-crm/duplicate-photos";
import { cleanText } from "@/lib/phoenix-crm/entry-rules";
import type { FraudScanCase } from "@/lib/phoenix-crm/fraud-scan-rules";
import {
  INTEGRITY_BULK_SETTLE_CAP,
  INTEGRITY_NOTE_LIMIT,
  INTEGRITY_NOTE_REQUIRED,
  isSettledIntegrityRow,
  readIntegritySettlement,
  type IntegritySettlement,
} from "@/lib/phoenix-crm/integrity-settlement";
import {
  placeNoteSubjectKey,
  type PlaceCheckIntegrityIndex,
  type PlaceCheckIntegrityView,
} from "@/lib/phoenix-crm/place-note-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import {
  judgeLaterSignboardReading,
  PHOENIX_CRM_INTEGRITY_LABELS,
  readStoredSignboardVerdict,
  type IntegrityLaterReading,
  type PhoenixCrmIntegrityFlag,
  type StoredSignboardVerdict,
} from "@/lib/phoenix-crm/location-integrity";
import { canDecideValidationReviews, placeChecksSeatScope, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * How many requests of one chunked read are in flight at once.
 *
 * Four, as everywhere else in Phoenix CRM that fans a database loop out: enough that a board of a few
 * hundred cases stops waiting on one round trip after another, and few enough that one Super Admin
 * opening the board cannot take a large share of the database's connections from the field app.
 * The board's reads run side by side as well (`loadIntegrityBoard`), so this is per read, not overall.
 */
const CHUNK_READS_AT_ONCE = 4;

/**
 * How many one-row settlement updates of a bulk settle are in flight at once.
 *
 * Higher than a read's four because each is a single-row update by primary key — the cheapest write
 * there is — and the batch is capped (`INTEGRITY_BULK_SETTLE_CAP`), so this bounds one button press
 * at a handful of short statements at a time rather than two hundred in a row.
 */
const SETTLE_UPDATES_AT_ONCE = 8;

/**
 * Which detector filed a case. The board is the one place they are read together.
 *
 * 🔴 EVERY DETECTOR THAT WRITES TO THE TABLE BELONGS IN THIS LIST, and `signboard` proves why. It
 * started filing cases on 2026-10-08 and was never added, so the five it had filed by the 9th fell
 * through `row.source === "photo" || "behaviour" ? … : "gps"` and printed on the owner's board as
 * **Position** — mock-location evidence, which is the one thing they are not. The detector breakdown
 * hid it too: with signboard folded into gps there was only one source in the tally, and the callout
 * that names them renders only when there are two or more.
 *
 * 🔴 AND `capture_trust` WAS THE SAME DEFECT, UNSPRUNG. It was allowed by the table's `source` CHECK
 * in the same migration (20261008023051) and was missing from here too; it had filed 0 rows on
 * production by 2026-10-09 only because it files on a place validation rather than on a nightly pass,
 * so the first rep to validate a place whose photo fix and capture pin disagree would have had his
 * case printed as Position. It is in the list on the evidence that it CAN file, not on a count.
 *
 * It is ONE list, exported, and everything else is derived from it — the type, the labels, the
 * coercion of a row's own `source`, and the tally. Adding a detector to the table and not to this
 * array is what `tests/phoenix-crm-integrity-settle.test.ts` reads every filer's `source:` literal to
 * catch, because the compiler cannot: the column is text and the filers write string literals.
 */
export const INTEGRITY_SOURCES = ["gps", "photo", "behaviour", "signboard", "capture_trust", "roster", "cadence", "coverage", "visit_photo"] as const;

export type IntegritySource = (typeof INTEGRITY_SOURCES)[number];

function isIntegritySource(value: unknown): value is IntegritySource {
  return typeof value === "string" && (INTEGRITY_SOURCES as readonly string[]).includes(value);
}

/**
 * The place this case was JUDGED against, when the detector recorded one — `signals.placeId`.
 *
 * 🔴 IT IS NOT THE SAME AS THE VISIT'S OWN `place_id`, AND THAT IS THE WHOLE POINT. The
 * visit-against-the-photograph pass measures a visit against the NEAREST photograph of that
 * customer captured before it, because a customer with two clinics is at whichever door the rep
 * stood at — so the anchor can be a different row of `phoenix_crm_places` from the one the visit
 * was saved against. Drawing the visit's own place here would print a distance the case was never
 * filed on, which is the one thing this panel must never do.
 *
 * Every other detector leaves it absent, and the reader then falls back to the visit's place
 * exactly as it did before.
 */
function anchorPlaceIdOf(row: Row): string | null {
  const signals = row.signals && typeof row.signals === "object" ? (row.signals as Record<string, unknown>) : {};
  const placeId = signals.placeId;
  return typeof placeId === "string" && placeId !== "" ? placeId : null;
}

/**
 * What a case can be ABOUT. The second half of this table's identity, and it had no list of its own.
 *
 * 🔴 IT IS THE SAME DEFECT `signboard` HAD, ONE COLUMN ACROSS. `subject_kind` is text with a CHECK,
 * the reader coerced it with `row.subject_kind === "place" ? "place" : "visit"`, and the visit
 * distance lookup asked `!== "place"` — so the day a third kind was filed, its case would have
 * printed on the owner's board as a VISIT and its id would have been looked up in
 * `phoenix_crm_visits`, where it does not exist. Two of the 2026-10-12 detectors file exactly such a
 * kind: a cadence finding is about a CUSTOMER and the shared-venue capture-trust case is about a
 * venue in `phoenix_crm_shared_places`.
 *
 * ONE list, and everything is derived from it — the type, the labels, the coercion, and the positive
 * test that decides whose id may be looked up as a visit. 🔴 IT LIVES IN
 * `@/lib/crm-integrity/integrity-case-story` AND IS RE-EXPORTED HERE, because the board's own client
 * view needs the same words and may not import this module at all (the service-role client would go
 * into the browser bundle with it). Every existing reader keeps its one import from here.
 */
export { INTEGRITY_SUBJECT_KINDS, integritySubjectKindLabel };
export type { IntegritySubjectKind };

function isIntegritySubjectKind(value: unknown): value is IntegritySubjectKind {
  return typeof value === "string" && (INTEGRITY_SUBJECT_KINDS as readonly string[]).includes(value);
}

/**
 * The detectors a viewer who is NOT the Super Admin may read — an ALLOW-LIST, never a subtraction.
 *
 * The position cases are the Super Admin's alone (owner, 2026-10-02) and the query used to say so as
 * `.eq("source", "photo")`, which is the same thing only for as long as `photo` is the only other
 * detector. It was not: `signboard` was kept out of the SFE's board by that accident rather than by a
 * decision. Written as an allow-list, a detector added later is the Super Admin's until somebody
 * decides otherwise — the safe direction for a table whose rows carry a person's name.
 */
const SFE_SOURCES: IntegritySource[] = ["photo"];

export type IntegrityBoardFlag = PhoenixCrmIntegrityFlag | PhoenixCrmPhotoFlag;

/**
 * One point this case has — a pin, a photograph's own fix, the place on the list.
 *
 * 🔴 THE POINTS TRAVEL AND THE METRES DO NOT. `tests/crm-integrity-place-distance.test.ts` refuses
 * every spelling of a great-circle calculation in this file — including in a comment, which is how
 * this line was first written — and that is the right place to draw it: a distance computed here
 * would be a second derivation of a number the visit row already carries, and the two drift. So the
 * loader hands the view the readings, and the view measures between them with `distanceMeters` from
 * the module's own `geo.ts` — one implementation, used once.
 *
 * `label` is what the reader sees beside the marker, in plain words. `atIso` is when that reading
 * was taken, when the row records it; null is UNKNOWN and never a zero.
 */
export type CaseReading = {
  label: string;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  atIso: string | null;
};

/**
 * One line of the case's own history — what happened to this customer or this place, and who did it.
 *
 * Read from `phoenix_crm_list_events`, the module's own trail of decisions. `byName` is the person's
 * NAME and never an HR id (the owner's standing rule); null when the row names nobody, which is what
 * an automated pass leaves behind.
 */
export type CaseEvent = {
  atIso: string;
  what: string;
  byName: string | null;
};

/**
 * Every `phoenix_crm_list_events.event_type` the module has written, in plain English (27 of them on
 * production, read 2026-10-13).
 *
 * Written out rather than prettified from the code, because a reader of this board is deciding about
 * a named person and `customer_merged_out` is not a sentence. A type this map does not hold falls
 * back to its own words with the underscores opened out — visible, never hidden, and never a code
 * printed as if it were English.
 */
const EVENT_LABELS: Record<string, string> = {
  customer_pending: "Added to the list, waiting to be validated",
  customer_loaded: "Loaded onto the list",
  customer_validated: "Validated at a place",
  customer_admitted: "Admitted to the list",
  customer_dropped: "Dropped from the list",
  customer_archived: "Archived",
  customer_renamed: "Renamed",
  customer_merged_in: "Another record was merged into this one",
  customer_merged_out: "Merged into another record",
  customer_met_outside: "Met away from the place",
  grade_changed: "Grade changed",
  list_type_changed: "Moved between the AM and PM lists",
  list_loaded: "The whole list was loaded",
  pharmacy_added: "A pharmacy was added",
  place_added: "A place was captured",
  place_updated: "The place was edited",
  place_moved: "The place was moved",
  place_retired: "The place was retired",
  place_restored: "The place was put back",
  request_created: "A request was raised",
  request_decided: "The request was decided",
  request_moved_on: "The request moved to the next reviewer",
  request_withdrawn: "The request was withdrawn",
  validation_held: "The validation was held for review",
  validation_review_approved: "The validation was approved",
  validation_review_rejected: "The validation was sent back",
  visit_locations_restamped: "The visits were re-stamped against the place",
};

export function integrityEventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType.replace(/_/g, " ");
}

/**
 * Every flag's plain English, from both detectors.
 *
 * Merged HERE rather than in either rules module, deliberately: the position checks and the photo
 * checks share nothing but this screen, and a single union living in one of them would be the first
 * step towards the phone importing the other.
 */
const FLAG_LABELS: Record<string, string> = { ...PHOENIX_CRM_INTEGRITY_LABELS, ...PHOENIX_CRM_PHOTO_LABELS };

const SOURCE_LABELS: Record<IntegritySource, string> = {
  gps: "Position",
  photo: "Photo",
  behaviour: "Pattern",
  signboard: "Signboard",
  // The place's own two readings against each other — the photo's shutter fix and the capture pin.
  // "Capture trust" is what the check is called everywhere else in the module; it is not a position
  // verdict and must never read as one on this screen.
  capture_trust: "Capture trust",
  // The three the second-pass audit added (2026-10-12). Each names what was READ, never what it
  // means: the roster, the call cadence, the brick coverage. "Roster" is not a position verdict and
  // "Coverage" is a finding about the data rather than about a person.
  roster: "Roster",
  cadence: "Cadence",
  coverage: "Coverage",
  // The ninth (2026-10-13), on the owner's own instruction: the rep's visit fix against the
  // PHOTOGRAPH taken at the place. It names what was compared and not what it means — "Visit
  // against the photograph" is a measurement, and a rep who filled the form in the car outside
  // produces it honestly.
  visit_photo: "Visit against the photograph",
};


export function integritySourceLabel(source: IntegritySource): string {
  return SOURCE_LABELS[source] ?? source;
}

export type IntegrityCase = {
  id: string;
  subjectKind: IntegritySubjectKind;
  subjectId: string;
  /** The rep's NAME, never his code (owner's standing rule). */
  repName: string;
  repHrId: string;
  customerName: string;
  seatId: string;
  capturedAt: string;
  /**
   * When the nightly pass FILED the case, which is not when the capture happened.
   *
   * The two differ by hours or by days — a sign read again a week later files a case about a
   * capture from the 3rd — and the filter bar offers both, because "what did the pass find last
   * night" and "what happened on the 3rd" are different questions a reader asks.
   */
  filedAt: string | null;
  visitDate: string | null;
  strong: boolean;
  /** Which detector filed it — the position, the photo, or the pattern. */
  source: IntegritySource;
  flags: IntegrityBoardFlag[];
  /** Those flags in plain English, ready to print. */
  reasons: string[];
  lat: number | null;
  lon: number | null;
  accuracyMeters: number | null;
  deviceMocked: boolean | null;
  /**
   * How far this VISIT was saved from the place it names, in metres - read from the visit row,
   * never recomputed here. `phoenix_crm_visits.distance_meters` is written at capture and is the
   * same figure the place-vs-actual report prints, so the board and that report can never
   * disagree about one visit.
   *
   * Null for a PLACE case (a place has no place to be far from), and for a visit whose row is
   * gone or never carried a distance. Null is UNKNOWN, never zero - a rep standing exactly on the
   * pin reads 0, and the two must not look alike.
   */
  placeDistanceMeters: number | null;
  /** The visit’s own stored verdict on that distance, e.g. far from the place. Null when unknown. */
  placeLocationFlag: string | null;
  /**
   * What the signboard read when this case was filed, verbatim, in its own script.
   *
   * The whole evidence of a signboard case, and the board showed none of it: a Super Admin reading
   * "the signboard names somebody else" had no way to see WHICH name without opening the database,
   * which is the one thing this screen exists to spare him. Null for every other detector.
   */
  signText: string | null;
  /** A later reading of the same sign, when one has been taken. Signboard cases only. */
  laterReading: IntegrityLaterReading | null;
  /**
   * The Super Admin's own settlement, when this case carries one that still describes it.
   *
   * Null for a case nobody has settled AND for one that was settled and has since been flagged
   * again — the two are the same thing to a reader, because both mean somewhere to look. `byName`
   * is the person's name; the HR id is kept beside it for the record, never printed.
   */
  settlement: IntegritySettlement | null;
  signals: Record<string, unknown>;
  isTest: boolean;
  /**
   * The photograph this case is about, as a storage PATH — signed by the scoped photo route when the
   * reader opens the case, never read from the bucket here.
   *
   * Null is "none kept", which is a real and ordinary answer: the one-tap visit (2026-09-29) keeps no
   * door photograph at all, so a visit case has none of its own while every place case has one. The
   * panel says so in words rather than drawing an empty frame.
   *
   * 🔴 ON A `visit_photo` CASE THIS PATH IS THE PLACE'S PHOTOGRAPH, NOT THE VISIT'S — the detector
   * files it in `signals.photoPath` deliberately, because the picture a reader judges that case on
   * is the one the place was validated with, and the visit itself keeps none. It is also captured by
   * somebody else on another day, which is why the panel captions that one differently.
   */
  photoPath: string | null;
  /** Every point this case has, each already named in the words the reader sees. */
  readings: CaseReading[];
  /**
   * Every visit this case's customer saved, as POINTS — the readings above are judged against them.
   *
   * 🔴 THE PHOTOGRAPH IS THE ANCHOR AND THESE ARE WHAT IS MEASURED AGAINST IT (owner, 13 October
   * 2026). A place's two readings can disagree with no way to tell which is stale from the case
   * alone; the visits the rep saved later are the one piece of evidence that sits with one of them,
   * and `visitsAgainstThePhotographSentence` is where that is said. Points only — the metres are the
   * view's to measure, exactly as for `readings`.
   *
   * Empty for a visit case, whose own fix is already a reading, and for a customer with no visit.
   */
  nearbyVisits: CaseVisitPoint[];
  /** The colleagues the visit named who were recorded off duty that day, BY NAME. */
  companionNames: string[];
  /** Whose earlier reading a replayed coordinate matches, BY NAME. Null when it was the rep's own. */
  replayByName: string | null;
  /** The place or venue the case is about, by its own name. Null for a visit or a customer. */
  subjectLabel: string | null;
  /** The rep's line, area and region BY NAME, from the organogram — the filter bar's own groups. */
  repLine: string | null;
  repArea: string | null;
  repRegion: string | null;
  /** The customer's own list (AM or PM) and speciality, for the filter bar and the story. */
  customerList: string | null;
  customerSpeciality: string | null;
  /** The brick the place resolved to, and how far outside it the capture fell. */
  brickName: string | null;
  brickDistanceKm: number | null;
  /** What has happened to this customer or this place, oldest first. */
  history: CaseEvent[];
};

/**
 * Re-exported so every existing reader of this module keeps one import. The type and the rule behind
 * it live in `@/lib/phoenix-crm/integrity-settlement`, which the board's own button can import
 * without pulling the service-role client into the browser bundle.
 */
export type { IntegritySettlement };

/**
 * A rep's MONTH, as the behaviour pass judged it. Not a capture, which is why it is its own list.
 *
 * `measured: false` is the row that matters most to read correctly: the month was too thin to carry
 * a claim, so it is NOT CHECKED. A rep on leave for three weeks must never read as a clean month.
 */
export type BehaviourCase = {
  id: string;
  month: string;
  /** The rep's NAME, never his code (owner's standing rule). */
  repName: string;
  repHrId: string;
  seatId: string | null;
  visits: number;
  measured: boolean;
  strong: boolean;
  flags: PhoenixCrmBehaviourFlag[];
  /** Those flags in plain English, ready to print. */
  reasons: string[];
  signals: Record<string, unknown>;
};

export type IntegrityBoard = {
  /** The cases that still stand — every one whose evidence a later reading has not taken away. */
  cases: IntegrityCase[];
  /**
   * Flags a later reading no longer supports. Listed, never dropped, and never counted as findings.
   *
   * 🔴 THEY ARE SEPARATED RATHER THAN DELETED, AND THEY ARE NOT HIDDEN EITHER. The table has no
   * resolution column, so the only way to clear a flag today is to delete the row — and deleting
   * evidence because a second reading disagreed is how the record of what the detector actually did
   * disappears. They leave the three counters, because a counter is a call to look and a withdrawn
   * flag is not one, and they keep their own section with both readings side by side.
   */
  withdrawn: IntegrityCase[];
  /**
   * Cases the Super Admin has looked at and settled, with his reason on each.
   *
   * 🔴 OUT OF THE COUNTERS, NEVER OUT OF THE PAGE, AND NEVER DELETED. A settled case keeps its row,
   * its flags and its evidence; it leaves the counters because a counter is a call to look and a case
   * he has already looked at is not one. It comes BACK the moment its subject is flagged again —
   * `settlement` is read as null once the stored flags no longer match the row's, so the case
   * re-enters `cases` on its own and is counted again.
   */
  settled: IntegrityCase[];
  /** How many of the listed cases carry at least one individually damning flag. */
  strongCount: number;
  /** Reps appearing in the list, most cases first — where a pattern shows rather than an incident. */
  byRep: { repHrId: string; repName: string; cases: number; strongCases: number }[];
  /** How many cases each detector filed, so a silent detector is visible as a zero. */
  bySource: { source: IntegritySource; label: string; cases: number }[];
  /** Months whose SHAPE did not hold up. Strongest and most recent first. */
  behaviour: BehaviourCase[];
  /** Months the sweep could not judge at all — too few visits. NOT CHECKED, never clean. */
  behaviourNotChecked: number;
  /**
   * True when either read stopped at its ceiling, so the page can say so instead of presenting a
   * part of the board as the whole of it. The same honesty `ValidationBoardRead` carries.
   */
  capped: boolean;
};

/**
 * The ceilings on the two paged reads. A bound on memory, not a bound on the board.
 *
 * 🔴 BOTH READS RAN ON `.limit(200)` UNTIL 2026-10-12, AND EACH DROPPED ROWS SILENTLY. The capture
 * read is ordered `strong desc, captured_at desc`, so past 200 the board stopped showing the oldest
 * cases — and nothing said so: there was no `capped`, and the counters counted what had been read.
 * The behaviour read was worse than cosmetic: `behaviourNotChecked` counts the unmeasured months
 * among the rows it got back, so a truncated read UNDER-REPORTED how much of the field the pass
 * cannot speak about — the one number on the board whose whole job is to admit a blind spot.
 *
 * `whenFull: "stop"` on both, because this read PRESENTS: strongest and newest first means a ceiling
 * loses the oldest and least damning, and `capped` then says it out loud. A read that JUDGED would
 * have to refuse instead (`server/paged-read.ts`).
 */
const BOARD_READ_MAX = 5_000;
const BEHAVIOUR_READ_MAX = 5_000;

/**
 * May this viewer read the evidence at all? The Super Admin and the SFE Manager, and nobody else.
 *
 * One predicate, two readers — this service and the page — so the board's audience is stated once
 * and a screen can never be more generous than the service behind it.
 */
export function canReadIntegrityBoard(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin || viewer.isSfeManager;
}

/**
 * May this viewer read the POSITION cases — the GPS detector's, mock-location included — and the
 * phone's own mock answer? The Super Admin alone (owner, 2026-10-02). The SFE Manager opens the board
 * for the photo cases and the behaviour months, and the position cases are never queried for him.
 */
export function readsPositionCases(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin;
}

/**
 * May this viewer SETTLE a case? The Super Admin alone — narrower than reading the board, and narrower
 * than a place decision too: `canDecideValidationReviews` admits the SFE Manager since 2026-10-19 and
 * this does not. Settling stays his own ruling (2026-10-09), unchanged by that widening.
 *
 * 🔴 THE SFE MANAGER READS THIS BOARD AND DOES NOT SETTLE ON IT (owner, 2026-10-09, on keeping the
 * signboard cases to the Super Admin). Settling is a judgement that a flag about a named person needs
 * nothing further, which is the one decision on this screen; reading it is not. A test persona is
 * refused as well, as it is everywhere else — a trial account must not be able to close a real case
 * about a real rep.
 */
export function canSettleIntegrityCases(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin && viewer.canUpdate && !viewer.isTestPersona;
}

/**
 * The settlement a row still carries, or null.
 *
 * 🔴 NULL IS RETURNED FOR A ROW WHOSE FLAGS HAVE MOVED SINCE, and that is the reopening mechanism.
 * The filers upsert on (subject_kind, subject_id, source), so a new finding on the same subject
 * REPLACES `flags` in place and leaves `settled_flags` describing a case that no longer exists. The
 * board then shows it as standing again, in the counters, exactly as if it had never been settled —
 * without one filer being taught about settling, and without any job having to go back and clear
 * settlements.
 *
 * A half-written settlement cannot exist (the table's own CHECK), but it is still read defensively:
 * a missing author or note makes the whole thing null rather than printing a settlement nobody owns.
 */
// `PeopleNames` and not `Map<string, string>`: the loader returns a ReadonlyMap, which a mutable Map
// parameter refuses. Naming the module's own type also says this function never writes to it.
function settlementOf(row: Row, people: PeopleNames): IntegritySettlement | null {
  const settlement = readIntegritySettlement({
    settledAt: row.settled_at,
    settledBy: row.settled_by,
    settledNote: row.settled_note,
    settledFlags: row.settled_flags,
    flagsNow: Array.isArray(row.flags) ? row.flags : [],
  });
  if (!settlement) return null;
  // The one thing added on top of the pure rule: the person's NAME, never his code.
  return { ...settlement, byName: nameOf(people, settlement.byHrId) || settlement.byHrId };
}

/**
 * The months the behaviour pass judged, strongest and most recent first.
 *
 * Read separately from the captures because it IS separate: a behaviour verdict is about a rep and a
 * month, not about a visit, and it is recomputed whole every night as more of the month lands.
 *
 * 🔴 IT PAGES, AND `id` IS THE TIEBREAKER THAT MAKES THE WALK SAFE. `strong desc, month desc` is not
 * a total order — a rep and a month share both keys with every other rep in that month — so an offset
 * walk over it would skip and repeat at a page seam. `notChecked` is counted from the complete read,
 * which is the point: it is the board's admission of what the pass could not judge.
 */
async function loadBehaviourCases(): Promise<{ cases: BehaviourCase[]; notChecked: number; repHrIds: string[]; capped: boolean }> {
  const read = await readEveryPage<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_behaviour_integrity")
        .select("id, month, rep_hr_id, seat_id, visits, measured, flags, strong, signals")
        .eq("is_test", false)
        .order("strong", { ascending: false })
        .order("month", { ascending: false })
        .order("id", { ascending: true }),
    {
      maxRows: BEHAVIOUR_READ_MAX,
      whenFull: "stop",
      what: "Phoenix CRM behaviour months",
      uniqueBy: (row) => String(row.id),
    },
  );
  throwIfError(read.error);
  const rows = read.rows;
  // A month with nothing wrong is not a case, but a month that could not be JUDGED is counted, so
  // the page can say how much of the field this pass is actually able to speak about.
  const notChecked = rows.filter((row) => row.measured !== true).length;
  const flagged = rows.filter((row) => Array.isArray(row.flags) && row.flags.length > 0);
  return {
    cases: flagged.map((row) => {
      const flags = (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag)) as PhoenixCrmBehaviourFlag[];
      return {
        id: String(row.id),
        month: String(row.month ?? ""),
        repHrId: String(row.rep_hr_id ?? ""),
        repName: "",
        seatId: row.seat_id ? String(row.seat_id) : null,
        visits: Number(row.visits ?? 0),
        measured: row.measured === true,
        strong: row.strong === true,
        flags,
        reasons: flags.map((flag) => PHOENIX_CRM_BEHAVIOUR_LABELS[flag] ?? flag),
        signals: (row.signals && typeof row.signals === "object" ? row.signals : {}) as Record<string, unknown>,
      };
    }),
    notChecked,
    repHrIds: [...new Set(flagged.map((row) => String(row.rep_hr_id ?? "")).filter(Boolean))],
    capped: read.capped,
  };
}

/**
 * Load the board. Checked here as well as on the page, because this is the one place in Phoenix CRM
 * where reading the data IS the sensitive act.
 */
export async function loadIntegrityBoard(viewer: PhoenixCrmViewer, options: { includeTest?: boolean } = {}): Promise<IntegrityBoard> {
  if (!canReadIntegrityBoard(viewer)) throw notFoundError("Not found.");

  const supabase = getSupabaseAdmin();
  // The position cases are the Super Admin's alone (owner, 2026-10-02): for anyone else the query asks
  // only for the detectors on the allow-list, so a case he may not read never leaves the database.
  const positions = readsPositionCases(viewer);
  // 🔴 BUILT FRESH PER PAGE, AND EVERY NARROWING LIVES INSIDE IT. `readEveryPage` calls this once for
  // each page and adds its own `.range()`, so a builder that leaked a filter — the audience cut most
  // of all — would narrow the first page and open the rest. The tier is decided here, once, and the
  // walk cannot widen it.
  const buildQuery = () => {
    let query = supabase
      .from("phoenix_crm_location_integrity")
      .select("id, subject_kind, subject_id, source, seat_id, rep_hr_id, customer_id, captured_at, created_at, visit_date, lat, lon, accuracy_meters, device_mocked, flags, strong, signals, is_test, settled_at, settled_by, settled_note, settled_flags")
      .order("strong", { ascending: false })
      .order("captured_at", { ascending: false })
      // The tiebreaker that makes the walk a total order. `strong desc, captured_at desc` is not one:
      // two captures in the same second — exactly the shape the behaviour rules look for — share both
      // keys, and an order that wobbles between pages both drops rows and repeats them.
      .order("id", { ascending: true });
    // Test captures stay the Super Admin's, as they are everywhere else in the module: the SFE reads
    // the real field, never the Super Admin's own trial entries.
    if (options.includeTest !== true || !viewer.isSuperAdmin) query = query.eq("is_test", false);
    if (!positions) query = query.in("source", SFE_SOURCES);
    return query;
  };

  const [read, behaviourRead] = await Promise.all([
    readEveryPage<Row>(buildQuery, {
      maxRows: BOARD_READ_MAX,
      whenFull: "stop",
      what: "Phoenix CRM integrity cases",
      uniqueBy: (row) => String(row.id),
    }),
    loadBehaviourCases(),
  ]);
  throwIfError(read.error);
  const rows = read.rows;
  const capped = read.capped || behaviourRead.capped;
  if (rows.length === 0 && behaviourRead.cases.length === 0) {
    return { cases: [], withdrawn: [], settled: [], strongCount: 0, byRep: [], bySource: [], behaviour: [], behaviourNotChecked: behaviourRead.notChecked, capped };
  }

  const customerIds = [...new Set(rows.map((row) => (row.customer_id ? String(row.customer_id) : null)).filter((id): id is string => Boolean(id)))];
  /** The evidence names people by HR id, deliberately — a name written into a row goes stale. Resolve here. */
  const signalsOf = (row: Row): Record<string, unknown> =>
    (row.signals && typeof row.signals === "object" ? row.signals : {}) as Record<string, unknown>;
  const hrIdsInSignals = (row: Row): string[] => {
    const signals = signalsOf(row);
    const companions = Array.isArray(signals.offDutyCompanionHrIds) ? signals.offDutyCompanionHrIds : [];
    const replay = signals.replay && typeof signals.replay === "object" ? (signals.replay as Record<string, unknown>) : {};
    return [...companions.map((entry) => String(entry ?? "")), String(replay.byRepHrId ?? "")].filter(Boolean);
  };

  // ── The reads, declared one by one and started together ───────────────────────────────────────
  //
  // 🔴 EACH READ BELOW WAS AWAITED AFTER THE ONE BEFORE IT UNTIL 2026-10-16 — eighteen to twenty-five
  // round trips end to end, on the page and on the export alike (Phoenix CRM performance audit) —
  // although almost none of them needs another's answer. Every read needs only the cases themselves,
  // except three: the places and the places' own trail need the visits the cases point at, and the
  // second names read needs the trail. So each read is DECLARED here with its reason beside it, as
  // before, and one `Promise.all` further down starts them together: the board waits for its slowest
  // chain of reads, never for the sum of them.
  //
  // 🔴 AND NOTHING ELSE MOVED. Every select is the select it was, chunked at 50 and non-fatal the way it
  // was. A chunked read runs four chunks at a time and hands them back IN CHUNK ORDER, and its reader
  // stops at the first chunk that failed — exactly the rows the one-after-another loop kept when it
  // broke there — so even a failure leaves the board it left before.
  const inChunksOf50 = <T>(length: number, read: (index: number) => Promise<T>): Promise<T[]> => {
    const starts: number[] = [];
    for (let index = 0; index < length; index += 50) starts.push(index);
    return mapWithConcurrency(starts, CHUNK_READS_AT_ONCE, read);
  };

  /**
   * One chunk of a read that GROWS WITH THE FIELD, keyset-paged on `id`.
   *
   * 🔴 TWO READS ON THIS BOARD WERE A SINGLE UNPAGED REQUEST PER CHUNK until 2026-10-16 — every visit of
   * fifty customers, and the trail of fifty customers or places — and PostgREST answers any request
   * with at most 1,000 rows and says nothing when it stops. Both grow with every working day, so the
   * day a chunk passed 1,000 the story would have dropped visits and history lines with no sign of
   * it. Keyset on `id`, never an offset: both tables are written to while this reads them.
   *
   * A page that fails is the whole chunk failing (`failed: true`, no rows), never a shorter answer —
   * the reader then stops there, as it always did on a failed chunk.
   */
  const readGrowing = async (buildQuery: Parameters<typeof fetchAllRowsKeyset>[0]): Promise<{ rows: Row[]; failed: boolean }> => {
    try {
      const found = await fetchAllRowsKeyset<Row>(buildQuery, {
        cursorColumn: "id",
        cursorOf: (entry) => (entry.id === null || entry.id === undefined ? null : String(entry.id)),
      });
      return { rows: found, failed: false };
    } catch {
      return { rows: [], failed: true };
    }
  };

  // Whoever SETTLED a case is loaded with the reps, because the board prints the name and never the
  // HR id — the owner's standing rule holds for the person who closed the case as much as for the
  // person it is about. The two people the EVIDENCE names come with them: the colleague recorded as
  // off duty on a visit, and whoever used a replayed coordinate first.
  const readPeople = (): Promise<PeopleNames> =>
    loadPeopleNames([
      ...new Set(
        [
          ...rows.map((row) => String(row.rep_hr_id ?? "")),
          ...rows.map((row) => String(row.settled_by ?? "")),
          ...rows.flatMap((row) => hrIdsInSignals(row)),
          ...behaviourRead.repHrIds,
        ].filter(Boolean),
      ),
    ]);

  // The customer's own list and speciality ride along with the name: both are filter groups the
  // owner asked for, and the story says "on the PM list" rather than printing a code. There is no
  // `ampm` column on this table — `list_type` is the AM/PM answer.
  //
  // 🔴 CHUNKED SINCE 2026-10-16. It was the one id list on this board sent whole, and an over-long
  // `.in()` comes back empty with no error — every case would have printed its customer as "—" on
  // the day the board passed a few hundred customers. Non-fatal per chunk, as the single read was
  // non-fatal: a chunk that fails leaves its own customers unnamed and nothing else.
  const readCustomers = async (): Promise<Row[]> => {
    const pages = await inChunksOf50(customerIds.length, async (index) =>
      await supabase.from("phoenix_crm_customers").select("id, name, speciality, list_type").in("id", customerIds.slice(index, index + 50)),
    );
    return pages.flatMap((page) => (page.data ?? []) as Row[]);
  };

  // The distance a visit was saved from its place already exists on the visit row, written at
  // capture. Read it rather than recompute it: recomputing would let this board and the
  // place-vs-actual report print two different numbers for one visit, and the report is the one
  // the DM and SFE already read.
  // 🔴 `=== "visit"`, NEVER `!== "place"`. The negative form meant "everything that is not a place is
  // a visit id", so the moment a third kind was filed its id went into this list and was looked up in
  // `phoenix_crm_visits` — a customer id asked of the visits table, which simply returns nothing and
  // leaves the case reading as a visit saved at its place. Only a visit has a distance from a place.
  const visitIds = [...new Set(rows.filter((row) => row.subject_kind === "visit").map((row) => String(row.subject_id)).filter(Boolean))];
  const readVisitDistances = async (): Promise<Map<string, { distanceMeters: number | null; locationFlag: string | null }>> => {
    const visitDistances = new Map<string, { distanceMeters: number | null; locationFlag: string | null }>();
    // Chunked at 50: a PostgREST `.in()` carrying several hundred ids comes back `{ data: [] }` past
    // some URL length, and an empty set here would read as “every case is at its place”.
    const pages = await inChunksOf50(visitIds.length, async (index) =>
      await supabase
        .from("phoenix_crm_visits")
        .select("id, distance_meters, location_flag")
        .in("id", visitIds.slice(index, index + 50)),
    );
    for (const { data: visitRows, error: visitError } of pages) {
      // Non-fatal: the board is about the flags, and a missing distance must never blank it.
      if (visitError) break;
      for (const visit of (visitRows ?? []) as Array<{ id: string; distance_meters: number | string | null; location_flag: string | null }>) {
        const raw = visit.distance_meters;
        const parsed = raw === null || raw === undefined || raw === "" ? null : Number(raw);
        visitDistances.set(String(visit.id), {
          distanceMeters: parsed !== null && Number.isFinite(parsed) ? parsed : null,
          locationFlag: visit.location_flag ? String(visit.location_flag) : null,
        });
      }
    }
    return visitDistances;
  };

  // Every visit each flagged customer saved, as points — what the place's own readings are judged
  // against (owner, 13 October 2026: drop the pin, compare the visits with the photograph). Keyed by
  // CUSTOMER and not by the case, because the evidence that settles a place's two readings is what
  // the rep saved at that customer afterwards, which is a different row every time.
  //
  // 🔴 NOTHING IS MEASURED HERE, same as `readingsFor`: the metres belong to the pure view module,
  // and `tests/crm-integrity-place-distance.test.ts` refuses any distance derived in this file by
  // reading its SOURCE, comments included — so even naming the formula here turns that pin red.
  // Chunked at 50 and non-fatal for the reason the visit distances are — an empty set must read as
  // "no visit to compare", which is what the sentence says, never as "the visits agree" — and
  // keyset-paged within each chunk (`readGrowing`), because fifty customers' visits pass 1,000 rows.
  const caseCustomerIds = [...new Set(rows.map((row) => String(row.customer_id ?? "")).filter(Boolean))];
  // Its own parse: the loader's `num` is a `const` declared further down, so reaching for it here
  // would be a reference error at runtime and not a type error at build time.
  const coordinate = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const readCustomerVisitPoints = async (): Promise<Map<string, CaseVisitPoint[]>> => {
    const customerVisitPoints = new Map<string, CaseVisitPoint[]>();
    const pages = await inChunksOf50(caseCustomerIds.length, (index) =>
      readGrowing(() =>
        supabase
          .from("phoenix_crm_visits")
          // `id` is the keyset cursor and nothing else; the point is still the four readings.
          .select("id, customer_id, lat, lon, accuracy_meters, captured_at")
          .in("customer_id", caseCustomerIds.slice(index, index + 50))
          .eq("is_test", false)
          .not("lat", "is", null),
      ),
    );
    for (const { rows: pointRows, failed } of pages) {
      if (failed) break;
      for (const visit of pointRows) {
        const customerId = String(visit.customer_id ?? "");
        const latitude = coordinate(visit.lat);
        const longitude = coordinate(visit.lon);
        if (customerId === "" || latitude === null || longitude === null) continue;
        const kept = customerVisitPoints.get(customerId) ?? [];
        kept.push({
          lat: latitude,
          lon: longitude,
          accuracyMeters: coordinate(visit.accuracy_meters),
          atIso: typeof visit.captured_at === "string" && visit.captured_at !== "" ? visit.captured_at : null,
        });
        customerVisitPoints.set(customerId, kept);
      }
    }
    return customerVisitPoints;
  };

  // What each flagged place's signboard reads NOW. The place row is the only record of that — the
  // nightly pass keeps a verdict there for every place, flagged or not — so a flag that a later
  // reading has taken the ground out from under can be told apart from one that still stands.
  // Chunked at 50 for the same reason the visits are.
  const signboardPlaceIds = [...new Set(rows.filter((row) => row.source === "signboard").map((row) => String(row.subject_id)).filter(Boolean))];
  const readPlaceSignboards = async (): Promise<Map<string, StoredSignboardVerdict>> => {
    const placeSignboards = new Map<string, StoredSignboardVerdict>();
    const pages = await inChunksOf50(signboardPlaceIds.length, async (index) =>
      await supabase
        .from("phoenix_crm_places")
        .select("id, signboard_check")
        .in("id", signboardPlaceIds.slice(index, index + 50)),
    );
    for (const { data: placeRows, error: placeError } of pages) {
      // Non-fatal, and it fails towards leaving the flag standing: a place whose current verdict could
      // not be read keeps its case in the live list, which is where an unknown belongs.
      if (placeError) break;
      for (const place of (placeRows ?? []) as Array<{ id: string; signboard_check: unknown }>) {
        // One coercion, shared with Phoenix Ranks' own reader — the two must agree about a withdrawn
        // case or a rep is charged on one screen for a finding the other has already dropped.
        const stored = readStoredSignboardVerdict(place.signboard_check);
        if (!stored) continue;
        placeSignboards.set(String(place.id), stored);
      }
    }
    return placeSignboards;
  };

  // ── The evidence that turns a case into something a reader can judge ──────────────────────────
  //
  // Four more reads, each in the shape of the two above: chunked at 50, non-fatal, failing towards a
  // field the panel simply does not draw rather than towards a blank board.
  //
  // 🔴 THEY ARE SEPARATE READS, AND THE TWO ABOVE ARE LEFT EXACTLY AS THEY ARE. Each of those asks
  // one narrow question — what distance was written at capture, what does the sign read now — and
  // both selects are pinned byte-for-byte by the tests that own those rules. Widening one to carry
  // the photograph and the pin as well would make a single read answer two questions, and the next
  // session to change the story's evidence would be editing the line that holds the distance rule.
  const readByIds = async (table: string, columns: string, ids: string[]): Promise<Row[]> => {
    const pages = await inChunksOf50(ids.length, async (index) => {
      const { data, error } = await supabase.from(table).select(columns).in("id", ids.slice(index, index + 50));
      return { data, error };
    });
    const out: Row[] = [];
    for (const { data, error } of pages) {
      // Non-fatal, like every other lookup on this board: the case itself is already read, and a
      // missing photograph or a missing pin must never take the finding off the screen.
      if (error) break;
      // A DOUBLE cast only because `table` is a plain string: supabase-js can give a literal
      // table name a row type and widens a dynamic one to `GenericStringError[]`, which does not
      // overlap `Row`. The sibling reads in this file name their table literally and need one cast.
      for (const found of (data ?? []) as unknown as Row[]) out.push(found);
    }
    return out;
  };

  const placeKindIds = [...new Set(rows.filter((row) => row.subject_kind === "place").map((row) => String(row.subject_id)).filter(Boolean))];
  const sharedKindIds = [...new Set(rows.filter((row) => row.subject_kind === "shared_place").map((row) => String(row.subject_id)).filter(Boolean))];

  const readVisitEvidence = (): Promise<Row[]> =>
    readByIds(
      "phoenix_crm_visits",
      "id, photo_path, lat, lon, accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at, captured_at, place_id",
      visitIds,
    );

  // The places read here are the place CASES plus the place each flagged visit was saved against —
  // a visit case's story is "the pin you saved and the place on the list are N apart", which needs
  // the place's own point and cannot be told from the visit row alone. That is why this read, alone
  // among the evidence, waits for the visits: it cannot know which places to ask for before them.
  const readPlaceEvidence = (visitEvidenceRows: Row[]): Promise<Row[]> => {
    const placeEvidenceIds = [
      ...new Set([
        ...placeKindIds,
        ...visitEvidenceRows.map((found) => (found.place_id ? String(found.place_id) : "")).filter(Boolean),
        // And the place each case was JUDGED against where the detector named one — see
        // `anchorPlaceIdOf`. Without this the visit-against-the-photograph cases would resolve to
        // the visit's own place, or to nothing at all when the visit carries no `place_id`.
        ...rows.map((row) => anchorPlaceIdOf(row)).filter((id): id is string => id !== null),
      ]),
    ];
    return readByIds(
      "phoenix_crm_places",
      "id, label, lat, lon, accuracy_meters, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_path, photo_captured_at, captured_at, brick_name, brick_distance_km, area_name, region_name",
      placeEvidenceIds,
    );
  };

  const readSharedEvidence = (): Promise<Row[]> =>
    readByIds(
      "phoenix_crm_shared_places",
      "id, name, lat, lon, accuracy_meters, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_path, photo_captured_at, captured_at, brick_name, brick_distance_km, area_name, region_name",
      sharedKindIds,
    );

  // What has happened to this customer and to this place, from the module's own trail of decisions.
  // Two reads because the trail is keyed two ways — a case about a place and a case about a customer
  // each has its own column — and `.in()` on the wrong one returns nothing without saying so.
  //
  // Keyset-paged within each chunk (`readGrowing`), so each chunk comes back in `id` order and is put
  // back in the trail's own order here: oldest first, as the query used to ask, and two events of the
  // same instant — one save often writes two — in the order they were written, which the old query
  // left to the planner. The case's story sorts its own lines oldest first again in any case.
  const eventColumns = "id, created_at, event_type, actor_hr_id, customer_id, place_id";
  const readEventsBy = async (column: string, ids: string[]): Promise<Row[]> => {
    const pages = await inChunksOf50(ids.length, (index) =>
      readGrowing(() => supabase.from("phoenix_crm_list_events").select(eventColumns).in(column, ids.slice(index, index + 50))),
    );
    const out: Row[] = [];
    for (const { rows: eventRows, failed } of pages) {
      if (failed) break;
      const oldestFirst = [...eventRows].sort((left, right) => {
        const leftAt = String(left.created_at ?? "");
        const rightAt = String(right.created_at ?? "");
        if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
        return Number(left.id) - Number(right.id);
      });
      for (const found of oldestFirst) out.push(found);
    }
    return out;
  };

  // The trail of the places — the place cases' own, and the place each flagged visit was saved
  // against — so it too waits for the visits, and runs beside the places read rather than after it.
  const readPlaceEvents = (visitEvidenceRows: Row[]): Promise<Row[]> =>
    readEventsBy("place_id", [
      ...new Set([...placeKindIds, ...visitEvidenceRows.map((found) => (found.place_id ? String(found.place_id) : "")).filter(Boolean)]),
    ]);

  // ── Started together: every read above, each as soon as what it needs is known ────────────────
  //
  // The visits-dependent pair is chained onto the visits read itself, so it starts the moment those
  // rows arrive instead of waiting for the slowest of the rest. `loadPeopleNames` still throws on a
  // failed read, exactly as it did when it ran first — every other read here is non-fatal.
  const visitEvidenceRead = readVisitEvidence();
  const placeStageRead = visitEvidenceRead.then((visitEvidenceRows) =>
    Promise.all([readPlaceEvidence(visitEvidenceRows), readPlaceEvents(visitEvidenceRows)]),
  );
  const [people, customerRows, visitDistances, customerVisitPoints, placeSignboards, visitEvidenceRows, sharedRows, customerEventRows, [placeRows, placeEventRows]] =
    await Promise.all([
      readPeople(),
      readCustomers(),
      readVisitDistances(),
      readCustomerVisitPoints(),
      readPlaceSignboards(),
      visitEvidenceRead,
      readSharedEvidence(),
      readEventsBy("customer_id", customerIds),
      placeStageRead,
    ]);

  const laterReadingFor = (row: Row): IntegrityLaterReading | null =>
    judgeLaterSignboardReading({
      source: String(row.source ?? ""),
      flags: (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag)),
      filedAt: row.created_at ? String(row.created_at) : null,
      stored: placeSignboards.get(String(row.subject_id)) ?? null,
    });

  const visitEvidence = new Map<string, Row>();
  for (const found of visitEvidenceRows) visitEvidence.set(String(found.id), found);
  const placeEvidence = new Map<string, Row>();
  for (const found of placeRows) placeEvidence.set(String(found.id), found);
  const sharedEvidence = new Map<string, Row>();
  for (const found of sharedRows) sharedEvidence.set(String(found.id), found);

  // The customer trail first and the place trail after it, as the two reads used to land: a line on
  // both keys is one row met twice, and the story drops the second copy.
  const historyRows: Row[] = [...customerEventRows, ...placeEventRows];

  // Whoever acted is named, never numbered — the owner's standing rule, which is why this is a
  // second people read: the actors are only known once the trail has been read.
  const actorNames = await loadPeopleNames([
    ...new Set(historyRows.map((found) => String(found.actor_hr_id ?? "")).filter(Boolean)),
  ]).catch(() => null);

  const eventOf = (found: Row): CaseEvent => ({
    atIso: String(found.created_at ?? ""),
    what: integrityEventLabel(String(found.event_type ?? "")),
    byName: found.actor_hr_id
      ? (actorNames ? nameOf(actorNames, String(found.actor_hr_id)) : "") || String(found.actor_hr_id)
      : null,
  });

  const historyByCustomer = new Map<string, CaseEvent[]>();
  const historyByPlace = new Map<string, CaseEvent[]>();
  for (const found of historyRows) {
    if (!found.created_at) continue;
    const event = eventOf(found);
    if (found.customer_id) {
      const key = String(found.customer_id);
      historyByCustomer.set(key, [...(historyByCustomer.get(key) ?? []), event]);
    }
    if (found.place_id) {
      const key = String(found.place_id);
      historyByPlace.set(key, [...(historyByPlace.get(key) ?? []), event]);
    }
  }

  const customerNames = new Map<string, string>();
  const customerLists = new Map<string, string>();
  const customerSpecialities = new Map<string, string>();
  for (const row of customerRows) {
    customerNames.set(String(row.id), String(row.name ?? ""));
    if (row.list_type) customerLists.set(String(row.id), String(row.list_type));
    if (row.speciality) customerSpecialities.set(String(row.id), String(row.speciality));
  }

  /** A number only when the row really carries one — `0` is a coordinate and `null` is not a zero. */
  const num = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  /** The row this case is ABOUT — the visit, the place or the shared venue. Nothing for a customer. */
  const subjectRowFor = (row: Row): Row | undefined => {
    const id = String(row.subject_id);
    if (row.subject_kind === "visit") return visitEvidence.get(id);
    if (row.subject_kind === "place") return placeEvidence.get(id);
    if (row.subject_kind === "shared_place") return sharedEvidence.get(id);
    return undefined;
  };

  /**
   * The PLACE behind this case — itself when the case is about a place, and the place the visit was
   * saved against when it is about a visit. A visit row carries no brick and no name of its own, so
   * reading the subject row for either would print a blank where there is a real answer.
   */
  const placeContextFor = (row: Row): Row | undefined => {
    if (row.subject_kind === "place") return placeEvidence.get(String(row.subject_id));
    if (row.subject_kind === "shared_place") return sharedEvidence.get(String(row.subject_id));
    if (row.subject_kind === "visit") {
      const anchorId = anchorPlaceIdOf(row);
      if (anchorId) {
        const anchor = placeEvidence.get(anchorId);
        if (anchor) return anchor;
      }
      const placeId = visitEvidence.get(String(row.subject_id))?.place_id;
      return placeId ? placeEvidence.get(String(placeId)) : undefined;
    }
    return undefined;
  };

  /**
   * The rep's line, area and region BY NAME, keyed on the case's own seat — four of the filter groups
   * the owner asked for, and the three facts that say whether a finding is one rep or one area.
   *
   * The organogram is already on the viewer (`viewer.org`, built once per request behind the module's
   * own five-minute cache), so this costs no query at all: no read to widen, and nothing that can
   * fail and leave the board half-drawn.
   */
  const seatFacts = (seatId: string): { line: string | null; area: string | null; region: string | null } => {
    const seat = seatId !== "" ? viewer.org.seats.get(seatId) : undefined;
    return { line: seat?.lineName ?? null, area: seat?.areaName ?? null, region: seat?.regionName ?? null };
  };

  /**
   * Every point this case has, each already named in the words the reader sees.
   *
   * 🔴 NOTHING IS MEASURED HERE. The metres between any two of these are the view's to compute, with
   * the module's one `distanceMeters` — see the note on `CaseReading`.
   *
   * Two readings at the same coordinates are not a duplicate to be tidied away: *the photograph and
   * the pin are the same reading* is the single commonest finding on this board (130 of 165 cases
   * read on production, 13 October), and the panel can only say so by drawing both.
   */
  const readingsFor = (row: Row): CaseReading[] => {
    const readings: CaseReading[] = [];
    const add = (label: string, lat: unknown, lon: unknown, accuracy: unknown, atIso: unknown): void => {
      const latitude = num(lat);
      const longitude = num(lon);
      if (latitude === null || longitude === null) return;
      if (readings.some((reading) => reading.label === label)) return;
      readings.push({
        label,
        lat: latitude,
        lon: longitude,
        accuracyMeters: num(accuracy),
        atIso: typeof atIso === "string" && atIso !== "" ? atIso : null,
      });
    };

    const kind = isIntegritySubjectKind(row.subject_kind) ? row.subject_kind : "visit";
    const subject = subjectRowFor(row);

    if (kind === "visit") {
      add(CASE_READING_LABELS.visitSaved, row.lat ?? subject?.lat, row.lon ?? subject?.lon, row.accuracy_meters ?? subject?.accuracy_meters, row.captured_at ?? subject?.captured_at);
      add(CASE_READING_LABELS.photograph, subject?.photo_lat, subject?.photo_lon, subject?.photo_accuracy_meters, subject?.photo_captured_at);
      const place = placeContextFor(row);
      add(CASE_READING_LABELS.placeOnList, place?.lat, place?.lon, place?.accuracy_meters, place?.captured_at);
      // The PLACE's photograph — the anchor the owner named, and a fourth reading only on the cases
      // that were actually judged against it. Every visit case could carry it, and it is withheld
      // from the other eight detectors on purpose: a point on the map is read as part of the
      // finding, and on a replay or a roster case this one had no part in it.
      //
      // On most places it lands on the same coordinate as the point kept for the place (1,312 of
      // 1,403 active validated places, production 13 Oct 2026, because the kept point was taken
      // FROM the photograph) — and the panel says so on one line rather than printing the same
      // numbers twice, which is what `groupReadings` is for.
      if (row.source === "visit_photo") {
        add(CASE_READING_LABELS.placePhotograph, place?.photo_lat, place?.photo_lon, place?.photo_accuracy_meters, place?.photo_captured_at);
      }
    } else {
      add(CASE_READING_LABELS.placeCaptured, row.lat ?? subject?.lat, row.lon ?? subject?.lon, row.accuracy_meters ?? subject?.accuracy_meters, row.captured_at ?? subject?.captured_at);
      add(CASE_READING_LABELS.pin, subject?.pin_lat, subject?.pin_lon, subject?.pin_accuracy_meters, subject?.captured_at);
      add(CASE_READING_LABELS.photograph, subject?.photo_lat, subject?.photo_lon, subject?.photo_accuracy_meters, subject?.photo_captured_at);
    }
    return readings;
  };

  const allCases: IntegrityCase[] = rows.map((row) => {
    const flags = (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag)) as IntegrityBoardFlag[];
    const repHrId = String(row.rep_hr_id ?? "");
    const customerId = row.customer_id ? String(row.customer_id) : null;
    const signals = (row.signals && typeof row.signals === "object" ? row.signals : {}) as Record<string, unknown>;
    return {
      id: String(row.id),
      // Every kind in the list by name. The fallback is `visit` only for a value the list does not
      // hold at all — a kind somebody added to the table without adding it here, which is the one
      // case the tests refuse.
      subjectKind: isIntegritySubjectKind(row.subject_kind) ? row.subject_kind : "visit",
      subjectId: String(row.subject_id),
      repHrId,
      repName: nameOf(people, repHrId) || repHrId,
      customerName: (customerId ? customerNames.get(customerId) : null) ?? "—",
      seatId: String(row.seat_id ?? ""),
      capturedAt: String(row.captured_at),
      // When the nightly pass FILED it, which is not when the capture happened — his filter bar
      // offers both days, so a case that answers `null` here is a case the filed-on group can
      // never match. Pinned, because a field nothing sets is a silently dead filter.
      filedAt: row.created_at ? String(row.created_at) : null,
      visitDate: row.visit_date ? String(row.visit_date) : null,
      strong: row.strong === true,
      // Every detector in the list by name. The fallback is `gps` only for a value the list does not
      // hold at all, which is a detector somebody added to the table without adding it here — the one
      // case the tests refuse.
      source: isIntegritySource(row.source) ? row.source : "gps",
      flags,
      reasons: flags.map((flag) => FLAG_LABELS[flag] ?? flag),
      signText: typeof signals.signText === "string" && signals.signText.trim() !== "" ? signals.signText : null,
      laterReading: laterReadingFor(row),
      settlement: settlementOf(row, people),
      // Positive for the same reason the gather above is: a place, a venue and a customer each have
      // no place to be far from, and only a visit's own row carries the figure.
      placeDistanceMeters: row.subject_kind === "visit"
        ? visitDistances.get(String(row.subject_id))?.distanceMeters ?? null
        : null,
      placeLocationFlag: row.subject_kind === "visit"
        ? visitDistances.get(String(row.subject_id))?.locationFlag ?? null
        : null,
      lat: row.lat === null || row.lat === undefined ? null : Number(row.lat),
      lon: row.lon === null || row.lon === undefined ? null : Number(row.lon),
      accuracyMeters: row.accuracy_meters === null || row.accuracy_meters === undefined ? null : Number(row.accuracy_meters),
      // The phone's own mock-location answer is position evidence, so it is the Super Admin's alone.
      deviceMocked: positions && typeof row.device_mocked === "boolean" ? row.device_mocked : null,
      signals,
      isTest: row.is_test === true,
      // 🔴 THE PATH, NEVER THE IMAGE. The bucket is private and the scoped photo route signs each
      // path for the reader who asks — which is also why the panel must be given only paths that
      // reader's own scope covers (one path it may not read refuses the whole batch).
      photoPath: typeof signals.photoPath === "string" && signals.photoPath !== ""
        ? signals.photoPath
        : (() => {
            const subject = subjectRowFor(row);
            return typeof subject?.photo_path === "string" && subject.photo_path !== "" ? subject.photo_path : null;
          })(),
      readings: readingsFor(row),
      nearbyVisits: row.subject_kind === "visit" ? [] : customerVisitPoints.get(customerId ?? "") ?? [],
      companionNames: (Array.isArray(signals.offDutyCompanionHrIds) ? signals.offDutyCompanionHrIds : [])
        .map((entry) => String(entry ?? ""))
        .filter(Boolean)
        .map((hrId) => nameOf(people, hrId) || hrId),
      replayByName: (() => {
        const replay = signals.replay && typeof signals.replay === "object" ? (signals.replay as Record<string, unknown>) : {};
        // The rep's own earlier reading is not somebody else, and saying "used before by Nada Saied"
        // of Nada Saied's own fix would read as an accusation about two people.
        if (replay.sameRep === true) return null;
        const hrId = String(replay.byRepHrId ?? "");
        return hrId === "" ? null : nameOf(people, hrId) || hrId;
      })(),
      subjectLabel: (() => {
        const place = placeContextFor(row);
        const label = place?.label ?? place?.name;
        return typeof label === "string" && label.trim() !== "" ? label : null;
      })(),
      repLine: seatFacts(String(row.seat_id ?? "")).line,
      repArea: seatFacts(String(row.seat_id ?? "")).area,
      repRegion: seatFacts(String(row.seat_id ?? "")).region,
      customerList: (customerId ? customerLists.get(customerId) : null) ?? null,
      customerSpeciality: (customerId ? customerSpecialities.get(customerId) : null) ?? null,
      brickName: (() => {
        const place = placeContextFor(row);
        return typeof place?.brick_name === "string" && place.brick_name !== "" ? place.brick_name : null;
      })(),
      brickDistanceKm: num(placeContextFor(row)?.brick_distance_km),
      // The customer's trail and the place's trail are one story to the reader: what happened to this
      // name, oldest first. Nothing is collapsed — a line repeated on both keys is one row read twice
      // and is dropped, but two real events at the same second are two lines.
      history: (() => {
        const fromCustomer = customerId ? historyByCustomer.get(customerId) ?? [] : [];
        const subjectKey = row.subject_kind === "visit"
          ? (visitEvidence.get(String(row.subject_id))?.place_id ? String(visitEvidence.get(String(row.subject_id))?.place_id) : null)
          : row.subject_kind === "place"
            ? String(row.subject_id)
            : null;
        const fromPlace = subjectKey ? historyByPlace.get(subjectKey) ?? [] : [];
        const seen = new Set<string>();
        return [...fromCustomer, ...fromPlace]
          .filter((event) => {
            const key = `${event.atIso}|${event.what}|${event.byName ?? ""}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort((left, right) => left.atIso.localeCompare(right.atIso));
      })(),
    };
  });

  // A flag a later reading no longer supports leaves the findings, and nothing else happens to it: it
  // is not deleted, not hidden, and not settled on anybody's behalf. Whether to act on one is the
  // owner's decision, exactly as it was before — he now gets to make it knowing the sign was read
  // again and what it said the second time.
  //
  // And a case the Super Admin has settled leaves them too, for a different reason: he has looked.
  // 🔴 WITHDRAWN WINS OVER SETTLED, deliberately. Whether a later reading still supports the flag is
  // a fact about the EVIDENCE; settling is a decision about the case. The withdrawn section's claim —
  // "each of these was read again, to a verdict that does not carry the flag" — has to stay true of
  // every row in it, so a withdrawn case that also carries a settlement is listed there with the two
  // readings, not moved out of the one section that explains why it is not a finding.
  // 🔴 READ `withdrawsFlag`, NEVER `!supportsFlag`. A reading that could not read the sign supports
  // nothing and answers nothing: it must leave the case standing, with its settle button. Reading
  // the negation instead withdrew مستشفى المنشاوى العام — a strong case — because one night's pass
  // failed on a sign it had read before, and the retry backlog guarantees more of them.
  const standing = allCases.filter((entry) => entry.laterReading === null || !entry.laterReading.withdrawsFlag);
  const withdrawn = allCases.filter((entry) => entry.laterReading !== null && entry.laterReading.withdrawsFlag);
  const cases = standing.filter((entry) => entry.settlement === null);
  const settled = standing.filter((entry) => entry.settlement !== null);

  const perRep = new Map<string, { repHrId: string; repName: string; cases: number; strongCases: number }>();
  for (const entry of cases) {
    const current = perRep.get(entry.repHrId) ?? { repHrId: entry.repHrId, repName: entry.repName, cases: 0, strongCases: 0 };
    current.cases += 1;
    if (entry.strong) current.strongCases += 1;
    perRep.set(entry.repHrId, current);
  }

  return {
    cases,
    withdrawn,
    // Most recently settled first: the last decision he took is the one he is most likely to be
    // coming back to.
    settled: [...settled].sort((left, right) => String(right.settlement?.at ?? "").localeCompare(String(left.settlement?.at ?? ""))),
    strongCount: cases.filter((entry) => entry.strong).length,
    byRep: [...perRep.values()].sort((left, right) => right.strongCases - left.strongCases || right.cases - left.cases),
    // Every detector in the list, so adding one can never leave its cases counted under another's
    // name — the defect that printed five signboard cases as Position until 2026-10-09.
    bySource: INTEGRITY_SOURCES.flatMap((source) => {
      const count = cases.filter((entry) => entry.source === source).length;
      return count === 0 ? [] : [{ source, label: integritySourceLabel(source), cases: count }];
    }),
    behaviour: behaviourRead.cases.map((entry) => ({ ...entry, repName: nameOf(people, entry.repHrId) || entry.repHrId })),
    behaviourNotChecked: behaviourRead.notChecked,
    capped,
  };
}

/**
 * Settle one case: the Super Admin has looked at it and it needs nothing further.
 *
 * 🔴 IT IS AN UPDATE OF FOUR COLUMNS AND NOTHING ELSE. The row, its flags, its signals and its
 * evidence are untouched — settling is a note on the record, never a deletion and never a rewrite of
 * what the detector found. There is no notification: nobody is told they were flagged (Golden Rule
 * #1), so nobody can be told a flag about them was closed either.
 *
 * 🔴 AND IT STAMPS THE FLAGS IT WAS SETTLED ON, read from the row inside this call rather than sent
 * by the browser. A client-supplied list would let a settlement claim to cover flags the row does not
 * carry — which is exactly the state that makes a case stay closed through a new finding. Read here,
 * so the only thing that can ever be stamped is what the row said at the moment he pressed it.
 *
 * The note is REQUIRED. A settled case with no reason is indistinguishable from one settled by
 * accident, and this table's whole point is being able to come back to it months later.
 */
export async function settleIntegrityCase(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ caseId: string; settled: true }> {
  // 🔴 A 404, NEVER A 403 — the same rule the board itself is refused by. A message reading "only the
  // Super Admin settles these" tells whoever asked that the board exists, that cases can be closed on
  // it, and who closes them. Nothing on this table ever explains itself to someone who is not its
  // audience. Pinned by `tests/phoenix-crm-blind-half.test.ts` §6.
  if (!canSettleIntegrityCases(viewer)) throw notFoundError("Not found.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.caseId)) throw validationError("Choose the case to settle.");
  const note = cleanText(body.note, INTEGRITY_NOTE_LIMIT);
  if (!note) throw validationError(INTEGRITY_NOTE_REQUIRED);
  const caseId = String(body.caseId).toLowerCase();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("phoenix_crm_location_integrity")
    .select("id, flags")
    .eq("id", caseId)
    .maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) throw notFoundError("This case is no longer there. Reload the page.");

  const flagsNow = (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag));
  const updated = await supabase
    .from("phoenix_crm_location_integrity")
    .update({
      settled_at: new Date().toISOString(),
      settled_by: viewer.hrId.toUpperCase(),
      settled_note: note,
      settled_flags: flagsNow,
    })
    .eq("id", caseId);
  throwIfError(updated.error);
  return { caseId, settled: true };
}

/**
 * Put a settled case back among the findings — he has changed his mind, or wants another look.
 *
 * All four columns go back to null together, because the table's CHECK allows nothing else: a
 * settlement exists whole or not at all. No note is required to reopen one. Closing a case about a
 * named person is the decision that needs a reason on the record; deciding to look again is not, and
 * demanding one would be a reason not to look.
 */
export async function reopenIntegrityCase(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ caseId: string; settled: false }> {
  // A 404 for the same reason as settling: the refusal says nothing about what was asked for.
  if (!canSettleIntegrityCases(viewer)) throw notFoundError("Not found.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.caseId)) throw validationError("Choose the case to reopen.");
  const caseId = String(body.caseId).toLowerCase();

  const { error } = await getSupabaseAdmin()
    .from("phoenix_crm_location_integrity")
    .update({ settled_at: null, settled_by: null, settled_note: null, settled_flags: null })
    .eq("id", caseId);
  throwIfError(error);
  return { caseId, settled: false };
}

/**
 * The capture-level integrity cases for one working week, for the weekly fraud scan.
 *
 * Lives HERE, beside `loadIntegrityBoard`, on purpose: this file is the ONLY reader of
 * `phoenix_crm_location_integrity`, and a second query anywhere else would be the first step towards
 * the rep-facing bundle importing it. The scan calls this, never the table directly.
 *
 * `includeGps` is the tier, not a convenience: the position (GPS) cases are the Super Admin's alone
 * (owner, 2026-10-02), so the SFE's copy asks with `includeGps: false` and a GPS case never leaves
 * the database for it — exactly as the board's own query narrows for an SFE viewer.
 *
 * 🔴 PLACE CASES ARE IN IT, AND WERE WRONGLY EXCLUDED UNTIL 2026-10-12. The query carried
 * `.eq("subject_kind", "visit")` on the stated ground that "a PLACE validation case has no visit day
 * to fall in the window" — which is simply false: both place filers write `visit_date`
 * (`server/location-integrity.ts`, `filePlaceSignboardFlag` and the capture-trust filer). So the
 * signboard and capture-trust detectors, which file ONLY against places, were invisible to the weekly
 * scan for its whole life: every Thursday reported a week with no signboard cases in it, including the
 * weeks that had them. The window is still a range on `visit_date`, and a row without one is still out
 * of it — but by not matching the week, not by its subject.
 *
 * Behaviour months are deliberately absent — they are a month's shape, recomputed nightly, not a
 * capture in a week.
 *
 * 🔴 A SETTLED CASE IS NOT IN THE SCAN EITHER. Settling has to mean the same thing on every surface
 * that reads this table, or it means nothing: a case he closed on the board would arrive in Saturday's
 * scan as a fresh finding and he would close it again. The test is the board's own — the stored flags
 * must still equal the row's — so a case that was settled and has since been flagged again comes back
 * here too, which is the point.
 */
export async function loadIntegrityCasesForWindow(options: {
  fromIso: string;
  toIso: string;
  includeGps: boolean;
}): Promise<FraudScanCase[]> {
  // Paged to the last case (keyset on the id: the detectors write while the scan reads). A fixed page of 200
  // counted only the newest 200 of a week that held 383 on production, and the scan sends counts.
  const data = await fetchAllRowsKeyset<Row>(
    () => {
      let query = getSupabaseAdmin()
        .from("phoenix_crm_location_integrity")
        .select("id, subject_kind, rep_hr_id, source, flags, strong, settled_at, settled_by, settled_note, settled_flags")
        .eq("is_test", false)
        .gte("visit_date", options.fromIso)
        .lte("visit_date", options.toIso);
      // The position cases are the Super Admin's alone: the SFE copy asks only for the detectors on the
      // allow-list, so a case a recipient may not see is never read for him — and a detector added later
      // is kept out of his copy by the same rule rather than by `photo` happening to be the only other.
      if (!options.includeGps) query = query.in("source", SFE_SOURCES);
      return query;
    },
    { cursorColumn: "id", cursorOf: (entry) => (entry.id === null || entry.id === undefined ? null : String(entry.id)) },
  );
  // A case the Super Admin has already settled is not a finding for this week. The comparison is
  // done HERE rather than in the query because the test is `settled_flags = flags`, a column against
  // a column, which PostgREST cannot ask — and asking only for `settled_at is null` would wrongly
  // drop a settled case the detectors have since flagged again.
  //
  // `isSettledIntegrityRow` and not `settlementOf(row, new Map())`: this reader needs only the
  // yes/no, and that empty Map existed purely to satisfy a name lookup whose answer nobody read.
  const rows = data.filter((row) => !isSettledIntegrityRow(row));
  if (rows.length === 0) return [];

  const people = await loadPeopleNames([...new Set(rows.map((row) => String(row.rep_hr_id ?? "")).filter(Boolean))]);
  return rows.map((row) => {
    const flags = (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag)) as IntegrityBoardFlag[];
    const repHrId = String(row.rep_hr_id ?? "");
    // 🔴 THE DETECTOR BY NAME, AND THE TIER STAMPED FROM THE ONE ALLOW-LIST. This read collapsed
    // every source that was not `photo` into `gps` until 2026-10-12 — the same defect that printed
    // five signboard cases as **Position** on the board in October, repeated in the scan. And the
    // collapse was load-bearing in the wrong direction: `sfeVisibleCases` narrowed by SUBTRACTION
    // (`source !== "gps"`), so widening the source here without stamping the tier would have leaked
    // signboard and capture-trust evidence into the SFE Manager's copy — against the owner's
    // 2026-10-09 decision that those stay the Super Admin's.
    //
    // `SFE_SOURCES` is that decision, and it is read HERE so the scan's two tiers and the board's own
    // query cannot drift: one allow-list, one meaning, whoever asks.
    const source = isIntegritySource(row.source) ? row.source : "gps";
    return {
      repHrId,
      repName: nameOf(people, repHrId) || repHrId,
      source,
      sfeVisible: SFE_SOURCES.includes(source),
      strong: row.strong === true,
      reasons: flags.map((flag) => FLAG_LABELS[flag] ?? flag),
    };
  });
}

/**
 * Settle SEVERAL cases with one reason — the owner's second request of 2026-10-13.
 *
 * 🔴 IT IS THE LAST FUNCTION IN THIS FILE DELIBERATELY, AND IT IS NOT CALLED
 * `settleIntegrityCases`. `tests/phoenix-crm-integrity-settle.test.ts` slices this file from
 * `settleIntegrityCase` to `reopenIntegrityCase` to read the single settle in isolation, by
 * `indexOf` — so a name beginning `settleIntegrityCase` would move that slice onto the wrong
 * function and every assertion in it would then be read against this one.
 *
 * 🔴 ONE `.update()` PER ROW, AND THAT IS THE WHOLE REASON THIS IS NOT A SINGLE STATEMENT OVER AN
 * `.in()`. `settled_flags` is THAT ROW'S OWN FLAGS: it is what reopens the case by itself when a
 * detector files a different finding on the same subject. A single update would stamp one case's
 * flags onto every other case in the batch, which is precisely the state that holds a case closed
 * through a genuinely different finding — the defect a set comparison was written to catch.
 * `flagsNow` is read from the ROW, never from the request.
 *
 * 🔴 A FAILURE ON ONE ROW NEVER STOPS THE OTHERS, and each one comes back named. Settling forty
 * cases and being told only "it failed" is how nobody settles anything again.
 *
 * A note is still REQUIRED (owner, 2026-10-13, when the bulk settle was put to him), and the board
 * offers ready-made reasons rather than letting it through empty. Nothing is deleted and nobody is
 * notified — no rep is ever told a flag was filed, so none can be told one was closed.
 */
export async function settleManyIntegrityCases(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ settled: string[]; failed: { caseId: string; message: string }[] }> {
  // A 404, never a 403 — the same rule the board and the single settle are refused by. A message
  // reading "only the Super Admin settles these" tells whoever asked that the board exists.
  if (!canSettleIntegrityCases(viewer)) throw notFoundError("Not found.");
  const body = (raw && typeof raw === "object" ? raw : {}) as { caseIds?: unknown; note?: unknown };
  const note = cleanText(body.note, INTEGRITY_NOTE_LIMIT);
  if (!note) throw validationError(INTEGRITY_NOTE_REQUIRED);

  const asked = Array.isArray(body.caseIds) ? body.caseIds : [];
  // Every id is checked, and a malformed one is a refusal rather than a silently shorter batch: a
  // reader who ticked forty rows and was told thirty-nine were settled would never find the fortieth.
  const failed: { caseId: string; message: string }[] = [];
  const caseIds: string[] = [];
  for (const entry of asked) {
    const given = String(entry ?? "");
    if (!isUuid(given)) {
      failed.push({ caseId: given, message: "This case is not one of ours. Reload the page." });
      continue;
    }
    const caseId = given.toLowerCase();
    if (!caseIds.includes(caseId)) caseIds.push(caseId);
  }
  if (caseIds.length === 0) throw validationError("Choose the cases to settle.");
  if (caseIds.length > INTEGRITY_BULK_SETTLE_CAP) {
    throw validationError(`Settle at most ${INTEGRITY_BULK_SETTLE_CAP} cases at a time.`);
  }

  const supabase = getSupabaseAdmin();
  // Chunked for the same reason every `.in()` in this file is: an over-long one returns an empty set
  // with no error at all, and an empty set here would read as "every case has gone". The chunks are
  // read side by side and kept in their own order; a failed one still fails the whole request, as it
  // did when they were read one after another.
  const parts: string[][] = [];
  for (let index = 0; index < caseIds.length; index += 50) parts.push(caseIds.slice(index, index + 50));
  const pages = await mapWithConcurrency(parts, CHUNK_READS_AT_ONCE, async (part) => {
    const { data, error } = await supabase
      .from("phoenix_crm_location_integrity")
      .select("id, flags")
      .in("id", part);
    throwIfError(error);
    return (data ?? []) as Row[];
  });
  const rows: Row[] = pages.flat();
  const byId = new Map(rows.map((row) => [String(row.id ?? "").toLowerCase(), row]));

  const at = new Date().toISOString();
  const by = viewer.hrId.toUpperCase();
  // 🔴 STILL ONE `.update()` PER ROW — only no longer one AFTER another. Up to 200 updates used to run
  // in sequence while he waited on the button (Phoenix CRM performance audit, 2026-10-16); they now
  // run a few at a time. Each still stamps that row's own flags, and each answer is put back IN THE
  // ORDER HE TICKED THEM — results are placed by index — so `settled` and `failed` read exactly as
  // they did, and one row failing still stops none of the others.
  const outcomes = await mapWithConcurrency(caseIds, SETTLE_UPDATES_AT_ONCE, async (caseId): Promise<string | null> => {
    const row = byId.get(caseId);
    if (!row) return "This case is no longer there.";
    const flagsNow = (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag));
    const updated = await supabase
      .from("phoenix_crm_location_integrity")
      .update({ settled_at: at, settled_by: by, settled_note: note, settled_flags: flagsNow })
      .eq("id", caseId);
    return updated.error ? updated.error.message : null;
  });
  const settled: string[] = [];
  for (const [position, caseId] of caseIds.entries()) {
    const message = outcomes[position];
    if (message !== null) {
      failed.push({ caseId, message });
      continue;
    }
    settled.push(caseId);
  }
  return { settled, failed };
}

// ── The device evidence on a place check, for the board that judges it ──────────────────────────

/**
 * The device evidence on a set of places and polyclinics, newest case first.
 *
 * 🔴 IT LIVES IN THIS FILE BECAUSE THE EVIDENCE DOES. This module's header draws the line: a read that
 * selects `lat`, `lon`, `signals`, `device_mocked` or the labels belongs here, behind this file's own
 * audience check, so the rep-facing bundle can never reach it through a component that imported a
 * convenient helper somewhere else.
 *
 * 🔴 AND THE AUDIENCE IS `placeChecksSeatScope`, THE SAME PREDICATE THE FOUR SECTION READS USE — not a
 * second copy of who may open that board. It answers `null` for the Super Admin, this manager's own
 * seat ids for a district manager, and THROWS for anybody else; the seat ids are then applied to every
 * row, so a case filed on another district's place is dropped here, on the server, even if an id for
 * it somehow reached this call.
 *
 * 🔴 EVERYBODY THIS FUNCTION ADMITS READS THE DEVICE'S EVIDENCE TOO, SO THERE IS NO TIER IN IT: the Super
 * Admin, the district manager on his own team's board (owner, 2026-10-13: "system and device evidence
 * the dm can see") and — since 2026-10-19 — the SFE Manager (owner: "show the mock-location evidence to
 * the SFE Manager too", answering the one place this board still differed from the Super Admin's). The
 * audience is the seat scope above, which throws for anybody else, so a narrowing here would be a branch
 * nobody can reach. 🔴 THAT IS THIS PLACE ONLY: the integrity board and the visit report still narrow the
 * SFE Manager to `SFE_SOURCES` and leave `device_mocked` out of the select (`readsPositionCases`,
 * 2026-10-02), and they must — nothing about a place check's evidence reaches them.
 */
export async function loadPlaceCheckIntegrity(
  viewer: PhoenixCrmViewer,
  input: { placeIds: ReadonlyArray<string>; sharedPlaceIds: ReadonlyArray<string> },
): Promise<PlaceCheckIntegrityIndex> {
  const seats = placeChecksSeatScope(viewer);
  const decides = canDecideValidationReviews(viewer);
  const ids = [...new Set([...input.placeIds, ...input.sharedPlaceIds].filter((id) => isUuid(id)))];
  if (ids.length === 0) return {};

  const rows = await selectByIds<Row>(
    "phoenix_crm_location_integrity",
    "id, subject_kind, subject_id, seat_id, source, flags, strong, device_mocked, accuracy_meters, created_at, settled_at, settled_by, settled_note, settled_flags",
    "subject_id",
    ids,
  );
  const people = await loadPeopleNames(rows.map((row) => (typeof row.settled_by === "string" ? row.settled_by : null)));
  const allowed = seats === null ? null : new Set(seats);

  const index: PlaceCheckIntegrityIndex = {};
  for (const row of rows.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))) {
    const kind = isIntegritySubjectKind(row.subject_kind) ? row.subject_kind : null;
    // A visit case is about a day's movement, not about this place: the board judges places.
    if (kind !== "place" && kind !== "shared_place") continue;
    if (allowed && !allowed.has(String(row.seat_id ?? ""))) continue;
    const subjectId = typeof row.subject_id === "string" ? row.subject_id : null;
    if (!subjectId) continue;
    const flags = (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag));
    const source = (INTEGRITY_SOURCES as readonly string[]).includes(String(row.source)) ? (String(row.source) as IntegritySource) : "gps";
    const settlement = settlementOf(row, people);
    const noticedAt = formatPhoenixDateTime(String(row.created_at));
    const accuracy = typeof row.accuracy_meters === "number" ? row.accuracy_meters : null;
    const view: PlaceCheckIntegrityView = {
      caseId: String(row.id),
      // The phone's own answer, in words, and ONLY when it said yes: a null is the phone never
      // forwarding one, and "it did not say" is not evidence about anybody.
      deviceText: row.device_mocked === true ? "The phone reported a mock location" : null,
      noticedText: accuracy === null ? `Noticed ${noticedAt}` : `Noticed ${noticedAt} · the phone reported ${Math.round(accuracy)} m of accuracy`,
      reasons: flags.map((flag) => FLAG_LABELS[flag] ?? flag),
      // A manager still reads that the case is closed, and never who closed it (owner, 2026-10-13).
      settledText: settlement
        ? `${decides ? `Settled by ${settlement.byName}` : "Settled"} · ${formatPhoenixDateTime(settlement.at)}`
        : null,
      sourceLabel: integritySourceLabel(source),
      strong: row.strong === true,
    };
    (index[placeNoteSubjectKey(kind === "place" ? "place" : "shared_place", subjectId)] ??= []).push(view);
  }
  return index;
}

// ── The evidence a visit report carries, for the generator that reports on a rep's visits ───────

export type VisitReportCaseFacts = {
  /** "Position: …; Photo: …" — every detector's name and its reasons in words, newest case first. */
  detectorsText: string | null;
  /** "Strong" or "Not strong" once any case is filed on the visit; null when none is. */
  strengthText: string | null;
  /** The phone's own mock answer. Read ONLY for the Super Admin (`readsPositionCases`); always null otherwise. */
  deviceMocked: boolean | null;
  settledText: string | null;
};

export type VisitReportEvidence = {
  byVisit: Map<string, VisitReportCaseFacts>;
  /** `seatId|YYYY-MM` → the behaviour flags in words, for a month the pass judged and flagged. */
  behaviourByMonth: Map<string, string>;
};

/**
 * The integrity cases FILED ON A VISIT and the behaviour months of the rep's seats, for the Visit report
 * generator (owner, 2026-10-15).
 *
 * 🔴 IT LIVES IN THIS FILE FOR THE SAME REASON `loadPlaceCheckIntegrity` DOES: a read that selects the
 * flags, the settlement or `device_mocked` of this table belongs behind this file's audience check. The
 * audience is the board's (`canReadIntegrityBoard`) and the tiers are the board's — the SFE Manager asks
 * for `SFE_SOURCES` only, so a position case, mock-location included, is never QUERIED for him, and the
 * `device_mocked` column is not even in his select. A 404, never a 403, for anybody else.
 *
 * Only cases whose SUBJECT is the visit are read (position, visit-against-the-photograph, roster): a
 * case about the place or the customer is not a fact about this call. No coordinate and no signal
 * leaves this function — the report carries words.
 */
export async function loadVisitReportEvidence(
  viewer: PhoenixCrmViewer,
  input: { visitIds: ReadonlyArray<string>; seatIds: ReadonlyArray<string>; months: ReadonlyArray<string>; wantsBehaviour: boolean },
): Promise<VisitReportEvidence> {
  if (!canReadIntegrityBoard(viewer)) throw notFoundError("Not found.");
  const positions = readsPositionCases(viewer);
  const includeTest = viewer.isTestPersona;
  const evidence: VisitReportEvidence = { byVisit: new Map(), behaviourByMonth: new Map() };

  const visitIds = [...new Set(input.visitIds.filter((id) => isUuid(id)))];
  if (visitIds.length > 0) {
    const columns = `id, subject_id, source, flags, strong, created_at, settled_at, settled_by, settled_note, settled_flags${positions ? ", device_mocked" : ""}`;
    const rows = await selectByIds<Row>("phoenix_crm_location_integrity", columns, "subject_id", visitIds, (query) => {
      // A visit report is per VISIT, so it names the one kind it reports on — as a list, because the weekly
      // scan's own read must never be written as an equality on this column (tests/crm-integrity-signboard-cases).
      let tuned = query.in("subject_kind", ["visit"]);
      if (!includeTest) tuned = tuned.eq("is_test", false);
      if (!positions) tuned = tuned.in("source", SFE_SOURCES);
      return tuned;
    });
    const people = await loadPeopleNames(rows.map((row) => (typeof row.settled_by === "string" ? row.settled_by : null)));
    const grouped = new Map<string, Row[]>();
    for (const row of rows) {
      const subjectId = typeof row.subject_id === "string" ? row.subject_id : null;
      if (!subjectId) continue;
      // Belt and braces: the query already narrowed by source, and the answer is narrowed again, so a
      // later change to either cannot widen the SFE Manager's sight on its own.
      if (!positions && !SFE_SOURCES.includes(isIntegritySource(row.source) ? row.source : "gps")) continue;
      grouped.set(subjectId, [...(grouped.get(subjectId) ?? []), row]);
    }
    for (const [visitId, cases] of grouped) {
      cases.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
      const detectors = cases.map((row) => {
        const source = isIntegritySource(row.source) ? row.source : "gps";
        const reasons = (Array.isArray(row.flags) ? row.flags : []).map((flag) => FLAG_LABELS[String(flag)] ?? String(flag));
        return reasons.length > 0 ? `${integritySourceLabel(source)}: ${reasons.join("; ")}` : integritySourceLabel(source);
      });
      const settled = cases.map((row) => settlementOf(row, people)).find((entry): entry is IntegritySettlement => entry !== null);
      const mockAnswers = positions ? cases.map((row) => row.device_mocked).filter((answer): answer is boolean => typeof answer === "boolean") : [];
      evidence.byVisit.set(visitId, {
        detectorsText: detectors.join(" | "),
        deviceMocked: mockAnswers.length === 0 ? null : mockAnswers.some(Boolean),
        settledText: settled ? `Settled by ${settled.byName} · ${formatPhoenixDateTime(settled.at)} · ${settled.note}` : null,
        strengthText: cases.some((row) => row.strong === true) ? "Strong" : "Not strong",
      });
    }
  }

  const seatIds = [...new Set(input.seatIds)];
  const months = [...new Set(input.months)];
  if (input.wantsBehaviour && seatIds.length > 0 && months.length > 0) {
    const rows = await selectByIds<Row>("phoenix_crm_behaviour_integrity", "id, seat_id, month, flags, measured", "seat_id", seatIds, (query) => {
      let tuned = query.in("month", months);
      if (!includeTest) tuned = tuned.eq("is_test", false);
      return tuned;
    });
    for (const row of rows) {
      const flags = (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag));
      if (flags.length === 0) continue;
      const words = flags.map((flag) => PHOENIX_CRM_BEHAVIOUR_LABELS[flag as PhoenixCrmBehaviourFlag] ?? flag);
      evidence.behaviourByMonth.set(`${String(row.seat_id)}|${String(row.month)}`, words.join("; "));
    }
  }
  return evidence;
}
