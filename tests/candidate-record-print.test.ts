import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { CandidateRecord } from "../src/lib/recruitment/candidate-record.ts";
import { candidateRecordSections } from "../src/lib/recruitment/candidate-record-fields.ts";
import {
  buildCandidateRecordBodyHtml,
  buildCandidateRecordDocumentHtml,
  buildCandidateRecordPrint,
  recordStamp,
  type CandidateRecordPrint,
  type PrintBlock,
  type PrintField,
  type PrintSection,
} from "../src/lib/recruitment/candidate-record-print.ts";
import {
  CANDIDATE_RECORD_SCREEN_ONLY_CLASS,
  candidateRecordPrintCss,
} from "../src/lib/recruitment/candidate-record-print-css.ts";
import { candidateRecordPrintHref } from "../src/lib/recruitment/candidate-page-link.ts";
import { getCvPositionSchema } from "../src/lib/recruitment/cv-field-schemas.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// One candidate's whole page as a sheet of paper (the owner, 2026-09-19): "all data appearing here I want
// it printed." Then, the same day, on the first sheet he saw:
//
//   "what they did not populate — remove it. For example the whole section of where they stand — remove
//    it. Of course the name, write it normally. Where is the salary question? You are putting the
//    non-important questions and leaving the important ones."
//
// Pinned here:
//
//   1. every section the page draws is on the paper, in the page's order, EXCEPT "Where they stand" —
//      the one section the paper leaves out, by name, so a section added to the screen and forgotten here
//      goes red instead of silently missing;
//   2. nothing unpopulated prints: no "not on file", no "Irrelevant", no empty section;
//   3. the salary, then the questions HR itself added, come before the five the bot always asks;
//   4. a stranger's name and notes are text, never markup, and every line reads from its own side;
//   5. the sheet is hairlines and type — no fill, no rounded corner — and it flows across pages without
//      splitting a row;
//   6. the print page repeats the shell's gate, is read-only, and the record page's button opens it in a
//      new tab. The CV is NOT on this sheet: it prints from its own pane.
// ─────────────────────────────────────────────────────────────────────────────

const CANDIDATE_ID = "0b6f7a52-3a0e-4c1e-9d63-5a7c2f0e8b11";
const NOW = new Date("2026-09-19T12:12:00.000Z");

/** The nine sections the paper carries, in the screen's order. */
const PRINTED_SECTIONS = [
  "Screening summary",
  "How they reached us",
  "Everything on the record",
  "Files",
  "Sent to managers",
  "Applications and interviews",
  "Opened by",
  "History",
  "Notes",
];

/** The one section of the screen the paper leaves out, on the owner's instruction. */
const LEFT_OUT = "Where they stand";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

// ── A very full record, and a very thin one ─────────────────────────────────────────────────────

const RESPONSIBILITIES = [
  "Covered 120 doctors across Haram, Faisal and 6th of October.",
  "تقديم المنتجات الجديدة للأطباء والصيدليات ومتابعة الطلبات مع الموزعين",
  "Trained two new joiners on the product portfolio.",
].join("\n");

