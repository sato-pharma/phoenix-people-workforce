// Recruitment / ATS — "I will call" and "Skip", the two answers a manager gives a CV in his portal.
//
// The owner, 2026-09-09: *"on every cv i want the phone number to be hidden and the download to be
// blocked of the cv and have 2 buttons on every cv — I will call and Skip. If the manager choose
// skip then he is skipped normally, and if pressed I will call then every other manager receiving
// this CV when open the same CV shows that Ahmed will call this CV, or reserved."*
//
// ── WHY A CLAIM EXISTS AT ALL ───────────────────────────────────────────────────────────────────
//
// The same CV genuinely reaches several managers. A recruiter can send one candidate to two managers
// (ats_candidate_manager_sends exists precisely for that), and a district folder is DERIVED from the
// area the applicant asked for — so a Nasr City CV sits in three managers' folders at once. Before
// this, nothing stopped three of them phoning the same person on the same morning, and nothing told
// any of them that the other two had. The claim is that missing signal: one manager per candidate
// says "I will call", and everybody else reading the same CV is told who it is.
//
// ── THE PHONE NUMBER IS THE POINT, NOT A SIDE EFFECT ────────────────────────────────────────────
//
// The claim is also what REVEALS the number. Hiding the phone on every card and revealing it only to
// the manager holding the claim is what makes "I will call" a thing he can act on and everyone else
// a reader. The two halves are one rule and must not drift: `revealPhoneToViewer` below is the only
// place that decides it, and both the server (which redacts before the payload leaves) and the card
// (which chooses what to print) ask it rather than re-deriving it.
//
// ── ONE CLAIM, MANY SKIPS ───────────────────────────────────────────────────────────────────────
//
// A claim is per CANDIDATE — the whole point is that it is visible to every other manager. A skip is
// per (candidate, MANAGER): one manager passing must leave the CV in front of the others, exactly as
// a district return leaves it in the other lines' folders. Both live in one table keyed on
// (candidate, manager); a partial unique index on candidate_id where action = 'will_call' is what
// makes the claim single without a second table. See the migration.
//
// PURE. No database, no React — the API route, the server page and the cards all import these, so
// the wording of a refusal and the rule about who may see a phone number cannot differ between the
// screen and the thing that enforces it. The database half is candidate-call-claims-db.ts.

import { canonicalHrIdKey } from "@/lib/hr-id";
// Type-only, so this module still compiles to nothing but its own functions and stays free of the
// folder machinery — the same shape as the type-only imports in types.ts.
import type { DistrictManagerBoard } from "@/lib/recruitment/district-manager-folders";
import { managerLabel } from "@/lib/recruitment/person-labels";

/** The two things a row in the table can be. */
export const candidateCallActions = ["will_call", "skipped"] as const;
export type CandidateCallAction = (typeof candidateCallActions)[number];

export function isCandidateCallAction(value: unknown): value is CandidateCallAction {
  return typeof value === "string" && (candidateCallActions as readonly string[]).includes(value);
}

/**
 * What the manager's card asks the server to do.
 *
 * `release` is not a stored action — it deletes the claim row — but it arrives on the same request,
 * so it belongs in the same vocabulary rather than in a second endpoint whose access rule would then
 * have to be kept in step with this one.
 */
export const candidateCallRequests = ["will_call", "release", "skip"] as const;
export type CandidateCallRequest = (typeof candidateCallRequests)[number];

export function isCandidateCallRequest(value: unknown): value is CandidateCallRequest {
  return typeof value === "string" && (candidateCallRequests as readonly string[]).includes(value);
}

/** Who has said they will call this candidate, as every reader of the CV needs to see it. */
export type CandidateCallClaim = {
  candidateId: string;
  /** Canonical (upper-case) hr id of the manager holding it. */
  managerHrId: string;
  /**
   * The manager's name, snapshotted when he claimed.
   *
   * Frozen on purpose, the same as `ats_candidate_district_returns.manager_name`: the notice on
   * another manager's screen must read "Ahmed Gawish will call this candidate" without a join to a
   * directory a leaver drops out of. Null only when the employee row could not be resolved at all,
   * and the hr id is shown then — a claim with no name is still a claim.
   */
  managerName: string | null;
  claimedAt: string;
};

/** Every claim on this page, keyed by candidate id. Absent = nobody has claimed that CV. */
export type CandidateCallClaims = Record<string, CandidateCallClaim>;

/**
 * MAY THIS VIEWER SEE THE PHONE NUMBER?
 *
 * The one decision behind the whole feature, asked in exactly one place. True only for the manager
 * who is holding the claim on this candidate. Everybody else — another manager, a National Sales
 * Manager reading his team's CVs, the same manager before he has pressed anything — gets nothing.
 *
 * Note what this does NOT do: it never asks whether the viewer COULD claim. A manager who can claim
 * but has not is exactly as unable to see the number as one who cannot, and that is the behaviour
 * the owner asked for — the number is what pressing the button buys.
 */
