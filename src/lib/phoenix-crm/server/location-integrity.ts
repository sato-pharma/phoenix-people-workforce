/**
 * Phoenix CRM — running the location-integrity detectors against what is already on record.
 *
 * The detectors themselves are pure and live in `@/lib/phoenix-crm/location-integrity`; this file is
 * only their I/O: it fetches the history they compare against and files the verdict.
 *
 * TWO RULES GOVERN EVERYTHING HERE, AND BOTH ARE THE OWNER'S (2026-09-25).
 *
 *   1. THE REP MUST NOT KNOW. Nothing in this file can change what a rep sees, reads or waits for.
 *      `judgeCapture` is called AFTER the save has already succeeded, it returns void, and it
 *      swallows every error it can produce. A spoofed visit and an honest one come back identical.
 *
 *   2. IT MUST NEVER COST A REP HIS VISIT. A fraud check that throws would turn a working save into
 *      a failure for a rep standing in front of a doctor — which is a far worse outcome than a
 *      missed catch. Every path here is wrapped; the worst case is one unwritten evidence row, and
 *      the capture it would have described is still on file to be re-judged later.
 */

import { checkLocationIntegrity, REPLAY_DECIMALS, type PhoenixCrmPriorFix } from "@/lib/phoenix-crm/location-integrity";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * How far back the rep's own history is read. Wide enough for the day checks and for a rep who works
 * one week a month in an outstation area; short enough that the query stays small forever.
 */
const OWN_HISTORY_DAYS = 14;

/**
 * How far back a coordinate is considered "used before", company-wide. A preset in a fake-GPS app
 * gets reused for months, so this is deliberately much longer than the rep's own window — and it is
 * bounded rather than unlimited so the scan cannot grow without end.
 */
const REPLAY_HISTORY_DAYS = 180;

/** Half of the last place a six-decimal coordinate can hold, for an index-friendly equality band. */
const COORDINATE_BAND = 0.5 / 10 ** REPLAY_DECIMALS;

function toPriorFix(row: Row, customerKey: string): PhoenixCrmPriorFix | null {
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  const capturedAt = new Date(String(row.captured_at));
  const repHrId = String(row.rep_hr_id ?? "").toUpperCase();
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Number.isNaN(capturedAt.getTime()) || !repHrId) return null;
  const accuracy = row.accuracy_meters === null || row.accuracy_meters === undefined ? null : Number(row.accuracy_meters);
  return {
    lat,
    lon,
    accuracyMeters: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null,
    capturedAt,
    repHrId,
    customerId: row[customerKey] ? String(row[customerKey]) : null,
  };
}

/**
 * Everything the detectors compare one fix against: this rep's recent captures, plus any capture by
 * ANYONE that sits on the same coordinate. Visits and validated places both count as fixes — a rep
 * who spoofs a place and then visits it honestly is still a rep who spoofed a place.
 */
