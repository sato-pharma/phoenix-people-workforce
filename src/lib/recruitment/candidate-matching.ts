// Recruitment / ATS — candidate identity + hybrid dedup (pure, unit-tested).
//
// Identity rule: match on National ID when present, else on normalized email.
// These helpers compute the normalized keys and resolve a match against existing
// candidates; the DB partial-unique indexes are the race-safety net behind them.
//
// PHONE IS NOT AN IDENTITY KEY — owner's instruction, 2026-08-30. It was, and it merged three
// different applicants into one record. A WhatsApp message from anyone NOT on the import allowlist
// is treated as a direct application, so the candidate is stamped with the SENDER's number
// (buildWhatsAppIntakeInput, identitySource "sender"). A hiring manager forwarding CVs from her own
// handset therefore produced one record carrying HER number, and every later forward matched it on
// phone: three forwards on 30 Aug became a single candidate, named after the first CV, holding all
// three. Measured before removal: phone had matched 8 times ever, 6 of them these wrong merges.
// Email matched 71 times and is untouched.
//
// The phone is still normalized, still stored, and still drives the ADVISORY duplicate flag below —
// what it no longer does is silently merge two records. That direction is deliberate and matches
// normalizePhone's own reasoning: a duplicate a human can merge is far cheaper than a false merge,
// which buries one applicant's CV inside another's file where nobody thinks to look.
//
// The unique index recruitment_candidates_phone_norm_uidx is dropped in the same change and must
// NOT be restored: with phone no longer matched, a second candidate on one number would hit 23505
// and the rematch below would find nothing to fall back to, so the import would fail outright
// instead of merging. Removing one without the other breaks CV intake.

export function normalizeNationalId(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

// An Egyptian mobile, in every form this pool actually stores it. The captured group is always the
// 10 significant digits (1 + operator digit + 8 subscriber digits); everything before it is prefix:
//   01xxxxxxxxx      local                        253 rows
//   201xxxxxxxxx     canonical (Meta's wa_id)      61 rows — matches, returned unchanged
//   00201xxxxxxxxx   international dialling prefix   7 rows
//   2001xxxxxxxxx    +20 written before the local 0  5 rows — country code doubled
// It deliberately does NOT match a bare 1xxxxxxxxx: with no 0 and no 20 there is nothing marking it
// as Egyptian, and guessing there is how you merge two different people.
const EGYPT_MOBILE = /^(?:00)?(?:(?:20)?0|20)(1\d{9})$/;

export function normalizePhone(value: string | null | undefined): string | null {
  // Keep digits only, then fold the ONE ambiguity that actually splits this pool: an Egyptian mobile
  // written locally and internationally is the same handset, and findMatchingCandidate compares by
  // exact string equality — so without this fold a CV carrying "01234567890" never matches the
  // WhatsApp record stamped "201234567890" from Meta's wa_id, and the same person is inserted twice.
  // Canonical form is the international one, because that is the form Meta sends and cannot be
  // asked to change. Every other shape is left exactly as-is on purpose: over-normalizing risks
  // false-merging distinct people, which is far worse than a duplicate a human can merge.
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 0) return null;
  const egyptianMobile = EGYPT_MOBILE.exec(digits);
  return egyptianMobile ? `20${egyptianMobile[1]}` : digits;
}

export type CandidateMatchKeys = {
  nationalIdNorm: string | null;
  emailNorm: string | null;
  phoneNorm: string | null;
};

export function candidateMatchKeys(input: {
  nationalId?: string | null;
  email?: string | null;
  phone?: string | null;
}): CandidateMatchKeys {
  return {
    nationalIdNorm: normalizeNationalId(input.nationalId),
    emailNorm: normalizeEmail(input.email),
    phoneNorm: normalizePhone(input.phone),
  };
}

// "phone" stays in the union even though findMatchingCandidate can no longer return it: 8 historical
// ats_cv_intake_events rows carry match_reason = 'phone', and cv-intake-service's asMatchReason
// narrows that free-text column back through this type. Dropping it would turn those rows into
// nulls on read, erasing the evidence of the very merges this change exists to stop.
export type CandidateMatchReason = "national_id" | "email" | "phone";

export type MatchableCandidate = CandidateMatchKeys & { id: string };

export type CandidateMatch = {
  id: string;
  reason: CandidateMatchReason;
};

