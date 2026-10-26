import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { findAccessRegistryEntry, type PermissionRequirement } from "../src/lib/security/access-registry.ts";
import type { WhatsAppApplicantRow } from "../src/lib/recruitment/whatsapp-applicant-filters.ts";
import {
  applicationFileName,
  attachmentDisposition,
  whatsAppApplicationApiPath,
  whatsAppApplicationPrintPath,
  whatsAppApplicationTextPath,
} from "../src/lib/recruitment/whatsapp-application-file.ts";
import {
  PRINT_CSS,
  PRINT_PAGE_CLASS,
  PRINT_PAGE_LANDSCAPE_CLASS,
  SCREEN_ONLY_CLASS,
} from "../src/lib/recruitment/whatsapp-application-print-css.ts";
import {
  buildApplicationForm,
  EMPLOYMENT_TYPES,
  formatDateOfBirth,
  formatMonthYear,
  type ApplicationCandidate,
} from "../src/lib/recruitment/whatsapp-application-form.ts";
import {
  buildApplicationSheet,
  buildApplicationSheetHtml,
  FIT_TO_ONE_PAGE_SCRIPT,
  FORM_EDUCATION_ROWS,
  FORM_EMPLOYMENT_ROWS,
  FORM_REFERENCE_ROWS,
  FORM_SKILL_COLUMNS,
  FORM_SKILL_SLOTS,
  MIN_SCALE,
} from "../src/lib/recruitment/whatsapp-application-sheet.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Applicants — "Download application" and "Print application" (the owner, 2026-09-19).
//
// Beside the CV he already downloads: the CV exactly as it was sent, then ONE page holding the old paper
// Job Application Form's every field and everything the bot asked and she answered, in the house style and
// with almost no ink. Pinned here:
//
//   1. the sheet says what the list says — the same questions, the same answers, in the order the bot
//      asked them — and never puts a guess in the bot's mouth;
//   2. EVERY field of the old paper form is on it, filled from the record where the record has it and left
//      as an empty line where it does not, and never filled with a guess;
//   3. it is built to stay ON ONE PAPER, and to escape everything a stranger typed;
//   4. the saved file's name and the download header survive an Arabic name and a hostile one;
//   5. the route, the print page and the registry all carry the SAME gate as the list that offers the
//      buttons, and the CV download the cell already had is left alone;
//   6. it reads the structured conversation, never the raw chat store the rest of HR may not open.
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_ID = "5b1c1f0e-3a0e-4c1e-9d63-5a7c2f0e8b11";
const NOW = new Date("2026-09-19T12:12:00.000Z");

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function row(overrides: Partial<WhatsAppApplicantRow> = {}): WhatsAppApplicantRow {
  return {
    answers: [
      { answer: "Pharmacy", key: "background", question: "What did you graduate in?" },
      { answer: "Haram", key: "area", question: "Which area?" },
      { answer: "3 years", key: "experience", question: "How much experience?" },
      { answer: "28000", key: "salary", question: "Expected salary" },
      { answer: "Two weeks after the offer", key: "extra:start", question: "If you were offered the job, when could you start?" },
    ],
    appliedAt: "2026-09-14T09:12:00.000Z",
    candidateId: "0b6f7a52-3a0e-4c1e-9d63-5a7c2f0e8b11",
    finished: true,
    key: "0b6f7a52-3a0e-4c1e-9d63-5a7c2f0e8b11::medical_rep",
    name: "Aya Mohamed Khedr",
    region: { label: "Giza", source: "whatsapp", sourceLine: "Their WhatsApp answer" },
    sessionId: SESSION_ID,
    status: "new",
    statusLabel: "New",
    stillOpen: false,
    titleValue: "medical_rep",
    typedTitle: null,
    values: {},
    waitingOn: null,
    ...overrides,
  };
}

/** What the CV reader and the bot left on her record — a full one, so a field that goes missing is noticed. */
const CANDIDATE: ApplicationCandidate = {
  address: "12 Tahrir Street, Dokki, Giza",
  currentEmployer: null,
  currentJobTitle: null,
  dateOfBirth: "1996-05-14",
  declaredExpectedSalary: null,
  degree: null,
  expectedSalary: null,
  faculty: null,
  grade: null,
  graduationYear: null,
  maritalStatus: "single",
  noticePeriod: null,
  positionSpecificFields: {
    educationHistory: [
      { degree: "Bachelor of Pharmacy", fieldOfStudy: "Pharmaceutical Sciences", grade: "Very Good", institution: "Cairo University", year: "2018" },
    ],
    skills: ["Excel", { name: "Customer service" }, "excel", "  "],
    workHistory: [
      { employer: "Teleperformance", from: "2021-09-01", isCurrent: false, jobTitle: "Customer Service Agent", to: "2023-06-01" },
      { employer: "El Ezaby Pharmacy", from: "2018-11", jobTitle: "Pharmacist", to: null },
      { employer: "Medmark", from: "2025-07-01", isCurrent: true, jobTitle: "Senior Account Manager", to: null },
    ],
  },
  source: "whatsapp",
  university: null,
};

/** A record with nothing on it but the fields every candidate row has. */
const BARE_CANDIDATE: ApplicationCandidate = {
  address: null,
  currentEmployer: null,
  currentJobTitle: null,
  dateOfBirth: null,
  declaredExpectedSalary: null,
  degree: null,
  expectedSalary: null,
  faculty: null,
  grade: null,
  graduationYear: null,
  maritalStatus: null,
  noticePeriod: null,
  positionSpecificFields: {},
  source: null,
  university: null,
};

function sheetOf(
  overrides: Partial<WhatsAppApplicantRow> = {},
  contact: { email: string | null; phone: string | null } = { email: "aya@example.com", phone: "+20 100 555 0142" },
  candidate: ApplicationCandidate | null = CANDIDATE,
) {
  return buildApplicationSheet({
    candidate,
    contact,
    cvLine: "The CV she sent comes first, on the pages before this one.",
    now: NOW,
    row: row(overrides),
    titleLabel: "Medical Representative",
  });
}