function fullCandidate(overrides: Record<string, unknown> = {}): Candidate {
  return {
    address: "12 El Nozha St, Haram, Giza — ١٢ شارع النزهة، الهرم، الجيزة",
    appliedForEvidence: "Hello, I would like to apply for the medical representative job",
    appliedForJobTitle: "Medical Representative",
    createdAt: "2026-09-14T09:12:00.000Z",
    createdBy: "H-2",
    currentEmployer: "Global Pharma Egypt",
    currentJobTitle: "Senior Medical Representative",
    currentRoleResponsibilities: RESPONSIBILITIES,
    cvReferenceName: "Aya Khedr CV.pdf",
    dateOfBirth: "1996-05-14",
    declaredBackground: "Pharmacy graduate",
    declaredExperience: "5 years",
    declaredExpectedSalary: "28 k",
    degree: "Bachelor of Pharmacy",
    email: "aya.khedr@example.com",
    faculty: "Faculty of Pharmacy",
    folder: null,
    fullName: "Aya Mohamed Khedr",
    gender: "Female",
    governorate: "Giza",
    graduationYear: 2019,
    hasMedicalRepExperience: true,
    id: CANDIDATE_ID,
    maritalStatus: "Married",
    medicalRepEmployer: "Global Pharma Egypt",
    medicalRepExperienceFrom: "2021-02-01",
    medicalRepExperienceTo: null,
    nationality: "Egyptian",
    notes: "Referred by a colleague.\nتمت الإحالة من زميلة",
    phone: "+20 100 555 0142",
    positionSpecificFields: {
      skills: [
        "Territory planning",
        "Key-account handling",
        "Product detailing",
        "Objection handling",
        "CRM reporting",
        "Negotiation",
      ].map((name) => ({ name })),
      workHistory: [
        { employer: "Global Pharma Egypt", from: "2021-02-01", jobTitle: "Senior Medical Representative", location: "Giza", responsibilities: RESPONSIBILITIES, to: null },
        { employer: "Nile Health", from: "2019-09-01", jobTitle: "Medical Representative", location: "Cairo", responsibilities: "Detailing to 80 doctors.", to: "2021-01-31" },
      ],
    },
    preferencesDeclaredAt: "2026-09-14T09:20:00.000Z",
    preferredAreaName: "Giza 2",
    rating: 3,
    screeningExtraAnswers: { age: "29", start: "Two weeks after the offer" },
    source: "whatsapp",
    sourceContext: {
      channel: "whatsapp",
      detailLines: ["Hello, I would like to apply for the medical representative job", "مرحبا، أريد التقديم على وظيفة مندوب دعاية طبية"],
      shortLabel: "Hello, I would like to apply for the medical representative job",
    },
    status: "shortlisted",
    statusChangedAt: "2026-09-16T09:00:00.000Z",
    statusNote: "Strong field record.",
    updatedAt: "2026-09-17T11:40:00.000Z",
    yearsExperience: 5,
    ...overrides,
  } as unknown as Candidate;
}

const PEOPLE = { "H-1": "Omar Gawish", "H-2": "Nour Hassan" };

function fullRecord(candidate: Candidate = fullCandidate(), overrides: Record<string, unknown> = {}): CandidateRecord {
  return {
    cvFolders: [],
    extraction: null,
    people: PEOPLE,
    profile: {
      applications: [
        {
          application: {
            currentOwnerHrId: "H-1",
            decisionReason: null,
            lastStageChangedAt: "2026-09-16T09:00:00.000Z",
            rejectedReason: null,
            stage: "screening",
          },
          jobTitle: "Medical Representative",
        },
      ],
      candidate,
      files: [
        { createdAt: "2026-09-14T09:12:00.000Z", fileName: "Aya Khedr CV.pdf", id: "file1", kind: "cv", sizeBytes: 251_000, uploadedByHrId: "H-2" },
      ],
      interviews: [
        {
          interview: {
            createdAt: "2026-09-16T12:00:00.000Z",
            id: "i1",
            interviewType: "hr",
            interviewerHrId: "H-1",
            notes: "Good energy and clear on the territory.",
            outcome: "pass",
            scheduledAt: "2026-09-18T10:30:00.000Z",
          },
          summary: { average: 4.2, ratedCount: 4, totalCriteria: 5 },
        },
      ],
      ratingAverage: null,
      rejectionHistory: [],
    },
    screeningQuestions: [
      { appliesToRoleFamilies: null, bodyText: "If you were offered the job, when could you start?", questionKey: "start" },
      { appliesToRoleFamilies: null, bodyText: "How old are you?", questionKey: "age" },
    ],
    sends: [
      {
        candidateId: CANDIDATE_ID,
        managerArea: "Giza 2",
        managerHrId: "H-9",
        managerJobTitle: "District Manager",
        managerName: "Ahmed Hassan",
        managerRegion: "Giza",
        position: null,
        sentAt: "2026-09-17T08:30:00.000Z",
      },
    ],
    unavailable: [],
    viewers: [
      { firstSeenAt: "2026-09-14T10:00:00.000Z", lastSeenAt: "2026-09-17T11:00:00.000Z", name: "Omar Gawish", viewCount: 3 },
      { firstSeenAt: "2026-09-15T10:00:00.000Z", lastSeenAt: "2026-09-15T10:00:00.000Z", name: null, viewCount: 1 },
    ],
    ...overrides,
  } as unknown as CandidateRecord;
}

