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
  mergeSignboardParts,
  parseSignboardPhotoProblem,
  readerRanOutOfRoom,
  signboardQuarters,
  signboardReadsCustomerName,
  signboardUnjudged as unjudged,
  signNamesCustomerOnSign,
  stampBandFraction,
  type PhoenixCrmSign,
  type PhoenixCrmSignboardCheck,
  type SignboardKind,
  type SignboardLegibility,
  type SignboardPart,
  type SignboardPhotoProblem,
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
 * One reader, named on each provider: `anthropicModel` is the Claude model asked, `model` the OpenAI
 * one asked only when Claude's ACCOUNT is dead (out of credit, key rejected).
 *
 * 🔴 CLAUDE READS THE SIGNBOARD FIRST SINCE 2026-10-18 (`preferProvider: "anthropic"` on every call),
 * AND THE NUMBER IS A MEASUREMENT. The owner, of a rep whose places were 19 of 21 "Not readable": *"The
 * photos are clearly readable. Why can't you read them?"* Those 21 production photos, replayed through
 * this file's own code and prompt: Claude Sonnet confirmed **14** at the door and the held re-read
 * behind it one more, Claude Haiku 12 at the door, where the stored readings (OpenAI's nano, then
 * mini) had confirmed 1. Of the 6 left, one is another doctor's plate, four show no plate a person
 * can read either, and one is a calligraphy board the reader takes a letter wrong on. No reader matched
 * a random other customer's name on any of them. Account: docs/phoenix-crm-validation-feedback.md,
 * "Claude reads the signboard".
 */
export type SignboardReader = { anthropicModel: string; model: string };

/**
 * 🔴 THE NIGHT READS WITH THE STRONG MODEL AND THE DOOR WITH A CHEAPER ONE, DELIBERATELY (the door's
 * moved from the cheapest tier to the middle one on 2026-10-17 — `PHOENIX_CRM_SIGNBOARD_DOOR_READER`).
 * Of the five places the cheap reader held on its first night (read 2026-10-09), four were held
 * wrongly and three of those were a board it could not read properly — "دكتور أحمد الشرباوي" for
 * الشعراوي, "محمد فريد" for فرج, a room sign for عبدالعال. The door cannot afford this model inside
 * a rep's 8-second save; the night can afford it for every place it reads, and the whole point of
 * the night is that it has no rep waiting on it.
 *
 * The extra cost is small because the SECOND look is only taken when the first found nobody: 5 of
 * the 60 places read on that night, 8%.
 *
 * Claude Opus was replayed on the same 21 photos for the night and confirmed the same 14 as Sonnet,
 * at 15.4 s p95 against 10.7 s — no gain for the slower model.
 */
export const PHOENIX_CRM_SIGNBOARD_STRONG_READER: SignboardReader = {
  anthropicModel: "claude-sonnet-5-5",
  model: OPENAI_STRONG_MODEL,
};
export const PHOENIX_CRM_SIGNBOARD_SWEEP_READER = PHOENIX_CRM_SIGNBOARD_STRONG_READER;

/**
 * 🔴 THE DOOR READS WITH THE MIDDLE TIER SINCE 2026-10-17, AND THE NUMBER IS A MEASUREMENT. 40
 * production photos captured since 10 October (30 stored "unreadable", 10 stored "match") were
 * replayed through every tier with this file's own prompt: the cheap model confirmed **1 of the 30**
 * a person reads at a glance; this one confirmed **12**, at 5.9 s p95 — inside the rep's 8 s. The cheap
 * one is now only the fallback for a LOST call (owner, 2026-10-17: "fall back on other way"), asked
 * with whatever time is left. Never move the door back to nano to save money without replaying those
 * photos first. Account: docs/phoenix-crm-validation-feedback.md, "The door reader and the held re-read".
 *
 * 🔴 SINCE 2026-10-18 THE DOOR ASKS CLAUDE SONNET, NOT HAIKU, AND THAT TOO IS A MEASUREMENT. 81
 * production photos (one rep's 21, 45 other places stored "unreadable", 15 stored matches) replayed at
 * the door: Sonnet confirmed 14 / 2 / 13 of them, Haiku 12 / 2 / 12, at 6.6 s p95 against Haiku's
 * 7.1 s, and 2 of Sonnet's 81 calls ran past 8 s. Neither matched a random other customer's name on
 * any photo. Haiku is the fallback for a lost call, as nano was.
 */
