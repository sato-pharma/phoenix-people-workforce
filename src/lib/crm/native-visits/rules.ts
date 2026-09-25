/**
 * A contact's visit rule, shared by the vacation-day-work feature (phase 6, rule 9): whether a visit
 * needs an existing contact, allows a prospect instead, or needs neither.
 *
 * The pilot's own visit-type, entry-window, GPS, draft-parsing and plan-refusal rules that used to
 * live here are retired (2026-09-25, once nothing read or wrote a native visit or plan any more).
 */

export type NativeVisitContactRule = "required" | "contact_or_prospect" | "none";
