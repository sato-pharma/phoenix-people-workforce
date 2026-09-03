import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { recruitmentAreaRegionOverrides } from "../src/lib/recruitment/candidate-region.ts";
import {
  driveFileNameFor,
  driveFolderPathFor,
  isUnclassifiedPath,
  regionFolderForArea,
  samePath,
  sanitizeDriveSegment,
  UNCLASSIFIED_FOLDER_NAME,
} from "../src/lib/recruitment/drive-cv-folders.ts";
import { escapeDriveQueryValue } from "../src/lib/recruitment/drive-tree.ts";

// The live grouping, as `au.canonical_areas` reports it (verified against production 2026-09-03).
// Only the rows these assertions need — the map is data, not a fixture to keep exhaustive.
const AREA_REGIONS = {
  "Alex Center": "AB",
  "Alex East": "AB",
  "Cairo West": "CA",
  Fayoum: "GZ",
  Ismailia: "OT",
  "Nasr City": "CA",
  Qalubeya: "D1",
  "Sharkia 1": "D2",
  "Sharkia 2": "D2",
  Suez: "OT",
};

export function runDriveCvFolderTests() {
  // ── The tree the owner asked for: region, then area ───────────────────────────────────────────
  //
  // "We will make a folder called, for example, region Alex. In this region, we have Alex Center."
  // The app's own shelf is FLAT (fifty area folders in one list); this nesting exists only in Drive.

  assert.deepEqual(
    driveFolderPathFor({ key: "Alex Center", kind: "medical_rep", label: "Alex Center" }, AREA_REGIONS),
    ["Medical Representative", "Alex-BHR", "Alex Center"],
    "a medical rep's area must sit inside its region folder",
  );

  assert.deepEqual(
    driveFolderPathFor({ key: "Nasr City", kind: "medical_rep", label: "Nasr City" }, AREA_REGIONS),
    ["Medical Representative", "Cairo", "Nasr City"],
    "the region folder is the company's own region NAME, not its code",
  );

  // ── The Delta (3) trap ────────────────────────────────────────────────────────────────────────
  //
  // The sales geography was DELIBERATELY left alone when Delta (3) opened, so `au.canonical_areas`
  // still files these five under their old regions. Reading that column straight would put a Delta
  // (3) applicant's CV in the Delta (2) folder — a mis-file nobody would ever find, because nobody
  // opens Delta (2) looking for it. `recruitmentRegionForArea` is what prevents it, and this is the
  // assertion that proves the Drive tree actually goes through it.

  assert.deepEqual(
    driveFolderPathFor({ key: "Sharkia 1", kind: "medical_rep", label: "Sharkia 1" }, AREA_REGIONS),
    ["Medical Representative", "Delta (3)", "Sharkia 1"],
    "Sharkia 1 is a Delta (3) recruitment area even though sales still files it under Delta (2)",
  );
  assert.equal(regionFolderForArea("Suez", AREA_REGIONS), "Delta (3)", "Suez recruits into Delta (3), not Others");
  assert.equal(regionFolderForArea("Fayoum", AREA_REGIONS), "Giza", "an area with no override keeps its sales region");

  // Every overridden area must actually reach Delta (3) through the Drive path — a rename on either
  // side would otherwise silently drop the override, which is the failure this pins.
  for (const areaName of Object.keys(recruitmentAreaRegionOverrides)) {
    assert.deepEqual(
      driveFolderPathFor({ key: areaName, kind: "medical_rep", label: areaName }, AREA_REGIONS),
      ["Medical Representative", "Delta (3)", areaName],
      `${areaName} must file under Delta (3)`,
    );
  }

  // An area the map does not know files one level UP rather than under a guessed region. A shallow
  // folder is recoverable; a confidently wrong one is not.
  assert.deepEqual(
    driveFolderPathFor({ key: "Somewhere New", kind: "medical_rep", label: "Somewhere New" }, AREA_REGIONS),
    ["Medical Representative", "Somewhere New"],
    "an unknown area must not be filed under a guessed region",
  );

  // ── The other three shelves ───────────────────────────────────────────────────────────────────

  assert.deepEqual(
    driveFolderPathFor({ key: "AB", kind: "district_manager", label: "Alex-BHR" }, AREA_REGIONS),
    ["District Manager", "Alex-BHR"],
    "a district manager files by region, one level deep",
  );
  assert.deepEqual(
    driveFolderPathFor({ key: "Regulatory Affairs Specialist", kind: "other", label: "Regulatory Affairs Specialist" }, AREA_REGIONS),
    ["Other positions", "Regulatory Affairs Specialist"],
    "every other role files under its job title",
  );
  // The paramedical shelf holds exactly one folder, so the shelf IS the folder — a nested
  // "Paramedical / Paramedical" would be pure noise.
  assert.deepEqual(
    driveFolderPathFor({ key: "Paramedical", kind: "paramedical", label: "Paramedical" }, AREA_REGIONS),
    ["Paramedical"],
    "the paramedical shelf is one folder, not a folder inside a folder",
  );

  // ── The holding folder ────────────────────────────────────────────────────────────────────────
  //
  // The common case at the moment a CV arrives: the applicant sends the file first and answers the
  // questions later, or never. 303 of 510 WhatsApp candidates on 2026-09-03 were in exactly this
  // state, so this path carries the majority of CVs and must be a real, visible folder.

  assert.deepEqual(driveFolderPathFor(null, AREA_REGIONS), [UNCLASSIFIED_FOLDER_NAME]);
  assert.deepEqual(driveFolderPathFor(undefined, AREA_REGIONS), [UNCLASSIFIED_FOLDER_NAME]);
  assert.ok(isUnclassifiedPath([UNCLASSIFIED_FOLDER_NAME]), "the holding path must be recognisable");
  assert.ok(!isUnclassifiedPath(["Medical Representative", "Cairo", "Nasr City"]));

  // ── Names that would break a folder ───────────────────────────────────────────────────────────
  //
  // Drive permits "/" inside a name, which is exactly the problem: a free-typed job title on the
  // "other" shelf is the one folder name a person enters by hand.
  assert.equal(
    sanitizeDriveSegment("Sales / Marketing Coordinator"),
    "Sales - Marketing Coordinator",
    "a slash in a typed job title must not read as a second folder level",
  );
  assert.equal(sanitizeDriveSegment("  Nasr   City  "), "Nasr City", "inner whitespace is collapsed like the app's own keys");
  assert.equal(sanitizeDriveSegment(".hidden."), "hidden", "a leading or trailing dot reads as a hidden folder");
  assert.equal(sanitizeDriveSegment("Tanta\u0000\u001f"), "Tanta", "control characters are stripped, not preserved");

  // The path resolver must apply the same cleaning, not just the direct helper.
  assert.deepEqual(
    driveFolderPathFor({ key: "Sales / Marketing", kind: "other", label: "Sales / Marketing" }, AREA_REGIONS),
    ["Other positions", "Sales - Marketing"],
    "the resolver sanitizes, so no caller can introduce a separator",
  );

  // ── The Drive query language ──────────────────────────────────────────────────────────────────
  //
  // Folder names are concatenated into a Drive `q=` string. An apostrophe — "Manager's Assistant",
  // typed on the free-text shelf — would terminate the literal and either error or match the wrong
  // folder. Backslash is escaped FIRST so it cannot smuggle the quote past the second replacement.
  assert.equal(escapeDriveQueryValue("Manager's Assistant"), "Manager\\'s Assistant");
  assert.equal(escapeDriveQueryValue("back\\slash"), "back\\\\slash");
  assert.equal(escapeDriveQueryValue("both\\'s"), "both\\\\\\'s", "a backslash must not be usable to escape the escape");

  // ── The file's own name ───────────────────────────────────────────────────────────────────────
  //
  // The original filename is deliberately discarded: what applicants actually send is "CV.pdf" and
  // "cv (1).pdf", identical across dozens of people, in the one place the name is read.

  assert.equal(
    driveFileNameFor({
      candidateName: "Ahmed Mohamed Saleh",
      mimeType: "application/pdf",
      phone: "+20 100 123 4567",
    }),
    "Ahmed Mohamed Saleh - 201001234567.pdf",
    "the file is named for the person, then the number that disambiguates them",
  );
  // A CV whose name extraction has not run yet is still filed and still findable — not skipped, and
  // certainly not given an invented name.
  assert.equal(
    driveFileNameFor({ candidateName: null, mimeType: "application/pdf", phone: "201001234567" }),
    "201001234567.pdf",
    "a nameless candidate is filed under their number rather than skipped",
  );
  assert.equal(
    driveFileNameFor({ candidateName: null, mimeType: null, phone: null }),
    "Unnamed CV",
    "with neither name nor number the file still gets a name",
  );
  // A mime type the table does not list falls back to the original file's extension — an unlisted
  // type is not a reason to write a file the owner's phone cannot open.
  assert.equal(
    driveFileNameFor({
      candidateName: "Mona Ali",
      mimeType: "application/x-unknown",
      originalFileName: "mona.docx",
      phone: "201002223333",
    }),
    "Mona Ali - 201002223333.docx",
    "an unlisted mime type falls back to the original extension",
  );
  assert.equal(
    driveFileNameFor({ candidateName: "Sara / Ali", mimeType: "image/jpeg", phone: "201005556666" }),
    "Sara - Ali - 201005556666.jpg",
    "a slash in a candidate's name must not split the file into a folder",
  );

  // ── samePath ──────────────────────────────────────────────────────────────────────────────────
  assert.ok(samePath(["a", "b"], ["a", "b"]));
  assert.ok(!samePath(["a", "b"], ["a", "b", "c"]), "a deeper path is a different path");
  assert.ok(!samePath(["a", "b"], ["a", "c"]));

  // ── The backfill script must not drift from the live module ───────────────────────────────────
  //
  // scripts/backfill-cvs-to-drive.mjs re-implements the placement tables, because it runs as a bare
  // node script with no TypeScript path resolution. That duplication is the drift risk, so it is
  // pinned here: if the Delta (3) overrides or the region names change on one side and not the
  // other, the backfill would file 950 CVs into folders the live intake never uses again.

  const backfillSource = fs.readFileSync(
    path.join(process.cwd(), "scripts", "backfill-cvs-to-drive.mjs"),
    "utf8",
  );
  // Read the override table itself, not the whole file: a bare includes("Suez") keeps passing on any
  // stray mention of the word elsewhere in the script, which is how a drift guard goes quietly vacuous.
  const tableStart = backfillSource.indexOf("const RECRUITMENT_AREA_REGION_OVERRIDES = {");
  assert.ok(tableStart >= 0, "the backfill script must still declare RECRUITMENT_AREA_REGION_OVERRIDES");
  const tableEnd = backfillSource.indexOf("};", tableStart);
  assert.ok(tableEnd > tableStart, "the override table must be a closed object literal");
  const overrideTable = backfillSource.slice(tableStart, tableEnd);

  for (const areaName of Object.keys(recruitmentAreaRegionOverrides)) {
    assert.ok(
      overrideTable.includes(`${areaName}: "D3"`) || overrideTable.includes(`"${areaName}": "D3"`),
      `the backfill script must carry the Delta (3) override for ${areaName}`,
    );
  }
  for (const label of ["Alex-BHR", "Delta (3)", "Upper Egypt", "Medical Representative", "Not yet classified"]) {
    assert.ok(backfillSource.includes(label), `the backfill script must carry the label ${label}`);
  }
  assert.equal(
    Object.keys(recruitmentAreaRegionOverrides).length,
    5,
    "Delta (3) covers five areas — if this changes, update the backfill script's copy too",
  );

  // ── Both readers of the area→region grouping must use the PUBLIC view ─────────────────────────
  //
  // This shipped broken once. `au.canonical_areas` is the real table, so `.schema("au")` reads like
  // the honest source — but PostgREST exposes only public, graphql_public and analytics, so it
  // answers PGRST106 "Invalid schema: au". The backfill surfaced it immediately; the live mirror did
  // NOT, because every path into it is best-effort and swallows the error. The visible result would
  // have been every CV, for ever, in "Not yet classified" — with nothing on screen saying so.
  //
  // Pinned as source text rather than behaviour because the failure is a network round-trip away:
  // a unit test cannot reach PostgREST, and by the time production could tell us, it is already
  // filing CVs into the wrong folder silently.

  const mirrorSource = fs.readFileSync(
    path.join(process.cwd(), "src", "lib", "recruitment", "drive-cv-mirror.ts"),
    "utf8",
  );
  // The FUNCTION BODY, not the whole file — the comment above it names the wrong call on purpose, to
  // explain why it is wrong, and a whole-file scan would read that explanation as the defect.
  const loaderStart = mirrorSource.indexOf("export async function loadAreaRegionMap(");
  assert.ok(loaderStart >= 0, "the Drive mirror must still export loadAreaRegionMap");
  const loaderEnd = mirrorSource.indexOf("\n}", loaderStart);
  assert.ok(loaderEnd > loaderStart, "loadAreaRegionMap must be a closed function body");
  const loaderBody = mirrorSource.slice(loaderStart, loaderEnd);

  assert.ok(
    loaderBody.includes('.from("au_v_canonical_areas")'),
    "the Drive mirror must read the public view au_v_canonical_areas",
  );
  assert.ok(
    !loaderBody.includes('.schema("au")'),
    'the Drive mirror must never call .schema("au") — PostgREST does not expose that schema',
  );
  assert.ok(
    backfillSource.includes("au_v_canonical_areas?select="),
    "the backfill script must read the public view au_v_canonical_areas",
  );
  assert.ok(
    !backfillSource.includes('"Accept-Profile": "au"'),
    "the backfill script must not ask PostgREST for the au schema profile",
  );
}
