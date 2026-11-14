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
// 🔴 THE FREE-TEXT COMMENT STOPPED BEING PRIVATE ON 2026-11-01 (owner: "when sfe or admin reject or
// approve validation and write the comment this comment appear to the rep and his manager"). A comment
// written WITH a decision now reaches both through the one door a rep already reads a person's words by
// — `phoenix_crm_place_notes`, by role and never by name. A note written before that day was written
// under the old promise and stays private: `decision_note` is never read on the rep's side.
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
// The long account, with the per-cause counts behind each of the first six:
// docs/phoenix-crm-validation-feedback.md. The seventh and eighth, and why a timetable refusal is a
// different pick-list from a signboard one: docs/phoenix-crm-shared-places.md.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * WHAT THE PHOTO WAS: the sign on a building, or the TIMETABLE hanging inside a shared place.
 *
 * Two kinds, because one photograph cannot be wrong in the other's ways. A timetable IS paper, so "a
 * photo of paper, not a building" is wrong by construction about one; and a customer seated in a
 * shared place has no location of his own at all — his point is the venue's, taken once at its door —
 * so neither "point_off" nor "not_at_door" can honestly be said about his capture either.
 */
export type ValidationPhotoKind = "signboard" | "schedule";

/**
 * WHAT IS BEING REFUSED on a decision screen: a customer's own photo (one of the two kinds above), or
 * the BUILDING of a shared place itself. A building is a signboard photo with no person behind it, so it
 * is offered the six signboard reasons and never `short_name`, which is about a customer's name — and
 * `phoenix_crm_shared_places`' own CHECK does not hold it.
 */
export type ValidationPickKind = ValidationPhotoKind | "building";

/**
 * The six things the 643 photos actually failed on, as graded one by one — the two the owner added on
 * 2026-10-09 for the timetable of a shared place — and the ninth, `short_name`, by his word of
 * 2026-11-07: a clinic customer still carrying one or two names is sent back for all three.
 *
 * CLOSED on purpose. A tenth needs the owner's word, because every one of these is a sentence that
 * reaches a rep's phone, and a list anybody could extend is a list that will eventually tell him
 * something nobody approved. The counts behind the first six: 57 street shots with no building, 36
 * blank or featureless walls, 23 too dark to read, 20 taken from a vehicle, 14 photographs of paper.
 *
 * `kinds` is what `reasonsFor` offers and is never a free choice: a reason is listed under every kind
 * of photo it can honestly be said about, and under no other.
 */
export const VALIDATION_REFUSAL_REASONS = [
  {
    key: "no_signboard",
    label: "No signboard in the photo",
    rep: "The photo does not show the clinic's signboard. Stand where the sign is readable, then take it again.",
    kinds: ["signboard", "building"],
  },
  {
    key: "wrong_name",
    label: "The sign is not this customer",
    rep: "The name on the sign in this photo is not this customer's. Take the photo at this customer's own entrance.",
    kinds: ["signboard", "building"],
  },
  {
    key: "too_dark",
    // The one reason both kinds share: a photograph can be unreadable whatever it is of.
    label: "Too dark or blurred to read",
    rep: "The photo is too dark or too blurred to read. Take it again with more light, and hold the phone still.",
    kinds: ["signboard", "schedule", "building"],
  },
  {
    key: "not_at_door",
    label: "Not taken at the entrance",
    rep: "This photo was not taken at the entrance — it looks taken from a distance or from a vehicle. Stand at the door and take it again.",
    kinds: ["signboard", "building"],
  },
  {
    key: "photo_of_paper",
    label: "A photo of paper, not a building",
    rep: "The photo shows paper or a screen rather than the clinic itself. Take a live photo of the building and its sign.",
    // 🔴 NEVER on a timetable. A timetable is paper, so this sentence would send a rep back to
    // photograph a building he was never asked for.
    kinds: ["signboard", "building"],
  },
  {
    key: "point_off",
    label: "The location is not where the photo was taken",
    // The one reason that mentions his readings at all. It bends nothing new: PLACE_PRECISION_NOTE
    // already tells him the same thing before he starts, by the owner's own 2026-10-03 amendment.
    rep: "The location saved with this photo is not where the photo was taken. Turn precise location on, wait for it to settle, then take the photo and capture the location again.",
    kinds: ["signboard", "building"],
  },
  {
    // The seventh (owner, 2026-10-09): the timetable is readable and this customer is not on it.
    key: "schedule_other_name",
    label: "The timetable does not name this customer",
    // No pronoun, deliberately: `A_PERSON` in phoenix-crm-validation-feedback.test.ts refuses "he " in
    // a reason, because a sentence that reads as being about a PERSON is what golden rule #1 forbids —
    // so the hours are named beside the name instead.
    rep: "The timetable in this photo does not show this customer's name. Photograph the timetable that names this customer, with the hours beside the name.",
    kinds: ["schedule"],
  },
  {
    // The eighth: whatever was photographed, it was not a timetable.
    key: "schedule_missing",
    label: "No timetable in the photo",
    rep: "There is no timetable in this photo. Photograph the schedule on the wall showing who receives and at what hours.",
    kinds: ["schedule"],
  },
  {
    // The ninth (owner, 2026-11-07: "Must enter the three names"; for the validations already waiting
    // with a short name, "Send them back to the rep"). About the customer's NAME, not the photograph, so
    // it is offered on a customer's own signboard and on a seated customer's timetable — never on a
    // building, which has no person's name (`phoenix_crm_shared_places`' CHECK does not hold it).
    key: "short_name",
    label: "Only one or two names — needs the full name",
    rep: "Write this customer's first, middle and last name as the sign or the timetable shows them, then validate again.",
    kinds: ["signboard", "schedule"],
  },
] as const;

