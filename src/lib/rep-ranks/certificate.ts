// Phoenix Ranks — the rep's certificate: the rank, the title, the score, and why the rep stands where
// they do, on one A4 sheet. PURE: data in, HTML out; the PDF is rendered in server/certificate-pdf.ts.
//
// Owner, 2026-10-05: "any rep who is taking a rank or a title to be able to export a premium polished
// PDF showing his title, his rank and his score and a snapshot of why he is in this place."
//
// ONE DESIGN WITH THE SPOTLIGHT SHEET. A rep's two recognition sheets are the same document family:
// the crest band, the bracketed field, the name on its rule, the stat band, the Arabic mark in the
// foot and SATO-DIS-2026-01 are the spotlight's own (src/lib/spotlight/pdf.ts — its fills are the
// owner's approved exemption from the ink rule), imported rather than copied so the two cannot drift.
//
// SCORES ONLY. The certificate prints what the rep's own portal page prints — the scores and places —
// never the counts behind them, and never which integrity check a save failed. Its words are about
// the rep in the third person and neutral: no "he", no "she".

import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { insigniaSvg } from "@/lib/rep-ranks/insignia-svg";
import type { MilitaryRank, RankTitle } from "@/lib/rep-ranks/ladder";
import { promotionSentence } from "@/lib/rep-ranks/ladder";
import {
  RANK_PILLARS,
  RANK_START_BONUS_MAX,
  scoredPillarCount,
  startBonusOf,
  startBonusPoints,
  type RankPillarScores,
} from "@/lib/rep-ranks/scoring";
import { RANK_WINDOW_TABS, type RankWindowKind } from "@/lib/rep-ranks/windows";
import { opener, SHEET_CSS, sheetShell, statBand } from "@/lib/spotlight/pdf";

export type RankCertificateInput = {
  repName: string;
  lineName: string | null;
  areaName: string | null;
  kind: RankWindowKind;
  /** "October 2026", "Week of 3 Oct 2026" — the window's own label. */
  windowLabel: string;
  /** A running window is "so far"; the certificate says so rather than claiming a finished period. */
  closed: boolean;
  total: number;
  companyPosition: number;
  companyCount: number;
  linePosition: number | null;
  lineCount: number;
  pillars: RankPillarScores;
  rank: MilitaryRank;
  rollingScore: number | null;
  stars: number;
  titles: readonly RankTitle[];
  /** The company #1's score in this window, for the gap line. */
  leaderTotal: number | null;
  /** The #2's score, when this rep is #1. */
  runnerUpTotal: number | null;
  /** When it was issued, already in Cairo words. */
  issuedLabel: string;
  /** The rep's polished portrait as a data URI, or null for the initials plate (owner, 2026-10-06, asking for the rep's picture). */
  photoDataUri: string | null;
  /** Two letters for the plate when there is no photograph — a name, never a code. */
  initials: string;
};

const round1 = (value: number): number => Math.round(value * 10) / 10;
const points = (value: number): string => (round1(value) === 1 ? "1 point" : `${round1(value).toFixed(1)} points`);

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** The sentence under the name: who, where, and the place — counts only, no opinion. */
export function certificateSentence(input: RankCertificateInput): string {
  const line = input.lineName ? ` on the ${input.lineName} line` : "";
  const where = input.areaName ? ` in ${input.areaName}` : "";
  const period = input.closed ? `for ${input.windowLabel}` : `for ${input.windowLabel} so far`;
  return `A medical representative${line}${where}, ranked ${ordinal(input.companyPosition)} of ${input.companyCount} across the company on Phoenix Ranks ${period}.`;
}

