// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What a rep is told when his signboard photo could not be confirmed.
//
// Owner, 2026-10-08, in his own words: "it's very frustrating to a rep that after he validates and
// the system accept, for the admin to reject and it is not validated again in the rep list."
//
// He was right about every link in it. Measured over the module's first five days: 27 rejections, 23
// of them one rep and 20 of those inside a single three-minute burst; a lag from validating to being
// rejected of 1.3 to 69.3 hours; NO notification path to the rep anywhere in the module; the
// mandatory reason note holding the single character "-" twenty-two times out of twenty-four; a
// reopened customer given no priority at all in a pool of 10,845; and 0 of the 22 still-pending
// reopened customers re-validated, having waited 40.8 hours on average and 76.7 at the oldest.
//
// 🔴 THIS BENDS GOLDEN RULE #1, AND ONLY THIS FAR. The rep's app is easy and blind: he never learns
// that a PERSON accepted or rejected him, and the module's existing wording is impersonal on purpose
// ("The system is checking this place", "Validate again"). What he may now learn is what is wrong
// with HIS PHOTO, from a CLOSED list the owner approved, in an imperative sentence that names no
// person, no role, no decision and no threshold. The free-text note stays private — which is the
// reason the two decision screens' labels moved from "never shown to the rep" to "the rep reads only
// the reason you chose", rather than the promise being quietly broken.
//
// WHY NOT IN google-place-rules.ts, where the other rep-facing strings live: that file is the
// AUTOMATIC verdict, and `googleCheckApplies` makes it AM-only. These reasons are a human's reading
// of a photograph and they apply to a PM refusal through `refuseValidatedPlace` just as much. A
// reason sitting beside `judgeGooglePlace` would read to every later session as something the Google
// check said.
//
// 🔴 No string here may contain "doctor", "doctors", "account" or "accounts" —
// tests/phoenix-crm-am-pm-words.test.ts sweeps this tree and refuses them. "customer" and "clinic".
//
// The long account, with the per-cause counts behind each of the six:
// docs/phoenix-crm-validation-feedback.md.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The six things the 643 photos actually failed on, as graded one by one.
 *
 * CLOSED on purpose. A seventh needs the owner's word, because every one of these is a sentence that
 * reaches a rep's phone, and a list anybody could extend is a list that will eventually tell him
 * something nobody approved. The counts behind them: 57 street shots with no building, 36 blank or
 * featureless walls, 23 too dark to read, 20 taken from a vehicle, 14 photographs of paper.
 */
export const VALIDATION_REFUSAL_REASONS = [
  {
    key: "no_signboard",
    label: "No signboard in the photo",
    rep: "The photo does not show the clinic's signboard. Stand where the sign is readable, then take it again.",
  },
  {
    key: "wrong_name",
    label: "The sign is not this customer",
    rep: "The name on the sign in this photo is not this customer's. Take the photo at this customer's own entrance.",
  },
  {
    key: "too_dark",
    label: "Too dark or blurred to read",
    rep: "The photo is too dark or too blurred to read. Take it again with more light, and hold the phone still.",
  },
  {
    key: "not_at_door",
    label: "Not taken at the entrance",
    rep: "This photo was not taken at the entrance — it looks taken from a distance or from a vehicle. Stand at the door and take it again.",
  },
  {
    key: "photo_of_paper",
    label: "A photo of paper, not a building",
    rep: "The photo shows paper or a screen rather than the clinic itself. Take a live photo of the building and its sign.",
  },
  {
    key: "point_off",
    label: "The location is not where the photo was taken",
    // The one reason that mentions his readings at all. It bends nothing new: PLACE_PRECISION_NOTE
    // already tells him the same thing before he starts, by the owner's own 2026-10-03 amendment.
    rep: "The location saved with this photo is not where the photo was taken. Turn precise location on, wait for it to settle, then take the photo and capture the location again.",
  },
] as const;

export type ValidationRefusalReason = (typeof VALIDATION_REFUSAL_REASONS)[number]["key"];

/** Every key, for the SQL CHECK and for a select. The test compares this list against the CHECK. */
export const VALIDATION_REFUSAL_REASON_KEYS: readonly ValidationRefusalReason[] =
  VALIDATION_REFUSAL_REASONS.map((reason) => reason.key);

/** The one parser. A value off the wire is never trusted to be one of the six. */
export function parseValidationRefusalReason(value: unknown): ValidationRefusalReason | null {
  const key = String(value ?? "").trim();
  return (
    VALIDATION_REFUSAL_REASON_KEYS.find((candidate) => candidate === key) ?? null
  );
}

/** What the Super Admin picked, for his own screens and for the report. */
export function validationRefusalLabel(key: string | null): string | null {
  if (!key) return null;
  return VALIDATION_REFUSAL_REASONS.find((reason) => reason.key === key)?.label ?? null;
}

/** What the rep reads. Null for a reason this module does not know, so the caller falls back. */
export function validationRefusalRepText(key: string | null): string | null {
  if (!key) return null;
  return VALIDATION_REFUSAL_REASONS.find((reason) => reason.key === key)?.rep ?? null;
}

/** Under the note box on both decision screens, so the new split is stated where it is used. */
export const VALIDATION_NOTE_HINT =
  "Kept on the record for you. The rep reads only the reason you chose above.";

/** Above the picker. It says who reads it, because that is the thing that changed. */
export const VALIDATION_REASON_LABEL = "What is wrong with the photo (the rep is told this)";
/** The empty option, so nothing is submitted by accident. */
export const VALIDATION_REASON_PLACEHOLDER = "Choose what is wrong";
/** The refusal when a rejection arrives without one. */
export const VALIDATION_REASON_REQUIRED =
  "Choose what is wrong with the photo — the rep is told this.";
/** On the note box, replacing the old "never shown to the rep". The promise it made is still kept. */
export const VALIDATION_NOTE_LABEL = "Note for the record (the rep reads only the reason above)";
