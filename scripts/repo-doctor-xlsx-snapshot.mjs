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
  for (const f of shown) out.push(`    ${f.name}`);
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

/** Untracked files under `xlsx/`. Tracked ones are git's problem, and recoverable from it. */
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
    return statEntries(dir).filter((f) => !tracked.has(f.name));
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

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

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
  if (files.length === 0) return { dir: null, copied: 0, skipped: all.length, verified: 0, mismatched: [] };

  const stamp = new Date(now).toISOString().slice(0, 10);
  const dir = path.join(snapshotRoot, `${SNAPSHOT_DIR_PREFIX}${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const rows = [];
  const mismatched = [];
  for (const f of files) {
    const src = path.join(repoRoot, "xlsx", f.name);
    const dst = path.join(dir, f.name);
    fs.copyFileSync(src, dst);
    // Verify from DISK on both sides, not against the buffer just written: the point is to prove the
    // copy LANDED, and a check that re-reads what it still holds in memory proves only that memory works.
    const a = sha256(src);
    const b = sha256(dst);
    if (a !== b) mismatched.push(f.name);
    rows.push({ name: f.name, bytes: f.bytes, hash: a });
  }

  const manifest = [
    "xlsx/ snapshot — untracked working files from the Phoenix Workforce repo",
    `Taken     : ${new Date(now).toISOString()}`,
    `Source    : ${path.join(repoRoot, "xlsx")}`,
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
    ...rows.map((r) => `${r.hash}  ${String(r.bytes).padStart(9)}  ${r.name}`),
  ].join("\n");
  fs.writeFileSync(path.join(dir, "MANIFEST.txt"), `${manifest}\n`);

  return {
    dir,
    copied: files.length,
    skipped: all.length - files.length,
    verified: files.length - mismatched.length,
    mismatched,
  };
}