function thinRecord(overrides: Record<string, unknown> = {}): CandidateRecord {
  return {
    cvFolders: [],
    extraction: null,
    people: {},
    profile: {
      applications: [],
      candidate: {
        createdAt: "2026-09-01T09:00:00.000Z",
        folder: { filedAt: "2026-09-02T08:00:00.000Z", filedByHrId: "H-2", key: "paramedical", kind: "paramedical" },
        fullName: "Samer <b>Haddad</b> & Sons",
        id: CANDIDATE_ID,
        nationality: "Syrian",
        positionSpecificFields: {},
        screeningExtraAnswers: {},
        status: "new",
      },
      files: [],
      interviews: [],
      ratingAverage: null,
      rejectionHistory: [],
    },
    screeningQuestions: null,
    sends: [],
    unavailable: ["extraction", "sends", "viewers", "folders"],
    viewers: [],
    ...overrides,
  } as unknown as CandidateRecord;
}

const TIMELINE = [
  { at: "2026-09-17T08:30:00.000Z", detail: "Ahmed Hassan · District Manager", id: "t3", kind: "sent", title: "Sent to a manager" },
  { at: "2026-09-16T09:00:00.000Z", detail: "Strong field record.", id: "t2", kind: "status", title: "Shortlisted" },
  { at: "2026-09-14T09:12:00.000Z", detail: null, id: "t1", kind: "arrived", title: "Arrived by WhatsApp" },
];

const NOTES = [
  { authorHrId: "H-1", authorJobTitle: "HR Section Head", authorName: "Omar Gawish", body: "Called her — available from the 1st.\nمتاحة من أول الشهر", candidateId: "c", createdAt: "2026-09-17T09:00:00.000Z", id: "n1" },
  { authorHrId: null, authorJobTitle: null, authorName: null, body: "Second note, no named author.", candidateId: "c", createdAt: "2026-09-16T09:00:00.000Z", id: "n2" },
];

function build(record: CandidateRecord, timeline: unknown = TIMELINE, notes: unknown = NOTES): CandidateRecordPrint {
  return buildCandidateRecordPrint({ notes: notes as never, now: NOW, record, timeline: timeline as never });
}

function titles(model: CandidateRecordPrint): string[] {
  return model.sections.map((section) => section.title);
}

function section(model: CandidateRecordPrint, title: string): PrintSection {
  const found = model.sections.find((entry) => entry.title === title);
  assert.ok(found, `the ${title} section is on the paper`);
  return found;
}

function fieldBlocks(blocks: PrintBlock[]): Array<Extract<PrintBlock, { kind: "fields" }>> {
  return blocks.filter((block): block is Extract<PrintBlock, { kind: "fields" }> => block.kind === "fields");
}

function allFields(model: CandidateRecordPrint): PrintField[] {
  return model.sections.flatMap((entry) => fieldBlocks(entry.blocks).flatMap((block) => block.fields));
}

function htmlOf(model: CandidateRecordPrint): string {
  return buildCandidateRecordDocumentHtml(model, null);
}

// ── 1 · The sections: the page's, less "Where they stand" ───────────────────────────────────────

