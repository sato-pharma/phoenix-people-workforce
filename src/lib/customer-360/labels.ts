/**
 * Human-readable names for the two coded fields this module displays.
 *
 * The owner's standing rule is that a screen shows human-readable names, never raw codes — so
 * `system_validated` must not reach a page spelled that way. Two of the five live values need more
 * than de-underscoring, because the plain English reading of each is the WRONG one:
 *
 *  - `system_validated` means NO HUMAN LOOKED. Rendered as a bare "System validated" it reads as an
 *    assurance — as though someone checked and passed it — which is the opposite of what it records.
 *    47 of the 345 marketing venues carry it, so this is not a corner case.
 *  - `nursery` is the venue type for ANY venue with no distributor account, and that filing is the
 *    owner's own. A clinic filed as a nursery is CORRECT, not a data-quality defect. Rendered bare it
 *    invites the next reader to "fix" five rows that are already right.
 *
 * Measured on production 2026-09-03: validation_status is pending (292), system_validated (47),
 * sfe_validated (6); venue_type is pharmacy (340), nursery (5).
 *
 * An unrecognised value is de-underscored and capitalised rather than dropped or shown raw: a value
 * added to the database tomorrow should read as ordinary English here, not as a code and not as a
 * blank where a real status exists.
 */

const VALIDATION_LABELS: Readonly<Record<string, string>> = {
  pending: "Pending review",
  sfe_validated: "SFE validated",
  system_validated: "System validated · no human review",
};

const VENUE_LABELS: Readonly<Record<string, string>> = {
  nursery: "Nursery · no distributor account",
  pharmacy: "Pharmacy",
};

/** De-underscore and capitalise anything the maps above do not name. Never returns a raw code. */
function humanise(value: string): string {
  const words = value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function validationStatusLabel(value: string | null | undefined): string | null {
  const key = (value ?? "").trim();
  if (!key) return null;
  return VALIDATION_LABELS[key.toLowerCase()] ?? humanise(key);
}

export function venueTypeLabel(value: string | null | undefined): string | null {
  const key = (value ?? "").trim();
  if (!key) return null;
  return VENUE_LABELS[key.toLowerCase()] ?? humanise(key);
}
