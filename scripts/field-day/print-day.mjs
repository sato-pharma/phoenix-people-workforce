// Phoenix CRM — the field day as four papers: one per line for the district managers, and a one-page
// summary for the Chief Executive.
//
//   node scripts/field-day/print-day.mjs              # today in Cairo
//   node scripts/field-day/print-day.mjs 2026-10-03   # a named day
//
// They land in `xlsx/` beside the company's other documents, as
// `Phoenix-CRM-Field-Day-<day>-<line>.pdf` and `-Summary-for-the-CEO.pdf`, and a re-run overwrites
// the day it was given. The field day does not close until 02:00 Cairo, so an evening cut is a cut of
// a day still running and says so on its own letterhead.
//
// THE HOUSE DOCUMENT IDENTITY, SATO-DIS-2026-01 v1.0: the palette measured from the Sato mark, the
// engine-turned band, and THE INK RULE — colour carried by lines and type, never by filled area, with
// the 6% zebra row as the single exception the owner asked for by name. Square corners everywhere,
// hairlines at 0.5 pt, nothing truncated with an ellipsis. Sato's mark above and the Phoenix emblem
// below, each in its own colours (owner, 2026-09-11), blue overriding.
//
// 🔴 THE RUNNING FOOTER RIDES IN A <tfoot>. That is the one technique Chrome repeats on every printed
// page — `@page` margin boxes are unimplemented and a `position: fixed` footer overlaps the text it is
// meant to sit below, which this file did in its first cut.
//
// Printed by headless Chrome, which is how the approved specimen itself is built: a PDF library
// cannot shape Arabic (render-shared.ts).

import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, readDay } from "./read-day.mjs";

/**
 * The PRIMARY checkout's `xlsx/`, whichever checkout this script is run from.
 *
 * 🔴 NOT `REPO_ROOT`/xlsx. The hourly backup to `F:\PHX backup` covers the untracked files at the top
 * of the PRIMARY's `xlsx/` and NOTHING in a worktree's (AGENTS.md §5), so a run from a worktree would
 * put the company's documents exactly where the backup never looks — and they would sit there
 * invisibly until that worktree was retired. `--git-common-dir` is the primary's `.git` from anywhere.
 */
function primaryXlsx() {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    return path.join(path.dirname(path.resolve(REPO_ROOT, common)), "xlsx");
  } catch {
    return path.join(REPO_ROOT, "xlsx");
  }
}
const OUT = process.env.FIELD_DAY_OUT || primaryXlsx();
const CHROME = process.env.FIELD_DAY_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

/** The smallest real paper measured is ~150 KB; the Chief Executive summary is 227 KB. */
const MIN_PAPER_BYTES = 100_000;
/** One paper, three tries — enough for a profile race, short of hanging the 21:00 job. */
const PAPER_ATTEMPTS = 3;

/** Sampled from the company mark, never chosen — src/lib/hiring-pack/house-identity.ts. */
const C = {
  ink: "#000000",
  deep: "#0A527D",
  blue: "#0A6BA6",
  light: "#1482C2",
  tint: "#F2F6FA",
  hair: "#B9C7D4",
  muted: "#5A6B7C",
  body: "#1A1A1A",
};

const asset = (file, mime) => `data:${mime};base64,${readFileSync(path.join(REPO_ROOT, file)).toString("base64")}`;
/** ALWAYS the on-light mark on paper: the stock file sets "SATO" in white and it vanishes. */
const SATO = () => asset("public/brand/sato-pharma-logo-on-light.svg", "image/svg+xml");
const PHOENIX = () => asset("public/brand/phoenix-login-emblem.png", "image/png");

const esc = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * One wavelength of the engine-turned band: two sine passes half a period apart, STROKED. It is line
 * and not area, so it spends almost no toner, and one exact wavelength tiles with no visible seam.
 */
