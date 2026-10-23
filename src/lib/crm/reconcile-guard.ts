// Which mirror rows a CRM reconcile or prune may delete — one pure guard, shared by the visits and
// check-ins reconcile in sync.ts and the plan prune in plan-sync.ts (audit F-07 and S-SAL-01,
// 2026-10-23). Kept in its own module so plan-sync.ts does not import the visits sync.

/**
 * Which mirror rows a reconcile may delete: the ones this run's fetch did not see AND that were
 * already in the mirror when this run took its snapshot. A row with no `synced_at`, or one synced
 * before `runStartedAt`, is stale; one a concurrent run wrote at or after it is never touched. The
 * caller keeps the FULL existing list for its 50%-truncation guard; only the delete set is filtered.
 * Pure, so the guard is testable without a database (both the visits and check-ins reconcile use it).
 */
export function staleReconcileIds(
  existingIds: readonly number[],
  freshIds: ReadonlySet<number>,
  syncedAtById: ReadonlyMap<number, string>,
  runStartedAt: string,
): number[] {
  // Compared as instants, not strings: the database writes `…:00.123456+00:00` and the run stamp
  // is `…:00.123Z`, which a string comparison orders by the character after the milliseconds.
  const startedAt = Date.parse(runStartedAt);
  return existingIds.filter((id) => {
    if (freshIds.has(id)) return false;
    const syncedAt = syncedAtById.get(id);
    if (!syncedAt) return true;
    const syncedAtMs = Date.parse(syncedAt);
    if (Number.isFinite(syncedAtMs) && Number.isFinite(startedAt)) return syncedAtMs < startedAt;
    return syncedAt < runStartedAt;
  });
}
