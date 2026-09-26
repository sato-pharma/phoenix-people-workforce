// Recruitment / ATS — the application sheet: the old paper Job Application Form, filled in from what the
// system holds, and everything one applicant was asked on WhatsApp and answered, on ONE A4 page that costs
// almost no ink.
//
// THE OWNER, 2026-09-19: on WhatsApp Applicants, beside the CV he already downloads, "download
// application" and "print application". Print opens the CV exactly as it was sent and "another page
// with all her WhatsApp history from all questions, all her answers ... in a polished way, but with no
// mud, with no many ink, because this is printable ... only in one paper."
//
// THE SAME DAY, HANDING OVER THE OLD PAPER FORM: "I want all the fields in the old to be in the new." Its
// personal information, employment desired, education, previous employment, skills, references and "how
// you heard" are the top of the sheet now (whatsapp-application-form.ts is the list of fields and where each
// comes from); the WhatsApp questions and answers follow. A field the system has no value for stays as an
// empty line to write on, because this is a form, and the record page's "print only what is filled in" rule
// was made for a different document.
//
// WHAT "ALL THE HISTORY" IS HERE. The bot's questions and this person's answers, taken from the
// conversation itself (`ats_whatsapp_classification_sessions`), which is what the list already shows. It
// is NOT the raw chat. The whole message store (`whatsapp_inbox_messages`) is Super Admin only, and this
// page is open to every recruiter who can read candidates, so printing from it would hand out chat that
// role was never given. The sheet is the structured record, and it stays inside what the list exposes.
//
// THE HOUSE IDENTITY, SATO-DIS-2026-01 v1.0, IS WHY THIS COSTS SO LITTLE INK. It has no filled areas:
// the sheet is type and hairlines, with the company mark and the engine-turned band. No zebra either,
// though the standard allows one at 6%, because this is meant to be printed by the dozen.
//
// ONE PAGE IS GUARANTEED BY MEASURING, NOT BY HOPING. Every size below is in `em` off one variable,
// `--k`, and `FIT_TO_ONE_PAGE_SCRIPT` shrinks it in the browser until the body stops overflowing. A
// person who answered fifteen long questions gets a smaller sheet, never a second page and never a
// clipped answer. Below `MIN_SCALE` the type would stop being readable, so the shrinking stops there and
// the overflow flows onto a second page instead, because dropping an answer would be worse.
//
// PURE — no I/O. The route owns Chromium and the file; the logo arrives as an argument.

import { HOUSE_DOCUMENT_STANDARD } from "@/lib/export/house-xlsx-palette";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { HOUSE_IDENTITY_CSS } from "@/lib/hiring-pack/house-identity";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import type { WhatsAppApplicantRow } from "@/lib/recruitment/whatsapp-applicant-filters";
import { BUILT_IN_ANSWER_QUESTIONS } from "@/lib/recruitment/whatsapp-answers";
import {
  buildApplicationForm,
  EMPLOYMENT_TYPES,
  type ApplicationCandidate,
  type ApplicationForm,
  type FormCell,
} from "@/lib/recruitment/whatsapp-application-form";

/** One question and what was answered. `note` sits under the answer in small type. */
export type ApplicationSheetEntry = { question: string; answer: string; note: string | null };

export type ApplicationSheet = {
  name: string;
  /** The title they applied for, as they chose or typed it. */
  jobTitle: string;
  /** "Applied 14 Sept 2026 · 12:12 (Cairo)"; empty when the row carries no usable date. */
  appliedLabel: string;
  /** The old paper form's fields, filled in from the record. */
  form: ApplicationForm;
  /** Every question they answered, in the order the bot asked it. */
  entries: ApplicationSheetEntry[];
  /**
   * Did this person apply over WhatsApp at all? True for a real conversation (the WhatsApp Applicants
   * download and the calendar's). False when the sheet is built for a candidate who never used WhatsApp
   * — the screening page's "Download application" reaches every CV now (owner, 2026-09-26) — and then
   * the "WhatsApp questions and answers" section and its outcome line are left off, and the sheet is a
   * plain Job application form filled from the record. Defaults true, so every existing caller is
   * unchanged.
   */
  hasWhatsApp: boolean;
  /** Whether they reached the end, and if not, where they stopped. One sentence. */
  outcome: string;
  finished: boolean;
  /** What the CV pages before this one are, or why there are none. One sentence. */
  cvLine: string;
  /** "Printed 19 Sept 2026 · 14:05 (Cairo)". */
  printedLabel: string;
};

