import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cvLibraryRowFromCandidate, summarizeCvLibrary } from "../src/lib/cv/cv-library.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

/**
 * Pins the CV Database onto the candidate pool.
 *
 * Measured on production 2026-08-24: the page showed 0 candidates while ats_candidates held 562.
 * `CvDatabaseManager` held its rows in React state, filled only by an .xlsx the user uploaded,
 * and a reload emptied it — there was no loader, no API route behind it, and it shared no data with
 * the pool next door. Owner decision: one dataset.
 */

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    createdAt: "2026-08-20T09:00:00.000Z",
    currentEmployer: null,
    currentJobTitle: null,
    cvReferenceName: null,
    degree: null,
    faculty: null,
    fullName: "Test Candidate",
    governorate: null,
    graduationYear: null,
    hasMedicalRepExperience: null,
    id: "00000000-0000-0000-0000-000000000001",
    medicalRepEmployer: null,
    medicalRepExperienceFrom: null,
    medicalRepExperienceTo: null,
    university: null,
    yearsExperience: null,
    ...overrides,
  } as Candidate;
}

export function runCvLibraryTests() {
  // ---------------------------------------------------------------------------
  // A fully-populated candidate maps onto the CV-facing view.
  // ---------------------------------------------------------------------------
  const row = cvLibraryRowFromCandidate(
    candidate({
      createdAt: "2026-08-20T09:00:00.000Z",
      currentEmployer: "Eva Pharma",
      currentJobTitle: "Medical Representative",
      cvReferenceName: "Mona_Salah_CV.pdf",
      degree: "Bachelor",
      faculty: "Pharmacy",
      fullName: "Mona Salah",
      governorate: "Giza",
      graduationYear: 2019,
      hasMedicalRepExperience: true,
      medicalRepEmployer: "Amoun",
      medicalRepExperienceFrom: "2021-01-01",
      medicalRepExperienceTo: "2023-04-01",
      university: "Cairo University",
      yearsExperience: 5,
    }),
  );

  assert.equal(row.name, "Mona Salah");
  assert.equal(row.currentJobTitle, "Medical Representative");
  assert.equal(row.currentEmployer, "Eva Pharma");
  assert.equal(row.governorate, "Giza");
  assert.equal(row.medicalSales, "experienced");
  assert.equal(row.medicalSalesEmployer, "Amoun");
  assert.equal(row.medicalSalesDuration, "2 years 3 months", "duration comes from the CV's own date range");
  assert.equal(row.totalExperience, "5 years", "total experience comes from yearsExperience, in years");
  assert.equal(
    row.education,
    "Bachelor · Pharmacy · Cairo University (2019)",
    "the four education columns compose into one readable line",
  );

  // The received date is the CAIRO calendar day, never the server's UTC one. 2026-08-20T22:30Z is
  // already the 21st in Cairo, and Railway runs in UTC.
  assert.equal(
    cvLibraryRowFromCandidate(candidate({ createdAt: "2026-08-20T22:30:00.000Z" })).receivedOn,
    "2026-08-21",
    "the CV received date must be the Africa/Cairo day",
  );

  // ---------------------------------------------------------------------------
  // Three answers, not two: "the CV did not say" is not "no".
  // ---------------------------------------------------------------------------
  assert.equal(cvLibraryRowFromCandidate(candidate({ hasMedicalRepExperience: true })).medicalSales, "experienced");
  assert.equal(cvLibraryRowFromCandidate(candidate({ hasMedicalRepExperience: false })).medicalSales, "fresh");
  assert.equal(
    cvLibraryRowFromCandidate(candidate({ hasMedicalRepExperience: null })).medicalSales,
    "unknown",
    "an unstated answer must stay its own bucket",
  );

  // Total experience is NOT substituted into the medical-sales duration — they are different
  // measurements, and conflating them would overstate how long someone sold pharmaceuticals.
  const yearsOnly = cvLibraryRowFromCandidate(candidate({ yearsExperience: 8 }));
  assert.equal(yearsOnly.totalExperience, "8 years");
  assert.equal(yearsOnly.medicalSalesDuration, "", "no date range means no medical-sales duration");

  // A blank candidate yields blank strings, never "null" or "undefined" on screen.
  const blank = cvLibraryRowFromCandidate(candidate({}));
  for (const [key, value] of Object.entries(blank)) {
    assert.ok(typeof value === "string", `${key} must be a string`);
    assert.ok(!/^(null|undefined|NaN)$/.test(value), `${key} rendered as "${value}"`);
  }

  // ---------------------------------------------------------------------------
  // The summary counts what it says it counts.
  // ---------------------------------------------------------------------------
  const summary = summarizeCvLibrary([
    cvLibraryRowFromCandidate(
      candidate({
        currentEmployer: "Eva Pharma",
        hasMedicalRepExperience: true,
        medicalRepExperienceFrom: "2021-01-01",
        medicalRepExperienceTo: "2023-01-01",
      }),
    ),
    cvLibraryRowFromCandidate(
      candidate({
        currentEmployer: "Eva Pharma",
        hasMedicalRepExperience: true,
        medicalRepExperienceFrom: "2022-01-01",
        medicalRepExperienceTo: "2023-01-01",
      }),
    ),
    cvLibraryRowFromCandidate(candidate({ hasMedicalRepExperience: false })),
    cvLibraryRowFromCandidate(candidate({ hasMedicalRepExperience: null })),
  ]);

  assert.equal(summary.candidates, 4);
  assert.equal(summary.experienced, 2);
  assert.equal(summary.fresh, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.employers, 1, "the same employer twice is one employer");
  assert.equal(
    summary.averageExperienceMonths,
    18,
    "24 and 12 months average to 18, over the two rows that HAVE a duration",
  );
  assert.equal(
    summarizeCvLibrary([]).averageExperienceMonths,
    0,
    "an empty library must not divide by zero",
  );

  // ---------------------------------------------------------------------------
  // The page must actually load the pool, and the component must not own data again.
  // ---------------------------------------------------------------------------
  for (const path of ["app/(admin)/cv-database/page.tsx", "app/employee-portals/cv-database/page.tsx"]) {
    const page = readFileSync(path, "utf8");
    // Match the CALL, not the import. The first cut of this guard tested for the bare identifier
    // `listCandidates`, which the import line satisfies on its own — so gutting the loader body
    // left the test green.
    assert.ok(
      /const rows = cvLibraryRowsFromCandidates\(await listCandidates\(\)\);/.test(page),
      `${path} must actually call listCandidates() and map it — importing the loader is not loading`,
    );
    assert.ok(/<CvDatabaseManager rows=\{rows\} \/>/.test(page), `${path} must pass rows to the manager`);
  }

  const manager = readFileSync("src/components/cv/cv-database-manager.tsx", "utf8");
  assert.ok(
    !/parseCvDatabaseWorkbook/.test(manager),
    "the CV Database went back to parsing an upload into browser memory",
  );
  assert.ok(
    !/React\.useState<CvDatabaseRow\[\]>/.test(manager),
    "the CV Database went back to owning its own row state",
  );
  // The owner's standing rule: nothing truncates with an ellipsis and nothing wraps to a second
  // line. The previous table used line-clamp-2, which broke both at once.
  assert.ok(
    !/line-clamp|truncate|text-ellipsis/.test(manager.replace(/\/\/[^\n]*/g, "")),
    "the CV Database table clips or wraps text",
  );
}
