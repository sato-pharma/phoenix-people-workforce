// Worktree-shaped folders that git does NOT account for and that are NOT empty — the one state
// repo-doctor used to file under a heading that reads as healthy.
//
// WHY THIS EXISTS. On 2026-09-04 `F:\Phoenix Workforce\_wt-cv-lifecycle-sheet` was retired with
// `node scripts/new-session.mjs --remove cv-lifecycle-sheet`, which reported "worktree removed:
// yes, no husk left". A live session then wrote `docs/cv-lifecycle-live-sheet.gs` into the folder
// that survived that removal, at 23:48 Cairo — 46,603 bytes against main's 16,135, 861 lines added
// and 141 removed. repo-doctor's next run printed `HUSKS: 0` and `LIVE worktrees: 1`. The folder
// was found by listing the directory by hand; the file is preserved at
// `refs/backups/wip/cv-lifecycle-sheet` on origin (commit 1c4ba0b1f).
//
// WHAT THE TWO BUCKETS DID WITH IT. repo-doctor sorted every candidate folder by
//
//     live  = isRegistered || hasGitEntry
//     husk  = !isRegistered && !hasGitEntry && files === 0
//     review= everything else
//
// so a folder git no longer accounts for lands in whichever bucket its LEFTOVER `.git` FILE
// happens to decide. `git worktree remove` on Windows routinely fails *Permission denied*,
// deregisters anyway and leaves the folder behind (AGENTS.md 2.1) — `.git` stub included. That
// folder then satisfies `hasGitEntry`, so it is counted and printed as a LIVE WORKTREE, under the
// one heading whose whole meaning is "these are fine", distinguished only by a bracketed tag at
// the end of a padded line. With the stub gone instead, it reached `review`, which printed a file
// COUNT and nothing else.
//
// Both readings are the same mistake in two sizes: a file count cannot tell a leftover checkout
// from the only copy of someone's afternoon. 4,152 files is what a healthy abandoned worktree
// looks like AND what one holding an unsaved 46KB file looks like.
//
// SO THIS CLASSIFIER KEYS ON REGISTRATION, NEVER ON THE `.git` FILE, and it answers the question
// the count could not: for every file, is this byte-identical to what `main` already has? A folder
// whose every file matches main is a leftover checkout and can be said so plainly. A single file
// that differs, or that is on no branch at all, is reported loudly and by name — that is the whole
// point, and it is the difference between "4,152 files" and "one of these 4,152 is 861 lines of
// work that exists nowhere else".
//
// REPORT-ONLY, ALWAYS. `--fix` deletes proven ZERO-file husks and nothing else, which is a
// disjoint set from this one by construction: a husk holds no files, this category holds files.
// Nothing here is ever passed to a removal path, and tests/repo-doctor-orphaned-folders.test.ts
// pins that at the source level.
//
// PURE, like repo-doctor-supabase-link.mjs — every fact arrives already read, so the test can
// drive every branch with synthetic inputs and no filesystem, no git and no clock.

/**
 * Directories whose contents are regenerable and are therefore not compared against main.
 *
 * `node_modules` is a junction to the primary's copy here (AGENTS.md 5), `.next` is build output,
 * and `.git` is git's own bookkeeping. Their file counts still appear in the TOTAL, because the
 * total is what the LIVE/HUSK sections speak in and two different totals on one report is its own
 * bug — they are excluded from the per-file comparison only.
 */
export const REGENERABLE_DIRS = new Set(["node_modules", ".next", ".git"]);

/**
 * Extensions AGENTS.md 5 forbids deleting outright ("Never delete a `.xlsx` or `.pdf` file, even a
 * stray untracked one in a worktree being cleaned up"). A file of one of these types is called out
 * loudly EVEN WHEN GITIGNORED, because the rule is about the file existing, not about git's
 * opinion of it, and a spreadsheet the owner dropped into a worktree is gitignored exactly as
 * often as it is not.
 */
export const RESCUE_EXTENSIONS = new Set([".xlsx", ".xls", ".xlsm", ".pdf"]);

