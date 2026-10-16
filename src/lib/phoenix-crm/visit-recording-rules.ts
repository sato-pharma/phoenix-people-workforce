/**
 * Phoenix CRM — the visit recording the Super Admin requires of the reps he chooses. Pure: no I/O, so the
 * recorder, the visit form and the server all read the same bounds.
 *
 * Owner, 2026-10-16: *"if i switch a toggle for a certain rep he is then required to be able to open a
 * voice recorder to be able to do any step in logging the visit … the conv between he and dr is recorded
 * then after that he can log this visit … this only works to who the admin choose not everyone"*. His
 * answers the same day: no consent tick in the app, doctor AND pharmacy visits, at most 15 minutes, at
 * least 30 seconds, a blocked microphone blocks the visit, the Super Admin, the SFE managers and the
 * rep's own managers above him listen, and the Super Admin downloads and deletes any recording at any
 * time — nothing is deleted on its own.
 *
 * 🔴 IT IS NOT THE VOICE NOTE. `voice-recorder.ts` is the rep's own optional one-minute comment, kept on
 * the visit form for everybody. This is the conversation itself, before the form opens, and only for the
 * reps on the Super Admin's list. Neither is a change to the other.
 *
 * 🔴 A REP NOT ON THE LIST SEES NOTHING NEW. The form answers `recordingRequired: false` and Add visit is
 * exactly what it was; the switch is the only thing that brings the recorder in front of a rep.
 */

/** The shortest recording that counts — a tap that opened and closed the microphone is not a visit. */
export const VISIT_RECORDING_MIN_SECONDS = 30;

/** Fifteen minutes; the recorder stops itself here and the visit form opens. */
export const VISIT_RECORDING_MAX_SECONDS = 15 * 60;

/** The bucket refuses anything larger; fifteen minutes of mono Opus at 24 kbps is about 2.7 MB. */
export const VISIT_RECORDING_MAX_BYTES = 16 * 1024 * 1024;

/** The server's own refusal when a required rep saves a visit with no recording. */
export const VISIT_RECORDING_REQUIRED_CODE = "phoenix_crm_recording_required";

/**
 * Every refusal that means "this recording cannot stand on this visit": the screen drops the recording it
 * holds and puts the recorder back in front of the rep, rather than offering a Save that cannot work.
 */
export function isVisitRecordingRefusal(code: string | null | undefined): boolean {
  return typeof code === "string" && (code === VISIT_RECORDING_REQUIRED_CODE || code.startsWith("phoenix_crm_recording_"));
}

/** Seconds as the reader says them: "4 min 05 s", "45 s". */
export function describeRecordingLength(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "Length not recorded";
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes === 0 ? `${rest} s` : `${minutes} min ${String(rest).padStart(2, "0")} s`;
}

/** Bytes as the reader says them: "2.4 MB", "640 KB". */
export function describeRecordingSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "Size not recorded";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The file name a downloaded recording is saved under: the rep, the customer and the day, so a folder of
 * them reads without opening any. Characters a file system refuses are dropped; Arabic is kept.
 */
export function recordingDownloadName(input: { repName: string; customerName: string; visitDate: string; extension: string }): string {
  const clean = (value: string) =>
    [...value]
      // Control characters are dropped by code point, so no regex carries one (no-control-regex).
      .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
      .join("")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  const parts = [input.visitDate, clean(input.repName), clean(input.customerName)].filter(Boolean);
  return `${parts.join(" - ") || "visit recording"}${input.extension}`;
}

/**
 * What a rep reads when the phone will not record (his answer 5: the visit cannot be logged, and the rep is
 * shown how to allow the microphone). Keyed by the `DOMException.name` `getUserMedia` throws. The blocked
 * sentence carries `BROWSER_PLACEHOLDER`, which the screen names at the render (`useBrowserNamed`).
 */
