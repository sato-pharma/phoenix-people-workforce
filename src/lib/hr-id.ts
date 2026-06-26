const hrIdAliases: Record<string, string> = {
  // Legacy uploads sometimes used AAA for Dr Anwar; the live employee master uses AA.
  aaa: "aa",
};

export function canonicalHrIdKey(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  return hrIdAliases[normalized] ?? normalized;
}

export function canonicalHrIdForDisplay(value: string | null | undefined) {
  return canonicalHrIdKey(value)?.toUpperCase() ?? null;
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