function band() {
  const width = 6;
  const height = 1.5;
  const stroke = 0.26;
  const steps = 24;
  const pass = (shift) => {
    const points = [];
    for (let step = 0; step <= steps; step += 1) {
      const x = (step / steps) * width;
      const y = height / 2 + (height / 2 - stroke) * Math.sin((2 * Math.PI * x) / width + shift);
      points.push(`${x.toFixed(3)},${y.toFixed(3)}`);
    }
    return `<polyline fill="none" stroke="${C.deep}" stroke-width="${stroke}" points="${points.join(" ")}"/>`;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">${pass(0)}${pass(Math.PI)}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}")`;
}

const css = () => `
  @page { size: A4 portrait; margin: 14mm 15mm 16mm; }
  * { box-sizing: border-box; border-radius: 0; }
  :root, html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: ${C.body}; font-family: Aptos, "Segoe UI Variable Text", "Segoe UI", Inter, Arial, sans-serif; font-size: 8.6pt; line-height: 1.45; }
  .lh { display: flex; direction: ltr; align-items: flex-end; justify-content: space-between; gap: 8mm; }
  .lh img { display: block; width: 34mm; height: auto; }
  .lh__id { text-align: right; color: ${C.muted}; font-size: 6.5pt; line-height: 1.5; }
  .lh__id strong { display: block; color: ${C.deep}; font-size: 8pt; font-weight: 700; }
  .band { height: 1.5mm; margin-top: 2.2mm; background: ${band()} repeat-x left center; }
  .title { text-align: center; padding: 3.3mm 0 2.2mm; }
  .title h1 { margin: 0; color: ${C.deep}; font-size: 17pt; font-weight: 700; line-height: 1.2; }
  .title p { margin: 1.2mm 0 0; color: ${C.muted}; font-size: 8pt; font-weight: 600; }
  .purpose { margin: 0 0 4mm; padding: 1.5mm 0; border-top: .5pt solid ${C.hair}; border-bottom: .5pt solid ${C.hair}; color: ${C.deep}; font-size: 8.5pt; font-weight: 700; text-align: center; }
  /* The day-off line sits straight under the addressee, sharing its rule rather than drawing a second one. */
  .purpose.rest { margin-top: -4mm; border-top: 0; color: ${C.body}; font-weight: 600; }
  h2 { margin: 5mm 0 1.8mm; color: ${C.deep}; font-size: 10pt; font-weight: 700; border-bottom: .5pt solid ${C.blue}; padding-bottom: 1mm; break-after: avoid; page-break-after: avoid; }
  h3 { margin: 3.4mm 0 1.2mm; color: ${C.ink}; font-size: 9pt; font-weight: 700; break-after: avoid; page-break-after: avoid; }
  h3 span { color: ${C.muted}; font-weight: 600; font-size: 8pt; }
  .figures { display: flex; direction: ltr; border-top: .5pt solid ${C.hair}; border-bottom: .5pt solid ${C.hair}; }
  .figures div { flex: 1; padding: 2.4mm 2mm; border-left: .5pt solid ${C.hair}; }
  .figures div:first-child { border-left: 0; }
  .figures dt { margin: 0; color: ${C.muted}; font-size: 6.6pt; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .figures dd { margin: .6mm 0 0; color: ${C.deep}; font-size: 14pt; font-weight: 700; line-height: 1.1; }
  .figures dd small { display: block; color: ${C.body}; font-size: 7.4pt; font-weight: 600; line-height: 1.3; }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; }
  th, td { padding: 1.5mm 1.8mm; vertical-align: top; text-align: left; overflow-wrap: break-word; }
  thead th { color: ${C.deep}; font-size: 7pt; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; border-top: .5pt solid ${C.deep}; border-bottom: .5pt solid ${C.deep}; }
  tbody td { border-bottom: .5pt solid ${C.hair}; }
  tbody tr:nth-child(even) td { background: ${C.tint}; border-bottom-color: transparent; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .rep { break-inside: avoid; page-break-inside: avoid; margin-bottom: 2mm; }
  .rep.quiet h3 { color: ${C.muted}; }
  .note { margin: 1.2mm 0 0; padding-left: 2.4mm; border-left: 1pt solid ${C.light}; color: ${C.body}; font-size: 8.2pt; }
  .note strong { color: ${C.deep}; }
  ul.events { margin: 1mm 0 0; padding: 0; list-style: none; }
  ul.events li { display: flex; direction: ltr; gap: 2.4mm; padding: .7mm 0; border-bottom: .5pt solid ${C.hair}; font-size: 8.2pt; }
  ul.events li:last-child { border-bottom: 0; }
  ul.events b { flex: 0 0 11mm; color: ${C.deep}; font-variant-numeric: tabular-nums; font-weight: 700; }
  ul.events span.what { flex: 0 0 24mm; color: ${C.muted}; font-size: 7.6pt; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  ul.events span.who { flex: 1 1 auto; font-family: Tahoma, "Noto Naskh Arabic", "Segoe UI", sans-serif; }
  ul.events span.how { flex: 0 0 38mm; text-align: right; }
  table.sheet { width: 100%; border-collapse: collapse; }
  table.sheet > tbody > tr > td, table.sheet > tfoot > tr > td { padding: 0; border: 0; vertical-align: top; }
  .foot { display: flex; direction: ltr; align-items: center; justify-content: space-between; gap: 4mm; margin-top: 5mm; padding-top: 1.4mm; border-top: .5pt solid ${C.hair}; color: ${C.muted}; font-size: 6.6pt; }
  .foot img { height: 6mm; width: auto; display: block; }
  .foot .mid { text-align: center; }
`;

/**
 * The judgements — the only sentences on these papers a human wrote, and each one is about a thing
 * the database records but cannot explain.
 *
 * 🔴 KEYED BY CAIRO DAY FIRST, THEN BY REP — because each sentence is about ONE day's captures and
 * is false on every other day. Keyed by rep alone, these six notes printed on every paper that rep
 * ever appeared on: "The phone was on approximate location all morning" is a 3 October incident, and
 * it went out on the 7th and the 8th as though it had happened that morning, to a district manager
 * and in summary to the Chief Executive. A rep with nothing to explain on a day gets only the
 * derived notes below.
 */
const AUTHORED = {
  "2026-10-03": {
    "Yasmeen Samy Shawky Mahdy":
      "The phone was on approximate location all morning — every reading came back at exactly 2,000 m — so all four Benha hospitals landed on one single point, and the system flagged the repeated coordinate three times. The two visits logged afterwards read far only because they were measured against those wrong points, not because the hospitals were far away. The four places were withdrawn on the owner's instruction, the hospitals went back to “To validate”, and they are being re-validated with precise location on. An email went out with the district manager and the SFE copied.",
    "Khaled Saied Abdelhady elkamry":
      "Al-Menshawy General sits 3.6 km from the pin Google still holds for it, because the hospital moved into the new Tanta General building in Sibirai. The photograph shows the new building, so the place was kept and the validation rules were emailed with the district manager and the SFE copied.",
    "Radwa Ahmed Abdel Qader Al-Sayed Moawad":
      "The psychiatry and neurology hospital was checked by hand: the photograph shows Tanta University's psychiatry and neurology centre, which is the customer on the list, so the place was kept. The validation rules were emailed with the district manager and the SFE copied.",
    "Esraa fotooh Mosaad Al-Shandalati":
      "An earlier attempt from inside the building was refused by the system for a weak reading; it was retaken outside and both places came in well inside the 100 m line.",
    "Hassan Mohamed Raffat Mohamed Elsherbiny":
      "One of the reps who used the “show your manager you started working” button. A visit that reads with a weak signal was taken inside the building; the place for that same hospital is accurate to a few metres, so the hospital's own point is sound.",
    "Sara Mohy Eldeen Helmy Mohamed Ebid":
      "The unmeasured visit is to the One Day Surgery hospital in Ashmoun — a different customer from the General validated later the same day. Validating one hospital never measures a visit to the other.",
  },
};

/**
 * How a day off is named in a sentence — `Armed Forces Day, a public holiday`, or `Friday, the
 * weekly day off`. One phrase, so no paper words it differently from another.
 */
export const restDayPhrase = (restDay) =>
  !restDay ? "" : restDay.kind === "holiday" ? `${restDay.name}, a public holiday` : "Friday, the weekly day off";

/**
 * The line every paper carries when the day was a day off, directly under the addressee.
 *
 * It states what the day was and why the figures below are what they are, because a reader who meets
 * a column of zeroes first reads them as a failure and only then, if at all, reads the explanation.
 */
export function restDayBanner(dayData) {
  if (!dayData.restDay) return "";
  const worked = dayData.groups.flatMap((group) => group.reps).filter((rep) => !rep.quiet).length;
  const consequence =
    worked === 0
      ? "No work was recorded, and none was expected: the figures below are zero for that reason alone, and there is nothing here for a manager to follow up."
      : "Whatever is recorded below was recorded on a day the company was off, and nothing was expected of anyone who recorded nothing.";
  return `<p class="purpose rest">${esc(longDay(dayData.day))} was ${esc(restDayPhrase(dayData.restDay))}. ${esc(consequence)}</p>`;
}

/**
 * What the data itself says about a rep's day, in words.
 *
 * No pronouns: these papers name fourteen people and a guessed one is a real discourtesy on a
 * document that goes to their managers.
 *
 * 🔴 AN EMPTY DAY OFF IS NOT AN EMPTY DAY. Without `restDay` this printed "Nothing was recorded
 * today, and nothing was planned for it either" under all fifteen names on Armed Forces Day — a
 * sentence that reads as fifteen people who did not work, on a paper their district manager and the
 * Chief Executive both read. On a day off the absence is explained and nothing is left to chase.
 */
export function derivedNotes(rep, restDay) {
  if (rep.quiet) {
    if (restDay) return [`${restDayPhrase(restDay)}. Nothing was recorded, and nothing was expected to be.`];
    return [
      rep.planned > 0
        ? `Nothing was recorded today, and ${rep.planned} customers were planned for it.`
        : "Nothing was recorded today, and nothing was planned for it either.",
    ];
  }
  const notes = [];
  const waiting = rep.events.filter((event) => event.how === "waiting to be measured").length;
  if (waiting > 0) {
    notes.push(
      `${waiting === 1 ? "One visit is" : `${waiting} visits are`} to a customer who is not validated yet, so each visit's own GPS reading is saved and waiting: the system measures it against the place the moment that customer is validated.`,
    );
  }
  for (const row of rep.unplanned) {
    const said = String(row.clarification ?? "").trim();
    notes.push(
      `The visit to ${row.customer} was off plan${said ? ` — “${said}” —` : ""} so it waits with the district manager and counts in nothing until it is approved.`,
    );
  }
  for (const row of rep.requests) {
    notes.push(
      row.kind === "grade"
        ? `A grade change was asked of the district manager for ${row.customer_name}. That request is still open.`
        : `A list request (${row.kind}) was raised for ${row.customer_name}. It is still open.`,
    );
  }
  return notes;
}

