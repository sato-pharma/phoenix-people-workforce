import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { findAccessRegistryEntry, type PermissionRequirement } from "../src/lib/security/access-registry.ts";
import type { WhatsAppApplicantRow } from "../src/lib/recruitment/whatsapp-applicant-filters.ts";
import {
  candidateApplicationApiPath,
  candidateApplicationFileName,
  candidateApplicationPrintPath,
  candidateApplicationTextPath,
} from "../src/lib/recruitment/whatsapp-application-file.ts";
import { buildApplicationSheet, buildApplicationSheetHtml } from "../src/lib/recruitment/whatsapp-application-sheet.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Screening page — "Download application" / "Print application" on EVERY CV (the owner, 2026-09-26:
// "NOT ONLY SHORTLISTED ANY CV IN SCREENING PAGE").
//
// The WhatsApp Applicants' two buttons, brought to the screening workstation and keyed by CANDIDATE rather
// than by WhatsApp conversation, so they reach a CV whose person never applied on WhatsApp. Where they did,
// the file is the full WhatsApp application; where they did not, it is the CV plus the Job application form
// filled from the record, with the Q&A section left off. Pinned here:
//
//   1. the sheet leaves the WhatsApp Q&A section off when `hasWhatsApp` is false, and names itself a plain
//      Job application then — and keeps everything exactly as it was when true (the default);
//   2. the candidate route is GET-only, gated by the shared predicate, builds the PDF, chooses the file name
//      by whether there was a conversation, is never cached, and serves the print page's base64 form;
//   3. it is a listed, audited EXPORT on candidates:read, and it has a print page gated like the file;
//   4. the loader prefers a real conversation and otherwise builds the row from the record with no answers;
//   5. the review header draws the candidate-keyed buttons on EVERY CV — unconditionally, keyed on row.id —
//      beside the other ways of reaching the person and before the verdicts.
// ─────────────────────────────────────────────────────────────────────────────

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

/** A minimal row for the sheet — the fields buildApplicationSheet actually reads. */
function rowOf(answers: WhatsAppApplicantRow["answers"]): WhatsAppApplicantRow {
  return {
    answers,
    appliedAt: "2026-09-20T09:00:00.000Z",
    candidateId: "c-1",
    finished: answers.length > 0,
    key: "c-1",
    name: "Mona Adel",
    region: null,
    sessionId: "",
    status: "new",
    statusLabel: "New",
    stillOpen: false,
    titleValue: "",
    typedTitle: null,
    values: {},
    waitingOn: null,
  };
}

function runSheetGatingTests() {
  const base = {
    candidate: null,
    contact: { email: null, phone: null },
    cvLine: "CV: PDF, 1 page, exactly as sent.",
    now: new Date("2026-09-26T09:00:00.000Z"),
    row: rowOf([{ answer: "28000", key: "salary", question: "Expected salary" }]),
    titleLabel: "Medical Representative",
  };

  // Default (a WhatsApp applicant): the section stays, and the document names itself for WhatsApp.
  const withWa = buildApplicationSheet(base);
  assert.equal(withWa.hasWhatsApp, true, "default is a WhatsApp application");
  const withWaHtml = buildApplicationSheetHtml(withWa, null);
  assert.ok(withWaHtml.includes("WhatsApp questions and answers"), "the Q&A section is present for a WhatsApp applicant");
  assert.ok(withWaHtml.includes("Recruitment · WhatsApp application"), "and it names itself a WhatsApp application");

  // A candidate who never applied on WhatsApp: no Q&A section, and it is a plain Job application.
  const noWa = buildApplicationSheet({ ...base, hasWhatsApp: false, row: rowOf([]) });
  assert.equal(noWa.hasWhatsApp, false);
  const noWaHtml = buildApplicationSheetHtml(noWa, null);
  assert.ok(!noWaHtml.includes("WhatsApp questions and answers"), "no Q&A section when there was no conversation");
  assert.ok(noWaHtml.includes("Recruitment · Job application"), "it names itself a plain Job application");
  assert.ok(noWaHtml.includes("— Job application</title>"), "the document title follows too");
  // The paper form itself is unchanged — the personal-information heading is still there to write on.
  assert.ok(noWaHtml.includes("Personal information") && noWaHtml.includes("Employment desired"), "the form is still the whole paper form");
}

function runPathTests() {
  assert.equal(candidateApplicationApiPath("c-1"), "/api/recruitment/candidates/c-1/application");
  assert.equal(candidateApplicationTextPath("c-1"), "/api/recruitment/candidates/c-1/application?format=base64");
  assert.equal(candidateApplicationPrintPath("c-1"), "/print/candidate-application/c-1");
  assert.equal(candidateApplicationPrintPath("a/b"), "/print/candidate-application/a%2Fb", "an id cannot add a path segment");
  assert.equal(candidateApplicationFileName("Mona Adel"), "Mona Adel - application.pdf");
  assert.equal(candidateApplicationFileName(""), "Applicant - application.pdf");
}