/** "Why this place" — the snapshot, every clause a figure printed elsewhere on the sheet. */
export function certificateReasons(input: RankCertificateInput): string[] {
  const reasons: string[] = [];
  const scored = scoredPillarCount(input.pillars);
  const bonus = startBonusOf(input.pillars);
  reasons.push(
    `A score of ${input.total.toFixed(1)}: the average of ${scored} Phoenix CRM measures, each worth the same${
      bonus > 0 ? `, plus ${round1(bonus).toFixed(1)} of the ${RANK_START_BONUS_MAX} AM start bonus points` : ""
    }.`,
  );
  if (input.companyPosition === 1) {
    reasons.push(
      input.runnerUpTotal !== null
        ? `First in the company, ${points(input.total - input.runnerUpTotal)} ahead of the next rep.`
        : "First in the company.",
    );
  } else if (input.leaderTotal !== null) {
    reasons.push(`${points(input.leaderTotal - input.total)} behind the company's first place.`);
  }
  if (input.linePosition !== null && input.lineName) {
    reasons.push(`${ordinal(input.linePosition)} of ${input.lineCount} on the ${input.lineName} line.`);
  }
  const measures = RANK_PILLARS.filter((pillar) => !pillar.bonus && input.pillars[pillar.key] !== null).map((pillar) => ({
    label: pillar.label,
    score: input.pillars[pillar.key] as number,
  }));
  const strongest = [...measures].sort((a, b) => b.score - a.score).slice(0, 3);
  if (strongest.length > 0) reasons.push(`Strongest: ${strongest.map((measure) => `${measure.label} ${measure.score}`).join(" · ")}.`);
  const weakest = [...measures].sort((a, b) => a.score - b.score)[0];
  if (weakest && weakest.score < 100) reasons.push(`Most room to grow: ${weakest.label} at ${weakest.score}.`);
  return reasons;
}

function titlesLine(titles: readonly RankTitle[]): string {
  if (titles.length === 0) return "";
  const shown = titles
    .slice(-4)
    .reverse()
    .map((title) => `${title.scope === "company" ? "Company" : "Line"} #1 · ${RANK_WINDOW_TABS[title.windowKind]} ${title.windowLabel}`);
  const more = titles.length > shown.length ? ` · and ${titles.length - shown.length} more` : "";
  return `<p class="rc-titles"><span>Titles held</span>${shown.map((text) => escapeHtml(text)).join(" &middot; ")}${escapeHtml(more)}</p>`;
}

/** The framed portrait, or the initials plate when there is no photograph. Square-edged, like the sheet. */
function portraitHtml(input: RankCertificateInput): string {
  const inner = input.photoDataUri && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(input.photoDataUri)
    ? `<img src="${input.photoDataUri}" alt="${escapeHtml(input.repName)}" />`
    : `<span class="rc-portrait__mono">${escapeHtml(input.initials)}</span>`;
  return `<div class="rc-portrait"><div class="rc-portrait__in">${inner}</div></div>`;
}

function measureGrid(pillars: RankPillarScores): string {
  return `<div class="rc-grid">${RANK_PILLARS.map((pillar) => {
    const score = pillars[pillar.key];
    const shown = score === null ? "—" : pillar.bonus ? `+${startBonusPoints(score).toFixed(1)}` : String(score);
    return `<div class="rc-m${pillar.bonus ? " rc-m--bonus" : ""}">
      <p class="rc-m__row"><span class="rc-m__l">${escapeHtml(pillar.label)}</span><span class="rc-m__v">${shown}</span></p>
      <div class="rc-m__track"><div class="rc-m__bar" style="width:${score ?? 0}%"></div></div>
    </div>`;
  }).join("")}</div>`;
}

