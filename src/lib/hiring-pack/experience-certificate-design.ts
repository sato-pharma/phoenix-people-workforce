/**
 * THE CERTIFICATE OF EXPERIENCE'S OWN DESIGN — shared by the English certificate
 * (`experience-certificate-en.ts`) and the Arabic one (`experience-certificate-ar.ts`).
 *
 * The owner chose it on 2026-10-28 (Cairo) from a pair printed for one employee, and asked for it to
 * become the certificate HR prints from the HR forms module. It sits INSIDE the HR premium identity —
 * the masthead, band, frame, watermark and running foot are `premium-identity.ts`'s, untouched — and
 * adds what a certificate needs on top: the two-weight title beside the reference facts, the holder
 * set as the page's one large name, the period at a glance, and three signing boxes.
 *
 * Both papers wear the same parts so a pair printed minutes apart for one person reads as one
 * instrument in two languages. Every class here is prefixed `xc-` and every rule is scoped under
 * `.xc`, so nothing reaches the other papers that load the premium stylesheet.
 *
 * THE SIGNING BOXES ARE BLANK — no name, no signature, no seal is drawn into them (owner,
 * 2026-10-28: "Blank box, sign by hand"). Anyone with access to HR forms can print this paper, so a
 * blank box means none leaves the building without HR signing it.
 *
 * THE INK RULE: rules and type only. The one filled shape is the 1.5 mm diamond before the kicker,
 * the identity's own marker.
 *
 * NO BACKTICKS IN THE CSS BELOW — it is a template literal, and one would close it. And no radius
 * word: the papers' tests read their stylesheets for it.
 */

import { HOUSE_COLORS } from "@/lib/hiring-pack/house-identity";
import { PREMIUM_LATIN_FONT_STACK } from "@/lib/hiring-pack/premium-identity";
import {
  ARABIC_FONT_STACK,
  countedNoun,
  escapeHtml,
  serviceSpan,
  splitIsoDate,
} from "@/lib/hiring-pack/render-shared";

const C = HOUSE_COLORS;

/** The headline face: the display cut where Windows has it, Noto Sans on the server. */
const DISPLAY_FONT_STACK = '"Segoe UI Variable Display", "Segoe UI", "Noto Sans", Arial, sans-serif';

const MONTHS_AR = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
] as const;

export type CertificateLang = "en" | "ar";

/** The month's name — English from the runtime, Arabic as Egypt writes it. Empty for a bad date. */
function monthName(month: number, lang: CertificateLang): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) return "";
  if (lang === "ar") return MONTHS_AR[month - 1];
  return new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(2000, month - 1, 1)));
}

/** "October 2026" / «أكتوبر 2026» — the masthead's issue line. Empty for a bad date. */
export function certificateMonthYear(iso: string | null | undefined, lang: CertificateLang): string {
  const parts = splitIsoDate(iso);
  if (!parts) return "";
  const month = monthName(Number(parts.month), lang);
  return month ? `${month} ${parts.year}` : "";
}

/** One date in the span: the day in outline, the month and year beside it. */
function dateFigure(iso: string | null | undefined, lang: CertificateLang): string {
  const parts = splitIsoDate(iso);
  if (!parts) return "";
  const month = monthName(Number(parts.month), lang);
  if (!month) return "";
  return `<div class="xc-fig"><b>${Number(parts.day)}</b><em>${escapeHtml(month)}<br>${parts.year}</em></div>`;
}

/** A counted unit's word, as it reads after its own numeral. */
function unitWord(count: number, unit: "year" | "month" | "day", lang: CertificateLang): string {
  if (lang === "en") {
    const word = unit === "year" ? "Year" : unit === "month" ? "Month" : "Day";
    return count === 1 ? word : `${word}s`;
  }
  const forms = {
    year: ["سنة", "سنتان", "سنوات", "سنة"],
    month: ["شهر", "شهران", "أشهر", "شهرًا"],
    day: ["يوم", "يومان", "أيام", "يومًا"],
  } as const;
  const [one, two, few, many] = forms[unit];
  // countedNoun writes "3 سنوات"; the numeral is drawn separately here, so only the word is kept.
  return countedNoun(count, one, two, few, many).replace(/^\d+\s+/, "");
}

