/**
 * Phoenix CRM — open the REAR camera, and only fall back to another lens when the phone has no way
 * to say which one is the rear.
 *
 * A signboard or nameplate is photographed with the back lens. `facingMode: { ideal: "environment" }`
 * is only a preference, and Chrome adds it to the resolution wishes when it ranks the lenses, so a
 * phone whose selfie lens fits the wished-for size better (a Samsung did, 19 Oct 2026) opens the
 * front camera and the rep photographs his own face. The rear lens is therefore ASKED FOR with
 * `exact`; only an answer that says "no lens matches" (a laptop's one webcam, a phone that reports no
 * facing) falls back to the preference. A refused permission is never retried: it is the rep's answer.
 *
 * THE REP MAY SWITCH TO THE FRONT LENS (owner, 2026-11-02: "when live camera is open to be able to
 * switch front camera to back camera"). The camera still OPENS on the rear lens every time; the switch is
 * the rep's own press, offered only on a phone that has more than one lens (`hasSecondCamera`). The front lens
 * is asked for the same way — `exact` first, the preference only when no lens matches — and the frame is
 * never mirrored, so the letters on a sign read the right way round in the stored photo.
 *
 * A leaf module with no imports, so the camera component and its test both reach it.
 */

export type CameraFacing = "environment" | "user";

type VideoSize = { height: number; width: number };

type CameraDevices = Pick<MediaDevices, "enumerateDevices" | "getUserMedia">;

/** Errors that mean "this constraint matches no lens", which is the only reason to ask more loosely. */
const NO_MATCHING_LENS = new Set(["OverconstrainedError", "ConstraintNotSatisfiedError", "NotFoundError"]);

/** A lens the phone itself names as a back one. */
const REAR_LABEL = /\b(back|rear|environment|world)\b|خلف/i;

function errorName(error: unknown): string {
  return error instanceof Error || (typeof DOMException !== "undefined" && error instanceof DOMException) ? error.name : "";
}

function stopStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

function facingOf(stream: MediaStream): string | undefined {
  return stream.getVideoTracks()[0]?.getSettings?.().facingMode;
}

export async function openRearCamera(devices: CameraDevices, ideal: VideoSize): Promise<MediaStream> {
  const sizes = { height: { ideal: ideal.height }, width: { ideal: ideal.width } };
  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia({ audio: false, video: { facingMode: { exact: "environment" }, ...sizes } });
  } catch (error) {
    if (!NO_MATCHING_LENS.has(errorName(error))) throw error;
    stream = await devices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, ...sizes } });
  }
  if (facingOf(stream) !== "user") return stream;

  // The phone still handed over the selfie lens: find a lens it names as a back one and open that.
  try {
    const lenses = (await devices.enumerateDevices()).filter((device) => device.kind === "videoinput" && REAR_LABEL.test(device.label));
    const rear = lenses[0];
    if (!rear?.deviceId) return stream;
    const rearStream = await devices.getUserMedia({ audio: false, video: { deviceId: { exact: rear.deviceId }, ...sizes } });
    stopStream(stream);
    return rearStream;
  } catch {
    return stream;
  }
}

/** The selfie lens, opened only when the rep presses Switch camera. A refused permission is never retried. */
export async function openFrontCamera(devices: CameraDevices, ideal: VideoSize): Promise<MediaStream> {
  const sizes = { height: { ideal: ideal.height }, width: { ideal: ideal.width } };
  try {
    return await devices.getUserMedia({ audio: false, video: { facingMode: { exact: "user" }, ...sizes } });
  } catch (error) {
    if (!NO_MATCHING_LENS.has(errorName(error))) throw error;
    return devices.getUserMedia({ audio: false, video: { facingMode: { ideal: "user" }, ...sizes } });
  }
}

/** True when the phone has a second lens to switch to. A failed read answers no, so no dead button is drawn. */
export async function hasSecondCamera(devices: Pick<MediaDevices, "enumerateDevices">): Promise<boolean> {
  try {
    return (await devices.enumerateDevices()).filter((device) => device.kind === "videoinput").length > 1;
  } catch {
    return false;
  }
}