function runSectionTests() {
  const full = build(fullRecord());
  assert.deepEqual(titles(full), PRINTED_SECTIONS, "a full record prints all nine sections, in the screen's order");

  // The paper follows the PAGE, not a list written here: read the page's own top-level section titles.
  // Since the 2026-10-19 premium sweep each top-level section is a RecordPanel (the module's dark
  // band, folding); the nested record subsections are still CollapsibleSections titled by an
  // expression, which this reader skips exactly as it always has.
  const page = stripComments(read("src/components/recruitment/candidate-record-page.tsx"));
  const pageTitles = [...page.matchAll(/<(?:CollapsibleSection|RecordPanel)\b[^>]*?\btitle="([^"]+)"/g)].map((match) => match[1]!);
  assert.ok(pageTitles.length >= 10, `the page's sections were read (${pageTitles.join(" | ")})`);
  assert.deepEqual(
    pageTitles.filter((title) => title !== LEFT_OUT),
    PRINTED_SECTIONS,
    "the page's sections, less the one left out, are exactly what the paper prints, in the same order — a section added to the screen and not here fails this",
  );
  assert.ok(pageTitles.includes(LEFT_OUT), "the section the owner removed from the paper is still on the screen");
  assert.equal(pageTitles.filter((title) => !PRINTED_SECTIONS.includes(title)).join(), LEFT_OUT, "and it is the ONLY one the paper omits");

  // Nothing about it reaches the paper, whatever the record holds.
  for (const model of [full, build(thinRecord(), null, null)]) {
    const html = htmlOf(model);
    assert.ok(!titles(model).includes(LEFT_OUT));
    assert.ok(!html.includes(LEFT_OUT), "the words 'Where they stand' are nowhere on the sheet");
    assert.ok(!html.includes("★"), "the star is screen-only");
    assert.ok(!html.includes("In the main pool") && !html.includes("In no folder") && !html.includes("No star"), "the shelf, the folders and the star line are screen-only");
  }
  // What stays of it is the status, in the line under the name.
  assert.ok(full.subtitle.includes("Shortlisted"), `the status is in the line under the name (${full.subtitle})`);
  assert.ok(full.subtitle.startsWith("Applying for Medical Representative"));

  // The same fact labels as the screen's summary: a label renamed there and forgotten here goes red.
  const facts = stripComments(read("src/components/recruitment/candidate-facts-summary.tsx"));
  const printSource = stripComments(read("src/lib/recruitment/candidate-record-print.ts"));
  for (const label of ["Current role", "Employer", "Experience", "Medical rep experience", "Governorate", "Education"]) {
    assert.ok(facts.includes(`label: "${label}"`), `the screen's summary has the ${label} cell`);
    assert.ok(printSource.includes(`"${label}"`), `and so does the paper`);
  }
  const fromTheCv = fieldBlocks(section(full, "Screening summary").blocks).find((block) => block.heading === "From the CV");
  assert.ok(fromTheCv, "the CV's facts are a block of the summary");
  assert.deepEqual(
    fromTheCv.fields.map((field) => field.label),
    ["Current role", "Employer", "Experience", "Medical rep experience", "Governorate", "Education"],
  );
}

// ── 2 · Nothing unpopulated prints ──────────────────────────────────────────────────────────────

function runUnpopulatedTests() {
  const thin = build(thinRecord(), null, null);
  const thinHtml = htmlOf(thin);

  for (const gap of ["not on file", "Not on file", "Irrelevant", "nothing on file", "Nobody has", "No file is attached", "Not stated"]) {
    assert.ok(!thinHtml.includes(gap), `a thin record does not print "${gap}"`);
    assert.ok(!htmlOf(build(fullRecord())).includes(gap), `and neither does a full one ("${gap}")`);
  }
  assert.ok(!thin.subtitle.includes("Applying for"), `a record with no known job has no 'Applying for' (${thin.subtitle})`);

  // A thin record prints only what it holds: no section is a heading over nothing.
  for (const entry of thin.sections) {
    assert.ok(entry.blocks.length > 0, `${entry.title} has content`);
    if (entry.title === "History" || entry.title === "Notes") continue;
    for (const block of entry.blocks) {
      if (block.kind === "fields") assert.ok(block.fields.length > 0, `${entry.title} has no empty group`);
      if (block.kind === "items") assert.ok(block.items.length > 0);
      if (block.kind === "events") assert.ok(block.events.length > 0);
      if (block.kind === "notes") assert.ok(block.notes.length > 0);
    }
  }
  for (const empty of ["Files", "Sent to managers", "Applications and interviews", "Opened by", "Screening summary"]) {
    assert.ok(!titles(thin).includes(empty), `${empty} has nothing on this record, so it is not on the paper`);
  }
  assert.deepEqual(
    titles(thin),
    ["How they reached us", "Everything on the record", "History", "Notes"],
    "the thin record prints what it has, and the two reads that failed keep a line saying so",
  );

  // A part that could not be READ is not the same as a part with nothing in it: the paper says so.
  const problems = thin.sections
    .flatMap((entry) => entry.blocks)
    .filter((block): block is Extract<PrintBlock, { kind: "say" }> => block.kind === "say" && block.problem)
    .map((block) => block.text);
  assert.deepEqual(problems, ["Could not load this candidate's history.", "Could not load the notes on this candidate."]);
  const unread = thin.notices.find((notice) => notice.text.startsWith("Could not read"));
  assert.ok(unread, "a failed read is a notice at the top of the sheet");
  assert.ok(unread.text.includes("the CV reader's last read"));
  assert.ok(unread.text.includes("the sends to managers"));
  assert.ok(unread.text.includes("who has opened this CV"));
  assert.ok(!unread.text.includes("folders"), "the folders are part of the section the paper does not carry, so a failed read of them is not reported");
  assert.ok(thin.notices.some((notice) => notice.text.startsWith("Filed:")), "a filed CV still says so at the top");
  assert.ok(thin.notices.some((notice) => /Syrian/i.test(notice.text)), "a stated non-Egyptian nationality still says so at the top");

  // The schema's "Irrelevant" row (military service for a woman) is not printed. Prove the premise first.
  const woman = fullCandidate({ gender: "Female" });
  const schema = getCvPositionSchema("universal");
  assert.ok(schema, "the universal CV schema exists");
  const irrelevant = candidateRecordSections(woman, schema)
    .flatMap((entry) => entry.rows)
    .filter((row) => row.kind === "irrelevant");
  assert.ok(irrelevant.length > 0, "the premise: the schema marks at least one field irrelevant for this person");
  const printedLabels = new Set(allFields(build(fullRecord(woman))).map((field) => field.label));
  for (const row of irrelevant) {
    assert.ok(!printedLabels.has(row.label), `the irrelevant field "${row.label}" is not printed`);
  }
}