// Returns the first existing candidate that matches the incoming keys, in
// priority order: National ID > email. Null when no match.
//
// phoneNorm is deliberately NOT consulted — see the header. Keep it on CandidateMatchKeys: it is
// still computed, still written to the row, and still feeds the advisory duplicate flag; only the
// automatic merge is gone.
export function findMatchingCandidate(
  existing: readonly MatchableCandidate[],
  keys: CandidateMatchKeys,
): CandidateMatch | null {
  if (keys.nationalIdNorm) {
    const hit = existing.find((row) => row.nationalIdNorm && row.nationalIdNorm === keys.nationalIdNorm);
    if (hit) return { id: hit.id, reason: "national_id" };
  }
  if (keys.emailNorm) {
    const hit = existing.find((row) => row.emailNorm && row.emailNorm === keys.emailNorm);
    if (hit) return { id: hit.id, reason: "email" };
  }
  return null;
}

// --- Advisory fuzzy dedup (NEVER auto-merges) ------------------------------------------------
// The exact-key identity rule above is LOCKED and stays the only thing that merges records. This is
// a SOFT signal only — to flag "this might be the same person who also applied elsewhere" so a human
// can look, catching the same applicant arriving via email and WhatsApp (different keys, same
// person). It must never drive a merge, because a name or phone-tail collision is not proof.

export function normalizeNameForMatch(value: string | null | undefined): string | null {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip Latin diacritics; Arabic is left intact
    .replace(/[^a-z؀-ۿ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 4 ? cleaned : null; // too short to be a meaningful name signal
}

// Last 9 significant digits — matches a number stored locally (01001234567) against Meta's
// international form (201001234567). Mirrors whatsapp-payload-parser's phoneTail intent.
export function phoneTailForMatch(value: string | null | undefined): string | null {
  const digits = normalizePhone(value)?.replace(/^0+/, "") ?? null;
  return digits && digits.length >= 9 ? digits.slice(-9) : null;
}

export type SoftDuplicateMatch = { id: string; reason: "name" | "phone_tail" };
export type SoftMatchableCandidate = { id: string; fullName?: string | null; phoneNorm?: string | null };

/**
 * Flags every candidate that shares a phone-tail (stronger) or normalized name with ANOTHER
 * candidate in the set — the advisory "possible duplicate" markers the candidate list shows. O(n)
 * via two indexes rather than an O(n²) pairwise scan, so it stays cheap on the whole pool.
 *
 * This function itself decides nothing — it points at a record to eyeball. Acting on the flag is a
 * separate, deliberate step a person takes: see candidate-merge.ts for what a merge may and may not
 * do. Note both rows of a pair get a flag, each naming the other, which is what lets the recruiter
 * choose the direction of a merge simply by clicking the row they want gone.
 */
export function findDuplicateFlags(candidates: readonly SoftMatchableCandidate[]): Map<string, SoftDuplicateMatch> {
  const idsByPhone = new Map<string, string[]>();
  const idsByName = new Map<string, string[]>();
  for (const candidate of candidates) {
    const tail = phoneTailForMatch(candidate.phoneNorm);
    if (tail) (idsByPhone.get(tail) ?? idsByPhone.set(tail, []).get(tail)!).push(candidate.id);
    const name = normalizeNameForMatch(candidate.fullName);
    if (name) (idsByName.get(name) ?? idsByName.set(name, []).get(name)!).push(candidate.id);
  }

  const flags = new Map<string, SoftDuplicateMatch>();
  for (const candidate of candidates) {
    const tail = phoneTailForMatch(candidate.phoneNorm);
    const phoneMatch = tail ? (idsByPhone.get(tail) ?? []).find((id) => id !== candidate.id) : undefined;
    if (phoneMatch) {
      flags.set(candidate.id, { id: phoneMatch, reason: "phone_tail" });
      continue;
    }
    const name = normalizeNameForMatch(candidate.fullName);
    const nameMatch = name ? (idsByName.get(name) ?? []).find((id) => id !== candidate.id) : undefined;
    if (nameMatch) flags.set(candidate.id, { id: nameMatch, reason: "name" });
  }
  return flags;
}

/**
 * The first existing candidate that SOFT-matches by phone-tail (stronger) or, failing that, by
 * normalized full name. Advisory only — surface it as a "possible duplicate" flag, never a merge.
 */
export function findPossibleDuplicate(
  existing: readonly SoftMatchableCandidate[],
  input: { fullName?: string | null; phone?: string | null },
): SoftDuplicateMatch | null {
  const tail = phoneTailForMatch(input.phone);
  if (tail) {
    const hit = existing.find((row) => phoneTailForMatch(row.phoneNorm) === tail);
    if (hit) return { id: hit.id, reason: "phone_tail" };
  }
  const name = normalizeNameForMatch(input.fullName);
  if (name) {
    const hit = existing.find((row) => normalizeNameForMatch(row.fullName) === name);
    if (hit) return { id: hit.id, reason: "name" };
  }
  return null;
}
