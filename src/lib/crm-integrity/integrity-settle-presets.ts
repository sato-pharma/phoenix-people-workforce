/**
 * Location integrity — the ready-made reasons for settling a case.
 *
 * The owner's answer when the bulk settle was put to him (2026-10-13): a note stays **required**, and
 * he gets ready-made reasons he can send as they are or edit. Both halves matter — the note is what
 * the next reader of a settled case sees, and "settled" with no words is a decision nobody can
 * check; but typing the same sentence forty times is why nothing had ever been settled on this board
 * at all (0 of 165 cases, read on production 13 October 2026).
 *
 * 🔴 THESE ARE STARTING TEXT, NEVER A CODE AND NEVER A VERDICT. Each one is a plain sentence saying
 * what the reader concluded about the EVIDENCE, in the same voice as the story: no finding is called
 * fraud, nobody is accused, and nothing says what anyone did. Pressing one fills the note field,
 * which stays editable — pressing it is not deciding anything by itself.
 */

export type IntegritySettlePreset = {
  /** Stable, so a test and a future screen can name one. Never shown. */
  id: string;
  /** The button's own words, short enough for a row of them. */
  label: string;
  /** What lands in the note field, and what is stamped on every case settled with it. */
  note: string;
};

export const INTEGRITY_SETTLE_PRESETS: ReadonlyArray<IntegritySettlePreset> = [
  {
    id: "one_tap",
    label: "One-tap capture",
    note: "One-tap capture — the pin and the photograph are the same reading, which is what that capture does.",
  },
  {
    id: "attested",
    label: "Another capture agrees",
    note: "The place is attested by another capture at the same place on the same day.",
  },
  {
    id: "approximate_location",
    label: "Approximate location was on",
    note: "The phone was set to approximate location, so the reading could not be precise and the precision findings say nothing.",
  },
  {
    id: "photo_checked",
    label: "Looked at the photograph",
    note: "Looked at the photograph: the place is right.",
  },
  {
    id: "sign_shared",
    label: "Shared or building sign",
    note: "The sign on the door is a building or shared-clinic sign, so the name on it is not the name on the list.",
  },
  {
    id: "record_corrected",
    label: "The day's record was wrong",
    note: "The day's record has since been corrected, so the finding no longer describes anything.",
  },
  {
    id: "read_no_action",
    label: "Read, nothing to do",
    note: "Read, and there is nothing to act on.",
  },
];

/** A preset by its id. Undefined for one that no longer exists — a kept link must not throw. */
export function integritySettlePreset(id: string): IntegritySettlePreset | undefined {
  return INTEGRITY_SETTLE_PRESETS.find((preset) => preset.id === id);
}
