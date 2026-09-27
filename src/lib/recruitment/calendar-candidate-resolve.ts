// Recruitment / interview calendar — is the outside person being booked already on file?
//
// WHY THIS EXISTS. Inbound CV intake (cv-intake-service.ts) asks that question three ways before it
// creates anybody: the byte-identical CV first, then National ID, then e-mail. Booking an interview
// for an outside person creates a candidate too — createInterviewBooking calls createCandidate and
// then uploads the CV — but it only ever asked createCandidate, which is National ID and e-mail
// alone. A WhatsApp applicant has neither, so the calendar created a second record for somebody
// already in the pipeline, every time, and the CV that proved it was the same person was attached
// one line later where nothing compared it.
//
// Measured on production 2026-09-27, that is not a theory. FOUR candidate pairs held a
// byte-for-byte identical CV under two records; ALL FOUR were one record from `whatsapp` intake and
// one from `interview_calendar`, and three of the four calendar records were created that same
// evening while the owner booked interviews:
//   Norhan Gamal Hamed          26/09 whatsapp  ×  27/09 19:00 calendar  (resolved by hand)
//   ABDALLAH SAAD SHARQAWY      13/09 whatsapp  ×  26/09 14:43 calendar
//   Asmaa Zaghloul Sayed        14/09 whatsapp  ×  27/09 18:55 calendar
//   Mohamed Salah Abd Elhamid   17/09 whatsapp  ×  27/09 19:39 calendar
// Not one of them shares an e-mail, and only the first shares a phone number, so nothing the
// calendar asked could have caught any of them. The bytes caught all four.
//
// PHONE IS ADVISORY HERE AND NOWHERE NEAR A MERGE — the owner's instruction of 2026-08-30, and the
// same production read says why. `normalizePhone` already folds 01017210988, +201017210988 and
// 201017210988 onto one key, and it is doing that correctly: of 1,220 candidates carrying a phone,
// ZERO have a `phone_norm` that disagrees with the normalizer. Twelve candidate PAIRS share a
// canonical number — and at least five of those pairs are DIFFERENT PEOPLE, because a hiring
// manager forwarding CVs from her own handset stamps her number onto each one (one number alone
// carries three unrelated applicants). Matching on it would merge them. So a shared number is
// reported to the person booking, in words, and they decide.

import { normalizePhone, type CandidateMatchReason } from "@/lib/recruitment/candidate-matching";

export type CalendarCandidateIdentity = {
  fullName: string;
  email: string | null;
  phone: string | null;
};

/**
 * `fullName` is nullable on purpose. A row read back can carry a blank name, and this module is the
 * thing that decides what a human is shown when it does — so the widening belongs here rather than
 * in a `!` at the call site.
 */
export type ResolvedCalendarCandidate = { id: string; fullName: string | null };

export type CalendarCandidateResolution = {
  candidateId: string;
  fullName: string;
  created: boolean;
  matchReason: CandidateMatchReason | null;
  /**
   * Names of the candidates already carrying this exact mobile, canonical-form compared. ADVISORY
   * ONLY — a signal for the person booking, never an input to the decision above.
   */
  phoneTwinNames: readonly string[];
};

export type CalendarCandidateDeps = {
  /** MD5-hex of the exact bytes — files.ts's cvContentFingerprint. */
  fingerprintCv: (bytes: ArrayBuffer | Buffer) => string;
  /** The candidate who already owns a byte-identical file, oldest first, or null. */
  findCvOwnerId: (contentMd5: string) => Promise<string | null>;
  getCandidateById: (id: string) => Promise<ResolvedCalendarCandidate | null>;
  /** candidates.ts's createCandidate — resolves National ID then e-mail itself. */
  createCandidate: (identity: CalendarCandidateIdentity) => Promise<{
    candidate: ResolvedCalendarCandidate;
    created: boolean;
    matchReason?: CandidateMatchReason;
  }>;
  /** Candidates sharing this canonical phone key, excluding the one resolved. */
  findPhoneTwins: (phoneNorm: string, excludeCandidateId: string) => Promise<ResolvedCalendarCandidate[]>;
  /** Best-effort reporting for a lookup that failed; the booking must never fail with it. */
  onLookupFailure?: (stage: "cv_fingerprint" | "phone_twins", error: unknown) => void;
};

