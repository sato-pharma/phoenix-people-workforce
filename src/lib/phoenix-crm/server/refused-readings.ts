/**
 * Phoenix CRM — filing the reading a REFUSED capture was carrying.
 *
 * Owner, 2026-10-03: "record the refused readings so the next refusal is traceable".
 *
 * THREE RULES GOVERN THIS FILE, AND THE FIRST TWO ARE THE SAME ONES `location-integrity.ts` OBEYS.
 *
 *   1. THE REP MUST NOT KNOW ANYTHING NEW. This changes no message, no screen and no figure. The
 *      refusal he reads is byte-for-byte the one he read before this file existed; the only
 *      difference is that its number now outlives it. (Golden rule #1, owner 2026-09-26.)
 *
 *   2. IT MUST NEVER COST A REP HIS WORK. Every path returns void and swallows every error it can
 *      produce. A rep who is already being refused must not then be refused differently, or
 *      hit a 500, because an evidence insert failed.
 *
 *   3. 🔴 IT IS AWAITED, UNLIKE THE INTEGRITY JUDGEMENT, AND THAT IS DELIBERATE. The first reason
 *      given here — a fire-and-forget promise killed with a serverless invocation — no longer applies:
 *      production is one long-lived Node process on Railway, and `afterResponse` (used by the blocked
 *      permission below) is the safe way to write after a reply. These two stay awaited because a
 *      refusal is rare, the rep is waiting for his refusal message anyway, the row is in before he can
 *      try again, and the off-listing count on his NEXT attempt reads the off-listing rows. Re-checked in the
 *      Phoenix CRM performance audit, 2026-10-16. Never a bare unawaited promise: nothing would log its
 *      failure.
 */

import { afterResponse } from "@/lib/http/after-response";
import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { PLACE_MAX_ACCURACY_METERS, refusedReadingOf, type PlaceDraft, type VisitDraft } from "@/lib/phoenix-crm/entry-rules";
import { type BlockedPermission } from "@/lib/phoenix-crm/refused-readings-rules";
import { type ScheduleRetakeReason } from "@/lib/phoenix-crm/schedule-rules";
import { type SeatingReading } from "@/lib/phoenix-crm/shared-place-rules";
import { type SignboardRetakeReason } from "@/lib/phoenix-crm/signboard-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type RecordRefusedReadingInput = {
  subjectKind: "visit" | "place";
  /** The body the door refused — the visit body itself, or `body.place` for a validation. */
  raw: unknown;
  seatId: string;
  /** Whoever's phone was refused: the rep, or the manager or Super Admin entering for him. */
  repHrId: string;
  customerId: string | null;
  isTest: boolean;
};

/**
 * File one refused capture, if the LOCATION is what refused it.
 *
 * A refusal about anything else — no comment, no products, no photo, a bad customer id — writes
 * nothing: `refusedReadingOf` answers null and this returns at once. A table that also held every
 * mistyped form would be a table nobody reads.
 */