const CERT_CSS = `
  /* THE PORTRAIT LEADS THE RANK ROW (owner, 2026-10-06, asking for the rep's picture): the face, then the
     insignia and the rank's names, with the promotion line under them — so the row that gained the
     photograph also absorbed the line that used to sit below it, and the sheet still fits A4. The
     places line above the row is gone for the same reason; the stat band carries both places. */
  .rc-rank { margin-top: calc(var(--u) * 1.3); display: flex; align-items: center; justify-content: center; gap: 7mm; }
  .rc-portrait { flex: 0 0 auto; position: relative; width: 31mm; height: 38mm; border: var(--hair-w) solid var(--hair); background: #FFF; }
  .rc-portrait__in { position: absolute; inset: 1.4mm; overflow: hidden; background: var(--wash);
    border: var(--hair-w) solid var(--light); }
  .rc-portrait__in img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: center top; }
  .rc-portrait__mono { display: flex; width: 100%; height: 100%; align-items: center; justify-content: center;
    font-family: var(--display); font-size: 26pt; font-weight: 700; color: var(--deep); letter-spacing: .04em; }
  .rc-rank__body { flex: 0 1 auto; max-width: 112mm; }
  .rc-rank__top { display: flex; align-items: center; gap: 6mm; }
  .rc-rank__badge { flex: 0 0 auto; width: 34mm; }
  .rc-rank__names { text-align: left; }
  .rc-rank__ar { font-family: var(--arabic); font-size: 22pt; font-weight: 700; color: var(--ink); line-height: 1.2; }
  .rc-rank__en { margin-top: .8mm; font-size: 8pt; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--blue); }
  .rc-rank__stars { margin-top: 1.2mm; font-size: 10pt; color: #B8860B; letter-spacing: .12em; }
  .rc-rank__stars small { font-size: 7pt; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin-left: 1.5mm; }
  .rc-promo { margin-top: calc(var(--u) * .8); text-align: left; font-size: 7.6pt; color: var(--muted); line-height: 1.5; }
  .rc-titles { margin: calc(var(--u) * .7) auto 0; max-width: 150mm; text-align: center; font-size: 7.4pt; line-height: 1.6; color: var(--body); }
  .rc-titles span { display: block; font-size: 6.2pt; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--blue); }
  /* ONE A4 SHEET, MEASURED: stacked, the score, the reasons and five rows of measures overran the
     stat band by ~34mm. The score now stands BESIDE the reasons and the measures run four across. */
  .rc-figure .figure__core { justify-content: space-evenly; padding: calc(var(--u) * .7) 0; }
  .rc-head { display: flex; align-items: center; gap: 8mm; width: 166mm; margin: 0 auto; text-align: left; }
  .rc-head__score { flex: 0 0 56mm; text-align: center; border-right: var(--hair-w) solid var(--hair); padding-right: 6mm; }
  .rc-head__score .figure__label { margin-bottom: calc(var(--u) * .6); letter-spacing: .3em; }
  .rc-score { display: flex; align-items: baseline; justify-content: center; gap: 2.5mm; }
  .rc-score__v { font-family: var(--display); font-weight: 700; font-size: 54pt; line-height: 1; color: var(--ink);
    letter-spacing: -.02em; font-variant-numeric: lining-nums tabular-nums; }
  .rc-score__of { white-space: nowrap; font-size: 11pt; font-weight: 700; color: var(--light); letter-spacing: .08em; }
  .rc-why { flex: 1 1 auto; min-width: 0; text-align: left; }
  .rc-why__h { font-size: 6.6pt; font-weight: 700; letter-spacing: .34em; text-transform: uppercase; color: var(--blue); }
  .rc-why ul { list-style: none; margin-top: 1.2mm; }
  .rc-why li { position: relative; padding-left: 4mm; font-size: 8.4pt; line-height: 1.45; color: var(--body); }
  .rc-why li::before { content: ""; position: absolute; left: 0; top: 1.9mm; width: 1.6mm; height: 1.6mm; background: var(--light); }
  .rc-grid { margin: calc(var(--u) * .9) auto 0; width: 166mm; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
    column-gap: 5mm; row-gap: 1.7mm; text-align: left; }
  .rc-m__row { display: flex; justify-content: space-between; gap: 2mm; align-items: baseline; }
  .rc-m__l { font-size: 7pt; font-weight: 600; color: var(--body); }
  .rc-m__v { font-family: var(--display); font-size: 9pt; font-weight: 700; color: var(--ink); font-variant-numeric: lining-nums tabular-nums; }
  .rc-m__track { margin-top: .8mm; height: 1.4pt; background: var(--rule); position: relative; }
  .rc-m__bar { position: absolute; left: 0; top: 0; bottom: 0; background: var(--deep); }
  .rc-m--bonus .rc-m__l, .rc-m--bonus .rc-m__v { color: var(--light); }
  .rc-m--bonus .rc-m__bar { background: var(--light); }
`;

