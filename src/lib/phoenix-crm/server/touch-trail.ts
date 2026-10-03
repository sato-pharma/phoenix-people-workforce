/**
 * Phoenix CRM — filing the touch trail.
 *
 * Owner, 2026-10-03: "every click or every touch … automatically saved … like a file manager grabber."
 *
 * THREE RULES, THE SAME THREE `refused-readings.ts` OBEYS, PLUS ONE THIS TABLE'S VOLUME ADDS.
 *
 *   1. THE REP LEARNS NOTHING NEW. Nothing here changes a screen, a message or a figure, and the
 *      route it serves answers 204 whatever happened inside, so even a browser watching the network
 *      tab sees one empty reply. (Golden rule #1.)
 *
 *   2. IT MUST NEVER COST A REP HIS WORK. Every path returns void and swallows what it can produce.
 *      An insert that fails is a trail with a hole in it, never a rep who is blocked.
 *
 *   3. IT IS AWAITED, because the browser already stopped waiting: the request is a background flush,
 *      so paying for the insert inside the invocation costs the rep nothing and a fire-and-forget
 *      promise would die with the serverless invocation — the hole `refused-readings.ts` was written
 *      to close.
 *
 *   4. 🔴 THE ACTOR AND THE TEST FLAG COME FROM THE SESSION, NEVER FROM THE BODY. Everything else in a
 *      row is the browser's own account of itself and is read as such; those two are the only fields
 *      an investigation leans on, so they are resolved server-side. A browser claiming `test: true`
 *      can only ADD the flag a test persona already carries, never clear it.
 */

import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import type { TouchTrailBatch } from "@/lib/phoenix-crm/touch-trail";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type RecordTouchTrailInput = {
  /** Whoever is signed in — on a manager's entry-for-a-rep, the MANAGER. Resolved from the session. */
  actorHrId: string;
  batch: TouchTrailBatch;
  isTest: boolean;
};

export async function recordTouchTrail({ actorHrId, batch, isTest }: RecordTouchTrailInput): Promise<void> {
  try {
    const arrivedAt = new Date();
    const occurredAt = arrivedAt.toISOString();
    // The Cairo VISIT day, which ends at 02:00 (owner, 2026-09-29) — the same arithmetic the visit
    // itself uses, so an evening of taps files under the day the rep was working rather than under
    // the server's UTC midnight.
    const visitDay = cairoBusinessDay(arrivedAt);
    const rows = batch.events.map((event) => ({
      actor_hr_id: actorHrId,
      seat_id: batch.seatId,
      session_id: batch.sessionId,
      ms_since_load: event.msSinceLoad,
      // The SERVER's clock, stamped once for the batch: forty events share one arrival, and
      // `ms_since_load` is what orders them inside it to the millisecond.
      occurred_at: occurredAt,
      device_at: event.deviceAt,
      visit_day: visitDay,
      kind: event.kind,
      route: event.route,
      screen: event.screen,
      element: event.element,
      element_label: event.elementLabel,
      value: event.value,
      value_length: event.valueLength,
      pointer_x: event.pointerX,
      pointer_y: event.pointerY,
      viewport_w: event.viewportW,
      viewport_h: event.viewportH,
      is_test: isTest,
    }));
    if (rows.length === 0) return;
    const { error } = await getSupabaseAdmin().from("phoenix_crm_touch_trail").insert(rows);
    if (error) {
      // Logged, never surfaced: the browser is not waiting on this and the rep cannot see it.
      console.error("[phoenix-crm] touch trail not recorded", {
        sessionId: batch.sessionId,
        events: rows.length,
        message: error.message,
      });
    }
  } catch (error) {
    console.error("[phoenix-crm] touch trail record failed", { sessionId: batch.sessionId, error });
  }
}
