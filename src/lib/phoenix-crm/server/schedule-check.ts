import { createOpenAiResponseText, hasOpenAiApiKey } from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/ai/parse-ai-json";
import {
  judgeSchedule,
  parseScheduleLegibility,
  parseScheduleProblem,
  type PhoenixCrmScheduleCheck,
  type ScheduleLegibility,
  type ScheduleProblem,
  scheduleUnjudged as unjudged,
} from "@/lib/phoenix-crm/schedule-rules";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { downloadIssuedPlacePhoto, downloadVenueTimetablePhoto } from "@/lib/phoenix-crm/server/photos";
import { cropStampBand } from "@/lib/phoenix-crm/server/signboard-check";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Read the TIMETABLE in the photo a rep took when he seated a customer in a shared place.
//
// The judging is next door, in src/lib/phoenix-crm/schedule-rules.ts — the house split, the same one
// signboard-check.ts keeps. This file fetches bytes, crops Phoenix's own caption off them, and asks
// the question. It decides nothing.
//
// IT NEVER THROWS. Its caller is a rep standing inside a polyclinic pressing Save, and a model being
// busy must never be able to stop that. Every absence comes back as an `unjudged` record naming WHY.
//
// 🔴 THE CROP IS NOT OPTIONAL HERE, IT IS THE WHOLE CORRECTNESS OF THE CHECK. `live-photo-capture`
// burns "Phoenix CRM customer: <name>" into the image before the Blob exists, so reading the stored
// object directly would read that customer's name off Phoenix's own caption and report "the timetable
// names him" about a photograph of a bare wall — a guaranteed false pass, every time. `cropStampBand`
// is therefore shared with the signboard reader rather than re-derived.
//
// Nothing it produces names a model, and `nameScore` is never rendered.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The same budget the signboard read takes, and for the same reason: he is standing in a corridor. */
export const PHOENIX_CRM_SCHEDULE_TIMEOUT_MS = 8_000;

/**
 * The model the door reads a timetable with. Chosen by replaying the production timetables through
 * each candidate before the scanner shipped (2026-10-17) — see docs/phoenix-crm-shared-places.md,
 * "The timetable scanner". A scanner that refuses a REAL timetable is worse than no scanner, so the
 * choice is the measured one, never the cheapest by default: on the 40 production photos the cheap
 * tier read a name off 5 and called the clear 25-name directory board "unreadable"; this one read
 * names off 17, the seated customer's included, at 2.6 s median and 6.2 s at p95 — inside the door's
 * 8 s. Never move it back to nano to save money without replaying those photos first.
 */
export const PHOENIX_CRM_SCHEDULE_MODEL = "gpt-5.4-mini";

const INSTRUCTIONS =
  "You are looking at a photograph a pharmaceutical sales representative took of the TIMETABLE on the " +
  "wall of a polyclinic, medical centre or hospital outpatient department in Egypt: a printed or " +
  "handwritten list, a framed sheet or a directory board naming the people who receive there and the " +
  "days and hours each of them receives. The photograph may be rotated sideways or upside down; read " +
  "it in whatever orientation its text runs. Report only what the photograph shows.\n\n" +
  "List every name you read as the name of a PERSON, as written, in its own script (Arabic stays in " +
  "Arabic; do not translate or transliterate). In schedule_text give only the schedule's heading and a " +
  "few of its lines, at most 300 characters, and in hours_read at most 200 characters — the names are " +
  "what matters, so never spend the answer transcribing the whole board. A dark caption strip " +
  "across the bottom of the image is the system's own stamp: never read it as part of the schedule, " +
  "and never take a name from it.\n\n" +
  "Say how well you could read the schedule — legibility \"clear\" only when you could read every " +
  "name on it, \"partial\" when some of it defeated you, \"unreadable\" when you can see a schedule is " +
  "there but cannot read its names. Say what is wrong with the photograph, if anything: " +
  "\"not_a_timetable\" when no schedule of any kind is in it (a street, a pavement, a floor, a door, a " +
  "signboard, a person, a car), \"too_far\" when the names are too small to read, \"blurred\", " +
  "\"glare\" when a reflection covers it, \"cut_off\" when part of the schedule is outside the frame, " +
  "and \"none\" when nothing is wrong.\n\n" +
  "Set schedule_present to false only when you are sure no schedule or timetable of any kind is in the " +
  "photograph; set it to null when you cannot tell. If a part is unreadable, report what you did read " +
  "and say \"partial\" — never guess a name. A confident wrong answer is worse than none, because a real " +
  "clinic would be doubted on the strength of it.";

