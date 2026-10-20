// Pins the three buttons on the Recruitment workspace's opened CV (owner, 20 Oct 2026: "download CV,
// download CV plus application, print CV and application").
//
// Why each case matters:
//   * Download CV points at the files route and nowhere else — the same file the viewer draws, saved as
//     received. A different route would hand out a copy the gate never saw.
//   * The combined file and its print page are the SCREENING page's own, keyed by the candidate. A second
//     builder would let "the CV with its application" mean two documents depending on the screen.
//   * Print opens a NEW tab, so the list, its filters and the opened CV survive the printout.
//   * The group is drawn only for a seat that works the workspace (`hr && canWork && actions`): the CEO
//     reads without `candidates: read`, and both application endpoints refuse him — an offered button
//     that then fails reads as broken.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cvFileDownloadPath } from "../src/lib/recruitment/cv-file-choice.ts";
import { candidateApplicationPrintPath } from "../src/lib/recruitment/whatsapp-application-file.ts";
import { stripComments } from "./support/comment-strip.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => stripComments(readFileSync(path.join(root, file), "utf8"));

export function runRecruitmentCvTakeAwayTests() {
  assert.equal(cvFileDownloadPath("f-1"), "/api/recruitment/files/f-1/download");
  assert.equal(cvFileDownloadPath("a/b"), "/api/recruitment/files/a%2Fb/download", "an id cannot add a path segment");

  const bar = read("src/components/recruitment/workspace/cv-take-away.tsx");
  for (const label of ["Download CV", "Download CV + application", "Print CV + application"]) {
    assert.ok(bar.includes(label), `the button "${label}" is there`);
  }
  assert.ok(bar.includes("fetchCandidateApplication(candidateId)"), "the combined file is the candidate-keyed application");
  assert.ok(bar.includes("href={candidateApplicationPrintPath(candidateId)}"), "Print opens the candidate print page");
  assert.ok(bar.includes('target="_blank"') && bar.includes('rel="noopener noreferrer"'), "Print opens a new tab");
  assert.ok(bar.includes("primaryCvFile(") && bar.includes("cvFileDownloadPath(file.id)"), "Download CV saves the primary CV file");
  assert.ok(bar.includes('role="alert"'), "a refusal is said in words under the buttons");
  assert.equal(candidateApplicationPrintPath("c-1"), "/print/candidate-application/c-1");

  const opened = read("src/components/recruitment/workspace/opened-cv.tsx");
  const uses = opened.match(/<CvTakeAway\b/g) ?? [];
  assert.equal(uses.length, 2, "drawn in the half-page CV and in the stacked card, and nowhere else");
  assert.ok(
    opened.includes("{hr && canWork && actions ? <CvTakeAway"),
    "the stacked card draws it only for a seat that works the workspace",
  );
  const fillStart = opened.indexOf("if (fill) {");
  const fillBar = opened.indexOf("<CvTakeAway", fillStart);
  const fillGate = opened.lastIndexOf("{hr && canWork && actions ? (", fillBar);
  assert.ok(fillGate > fillStart && fillGate < fillBar, "in the half-page CV it sits inside the working seat's action bar");
}