/** The exact sentence a region answer carries when they tapped one of the listed regions. */
const PLAIN_WHATSAPP_REGION_NOTE = "Their WhatsApp answer";

function clean(raw: string | null | undefined): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.length > 0 ? value : null;
}

/**
 * The sheet's content, from the same row the list shows and the candidate's record.
 *
 * REGION IS A WHATSAPP QUESTION ONLY WHEN THEY WERE ASKED IT. Office coordinators have not been asked
 * since 2026-09-05, so their region comes from the CV's address. Listing that under "Which region?"
 * would put a guess in the bot's mouth, so the form's Region field carries it with its source instead.
 * A typed answer ("Minya") keeps their own words as the note under the company region it was filed into.
 */
export function buildApplicationSheet(input: {
  row: WhatsAppApplicantRow;
  titleLabel: string;
  contact: { email: string | null; phone: string | null };
  /** The record the form's education, jobs, skills and personal fields are read from; null when it is gone. */
  candidate: ApplicationCandidate | null;
  cvLine: string;
  now: Date;
  /** False for a candidate who never applied on WhatsApp; the Q&A section is then left off. Defaults true. */
  hasWhatsApp?: boolean;
}): ApplicationSheet {
  const { candidate, contact, cvLine, now, row, titleLabel } = input;
  const hasWhatsApp = input.hasWhatsApp ?? true;
  const jobTitle = clean(row.typedTitle) ?? titleLabel;

  const entries: ApplicationSheetEntry[] = [
    { answer: jobTitle, note: null, question: BUILT_IN_ANSWER_QUESTIONS.job_title },
  ];
  const region = row.region;
  const asked = region?.source === "whatsapp" ? region : null;
  // The list orders background, area, experience, salary, then the admin's questions. Region was asked
  // between background and area, so it is placed there.
  const background = row.answers.filter((answer) => answer.key === "background");
  const rest = row.answers.filter((answer) => answer.key !== "background");
  for (const answer of background) entries.push({ answer: answer.answer, note: null, question: answer.question });
  if (asked) {
    entries.push({
      answer: asked.label,
      note: asked.sourceLine === PLAIN_WHATSAPP_REGION_NOTE ? null : asked.sourceLine,
      question: BUILT_IN_ANSWER_QUESTIONS.region,
    });
  }
  for (const answer of rest) entries.push({ answer: answer.answer, note: null, question: answer.question });

  const outcome = row.finished
    ? "Answered every question the bot asked."
    : row.waitingOn
      ? `${row.stillOpen ? "Chat still open. Waiting for the answer to" : "Stopped answering at"}: ${row.waitingOn}`
      : "Did not answer every question the bot asked.";

  const applied = cairoDateTime(row.appliedAt);

  return {
    appliedLabel: applied === "—" ? "" : `Applied ${applied} (Cairo)`,
    cvLine,
    entries,
    finished: row.finished,
    form: buildApplicationForm({ candidate, contact, jobTitle, row }),
    hasWhatsApp,
    jobTitle,
    name: row.name,
    outcome,
    printedLabel: `Printed ${cairoDateTime(now.toISOString())} (Cairo)`,
  };
}

/** The rows the old paper form drew for each table. A record with fewer keeps the empty lines; more, all of them. */
export const FORM_EDUCATION_ROWS = 3;
export const FORM_EMPLOYMENT_ROWS = 4;
export const FORM_REFERENCE_ROWS = 2;
/** The four numbered skill lines of the paper form. They are drawn in rows of three, so an empty form shows six. */
export const FORM_SKILL_SLOTS = 4;
export const FORM_SKILL_COLUMNS = 3;

/** The smallest the type may shrink to before the sheet is allowed to run onto a second page. */
export const MIN_SCALE = 0.55;

/**
 * Runs inside the page. Shrinks `--k` until `.sheet__body` stops overflowing, and answers what it
 * settled on. Evaluated as a string because the Chromium wrapper takes one, so it must stay a plain
 * expression with nothing from this module in it.
 */
