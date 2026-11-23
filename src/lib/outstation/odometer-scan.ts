/**
 * Reading the odometer from a car trip's photo — the server half of odometer-scan-rules.ts (owner,
 * 2026-11-23). Through the one AI door (`createOpenAiResponseText`), the same way a train ticket is
 * read (ticket-scan.ts): no key, a failed call or a reply that is not JSON is `unavailable`, and the
 * photo is then KEPT as "not read" — an employee is never refused for the system's own outage.
 *
 * Read once, on the server, when the photo arrives: the arrival photo with the claim
 * (submitOutstationRequest), the departure photo when it is taken (captureOutstationDeparturePhoto).
 */

import { createOpenAiResponseText, hasAiApiKey, OPENAI_ROUTE_BUDGET_MS } from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/ai/parse-ai-json";
import { normalizeOdometerScan, ODOMETER_PROBLEMS, type OdometerRead } from "@/lib/outstation/odometer-scan-rules";

const INSTRUCTIONS = [
  "You read a car's dashboard from a photo taken by an employee on a business trip in Egypt.",
  "The photo carries a stamp panel at the bottom with a time, a place and an ID: ignore it entirely, it is not the dashboard.",
  "Return odometer_km: the car's TOTAL distance — the odometer, often marked ODO or km, usually the longest number on the display.",
  "Never return the trip meter (TRIP, TRIP A, TRIP B), the fuel range, the speed, the clock, the outside temperature or the fuel consumption as the odometer.",
  "Return the trip meter separately as trip_km when one is shown, else null.",
  "The digits may be on a digital display or on mechanical rollers; Arabic or Western digits.",
  "Return null for odometer_km unless you can read every digit of it with certainty. Never guess a digit.",
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
        is_dashboard: { type: "boolean" as const },
        odometer_km: { type: ["integer", "null"] as const },
        problems: { items: { enum: [...ODOMETER_PROBLEMS], type: "string" as const }, type: "array" as const },
        trip_km: { type: ["number", "null"] as const },
      },
      required: ["is_dashboard", "odometer_km", "trip_km", "problems"],
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

/** Reads one car photo (a JPEG). Never throws. */
export async function readCarOdometer(bytes: Buffer): Promise<OdometerRead> {
  if (!hasAiApiKey()) return { status: "unavailable" };
  const image = { detail: "high" as const, image_url: `data:image/jpeg;base64,${bytes.toString("base64")}`, type: "input_image" as const };
  try {
    const response = await createOpenAiResponseText({
      input: [{ content: [{ text: "Read this car's odometer.", type: "input_text" as const }, image], role: "user" as const }],
      instructions: INSTRUCTIONS,
      maxOutputTokens: 600,
      purpose: "outstation-car-odometer-scan",
      reasoning: { effort: "low" },
      text: TEXT_FORMAT,
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
    });
    return normalizeOdometerScan(parseAiJson(response.outputText));
  } catch {
    return { status: "unavailable" };
  }
}
