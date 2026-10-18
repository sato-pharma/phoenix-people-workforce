import {
  createOpenAiResponseText,
  hasAiApiKey,
  OPENAI_NANO_MODEL,
  OPENAI_STRONG_MODEL,
} from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/ai/parse-ai-json";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { downloadIssuedPlacePhoto, downloadPhoto } from "@/lib/phoenix-crm/server/photos";
import {
  chooseSignToReadAgain,
  jsonbSafe,
  judgeSignboards,
  signboardUnjudged as unjudged,
  stampBandFraction,
  type PhoenixCrmSign,
  type PhoenixCrmSignboardCheck,
  type SignboardKind,
  type SignboardLegibility,
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

/**
 * What ONE place may cost the nightly pass, across every call it makes for that place.
 *
 * 🔴 IT IS A BUDGET FOR THE WHOLE PLACE, NOT A TIMEOUT PER CALL, and that is what keeps the night's
 * own arithmetic honest: the sweep reads a place with a second, cropped look when the first does not
 * find him, so a per-call timeout would make one place cost 2 x 25 s and the pass's worst case would
 * silently double. Each call gets what is LEFT of this.
 *
 * 25 s against the door's 8 s because nobody is standing in the street at 03:35, and
 * `SIGNBOARD_SWEEP_BUDGET_MS` (100 s) plus the longest one place can take is 100 + 2 × 25 = 150 s —
 * EXACTLY the 150 s half of the cron's 300 s that `tests/phoenix-crm-signboard-check.test.ts` holds
 * the pass to, which is the line the photo and behaviour passes share.
 *
 * 🔴 THIS SUM SAID "120 s … 145 s" UNTIL 2026-10-12, AND BOTH NUMBERS WERE WRONG. The budget was
 * lowered 120 → 100 s on 2026-10-09 in the same change that made one place able to cost two full
 * reads, and this comment kept the old figure while adding only ONE read to it — so it read as 5 s of
 * headroom where there is none. The real worst case is exactly the limit, not inside it: anything that
 * lets a place make a third read, or raises either constant, breaks the cron's half and must be
 * measured against `signboard-sweep.ts`'s own account of why the ceiling is two.
 */
export const PHOENIX_CRM_SIGNBOARD_SWEEP_BUDGET_MS = 25_000;

/**
 * 🔴 THE NIGHT READS WITH THE STRONG MODEL AND THE DOOR READS WITH THE CHEAP ONE, DELIBERATELY.
 * Of the five places the cheap reader held on its first night (read 2026-10-09), four were held
 * wrongly and three of those were a board it could not read properly — "دكتور أحمد الشرباوي" for
 * الشعراوي, "محمد فريد" for فرج, a room sign for عبدالعال. The door cannot afford this model inside
 * a rep's 8-second save; the night can afford it for every place it reads, and the whole point of
 * the night is that it has no rep waiting on it.
 *
 * The extra cost is small because the SECOND look is only taken when the first found nobody: 5 of
 * the 60 places read on that night, 8%.
 */
export const PHOENIX_CRM_SIGNBOARD_SWEEP_MODEL = OPENAI_STRONG_MODEL;

/** How much of the frame around a sign's own box is kept when the sign is read again on its own. */
export const SIGNBOARD_CROP_MARGIN = 0.06;

/** Which reader is asking: a rep at the door, or the night. */
export type SignboardReadMode = "door" | "sweep";

const INSTRUCTIONS =
  "You are looking at a photograph taken by a pharmaceutical sales representative standing in " +
  "front of a medical practice, clinic, hospital or health unit in Egypt. Report only what the " +
  "photograph shows.\n\n" +
  "LIST EVERY SIGNBOARD, NAMEPLATE, BANNER OR LETTERED PLATE YOU CAN SEE, one entry each, however " +
  "small and whoever it belongs to. An Egyptian doorway commonly carries several: the practice's own " +
  "nameplate, the neighbouring shops, a pharmacy, a building number, a floor directory. Do not " +
  "choose between them and do not merge them — the smallest plate is frequently the one that " +
  "matters, and something else is picked here from the list you return.\n\n" +
  "For each sign: transcribe it exactly as written, in its own script (Arabic signs stay in Arabic; " +
  "do not translate or transliterate); list separately the names you read as the names of PEOPLE and " +
  "the names you read as the names of PLACES (a hospital, a centre, a unit, a practice); give its " +
  "box as fractions of the image (left, top, width, height, each between 0 and 1); say how well you " +
  "could read it — \"clear\" only when you are confident of the WHOLE sign, \"partial\" when some of " +
  "it defeated you, \"unreadable\" when you can see a sign is there but cannot read it; and say what " +
  "trade it belongs to — \"medical\" for a practice, clinic, hospital, laboratory, radiology or " +
  "pharmacy sign, \"other\" for any other trade (a clothes shop, a grocer, a mobile-phone dealer), " +
  "\"unknown\" when you cannot tell.\n\n" +
  "\"partial\" and \"unreadable\" are expected answers and are useful ones: a sign you half-read is " +
  "reported as half-read, never as a clear sign carrying only the part you managed. A faded or " +
  "distant board still gets its own entry, with whatever text you have and its legibility.\n\n" +
  "A dark caption strip across the bottom of the image is the system's own stamp: never read it as a " +
  "signboard, and never take a name from it. Set sign_present to false only when you are sure no " +
  "signboard, plate or lettering of any kind is in the photograph (a street, a bare wall, a vehicle " +
  "interior, a sheet of paper), and return an empty list of signs with it; set it to null when you " +
  "cannot tell. A confident wrong answer is worse than no answer, because a real practice would be " +
  "doubted on the strength of it.";

const BOX_SCHEMA = {
  additionalProperties: false,
  properties: {
    height: { type: ["number", "null"] as const },
    left: { type: ["number", "null"] as const },
    top: { type: ["number", "null"] as const },
    width: { type: ["number", "null"] as const },
  },
  required: ["left", "top", "width", "height"],
  type: ["object", "null"] as const,
};

const SIGN_SCHEMA = {
  additionalProperties: false,
  properties: {
    box: BOX_SCHEMA,
    kind: { enum: ["medical", "other", "unknown"] as const, type: "string" as const },
    legibility: { enum: ["clear", "partial", "unreadable"] as const, type: "string" as const },
    person_names: { items: { type: "string" as const }, type: ["array", "null"] as const },
    place_names: { items: { type: "string" as const }, type: ["array", "null"] as const },
    text: { type: ["string", "null"] as const },
  },
  required: ["text", "person_names", "place_names", "box", "legibility", "kind"],
  type: "object" as const,
};

const TEXT_FORMAT = {
  format: {
    name: "phoenix_crm_signboard",
    schema: {
      additionalProperties: false,
      properties: {
        note: { type: ["string", "null"] as const },
        sign_present: { type: ["boolean", "null"] as const },
        signs: { items: SIGN_SCHEMA, type: ["array", "null"] as const },
      },
      required: ["sign_present", "signs", "note"],
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

/** 0–1, or null. A box outside the frame is no box: the crop would read the wrong part of the photo. */
function fraction(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) return null;
  return Math.round(number * 10000) / 10000;
}

function box(value: unknown): PhoenixCrmSign["box"] {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const left = fraction(raw.left);
  const top = fraction(raw.top);
  const width = fraction(raw.width);
  const height = fraction(raw.height);
  if (left === null || top === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0 || left + width > 1.0001 || top + height > 1.0001) return null;
  return { height, left, top, width };
}

/**
 * 🔴 AN UNRECOGNISED LEGIBILITY READS AS `partial`, NEVER AS `clear`. A reader that answers outside
 * the enum, or a stored row written before the field existed, must not be able to hold a place: only
 * `clear` holds, so the unknown case has to fall on the safe side of that line by construction.
 */
function legibility(value: unknown): SignboardLegibility {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "clear") return "clear";
  if (raw === "unreadable") return "unreadable";
  return "partial";
}

/** Anything but a confident "another trade" counts as possibly the practice's own. */
function kind(value: unknown): SignboardKind {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "medical") return "medical";
  if (raw === "other") return "other";
  return "unknown";
}

/** At most eight signs are kept: a doorway with more than that is a street, not an address. */
function signsFrom(value: unknown): PhoenixCrmSign[] {
  if (!Array.isArray(value)) return [];
  const signs: PhoenixCrmSign[] = [];
  for (const entry of value.slice(0, 8)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const sign: PhoenixCrmSign = {
      box: box(raw.box),
      kind: kind(raw.kind),
      legibility: legibility(raw.legibility),
      personNames: names(raw.person_names),
      placeNames: names(raw.place_names),
      text: text(raw.text),
    };
    if (sign.text === null && sign.personNames.length === 0 && sign.placeNames.length === 0 && !sign.box) continue;
    signs.push(sign);
  }
  return signs;
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
 *
 * Exported for server/schedule-check.ts, which reads a TIMETABLE out of a place photo and has the
 * identical problem: the stamp burns the customer's own name across the bottom, so an uncropped read
 * would find that name on a photograph of a blank wall and report a match every time.
 */
export async function cropStampBand(
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

/**
 * Crop to ONE sign's own box and return it as its own JPEG.
 *
 * 🔴 THIS IS THE STEP THAT FIXES THE LETTERS. A signboard is small text inside a wide street
 * photograph; "high" detail stops the whole frame being thrown away but the sign itself is still a
 * few hundred pixels of it, and that is where الشعراوي came back as الشرباوي and فرج as فريد — two
 * letters lost to scale, not to the model being weak. Read on its own the same sign is most of the
 * image.
 *
 * `sharp` is imported inside the function for the reason `cropStampBand` records above.
 */
export async function cropToBox(
  jpeg: Buffer,
  area: NonNullable<PhoenixCrmSign["box"]>,
): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(jpeg).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) return null;

    const left = Math.max(0, Math.floor((area.left - SIGNBOARD_CROP_MARGIN) * width));
    const top = Math.max(0, Math.floor((area.top - SIGNBOARD_CROP_MARGIN) * height));
    const right = Math.min(width, Math.ceil((area.left + area.width + SIGNBOARD_CROP_MARGIN) * width));
    const bottom = Math.min(height, Math.ceil((area.top + area.height + SIGNBOARD_CROP_MARGIN) * height));
    const keepWidth = right - left;
    const keepHeight = bottom - top;
    // Nothing legible comes out of a crop this small, and asking costs a whole model call.
    if (keepWidth < 64 || keepHeight < 32) return null;

    return await sharp(jpeg)
      .extract({ height: keepHeight, left, top, width: keepWidth })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    return null;
  }
}