function runSheetContentTests() {
  // ── 1 · The questions, in the order the bot asked them ───────────────────────────────────────
  const sheet = sheetOf();
  assert.deepEqual(
    sheet.entries.map((entry) => entry.question),
    [
      "What are you applying for?",
      "What did you graduate in?",
      "Which region?",
      "Which area?",
      "How much experience?",
      "Expected salary",
      "If you were offered the job, when could you start?",
    ],
    "job first, then the degree, the region the bot asked between the degree and the area, then the rest",
  );
  assert.equal(sheet.entries[0]!.answer, "Medical Representative", "the job is the title they chose");
  assert.equal(sheet.entries[2]!.answer, "Giza");
  assert.equal(sheet.entries[2]!.note, null, "a tapped region carries no note — 'Their WhatsApp answer' would only repeat the column");
  assert.equal(sheet.name, "Aya Mohamed Khedr");
  assert.equal(sheet.jobTitle, "Medical Representative");
  assert.equal(sheet.finished, true);
  assert.equal(sheet.outcome, "Answered every question the bot asked.");
  assert.equal(sheet.printedLabel, "Printed 19 Sept 2026 · 15:12 (Cairo)", "the printed time is Cairo local, never UTC");
  assert.equal(sheet.appliedLabel, "Applied 14 Sept 2026 · 12:12 (Cairo)", "the applied time is Cairo local, never UTC");
  assert.equal(sheetOf({ appliedAt: "not a date" }).appliedLabel, "", "no usable date prints no 'Applied —' line at all");
  assert.deepEqual(
    sheet.form.desired[2],
    { label: "Region", note: null, value: "Giza" },
    "a tapped region is on the form as well as an entry, and 'Their WhatsApp answer' would only repeat the column",
  );

  // A title they typed for "Other" wins over the label of the family it was filed under.
  assert.equal(sheetOf({ typedTitle: "Pharma sales lead" }).jobTitle, "Pharma sales lead");
  assert.equal(sheetOf({ typedTitle: "   " }).jobTitle, "Medical Representative", "a blank typed title is no title");
  assert.equal(sheetOf({ typedTitle: "Pharma sales lead" }).form.desired[0]!.value, "Pharma sales lead", "and it is the form's Position");

  // A typed region keeps their own words under the company region it was filed into.
  const typed = sheetOf({ region: { label: "Upper Egypt", source: "whatsapp", sourceLine: "They wrote: Minya" } });
  assert.equal(typed.entries.find((entry) => entry.question === "Which region?")!.note, "They wrote: Minya");
  assert.equal(typed.form.desired[2]!.note, "They wrote: Minya", "the form's Region keeps their own words too");

  // ── 2 · A region nobody asked is on the form with its source, never a question ───────────────
  const fromCv = sheetOf({ region: { label: "Cairo", source: "cv", sourceLine: "From the address on their CV" } });
  assert.ok(!fromCv.entries.some((entry) => entry.question === "Which region?"), "a CV's address is not the bot's question");
  assert.deepEqual(fromCv.form.desired[2], { label: "Region", note: "From the address on their CV", value: "Cairo" });
  const nobody = sheetOf({ region: null });
  assert.deepEqual(nobody.form.desired[2], { label: "Region", note: null, value: "" }, "no region is an empty line to write on, not a dash");

  // ── 3 · A form's gap is an empty line, never a dash and never a guess ────────────────────────
  const noContact = sheetOf({}, { email: null, phone: "  " });
  assert.equal(noContact.form.personal[1]!.value, "", "no phone is an empty line");
  assert.equal(noContact.form.personal[3]!.value, "", "no email is an empty line");
  assert.equal(sheet.form.personal[1]!.value, "+20 100 555 0142");
  assert.equal(sheet.form.personal[3]!.value, "aya@example.com");

  // ── 4 · How it ended, in one sentence ───────────────────────────────────────────────────────
  assert.equal(
    sheetOf({ finished: false, stillOpen: true, waitingOn: "How much experience?" }).outcome,
    "Chat still open. Waiting for the answer to: How much experience?",
  );
  assert.equal(
    sheetOf({ finished: false, stillOpen: false, waitingOn: "How much experience?" }).outcome,
    "Stopped answering at: How much experience?",
  );
  assert.equal(
    sheetOf({ finished: false, stillOpen: false, waitingOn: null }).outcome,
    "Did not answer every question the bot asked.",
  );
}

