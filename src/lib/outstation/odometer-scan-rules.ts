/**
 * Reading the odometer from a car trip's photos — the pure half (owner, 2026-11-23: "the system reads the
 * odometer from the car photo"). The server half is odometer-scan.ts.
 *
 * Why: on 23 Nov 136 of the 207 car claims filed since July carried a typed kilometre reading of 0 or
 * nothing, and the photos showed what the typed field never caught — claim 163 shows 7 km on the
 * odometer after claim 162, and two trips chained without the car going home. So the typed field is
 * gone; the arrival and departure photos of a car trip are READ, and each reading is kept beside its
 * photo (`odometer` on the photo's metadata) for the desk to chain against the person's earlier trips.
 *
 *  - A reading the system can make is kept: `read`, with the kilometres.
 *  - A photo the system cannot read is REFUSED with what to do (too far, blurred, the display off...),
 *    exactly as a ticket is — the employee takes it again.
 *  - When the reader itself cannot be reached the photo is KEPT, marked `not_read` — an employee is never
 *    refused for the system's own outage. The desk then says it could not check.
 *  - 🔴 A PHOTO IS REFUSED FOR ITS ODOMETER ONCE, NEVER TWICE (owner, 2026-11-25: "Fix the odometer reader",
 *    after Dina Hamdy retook a sharp, lit night photo of 481,456 km for about half an hour). The phone counts
 *    the refusals it was given and sends the count; from the second photo on, the photo is KEPT, marked
 *    `unreadable` with `refusedTries`, and Expense Approvals fails its Odometer check so the approver reads
 *    the photo. A forged count only files the claim in Your call: it never passes the check.
 *  - 🔴 A DEPARTURE READING BELOW THE SAME TRIP'S ARRIVAL READING IS A MISREAD, refused once like an unreadable
 *    photo (claim 423, 25 Nov 2026: 57,108 km on arrival, 51,109 km at departure). Kept on the second photo,
 *    and the desk then fails "The odometer went down during the trip".
 *  - A claim filed before this rule has no `odometer` on its photo at all, and the desk prints no line.
 */

export type OdometerProblem = "not_a_dashboard" | "display_off" | "too_far" | "cut_off" | "blurry" | "dark" | "glare";

export const ODOMETER_PROBLEMS: readonly OdometerProblem[] = [
  "not_a_dashboard",
  "display_off",
  "too_far",
  "cut_off",
  "blurry",
  "dark",
  "glare",
];

/** What the employee should do about each problem — an instruction, never a diagnosis. */
export const ODOMETER_GUIDANCE: Record<OdometerProblem, string> = {
  blurry: "Hold the phone still and tap the screen on the odometer so it focuses before you take the photo.",
  cut_off: "Keep the whole kilometre number in the photo — none of its digits cut off.",
  dark: "Switch the car on so the dashboard lights up, or take the photo in more light.",
  display_off: "Switch the ignition on so the dashboard shows the kilometre number.",
  glare: "Tilt the phone so no light reflects on the dashboard glass.",
  not_a_dashboard: "Take the photo of the car's dashboard, with the odometer (the total kilometres) in view.",
  too_far: "Move the phone closer — the kilometre number should be large and clear in the photo.",
};

/** What the system needs from a car photo, said with every refusal. */
export const ODOMETER_NEEDS =
  "On a car trip the system reads the car's total kilometres from this photo, so the odometer must be in it, lit and sharp.";

export type OdometerRead =
  | { status: "read"; km: number; tripKm: number | null }
  | { status: "unreadable"; problems: OdometerProblem[] }
  | { status: "unavailable" };

/**
 * What is kept on the photo's metadata. `unreadable` is kept by an offline replay, a role that owes no photo,
 * and a photo taken after the system had already refused one for its odometer (`refusedTries`).
 */
export type OutstationOdometerRecord = {
  km: number | null;
  readAt: string;
  /** How many photos the system refused for their odometer before keeping this one; absent when none was. */
  refusedTries?: number;
  status: "read" | "not_read" | "unreadable";
  tripKm: number | null;
};

/** Refused this many times for its odometer, the next photo is kept and the approver reads it (owner, 2026-11-25). */
export const ODOMETER_REFUSALS_BEFORE_KEEPING = 1;

/** The count of earlier odometer refusals a phone sends: a whole number from 0 to 20, anything else 0. */
export function odometerRefusedTriesOf(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : 0;
  return Number.isInteger(number) && number > 0 ? Math.min(number, 20) : 0;
}

/** True while the system may still refuse a photo for its odometer: only before its first such refusal. */
export function odometerMayRefuse(refusedTries: number): boolean {
  return refusedTries < ODOMETER_REFUSALS_BEFORE_KEEPING;
}

/**
 * The room the reader gets for its answer, thinking included: the second provider counts both against it, and
 * 600 stopped it mid-answer on two of the first three arrival photos (24 and 25 Nov 2026), so neither was read.
 */
export const ODOMETER_SCAN_MAX_OUTPUT_TOKENS = 2_000;