// ── 3 · The important answers come first ────────────────────────────────────────────────────────

function runImportanceTests() {
  const summary = section(build(fullRecord()), "Screening summary");
  assert.equal(summary.blocks[0]?.kind, "fields");
  const first = fieldBlocks(summary.blocks)[0]!;
  assert.equal(first.heading, "Answers on WhatsApp", "the summary opens with what they answered, not with the CV's facts");
  assert.deepEqual(
    first.fields.slice(0, 3).map((field) => field.label),
    ["Expected salary", "If you were offered the job, when could you start?", "How old are you?"],
    "the salary first, then the questions HR itself added, in the order the applicant met them",
  );
  assert.equal(first.fields[0]!.values[0]!.text, "28 k", "the salary is the applicant's own words");
  const rest = first.fields.slice(3).map((field) => field.label);
  assert.ok(rest.length >= 3, `the questions the bot always asks follow (${rest.join(" | ")})`);
  assert.ok(rest.includes("What did you graduate in?") && rest.includes("How much experience?"));
  assert.ok(first.fields.every((field) => field.sentence), "a question is set as a sentence, not capitalised like a label");

  // A salary nobody answered on WhatsApp but the record holds still leads, as its own block.
  const typedIn = section(
    build(fullRecord(fullCandidate({ declaredExpectedSalary: null, expectedSalary: 28000 }))),
    "Screening summary",
  );
  const lead = fieldBlocks(typedIn.blocks)[0]!;
  assert.equal(lead.heading, "On the record");
  assert.deepEqual(lead.fields.map((field) => [field.label, field.values[0]!.text]), [["Expected salary", "28,000"]]);
  assert.equal(fieldBlocks(typedIn.blocks)[1]!.heading, "Answers on WhatsApp");

  // A record with no salary anywhere prints no salary row: nothing is invented.
  const none = build(fullRecord(fullCandidate({ declaredExpectedSalary: null, expectedSalary: null })));
  assert.ok(!allFields(none).some((field) => field.label === "Expected salary"), "no salary on file, no salary row");
}

// ── 4 · One line of skills, not one row each ────────────────────────────────────────────────────

function runCompactionTests() {
  const model = build(fullRecord());
  const record = section(model, "Everything on the record");
  const fields = fieldBlocks(record.blocks).flatMap((block) => block.fields);
  const skills = fields.find((field) => field.values.some((value) => value.text.startsWith("Territory planning")));
  assert.ok(skills, "the skills are on the sheet");
  assert.equal(skills.entries.length, 0, "a list of single words is one field, not one row per word");
  assert.equal(skills.values.length, 1);
  assert.equal(
    skills.values[0]!.text,
    "Territory planning · Key-account handling · Product detailing · Objection handling · CRM reporting · Negotiation",
    "every skill is still there, in the same order, on one wrapped line",
  );

  // A block of real records keeps a row each, so a page can break between two jobs.
  const jobs = fields.find((field) => field.entries.length === 2);
  assert.ok(jobs, "the two jobs stay two entries");
  assert.ok(jobs.entries.every((lines) => lines.length > 1), "each job keeps its own lines");
  const html = htmlOf(model);
  assert.ok(!html.includes("Skill:"), "the word 'Skill' is not repeated down the page");
}