export interface CertificateSpanInput {
  lang: CertificateLang;
  startsOn: string | null | undefined;
  endsOn: string | null | undefined;
  departed: boolean;
  countable: boolean;
}

/**
 * THE PERIOD AT A GLANCE: the joining date and the end date in outline, the total filled.
 *
 * It repeats what the paragraph above it already says, in figures, so it adds no fact and can drop
 * nothing. That is also why it is left out entirely, never ruled, when the period cannot be stated:
 * the sentence carries the blanks for a human to fill, and a strip of empty boxes would only repeat
 * them. The total is `serviceSpan` — the same arithmetic as the words — so the two cannot disagree.
 */
export function certificateSpanHtml(input: CertificateSpanInput): string {
  if (!input.countable) return "";
  const span = serviceSpan(input.startsOn, input.endsOn);
  const start = dateFigure(input.startsOn, input.lang);
  const end = dateFigure(input.endsOn, input.lang);
  if (!span || !start || !end) return "";

  const en = input.lang === "en";
  const labels = en
    ? ["Joined", input.departed ? "Last working day" : "To the date of issue", "Total service"]
    : ["تاريخ الالتحاق بالعمل", input.departed ? "آخر يوم عمل" : "حتى تاريخ صدور الشهادة", "مدة الخدمة"];

  const total = ([["year", span.years], ["month", span.months], ["day", span.days]] as const)
    .filter(([, count]) => count > 0)
    .map(([unit, count]) => `<b>${count}</b><em>${escapeHtml(unitWord(count, unit, input.lang))}</em>`)
    .join("");
  if (!total) return "";

  return `<div class="xc-span">
        <div><span class="xc-micro">${escapeHtml(labels[0])}</span>${start}</div>
        <div><span class="xc-micro">${escapeHtml(labels[1])}</span>${end}</div>
        <div class="xc-tot"><span class="xc-micro">${escapeHtml(labels[2])}</span><div class="xc-fig">${total}</div></div>
      </div>`;
}

/**
 * The three signing boxes, BLANK. Each is a `span` inside `div.cert__signrow` — the shape the stored
 * hand-placed marks were measured against (`… > div:nth-of-type(1) > span:nth-of-type(3)` is the
 * stamp box), so a mark still finds its box.
 */
export function certificateSignCellsHtml(labels: readonly [string, string, string]): string {
  const cells = labels
    .map((label) => `<span class="xc-cell"><em class="xc-lbl">${escapeHtml(label)}</em></span>`)
    .join("");
  return `<div class="cert__signrow xc-cells">${cells}</div>`;
}

/**
 * The design's stylesheet, appended AFTER `premiumDocumentStylesheet()` so its masthead overrides
 * win on order. Scoped under `.xc`; the Arabic paper adds `.xc--ar`.
 */
