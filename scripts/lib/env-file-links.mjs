// ONE copy of each local env file on this laptop, not one per worktree.
//
// WHY THIS EXISTS (credentials audit, 18 Nov 2026, finding 3): sync-worktree-env.mjs and the sweep in
// provision-worktree.mjs used to COPY the primary's gitignored .env files into every worktree. Each
// copy holds the live production service key, cron secret and database password, so 18 worktrees
// meant 18 copies, and a rotation in the primary left 18 stale ones behind. The date-stamped and
// retired files went along too: `.env.local.production-20260921` (a dead old-format key) and
// `.env.production` (a dead third project) sat in every worktree.
//
// Now a worktree's env file is a HARD LINK to the primary's: one file on disk under two names.
// No admin right or developer mode is needed (unlike a symbolic link), it works only on one volume
// (every worktree here is on F:), and Next.js and every script read it like a plain file.
//
// 🔴 A HARD LINK SHARES THE BYTES BOTH WAYS. Appending to a worktree's .env.local in place edits the
// primary's and every other worktree's. A worktree that needs its own values deletes the link first
// and writes a fresh file; a file that differs from the primary's and is not a link is left alone.
//
// What each run does, per file, never printing a value:
//   - missing here                          -> linked to the primary's
//   - already the primary's file            -> nothing
//   - a byte-identical copy                 -> replaced by a link (same bytes, so no behaviour change)
//   - an OLDER copy (last written before the primary's file was) -> replaced by a link: it is a
//     snapshot the primary has since moved past. Measured 18 Nov 2026: 13 of 19 worktrees held one,
//     and not one copy had been edited after the primary's last write.
//   - a link into a file the primary has since REPLACED (scripts/refresh-local-env.mjs renames the
//     old .env.local aside and writes a new one, which leaves every link on the old bytes)
//                                          -> re-linked to the primary's current file
//   - a file written AFTER the primary's, not a link -> kept (the worktree's own on purpose);
//                                              --force re-links it
// A link that cannot be made (another volume, a filesystem without links) falls back to a copy,
// and an existing file is never touched when its replacement fails.
import fs from "node:fs";
import path from "node:path";

// Files never handed to a worktree. Kept in the primary; a worktree's copy is removed when the primary
// holds the same name with the same bytes or NEWER ones (the copy is then a stale snapshot of a stale
// file). A copy with no original in the primary, or written after it, is kept and reported.
//   .env.production          — a dead third Supabase project's keys (Next also loads it on a local
//                              `next build`, where .env.local wins anyway)
//   .env.sentry-build-plugin — the upload token of the retired error tracker
export const RETIRED_ENV_FILES = new Set([".env.production", ".env.sentry-build-plugin"]);

/** A date-stamped snapshot, a backup or a retired file: never provisioned into a worktree. */
export function isStaleEnvName(name) {
  return (
    RETIRED_ENV_FILES.has(name) ||
    /-\d{8}(?:$|[-.])/.test(name) ||
    /\.(?:bak|backup|old|orig|prev)(?:$|[-.])/i.test(name)
  );
}

function statOrNull(file) {
  try {
    return fs.statSync(file, { bigint: true });
  } catch {
    return null;
  }
}

function sameInode(a, b) {
  return Boolean(a && b) && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
}

/** True when both names are the same file on disk (a hard link, or one name followed through a link). */
export function isSameFile(a, b) {
  return sameInode(statOrNull(a), statOrNull(b));
}

function sameBytes(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

// Link under a temporary name, then rename over the old file: a reader never sees the name missing.
function replaceWithLink(src, dest) {
  const tmp = `${dest}.link-${process.pid}-${Date.now()}`;
  fs.linkSync(src, tmp);
  try {
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing left to tidy
    }
    throw err;
  }
}

/**
 * Make `dest` the primary's `src`. Returns what happened:
 *   "linked" | "relinked" | "copied" | "already-linked" | "kept" | "absent"
 *   and in dryRun "would-link" | "would-relink".
 * "linked", "relinked" and "copied" changed something; "kept" means a different file was left alone.
 *
 * @param {string} src  the primary's env file
 * @param {string} dest the same name in a worktree
 * @param {{ force?: boolean, dryRun?: boolean }} [options]
 */
export function provisionEnvFile(src, dest, { force = false, dryRun = false } = {}) {
  const s = statOrNull(src);
  if (!s) return "absent";
  const d = statOrNull(dest);
  if (d) {
    if (sameInode(s, d)) return "already-linked";
    const orphanedLink = d.nlink > 1n; // a link whose primary-side name now points at newer bytes
    const olderSnapshot = d.mtimeMs <= s.mtimeMs; // copied before the primary's last write
    if (!force && !orphanedLink && !olderSnapshot && !sameBytes(src, dest)) return "kept";
  }
  if (dryRun) return d ? "would-relink" : "would-link";
  try {
    if (d) replaceWithLink(src, dest);
    else fs.linkSync(src, dest);
    return d ? "relinked" : "linked";
  } catch {
    if (d) return "kept"; // never leave a worktree without the file it had
    fs.copyFileSync(src, dest);
    return "copied";
  }
}

/** Changed something on disk (or would, in dryRun). */
export function envFileChanged(status) {
  return /^(linked|relinked|copied|would-link|would-relink|removed|would-remove)$/.test(status);
}

/**
 * Remove a worktree's copy of a stale env file (isStaleEnvName) when the primary still holds that
 * name with the same bytes or newer ones. Returns one entry per stale file found in `dir`.
 *
 * @param {string} primaryRoot
 * @param {string} dir
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ name: string, status: "removed" | "would-remove" | "kept" }[]}
 */
export function removeStaleEnvCopies(primaryRoot, dir, { dryRun = false } = {}) {
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith(".env") && isStaleEnvName(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const src = path.join(primaryRoot, name);
    const dest = path.join(dir, name);
    const s = statOrNull(src);
    const d = statOrNull(dest);
    const covered = s && d && (sameInode(s, d) || d.mtimeMs <= s.mtimeMs || sameBytes(src, dest));
    if (!covered) {
      out.push({ name, status: "kept" }); // no original in the primary, or written after it
      continue;
    }
    if (dryRun) {
      out.push({ name, status: "would-remove" });
      continue;
    }
    try {
      fs.unlinkSync(dest);
      out.push({ name, status: "removed" });
    } catch {
      out.push({ name, status: "kept" });
    }
  }
  return out;
}
