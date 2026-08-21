/**
 * Turning an intake blob back into a person's name.
 *
 * The WhatsApp/email forwarder writes the whole envelope into `full_name`, so 220 of the 555
 * production rows read like:
 *
 *   "Diwakar Mogarala Resume From(Diwakar Mogarala (diwakar@gmail com)) Subject(Experienced …)"
 *
 * Measured 2026-08-20: those 220 average 100+ characters and reach 185, against a p95 of 28 for
 * the 335 rows that carry a real name. A single row like that is what forced the candidate pool
 * into horizontal scroll — one cell was wider than the screen.
 *
 * This is a DISPLAY derivation only. Nothing here writes to the database: the stored value is
 * still the envelope, `fullName` is still what search and the profile show, and the full string
 * stays available as hover text. The sender name is what the forwarder had — it is not always
 * spelled the same as the CV (the CV may say "Mohamed Dawood" where WhatsApp says "Dawood
 * Dawood"), which is why the original is never thrown away.
 */

/** `From(` … `(` — the sender's display name, as the forwarder recorded it. */
const FORWARDED_SENDER = /From\(\s*([^()]+?)\s*\(/;

/** A sender slot holding an address rather than a name — no better than the envelope itself. */
const LOOKS_LIKE_AN_ADDRESS = /@|^\s*$/;

/**
 * The name to show for a candidate: the forwarder's sender name when the row is an intake
 * envelope, otherwise the stored name unchanged. Never empty — falls back to the original.
 */
export function candidateDisplayName(fullName: string | null | undefined): string {
  const stored = (fullName ?? "").trim();
  if (!stored) return "";

  const sender = stored.match(FORWARDED_SENDER)?.[1]?.trim();
  if (!sender || LOOKS_LIKE_AN_ADDRESS.test(sender)) return stored;
  return sender;
}

/**
 * True when the shown name is a shortened form of a longer stored value, so the caller knows a
 * hover title carrying the original is worth rendering.
 */
export function isShortenedCandidateName(fullName: string | null | undefined): boolean {
  const stored = (fullName ?? "").trim();
  return stored.length > 0 && candidateDisplayName(stored) !== stored;
}

/*
 * "Applying for" used to live here too, reading the same envelope for a different fact. It moved to
 * src/lib/recruitment/applied-for.ts on 2026-08-21, when it grew from one source (the `Subject( … )`
 * in this envelope) to six. Nothing was lost — that module still reads this envelope, as the fourth
 * rung of its ladder.
 */