/** The whole certificate, as HTML. Exported so a test can assert on it without Chromium. */
export function rankCertificateHtml(input: RankCertificateInput): string {
  const stars = input.stars > 0 ? `${"★".repeat(Math.min(input.stars, 5))}<small>${input.stars} ${input.stars === 1 ? "star" : "stars"}</small>` : "";
  const rolling =
    input.rollingScore === null
      ? "The rank follows the average of the last three ranked months."
      : `The rank follows the three-month average, ${input.rollingScore.toFixed(1)}. ${promotionSentence(input.rollingScore)}`;
  const body = `
    ${opener(`Phoenix Ranks · ${RANK_WINDOW_TABS[input.kind]} · ${input.windowLabel}`)}
    <p class="lead-in">This certificate recognises</p>

    <h1 class="name${input.repName.length > 26 ? " name--long" : ""}" dir="auto">${escapeHtml(input.repName)}</h1>
    <div class="signrule"></div>
    <p class="sentence">${escapeHtml(certificateSentence(input))}</p>

    <section class="rc-rank">
      ${portraitHtml(input)}
      <div class="rc-rank__body">
        <div class="rc-rank__top">
          <div class="rc-rank__badge">${insigniaSvg(input.rank.insignia, "34mm", `${input.rank.english} insignia`)}</div>
          <div class="rc-rank__names">
            <p class="rc-rank__ar" dir="rtl" lang="ar">${escapeHtml(input.rank.arabic)}</p>
            <p class="rc-rank__en">${escapeHtml(input.rank.english)}</p>
            ${stars ? `<p class="rc-rank__stars">${stars}</p>` : ""}
          </div>
        </div>
        <p class="rc-promo">${escapeHtml(rolling)}</p>
      </div>
    </section>
    ${titlesLine(input.titles)}

    <section class="figure rc-figure">
      <div class="figure__core">
        <div class="rc-head">
        <div class="rc-head__score">
          <p class="figure__label">Phoenix Ranks score</p>
          <p class="rc-score"><span class="rc-score__v">${input.total.toFixed(1)}</span><span class="rc-score__of">of 100</span></p>
        </div>
        <div class="rc-why">
          <p class="rc-why__h">Why this place</p>
          <ul>${certificateReasons(input).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
        </div>
        </div>
        ${measureGrid(input.pillars)}
      </div>
    </section>

    ${statBand([
      { value: `${input.total.toFixed(1)}<small> of 100</small>`, label: "Phoenix Ranks score" },
      { value: `${input.companyPosition}<small> of ${input.companyCount}</small>`, label: "Place in the company" },
      input.linePosition !== null
        ? { value: `${input.linePosition}<small> of ${input.lineCount}</small>`, label: `Place on the ${escapeHtml(input.lineName ?? "line")} line` }
        : { value: `${input.titles.length}`, label: "Titles held" },
    ])}`;

  const plinth = `Sato Pharma &middot; Phoenix Ranks &middot; ${escapeHtml(input.windowLabel)} &middot; Issued ${escapeHtml(input.issuedLabel)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Phoenix Ranks · ${escapeHtml(input.repName)}</title><style>${SHEET_CSS}${CERT_CSS}</style></head>
<body style="margin:0">${sheetShell(plinth, body, 1, 1)}</body></html>`;
}