// ── 5 · Text, never markup; every line from its own side; names, never codes ────────────────────

function runEscapingAndNamesTests() {
  const hostileNotes = [
    { authorHrId: null, authorJobTitle: '<i onclick="x">Boss</i>', authorName: "<img src=x onerror=alert(1)>", body: "<script>alert(1)</script>\nمرحبا", candidateId: "c", createdAt: "2026-09-16T09:00:00.000Z", id: "n1" },
  ];
  const thin = build(thinRecord(), TIMELINE, hostileNotes);
  const html = buildCandidateRecordBodyHtml(thin, null);
  assert.ok(!html.includes("<b>Haddad"), "a name cannot open a tag");
  assert.ok(html.includes("Samer &lt;b&gt;Haddad&lt;/b&gt; &amp; Sons"));
  assert.ok(!html.includes("<script") && !html.includes("<img") && !html.includes("<i onclick"), "a note cannot open a script, an image or a handler");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes('<h1 dir="auto">Samer &lt;b&gt;Haddad'), "the name reads from its own side");

  const full = htmlOf(build(fullRecord()));
  assert.ok(full.includes('<span class="ln" dir="auto">12 El Nozha St'), "an address line reads from its own side");
  assert.ok(
    full.includes('<span class="ln" dir="auto">تقديم المنتجات الجديدة للأطباء والصيدليات ومتابعة الطلبات مع الموزعين</span>'),
    "an Arabic line sits in its own span, so it reads right-to-left inside a block of English",
  );
  assert.ok(full.includes('<span class="ln" dir="auto">متاحة من أول الشهر</span>'), "and so does a note's Arabic line");

  // Names, never codes: every HR id resolves to a person, or to "Unnamed user".
  for (const code of ["H-1", "H-2", "H-9"]) assert.ok(!full.includes(code), `${code} is not printed`);
  assert.ok(full.includes("Nour Hassan"), "the person who added the CV is named");
  assert.ok(full.includes("Omar Gawish"));
  assert.ok(full.includes("Unnamed user"), "a viewer with no name is 'Unnamed user'");
  assert.ok(full.includes("Unnamed author"), "a note with no author is 'Unnamed author'");
  const strangers = htmlOf(build(fullRecord(fullCandidate({ createdBy: "H-77" }))));
  assert.ok(!strangers.includes("H-77") && strangers.includes("Unnamed user"), "an id that matches nobody prints as 'Unnamed user'");
  const batch = htmlOf(build(fullRecord(fullCandidate({ createdBy: "ops:import-2026-09" }))));
  assert.ok(batch.includes("An automated batch") && !batch.includes("ops:import"), "an automated batch is named as one, never by its code");

  // The time is Cairo, in the screen's own words.
  assert.equal(recordStamp("2026-09-17T11:00:00.000Z"), "17 Sept 2026, 02:00 pm");
  assert.equal(recordStamp("2026-09-17T11:00:00.000Z", { dateOnly: true }), "17 Sept 2026");
  assert.equal(recordStamp(null), "");
  assert.equal(recordStamp("not a date"), "");
  assert.equal(build(fullRecord()).printedLabel, "Printed 19 Sept 2026, 03:12 pm (Cairo)", "the printed time is Cairo local, never UTC");

  // A file with a size prints the size the way the screen does.
  assert.ok(full.includes("CV · 245 KB"), "the file's size is in words");
}

// ── 6 · The paper: hairlines and type, flowing across pages ─────────────────────────────────────

