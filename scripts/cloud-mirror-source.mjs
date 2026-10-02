// WHERE THE MIRROR IS READ FROM, which is the whole of this module's point.
//
// 🔴 A CLOUD SESSION CLONES `main`. It never sees a laptop working tree, so the copy that decides
// what it wakes up knowing is the mirror **on `origin/main`** — not the one on disk here.
//
// MEASURED 2026-10-02, four times in one afternoon: `repo-doctor` reported "2 files DRIFTED" while
// both files were byte-identical to live memory on `origin/main`. The cause each time was the same
// and is the NORMAL state of this repository rather than an edge case — `main` moves every few
// minutes, so the primary checkout is usually a commit or two behind, and reading its working tree
// compares live memory against a mirror that was already superseded. Every one of those four reports
// cost a round of hand-proving that the drift was spurious, and a check that cries wolf is a check
// people switch off.
//
// The fix is to read the tree, not the disk. `cloud-mirror-drift.mjs` stays pure — it classifies two
// Maps and knows nothing about git — and this module is the only part that does I/O.
//
// 🔴 THE REF IS AS FRESH AS THE LAST FETCH, AND THIS MODULE DOES NOT FETCH. A SessionStart hook must
// not do network I/O: it would add seconds to every session start and fail in odd ways offline. A
// stale `origin/main` ref can therefore still report drift that a newer merge has already fixed —
// but it is strictly better than the working tree, because after any fetch HEAD is an ancestor of
// `origin/main`, so the ref is never the older of the two. Callers print which source they used.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MIRROR_DIR = ".claude/cloud-context/memory-mirror";

/**
 * Read every `.md` of the mirror as it exists in a git ref.
 *
 * One `ls-tree` and one `cat-file --batch` for the whole directory — never a `git show` per file,
 * which would be ~1,066 process spawns and far too slow for a SessionStart hook.
 *
 * 🔴 `root` MUST be declared here, not left to inference. Without this `@param` TypeScript types
 * the options from the destructuring defaults alone — `root` has none, so it is dropped and every
 * `.ts` caller passing it fails `checks` with TS2353 "'root' does not exist in type". It is typed
 * optional because the runtime tolerates its absence: `git -C undefined` throws inside the try and
 * the function answers `null`, i.e. "could not read", which is this function's contract anyway.
 *
 * @param {{ root?: string, ref?: string, dir?: string }} [options] `root` is the checkout to read
 *        from (every caller passes one), `ref` the git ref, `dir` the mirror directory inside it.
 * @returns `Map<filename, contents>`, or `null` when the ref or the directory is not there (a fresh
 *          clone, a cloud session, a branch predating the mirror). `null` means "could not read",
 *          never "empty" — the caller must not report an absent source as clean.
 */
export function readMirrorFromRef({ root, ref = "origin/main", dir = MIRROR_DIR } = {}) {
  let listing;
  try {
    listing = execFileSync("git", ["-C", root, "ls-tree", "-r", ref, "--", dir], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // no such ref, not a repo, git unavailable — all "cannot read"
  }

  const wanted = [];
  for (const line of listing.split("\n")) {
    if (!line) continue;
    // `<mode> <type> <oid>\t<path>`
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    const filePath = line.slice(tab + 1);
    if (meta[1] !== "blob") continue;
    const name = path.posix.basename(filePath);
    if (!name.toLowerCase().endsWith(".md")) continue;
    // `.bak` copies are deliberate pre-rewrite snapshots, not memories — the same exclusion every
    // other reader of this directory makes.
    if (name.includes(".bak")) continue;
    wanted.push({ oid: meta[2], name });
  }
  if (wanted.length === 0) return null;

  // One batch process for every blob. The response is `<oid> blob <size>\n<bytes>\n`, so it is parsed
  // by OFFSET rather than by splitting on newlines — a memory file is full of newlines.
  let batch;
  try {
    batch = execFileSync("git", ["-C", root, "cat-file", "--batch"], {
      input: wanted.map((w) => w.oid).join("\n") + "\n",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return null;
  }

  const out = new Map();
  let at = 0;
  for (const { name } of wanted) {
    const nl = batch.indexOf(0x0a, at);
    if (nl < 0) return null; // truncated response — refuse rather than report a partial mirror
    const header = batch.subarray(at, nl).toString("utf8");
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) return null;
    const start = nl + 1;
    out.set(name, batch.subarray(start, start + size).toString("utf8"));
    at = start + size + 1; // trailing newline after each blob
  }
  return out;
}

/**
 * Read the mirror from disk, the way every caller used to.
 *
 * Kept as the explicit fallback so the two sources are named in one place and a caller can SAY which
 * one it used. A working-tree read answers "what would a commit from here ship", which is a different
 * and weaker question than "what has a cloud session got".
 */
export function readMirrorFromDisk(dir) {
  try {
    const out = new Map();
    for (const name of fs.readdirSync(dir)) {
      if (!name.toLowerCase().endsWith(".md") || name.includes(".bak")) continue;
      try {
        out.set(name, fs.readFileSync(path.join(dir, name), "utf8"));
      } catch {
        // Unreadable file left out: it then shows as missing from this side, which is visible.
      }
    }
    return out.size === 0 ? null : out;
  } catch {
    return null;
  }
}

/**
 * The mirror a cloud session would actually clone, with the fallback and a label.
 *
 * @param {{ root?: string, ref?: string, diskDir?: string }} [options] Same `root`/`ref` as
 *        `readMirrorFromRef` — declared for the same TS2353 reason given there — plus `diskDir`,
 *        the working-tree directory used only when the ref cannot be read.
 * @returns `{ files, source, label }` — `source` is `"ref"` or `"disk"`, `label` is the sentence a
 *          caller prints so a reader is never left guessing which copy was measured. `null` when
 *          neither could be read, which callers must report as "cannot measure".
 */
export function readCloudMirror({ root, ref = "origin/main", diskDir } = {}) {
  const fromRef = readMirrorFromRef({ root, ref });
  if (fromRef) {
    return {
      files: fromRef,
      source: "ref",
      label: `measured against ${ref} — the copy a cloud session clones (as fresh as the last fetch)`,
    };
  }
  const fromDisk = diskDir ? readMirrorFromDisk(diskDir) : null;
  if (fromDisk) {
    return {
      files: fromDisk,
      source: "disk",
      label: `measured against this WORKING TREE — ${ref} could not be read, so this says what a commit from here would ship, not what cloud has`,
    };
  }
  return null;
}
