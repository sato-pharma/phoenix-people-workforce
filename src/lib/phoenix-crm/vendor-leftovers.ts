/**
 * Phoenix CRM — who is still recording his day in iReports360 after his team moved.
 *
 * Owner's pick, 2026-10-02. From a team's start its reps' iReports360 visits are IGNORED everywhere
 * (`src/lib/crm/phoenix-team-starts.ts`): the unified view anti-joins them out, so a rep who keeps
 * logging there is doing real work that lands in **no** figure at all — not his call rate, not his
 * coverage, not a single screen anybody reads.
 *
 * It is worth a flag because the volume is not small and the switch is not automatic. Measured on
 * production on 2026-10-02, the day before Delta (1) began: **1,629 iReports360 visits in fourteen
 * days from all seventeen of its people, 135.8 a day.** If even a few of them carry on out of habit,
 * their month reads empty and nobody can tell why.
 *
 * 🔴 IT IS ABOUT WHERE WORK IS RECORDED, NEVER ABOUT HONESTY. A rep still on the old app is
 * following the habit he was trained in; nothing here is an accusation, a flag against him, or an
 * integrity signal, and `WORDS` below is deliberately free of blame. Read by his district manager,
 * the SFE Manager and the Super Admin — never by the rep (Phoenix CRM golden rule #1: his app never
 * lets him feel he is being checked, and this is not his to see).
 *
 * Pure: counts in, sentence out.
 */

export type VendorLeftoverRep = {
  /** The rep, by name — never an HR id on a screen. */
  repName: string;
  /** iReports360 visits he recorded since his team started counting from Phoenix. */
  visits: number;
  /** The last day one arrived, `YYYY-MM-DD`, so a manager can see whether it is still happening. */
  lastDay: string;
};

/** Most still-arriving first, then the heaviest, then by name — the order a manager works them. */
export function sortVendorLeftovers(reps: ReadonlyArray<VendorLeftoverRep>): VendorLeftoverRep[] {
  return [...reps].sort(
    (left, right) =>
      right.lastDay.localeCompare(left.lastDay) || right.visits - left.visits || left.repName.localeCompare(right.repName),
  );
}

/**
 * The one sentence every screen prints, or null when nobody is. Names the people, because a count
 * alone ("3 reps") gives a manager nothing to act on, and the list is short by construction.
 */
export function vendorLeftoverNote(reps: ReadonlyArray<VendorLeftoverRep>): string | null {
  const sorted = sortVendorLeftovers(reps.filter((rep) => rep.visits > 0));
  if (sorted.length === 0) return null;
  const visits = sorted.reduce((sum, rep) => sum + rep.visits, 0);
  const names = sorted.map((rep) => rep.repName);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const calls = visits === 1 ? "1 visit" : `${visits} visits`;
  return `${who} ${names.length === 1 ? "is" : "are"} still recording in iReports360 — ${calls} since the team moved, counted nowhere.`;
}

/** The heading above the sentence. States the cost, not a verdict on anyone. */
export const VENDOR_LEFTOVER_TITLE = "Work recorded in the old app";
