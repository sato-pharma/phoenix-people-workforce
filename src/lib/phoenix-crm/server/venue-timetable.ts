/**
 * Phoenix CRM — a polyclinic's timetable on its own, and settling the customers seated in it.
 *
 * Owner, 2026-10-10: a customer the Super Admin moves into a polyclinic is counted on his visits "but
 * it will not be included in KPIs until the timetable of the doctor in the polyclinic is updated … we
 * validate the polyclinic normally as we validate anything, and we validate the customer inside the
 * polyclinic by the timetable."
 *
 * Until that day a venue's timetable was only ever written as a side effect of a rep seating somebody
 * in it, so a building whose customers had all been moved in by the Super Admin had nobody left to seat
 * and could never get a board. This is the door that closes that gap: a rep photographs the board
 * without seating anybody, and every customer seated there is then read against it.
 *
 * 🔴 `unjudged` NEVER holds. The read runs silently after the commit, never throws, and an outage at the
 * model's end leaves every customer exactly as he was (phoenix_crm_settle_venue_timetable).
 */

import { validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { readTestFlag, territoryForValidation, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, throwIfError } from "@/lib/phoenix-crm/server/db";
import { judgeScheduleBoard, readScheduleBoard, recordPlaceSchedule } from "@/lib/phoenix-crm/server/schedule-check";
import { signboardNameIsUsable } from "@/lib/phoenix-crm/signboard-rules";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export type SettledVenue = { validated: number; held: number };

/**
 * Read the building's board for every customer seated in it that has no verdict yet, then let the
 * database settle each one. Void on a venue with no board: the database still holds them out of the
 * KPIs, structurally, with nothing to read.
 */
export async function settleVenueTimetable(input: {
  viewer: PhoenixCrmViewer;
  seatId: string;
  isTest: boolean;
  sharedPlaceId: string;
  schedulePhotoPath: string | null;
}): Promise<SettledVenue> {
  const { viewer, seatId, isTest, sharedPlaceId, schedulePhotoPath } = input;
  if (schedulePhotoPath) {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_places")
      .select("id, customer_id")
      .eq("shared_place_id", sharedPlaceId)
      .eq("status", "active")
      .is("schedule_check", null);
    throwIfError(error);
    const places = (data ?? []) as Row[];
    const ids = [...new Set(places.map((place) => String(place.customer_id)))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const customers = await getSupabaseAdmin().from("phoenix_crm_customers").select("id, name").in("id", ids);
      throwIfError(customers.error);
      for (const row of (customers.data ?? []) as Row[]) names.set(String(row.id), String(row.name ?? ""));
    }
    // 🔴 THE BOARD IS READ ONCE, NOT ONCE PER DOCTOR (2026-10-16 Phoenix CRM performance audit). The
    // question put to the model names nobody — "who is on this schedule, and at what hours" — so every
    // doctor seated behind this door is judged against the ONE reading, his own name held against it
    // exactly as `readPlaceSchedule` holds it. It used to download, crop and send the same photograph
    // once per doctor, one after another, while the rep waited at the board. Nothing is read when no
    // seated doctor has a usable name, as before, and each verdict is still kept on his own row.
    const judged = places
      .map((place) => ({ place, name: names.get(String(place.customer_id)) ?? "" }))
      .filter(({ name }) => signboardNameIsUsable(name));
    if (judged.length > 0) {
      const board = await readScheduleBoard({
        isTest,
        photoPath: schedulePhotoPath,
        repHrId: viewer.hrId,
        reusedTimetable: true,
        seatId,
      });
      // Each write is its own row and never throws (`recordPlaceSchedule`), so they go a few at a time.
      await mapWithConcurrency(judged, 4, ({ place, name }) => recordPlaceSchedule(String(place.id), judgeScheduleBoard(board, name)));
    }
  }
  const result = await callPhoenixCrm<Row>("phoenix_crm_settle_venue_timetable", {
    p: { seat_id: seatId, actor_hr_id: viewer.hrId, is_test: isTest, shared_place_id: sharedPlaceId },
  });
  return {
    validated: Array.isArray(result.validated) ? result.validated.length : 0,
    held: Array.isArray(result.held) ? result.held.length : 0,
  };
}

export type AddedVenueTimetable = { sharedPlaceId: string; replaced: boolean } & SettledVenue;

/** The rep, or a manager of the territory, photographs a building's timetable — first time or replaced. */
export async function addVenueTimetable(viewer: PhoenixCrmViewer, raw: unknown): Promise<AddedVenueTimetable> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  const { seat, isTest } = territoryForValidation(viewer, body.seatId, readTestFlag(body.test));
  if (!isUuid(body.sharedPlaceId)) throw validationError("Choose the polyclinic or centre the timetable belongs to.");
  const photoPath = typeof body.photoPath === "string" ? body.photoPath.trim() : "";
  if (!photoPath) throw validationError("Take a photo of the timetable first.");
  const result = await callPhoenixCrm<Row>("phoenix_crm_set_venue_timetable", {
    p: {
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      shared_place_id: String(body.sharedPlaceId).toLowerCase(),
      photo_path: photoPath,
    },
  });
  const sharedPlaceId = String(result.shared_place_id);
  // A REPLACED board makes every earlier verdict about a different photograph, so they are read again.
  if (result.replaced === true) {
    const { error } = await getSupabaseAdmin()
      .from("phoenix_crm_places")
      .update({ schedule_check: null })
      .eq("shared_place_id", sharedPlaceId)
      .eq("status", "active");
    throwIfError(error);
  }
  const settled = await settleVenueTimetable({
    viewer,
    seatId: seat.seatId,
    isTest,
    sharedPlaceId,
    schedulePhotoPath: String(result.schedule_photo_path),
  });
  return { sharedPlaceId, replaced: result.replaced === true, ...settled };
}
