/**
 * Which saved plan drafts a browser may forget.
 *
 * The plans workspace keeps an unsaved draft per person, plan kind and period, under
 * `phoenix:plan-draft:<version>:<hr id>:<kind>:<period start>`. A draft was removed only when a plan
 * for that same period was saved — so every week a rep opened and left unsaved stayed in the browser
 * for good (2026-10-26 cache audit, P3). This picks the ones to drop: a period that started more than
 * `maxAgeDays` ago, or a draft written by an older version of the workspace that no longer reads it.
 *
 * Pure, so the workspace runs it over `localStorage`'s keys and the test runs it over a list.
 */
export const PLAN_DRAFT_KEY_PREFIX = "phoenix:plan-draft:";

/** Long enough to cover a monthly plan's whole period with room to spare. */
export const PLAN_DRAFT_MAX_AGE_DAYS = 60;

const DAY_MS = 86_400_000;

export function stalePlanDraftKeys(
  keys: readonly string[],
  options: { currentVersion: string; today: Date; maxAgeDays?: number },
): string[] {
  const maxAgeDays = options.maxAgeDays ?? PLAN_DRAFT_MAX_AGE_DAYS;
  const todayUtc = Date.UTC(options.today.getFullYear(), options.today.getMonth(), options.today.getDate());
  const stale: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(PLAN_DRAFT_KEY_PREFIX)) continue;
    const parts = key.slice(PLAN_DRAFT_KEY_PREFIX.length).split(":");
    const version = parts[0];
    const periodStart = parts[parts.length - 1] ?? "";
    if (version !== options.currentVersion) {
      stale.push(key);
      continue;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(periodStart);
    // A key this code did not write is left alone rather than guessed at.
    if (!match) continue;
    const startUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (!Number.isFinite(startUtc)) continue;
    if ((todayUtc - startUtc) / DAY_MS > maxAgeDays) stale.push(key);
  }
  return stale;
}
