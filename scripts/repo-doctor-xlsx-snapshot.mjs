// Whether the untracked spreadsheets in xlsx/ exist anywhere but this one disk — and, on request, a copy.
//
// WHY THIS EXISTS. On 2026-09-05 something outside this repository deleted every TRACKED PDF under
// xlsx/ from all seven checkouts on this machine at once — the primary, five worktrees, and one
// under .claude/worktrees/. No repo script deletes PDFs, .gitignore carries no PDF rule, and Windows
// Defender logged no detection on that path; the cause was never identified. Every one came back
// with `git checkout -- xlsx/`, byte-identical to its blob, because git held them.
//
// The five that came back were the entire tracked population of that folder. The other 104 files in
// it — 56 MB — are matched by `.gitignore` line 45 (`*.xlsx`), so git holds NONE of them. Had the
// same sweep taken `*.xlsx` instead, it would have destroyed `phoenix-monthly-closing-2026-07-*` in
// seven variants, all three `phoenix-closing-2026-07-*.xlsm` premium engines (the pivot/slicer/VBA
// workbooks AGENTS.md section 4 forbids round-tripping precisely because they cannot be rebuilt),
// `closing-details-2026-07.xlsx`, the doctor-brick and doctor-location mapping set, and roughly forty
// decision sheets the owner had filled in and sent back.
//
// The DR set already held a copy at `05-data-files\xlsx\`. It was taken 2026-08-25 and held 35
// files; 74 of the 104 were absent from it. So the backup existed, was eleven days stale, and
// NOTHING MEASURED THAT. This section is the measurement.
//
// WHY IT LIVES IN THE DOCTOR. AGENTS.md section 5 already sends a session here after any worktree
// removal, and this is the same class of question the ARCHIVE REFS section asks about commits —
// "does this exist off this laptop?" — for the one category of file git was never going to answer
// for. Answering it anywhere else means a check nobody runs.
//
// READ-ONLY BY DEFAULT, and that is load-bearing. AGENTS.md documents repo-doctor as a tool that
// never writes, and other sessions rely on that. The report is pure measurement; the COPY happens
// only under the explicit `--snapshot-xlsx` flag. Even then this module only ever CREATES files
// under the snapshot root — it never deletes, never overwrites anything in the repo, and never
// touches the older `xlsx\` copy, which may be a deliberate point-in-time original.
//
// NOT KNOWING READS LOUD, never clean — the same one-way rule as the rest of the doctor. A missed
// file here reads as "safely backed up" over a file that exists once, which is worse than having no
// check at all because it stops anyone looking. An unreadable source, an unreadable snapshot root
// and an absent destination are each their own status, and none of them is "ok".

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Directories under the snapshot root that hold a dated snapshot. */
export const SNAPSHOT_DIR_PREFIX = "xlsx-snapshot-";

/**
 * The pre-existing hand-made copy. Counted as coverage — a file in it IS off this disk — but never
 * written to: it predates this tool and may be a deliberate original.
 */
export const LEGACY_SNAPSHOT_DIR = "xlsx";

/** Where snapshots live. Machine-specific, so overridable; absent is a valid state, not an error. */
export const DEFAULT_SNAPSHOT_ROOT = "F:\\PHX backup\\05-data-files";

/**
 * Excel writes `~$<name>` lock files beside an open workbook and deletes them on close. They carry
 * no content and are gone by the time anyone reads a snapshot, so they are excluded from BOTH the
 * copy and the coverage count — otherwise every run reports a file that cannot be kept.
 */
export const isLockFile = (name) => name.startsWith("~$");

