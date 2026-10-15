// Recruitment — the job-post pictures. Five looks, one set of fields.
//
// 🔒 THE FIVE LOOKS ARE THE OWNER'S APPROVED RENDERS, PORTED ONE TO ONE. He saw them on 2026-10-15 as
// PNGs (F:\Hiring Posts\2026-10-15 Job Post Templates\, built by build-templates.mjs there) and
// answered "build the job post module with all rendered templates". Executive is the v7 look he
// approved on 2026-10-06; Split, Editorial, Bold Blue and Night Blueprint are its four siblings. A
// change of colour, spacing or type here is a change to a design he signed off — fix defects, never
// restyle.
//
// 🔒 A TEMPLATE IS A LOOK, NEVER A SOURCE OF WORDS. Every word on a post comes from the job title's
// row (ats_job_post_titles) or the post's own choices (areas, line). Nothing here invents copy: no
// headline is printed when the title has none, no line is printed unless one was chosen.
//
// 🔴 PURE AND ISOMORPHIC. The builder runs in the browser for the live preview and in Chromium on the
// server for the download, so the two can never disagree. No Node import, no database, no React.
// Assets (the two Montserrat faces and the logo) arrive as URLs — data URIs in both places, because
// Chromium's setContent has no origin and the preview iframe is sandboxed without one.
//
// 🔴 EVERY USER STRING IS ESCAPED. Titles, duties and areas are typed by people; a "<" in a duty must
// print as a "<", and a <script> must print as text.
//
// 🔴 A WORD IS FITTED, NEVER CUT, AND NOTHING ENDS IN AN ELLIPSIS (house rule). The layout pass at the
// bottom shrinks a long title until it fits its box ("Representative" in Split's narrow column was the
// case that proved it), then steps the list type down until the page holds everything.
//
// 🔒 NOT ONE ROUNDED CORNER (AGENTS.md §4).

export type JobPostLine = { lead: string; rest: string };

/** Everything one picture prints. Built from a title row plus the choices made for this post. */
export type JobPostContent = {
  title: string;
  department: string;
  /** Up to two lines, split on a newline. Null prints no statement. */
  headline: string | null;
  reportsTo: string | null;
  employment: string;
  location: string;
  duties: JobPostLine[];
  needs: JobPostLine[];
  /** The areas this post is open in. One area means one rep — never a count. */
  areas: string[];
  /** CNS, Anti Infective or Pedia — printed only when the person chose to show it. */
  line: string | null;
  /** The wording after "choose" on the WhatsApp line. */
  menuName: string;
  /** Local form, e.g. 01159888247. */
  whatsapp: string;
  careers: string;
};

export type JobPostAssets = { fontRegular: string; fontBold: string; logo: string };

export const JOB_POST_TEMPLATE_KEYS = ["executive", "split", "editorial", "bold-blue", "night-blueprint"] as const;
export type JobPostTemplateKey = (typeof JOB_POST_TEMPLATE_KEYS)[number];

export const JOB_POST_TEMPLATES: ReadonlyArray<{ key: JobPostTemplateKey; name: string; description: string }> = [
  { key: "executive", name: "Executive", description: "Navy hero, floating key-facts card, blue apply band" },
  { key: "split", name: "Split", description: "Navy title column, duties and requirements beside it" },
  { key: "editorial", name: "Editorial", description: "White magazine page, numbered duties, checklist panel" },
  { key: "bold-blue", name: "Bold Blue", description: "The whole post in brand blue, white card, ink shadow" },
  { key: "night-blueprint", name: "Night Blueprint", description: "Dark page on a blueprint grid, light-blue glow" },
];