/**
 * How recently a write has to have happened for the report to say a process may still be running
 * in the folder.
 *
 * Deliberately NOT the 120 minutes `--strip-idle` uses. That threshold gates a DELETION and is
 * tuned to be conservative about acting; this one gates a SENTENCE, where the cost of saying
 * "something may still be writing here" about a dormant folder is nil and the cost of staying
 * quiet about a live one is the incident above — the file that mattered was 5 minutes old when
 * the report that missed it ran.
 */
export const LIVE_WRITE_WINDOW_MIN = 30;

const num = (n) => n.toLocaleString("en-US");

/** AGENTS.md 4: every time is reported in Africa/Cairo, never raw UTC. */
function cairoStamp(ms) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(new Date(ms))
      .replace(",", "");
  } catch {
    return null;
  }
}

function ago(ms, nowMs) {
  const mins = Math.floor((nowMs - ms) / 60000);
  if (mins < 0) return "in the future (clock skew)";
  if (mins < 1) return "less than a minute ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function extensionOf(p) {
  const at = p.lastIndexOf(".");
  if (at <= 0) return "";
  return p.slice(at).toLowerCase();
}

/**
 * Print at most `listLimit` names, then say how many were withheld. A folder where 300 files
 * differ is a folder someone re-checked-out, and 300 lines of report buries the one line that
 * matters in the NEXT folder down. `--deep` passes Infinity.
 */
function nameList(paths, listLimit, describe) {
  const shown = paths.slice(0, listLimit);
  const out = shown.map((p) => `         ${p}`);
  if (paths.length > shown.length) {
    out.push(`         ... and ${num(paths.length - shown.length)} more ${describe} (run with --deep to list them)`);
  }
  return out;
}

/**
 * @param {object} input                    Everything already read by the caller.
 * @param {string} input.label              Printable path, relative to the checkout's parent.
 * @param {string} [input.dir]              Absolute path, used only in the recovery advice.
 * @param {boolean} input.isRegistered      Present in `git worktree list --porcelain`.
 * @param {boolean} input.hasGitEntry       A `.git` file or directory exists on disk.
 * @param {number} input.totalFiles         Full recursive file count, node_modules/.next included.
 * @param {boolean} input.unreadable        Some part of the walk could not be read.
 * @param {number|null} input.newestMtimeMs Newest mtime among the compared files, or null.
 * @param {number} input.nowMs              Injected so the verdict is deterministic under test.
 * @param {boolean} input.mainTreeAvailable Whether `main`'s tree could be read AT ALL.
 * @param {boolean} [input.scannedAll]      False when the file list hit the caller's cap.
 * @param {number} [input.listLimit]        Names printed per group before "... and N more".
 * @param {Array<{path: string, hash: string|null, mainHash: string|null, size: number|null,
 *                mainSize: number|null, ignored: boolean}>} input.files
 *   One entry per file OUTSIDE {@link REGENERABLE_DIRS}. `hash` is the git blob id of the file on
 *   disk (null when it could not be hashed — which must never read as "matches"), `mainHash` is
 *   main's blob id at the same path (null means the path is on no branch).
 *
 * @returns {{orphaned: boolean, state: "registered"|"husk"|"orphaned",
 *            severity: "ok"|"note"|"alarm", differing: string[], untracked: string[],
 *            rescue: string[], unknown: string[], matching: number, ignored: number,
 *            lines: string[]}}
 *   `severity` is "alarm" whenever this folder may hold the only copy of something. Not knowing
 *   is always an alarm, never an "ok": an unreadable file and an unreadable main tree both mean
 *   the safe answer could not be proven, and AGENTS.md rule 1 makes an unproven claim the
 *   expensive kind of wrong.
 */