function runPaperTests() {
  const model = build(fullRecord());
  const css = candidateRecordPrintCss(model.printedLabel);
  const own = css.slice(css.indexOf("@page"));

  assert.ok(css.includes("@page {") && css.includes("size: A4 portrait"));
  assert.ok(/@bottom-right \{[^}]*counter\(page\)[^}]*counter\(pages\)/.test(css), "every page carries 'Page N of M'");
  assert.ok(css.includes("SATO-DIS-2026-01"), "and the document standard, in the page's own margin");
  assert.ok(css.includes(`.${CANDIDATE_RECORD_SCREEN_ONLY_CLASS} { display: none !important; }`), "the toolbar is not on the paper");
  assert.equal(CANDIDATE_RECORD_SCREEN_ONLY_CLASS, "rec-screen-only");

  // A row is never split across two pages, and a heading never sits alone at the foot of one.
  assert.ok(/\.rec tr \{[^}]*break-inside: avoid/.test(css), "a table row is not split");
  assert.ok(/\.rec li \{[^}]*break-inside: avoid/.test(css), "a list item is not split");
  assert.ok(/\.rec h2 \{[^}]*break-after: avoid/.test(css), "a section heading stays with its first row");
  assert.ok(/\.rec h3 \{[^}]*break-after: avoid/.test(css), "and so does a group heading");

  // No fill, no rounded corner, no ellipsis: the house identity's ink rule.
  const fills = [...own.matchAll(/background(?:-color)?:\s*([^;}]+)/g)].map((match) => match[1]!.trim());
  assert.ok(fills.length > 0 && fills.every((fill) => /^#fff(?: !important)?$/.test(fill)), `only white paper is a background (got ${fills.join(" | ")})`);
  assert.ok(!/text-overflow/.test(css), "nothing is cut off with an ellipsis");
  assert.ok(!css.includes("…") && !htmlOf(model).includes("…"), "no ellipsis character on the paper");
  assert.ok(css.includes(".rec, .rec * { box-sizing: border-box; border-radius: 0; }"), "square edges");
  assert.ok(!/border-radius:\s*[1-9]/.test(css), "no rounded corner");

  // THE NAME, WRITTEN NORMALLY (owner: "the name … write it normally, not like this"). It was a big bold
  // blue heading; it is ordinary body ink now, and the section headings are the only blue on the sheet.
  const h1 = css.match(/\.rec h1 \{([^}]*)\}/)?.[1] ?? "";
  assert.ok(h1.includes("color: var(--phx-doc-body)"), `the name is body ink (${h1.trim()})`);
  assert.ok(!/phx-doc-(blue|deep)|#0[Aa]/.test(h1), "not the house blue");
  assert.ok(h1.includes("font-size: 13pt"), "and no bigger than a heading");
  assert.ok(!/text-transform|letter-spacing/.test(h1), "and not set in capitals");

  // A printed label with a quote or a brace in it cannot break out of its CSS string.
  const injected = candidateRecordPrintCss('Printed "x"; } body { display: none } /*\nnext');
  assert.ok(
    /@bottom-left \{ content: "(?:[^"\\\n]|\\.)*"; color/.test(injected),
    "the margin text closes exactly where it is meant to, whatever the label held",
  );

  // The document is the letterhead, the name, the sections — and the company mark only when handed one.
  const html = htmlOf(model);
  assert.equal(html.match(/<h1 /g)?.length, 1);
  assert.equal(html.match(/<section>/g)?.length, PRINTED_SECTIONS.length);
  assert.ok(!html.includes("<img"), "no mark, no image");
  assert.equal(buildCandidateRecordDocumentHtml(model, "data:image/png;base64,AAAA").match(/<img /g)?.length, 1);
  assert.ok(html.includes("Candidate record") && html.includes("Sato Pharma"));
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.includes("Aya Mohamed Khedr — candidate record</title>"), "the saved-as name is the candidate's");
}

// ── 7 · The page: same gate as the screen, read-only, opened from a button ──────────────────────

