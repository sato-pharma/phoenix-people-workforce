import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cvLibraryRowFromCandidate, summarizeCvLibrary, type CvLibraryRow } from "../src/lib/cv/cv-library.ts";
import { candidateScreeningFacts } from "../src/lib/recruitment/candidate-screening-facts.ts";
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
  //
  // Two fields are deliberately not strings and are checked on their own terms below: `regionCode`
  // is null when nobody knows where this person wants to work, because the Region filter has to be
  // able to ASK for that group, and "" is a code the filter would then have to special-case; and
  // `regionDeclared` is the boolean the screen reads to say whether the applicant chose it. Neither
  // is ever rendered — `regionLabel` is what reaches the cell — so neither can leak a "null".
  const blank = cvLibraryRowFromCandidate(candidate({}));
  for (const [key, value] of Object.entries(blank)) {
    if (key === "regionCode" || key === "regionDeclared") continue;
    assert.ok(typeof value === "string", `${key} must be a string`);
    assert.ok(!/^(null|undefined|NaN)$/.test(value), `${key} rendered as "${value}"`);
  }
  assert.equal(blank.regionCode, null, "an unknown region must be null, so the filter can ask for it");
  assert.equal(typeof blank.regionDeclared, "boolean");
  assert.equal(typeof blank.regionLabel, "string", "the field the cell actually renders is always a string");

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

  // ---------------------------------------------------------------------------
  // THE SCREEN, rebuilt from scratch 2026-08-30. These are the properties the rebuild has to keep,
  // not a transcription of its markup — a guard that mirrors the JSX line by line only ever proves
  // the JSX has not been retyped.
  // ---------------------------------------------------------------------------
  const manager = readFileSync("src/components/cv/cv-database-manager.tsx", "utf8");
  // Comments stripped, because the file explains each of these rules in prose and an assertion that
  // can match the explanation of the rule instead of a breach of it can never fail.
  const managerCode = manager.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // The original defect: this page once held its rows in React state, filled only by whatever .xlsx
  // somebody had uploaded that minute, and a reload emptied it. It must never own data again.
  assert.ok(
    !/parseCvDatabaseWorkbook/.test(manager),
    "the CV Database went back to parsing an upload into browser memory",
  );
  assert.ok(
    !/React\.useState<Cv(Library|Database)Row\[\]>/.test(manager),
    "the CV Database went back to owning its own row state",
  );

  // The owner's standing rule: nothing truncates with an ellipsis and nothing wraps to a second
  // line. The rebuilt table stacks two facts in a cell as two separate nowrap elements, which is
  // the module's idiom — that is not wrapping, and `truncate` is what would make it clipping.
  assert.ok(
    !/line-clamp|truncate|text-ellipsis/.test(managerCode),
    "the CV Database table clips or wraps text",
  );

  // Match the sibling pages; never invent a one-off look. The page this replaced wrapped itself in
  // a bespoke `CvDatabaseShell` — a radial-gradient backdrop with two blurred colour blobs —
  // that nothing else in the module wore. The Recruitment workspace is the identity to match.
  for (const primitive of ["AdminPageHero", "AdminStatCard", "AdminTableShell"]) {
    assert.ok(
      managerCode.includes(`<${primitive}`),
      `the CV Database stopped using ${primitive}, the shared primitive its sibling pages are built from`,
    );
  }
  assert.ok(
    // `managerCode`, not `manager`: the file's own header explains what CvDatabaseShell was and why
    // it went, and a guard that its own rationale can trip is a guard nobody can keep.
    !/CvDatabaseShell/.test(managerCode),
    "the CV Database grew its own bespoke page shell again instead of matching its sibling pages",
  );

  // The region must arrive on the row already resolved. Re-deriving it here from the CV governorate
  // is precisely what made this screen disagree with the recruitment pool about the same person.
  assert.ok(
    !/candidateRegionForGovernorate\(row\.governorate\)/.test(managerCode),
    "the CV Database re-derives the region from the CV governorate again — that is the drift itself",
  );
  assert.ok(/row\.regionLabel/.test(managerCode), "the CV Database stopped showing the region");
  assert.ok(
    /row\.regionDeclared/.test(managerCode),
    "the CV Database stopped distinguishing a region the applicant chose from one read off their CV",
  );

  // The Region filter has THREE buckets that answer to a null code, not two. Somebody living in
  // Dubai will never have a region and somebody with no address on their CV might have any, so
  // offering only "Region not known" describes the first group wrongly and buries them in the
  // second. Both halves are asserted: the option has to exist, and the unknown bucket has to push
  // the foreign rows back out again — an option that selects nothing distinct is decoration.
  assert.ok(
    /value="foreign"/.test(managerCode),
    "the CV Database dropped the Outside Egypt filter, so a foreign address reads as a missing one",
  );
  assert.ok(
    /regionFilter === "unknown"[\s\S]{0,200}foreign/.test(managerCode),
    "the CV Database's unknown bucket no longer excludes foreign rows, so it claims we have no address for them",
  );

  // THE EXPORT — three parallel lists. If they ever stop being the same length, a column silently
  // writes its neighbour's values into the file, which is worse than a missing column because it
  // still looks like a full spreadsheet.
  const headerBlock = /const exportHeaders = \[([\s\S]*?)\] as const;/.exec(manager);
  const widthBlock = /const exportWidths = \[(.*?)\];/.exec(manager);
  const valueBlock = /rows\.map\(\(row\) => \[([\s\S]*?)\]\),/.exec(manager);
  assert.ok(headerBlock && widthBlock && valueBlock, "the export shape could not be read");
  const entries = (block: string) => block.split(",").filter((part) => part.trim().length > 0).length;
  const headerCount = entries(headerBlock![1]);
  assert.equal(entries(widthBlock![1]), headerCount, "every export column needs a width");
  assert.equal(
    entries(valueBlock![1]),
    headerCount,
    "the export writes a different number of cells than it has headers",
  );
  // The owner's rule is that an export matches the screen. The screen stacks some of these two to a
  // cell; the file keeps one per column, so every fact stays filterable.
  for (const column of ["Region", "Area asked for", "Governorate"]) {
    assert.ok(headerBlock![1].includes(`"${column}"`), `the export dropped the ${column} column`);
  }

  // THE TABLE — one cell per heading. TWO shapes render a cell here: a literal `<td>` and the
  // `StackedCell` component that carries the two-line idiom. Counting only `<td>` is exactly how
  // this guard would quietly stop working, so both are counted.
  const head = manager.slice(manager.indexOf("<thead"), manager.indexOf("</thead>"));
  const body = manager.slice(manager.indexOf("<tbody"), manager.indexOf("</tbody>"));
  const headings = (head.match(/<th[\s>]/g) ?? []).length;
  const cells = (body.match(/<td[\s>]/g) ?? []).length + (body.match(/<StackedCell[\s>]/g) ?? []).length;
  // FIVE, exactly. This was ">= 8" while the table had eight columns, and eight columns is what
  // made it 2460px wide inside a 1758px container — 702px of every row sat off-screen behind a
  // horizontal scrollbar. Held as an equality, not a floor: a floor is what let it grow.
  assert.equal(headings, 4, "the CV Database table is not four columns wide, so it will scroll again");
  assert.equal(
    cells,
    headings,
    "the CV Database table renders a different number of cells than it has column headings",
  );

  // The facts that lost their own COLUMN did not lose their place — they are lines inside a cell
  // now, which is the whole trick that bought the width back. Dropping one is the failure this
  // guards against; moving one is not.
  for (const fact of ["row.governorate", "row.preferredArea", "row.totalExperience", "row.cvFileName"]) {
    assert.ok(
      body.includes(fact),
      `the CV Database table stopped rendering ${fact} when its column was folded away`,
    );
  }

  // ---------------------------------------------------------------------------
  // WHERE THEY WILL WORK — the applicant's own answer, not the address on the CV.
  //
  // This screen used to derive a region by running the CV governorate through
  // `candidateRegionForGovernorate`, while the recruitment pool next door honoured the answer the
  // applicant gave on WhatsApp. Same person, same database, two different regions — and the CV
  // Database is the one an SFE screener filters on. Both screens now read `candidateScreeningFacts`.
  // ---------------------------------------------------------------------------

  // The whole defect, in one fixture: someone whose CV says they live in Assiut, who was asked
  // where they want to WORK and answered Giza. Upper Egypt is where they live; Giza is the job.
  const asked = cvLibraryRowFromCandidate(
    candidate({ governorate: "Assiut", preferredAreaName: "October", preferredRegionCode: "GZ" }),
  );
  assert.equal(asked.regionCode, "GZ", "the applicant's own answer must beat the address on their CV");
  assert.equal(asked.regionLabel, "Giza");
  assert.equal(asked.regionDeclared, true, "the screen has to be able to say this came from the applicant");
  assert.equal(asked.preferredArea, "October");
  assert.equal(
    asked.governorate,
    "Assiut",
    "declaring a work region must not overwrite where the CV says they live — they are two facts",
  );

  // Nobody asked, so the CV address is the only thing on file. It still answers, and it must be
  // marked as NOT declared, because "we read this off their CV" and "they told us" are different
  // claims to make to a screener.
  const derived = cvLibraryRowFromCandidate(candidate({ governorate: "Assiut" }));
  assert.equal(derived.regionCode, "UE");
  assert.equal(derived.regionLabel, "Upper Egypt");
  assert.equal(derived.regionDeclared, false);
  assert.equal(derived.preferredArea, "", "an area is only ever the applicant's own words");

  // Production stores free text here as well as a code — "Minya" and "Minia Government ( Minia
  // North )" are both real values. A place name resolves through the same governorate map.
  const typed = cvLibraryRowFromCandidate(candidate({ preferredRegionName: "Minya" }));
  assert.equal(typed.regionCode, "UE", "a typed governorate must still place them");
  assert.equal(typed.regionDeclared, true);

  // Typed something we cannot place. The code is null — so the Region filter's "no governorate on
  // file" bucket still finds them — but their words are kept and shown, because a blank cell reads
  // as "never answered" when the truth is "answered, unplaceable".
  const unplaceable = cvLibraryRowFromCandidate(candidate({ preferredRegionName: "Anywhere in Egypt" }));
  assert.equal(unplaceable.regionCode, null);
  assert.equal(unplaceable.regionLabel, "Anywhere in Egypt", "their own words must survive to the screen");
  assert.equal(unplaceable.regionDeclared, true);

  // An address outside Egypt. Two people in production have one, and both used to render exactly
  // like somebody whose CV gave no address at all — same blank cell, same filter bucket. They keep
  // a null code, because Others is a real selling region and filing Dubai there would claim a
  // territory nobody confirmed; what they gain is a label that SAYS so and the country behind it.
  const abroad = cvLibraryRowFromCandidate(candidate({ governorate: "Dubai" }));
  assert.equal(abroad.regionCode, null, "a foreign address is not one of the company's regions");
  assert.equal(abroad.regionLabel, "Outside Egypt", "and it must say so rather than render blank");
  assert.equal(abroad.regionForeignCountry, "United Arab Emirates", "the country is what separates it from a gap");
  assert.equal(abroad.regionDeclared, false, "nobody chose this — it was read off the CV");
  assert.equal(abroad.governorate, "Dubai", "the place itself still shows, in its own column");

  // The distinction has to hold in BOTH directions, or the screen swaps one wrong answer for
  // another: an Egyptian candidate must never pick up a country, and a candidate we know nothing
  // about must never be described as being abroad.
  const egyptian = cvLibraryRowFromCandidate(candidate({ governorate: "Assiut" }));
  assert.equal(egyptian.regionForeignCountry, "", "an Egyptian governorate carries no country");
  assert.equal(
    cvLibraryRowFromCandidate(candidate({})).regionForeignCountry,
    "",
    "an empty row is unknown, not abroad",
  );

  // A stored code that is not one of ours must fall back to the CV rather than blank the cell.
  const junk = cvLibraryRowFromCandidate(candidate({ governorate: "Cairo", preferredRegionCode: "ZZ" }));
  assert.equal(junk.regionCode, "CA", "an unrecognised code must not erase what the CV knows");
  assert.equal(junk.regionDeclared, false);

  // Nothing at all: no code, no label, no area — and never the string "null".
  const nothing = cvLibraryRowFromCandidate(candidate({}));
  assert.equal(nothing.regionCode, null);
  assert.equal(nothing.regionLabel, "");
  assert.equal(nothing.regionDeclared, false);
  assert.equal(nothing.preferredArea, "");

  // THE PARITY ASSERTION, and the reason this maps through the pool's own resolver rather than
  // repeating the rule. Every one of these fixtures must get the same answer from both screens; a
  // second copy of the precedence order is exactly how they drifted apart the first time.
  for (const fixture of [
    candidate({ governorate: "Assiut", preferredAreaName: "October", preferredRegionCode: "GZ" }),
    candidate({ governorate: "Assiut" }),
    candidate({ preferredRegionName: "Minya" }),
    candidate({ governorate: "Cairo", preferredRegionCode: "ZZ" }),
    candidate({}),
  ]) {
    const facts = candidateScreeningFacts(fixture);
    const libraryRow = cvLibraryRowFromCandidate(fixture);
    assert.equal(
      libraryRow.regionCode,
      facts.region?.value.code ?? null,
      "the CV Database and the recruitment pool disagree about this candidate's region",
    );
    assert.equal(
      libraryRow.preferredArea,
      facts.area?.value ?? "",
      "the CV Database and the recruitment pool disagree about the area this candidate asked for",
    );
  }

  // ---------------------------------------------------------------------------
  // The Region filter partitions the pool into three buckets — no gaps, no double counting.
  // ---------------------------------------------------------------------------
  // Mirrors the predicate inside CvDatabaseManager, which lives in a client component and cannot
  // be imported here; the two regex guards above pin the component to this same shape. The
  // property being asserted is the one the Source filter's 561-vs-562 defect broke: every row must
  // be reachable by EXACTLY one option, or a candidate silently exists in the table and in no
  // filter. A two-bucket region filter passes "no gaps" and fails "no double counting", because a
  // foreign row answers to both "Outside Egypt" and "Region not known".
  function matchesRegion(row: Pick<CvLibraryRow, "regionCode" | "regionForeignCountry">, filter: string): boolean {
    if (!filter) return true;
    const region = row.regionCode;
    const foreign = Boolean(row.regionForeignCountry);
    if (filter === "foreign") return foreign;
    if (filter === "unknown") return region === null && !foreign;
    return region === filter;
  }

  // Production's shape on 2026-08-29, scaled down: two placed, two abroad, one with no address.
  const regionPool = [
    cvLibraryRowFromCandidate(candidate({ governorate: "Sharqiya" })),
    cvLibraryRowFromCandidate(candidate({ governorate: "El Menia" })),
    cvLibraryRowFromCandidate(candidate({ governorate: "Dubai" })),
    cvLibraryRowFromCandidate(candidate({ governorate: "Gauteng" })),
    cvLibraryRowFromCandidate(candidate({})),
  ];

  const regionOptions = ["D3", "UE", "foreign", "unknown"];
  for (const row of regionPool) {
    const matching = regionOptions.filter((option) => matchesRegion(row, option));
    assert.equal(
      matching.length,
      1,
      `a row matched ${matching.length} region options, expected exactly 1 (matched: ${matching.join(", ")})`,
    );
  }

  // Each bucket returns the people it claims to, and only those.
  assert.deepEqual(
    regionPool.filter((row) => matchesRegion(row, "foreign")).map((row) => row.regionForeignCountry),
    ["United Arab Emirates", "South Africa"],
    "the Outside Egypt bucket must hold exactly the two foreign addresses",
  );
  assert.equal(
    regionPool.filter((row) => matchesRegion(row, "unknown")).length,
    1,
    "only the candidate with no address at all belongs in Region not known",
  );
  assert.deepEqual(
    regionPool.filter((row) => matchesRegion(row, "D3")).map((row) => row.governorate),
    ["Sharqiya"],
    "Sharqiya must be reachable through the Delta (3) option — this is the defect being fixed",
  );
  assert.equal(regionPool.filter((row) => matchesRegion(row, "")).length, regionPool.length);

  // ---------------------------------------------------------------------------
  // The table must FIT its container — no horizontal scroll.
  // ---------------------------------------------------------------------------
  // Measured on production 2026-08-30 at a 2400px window: the wrapper was 1758px and the table
  // 2460px, so 702px of the row was permanently off-screen behind a horizontal scrollbar. Education
  // alone was 733px and "Doing now" 580px — between them more than half the table.
  //
  // The rule here is that nothing truncates with an ellipsis and nothing wraps, so width cannot be
  // bought by cutting text. It is bought by giving one column several LINES instead of giving
  // several columns one line each — which is the idiom this table already used, applied further.
  assert.equal(
    (managerCode.match(/<th className=\{headCellClassName\}>/g) ?? []).length,
    4,
    "the desktop table grew back past four columns, which is what put it wider than its container",
  );

  // The export must not shrink with the screen. Stacking two facts into one cell is a layout
  // decision; the spreadsheet still carries one column per fact, because a merged column is the one
  // thing nobody can filter or pivot on afterwards.
  for (const header of ["Total experience", "Governorate", "Region", "Area asked for", "CV file"]) {
    assert.ok(
      new RegExp(`"${header}"`).test(managerCode),
      `the export lost its "${header}" column when the screen stopped giving it one`,
    );
  }

  // Education is split at its own field boundary, not mid-string — these are separately-extracted
  // fields on their own lines, which is why this is not text wrapping.
  const split = cvLibraryRowFromCandidate(
    candidate({ degree: "Bachelor", faculty: "Pharmacy", university: "Cairo University", graduationYear: 2019 }),
  );
  assert.equal(split.educationDegree, "Bachelor");
  assert.equal(split.educationFaculty, "Pharmacy");
  assert.equal(split.educationInstitution, "Cairo University (2019)");
  assert.equal(
    split.education,
    "Bachelor \u00b7 Pharmacy \u00b7 Cairo University (2019)",
    "the joined form must survive unchanged — it is what the export writes",
  );

  // The year rides with the institution. A bare year alone on the second line would read as a
  // stray number, so with no university it becomes the institution line itself.
  const noUniversity = cvLibraryRowFromCandidate(candidate({ degree: "Bachelor", graduationYear: 2019 }));
  assert.equal(noUniversity.educationDegree, "Bachelor");
  assert.equal(noUniversity.educationInstitution, "2019");

  // Nothing known: both halves empty, and never the string "undefined".
  const noEducation = cvLibraryRowFromCandidate(candidate({}));
  assert.equal(noEducation.educationDegree, "");
  assert.equal(noEducation.educationFaculty, "");
  assert.equal(noEducation.educationInstitution, "");

  // A custom font SIZE on these cells must stay in the literal bracket form. tailwind-merge
  // silently drops custom NAMED sizes (text-phx-*), and nothing in this repo can see it happen —
  // only getComputedStyle in a real browser can, so it ships looking fine and renders wrong.
  assert.ok(
    /const cellClassName = "[^"]*text-\[13px\]/.test(managerCode),
    "the table cell font size was renamed to a named size, which tailwind-merge will silently drop",
  );
}
