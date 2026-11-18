/**
 * The managers an offer for a position may name as its reporting line, offered as one-press choices
 * beside the free "Reports to" box on the offer form.
 *
 * WHY THIS EXISTS. A position's reporting line is normally one fact, kept on its job title and
 * prefilled into the offer. A Product Manager is the exception at Sato Pharma: one reports to the
 * Marketing Manager (Anti Infective), another to a Group Product Manager (Pedia and Anti Infective),
 * and the owner chooses per offer (17 Nov 2026: "can be reporting to marketing manager or group
 * product manager as i choose"). The letter prints the choice as "reporting to the …", by title
 * only, never a person's name (his answer: "Title only").
 *
 * The box stays typeable: a choice only writes its words into it. Pure and browser-safe — the offer
 * form imports it, so it must never import the server-side offer service.
 */

const REPORTS_TO_CHOICES: Readonly<Record<string, readonly string[]>> = {
  "product manager": ["Marketing Manager", "Group Product Manager"],
};

function normalizeTitle(title: string | null | undefined): string {
  return String(title ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** The reporting lines offered for a title, in the order they are shown; empty for every other title. */
export function reportsToChoicesForTitle(title: string | null | undefined): readonly string[] {
  return REPORTS_TO_CHOICES[normalizeTitle(title)] ?? [];
}

/** One person the joining form may file a new joiner under. */
export type ReportsToPerson = {
  active: boolean;
  hrId: string;
  jobTitle: string | null;
  lineId: number | null;
  name: string;
};

/**
 * The manager the joining form files a new joiner under when the offer CHOSE a reporting line.
 *
 * WHY. The record's manager used to come from the vacancy alone, so a Product Manager whose offer
 * said "reporting to the Group Product Manager" was filed under the Marketing Manager, and the new
 * joiner announcement told Head Office the wrong name (Nourhan Abdelmoniem, 18 Nov 2026: the offer
 * named the Group Product Manager, the record and the email named the Marketing Manager).
 *
 * Only for a title that offers choices, and only when the offer's words are one of them: every other
 * title's "Reports to" is free text and the vacancy keeps deciding. The choice is a title, so it
 * becomes a person only when exactly one ACTIVE employee holds that title, or exactly one on the
 * seat's own line; anything else returns null and the vacancy's manager stays. PURE.
 */
export function pickReportsToManager(input: {
  offerTitle: string | null | undefined;
  people: readonly ReportsToPerson[];
  reportsTo: string | null | undefined;
  seatLineId: number | null;
}): { hrId: string; name: string } | null {
  const wanted = normalizeTitle(input.reportsTo);
  if (!wanted) return null;
  const offered = reportsToChoicesForTitle(input.offerTitle).map(normalizeTitle);
  if (!offered.includes(wanted)) return null;
  const holders = input.people.filter((person) => person.active && normalizeTitle(person.jobTitle) === wanted);
  const onLine = input.seatLineId === null ? [] : holders.filter((person) => person.lineId === input.seatLineId);
  const pick = holders.length === 1 ? holders[0] : onLine.length === 1 ? onLine[0] : null;
  return pick ? { hrId: pick.hrId, name: pick.name } : null;
}