function runPageTests() {
  // The address is one path in every shell, with the id encoded so it cannot add a segment.
  assert.equal(candidateRecordPrintHref(CANDIDATE_ID), `/print/candidate-record/${CANDIDATE_ID}`);
  assert.equal(candidateRecordPrintHref("a/b"), "/print/candidate-record/a%2Fb");

  // ── The print page repeats the shell's gate, because it sits outside both shells ───────────
  const page = stripComments(read("app/print/candidate-record/[id]/page.tsx"));
  assert.ok(page.includes("index: false") && page.includes("nocache: true") && page.includes("follow: false"), "never indexed, never cached");
  assert.ok(page.includes('export const dynamic = "force-dynamic"'));
  assert.ok(page.includes("parseCandidatePageId(rawId)") && page.includes("if (!id) notFound()"), "a cut-off id is a 404 before the database is asked");
  assert.ok(page.includes("redirect(`/login?returnUrl=${encodeURIComponent(candidateRecordPrintHref(id))}`)"), "signed out, it comes back here after the login");
  assert.ok(page.includes("isHrAuthorityRole(access.role)"));
  assert.ok(page.includes('canAccess(access, "recruitment", "read")'));
  assert.ok(page.includes('canAccess(access, "candidates", "read")'));
  assert.ok(
    page.indexOf("parseCandidatePageId(") < page.indexOf("resolveAccessContextFromPage(") &&
      page.indexOf('redirect("/employee-portals")') < page.indexOf("loadCandidateRecordPrint(id)"),
    "the id is checked first, and a refused caller is redirected before any of the person's data is loaded",
  );
  assert.ok(page.includes("if (!record) notFound()"), "a candidate who is not in the system is a 404");

  // ── READ-ONLY: opening the paper marks nothing read and writes nothing ────────────────────
  for (const file of [
    "app/print/candidate-record/[id]/page.tsx",
    "src/lib/recruitment/candidate-record-print.ts",
    "src/lib/recruitment/candidate-record-print-css.ts",
    "src/lib/recruitment/candidate-record-print-loader.ts",
    "src/lib/recruitment/candidate-timeline-loader.ts",
    "src/components/recruitment/candidate-record-print.tsx",
  ]) {
    const source = stripComments(read(file));
    for (const write of ["/seen", "markCandidateSeen", "recordCandidateView", ".insert(", ".update(", ".upsert(", ".delete(", 'method: "POST"', 'method: "PATCH"', "fetch("]) {
      assert.ok(!source.includes(write), `${file} never does ${write}`);
    }
  }

  // ── The loader reads through the screen's own loader, and one failed read does not take the rest ──
  const loader = stripComments(read("src/lib/recruitment/candidate-record-print-loader.ts"));
  assert.ok(loader.includes("loadCandidateRecord(candidateId)"), "the record is read the way the screen reads it");
  assert.ok(loader.includes("loadCandidateTimeline(record.profile).catch(() => null)"), "a history that fails is null, and the sheet says so");
  assert.ok(loader.includes("listCandidateComments(candidateId).catch(() => null)"), "so are the notes");

  // The history is the timeline route's own body, so the paper and the tab cannot drift apart.
  const route = stripComments(read("app/api/recruitment/candidates/[id]/timeline/route.ts"));
  assert.ok(route.includes('requireRecruitmentAccess(request, "candidates", "read")'), "the timeline route keeps its gate");
  assert.ok(route.includes("loadCandidateTimeline(profile)"), "and builds its answer from the shared loader");
  assert.ok(stripComments(read("src/lib/recruitment/candidate-timeline-loader.ts")).includes("export async function loadCandidateTimeline"));

  // ── The client component frames the sheet and imports only the small file ─────────────────
  const client = read("src/components/recruitment/candidate-record-print.tsx");
  assert.ok(client.startsWith('"use client"'));
  const clientImports = [...client.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(clientImports.includes("@/lib/recruitment/candidate-record-print-css"));
  assert.ok(
    !clientImports.includes("@/lib/recruitment/candidate-record-print"),
    "the browser bundle does not pull the whole record builder in for one class name",
  );
  assert.ok(client.includes("window.print()") && client.includes("AUTO_PRINT_DELAY_MS"), "the print dialog opens on its own, once");

  // ── The button on the candidate's own page opens it in a new tab, beside what was there ─────
  const recordPage = stripComments(read("src/components/recruitment/candidate-record-page.tsx"));
  assert.ok(
    /href=\{candidateRecordPrintHref\(candidate\.id\)\}\s+rel="noopener noreferrer"\s+target="_blank"/.test(recordPage),
    "'Print record' opens the print page in a new tab, so the page he was reading stays put",
  );
  assert.ok(recordPage.includes("Print record"));
  assert.ok(recordPage.includes("<ScheduleInterviewButton"), "the buttons that were already there are still there");
}

export function runCandidateRecordPrintTests() {
  runSectionTests();
  runUnpopulatedTests();
  runImportanceTests();
  runCompactionTests();
  runEscapingAndNamesTests();
  runPaperTests();
  runPageTests();
}
