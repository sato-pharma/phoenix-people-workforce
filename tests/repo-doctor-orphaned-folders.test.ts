import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyOrphanedFolder,
  orphanedFolderLines,
  LIVE_WRITE_WINDOW_MIN,
  REGENERABLE_DIRS,
  RESCUE_EXTENSIONS,
} from "../scripts/repo-doctor-orphaned-folders.mjs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A worktree-shaped folder git no longer accounts for, holding files, must be REPORTED — by name,
 * with the evidence — and must never be reachable from a deletion path.
 *
 * WHY THIS EXISTS. On 2026-09-04 `_wt-cv-lifecycle-sheet` was retired with `new-session.mjs
 * --remove`, which reported "worktree removed: yes, no husk left". A live session then wrote
 * docs/cv-lifecycle-live-sheet.gs into the folder that survived it — 46,603 bytes against main's
 * 16,135, 861 lines added, 141 removed. repo-doctor's next run printed `HUSKS: 0` and `LIVE
 * worktrees: 1`, and the file was found only by listing the directory by hand. It is preserved at
 * refs/backups/wip/cv-lifecycle-sheet (commit 1c4ba0b1f).
 *
 * The two buckets split on `isRegistered || hasGitEntry`, so a DEREGISTERED folder is filed by
 * whatever its leftover `.git` stub decides: stub present and it counts as a LIVE WORKTREE — the
 * heading whose whole meaning is "these are fine" — stub gone and it reached a NEEDS REVIEW line
 * carrying a file COUNT and nothing else. Both are the same mistake in two sizes, because 4,152
 * files is what a healthy abandoned worktree looks like AND what one holding the only copy of an
 * afternoon's work looks like.
 *
 * So the two properties pinned here are:
 *
 *   1. THE CLASSIFIER KEYS ON REGISTRATION, NOT ON THE `.git` FILE, and answers by CONTENT — every
 *      file held against main's blob. Not knowing is always an alarm, never an "ok": an unhashable
 *      file, an unreadable main tree, a truncated scan and an unreadable folder must each refuse to
 *      print as safe. That is AGENTS.md rule 1 — being confidently wrong is what costs a day.
 *
 *   2. `--fix` CANNOT REACH THIS CATEGORY. It deletes proven ZERO-file husks and nothing else, and
 *      this category holds files by definition. Checked at the source level, because the failure
 *      would be a one-line change in repo-doctor.mjs that no synthetic input can see.
 *
 * The classifier takes every fact pre-read, like repo-doctor-supabase-link.mjs, so all of part 1
 * runs with no filesystem, no git and no clock.
 */

const DOCTOR = "scripts/repo-doctor.mjs";
const NOW = Date.UTC(2026, 8, 4, 21, 0, 0); // 2026-09-05 00:00 Cairo
const MIN = 60_000;

type FileFact = {
  path: string;
  hash: string | null;
  mainHash: string | null;
  size: number | null;
  mainSize: number | null;
  ignored: boolean;
};

/** A file whose content is identical to main's. The uninteresting case, and the common one. */
function same(path: string): FileFact {
  return { path, hash: "a".repeat(40), mainHash: "a".repeat(40), size: 10, mainSize: 10, ignored: false };
}

function folder(overrides: Record<string, unknown> = {}) {
  return classifyOrphanedFolder({
    label: "_wt-probe",
    dir: "F:\\Phoenix Workforce\\_wt-probe",
    isRegistered: false,
    hasGitEntry: false,
    totalFiles: 1,
    unreadable: false,
    newestMtimeMs: NOW - 5 * MIN,
    nowMs: NOW,
    mainTreeAvailable: true,
    scannedAll: true,
    listLimit: 10,
    files: [same("package.json")],
    ...overrides,
  });
}

const text = (v: { lines: string[] }) => v.lines.join("\n");

// ── 1. THE TWO BUCKETS THAT ALREADY WORK MUST KEEP THEIR FOLDERS ───────────────────

function testRegisteredAndProvenEmptyAreNotOrphans() {
  const registered = folder({ isRegistered: true, totalFiles: 4152 });
  assert.equal(registered.orphaned, false, "a registered worktree is the retirement gates' business");
  assert.equal(registered.state, "registered");
  assert.deepEqual(registered.lines, [], "a registered worktree must add nothing to this section");

  // Registration wins even with a .git stub AND files, so the section can never duplicate a
  // healthy worktree into an alarm.
  const both = folder({ isRegistered: true, hasGitEntry: true, files: [], totalFiles: 900 });
  assert.equal(both.orphaned, false);

  const husk = folder({ totalFiles: 0, files: [], hasGitEntry: false, unreadable: false });
  assert.equal(husk.orphaned, false, "a proven-empty unregistered folder is a husk — --fix's job");
  assert.equal(husk.state, "husk");
  assert.deepEqual(husk.lines, []);
}

function testEmptinessMustBePROVEN() {
  // A walk that could not finish is not a walk that found nothing. If `unreadable` could pass for
  // a husk here, this category would hand the one folder it exists to catch straight back to the
  // bucket labelled "safe to delete".
  const unreadable = folder({ totalFiles: 0, files: [], unreadable: true });
  assert.equal(unreadable.orphaned, true, "an unreadable folder is never a proven-empty husk");
  assert.equal(unreadable.severity, "alarm");

  // A .git stub over an empty folder is also not a husk: --fix requires no .git entry.
  const stub = folder({ totalFiles: 0, files: [], hasGitEntry: true });
  assert.equal(stub.orphaned, true);
}

// ── 2. THE INCIDENT SHAPE ──────────────────────────────────────────────────────────

function testTheIncidentShapeIsCaughtAndNamed() {
  // Exactly what was on disk on 2026-09-04: deregistered, .git stub left behind by a failed
  // removal, a full checkout's worth of files, and ONE of them 861 lines ahead of main.
  const v = folder({
    label: "_wt-cv-lifecycle-sheet",
    hasGitEntry: true,
    totalFiles: 4152,
    newestMtimeMs: NOW - 5 * MIN,
    files: [
      same("package.json"),
      {
        path: "docs/cv-lifecycle-live-sheet.gs",
        hash: "b".repeat(40),
        mainHash: "c".repeat(40),
        size: 46603,
        mainSize: 16135,
        ignored: false,
      },
    ],
  });

  assert.equal(v.orphaned, true, "the .git stub must NOT buy this folder a place under LIVE");
  assert.equal(v.severity, "alarm");
  assert.equal(v.differing.length, 1);
  assert.equal(v.matching, 1);

  const out = text(v);
  assert.match(out, /docs\/cv-lifecycle-live-sheet\.gs/, "the file at risk must be named, not counted");
  assert.match(out, /46,603 bytes here vs 16,135 on main/, "both sizes carry the size of the loss");
  assert.match(out, /DIFFER/, "the differing group must be loud");
  assert.match(out, /!!/, "an at-risk folder is marked, not left to be inferred from a count");

  // The stub is the reason it hid, so the report has to say the folder is ALSO listed above —
  // otherwise the same line count reads as two different folders.
  assert.match(out, /ALSO appears under LIVE/);

  // And the recovery advice must not be the thing that loses the work a second time.
  assert.match(out, /Do NOT run git inside this folder/);
  assert.match(out, /PRIMARY checkout/, "AGENTS.md 2.1: git in a deregistered folder commits to main");
}

function testAFolderWithNoGitEntryIsCaughtToo() {
  const v = folder({
    files: [{ path: "docs/x.md", hash: "b".repeat(40), mainHash: "c".repeat(40), size: 9, mainSize: 4, ignored: false }],
  });
  assert.equal(v.orphaned, true);
  assert.match(text(v), /no \.git entry/);
}

// ── 3. WHICH FILES ARE LOUD, AND WHICH ARE NOISE ───────────────────────────────────

function testUntrackedIsLoudAndGitignoredIsQuiet() {
  const v = folder({
    totalFiles: 3,
    files: [
      same("package.json"),
      { path: "docs/notes.md", hash: "b".repeat(40), mainHash: null, size: 12, mainSize: null, ignored: false },
      { path: ".env.local", hash: "d".repeat(40), mainHash: null, size: 40, mainSize: null, ignored: true },
    ],
  });

  assert.deepEqual(v.untracked, ["docs/notes.md"], "a file on no branch is work until proven otherwise");
  assert.equal(v.ignored, 1);
  assert.equal(v.severity, "alarm");

  const out = text(v);
  assert.match(out, /docs\/notes\.md/);
  // The env copies the SessionStart hook writes into EVERY worktree must not be named as unsaved
  // work — six loud false positives per folder is how a report stops being read.
  assert.ok(!out.includes(".env.local"), "a gitignored copy is counted, never named as work at risk");
  assert.match(out, /1 gitignored file\(s\)/);
}

function testASpreadsheetIsLoudEvenWhenGitignored() {
  // AGENTS.md 5: "Never delete a .xlsx or .pdf file, even a stray untracked one in a worktree
  // being cleaned up." The rule is about the file existing; git's opinion of it is irrelevant, and
  // a spreadsheet the owner dropped into a worktree is gitignored as often as not.
  const v = folder({
    totalFiles: 2,
    files: [
      same("package.json"),
      { path: "xlsx/roster.xlsx", hash: "e".repeat(40), mainHash: null, size: 900, mainSize: null, ignored: true },
    ],
  });
  assert.deepEqual(v.rescue, ["xlsx/roster.xlsx"]);
  assert.equal(v.ignored, 0, "a rescue-extension file is never filed away as a quiet gitignored copy");
  assert.equal(v.severity, "alarm");
  assert.match(text(v), /AGENTS\.md 5 forbids deleting these/);

  for (const ext of RESCUE_EXTENSIONS) {
    const one = folder({
      totalFiles: 1,
      files: [{ path: `f${ext}`, hash: "e".repeat(40), mainHash: null, size: 1, mainSize: null, ignored: true }],
    });
    assert.equal(one.rescue.length, 1, `${ext} must be rescued`);
  }

  // A spreadsheet that IS byte-identical to main is a checkout artefact, not a rescue.
  const identical = folder({
    totalFiles: 1,
    files: [{ path: "xlsx/tracked.xlsx", hash: "a".repeat(40), mainHash: "a".repeat(40), size: 1, mainSize: 1, ignored: false }],
  });
  assert.deepEqual(identical.rescue, []);
  assert.equal(identical.severity, "note");
}

// ── 4. NOT KNOWING IS NEVER "OK" ───────────────────────────────────────────────────

function testEveryUnknownRefusesToPrintAsSafe() {
  const unhashable = folder({
    totalFiles: 2,
    files: [same("package.json"), { path: "docs/y.md", hash: null, mainHash: "c".repeat(40), size: null, mainSize: 4, ignored: false }],
  });
  assert.deepEqual(unhashable.unknown, ["docs/y.md"]);
  assert.equal(unhashable.matching, 1, "an unhashable file must never be counted as a match");
  assert.equal(unhashable.severity, "alarm");
  assert.match(text(unhashable), /could NOT be hashed/);

  const noMain = folder({ mainTreeAvailable: false });
  assert.equal(noMain.severity, "alarm", "with no main tree NOTHING is proven to be a copy");
  assert.match(text(noMain), /main's tree could not be read/);
  assert.ok(
    !text(noMain).includes("nothing here is at risk"),
    "a comparison that never ran must not be reported in the words of one that passed",
  );

  const capped = folder({ scannedAll: false });
  assert.equal(capped.severity, "alarm");
  assert.match(text(capped), /hit this run's cap/);
}

function testBuildOutputOnlyNeverClaimsAComparison() {
  // The whole folder is node_modules/.next, so nothing was compared. The line that used to print
  // here was "every file here is byte-identical to main", i.e. a verdict on a check that never ran
  // — the same reading that let 861 unsaved lines pass for healthy.
  const v = folder({ totalFiles: 45651, files: [], newestMtimeMs: null });
  assert.equal(v.orphaned, true);
  assert.equal(v.severity, "note", "regenerable build output is not an alarm");
  const out = text(v);
  assert.match(out, /nothing here was comparable/);
  assert.ok(!/byte for byte/.test(out), "no byte comparison happened, so none may be claimed");
  // And the missing mtime must read as "there was nothing to time", not as a read failure that
  // sends the reader hunting a permissions problem.
  assert.match(out, /no write time worth reporting/);
  assert.ok(!out.includes("no file mtime could be read"));
}

// ── 5. THE RECENT-WRITE SIGNAL ─────────────────────────────────────────────────────

function testARecentWriteSaysSomethingMayStillBeWriting() {
  const fresh = folder({ newestMtimeMs: NOW - (LIVE_WRITE_WINDOW_MIN - 1) * MIN });
  assert.match(text(fresh), /may STILL be writing here/);

  // AGENTS.md 4: every time is reported in Africa/Cairo, never raw UTC. Asserted on a write AT
  // `NOW` — 2026-09-04 21:00 UTC — because Cairo is UTC+3 that week, so the correct stamp rolls
  // the DATE over to the 5th. A UTC stamp would read "2026-09-04 21:00", which differs in both
  // fields; anything less than the whole stamp lets a half-applied offset pass.
  const atNow = folder({ newestMtimeMs: NOW });
  assert.match(text(atNow), /\(2026-09-05 00:00 Cairo\)/, "the stamp must be Cairo local, never raw UTC");

  const stale = folder({ newestMtimeMs: NOW - (LIVE_WRITE_WINDOW_MIN + 1) * MIN });
  assert.ok(!text(stale).includes("may STILL be writing here"));
  assert.match(text(stale), /newest write \d+ min ago/);

  const old = folder({ newestMtimeMs: NOW - 5 * 24 * 60 * MIN });
  assert.match(text(old), /newest write 5 days ago/);

  const unknown = folder({ newestMtimeMs: null, files: [same("a.txt")] });
  assert.match(text(unknown), /newest write UNKNOWN/);
}

function testLongListsAreTruncatedButNeverSilently() {
  const many = Array.from({ length: 25 }, (_, i) => ({
    path: `docs/f${i}.md`,
    hash: "b".repeat(40),
    mainHash: null,
    size: 1,
    mainSize: null,
    ignored: false,
  }));
  const v = folder({ totalFiles: 25, files: many });
  assert.equal(v.untracked.length, 25, "the verdict carries every path even when the print is capped");
  assert.match(text(v), /and 15 more untracked file\(s\) \(run with --deep to list them\)/);

  const deep = folder({ totalFiles: 25, files: many, listLimit: Number.POSITIVE_INFINITY });
  assert.ok(!text(deep).includes("more untracked"), "--deep lists them all");
  assert.match(text(deep), /docs\/f24\.md/);
}

// ── 6. THE SECTION AROUND THE VERDICTS ─────────────────────────────────────────────

function testSectionLines() {
  assert.deepEqual(
    orphanedFolderLines([folder({ isRegistered: true }), folder({ totalFiles: 0, files: [] })]),
    [],
    "with nothing orphaned the section must not print a heading at all",
  );

  const alarm = folder({
    files: [{ path: "a.md", hash: "b".repeat(40), mainHash: null, size: 1, mainSize: null, ignored: false }],
  });
  const quiet = folder();
  const out = orphanedFolderLines([alarm, quiet, folder({ isRegistered: true })]).join("\n");

  assert.match(out, /ORPHANED FOLDERS \(no worktree registration, but NOT empty — never auto-deleted\): 2/);
  assert.match(out, /1 of these may hold the only copy of real work/);

  const allQuiet = orphanedFolderLines([quiet]).join("\n");
  assert.match(allQuiet, /: 1/);
  assert.ok(!allQuiet.includes("only copy of real work. Inspect them"));
  assert.match(allQuiet, /Inspect these by hand/);
}

// ── 7. --fix CANNOT REACH ANY OF THIS ──────────────────────────────────────────────

function testFixDeletesHusksAndNothingElse() {
  const code = stripComments(readFileSync(DOCTOR, "utf8"));

  const fixAt = code.indexOf("if (fix) {");
  assert.notEqual(fixAt, -1, "the --fix block moved; re-anchor this test");
  const stripAt = code.indexOf("if (stripIdle) {", fixAt);
  assert.notEqual(stripAt, -1, "the --strip-idle block moved; re-anchor this test");
  const fixBlock = code.slice(fixAt, stripAt);

  assert.ok(
    fixBlock.includes("for (const r of husks)"),
    "--fix must iterate the husk list — the ONE list whose members are proven to hold zero files",
  );
  for (const forbidden of [
    "orphanVerdicts",
    "orphanCandidates",
    "orphanedFolderLines",
    "classifyOrphanedFolder",
    "allRows",
  ]) {
    assert.ok(
      !fixBlock.includes(forbidden),
      `--fix must never see ${forbidden}: this category holds FILES, and a folder holding files ` +
        "has historically held the only copy of real work",
    );
  }

  // The reporting pass itself must hold no deletion primitive at all, so the question cannot be
  // reopened by a later edit that "just tidies up while it is in there".
  const sectionAt = code.indexOf("const orphanCandidates");
  const sectionEnd = code.indexOf("const orphanLines");
  assert.notEqual(sectionAt, -1, "the orphan section moved; re-anchor this test");
  assert.ok(sectionEnd > sectionAt, "the orphan section's end anchor moved; re-anchor this test");
  const section = code.slice(sectionAt, sectionEnd);
  for (const primitive of ["rmSync", "unlinkSync", "rmdirSync", "renameSync", "writeFileSync"]) {
    assert.ok(!section.includes(primitive), `the orphan pass is report-only; it must not call ${primitive}`);
  }

  // The husk definition must stay the removal gate: unregistered, no .git, and ZERO files.
  assert.ok(
    code.includes("else if (files === 0 && !unreadable) husks.push(row);"),
    "the husk bucket must keep requiring a proven-zero file count",
  );
}

function testTheSectionIsActuallyWiredIn() {
  const raw = readFileSync(DOCTOR, "utf8");
  assert.match(raw, /repo-doctor-orphaned-folders\.mjs/, "the classifier must be imported");

  const code = stripComments(raw);
  assert.ok(code.includes("orphanedFolderLines(orphanVerdicts)"), "the section must be printed");
  assert.ok(
    code.includes("allRows.filter((r) => !r.isRegistered)"),
    "the candidate set must key on REGISTRATION — keying on the .git file is what hid the incident",
  );
  assert.ok(
    !code.includes("NEEDS REVIEW"),
    "the old file-count-only section must be gone, not left beside its replacement as a second heading",
  );

  // `.git` in a worktree is a FILE holding a `gitdir:` pointer, so the skip has to run before the
  // entry's type is looked at. When it did not, the stub was reported as "on NO branch at all" —
  // the loudest line in the section, spent on the one file that is certainly nobody's work.
  assert.ok(
    code.includes("if (REGENERABLE_DIRS.has(e.name)) continue;"),
    "regenerable entries must be skipped by NAME, before isDirectory() is consulted",
  );
  assert.ok(REGENERABLE_DIRS.has(".git"), ".git must be excluded from the comparison");
  assert.ok(REGENERABLE_DIRS.has("node_modules"), "node_modules is a junction here (AGENTS.md 5)");
  assert.ok(REGENERABLE_DIRS.has(".next"), ".next is build output");
}

export function runRepoDoctorOrphanedFoldersTests() {
  testRegisteredAndProvenEmptyAreNotOrphans();
  testEmptinessMustBePROVEN();
  testTheIncidentShapeIsCaughtAndNamed();
  testAFolderWithNoGitEntryIsCaughtToo();
  testUntrackedIsLoudAndGitignoredIsQuiet();
  testASpreadsheetIsLoudEvenWhenGitignored();
  testEveryUnknownRefusesToPrintAsSafe();
  testBuildOutputOnlyNeverClaimsAComparison();
  testARecentWriteSaysSomethingMayStillBeWriting();
  testLongListsAreTruncatedButNeverSilently();
  testSectionLines();
  testFixDeletesHusksAndNothingElse();
  testTheSectionIsActuallyWiredIn();
}