type SignboardReading = {
  signs: PhoenixCrmSign[];
  signPresent: boolean | null;
  note: string | null;
};

/**
 * One look at one image. Returns null for every failure — a timeout, a refusal, unparseable JSON —
 * because a partial reading is worse than none here, exactly as the file header says.
 *
 * 🔴 THE CUSTOMER'S NAME IS NEVER IN THIS PROMPT, in either pass. The reader transcribes, this
 * repository judges, and a reader told whose name to expect will find it on a blank wall. It is the
 * same reason the stamp band is cropped off before the image is sent at all.
 */
async function readSigns(input: {
  jpeg: Buffer;
  model: string;
  timeoutMs: number;
  question: string;
}): Promise<SignboardReading | null> {
  if (input.timeoutMs <= 0) return null;
  try {
    const response = await createOpenAiResponseText({
      component: "phoenix_crm_signboard",
      input: [
        {
          content: [
            { text: input.question, type: "input_text" as const },
            {
              // "high" detail: a signboard is small text inside a wide street photograph, and
              // downsampling is exactly what turns a readable sign into a guess.
              detail: "high" as const,
              image_url: `data:image/jpeg;base64,${input.jpeg.toString("base64")}`,
              type: "input_image" as const,
            },
          ],
          role: "user" as const,
        },
      ],
      instructions: INSTRUCTIONS,
      // Several signs, each with a box, do not fit in the 400 one sign needed.
      maxOutputTokens: 1_400,
      // `timeoutMs` is the time LEFT on this check's deadline. The SDK would retry a timeout with a fresh
      // copy of it, and the rep stands at the door for the doubled wait (16.4 s against an 8 s budget).
      maxRetries: 0,
      model: input.model,
      purpose: "phoenix-crm-signboard",
      reasoning: { effort: "low" },
      text: TEXT_FORMAT,
      timeoutMs: input.timeoutMs,
    });

    const parsed = parseAiJson(response.outputText);
    return {
      note: text(parsed.note),
      signPresent: typeof parsed.sign_present === "boolean" ? parsed.sign_present : null,
      signs: signsFrom(parsed.signs),
    };
  } catch {
    return null;
  }
}

