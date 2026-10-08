import { createOpenAiResponseText, hasOpenAiApiKey, OPENAI_NANO_MODEL } from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/ai/parse-ai-json";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { downloadIssuedPlacePhoto, downloadPhoto } from "@/lib/phoenix-crm/server/photos";
import {
  judgeSignboard,
  signboardUnjudged as unjudged,
  stampBandFraction,
  type PhoenixCrmSignboardCheck,
} from "@/lib/phoenix-crm/signboard-rules";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Read the signboard in a place's own photo.
//
// The judging is next door, in src/lib/phoenix-crm/signboard-rules.ts — the house split, the same one
// duplicate-photos.ts and server/photo-dupes.ts keep. This file fetches bytes, crops Phoenix's own
// caption off them, and asks the question. It decides nothing.
//
// IT NEVER THROWS. Its callers are `validateCustomer` and `addPlace`, which are a rep standing at a
// doorway pressing Save, and a model being busy must never be able to stop that. Every absence comes
// back as an `unjudged` record naming WHY, so the board can always tell NOT CHECKED from CHECKED AND
// CLEAN — the distinction the nightly photo sweep's own rules insist on for the same reason.
//
// Nothing it produces names a model, and `nameScore` is never rendered.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 NOT `OPENAI_ROUTE_BUDGET_MS` (60 s). This call sits inside a rep's save AT THE DOOR, where the
 * module's own budgets are the shutter fix's 8 s and the Google lookup's 6 s. A slow model must never
 * hold somebody standing in the street for a minute; eight seconds and an `unjudged` record is the
 * right failure, and the nightly sweep picks the place up afterwards.
 */
export const PHOENIX_CRM_SIGNBOARD_TIMEOUT_MS = 8_000;

const INSTRUCTIONS =
  "You are looking at a photograph taken by a pharmaceutical sales representative standing in " +
  "front of a medical practice, clinic, hospital or health unit in Egypt. Report only what the " +
  "photograph shows. Transcribe the signboard exactly as written, in its own script (Arabic signs " +
  "stay in Arabic; do not translate or transliterate). List separately the names you read as the " +
  "names of PEOPLE and the names you read as the names of PLACES — a hospital, a centre, a unit, a " +
  "practice. A dark caption strip across the bottom of the image is the system's own stamp: never " +
  "read it as the signboard, and never take a name from it. Set sign_present to false only when " +
  "you are sure no signboard of any kind is in the photograph (a street, a wall, a vehicle " +
  "interior, a sheet of paper); set it to null when you cannot tell. If the signboard is " +
  "unreadable, obscured, cut off, or you are not confident, return null rather than guessing. A null " +
  "answer is expected and useful; a confident wrong answer is not, because a real clinic would be " +
  "doubted on the strength of it.";

