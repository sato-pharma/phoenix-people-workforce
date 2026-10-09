/**
 * Phoenix CRM — the integrity board, for the Super Admin and the SFE Manager.
 *
 * THREE DETECTORS FILE HERE, and from 2026-09-27 the row says which. The position checks judge where
 * the phone said it was; the photo sweep judges whether the picture is a new picture; the signboard
 * pass judges whether the sign on the building names the customer it was validated for. They share
 * this table and nothing else — a capture can carry one verdict from each, which is why `source` is
 * part of the unique key rather than a label bolted on afterwards.
 *
 * 🔴 AND THE READER MUST KNOW ALL THREE BY NAME. `signboard` began filing on 2026-10-08 and was not
 * added to `IntegritySource`, so for a day its cases printed as **Position** on the owner's board and
 * the detector tally hid them — five real cases about five named people, labelled as the one kind of
 * evidence they are not. A fourth detector is a change to this file, never only to the writer's.
 *
 * This is the ONLY reader of `phoenix_crm_location_integrity`. It lives behind `/admin`, which no rep
 * can open at all, so the evidence cannot leak into the field app through a role mistake in a tab or
 * a component: the rep-facing bundle does not import this file and has no route that reaches it.
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

import { notFoundError } from "@/lib/http/api-errors";
import { PHOENIX_CRM_BEHAVIOUR_LABELS, type PhoenixCrmBehaviourFlag } from "@/lib/phoenix-crm/behaviour-integrity";
import { PHOENIX_CRM_PHOTO_LABELS, type PhoenixCrmPhotoFlag } from "@/lib/phoenix-crm/duplicate-photos";
import type { FraudScanCase } from "@/lib/phoenix-crm/fraud-scan-rules";
import {
  judgeLaterSignboardReading,
  PHOENIX_CRM_INTEGRITY_LABELS,
  type IntegrityLaterReading,
  type PhoenixCrmIntegrityFlag,
  type StoredSignboardVerdict,
} from "@/lib/phoenix-crm/location-integrity";
import { type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * Which detector filed a case. The board is the one place they are read together.
 *
 * 🔴 EVERY DETECTOR THAT WRITES TO THE TABLE BELONGS IN THIS UNION, and `signboard` proves why. It
 * started filing cases on 2026-10-08 and was never added here, so the five it had filed by the 9th
 * fell through `row.source === "photo" || "behaviour" ? … : "gps"` and printed on the owner's board
 * as **Position** — mock-location evidence, which is the one thing they are not. The detector
 * breakdown hid it too: with signboard folded into gps there was only one source in the tally, and
 * the callout that names them renders only when there are two or more.
 */
export type IntegritySource = "gps" | "photo" | "behaviour" | "signboard";

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
};


export function integritySourceLabel(source: IntegritySource): string {
  return SOURCE_LABELS[source] ?? source;
}

export type IntegrityCase = {
  id: string;
  subjectKind: "visit" | "place";
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
  signals: Record<string, unknown>;
  isTest: boolean;
};

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
};

const BOARD_LIMIT = 200;

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
 * The months the behaviour pass judged, strongest and most recent first.
 *
 * Read separately from the captures because it IS separate: a behaviour verdict is about a rep and a
 * month, not about a visit, and it is recomputed whole every night as more of the month lands.
 */
async function loadBehaviourCases(): Promise<{ cases: BehaviourCase[]; notChecked: number; repHrIds: string[] }> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_behaviour_integrity")
    .select("id, month, rep_hr_id, seat_id, visits, measured, flags, strong, signals")
    .eq("is_test", false)
    .order("strong", { ascending: false })
    .order("month", { ascending: false })
    .limit(BOARD_LIMIT);
  throwIfError(error);
  const rows = (data ?? []) as Row[];
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
  };
}

/**
 * Load the board. Checked here as well as on the page, because this is the one place in Phoenix CRM
 * where reading the data IS the sensitive act.
 */