export async function recordRefusedReading(input: RecordRefusedReadingInput): Promise<void> {
  try {
    const reading = refusedReadingOf(input.raw, input.subjectKind);
    if (reading === null) return;
    const refusedAt = new Date();
    const { error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .insert({
        subject_kind: input.subjectKind,
        reason: reading.reason,
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        refused_at: refusedAt.toISOString(),
        // The Cairo VISIT day, which ends at 02:00 (owner, 2026-09-29) — the same arithmetic the
        // visit itself uses, so a refusal at 01:30 files under the day the rep was working.
        visit_date: cairoBusinessDay(refusedAt),
        lat: reading.lat,
        lon: reading.lon,
        accuracy_meters: reading.accuracyMeters,
        photo_lat: reading.photoLat,
        photo_lon: reading.photoLon,
        photo_accuracy_meters: reading.photoAccuracyMeters,
        // 🔴 THE PHOTO ITSELF (owner, 2026-10-03: "save the photo when a validation is refused").
        // The object is already in the bucket — the browser PUTs it to its slot before the save is
        // even attempted — so this keeps the POINTER that was being thrown away and uploads nothing.
        // Before 20261003224941 a refusal kept the photo's two COORDINATES and lost the picture,
        // which left the only human-readable evidence of where the rep stood reachable just by
        // hand-joining unused slots to storage.objects.
        photo_path: reading.photoPath,
        max_accuracy_meters: reading.maxAccuracyMeters,
        device_captured_at: reading.deviceCapturedAt,
        device_mocked: reading.deviceMocked,
        is_test: input.isTest,
      });
    if (error) {
      // Logged, never surfaced: the rep is about to read his refusal either way.
      console.error("[phoenix-crm] refused reading not recorded", { seatId: input.seatId, message: error.message });
    }
  } catch (error) {
    console.error("[phoenix-crm] refused reading record failed", { seatId: input.seatId, error });
  }
}

export type OffListingRefusalInput = {
  /** The place draft that already parsed — both its readings are precise, which is the point. */
  place: PlaceDraft;
  seatId: string;
  repHrId: string;
  /** Null for "Add new customer" and an out-of-list customer: there is no row to count against yet. */
  customerId: string | null;
  isTest: boolean;
};

/**
 * File a validation Google refused as a MISMATCH — the listing IS the account, and the rep's point is
 * 150 m - 1 km from its pin (`google-place-rules.ts`).
 *
 * It needs its own entry point because `refusedReadingOf` answers null here, correctly: BOTH readings
 * are precise, so there is nothing wrong with the position and the existing recorder has nothing to
 * say about it. What refused the save was the account's own pin, which is why the reason is
 * `off_listing` and the place's readings are taken from the draft that already parsed.
 *
 * 🔴 IT IS COUNTED, NOT JUST KEPT. The next attempt on the same customer reads these rows to decide
 * whether to refuse again or HOLD it for the Super Admin, so a failure to insert costs the rep his
 * way out — and still must never cost him his refusal message or a 500. It returns the row's own id,
 * or null when nothing was written, so the caller can say in its log whether the count will see it.
 *
 * The same three rules as above hold: the rep learns nothing new, it never throws, and it is awaited.
 */
export async function recordOffListingRefusal(input: OffListingRefusalInput): Promise<string | null> {
  try {
    const refusedAt = new Date();
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .insert({
        subject_kind: "place",
        reason: "off_listing",
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        refused_at: refusedAt.toISOString(),
        visit_date: cairoBusinessDay(refusedAt),
        lat: input.place.lat,
        lon: input.place.lon,
        accuracy_meters: input.place.accuracyMeters,
        photo_lat: input.place.photoLat,
        photo_lon: input.place.photoLon,
        photo_accuracy_meters: input.place.photoAccuracyMeters,
        photo_path: input.place.photoPath,
        max_accuracy_meters: PLACE_MAX_ACCURACY_METERS,
        device_captured_at: input.place.deviceCapturedAt,
        device_mocked: input.place.deviceMocked,
        is_test: input.isTest,
      })
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("[phoenix-crm] off-listing refusal not recorded", { seatId: input.seatId, message: error.message });
      return null;
    }
    const row = (data ?? null) as { id?: unknown } | null;
    return row && row.id ? String(row.id) : null;
  } catch (error) {
    console.error("[phoenix-crm] off-listing refusal record failed", { seatId: input.seatId, error });
    return null;
  }
}

export type FarVisitRefusalInput = {
  /** The visit draft that already parsed — its reading was good enough to measure, which is the point. */
  visit: Pick<
    VisitDraft,
    "lat" | "lon" | "accuracyMeters" | "photoLat" | "photoLon" | "photoAccuracyMeters" | "photoPath" | "deviceCapturedAt" | "deviceMocked"
  >;
  seatId: string;
  repHrId: string;
  customerId: string;
  /** The nearest validated place the visit was measured to, and the metres to its photograph. */
  placeId: string | null;
  metres: number | null;
  /** The far line the visit was refused against, stored in `max_accuracy_meters` (see the reason's note). */
  farMeters: number;
  isTest: boolean;
};

/**
 * File a rep's visit refused for being logged past the far line from the customer's validated
 * photograph (owner, 2026-10-20 — `visitAwayFromValidatedPlace`, entry-rules.ts).
 *
 * Its own entry point for the same reason as `recordOffListingRefusal`: `refusedReadingOf` answers null
 * here, correctly — the reading was within the visit's accuracy line, so nothing was wrong with the
 * phone. What refused it was WHERE it was, so the row carries the metres and the place they were
 * measured to, and the SFE reads it as its own reason, never as "too rough".
 *
 * The same three rules as above hold: the rep learns nothing beyond the refusal he already reads, it
 * never throws, and it is awaited.
 */
