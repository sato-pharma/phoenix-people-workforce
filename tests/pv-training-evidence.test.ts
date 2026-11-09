import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { canOpenPvTrainingEvidence, PV_TRAINING_EVIDENCE_HR_IDS } from "../src/lib/pv-training/access.ts";
import {
  findPvTrainingPerson,
  listPvTrainingPeople,
  PV_TRAINING_SHEETS,
  pvTrainingSheetFileName,
} from "../src/lib/pv-training/training-sheets.ts";

/**
 * PV Training Evidence — the signed PV training sheets, for the QPPV's own account alone.
 *
 * The owner (2026-11-09): "In Dr. Sama account, the QPPV, only in Dr. Sama account … She types a
 * name, any name from this PDF, then the full sheet appear." What this file pins:
 *
 *  · the door is ONE HR id, A-3, matched in any case — her `Manager` role is shared with the R&D
 *    Manager (AB), who must be refused, and so must the Super Admin and a plain employee;
 *  · every one of the 30 pages has its scan, and the scans sit in `assets/`, never in `public/`,
 *    because each carries real signatures — and next.config.ts traces them into the build;
 *  · his own example works: "Nahed Hatab" brings up serial 01/2026 (and she also signed 03/2026);
 *  · the crossed-out row on serial 01/2026 is not offered as an attendee;
 *  · no employment status is shown for anyone — "don't put status beside anyone";
 *  · the portal sidebar imports the gate from the data-free access file, so drawing one link never
 *    ships every attendee's name to the whole company.
 */
export function runPvTrainingEvidenceTests() {
  // ── The door ──────────────────────────────────────────────────────────────────────────────────
  assert.deepEqual([...PV_TRAINING_EVIDENCE_HR_IDS], ["A-3"], "only the QPPV, Dr. Samaa Mosaad (A-3), is named");
  assert.equal(canOpenPvTrainingEvidence("A-3"), true);
  assert.equal(canOpenPvTrainingEvidence("a-3"), true, "production stores HR ids in mixed case");
  for (const refused of ["AB", "B-10", "AA", "A-14", "B-130", "", null, undefined]) {
    assert.equal(canOpenPvTrainingEvidence(refused), false, `${String(refused)} must not open the QPPV's sheets`);
  }

  // ── Every page has its scan, and the scans are private ───────────────────────────────────────
  const pages = PV_TRAINING_SHEETS.map((sheet) => sheet.page);
  assert.deepEqual(pages, Array.from({ length: 30 }, (_, index) => index + 1), "one entry per scanned page, 1 to 30");
  const onDisk = readdirSync("assets/pv-training-sheets").filter((name) => name.endsWith(".jpg")).sort();
  assert.deepEqual(onDisk, pages.map(pvTrainingSheetFileName).sort(), "every page has exactly one scan, and no stray file");
  assert.equal(existsSync("public/pv-training-sheets"), false, "the signed scans must never be served from public/");
  const nextConfig = readFileSync("next.config.ts", "utf8");
  assert.ok(
    nextConfig.includes('"/employee-portals/pv-training-evidence": ["./assets/pv-training-sheets/*.jpg"]'),
    "the scans are read from disk by the page, so the standalone build must trace them",
  );

  // ── His example, and one person across sheets ────────────────────────────────────────────────
  const nahed = findPvTrainingPerson("A-10");
  assert.ok(nahed, "Nahed Hatab is on the sheets");
  assert.equal(nahed.name, "Nahed Hatab", "the name as the first sheet prints it");
  assert.deepEqual(nahed.appearances.map(({ sheet }) => sheet.serial), ["01/2026", "03/2026"]);
  assert.equal(findPvTrainingPerson("a-10")?.key, "A-10", "the key matches in any case");
  assert.equal(findPvTrainingPerson("nobody"), null);
  assert.equal(findPvTrainingPerson(""), null);

  const people = listPvTrainingPeople();
  assert.equal(new Set(people.map((person) => person.key)).size, people.length, "one entry per person");
  assert.ok(!people.some((person) => /wegdan/i.test(person.name)), "the crossed-out row on serial 01/2026 did not attend");

  // ── No employment status anywhere (owner, 2026-11-09: "don't put status beside anyone") ──────
  const page = readFileSync("app/employee-portals/pv-training-evidence/page.tsx", "utf8");
  for (const word of ["employment_status", "Resigned", "resignation"]) {
    assert.ok(!page.includes(word), `the page shows no status, so it must not carry "${word}"`);
  }

  // ── The sidebar never bundles the sheet list ─────────────────────────────────────────────────
  const navigation = readFileSync("src/lib/employee-portal/navigation.ts", "utf8");
  assert.ok(navigation.includes('from "@/lib/pv-training/access"'), "the sidebar reads the data-free gate");
  assert.ok(!navigation.includes('from "@/lib/pv-training/training-sheets"'), "the sidebar must not import the attendee list");
  const access = readFileSync("src/lib/pv-training/access.ts", "utf8");
  assert.ok(!access.includes("training-sheets"), "the gate file carries no data");
}