/**
 * A rep's notes: the authored sentence about that rep's day, then what the data itself says.
 *
 * 🔴 AN AUTHORED NOTE PRINTS ON ITS OWN DAY AND NO OTHER, so the day is looked up before the rep.
 * The `restDay` guard stays behind that: a day off has no captures to explain, so should a note ever
 * be written against a date the company later moves its day off onto, the note still does not print.
 */
const notesFor = (rep, day, restDay) => [
  ...(AUTHORED[day]?.[rep.name] && !restDay ? [AUTHORED[day][rep.name]] : []),
  ...derivedNotes(rep, restDay),
];

export const figuresOf = (group) => ({
  worked: group.reps.filter((rep) => !rep.quiet).length,
  occupied: group.reps.length,
  am: group.reps.reduce((total, rep) => total + rep.am, 0),
  pm: group.reps.reduce((total, rep) => total + rep.pm, 0),
  places: group.reps.reduce((total, rep) => total + rep.places, 0),
  kept: group.reps.reduce((total, rep) => total + rep.kept, 0),
  validated: group.reps.reduce((total, rep) => total + rep.validated, 0),
  list: group.reps.reduce((total, rep) => total + rep.list, 0),
});

const longDay = (day) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

const shell = (title, inner, footMiddle) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css()}</style></head>
<body><table class="sheet"><tbody><tr><td>
${inner}
</td></tr></tbody>
<tfoot><tr><td><div class="foot">
  <img alt="Phoenix Workforce" src="${PHOENIX()}">
  <span class="mid">${footMiddle}<br>Read from the production record in Africa/Cairo time. Internal — not for distribution outside Sato Pharma.</span>
  <img alt="Sato Pharma" src="${SATO()}" style="height:5mm">
