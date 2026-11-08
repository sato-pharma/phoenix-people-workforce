/**
 * The district managers on a Regional Manager's org tree who hold no row on his "My Districts" board yet
 * (owner, 2026-11-09). That board ranks the published closing window, so a manager who joined after it —
 * Sahar El Gallad, 24 Oct 2026, against a Jul–Sep window — had no row at all, while the card above counted
 * her among "3 districts". Each one is listed under the ranked rows with no rank and no percentage, and says
 * why. A figure is never invented for her: her sales arrive with the first published month that holds her.
 *
 * Pure, so the rule is pinned without a database.
 */

export type UnrankedManager = { hrId: string; name: string; note: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The same key the departed-roster split uses: case and punctuation never decide a match. */
function hrKey(value?: string | null): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** "2026-10-24" → "24 Oct 2026"; anything else → null (a date is never guessed). */
export function joinedLabel(hireDate: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(hireDate ?? "");
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return null;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

export const NO_PUBLISHED_MONTH = "No published month yet";

export function managersWithoutPublishedMonth(input: {
  /** The serving roster's district managers — active people on his org tree. */
  roster: ReadonlyArray<{ hrId: string; name: string }>;
  /** Everyone already ranked on the board. */
  ranked: ReadonlyArray<{ hrId: string }>;
  /** hr id → hire date, from the employee directory. */
  hireDates: ReadonlyMap<string, string | null>;
}): UnrankedManager[] {
  const ranked = new Set(input.ranked.map((row) => hrKey(row.hrId)).filter(Boolean));
  const hire = new Map<string, string | null>();
  for (const [hrId, date] of input.hireDates) hire.set(hrKey(hrId), date);
  const seen = new Set<string>();
  const out: UnrankedManager[] = [];
  for (const person of input.roster) {
    const key = hrKey(person.hrId);
    if (!key || ranked.has(key) || seen.has(key)) continue;
    seen.add(key);
    const joined = joinedLabel(hire.get(key));
    out.push({ hrId: person.hrId, name: person.name, note: joined ? `Joined ${joined}` : "" });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}
