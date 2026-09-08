import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  candidateRegionForGovernorate,
  foreignCountryForGovernorate,
  recruitmentAreaRegionOverrides,
} from "../src/lib/recruitment/candidate-region.ts";
import { egyptRegionFromFreeText } from "../src/lib/recruitment/candidate-region-freetext.ts";
import { inferCandidatePlacement } from "../src/lib/recruitment/candidate-folder-inference.ts";
import {
  areaGovernorateFolder,
  areaGovernorateFolders,
  driveFileNameFor,
  driveFolderPathFor,
  driveInferredFolderPath,
  INFERRED_FOLDER_NAME,
  isInferredPath,
  isUnclassifiedPath,
  NO_LOCATION_FOLDER_NAME,
  readsAsAJobTitle,
  governorateFolderFromTypedArea,
  governorateFolderNames,
  regionFolderForArea,
  regionFolderFromTypedArea,
  samePath,
  sanitizeDriveSegment,
  UNCLASSIFIED_FOLDER_NAME,
  UNREADABLE_TITLE_FOLDER_NAME,
} from "../src/lib/recruitment/drive-cv-folders.ts";
import { escapeDriveQueryValue } from "../src/lib/recruitment/drive-tree.ts";

// The live grouping, as `au.canonical_areas` reports it (re-read from production 2026-09-04).
//
// EVERY area the governorate map groups is here, and that is load-bearing rather than tidy: the
// invariant below walks all of them to prove no governorate parent straddles two regions. The rest
// are the standalone areas individual assertions need.
const AREA_REGIONS = {
  "Alex Center": "AB",
  "Alex East": "AB",
  "Alex West": "AB",
  Aswan: "OT",
  "Aswan (Legacy)": "OT",
  "Assuit 1": "UE",
  "Assuit 2": "UE",
  "Behira 1": "AB",
  "Behira 2": "AB",
  "Cairo East 1": "CA",
  "Cairo East 2": "CA",
  "Cairo West": "CA",
  "Dakahlia 1": "D2",
  "Dakahlia 2": "D2",
  "Dakahlia 3": "D2",
  Fayoum: "GZ",
  "Gharbia 1 (Tanta)": "D1",
  "Gharbia 2 (Mahalla)": "D1",
  Ismailia: "OT",
  "Kafr El-Sheikh 1": "D1",
  "Kafr El-Sheikh 2": "D1",
  "Menoufia 1": "D1",
  "Menoufia 2": "D1",
  "Minia 1": "UE",
  "Minia 2": "UE",
  "Nasr City": "CA",
  Qalubeya: "D1",
  "Qena 1": "UE",
  "Qena 2": "UE",
  "Sharkia 1": "D2",
  "Sharkia 2": "D2",
  Sohag1: "UE",
  Sohag2: "UE",
  Suez: "OT",
};

