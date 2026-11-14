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
 *
 * 🔴 THE PHOTOGRAPH IS READ BEFORE IT BECOMES THE BUILDING'S BOARD (Phoenix CRM validation audit,
 * 14 Nov 2026). This door used to store whatever it was sent and read it afterwards, so a picture of a
 * wall replaced a good board, every verdict behind it was read again as "no timetable", and the settle
 * sent every customer in the building out of the KPIs with nobody told. A photograph the reader is sure
 * shows no timetable is now refused first, in the seating door's own words (`venueTimetableRefusal`),
 * and nothing is written. That one reading is then the one the settle judges on, so the board is still
 * read once.
 */

import { hasAiApiKey } from "@/lib/ai/openai-client";
import { validationError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import {
  SCHEDULE_REREAD_REASONS,
  SCHEDULE_RETAKE_CODE,
  scheduleNeedsReread,
  scheduleRereadToKeep,
  venueTimetableRefusal,
} from "@/lib/phoenix-crm/schedule-rules";
import { readTestFlag, territoryForValidation, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { judgeScheduleBoard, readScheduleBoard, recordPlaceSchedule, type ScheduleBoardReading } from "@/lib/phoenix-crm/server/schedule-check";
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
  /** The reading of this same photograph the caller already holds, so it is not read a second time. */
  board?: ScheduleBoardReading;
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
      const board =
        input.board ??
        (await readScheduleBoard({
          isTest,
          photoPath: schedulePhotoPath,
          repHrId: viewer.hrId,
          reusedTimetable: true,
          seatId,
        }));
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
  // Read BEFORE anything is written, through the door that reads a photo this person has just taken. A
  // reader that never answered refuses nobody: the photo is stored and `unjudged` never holds.
  const board = await readScheduleBoard({ isTest, photoPath, repHrId: viewer.hrId, seatId: seat.seatId });
  const refusal = board.kind === "read" ? venueTimetableRefusal(board) : null;
  if (refusal) throw validationError(refusal, SCHEDULE_RETAKE_CODE);
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
  // 🔴 THE BOARD IS SAVED BY NOW, SO NOTHING BELOW MAY ANSWER AN ERROR FOR IT (Phoenix CRM validation
  // audit, 14 Nov 2026). A failed read or settle used to reach the rep as a failure of a photograph that
  // was stored, and his retry was then refused as a photo already used. It is logged, and the customers
  // stay exactly as they were until the next settle of this building.
  let settled: SettledVenue = { validated: 0, held: 0 };
  try {
    // A REPLACED board makes every earlier verdict about a different photograph, so they are read again.
    if (result.replaced === true) {
      const { error } = await getSupabaseAdmin()
        .from("phoenix_crm_places")
        .update({ schedule_check: null })
        .eq("shared_place_id", sharedPlaceId)
        .eq("status", "active");
      throwIfError(error);
    }
    settled = await settleVenueTimetable({
      viewer,
      seatId: seat.seatId,
      isTest,
      sharedPlaceId,
      schedulePhotoPath: String(result.schedule_photo_path),
      board,
    });
  } catch (error) {
    logError("Phoenix CRM venue timetable was saved but not settled", { error, labels: { event: "phoenix_crm_venue_timetable_settle_failed" } });
  }
  return { sharedPlaceId, replaced: result.replaced === true, ...settled };
}

// ── A timetable the door got no answer about, read again at night ───────────────────────────────

/** Photographs read again in one night, how long the pass may keep starting them, and each read's wait. */
export const LOST_TIMETABLE_REREAD_LIMIT = 200;
export const LOST_TIMETABLE_REREAD_BUDGET_MS = 60_000;
export const LOST_TIMETABLE_REREAD_TIMEOUT_MS = 30_000;

export type LostTimetableRereadResult = {
  /** Seated places whose row now carries a real answer. */
  read: number;
  /** Of those, the board names the customer. */
  matched: number;
  /** Places the reader still did not answer about; one of their re-reads is spent. */
  unanswered: number;
  moreWaiting: boolean;
  skipped: "no_api_key" | null;
};

/**
 * The night's re-read of every seated place whose timetable the door never got an answer about
 * (`scheduleNeedsReread` holds the ruling and its fences). Allowed to throw on the backlog read, like
 * the passes beside it — a night that failed must reach the dead-man's switch as one — and never on one
 * photograph.
 *
 * 🔴 IT ONLY WRITES `schedule_check`. No settle, no review, no notice: a seated customer is never
 * de-validated by a pass nobody watches, and the building's own settle keeps its one meaning (a board a
 * rep has just photographed). One photograph is read once however many customers are seated behind it,
 * and a reading already stored for it is used instead of a call (`readScheduleBoard`).
 */
export async function runLostTimetableRereads(
  options: { limit?: number; budgetMs?: number } = {},
): Promise<LostTimetableRereadResult> {
  const result: LostTimetableRereadResult = { matched: 0, moreWaiting: false, read: 0, skipped: null, unanswered: 0 };
  if (!hasAiApiKey()) return { ...result, skipped: "no_api_key" };
  const limit = Math.max(1, Math.min(options.limit ?? LOST_TIMETABLE_REREAD_LIMIT, 500));
  const deadline = Date.now() + (options.budgetMs ?? LOST_TIMETABLE_REREAD_BUDGET_MS);

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_places")
    .select("id, customer_id, seat_id, created_by_hr_id, photo_path, shared_place_id, schedule_check")
    .eq("status", "active")
    .eq("is_test", false)
    .not("shared_place_id", "is", null)
    .not("photo_path", "is", null)
    .or(`schedule_check.is.null,and(schedule_check->>verdict.eq.unjudged,schedule_check->>reason.in.(${SCHEDULE_REREAD_REASONS.join(",")}))`)
    .order("id", { ascending: true })
    // One page, under PostgREST's 1,000-row ceiling by construction.
    .limit(limit);
  throwIfError(error);
  const page = (data ?? []) as Row[];
  result.moreWaiting = page.length >= limit;
  const rows = page.filter((row) => scheduleNeedsReread(row.schedule_check ?? null));
  if (rows.length === 0) return result;

  const [customers, venues] = await Promise.all([
    selectByIds<Row>("phoenix_crm_customers", "id, name", "id", rows.map((row) => String(row.customer_id))),
    selectByIds<Row>("phoenix_crm_shared_places", "id, status, timetable_exempt_at, schedule_photo_path", "id", rows.map((row) => String(row.shared_place_id))),
  ]);
  const nameOf = new Map(customers.map((row) => [String(row.id), String(row.name ?? "")]));
  const venueOf = new Map(venues.map((row) => [String(row.id), row]));

  // One group per photograph: the question put to it names nobody.
  const groups = new Map<string, Array<{ row: Row; name: string }>>();
  for (const row of rows) {
    const venue = venueOf.get(String(row.shared_place_id));
    // A building declared to have no timetable keeps its door photo here, and a retired one is nobody's.
    if (!venue || venue.status === "retired" || venue.timetable_exempt_at) continue;
    // 🔴 A BUILDING WITH NO BOARD HAS NOTHING TO READ. A customer the Super Admin moved into it keeps his
    // OWN door photo on the row until a board exists; reading that as a timetable would leave a verdict
    // about a doorway, and the building's first settle would then act on it.
    if (!venue.schedule_photo_path) continue;
    const name = nameOf.get(String(row.customer_id)) ?? "";
    // The door's own guard: a name too short to match is never held against a wall of names.
    if (!signboardNameIsUsable(name)) continue;
    // A lost call is asked again about the photograph the door asked about; a row nobody has read is
    // read against the building's board, exactly as the building's own settle reads it.
    const photoPath = String(row.schedule_check ? row.photo_path : venue.schedule_photo_path);
    groups.set(photoPath, [...(groups.get(photoPath) ?? []), { row, name }]);
  }

  for (const [photoPath, seated] of groups) {
    if (Date.now() >= deadline) {
      result.moreWaiting = true;
      break;
    }
    try {
      const first = seated[0].row;
      // The download door wants the seat the photograph was uploaded under, which is not always the seat
      // of the customer seated behind it. One row by its own path; a miss falls back to his seat.
      const upload = await getSupabaseAdmin().from("phoenix_crm_photo_uploads").select("seat_id").eq("path", photoPath).maybeSingle();
      const uploadSeatId = upload.data?.seat_id ? String(upload.data.seat_id) : String(first.seat_id);
      const ask = () =>
        readScheduleBoard({
          isTest: false,
          photoPath,
          repHrId: String(first.created_by_hr_id ?? ""),
          reusedTimetable: true,
          seatId: uploadSeatId,
          timeoutMs: LOST_TIMETABLE_REREAD_TIMEOUT_MS,
        });
      let board = await ask();
      // A call lost again is tried once more at once, as the signboard night does; nothing else is.
      if (board.kind === "unread" && board.check.reason === "call_failed") board = await ask();
      await mapWithConcurrency(seated, 4, async ({ row, name }) => {
        const judged = judgeScheduleBoard(board, name);
        await recordPlaceSchedule(String(row.id), scheduleRereadToKeep(judged, row.schedule_check ?? null));
        if (judged.verdict === "unjudged" && (SCHEDULE_REREAD_REASONS as readonly unknown[]).includes(judged.reason)) {
          result.unanswered += 1;
          return;
        }
        result.read += 1;
        if (judged.verdict === "match") result.matched += 1;
      });
    } catch (failure) {
      logError("Phoenix CRM lost timetable re-read failed", { error: failure, labels: { event: "phoenix_crm_lost_timetable_reread_failed" } });
    }
  }
  return result;
}