export const PHOENIX_CRM_SIGNBOARD_DOOR_READER: SignboardReader = {
  anthropicModel: "claude-sonnet-5-5",
  model: "gpt-5.4-mini",
};
/** The fast Claude model: what a lost call falls back to, at the door and on the held re-read. */
const CLAUDE_FAST_MODEL = "claude-haiku-5-5";
const DOOR_READERS = [
  PHOENIX_CRM_SIGNBOARD_DOOR_READER,
  { anthropicModel: CLAUDE_FAST_MODEL, model: OPENAI_NANO_MODEL },
] as const;

/**
 * A HELD place is re-read by the strong reader, falling back to the fast one on a lost call, and the
 * whole re-read of one place — the blind look, its second look, the guided look and its check — gets
 * this long. Nobody waits on it: it runs after the rep's reply and in the hourly re-check.
 */
export const PHOENIX_CRM_SIGNBOARD_HELD_BUDGET_MS = 45_000;
/** No single call may take the whole re-read, or a hung call would leave no time for the fallback. */
const HELD_CALL_CAP_MS = 20_000;
const HELD_READERS = [
  PHOENIX_CRM_SIGNBOARD_STRONG_READER,
  { anthropicModel: CLAUDE_FAST_MODEL, model: PHOENIX_CRM_SIGNBOARD_DOOR_READER.model },
] as const;

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

/**
 * 🔴 THE BLIND READ ALSO SAYS WHAT STOPS A NAMEPLATE BEING READ (2026-10-18). It is what the door tells
 * the rep to fix and what the audit of the old "Not readable" places counts; a stored "unreadable" with
 * no reason could not say whether the photo or the old reader was at fault. Only the blind read asks it:
 * the guided read's schema has no such field.
 */
const PROBLEM_EXTRA =
  "\n\nFinally, in problem, say what — if anything — stops a practice's own nameplate being read in " +
  "this photograph: \"none\" when the nameplate or practice sign is legible; \"no_plate\" when the photo " +
  "shows no nameplate or practice sign at all (a street, a wall, a bare door, a vehicle); " +
  "\"building_sign_only\" when it shows only a building's, a hospital's or another trade's sign and no " +
  "plate of the practice itself; \"too_far\" when a plate is there but too small to read; \"blurred\"; " +
  "\"dark_or_glare\" when it is too dark or a reflection covers it; \"cut_off\" when the plate runs out " +
  "of the frame; \"stylised\" when decorative or calligraphic lettering cannot be followed.\n\n" +
  "And in upright, say how the scene stands in this image: \"upright\" when its lettering reads the " +
  "normal way up; otherwise how the IMAGE must be turned for the lettering to stand upright — " +
  "\"turn_clockwise\", \"turn_counterclockwise\" or \"upside_down\". A phone held sideways stores the " +
  "scene on its side.";

const PROBLEM_SCHEMA = {
  enum: ["none", "no_plate", "building_sign_only", "too_far", "blurred", "dark_or_glare", "cut_off", "stylised"] as const,
  type: "string" as const,
};

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
        problem: PROBLEM_SCHEMA,
        sign_present: { type: ["boolean", "null"] as const },
        signs: { items: SIGN_SCHEMA, type: ["array", "null"] as const },
        upright: {
          enum: ["upright", "turn_clockwise", "turn_counterclockwise", "upside_down"] as const,
          type: "string" as const,
        },
      },
      required: ["sign_present", "signs", "note", "problem", "upright"],
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
  options: { minLongSide?: number } = {},
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

    let image = sharp(jpeg).extract({ height: keepHeight, left, top, width: keepWidth });
    // The held re-read's close look enlarges a small plate so its letters are not a few pixels each —
    // the shape the 2026-10-17 replay was measured with. The night's second look is unchanged.
    const longSide = Math.max(keepWidth, keepHeight);
    if (options.minLongSide && longSide < options.minLongSide) {
      image =
        keepWidth >= keepHeight
          ? image.resize({ kernel: "lanczos3", width: options.minLongSide })
          : image.resize({ height: options.minLongSide, kernel: "lanczos3" });
    }
    return await image.jpeg({ quality: 90 }).toBuffer();
  } catch {
    return null;
  }
}

