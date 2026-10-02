/**
 * Phoenix CRM Wave 2 — the tracking sheet: every customer down the side, every day of the month
 * across the top, and a mark where a visit landed.
 *
 * 🔴 THE SPACING NOTE IS FOR MANAGERS ONLY, AND IT NEVER REACHES THE REP. "Seen on the 5th and the
 * 9th, then not again" is a judgement about how a rep worked his month, which is Golden rule #1's
 * whole subject: the rep's app is easy and BLIND, and anything that judges him is never his. The
 * note is computed here and gated by the caller (`managerView`), and the rep's own grid carries
 * the marks without a word of commentary.
 *
 * Pure rules, no I/O.
 */

export type TrackingSheetInput = {
  customerId: string;
  name: string;
  /** The Cairo calendar days a countable visit landed on, `YYYY-MM-DD`, any order. */
  days: readonly string[];
};

export type TrackingSheetRow = {
  customerId: string;
  name: string;
  /** Ascending, de-duplicated — two visits to one customer in a day mark that day once. */
  days: string[];
  /** The gaps between consecutive visits, in days. Empty for a customer seen once or not at all. */
  gaps: number[];
  /** Manager-only. Null for the rep's own view, and null when there is nothing worth saying. */
  spacing: string | null;
};

/** Whole days between two `YYYY-MM-DD` dates, read as UTC so no timezone can shift the count. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function dayOfMonth(iso: string): string {
  const day = Number(iso.slice(8, 10));
  if (!Number.isFinite(day)) return iso;
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suffix}`;
}

/**
 * The manager's sentence, in plain words about the shape of the month — never a score and never a
 * verdict. It only speaks when the shape is actually lopsided: a customer seen at an even cadence
 * gets nothing, because a note on every row is a note nobody reads.
 *
 * The test for "lopsided" is that the rep STOPPED — the tail since the last visit is longer than
 * the longest gap between visits, and longer than a week. A bunched start followed by silence is
 * the pattern he described in his own words, and it is the one a manager can still act on with
 * days left in the month.
 *
 * 🔴 `through` IS WHERE THE MONTH HAS GOT TO, NOT WHERE IT ENDS. On a RUNNING month it is TODAY: the
 * caller passes the earlier of the month's end and today (`reports.ts`). Handed the month's end it
 * measured the tail against days nobody had lived yet, so on the 3rd of a month every customer read
 * a 28-day silence and the note fired on all of them — "then not again" about a customer the rep had
 * seen yesterday. A finished month passes its own end, which is the same thing.
 */
export function spacingNote(days: readonly string[], through: string): string | null {
  if (days.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i += 1) gaps.push(daysBetween(days[i - 1] as string, days[i] as string));
  const longestGap = Math.max(...gaps);
  const tail = daysBetween(days[days.length - 1] as string, through);
  if (tail <= 7 || tail <= longestGap) return null;
  // His own wording, kept exactly: "Seen on the 5th and the 9th, then not again." The article
  // repeats before every date — the opening "Seen on the" supplies the first one, so the joins
  // carry the rest. A long month is summarised rather than listed, because a note that runs to
  // nine dates is a row of data pretending to be a sentence.
  const listed = days.map(dayOfMonth);
  const said =
    listed.length <= 3
      ? listed.slice(0, -1).join(", the ") + ` and the ${listed[listed.length - 1]}`
      : `${listed.slice(0, 2).join(", the ")} and ${listed.length - 2} more`;
  return `Seen on the ${said}, then not again.`;
}

/**
 * `through` is where the month has got to — TODAY on a running month, the month's end on a finished
 * one. See {@link spacingNote}; passing the month's end for a running month is the defect it names.
 */
export function buildTrackingSheet(
  inputs: readonly TrackingSheetInput[],
  through: string,
  options: { managerView: boolean },
): TrackingSheetRow[] {
  return inputs
    .map((input) => {
      const days = [...new Set(input.days)].sort();
      const gaps: number[] = [];
      for (let i = 1; i < days.length; i += 1) gaps.push(daysBetween(days[i - 1] as string, days[i] as string));
      return {
        customerId: input.customerId,
        days,
        gaps,
        name: input.name,
        // 🔴 Gated HERE as well as by the caller. A report helper that returns the note and trusts
        //    the screen to hide it is one render away from putting a judgement on a rep's phone.
        spacing: options.managerView ? spacingNote(days, through) : null,
      };
    })
    .sort((a, b) => b.days.length - a.days.length || a.name.localeCompare(b.name));
}