export const FIT_TO_ONE_PAGE_SCRIPT = `(() => {
  const body = document.querySelector('.sheet__body');
  const root = document.documentElement;
  const overflows = () => body.scrollHeight > body.clientHeight + 1;
  let k = 1;
  root.style.setProperty('--k', String(k));
  while (overflows() && k > ${MIN_SCALE}) {
    k = Math.round((k - 0.03) * 100) / 100;
    root.style.setProperty('--k', String(k));
  }
  const fits = !overflows();
  // Too long even at the smallest type: let it run onto a second page rather than clip an answer.
  if (!fits) document.querySelector('.sheet').classList.add('sheet--flow');
  return JSON.stringify({ fits, k });
})()`;

/**
 * Square edges, hairlines, no fills. `--k` scales the body type and every space in it, and only those:
 * the letterhead keeps its house size.
 *
 * The sheet is a fixed 296 mm rather than 297. A box exactly the height of the paper spills a blank
 * second page whenever layout rounds up by a fraction of a millimetre.
 */
const SHEET_CSS = `
  ${HOUSE_IDENTITY_CSS}
  :root { --k: 1; }
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; border-radius: 0 !important; }
  html, body { margin: 0; padding: 0; }
  body { color: var(--phx-doc-body); font-family: "Segoe UI", Tahoma, Arial, "Noto Sans Arabic", "Noto Naskh Arabic", sans-serif; }
  .sheet { display: flex; flex-direction: column; width: 210mm; height: 296mm; padding: 12mm 16mm 9mm; overflow: hidden; break-after: avoid; page-break-after: avoid; }
  .sheet__body { flex: 1 1 auto; min-height: 0; overflow: hidden; padding-top: 4mm; font-size: calc(9.6pt * var(--k)); line-height: 1.38; }
  .sheet--flow { height: auto; min-height: 296mm; overflow: visible; }
  .sheet--flow .sheet__body { flex: none; overflow: visible; }
  .top { display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; margin-bottom: .2em; }
  .eyebrow { margin: 0; color: var(--phx-doc-muted); font-size: .78em; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .applied { margin: 0; color: var(--phx-doc-muted); font-size: .84em; text-align: right; }
  h2 { margin: .8em 0 .08em; padding-bottom: .2em; border-bottom: .5pt solid var(--phx-doc-blue); color: var(--phx-doc-deep); font-size: 1.05em; font-weight: 700; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 2.4em; }
  .skills { display: grid; grid-template-columns: repeat(${FORM_SKILL_COLUMNS}, 1fr); column-gap: 1.8em; }
  .f, .sk { display: flex; align-items: baseline; gap: .7em; min-width: 0; min-height: 1.85em; padding: .26em 0 .1em; border-bottom: .5pt solid var(--phx-doc-hair); }
  .f--wide { grid-column: 1 / -1; }
  .l, .sk .n { flex: none; color: var(--phx-doc-muted); font-size: .84em; }
  .sk .n { width: 1.4em; font-size: .9em; }
  .v { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; font-weight: 700; }
  .v--name { font-size: 1.22em; line-height: 1.25; }
  .sk .v { font-weight: 600; }
  .note { display: block; color: var(--phx-doc-muted); font-size: .8em; font-weight: 400; }
  .opts { flex: 1 1 auto; display: flex; flex-wrap: wrap; gap: .2em 2.2em; }
  .opt { display: inline-flex; align-items: center; gap: .5em; font-weight: 600; }
  .box { flex: none; display: inline-block; width: .9em; height: .9em; border: .6pt solid var(--phx-doc-body); }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { padding: .3em .6em .15em 0; border-bottom: .5pt solid var(--phx-doc-hair); color: var(--phx-doc-muted); font-size: .8em; font-weight: 400; text-align: start; }
  td { height: 1.85em; padding: .26em .6em .1em 0; border-bottom: .5pt solid var(--phx-doc-hair); vertical-align: top; text-align: start; overflow-wrap: anywhere; font-weight: 600; }
  .qa td { height: auto; padding: .34em .5em .34em 0; vertical-align: top; font-weight: 400; }
  .qa td.n { width: 5%; color: var(--phx-doc-muted); font-size: .9em; }
  .qa td.q { width: 39%; padding-inline-end: 1em; color: var(--phx-doc-muted); }
  .qa td.a { width: 56%; padding-inline-end: 0; color: var(--phx-doc-body); font-weight: 700; }
  .qa td.a .note { margin-top: .1em; font-size: .84em; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .outcome { margin: .9em 0 0; color: var(--phx-doc-deep); font-size: 1em; font-weight: 700; overflow-wrap: anywhere; }
  .outcome--open { color: var(--phx-doc-body); }
  .sheet__foot { flex: none; display: flex; justify-content: space-between; gap: 6mm; padding-top: 1.8mm; border-top: .5pt solid var(--phx-doc-hair); color: var(--phx-doc-muted); font-size: 6.8pt; line-height: 1.4; }
  .sheet__foot span { min-width: 0; overflow-wrap: anywhere; }
  .sheet__foot span:last-child { text-align: right; white-space: nowrap; }
`;