export type ValidationRefusalReason = (typeof VALIDATION_REFUSAL_REASONS)[number]["key"];

/** Every key, for the SQL CHECK and for a select. The test compares this list against the CHECK. */
export const VALIDATION_REFUSAL_REASON_KEYS: readonly ValidationRefusalReason[] =
  VALIDATION_REFUSAL_REASONS.map((reason) => reason.key);

/**
 * The reasons that may be OFFERED about one kind of photo, or about a building.
 *
 * The parser below still accepts any of the nine, deliberately: the kind is a property of the
 * screen, and a decision already stored keeps rendering whatever reason it carries. A building's
 * refusal is the one place that must refuse a key too — `buildingRefusalReason`.
 */
export function reasonsFor(kind: ValidationPickKind): typeof VALIDATION_REFUSAL_REASONS[number][] {
  return VALIDATION_REFUSAL_REASONS.filter((reason) => (reason.kinds as readonly string[]).includes(kind));
}

/**
 * The parser for a BUILDING's refusal: only a reason `reasonsFor("building")` offers. A key the
 * venue's CHECK does not hold would otherwise reach the database as a constraint error.
 */
export function buildingRefusalReason(value: unknown): ValidationRefusalReason | null {
  const key = parseValidationRefusalReason(value);
  if (!key) return null;
  return reasonsFor("building").some((reason) => reason.key === key) ? key : null;
}

/** The one parser. A value off the wire is never trusted to be one of the nine. */
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

/** Under the comment box on the decision screens, so who reads it is stated where it is typed. */
export const VALIDATION_NOTE_HINT =
  "The rep and their manager read this comment, from the System Administrator, with no name on it.";

/** Above the picker. It says who reads it, because that is the thing that changed. */
export const VALIDATION_REASON_LABEL = "What is wrong with the photo (the rep is told this)";
/** The empty option, so nothing is submitted by accident. */
export const VALIDATION_REASON_PLACEHOLDER = "Choose what is wrong";
/** The refusal when a rejection arrives without one. */
export const VALIDATION_REASON_REQUIRED =
  "Choose what is wrong with the photo — the rep is told this.";
/**
 * On the comment box. It says who reads it, because since 2026-11-01 the rep and their manager do.
 *
 * 🔴 IT SAYS OPTIONAL SINCE 2026-10-15 (owner: "admin comment is optional"). It was required, and of
 * the 24 refusals in the module's first five days 22 carried the single character `-`: a field that is
 * required and never read is a field that gets a dash. The REASON above it stays required on a refusal.
 */
export const VALIDATION_NOTE_LABEL = "Comment — optional (the rep and their manager read it)";

// ── A place check is not an add to the rep's list ────────────────────────────────────────────────

/**
 * Under every control that approves a place check, and on the board's own explanation (owner,
 * 2026-10-27, after a rep was told her doctors were "approved" and waited for them to reach her list).
 *
 * 🔴 WORDING ONLY. Approving a place check confirms the place and nothing else; a customer outside the
 * rep's list stays outside until the rep asks to add them and that request is decided on its own. The
 * sentences name nobody, so they stand on the district manager's board too.
 */