/** No car on the road has driven a million kilometres; a longer number is a misread. */
const MAX_ODOMETER_KM = 999_999;

const wholeKm = (value: unknown): number | null => {
  // Nothing is not zero: an empty value never becomes a 0 km reading.
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const number = typeof value === "number" ? value : Number(String(value ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(number) && number >= 0 && number <= MAX_ODOMETER_KM ? Math.round(number) : null;
};

/** A model's answer, made safe: kilometres only when they are a real whole number, problems only from the list. */
export function normalizeOdometerScan(raw: Record<string, unknown>): OdometerRead {
  const km = raw.odometer_km === null || raw.odometer_km === undefined ? null : wholeKm(raw.odometer_km);
  if (raw.is_dashboard !== false && km !== null) {
    const trip = raw.trip_km === null || raw.trip_km === undefined ? null : Number(raw.trip_km);
    return { km, status: "read", tripKm: Number.isFinite(trip) && (trip as number) >= 0 ? Math.round((trip as number) * 10) / 10 : null };
  }
  const problems = (Array.isArray(raw.problems) ? raw.problems : [])
    .map((entry) => String(entry))
    .filter((entry): entry is OdometerProblem => (ODOMETER_PROBLEMS as readonly string[]).includes(entry));
  if (raw.is_dashboard === false && !problems.includes("not_a_dashboard")) problems.unshift("not_a_dashboard");
  if (problems.length === 0) problems.push("blurry");
  return { problems: [...new Set(problems)], status: "unreadable" };
}

export function odometerRecordOf(read: OdometerRead, readAt: string, refusedTries = 0): OutstationOdometerRecord {
  const tries = refusedTries > 0 ? { refusedTries } : {};
  if (read.status === "read") return { km: read.km, readAt, status: "read", tripKm: read.tripKm, ...tries };
  return { km: null, readAt, status: read.status === "unavailable" ? "not_read" : "unreadable", tripKm: null, ...tries };
}

/** Said at the end of every odometer refusal: the next photo is not refused again. */
export const ODOMETER_NEXT_PHOTO_KEPT =
  "If the system still cannot read your next photo, that photo is kept and your approver reads the kilometres from it.";

/** The one message a refused car photo raises: why, then what to do, then what the system needs. */
export function odometerRefusalMessage(photo: "arrival" | "departure", read: Extract<OdometerRead, { status: "unreadable" }>): string {
  const which = photo === "arrival" ? "arrival photo" : "departure photo";
  const reason = read.problems.includes("not_a_dashboard")
    ? `Not accepted: this ${which} does not show the car's odometer.`
    : `Not accepted: the system could not read the kilometres on this ${which}.`;
  const guidance = read.problems.map((problem) => ODOMETER_GUIDANCE[problem]).join(" ");
  return `${reason} ${guidance} ${ODOMETER_NEEDS} ${ODOMETER_NEXT_PHOTO_KEPT}`.trim();
}

/**
 * A departure reading below the same trip's arrival reading: one of the two is a misread (claim 423). Null when
 * either was not read, or when the departure is not below.
 */
export function departureBelowArrivalMessage(arrival: OutstationOdometerRecord | null | undefined, departure: OdometerRead): string | null {
  if (departure.status !== "read" || arrival?.status !== "read" || arrival.km === null || departure.km >= arrival.km) return null;
  return [
    `Not accepted: this departure photo reads ${kmLabel(departure.km)} km, less than the ${kmLabel(arrival.km)} km on your arrival photo, so a digit was misread.`,
    ODOMETER_GUIDANCE.blurry,
    ODOMETER_GUIDANCE.too_far,
    ODOMETER_NEXT_PHOTO_KEPT,
  ].join(" ");
}

/**
 * The reading kept on a photo's metadata. `undefined` = the photo was taken before this rule (no
 * `odometer` key at all) — never the same as a reading that failed.
 */
export function odometerOfMetadata(metadata: unknown): OutstationOdometerRecord | undefined {
  if (!metadata || typeof metadata !== "object" || !("odometer" in metadata)) return undefined;
  return odometerFromValue((metadata as { odometer?: unknown }).odometer);
}

/** A stored `odometer` value, read safely; `undefined` when it is not one. */
export function odometerFromValue(value: unknown): OutstationOdometerRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const status = record.status === "read" || record.status === "not_read" || record.status === "unreadable" ? record.status : null;
  if (!status) return undefined;
  const km = wholeKm(record.km);
  if (status === "read" && km === null) return undefined;
  const refusedTries = odometerRefusedTriesOf(record.refusedTries);
  return {
    km: status === "read" ? km : null,
    readAt: typeof record.readAt === "string" ? record.readAt : "",
    ...(refusedTries > 0 ? { refusedTries } : {}),
    status,
    tripKm: typeof record.tripKm === "number" && Number.isFinite(record.tripKm) ? record.tripKm : null,
  };
}

/** "52,612" — kilometres as people read them. */
export function kmLabel(km: number): string {
  return Math.round(km).toLocaleString("en-US");
}