/**
 * Subfolders of `xlsx/` whose untracked files are backed up as well as the top level's.
 *
 * The backup used to cover the TOP of `xlsx/` and nothing below it, which was right while everything
 * below it was a worktree's leftovers. It stopped being right on 2026-10-09, when the field day
 * printer began archiving the paper it replaces into `xlsx/field-day-superseded/` (owner, that day:
 * "add xlsx/field-day-superseded to the hourly backup"). Those archives are the only copy of a paper
 * that already went to a district manager or the Chief Executive, and nothing else holds them: they
 * are PDFs matched by no commit.
 *
 * 🔴 THE NAME IS REPEATED HERE AND NEVER IMPORTED, deliberately. `xlsx-snapshot.cmd` extracts THIS
 * FILE ALONE from `origin/main` (`git show origin/main:scripts/repo-doctor-xlsx-snapshot.mjs`) and
 * runs it as a standalone script, so an import of any other repo file would make the hourly backup
 * fail outright — node would be resolving a path that was never extracted. Node builtins only, here
 * and below. `tests/repo-doctor-xlsx-snapshot.test.ts` asserts this list still matches the printer's
 * own `SUPERSEDED_DIR`, which is what catches a rename of that folder.
 *
 * `scratch-map-unmapped` joined on 2026-10-12 (owner: "add scratch-map-unmapped to the xlsx backup
 * list"): the pre-images and plans of the unmapped-customer mapping run, the only way to undo it.
 *
 * Only named folders, never a recursive walk: `xlsx/` also holds whatever a session left behind.
 */
export const BACKED_UP_SUBDIRS = ["field-day-superseded", "scratch-map-unmapped"];

export function snapshotRootFor(env = process.env) {
  const override = env.PHOENIX_XLSX_SNAPSHOT_ROOT;
  return override && override.trim() ? override.trim() : DEFAULT_SNAPSHOT_ROOT;
}

/**
 * Is this source file already in a snapshot?
 *
 * Name AND size AND freshness, deliberately — not name alone. A decision sheet the owner fills in
 * and sends back keeps its NAME, so name-only matching would report the filled sheet as covered by
 * the empty version of itself, which is the exact failure this module exists to prevent. Size
 * catches a changed workbook (an .xlsx is a zip; an edit preserving the byte count is not realistic),
 * and the freshness comparison catches a re-save that happens to land on the same size.
 *
 * Hashing is NOT used here. The report runs on every `repo:doctor` invocation and would have to read
 * 56 MB to answer; the WRITE path hashes every byte instead, where the cost buys a verification.
 */
export function isCovered(file, snapshotEntries) {
  return snapshotEntries.some(
    (e) => e.name === file.name && e.bytes === file.bytes && e.mtimeMs >= file.mtimeMs,
  );
}

/**
 * The verdict, from facts read elsewhere. No filesystem, no git, no clock — so a test can drive
 * every branch, including the ones that only happen on a machine that has lost its backup drive.
 */
