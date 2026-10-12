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
 * 🔴 AND THE MOCK-LOCATION EVIDENCE IS THE SUPER ADMIN'S ALONE (owner, 2026-10-02). The position cases
 * (`source = 'gps'`) and the phone's own mock-location answer (`device_mocked`) are never read for the
 * SFE Manager — not filtered out of a screen, never QUERIED. The SFE keeps the photo cases and the
 * behaviour months, which judge a picture and a month's shape rather than where a phone said it was.
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

import { notFoundError, validationError } from "@/lib/http/api-errors";
import { PHOENIX_CRM_BEHAVIOUR_LABELS, type PhoenixCrmBehaviourFlag } from "@/lib/phoenix-crm/behaviour-integrity";
import { PHOENIX_CRM_PHOTO_LABELS, type PhoenixCrmPhotoFlag } from "@/lib/phoenix-crm/duplicate-photos";
import { cleanText } from "@/lib/phoenix-crm/entry-rules";
import type { FraudScanCase } from "@/lib/phoenix-crm/fraud-scan-rules";
import {
  INTEGRITY_NOTE_LIMIT,
  INTEGRITY_NOTE_REQUIRED,
  isSettledIntegrityRow,
  readIntegritySettlement,
  type IntegritySettlement,
} from "@/lib/phoenix-crm/integrity-settlement";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import {
  judgeLaterSignboardReading,
  PHOENIX_CRM_INTEGRITY_LABELS,
  readStoredSignboardVerdict,
  type IntegrityLaterReading,
  type PhoenixCrmIntegrityFlag,
  type StoredSignboardVerdict,
} from "@/lib/phoenix-crm/location-integrity";
import { type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

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
export const INTEGRITY_SOURCES = ["gps", "photo", "behaviour", "signboard", "capture_trust", "roster", "cadence", "coverage"] as const;

export type IntegritySource = (typeof INTEGRITY_SOURCES)[number];

function isIntegritySource(value: unknown): value is IntegritySource {
  return typeof value === "string" && (INTEGRITY_SOURCES as readonly string[]).includes(value);
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
 * ONE list, exported, and everything is derived from it — the type, the labels, the coercion, and the
 * positive test that decides whose id may be looked up as a visit. `tests/phoenix-crm-integrity-settle.test.ts`
 * reads it against the migration's own CHECK, because the column is text and the compiler cannot.
 */
export const INTEGRITY_SUBJECT_KINDS = ["visit", "place", "shared_place", "customer"] as const;

export type IntegritySubjectKind = (typeof INTEGRITY_SUBJECT_KINDS)[number];

function isIntegritySubjectKind(value: unknown): value is IntegritySubjectKind {
  return typeof value === "string" && (INTEGRITY_SUBJECT_KINDS as readonly string[]).includes(value);
}

/**
 * Each kind in the owner's own words, as the board prints it. Sentence case, because the page writes
 * it at the head of a line and lowercases it where it writes it mid-sentence.
 */
const SUBJECT_KIND_LABELS: Record<IntegritySubjectKind, string> = {
  visit: "A visit",
  place: "Validating a place",
  shared_place: "A shared venue",
  customer: "A customer",
};

export function integritySubjectKindLabel(kind: IntegritySubjectKind): string {
  return SUBJECT_KIND_LABELS[kind] ?? kind;
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
 * One page for the weekly scan's window — a Sat–Wed week, never the whole table.
 *
 * Left as a single page deliberately: a working week has never come near 200 capture cases (the board
 * carried 11 standing on 2026-10-12), and the scan has no channel to admit a truncation through — it
 * sends counts, and `summarizeFraudCases` has no `capped`. If a week ever reaches this, the honest fix
 * is to page it AND give the summary somewhere to say so, not to raise the number quietly.
 */
const WEEK_WINDOW_LIMIT = 200;

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
 * May this viewer SETTLE a case? The Super Admin alone — the same shape as every other decision in
 * Phoenix CRM (`canDecideValidationReviews`), and narrower than reading the board.
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
  const [people, customers] = await Promise.all([
    // Whoever SETTLED a case is loaded with the reps, because the board prints his name and never his
    // HR id — the owner's standing rule holds for the person who closed the case as much as for the
    // person it is about.
    loadPeopleNames([
      ...new Set(
        [
          ...rows.map((row) => String(row.rep_hr_id ?? "")),
          ...rows.map((row) => String(row.settled_by ?? "")),
          ...behaviourRead.repHrIds,
        ].filter(Boolean),
      ),
    ]),
    customerIds.length === 0
      ? Promise.resolve({ data: [] as Row[] })
      : supabase.from("phoenix_crm_customers").select("id, name").in("id", customerIds),
  ]);
  // The distance a visit was saved from its place already exists on the visit row, written at
  // capture. Read it rather than recompute it: recomputing would let this board and the
  // place-vs-actual report print two different numbers for one visit, and the report is the one
  // the DM and SFE already read.
  // 🔴 `=== "visit"`, NEVER `!== "place"`. The negative form meant "everything that is not a place is
  // a visit id", so the moment a third kind was filed its id went into this list and was looked up in
  // `phoenix_crm_visits` — a customer id asked of the visits table, which simply returns nothing and
  // leaves the case reading as a visit saved at its place. Only a visit has a distance from a place.
  const visitIds = [...new Set(rows.filter((row) => row.subject_kind === "visit").map((row) => String(row.subject_id)).filter(Boolean))];
  const visitDistances = new Map<string, { distanceMeters: number | null; locationFlag: string | null }>();
  // Chunked at 50: a PostgREST `.in()` carrying several hundred ids comes back `{ data: [] }` past
  // some URL length, and an empty set here would read as “every case is at its place”.
  for (let index = 0; index < visitIds.length; index += 50) {
    const { data: visitRows, error: visitError } = await supabase
      .from("phoenix_crm_visits")
      .select("id, distance_meters, location_flag")
      .in("id", visitIds.slice(index, index + 50));
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

  // What each flagged place's signboard reads NOW. The place row is the only record of that — the
  // nightly pass keeps a verdict there for every place, flagged or not — so a flag that a later
  // reading has taken the ground out from under can be told apart from one that still stands.
  // Chunked at 50 for the same reason the visits are.
  const signboardPlaceIds = [...new Set(rows.filter((row) => row.source === "signboard").map((row) => String(row.subject_id)).filter(Boolean))];
  const placeSignboards = new Map<string, StoredSignboardVerdict>();
  for (let index = 0; index < signboardPlaceIds.length; index += 50) {
    const { data: placeRows, error: placeError } = await supabase
      .from("phoenix_crm_places")
      .select("id, signboard_check")
      .in("id", signboardPlaceIds.slice(index, index + 50));
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

  const laterReadingFor = (row: Row): IntegrityLaterReading | null =>
    judgeLaterSignboardReading({
      source: String(row.source ?? ""),
      flags: (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag)),
      filedAt: row.created_at ? String(row.created_at) : null,
      stored: placeSignboards.get(String(row.subject_id)) ?? null,
    });

  const customerNames = new Map<string, string>();
  for (const row of ((customers as { data?: Row[] }).data ?? []) as Row[]) customerNames.set(String(row.id), String(row.name ?? ""));

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
  let query = getSupabaseAdmin()
    .from("phoenix_crm_location_integrity")
    .select("subject_kind, rep_hr_id, source, flags, strong, settled_at, settled_by, settled_note, settled_flags")
    .eq("is_test", false)
    .gte("visit_date", options.fromIso)
    .lte("visit_date", options.toIso)
    .order("captured_at", { ascending: false })
    .limit(WEEK_WINDOW_LIMIT);
  // The position cases are the Super Admin's alone: the SFE copy asks only for the detectors on the
  // allow-list, so a case a recipient may not see is never read for him — and a detector added later
  // is kept out of his copy by the same rule rather than by `photo` happening to be the only other.
  if (!options.includeGps) query = query.in("source", SFE_SOURCES);

  const { data, error } = await query;
  throwIfError(error);
  // A case the Super Admin has already settled is not a finding for this week. The comparison is
  // done HERE rather than in the query because the test is `settled_flags = flags`, a column against
  // a column, which PostgREST cannot ask — and asking only for `settled_at is null` would wrongly
  // drop a settled case the detectors have since flagged again.
  //
  // `isSettledIntegrityRow` and not `settlementOf(row, new Map())`: this reader needs only the
  // yes/no, and that empty Map existed purely to satisfy a name lookup whose answer nobody read.
  const rows = ((data ?? []) as Row[]).filter((row) => !isSettledIntegrityRow(row));
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
