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
 *   3. 🔴 IT IS AWAITED, UNLIKE THE INTEGRITY JUDGEMENT, AND THAT IS DELIBERATE. `judgeCapture` runs
 *      after a save has already returned; this one runs while the request is still open, so a
 *      fire-and-forget promise can be killed with the serverless invocation and record nothing —
 *      which is precisely the hole being closed. One bounded insert is paid before an error message
 *      the rep is waiting for anyway. If that ever becomes the wrong trade, the fix is a queue, never
 *      an unawaited promise.
 */

import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { refusedReadingOf } from "@/lib/phoenix-crm/entry-rules";
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