export function revealPhoneToViewer(
  claim: CandidateCallClaim | null | undefined,
  viewerHrId: string | null | undefined,
): boolean {
  if (!claim) return false;
  const viewer = canonicalHrIdKey(viewerHrId);
  if (!viewer) return false;
  return canonicalHrIdKey(claim.managerHrId) === viewer;
}

/** True when this viewer is the manager holding the claim. Same test, read the other way round. */
export const isViewersOwnClaim = revealPhoneToViewer;

/**
 * The contact fields a card must not print, blanked.
 *
 * Applied on the SERVER, before the candidate list leaves for the browser — hiding a field in JSX
 * leaves the number sitting in the page payload for anyone who opens the network tab, which is not
 * hiding it. The cards then simply have nothing to print, and say so.
 *
 * WhatsApp goes with the phone. It is the same number in practice and the same act (ringing the
 * candidate directly); leaving it visible would make the phone rule decorative.
 */
export function redactCandidateContact<T extends { phone: string | null; whatsapp: string | null }>(
  candidate: T,
  reveal: boolean,
): T {
  if (reveal) return candidate;
  if (candidate.phone === null && candidate.whatsapp === null) return candidate;
  return { ...candidate, phone: null, whatsapp: null };
}

/** Redact a whole list against the claims that were loaded with it. */
export function redactCandidateListContact<T extends { id: string; phone: string | null; whatsapp: string | null }>(
  candidates: readonly T[],
  claims: CandidateCallClaims,
  viewerHrId: string | null | undefined,
): T[] {
  return candidates.map((candidate) =>
    redactCandidateContact(candidate, revealPhoneToViewer(claims[candidate.id] ?? null, viewerHrId)),
  );
}

/**
 * The same redaction, over the derived district folders.
 *
 * Its own function because the boards are three levels deep — board, folder, candidate — and the one
 * time that mapping is written by hand at a call site is the time somebody redacts the list but not
 * the folders, and the phone numbers keep travelling inside the half of the payload nobody looked at.
 * The board type arrives type-only, so this module stays pure and imports no code.
 */
export function redactDistrictBoardsContact<
  TCandidate extends { id: string; phone: string | null; whatsapp: string | null },
>(
  boards: readonly DistrictManagerBoard<TCandidate>[],
  claims: CandidateCallClaims,
  viewerHrId: string | null | undefined,
): DistrictManagerBoard<TCandidate>[] {
  return boards.map((board) => ({
    ...board,
    folders: board.folders.map((folder) => ({
      ...folder,
      candidates: redactCandidateListContact(folder.candidates, claims, viewerHrId),
    })),
  }));
}

/**
 * How the holder of a claim is named on somebody else's screen.
 *
 * Goes into a sentence another manager reads — "Ahmed will call this candidate." This returned the
 * HR id when no name was resolved, which made that sentence read "B-10 will call this candidate": a
 * raw code where the owner's rule is a human-readable name, in the one place on the screen whose
 * whole job is to say WHO. Words instead, so the sentence still scans and still says what it knows.
 */
export function callClaimHolderLabel(claim: CandidateCallClaim): string {
  return managerLabel(claim.managerName);
}

/**
 * The sentence another manager reads on a CV somebody has taken.
 *
 * The owner's own example — *"Ahmed will call this CV"* — with the candidate as the object rather
 * than the document, because the manager is calling a person.
 */
export function callClaimNotice(
  claim: CandidateCallClaim,
  viewerHrId: string | null | undefined,
): string {
  if (isViewersOwnClaim(claim, viewerHrId)) return "You said you will call this candidate.";
  return `${callClaimHolderLabel(claim)} will call this candidate.`;
}

/** What the API answers when a second manager presses "I will call" on a CV already taken. */
export function callClaimTakenMessage(claim: CandidateCallClaim): string {
  return `${callClaimHolderLabel(claim)} has already said they will call this candidate.`;
}

/**
 * Why this request is refused, or null when it may proceed.
 *
 * One sentence asked in one place, so the disabled button, the service and the route's 4xx all say
 * the same thing — the shape `candidateFolderRefusal` and `bulkDecisionRefusal` already use here.
 */
export function candidateCallRefusal(
  request: CandidateCallRequest,
  claim: CandidateCallClaim | null,
  viewerHrId: string | null | undefined,
): string | null {
  if (!canonicalHrIdKey(viewerHrId)) {
    return "Your account has no HR id, so a CV cannot be reserved against it.";
  }
  if (request === "will_call") {
    // Claiming twice is not an error — the second press means the same thing as the first, and
    // answering it with a refusal would tell a manager his own reservation had failed.
    if (claim && !isViewersOwnClaim(claim, viewerHrId)) return callClaimTakenMessage(claim);
    return null;
  }
  if (request === "release") {
    if (!claim) return "Nobody has reserved this candidate.";
    if (!isViewersOwnClaim(claim, viewerHrId)) return callClaimTakenMessage(claim);
    return null;
  }
  // A skip is always the viewer's own act on his own list, so there is nothing another manager's
  // claim can refuse. Passing on a CV somebody else has taken is a perfectly ordinary thing to do.
  return null;
}
