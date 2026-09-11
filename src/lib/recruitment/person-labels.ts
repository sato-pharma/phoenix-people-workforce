/**
 * What a person is CALLED on a recruitment screen, when all we hold is an HR id.
 *
 * THE RULE THIS EXISTS TO KEEP. The owner's standing instruction is that the UI shows human-readable
 * names and never raw codes or ids. An HR id is a raw code: "filed 03 Sept 2026, 10:33 by B-10" asks
 * a tired reader at 4am to remember that B-10 is Omar Gawish, which is exactly the decoding the rule
 * forbids. The folder shelf shipped that line, and eight more screens fell back to the id whenever a
 * name lookup came back empty — the same leak, one step further along.
 *
 * WHY WORDS AND NOT THE ID AS A LAST RESORT. Falling back to `name ?? hrId` reads as a safe default
 * and is not one: it is silent, so the one case the reader sees is the case nobody noticed, and the
 * id it prints is useless to the only person who reads these screens. Saying so in words costs the
 * id — which no reader could act on anyway — and keeps the screen honest about what it does not know.
 *
 * The wording follows the module's own convention for a person whose name is missing: the CV pool
 * has said "Unnamed candidate" since it was written, and the workstation's history strip says
 * "Unnamed author". A field that is merely absent says "Not on file" instead, which is a different
 * statement and deliberately not reused here — a manager with no name on file is not a blank field,
 * he is somebody whose name we failed to resolve.
 */

/** A hiring manager whose HR id resolved to no employee row. */
export const UNNAMED_MANAGER_LABEL = "Unnamed manager";

/** The author of a candidate comment whose HR id resolved to no employee row. */
export const UNNAMED_AUTHOR_LABEL = "Unnamed author";

/**
 * A signed-in person we could not name — used for an export's "Exported by" provenance.
 *
 * Rare by construction: whoever took the export was signed in, so they normally have an employee
 * row. It covers the console accounts that carry no `hr_id` at all (see `admin-HR`), which is the
 * case the old code answered with "System" — a claim about WHO, on a row whose whole job is
 * provenance.
 */
export const UNNAMED_USER_LABEL = "Unnamed user";

/**
 * Whoever filed a CV onto a shelf, when their HR id resolved to no employee row.
 *
 * Carries its own article because it is read mid-sentence — "filed 03 Sept 2026, 10:33 by an
 * unnamed user" — where a bare "Unnamed user" would read as a name.
 */
export const UNNAMED_FILER_LABEL = "an unnamed user";

/**
 * A person's name for display, or the given wording when we could not resolve one.
 *
 * Takes the already-resolved name rather than an HR id: resolving is a database read and belongs on
 * the server, so by the time a component is rendering, the only question left is what to print when
 * the answer came back empty. Blank and whitespace-only names count as unresolved — `full_name` is
 * an empty string on a handful of employee rows, and `" "` must not render as a name.
 */
export function personLabel(name: string | null | undefined, whenUnnamed: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed ? trimmed : whenUnnamed;
}

/** A hiring manager's name for display, or "Unnamed manager". */
export function managerLabel(name: string | null | undefined): string {
  return personLabel(name, UNNAMED_MANAGER_LABEL);
}

/**
 * A hiring manager's name, "Unnamed manager", or null when the seat names NOBODY.
 *
 * Two different absences, which the screens this replaces collapsed into one. A requisition with no
 * hiring manager at all is a gap in the requisition — it renders as an em dash, or the segment is
 * dropped from a joined line. A requisition that names somebody whose HR id resolved to no employee
 * is a lookup that failed, and saying "Unnamed manager" is the honest reading of it. Printing the id
 * for the second case, which is what these did, told the reader neither thing.
 *
 * Pass the id so the caller does not have to decide which case it is in; a name with no id still
 * wins, because a resolved name is the answer however it got there.
 */
export function managerLabelOrNull(
  name: string | null | undefined,
  hrId: string | null | undefined,
): string | null {
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (trimmedName) return trimmedName;
  const trimmedHrId = typeof hrId === "string" ? hrId.trim() : "";
  return trimmedHrId ? UNNAMED_MANAGER_LABEL : null;
}
