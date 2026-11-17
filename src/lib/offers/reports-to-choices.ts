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
