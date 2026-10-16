/**
 * Phoenix CRM — who recorded the SAME day in both apps after his team moved.
 *
 * Owner's pick, 2026-10-02; the premise changed on 2026-10-16. PHOENIX WINS THE DAY, FOR A MEDICAL REP:
 * once a started team's rep has an entry in Phoenix CRM on a day, his iReports360 visits of THAT day are
 * ignored everywhere (`src/lib/crm/phoenix-team-starts.ts`), and a day he recorded only in iReports360
 * counts as it always did. So the only iReports360 work that reaches no figure is a day recorded in both
 * apps — and that is what this flag counts. (Before 2026-10-16 every iReports360 visit from the start
 * was dropped, and this flag counted them all, "counted nowhere".)
 *
 * It is worth a flag because the duplicate effort is not small and the switch is not automatic. Measured
 * on production on 2026-10-02, the day before Delta (1) began: **1,629 iReports360 visits in fourteen
 * days from all seventeen of its people, 135.8 a day.** A rep who keeps double-entering is spending the
 * time twice, and the second copy counts for nothing.
 *
 * 🔴 IT IS ABOUT WHERE WORK IS RECORDED, NEVER ABOUT HONESTY. A rep still on the old app is
 * following the habit he was trained in; nothing here is an accusation, a flag against him, or an
 * integrity signal, and `WORDS` below is deliberately free of blame. Read by his district manager,
 * the SFE Manager and the Super Admin — never by the rep (Phoenix CRM golden rule #1: his app never
 * lets him feel he is being checked, and this is not his to see). A district manager keeps both apps by
 * the owner's rule, so he never appears here.
 *
 * Pure: counts in, sentence out.
 */

export type VendorLeftoverRep = {
  /** The rep, by name — never an HR id on a screen. */
  repName: string;
  /** iReports360 visits he recorded on days he also recorded in Phoenix CRM, since his team started. */
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
  return `${who} ${names.length === 1 ? "is" : "are"} still recording in iReports360 on days also recorded in Phoenix CRM — ${calls} since the team moved, not counted.`;
}

/** The heading above the sentence. States the cost, not a verdict on anyone. */
export const VENDOR_LEFTOVER_TITLE = "Recorded in both apps on the same day";