const TEXT_FORMAT = {
  format: {
    name: "phoenix_crm_signboard",
    schema: {
      additionalProperties: false,
      properties: {
        sign_present: { type: ["boolean", "null"] as const },
        sign_text: { type: ["string", "null"] as const },
        person_names: { items: { type: "string" as const }, type: ["array", "null"] as const },
        place_names: { items: { type: "string" as const }, type: ["array", "null"] as const },
        note: { type: ["string", "null"] as const },
      },
      required: ["sign_present", "sign_text", "person_names", "place_names", "note"],
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
  return [...new Set(cleaned)].slice(0, 12);
}

/**
 * Crop Phoenix's own caption box off the bottom and return a JPEG of what is left.
 *
 * 🔴 `sharp` IS IMPORTED INSIDE THE FUNCTION, not at the top of the file, for the reason the nightly
 * photo sweep records: a top-level `import sharp` has already taken this system down by 500ing a whole
 * page when the native binary failed to load, and this module is reachable from the route graph.
 *
 * 🔴 NEVER CALL `.stats()` AFTER `.extract()` — it silently measures the SOURCE image, not the
 * extraction, so a measurement taken that way would describe the picture including the stamp.
 */
async function cropStampBand(
  bytes: Uint8Array,
): Promise<{ jpeg: Buffer; croppedFraction: number } | null> {
  try {
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(bytes).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) return null;

    const croppedFraction = stampBandFraction(width, height);
    const keep = Math.max(1, Math.round(height * (1 - croppedFraction)));
    const jpeg = await sharp(bytes)
      .extract({ height: keep, left: 0, top: 0, width })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { croppedFraction, jpeg };
  } catch {
    return null;
  }
}

async function judgeBytes(input: {
  bytes: Uint8Array;
  customerName: string;
  listType: PhoenixCrmListType;
}): Promise<PhoenixCrmSignboardCheck> {
  const cropped = await cropStampBand(input.bytes);
  if (!cropped) return unjudged("call_failed");

  try {
    const response = await createOpenAiResponseText({
      component: "phoenix_crm_signboard",
      input: [
        {
          content: [
            { text: "What does this signboard say, and who is named on it?", type: "input_text" as const },
            {
              // "high" detail: a signboard is small text inside a wide street photograph, and
              // downsampling is exactly what turns a readable sign into a guess.
              detail: "high" as const,
              image_url: `data:image/jpeg;base64,${cropped.jpeg.toString("base64")}`,
              type: "input_image" as const,
            },
          ],
          role: "user" as const,
        },
      ],
      instructions: INSTRUCTIONS,
      maxOutputTokens: 400,
      model: OPENAI_NANO_MODEL,
      purpose: "phoenix-crm-signboard",
      reasoning: { effort: "low" },
      text: TEXT_FORMAT,
      timeoutMs: PHOENIX_CRM_SIGNBOARD_TIMEOUT_MS,
    });

    const parsed = parseAiJson(response.outputText);
    return judgeSignboard({
      croppedFraction: cropped.croppedFraction,
      customerName: input.customerName,
      listType: input.listType,
      note: text(parsed.note),
      personNames: names(parsed.person_names),
      placeNames: names(parsed.place_names),
      signPresent: typeof parsed.sign_present === "boolean" ? parsed.sign_present : null,
      signText: text(parsed.sign_text),
    });
  } catch {
    // Swallowed on purpose. A partial verdict on evidence is worse than none, because the board would
    // render it as though it had been read.
    return unjudged("call_failed", cropped.croppedFraction);
  }
}

/**
 * Read the signboard in a photo a rep is saving right now, before the place row exists.
 *
 * Reached only through the scoped `downloadIssuedPlacePhoto`, never `downloadPhoto`: this runs inside
 * a request, so the path has to be one the server itself issued to this person for this territory.
 */
export async function readPlaceSignboard(input: {
  photoPath: string;
  customerName: string;
  listType: PhoenixCrmListType;
  seatId: string;
  repHrId: string;
  isTest: boolean;
}): Promise<PhoenixCrmSignboardCheck> {
  if (!hasOpenAiApiKey()) return unjudged("no_api_key");

  const bytes = await downloadIssuedPlacePhoto({
    hrId: input.repHrId,
    isTest: input.isTest,
    path: input.photoPath,
    seatId: input.seatId,
  }).catch(() => null);
  if (!bytes) return unjudged("no_bytes");

  return judgeBytes({ bytes, customerName: input.customerName, listType: input.listType });
}

/**
 * Read the signboard of a place already in the database, for the nightly sweep.
 *
 * `downloadPhoto` is legitimate here and only here: the sweep runs as the system over rows it found
 * itself, which is the one case that function's own doc permits.
 */
export async function readStoredPlaceSignboard(input: {
  photoPath: string;
  customerName: string;
  listType: PhoenixCrmListType;
}): Promise<PhoenixCrmSignboardCheck> {
  if (!hasOpenAiApiKey()) return unjudged("no_api_key");
  const bytes = await downloadPhoto(input.photoPath).catch(() => null);
  if (!bytes) return unjudged("no_bytes");
  return judgeBytes({ bytes, customerName: input.customerName, listType: input.listType });
}

/**
 * Keep the verdict on the place row.
 *
 * A plain update, NOT part of `phoenix_crm_validate_customer`'s transaction, and deliberately so: the
 * verdict is a RECORD and the gate is `hold_review`, which the RPC already writes atomically with the
 * row. Putting the record inside it would mean rebuilding a 300-line security-definer function from
 * `pg_proc.prosrc` for no correctness gain. If this update loses, a held place still carries its
 * evidence on its review row and the sweep fills the rest in.
 *
 * Void and never throws: it runs after the place is saved, and nothing it does may turn a successful
 * validation into an error the rep sees.
 */
export async function recordPlaceSignboard(
  placeId: string,
  check: PhoenixCrmSignboardCheck,
): Promise<void> {
  if (!placeId) return;
  try {
    const { error } = await getSupabaseAdmin()
      .from("phoenix_crm_places")
      .update({ signboard_check: check })
      .eq("id", placeId);
    throwIfError(error);
  } catch {
    // Deliberately silent — see the doc above.
  }
}
