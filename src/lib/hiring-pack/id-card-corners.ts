import { createOpenAiResponseText, hasAiApiKey, OPENAI_ROUTE_BUDGET_MS, OPENAI_STRONG_MODEL } from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/ai/parse-ai-json";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHERE IS THE CARD IN THIS PHOTO, AND WHICH WAY UP IS IT? (owner, 2026-11-27: the bank letter's
// ID pages print each card cropped to its edges and turned landscape.)
//
// Finding a card on a desk by pixels alone fails on the photos people actually take — a white card
// on white paper, a hand holding it, a patterned tablecloth — and pixels cannot say which way the
// printing reads. So the photo is shown once to the model, which answers the card's four corners in
// the card's own reading order; `id-card-crop.ts` then snaps them to the real edges and flattens the
// card. The answer only ever crops and turns a picture the person uploaded: nothing is read off the
// card, stored or shown, and a missing or doubtful answer prints the photo as it is.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const INSTRUCTIONS =
  "You are given a photograph of one side of an Egyptian national ID card (a plastic card the size " +
  "of a bank card), usually lying on a surface or held in a hand. It may be rotated any way, sideways, " +
  "upside down or photographed at a slant: that is expected. Locate the card's four physical corners " +
  "and give each as x and y in thousandths of the photograph's width and height (0 is the left or top " +
  "edge, 1000 the right or bottom edge). The order of the four corners does not matter. If the card's " +
  "rounded corner is cut off by the photograph's edge, estimate where it would be. If there is no ID " +
  "card in the photograph, or you cannot see all four edges well enough to place the corners, set " +
  "found to false. When unsure of a corner, place it a little OUTSIDE the card, never inside it: the " +
  "picture is cut along these corners and must never cut off part of the card. Do not read out or " +
  "repeat anything printed on the card.";

const ORIENTATION_INSTRUCTIONS =
  "You are given a picture of one side of an Egyptian national ID card, already cut out, laid flat and " +
  "landscape (long side horizontal). Say whether it is upright or upside down. Upright, the FRONT has " +
  "the green heading (Arab Republic of Egypt) along the top and the person's photo on the left; the " +
  "BACK has the dense barcode band along the bottom and the eagle emblem on the right. Answer " +
  "upright, upside_down, or unsure. Do not read out or repeat anything printed on the card.";

const ORIENTATION_FORMAT = {
  format: {
    name: "id_card_orientation",
    schema: {
      additionalProperties: false,
      properties: { orientation: { enum: ["upright", "upside_down", "unsure"], type: "string" } },
      required: ["orientation"],
      type: "object",
    },
    strict: true,
    type: "json_schema" as const,
  },
};

const POINT_SCHEMA = {
  additionalProperties: false,
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  type: "object",
} as const;

const TEXT_FORMAT = {
  format: {
    name: "id_card_corners",
    schema: {
      additionalProperties: false,
      properties: {
        corner_1: POINT_SCHEMA,
        corner_2: POINT_SCHEMA,
        corner_3: POINT_SCHEMA,
        corner_4: POINT_SCHEMA,
        found: { type: "boolean" },
      },
      required: ["found", "corner_1", "corner_2", "corner_3", "corner_4"],
      type: "object",
    },
    strict: true,
    type: "json_schema" as const,
  },
};

function point(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** The model's answer, read strictly: four corners in thousandths, in any order, or null. */
export function readCornerAnswer(answer: Record<string, unknown>): { x: number; y: number }[] | null {
  if (answer.found !== true) return null;
  const corners = [answer.corner_1, answer.corner_2, answer.corner_3, answer.corner_4].map(point);
  return corners.every((corner) => corner !== null) ? (corners as { x: number; y: number }[]) : null;
}

/**
 * The card's four corners in `jpeg`, in thousandths of its width and height, in any order (the crop
 * orders them by geometry, so a misread order can never mirror the card) — or null when no AI key is set, the call fails, or the model could not place them.
 * Never throws: a crop is a nicety on a page that prints either way.
 */
export async function findIdCardCorners(jpeg: Buffer): Promise<{ x: number; y: number }[] | null> {
  if (!hasAiApiKey()) return null;
  try {
    const response = await createOpenAiResponseText({
      input: [
        {
          content: [
            { text: "Where are this ID card's four corners?", type: "input_text" as const },
            // "high": a corner a few per cent off leaves desk along an edge; the refinement after
            // this only searches a narrow band, so the first reading has to be close.
            { detail: "high" as const, image_url: `data:image/jpeg;base64,${jpeg.toString("base64")}`, type: "input_image" as const },
          ],
          role: "user" as const,
        },
      ],
      instructions: INSTRUCTIONS,
      maxOutputTokens: 1500,
      model: OPENAI_STRONG_MODEL,
      purpose: "bank-letter-id-card-corners",
      reasoning: { effort: "low" },
      text: TEXT_FORMAT,
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
    });
    return readCornerAnswer(parseAiJson(response.outputText));
  } catch {
    return null;
  }
}

/** The model's orientation answer, read strictly. */
export function readOrientationAnswer(answer: Record<string, unknown>): "upright" | "upside_down" | null {
  return answer.orientation === "upright" || answer.orientation === "upside_down" ? answer.orientation : null;
}

/**
 * Whether a flat, landscape card picture reads upright or upside down — or null when no AI key is
 * set, the call fails or the model is unsure. Never throws.
 */
export async function findIdCardOrientation(jpeg: Buffer): Promise<"upright" | "upside_down" | null> {
  if (!hasAiApiKey()) return null;
  try {
    const response = await createOpenAiResponseText({
      input: [
        {
          content: [
            { text: "Is this ID card upright or upside down?", type: "input_text" as const },
            { detail: "low" as const, image_url: `data:image/jpeg;base64,${jpeg.toString("base64")}`, type: "input_image" as const },
          ],
          role: "user" as const,
        },
      ],
      instructions: ORIENTATION_INSTRUCTIONS,
      maxOutputTokens: 600,
      model: OPENAI_STRONG_MODEL,
      purpose: "bank-letter-id-card-orientation",
      reasoning: { effort: "low" },
      text: ORIENTATION_FORMAT,
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
    });
    return readOrientationAnswer(parseAiJson(response.outputText));
  } catch {
    return null;
  }
}
