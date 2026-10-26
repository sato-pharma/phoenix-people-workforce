// How many fortnights each rep has won — keyed on the EMPLOYEE, never on the printed name.
//
// The same rep is stored under different spellings ("Mostafa Saied" and "Mostafa Saied Basiouny
// Hamd"; one rep under three), because a winner row freezes the name it carried on the day. A count
// keyed on the name would split one rep's wins across spellings and crown nobody ×N. The key is the
// normalised hr id, so spelling, case and punctuation of the NAME cannot move a count.

import { normalizeHrIdForAccess } from "@/lib/hr-id";

type CountableWinner = { employeeHrId: string; employeeName: string };

export function winnerKey(winner: Pick<CountableWinner, "employeeHrId">): string {
  return normalizeHrIdForAccess(winner.employeeHrId) ?? winner.employeeHrId;
}

/** Wins per rep, keyed by the normalised hr id. A row with no hr id at all counts for nobody. */
export function countWinsByHrIdKey(winners: readonly Pick<CountableWinner, "employeeHrId">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const winner of winners) {
    const key = normalizeHrIdForAccess(winner.employeeHrId);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The repeat winners for the "Most stars" list: top five by wins, then by name. One entry per REP —
 * the name printed is the first row's, which the service has already replaced with the employee's
 * current name, so every row of one rep carries the same one.
 */
export function listMostStars(
  winners: readonly CountableWinner[],
  limit = 5,
): Array<{ key: string; name: string; wins: number }> {
  const byRep = new Map<string, { key: string; name: string; wins: number }>();
  for (const winner of winners) {
    const key = winnerKey(winner);
    const entry = byRep.get(key);
    if (entry) entry.wins += 1;
    else byRep.set(key, { key, name: winner.employeeName, wins: 1 });
  }
  return [...byRep.values()]
    .filter((entry) => entry.wins > 1)
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name))
    .slice(0, limit);
}