type TableColumn = { label: string; width: number };

const EDUCATION_COLUMNS: readonly TableColumn[] = [
  { label: "Degree / course", width: 34 },
  { label: "University", width: 32 },
  { label: "Year of graduation", width: 16 },
  { label: "Grade", width: 18 },
];

const EMPLOYMENT_COLUMNS: readonly TableColumn[] = [
  { label: "Company name", width: 28 },
  { label: "Position", width: 26 },
  { label: "Start (month / year)", width: 15 },
  { label: "End (month / year)", width: 15 },
  { label: "Package", width: 16 },
];

const REFERENCE_COLUMNS: readonly TableColumn[] = [
  { label: "Name", width: 28 },
  { label: "Title", width: 24 },
  { label: "Company", width: 26 },
  { label: "Phone no.", width: 22 },
];

/**
 * One labelled field of the form. An empty value is an empty line to write on. `bare` leaves the label off for a
 * field the heading above already names, so the words are not printed twice.
 */
function fieldHtml(cell: FormCell, options: { bare?: boolean; name?: boolean; wide?: boolean } = {}): string {
  const note = cell.note ? `<span class="note" dir="auto">${escapeHtml(cell.note)}</span>` : "";
  const label = options.bare ? "" : `<span class="l">${escapeHtml(cell.label)}</span>`;
  return `<div class="f${options.wide ? " f--wide" : ""}">${label}<span class="v${
    options.name ? " v--name" : ""
  }" dir="auto">${escapeHtml(cell.value)}${note}</span></div>`;
}

