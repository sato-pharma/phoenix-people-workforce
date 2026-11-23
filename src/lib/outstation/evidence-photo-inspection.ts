/**
 * The one inspection of an arrival or departure photo, run by the server before anything is stored
 * (owner, 2026-11-23, after the District Manager expense inspection). The claim submit and the departure
 * capture both call this, so the two photos can never be judged by two drifting copies of the rule.
 *
 *   1. The frame is measured (blank-frame.ts). A blank one — black, white, a covered lens — is REFUSED
 *      with what to do, and the employee takes it again.
 *   2. On a car trip the odometer is read from the photo (odometer-scan-rules.ts). A photo the system
 *      cannot read is REFUSED with what to do, exactly as an unreadable ticket is. A blank frame holds
 *      no odometer and is never sent to the reader.
 *
 * 🔴 IT NEVER COSTS THE EMPLOYEE HIS CLAIM FOR THE SYSTEM'S OWN FAULT. A photo the server could not open
 *    (`measure` answers null) and a reader that could not be reached (`unavailable`) refuse nothing: the
 *    photo is kept, and the desk says it could not check.
 * 🔴 TWO CASES KEEP THE PHOTO INSTEAD OF REFUSING IT (`mayRefuse: false`): an offline replay — the person
 *    is no longer there to take it again — and a role that owes no photo at all (evidence-waiver.ts). The
 *    reading is still kept, so the approver sees the blank or unreadable photo on Expense Approvals.
 *
 * The measuring and the reading are passed in (the server passes `measureEvidencePhoto` and
 * `readCarOdometer`), so this holds no image library and no network call of its own.
 */

import { blankFrameRefusal, OutstationPhotoRefusedError, type FrameReading } from "@/lib/outstation/blank-frame";
import { odometerRecordOf, odometerRefusalMessage, type OdometerRead, type OutstationOdometerRecord } from "@/lib/outstation/odometer-scan-rules";

export type EvidencePhotoInspection = {
  /** The frame's measure, kept on the photo's metadata; null when the photo could not be opened. */
  frame: FrameReading | null;
  /** The odometer reading, kept on the photo's metadata; null when the trip is not by car. */
  odometer: OutstationOdometerRecord | null;
};

/** Throws `OutstationPhotoRefusedError` (a 400 the employee acts on) when the photo is refused. */
export async function inspectEvidencePhoto(input: {
  bytes: Buffer;
  car: boolean;
  mayRefuse: boolean;
  measure: (bytes: Buffer) => Promise<FrameReading | null>;
  now: string;
  photo: "arrival" | "departure";
  readOdometer: (bytes: Buffer) => Promise<OdometerRead>;
}): Promise<EvidencePhotoInspection> {
  const frame = await input.measure(input.bytes);
  if (frame?.blank && input.mayRefuse) throw new OutstationPhotoRefusedError(blankFrameRefusal(input.photo, frame));
  if (!input.car) return { frame, odometer: null };
  const read: OdometerRead = frame?.blank ? { problems: ["display_off"], status: "unreadable" } : await input.readOdometer(input.bytes);
  if (read.status === "unreadable" && input.mayRefuse) throw new OutstationPhotoRefusedError(odometerRefusalMessage(input.photo, read));
  return { frame, odometer: odometerRecordOf(read, input.now) };
}