function runApplicationFormTests() {
  const contact = { email: "aya@example.com", phone: "+20 100 555 0142" };
  const formOf = (overrides: Partial<WhatsAppApplicantRow> = {}, candidate: ApplicationCandidate | null = CANDIDATE) =>
    buildApplicationForm({ candidate, contact, jobTitle: "Medical Representative", row: row(overrides) });

  // ── The two date shapes the old form asked for ──────────────────────────────────────────────
  assert.equal(formatDateOfBirth("1996-05-14"), "14 May 1996");
  assert.equal(formatDateOfBirth("2001-09-03"), "03 Sept 2001", "the app's own month table, with Sept, and two-digit days");
  assert.equal(formatDateOfBirth("1996-05-14T22:30:00.000Z"), "14 May 1996", "a calendar date, never shifted into Cairo time");
  assert.equal(formatDateOfBirth("May 1996"), "May 1996", "a half date is printed as the record has it");
  assert.equal(formatDateOfBirth("1996-13-45"), "1996-13-45", "an impossible date is printed as stored, not as a dash");
  assert.equal(formatDateOfBirth(null), "");
  assert.equal(formatMonthYear("2021-09-01"), "Sept 2021", "the old form asked month and year; the day is dropped");
  assert.equal(formatMonthYear("2018-11"), "Nov 2018");
  assert.equal(formatMonthYear("2021"), "2021");
  assert.equal(formatMonthYear("Present"), "Present", "text that is not a date is printed as the record has it");
  assert.equal(formatMonthYear(null), "");

  // ── The record, in the paper form's own shape and order ─────────────────────────────────────
  const form = formOf();
  assert.deepEqual(
    form.personal.map((cell) => cell.label),
    ["Full name", "Phone number", "Address", "Email", "Date of birth", "Marital status"],
    "the old form's personal information, in its own order",
  );
  assert.deepEqual(
    form.desired.map((cell) => cell.label),
    ["Position", "Expectation for salary", "Region", "Date available to start"],
    "the old form's employment desired, with Region after them (the sheet draws employment type between salary and date)",
  );
  assert.equal(form.heardAbout.label, "How you heard about this vacancy");
  assert.deepEqual(
    form.personal.map((cell) => cell.value),
    ["Aya Mohamed Khedr", "+20 100 555 0142", "12 Tahrir Street, Dokki, Giza", "aya@example.com", "14 May 1996", "Single"],
    "marital status is capitalised, the birthday is a readable date",
  );
  assert.deepEqual(form.education, [
    { course: "Bachelor of Pharmacy · Pharmaceutical Sciences", grade: "Very Good", university: "Cairo University", year: "2018" },
  ]);
  assert.deepEqual(form.employment, [
    { company: "Teleperformance", end: "Jun 2023", position: "Customer Service Agent", start: "Sept 2021" },
    { company: "El Ezaby Pharmacy", end: "", position: "Pharmacist", start: "Nov 2018" },
    { company: "Medmark", end: "Present", position: "Senior Account Manager", start: "Jul 2025" },
  ]);
  assert.equal(form.employment[1]!.end, "", "no end date and no isCurrent flag stays empty: the reader found no end, and 'Present' would claim a current job the CV never named");
  assert.equal(form.employment[2]!.end, "Present", "the CV said 'Present' (isCurrent), so the paper says it too");
  assert.deepEqual(form.skills, ["Excel", "Customer service"], "a repeated skill in another case and a blank one are dropped");
  assert.deepEqual([...EMPLOYMENT_TYPES], ["Full-time", "Semi-full", "Part-time"], "the old form's three boxes, in its own words");

  // ── A record with no history block still gives the one job and one qualification it names ────
  const plain = formOf(
    {},
    {
      ...BARE_CANDIDATE,
      currentEmployer: "GSK",
      currentJobTitle: "Medical Rep",
      degree: "Pharm D",
      faculty: "Ain Shams",
      grade: "Good",
      graduationYear: 2020,
      university: "Ain Shams University",
    },
  );
  assert.deepEqual(plain.education, [{ course: "Pharm D · Ain Shams", grade: "Good", university: "Ain Shams University", year: "2020" }]);
  assert.deepEqual(plain.employment, [{ company: "GSK", end: "", position: "Medical Rep", start: "" }]);
  const nothing = formOf({}, BARE_CANDIDATE);
  assert.deepEqual([nothing.education, nothing.employment, nothing.skills], [[], [], []], "a bare record has no invented rows");
  assert.deepEqual(
    [nothing.personal[2]!.value, nothing.personal[4]!.value, nothing.personal[5]!.value],
    ["", "", ""],
    "and its address, birthday and marital status are empty lines",
  );
  const gone = formOf({}, null);
  assert.deepEqual([gone.education, gone.employment, gone.skills], [[], [], []], "a candidate row that could not be read back still gives a form");
  assert.equal(gone.personal[0]!.value, "Aya Mohamed Khedr", "and the name and phone still come from the row and contact");

  // ── Expectation for salary: her own words first, then what the record kept ───────────────────
  const salaryOf = (answers: WhatsAppApplicantRow["answers"], candidate: ApplicationCandidate) => formOf({ answers }, candidate).desired[1]!.value;
  const typedSalary = [{ answer: "28000", key: "salary", question: "Expected salary" }];
  assert.equal(salaryOf(typedSalary, { ...CANDIDATE, declaredExpectedSalary: "30k", expectedSalary: 25000 }), "28000", "what she answered on WhatsApp wins");
  assert.equal(salaryOf([], { ...CANDIDATE, declaredExpectedSalary: "30k negotiable", expectedSalary: 25000 }), "30k negotiable");
  assert.equal(salaryOf([], { ...CANDIDATE, expectedSalary: 25000 }), "25,000", "a bare number gets separators and no currency, which nothing stores");
  assert.equal(salaryOf([], CANDIDATE), "", "no figure anywhere is an empty line, never a zero");

  // ── Date available to start: HR's own question, else the notice period on the record ─────────
  const startOf = (answers: WhatsAppApplicantRow["answers"], candidate: ApplicationCandidate) => formOf({ answers }, candidate).desired[3]!;
  assert.deepEqual(startOf(row().answers, CANDIDATE), {
    label: "Date available to start",
    note: null,
    value: "Two weeks after the offer",
  });
  assert.equal(
    startOf([{ answer: "Yes", key: "extra:commute", question: "Can you start commuting to Sheraton?" }], CANDIDATE).value,
    "",
    "a question that only contains the word 'start' is not the start date",
  );
  assert.equal(startOf([{ answer: "Yes", key: "extra:avail", question: "Are you available immediately?" }], CANDIDATE).value, "Yes");
  assert.equal(
    startOf([{ answer: "Immediately", key: "area", question: "When could you start? Which area?" }], CANDIDATE).value,
    "",
    "only a question HR added is read for it, never one of the bot's own",
  );
  assert.deepEqual(startOf([], { ...CANDIDATE, noticePeriod: "30 days" }), {
    label: "Date available to start",
    note: "Notice period on the record",
    value: "30 days",
  });

  // ── How you heard: the channel it arrived by, and nothing for a hand-typed record ────────────
  const heardOf = (source: string | null) => formOf({}, { ...CANDIDATE, source }).heardAbout.value;
  assert.equal(heardOf("whatsapp"), "WhatsApp");
  assert.equal(heardOf("email"), "Email");
  assert.equal(heardOf(null), "", "'Manual' is not how anyone heard about a vacancy");
}