type SignboardReading = {
  signs: PhoenixCrmSign[];
  signPresent: boolean | null;
  note: string | null;
  /** The blind read's word on what stops the nameplate being read; null from the guided read. */
  problem: SignboardPhotoProblem | null;
  /** Which reader answered, and whether it was Claude itself rather than the account fallback. */
  reader: SignboardReader;
  byClaude: boolean;
  /** How the image must be turned for its lettering to stand upright; null when it already does. */
  turn: SignboardTurn | null;
};

/** How the reader says the IMAGE must be turned for the lettering in it to stand upright. */
type SignboardTurn = "clockwise" | "counterclockwise" | "upside_down";

const TURN_DEGREES: Record<SignboardTurn, number> = { clockwise: 90, counterclockwise: 270, upside_down: 180 };
const OPPOSITE_TURN: Record<SignboardTurn, SignboardTurn> = {
  clockwise: "counterclockwise",
  counterclockwise: "clockwise",
  upside_down: "upside_down",
};

/** An answer outside the list is "upright" — never a guess at which way to turn a photo. */
function turnOf(value: unknown): SignboardTurn | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "turn_clockwise") return "clockwise";
  if (raw === "turn_counterclockwise") return "counterclockwise";
  if (raw === "upside_down") return "upside_down";
  return null;
}

/** The image turned upright (sharp's `rotate` turns clockwise). `sharp` imported inside, as above. */
async function turnJpeg(jpeg: Buffer, turn: SignboardTurn): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import("sharp");
    return await sharp(jpeg).rotate(TURN_DEGREES[turn]).jpeg({ quality: 90 }).toBuffer();
  } catch {
    return null;
  }
}

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
  reader: SignboardReader;
  timeoutMs: number;
  question: string;
  /** The whole photo's read: an answer that runs out of room is read again in quarters. */
  inPartsWhenFull?: boolean;
}): Promise<SignboardReading | null> {
  if (input.timeoutMs <= 0) return null;
  const startedAt = Date.now();
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
      instructions: INSTRUCTIONS + PROBLEM_EXTRA,
      // Several signs, each with a box, do not fit in the 400 one sign needed — and Claude spends more
      // tokens on Arabic than OpenAI did: at 1,400, 2 of 81 replayed street photos came back cut off
      // mid-answer (2026-10-18). A cap is a ceiling, never a cost; only what is written is billed.
      maxOutputTokens: 2_400,
      // `timeoutMs` is the time LEFT on this check's deadline. The SDK would retry a timeout with a fresh
      // copy of it, and the rep stands at the door for the doubled wait (16.4 s against an 8 s budget).
      maxRetries: 0,
      ...readerParams(input.reader),
      purpose: "phoenix-crm-signboard",
      reasoning: { effort: "low" },
      text: TEXT_FORMAT,
      timeoutMs: input.timeoutMs,
    });

    const parsed = parseAiJson(response.outputText);
    return {
      byClaude: answeredByClaude(response.model),
      note: text(parsed.note),
      problem: parseSignboardPhotoProblem(parsed.problem),
      reader: input.reader,
      signPresent: typeof parsed.sign_present === "boolean" ? parsed.sign_present : null,
      signs: signsFrom(parsed.signs),
      turn: turnOf(parsed.upright),
    };
  } catch (error) {
    if (!input.inPartsWhenFull || !readerRanOutOfRoom(error)) return null;
    return readInParts({ ...input, timeoutMs: input.timeoutMs - (Date.now() - startedAt) });
  }
}

/**
 * A board too full for one answer, read again as four overlapping quarters side by side — each with
 * the time the whole read left, never more, so a place still costs at most its budget. Any quarter that
 * fails fails the read: a board read three-quarters is the partial reading this file refuses.
 */
