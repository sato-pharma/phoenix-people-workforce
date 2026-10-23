const hrIdAliases: Record<string, string> = {
  // Legacy uploads sometimes used AAA for Dr Anwar; the live employee master uses AA.
  aaa: "aa",
};

export function canonicalHrIdKey(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  return hrIdAliases[normalized] ?? normalized;
}

/** Every legacy alias that canonicalises to the same person as `value` (`AA` → `["aaa"]`), so a read
 * filtered by hr id can also find the rows stored under an old spelling. Empty for most ids. */
export function hrIdAliasSources(value: string | null | undefined): string[] {
  const canonical = canonicalHrIdKey(value);
  if (!canonical) return [];
  return Object.entries(hrIdAliases)
    .filter(([, target]) => target === canonical)
    .map(([source]) => source);
}

export function canonicalHrIdForDisplay(value: string | null | undefined) {
  return canonicalHrIdKey(value)?.toUpperCase() ?? null;
}

// The form an HR id is STORED in. AccessContext.hrId holds canonicalHrIdKey — the lowercase
// COMPARISON key — which is correct for matching and wrong for persisting: writing it is what left
// ~37,000 lowercase actor ids across 52 columns (audited 2026-09-02). The damage is silent, because
// the app's own lookups mostly canonicalise; only a naive .eq feels it, and then it returns nothing
// at all rather than something wrong. Every actor/owner id written to the database goes through
// here. Falls back to the raw value so a non-canonical id is still recorded rather than dropped.
export function hrIdForStorage(value: string | null | undefined) {
  return canonicalHrIdForDisplay(value) ?? value ?? null;
}

export function normalizeHrIdForAccess(value: string | null | undefined) {
  const normalized = canonicalHrIdKey(value);
  return normalized ? normalized.replace(/[^a-z0-9]/g, "") : null;
}

// Client-safe HR_ID equality: routes through the legacy alias table (e.g. aaa -> aa)
// before comparing, with a symbol-stripped fallback for formatting drift (hyphens etc).
export function hrIdsMatch(left: string | null | undefined, right: string | null | undefined) {
  const a = canonicalHrIdKey(left);
  const b = canonicalHrIdKey(right);
  if (a && b && a === b) return true;

  const canonicalLeft = normalizeHrIdForAccess(left);
  const canonicalRight = normalizeHrIdForAccess(right);
  return Boolean(
    canonicalLeft && canonicalRight && canonicalLeft === canonicalRight,
  );
}

export function hrIdLookupKeys(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  const canonical = canonicalHrIdKey(value);
  const keys = [
    trimmed,
    trimmed.toLowerCase(),
    trimmed.toUpperCase(),
    canonical,
    canonical?.toUpperCase(),
  ].filter((key): key is string => Boolean(key));

  return Array.from(new Set(keys));
}

export type StoredHrIdDirectoryEntry = {
  hrId: string | null | undefined;
};

export function resolveStoredHrId(
  value: string | null | undefined,
  byHrId?: Map<string, StoredHrIdDirectoryEntry>,
): string | null {
  const canonical = canonicalHrIdKey(value);
  if (!canonical) return null;

  const stored = byHrId?.get(canonical)?.hrId;
  return (stored ? String(stored) : null) ?? canonicalHrIdForDisplay(value);
}

export function formatHrIdForDisplay(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.toUpperCase() : null;
}