const WIDE_QUESTION = "What signs are in this photograph, and who is named on each of them?";
const CLOSE_QUESTION =
  "This is one sign from a photograph, on its own. What does it say, and who is named on it?";

/**
 * Read a place photo and judge it.
 *
 * TWO LOOKS ON THE NIGHTLY PASS, ONE AT THE DOOR.
 *
 *   1. The whole frame, every sign in it. If a sign names him, that is the answer and it is done.
 *   2. 🔴 OTHERWISE THE SIGN THE VERDICT WOULD REST ON IS CROPPED OUT AND READ AGAIN ON ITS OWN, and
 *      THAT READING DECIDES — in every direction, not only when it helps. It is the same sign and
 *      the same model with four to ten times the pixels on the letters, so it is strictly better
 *      evidence: it may turn a hold into a match, it may hold with its own clearer text, and if it
 *      cannot read the sign either then nothing in this photograph was read clearly and the place
 *      goes back in the queue rather than onto the owner's flag list.
 *
 * The door takes neither the strong model nor the second look: a rep is standing in the street on an
 * 8-second budget, and the night picks his place up a few hours later.
 */
async function judgeBytes(input: {
  bytes: Uint8Array;
  customerName: string;
  listType: PhoenixCrmListType;
  mode: SignboardReadMode;
}): Promise<PhoenixCrmSignboardCheck> {
  const cropped = await cropStampBand(input.bytes);
  if (!cropped) return unjudged("call_failed");

  const atTheDoor = input.mode === "door";
  const model = atTheDoor ? OPENAI_NANO_MODEL : PHOENIX_CRM_SIGNBOARD_SWEEP_MODEL;
  const deadline =
    Date.now() + (atTheDoor ? PHOENIX_CRM_SIGNBOARD_TIMEOUT_MS : PHOENIX_CRM_SIGNBOARD_SWEEP_BUDGET_MS);
  const remaining = (): number => deadline - Date.now();

  const wide = await readSigns({ jpeg: cropped.jpeg, model, question: WIDE_QUESTION, timeoutMs: remaining() });
  if (!wide) return unjudged("call_failed", cropped.croppedFraction);

  const judged = judgeSignboards({
    croppedFraction: cropped.croppedFraction,
    customerName: input.customerName,
    listType: input.listType,
    note: wide.note,
    signPresent: wide.signPresent,
    signs: wide.signs,
  });
  if (atTheDoor || judged.verdict === "match") return judged;

  const chosen = chooseSignToReadAgain(wide.signs, input.listType);
  // Under two seconds left is not a read, it is a timeout with a model call attached to it.
  if (!chosen?.box || remaining() < 2_000) return judged;
  const tight = await cropToBox(cropped.jpeg, chosen.box);
  if (!tight) return judged;

  const close = await readSigns({ jpeg: tight, model, question: CLOSE_QUESTION, timeoutMs: remaining() });
  if (!close || close.signs.length === 0) return judged;

  // 🔴 THE CLOSER READING IS JUDGED WITH THE REST OF THE FRAME, NEVER ON ITS OWN. Judging the crop
  // alone held رضوان محمد a second time: the crop was one clear sign, so every rule that depends on
  // the frame — "something here could not be read", "every clear sign belongs to another trade" —
  // had nothing left to see, and a photograph the wide look had correctly left `unjudged` came back
  // as a flag. The crop REPLACES the sign it was taken from, and the other signs keep their own
  // legibility in the verdict.
  const evidence = [...close.signs, ...wide.signs.filter((sign) => sign !== chosen)].slice(0, 8);
  const closer = judgeSignboards({
    croppedFraction: cropped.croppedFraction,
    customerName: input.customerName,
    listType: input.listType,
    note: close.note ?? wide.note,
    signPresent: close.signPresent ?? wide.signPresent,
    signs: evidence,
  });
  return { ...closer, signs: evidence };
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
  if (!hasAiApiKey()) return unjudged("no_api_key");

  const bytes = await downloadIssuedPlacePhoto({
    hrId: input.repHrId,
    isTest: input.isTest,
    path: input.photoPath,
    seatId: input.seatId,
  }).catch(() => null);
  if (!bytes) return unjudged("no_bytes");

  return judgeBytes({ bytes, customerName: input.customerName, listType: input.listType, mode: "door" });
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
  if (!hasAiApiKey()) return unjudged("no_api_key");
  const bytes = await downloadPhoto(input.photoPath).catch(() => null);
  if (!bytes) return unjudged("no_bytes");
  return judgeBytes({ bytes, customerName: input.customerName, listType: input.listType, mode: "sweep" });
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
 * Never throws: it runs after the place is saved, and nothing it does may turn a successful
 * validation into an error the rep sees. 🔴 BUT IT ANSWERS WHETHER THE ROW TOOK IT, because a caller
 * that reports its own writes cannot report them from a `void`. Measured 2026-10-09: the re-read pass
 * printed "written to the place row" for all five places and اسلام عبدالعال still held its old
 * verdict — the swallowed error was the only record of the loss, and nothing could see it. The rep's
 * path ignores the answer, exactly as before.
 *
 * 🔴 AND THE PAYLOAD IS SANITISED FIRST, because `jsonb` REFUSES a string this reader can produce.
 * Postgres rejects `\u0000` and a lone surrogate outright, and a model transcribing a damaged
 * signboard emits both — so one unlucky character threw the WHOLE verdict away silently, leaving that
 * place in the nightly backlog for ever.
 */
export async function recordPlaceSignboard(
  placeId: string,
  check: PhoenixCrmSignboardCheck,
): Promise<boolean> {
  if (!placeId) return false;
  try {
    const { error } = await getSupabaseAdmin()
      .from("phoenix_crm_places")
      .update({ signboard_check: jsonbSafe(check) })
      .eq("id", placeId);
    throwIfError(error);
    return true;
  } catch {
    // Still silent — see the doc above. The answer is how a caller learns of it.
    return false;
  }
}