/**
 * The candidate an interview booking should land on, and whether it had to be created.
 *
 * Order is the intake's order, for the intake's reason: the bytes are proof in a way a name or a
 * number is not, and the check has to run BEFORE createCandidate because createCandidate cannot be
 * taken back — after it, the duplicate record already exists. Oldest owner wins, so a late booking
 * attaches to the record already in the pipeline rather than dragging it onto a new one.
 *
 * Every lookup here is best-effort in the same direction: a failure falls through to creating the
 * candidate, which is exactly today's behaviour. An interview must still book when the fingerprint
 * query is down — a duplicate a human can merge is far cheaper than a booking that would not save.
 */
export async function resolveCalendarCandidate(
  identity: CalendarCandidateIdentity,
  cvBytes: ArrayBuffer | Buffer | null,
  deps: CalendarCandidateDeps,
): Promise<CalendarCandidateResolution> {
  let owner: ResolvedCalendarCandidate | null = null;
  if (cvBytes) {
    try {
      const ownerId = await deps.findCvOwnerId(deps.fingerprintCv(cvBytes));
      owner = ownerId ? await deps.getCandidateById(ownerId) : null;
    } catch (error) {
      deps.onLookupFailure?.("cv_fingerprint", error);
    }
  }

  const resolved = owner
    ? { candidate: owner, created: false, matchReason: "cv_content" as CandidateMatchReason }
    : await deps.createCandidate(identity);

  // Asked AFTER the decision and never before it, so that no ordering accident can turn this into a
  // match. Excludes the resolved record itself: a record found BY its phone would otherwise report
  // itself as its own twin.
  let phoneTwinNames: string[] = [];
  const phoneNorm = normalizePhone(identity.phone);
  if (phoneNorm) {
    try {
      const twins = await deps.findPhoneTwins(phoneNorm, resolved.candidate.id);
      phoneTwinNames = twins
        .map((twin) => String(twin.fullName ?? "").trim())
        .filter((name) => name.length > 0);
    } catch (error) {
      deps.onLookupFailure?.("phone_twins", error);
    }
  }

  return {
    candidateId: resolved.candidate.id,
    created: resolved.created,
    fullName: String(resolved.candidate.fullName ?? "").trim() || identity.fullName,
    matchReason: resolved.matchReason ?? null,
    phoneTwinNames,
  };
}

/** "A and B", "A, B and C" — names, never ids, and never truncated with an ellipsis. */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What the person who booked is told. One or two plain sentences: what happened to the record, and
 * — separately — whether somebody else already holds this mobile number.
 *
 * The number sentence never claims the two are the same person, because on this data they often are
 * not: five of the twelve pairs sharing a number on production are unrelated applicants forwarded
 * from one handset. It asks; it does not decide.
 */
export function calendarCandidateNotice(
  resolution: CalendarCandidateResolution,
  options: { cvAttached: boolean },
): string | null {
  const name = resolution.fullName;
  const sentences: string[] = [];

  if (resolution.matchReason === "cv_content") {
    sentences.push(
      `${name} is already in Recruitment — the CV you attached is the identical document already on that record, `
        + `so the interview is on it${options.cvAttached ? " and your copy was filed beside it" : ""}.`,
    );
  } else if (!resolution.created) {
    sentences.push(
      `${name} was already in Recruitment, so the interview is on that record`
        + `${options.cvAttached ? " and the CV was added to it" : ""}.`,
    );
  }

  if (resolution.phoneTwinNames.length > 0) {
    const holders = nameList(resolution.phoneTwinNames);
    const plural = resolution.phoneTwinNames.length > 1;
    sentences.push(
      `${resolution.created ? `${name} was added to Recruitment. ` : ""}`
        + `${holders} ${plural ? "already hold" : "already holds"} the same mobile number, `
        + `so check whether this is the same person before the interview.`,
    );
  }

  return sentences.length > 0 ? sentences.join(" ") : null;
}