</div></td></tr></tfoot></table></body></html>`;

const letterhead = (kind, stamp) => `<header class="lh">
    <div class="lh__mark"><img alt="Sato Pharma" src="${SATO()}"></div>
    <div class="lh__id"><strong>SATO-DIS-2026-01 v1.0</strong>Phoenix Workforce · Field CRM<br>${esc(kind)} · ${esc(stamp)}</div>
  </header>
  <div class="band"></div>`;

/** The stamp every paper carries: which day, and the moment it was read from production. */
export const stampOf = (dayData) => `${longDay(dayData.day)} · read at ${dayData.readAt} Cairo`;

export function renderLinePage(group, dayData) {
  const figures = figuresOf(group);
  const rows = group.reps
    .map(
      (rep) => `<tr>
        <td>${esc(rep.name)}</td><td>${esc(rep.area)}</td>
        <td class="num">${rep.planned || "—"}</td><td class="num">${rep.am || "—"}</td><td class="num">${rep.pm || "—"}</td>
        <td class="num">${rep.places || "—"}</td><td>${esc(rep.accuracy)}</td><td class="num">${rep.validated} of ${rep.list}</td>
      </tr>`,
    )
    .join("");
  const blocks = group.reps
    .map((rep) => {
      const events = rep.events
        .map(
          (event) =>
            `<li><b>${esc(event.at)}</b><span class="what">${esc(event.what)}</span><span class="who" dir="auto">${esc(event.who)}</span><span class="how">${esc(event.how)}</span></li>`,
        )
        .join("");
      const notes = notesFor(rep, dayData.day, dayData.restDay).map((note) => `<p class="note">${esc(note)}</p>`).join("");
      const title = rep.title && rep.title !== "Medical Representative" ? ` <span>— ${esc(rep.title)}</span>` : "";
      return `<div class="rep${rep.quiet ? " quiet" : ""}">
        <h3>${esc(rep.name)} <span>· ${esc(rep.area)}</span>${title}</h3>
        ${events ? `<ul class="events">${events}</ul>` : ""}${notes}
      </div>`;
    })
    .join("");
  const vacant = group.vacant.length
    ? `<p class="note"><strong>Vacant seat${group.vacant.length > 1 ? "s" : ""}:</strong> ${group.vacant.map(esc).join(", ")} — nobody is carrying ${group.vacant.length > 1 ? "those areas" : "that area"}.</p>`
    : "";

  return shell(
    `Phoenix CRM field day — ${group.line} — ${dayData.day}`,
    `${letterhead("Internal operations report", stampOf(dayData))}
  <div class="title"><h1>Field Day Report</h1><p>${esc(group.line)} · Delta (1) · ${esc(longDay(dayData.day))}</p></div>
  <p class="purpose">District Manager ${esc(group.dm)}</p>
  ${restDayBanner(dayData)}
  <div class="figures">
    <div><dt>Reps</dt><dd>${figures.worked} of ${figures.occupied}<small>recorded work ${dayData.restDay ? `on ${dayData.restDay.kind === "holiday" ? "the public holiday" : "the weekly day off"}` : "today"}${group.vacant.length ? ` · ${group.vacant.length} seat vacant` : ""}</small></dd></div>
    <div><dt>Calls</dt><dd>${figures.am + figures.pm}<small>${figures.am} hospitals · ${figures.pm} doctors</small></dd></div>
    <div><dt>Places validated</dt><dd>${figures.kept}<small>of ${figures.places} captured at the door</small></dd></div>
    <div><dt>List standing</dt><dd>${figures.validated}<small>validated of ${figures.list.toLocaleString("en-GB")} customers</small></dd></div>
  </div>
  <h2>Every rep on the line</h2>
  <table>
    <colgroup><col style="width:21%"><col style="width:13%"><col style="width:9%"><col style="width:11%"><col style="width:9%"><col style="width:8%"><col style="width:15%"><col style="width:14%"></colgroup>
    <thead><tr><th>Rep</th><th>Area</th><th class="num">Planned</th><th class="num">Hospitals</th><th class="num">Doctors</th><th class="num">Places</th><th>Accuracy</th><th class="num">Validated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${vacant}
  <h2>What each rep did, hour by hour</h2>
  ${blocks}
  <h2>How a visit gets its distance</h2>
  <p class="note">A customer can be planned and visited before being validated. Such a visit saves its own
  GPS reading and waits: the moment the rep validates that customer's place, the system measures the
  earlier visit against it automatically and the place-vs-actual report picks it up. Nothing is lost and
  nothing is entered twice — and the rep is never shown any of it.</p>
  <p class="note">A distance only ever compares a visit with a place <strong>of the same customer</strong>.
  Two hospitals in one town are two customers, so validating one never measures a visit to the other.</p>`,
    `Phoenix Workforce · Field CRM · ${esc(group.line)} Delta (1) · ${esc(longDay(dayData.day))}`,
  );
}

/**
 * The Chief Executive's page. One side of paper, no rep named and no hour-by-hour detail: what the
 * day proves about the system, and what it leaves to do.
 */
export function renderSummaryPage(dayData) {
  const per = dayData.groups.map((group) => ({ group, figures: figuresOf(group) }));
  const total = (pick) => per.reduce((sum, row) => sum + pick(row.figures), 0);
  const am = total((figures) => figures.am);
  const pm = total((figures) => figures.pm);
  const places = total((figures) => figures.places);
  const kept = total((figures) => figures.kept);
  const validated = total((figures) => figures.validated);
  const list = total((figures) => figures.list);
  const worked = total((figures) => figures.worked);
  const occupied = total((figures) => figures.occupied);
  const vacant = dayData.groups.reduce((sum, group) => sum + group.vacant.length, 0);
  const quiet = dayData.groups.flatMap((group) => group.reps).filter((rep) => rep.quiet).length;
  const within25 = dayData.places.filter((place) => Math.max(Number(place.photo_accuracy_meters ?? 0), Number(place.pin_accuracy_meters ?? 0)) <= 25).length;
  const within100 = dayData.places.filter((place) => Math.max(Number(place.photo_accuracy_meters ?? 0), Number(place.pin_accuracy_meters ?? 0)) <= 100).length;
  const withdrawn = places - kept;
  const restDay = dayData.restDay ?? null;

  /**
   * What the day shows, in the order it is read.
   *
   * 🔴 A DAY OFF LEADS ITS OWN PAGE. On a public holiday the three sections below say nothing true:
   * "0 of the 15 reps who hold a seat recorded real work" is a performance sentence, "Of the 0
   * places captured, 0 were accurate" is arithmetic about nothing, and both stood on a paper
   * prepared for the Chief Executive on Armed Forces Day. So the day off is stated first, and a
   * section whose figures are empty is not printed at all rather than printed as a zero.
   */
  const shows = [];
  if (restDay) {
    shows.push(`<h3>The day was a day off</h3>
  <p class="note">${
    restDay.kind === "holiday"
      ? `${esc(restDay.name)} is a public holiday for the whole company, confirmed on the company holiday calendar — which is where this page reads it from, so a day off the company moves is a day off on this paper.`
      : "The day was a Friday, the weekly day off."
  } ${
    worked === 0
      ? "Nothing was due from the field and nothing was recorded, so every figure on this page reads zero because the day was off — not because a day's work went unreported."
      : `${worked === 1 ? "One rep" : `${worked} reps`} recorded work on it even so; nothing was asked of anyone who recorded none.`
  }</p>`);
  }
  if (worked > 0) {
    shows.push(`<h3>The field is on the system</h3>
  <p class="note">${worked} of the ${occupied} reps who hold a seat recorded real work — ${am} hospital calls
  and ${pm} doctor calls, every one tied to a photograph taken at the door and to the GPS reading of the
  phone that took it. Nothing here is typed in from memory at the end of the day.</p>`);
  }
  if (places > 0) {
    shows.push(`<h3>The locations are accurate</h3>
  <p class="note">Of the ${places} places captured, ${within25} were accurate to within 25 metres and
  ${within100} within the 100 metres the company requires. Each one becomes the fixed point every future
  visit to that customer is measured against, so today's care is what makes next month's coverage figures
  trustworthy.</p>`);
  }
  if (withdrawn > 0) {
    shows.push(`<h3>The system caught what it should</h3>
  <p class="note">${withdrawn} ${withdrawn === 1 ? "place was" : "places were"} withdrawn after the system
  flagged the capture itself — a phone left on approximate location puts every hospital on one point, and
  the repeated coordinate is caught without a manager having to notice it. Those customers go back to
  “To validate” and are re-validated standing at the door, so no wrong point survives into the record.</p>`);
  }
  const vacantClause = vacant === 0 ? "" : ` ${vacant === 1 ? "One seat is" : `${vacant} seats are`} vacant, which the district managers are following.`;
  shows.push(`<h3>The work ahead is the lists</h3>
  <p class="note">${validated} customers of ${list.toLocaleString("en-GB")} are validated so far — a job that
  runs over the coming weeks, one doorway at a time.${
    restDay
      ? ` No call was due on ${esc(restDay.name)}, so the lists stand where the last working day left them.${vacantClause}`
      : ` ${quiet === 0 ? "Every rep with a seat recorded work" : quiet === 1 ? "One rep recorded nothing" : `${quiet} reps recorded nothing`} today.${vacantClause}`
  }</p>`);

  const rows = per
    .map(
      ({ group, figures }) => `<tr>
        <td>${esc(group.line)}</td><td>${esc(group.dm)}</td>
        <td class="num">${figures.worked} of ${figures.occupied}</td><td class="num">${figures.am + figures.pm}</td>
        <td class="num">${figures.kept}</td><td class="num">${figures.validated} of ${figures.list.toLocaleString("en-GB")}</td>
      </tr>`,
    )
    .join("");

  return shell(
    "Phoenix CRM — Delta (1) field day — executive summary",
    `${letterhead("Executive summary", stampOf(dayData))}
  <div class="title"><h1>Phoenix CRM · Field Day</h1><p>Delta (1) — CNS, Pedia and Anti-Infective · ${esc(longDay(dayData.day))}</p></div>
  <p class="purpose">Prepared for Anwar Gaweesh, Chief Executive Officer</p>
  ${restDayBanner(dayData)}
  <div class="figures">
    <div><dt>Teams live</dt><dd>${dayData.groups.length}<small>all of Delta (1)</small></dd></div>
    <div><dt>${restDay ? "Reps in the field" : "Reps working"}</dt><dd>${worked} of ${occupied}<small>${restDay ? "the company was off" : "recorded work"} · ${vacant === 1 ? "one seat" : `${vacant} seats`} vacant besides</small></dd></div>
    <div><dt>Calls logged</dt><dd>${am + pm}<small>${am} hospitals · ${pm} doctors</small></dd></div>
    <div><dt>Places validated</dt><dd>${kept}<small>of ${places} captured at the door</small></dd></div>
  </div>
  <h2>The three lines</h2>
  <table>
    <colgroup><col style="width:17%"><col style="width:29%"><col style="width:13%"><col style="width:11%"><col style="width:13%"><col style="width:17%"></colgroup>
    <thead><tr><th>Line</th><th>District Manager</th><th class="num">${restDay ? "Reps in the field" : "Reps working"}</th><th class="num">Calls</th><th class="num">Places</th><th class="num">Validated of list</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>What the day shows</h2>
  ${shows.join("\n  ")}
  <h2>What this replaces</h2>
  <p class="note">Visit reporting for these teams now comes from Phoenix rather than the outside system:
  the plan, the call, the photograph, the location and the approval all sit in one record that the district
  manager, the SFE and the board read from the same page.</p>`,
    `Phoenix Workforce · Field CRM · Delta (1) · ${esc(longDay(dayData.day))}`,
  );
}

export function papersOf(dayData) {
  return [
    ...dayData.groups.map((group) => ({ file: group.file, html: renderLinePage(group, dayData) })),
    { file: "Summary-for-the-CEO", html: renderSummaryPage(dayData) },
  ];
}

/**
 * 🔴 CHROME EXITS 0 HAVING WRITTEN NOTHING, AND IT IS ALWAYS THE LAST PAPER.
 *
 * Measured twice on 2026-10-08: the loop below printed all four paths and exited 0, and only three
 * PDFs were on disk — the missing one each time was `Summary-for-the-CEO`, the Chief Executive's own
 * page. The HTML was sound (the same Chrome command run by hand wrote 227,229 bytes), so nothing was
 * throwing: the 4th invocation raced the 3rd's shutdown over the SHARED DEFAULT PROFILE and gave up
 * silently. `--user-data-dir` per invocation is the fix; this verifier is the proof, because a
 * nightly job nobody watches must never log a paper it did not write.
 *
 * Returns the size in bytes. Throws, naming the paper, on anything else.
 */
export function verifyPaper(pdfPath, { writtenAfter = 0 } = {}) {
  const name = path.basename(pdfPath);
  let stat;
  try {
    stat = statSync(pdfPath);
  } catch {
    throw new Error(`${name} was not written — Chrome exited 0 and left no file`);
  }
  // A paper here is 150-350 KB. Chrome also leaves a 0-byte or few-hundred-byte stub when it dies
  // mid-print, which `existsSync` alone would happily call a success.
  if (stat.size < MIN_PAPER_BYTES) {
    throw new Error(`${name} is ${stat.size} bytes — a paper here is over ${MIN_PAPER_BYTES}; Chrome wrote a stub`);
  }
  // 🔴 NOT a delete-then-check: these are protected documents (standing rule, never delete a PDF), so
  // a stale paper from an earlier run of the SAME day is ruled out by its timestamp instead.
  if (stat.mtimeMs < writtenAfter) {
    throw new Error(`${name} is stale — it was last written ${new Date(stat.mtimeMs).toISOString()}, before this run`);
  }
  const magic = Buffer.alloc(5);
  const fd = openSync(pdfPath, "r");
  try {
    readSync(fd, magic, 0, 5, 0);
  } finally {
    closeSync(fd);
  }
  if (!magic.toString("latin1").startsWith("%PDF")) {
    throw new Error(`${name} does not begin with %PDF — Chrome wrote ${JSON.stringify(magic.toString("latin1"))}`);
  }
  return stat.size;
}

/**
 * Print one paper and PROVE it landed, retrying that one paper before giving up.
 *
 * Each attempt gets its own `--user-data-dir`, so no two Chromes ever share a profile — not the
 * sequential ones in the loop below, and not two sessions printing the same day at once. Chrome's own
 * "N bytes written to file" line rides on stderr, which the old `{ stdio: "pipe" }` swallowed, so it
 * is captured here and goes into the message when every attempt has failed.
 */
export function printPaper({ htmlPath, pdfPath, work }) {
  const name = path.basename(pdfPath);
  const failures = [];
  for (let attempt = 1; attempt <= PAPER_ATTEMPTS; attempt += 1) {
    const writtenAfter = Date.now() - 2000; // filesystem timestamp granularity and clock skew
    const profile = path.join(work, `field-day-chrome-${process.pid}-${attempt}-${randomUUID().slice(0, 8)}`);
    const run = spawnSync(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=4000",
        `--user-data-dir=${profile}`,
        `--print-to-pdf=${pdfPath}`,
        `file:///${htmlPath.replace(/\\/g, "/")}`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const chatter = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
    try {
      if (run.error) throw run.error;
      if (run.status !== 0) throw new Error(`Chrome exited ${run.status}${run.signal ? ` on ${run.signal}` : ""}`);
      const size = verifyPaper(pdfPath, { writtenAfter });
      cleanProfile(profile);
      return { size, attempt };
    } catch (error) {
      cleanProfile(profile);
      failures.push(`attempt ${attempt}: ${error?.message ?? error}${chatter ? ` — chrome said: ${chatter}` : ""}`);
    }
  }
  // 🔴 LOUD, and naming the paper: `run-nightly.mjs` puts a thrown message into
  // `xlsx/field-day-task.log`, which is the only thing anyone will ever read about a 21:00 run.
  throw new Error(`${name} could not be printed in ${PAPER_ATTEMPTS} attempts.\n  ${failures.join("\n  ")}`);
}