export function isJobPostTemplateKey(value: unknown): value is JobPostTemplateKey {
  return typeof value === "string" && (JOB_POST_TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** The careers page every post sends people to. */
export const JOB_POST_CAREERS = "satopharma.com/careers";
/** One post's picture size — the 4:5 portrait LinkedIn and Facebook show uncropped. */
export const JOB_POST_WIDTH = 1080;
export const JOB_POST_HEIGHT = 1350;
/** The most areas one post lists. Enough for a district; beyond it the picture stops reading. */
export const JOB_POST_MAX_AREAS = 12;

export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** 01159888247 → "011 5988 8247", the way every approved post prints it. Anything else passes through. */
export function formatPostNumber(raw: string): string {
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("01")) return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`;
  return String(raw).trim();
}

/**
 * The title over two lines: everything but the last word, then the last word. "Talent Acquisition /
 * Specialist", "Medical / Representative" — the split every approved render used. One word stays one line.
 */
export function titleLines(title: string): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return words;
  return [words.slice(0, -1).join(" "), words[words.length - 1]!];
}

function headlineLines(headline: string | null): string[] {
  if (!headline) return [];
  return headline.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).slice(0, 2);
}

/**
 * One line of a list: the bold lead, then the rest. A rest that opens with punctuation joins the lead
 * directly ("Own HR systems, workforce data…"); anything else gets a space ("Cairo-based / able…").
 */
export function lineHtml(line: JobPostLine): string {
  const lead = escapeHtml(line.lead.trim());
  const rest = line.rest.trim();
  if (!rest) return `<b>${lead}</b>`;
  const joiner = /^[,.;:)]/.test(rest) ? "" : " ";
  return `<b>${lead}</b>${joiner}${escapeHtml(rest)}`;
}

/** The same post narrowed to one area — the per-area picture. Names that area and no other. */
export function jobPostForArea(content: JobPostContent, area: string): JobPostContent {
  return { ...content, areas: [area] };
}

/** A filename-safe stem, e.g. "medical-representative-nasr-city". */
export function jobPostFileStem(content: Pick<JobPostContent, "title">, area?: string | null): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const base = slug(content.title) || "job-post";
  return area ? `${base}-${slug(area) || "area"}` : base;
}

type Fact = [label: string, value: string];

/** The key facts, in the approved order. Location reads the area when the post names exactly one. */
function facts(content: JobPostContent): Fact[] {
  const out: Fact[] = [];
  if (content.reportsTo) out.push(["Reports to", content.reportsTo]);
  out.push(["Department", content.department]);
  if (content.line) out.push(["Line", content.line]);
  out.push(["Employment", content.employment]);
  const n = content.areas.length;
  out.push(["Location", n === 1 ? content.areas[0]! : n > 1 ? `${n} areas` : content.location]);
  return out;
}

/* ───────────── shared pieces ───────────── */

const BASE_CSS = `
  @page { size: ${JOB_POST_WIDTH}px ${JOB_POST_HEIGHT}px; margin: 0; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  :root { --ink:#111820; --navy:#14273e; --blue:#0879b8; --blue-deep:#066aa3; --blue-light:#5db7e8;
          --body:#45515a; --soft:#69757e; --faint:#8f9aa2; --line:#dfe5e9; --paper:#f6f8fa; --k: 1; }
  * { box-sizing: border-box; margin: 0; padding: 0; border-radius: 0 !important; }
  html, body { width: ${JOB_POST_WIDTH}px; height: ${JOB_POST_HEIGHT}px; overflow: hidden; background: #fff; }
  body { font-family: "Montserrat", Arial, sans-serif; color: var(--body); -webkit-font-smoothing: antialiased; font-feature-settings: "kern" 1, "tnum" 1; }
  .page { position: relative; width: ${JOB_POST_WIDTH}px; height: ${JOB_POST_HEIGHT}px; display: flex; flex-direction: column; overflow: hidden; }
  ul, ol { list-style: none; }
  li p b { font-weight: 700; }
  .fit { min-height: 0; overflow: hidden; }
  .tick { position: absolute; width: 36px; height: 36px; z-index: 20; }
  .tick.tl { top: 8px; left: 8px; border-top: 3px solid var(--blue); border-left: 3px solid var(--blue); }
  .tick.tr { top: 8px; right: 8px; border-top: 3px solid var(--blue); border-right: 3px solid var(--blue); }
  .tick.bl { bottom: 8px; left: 8px; border-bottom: 3px solid var(--blue-light); border-left: 3px solid var(--blue-light); }
  .tick.br { bottom: 8px; right: 8px; border-bottom: 3px solid var(--blue-light); border-right: 3px solid var(--blue-light); }
  .frame::before { content: ""; position: absolute; inset: 10px; border: 1px solid rgba(93,183,232,.6); pointer-events: none; z-index: 19; }
  .frame::after { content: ""; position: absolute; inset: 15px; border: 1px solid rgba(93,183,232,.26); pointer-events: none; z-index: 19; }
  .areas { display: flex; align-items: center; gap: 22px; padding: 15px 20px; border: 1px solid #bcd9ea; background: #f3f9fd; flex-shrink: 0; }
  .areas .ak { display: flex; align-items: center; gap: 10px; flex-shrink: 0; font-size: 11px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--blue); }
  .areas .ak s { display: block; width: 8px; height: 8px; background: var(--blue); }
  .areas .al { display: flex; flex-wrap: wrap; gap: 10px; }
  .areas .al span { display: inline-flex; align-items: center; gap: 10px; padding: 9px 15px; background: #fff; box-shadow: inset 0 0 0 1.5px var(--blue); font-size: 16.5px; font-weight: 700; color: var(--ink); }
  .areas .al span i { display: block; width: 7px; height: 7px; background: var(--blue); }
  .areas.dark { border-color: rgba(93,183,232,.45); background: rgba(8,121,184,.14); }
  .areas.dark .ak { color: var(--blue-light); } .areas.dark .ak s, .areas.dark .al span i { background: var(--blue-light); }
  .areas.dark .al span { background: rgba(17,24,32,.55); color: #fff; box-shadow: inset 0 0 0 1px rgba(93,183,232,.7); }
  .areas.ink { border: 0; background: var(--ink); }
  .areas.ink .ak { color: var(--blue-light); } .areas.ink .ak s, .areas.ink .al span i { background: var(--blue-light); }
  .areas.ink .al span { background: transparent; color: #fff; box-shadow: inset 0 0 0 1px rgba(93,183,232,.7); }
  .areas.stack { flex-direction: column; align-items: stretch; gap: 12px; padding: 0; border: 0; background: none; margin-top: 26px; }
  .areas.stack .al { flex-direction: column; gap: 8px; }
  .areas.stack .al span { background: rgba(255,255,255,.06); color: #fff; box-shadow: inset 0 0 0 1px rgba(93,183,232,.55); }
  .areas.stack .ak { color: var(--blue-light); } .areas.stack .ak s, .areas.stack .al span i { background: var(--blue-light); }`;

const FOOT_CSS = `
  .foot { position: relative; height: 84px; flex-shrink: 0; background: var(--ink); display: flex; align-items: center; justify-content: space-between; padding: 0 72px; }
  .foot::before { content: ""; position: absolute; left: 72px; right: 72px; top: 0; height: 1px; background: linear-gradient(90deg, rgba(93,183,232,0), rgba(93,183,232,.5) 50%, rgba(93,183,232,0)); }
  .foot .brand { display: flex; align-items: center; gap: 13px; }
  .foot .brand s { display: block; width: 9px; height: 9px; background: var(--blue); }
  .foot .brand span { font-weight: 700; color: #fff; letter-spacing: .3em; text-transform: uppercase; font-size: 13.5px; }
  .foot .ff { display: flex; align-items: center; }
  .foot .fi { display: flex; flex-direction: column; gap: 6px; text-align: right; padding: 0 26px; }
  .foot .fi:last-child { padding-right: 0; }
  .foot .fi + .fi { border-left: 1px solid rgba(255,255,255,.15); }
  .foot .k { font-size: 9.5px; font-weight: 700; letter-spacing: .28em; text-transform: uppercase; color: var(--faint); }
  .foot .val { font-size: 13.5px; color: rgba(255,255,255,.84); letter-spacing: .02em; }`;

const TICKS = `<div class="tick tl"></div><div class="tick tr"></div><div class="tick bl"></div><div class="tick br"></div>`;

const FOOT = `<footer class="foot"><div class="brand"><s></s><span>Sato Pharma</span></div><div class="ff">
  <div class="fi"><span class="val">www.satopharma.com</span></div>
  <div class="fi"><span class="k">Head Office</span><span class="val">Sheraton, Cairo, Egypt</span></div></div></footer>`;

function blocksCss(size = 30, gap = 8, line = "rgba(255,255,255,.2)"): string {
  return `
  .blocks { display: grid; grid-template-columns: repeat(4, ${size}px); grid-auto-rows: ${size}px; gap: ${gap}px; }
  .blocks u { display: block; }
  .blocks .o { box-shadow: inset 0 0 0 1px ${line}; }
  .blocks .b { background: var(--blue); box-shadow: inset 0 0 0 1px rgba(93,183,232,.75), 0 10px 20px -10px rgba(8,121,184,.9); }`;
}

/** The building-blocks motif: one blue block on the crest (or two), the rest outlined steps. */
function blocks(blue: number[] = [3]): string {
  const map = ["", "", "", "", "", "", "o", "o", "", "o", "o", "o", "o", "o", "o", "o"];
  return `<div class="blocks" aria-hidden="true">${map.map((c, i) => `<u class="${blue.includes(i) ? "b" : c}"></u>`).join("")}</div>`;
}

/** The smallest the list text may shrink to (as a share of its normal size) before a post is too long. */
export const JOB_POST_TEXT_FLOOR = 0.6;
/** The smallest a title may shrink to, in px, before it is too long for its box. */
export const JOB_POST_TITLE_FLOOR_PX = 24;

/**
 * The layout pass, run in the page once Montserrat has loaded (an unloaded face measures at the
 * fallback's metrics). It exposes its promise as window.__jobPostFit so the server can wait for it
 * and refuse to print a picture it did not run on.
 *   1. Every title shrinks until it fits its box.
 *   2. While the page or any .fit region overflows, the list scale --k steps down.
 * The report says what it cost: `k` is the text size as a share of normal, and `limited` is true
 * when the shrinking ran out — a title at its floor and still too wide, the text at its floor, or
 * anything still overflowing — so the picture is clipped or too small to read. The server refuses to
 * draw a limited post; the preview shows the same verdict (posted to the parent page, the only way
 * out of its sandboxed frame).
 */
const FIT_SCRIPT = `<script>
window.__jobPostFit = (async () => {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const report = { titles: 0, k: 1, limited: false };
  document.querySelectorAll("h1").forEach((el) => {
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth + 1 && size > ${JOB_POST_TITLE_FLOOR_PX}) { size -= 1; el.style.fontSize = size + "px"; }
    if (el.scrollWidth > el.clientWidth + 1) report.limited = true;
    report.titles += 1;
  });
  const page = document.querySelector(".page");
  const regions = Array.from(document.querySelectorAll(".fit"));
  const overflowing = () => (page && page.scrollHeight > page.clientHeight + 1) || regions.some((el) => el.scrollHeight > el.clientHeight + 1);
  let k = 1;
  while (overflowing() && k > ${JOB_POST_TEXT_FLOOR}) { k = Math.round((k - 0.03) * 100) / 100; document.documentElement.style.setProperty("--k", String(k)); }
  report.k = k;
  if (k <= ${JOB_POST_TEXT_FLOOR} || overflowing()) report.limited = true;
  try { if (window.parent !== window) window.parent.postMessage({ jobPostFit: report }, "*"); } catch (e) {}
  return report;
})();
</script>`;

function doc(name: string, assets: JobPostAssets, css: string, body: string): string {
  const fonts = `
  @font-face { font-family: "Montserrat"; src: url("${assets.fontRegular}") format("truetype"); font-weight: 400; font-display: block; }
  @font-face { font-family: "Montserrat"; src: url("${assets.fontBold}") format("truetype"); font-weight: 700; font-display: block; }`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sato Pharma - ${escapeHtml(name)}</title>
<style>${fonts}${BASE_CSS}${css}</style></head><body>${body}
${FIT_SCRIPT}</body></html>`;
}

/* ───────────── the five looks ───────────── */

type Parts = {
  c: JobPostContent;
  a: JobPostAssets;
  t: string[];
  h: string[];
  f: Fact[];
  duties: string;
  needs: string;
  areas: (cls?: string, style?: string) => string;
  applySub: string;
  num: string;
};

function parts(c: JobPostContent, a: JobPostAssets): Parts {
  const li = (items: JobPostLine[]) => items.map((line) => `<li><s></s><p>${lineHtml(line)}</p></li>`).join("");
  const n = c.areas.length;
  // A one-area picture carries its area in the Location fact; the list block is for two or more.
  const areas = (cls = "", style = "") =>
    n > 1
      ? `<div class="areas ${cls}" style="${style}"><div class="ak"><s></s>Open in ${n} areas</div><div class="al">${c.areas
          .map((area) => `<span><i></i>${escapeHtml(area)}</span>`)
          .join("")}</div></div>`
      : "";
  const applySub = `Send your CV on WhatsApp and choose <b>${escapeHtml(c.menuName)}</b>${n > 1 ? " and your area" : ""} &mdash; or apply at <b>${escapeHtml(c.careers)}</b>`;
  return {
    c,
    a,
    t: titleLines(c.title).map(escapeHtml),
    h: headlineLines(c.headline).map(escapeHtml),
    f: facts(c).map(([k, v]) => [escapeHtml(k), escapeHtml(v)] as Fact),
    duties: li(c.duties),
    needs: li(c.needs),
    areas,
    applySub,
    num: escapeHtml(formatPostNumber(c.whatsapp)),
  };
}

function executive(p: Parts): string {
  const cols = p.f.length;
  const hero = p.h.length
    ? `<h1><span class="l1">${p.h[0]}</span>${p.h[1] ? `<span class="l2">${p.h[1]}</span>` : ""}</h1><div class="statement"><i></i>${p.t.join(" ")}</div>`
    : `<h1>${p.t.length > 1 ? `<span class="l1">${p.t[0]}</span><span class="l2">${p.t[1]}</span>` : `<span class="l2">${p.t[0] ?? ""}</span>`}</h1>`;
  return doc(`${p.c.title} - Executive`, p.a, `
  .page { background: #fff; }
  .rail { position: absolute; top: 0; bottom: 0; left: 44px; width: 1px; background: var(--line); z-index: 0; }
  .rail.right { left: auto; right: 44px; }
  .hero .rail, .apply .rail { background: rgba(255,255,255,.12); z-index: 1; }
  .mast { position: relative; height: 88px; flex-shrink: 0; padding: 0 116px; display: flex; justify-content: space-between; align-items: center; }
  .mast img { height: 44px; }
  .micro { font-size: 12.5px; font-weight: 700; letter-spacing: .24em; text-transform: uppercase; color: var(--soft); text-align: right; }
  .city { font-size: 20px; font-weight: 700; color: var(--ink); margin-top: 5px; text-align: right; }
  .seam { height: 3px; flex-shrink: 0; background: var(--blue); }
  .hero { position: relative; height: 352px; flex-shrink: 0; overflow: hidden;
          background: radial-gradient(ellipse 700px 400px at 18% 30%, rgba(8,121,184,.2), rgba(8,121,184,0) 70%),
                      linear-gradient(180deg, #1a3555 0%, var(--navy) 50%, var(--ink) 100%); }
  .hero .copy { position: relative; z-index: 2; padding: 38px 0 0 116px; max-width: 800px; }
  .badge { display: flex; align-items: center; gap: 16px; }
  .badge b { display: inline-flex; align-items: center; gap: 11px; background: var(--blue); color: #fff; font-size: 13.5px; letter-spacing: .32em; text-transform: uppercase; padding: 10px 13px 10px 16px; box-shadow: inset 0 0 0 1px rgba(93,183,232,.6); }
  .badge b s { display: block; width: 7px; height: 7px; background: #fff; }
  .badge i { display: block; width: 36px; border-top: 1px solid rgba(93,183,232,.6); }
  .badge span { font-size: 12.5px; font-weight: 700; letter-spacing: .34em; text-transform: uppercase; color: var(--blue-light); }
  h1 { margin-top: 24px; font-size: 58px; line-height: 1.06; letter-spacing: -.027em; }
  h1 .l1 { display: block; font-weight: 400; color: rgba(255,255,255,.92); white-space: nowrap; }
  h1 .l2 { display: block; font-weight: 700; color: #fff; white-space: nowrap; }
  .statement { margin-top: 22px; display: flex; gap: 16px; font-size: 32px; font-weight: 700; line-height: 1.15; color: #fff; }
  .statement i { display: block; flex: 0 0 5px; background: var(--blue-light); }
  ${blocksCss()}
  .hero .blocks { position: absolute; right: 116px; top: 56px; z-index: 1; }
  .keys { position: relative; z-index: 5; margin: -46px 84px 0; flex-shrink: 0; background: #fff; display: grid; grid-template-columns: repeat(${cols}, 1fr); padding: 22px 12px 20px; border-top: 3px solid var(--blue); box-shadow: 0 22px 44px -26px rgba(17,24,32,.55), 0 0 0 1px rgba(17,24,32,.06); }
  .keys::after { content: ""; position: absolute; inset: 6px; border: 1px solid #e4ebef; pointer-events: none; }
  .key { position: relative; text-align: center; padding: 0 8px; }
  .key + .key::before { content: ""; position: absolute; left: 0; top: 2px; bottom: 2px; width: 1px; background: var(--line); }
  .key .k { font-size: 9.5px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--faint); }
  .key .v { margin-top: 9px; font-size: ${cols > 4 ? 16 : 18}px; font-weight: 700; color: var(--ink); line-height: 1.25; }
  .key:first-child .v { color: var(--blue); }
  .body { position: relative; flex: 1; padding: 28px 116px 0; display: flex; flex-direction: column; }
  .cols { flex: 1; display: grid; grid-template-columns: 1fr 1px 1fr; grid-template-rows: auto auto; align-content: center; column-gap: 26px; row-gap: 16px; }
  .cols .sep { grid-column: 2; grid-row: 1 / 3; background: var(--line); }
  .lbl { display: flex; align-items: center; gap: 10px; font-size: 10.5px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--blue); }
  .lbl::after { content: ""; flex: 0 0 28px; height: 1px; background: #bcd9ea; }
  .lbl.n { color: var(--ink); grid-column: 3; grid-row: 1; }
  ul.d { grid-column: 1; grid-row: 2; } ul.n { grid-column: 3; grid-row: 2; }
  .cols ul { display: flex; flex-direction: column; gap: calc(var(--k) * 21px); }
  .cols li { display: flex; align-items: baseline; gap: 12px; font-size: calc(var(--k) * 18.5px); line-height: 1.42; }
  .cols li b { color: var(--ink); }
  .cols li s { flex: 0 0 7px; height: 7px; background: var(--blue); transform: translateY(-2px); }
  ul.n li s { background: transparent; box-shadow: inset 0 0 0 1.5px var(--blue); }
  .apply { position: relative; height: 150px; flex-shrink: 0; color: #fff; overflow: hidden; margin-top: 28px;
           background: linear-gradient(180deg, #0a82c2 0%, var(--blue) 55%, var(--blue-deep) 100%);
           display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .apply > *:not(.rail) { position: relative; z-index: 2; }
  .apply .eb { display: flex; align-items: center; gap: 18px; font-size: 11.5px; font-weight: 700; letter-spacing: .42em; text-transform: uppercase; color: rgba(255,255,255,.85); }
  .apply .eb i { display: block; width: 36px; border-top: 1px solid rgba(255,255,255,.5); }
  .apply .row { margin-top: 10px; display: flex; align-items: center; gap: 30px; }
  .apply .big { font-size: 33px; color: rgba(255,255,255,.92); }
  .apply .div { width: 1px; height: 44px; background: rgba(255,255,255,.35); }
  .apply .num { font-size: 46px; font-weight: 700; white-space: nowrap; }
  .apply .sub { margin-top: 9px; padding: 0 60px; font-size: 14.5px; color: rgba(255,255,255,.84); }
  .apply .sub b { color: #fff; }
  ${FOOT_CSS}`, `
<div class="page frame">${TICKS}
  <div class="rail"></div><div class="rail right"></div>
  <header class="mast"><img src="${p.a.logo}" alt="Sato Pharma"><div><div class="micro">Careers</div><div class="city">Cairo, Egypt</div></div></header>
  <div class="seam"></div>
  <section class="hero"><div class="rail"></div><div class="rail right"></div>${blocks()}
    <div class="copy">
      <div class="badge"><b><s></s>We are hiring</b><i></i><span>${escapeHtml(p.c.department)}</span></div>
      ${hero}
    </div>
  </section>
  <section class="keys">${p.f.map(([k, v]) => `<div class="key"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</section>
  <section class="body fit">${p.areas("", "margin-bottom: 4px")}<div class="cols"><i class="sep"></i>
    <div class="lbl">What you will do</div><ul class="d">${p.duties}</ul>
    <div class="lbl n">What you need</div><ul class="n">${p.needs}</ul>
  </div></section>
  <section class="apply"><div class="rail"></div><div class="rail right"></div>
    <div class="eb"><i></i>Join Sato Pharma<i></i></div>
    <div class="row"><div class="big">Ready to apply?</div><div class="div"></div><div class="num">${p.num}</div></div>
    <div class="sub">${p.applySub}</div>
  </section>
  ${FOOT}
</div>`);
}

function split(p: Parts): string {
  const side = p.f.filter(([k]) => k !== "Department" && !(p.c.areas.length > 1 && k === "Location"));
  return doc(`${p.c.title} - Split`, p.a, `
  .mast { height: 96px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 72px; border-bottom: 3px solid var(--blue); }
  .mast img { height: 46px; }
  .mast .tag { display: flex; align-items: center; gap: 12px; font-size: 12px; font-weight: 700; letter-spacing: .32em; text-transform: uppercase; color: var(--ink); }
  .mast .tag s { display: block; width: 8px; height: 8px; background: var(--blue); }
  .main { flex: 1; min-height: 0; display: grid; grid-template-columns: 404px 1fr; }
  .side { position: relative; overflow: hidden; color: #fff; padding: 52px 44px 44px 72px; display: flex; flex-direction: column; min-height: 0;
          background: radial-gradient(ellipse 420px 360px at 20% 18%, rgba(8,121,184,.32), rgba(8,121,184,0) 70%),
                      linear-gradient(180deg, #1a3555 0%, var(--navy) 55%, var(--ink) 100%); }
  .side::after { content: ""; position: absolute; top: 0; bottom: 0; right: 0; width: 4px; background: linear-gradient(180deg, var(--blue-light), var(--blue)); }
  .hire { display: inline-flex; align-self: flex-start; align-items: center; gap: 10px; background: var(--blue); padding: 9px 14px; font-size: 12.5px; font-weight: 700; letter-spacing: .32em; text-transform: uppercase; box-shadow: inset 0 0 0 1px rgba(93,183,232,.6); }
  .hire s { display: block; width: 7px; height: 7px; background: #fff; }
  .dept { margin-top: 30px; font-size: 12px; font-weight: 700; letter-spacing: .34em; text-transform: uppercase; color: var(--blue-light); }
  h1 { margin-top: 14px; font-size: 50px; line-height: 1.04; letter-spacing: -.03em; font-weight: 700; overflow: hidden; }
  h1 span { display: block; }
  h1 span + span { color: var(--blue-light); }
  .rule { margin-top: 26px; width: 64px; height: 3px; flex-shrink: 0; background: var(--blue-light); }
  .facts { margin-top: 30px; display: flex; flex-direction: column; }
  .fact { padding: 15px 0; border-top: 1px solid rgba(255,255,255,.14); }
  .fact:last-child { border-bottom: 1px solid rgba(255,255,255,.14); }
  .fact .k { font-size: 9.5px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: rgba(255,255,255,.55); }
  .fact .v { margin-top: 6px; font-size: 19px; font-weight: 700; }
  ${blocksCss(26, 7)}
  .side .blocks { margin-top: auto; padding-top: 24px; }
  .content { position: relative; padding: 50px 72px 40px 56px; display: flex; flex-direction: column; justify-content: center; gap: calc(var(--k) * 56px); }
  .content::before { content: ""; position: absolute; inset: 22px; border: 1px solid #edf1f4; pointer-events: none; }
  .grp { position: relative; }
  .lbl { display: flex; align-items: center; gap: 14px; font-size: 12px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--blue); padding-bottom: 14px; border-bottom: 1px solid var(--line); }
  .lbl em { font-style: normal; font-size: 26px; letter-spacing: -.02em; color: var(--ink); }
  .grp ul { margin-top: 22px; display: flex; flex-direction: column; gap: calc(var(--k) * 19px); }
  .grp li { display: flex; align-items: baseline; gap: 14px; font-size: calc(var(--k) * 19px); line-height: 1.42; }
  .grp li b { color: var(--ink); }
  .grp li s { flex: 0 0 8px; height: 8px; background: var(--blue); transform: translateY(-2px); }
  .grp.n li s { background: transparent; box-shadow: inset 0 0 0 1.5px var(--blue); }
  .apply { flex-shrink: 0; height: 132px; display: grid; grid-template-columns: 404px 1fr; }
  .apply .l { background: var(--ink); color: #fff; padding: 0 44px 0 72px; display: flex; flex-direction: column; justify-content: center; }
  .apply .l .k { font-size: 11px; font-weight: 700; letter-spacing: .36em; text-transform: uppercase; color: var(--blue-light); }
  .apply .l .v { margin-top: 8px; font-size: 30px; }
  .apply .r { background: linear-gradient(180deg, #0a82c2 0%, var(--blue) 55%, var(--blue-deep) 100%); color: #fff; padding: 0 72px 0 56px; display: flex; flex-direction: column; justify-content: center; }
  .apply .num { font-size: 50px; font-weight: 700; letter-spacing: -.01em; line-height: 1; }
  .apply .sub { margin-top: 12px; font-size: 14px; color: rgba(255,255,255,.86); }
  .apply .sub b { color: #fff; }
  ${FOOT_CSS}`, `
<div class="page frame">${TICKS}
  <header class="mast"><img src="${p.a.logo}" alt="Sato Pharma"><span class="tag"><s></s>Careers &middot; Cairo, Egypt</span></header>
  <div class="main">
    <aside class="side fit">
      <span class="hire"><s></s>We are hiring</span>
      <div class="dept">${escapeHtml(p.c.department)}</div>
      <h1>${p.t.map((t) => `<span>${t}</span>`).join("")}</h1>
      <div class="rule"></div>
      <div class="facts">${side.map(([k, v]) => `<div class="fact"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div>
      ${p.areas("stack")}
      ${blocks([3])}
    </aside>
    <section class="content fit">
      <div class="grp d"><div class="lbl"><em>01</em>What you will do</div><ul>${p.duties}</ul></div>
      <div class="grp n"><div class="lbl"><em>02</em>What you need</div><ul>${p.needs}</ul></div>
    </section>
  </div>
  <section class="apply">
    <div class="l"><div class="k">Join Sato Pharma</div><div class="v">Ready to apply?</div></div>
    <div class="r"><div class="num">${p.num}</div><div class="sub">${p.applySub}</div></div>
  </section>
  ${FOOT}
</div>`);
}

function editorial(p: Parts): string {
  const side = p.f.filter(([k]) => k !== "Department");
  const lede = p.h.length ? `<p class="lede"><b>${p.h[0]}</b>${p.h[1] ? ` ${p.h[1]}` : ""}</p>` : "";
  const numbered = p.c.duties
    .map((line, i) => `<li><em>${String(i + 1).padStart(2, "0")}</em><p>${lineHtml(line)}</p></li>`)
    .join("");
  return doc(`${p.c.title} - Editorial`, p.a, `
  .page { background: #fff; }
  .mast { height: 104px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 84px; }
  .mast img { height: 46px; }
  .mast .issue { text-align: right; }
  .mast .issue .k { font-size: 11px; font-weight: 700; letter-spacing: .34em; text-transform: uppercase; color: var(--faint); }
  .mast .issue .v { margin-top: 5px; font-size: 15px; font-weight: 700; color: var(--ink); letter-spacing: .04em; }
  .dbl { flex-shrink: 0; margin: 0 84px; height: 7px; border-top: 3px solid var(--ink); border-bottom: 1px solid var(--ink); }
  .head { flex-shrink: 0; padding: 34px 84px 0; display: grid; grid-template-columns: minmax(0, 1fr) 230px; column-gap: 40px; }
  .eyebrow { display: flex; align-items: center; gap: 14px; font-size: 13px; font-weight: 700; letter-spacing: .34em; text-transform: uppercase; color: var(--blue); }
  .eyebrow i { display: block; width: 44px; height: 3px; background: var(--blue); }
  h1 { margin-top: 18px; font-size: 76px; line-height: .98; letter-spacing: -.045em; font-weight: 700; color: var(--ink); }
  h1 span { display: block; }
  h1 span + span { color: var(--blue); }
  .lede { margin-top: 20px; font-size: 22px; line-height: 1.35; color: var(--soft); }
  .lede b { color: var(--ink); }
  .facts { border-left: 1px solid var(--line); padding-left: 26px; align-self: end; display: flex; flex-direction: column; gap: 16px; padding-bottom: 6px; }
  .facts .k { font-size: 9.5px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--faint); }
  .facts .v { margin-top: 4px; font-size: 17px; font-weight: 700; color: var(--ink); }
  .facts div:first-child .v { color: var(--blue); }
  .thin { flex-shrink: 0; margin: 30px 84px 0; height: 1px; background: var(--line); }
  .duties { flex-shrink: 0; padding: 26px 84px 0; }
  .sec { display: flex; align-items: baseline; justify-content: space-between; font-size: 12px; font-weight: 700; letter-spacing: .32em; text-transform: uppercase; color: var(--ink); }
  .sec span { color: var(--faint); font-size: 10.5px; }
  .duties ol { margin-top: 16px; display: grid; grid-template-columns: 1fr 1fr; column-gap: 44px; row-gap: calc(var(--k) * 16px); }
  .duties li { display: grid; grid-template-columns: 50px 1fr; align-items: baseline; font-size: calc(var(--k) * 16.5px); line-height: 1.42; padding-top: 12px; border-top: 1px solid var(--line); }
  .duties li em { font-style: normal; font-size: 28px; font-weight: 700; letter-spacing: -.03em; color: var(--blue); line-height: 1; }
  .duties li b { color: var(--ink); }
  .needs { flex: 1; margin: 30px 84px 0; padding: 26px 34px; background: var(--paper); border-left: 4px solid var(--blue); display: flex; flex-direction: column; justify-content: center; }
  .needs ul { margin-top: 16px; display: grid; grid-template-columns: 1fr 1fr; column-gap: 36px; row-gap: calc(var(--k) * 13px); }
  .needs li { display: flex; align-items: baseline; gap: 12px; font-size: calc(var(--k) * 15.5px); line-height: 1.4; }
  .needs li b { color: var(--ink); }
  .needs li s { flex: 0 0 13px; height: 13px; transform: translateY(1px); box-shadow: inset 0 0 0 1.5px var(--blue); position: relative; }
  .needs li s::after { content: ""; position: absolute; left: 4px; top: 1px; width: 3px; height: 7px; border-right: 2px solid var(--blue); border-bottom: 2px solid var(--blue); transform: rotate(45deg); }
  .apply { flex-shrink: 0; margin: 28px 84px 30px; display: grid; grid-template-columns: auto 1fr; align-items: center; column-gap: 34px; padding: 22px 0; border-top: 3px solid var(--ink); border-bottom: 1px solid var(--ink); }
  .apply .num { font-size: 54px; font-weight: 700; letter-spacing: -.02em; color: var(--blue); line-height: 1; white-space: nowrap; }
  .apply .k { font-size: 11px; font-weight: 700; letter-spacing: .34em; text-transform: uppercase; color: var(--ink); }
  .apply .sub { margin-top: 7px; font-size: 14.5px; line-height: 1.45; color: var(--soft); }
  .apply .sub b { color: var(--ink); }
  ${FOOT_CSS}`, `
<div class="page frame">${TICKS}
  <header class="mast"><img src="${p.a.logo}" alt="Sato Pharma"><div class="issue"><div class="k">Careers</div><div class="v">${escapeHtml(p.c.department)} &middot; Cairo</div></div></header>
  <div class="dbl"></div>
  <section class="head">
    <div>
      <div class="eyebrow"><i></i>We are hiring</div>
      <h1>${p.t.map((t) => `<span>${t}</span>`).join("")}</h1>
      ${lede}
    </div>
    <div class="facts">${side.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div>
  </section>
  <div class="thin"></div>
  ${p.areas("", "margin: 24px 84px 0")}
  <section class="duties"><div class="sec">What you will do <span>The role</span></div><ol>${numbered}</ol></section>
  <section class="needs fit"><div class="sec">What you need <span>The person</span></div><ul>${p.needs}</ul></section>
  <section class="apply"><div class="num">${p.num}</div><div><div class="k">Ready to apply?</div><div class="sub">${p.applySub}</div></div></section>
  ${FOOT}
</div>`);
}

function boldBlue(p: Parts): string {
  const chips = p.f
    .filter(([k]) => k !== "Department")
    .map(([k, v]) => `<span><s></s>${k === "Reports to" ? "Reports to " : ""}${v}</span>`)
    .join("");
  return doc(`${p.c.title} - Bold Blue`, p.a, `
  .page { background: radial-gradient(ellipse 900px 600px at 15% 10%, #1a95d6 0%, rgba(26,149,214,0) 60%), linear-gradient(180deg, #0a82c2 0%, var(--blue) 45%, var(--blue-deep) 100%); color: #fff; }
  .page::before { content: ""; position: absolute; inset: 10px; border: 1px solid rgba(255,255,255,.55); z-index: 19; }
  .page::after { content: ""; position: absolute; inset: 15px; border: 1px solid rgba(255,255,255,.22); z-index: 19; }
  .tick.tl, .tick.tr { border-color: #fff; } .tick.bl, .tick.br { border-color: var(--blue-light); }
  .ghost { position: absolute; left: 40px; top: 150px; font-size: 250px; font-weight: 700; letter-spacing: -.04em; line-height: 1; color: transparent; -webkit-text-stroke: 1.5px rgba(255,255,255,.11); white-space: nowrap; z-index: 0; }
  .mast { position: relative; z-index: 2; height: 96px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 72px; }
  .plate { background: #fff; padding: 11px 18px; box-shadow: 0 14px 28px -16px rgba(17,24,32,.6); }
  .plate img { display: block; height: 38px; }
  .mast .tag { font-size: 12.5px; font-weight: 700; letter-spacing: .32em; text-transform: uppercase; color: rgba(255,255,255,.9); }
  .hero { position: relative; z-index: 2; flex-shrink: 0; padding: 40px 72px 0; }
  .hire { display: inline-flex; align-items: center; gap: 12px; background: var(--ink); padding: 11px 16px; font-size: 14px; font-weight: 700; letter-spacing: .34em; text-transform: uppercase; }
  .hire s { display: block; width: 8px; height: 8px; background: var(--blue-light); }
  h1 { margin-top: 22px; font-size: 80px; line-height: .98; letter-spacing: -.045em; font-weight: 700; }
  h1 span { display: block; }
  h1 span + span { color: var(--ink); }
  .chips { margin-top: 26px; display: flex; flex-wrap: wrap; gap: 10px; }
  .chips span { display: inline-flex; align-items: center; gap: 10px; padding: 9px 14px; font-size: 14.5px; font-weight: 700; box-shadow: inset 0 0 0 1px rgba(255,255,255,.45); }
  .chips span s { display: block; width: 6px; height: 6px; background: var(--blue-light); }
  .card { position: relative; z-index: 2; flex: 1; margin: 34px 56px 0; background: #fff; color: var(--body); padding: 30px 36px; display: grid; grid-template-columns: 1fr 1px 1fr; column-gap: 28px; align-content: center;
          box-shadow: 14px 14px 0 var(--ink); overflow: visible; }
  .card .sep { background: var(--line); }
  .lbl { display: flex; align-items: center; gap: 10px; font-size: 11px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--blue); padding-bottom: 12px; border-bottom: 2px solid var(--blue); }
  .n .lbl { color: var(--ink); border-color: var(--ink); }
  .card ul { margin-top: 20px; display: flex; flex-direction: column; gap: calc(var(--k) * 20px); }
  .card li { display: flex; align-items: baseline; gap: 11px; font-size: calc(var(--k) * 17.5px); line-height: 1.42; }
  .card li b { color: var(--ink); }
  .card li s { flex: 0 0 7px; height: 7px; background: var(--blue); transform: translateY(-2px); }
  .n li s { background: var(--ink); }
  .apply { position: relative; z-index: 2; flex-shrink: 0; margin: 44px 0 0; height: 140px; background: var(--ink); display: flex; align-items: center; justify-content: space-between; gap: 40px; padding: 0 72px; }
  .apply .k { font-size: 11.5px; font-weight: 700; letter-spacing: .36em; text-transform: uppercase; color: var(--blue-light); }
  .apply .num { margin-top: 8px; font-size: 52px; font-weight: 700; letter-spacing: -.01em; line-height: 1; white-space: nowrap; }
  .apply .sub { max-width: 400px; font-size: 14.5px; line-height: 1.5; color: rgba(255,255,255,.78); text-align: right; }
  .apply .sub b { color: #fff; }
  .foot { position: relative; z-index: 2; height: 70px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 72px; border-top: 1px solid rgba(93,183,232,.35); background: #0b121a; }
  .foot b { font-size: 13px; letter-spacing: .3em; text-transform: uppercase; }
  .foot span { font-size: 13.5px; color: rgba(255,255,255,.75); }`, `
<div class="page">${TICKS}
  <div class="ghost" aria-hidden="true">HIRING</div>
  <header class="mast"><div class="plate"><img src="${p.a.logo}" alt="Sato Pharma"></div><span class="tag">Careers &middot; ${escapeHtml(p.c.department)}</span></header>
  <section class="hero">
    <span class="hire"><s></s>We are hiring</span>
    <h1>${p.t.map((t) => `<span>${t}</span>`).join("")}</h1>
    <div class="chips">${chips}</div>
  </section>
  ${p.areas("ink", "margin: 30px 56px 0; position: relative; z-index: 2")}
  <section class="card fit"><div class="d"><div class="lbl">What you will do</div><ul>${p.duties}</ul></div><i class="sep"></i><div class="n"><div class="lbl">What you need</div><ul>${p.needs}</ul></div></section>
  <section class="apply"><div><div class="k">Ready to apply? WhatsApp</div><div class="num">${p.num}</div></div><div class="sub">${p.applySub}</div></section>
  <footer class="foot"><b>Sato Pharma</b><span>www.satopharma.com &middot; Sheraton, Cairo, Egypt</span></footer>
</div>`);
}

function nightBlueprint(p: Parts): string {
  const cols = p.f.length;
  const lede = p.h.length ? `<p class="lede">${p.h.join(" ")}</p>` : "";
  return doc(`${p.c.title} - Night Blueprint`, p.a, `
  .page { color: #fff; background:
     radial-gradient(ellipse 760px 520px at 85% 12%, rgba(8,121,184,.34), rgba(8,121,184,0) 70%),
     repeating-linear-gradient(0deg, rgba(93,183,232,.07) 0 1px, transparent 1px 36px),
     repeating-linear-gradient(90deg, rgba(93,183,232,.07) 0 1px, transparent 1px 36px),
     linear-gradient(180deg, #13202e 0%, var(--ink) 60%, #0b1118 100%); }
  .page::before { content: ""; position: absolute; inset: 10px; border: 1px solid rgba(93,183,232,.55); z-index: 19; }
  .page::after { content: ""; position: absolute; inset: 15px; border: 1px solid rgba(93,183,232,.2); z-index: 19; }
  .tick.tl, .tick.tr { border-color: var(--blue-light); }
  .mast { height: 104px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 72px; }
  .plate { background: #fff; padding: 11px 18px; box-shadow: 0 0 0 1px rgba(93,183,232,.5), 0 18px 34px -18px rgba(8,121,184,.9); }
  .plate img { display: block; height: 38px; }
  .coord { text-align: right; font-size: 11.5px; font-weight: 700; letter-spacing: .32em; text-transform: uppercase; color: var(--blue-light); line-height: 1.7; }
  .coord span { color: rgba(255,255,255,.55); }
  .hero { position: relative; flex-shrink: 0; padding: 36px 72px 0; }
  .hero .copy { max-width: 760px; }
  .hire { display: flex; align-items: center; gap: 16px; font-size: 13.5px; font-weight: 700; letter-spacing: .36em; text-transform: uppercase; color: var(--blue-light); }
  .hire s { display: block; width: 10px; height: 10px; background: var(--blue-light); box-shadow: 0 0 18px 2px rgba(93,183,232,.7); }
  .hire i { display: block; width: 60px; border-top: 1px solid rgba(93,183,232,.6); }
  h1 { margin-top: 22px; font-size: 74px; line-height: 1; letter-spacing: -.04em; font-weight: 700; }
  h1 span { display: block; white-space: nowrap; }
  h1 span + span { color: var(--blue-light); text-shadow: 0 0 40px rgba(93,183,232,.45); }
  .lede { margin-top: 18px; font-size: 22px; color: rgba(255,255,255,.72); }
  ${blocksCss(28, 8, "rgba(93,183,232,.32)")}
  .hero .blocks { position: absolute; right: 72px; top: 40px; }
  .keys { flex-shrink: 0; margin: 32px 72px 0; display: grid; grid-template-columns: repeat(${cols}, 1fr); border: 1px solid rgba(93,183,232,.4); background: rgba(8,121,184,.10); }
  .key { padding: 15px 18px; }
  .key + .key { border-left: 1px solid rgba(93,183,232,.25); }
  .key .k { font-size: 9.5px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--blue-light); }
  .key .v { margin-top: 7px; font-size: ${cols > 4 ? 15 : 16.5}px; font-weight: 700; line-height: 1.25; }
  .cols { flex: 1; margin: 0 72px; display: grid; grid-template-columns: 1fr 1fr; column-gap: 44px; align-content: center; }
  .lbl { display: flex; align-items: center; gap: 12px; font-size: 11px; font-weight: 700; letter-spacing: .32em; text-transform: uppercase; color: var(--blue-light); padding-bottom: 12px; border-bottom: 1px solid rgba(93,183,232,.35); }
  .lbl em { font-style: normal; color: rgba(255,255,255,.45); }
  .cols ul { margin-top: 20px; display: flex; flex-direction: column; gap: calc(var(--k) * 21px); }
  .cols li { display: flex; align-items: baseline; gap: 12px; font-size: calc(var(--k) * 18px); line-height: 1.45; color: rgba(255,255,255,.74); }
  .cols li b { color: #fff; }
  .cols li s { flex: 0 0 7px; height: 7px; background: var(--blue-light); transform: translateY(-2px); }
  .n li s { background: transparent; box-shadow: inset 0 0 0 1.5px var(--blue-light); }
  .apply { flex-shrink: 0; margin: 0 72px 34px; display: grid; grid-template-columns: auto 1fr; column-gap: 34px; align-items: center; padding: 22px 30px; border: 1px solid var(--blue-light); background: linear-gradient(90deg, rgba(8,121,184,.38), rgba(8,121,184,.08)); box-shadow: 0 0 46px -14px rgba(93,183,232,.55); }
  .apply .num { font-size: 50px; font-weight: 700; letter-spacing: -.01em; color: #fff; white-space: nowrap; line-height: 1; }
  .apply .k { font-size: 11px; font-weight: 700; letter-spacing: .34em; text-transform: uppercase; color: var(--blue-light); }
  .apply .sub { margin-top: 7px; font-size: 14px; line-height: 1.5; color: rgba(255,255,255,.78); }
  .apply .sub b { color: #fff; }
  .foot { height: 70px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 72px; border-top: 1px solid rgba(93,183,232,.3); background: rgba(0,0,0,.35); }
  .foot b { font-size: 13px; letter-spacing: .3em; text-transform: uppercase; }
  .foot span { font-size: 13.5px; color: rgba(255,255,255,.7); }`, `
<div class="page">${TICKS}
  <header class="mast"><div class="plate"><img src="${p.a.logo}" alt="Sato Pharma"></div><div class="coord">Careers<br><span>${escapeHtml(p.c.department)} &middot; Cairo</span></div></header>
  <section class="hero">${blocks([3, 6])}
    <div class="copy">
      <div class="hire"><s></s>We are hiring<i></i></div>
      <h1>${p.t.map((t) => `<span>${t}</span>`).join("")}</h1>
      ${lede}
    </div>
  </section>
  <section class="keys">${p.f.map(([k, v]) => `<div class="key"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</section>
  ${p.areas("dark", "margin: 18px 72px 0")}
  <section class="cols fit"><div class="d"><div class="lbl"><em>01</em>What you will do</div><ul>${p.duties}</ul></div><div class="n"><div class="lbl"><em>02</em>What you need</div><ul>${p.needs}</ul></div></section>
  <section class="apply"><div class="num">${p.num}</div><div><div class="k">Ready to apply?</div><div class="sub">${p.applySub}</div></div></section>
  <footer class="foot"><b>Sato Pharma</b><span>www.satopharma.com &middot; Sheraton, Cairo, Egypt</span></footer>
</div>`);
}

const BUILDERS: Record<JobPostTemplateKey, (p: Parts) => string> = {
  executive,
  split,
  editorial,
  "bold-blue": boldBlue,
  "night-blueprint": nightBlueprint,
};

/** One complete, self-contained HTML document for one picture. */
export function renderJobPostHtml(content: JobPostContent, template: JobPostTemplateKey, assets: JobPostAssets): string {
  return BUILDERS[template](parts(content, assets));
}
