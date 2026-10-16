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

import { assessCaptureTrust, fixesAreBitIdentical, type CaptureFix } from "@/lib/evidence/capture-trust";
import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import {
  checkLocationIntegrity,
  PHOENIX_CRM_STRONG_INTEGRITY_FLAGS,
  REPLAY_DECIMALS,
  type PhoenixCrmIntegrityFlag,
  type PhoenixCrmPriorFix,
} from "@/lib/phoenix-crm/location-integrity";
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

/**
 * A stored coordinate, or null when there is none.
 *
 * 🔴 NEVER `Number(row.lat)` ALONE: `Number(null)` is 0, which is finite, so a missing reading became a
 * fix at 0°N 0°E — and the rep's next real visit, in Egypt, read as IMPOSSIBLE TRAVEL from the Gulf of
 * Guinea. A visit the Super Admin entered for a rep who missed logging it (owner, 2026-10-01) has no
 * reading at all, by design: he was not at the door. It is no fix, and it never accuses anybody.
 */
function coordinate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPriorFix(row: Row, customerKey: string): PhoenixCrmPriorFix | null {
  const lat = coordinate(row.lat);
  const lon = coordinate(row.lon);
  const capturedAt = new Date(String(row.captured_at));
  const repHrId = String(row.rep_hr_id ?? "").toUpperCase();
  if (lat === null || lon === null || Number.isNaN(capturedAt.getTime()) || !repHrId) return null;
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
    // Visits with a reading only: one the Super Admin entered for the rep has none, and must not spend
    // a row of the 500 — toPriorFix would drop it anyway.
    supabase
      .from("phoenix_crm_visits")
      .select(visitColumns)
      .eq("rep_hr_id", repHrId)
      .eq("is_test", isTest)
      .gte("captured_at", ownSince)
      .not("lat", "is", null)
      .limit(500),
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
  /** Whether the browser's own location reader was replaced (location-reader-probe.ts); null when not asked. */
  readerReplaced?: boolean | null;
  readerFindings?: readonly string[];
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
      readerReplaced: input.readerReplaced ?? null,
      readerFindings: input.readerFindings ?? [],
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
        // 🔴 THE VISIT DAY ENDS AT 02:00 CAIRO (owner, 2026-09-29) — the same arithmetic as
        // `phoenix_crm_save_visit`'s own `visit_date`. This filed the CALENDAR day until 2026-10-02,
        // so a visit logged at 01:30 carried a different day here from the one on the visit itself and
        // on every other CRM screen: evidence about a day the rep did not work.
        visit_date: cairoBusinessDay(input.fix.capturedAt),
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

/**
 * Compare a place's TWO readings with each other and file what the comparison says.
 *
 * A place stores the photo's own shutter fix and the separate Capture-location pin, and until
 * 2026-10-08 nothing anywhere compared them: each was measured against its own ceiling and that was
 * all. `assessCaptureTrust` already answers exactly this question for three other modules, so no
 * threshold is declared here — the verdict is read, never re-derived.
 *
 * 🔴 A FLAG, NEVER A REFUSAL AND NEVER A HOLD. A rep cannot pass a gap refusal by standing anywhere:
 * he does not choose which of his two readings drifted, and the photo's fix is taken once by the
 * shutter with no retry. A hold would stall his admission and stop his visits counting over a signal
 * that says nothing about WHO the customer is.
 *
 * 🔴 `source: "capture_trust"`, NEVER `"gps"`. `source` is part of this table's unique key, so filing
 * under `"gps"` would REPLACE `judgeCapture`'s own verdict on the same place — the write succeeds, the
 * row is there, and the flags are somebody else's. The `source` CHECK was widened to allow this value
 * in migration 20261008023051; this function has its own `catch` as well, so a database that has not
 * had that migration applied can never turn a successful validation into a 500 after the place saved.
 *
 * Void and never throws, by rule 2 of this file's header.
 */
export async function filePlaceCaptureTrust(input: {
  placeId: string;
  /**
   * Which kind of subject `placeId` names. Defaults to an ordinary place.
   *
   * 🔴 `"shared_place"` IS THE SAME CHECK OVER A DIFFERENT TABLE, AND IT IS ON PURPOSE THAT THERE IS
   * ONLY ONE FILER. `phoenix_crm_shared_places` carries the identical pair of independent fixes — the
   * photo's shutter reading and the capture pin — and the second-pass audit found the 24 active
   * venues reached NO detector at all. A second filer would have been a second place for the
   * threshold, the flags and the upsert key to drift. `subject_kind` is part of
   * UNIQUE (subject_kind, subject_id, source), so a venue's case cannot collide with a place's even
   * if the two tables ever shared an id.
   */
  subjectKind?: "place" | "shared_place";
  seatId: string;
  repHrId: string;
  customerId: string | null;
  isTest: boolean;
  photoFix: CaptureFix | null;
  pinFix: CaptureFix | null;
  /** The place's own fixed point, so the evidence row reads on its own like every other one. */
  fixed: { lat: number; lon: number; accuracyMeters: number | null; capturedAt: Date };
}): Promise<void> {
  try {
    const assessment = assessCaptureTrust({ locationFix: input.pinFix, photoFix: input.photoFix });
    // 🔴 `unmeasured` writes NOTHING. A place with only one reading has not been measured, and an
    // unmeasured pair is never corroboration — filing it would put a row on the board for every
    // place captured before the shutter fix shipped.
    if (!assessment.measured) return;

    const flags: PhoenixCrmIntegrityFlag[] = [];
    if (assessment.verdict === "disagrees") flags.push("photo_pin_disagrees");
    else if (assessment.verdict === "drifted") flags.push("photo_pin_drifted");
    if (assessment.gapIsLong) flags.push("photo_pin_gap_long");
    if (fixesAreBitIdentical(input.pinFix, input.photoFix)) flags.push("photo_pin_identical");
    if (flags.length === 0) return;

    const strong = flags.some((flag) => PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(flag));
    const { error } = await getSupabaseAdmin().from("phoenix_crm_location_integrity").upsert(
      {
        subject_kind: input.subjectKind ?? "place",
        subject_id: input.placeId,
        source: "capture_trust",
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        captured_at: input.fixed.capturedAt.toISOString(),
        visit_date: cairoBusinessDay(input.fixed.capturedAt),
        lat: input.fixed.lat,
        lon: input.fixed.lon,
        accuracy_meters: input.fixed.accuracyMeters,
        device_mocked: null,
        flags,
        strong,
        // The measurements themselves, so a reader can see the gap rather than take the flag on trust.
        signals: {
          gapSeconds: assessment.gapSeconds,
          metresApart: assessment.distanceMeters,
          verdict: assessment.verdict,
        },
        is_test: input.isTest,
      },
      { onConflict: "subject_kind,subject_id,source" },
    );
    if (error) {
      console.error("[phoenix-crm] capture trust not recorded", { placeId: input.placeId, message: error.message });
    }
  } catch (error) {
    console.error("[phoenix-crm] capture trust check failed", { placeId: input.placeId, error });
  }
}

/**
 * File what the signboard in a place's own photo said, when it said the wrong thing.
 *
 * Only the two confident negatives reach here; a match and an `unjudged` write nothing, for the same
 * reason `judgeCapture` writes nothing on a clean capture — an evidence log that records "nothing
 * happened" six hundred times is a log nobody reads. What the system read is kept on the place row
 * itself (`phoenix_crm_places.signboard_check`), for every place and not only the flagged ones, so
 * "how many validated places has the system actually read the sign of" stays a query.
 *
 * 🔴 `source: "signboard"`, beside the other detectors and never instead of one. And a FLAG only: the
 * owner's ruling of 2026-10-08 is that he decides each of the already-validated places himself, so
 * nothing here un-validates a customer or tells a rep anything.
 *
 * Void and never throws.
 */
export async function filePlaceSignboardFlag(input: {
  placeId: string;
  seatId: string;
  repHrId: string;
  customerId: string | null;
  isTest: boolean;
  flag: "sign_other_name" | "sign_no_name";
  /** What was read, for the board: the sign's own words and the names on it. */
  signals: Record<string, unknown>;
  fixed: { lat: number; lon: number; accuracyMeters: number | null; capturedAt: Date };
}): Promise<void> {
  try {
    const flags: PhoenixCrmIntegrityFlag[] = [input.flag];
    const { error } = await getSupabaseAdmin().from("phoenix_crm_location_integrity").upsert(
      {
        subject_kind: "place",
        subject_id: input.placeId,
        source: "signboard",
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        captured_at: input.fixed.capturedAt.toISOString(),
        visit_date: cairoBusinessDay(input.fixed.capturedAt),
        lat: input.fixed.lat,
        lon: input.fixed.lon,
        accuracy_meters: input.fixed.accuracyMeters,
        device_mocked: null,
        flags,
        strong: PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(input.flag),
        signals: input.signals,
        is_test: input.isTest,
      },
      { onConflict: "subject_kind,subject_id,source" },
    );
    if (error) {
      console.error("[phoenix-crm] signboard flag not recorded", { placeId: input.placeId, message: error.message });
    }
  } catch (error) {
    console.error("[phoenix-crm] signboard flag failed", { placeId: input.placeId, error });
  }
}

// ── The three silent detectors' filers (2026-10-12) ─────────────────────────────────────────────
//
// 🔴 EACH IS ITS OWN `source`, NEVER `"gps"`. `source` is part of UNIQUE (subject_kind, subject_id,
// source), so filing a roster finding under `"gps"` would REPLACE `judgeCapture`'s own verdict on the
// same visit — the write succeeds, the row is there, and the flags are somebody else's. That is the
// mistake `capture_trust`'s own comment above records, and these three repeat the shape, not the bug.
//
// 🔴 AND EVERY FLAG THEY CARRY IS WEAK, so `strong` is computed from the one shared list rather than
// written false by hand: the day one of these is promoted the row must follow, and the day one is
// NOT promoted a hand-written `false` would hide it.
//
// All three are void and never throw, by rule 2 of this file's header.

/**
 * File what the ROSTER says about the day a visit was saved on — leave, an away day, or a companion
 * who was himself off duty.
 *
 * `visitId` is the subject, because the finding is about one capture and not about the rep's month.
 */
export async function fileVisitRosterFlags(input: {
  visitId: string;
  seatId: string;
  repHrId: string;
  customerId: string | null;
  isTest: boolean;
  capturedAt: Date;
  visitDate: string;
  flags: PhoenixCrmIntegrityFlag[];
  /** What the roster actually said, so a reader sees the day rather than taking the flag on trust. */
  signals: Record<string, unknown>;
}): Promise<void> {
  if (input.flags.length === 0) return;
  try {
    const { error } = await getSupabaseAdmin().from("phoenix_crm_location_integrity").upsert(
      {
        subject_kind: "visit",
        subject_id: input.visitId,
        source: "roster",
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        captured_at: input.capturedAt.toISOString(),
        visit_date: input.visitDate,
        // No position is claimed: the roster knows nothing about where anybody stood, and a lat/lon
        // copied off the visit here would read on the board as this detector's own evidence.
        lat: null,
        lon: null,
        accuracy_meters: null,
        device_mocked: null,
        flags: input.flags,
        strong: input.flags.some((flag) => PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(flag)),
        signals: input.signals,
        is_test: input.isTest,
      },
      { onConflict: "subject_kind,subject_id,source" },
    );
    if (error) console.error("[phoenix-crm] roster flags not recorded", { visitId: input.visitId, message: error.message });
  } catch (error) {
    console.error("[phoenix-crm] roster check failed", { visitId: input.visitId, error });
  }
}

/**
 * File that one rep called one CUSTOMER too often in too few days.
 *
 * 🔴 THE SUBJECT IS THE CUSTOMER, NOT A VISIT, and that is what `subject_kind: "customer"` is for.
 * Picking one of the three visits would make the finding look like a judgement on that call, and the
 * upsert key would then file the same pattern again under the next visit every night.
 */
export async function fileCustomerCadenceFlag(input: {
  customerId: string;
  seatId: string;
  repHrId: string;
  isTest: boolean;
  /** The last of the calls, so the row sorts on the board with the rest of this week's evidence. */
  capturedAt: Date;
  visitDate: string;
  flags: PhoenixCrmIntegrityFlag[];
  signals: Record<string, unknown>;
}): Promise<void> {
  if (input.flags.length === 0) return;
  try {
    const { error } = await getSupabaseAdmin().from("phoenix_crm_location_integrity").upsert(
      {
        subject_kind: "customer",
        subject_id: input.customerId,
        source: "cadence",
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        // The same id in both columns deliberately: `customer_id` is what the board joins to print a
        // NAME instead of a uuid, and a customer case has to read as a name like every other row.
        customer_id: input.customerId,
        captured_at: input.capturedAt.toISOString(),
        visit_date: input.visitDate,
        lat: null,
        lon: null,
        accuracy_meters: null,
        device_mocked: null,
        flags: input.flags,
        strong: input.flags.some((flag) => PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(flag)),
        signals: input.signals,
        is_test: input.isTest,
      },
      { onConflict: "subject_kind,subject_id,source" },
    );
    if (error) console.error("[phoenix-crm] cadence flag not recorded", { customerId: input.customerId, message: error.message });
  } catch (error) {
    console.error("[phoenix-crm] cadence check failed", { customerId: input.customerId, error });
  }
}

/**
 * File that a visit sits far from the PHOTOGRAPH of the place it names (2026-10-13).
 *
 * The owner's instruction, in his own words: "since u have the accurate validation the photo with
 * location then drop the suspected one and compare visits vs the accurate", and then "i want the
 * integrity report to show exactly this with story with the pictures and live loc numbers and
 * photos". The comparison had been a sentence on a PLACE's panel since #5825; 47 of the 48 visits it
 * found sitting far from the door reached the board through no case of their own, which is what this
 * filer is for.
 *
 * 🔴 `source: "visit_photo"`, NEVER `"gps"`. `source` is part of
 * UNIQUE (subject_kind, subject_id, source), so filing under `"gps"` would REPLACE
 * `judgeCapture`'s own verdict on the same visit — the write succeeds, the row is there, and the
 * flags are somebody else's. That is the mistake `filePlaceCaptureTrust`'s comment above records,
 * and this repeats its shape, not its bug. The value is allowed by the `source` CHECK from
 * migration 20261013_phoenix_crm_visit_photograph_gap; this function has its own `catch` as well, so
 * a database without that migration can never turn a nightly pass into a 500.
 *
 * 🔴 ITS EVIDENCE POINT IS THE VISIT'S OWN FIX, and the photograph travels in the signals. The row's
 * lat/lon is where the rep's phone was when the box was filled in — the reading the case is ABOUT —
 * and the board draws the photograph beside it from the place, by label, so the panel says which of
 * the two is which rather than printing two bare coordinates.
 *
 * Void and never throws, by rule 2 of this file's header.
 */
export async function fileVisitPhotographGap(input: {
  visitId: string;
  seatId: string;
  /** The rep who saved it. A visit with none is not filed at all — see the pass's own note. */
  repHrId: string;
  customerId: string | null;
  isTest: boolean;
  capturedAt: Date;
  visitDate: string;
  flags: PhoenixCrmIntegrityFlag[];
  /** Where the visit was saved: the row's own evidence point. */
  fix: { lat: number; lon: number; accuracyMeters: number | null };
  /** What it was measured against, and the numbers the panel prints. */
  signals: Record<string, unknown>;
}): Promise<void> {
  if (input.flags.length === 0) return;
  try {
    const { error } = await getSupabaseAdmin().from("phoenix_crm_location_integrity").upsert(
      {
        subject_kind: "visit",
        subject_id: input.visitId,
        source: "visit_photo",
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        captured_at: input.capturedAt.toISOString(),
        visit_date: input.visitDate,
        lat: input.fix.lat,
        lon: input.fix.lon,
        accuracy_meters: input.fix.accuracyMeters,
        // Nothing is claimed about the phone's mock-location answer: that is `judgeCapture`'s own
        // verdict on this same visit, filed under its own source, and a `false` written here would
        // read on the board as this detector having asked.
        device_mocked: null,
        flags: input.flags,
        // From the one shared list, never a hand-written false: the day one of these is promoted the
        // row must follow, and the day one is NOT promoted a hand-written false would hide it.
        strong: input.flags.some((flag) => PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(flag)),
        signals: input.signals,
        is_test: input.isTest,
      },
      { onConflict: "subject_kind,subject_id,source" },
    );
    if (error) console.error("[phoenix-crm] visit photograph gap not recorded", { visitId: input.visitId, message: error.message });
  } catch (error) {
    console.error("[phoenix-crm] visit photograph check failed", { visitId: input.visitId, error });
  }
}

/**
 * File that a place sits far outside the brick it is filed under.
 *
 * A finding about the DATA, which is why it carries the place's own fixed point as its evidence: the
 * reader's first question is "where is it then", and the answer is on the row.
 */
export async function filePlaceCoverageFlag(input: {
  placeId: string;
  seatId: string;
  repHrId: string;
  customerId: string | null;
  isTest: boolean;
  flags: PhoenixCrmIntegrityFlag[];
  signals: Record<string, unknown>;
  fixed: { lat: number; lon: number; accuracyMeters: number | null; capturedAt: Date };
}): Promise<void> {
  if (input.flags.length === 0) return;
  try {
    const { error } = await getSupabaseAdmin().from("phoenix_crm_location_integrity").upsert(
      {
        subject_kind: "place",
        subject_id: input.placeId,
        source: "coverage",
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        captured_at: input.fixed.capturedAt.toISOString(),
        visit_date: cairoBusinessDay(input.fixed.capturedAt),
        lat: input.fixed.lat,
        lon: input.fixed.lon,
        accuracy_meters: input.fixed.accuracyMeters,
        device_mocked: null,
        flags: input.flags,
        strong: input.flags.some((flag) => PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(flag)),
        signals: input.signals,
        is_test: input.isTest,
      },
      { onConflict: "subject_kind,subject_id,source" },
    );
    if (error) console.error("[phoenix-crm] coverage flag not recorded", { placeId: input.placeId, message: error.message });
  } catch (error) {
    console.error("[phoenix-crm] coverage check failed", { placeId: input.placeId, error });
  }
}
