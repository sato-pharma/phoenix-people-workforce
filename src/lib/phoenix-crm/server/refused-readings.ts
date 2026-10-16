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
import { PLACE_MAX_ACCURACY_METERS, refusedReadingOf, type PlaceDraft } from "@/lib/phoenix-crm/entry-rules";
import { type BlockedPermission } from "@/lib/phoenix-crm/refused-readings-rules";
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
