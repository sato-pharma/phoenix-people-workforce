import { createOpenAiResponseText, hasOpenAiApiKey, OPENAI_NANO_MODEL } from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/ai/parse-ai-json";
import {
  judgeSchedule,
  type PhoenixCrmScheduleCheck,
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

const INSTRUCTIONS =
  "You are looking at a photograph of a printed or handwritten schedule on the wall of a polyclinic, " +
  "medical centre or hospital outpatient department in Egypt. It lists the people who receive there " +
  "and the days and hours each of them receives. Report only what the photograph shows. Transcribe " +
  "the schedule as written, in its own script (Arabic stays in Arabic; do not translate or " +
  "transliterate). List separately the names you read as the names of PEOPLE. A dark caption strip " +
  "across the bottom of the image is the system's own stamp: never read it as part of the schedule, " +
  "and never take a name from it. Set schedule_present to false only when you are sure no schedule " +
  "or timetable of any kind is in the photograph (a wall, a shopfront, a street, a prescription); " +
  "set it to null when you cannot tell. If the schedule is unreadable, obscured, cut off, or you are " +
  "not confident, return null rather than guessing. A null answer is expected and useful; a confident " +
  "wrong answer is not, because a real clinic would be doubted on the strength of it.";

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
        note: { type: ["string", "null"] as const },
      },
      required: ["schedule_present", "schedule_text", "person_names", "hours_read", "note"],
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
      note: string | null;
      personNames: string[];
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
      note: board.note,
      personNames: board.personNames,
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
 */
export async function readScheduleBoard(input: {
  photoPath: string;
  seatId: string;
  repHrId: string;
  isTest: boolean;
  reusedTimetable?: boolean;
}): Promise<ScheduleBoardReading> {
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

  const cropped = await cropStampBand(bytes);
  if (!cropped) return { kind: "unread", check: unjudged("call_failed") };

  try {
    const response = await createOpenAiResponseText({
      component: "phoenix_crm_schedule",
      input: [
        {
          content: [
            { text: "Who is on this schedule, and at what hours?", type: "input_text" as const },
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
      maxOutputTokens: 700,
      model: OPENAI_NANO_MODEL,
      purpose: "phoenix-crm-schedule",
      reasoning: { effort: "low" },
      text: TEXT_FORMAT,
      timeoutMs: PHOENIX_CRM_SCHEDULE_TIMEOUT_MS,
    });

    const parsed = parseAiJson(response.outputText);
    return {
      kind: "read",
      croppedFraction: cropped.croppedFraction,
      hoursRead: text(parsed.hours_read),
      note: text(parsed.note),
      personNames: names(parsed.person_names),
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