async function readInParts(input: {
  jpeg: Buffer;
  reader: SignboardReader;
  timeoutMs: number;
  question: string;
}): Promise<SignboardReading | null> {
  // Under two seconds is not a read, it is a timeout with a model call attached to it.
  if (input.timeoutMs < 2_000) return null;
  const parts = signboardQuarters();
  const images = await Promise.all(parts.map((part) => cropToPart(input.jpeg, part)));
  if (images.some((image) => image === null)) return null;
  const readings = await Promise.all(
    images.map((jpeg) =>
      readSigns({ jpeg: jpeg as Buffer, question: input.question, reader: input.reader, timeoutMs: input.timeoutMs }),
    ),
  );
  const answered = readings.filter((reading): reading is SignboardReading => reading !== null);
  if (answered.length !== parts.length) return null;
  return {
    ...mergeSignboardParts(answered, parts),
    byClaude: answered.every((reading) => reading.byClaude),
    reader: input.reader,
  };
}

/** Exactly one part of the image, with no margin — its fractions are what the boxes are mapped back by. */
async function cropToPart(jpeg: Buffer, part: SignboardPart): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(jpeg).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) return null;
    const left = Math.floor(part.left * width);
    const top = Math.floor(part.top * height);
    const keepWidth = Math.min(width - left, Math.round(part.width * width));
    const keepHeight = Math.min(height - top, Math.round(part.height * height));
    if (keepWidth < 64 || keepHeight < 32) return null;
    return await sharp(jpeg).extract({ height: keepHeight, left, top, width: keepWidth }).jpeg({ quality: 90 }).toBuffer();
  } catch {
    return null;
  }
}

/** The reply names the model that answered; a Claude model id starts with its family name. */
function answeredByClaude(model: unknown): boolean {
  return typeof model === "string" && model.trim().toLowerCase().startsWith("claude");
}

/** Claude first, by name; the OpenAI model only when Claude's account is dead. */
function readerParams(reader: SignboardReader) {
  return { anthropicModel: reader.anthropicModel, model: reader.model, preferProvider: "anthropic" as const };
}

const WIDE_QUESTION = "What signs are in this photograph, and who is named on each of them?";
const CLOSE_QUESTION =
  "This is one sign from a photograph, on its own. What does it say, and who is named on it?";

/**
 * The owner's own idea for a sign nobody could read (2026-10-17): *"look at what the rep typed; when
 * you connect the letters you will know"*. The guided read is told the name — and that is exactly why
 * its answer is NEVER trusted on its own (`spotCheck` below): replayed on 40 production photos with a
 * near-miss decoy name, it wrote the decoy it was handed on 8 of 40, among them "مستشفى الأمان" off a
 * clear "مستشفى الإمام علي" board and "سمير ريحان" off سمير الجزار's plate.
 */
const GUIDED_EXTRA =
  "\n\nTHE REPRESENTATIVE HAS TOLD US WHOSE PLACE THIS IS, and the name is in the question. Use it " +
  "only to know what to look for — Arabic signboards are often stylised, faded, lit badly or " +
  "photographed at night, and knowing the name helps you connect letters you can only half see. " +
  "But you are a witness, not a helper: put in name_as_written ONLY the letters you can actually see " +
  "on a sign where that name appears, copied from the sign, never copied from the question. Answer " +
  "name_on_sign \"yes\" only when you can see the name written on a sign (spelling variants, a " +
  "missing grandfather's name or a title like د/ are fine); \"partly\" when you can see part of it " +
  "but not enough to be sure it is this person; \"no\" when the signs are readable and this name is " +
  "not on any of them; \"cannot_tell\" when the signs cannot be read well enough to say either way. " +
  "Give name_box, the box of the sign where you see the name, as fractions of the image; null when " +
  "you do not see it. A wrong \"yes\" is the worst possible answer: it would validate a practice " +
  "that is not this customer's, and the photographs are checked again by a person.";

