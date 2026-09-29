/**
 * Phoenix CRM — the integrity board, for the Super Admin and the SFE Manager.
 *
 * TWO DETECTORS FILE HERE, and from 2026-09-27 the row says which. The position checks judge where
 * the phone said it was; the photo sweep judges whether the picture is a new picture. They share
 * this table and nothing else — a capture can carry one verdict from each, which is why `source` is
 * part of the unique key rather than a label bolted on afterwards.
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
import { PHOENIX_CRM_INTEGRITY_LABELS, type PhoenixCrmIntegrityFlag } from "@/lib/phoenix-crm/location-integrity";
import { type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** Which detector filed a case. The board is the one place the two are read together. */
export type IntegritySource = "gps" | "photo" | "behaviour";

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
  cases: IntegrityCase[];
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
    .select("id, subject_kind, subject_id, source, seat_id, rep_hr_id, customer_id, captured_at, visit_date, lat, lon, accuracy_meters, device_mocked, flags, strong, signals, is_test")
    .order("strong", { ascending: false })
    .order("captured_at", { ascending: false })
    .limit(BOARD_LIMIT);
  // Test captures stay the Super Admin's, as they are everywhere else in the module: the SFE reads
  // the real field, never the Super Admin's own trial entries.
  if (options.includeTest !== true || !viewer.isSuperAdmin) query = query.eq("is_test", false);

  const [{ data, error }, behaviourRead] = await Promise.all([query, loadBehaviourCases()]);
  throwIfError(error);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0 && behaviourRead.cases.length === 0) {
    return { cases: [], strongCount: 0, byRep: [], bySource: [], behaviour: [], behaviourNotChecked: behaviourRead.notChecked };
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

  const customerNames = new Map<string, string>();
  for (const row of ((customers as { data?: Row[] }).data ?? []) as Row[]) customerNames.set(String(row.id), String(row.name ?? ""));

  const cases: IntegrityCase[] = rows.map((row) => {
    const flags = (Array.isArray(row.flags) ? row.flags : []).map((flag) => String(flag)) as IntegrityBoardFlag[];
    const repHrId = String(row.rep_hr_id ?? "");
    const customerId = row.customer_id ? String(row.customer_id) : null;
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
      source: row.source === "photo" || row.source === "behaviour" ? row.source : "gps",
      flags,
      reasons: flags.map((flag) => FLAG_LABELS[flag] ?? flag),
      placeDistanceMeters: row.subject_kind === "place"
        ? null
        : visitDistances.get(String(row.subject_id))?.distanceMeters ?? null,
      placeLocationFlag: row.subject_kind === "place"
        ? null
        : visitDistances.get(String(row.subject_id))?.locationFlag ?? null,
      lat: row.lat === null || row.lat === undefined ? null : Number(row.lat),
      lon: row.lon === null || row.lon === undefined ? null : Number(row.lon),
      accuracyMeters: row.accuracy_meters === null || row.accuracy_meters === undefined ? null : Number(row.accuracy_meters),
      deviceMocked: typeof row.device_mocked === "boolean" ? row.device_mocked : null,
      signals: (row.signals && typeof row.signals === "object" ? row.signals : {}) as Record<string, unknown>,
      isTest: row.is_test === true,
    };
  });

  const perRep = new Map<string, { repHrId: string; repName: string; cases: number; strongCases: number }>();
  for (const entry of cases) {
    const current = perRep.get(entry.repHrId) ?? { repHrId: entry.repHrId, repName: entry.repName, cases: 0, strongCases: 0 };
    current.cases += 1;
    if (entry.strong) current.strongCases += 1;
    perRep.set(entry.repHrId, current);
  }

  return {
    cases,
    strongCount: cases.filter((entry) => entry.strong).length,
    byRep: [...perRep.values()].sort((left, right) => right.strongCases - left.strongCases || right.cases - left.cases),
    bySource: (["gps", "photo", "behaviour"] as const).flatMap((source) => {
      const count = cases.filter((entry) => entry.source === source).length;
      return count === 0 ? [] : [{ source, label: integritySourceLabel(source), cases: count }];
    }),
    behaviour: behaviourRead.cases.map((entry) => ({ ...entry, repName: nameOf(people, entry.repHrId) || entry.repHrId })),
    behaviourNotChecked: behaviourRead.notChecked,
  };
}
