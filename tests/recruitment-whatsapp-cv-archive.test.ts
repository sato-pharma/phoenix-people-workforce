import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ARCHIVE_FOLDER_NAME,
  archiveAnswers,
  archiveFileHref,
  buildWhatsAppCvArchiveView,
  countsOnWhatsAppApplicants,
  RECRUITMENT_CLEANUP_CUT_AT,
  type WhatsAppCvArchiveFileRow,
  type WhatsAppCvArchiveRow,
} from "../src/lib/recruitment/whatsapp-cv-archive.ts";

/**
 * THE WHATSAPP CV ARCHIVE — the old WhatsApp applicants the owner kept when every candidate received
 * before 11 October 2026 was cleaned out (2026-10-18): "make a folder in each folder called archive …
 * I want the recruitment module and screening to be clear and clean", and the Archive lives "in
 * Phoenix as well". They are NOT candidates. Pinned here: the folders are the cabinet's own, what each
 * person answered reads in the bot's order, and no candidate screen can reach the Archive's tables or
 * its bucket.
 */

function row(overrides: Partial<WhatsAppCvArchiveRow> & Pick<WhatsAppCvArchiveRow, "id">): WhatsAppCvArchiveRow {
  return {
    area: null,
    background: null,
    email: null,
    expected_salary: null,
    experience: null,
    extra_answers: [],
    folder_path: ["WhatsApp 01098500699", "Medical Representative", "Upper Egypt"],
    full_name: "Applicant",
    job_title: null,
    phone: null,
    received_at: "2026-09-20T10:00:00Z",
    region: null,
    whatsapp: null,
    ...overrides,
  };
}

function file(id: string, archiveId: string, fileName: string): WhatsAppCvArchiveFileRow {
  return { archive_id: archiveId, file_name: fileName, id, mime_type: "application/pdf", size_bytes: "1024" };
}

function runGroupingTests() {
  const view = buildWhatsAppCvArchiveView(
    [
      row({ id: "a", full_name: "Older", received_at: "2026-09-01T10:00:00Z" }),
      row({ id: "b", full_name: "Newer", received_at: "2026-10-05T10:00:00Z" }),
      row({ id: "c", full_name: "Sales lead", folder_path: ["WhatsApp 01159888247", "National Sales Manager"] }),
      row({ id: "d", full_name: "  ", folder_path: [], phone: null, whatsapp: "+201000000000" }),
    ],
    [file("f2", "b", "b-second.pdf"), file("f1", "b", "a-first.pdf"), file("f3", "c", "cv.docx")],
  );

  assert.equal(view.people, 4, "everyone in the table is counted");
  assert.equal(view.files, 3, "every file is counted once");
  assert.deepEqual(
    view.folders.map((folder) => folder.path.join(" › ")),
    ["Not filed", "WhatsApp 01098500699 › Medical Representative › Upper Egypt", "WhatsApp 01159888247 › National Sales Manager"],
    "folders are the cabinet's own path, sorted, and a row with no folder is filed rather than dropped",
  );

  const upperEgypt = view.folders[1];
  assert.deepEqual(
    upperEgypt.people.map((person) => person.name),
    ["Newer", "Older"],
    "inside a folder the newest CV is first",
  );
  assert.deepEqual(
    upperEgypt.people[0].files.map((entry) => entry.fileName),
    ["a-first.pdf", "b-second.pdf"],
    "a person's files are all attached, in name order",
  );
  assert.equal(upperEgypt.people[0].files[0].sizeBytes, 1024, "a size read back as text is a number");
  assert.deepEqual(upperEgypt.people[1].files, [], "a person with no file shows no file rather than another person's");

  const unnamed = view.folders[0].people[0];
  assert.equal(unnamed.name, "Name not on file", "a blank name says so");
  assert.equal(unnamed.phone, "+201000000000", "the WhatsApp number stands in when there is no phone");

  assert.equal(ARCHIVE_FOLDER_NAME, "Archive", "each folder's Archive is called Archive, his word");
}

function runAnswerTests() {
  const answers = archiveAnswers(
    row({
      area: "Nasr City",
      background: "Pharmacy",
      expected_salary: "30000",
      experience: "3 - 5 years",
      extra_answers: [
        { answer: "Within 2 weeks", question: "When can you start?" },
        { answer: "", question: "Blank answer" },
        { question: "No answer at all" },
        "not an object",
        { answer: "35 to 39", question: "How old are you?" },
      ],
      id: "x",
      job_title: "National Sales Manager",
      region: "Cairo",
    }),
  );
  assert.deepEqual(answers, [
    { answer: "National Sales Manager", question: "Job title" },
    { answer: "Nasr City, Cairo", question: "Area" },
    { answer: "Pharmacy", question: "Background" },
    { answer: "3 - 5 years", question: "Experience" },
    { answer: "30000", question: "Expected salary" },
    { answer: "Within 2 weeks", question: "When can you start?" },
    { answer: "35 to 39", question: "How old are you?" },
  ], "the five main answers first in the bot's order, then every other answer, and a blank or broken one is left out");

  assert.deepEqual(
    archiveAnswers(row({ id: "y", region: "Upper Egypt", extra_answers: null })),
    [{ answer: "Upper Egypt", question: "Area" }],
    "the region alone still answers where they are, and missing extras are no answers rather than an error",
  );
}