const GUIDED_TEXT_FORMAT = {
  format: {
    name: "phoenix_crm_signboard_guided",
    schema: {
      additionalProperties: false,
      properties: {
        name_as_written: { type: ["string", "null"] as const },
        name_box: BOX_SCHEMA,
        name_on_sign: { enum: ["yes", "partly", "no", "cannot_tell"] as const, type: "string" as const },
        note: { type: ["string", "null"] as const },
        sign_present: { type: ["boolean", "null"] as const },
        signs: { items: SIGN_SCHEMA, type: ["array", "null"] as const },
      },
      required: ["sign_present", "signs", "note", "name_on_sign", "name_as_written", "name_box"],
      strict: true as const,
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

type GuidedReading = SignboardReading & { nameAsWritten: string | null; nameBox: PhoenixCrmSign["box"] };

/** The guided look: the name is in the question. Null for every failure, as `readSigns` is. */
async function readGuided(input: {
  jpeg: Buffer;
  reader: SignboardReader;
  timeoutMs: number;
  nameGiven: string;
  listType: PhoenixCrmListType;
}): Promise<GuidedReading | null> {
  if (input.timeoutMs <= 0) return null;
  const asked =
    `The representative recorded this photograph as the ${input.listType === "PM" ? "practice of" : "facility"}: «${input.nameGiven}». ` +
    "What signs are in this photograph, what does each say, and is this name written on any of them?";
  try {
    const response = await createOpenAiResponseText({
      component: "phoenix_crm_signboard",
      input: [
        {
          content: [
            { text: asked, type: "input_text" as const },
            { detail: "high" as const, image_url: `data:image/jpeg;base64,${input.jpeg.toString("base64")}`, type: "input_image" as const },
          ],
          role: "user" as const,
        },
      ],
      instructions: INSTRUCTIONS + GUIDED_EXTRA,
      maxOutputTokens: 2_800,
      maxRetries: 0,
      ...readerParams(input.reader),
      purpose: "phoenix-crm-signboard",
      reasoning: { effort: "low" },
      text: GUIDED_TEXT_FORMAT,
      timeoutMs: input.timeoutMs,
    });
    const parsed = parseAiJson(response.outputText);
    return {
      byClaude: answeredByClaude(response.model),
      nameAsWritten: text(parsed.name_as_written),
      nameBox: box(parsed.name_box),
      note: text(parsed.note),
      problem: null,
      reader: input.reader,
      turn: null,
      signPresent: typeof parsed.sign_present === "boolean" ? parsed.sign_present : null,
      signs: signsFrom(parsed.signs),
    };
  } catch {
    return null;
  }
}

/**
 * Ask each model in turn until one answers — the owner's "fall back on other way" for a lost call.
 * Each call gets what is left, capped so one hung call cannot spend the fallback's time too.
 */
async function firstAnswer<T>(
  readers: readonly SignboardReader[],
  remaining: () => number,
  capMs: number,
  ask: (reader: SignboardReader, timeoutMs: number) => Promise<T | null>,
): Promise<T | null> {
  for (const reader of readers) {
    const left = Math.min(remaining(), capMs);
    // Under two seconds is not a read, it is a timeout with a model call attached to it.
    if (left < 2_000) return null;
    const answer = await ask(reader, left);
    if (answer) return answer;
  }
  return null;
}

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
 * The door takes no second look: a rep is standing in the street on an 8-second budget, and the held
 * re-read picks his place up straight after his reply.
 */
async function judgeBytes(input: {
  bytes: Uint8Array;
  customerName: string;
  listType: PhoenixCrmListType;
  mode: SignboardReadMode;
  /** The night's second, cropped look; the door never takes one. */
  secondLook?: boolean;
  /** The brick the photo's GPS resolved to: an AM name's town word (`signNamesCustomer`). */
  photoBrick?: string | null;
}): Promise<PhoenixCrmSignboardCheck> {
  const cropped = await cropStampBand(input.bytes);
  if (!cropped) return unjudged("call_failed");

  const atTheDoor = input.mode === "door";
  const deadline =
    Date.now() + (atTheDoor ? PHOENIX_CRM_SIGNBOARD_TIMEOUT_MS : PHOENIX_CRM_SIGNBOARD_SWEEP_BUDGET_MS);
  return blindRead({
    cropped,
    customerName: input.customerName,
    listType: input.listType,
    photoBrick: input.photoBrick ?? null,
    // The door asks its reader and falls back to the fast one on a lost call; the night keeps its one
    // strong reader, whose lost call `signboard-sweep.ts` retries itself.
    readers: atTheDoor ? DOOR_READERS : [PHOENIX_CRM_SIGNBOARD_SWEEP_READER],
    callCapMs: atTheDoor ? PHOENIX_CRM_SIGNBOARD_TIMEOUT_MS : PHOENIX_CRM_SIGNBOARD_SWEEP_BUDGET_MS,
    remaining: () => deadline - Date.now(),
    secondLook: atTheDoor ? false : input.secondLook ?? true,
    turnUpright: !atTheDoor,
  });
}

/**
 * The BLIND read — the reader is never told the name — and, off the door, its second look at the sign
 * that would answer, cropped out of the frame. The night's reader, the held re-read's first half, and
 * the door's one look (without the second).
 */
async function blindRead(input: {
  cropped: { jpeg: Buffer; croppedFraction: number };
  customerName: string;
  listType: PhoenixCrmListType;
  readers: readonly SignboardReader[];
  callCapMs: number;
  remaining: () => number;
  secondLook: boolean;
  /** Turn a sideways scene upright and read it again — everywhere but the door. */
  turnUpright: boolean;
  photoBrick?: string | null;
}): Promise<PhoenixCrmSignboardCheck> {
  const { cropped } = input;
  const first = await firstAnswer(input.readers, input.remaining, input.callCapMs, (reader, timeoutMs) =>
    readSigns({ inPartsWhenFull: true, jpeg: cropped.jpeg, question: WIDE_QUESTION, reader, timeoutMs }),
  );
  if (!first) return unjudged("call_failed", cropped.croppedFraction);
  const judge = (reading: SignboardReading): PhoenixCrmSignboardCheck =>
    judgeSignboards({
      croppedFraction: cropped.croppedFraction,
      customerName: input.customerName,
      listType: input.listType,
      note: reading.note,
      photoBrick: input.photoBrick ?? null,
      problem: reading.problem,
      signPresent: reading.signPresent,
      signs: reading.signs,
    });

  // 🔴 A SIDEWAYS SCENE IS TURNED UPRIGHT AND READ ONCE MORE (2026-10-18). The one-off pass over the old
  // "Not readable" places found 38 of its first 157 photos on their side — a phone held sideways stores
  // the scene turned while the caption stays upright — and Claude, which said so in its own note, read
  // none of their plates: "cut off", "stylised", "too far". Off the door the image is turned the way the
  // reader says and read again, the other way once if that reading is still on its side; the door has no
  // time for it, and a photo nobody turned upright asks the rep to hold the phone upright (`sideways`).
  let wide = first;
  let image = cropped.jpeg;
  let onItsSide = first.turn !== null && judge(first).verdict !== "match";
  if (onItsSide && input.turnUpright && first.turn) {
    const turns: SignboardTurn[] = first.turn === "upside_down" ? ["upside_down"] : [first.turn, OPPOSITE_TURN[first.turn]];
    for (const turn of turns) {
      if (input.remaining() < 2_000) break;
      const turned = await turnJpeg(cropped.jpeg, turn);
      if (!turned) break;
      const again = await firstAnswer(input.readers, input.remaining, input.callCapMs, (reader, timeoutMs) =>
        readSigns({ inPartsWhenFull: true, jpeg: turned, question: WIDE_QUESTION, reader, timeoutMs }),
      );
      if (!again) break;
      if (again.turn !== null) continue;
      wide = again;
      image = turned;
      onItsSide = false;
      break;
    }
  }

  // The strong reader is always the first in the list; an answer from it through Claude is the one
  // whose "unreadable" is final (`signboardNextAttempt`). A fallback's answer keeps the photo a try.
  const strongRead = wide.byClaude && wide.reader === input.readers[0];
  const read = judge(wide);
  const judged: PhoenixCrmSignboardCheck = {
    ...read,
    problem: onItsSide && read.verdict !== "match" && read.verdict !== "other_name" ? "sideways" : read.problem,
    strongRead,
  };
  if (!input.secondLook || judged.verdict === "match") return judged;

  const chosen = chooseSignToReadAgain(wide.signs, input.listType);
  // Under two seconds left is not a read, it is a timeout with a model call attached to it.
  if (!chosen?.box || input.remaining() < 2_000) return judged;
  const tight = await cropToBox(image, chosen.box);
  if (!tight) return judged;

  const close = await firstAnswer(input.readers, input.remaining, input.callCapMs, (reader, timeoutMs) =>
    readSigns({ jpeg: tight, question: CLOSE_QUESTION, reader, timeoutMs }),
  );
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
    photoBrick: input.photoBrick ?? null,
    problem: wide.problem,
    signPresent: close.signPresent ?? wide.signPresent,
    signs: evidence,
  });
  return {
    ...closer,
    problem: onItsSide && closer.verdict !== "match" && closer.verdict !== "other_name" ? "sideways" : closer.problem,
    signs: evidence,
    strongRead,
  };
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
  /** The brick the photo's GPS resolved to, when the caller has it. */
  photoBrick?: string | null;
}): Promise<PhoenixCrmSignboardCheck> {
  if (!hasAiApiKey()) return unjudged("no_api_key");

  const bytes = await downloadIssuedPlacePhoto({
    hrId: input.repHrId,
    isTest: input.isTest,
    path: input.photoPath,
    seatId: input.seatId,
  }).catch(() => null);
  if (!bytes) return unjudged("no_bytes");

  return judgeBytes({ bytes, customerName: input.customerName, listType: input.listType, mode: "door", photoBrick: input.photoBrick ?? null });
}