/** A Chrome profile this run made, under FIELD_DAY_TMP — JSON and caches, no document types. */
function cleanProfile(profile) {
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    /* Chrome may still hold a lock; the temp folder is swept by Storage Sense anyway. */
  }
}

/**
 * The one line stdout carries when a run printed nothing on purpose.
 *
 * 🔴 IT IS PREFIXED, BECAUSE EVERY OTHER STDOUT LINE IS A PDF PATH THE LAUNCHER LOGS AS
 * `wrote <line>` — #5578 exists because the log claimed papers Chrome never wrote. An unprefixed
 * sentence here would come out as "wrote 2026-10-09 was Friday…", a written paper that is a
 * sentence. `run-nightly.mjs` recognises this prefix and nothing else.
 */
export const SKIPPED = "SKIPPED — ";

/** The skip line for a day off, or null for a working day — which always prints. */
export const dayOffSkipNotice = (dayData) =>
  dayData.restDay ? `${SKIPPED}${dayData.day} was ${restDayPhrase(dayData.restDay)}; no papers printed.` : null;

/**
 * The printer's own arguments: the day to print, and whether a day off should print at all.
 *
 * 🔴 THE SKIP IS OPT-IN AND THE UNATTENDED RUN IS THE ONLY THING THAT ASKS FOR IT (owner,
 * 2026-10-09: "make the nightly skip a day off"). A day NAMED on the command line always prints,
 * whatever day of the week it was — that is a human asking for that day, and it is the path the
 * 8 October papers were reprinted by once the holiday fix landed. A printer that refused a day off
 * outright would have made that reprint impossible.
 */