/** A ruled table with the old form's column heads, padded with empty lines up to the rows the paper form had. */
function tableHtml(columns: readonly TableColumn[], rows: readonly (readonly string[])[], minimumRows: number): string {
  const blank = columns.map(() => "");
  const padded = [...rows, ...Array.from({ length: Math.max(0, minimumRows - rows.length) }, () => blank)];
  const widths = columns.map((column) => `<col style="width:${column.width}%">`).join("");
  const heads = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
  const body = padded
    .map((row) => `<tr>${row.map((value) => `<td dir="auto">${escapeHtml(value)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><colgroup>${widths}</colgroup><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table>`;
}

/** The three boxes of "Employment type". Nothing records the answer, so none is ticked. */
function employmentTypeHtml(): string {
  const options = EMPLOYMENT_TYPES.map((type) => `<span class="opt"><span class="box"></span>${escapeHtml(type)}</span>`).join("");
  return `<div class="f f--wide"><span class="l">Employment type</span><span class="opts">${options}</span></div>`;
}

/** The sheet as a document. `markDataUri` is the on-light company mark; without it the mark is left off. */
export function buildApplicationSheetHtml(sheet: ApplicationSheet, markDataUri: string | null): string {
  const { form } = sheet;

  // The cells come in the paper form's own order (see ApplicationForm); the two columns pair the short ones,
  // so the phone sits beside the email and the birthday beside the marital status, with the name and the
  // address across the full width.
  const [fullName, phone, address, email, birth, marital] = form.personal;
  const personal = [
    fieldHtml(fullName, { name: true, wide: true }),
    fieldHtml(phone),
    fieldHtml(email),
    fieldHtml(address, { wide: true }),
    fieldHtml(birth),
    fieldHtml(marital),
  ].join("");

  // The old form's order: position, salary, employment type, date available. Region rides at the end.
  const [position, salary, region, start] = form.desired;
  const desired = [
    fieldHtml(position),
    fieldHtml(salary),
    employmentTypeHtml(),
    fieldHtml(start),
    fieldHtml(region),
  ].join("");

  const education = tableHtml(
    EDUCATION_COLUMNS,
    form.education.map((item) => [item.course, item.university, item.year, item.grade]),
    FORM_EDUCATION_ROWS,
  );
  const employment = tableHtml(
    EMPLOYMENT_COLUMNS,
    // The package at each job is on the paper form and nowhere in the system, so it stays an empty column.
    form.employment.map((item) => [item.company, item.position, item.start, item.end, ""]),
    FORM_EMPLOYMENT_ROWS,
  );
  const references = tableHtml(REFERENCE_COLUMNS, [], FORM_REFERENCE_ROWS);

  // Whole rows of three, so the last row is never ragged: an empty form shows six numbered lines, not four.
  const skillSlots = Math.ceil(Math.max(FORM_SKILL_SLOTS, form.skills.length) / FORM_SKILL_COLUMNS) * FORM_SKILL_COLUMNS;
  const skills = Array.from({ length: skillSlots }, (_, index) =>
    `<div class="sk"><span class="n">${index + 1}</span><span class="v" dir="auto">${escapeHtml(form.skills[index] ?? "")}</span></div>`,
  ).join("");

  const rows = sheet.entries
    .map(
      (entry, index) =>
        `<tr><td class="n">${index + 1}</td><td class="q" dir="auto">${escapeHtml(entry.question)}</td><td class="a" dir="auto">${escapeHtml(entry.answer)}${
          entry.note ? `<span class="note" dir="auto">${escapeHtml(entry.note)}</span>` : ""
        }</td></tr>`,
    )
    .join("");

  // The document names itself for what it is: a WhatsApp application when there was a conversation, else a
  // plain Job application built from the record. Everything above this line is identical either way.
  const docLabel = sheet.hasWhatsApp ? "WhatsApp application" : "Job application";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(`${sheet.name} — ${docLabel}`)}</title>
<style>${SHEET_CSS}</style></head>
<body>
<div class="sheet">
  <header class="lh">
    <div class="lh__mark">${markDataUri ? `<img src="${markDataUri}" alt="">` : ""}</div>
    <div class="lh__id"><strong>Sato Pharma</strong><span dir="ltr">Recruitment · ${escapeHtml(docLabel)}</span></div>
  </header>
  <div class="lh__rule"></div>
  <div class="sheet__body">
    <div class="top">
      <h1 class="eyebrow">Job application form</h1>
      ${sheet.appliedLabel ? `<p class="applied">${escapeHtml(sheet.appliedLabel)}</p>` : ""}
    </div>
    <h2>Personal information</h2>
    <div class="grid">${personal}</div>
    <h2>Employment desired</h2>
    <div class="grid">${desired}</div>
    <h2>Education</h2>
    ${education}
    <h2>Previous employment</h2>
    ${employment}
    <h2>Skills</h2>
    <div class="skills">${skills}</div>
    <h2>References</h2>
    ${references}
    <h2>${escapeHtml(form.heardAbout.label)}</h2>
    <div class="grid">${fieldHtml(form.heardAbout, { bare: true, wide: true })}</div>
    ${
      sheet.hasWhatsApp
        ? `<h2>WhatsApp questions and answers</h2>
    <table class="qa"><tbody>${rows}</tbody></table>
    <p class="outcome${sheet.finished ? "" : " outcome--open"}" dir="auto">${escapeHtml(sheet.outcome)}</p>`
        : ""
    }
  </div>
  <footer class="sheet__foot">
    <span dir="auto">${escapeHtml(sheet.cvLine)}</span>
    <span>${escapeHtml(`${HOUSE_DOCUMENT_STANDARD} · ${sheet.printedLabel}`)}</span>
  </footer>
</div>
</body></html>`;
}