function runRouteTests() {
  const route = stripComments(read("app/api/recruitment/candidates/[id]/application/route.ts"));
  assert.ok(/export async function GET\(/.test(route), "the download is a GET");
  assert.ok(!/export async function (POST|PATCH|PUT|DELETE)\(/.test(route), "read only");

  const gate = route.indexOf('requireRecruitmentAccess(request, "candidates", "read")');
  const predicate = route.indexOf("canOpenWhatsAppApplications(access)");
  const load = route.indexOf("loadCandidateApplication(id)");
  const build = route.indexOf("buildWhatsAppApplicationPdf(");
  assert.ok(gate >= 0 && predicate > gate, "the candidates gate, then the shared predicate");
  assert.ok(route.indexOf("isUuid(id)") > predicate, "a malformed id is a 404 after the gate");
  assert.ok(route.indexOf("assertExportRateLimit(") < load, "the export limit is charged before anything is built");
  assert.ok(load < build, "the application is loaded before Chromium starts");
  assert.ok(route.includes("hasWhatsApp"), "whether they applied on WhatsApp is passed through to the builder");
  assert.ok(
    /hasWhatsApp\s*\n?\s*\?\s*applicationFileName\(application\.row\.name\)\s*\n?\s*:\s*candidateApplicationFileName\(application\.row\.name\)/.test(route),
    "the file names itself for what it is",
  );
  assert.ok(route.includes('"Cache-Control": "private, no-store"'), "a person's CV is never cached");
  assert.ok(route.includes('searchParams.get("format") === "base64"'), "the print page's text form is served");
  assert.ok(route.includes('scope: "export:recruitment:candidate-application"'));
}

function runRegistryTests() {
  const entry = findAccessRegistryEntry("/api/recruitment/candidates/anything/application", "GET");
  assert.ok(entry, "the candidate application route is registered");
  assert.equal(entry.pattern, "/api/recruitment/candidates/:id/application", "its own entry, not the candidates catch-all");
  const permission = entry.permission;
  const requirements: readonly PermissionRequirement[] = permission === null ? [] : "resource" in permission ? [permission] : permission;
  assert.ok(
    requirements.some((requirement) => requirement.resource === "candidates" && requirement.action === "read"),
    "candidates:read",
  );
  assert.equal(entry.audit.classification, "export", "a CV leaving the building is an audited export");
  assert.equal(entry.audit.required, true);
  // The route file exports only GET, so a POST 405s; the candidates/** blanket still gates it at
  // candidates:read, which is why this GET-only export entry sits ABOVE that blanket and matches first.
  assert.equal(entry.methods.includes("GET"), true, "the export entry serves GET");
  assert.equal(entry.methods.includes("POST"), false, "the export entry itself is read-only");
}

function runLoaderTests() {
  const loader = stripComments(read("src/lib/recruitment/candidate-application.ts"));
  const wa = loader.indexOf("findWhatsAppApplicationSessionId(candidateId)");
  const full = loader.indexOf("loadWhatsAppApplication(sessionId)");
  assert.ok(wa >= 0 && full > wa, "a real conversation is preferred, resolved by the same join the list uses");
  assert.ok(/hasWhatsApp:\s*true/.test(loader) && /hasWhatsApp:\s*false/.test(loader), "both outcomes are reported");
  assert.ok(loader.includes("answers: []"), "the record-only row carries no answers");
  assert.ok(loader.includes('.from("ats_candidates").select("*")') && loader.includes("mapCandidate("), "the record is read and mapped the usual way");
}

function runPrintPageTests() {
  const page = stripComments(read("app/print/candidate-application/[id]/page.tsx"));
  assert.ok(page.includes("index: false") && page.includes("nocache: true"), "never indexed, never cached");
  assert.ok(page.includes("if (!isUuid(id)) notFound()"));
  assert.ok(page.includes("isHrAuthorityRole(access.role)") && page.includes('canAccess(access, "candidates", "read")'), "the same gate as the file");
  assert.ok(page.indexOf('redirect("/employee-portals")') < page.indexOf("<CandidateApplicationPrint"), "the refusal comes before anything is drawn");
}

function runComponentTests() {
  const actions = stripComments(read("src/components/recruitment/candidate-application-actions.tsx"));
  assert.ok(actions.includes("Download application") && actions.includes("Print application"), "both buttons");
  assert.ok(actions.includes("fetchCandidateApplication(candidateId)"), "Download builds the candidate's file");
  assert.ok(actions.includes("href={candidateApplicationPrintPath(candidateId)}"), "Print opens the candidate print page");
  assert.ok(actions.includes('target="_blank"') && actions.includes('rel="noopener noreferrer"'), "Print opens a new tab, so the list survives");

  const header = stripComments(read("src/components/recruitment/workstation/workstation-review-header.tsx"));
  const decisionsStart = header.indexOf("const decisions = (");
  const decisionsEnd = header.indexOf("const afterBands", decisionsStart);
  const decisions = header.slice(decisionsStart, decisionsEnd);
  assert.ok(
    decisions.includes("<CandidateApplicationActions applicantName={row.fullName} candidateId={row.id} />"),
    "the buttons are drawn on EVERY CV — unconditionally, keyed on the candidate",
  );
  assert.ok(!/applicationSessionId/.test(header), "no leftover WhatsApp-session gate");
  const schedule = decisions.indexOf("<ScheduleInterviewButton");
  const application = decisions.indexOf("<CandidateApplicationActions");
  const shortlist = decisions.indexOf('label="Shortlist"');
  assert.ok(schedule >= 0 && application > schedule && shortlist > application, "after Schedule interview, before the verdicts");

  // The workstation no longer fetches a session id for the button — it is candidate-keyed now.
  const workstation = stripComments(read("src/components/recruitment/workstation/screening-workstation.tsx"));
  assert.ok(!workstation.includes("applicationSessions"), "the per-candidate session lookup is gone");
}

export function runScreeningDownloadApplicationTests() {
  runSheetGatingTests();
  runPathTests();
  runRouteTests();
  runRegistryTests();
  runLoaderTests();
  runPrintPageTests();
  runComponentTests();
}