export function classifyXlsxSnapshot({ destinationExists, sourceFiles, snapshots, now }) {
  if (sourceFiles === null) {
    return { status: "unknown-source", uncovered: [], sourceCount: 0, sourceBytes: 0, newest: null, ageDays: null };
  }

  const files = sourceFiles.filter((f) => !isLockFile(f.name));
  const sourceBytes = files.reduce((n, f) => n + f.bytes, 0);
  const base = { uncovered: [], sourceCount: files.length, sourceBytes, newest: null, ageDays: null };

  if (!destinationExists) return { ...base, status: "no-destination" };
  if (snapshots === null) return { ...base, status: "unknown-snapshots" };

  const all = snapshots.flatMap((s) => s.entries);
  const uncovered = files.filter((f) => !isCovered(f, all));

  // The newest DATED snapshot. The legacy hand-made folder is coverage but never a freshness signal:
  // it has no date in its name, and reading its mtime would report an untouched 2026-08-25 copy as
  // current the moment anything else in the DR set was touched.
  const dated = snapshots.filter((s) => s.dir.startsWith(SNAPSHOT_DIR_PREFIX));
  const newest = dated.length > 0 ? dated[dated.length - 1] : null;

  return {
    ...base,
    status: uncovered.length === 0 ? "covered" : "gap",
    uncovered,
    newest: newest ? newest.dir : null,
    ageDays: newest ? Math.floor((now - newest.mtimeMs) / 86_400_000) : null,
  };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The printed section. `deep` lists every uncovered file rather than the first ten. */
export function xlsxSnapshotLines(verdict, { deep = false, snapshotRoot = DEFAULT_SNAPSHOT_ROOT } = {}) {
  const out = ["", "XLSX SNAPSHOT (untracked spreadsheets — git holds none of these)"];

  if (verdict.status === "unknown-source") {
    out.push("  -> COULD NOT READ xlsx/. Do NOT read this as clean.");
    return out;
  }
  if (verdict.sourceCount === 0) {
    out.push("  -> no untracked spreadsheets in xlsx/. Nothing here git cannot already recover.");
    return out;
  }

  out.push(`  ${verdict.sourceCount} untracked file(s) in xlsx/, ${mb(verdict.sourceBytes)}`);

  if (verdict.status === "no-destination") {
    out.push(`  -> snapshot root not present on this machine (${snapshotRoot}).`);
    out.push("     NOT CHECKED, not clean. Set PHOENIX_XLSX_SNAPSHOT_ROOT or attach the backup drive.");
    return out;
  }
  if (verdict.status === "unknown-snapshots") {
    out.push("  -> snapshot root exists but COULD NOT BE READ. Do NOT read this as clean.");
    return out;
  }

  out.push(
    verdict.newest
      ? `  newest snapshot: ${verdict.newest} (${verdict.ageDays} day(s) old)`
      : "  newest snapshot: none — no dated snapshot has ever been taken",
  );

  if (verdict.status === "covered") {
    out.push("  -> every one is also in a snapshot.");
    return out;
  }

  const LIST_LIMIT = 10;
  const shown = deep ? verdict.uncovered : verdict.uncovered.slice(0, LIST_LIMIT);
  for (const f of shown) out.push(`    ${f.rel ?? f.name}`);
  if (verdict.uncovered.length > shown.length) {
    out.push(
      `    ... and ${verdict.uncovered.length - shown.length} more not listed — re-run with --deep for the full list.`,
    );
  }
  out.push(`  -> ${verdict.uncovered.length} file(s) exist on this disk ONLY. To copy them:`);
  out.push("       node scripts/repo-doctor.mjs --snapshot-xlsx");
  return out;
}

// ---------------------------------------------------------------------------------------------
// IO. Everything below touches the disk; everything above is pure.
// ---------------------------------------------------------------------------------------------

function statEntries(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const st = fs.statSync(path.join(dir, d.name));
      return { name: d.name, bytes: st.size, mtimeMs: st.mtimeMs };
    });
}

/**
 * Untracked files under `xlsx/`. Tracked ones are git's problem, and recoverable from it.
 *
 * Every entry carries `rel` — its path relative to `xlsx/` — because a file from one of
 * `BACKED_UP_SUBDIRS` is read from the subfolder while `name`, the basename, stays the key the
 * coverage test, the flat snapshot folder and the manifest all use.
 */
