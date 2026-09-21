// The Closing Corrections page's headline chip.
//
// The chip printed "Nothing distorts this month" in green whenever the situation count was 0 — and
// a FAILED load leaves the count at 0 too (no data at all), so a month nobody could check read as a
// clean month to the person about to sign it off. Source of Sales fix backlog, re-measured
// 2026-09-18, #109. The green chip is now earned only by a load that ran and found nothing.

export type ClosingCorrectionsHeadline = {
  tone: "neutral" | "orange" | "slate" | "emerald";
  text: string;
};

export function closingCorrectionsHeadline(input: {
  loadError: string | null;
  period: string | null | undefined;
  situationCount: number | null | undefined;
}): ClosingCorrectionsHeadline {
  if (input.loadError) return { tone: "slate", text: "Could not check this month" };
  if (!input.period) return { tone: "neutral", text: "No month to check" };
  const count = input.situationCount ?? 0;
  if (count > 0) return { tone: "orange", text: `${count} situations found` };
  return { tone: "emerald", text: "Nothing distorts this month" };
}
