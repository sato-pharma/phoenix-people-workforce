/**
 * Reading the odometer from a car trip's photo — the server half of odometer-scan-rules.ts (owner,
 * 2026-11-23). Through the one AI door (`createOpenAiResponseText`), the same way a train ticket is
 * read (ticket-scan.ts): no key, a failed call or a reply that is not JSON is `unavailable`, and the
 * photo is then KEPT as "not read" — an employee is never refused for the system's own outage.
 *
 * Read once, on the server, when the photo arrives: the arrival photo with the claim
 * (submitOutstationRequest), the departure photo when it is taken (captureOutstationDeparturePhoto).
 *
 * 🔴 THE PHOTO IS SHOWN FOUR WAYS IN ONE LOOK, AND THE STRONG MODEL READS THE VIEW WHOSE DIGITS STAND UPRIGHT
 * (owner, 2026-11-25: "make the odometer reader read sideways digits"; odometer-scan-rules.ts says why). A car
 * trip has two photos, so the strong tier costs a few photos a day.
 */

import { createOpenAiResponseText, hasAiApiKey, OPENAI_ROUTE_BUDGET_MS, OPENAI_STRONG_MODEL } from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/ai/parse-ai-json";
import {
  normalizeOdometerScan,
  ODOMETER_PROBLEMS,
  ODOMETER_SCAN_MAX_OUTPUT_TOKENS,
  ODOMETER_VIEW_NAMES,
  ODOMETER_VIEW_TURNS,
  type OdometerRead,
} from "@/lib/outstation/odometer-scan-rules";

const INSTRUCTIONS = [
  "You read a car's dashboard from a photo taken by an employee on a business trip in Egypt.",
  `You get the SAME photo ${ODOMETER_VIEW_TURNS.length} times: ${ODOMETER_VIEW_NAMES.map((name, index) => `image ${index + 1} ${name}`).join(", ")}.`,
  "The odometer's digits are often on their side in the photo as taken — a narrow display, or a phone held sideways.",
  "Find the image in which the odometer's own digits stand upright and read left to right, and read the odometer there.",
  "Judge which image is upright only by the odometer's digits, never by the speedometer numbers or the stamp text.",
  "The photo carries a stamp panel with a time, a place and an ID: ignore it entirely, it is not the dashboard.",
  "Return odometer_km: the car's TOTAL distance — the odometer, often marked ODO or km, usually the longest number on the display.",
  "Never return the trip meter (TRIP, TRIP A, TRIP B), the fuel range, the speed, the clock, the outside temperature or the fuel consumption as the odometer.",
  "Return the trip meter separately as trip_km only when a TRIP reading is shown, else null; a clock time such as 16:21 is never the trip meter.",
  "The digits may be on a digital display or on mechanical rollers; Arabic or Western digits.",
  "Return null for odometer_km unless you can read every digit of it with certainty. Never guess a digit.",
  "Never drop or skip a digit either — the last digit beside the km mark included: if any one digit cannot be read, odometer_km is null.",
  "digit_count: how many digits the odometer display shows, counted one by one before you read them; null when you cannot count them.",
  "upright_image is the number of the image you read the odometer in, else null.",
  "is_dashboard is false when the photo does not show a car dashboard at all.",
  "problems: when odometer_km is null, list every photo problem that stopped you, from:",
  "not_a_dashboard, display_off (the dashboard is dark or shows no kilometres), too_far (the number is too small to read),",
  "cut_off (digits are outside the frame or covered), blurry, dark, glare.",
  "When the odometer is read, problems is an empty list.",
].join(" ");

const TEXT_FORMAT = {
  format: {
    name: "phoenix_car_odometer",
    schema: {
      additionalProperties: false,
      properties: {
        // A counting aid, never checked against the reading: rollers show leading zeros (057108 is 57,108 in six
        // digits), so a shorter number is no misread. Asked for it, the reader stopped dropping Dina Hamdy's last
        // digit (48,144 for 481,442 on 5 reads of 8 before, 0 of 16 after).
        digit_count: { type: ["integer", "null"] as const },
        is_dashboard: { type: "boolean" as const },
        odometer_km: { type: ["integer", "null"] as const },
        problems: { items: { enum: [...ODOMETER_PROBLEMS], type: "string" as const }, type: "array" as const },
        trip_km: { type: ["number", "null"] as const },
        upright_image: { type: ["integer", "null"] as const },
      },
      required: ["is_dashboard", "odometer_km", "digit_count", "trip_km", "problems", "upright_image"],
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

/** The photo in each view of ODOMETER_VIEW_TURNS, in that order; null when it cannot be turned. */
export async function odometerViewsOf(bytes: Buffer): Promise<Buffer[] | null> {
  try {
    const { default: sharp } = await import("sharp");
    return await Promise.all(ODOMETER_VIEW_TURNS.map((turn) => (turn === 0 ? bytes : sharp(bytes).rotate(turn).jpeg({ quality: 92 }).toBuffer())));
  } catch {
    return null;
  }
}

const imageOf = (bytes: Buffer) => ({ detail: "high" as const, image_url: `data:image/jpeg;base64,${bytes.toString("base64")}`, type: "input_image" as const });

/** What is asked of the AI door for one photo's views (exported so the test reads the real request). */
export function odometerScanRequest(views: Buffer[]) {
  return {
    input: [{ content: [{ text: "Read this car's odometer.", type: "input_text" as const }, ...views.map(imageOf)], role: "user" as const }],
    instructions: INSTRUCTIONS,
    // 600 was too little for the second provider: its thinking spends the same budget, and on 24 and
    // 25 Nov 2026 it stopped mid-answer ("ran out of room… max_tokens") on two of the first three
    // arrival photos, so neither was read. The answer itself is five short fields.
    maxOutputTokens: ODOMETER_SCAN_MAX_OUTPUT_TOKENS,
    model: OPENAI_STRONG_MODEL,
    purpose: "outstation-car-odometer-scan",
    reasoning: { effort: "low" as const },
    text: TEXT_FORMAT,
    timeoutMs: OPENAI_ROUTE_BUDGET_MS,
  };
}

/** Reads one car photo (a JPEG). Never throws: no key, a photo that cannot be turned or a failed call is `unavailable`. */
export async function readCarOdometer(bytes: Buffer): Promise<OdometerRead> {
  if (!hasAiApiKey()) return { status: "unavailable" };
  const views = await odometerViewsOf(bytes);
  if (!views) return { status: "unavailable" };
  try {
    const response = await createOpenAiResponseText(odometerScanRequest(views));
    return normalizeOdometerScan(parseAiJson(response.outputText));
  } catch {
    return { status: "unavailable" };
  }
}
