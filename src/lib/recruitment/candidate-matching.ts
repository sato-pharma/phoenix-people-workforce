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