/**
 * Read the signboard of a place already in the database, for the nightly sweep.
 *
 * `downloadPhoto` is legitimate here and only here: the sweep runs as the system over rows it found
 * itself, which is the one case that function's own doc permits.
 */
export async function readStoredPlaceSignboard(
  input: {
    photoPath: string;
    customerName: string;
    listType: PhoenixCrmListType;
    photoBrick?: string | null;
  },
  /**
   * `secondLook: false` is the one-off read of the old "Not readable" places (2026-10-18): one look per
   * photo, because on 81 replayed photos the second, cropped look confirmed nothing the first had not.
   */
  options: { secondLook?: boolean } = {},
): Promise<PhoenixCrmSignboardCheck> {
  if (!hasAiApiKey()) return unjudged("no_api_key");
  const bytes = await downloadPhoto(input.photoPath).catch(() => null);
  if (!bytes) return unjudged("no_bytes");
  return judgeBytes({
    bytes,
    customerName: input.customerName,
    listType: input.listType,
    mode: "sweep",
    photoBrick: input.photoBrick ?? null,
    secondLook: options.secondLook ?? true,
  });
}

/**
 * Re-read a place the door HELD (owner, 2026-10-17: "hold; re-read; else you decide").
 *
 * TWO READERS, AND EACH ONE IS BLIND WHERE IT COUNTS:
 *
 *   1. The night's own blind read with its second look — the strong model, never told the name.
 *   2. Only if that did not find him: the GUIDED read, told the name the rep typed (his own idea), and
 *      then `spotCheck` — a BLIND close look at the one spot the guided read pointed to, which must
 *      itself read the name. The guided answer alone decides nothing.
 *
 * Measured on the same 40 production photos (2026-10-17): the door's middle tier, this blind read and
 * the checked guided read together confirmed **16 of 30** photos the cheap reader had filed
 * "unreadable", with **0** false confirmations against a random and a near-miss decoy name for every
 * photo — where the guided read on its own reached 19 of 30 but confirmed the wrong name 8 times.
 *
 * Never throws: it runs after the rep's reply and in a cron, and every absence is an `unjudged` record.
 * Read with `downloadPhoto`, which is legitimate here as in the night pass: it runs as the system over
 * a place row it found itself.
 */
