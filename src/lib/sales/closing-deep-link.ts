// A deep link into the Closing Matrix that could not be honoured must SAY SO on the page.
//
// /sales/monthly-closing takes ?line= and ?period= — the published-closing email's link is built
// from them (closing-publish-notification.ts), and so is every link anyone pastes into a chat or a
// bookmark. loadMonthlyClosingParts validates each one against the months and lines it actually
// has and, finding neither, falls back to `availableLines[0]` and `availablePeriods[0]`: the newest
// month of the first line.
//
// 🔴 THAT FALLBACK IS CORRECT AND SILENT, WHICH IS THE PROBLEM. The page then renders a real,
// complete closing for a DIFFERENT line or month than the link asked for, under the ordinary
// heading, with nothing anywhere saying a substitution happened. A manager who clicks "Pedia,
// August" in last month's email and reads September's national total has no way to know. The
// client-side picker already refuses to do this quietly — a month it could not read is named in an
// amber line above the matrix ("has no closing data, so it is not in the figures below") — and this
// module is the same promise for the first, server-rendered read.
//
// The comparison is deliberately EXACT apart from case and surrounding space, because the loader's
// own membership test is exact: "cns" is not "CNS" to it, and a link spelled that way lands on
// whichever line happens to be first. Case alone is not a substitution worth reporting — the reader
// got the line they asked for — so it is folded out here, and everything else is reported.

import { periodLabel } from "@/lib/sales/monthly-closing-period-merge";

/** The parts of a deep link the closing could not honour. Null fields were honoured (or absent). */
export type ClosingDeepLinkMiss = {
  line: string | null;
  period: string | null;
};

function clean(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function sameValue(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/**
 * What a ?line=/?period= link asked for and did not get, or null when it was honoured.
 *
 * Returns null when nothing loaded at all (no resolved line or period): the page already says
 * there is no validated Source of Sales data, and a substitution notice on top of that would
 * describe a substitution that never happened.
 */
export function resolveClosingDeepLinkMiss(input: {
  requestedLine?: string | null;
  requestedPeriod?: string | null;
  resolvedLine?: string | null;
  resolvedPeriod?: string | null;
}): ClosingDeepLinkMiss | null {
  const requestedLine = clean(input.requestedLine);
  const requestedPeriod = clean(input.requestedPeriod);
  const resolvedLine = clean(input.resolvedLine);
  const resolvedPeriod = clean(input.resolvedPeriod);

  const line = requestedLine && resolvedLine && !sameValue(requestedLine, resolvedLine) ? requestedLine : null;
  const period = requestedPeriod && resolvedPeriod && !sameValue(requestedPeriod, resolvedPeriod)
    ? requestedPeriod
    : null;

  if (!line && !period) return null;
  return { line, period };
}

/**
 * The sentence shown above the matrix. It names what was asked for AND what is on screen instead,
 * because either half alone leaves the reader to work out which numbers they are looking at.
 */
export function describeClosingDeepLinkMiss(
  miss: ClosingDeepLinkMiss,
  shown: { line?: string | null; period?: string | null },
): string {
  const shownLine = clean(shown.line);
  const shownPeriod = clean(shown.period);

  if (miss.line && miss.period) {
    return `This link asked for ${miss.line} ${periodLabel(miss.period)}, which the closing does not have. `
      + `${shownLine} ${periodLabel(shownPeriod)} is shown instead.`;
  }
  if (miss.line) {
    return `This link asked for the ${miss.line} closing, which is not available. `
      + `${shownLine} is shown instead.`;
  }
  return `This link asked for ${periodLabel(miss.period)}, which has no closing yet. `
    + `${periodLabel(shownPeriod)} is shown instead.`;
}