const TEXT_FORMAT = {
  format: {
    name: "phoenix_crm_schedule",
    schema: {
      additionalProperties: false,
      properties: {
        schedule_present: { type: ["boolean", "null"] as const },
        schedule_text: { type: ["string", "null"] as const },
        person_names: { items: { type: "string" as const }, type: ["array", "null"] as const },
        hours_read: { type: ["string", "null"] as const },
        legibility: { enum: ["clear", "partial", "unreadable"] as const, type: "string" as const },
        problem: { enum: ["none", "not_a_timetable", "too_far", "blurred", "glare", "cut_off"] as const, type: "string" as const },
        note: { type: ["string", "null"] as const },
      },
      required: ["schedule_present", "schedule_text", "person_names", "hours_read", "legibility", "problem", "note"],
      strict: true as const,
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 && trimmed.toLowerCase() !== "null" ? trimmed : null;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned = value.map((entry) => text(entry)).filter((entry): entry is string => entry !== null);
  // A polyclinic's board legitimately lists more people than a signboard ever would.
  return [...new Set(cleaned)].slice(0, 40);
}

/**
 * Read the timetable in a photo a rep is saving right now, before the place row exists.
 *
 * Reached only through a scoped download door, never `downloadPhoto`: this runs inside
 * a request, so the path has to be one the server itself issued to this person for this territory.
 */
export async function readPlaceSchedule(input: {
  photoPath: string;
  customerName: string;
  seatId: string;
  repHrId: string;
  isTest: boolean;
  /**
   * 🔴 The timetable is the BUILDING's and is photographed once (owner, 2026-10-10), so the second
   * doctor seated in it is read from a photo a DIFFERENT rep uploaded. `downloadIssuedPlacePhoto`
   * requires the slot to have been issued to the rep saving now and would answer null — reported as
   * `unjudged("no_bytes")`, a verdict lost in silence. The venue door drops that one condition and
   * keeps every other.
   */
  reusedTimetable?: boolean;
}): Promise<PhoenixCrmScheduleCheck> {
  return judgeScheduleBoard(await readScheduleBoard(input), input.customerName);
}

/**
 * What one photograph of a board SAYS, before anybody's name is held against it — or the verdict that
 * stands for every name when it could not be read.
 *
 * 🔴 THE QUESTION PUT TO THE MODEL NAMES NOBODY (2026-10-16 Phoenix CRM performance audit). It asks who
 * is on the schedule and at what hours; the customer's name is used only by `judgeSchedule`, afterwards.
 * So a building's board is read ONCE however many doctors are seated behind its door, and each one is
 * judged against that one reading (`judgeScheduleBoard`) — where it used to download, crop and send the
 * same image to the model once per doctor.
 */
export type ScheduleBoardReading =
  | { kind: "unread"; check: PhoenixCrmScheduleCheck }
  | {
      kind: "read";
      croppedFraction: number;
      hoursRead: string | null;
      legibility: ScheduleLegibility | null;
      note: string | null;
      personNames: string[];
      problem: ScheduleProblem | null;
      schedulePresent: boolean | null;
      scheduleText: string | null;
    };

/** One customer's verdict on a board already read. Never throws, as `readPlaceSchedule` never did. */
export function judgeScheduleBoard(board: ScheduleBoardReading, customerName: string): PhoenixCrmScheduleCheck {
  if (board.kind === "unread") return { ...board.check };
  try {
    return judgeSchedule({
      croppedFraction: board.croppedFraction,
      customerName,
      hoursRead: board.hoursRead,
      legibility: board.legibility,
      note: board.note,
      personNames: board.personNames,
      problem: board.problem,
      schedulePresent: board.schedulePresent,
      scheduleText: board.scheduleText,
    });
  } catch {
    // Swallowed on purpose. A partial verdict on evidence is worse than none, because the board would
    // render it as though it had been read.
    return unjudged("call_failed", board.croppedFraction);
  }
}

/**
 * Read a board's photograph: the scoped download, the crop and the one model call `readPlaceSchedule`
 * makes, without the name. Never throws — every absence is an `unread` reading naming WHY.
 *
 * 🔴 A BOARD ALREADY READ IS NOT READ AGAIN (2026-10-17). The same photograph of one building's board
 * used to be sent to the model once per customer seated against it, and the same image came back
 * "no timetable" for one customer and "unreadable" for the next — measured on 3 of the 15 boards that
 * carry 48 of production's seatings. A reused board is judged against the reading already stored on a
 * place seated behind it, when that reading could see the board (`clear` or `partial`); one photograph,
 * one reading. A board nobody could read is read again, because that reading is exactly what is in doubt.
 */
export async function readScheduleBoard(input: {
  photoPath: string;
  seatId: string;
  repHrId: string;
  isTest: boolean;
  reusedTimetable?: boolean;
}): Promise<ScheduleBoardReading> {
  if (input.reusedTimetable) {
    const stored = await storedBoardReading(input.photoPath, input.isTest);
    if (stored) return stored;
  }
  if (!hasOpenAiApiKey()) return { kind: "unread", check: unjudged("no_api_key") };

  const bytes = await (input.reusedTimetable
    ? downloadVenueTimetablePhoto({ isTest: input.isTest, path: input.photoPath, seatId: input.seatId })
    : downloadIssuedPlacePhoto({
        hrId: input.repHrId,
        isTest: input.isTest,
        path: input.photoPath,
        seatId: input.seatId,
      })
  ).catch(() => null);
  if (!bytes) return { kind: "unread", check: unjudged("no_bytes") };

  return readScheduleBytes(bytes);
}

/**
 * The crop and the one model call, on bytes already in hand. Exported so the calibration replay
 * (docs/phoenix-crm-shared-places.md, "The timetable scanner") reads a photograph through EXACTLY the
 * door's question rather than a copy of it. Never throws.
 */
export async function readScheduleBytes(
  bytes: Uint8Array,
  options: { model?: string; timeoutMs?: number } = {},
): Promise<ScheduleBoardReading> {
  const cropped = await cropStampBand(bytes);
  if (!cropped) return { kind: "unread", check: unjudged("call_failed") };

  try {
    const response = await createOpenAiResponseText({
      component: "phoenix_crm_schedule",
      input: [
        {
          content: [
            { text: "Who is on this schedule, and at what hours? How well can you read it, and what is wrong with the photograph?", type: "input_text" as const },
            {
              // "high" detail: a timetable is a grid of small text, and downsampling is exactly what
              // turns a readable row into a guess.
              detail: "high" as const,
              image_url: `data:image/jpeg;base64,${cropped.jpeg.toString("base64")}`,
              type: "input_image" as const,
            },
          ],
          role: "user" as const,
        },
      ],
      instructions: INSTRUCTIONS,
      // 🔴 No retry inside the rep's wait: the SDK's default second attempt turned the 8-second budget
      // into sixteen, the defect the signboard read fixed the same way.
      maxRetries: 0,
      // 🔴 A REAL BOARD IS LONG. At 900 tokens with the whole board transcribed, the stronger readers ran
      // out of room on exactly the photographs that ARE timetables (a 25-name directory board) and the
      // answer arrived cut off — `call_failed`, measured 2026-10-17 on 11 of 40 production photos. The
      // prompt now keeps the transcription short and the names whole; the ceiling leaves room for both.
      maxOutputTokens: 1_600,
      model: options.model ?? PHOENIX_CRM_SCHEDULE_MODEL,
      purpose: "phoenix-crm-schedule",
      reasoning: { effort: "low" },
      text: TEXT_FORMAT,
      timeoutMs: options.timeoutMs ?? PHOENIX_CRM_SCHEDULE_TIMEOUT_MS,
    });

    const parsed = parseAiJson(response.outputText);
    return {
      kind: "read",
      croppedFraction: cropped.croppedFraction,
      hoursRead: text(parsed.hours_read),
      legibility: parseScheduleLegibility(parsed.legibility),
      note: text(parsed.note),
      personNames: names(parsed.person_names),
      // "none" is the schema's way of saying nothing is wrong; it is not a problem.
      problem: parseScheduleProblem(parsed.problem),
      schedulePresent: typeof parsed.schedule_present === "boolean" ? parsed.schedule_present : null,
      scheduleText: text(parsed.schedule_text),
    };
  } catch {
    // Swallowed on purpose. A partial verdict on evidence is worse than none, because the board would
    // render it as though it had been read.
    return { kind: "unread", check: unjudged("call_failed", cropped.croppedFraction) };
  }
}

/**
 * The reading already stored for this photograph on a place seated behind it, when that reading saw
 * the board. Null on anything else — an older record with no legibility, an unreadable one, nothing
 * transcribed, or a failed read — and then the board is read afresh. Never throws.
 */
async function storedBoardReading(photoPath: string, isTest: boolean): Promise<ScheduleBoardReading | null> {
  if (!photoPath) return null;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_places")
      .select("schedule_check")
      .eq("photo_path", photoPath)
      .eq("is_test", isTest)
      .not("shared_place_id", "is", null)
      .not("schedule_check", "is", null)
      .order("created_at", { ascending: false })
      .limit(10);
    throwIfError(error);
    for (const row of (data ?? []) as Array<{ schedule_check: Record<string, unknown> | null }>) {
      const check = row.schedule_check;
      if (!check) continue;
      const legibility = parseScheduleLegibility(check.legibility);
      if (legibility !== "clear" && legibility !== "partial") continue;
      const personNames = names(check.personNames);
      const scheduleText = text(check.scheduleText);
      if (personNames.length === 0 && !scheduleText) continue;
      return {
        kind: "read",
        croppedFraction: typeof check.croppedFraction === "number" ? check.croppedFraction : 0,
        hoursRead: text(check.hoursRead),
        legibility,
        note: text(check.note),
        personNames,
        problem: parseScheduleProblem(check.problem),
        // It saw a board, or it would not have said clear or partial.
        schedulePresent: true,
        scheduleText,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Keep the verdict on the seated place's row, in its own `schedule_check` column.
 *
 * A plain update, NOT part of `phoenix_crm_validate_customer`'s transaction, for the reason
 * `recordPlaceSignboard` records: the verdict is a RECORD and the gate is `hold_review`, which the RPC
 * writes atomically with the row. Void and never throws — it runs after the place is saved, and
 * nothing it does may turn a successful seating into an error the rep sees.
 */
export async function recordPlaceSchedule(placeId: string, check: PhoenixCrmScheduleCheck): Promise<void> {
  if (!placeId) return;
  try {
    const { error } = await getSupabaseAdmin()
      .from("phoenix_crm_places")
      .update({ schedule_check: check })
      .eq("id", placeId);
    throwIfError(error);
  } catch {
    // Deliberately silent — see the doc above.
  }
}
