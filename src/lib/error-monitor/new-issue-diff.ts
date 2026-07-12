// Pure id-set diffing for the System Issues dashboard's "new issue" toast.
// `previousIds === null` means "no baseline yet" (e.g. before the first poll response
// has replaced the SSR-seeded baseline) — callers must treat that as "nothing is new"
// rather than toasting for every row on first paint.
export function computeNewlyArrivedIds(previousIds: Set<string> | null, currentIds: readonly string[]): string[] {
  if (previousIds === null) return [];
  return currentIds.filter((id) => !previousIds.has(id));
}