function runSheetHtmlTests() {
  const sheet = sheetOf();
  const html = buildApplicationSheetHtml(sheet, null);

  assert.equal(html.match(/<div class="sheet">/g)?.length, 1, "exactly one sheet, so one paper");
  assert.ok(!html.includes("<img"), "no mark given, no image");
  assert.ok(!html.includes("…"), "no ellipsis anywhere on the paper");
  assert.ok(
    html.includes(".sheet { display: flex; flex-direction: column; width: 210mm; height: 296mm;"),
    "the sheet is 296 mm, one millimetre short of A4, so rounding cannot spill a blank second page",
  );
  assert.ok(html.includes("break-after: avoid"), "the sheet asks not to be followed by a page break");
  assert.ok(html.includes("border-radius: 0"), "square edges");
  assert.ok(html.includes("@page { size: A4 portrait; margin: 0; }"));
  assert.ok(html.includes("WhatsApp questions and answers"), "the questions and answers still follow the form");
  assert.ok(html.includes(">1</td>") && html.includes(">7</td>"), "the questions are numbered");

  // Every piece of text a stranger typed reads from its own side.
  assert.ok(html.includes('<span class="v v--name" dir="auto">Aya Mohamed Khedr</span>'), "the name is the first field and the biggest thing on the page");
  assert.ok(html.includes('<td class="q" dir="auto">Expected salary</td>'));
  assert.ok(html.includes('<td class="a" dir="auto">28000</td>'));

  // ── THE OLD PAPER FORM: every one of its fields is on the sheet ──────────────────────────────
  for (const heading of [
    "Personal information",
    "Employment desired",
    "Education",
    "Previous employment",
    "Skills",
    "References",
    "How you heard about this vacancy",
  ]) {
    assert.ok(html.includes(`<h2>${heading}</h2>`), `the form's "${heading}" section is on the sheet`);
  }
  for (const label of [
    "Full name",
    "Phone number",
    "Address",
    "Email",
    "Date of birth",
    "Marital status",
    "Position",
    "Expectation for salary",
    "Employment type",
    "Date available to start",
    "Degree / course",
    "University",
    "Year of graduation",
    "Grade",
    "Company name",
    "Start (month / year)",
    "End (month / year)",
    "Package",
    "Name",
    "Title",
    "Company",
    "Phone no.",
  ]) {
    assert.ok(html.includes(`>${label}</`), `the old form's "${label}" is on the sheet`);
  }
  for (const type of EMPLOYMENT_TYPES) {
    assert.ok(html.includes(`<span class="box"></span>${type}</span>`), `the "${type}" box is drawn`);
  }
  assert.equal(html.match(/class="box"/g)?.length, 3, "three empty boxes: nothing records the employment type, so none is ticked");
  assert.ok(!html.includes("☐"), "the boxes are drawn, not a glyph a font might not have");

  // What the record holds is printed, in the form's own shape.
  for (const printed of [
    "12 Tahrir Street, Dokki, Giza",
    "14 May 1996",
    "Single",
    "Bachelor of Pharmacy · Pharmaceutical Sciences",
    "Cairo University",
    "Very Good",
    "Teleperformance",
    "Customer Service Agent",
    "Sept 2021",
    "Jun 2023",
    "El Ezaby Pharmacy",
    "Nov 2018",
    "Medmark",
    "Jul 2025",
    "Present",
    "Customer service",
  ]) {
    assert.ok(html.includes(`>${printed}<`), `"${printed}" is printed on the form`);
  }
  assert.ok(
    html.includes('<span class="l">Expectation for salary</span><span class="v" dir="auto">28000</span>'),
    "the salary she typed is the form's Expectation for salary, not only a line further down",
  );
  assert.ok(
    html.includes('<span class="l">Date available to start</span><span class="v" dir="auto">Two weeks after the offer</span>'),
    "the answer to HR's own 'when could you start' question is the form's Date available to start",
  );
  assert.ok(html.includes('<span class="l">Position</span><span class="v" dir="auto">Medical Representative</span>'));
  assert.ok(
    html.includes('<h2>How you heard about this vacancy</h2>\n    <div class="grid"><div class="f f--wide"><span class="v" dir="auto">WhatsApp</span></div></div>'),
    "how they heard is the heading with the channel on the line under it, as on the paper form",
  );
  assert.equal(html.split("How you heard about this vacancy").length - 1, 1, "and the words are printed once, not as a heading and again as a label");

  // The paper form's empty lines stay when the record has fewer rows than the form had.
  const educationTable = html.slice(html.indexOf("<h2>Education</h2>"), html.indexOf("<h2>Previous employment</h2>"));
  assert.equal(educationTable.match(/<tr>/g)?.length, 1 + FORM_EDUCATION_ROWS, "the column heads plus the paper form's three education lines");
  const employmentTable = html.slice(html.indexOf("<h2>Previous employment</h2>"), html.indexOf("<h2>Skills</h2>"));
  assert.equal(employmentTable.match(/<tr>/g)?.length, 1 + FORM_EMPLOYMENT_ROWS, "the heads plus the paper form's four job lines");
  const referencesTable = html.slice(html.indexOf("<h2>References</h2>"), html.indexOf("<h2>How you heard about this vacancy</h2>"));
  assert.equal(referencesTable.match(/<tr>/g)?.length, 1 + FORM_REFERENCE_ROWS, "the heads plus the two reference lines, empty for every applicant");
  assert.ok(!/<td[^>]*>[^<]/.test(referencesTable), "nothing in the system holds a reference, so none is printed");
  const skillsBlock = html.slice(html.indexOf("<h2>Skills</h2>"), html.indexOf("<h2>References</h2>"));
  assert.equal(
    skillsBlock.match(/class="sk"/g)?.length,
    Math.ceil(FORM_SKILL_SLOTS / FORM_SKILL_COLUMNS) * FORM_SKILL_COLUMNS,
    "the paper form's four skill lines, drawn in whole rows of three so the last row is never ragged: six lines, two filled from the CV",
  );
  assert.ok(skillsBlock.includes(">Excel<") && skillsBlock.includes(">Customer service<"), "the two skills on the record are the first two lines");

  // A record with more rows than the paper had prints every one of them, never a silent cut.
  const many = buildApplicationSheetHtml(
    sheetOf(
      {},
      undefined,
      {
        ...CANDIDATE,
        positionSpecificFields: {
          educationHistory: Array.from({ length: 5 }, (_, index) => ({ degree: `Degree ${index + 1}`, institution: `University ${index + 1}` })),
          skills: Array.from({ length: 9 }, (_, index) => `Skill ${index + 1}`),
          workHistory: Array.from({ length: 7 }, (_, index) => ({ employer: `Employer ${index + 1}`, jobTitle: `Role ${index + 1}` })),
        },
      },
    ),
    null,
  );
  for (let index = 1; index <= 5; index += 1) assert.ok(many.includes(`>Degree ${index}</`), `education line ${index} is printed`);
  for (let index = 1; index <= 7; index += 1) assert.ok(many.includes(`>Employer ${index}</`), `job ${index} is printed`);
  for (let index = 1; index <= 9; index += 1) assert.ok(many.includes(`>Skill ${index}</`), `skill ${index} is printed`);
  const manySkills = many.slice(many.indexOf("<h2>Skills</h2>"), many.indexOf("<h2>References</h2>"));
  assert.equal(manySkills.match(/class="sk"/g)?.length, 9, "nine skills fill three whole rows of three");
  const tenSkills = buildApplicationSheetHtml(
    sheetOf({}, undefined, { ...CANDIDATE, positionSpecificFields: { skills: Array.from({ length: 10 }, (_, index) => `Skill ${index + 1}`) } }),
    null,
  );
  const tenBlock = tenSkills.slice(tenSkills.indexOf("<h2>Skills</h2>"), tenSkills.indexOf("<h2>References</h2>"));
  assert.equal(tenBlock.match(/class="sk"/g)?.length, 12, "ten skills round up to twelve lines, the last row never ragged");
  assert.ok(tenBlock.includes(">Skill 10<"), "and the tenth is printed");

  // A candidate with a bare record still gets the whole form: every field is there and every one is empty.
  const bare = buildApplicationSheetHtml(sheetOf({ answers: [], region: null }, { email: null, phone: null }, BARE_CANDIDATE), null);
  assert.ok(bare.includes(">Marital status</") && bare.includes(">Date of birth</"), "a bare record still prints every field's label");
  assert.equal(bare.match(/<td dir="auto"><\/td>/g)?.length, (FORM_EDUCATION_ROWS * 4) + (FORM_EMPLOYMENT_ROWS * 5) + (FORM_REFERENCE_ROWS * 4), "and every table line is empty, for a pen");
  const noRecord = buildApplicationSheetHtml(sheetOf({}, undefined, null), null);
  assert.ok(noRecord.includes("<h2>Education</h2>") && noRecord.includes(">Address</"), "a candidate row that could not be read back still gets the form");

  // The company mark is the on-light one the caller hands over, and only that.
  const marked = buildApplicationSheetHtml(sheet, "data:image/png;base64,AAAA");
  assert.equal(marked.match(/<img /g)?.length, 1);
  assert.ok(marked.includes('<img src="data:image/png;base64,AAAA" alt="">'));

  // ── A stranger's name and answers are text, never markup ────────────────────────────────────
  const hostile = buildApplicationSheetHtml(
    sheetOf(
      {
        answers: [{ answer: "<script>alert(1)</script> & 'quotes'", key: "salary", question: "Expected <b>salary</b>" }],
        name: "<img src=x onerror=alert(1)>",
        typedTitle: '"><svg onload=alert(2)>',
      },
      { email: "<iframe src=x>@example.com", phone: "<u>0100</u>" },
      {
        ...CANDIDATE,
        address: "<marquee>Giza</marquee>",
        positionSpecificFields: {
          educationHistory: [{ degree: "<object data=x>", institution: "<embed src=x>" }],
          skills: ["<video src=x onerror=alert(3)>"],
          workHistory: [{ employer: "<link rel=x>", jobTitle: "<form action=x>" }],
        },
      },
    ),
    null,
  );
  assert.ok(!hostile.includes("<img"), "a name cannot open an image tag");
  assert.ok(!hostile.includes("<svg"), "a typed job title cannot open an svg tag");
  assert.ok(!hostile.includes("<script"), "an answer cannot open a script tag");
  assert.ok(!hostile.includes("<b>salary"), "a question cannot open a tag");
  assert.ok(hostile.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(hostile.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; "));
  // The form's own fields come from a CV a stranger wrote, so they are text too.
  for (const tag of ["<iframe", "<u>", "<marquee", "<object", "<embed", "<video", "<link", "<form"]) {
    assert.ok(!hostile.includes(tag), `${tag} from the record or the contact cannot open a tag`);
  }
  assert.ok(hostile.includes("&lt;marquee&gt;Giza&lt;/marquee&gt;"), "an address is escaped");
  assert.ok(hostile.includes("&lt;video src=x onerror=alert(3)&gt;"), "a skill is escaped");

  // ── The paper is a fixed page with no fills and no rounded corners ──────────────────────────
  const sheetStyle = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  assert.ok(!/border-radius:\s*[1-9]/.test(sheetStyle), "no rounded corner anywhere in the sheet's stylesheet");
}

function runFitToOnePageTests() {
  // It shrinks the type until the body stops overflowing, and only then, so a short application keeps
  // full-size type and a long one shrinks instead of spilling onto a second sheet.
  assert.ok(FIT_TO_ONE_PAGE_SCRIPT.includes(".sheet__body"), "it measures the sheet's own body");
  assert.ok(FIT_TO_ONE_PAGE_SCRIPT.includes("scrollHeight > body.clientHeight"), "it measures overflow, not the answer count");
  assert.ok(FIT_TO_ONE_PAGE_SCRIPT.includes(`k > ${MIN_SCALE}`), "and it stops at the smallest readable size");
  assert.ok(FIT_TO_ONE_PAGE_SCRIPT.includes("sheet--flow"), "below that size it lets a second page happen rather than clip an answer");
  assert.ok(FIT_TO_ONE_PAGE_SCRIPT.includes("JSON.stringify({ fits, k })"), "it reports what it settled on");
  assert.ok(MIN_SCALE >= 0.5 && MIN_SCALE <= 0.7, `the smallest type is still readable (got ${MIN_SCALE})`);

  // It is one expression the browser can evaluate on its own: nothing from this module is inside it.
  const documentStub = { classes: [] as string[] };
  const properties = new Map<string, string>();
  const evaluate = new Function(
    "document",
    `return ${FIT_TO_ONE_PAGE_SCRIPT};`,
  ) as (document: unknown) => string;
  const answer = JSON.parse(
    evaluate({
      documentElement: { style: { setProperty: (name: string, value: string) => properties.set(name, value) } },
      querySelector: (selector: string) =>
        selector === ".sheet__body"
          ? // Overflows until the type has shrunk to 0.7 of its size, then fits.
            {
              get clientHeight() {
                return 100;
              },
              get scrollHeight() {
                return Number(properties.get("--k")) > 0.7 ? 240 : 90;
              },
            }
          : { classList: { add: (name: string) => documentStub.classes.push(name) } },
    }),
  ) as { fits: boolean; k: number };
  assert.equal(answer.fits, true, "a body that fits once the type shrinks is reported as fitting");
  assert.ok(answer.k <= 0.7 && answer.k > MIN_SCALE, `it stopped at the first size that fits, not the smallest (${answer.k})`);
  assert.deepEqual(documentStub.classes, [], "a sheet that fits is not allowed to flow onto a second page");

  const overflowing = JSON.parse(
    evaluate({
      documentElement: { style: { setProperty: () => undefined } },
      querySelector: (selector: string) =>
        selector === ".sheet__body"
          ? { clientHeight: 100, scrollHeight: 900 }
          : { classList: { add: (name: string) => documentStub.classes.push(name) } },
    }),
  ) as { fits: boolean; k: number };
  assert.equal(overflowing.fits, false);
  assert.equal(overflowing.k, MIN_SCALE, "it never shrinks past the smallest readable size");
  assert.deepEqual(documentStub.classes, ["sheet--flow"], "an application too long even then flows onto a second page instead of losing an answer");
}

function runFileNameTests() {
  assert.equal(applicationFileName("Sara Ahmed"), "Sara Ahmed - WhatsApp application.pdf");
  assert.equal(
    applicationFileName('A/B\\C:D*E?F"G<H>I|J'),
    "A B C D E F G H I J - WhatsApp application.pdf",
    "everything a file system refuses is dropped",
  );
  assert.equal(applicationFileName("سارة أحمد"), "سارة أحمد - WhatsApp application.pdf", "an Arabic name stays Arabic");
  assert.equal(applicationFileName("     "), "Applicant - WhatsApp application.pdf", "no name at all still saves under a name");
  assert.equal(applicationFileName(""), "Applicant - WhatsApp application.pdf");
  assert.equal(applicationFileName("a ".repeat(200)).replace(" - WhatsApp application.pdf", "").length <= 80, true, "a very long name is cut to 80 characters");
  assert.ok(!applicationFileName("Ali\r\nSet-Cookie: x=1").includes("\n"), "a line break in a name cannot reach a header");

  // ── The download header, for a name a header cannot carry ───────────────────────────────────
  assert.equal(
    attachmentDisposition("Sara Ahmed - WhatsApp application.pdf"),
    `attachment; filename="Sara Ahmed - WhatsApp application.pdf"; filename*=UTF-8''Sara%20Ahmed%20-%20WhatsApp%20application.pdf`,
  );
  const arabic = attachmentDisposition("سارة أحمد");
  assert.ok(arabic.startsWith('attachment; filename="WhatsApp application.pdf"; filename*=UTF-8\'\''), "an all-Arabic name gets a readable ASCII fallback");
  assert.ok(arabic.includes("%D8%B3%D8%A7%D8%B1%D8%A9"), "and the real name travels percent-encoded");
  const odd = attachmentDisposition("Sara's (copy) *.pdf");
  for (const escaped of ["%27", "%28", "%29", "%2A"]) {
    assert.ok(odd.includes(escaped), `${escaped} is escaped, as RFC 5987 requires`);
  }
  const quoted = attachmentDisposition('A"B\\C.pdf');
  assert.equal(quoted.match(/filename="([^"]*)"/)?.[1], "ABC.pdf", "a quote or backslash cannot break out of the fallback name");
  assert.ok(!/[\r\n]/.test(attachmentDisposition("A\r\nB.pdf")), "a header value never carries a line break");

  // ── Where each half lives ────────────────────────────────────────────────────────────────────
  assert.equal(whatsAppApplicationApiPath(SESSION_ID), `/api/recruitment/whatsapp-applicants/${SESSION_ID}/application`);
  assert.equal(whatsAppApplicationTextPath(SESSION_ID), `/api/recruitment/whatsapp-applicants/${SESSION_ID}/application?format=base64`);
  assert.equal(whatsAppApplicationPrintPath(SESSION_ID), `/print/whatsapp-application/${SESSION_ID}`);
  assert.equal(whatsAppApplicationPrintPath("a/b"), "/print/whatsapp-application/a%2Fb", "an id cannot add a path segment");
  assert.equal(whatsAppApplicationApiPath("a/b?c"), "/api/recruitment/whatsapp-applicants/a%2Fb%3Fc/application");
}

function runPrintCssTests() {
  assert.ok(PRINT_CSS.includes("@page { size: A4 portrait; margin: 0; }"));
  assert.ok(PRINT_CSS.includes("@page wa-landscape { size: A4 landscape; margin: 0; }"), "a wide CV page gets a landscape sheet, not a shrunk portrait one");
  assert.ok(PRINT_CSS.includes("width: 210mm; max-width: none; height: 296mm"), "portrait is 210 x 296, one millimetre short of A4");
  assert.ok(PRINT_CSS.includes("width: 297mm; height: 209mm"), "landscape is 297 x 209 for the same reason");
  assert.ok(PRINT_CSS.includes("break-after: page"), "each drawn page is exactly one sheet");
  assert.ok(PRINT_CSS.includes(".wa-print-page:last-child { break-after: auto"), "and the last one is not followed by a blank sheet");
  assert.ok(PRINT_CSS.includes(`.${SCREEN_ONLY_CLASS} { display: none !important; }`), "the toolbar is not on the paper");
  assert.equal(PRINT_PAGE_CLASS, "wa-print-page");
  assert.equal(PRINT_PAGE_LANDSCAPE_CLASS, "wa-print-page wa-print-page--landscape");
  assert.ok(!PRINT_CSS.includes("border-radius"), "no rounded corners on the printing page");
}

function runGateTests() {
  // ── The route: the same three gates as the list, in the same order, before any read ─────────
  const route = stripComments(read("app/api/recruitment/whatsapp-applicants/[sessionId]/application/route.ts"));
  assert.ok(route.includes('requireRecruitmentAccess(request, "candidates", "read")'), "the candidates grant, because the file names a person and opens their CV");
  assert.ok(route.includes("isHrAuthorityRole(access.role)"));
  assert.ok(route.includes('canAccess(access, "recruitment", "read")'));
  assert.ok(route.includes("status: 403"), "a caller without them is refused, not shown nothing");
  const at = (needle: string) => {
    const index = route.indexOf(needle);
    assert.ok(index >= 0, `${needle} is in the route`);
    return index;
  };
  assert.ok(at("requireRecruitmentAccess(") < at("isUuid(sessionId)"), "signed in and permitted before the id is even looked at");
  assert.ok(at("isUuid(sessionId)") < at("assertExportRateLimit("), "a malformed id is a 404 before it costs a rate-limit slot");
  assert.ok(at("assertExportRateLimit(") < at("loadWhatsAppApplication("), "the export limit is charged before anything is read or rendered");
  assert.ok(at("loadWhatsAppApplication(") < at("buildWhatsAppApplicationPdf("), "a conversation that is not a listed row is a 404 before Chromium starts");
  assert.ok(route.includes('scope: "export:recruitment:whatsapp-application"'));
  assert.ok(route.includes('searchParams.get("format") === "base64"'), "the print page's text form is served");
  assert.ok(route.includes('"Cache-Control": "private, no-store"'), "a person's CV is never cached between the server and the reader");
  assert.ok(route.includes('"X-Content-Type-Options": "nosniff"'));
  assert.ok(route.includes("attachmentDisposition(fileName)"), "the download names its file safely");
  assert.ok(route.includes("applicationFileName(application.row.name)"));

  // ── The registry: the route is a listed export, on the candidates grant ─────────────────────
  const entry = findAccessRegistryEntry("/api/recruitment/whatsapp-applicants/anything/application", "GET");
  assert.ok(entry, "the application route has its own registry entry");
  assert.equal(entry.pattern, "/api/recruitment/whatsapp-applicants/:sessionId/application", "not the recruitment catch-all");
  const permission = entry.permission;
  const requirements: readonly PermissionRequirement[] = permission === null ? [] : "resource" in permission ? [permission] : permission;
  assert.ok(
    requirements.some((requirement) => requirement.resource === "candidates" && requirement.action === "read"),
    "candidates:read",
  );
  assert.equal(entry.audit.classification, "export", "a CV leaving the building is an audited export");
  assert.equal(entry.audit.required, true);

  // ── The print page: outside the shells, so it repeats the shell's gate ─────────────────────
  const page = stripComments(read("app/print/whatsapp-application/[sessionId]/page.tsx"));
  assert.ok(page.includes("index: false") && page.includes("nocache: true") && page.includes("follow: false"), "never indexed, never cached");
  assert.ok(page.includes('export const dynamic = "force-dynamic"'));
  assert.ok(page.includes("if (!isUuid(sessionId)) notFound()"));
  assert.ok(page.includes("redirect(`/login?returnUrl=${encodeURIComponent(whatsAppApplicationPrintPath(sessionId))}`)"), "signed out, it comes back here after the login");
  assert.ok(page.includes("isHrAuthorityRole(access.role)"));
  assert.ok(page.includes('canAccess(access, "recruitment", "read")'));
  assert.ok(page.includes('canAccess(access, "candidates", "read")'));
  assert.ok(
    page.indexOf('redirect("/employee-portals")') < page.indexOf("<WhatsAppApplicationPrint"),
    "the refusal comes before anything is drawn",
  );

  // ── The list: the buttons sit under what the cell already held, and the CV download is untouched ──
  const cell = stripComments(read("src/components/recruitment/whatsapp-applicants-search.tsx"));
  assert.ok(
    /<WhatsAppApplicationActions\s+applicantName=\{row\.name\}\s+className="mt-2"\s+sessionId=\{row\.sessionId\}\s*\/>/.test(cell),
    "the buttons are built from the row's own conversation",
  );
  assert.ok(cell.includes("<ScheduleInterviewButton"), "the interview button the cell already had is still there");
  const actions = stripComments(read("src/components/recruitment/whatsapp-application-actions.tsx"));
  assert.ok(actions.includes("Download application") && actions.includes("Print application"), "both buttons");
  assert.ok(actions.includes("href={whatsAppApplicationPrintPath(sessionId)}"));
  assert.ok(actions.includes('target="_blank"') && actions.includes('rel="noopener noreferrer"'), "Print opens a new tab, so the search he built survives");

  const filters = stripComments(read("src/lib/recruitment/whatsapp-applicant-filters.ts"));
  assert.ok(/sessionId:\s*string;/.test(filters), "a row carries the conversation it shows");
  assert.ok(/sessionId:\s*session\.id,/.test(stripComments(read("src/lib/recruitment/whatsapp-applicants.ts"))), "and the builder fills it");

  // ── It reads the structured conversation, never the raw chat store ─────────────────────────
  const loader = stripComments(read("src/lib/recruitment/whatsapp-applicants-loader.ts"));
  const applicationLoader = loader.slice(loader.indexOf("export async function loadWhatsAppApplication"));
  assert.ok(loader.includes('const SESSIONS_TABLE = "ats_whatsapp_classification_sessions"'));
  assert.ok(
    applicationLoader.length > 100 && applicationLoader.includes(".from(SESSIONS_TABLE)"),
    "the application loader reads the structured conversation, which is what the list shows",
  );
  for (const file of [
    "src/lib/recruitment/whatsapp-application-sheet.ts",
    "src/lib/recruitment/whatsapp-application-pdf.ts",
    "app/api/recruitment/whatsapp-applicants/[sessionId]/application/route.ts",
  ]) {
    assert.ok(!stripComments(read(file)).includes("whatsapp_inbox_messages"), `${file} never reads the raw chat`);
  }
  assert.ok(!applicationLoader.includes("whatsapp_inbox_messages"), "the application loader never reads the raw chat");

  // ── The old form's fields come from the candidate's own record, and reach the sheet ─────────
  assert.ok(
    applicationLoader.includes('.from("ats_candidates").select("*")') && applicationLoader.includes("mapCandidate(data as Record<string, unknown>)"),
    "the whole record is read and mapped the way every recruitment screen maps it",
  );
  assert.ok(/return\s*\{\s*candidate,\s*contact,/.test(applicationLoader), "the application carries the record beside the contact");
  assert.ok(stripComments(read("src/lib/recruitment/whatsapp-application-pdf.ts")).includes("candidate: application.candidate"), "and the PDF hands it to the sheet");
}

export function runWhatsAppApplicationPrintTests() {
  runSheetContentTests();
  runApplicationFormTests();
  runSheetHtmlTests();
  runFitToOnePageTests();
  runFileNameTests();
  runPrintCssTests();
  runGateTests();
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE CV IS SIZED BEFORE ANYTHING OPENS IT (audit, 2026-10-26, point 34). The application PDF opens a
//    stranger's CV with pdf-lib, mammoth and sharp inside the web process. A file over the inbound intake's
//    own byte limit, or a PDF past MAX_APPLICATION_CV_PAGES, is left out — the sheet is still made, and its
//    footer says why — and the byte limit is the intake's knob, never a second number.
// ─────────────────────────────────────────────────────────────────────────────

async function pdfWithPages(count: number, useObjectStreams: boolean): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let index = 0; index < count; index++) doc.addPage([595, 842]);
  return doc.save({ useObjectStreams });
}

export async function runWhatsAppApplicationCvCapTests() {
  const builder = await import("../src/lib/recruitment/whatsapp-application-pdf.ts");
  const { maxInboundCvBytes } = await import("../src/lib/recruitment/inbound/cv-intake-service.ts");
  const { MAX_APPLICATION_CV_PAGES, countPlainPdfPageObjects, cvRefusedBeforeOpening, pdfCv } = builder;
  const limit = maxInboundCvBytes();
  assert.equal(limit, 15 * 1024 * 1024, "the byte limit is the inbound intake's 15 MB");
  assert.equal(MAX_APPLICATION_CV_PAGES, 50, "an application prints at most 50 CV pages");

  // Over the byte limit: left out before pdf-lib, mammoth or sharp — whatever kind of file it is.
  const kinds: Array<[string, string]> = [
    ["application/pdf", "cv.pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "cv.docx"],
    ["image/jpeg", "cv.jpg"],
  ];
  for (const [mimeType, fileName] of kinds) {
    const over = cvRefusedBeforeOpening({ bytes: new Uint8Array(limit + 1), fileName, mimeType });
    assert.ok(over && over.startsWith("CV not included: the file is 15 MB, over the 15 MB a CV may be."), `a ${fileName} one byte over the limit is left out, and the footer says so (${over})`);
    assert.equal(cvRefusedBeforeOpening({ bytes: new Uint8Array(limit), fileName: fileName.replace(".pdf", ".jpg"), mimeType: mimeType === "application/pdf" ? "image/jpeg" : mimeType }), null, `a ${fileName} exactly at the limit may be opened`);
  }

  // The limit is the intake's own knob: move it and the application moves with it.
  const saved = process.env.RECRUITMENT_INBOUND_CV_MAX_BYTES;
  try {
    process.env.RECRUITMENT_INBOUND_CV_MAX_BYTES = "1000";
    assert.ok(cvRefusedBeforeOpening({ bytes: new Uint8Array(1001), fileName: "cv.jpg", mimeType: "image/jpeg" }), "RECRUITMENT_INBOUND_CV_MAX_BYTES moves the application's limit too");
    assert.equal(cvRefusedBeforeOpening({ bytes: new Uint8Array(1000), fileName: "cv.jpg", mimeType: "image/jpeg" }), null);
  } finally {
    if (saved === undefined) delete process.env.RECRUITMENT_INBOUND_CV_MAX_BYTES;
    else process.env.RECRUITMENT_INBOUND_CV_MAX_BYTES = saved;
  }

  // A PDF whose page objects are written in the open is counted before pdf-lib opens it.
  const plainOver = await pdfWithPages(MAX_APPLICATION_CV_PAGES + 1, false);
  assert.equal(countPlainPdfPageObjects(plainOver), MAX_APPLICATION_CV_PAGES + 1, "every /Type /Page is counted, and the /Pages tree is not");
  assert.equal(
    cvRefusedBeforeOpening({ bytes: plainOver, fileName: "cv.pdf", mimeType: "application/pdf" }),
    "CV not included: it has 51 pages, more than the 50 an application prints. Open it from the candidate's page.",
    "a 51-page PDF is left out before pdf-lib opens it",
  );
  const plainAtCap = await pdfWithPages(MAX_APPLICATION_CV_PAGES, false);
  assert.equal(cvRefusedBeforeOpening({ bytes: plainAtCap, fileName: "cv.pdf", mimeType: "application/pdf" }), null, "a 50-page PDF may be opened");
  const atCap = await pdfCv(plainAtCap);
  assert.equal(atCap.pdf?.getPageCount(), 50, "and all 50 of its pages are carried, untouched");
  assert.equal(atCap.line, "CV: PDF, 50 pages, exactly as sent.");

  // A PDF that keeps its pages in compressed object streams counts low on the raw bytes — so pdf-lib's own
  // count stops it before a single page is copied.
  const hiddenOver = await pdfWithPages(MAX_APPLICATION_CV_PAGES + 1, true);
  assert.ok(countPlainPdfPageObjects(hiddenOver) < MAX_APPLICATION_CV_PAGES, "the fixture really hides its page objects from the raw count");
  assert.equal(cvRefusedBeforeOpening({ bytes: hiddenOver, fileName: "cv.pdf", mimeType: "application/pdf" }), null);
  const hidden = await pdfCv(hiddenOver);
  // assert.ok, not assert.equal: a failing strict equal prints a diff of the whole PDFDocument graph.
  assert.ok(hidden.pdf === null, "a 51-page PDF hidden in object streams carries no pages, got " + hidden.pdf?.getPageCount());
  assert.equal(hidden.line, "CV not included: it has 51 pages, more than the 50 an application prints. Open it from the candidate's page.");

  // An ordinary CV is untouched by all of this.
  const ordinary = await pdfWithPages(2, true);
  assert.equal(cvRefusedBeforeOpening({ bytes: ordinary, fileName: "cv.pdf", mimeType: "application/pdf" }), null);
  assert.equal((await pdfCv(ordinary)).line, "CV: PDF, 2 pages, exactly as sent.");

  // The gate runs FIRST in cvPart — before the switch hands the bytes to pdf-lib, mammoth or sharp — and
  // the Word branch counts Chromium's pages before it hands any back.
  const source = stripComments(read("src/lib/recruitment/whatsapp-application-pdf.ts"));
  const cvPartBody = source.slice(source.indexOf("async function cvPart("), source.indexOf("export type BuiltApplicationPdf"));
  const gateAt = cvPartBody.indexOf("cvRefusedBeforeOpening(cv)");
  assert.ok(gateAt > 0 && gateAt < cvPartBody.indexOf("switch (detectCvFileKind("), "cvPart refuses an oversized CV before the switch opens it");
  const wordBody = source.slice(source.indexOf("async function wordCv("), source.indexOf("async function cvPart("));
  assert.ok(
    wordBody.indexOf("doc.getPageCount() > MAX_APPLICATION_CV_PAGES") > wordBody.indexOf("PDFDocument.load(drawn)") &&
      wordBody.indexOf("doc.getPageCount() > MAX_APPLICATION_CV_PAGES") < wordBody.indexOf("pdf: doc"),
    "a Word CV is counted once Chromium has drawn it, before its pages are handed back",
  );
  assert.ok(!/15\s*\*\s*1024\s*\*\s*1024/.test(source) && source.includes("maxInboundCvBytes()"), "the byte limit is read from maxInboundCvBytes(), never written a second time");
}