export async function rereadHeldPlaceSignboard(input: {
  photoPath: string;
  customerName: string;
  listType: PhoenixCrmListType;
  photoBrick?: string | null;
}): Promise<PhoenixCrmSignboardCheck> {
  if (!hasAiApiKey()) return unjudged("no_api_key");
  const bytes = await downloadPhoto(input.photoPath).catch(() => null);
  if (!bytes) return unjudged("no_bytes");
  const cropped = await cropStampBand(bytes);
  // A photo that cannot be opened is a read that answered — it never gets better — so it is `no_bytes`
  // here, never the `call_failed` that spends nothing (`heldSignboardReadHappened`).
  if (!cropped) return unjudged("no_bytes");

  const deadline = Date.now() + PHOENIX_CRM_SIGNBOARD_HELD_BUDGET_MS;
  const remaining = (): number => deadline - Date.now();
  const blind = await blindRead({
    callCapMs: HELD_CALL_CAP_MS,
    cropped,
    customerName: input.customerName,
    listType: input.listType,
    photoBrick: input.photoBrick ?? null,
    readers: HELD_READERS,
    remaining,
    secondLook: true,
    turnUpright: true,
  });
  if (blind.verdict === "match") return blind;
  const spotted = await spotCheck({ cropped, customerName: input.customerName, listType: input.listType, remaining });
  return spotted ?? blind;
}