/**
 * 705 conversations from before the clean-up point at a candidate he had taken out. They are not
 * "applicants whose chat could not be matched to a CV", so WhatsApp Applicants does not count them.
 */
function runCleanedOutConversationTests() {
  assert.equal(RECRUITMENT_CLEANUP_CUT_AT, "2026-10-10T21:00:00.000Z", "the cut is Sunday 11 October 2026, 00:00 Cairo");
  assert.equal(countsOnWhatsAppApplicants("2026-09-30T10:00:00Z", false), false, "an old chat whose person was taken out is not counted");
  assert.equal(countsOnWhatsAppApplicants("2026-10-10T20:59:59Z", false), false, "a second before the cut is still old");
  assert.equal(countsOnWhatsAppApplicants("2026-10-10T21:00:00Z", false), true, "from the cut on, an unmatched chat is counted as before");
  assert.equal(countsOnWhatsAppApplicants("2026-09-30T10:00:00Z", true), true, "an old chat that joins a live candidate is always listed");
  assert.equal(countsOnWhatsAppApplicants("not a date", false), true, "an unreadable start is counted rather than hidden");

  const loader = readFileSync(path.join(process.cwd(), "src/lib/recruitment/whatsapp-applicants-loader.ts"), "utf8");
  assert.ok(
    /\.filter\(\(session\) => countsOnWhatsAppApplicants\(session\.started_at, joined\.has\(session\.id\)\)\)/.test(loader),
    "the list's own loader applies it before the view is built",
  );
}

function runAddressTests() {
  assert.equal(archiveFileHref("abc", "inline"), "/api/recruitment/whatsapp-cv-archive/abc?disposition=inline");
  assert.equal(archiveFileHref("abc", "download"), "/api/recruitment/whatsapp-cv-archive/abc");
  assert.equal(archiveFileHref("a/b", "download"), "/api/recruitment/whatsapp-cv-archive/a%2Fb", "an id can never walk out of the route");
}

function sourceFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .map((entry) => path.posix.join(root, entry.split(path.sep).join("/")))
    .filter((file) => /\.(ts|tsx)$/.test(file));
}

/**
 * THE POOL AND SCREENING STAY CLEAN BY CONSTRUCTION. Only the Archive's own two files may name its
 * tables or its bucket; a candidate list, screening, a folder, a tile or an alert that read them would
 * put the old CVs back where he had them taken out.
 */
function runIsolationTests() {
  const allowed = new Set(["src/lib/recruitment/whatsapp-cv-archive.ts", "src/lib/recruitment/whatsapp-cv-archive-loader.ts"]);
  const names = ["ats_whatsapp_cv_archive", "recruitment-cv-archive"];
  const files = [...sourceFiles("src"), ...sourceFiles("app")];
  assert.ok(files.length > 500, `the sweep must actually read the source tree (read ${files.length} files)`);
  const offenders = files.filter(
    (relative) => !allowed.has(relative) && names.some((name) => readFileSync(path.join(process.cwd(), relative), "utf8").includes(name)),
  );
  assert.deepEqual(offenders, [], "nothing but the Archive's own files reads the Archive's tables or bucket");

  const loader = readFileSync(path.join(process.cwd(), "src/lib/recruitment/whatsapp-cv-archive-loader.ts"), "utf8");
  assert.ok(loader.includes('"recruitment-cv-archive"'), "the Archive's files are read from their own bucket");
  assert.ok(!loader.includes("RECRUITMENT_FILES_BUCKET") && !loader.includes('"recruitment-files"'), "never from the candidates' bucket");

  const registry = readFileSync(path.join(process.cwd(), "src/lib/security/access-registry.ts"), "utf8");
  assert.ok(
    registry.includes('pattern: "/api/recruitment/whatsapp-cv-archive/:fileId", permission: { resource: "candidates", action: "read" }'),
    "the CV route is registered under the candidates grant",
  );
}

export function runRecruitmentWhatsAppCvArchiveTests() {
  runGroupingTests();
  runAnswerTests();
  runCleanedOutConversationTests();
  runAddressTests();
  runIsolationTests();
}