export async function loadIntegrityBoard(viewer: PhoenixCrmViewer, options: { includeTest?: boolean } = {}): Promise<IntegrityBoard> {
  if (!canReadIntegrityBoard(viewer)) throw notFoundError("Not found.");

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("phoenix_crm_location_integrity")
    .select("id, subject_kind, subject_id, source, seat_id, rep_hr_id, customer_id, captured_at, created_at, visit_date, lat, lon, accuracy_meters, device_mocked, flags, strong, signals, is_test")
    .order("strong", { ascending: false })
    .order("captured_at", { ascending: false })
    .limit(BOARD_LIMIT);
  // Test captures stay the Super Admin's, as they are everywhere else in the module: the SFE reads
  // the real field, never the Super Admin's own trial entries.
  if (options.includeTest !== true || !viewer.isSuperAdmin) query = query.eq("is_test", false);
  // The position cases are the Super Admin's alone (owner, 2026-10-02): for anyone else the query asks
  // only for the detectors on the allow-list, so a case he may not read never leaves the database.
  const positions = readsPositionCases(viewer);
  if (!positions) query = query.in("source", SFE_SOURCES);

  const [{ data, error }, behaviourRead] = await Promise.all([query, loadBehaviourCases()]);
  throwIfError(error);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0 && behaviourRead.cases.length === 0) {
    return { cases: [], withdrawn: [], strongCount: 0, byRep: [], bySource: [], behaviour: [], behaviourNotChecked: behaviourRead.notChecked };
  }

  const customerIds = [...new Set(rows.map((row) => (row.customer_id ? String(row.customer_id) : null)).filter((id): id is string => Boolean(id)))];
  const [people, customers] = await Promise.all([
    loadPeopleNames([...new Set([...rows.map((row) => String(row.rep_hr_id ?? "")), ...behaviourRead.repHrIds].filter(Boolean))]),
    customerIds.length === 0
      ? Promise.resolve({ data: [] as Row[] })
      : supabase.from("phoenix_crm_customers").select("id, name").in("id", customerIds),
  ]);
  // The distance a visit was saved from its place already exists on the visit row, written at
  // capture. Read it rather than recompute it: recomputing would let this board and the
  // place-vs-actual report print two different numbers for one visit, and the report is the one
  // the DM and SFE already read.
  const visitIds = [...new Set(rows.filter((row) => row.subject_kind !== "place").map((row) => String(row.subject_id)).filter(Boolean))];
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
      const check = place.signboard_check;
      if (!check || typeof check !== "object") continue;
      const stored = check as Record<string, unknown>;
      if (typeof stored.verdict !== "string") continue;
      placeSignboards.set(String(place.id), {
        verdict: stored.verdict,
        reason: typeof stored.reason === "string" ? stored.reason : null,
        checkedAt: typeof stored.checkedAt === "string" ? stored.checkedAt : null,
        signText: typeof stored.signText === "string" && stored.signText.trim() !== "" ? stored.signText : null,
      });
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
      subjectKind: row.subject_kind === "place" ? "place" : "visit",
      subjectId: String(row.subject_id),
      repHrId,
      repName: nameOf(people, repHrId) || repHrId,
      customerName: (customerId ? customerNames.get(customerId) : null) ?? "—",
      seatId: String(row.seat_id ?? ""),
      capturedAt: String(row.captured_at),
      visitDate: row.visit_date ? String(row.visit_date) : null,
      strong: row.strong === true,
      source: row.source === "photo" || row.source === "behaviour" || row.source === "signboard" ? row.source : "gps",
      flags,
      reasons: flags.map((flag) => FLAG_LABELS[flag] ?? flag),
      signText: typeof signals.signText === "string" && signals.signText.trim() !== "" ? signals.signText : null,
      laterReading: laterReadingFor(row),
      placeDistanceMeters: row.subject_kind === "place"
        ? null
        : visitDistances.get(String(row.subject_id))?.distanceMeters ?? null,
      placeLocationFlag: row.subject_kind === "place"
        ? null
        : visitDistances.get(String(row.subject_id))?.locationFlag ?? null,
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
  const cases = allCases.filter((entry) => entry.laterReading === null || entry.laterReading.supportsFlag);
  const withdrawn = allCases.filter((entry) => entry.laterReading !== null && !entry.laterReading.supportsFlag);

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
    strongCount: cases.filter((entry) => entry.strong).length,
    byRep: [...perRep.values()].sort((left, right) => right.strongCases - left.strongCases || right.cases - left.cases),
    // Every detector in the union, so adding one can never leave its cases counted under another's
    // name — the defect that printed five signboard cases as Position until 2026-10-09.
    bySource: (["gps", "photo", "behaviour", "signboard"] as const).flatMap((source) => {
      const count = cases.filter((entry) => entry.source === source).length;
      return count === 0 ? [] : [{ source, label: integritySourceLabel(source), cases: count }];
    }),
    behaviour: behaviourRead.cases.map((entry) => ({ ...entry, repName: nameOf(people, entry.repHrId) || entry.repHrId })),
    behaviourNotChecked: behaviourRead.notChecked,
  };
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
 * Visit subjects only: the window is a Sat–Wed range on `visit_date`, and a PLACE validation case has
 * no visit day to fall in it. Behaviour months are deliberately absent — they are a month's shape,
 * recomputed nightly, not a capture in a week.
 */
export async function loadIntegrityCasesForWindow(options: {
  fromIso: string;
  toIso: string;
  includeGps: boolean;
}): Promise<FraudScanCase[]> {
  let query = getSupabaseAdmin()
    .from("phoenix_crm_location_integrity")
    .select("subject_kind, rep_hr_id, source, flags, strong")
    .eq("is_test", false)
    .eq("subject_kind", "visit")
    .gte("visit_date", options.fromIso)
    .lte("visit_date", options.toIso)
    .order("captured_at", { ascending: false })
    .limit(BOARD_LIMIT);
  // The position cases are the Super Admin's alone: the SFE copy asks only for the detectors on the
  // allow-list, so a case a recipient may not see is never read for him — and a detector added later
  // is kept out of his copy by the same rule rather than by `photo` happening to be the only other.
  if (!options.includeGps) query = query.in("source", SFE_SOURCES);

  const { data, error } = await query;
  throwIfError(error);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];

  const people = await loadPeopleNames([...new Set(rows.map((row) => String(row.rep_hr_id ?? "")).filter(Boolean))]);
  return rows.map((row) => {
    const flags = (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag)) as IntegrityBoardFlag[];
    const repHrId = String(row.rep_hr_id ?? "");
    return {
      repHrId,
      repName: nameOf(people, repHrId) || repHrId,
      source: row.source === "photo" ? "photo" : "gps",
      strong: row.strong === true,
      reasons: flags.map((flag) => FLAG_LABELS[flag] ?? flag),
    };
  });
}
