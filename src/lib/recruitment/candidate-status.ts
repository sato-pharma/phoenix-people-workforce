// Recruitment / ATS — the candidate's own status, as a fixed list.
//
// Until 2026-08-15 this column was free text with a database default of 'Candidate Created', and it
// produced exactly what free text produces: measured in production, 225 of the 226 candidates
// carried that one meaningless string and the 226th carried a whole sentence
// ("Not Eligible — Non-Egyptian (Dubai, UAE)"). Nothing could be filtered, counted or reported on,
// so the column was decoration — and the module had no way at all to say which applicants a human
// had already looked at.
//
// Deliberately NOT a Postgres enum or a CHECK constraint. The column stays plain `text`, the list
// lives here, and renaming a label or adding a state is a code change rather than a migration. The
// validation that matters happens at the one write path a browser can reach —
// PATCH /api/recruitment/candidates/[id]/status.
//
// Pure on purpose (no database, no React) so the server route, the dashboard counters and the
// client workspace all import the same list and cannot drift apart.

export const candidateStatuses = ["new", "shortlisted", "sent_to_manager", "rejected", "hired"] as const;
export type CandidateStatus = (typeof candidateStatuses)[number];

/**
 * What a candidate is the moment their CV arrives. Also the database column default from
 * 20260815210000_candidate_status_vocabulary — the two must stay equal, because inbound intake
 * never sets a status explicitly and relies on that default.
 */
export const DEFAULT_CANDIDATE_STATUS: CandidateStatus = "new";

export const candidateStatusLabels: Record<CandidateStatus, string> = {
  hired: "Hired",
  new: "New",
  rejected: "Rejected",
  sent_to_manager: "Sent to manager",
  shortlisted: "Shortlisted",
};

export const candidateStatusDescriptions: Record<CandidateStatus, string> = {
  hired: "Joined the company.",
  new: "Arrived. Nobody has looked at them yet.",
  rejected: "Not proceeding.",
  sent_to_manager: "Pushed to the hiring manager.",
  shortlisted: "Worth taking forward.",
};

/** How long a status note may be. Long enough for a real reason, short enough to fit a table cell. */
export const CANDIDATE_STATUS_NOTE_MAX_LENGTH = 300;

export function isCandidateStatus(value: unknown): value is CandidateStatus {
  return typeof value === "string" && (candidateStatuses as readonly string[]).includes(value);
}

// The free-text values that actually exist in production, mapped onto the list. Only the ones that
// carry no information are mapped: 'Candidate Created' was the database default that every single
// inbound CV received, so it means "new" and nothing else. A value NOT in here — such as the one
// handwritten rejection sentence — deliberately resolves to null rather than being guessed at, so
// the screen keeps showing what a human actually wrote instead of a status it never chose.
const legacyCandidateStatuses: Record<string, CandidateStatus> = {
  "candidate created": "new",
};

/**
 * Resolves a stored status onto the fixed list, or null when it is neither a known code nor a
 * recognised legacy value.
 *
 * This has to keep working on legacy text long after the backfill, for a reason that is easy to
 * miss: the code ships on a merge to `main` and the backfill is a separate, announced production
 * step, so there is a real window in which new code reads old rows.
 */
export function normalizeCandidateStatus(value: string | null | undefined): CandidateStatus | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (isCandidateStatus(raw)) return raw;
  return legacyCandidateStatuses[raw.toLowerCase()] ?? null;
}

/**
 * What to show a human. An unrecognised legacy value is shown verbatim rather than forced into the
 * list — the owner's rule is that text is never truncated and never hidden, and a status somebody
 * typed by hand is information.
 */
export function candidateStatusLabel(value: string | null | undefined): string {
  const status = normalizeCandidateStatus(value);
  if (status) return candidateStatusLabels[status];
  const raw = String(value ?? "").trim();
  return raw || candidateStatusLabels[DEFAULT_CANDIDATE_STATUS];
}

/**
 * "Nobody has looked at this person yet" — the number the recruitment landing screen counts.
 *
 * An unrecognised value is NOT unreviewed: somebody typed it, which is itself the review. That is
 * why this asks `=== "new"` on the normalized value rather than testing for the absence of a
 * decision.
 */
export function isUnreviewedCandidateStatus(value: string | null | undefined): boolean {
  return normalizeCandidateStatus(value) === DEFAULT_CANDIDATE_STATUS;
}

// ---------------------------------------------------------------------------
// The manager's answer.
// ---------------------------------------------------------------------------
//
// A recruiter pushes a CV to a District Manager and the manager answers one of exactly two things.
// Those answers land on the SAME five statuses rather than adding a sixth, and that is a decision
// worth stating: a "manager interested" code would have to be taught to the pool filters, the four
// stat cards, the counters and every screen that reads a status, in exchange for information that
// status_changed_by_hr_id already carries — the row records WHO decided, so "shortlisted by the
// District Manager" is readable without a new state to maintain.
//
// The note is where the manager's own words go, and it is required on a refusal: "not interested"
// with no reason tells Talent Acquisition nothing, and the whole point of pushing a CV out is to
// get an answer back that is worth reading.
export const hiringManagerDecisions = ["interview", "not_interested"] as const;
export type HiringManagerDecision = (typeof hiringManagerDecisions)[number];

export const hiringManagerDecisionStatus: Record<HiringManagerDecision, CandidateStatus> = {
  interview: "shortlisted",
  not_interested: "rejected",
};

export const hiringManagerDecisionLabels: Record<HiringManagerDecision, string> = {
  interview: "I want to interview",
  not_interested: "Not interested",
};

export function isHiringManagerDecision(value: unknown): value is HiringManagerDecision {
  return typeof value === "string" && (hiringManagerDecisions as readonly string[]).includes(value);
}
