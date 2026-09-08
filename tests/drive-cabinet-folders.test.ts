import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { chooseCvCopies, copyLabelsFor, shouldMirrorCopy, withCopyLabel } from "../src/lib/recruitment/cv-duplicate-copies.ts";
import {
  CABINET_ROOT_NAME,
  cabinetPathFor,
  cabinetPlaceFolders,
  cabinetPositionFolder,
  OUTSIDE_EGYPT_REGION,
  POSITION_NOT_STATED,
  REGION_NOT_STATED,
} from "../src/lib/recruitment/drive-cabinet-folders.ts";

/**
 * The live area→region grouping, as `au.canonical_areas` reports it (production, 2026-09-07).
 *
 * Only the areas the assertions below actually name. The point of handing it in rather than reading
 * it is that the whole tree stays testable with no database.
 */
const AREA_REGIONS = {
  "Alex Center": "AB",
  "Behira 1": "AB",
  "Cairo East 1": "CA",
  "Gharbia 1 (Tanta)": "D1",
  "Kafr El-Sheikh 1": "D1",
  "Qena 1": "UE",
  // Sales files Sharkia under Delta (2). Recruitment files it under Delta (3). That disagreement is
  // the whole reason `regionFolderForArea` exists, and the test below pins which side wins.
  "Sharkia 1": "D2",
};

/** A candidate row with nothing on it — each test names only the fields it cares about. */
function candidate(overrides = {}) {
  return {
    address: null,
    applied_for_job_title: null,
    current_job_title: null,
    folder_key: null,
    folder_kind: null,
    governorate: null,
    preferred_area_name: null,
    preferred_region_code: null,
    sent_for_job_title: null,
    sent_for_region: null,
    ...overrides,
  };
}