/**
 * The guided read, and the blind close look that is the only thing allowed to believe it.
 *
 * 🔴 THE STORED EVIDENCE IS THE BLIND LOOK'S, NEVER THE GUIDED TRANSCRIPTION. The guided reader can
 * copy the name it was given into its own text, so its signs are used to find WHERE to look and are
 * then thrown away; what is kept is what a reader that was never told the name read at that spot.
 *
 * 🔴 AND THE CLOSE LOOK MUST READ THE NAME, NOT MERELY RETURN `match` (`signboardReadsCustomerName`):
 * the AM rule makes a frame naming no place a match, and a close look that read only "صيدلية" would
 * otherwise confirm whatever name the guided read was handed.
 *
 * Null when nothing was confirmed — the blind read's own verdict then stands.
 */
async function spotCheck(input: {
  cropped: { jpeg: Buffer; croppedFraction: number };
  customerName: string;
  listType: PhoenixCrmListType;
  remaining: () => number;
}): Promise<PhoenixCrmSignboardCheck | null> {
  const subject = { customerName: input.customerName, listType: input.listType };
  const guided = await firstAnswer(HELD_READERS, input.remaining, HELD_CALL_CAP_MS, (reader, timeoutMs) =>
    readGuided({ jpeg: input.cropped.jpeg, listType: input.listType, nameGiven: input.customerName, reader, timeoutMs }),
  );
  if (!guided) return null;
  const claimed: PhoenixCrmSign[] = guided.nameAsWritten
    ? [
        {
          box: guided.nameBox,
          kind: "medical",
          legibility: "partial",
          personNames: input.listType === "PM" ? [guided.nameAsWritten] : [],
          placeNames: input.listType === "PM" ? [] : [guided.nameAsWritten],
          text: guided.nameAsWritten,
        },
      ]
    : [];
  if (!signboardReadsCustomerName([...claimed, ...guided.signs], subject)) return null;

  // Where it says it saw him: its own box for the name, or else the box of a sign it read him on.
  const spot =
    guided.nameBox ??
    guided.signs.find((sign) => sign.box !== null && signNamesCustomerOnSign(sign, subject).matches === true)?.box ??
    null;
  if (!spot || input.remaining() < 2_000) return null;
  const tight = await cropToBox(input.cropped.jpeg, spot, { minLongSide: 1_024 });
  if (!tight) return null;
  const close = await firstAnswer(HELD_READERS, input.remaining, HELD_CALL_CAP_MS, (reader, timeoutMs) =>
    readSigns({ jpeg: tight, question: CLOSE_QUESTION, reader, timeoutMs }),
  );
  if (!close || !signboardReadsCustomerName(close.signs, subject)) return null;
  return judgeSignboards({
    croppedFraction: input.cropped.croppedFraction,
    customerName: input.customerName,
    listType: input.listType,
    note: close.note,
    signPresent: close.signPresent,
    signs: close.signs,
  });
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
