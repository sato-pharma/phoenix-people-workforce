// HR's total years of experience (owner, 2026-10-31) — the pure half: the limit and the parse. Kept
// apart from total-experience.ts, which reads the database, so the Employee Master form (a browser
// component) checks the same rule the server saves with.

export const totalExperienceMaxYears = 60;

/**
 * HR's value, checked: empty clears it, otherwise a number from 0 to 60 with one decimal. Throws a
 * sentence HR can act on.
 */
export function parseTotalExperienceYears(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const years = Number(text);
  if (!Number.isFinite(years) || years < 0 || years > totalExperienceMaxYears) {
    throw new Error(`Total years of experience must be a number from 0 to ${totalExperienceMaxYears}, for example 2 or 0.5.`);
  }
  return Math.round(years * 10) / 10;
}