export function classifyOrphanedFolder(input) {
  const {
    label,
    dir = null,
    isRegistered = false,
    hasGitEntry = false,
    totalFiles = 0,
    unreadable = false,
    newestMtimeMs = null,
    nowMs = 0,
    mainTreeAvailable = false,
    scannedAll = true,
    listLimit = 10,
    files = [],
  } = input;

  const empty = {
    orphaned: false,
    differing: [],
    untracked: [],
    rescue: [],
    unknown: [],
    matching: 0,
    ignored: 0,
    lines: [],
  };

  // A registered worktree is git's business and the retirement gates' business, not this
  // section's. Checked FIRST, so a registered folder can never be reported here whatever its
  // `.git` file looks like.
  if (isRegistered) return { ...empty, state: "registered", severity: "ok" };

  // The husk definition is repeated here as a NEGATIVE — this category is "unregistered and not a
  // husk" — so the two can never both claim a folder, and --fix's input set stays exactly what it
  // was. Emptiness must be PROVEN: `unreadable` means the walk could not finish, and a folder that
  // could not be counted is not a folder known to be empty.
  if (!hasGitEntry && totalFiles === 0 && !unreadable) {
    return { ...empty, state: "husk", severity: "ok" };
  }

  const differing = [];
  const untracked = [];
  const rescue = [];
  const unknown = [];
  let matching = 0;
  let ignored = 0;

  for (const f of files) {
    if (RESCUE_EXTENSIONS.has(extensionOf(f.path))) {
      // Reported by TYPE before anything else looks at its git status. AGENTS.md 5 protects these
      // whether or not git tracks them, and a tracked-and-identical .xlsx is the rare case.
      if (f.hash === null || f.mainHash === null || f.hash !== f.mainHash) {
        rescue.push(f.path);
        continue;
      }
    }
    if (f.hash === null) {
      unknown.push(f.path);
      continue;
    }
    if (f.mainHash === null) {
      if (f.ignored) {
        ignored += 1;
      } else {
        untracked.push(f.path);
      }
      continue;
    }
    if (f.hash === f.mainHash) {
      matching += 1;
    } else {
      const here = f.size === null ? "?" : num(f.size);
      const there = f.mainSize === null ? "?" : num(f.mainSize);
      differing.push(`${f.path}   ${here} bytes here vs ${there} on main`);
    }
  }

  // "I could not check" is an alarm, in every one of its four spellings. A comparison that did not
  // happen must never be printed in the words of one that happened and passed.
  const unproven = !mainTreeAvailable && files.length > 0;
  const atRisk =
    differing.length > 0 || untracked.length > 0 || rescue.length > 0 || unknown.length > 0;
  const severity = unproven || atRisk || unreadable || !scannedAll ? "alarm" : "note";

  const lines = [];
  const compared = files.length;
  const countNote = compared === totalFiles ? "" : ` (${num(compared)} outside node_modules/.next)`;
  lines.push(
    `  ${label.padEnd(58)} ${num(totalFiles).padStart(9)} files${countNote}` +
      (unreadable ? " (partly unreadable)" : ""),
  );

  if (hasGitEntry) {
    lines.push(
      "    it still holds a .git entry, so it ALSO appears under LIVE worktrees above — but " +
        "`git worktree list` does not know it,",
    );
    lines.push(
      "    which is the exact shape a failed `git worktree remove` leaves behind (AGENTS.md 2.1).",
    );
  } else {
    lines.push("    no .git entry, and git has no worktree registered here.");
  }

  if (newestMtimeMs !== null) {
    const stamp = cairoStamp(newestMtimeMs);
    const mins = Math.floor((nowMs - newestMtimeMs) / 60000);
    const live =
      mins < LIVE_WRITE_WINDOW_MIN
        ? "  <- a live process may STILL be writing here; do not remove anything yet"
        : "";
    lines.push(
      `    newest write ${ago(newestMtimeMs, nowMs)}${stamp === null ? "" : ` (${stamp} Cairo)`}${live}`,
    );
  } else if (compared === 0) {
    // Distinguished from the line below on purpose. "no file mtime could be read" describes a
    // FAILURE, and printing it for a folder that simply holds nothing but build output sends the
    // reader looking for a permissions problem that does not exist.
    lines.push("    no file outside node_modules/.next, so there is no write time worth reporting");
  } else {
    lines.push("    newest write UNKNOWN — no file mtime could be read");
  }

  if (unproven) {
    lines.push(
      "    !! main's tree could not be read, so NOTHING below is proven to be a copy of anything.",
    );
    lines.push("       Treat every file here as potentially the only one.");
  }
  if (!scannedAll) {
    lines.push(
      "    !! the file list hit this run's cap — files beyond it were NOT compared against main.",
    );
  }

  if (rescue.length) {
    lines.push(
      `    !! ${num(rescue.length)} spreadsheet/PDF file(s) that main does not have identically — ` +
        "AGENTS.md 5 forbids deleting these:",
    );
    lines.push(...nameList(rescue, listLimit, "spreadsheet/PDF file(s)"));
  }
  if (differing.length) {
    lines.push(
      `    !! ${num(differing.length)} file(s) DIFFER from what main has — this is content that ` +
        "exists nowhere else:",
    );
    lines.push(...nameList(differing, listLimit, "differing file(s)"));
  }
  if (untracked.length) {
    lines.push(
      `    !! ${num(untracked.length)} file(s) are on NO branch at all (untracked, not gitignored):`,
    );
    lines.push(...nameList(untracked, listLimit, "untracked file(s)"));
  }
  if (unknown.length) {
    lines.push(
      `    !! ${num(unknown.length)} file(s) could NOT be hashed, so they are not proven to be copies:`,
    );
    lines.push(...nameList(unknown, listLimit, "unhashable file(s)"));
  }

  if (matching > 0) {
    lines.push(
      `       ${num(matching)} file(s) match main byte for byte — leftover checkout, nothing at risk there`,
    );
  }
  if (ignored > 0) {
    lines.push(
      `       ${num(ignored)} gitignored file(s) (env copies, caches) — not compared against main`,
    );
  }

  if (severity === "alarm") {
    lines.push(
      "    -> archive this BEFORE anything removes it. Copy the named files into a real checkout",
    );
    lines.push("       and commit them from there. Do NOT run git inside this folder:");
    if (dir !== null) lines.push(`         git -C "${dir}" ...   # <- WRONG, see below`);
    lines.push(
      "       a folder git does not account for resolves against the PRIMARY checkout, so a commit",
    );
    lines.push("       made inside it lands on main's own branch, silently (AGENTS.md 2.1).");
  } else if (compared === 0) {
    // NOT "every file here is byte-identical to main". Zero files were compared, so that sentence
    // would be reporting a verification that never ran — AGENTS.md rule 1's expensive kind of
    // wrong, and the exact reading that let a folder holding 861 unsaved lines pass for healthy.
    lines.push(
      `    -> nothing here was comparable: all ${num(totalFiles)} file(s) sit inside ` +
        "node_modules/.next, i.e. regenerable build output.",
    );
    lines.push(
      "       Still never auto-deleted — --fix removes only proven ZERO-file husks, and this is not one.",
    );
  } else {
    // Spelled out from the counts rather than asserted as one sentence: a gitignored file is not
    // "byte-identical to main" — main does not have it at all — so a folder holding matches AND
    // env copies needs both halves said, or the claim overstates what was checked.
    const parts = [];
    if (matching > 0) parts.push(`${num(matching)} match main byte for byte`);
    if (ignored > 0) parts.push(`${num(ignored)} are gitignored copies (env files, caches)`);
    lines.push(`    -> nothing here is at risk: ${parts.join(", ")}.`);
    lines.push(
      "       Still never auto-deleted — --fix removes only proven ZERO-file husks, and this is not one.",
    );
  }

  return {
    orphaned: true,
    state: "orphaned",
    severity,
    differing,
    untracked,
    rescue,
    unknown,
    matching,
    ignored,
    lines,
  };
}

/**
 * The whole section, heading included, from the verdicts of every candidate folder.
 *
 * Returns [] when nothing is orphaned, so the caller prints no heading at all — the same shape the
 * NEEDS REVIEW block this replaces had, and the reason a normal run is unchanged: on a healthy
 * machine every candidate is registered or a husk and this section does not exist.
 */
export function orphanedFolderLines(verdicts) {
  const orphans = verdicts.filter((v) => v.orphaned);
  if (orphans.length === 0) return [];

  const alarming = orphans.filter((v) => v.severity === "alarm").length;
  const lines = [
    `ORPHANED FOLDERS (no worktree registration, but NOT empty — never auto-deleted): ${orphans.length}`,
  ];
  for (const v of orphans) lines.push(...v.lines);
  lines.push(
    alarming > 0
      ? `  ${num(alarming)} of these may hold the only copy of real work. Inspect them by hand before anything else.`
      : "  Inspect these by hand. An orphaned worktree has held the only copy of real work before.",
  );
  return lines;
}
