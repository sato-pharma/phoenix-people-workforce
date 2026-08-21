// Recruitment / ATS — candidate identity + hybrid dedup (pure, unit-tested).
//
// Identity rule (LOCKED): match on National ID when present, else on normalized
// phone OR email. These helpers compute the normalized keys and resolve a match
// against existing candidates; the DB partial-unique indexes are the race-safety
// net behind them.

export function normalizeNationalId(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizePhone(value: string | null | undefined): string | null {
  // Keep digits only; drop a single leading Egyptian/international 00/0 noise but
  // stay conservative — over-normalizing risks false-merging distinct people.
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
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

export type CandidateMatchReason = "national_id" | "email" | "phone";

export type MatchableCandidate = CandidateMatchKeys & { id: string };

export type CandidateMatch = {
  id: string;
  reason: CandidateMatchReason;
};

// Returns the first existing candidate that matches the incoming keys, in
// priority order: National ID > email > phone. Null when no match.
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
  if (keys.phoneNorm) {
    const hit = existing.find((row) => row.phoneNorm && row.phoneNorm === keys.phoneNorm);
    if (hit) return { id: hit.id, reason: "phone" };
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