export function runDriveCabinetFolderTests() {
  // ── The cabinet is a SECOND tree, never the first one ──────────────────────────────────────────
  // The owner asked for a new folder and for the old one to be left alone ("don't fix. Create a new
  // folder and reroute"). A session that renamed this constant back would silently start writing
  // into the frozen tree, so the name is pinned rather than merely defaulted.
  assert.equal(CABINET_ROOT_NAME, "Phoenix CV Cabinet");
  assert.notEqual(CABINET_ROOT_NAME, "Phoenix CVs");

  // ── Level one: the position is CLASSIFIED, never used verbatim ────────────────────────────────
  // This is the defect the cabinet exists to fix. Filing the typed string produced 40 top-level
  // folders of which 26 held one CV each. Every title below is real, taken from production on
  // 2026-09-07, and each one used to open a folder of its own.
  const fragmentedRepTitles = [
    "Medical Representative",
    "Medical Representative - Damietta and Port Said",
    "Medical Representative – Ismailia and Suez",
    "Medical Representative – Pedia Line",
    "Medical Representative (Port Said)",
    "Medical Representative (Zagazig or Diarb Negm)",
    "Medical Sales Representative (training opportunity)",
    "Entry-level Veterinary Medical Representative",
  ];
  for (const title of fragmentedRepTitles) {
    assert.equal(
      cabinetPositionFolder(candidate({ applied_for_job_title: title })),
      "Medical Representative",
      `"${title}" must reach the Medical Representative folder, not one of its own`,
    );
  }

  // The same collapse on the manager side, including the spelling that has no "district manager"
  // substring at all and the "area sales manager" the owner ruled is a district-manager seat.
  for (const title of ["District Manager", "Upper Egypt District Sales Manager", "Area - District Sales Manager", "Area Sales Manager"]) {
    assert.equal(cabinetPositionFolder(candidate({ applied_for_job_title: title })), "District Manager", title);
  }

  // Seven HR spellings and four accountant spellings were seven and four folders.
  for (const title of ["Human Resources", "HR Specialist", "HR Supervisor", "HR Generalist role", "Personnel and Recruitment Specialist"]) {
    assert.equal(cabinetPositionFolder(candidate({ applied_for_job_title: title })), "Human Resources", title);
  }
  for (const title of ["Accountant", "Junior Accountant", "Chief Accountant", "Financial Accountant"]) {
    assert.equal(cabinetPositionFolder(candidate({ applied_for_job_title: title })), "Finance & Accounting", title);
  }

  // ── A message typed into the job-title box is not a position ──────────────────────────────────
  // "regarding this advertisement", live in production and already a folder in the old tree.
  assert.equal(cabinetPositionFolder(candidate({ applied_for_job_title: "بخصوص الإعلان دا" })), POSITION_NOT_STATED);

  // ── Nothing at all is NOT "Other positions" ───────────────────────────────────────────────────
  // "We do not know this person's job" and "their job is none of these" are different claims, and
  // only the second deserves a folder of unrelated roles.
  assert.equal(cabinetPositionFolder(candidate()), POSITION_NOT_STATED);
  assert.equal(cabinetPositionFolder(candidate({ applied_for_job_title: "   " })), POSITION_NOT_STATED);

  // ── The title ladder only ever FILLS A GAP ────────────────────────────────────────────────────
  // The safety property of reaching for `current_job_title`: a candidate who named a job they
  // applied for never consults it, so it can never move anyone AWAY from the folder their own
  // answer earned. Break this and someone who applied to be an Office Coordinator gets filed under
  // whatever they happen to do today.
  assert.equal(
    cabinetPositionFolder(candidate({ applied_for_job_title: "Office Coordinator", current_job_title: "Medical Representative" })),
    "Office Coordinator",
  );
  // With no applied-for title, the CV's own title is better than nothing.
  assert.equal(cabinetPositionFolder(candidate({ current_job_title: "Medical Representative" })), "Medical Representative");
  // A recruiter putting someone forward is an ACTION, and outranks both.
  assert.equal(
    cabinetPositionFolder(
      candidate({ applied_for_job_title: "Office Coordinator", current_job_title: "Accountant", sent_for_job_title: "District Manager" }),
    ),
    "District Manager",
  );

  // A folder a human filed by hand outranks every derived answer.
  assert.equal(cabinetPositionFolder(candidate({ folder_kind: "medical_rep", folder_key: "Alex Center", applied_for_job_title: "Accountant" })), "Medical Representative");

  // ── Levels two and three: region, then area ───────────────────────────────────────────────────
  // A stated area names both rungs at once.
  assert.deepEqual(cabinetPlaceFolders(candidate({ preferred_area_name: "Kafr El-Sheikh 1" }), AREA_REGIONS), {
    area: "Kafr El-Sheikh 1",
    region: "Delta (1)",
  });

  // THE DELTA (3) OVERRIDE. Sales files Sharkia 1 under Delta (2); recruitment files it under
  // Delta (3). Reading `code_region_code` directly would put this CV in the wrong region folder —
  // the exact mis-file the recruitment override exists to prevent.
  assert.equal(cabinetPlaceFolders(candidate({ preferred_area_name: "Sharkia 1" }), AREA_REGIONS).region, "Delta (3)");

  // A stated region with no area stops at the region rather than inventing one.
  assert.deepEqual(cabinetPlaceFolders(candidate({ preferred_region_code: "UE" }), AREA_REGIONS), {
    area: null,
    region: "Upper Egypt",
  });

  // A governorate typed by hand resolves to a folder the company OWNS. "Qena north" never becomes a
  // folder beside the real Qena 1 and Qena 2 wearing an official-looking name.
  const typed = cabinetPlaceFolders(candidate({ preferred_area_name: "Qena north" }), AREA_REGIONS);
  assert.equal(typed.region, "Upper Egypt");
  assert.equal(typed.area, "Qena");

  // Nothing anywhere is a fact, and gets a named folder rather than the root.
  assert.deepEqual(cabinetPlaceFolders(candidate(), AREA_REGIONS), { area: null, region: REGION_NOT_STATED });

  // Outside Egypt keeps the region level a list of the company's own eight, with the country as the
  // area beneath it.
  const abroad = cabinetPlaceFolders(candidate({ governorate: "Dubai" }), AREA_REGIONS);
  if (abroad.region !== REGION_NOT_STATED) {
    assert.equal(abroad.region, OUTSIDE_EGYPT_REGION);
    assert.ok(abroad.area, "a foreign placement names the country as its area");
  }

  // ── The tree is never more than three deep ────────────────────────────────────────────────────
  // The owner asked for one folder per region, per area and per position — three rungs. The old
  // tree's governorate level is deliberately absent, and a fourth would put an area out of reach
  // behind a rung he did not ask for.
  const deepest = cabinetPathFor(
    candidate({ applied_for_job_title: "Medical Representative", preferred_area_name: "Gharbia 1 (Tanta)" }),
    AREA_REGIONS,
  );
  assert.deepEqual(deepest, ["Medical Representative", "Delta (1)", "Gharbia 1 (Tanta)"]);
  for (const row of [
    candidate(),
    candidate({ applied_for_job_title: "Accountant" }),
    candidate({ preferred_area_name: "Qena 1", applied_for_job_title: "Medical Representative" }),
    candidate({ governorate: "Cairo", current_job_title: "HR Specialist" }),
  ]) {
    const path = cabinetPathFor(row, AREA_REGIONS);
    assert.ok(path.length >= 2 && path.length <= 3, `cabinet paths are 2 or 3 deep, got ${path.length}: ${path.join("/")}`);
    assert.ok(
      path.every((segment) => segment && !segment.includes("/")),
      `no segment may be empty or carry a separator: ${path.join(" | ")}`,
    );
  }

  // A typed title carrying a slash is one folder, not three. Live in production:
  // "HR Generalist / HR Operations / Personnel & Payroll".
  const slashed = cabinetPathFor(candidate({ applied_for_job_title: "HR Generalist / HR Operations / Personnel & Payroll" }), AREA_REGIONS);
  assert.equal(slashed[0].includes("/"), false);

  // ── The dedupe ────────────────────────────────────────────────────────────────────────────────
  // 264 of the 1,156 mirrored files were byte-identical re-sends by one person, and one candidate
  // had thirteen copies of the same file in one folder.
  const rows = [
    { content_md5: "aaa", created_at: "2026-09-02T10:00:00Z", id: "second" },
    { content_md5: "aaa", created_at: "2026-09-01T10:00:00Z", id: "first" },
    { content_md5: "aaa", created_at: "2026-09-03T10:00:00Z", id: "third" },
    { content_md5: "bbb", created_at: "2026-09-04T10:00:00Z", id: "different" },
  ];
  const chosen = chooseCvCopies(rows);
  assert.deepEqual(
    chosen.keep.map((row) => row.id).sort(),
    ["different", "first"],
    "one copy per distinct file, and the ORIGINAL wins",
  );
  assert.equal(chosen.suppress.length, 2);

  // The oldest wins because `findCandidateIdByContentFingerprint` already resolves a fingerprint
  // clash oldest-first. Disagreeing would let the row that owns the candidate and the row that owns
  // the Drive copy be two different rows.
  assert.equal(chosen.keep.find((row) => row.content_md5 === "aaa")?.id, "first");

  // A row with NO fingerprint is always kept: absence means "never computed", not "unique", and
  // suppressing on a value we do not have would silently drop a CV nobody sees again.
  const unfingerprinted = chooseCvCopies([
    { content_md5: null, created_at: "2026-09-01T10:00:00Z", id: "a" },
    { content_md5: null, created_at: "2026-09-02T10:00:00Z", id: "b" },
  ]);
  assert.equal(unfingerprinted.keep.length, 2);
  assert.equal(unfingerprinted.suppress.length, 0);

  // Ties are broken on id, so a re-run of the fill script cannot pick a different winner and upload
  // a second copy of the file it is meant to be de-duplicating.
  const sameInstant = [
    { content_md5: "ccc", created_at: "2026-09-01T10:00:00Z", id: "zzz" },
    { content_md5: "ccc", created_at: "2026-09-01T10:00:00Z", id: "aaa" },
  ];
  assert.equal(chooseCvCopies(sameInstant).keep[0].id, "aaa");
  assert.equal(chooseCvCopies([...sameInstant].reverse()).keep[0].id, "aaa");

  // The live mirror's yes/no shape agrees with the chooser it wraps.
  assert.equal(shouldMirrorCopy("first", rows), true);
  assert.equal(shouldMirrorCopy("second", rows), false);
  assert.equal(shouldMirrorCopy("different", rows), true);

  // ── Telling one candidate's two DIFFERENT CVs apart ───────────────────────────────────────────
  // Owner, 2026-09-07: "add the date to the duplicate names". These are not duplicates in the
  // dedupe sense — every byte-identical re-send is already gone — they are genuinely different CVs
  // from one person, and both belong in the cabinet wearing distinguishable names.

  // A candidate with ONE CV keeps the plain name. 860 of 875 candidates, and a date on every file
  // would be 892 longer names buying nothing.
  const solo = copyLabelsFor([{ content_md5: "a", created_at: "2026-08-15T09:00:00Z", id: "only" }]);
  assert.equal(solo.get("only"), "");
  assert.equal(withCopyLabel("Samy Kassab - 966577581850.pdf", ""), "Samy Kassab - 966577581850.pdf");

  // Two CVs on DIFFERENT days: the date alone separates them, so no counter. This is Samy Kassab,
  // live in production — 2026-08-15 and 2026-09-06.
  const twoDays = copyLabelsFor([
    { content_md5: "a", created_at: "2026-08-15T09:00:00Z", id: "aug" },
    { content_md5: "b", created_at: "2026-09-06T15:14:00Z", id: "sep" },
  ]);
  assert.equal(twoDays.get("aug"), "2026-08-15");
  assert.equal(twoDays.get("sep"), "2026-09-06");

  // THE CASE THE DATE ALONE CANNOT SOLVE, and the reason this is a function rather than a
  // concatenation. Measured on production: only 5 of the 15 multi-CV candidates sent on different
  // days. Acheampong Augustine sent THREE on 2026-08-14, and maisaa's two are twenty-one seconds
  // apart — a date, a date and hour, even a date and minute all still collide.
  const sameDay = copyLabelsFor([
    { content_md5: "a", created_at: "2026-08-14T06:15:04Z", id: "first" },
    { content_md5: "b", created_at: "2026-08-14T06:15:15Z", id: "second" },
    { content_md5: "c", created_at: "2026-08-14T06:15:26Z", id: "third" },
  ]);
  assert.equal(sameDay.get("first"), "2026-08-14 #1");
  assert.equal(sameDay.get("second"), "2026-08-14 #2");
  assert.equal(sameDay.get("third"), "2026-08-14 #3");
  assert.equal(new Set([...sameDay.values()]).size, 3, "same-day CVs must still get distinct labels");

  // Mixed: the lone day stays clean, only the crowded one is numbered.
  const mixed = copyLabelsFor([
    { content_md5: "a", created_at: "2026-08-14T06:00:00Z", id: "x1" },
    { content_md5: "b", created_at: "2026-08-14T07:00:00Z", id: "x2" },
    { content_md5: "c", created_at: "2026-09-01T07:00:00Z", id: "y" },
  ]);
  assert.equal(mixed.get("x1"), "2026-08-14 #1");
  assert.equal(mixed.get("x2"), "2026-08-14 #2");
  assert.equal(mixed.get("y"), "2026-09-01");

  // A suppressed identical re-send never gets a label, because it never reaches Drive at all.
  const withResend = copyLabelsFor([
    { content_md5: "a", created_at: "2026-08-15T09:00:00Z", id: "kept" },
    { content_md5: "a", created_at: "2026-08-16T09:00:00Z", id: "resent" },
    { content_md5: "b", created_at: "2026-09-06T09:00:00Z", id: "different" },
  ]);
  assert.equal(withResend.has("resent"), false);
  assert.equal(withResend.get("kept"), "2026-08-15");
  assert.equal(withResend.get("different"), "2026-09-06");

  // The label goes BEFORE the extension — a name ending ".pdf (2026-08-15)" stops looking like a PDF
  // to the phone this folder is read on.
  assert.equal(
    withCopyLabel("Amr Mohamed Rozza - 01004316664.docx", "2026-08-14"),
    "Amr Mohamed Rozza - 01004316664 (2026-08-14).docx",
  );
  assert.equal(withCopyLabel("Acheampong Augustine.jpg", "2026-08-14 #2"), "Acheampong Augustine (2026-08-14 #2).jpg");
  // A name with no extension still gets its label rather than being mangled.
  assert.equal(withCopyLabel("Unnamed CV", "2026-08-14"), "Unnamed CV (2026-08-14)");

  // Cairo, not UTC. 22:30 UTC on the 14th is already the 15th in Cairo, and the owner reads these
  // folders on his own working day.
  const cairoEdge = copyLabelsFor([
    { content_md5: "a", created_at: "2026-08-14T22:30:00Z", id: "late" },
    { content_md5: "b", created_at: "2026-09-01T09:00:00Z", id: "other" },
  ]);
  assert.equal(cairoEdge.get("late"), "2026-08-15", "the day key must be Africa/Cairo, not UTC");

  // ── The cutover guard, pinned in the mirror's own source ──────────────────────────────────────
  //
  // THIS IS THE ONE THAT PROTECTS THE FROZEN TREE. Every `ats_files` row written before 2026-09-07
  // records a path in the old "Phoenix CVs" tree, and two of those shapes — "Medical
  // Representative/<Region>" and "District Manager/<Region>" — are byte-identical to a legitimate
  // cabinet path. So the mirror cannot tell the trees apart from an unrooted path, and a mismatch
  // it reads as "the folder changed" would MOVE the file: the frozen tree emptied one candidate at
  // a time, silently, with no error raised anywhere and nothing in the app that would show it.
  //
  // Pinned as source rather than behaviour because `mirrorCvToDrive` needs a live Supabase client
  // and a live Drive token to run at all. Matched on named expressions rather than a byte window,
  // deliberately: a fixed slice false-fails the moment anything above it shifts by a line.
  const mirrorSource = fs.readFileSync(
    path.join(process.cwd(), "src/lib/recruitment/drive-cv-mirror.ts"),
    "utf8",
  );

  assert.match(
    mirrorSource,
    /const pathKey = \[CABINET_ROOT_NAME, \.\.\.path\]\.join\("\/"\)/,
    "the stored mirror path must be ROOTED at the cabinet, or a legacy row is indistinguishable from a cabinet one",
  );
  assert.match(
    mirrorSource,
    /const recordedInCabinet = String\(row\.drive_mirror_path \?\? ""\)\.startsWith\(`\$\{CABINET_ROOT_NAME\}\/`\)/,
    "the mirror must decide move-vs-upload on whether the RECORDED path is a cabinet path",
  );
  assert.match(
    mirrorSource,
    /if \(row\.drive_mirror_file_id && recordedInCabinet\) \{/,
    "the MOVE branch must be gated on recordedInCabinet — ungated, it drags files out of the frozen tree",
  );

  // The dedupe guard has to run BEFORE anything is uploaded, or the copy it is meant to prevent is
  // already in Drive by the time the decision is made.
  const guardAt = mirrorSource.indexOf("shouldMirrorCopy(fileId, siblings)");
  const uploadAt = mirrorSource.indexOf("uploadCvToDrivePath({");
  assert.ok(guardAt > 0, "the mirror must consult shouldMirrorCopy");
  assert.ok(uploadAt > 0, "the mirror must still upload");
  assert.ok(guardAt < uploadAt, "the dedupe guard must run before the upload, not after it");

  // The cabinet is what the tree roots at. If this reverts to the old tree's variable, every new CV
  // goes straight back into the folder the owner asked us to stop writing to.
  const treeSource = fs.readFileSync(path.join(process.cwd(), "src/lib/recruitment/drive-tree.ts"), "utf8");
  const rootStart = treeSource.indexOf("export async function ensureRootFolder(");
  assert.ok(rootStart > 0, "drive-tree must still export ensureRootFolder");
  const rootBody = treeSource.slice(rootStart, rootStart + 600);
  assert.match(rootBody, /CABINET_ROOT_NAME/, "the mirror's root must be the cabinet");
  assert.doesNotMatch(
    rootBody,
    /rootFolderId\(\)/,
    "ensureRootFolder must NOT read GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID — that pins the frozen tree",
  );
}

/**
 * Drive's bin is not a 404, and the mirror must not put back what the owner threw away.
 *
 * FOUND ON THE CABINET'S FIRST NIGHT, 2026-09-07. The owner opened it, saw `MRs JO.pdf` — a job
 * posting that had arrived by email and been treated as somebody's CV — and binned it. The database
 * went on recording it as filed under Medical Representative / Cairo, because a trashed file
 * answers `files/{id}` with a 200: parents intact, name intact, `trashed: true` in a field nobody
 * had asked for. The check that catches deletion everywhere else, the 404, never fires.
 *
 * The reconciliation caught it only because a separate audit counted the cabinet's live files (892)
 * against the rows claiming to be in it (893). Nothing in the app would ever have noticed.
 *
 * TRASHED AND MISSING WANT OPPOSITE RESPONSES, which is why this is a three-way result and not a
 * boolean. Missing should be re-filed. Trashed must never be: putting it back would overrule the
 * owner with a cron job, and he would have to delete it again after every classification event with
 * no way to make it stop.
 */
export function runDriveTrashedFileTests() {
  const treeSource = fs.readFileSync(path.join(process.cwd(), "src/lib/recruitment/drive-tree.ts"), "utf8");
  const mirrorSource = fs.readFileSync(path.join(process.cwd(), "src/lib/recruitment/drive-cv-mirror.ts"), "utf8");

  // `trashed` must be ASKED FOR — it is not in Drive's default field set, and that omission is the
  // entire bug. Without it the response looks identical to a healthy file.
  assert.match(
    treeSource,
    /files\/\$\{id\}\?fields=parents,name,trashed/,
    "the lookup must request `trashed` — Drive omits it by default, which is exactly how this was missed",
  );
  assert.match(treeSource, /if \(current\.trashed\) return "trashed";/, "a trashed file must answer 'trashed'");

  // Asked BEFORE the folder walk: `ensureFolderPath` CREATES folders, so checking afterwards would
  // rebuild the shelf the owner had just emptied on the way to deciding not to file into it.
  const trashedAt = treeSource.indexOf('if (current.trashed) return "trashed";');
  const ensureAt = treeSource.indexOf("const targetId = await ensureFolderPath(input.path);");
  assert.ok(trashedAt > 0 && ensureAt > 0, "both landmarks must exist");
  assert.ok(trashedAt < ensureAt, "the trashed check must run BEFORE any folder is created");

  // Three distinct answers, no booleans left. A boolean here is what collapsed the two cases.
  assert.match(treeSource, /Promise<DriveMoveResult>/, "moveDriveFile must return the three-way result");
  const moveStart = treeSource.indexOf("export async function moveDriveFile(");
  const moveBody = treeSource.slice(moveStart);
  assert.doesNotMatch(
    moveBody.slice(0, moveBody.indexOf("\n}\n")),
    /return (true|false);/,
    "no boolean return may survive in moveDriveFile — that is what merged 'binned' with 'gone'",
  );

  // THE PROPERTY THAT MATTERS: a trashed file's id is KEPT. Clearing it is what routes a row to the
  // upload branch, and the upload branch is the resurrection. Keeping it means every later pass
  // lands on the trashed check again and does nothing — idempotent by construction.
  const trashedBranch = mirrorSource.slice(
    mirrorSource.indexOf('if (moved === "trashed")'),
    mirrorSource.indexOf('if (moved === "ok" && folderUnchanged)'),
  );
  assert.ok(trashedBranch.length > 0, "the mirror must handle the trashed answer on its own");
  assert.doesNotMatch(
    trashedBranch,
    /drive_mirror_file_id: null/,
    "a binned file must KEEP its id — clearing it is what makes the next pass re-upload the file the owner deleted",
  );
  assert.match(trashedBranch, /return "removed"/, "a deliberate deletion is its own outcome, not a failure");

  // And the MISSING branch must still clear, because gone is not binned.
  const missingBranch = mirrorSource.slice(
    mirrorSource.indexOf('if (moved === "missing")'),
    mirrorSource.indexOf('return "failed";') + 20,
  );
  assert.match(
    missingBranch,
    /drive_mirror_file_id: null/,
    "a genuinely missing file must still clear its id so it can be re-filed",
  );
}

/**
 * The backfill script and the app must answer the SAME question about where a CV belongs.
 *
 * They did not, for a day. The cabinet shipped in #3454 and `drive-cv-mirror.ts` began recording
 * `drive_mirror_path` as `Phoenix CV Cabinet/...`, while `scripts/backfill-cvs-to-drive.mjs` went on
 * computing the old `drive-cv-folders` tree. `--verify` compared the two and called 913 of 1,171
 * mirrored CVs misfiled — then printed "run with --refile", which acts on that same comparison and
 * would have moved every one of them back OUT of the cabinet, rewriting its recorded path as it went.
 *
 * Neither half was wrong on its own, which is exactly why nothing caught it: the app filed
 * correctly, the script computed the old rule correctly, and only asking both the same question
 * exposes the disagreement. So this pins the one thing that keeps them together — the script
 * imports the app's function instead of keeping a copy.
 */
export function runDriveScriptAgreesWithAppTests() {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts", "backfill-cvs-to-drive.mjs"), "utf8");

  assert.match(
    source,
    /import \{[^}]*cabinetPathFor[^}]*\} from "@\/lib\/recruitment\/drive-cabinet-folders"/,
    "the backfill script must take its folder rule from the cabinet module the app itself runs",
  );
  assert.ok(
    source.includes(CABINET_ROOT_NAME) || source.includes("CABINET_ROOT_NAME"),
    "the expected path must be rooted — drive_mirror_path is recorded rooted, so an unrooted "
      + "comparison disagrees with every file in the library",
  );

  // The old tree's two path builders. Either one back in this file means a second copy of the rule,
  // which is the whole defect: a copy cannot be kept in step, it can only be found later.
  for (const dead of ["driveFolderPathFor", "driveInferredFolderPath"]) {
    assert.ok(
      !source.includes(dead),
      `${dead} builds the OLD tree's path — the backfill script must not compute a folder of its own`,
    );
  }

  // The cabinet's title ladder reads two columns the old tree never asked for. A SELECT missing
  // either one silently drops the candidate to a lower rung, so a correctly filed CV reads as
  // misfiled — the same false alarm by a quieter route.
  for (const column of ["current_job_title", "sent_for_job_title"]) {
    assert.ok(
      source.includes(column),
      `the candidate SELECT must fetch ${column}, or cabinetPathFor files on a lower rung than the app did`,
    );
  }
}