export function parsePrintArgs(argv) {
  const rest = argv.slice(2);
  return {
    day: rest.find((value) => !value.startsWith("-")),
    skipDayOff: rest.includes("--skip-day-off") || process.env.FIELD_DAY_SKIP_DAY_OFF === "1",
  };
}

// `pathToFileURL`, never a hand-built `file:///` string: this repository lives under "Phoenix
// Workforce", and the space arrives percent-encoded in `import.meta.url` but raw in `argv[1]`, so a
// string comparison silently fails and the script prints nothing at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parsePrintArgs(process.argv);
  const dayData = await readDay(args.day);
  const skip = args.skipDayOff ? dayOffSkipNotice(dayData) : null;
  if (skip) {
    // Exit 0, never a failure code: a day off printing nothing is the CORRECT outcome, and Task
    // Scheduler shows a non-zero exit as a job that broke.
    console.log(skip);
    process.exit(0);
  }
  mkdirSync(OUT, { recursive: true });
  const work = process.env.FIELD_DAY_TMP || tmpdir();
  for (const paper of papersOf(dayData)) {
    const htmlPath = path.join(work, `field-day-${dayData.day}-${paper.file}.html`);
    const pdfPath = path.join(OUT, `Phoenix-CRM-Field-Day-${dayData.day}-${paper.file}.pdf`);
    writeFileSync(htmlPath, paper.html, "utf8");
    // 🔴 `printPaper` THROWS rather than returning — the path is logged only once the file on disk
    // has been stat-checked, so this log can never again claim a paper that does not exist.
    printPaper({ htmlPath, pdfPath, work });
    console.log(pdfPath);
  }
}