export async function recordFarVisitRefusal(input: FarVisitRefusalInput): Promise<void> {
  try {
    const refusedAt = new Date();
    const { error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .insert({
        subject_kind: "visit",
        reason: "far_from_place",
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        refused_at: refusedAt.toISOString(),
        visit_date: cairoBusinessDay(refusedAt),
        lat: input.visit.lat,
        lon: input.visit.lon,
        accuracy_meters: input.visit.accuracyMeters,
        photo_lat: input.visit.photoLat,
        photo_lon: input.visit.photoLon,
        photo_accuracy_meters: input.visit.photoAccuracyMeters,
        photo_path: input.visit.photoPath,
        max_accuracy_meters: Math.round(input.farMeters),
        place_id: input.placeId,
        // Whole metres, as every distance in this module is stored.
        distance_meters: input.metres === null || !Number.isFinite(input.metres) ? null : Math.round(input.metres),
        device_captured_at: input.visit.deviceCapturedAt,
        device_mocked: input.visit.deviceMocked,
        is_test: input.isTest,
      });
    if (error) {
      console.error("[phoenix-crm] far-visit refusal not recorded", { seatId: input.seatId, message: error.message });
    }
  } catch (error) {
    console.error("[phoenix-crm] far-visit refusal record failed", { seatId: input.seatId, error });
  }
}

export type SeatingAwayRefusalInput = {
  reading: SeatingReading;
  sharedPlaceId: string;
  /** Null on `new`, `outside` and `reference`, where no customer row has been chosen yet. */
  customerId: string | null;
  /** A fresh timetable photo he had taken, kept with the row. Null when the board on file was to be used. */
  photoPath: string | null;
  seatId: string;
  repHrId: string;
  metres: number | null;
  farMeters: number;
  isTest: boolean;
};

/**
 * File a rep's seating refused for being past the far line from the building (owner, 3 Nov 2026 —
 * `seatingAwayFromBuilding`, shared-place-rules.ts). The same reason as a far visit, told apart by
 * `subject_kind`, and it names the BUILDING (`shared_place_id`, 20261103154101), because a refused seating
 * leaves no place row to say which one. It never counts as a timetable try: those are counted by their
 * own two reasons. The same three rules as above: nothing more reaches the rep, it never throws, it is awaited.
 */
export async function recordSeatingAwayRefusal(input: SeatingAwayRefusalInput): Promise<void> {
  try {
    const refusedAt = new Date();
    const { error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .insert({
        subject_kind: "place",
        reason: "far_from_place",
        shared_place_id: input.sharedPlaceId,
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        refused_at: refusedAt.toISOString(),
        visit_date: cairoBusinessDay(refusedAt),
        lat: input.reading.lat,
        lon: input.reading.lon,
        accuracy_meters: input.reading.accuracyMeters,
        photo_path: input.photoPath,
        max_accuracy_meters: Math.round(input.farMeters),
        distance_meters: input.metres === null || !Number.isFinite(input.metres) ? null : Math.round(input.metres),
        is_test: input.isTest,
      });
    if (error) {
      console.error("[phoenix-crm] far-seating refusal not recorded", { seatId: input.seatId, message: error.message });
    }
  } catch (error) {
    console.error("[phoenix-crm] far-seating refusal record failed", { seatId: input.seatId, error });
  }
}

/**
 * How many times this rep has already been refused on this customer for standing off its Google
 * listing. Zero for a customer with no row to count against (a brand-new one), and zero on any error:
 * a read that fails must refuse the rep as before, never hold on a count it does not have.
 */
export async function countOffListingRefusals(input: { seatId: string; repHrId: string; customerId: string | null; isTest: boolean }): Promise<number> {
  if (!input.customerId) return 0;
  try {
    const { count, error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .select("id", { count: "exact", head: true })
      .eq("seat_id", input.seatId)
      .eq("customer_id", input.customerId)
      .eq("subject_kind", "place")
      .eq("reason", "off_listing")
      .eq("is_test", input.isTest)
      // HR ids are mixed case in this database, and the recorder upper-cases what it writes.
      .eq("rep_hr_id", input.repHrId.toUpperCase());
    if (error) {
      console.error("[phoenix-crm] off-listing refusal count failed", { seatId: input.seatId, message: error.message });
      return 0;
    }
    return count ?? 0;
  } catch (error) {
    console.error("[phoenix-crm] off-listing refusal count failed", { seatId: input.seatId, error });
    return 0;
  }
}

export type TimetableRefusalInput = {
  reason: ScheduleRetakeReason;
  /** The BUILDING whose timetable was refused — the count's key, never a customer. */
  sharedPlaceId: string;
  /** The refused photograph's own pointer, kept as every refusal here keeps its own. */
  photoPath: string | null;
  seatId: string;
  repHrId: string;
  /** The customer being seated, when he already has a row. Kept for the board, never counted on. */
  customerId: string | null;
  isTest: boolean;
};

/**
 * File one timetable photograph the door refused — the reader answered, and what it saw was not a
 * readable timetable (owner, 2026-10-17: the scanner, "3 tries then held to confirmation by admin").
 *
 * 🔴 IT IS COUNTED, LIKE THE OFF-LISTING ONE: the rep's next photograph of the same building today
 * reads these rows to decide whether to refuse again or save and hold. So it is awaited, and a failed
 * insert costs him only a try he would otherwise have had — never his refusal message, never a 500.
 * Unlike the location refusals, the rep IS told what to fix: that is the owner's ruling for this one
 * photograph, and the words are `scheduleDoorAction`'s.
 */
export async function recordTimetableRefusal(input: TimetableRefusalInput): Promise<string | null> {
  if (!input.sharedPlaceId) return null;
  try {
    const refusedAt = new Date();
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .insert({
        subject_kind: "place",
        reason: input.reason,
        // Paired with the reason by the table's own CHECK (20261017193000): no other reason may
        // carry a building, and this writer never files a timetable reason without one.
        shared_place_id: input.sharedPlaceId,
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        refused_at: refusedAt.toISOString(),
        // The Cairo visit day, ending at 02:00 — the day the tries are counted on.
        visit_date: cairoBusinessDay(refusedAt),
        photo_path: input.photoPath,
        is_test: input.isTest,
      })
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("[phoenix-crm] timetable refusal not recorded", { seatId: input.seatId, message: error.message });
      return null;
    }
    const row = (data ?? null) as { id?: unknown } | null;
    return row && row.id ? String(row.id) : null;
  } catch (error) {
    console.error("[phoenix-crm] timetable refusal record failed", { seatId: input.seatId, error });
    return null;
  }
}

/**
 * How many timetable photographs of this BUILDING this rep has had refused today (Cairo visit day).
 * Zero on any error: a count the door cannot read asks for another photograph rather than hold on a
 * number it does not have — the third refusal is still reached on the next try that can count.
 */
export async function countTimetableRefusals(input: { sharedPlaceId: string; repHrId: string; isTest: boolean; now?: Date }): Promise<number> {
  if (!input.sharedPlaceId) return 0;
  try {
    const { count, error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .select("id", { count: "exact", head: true })
      .eq("shared_place_id", input.sharedPlaceId)
      // HR ids are mixed case in this database, and the recorder upper-cases what it writes.
      .eq("rep_hr_id", input.repHrId.toUpperCase())
      .eq("visit_date", cairoBusinessDay(input.now ?? new Date()))
      .in("reason", ["timetable_unreadable", "timetable_missing"])
      .eq("is_test", input.isTest);
    if (error) {
      console.error("[phoenix-crm] timetable refusal count failed", { sharedPlaceId: input.sharedPlaceId, message: error.message });
      return 0;
    }
    return count ?? 0;
  } catch (error) {
    console.error("[phoenix-crm] timetable refusal count failed", { sharedPlaceId: input.sharedPlaceId, error });
    return 0;
  }
}

/**
 * The same count for every building on the rep's picker, in one read, so the phone knows where the
 * last try may be an upload (`scheduleUploadAllowed`). An empty map on any error: the camera stays the
 * only door, which is what an unreadable count must mean.
 */
export async function countTimetableRefusalsByVenue(input: { sharedPlaceIds: string[]; repHrId: string; isTest: boolean; now?: Date }): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (input.sharedPlaceIds.length === 0) return counts;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .select("shared_place_id")
      .in("shared_place_id", input.sharedPlaceIds)
      .eq("rep_hr_id", input.repHrId.toUpperCase())
      .eq("visit_date", cairoBusinessDay(input.now ?? new Date()))
      .in("reason", ["timetable_unreadable", "timetable_missing"])
      .eq("is_test", input.isTest);
    if (error) {
      console.error("[phoenix-crm] timetable refusal counts failed", { message: error.message });
      return counts;
    }
    for (const row of (data ?? []) as Array<{ shared_place_id: unknown }>) {
      const id = String(row.shared_place_id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  } catch (error) {
    console.error("[phoenix-crm] timetable refusal counts failed", { error });
    return counts;
  }
}

export type SignboardRefusalInput = {
  reason: SignboardRetakeReason;
  /** `signboardRefusalKey`: the place, the customer, or a new customer's folded name — the count's key. */
  key: string;
  photoPath: string | null;
  seatId: string;
  repHrId: string;
  customerId: string | null;
  isTest: boolean;
};

/**
 * File one signboard photo the door refused — the reader answered, and the photo shows no name it can
 * read (2026-10-18: the signboard scanner, the timetable's "3 tries then held" carried to the signboard).
 * Counted, like the timetable's: awaited, and a failed insert costs the rep only a try he would
 * otherwise have had — never his refusal message, never a 500.
 */
export async function recordSignboardRefusal(input: SignboardRefusalInput): Promise<string | null> {
  if (!input.key) return null;
  try {
    const refusedAt = new Date();
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .insert({
        subject_kind: "place",
        reason: input.reason,
        // Paired with the reason by the table's own CHECK (20261018230000): no other reason carries a key.
        signboard_key: input.key,
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        refused_at: refusedAt.toISOString(),
        visit_date: cairoBusinessDay(refusedAt),
        photo_path: input.photoPath,
        is_test: input.isTest,
      })
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("[phoenix-crm] signboard refusal not recorded", { seatId: input.seatId, message: error.message });
      return null;
    }
    const row = (data ?? null) as { id?: unknown } | null;
    return row && row.id ? String(row.id) : null;
  } catch (error) {
    console.error("[phoenix-crm] signboard refusal record failed", { seatId: input.seatId, error });
    return null;
  }
}

/**
 * How many signboard photos under this key this rep has had refused today (Cairo visit day). Zero on any
 * error, for the timetable's reason: a count the door cannot read asks for another photo rather than hold.
 */
export async function countSignboardRefusals(input: { key: string; repHrId: string; isTest: boolean; now?: Date }): Promise<number> {
  if (!input.key) return 0;
  try {
    const { count, error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .select("id", { count: "exact", head: true })
      .eq("signboard_key", input.key)
      .eq("rep_hr_id", input.repHrId.toUpperCase())
      .eq("visit_date", cairoBusinessDay(input.now ?? new Date()))
      .in("reason", ["signboard_unreadable", "signboard_no_plate"])
      .eq("is_test", input.isTest);
    if (error) {
      console.error("[phoenix-crm] signboard refusal count failed", { message: error.message });
      return 0;
    }
    return count ?? 0;
  } catch (error) {
    console.error("[phoenix-crm] signboard refusal count failed", { error });
    return 0;
  }
}

export type ImpossibleTravelRefusalInput = {
  /** The reading judged impossible — the pin, or the photo's own reading beside a good pin. */
  reading: { lat: number; lon: number; accuracyMeters: number | null };
  /** The photo's reading too, only when IT was judged impossible as well; null otherwise. */
  photo: { lat: number; lon: number; accuracyMeters: number | null } | null;
  photoPath: string | null;
  deviceCapturedAt: string | null;
  deviceMocked: boolean | null;
  seatId: string;
  repHrId: string;
  customerId: string | null;
  /** Metres from the rep's own visit saved minutes earlier; null for a bare repeat. */
  metres: number | null;
  isTest: boolean;
};

/**
 * File a place reading refused as IMPOSSIBLE (owner, 10 Nov 2026 — `judgeImpossibleLocation`,
 * far-visit-safeguards.ts). 🔴 `lat`/`lon` hold THE READING JUDGED IMPOSSIBLE, and `photo_lat`/`photo_lon`
 * hold the photo's reading only when it was judged impossible too — so every point on such a row is a
 * point the repeat rule may refuse again, and a good pin beside a bad photo is never remembered as bad.
 * The same three rules as above: nothing more reaches the rep, it never throws, it is awaited — the
 * repeat rule on his very next try reads this row.
 */
export async function recordImpossibleTravelRefusal(input: ImpossibleTravelRefusalInput): Promise<void> {
  try {
    const refusedAt = new Date();
    const { error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .insert({
        subject_kind: "place",
        reason: "impossible_travel",
        seat_id: input.seatId,
        rep_hr_id: input.repHrId.toUpperCase(),
        customer_id: input.customerId,
        refused_at: refusedAt.toISOString(),
        visit_date: cairoBusinessDay(refusedAt),
        lat: input.reading.lat,
        lon: input.reading.lon,
        accuracy_meters: input.reading.accuracyMeters,
        photo_lat: input.photo?.lat ?? null,
        photo_lon: input.photo?.lon ?? null,
        photo_accuracy_meters: input.photo?.accuracyMeters ?? null,
        photo_path: input.photoPath,
        distance_meters: input.metres === null || !Number.isFinite(input.metres) ? null : Math.round(input.metres),
        device_captured_at: input.deviceCapturedAt,
        device_mocked: input.deviceMocked,
        is_test: input.isTest,
      });
    if (error) {
      console.error("[phoenix-crm] impossible-location refusal not recorded", { seatId: input.seatId, message: error.message });
    }
  } catch (error) {
    console.error("[phoenix-crm] impossible-location refusal record failed", { seatId: input.seatId, error });
  }
}

/**
 * Every point this rep has had refused as impossible since `since` — both readings of each row, which
 * are impossible by construction (`recordImpossibleTravelRefusal`). Empty on any error: a read that fails
 * never refuses a rep on a point it cannot see.
 */
export async function loadImpossiblePoints(input: { repHrId: string; isTest: boolean; since: Date }): Promise<Array<{ lat: number; lon: number }>> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .select("lat, lon, photo_lat, photo_lon")
      .eq("reason", "impossible_travel")
      .eq("rep_hr_id", input.repHrId.toUpperCase())
      .eq("is_test", input.isTest)
      .gte("refused_at", input.since.toISOString())
      .limit(200);
    if (error) {
      console.error("[phoenix-crm] impossible points not read", { message: error.message });
      return [];
    }
    const points: Array<{ lat: number; lon: number }> = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      for (const [lat, lon] of [[row.lat, row.lon], [row.photo_lat, row.photo_lon]] as const) {
        if (typeof lat === "number" && typeof lon === "number") points.push({ lat, lon });
      }
    }
    return points;
  } catch (error) {
    console.error("[phoenix-crm] impossible points not read", { error });
    return [];
  }
}

/**
 * This rep's far refusals on this customer on one Cairo visit day, as readings — what decides whether he
 * is stuck at one spot (`stuckAtOneSpot`). Empty on any error: a count the save cannot read refuses as
 * before, never holds, and never alerts.
 */
export async function loadFarTriesOnDay(input: {
  seatId: string;
  repHrId: string;
  customerId: string;
  isTest: boolean;
  visitDate: string;
}): Promise<Array<{ lat: number; lon: number; accuracyMeters: number | null }>> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_refused_readings")
      .select("lat, lon, accuracy_meters")
      .eq("reason", "far_from_place")
      .eq("subject_kind", "visit")
      .eq("seat_id", input.seatId)
      .eq("customer_id", input.customerId)
      .eq("rep_hr_id", input.repHrId.toUpperCase())
      .eq("is_test", input.isTest)
      .eq("visit_date", input.visitDate)
      .limit(500);
    if (error) {
      console.error("[phoenix-crm] far tries not read", { seatId: input.seatId, message: error.message });
      return [];
    }
    const tries: Array<{ lat: number; lon: number; accuracyMeters: number | null }> = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      if (typeof row.lat !== "number" || typeof row.lon !== "number") continue;
      const accuracy = row.accuracy_meters === null || row.accuracy_meters === undefined ? null : Number(row.accuracy_meters);
      tries.push({ lat: row.lat, lon: row.lon, accuracyMeters: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null });
    }
    return tries;
  } catch (error) {
    console.error("[phoenix-crm] far tries not read", { seatId: input.seatId, error });
    return [];
  }
}

