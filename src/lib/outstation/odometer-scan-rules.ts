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

/** What is kept on the photo's metadata. `unreadable` is kept only by an offline replay, which cannot refuse. */
export type OutstationOdometerRecord = {
  km: number | null;
  readAt: string;
  status: "read" | "not_read" | "unreadable";
  tripKm: number | null;
};

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

export function odometerRecordOf(read: OdometerRead, readAt: string): OutstationOdometerRecord {
  if (read.status === "read") return { km: read.km, readAt, status: "read", tripKm: read.tripKm };
  return { km: null, readAt, status: read.status === "unavailable" ? "not_read" : "unreadable", tripKm: null };
}

/** The one message a refused car photo raises: why, then what to do, then what the system needs. */
export function odometerRefusalMessage(photo: "arrival" | "departure", read: Extract<OdometerRead, { status: "unreadable" }>): string {
  const which = photo === "arrival" ? "arrival photo" : "departure photo";
  const reason = read.problems.includes("not_a_dashboard")
    ? `Not accepted: this ${which} does not show the car's odometer.`
    : `Not accepted: the system could not read the kilometres on this ${which}.`;
  const guidance = read.problems.map((problem) => ODOMETER_GUIDANCE[problem]).join(" ");
  return `${reason} ${guidance} ${ODOMETER_NEEDS}`.trim();
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
  return {
    km: status === "read" ? km : null,
    readAt: typeof record.readAt === "string" ? record.readAt : "",
    status,
    tripKm: typeof record.tripKm === "number" && Number.isFinite(record.tripKm) ? record.tripKm : null,
  };
}

/** "52,612" — kilometres as people read them. */
export function kmLabel(km: number): string {
  return Math.round(km).toLocaleString("en-US");
}
