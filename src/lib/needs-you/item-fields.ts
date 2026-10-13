/**
 * The small pure helpers a Needs-You item's fields are built from.
 *
 * WHY THEY LEFT `sources.ts`. They are used by almost every adapter there (`plural` 29 times,
 * `ageDaysSince` 6), so a source extracted out of that file for testing cannot take a copy of them
 * without the copy drifting from the original — and a board row whose age or plural reads
 * differently depending on which module produced it is exactly the kind of difference nobody
 * notices. One definition, imported by both.
 *
 * 🔴 THIS FILE HAS NO IMPORTS, AND THAT IS LOAD-BEARING. `sources.ts` reaches ~30 `@/lib/**`
 * service modules, one of which heads to `getSupabaseAdmin` — so anything that imports it puts a
 * Supabase client in the process and cannot run as an offline contract gate
 * (`scripts/check-contracts-gates.mjs`). Keep this module free of imports and the pure sources that
 * depend on it stay runnable without a database.
 */

/** Whole days between two instants, floored. Never negative — a future stamp reads as 0 days old. */
export function ageDaysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

export const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