export type BlockedPermissionInput = {
  subjectKind: "visit" | "place";
  /** Which permission the browser blocked — already parsed, never a string off the wire. */
  permission: BlockedPermission;
  /** The territory's seat when the screen named one, null otherwise. Never identifies the rep. */
  seatId: string | null;
  /** Whoever's phone was blocked, resolved from the SESSION by the route — never from the body. */
  repHrId: string;
  isTest: boolean;
};

/**
 * File a capture the BROWSER ended — the rep's phone blocked location or the camera, so nothing was
 * ever sent and no door ever refused it.
 *
 * 🔴 IT IS THE ONE ROW THE SERVER DOES NOT DECIDE, AND WITHOUT IT THE BOARD HAS A HOLE THE SHAPE OF
 * EVERY BLOCKED REP. The three recorded reasons all begin with a reading that arrived. A blocked
 * permission produces no reading, reaches no door, and until this function existed reached no row:
 * Norhan Gamal's iPhone answered PERMISSION_DENIED five times across 10 and 12 October 2026 and
 * `phoenix_crm_refused_readings` held nothing at all for her seat, so answering "why was she blocked"
 * meant reading 72 touch-trail messages by hand.
 *
 * The same three rules as the recorders above, with the third inverted for the one reason it must be:
 *
 *   1. THE REP LEARNS NOTHING NEW. The message on the glass is byte-for-byte the one that was there
 *      before this file wrote anything. The report is sent AFTER it is rendered and changes nothing
 *      about it (golden rule #1).
 *
 *   2. IT NEVER COSTS A REP HIS WORK. Void, and it swallows everything — a rep whose camera is
 *      already blocked must not then meet a second failure because an evidence insert went wrong.
 *
 *   3. 🔴 IT IS NOT AWAITED BY THE BROWSER, AND THAT IS THE DIFFERENCE. The other two run inside a
 *      request the rep is already waiting on. This one has no request of its own to ride: the
 *      permission died in the browser, so the browser posts it fire-and-forget. Since 2026-10-16 the
 *      insert runs AFTER the route's 204 has gone (`afterResponse`, Phoenix CRM performance audit):
 *      nothing reads that answer, production is one long-lived Node process on Railway where Next's
 *      `after()` completes the task once the response has closed, and outside a request scope the
 *      task is simply awaited as before. Its failure is logged inside the task exactly as it was.
 *
 * NO CUSTOMER IS ATTACHED, deliberately. A blocked permission is a fact about the PHONE — the same
 * switch blocks every customer on the list, and a row tied to whichever one happened to be on screen
 * would read as a problem with that place. The board prints it as "not tied to a customer", which is
 * exactly what it is.
 */