export function runDriveCvFolderTests() {
  // ── The tree the owner asked for: region, then area ───────────────────────────────────────────
  //
  // "We will make a folder called, for example, region Alex. In this region, we have Alex Center."
  // The app's own shelf is FLAT (fifty area folders in one list); this nesting exists only in Drive.

  assert.deepEqual(
    driveFolderPathFor({ key: "Alex Center", kind: "medical_rep", label: "Alex Center" }, AREA_REGIONS),
    ["Medical Representative", "Alex-BHR", "Alex", "Alex Center"],
    "a medical rep's area sits inside its region — and, where the city is split, inside its governorate too",
  );

  assert.deepEqual(
    driveFolderPathFor({ key: "Nasr City", kind: "medical_rep", label: "Nasr City" }, AREA_REGIONS),
    ["Medical Representative", "Cairo", "Nasr City"],
    "the region folder is the company's own region NAME, not its code",
  );

  // ── The governorate parent, for a city the company cuts in half ───────────────────────────────
  //
  // Owner, 2026-09-04: "we can make a folder called Qena and inside we have two folders, Qena 1 and
  // Qena 2. If we can identify which one he is from we put him in the folder. If we can't identify
  // we put him general in the folder which is called Qena."
  //
  // So the tree grows one rung, and only where the company actually splits a governorate.

  assert.deepEqual(
    driveFolderPathFor({ key: "Qena 1", kind: "medical_rep", label: "Qena 1" }, AREA_REGIONS),
    ["Medical Representative", "Upper Egypt", "Qena", "Qena 1"],
    "a declared half sits inside its governorate folder",
  );

  // An area that is nobody's half keeps the shape it has always had. Adding a "Fayoum" folder
  // holding one "Fayoum" folder would be pure noise, and the same is true of the other five.
  for (const standalone of ["Fayoum", "Nasr City", "Cairo West", "Qalubeya", "Ismailia", "Suez"] as const) {
    assert.equal(
      areaGovernorateFolder(standalone),
      null,
      `${standalone} is not half of anything and must group under no parent`,
    );
    assert.equal(
      driveFolderPathFor({ key: standalone, kind: "medical_rep", label: standalone }, AREA_REGIONS).length,
      3,
      `${standalone} keeps the two-level shape: region, then area`,
    );
  }

  // WHY THIS IS A REVIEWED MAP AND NOT A PATTERN. Every one of these four is live in
  // `au.canonical_areas` today, and every one of them defeats an obvious derivation rule.
  assert.equal(areaGovernorateFolder("Gharbia 1 (Tanta)"), "Gharbia", "a city after the number: stripping a trailing digit fails");
  assert.equal(areaGovernorateFolder("Sohag1"), "Sohag", "no space before the number");
  assert.equal(areaGovernorateFolder("Cairo East 1"), "Cairo East", "the parent is TWO words");
  assert.equal(
    areaGovernorateFolder("Cairo West"),
    null,
    "Cairo West shares a first word with Cairo East and is a different place — a first-word rule would swallow it",
  );
  assert.equal(
    areaGovernorateFolder("Aswan (Legacy)"),
    null,
    "a retired area must not fold live Aswan CVs into a territory nobody sells",
  );
  assert.equal(areaGovernorateFolder("Aswan"), null, "live Aswan is a single area, not a half");
  // Names that merely CONTAIN a separator are single areas, not a parent and a half.
  for (const oneArea of [
    "Port said - Domiat",
    "Haram - Faisal",
    "Helwan-Maadi",
    "Giza - Giza Centers",
    "Dokki - Mohandseen - Bolak",
    "Imbaba - Imbaba Centers",
  ] as const) {
    assert.equal(areaGovernorateFolder(oneArea), null, `${oneArea} is one area whose NAME holds a separator`);
  }

  // THE INVARIANT. A parent folder lives inside exactly one region folder, so if two areas sharing a
  // parent ever resolved to different regions the parent would appear twice and split its own CVs in
  // half — the precise failure this feature exists to prevent. Walked over the whole map, not a
  // sample, and over the RECRUITMENT region so the Delta (3) override is included.
  const membersByParent = new Map<string, string[]>();
  for (const [area, parent] of Object.entries(areaGovernorateFolders)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(AREA_REGIONS, area),
      `${area} is grouped under ${parent} but missing from the production fixture — add it, or the invariant below silently skips it`,
    );
    membersByParent.set(parent, [...(membersByParent.get(parent) ?? []), area]);
  }
  for (const [parent, members] of membersByParent) {
    const regions = new Set(members.map((area) => regionFolderForArea(area, AREA_REGIONS)));
    assert.equal(
      regions.size,
      1,
      `every area under "${parent}" must resolve to ONE region, got: ${[...regions].join(", ")}`,
    );
    assert.ok(members.length >= 2, `"${parent}" groups ${members.length} area(s) — a parent over one area is noise`);
  }
  assert.deepEqual(
    governorateFolderNames(),
    ["Alex", "Assuit", "Behira", "Cairo East", "Dakahlia", "Gharbia", "Kafr El-Sheikh", "Menoufia", "Minia", "Qena", "Sharkia", "Sohag"],
    "the governorate level is exactly these parents",
  );

  // A CITY never reaches a parent. "Tanta" IS Gharbia 1 and "Mahalla" IS Gharbia 2, so sending
  // either to the parent would throw away a half we can actually identify — while sending it to the
  // numbered area would be inference the owner's rule never asked for. Both fall through instead.
  for (const city of ["Tanta", "Mahalla"] as const) {
    assert.equal(governorateFolderFromTypedArea(city), null, `${city} names a half, not a governorate`);
    assert.ok(
      !driveFolderPathFor({ key: city, kind: "medical_rep", label: city }, AREA_REGIONS).includes("Gharbia"),
      `${city} must not be filed into the Gharbia parent`,
    );
  }

  // And the one-word trap that made `kafr` and `sheikh` unusable as keys: Kafr El-Dawar is in
  // BEHIRA and Sheikh Zayed is in GIZA. A bare-word match would file both under Kafr El-Sheikh.
  for (const elsewhere of ["Kafr El-Dawar", "Sheikh Zayed"] as const) {
    assert.notEqual(
      governorateFolderFromTypedArea(elsewhere),
      "Kafr El-Sheikh",
      `${elsewhere} is not in Kafr El-Sheikh`,
    );
  }

  // The two shelves that are not areas never grow this level.
  assert.deepEqual(
    driveFolderPathFor({ key: "UE", kind: "district_manager", label: "Upper Egypt" }, AREA_REGIONS),
    ["District Manager", "Upper Egypt"],
    "a district manager files by region only — the governorate level is a medical-rep shape",
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
    ["Medical Representative", "Delta (3)", "Sharkia", "Sharkia 1"],
    "Sharkia 1 is a Delta (3) recruitment area even though sales still files it under Delta (2)",
  );
  assert.equal(regionFolderForArea("Suez", AREA_REGIONS), "Delta (3)", "Suez recruits into Delta (3), not Others");
  assert.equal(regionFolderForArea("Fayoum", AREA_REGIONS), "Giza", "an area with no override keeps its sales region");

  // Every overridden area must actually reach Delta (3) through the Drive path — a rename on either
  // side would otherwise silently drop the override, which is the failure this pins.
  // Two of the five (Sharkia 1 and 2) also sit under a governorate parent and three stand alone, so
  // the expected depth is read from the same map the code reads rather than assumed to be one shape.
  for (const areaName of Object.keys(recruitmentAreaRegionOverrides)) {
    const governorate = areaGovernorateFolder(areaName);
    assert.deepEqual(
      driveFolderPathFor({ key: areaName, kind: "medical_rep", label: areaName }, AREA_REGIONS),
      governorate
        ? ["Medical Representative", "Delta (3)", governorate, areaName]
        : ["Medical Representative", "Delta (3)", areaName],
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

  // ── The backfill script must DELEGATE, never keep its own copy ─────────────────────────────────
  //
  // This pin used to assert the exact opposite, and the story of why it flipped is the reason to
  // keep reading. scripts/backfill-cvs-to-drive.mjs carried its own region labels, its own Delta (3)
  // overrides, its own shelf labels and its own sanitizer, because a bare node script has no
  // TypeScript path resolution. This test pinned that duplication in place and tried to hold the two
  // copies equal by hand.
  //
  // That failed the way a copy always fails: silently, and only once somebody IMPROVES the original.
  // The script's own `--verify` mode reported 0 CVs in the wrong folder while it read its own
  // tables, and 5 the moment it read the app's — four hand-typed governorates and one Arabic
  // sentence that had become a Drive folder. The copy was not merely redundant, it was hiding real
  // damage from the very check written to find it.
  //
  // So the assertion is inverted. The script resolves `@/` through tests/alias-loader.mjs and
  // imports the live modules; what is pinned now is that it holds no private copy left to drift.
  const backfillSource = fs.readFileSync(
    path.join(process.cwd(), "scripts", "backfill-cvs-to-drive.mjs"),
    "utf8",
  );

  // The anti-pattern, by name. A future session reaching for a local table is the thing to catch,
  // and it is cheaper to catch here than in a folder tree holding 960 people's CVs.
  for (const copied of [
    "const RECRUITMENT_AREA_REGION_OVERRIDES",
    "const REGION_LABELS",
    "const SHELF_LABELS",
    "function sanitize",
  ]) {
    assert.ok(
      !backfillSource.includes(copied),
      `the backfill script must not re-declare ${copied} — it imports the live one`,
    );
  }

  // And the delegation itself, so that removing a copy can never quietly remove the behaviour too.
  //
  // AMENDED 2026-09-08, and the amendment is the second half of this pin's story. The list named the
  // OLD tree's modules, and was right to until the cabinet shipped (#3454) and the script's folder
  // rule moved to `drive-cabinet-folders`. After that, pinning the old imports held the script
  // delegating correctly to the wrong module — real delegation, wrong target, which is a state this
  // test was shaped to call healthy. `--verify` then reported 913 of 1,171 mirrored CVs misfiled,
  // and `--refile` acts on that comparison: following it would have moved them back out of the
  // cabinet. What is pinned here is DELEGATION, never a particular module, so the list has to follow
  // the rule the app actually runs rather than the one it used to.
  for (const imported of [
    'from "@/lib/recruitment/drive-cabinet-folders"',
    'from "@/lib/recruitment/drive-cv-folders"',
    "cabinetPathFor",
    "sanitizeDriveSegment",
  ]) {
    assert.ok(backfillSource.includes(imported), `the backfill script must import ${imported}`);
  }
  assert.ok(
    !backfillSource.includes("[UNCLASSIFIED]"),
    "no path in the backfill may still fall back to the flat holding folder",
  );

  // The Delta (3) override reaching the backfill is no longer two tables agreeing — it is the same
  // function call the live intake makes, pinned by behaviour a few lines below ("an inferred
  // Delta (3) governorate files where recruitment says"). The count stays so that an override table
  // silently emptied still fails something here.
  assert.equal(Object.keys(recruitmentAreaRegionOverrides).length, 5, "Delta (3) covers five areas");

  // ── Inference: a CV with no declared answers still gets a real folder ──────────────────────────
  //
  // The owner's instruction on 2026-09-04: "I don't want a CV sitting with no folder." Measured that
  // day, 529 candidates holding a stored CV had never answered the WhatsApp questions, and 387 of
  // them had a governorate the CV extractor had ALREADY read and stored. They were all in one flat
  // folder. These assertions pin the recovery, and pin the limits on it.

  // The governorate route - the one that carries 378 of the 387.
  assert.deepEqual(
    driveInferredFolderPath(inferCandidatePlacement({ governorate: "Sohag" })),
    [INFERRED_FOLDER_NAME, "Upper Egypt"],
    "a governorate the CV names must reach its region folder",
  );
  assert.deepEqual(
    driveInferredFolderPath(inferCandidatePlacement({ governorate: "Sharqia" })),
    [INFERRED_FOLDER_NAME, "Delta (3)"],
    "an inferred Delta (3) governorate files where recruitment says, exactly as a declared one does",
  );

  // The free-text address, when the governorate column is empty.
  assert.deepEqual(
    driveInferredFolderPath(inferCandidatePlacement({ address: "12 Gameat El Dowal, Giza, Egypt" })),
    [INFERRED_FOLDER_NAME, "Giza"],
    "an address must be read when the governorate column is blank",
  );

  // A vacancy a recruiter actually sent them for outranks both - it is a person's action.
  assert.deepEqual(
    driveInferredFolderPath(inferCandidatePlacement({ governorate: "Cairo", sentForRegion: "AB" })),
    [INFERRED_FOLDER_NAME, "Alex-BHR"],
    "a vacancy a recruiter sent the candidate for outranks the extracted governorate",
  );
  // ...but only when it names a region that exists. A typo must not become a folder.
  assert.deepEqual(
    driveInferredFolderPath(inferCandidatePlacement({ governorate: "Cairo", sentForRegion: "ZZ" })),
    [INFERRED_FOLDER_NAME, "Cairo"],
    "an unrecognised region code is ignored rather than turned into a folder",
  );

  // Outside Egypt is a real answer, not a blank - and it must not pollute the Egyptian region list.
  assert.deepEqual(
    driveInferredFolderPath(inferCandidatePlacement({ governorate: "Dubai" })),
    [INFERRED_FOLDER_NAME, "Outside Egypt", "United Arab Emirates"],
    "a foreign address files under its country, one level below Outside Egypt",
  );

  // Nothing at all is STILL a folder. This is the assertion that carries the owner's instruction.
  assert.deepEqual(
    driveInferredFolderPath(inferCandidatePlacement({})),
    [INFERRED_FOLDER_NAME, NO_LOCATION_FOLDER_NAME],
    "a record naming nowhere still gets a folder, never the flat pile",
  );
  assert.deepEqual(
    driveInferredFolderPath(null),
    [INFERRED_FOLDER_NAME, NO_LOCATION_FOLDER_NAME],
    "a null placement is a folder too - there is no path that returns nothing",
  );

  // THE LINE: an inference never enters the confirmed tree, and is always recognisable as a guess.
  assert.ok(isInferredPath(driveInferredFolderPath(inferCandidatePlacement({ governorate: "Cairo" }))));
  assert.ok(!isInferredPath(driveFolderPathFor({ key: "Nasr City", kind: "medical_rep", label: "Nasr City" }, AREA_REGIONS)));
  for (const shelf of ["Medical Representative", "District Manager", "Other positions", "Paramedical"]) {
    assert.notEqual(INFERRED_FOLDER_NAME, shelf, "the inferred shelf must never collide with a real one");
  }
  // It stops at REGION. Area is where a wrong folder becomes unfindable, so it is never guessed.
  for (const gov of ["Cairo", "Sohag", "Sharqia", "Giza", "Alexandria"]) {
    assert.equal(
      driveInferredFolderPath(inferCandidatePlacement({ governorate: gov })).length,
      2,
      `an inferred path stops at the region for ${gov} - it must never guess an area`,
    );
  }

  // The three spellings production held that the map did not recognise, found by auditing the live
  // rows on 2026-09-04. Each was one real candidate whose CV had nowhere to go.
  assert.equal(candidateRegionForGovernorate("Albuhayra"), "AB", "Albuhayra is Beheira");
  assert.equal(candidateRegionForGovernorate("Bani - seuf"), "GZ", "Bani - seuf is Beni Suef");
  assert.equal(candidateRegionForGovernorate("Kafr El-Shiekh"), "D1", "the transposed Shiekh spelling");

  // A blank stays blank. The normaliser must not turn an empty field into a confident answer.
  for (const empty of ["", "   ", null, undefined]) {
    assert.equal(candidateRegionForGovernorate(empty), null, "an empty governorate resolves to nothing");
  }

  // ── The free-text reader, and the two traps that sit on it ────────────────────────────────────
  //
  // Second audit pass, production 2026-09-04: 53 candidates holding a CV had NO governorate and an
  // address the map could not read. Every town below is one of them. They are read now.
  for (const [text, want] of [
    ["Damanhour, Damanhour 22511", "AB"],
    ["Baltim, Kafr El-Sheikh, Egypt", "D1"],
    ["Naga Hammadi, Egypt", "UE"],
    ["10th of Ramadan", "D3"],
    ["Zifta, Gharbiyah, Egypt", "D1"],
    ["Itay El-Baroud, Egypt", "AB"],
    ["Bani Swef city", "GZ"],
  ] as const) {
    assert.equal(egyptRegionFromFreeText(text), want, `a street address must place ${text}`);
  }

  // Arabic, and the two misspellings production produces that the map did not carry.
  assert.equal(egyptRegionFromFreeText("الدقهلية"), "D2", "an Arabic governorate must resolve");
  assert.equal(egyptRegionFromFreeText("Behaira"), "AB", "Behaira is Beheira");
  assert.equal(egyptRegionFromFreeText("Kafr Elshikh"), "D1", "the Elshikh spelling");

  // TRAP 1 — why this does not call `resolveGovernorate`. That helper matches with a bare
  // `includes`, so the Dakahlia alias "aga" matches INSIDE "Sagamu" and a Nigerian CV resolves to
  // Dakahlia — filed in a Delta folder, in Egypt, for ever. Whole-word matching is what stops it,
  // and this assertion is the reason the matching may never be loosened back.
  assert.equal(
    egyptRegionFromFreeText("Sagamu, Ogun State, Nigeria"),
    null,
    "a foreign address must never resolve to an Egyptian region",
  );
  assert.equal(foreignCountryForGovernorate("Sagamu, Ogun State, Nigeria"), "Nigeria");

  // TRAP 2 — "riyadh" is the Saudi capital AND a real town in Kafr El-Sheikh. An explicit Egyptian
  // signal has to be asked for first, or an Egyptian CV files under Outside Egypt.
  assert.equal(
    egyptRegionFromFreeText("Riyadh, Kafr El-Sheikh"),
    "D1",
    "an Egyptian governorate in the text outranks a foreign city name sharing a town's name",
  );

  // The rest of the world reaches its own country rather than the no-location shelf.
  for (const [text, country] of [
    ["Karachi, Pakistan", "Pakistan"],
    ["Delhi, India", "India"],
    ["AMMAN - JORDAN", "Jordan"],
    ["Tangerang, Banten, Indonesia", "Indonesia"],
    ["Lalitpur, Nepal", "Nepal"],
    ["Azmi Street, Tripoli", "Libya"],
    ["Sampaloc Manila", "Philippines"],
    ["NJ, USA", "United States"],
    ["Riyadh, Saudi Arabia", "Saudi Arabia"],
  ] as const) {
    assert.equal(egyptRegionFromFreeText(text), null, `${text} is not in Egypt`);
    assert.equal(foreignCountryForGovernorate(text), country, `${text} is ${country}`);
  }

  // Text that names a place nobody can act on stays null — never folded into "Others", which is a
  // real selling region with real areas in it.
  for (const nothing of ["Email :", "Egypt", "", "   "]) {
    assert.equal(egyptRegionFromFreeText(nothing), null, `${JSON.stringify(nothing)} names no region`);
  }

  // ── What the applicant said themselves ────────────────────────────────────────────────────────
  //
  // `preferred_region_code` is the region the APPLICANT chose in WhatsApp. It is saved per answer,
  // so an abandoned conversation leaves a real stated region with no `preferences_declared_at`.
  assert.deepEqual(
    driveInferredFolderPath(inferCandidatePlacement({ preferredRegionCode: "D3" })),
    [INFERRED_FOLDER_NAME, "Delta (3)"],
    "a stated region preference must reach its folder",
  );
  assert.equal(
    inferCandidatePlacement({ preferredRegionCode: "CA", governorate: "Sohag" })?.basis,
    "declared-preference",
    "what the applicant said outranks what the extractor read",
  );
  assert.equal(
    inferCandidatePlacement({ sentForRegion: "AB", preferredRegionCode: "CA", governorate: "Sohag" })?.basis,
    "vacancy",
    "being put forward for a vacancy outranks a stated preference",
  );
  assert.equal(
    inferCandidatePlacement({ preferredRegionCode: "ZZ", governorate: "Sohag" })?.basis,
    "governorate",
    "an unrecognised preference code is ignored, not turned into a folder",
  );

  // Still region-only, on the address route too — an address names a street, never an area.
  assert.equal(
    driveInferredFolderPath(inferCandidatePlacement({ address: "Damanhour, Damanhour 22511" })).length,
    2,
    "an address-derived path stops at the region",
  );

  // ── A hand-typed area still gets a region above it ────────────────────────────────────────────
  //
  // Six CVs were found on 2026-09-04 sitting directly under "Medical Representative" with nothing
  // above them, because the applicant typed a GOVERNORATE where the flow wanted one of our areas.
  // Loose at the top of a 900-CV shelf is the worst outcome there is: the file is present and
  // effectively unfindable. Each of these is one of those six, verbatim.
  //
  // Each lands on the GOVERNORATE parent, which is the honest depth: the governorate is known and
  // the half is not. That is the owner's rule of 2026-09-04, and it puts the CV beside the numbered
  // folders a recruiter already opens instead of loose among every CV in the region.
  for (const [typed, region, governorate] of [
    ["Qena north", "Upper Egypt", "Qena"],
    ["Qena", "Upper Egypt", "Qena"],
    ["Minia Government", "Upper Egypt", "Minia"],
    ["kafrelsheikh", "Delta (1)", "Kafr El-Sheikh"],
    ["Kafr El-Sheikh", "Delta (1)", "Kafr El-Sheikh"],
  ] as const) {
    assert.deepEqual(
      driveFolderPathFor({ key: typed, kind: "medical_rep", label: typed }, AREA_REGIONS),
      ["Medical Representative", region, governorate],
      `a typed governorate must nest under its region and its own parent folder: ${typed}`,
    );
  }

  // The rule that survived the change: the applicant's OWN WORDS never become a folder. "Qena north"
  // files into "Qena" — a folder the company owns — and never into a folder called "Qena north",
  // which would read beside the real "Qena 1" and "Qena 2" as a territory nobody owns and no target
  // covers. What is written down is what is known; the exact words stay on the candidate record.
  assert.deepEqual(
    driveFolderPathFor({ key: "Qena north", kind: "medical_rep", label: "Qena north" }, AREA_REGIONS),
    ["Medical Representative", "Upper Egypt", "Qena"],
    "a hand-typed area never becomes a folder of its own",
  );
  assert.ok(
    !driveFolderPathFor({ key: "Qena north", kind: "medical_rep", label: "Qena north" }, AREA_REGIONS).includes(
      "Qena north",
    ),
    "the applicant's typed words must appear in no segment of the path",
  );

  // And it never guesses the HALF. Landing on "Qena 1" would be a coin flip written down as fact,
  // and a recruiter reading that folder has no way to tell it from a real declared area.
  for (const half of ["Qena 1", "Qena 2"] as const) {
    assert.ok(
      !driveFolderPathFor({ key: "Qena", kind: "medical_rep", label: "Qena" }, AREA_REGIONS).includes(half),
      `a governorate with no half declared must never be filed into ${half}`,
    );
  }

  // A real area is untouched — three levels, area innermost. Sharkia 2 also pins the recruitment
  // override: the SALES map above still calls it Delta (2), and recruitment files it under
  // Delta (3). Reading the sales column directly here is the exact mis-file that override prevents.
  assert.deepEqual(
    driveFolderPathFor({ key: "Sharkia 2", kind: "medical_rep", label: "Sharkia 2" }, AREA_REGIONS),
    ["Medical Representative", "Delta (3)", "Sharkia", "Sharkia 2"],
    "a canonical area keeps its own folder, under its governorate, under its RECRUITMENT region",
  );

  // Nothing readable at all: their own words still beat the top of the shelf.
  assert.deepEqual(
    driveFolderPathFor({ key: "somewhere nice", kind: "medical_rep", label: "somewhere nice" }, AREA_REGIONS),
    ["Medical Representative", "somewhere nice"],
    "an unreadable area keeps the applicant's own words rather than vanishing up a level",
  );

  assert.equal(regionFolderFromTypedArea("Minia Government"), "Upper Egypt");
  assert.equal(regionFolderFromTypedArea("nowhere at all"), null, "an unreadable area names no region");

  // ── A message typed into the job-title box never becomes a folder ─────────────────────────────
  //
  // One CV was filed under a folder called "بخصوص الإعلان دا" — "regarding this advertisement".
  assert.deepEqual(
    driveFolderPathFor({ key: "بخصوص الإعلان دا", kind: "other", label: "بخصوص الإعلان دا" }, AREA_REGIONS),
    ["Other positions", UNREADABLE_TITLE_FOLDER_NAME],
    "a sentence sent as a job title is not a folder name",
  );

  // The guard is narrow ON PURPOSE. These are the other six titles that shelf actually holds in
  // production; a cleverer sentence-detector would eventually eat one of them.
  for (const title of [
    "Office Coordinator",
    "Technical Support and infrastructure Engineer",
    "Area / Regional Manager",
    "National Sales Manager",
    "Human Resources",
    "Other",
  ] as const) {
    assert.ok(readsAsAJobTitle(title), `${title} is a real title and must keep its own folder`);
    assert.equal(
      driveFolderPathFor({ key: title, kind: "other", label: title }, AREA_REGIONS)[1],
      sanitizeDriveSegment(title),
      `${title} must still file under its own name`,
    );
  }

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