export const EXPERIENCE_CERTIFICATE_DESIGN_CSS = `
  .xc { font-family: ${PREMIUM_LATIN_FONT_STACK}; color: ${C.body}; font-kerning: normal; }
  .xc p { margin: 0; }

  /* The masthead speaks quietly here: the certificate's own title is the hero below it. */
  .xc .pm-mast__t--en { margin-top: 0; font-size: 8.5pt; letter-spacing: 2.6pt; text-transform: uppercase; line-height: 1.3; }
  .xc .pm-mast__s, .xc .pm-mast__s[lang] { font-size: 6.8pt; font-weight: 400; letter-spacing: 1.3pt; text-transform: uppercase; }

  .xc-micro { font-size: 7pt; font-weight: 700; letter-spacing: 1.6pt; text-transform: uppercase; color: ${C.blue}; line-height: 1.3; }
  .xc .pm-shead.xc-micro { margin: 0; }
  .xc-dia { display: inline-block; width: 1.5mm; height: 1.5mm; background: ${C.deep}; transform: rotate(45deg); }

  /* the hero: the two-weight title beside the certificate's reference facts */
  .xc-hero { display: grid; grid-template-columns: 1fr 62mm; column-gap: 10mm; margin-top: 8mm; align-items: end; }
  .xc-kicker { display: flex; align-items: center; gap: 2.5mm; }
  .xc-hero h2 { margin: 5mm 0 0; color: ${C.deep}; font-family: ${DISPLAY_FONT_STACK}; font-size: 29pt; line-height: 1.08;
    font-weight: 250; letter-spacing: -0.6pt; }
  .xc-hero h2 b { display: block; margin-top: 1mm; font-size: 47pt; line-height: .98; font-weight: 700; letter-spacing: -1.5pt; }
  .xc-tar { margin-top: 2mm; color: ${C.blue}; font-family: ${ARABIC_FONT_STACK}; font-size: 12pt; font-weight: 600; text-align: left; }
  .xc-tick { display: flex; align-items: center; gap: 1.5mm; margin: 5mm 0 3.6mm; }
  .xc-tick i { display: block; border-top: 1.2pt solid ${C.blue}; width: 14mm; }
  .xc-tick i + i { width: 3mm; border-top-color: ${C.light}; }
  .xc-tick i + i + i { width: 1.2mm; border-top-color: ${C.hair}; }
  .xc-purpose { color: ${C.muted}; font-size: 8.4pt; line-height: 1.5; }

  .xc-facts { margin: 0; padding: 0; border-top: .7pt solid ${C.deep}; }
  .xc-facts > div { display: grid; grid-template-columns: 22mm 1fr; column-gap: 3mm; padding: 2.3mm 0;
    border-bottom: .4pt solid ${C.hair}; align-items: baseline; }
  .xc-facts dt { color: ${C.blue}; font-size: 6.4pt; font-weight: 700; letter-spacing: 1.3pt; text-transform: uppercase; }
  .xc-facts dd { margin: 0; font-size: 10pt; color: ${C.ink}; font-variant-numeric: lining-nums tabular-nums; overflow-wrap: anywhere; }
  .xc-facts .fill { color: inherit; font-weight: inherit; }

  /* the holder, set as the page's one large name */
  .xc-holder { margin-top: 8mm; padding-top: 3mm; border-top: .7pt solid ${C.deep}; display: grid;
    grid-template-columns: 1fr auto; align-items: end; column-gap: 8mm; }
  .xc-nm { margin-top: 2mm; color: ${C.deep}; font-family: ${DISPLAY_FONT_STACK}; font-size: 21pt; line-height: 1.1;
    font-weight: 300; letter-spacing: -0.3pt; }
  .xc-nm b { font-weight: 700; }
  .xc-nm .fill { color: inherit; font-weight: inherit; }
  .xc-role { max-width: 62mm; padding-left: 4mm; border-left: 1.2pt solid ${C.blue}; color: ${C.body}; font-size: 9pt; line-height: 1.5; }
  .xc-role b { display: block; color: ${C.deep}; font-size: 10pt; }
  .xc-role .fill { color: inherit; font-weight: inherit; }

  /* the certificate's own words */
  .xc-text { margin-top: 8mm; }
  .xc-salute { margin: 0 0 3.6mm; color: ${C.deep}; font-family: ${DISPLAY_FONT_STACK}; font-size: 14pt; font-weight: 600; letter-spacing: -0.1pt; }
  .xc-text p { margin: 0; font-size: 10.6pt; line-height: 1.62; color: ${C.body}; }
  .xc-text p + p { margin-top: 3mm; }
  .xc .xc-text .fill { color: ${C.ink}; font-weight: 600; font-variant-numeric: lining-nums; white-space: nowrap; }
  .xc .xc-text .fill[data-hp-key="EMPLOYEE_NAME_EN"],
  .xc .xc-text .fill[data-hp-key="JOB_TITLE_EN"],
  .xc .xc-text .fill[data-hp-key="JOB_TITLE"],
  .xc .xc-text .fill[data-hp-key="DEPARTMENT"] { white-space: normal; }
  .xc .xc-text .fill[data-hp-key="EMPLOYEE_NAME_EN"] { color: ${C.deep}; font-weight: 700; }
  .xc .rule-line { color: ${C.muted}; letter-spacing: .04em; }

  /* the period at a glance: two dates in outline, the span filled */
  .xc-span { display: grid; grid-template-columns: 1fr 1fr 1.55fr; margin: 5mm 0; border-top: .7pt solid ${C.deep};
    border-bottom: .4pt solid ${C.hair}; }
  .xc-span > div { padding: 2.4mm 4mm 2.8mm; border-left: .4pt solid ${C.hair}; }
  .xc-span > div:first-child { padding-left: 0; border-left: 0; }
  .xc-fig { display: flex; align-items: center; gap: 2.2mm; margin-top: 2mm; }
  .xc-fig b { font-family: ${DISPLAY_FONT_STACK}; font-size: 27pt; line-height: .8; font-weight: 200; color: transparent;
    -webkit-text-stroke: .6pt ${C.light}; letter-spacing: -1pt; font-variant-numeric: lining-nums; }
  .xc-fig em { font-style: normal; color: ${C.deep}; font-size: 7.4pt; line-height: 1.25; font-weight: 700;
    letter-spacing: 1.2pt; text-transform: uppercase; }
  .xc-tot .xc-fig { gap: 1.6mm; }
  .xc-tot .xc-fig b { color: ${C.deep}; -webkit-text-stroke: 0; font-weight: 700; }
  .xc-tot .xc-fig em { margin-right: 2.6mm; color: ${C.muted}; }
  .xc-tot .xc-fig em:last-child { margin-right: 0; }

  /* signed and stamped: three blank boxes under one deep rule.
     THE BOXES TAKE WHAT THE SHEET HAS LEFT. Each copy is a column one sheet tall, and the boxes grow
     into the space under the words, up to 40 mm — so a long name or job title shortens the boxes
     instead of carrying the signing block onto a second sheet. Never under 22 mm, room enough to
     sign and press a stamp; past that the paper does run over, which is honest. Printed, the column
     is 296 mm, not 297, so rounding can never push an empty second sheet out. */
  .xc { display: flex; flex-direction: column; }
  @media print { .xc { min-height: 296mm; } }
  .xc-sign { margin-top: 8mm; flex: 1 0 auto; display: flex; flex-direction: column; }
  .xc .cert__signfor { margin: 2.6mm 0 0; color: ${C.deep}; font-size: 9.6pt; font-weight: 700; }
  .xc-cells { flex: 1 1 0; min-height: 22mm; max-height: 40mm; display: grid; grid-template-columns: 1.15fr 1fr 1fr; margin-top: 2.6mm; border-top: .7pt solid ${C.deep};
    border-bottom: .4pt solid ${C.hair}; }
  .xc-cells > .xc-cell { display: block; position: relative; padding: 2.4mm 4mm; border-left: .4pt solid ${C.hair}; }
  .xc-cells > .xc-cell:first-child { padding-left: 0; border-left: 0; }
  .xc-lbl { display: block; font-style: normal; color: ${C.blue}; font-size: 6.4pt; font-weight: 700; letter-spacing: 1.3pt; text-transform: uppercase; }

  /* ---------- the Arabic paper: same anatomy, read right to left, never letter-spaced ---------- */
  .xc--ar { font-family: ${ARABIC_FONT_STACK}; }
  .xc--ar .pm-mast__t { margin-top: 0; font-size: 11pt; letter-spacing: 0; }
  .xc--ar .pm-mast__s, .xc--ar .pm-mast__s[lang] { font-size: 8pt; letter-spacing: 0; text-transform: none; }
  .xc--ar .xc-micro, .xc--ar .xc-facts dt, .xc--ar .xc-lbl { font-size: 8.4pt; letter-spacing: 0; text-transform: none; }
  .xc--ar .xc-hero { grid-template-columns: 1fr 72mm; }
  .xc--ar .xc-tick { margin: 4mm 0 3mm; }
  .xc--ar .xc-hero h2 { margin-top: 4mm; font-family: ${ARABIC_FONT_STACK}; font-size: 30pt; line-height: 1.25; font-weight: 400; letter-spacing: 0; }
  .xc--ar .xc-hero h2 b { display: inline; margin: 0; font-size: 30pt; line-height: 1.25; letter-spacing: 0; }
  .xc-law { margin-top: 1.4mm; color: ${C.deep}; font-size: 9pt; line-height: 1.55; }
  .xc--ar .xc-purpose { font-size: 8.2pt; line-height: 1.6; }
  .xc-issuer { border-top: .7pt solid ${C.deep}; padding-top: 2.4mm; }
  .xc-issuer p { margin-top: 1mm; font-size: 8pt; line-height: 1.65; color: ${C.body}; }
  .xc-issuer .fill { color: inherit; font-weight: inherit; }
  .xc--ar .xc-facts > div { grid-template-columns: 31mm 1fr; padding: 1.7mm 0; }
  .xc--ar .xc-facts dd { font-size: 10.6pt; }
  .xc-fields { display: grid; grid-template-columns: 1fr 1fr; column-gap: 9mm; margin-top: 3mm; }
  .xc-fields > .xc-wide { grid-column: 1 / -1; }
  .xc-fields > .xc-wide dd { color: ${C.deep}; font-size: 15pt; font-weight: 700; }
  .xc-party { margin-top: 5.5mm; }
  .xc--ar .xc-text { margin-top: 5.5mm; }
  .xc--ar .xc-salute { font-family: ${ARABIC_FONT_STACK}; font-size: 13pt; font-weight: 700; letter-spacing: 0; margin-bottom: 2.4mm; }
  .xc--ar .xc-text p { font-size: 11pt; line-height: 1.8; }
  .xc--ar .xc-text p + p { margin-top: 1.6mm; }
  /* The status sentence is a whole sentence held in one blank, and the company is named as the
     approved pair names it: both read as the paragraph's own words, not as filled-in values. */
  .xc .xc-text .fill[data-hp-key="SERVICE_STATUS"],
  .xc .xc-text .fill[data-hp-key="COMPANY_NAME"] { color: inherit; font-weight: inherit; white-space: normal; }
  .xc--ar .xc-span { grid-template-columns: 1fr 1fr 1.4fr; margin: 3mm 0; }
  .xc--ar .xc-span > div { border-left: 0; border-right: .4pt solid ${C.hair}; }
  .xc--ar .xc-span > div:first-child { padding-left: 4mm; padding-right: 0; border-right: 0; }
  .xc--ar .xc-fig em { font-size: 9pt; letter-spacing: 0; line-height: 1.35; }
  .xc--ar .xc-tot .xc-fig em { margin-right: 0; margin-left: 2.6mm; }
  .xc--ar .xc-tot .xc-fig em:last-child { margin-left: 0; }
  .xc--ar .xc-sign { margin-top: 5mm; }
  .xc--ar .cert__signfor { font-size: 10.4pt; }
  .xc--ar .xc-cells > .xc-cell { border-left: 0; border-right: .4pt solid ${C.hair}; }
  .xc--ar .xc-cells > .xc-cell:first-child { padding-left: 4mm; padding-right: 0; border-right: 0; }
`;