async function loadHistory(repHrId: string, fix: { lat: number; lon: number }, isTest: boolean): Promise<PhoenixCrmPriorFix[]> {
  const supabase = getSupabaseAdmin();
  const ownSince = new Date(Date.now() - OWN_HISTORY_DAYS * 86_400_000).toISOString();
  const replaySince = new Date(Date.now() - REPLAY_HISTORY_DAYS * 86_400_000).toISOString();
  const latLow = fix.lat - COORDINATE_BAND;
  const latHigh = fix.lat + COORDINATE_BAND;
  const lonLow = fix.lon - COORDINATE_BAND;
  const lonHigh = fix.lon + COORDINATE_BAND;

  const visitColumns = "lat, lon, accuracy_meters, captured_at, rep_hr_id, customer_id";
  // A place records who created it rather than a "rep", so it is aliased into the same shape.
  const placeColumns = "lat, lon, accuracy_meters, captured_at, rep_hr_id:created_by_hr_id, customer_id";

  const [ownVisits, ownPlaces, replayVisits, replayPlaces] = await Promise.all([
    supabase.from("phoenix_crm_visits").select(visitColumns).eq("rep_hr_id", repHrId).eq("is_test", isTest).gte("captured_at", ownSince).limit(500),
    supabase.from("phoenix_crm_places").select(placeColumns).eq("created_by_hr_id", repHrId).eq("is_test", isTest).gte("captured_at", ownSince).limit(500),
    supabase
      .from("phoenix_crm_visits")
      .select(visitColumns)
      .eq("is_test", isTest)
      .gte("captured_at", replaySince)
      .gte("lat", latLow)
      .lte("lat", latHigh)
      .gte("lon", lonLow)
      .lte("lon", lonHigh)
      .limit(50),
    supabase
      .from("phoenix_crm_places")
      .select(placeColumns)
      .eq("is_test", isTest)
      .gte("captured_at", replaySince)
      .gte("lat", latLow)
      .lte("lat", latHigh)
      .gte("lon", lonLow)
      .lte("lon", lonHigh)
      .limit(50),
  ]);

  const out: PhoenixCrmPriorFix[] = [];
  for (const result of [ownVisits, ownPlaces, replayVisits, replayPlaces]) {
    for (const row of (result.data ?? []) as Row[]) {
      const prior = toPriorFix(row, "customer_id");
      if (prior) out.push(prior);
    }
  }
  return out;
}

export type JudgeCaptureInput = {
  subjectKind: "visit" | "place";
  subjectId: string;
  seatId: string;
  repHrId: string;
  customerId: string | null;
  isTest: boolean;
  fix: { lat: number; lon: number; accuracyMeters: number | null; capturedAt: Date };
  /** Android's mock-provider flag as the phone reported it; null where it cannot be asked. */
  deviceMocked: boolean | null;
};

/**
 * Judge one capture and file the evidence if anything fired. Clean captures write nothing — the
 * denominator is the visits table itself, and an evidence log that records "nothing happened"
 * hundreds of times a day is a log nobody reads.
 *
 * Returns nothing and throws nothing, by design: see the header.
 */
export async function judgeCapture(input: JudgeCaptureInput): Promise<void> {
  try {
    const repHrId = input.repHrId.toUpperCase();
    const history = await loadHistory(repHrId, input.fix, input.isTest).catch(() => [] as PhoenixCrmPriorFix[]);
    // The capture being judged is already on file by now, so it would otherwise match itself.
    const verdict = checkLocationIntegrity({
      fix: input.fix,
      repHrId,
      customerId: input.customerId,
      deviceMocked: input.deviceMocked,
      history: history.filter((prior) => prior.capturedAt.getTime() !== input.fix.capturedAt.getTime()),
    });
    if (verdict.flags.length === 0) return;

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("phoenix_crm_location_integrity").upsert(
      {
        subject_kind: input.subjectKind,
        subject_id: input.subjectId,
        // 🔴 Which detector is speaking, and it is part of the unique key. Before 2026-09-27 it was
        // not: this upsert conflicted on the capture alone, so a second detector filing evidence
        // about the same visit would have REPLACED this verdict rather than sitting beside it — the
        // write succeeds, the row is there, and the flags are simply somebody else's. The photo
        // sweep files under 'photo' against the same visit.
        source: "gps",
        seat_id: input.seatId,
        rep_hr_id: repHrId,
        customer_id: input.customerId,
        captured_at: input.fix.capturedAt.toISOString(),
        visit_date: new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(input.fix.capturedAt),
        lat: input.fix.lat,
        lon: input.fix.lon,
        accuracy_meters: input.fix.accuracyMeters,
        device_mocked: input.deviceMocked,
        flags: verdict.flags,
        strong: verdict.strong,
        signals: verdict.signals,
        is_test: input.isTest,
      },
      { onConflict: "subject_kind,subject_id,source" },
    );
    if (error) {
      // Logged, never surfaced: the rep's save has already returned successfully by this point.
      console.error("[phoenix-crm] location integrity not recorded", { subjectId: input.subjectId, message: error.message });
    }
  } catch (error) {
    console.error("[phoenix-crm] location integrity check failed", { subjectId: input.subjectId, error });
  }
}