export async function recordBlockedPermission(input: BlockedPermissionInput): Promise<void> {
  try {
    // Stamped when the report ARRIVED, never when the deferred insert happens to run.
    const refusedAt = new Date();
    const row = {
      subject_kind: input.subjectKind,
      reason: "blocked",
      // Paired with the reason by the table's own CHECK (20261013163001): a 'blocked' row without
      // it is refused by the database, and no other reason may carry it.
      blocked_permission: input.permission,
      seat_id: input.seatId,
      rep_hr_id: input.repHrId.toUpperCase(),
      customer_id: null,
      refused_at: refusedAt.toISOString(),
      visit_date: cairoBusinessDay(refusedAt),
      // Every reading column stays null on purpose: there was no position and no photo to report,
      // and a 0 here would read as a rep standing exactly on the pin.
      is_test: input.isTest,
    };
    // Rule 3: after the 204. The task swallows its own failure, so `afterResponse` never has one.
    await afterResponse("phoenix_crm_blocked_permission", async () => {
      try {
        const { error } = await getSupabaseAdmin().from("phoenix_crm_refused_readings").insert(row);
        if (error) {
          console.error("[phoenix-crm] blocked permission not recorded", { seatId: input.seatId, message: error.message });
        }
      } catch (error) {
        console.error("[phoenix-crm] blocked permission record failed", { seatId: input.seatId, error });
      }
    });
  } catch (error) {
    console.error("[phoenix-crm] blocked permission record failed", { seatId: input.seatId, error });
  }
}
