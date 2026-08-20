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

/* ────────────────────────────────────────────────────────────────────────────
 * "Applying for" — the same envelope, read for a different fact.
 *
 * Only 15 of the 555 production rows carry `applied_for_job_title`, so the column read
 * "Not stated" 97% of the time and told a recruiter nothing. But 198 of those rows carry a
 * `Subject( … )` in the intake envelope, and the subjects are real answers, not noise —
 * "Personnel & Recruitment Specialist" ×22, "HR Specialist" ×18, "HR Generalist",
 * "Senior Payroll Specialist", "District Manager". Reading it lifts the column from 15 rows to
 * 186 (measured 2026-08-21).
 *
 * Two sources deliberately NOT used:
 *   • `ats_candidate_cv_extractions.position_key` is the extraction template ("universal" /
 *     "medical_rep"), not a role.
 *   • `extracted_fields->>'currentJobTitle'` is what the applicant does NOW. Putting it in a
 *     column headed "Applying for" would state an intention nobody expressed.
 *
 * A derived value is always labelled as derived, and the stored column always wins.
 * ──────────────────────────────────────────────────────────────────────────── */

/** `Subject(` … `)` — what the forwarded message was about. */
const FORWARDED_SUBJECT = /Subject\(([^)]*)\)/;

/** Mail-client and applicant boilerplate wrapped around the actual role. */
const SUBJECT_PREAMBLE = /^(?:re|fw|fwd)\s*:\s*|^(?:applying|apply|application)\s+(?:for|to)\s+|^application\s*:?\s*/i;

/** Subjects that name no role. Kept small on purpose — "HR" is 18 rows and is a real answer. */
const SUBJECT_SAYS_NOTHING = new Set(["cv", "resume", "my cv", "cv attached", "job application", "application", "job", "apply"]);

/** Longer than any real job title; past this the subject is a sentence, not a role. */
const LONGEST_PLAUSIBLE_TITLE = 60;

/**
 * Two, not three. "HR" is the whole subject on 18 production rows and "Apply for HR" reduces to it
 * on four more — a department rather than a title, but a recruiter reads it as an answer, and a
 * three-character floor would silently drop all 22.
 */
const SHORTEST_PLAUSIBLE_TITLE = 2;

export type AppliedForSource = "stated" | "subject";

export type CandidateAppliedFor = {
  /** The role to show, already cleaned. Null when neither source gives one. */
  text: string | null;
  /** Where it came from — "subject" must be shown as inferred, never as fact. */
  source: AppliedForSource | null;
};

/**
 * The role to show in "Applying for": the stored title when there is one, otherwise the subject
 * line of the message the CV arrived on. Never guesses — returns null rather than a role nobody
 * named, because a wrong job title routes a CV to the wrong manager.
 */
export function candidateAppliedFor(
  appliedForJobTitle: string | null | undefined,
  fullName: string | null | undefined,
): CandidateAppliedFor {
  const stated = (appliedForJobTitle ?? "").trim();
  if (stated) return { source: "stated", text: stated };

  const subject = (fullName ?? "").match(FORWARDED_SUBJECT)?.[1]?.trim();
  if (!subject) return { source: null, text: null };

  const title = subject.replace(SUBJECT_PREAMBLE, "").trim();
  if (title.length < SHORTEST_PLAUSIBLE_TITLE || title.length > LONGEST_PLAUSIBLE_TITLE) return { source: null, text: null };
  if (SUBJECT_SAYS_NOTHING.has(title.toLowerCase())) return { source: null, text: null };

  return { source: "subject", text: title };
}