export function readSourceFiles(repoRoot) {
  const dir = path.join(repoRoot, "xlsx");
  if (!fs.existsSync(dir)) return [];
  let tracked;
  try {
    // -z, not the default: these filenames hold spaces, and git QUOTES such paths in its normal
    // output. Parsing the quoted form would mis-key every file with a space in it — which is most of
    // them — and every one would then read as untracked AND as absent from the snapshot.
    const raw = execFileSync("git", ["-C", repoRoot, "ls-files", "-z", "--", "xlsx/"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    tracked = new Set(raw.split("\0").filter(Boolean).map((p) => path.posix.basename(p)));
  } catch {
    return null; // git failed — an alarm, never an empty list
  }
  try {
    const top = statEntries(dir)
      .filter((f) => !tracked.has(f.name))
      .map((f) => ({ ...f, rel: f.name }));
    // An ABSENT subfolder is nothing to copy; an UNREADABLE one throws into the catch below and the
    // whole answer becomes null, which reads as "do NOT treat this as clean" everywhere above.
    const nested = BACKED_UP_SUBDIRS.flatMap((sub) => {
      const subDir = path.join(dir, sub);
      if (!fs.existsSync(subDir)) return [];
      return statEntries(subDir)
        .filter((f) => !tracked.has(f.name))
        .map((f) => ({ ...f, rel: path.join(sub, f.name) }));
    });
    return [...top, ...nested];
  } catch {
    return null;
  }
}

/** Every snapshot directory under the root, sorted, so the last dated one is the newest. */
export function readSnapshots(snapshotRoot) {
  try {
    return fs
      .readdirSync(snapshotRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => n === LEGACY_SNAPSHOT_DIR || n.startsWith(SNAPSHOT_DIR_PREFIX))
      .sort()
      .map((dir) => {
        const full = path.join(snapshotRoot, dir);
        return { dir, entries: statEntries(full), mtimeMs: fs.statSync(full).mtimeMs };
      });
  } catch {
    return null;
  }
}

const MANIFEST_NAME = "MANIFEST.txt";

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * Write MANIFEST.txt describing THE FOLDER, not the run that happened to call this.
 *
 * Re-running on the same day reuses that day's directory, so a manifest built from the current
 * run's copies silently drops every file an earlier run put there. Measured 2026-09-05: the base
 * folder held 109 files while its own manifest listed 4, under a heading calling it the full base.
 * Coverage is computed from real directory contents, so the BACKUP was never at risk — but the
 * manifest is the audit record, and one that under-reports by 105 files invites the reader to
 * conclude the backup is nearly empty.
 */
function writeManifest({ dir, repoRoot, now, added }) {
  const held = statEntries(dir)
    .filter((e) => e.name !== MANIFEST_NAME)
    .map((e) => ({ name: e.name, bytes: e.bytes, hash: sha256(path.join(dir, e.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const manifest = [
    "xlsx/ snapshot — untracked working files from the Phoenix Workforce repo",
    `Taken     : ${new Date(now).toISOString()}`,
    `Source    : ${path.join(repoRoot, "xlsx")}`,
    `Holds     : ${held.length} file(s) in this folder; this run added ${added}`,
    "",
    "WHY THIS EXISTS: .gitignore ignores *.xlsx, so none of these files are in git. Written by",
    "scripts/repo-doctor-xlsx-snapshot.mjs — see that file's header for the incident behind it.",
    "",
    "THIS IS A DELTA. It holds only the files no earlier snapshot already held. To restore, apply",
    "every xlsx-snapshot-* folder in DATE ORDER, oldest first, letting the newest copy of each file",
    "win. xlsx-snapshot-2026-09-05 is the full base.",
    "",
    "SHA256                                                            BYTES  NAME",
    "----------------------------------------------------------------------------",
    ...held.map((r) => `${r.hash}  ${String(r.bytes).padStart(9)}  ${r.name}`),
  ].join("\n");
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), `${manifest}\n`);
  return held.length;
}

/**
 * Copy the untracked spreadsheets that NO existing snapshot holds into a dated one, VERIFY each,
 * then write a manifest.
 *
 * A DELTA, not a full copy, and the disk is why. Measured 2026-09-05: the folder is 103 files and
 * 56.1 MB, but only 16 files and ~3 MB change on a given day. Copying all of it daily writes ~20 GB
 * a year against 21.9 GB free on this drive — a scheduled full snapshot would fill the disk inside a
 * year and take the backups down with it. A delta writes about 1 GB a year.
 *
 * SO THE SNAPSHOT SET IS A FULL BASE PLUS DELTAS. xlsx-snapshot-2026-09-05 was taken complete by
 * hand; every later folder holds only what was newly at risk that day. To restore, apply the folders
 * in date order, oldest first, and the newest copy of each file wins. Every manifest repeats that.
 * COVERAGE IS ALREADY COMPUTED ACROSS ALL FOLDERS — classifyXlsxSnapshot flattens them — so the
 * report cannot be fooled by a file living in an older folder than the newest one.
 *
 * Creates only. Never deletes, never writes inside the repo, never touches the legacy copy. Nothing
 * uncovered means no directory is created at all, so a quiet day leaves no empty folder behind.
 * Re-running on the same day reuses that day's directory and overwrites its own earlier copies, so a
 * half-finished run self-heals on the next one rather than leaving a partial snapshot to be trusted.
 */
export function takeXlsxSnapshot({ repoRoot, snapshotRoot, now = Date.now() }) {
  const all = (readSourceFiles(repoRoot) ?? []).filter((f) => !isLockFile(f.name));
  // Held against EVERY existing snapshot, by the same content test the report uses. Sharing one
  // predicate is the point: a write path with its own idea of "already backed up" would drift from
  // the report, and the report is what tells anyone whether to trust the backup.
  const existing = (readSnapshots(snapshotRoot) ?? []).flatMap((snap) => snap.entries);
  const files = all.filter((f) => !isCovered(f, existing));

  // Africa/Cairo, not UTC — this names the snapshot folder the owner reads to see when the
  // backup was taken, and dates the "same day" key the quiet-run manifest reconcile keys on.
  // Formats the injected `now` (never a fresh clock read) so the caller stays in control.
  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(now));
  const dir = path.join(snapshotRoot, `${SNAPSHOT_DIR_PREFIX}${stamp}`);

  if (files.length === 0) {
    // Nothing to copy — but an earlier run TODAY may have left a manifest describing only itself,
    // and no other code path will ever repair it: a wrong manifest is only rewritten when a new
    // file happens to appear. Reconcile it here so the record self-heals on the next quiet run.
    // Creates nothing: a day with no snapshot folder stays a day with no snapshot folder.
    const manifestHolds = fs.existsSync(dir) ? writeManifest({ dir, repoRoot, now, added: 0 }) : 0;
    return { dir: null, copied: 0, skipped: all.length, verified: 0, mismatched: [], collided: [], manifestHolds };
  }

  fs.mkdirSync(dir, { recursive: true });

  // 🔴 THE SNAPSHOT FOLDER IS FLAT AND KEYED BY BASENAME, so two sources sharing one basename would
  // mean the second copy silently overwrote the first while the manifest named only one of them — a
  // file believed backed up that is not, which is the single outcome this module exists to prevent.
  // It cannot happen with what is there today: every archive carries `-superseded-<sha>`, which no
  // live paper's name does. If it ever does, the nested file is NOT copied and the run ends LOUD.
  const byName = new Map();
  const collided = [];
  for (const f of files) {
    if (byName.has(f.name)) {
      collided.push(f.rel ?? f.name);
      continue;
    }
    byName.set(f.name, f);
  }

  const rows = [];
  const mismatched = [];
  for (const f of byName.values()) {
    const src = path.join(repoRoot, "xlsx", f.rel ?? f.name);
    const dst = path.join(dir, f.name);
    fs.copyFileSync(src, dst);
    // Verify from DISK on both sides, not against the buffer just written: the point is to prove the
    // copy LANDED, and a check that re-reads what it still holds in memory proves only that memory works.
    const a = sha256(src);
    const b = sha256(dst);
    if (a !== b) mismatched.push(f.name);
    rows.push({ name: f.name, bytes: f.bytes, hash: a });
  }

  const holds = writeManifest({ dir, repoRoot, now, added: rows.length });

  return {
    dir,
    copied: rows.length,
    skipped: all.length - files.length,
    verified: rows.length - mismatched.length,
    mismatched,
    collided,
    manifestHolds: holds,
  };
}

// ---------------------------------------------------------------------------------------------
// RUN DIRECTLY, as the nightly job does.
//
// WHY THIS ENTRY POINT EXISTS. The obvious way to schedule the snapshot is to point a task at
// `repo-doctor.mjs --snapshot-xlsx` in the primary checkout. Measured 2026-09-05, that silently does
// NOTHING: the primary sat 38 commits behind origin/main, its repo-doctor predated the flag, and an
// unknown flag is ignored without complaint — the job exited 0 and wrote a full, plausible-looking
// report with no snapshot section in it at all. A working checkout is on whatever branch someone
// left it on, so a backup that depends on the code checked out there is a backup that stops working
// without saying so. The wrapper therefore extracts THIS file from origin/main and runs it, and only
// the folder being copied comes from the checkout.
//
// Exit codes are the whole point of running it this way: they are what the scheduled task records.
//   0 copied, or nothing to copy   2 no destination   3 source unreadable   4 a copy failed to verify
// ---------------------------------------------------------------------------------------------
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // 🔴 AN UNKNOWN FLAG IS REFUSED, NEVER IGNORED — the header above records the day an ignored flag made this very
  // job exit 0 having done nothing. Inline and on node builtins only: `xlsx-snapshot.cmd` extracts this file ALONE,
  // so an import of scripts/lib/refuse-arguments.mjs would stop the hourly backup outright. Exact tokens, not
  // `--flag=value`: argOf below reads only the separate-value form, so accepting `--repo=x` would ignore it.
  const SNAPSHOT_FLAGS = ["--repo", "--root"];
  const unknownFlags = process.argv.slice(2).filter((a) => a.startsWith("-") && !SNAPSHOT_FLAGS.includes(a));
  if (unknownFlags.length > 0) {
    console.error(
      `${new Date().toISOString()} REFUSED — unknown flag ${unknownFlags.join(" ")}; this job accepts ${SNAPSHOT_FLAGS.join(" ")}. Nothing was copied.`,
    );
    process.exit(2);
  }
  const argOf = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
  };
  const repoRoot = argOf("--repo") ?? process.cwd();
  const snapshotRoot = argOf("--root") ?? snapshotRootFor();
  const stamp = new Date().toISOString();

  if (!fs.existsSync(snapshotRoot)) {
    // REFUSED, never "created". An absent backup drive is the one state where inventing the
    // destination would be worst: it writes the only copy onto the disk it is meant to survive.
    console.error(`${stamp} REFUSED — ${snapshotRoot} does not exist. Nothing was copied.`);
    process.exit(2);
  }
  // An ABSENT xlsx/ is a failure here, not an empty one. readSourceFiles answers [] for a folder
  // that is not there — right for the report, which runs inside a known repo — but as a scheduled
  // job that turns a wrong --repo (a typo, a moved folder, a drive letter that came back different)
  // into "OK, 0 sheet(s), nothing to do" with exit 0. That is the false clean this whole check
  // exists to prevent, and it would be the nightly log every night while nothing was backed up.
  const sourceDir = path.join(repoRoot, "xlsx");
  if (!fs.existsSync(sourceDir)) {
    console.error(`${stamp} FAILED — ${sourceDir} does not exist. Wrong --repo? Nothing was copied.`);
    process.exit(3);
  }
  if (readSourceFiles(repoRoot) === null) {
    console.error(`${stamp} FAILED — cannot read ${sourceDir}. Nothing was copied.`);
    process.exit(3);
  }

  const result = takeXlsxSnapshot({ repoRoot, snapshotRoot });
  if (result.dir === null) {
    const also = result.manifestHolds
      ? ` Manifest reconciled: ${result.manifestHolds} file(s) in today's folder.`
      : "";
    console.log(
      `${stamp} OK — nothing new; all ${result.skipped} sheet(s) are already in a snapshot.${also}`,
    );
    process.exit(0);
  }
  console.log(
    `${stamp} OK — copied ${result.copied}, skipped ${result.skipped} already held, ` +
      `verified ${result.verified} by SHA256 -> ${result.dir}`,
  );
  if (result.mismatched.length) {
    console.error(`${stamp} FAILED — ${result.mismatched.length} copy/copies did not verify:`);
    for (const m of result.mismatched) console.error(`  ${m}`);
    process.exit(4);
  }
  // Not copied, so not backed up — the same class of failure as a copy that did not verify, and it
  // must never be the quiet part of an otherwise green run.
  if (result.collided?.length) {
    console.error(
      `${stamp} FAILED — ${result.collided.length} file(s) share a name with another source and were NOT copied:`,
    );
    for (const c of result.collided) console.error(`  ${c}`);
    process.exit(4);
  }
}