export function visitRecordingMicrophoneProblem(errorName: string | null | undefined, browserPlaceholder: string): string {
  if (errorName === "NotAllowedError" || errorName === "SecurityError" || errorName === "PermissionDeniedError") {
    return `The microphone is blocked for ${browserPlaceholder}. Open its settings, find this site, allow the microphone, then press Start recording again. The visit can be logged once it is recorded.`;
  }
  if (errorName === "NotFoundError" || errorName === "OverconstrainedError" || errorName === "DevicesNotFoundError") {
    return "No microphone was found on this phone. The visit can be logged once it is recorded, so record it on a phone with a working microphone.";
  }
  if (errorName === "NotReadableError" || errorName === "TrackStartError") {
    return "Another app is using the microphone, often a call. Close it, then press Start recording again.";
  }
  return "The recording could not start. Press Start recording again.";
}

/** A browser with no recorder at all: the rep is told where Phoenix records. */
export const VISIT_RECORDING_UNSUPPORTED =
  "This browser cannot record audio. Open Phoenix in Chrome on Android or Safari on iPhone, then record the visit there.";

/** The Super Admin's page: one row per rep, and one per recording. Shared by the server and the screen. */
export type RecordingRepRow = {
  hrId: string;
  name: string;
  lineName: string;
  areaName: string;
  regionName: string;
  required: boolean;
  setByName: string | null;
  setAt: string | null;
};

/**
 * 🔴 A RECORDED VISIT WAITS FOR THE ADMINISTRATOR FIRST, WHATEVER ITS TYPE (owner, 2026-10-16: *"any
 * visit any type which is recorder must go for adminstarator approval first even if in plan"*). Planned,
 * out of plan, out of list or a pharmacy: it counts in nothing until he approves it on the Visit
 * Recording page, and a recorded off-plan visit reaches the district manager and SFE only after his yes.
 * His refusal ends it. The decision is kept on the recording row (`review_status`), the one row every
 * recorded visit has; `phoenix_crm_countable_visits` reads it.
 */
export type RecordingReviewStatus = "pending" | "approved" | "refused";

export function isRecordingReviewStatus(value: unknown): value is RecordingReviewStatus {
  return value === "pending" || value === "approved" || value === "refused";
}

/** The Visit Recording page, where the Administrator approves or refuses a recorded visit. */
export const VISIT_RECORDING_ADMIN_PATH = "/admin/field-crm/visit-recording";

/** The refusal note's ceiling — the database's own (500). */
export const RECORDING_REVIEW_NOTE_MAX = 500;

/**
 * What the rep reads once a recorded visit is saved, in the owner's own words (2026-10-16: "show here ur
 * visit is pending admin approval"). It names a role, never a person and never a check (Golden Rule #1).
 * It never stops his next visit: every one waits on its own, and all of them stay pending until the
 * Administrator decides.
 */
export const RECORDED_VISIT_REP_NOTE = "Your visit is pending admin approval. It counts once it is approved.";

/**
 * Where a recorded visit's approval has got to, on the rep's OWN visit list — his own approval, shown so
 * he knows it is not counting yet, the same way an off-plan visit shows its step.
 */
export function recordingReviewRepLabel(status: RecordingReviewStatus): string {
  if (status === "approved") return "Approved — it counts";
  if (status === "refused") return "Not approved — it does not count";
  return "Pending admin approval";
}

export function recordingReviewLabel(status: RecordingReviewStatus): string {
  if (status === "approved") return "Approved — it counts";
  if (status === "refused") return "Refused — it does not count";
  return "Waiting for your approval";
}

export type RecordingListRow = {
  path: string;
  visitId: string;
  visitDate: string;
  capturedAt: string;
  repName: string;
  customerName: string;
  lineName: string;
  areaName: string;
  seconds: number | null;
  bytes: number | null;
  /** "Planned", "Out of plan", "Out of list" or "Pharmacy" — what the visit was, for the decision. */
  visitTypeLabel: string;
  reviewStatus: RecordingReviewStatus;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** The file was deleted; the visit is still decided on what the row says about it. */
  deleted: boolean;
};

export type VisitRecordingAdminView = {
  reps: RecordingRepRow[];
  /** Recorded visits waiting for the Administrator, oldest first — whatever their age, deleted file or not. */
  waiting: RecordingListRow[];
  recordings: RecordingListRow[];
  /** The window the recordings list covers, as Cairo days. */
  since: string;
  /** Whether this viewer is the Administrator, the one person who approves a recorded visit. */
  canReview: boolean;
};