export const PLACE_APPROVAL_IS_NOT_A_LIST_ADD =
  "Approving confirms the place only. It does not add the customer to the rep's list: a customer outside it stays outside until the rep asks to add them and that request is approved on its own.";
/** Beside a settled or just-saved approval, where the long sentence above would crowd the row. */
export const PLACE_APPROVED_NOT_A_LIST_ADD = "The place only — this does not add the customer to the rep's list.";

// ── A take-back is promised only to the one who has it ───────────────────────────────────────────

/**
 * Taking a rejection back is the Super Admin's alone (owner, 2026-11-10: "the SFE cannot"). The SFE
 * Manager decides on the same board, and two sentences on it still promised him a take-back he has no
 * button for (seen on his own board, 14 Nov 2026). Both now ask who is reading.
 *
 * 🔴 `canRestore` IS THE SCREEN'S `useCanRestoreValidation()`, the page's `canRestoreValidation(viewer)`.
 * Never key these on `mode`: the company board is the Super Admin's AND the SFE Manager's.
 */
export function rejectedBuildingsSwitchLabel(count: number, reader: { team: boolean; canRestore: boolean }): string {
  const buildings = count === 1 ? "building" : "buildings";
  // A manager's board never says a building was rejected, or that anything is decided.
  if (reader.team) return `Show the ${count} ${buildings} no longer in use`;
  return reader.canRestore ? `Show the ${count} rejected ${buildings}, which can be brought back` : `Show the ${count} rejected ${buildings}`;
}

/** What rejecting a customer seated in a polyclinic costs, said before the second press. */
export function seatedRejectWarning(canRestore: boolean): string {
  const cost = "This retires their seat — the rep captures the customer again from their own list.";
  return canRestore ? `${cost} You can approve it after all from this row.` : cost;
}

// ── When the POLYCLINIC was refused, not his own capture of the customer ─────────────────────────

/** Said first, so the clause's "its" has a subject and the rep knows which photo is meant. */
export const SHARED_PLACE_REFUSED_LEAD = "The polyclinic or centre this customer is in could not be confirmed.";
/** Said last, because photographing this customer's timetable again would never clear it. */
export const SHARED_PLACE_REFUSED_ACTION =
  "Capture the polyclinic or centre again at its door, then register this customer in it.";

/**
 * What a rep is told when the POLYCLINIC OR CENTRE his customer sits in was refused — rather than his
 * own capture of that customer, which is what the nine above are about.
 *
 * 🔴 NONE OF THE SIX SIGNBOARD SENTENCES MAY BE FORWARDED HERE. Every one of them is about THIS
 * CUSTOMER's own door — "take the photo at this customer's own entrance", "take a live photo of the
 * building and its sign" — and a customer seated in a polyclinic has no door of his own: the venue is
 * captured ONCE at its own, which is the entire reason this feature exists. Sent as they stand, they
 * would order a rep to photograph an entrance that is not there. So the venue carries its own clause
 * per reason, about the VENUE's photo, ending in the one action that actually clears it.
 *
 * Worded under the same ban as the nine: no person, no role, no decision, no threshold, no pronoun —
 * and "polyclinic or centre", the phrase the rep's own screen uses, never a kind he did not capture.
 */
const SHARED_PLACE_REFUSAL_CLAUSE: Partial<Record<ValidationRefusalReason, string>> = {
  no_signboard: "Its photo does not show the signboard on the building.",
  wrong_name: "The sign in its photo is not this polyclinic or centre's own.",
  too_dark: "Its photo is too dark or too blurred to read.",
  not_at_door: "Its photo was not taken at the entrance — it looks taken from a distance or from a vehicle.",
  photo_of_paper: "Its photo shows paper or a screen rather than the building itself.",
  point_off: "The location saved with its photo is not where the photo was taken.",
};

/**
 * The whole sentence a seated customer's rep reads when the venue was refused. Null for a reason this
 * module cannot honestly say about a venue — the two timetable ones, which a venue refusal is never
 * offered — so the caller falls back to the system's own wording.
 */
export function sharedPlaceRefusalRepText(key: string | null): string | null {
  const clause = key ? SHARED_PLACE_REFUSAL_CLAUSE[key as ValidationRefusalReason] : undefined;
  if (!clause) return null;
  return `${SHARED_PLACE_REFUSED_LEAD} ${clause} ${SHARED_PLACE_REFUSED_ACTION}`;
}
