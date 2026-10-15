import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MEMORY_INDEX_READ_CEILING } from "./memory-index-budget.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "memory-index-reachability",
  entry: import.meta.url,
  known: ["--all"],
});

// A MEMORY FILE NAMED IN `AGENTS.md` IS REACHABLE. THE DOCTOR USED TO CALL IT AN ORPHAN.
//
// WHY THIS EXISTS. The orphan check asks one question — is this file pointed at from `MEMORY.md` or
// `MEMORY-ARCHIVE.md`? — and that question stopped being the whole truth the moment AGENTS.md §2.2
// made relocation the prescribed remedy for an over-budget index. `MEMORY.md` is capped at 22,000
// bytes against a 24,400-byte loader cliff, and when compression runs out §2.2 says to move a hook
// into `AGENTS.md` §2.1 / §2.3 / §4 instead of deleting it. `CLAUDE.md` pulls that file in via
// `@AGENTS.md`, in full, with no cliff — so a hook living there is at least as findable as one
// linked from the index, and strictly more reliable than one sitting past byte 24,400.
//
// THE BUG THIS FIXES IS THE ADVICE, NOT THE COUNT. Reporting six extra orphans would only be noise.
// What made it harmful is the sentence that followed: "give each orphan a line in MEMORY.md if it
// is a live rule". Every relocation therefore produced a report instructing the next session to put
// the lines back — undoing the relocation and pushing the index straight back over budget, with the
// doctor's own authority behind it. Measured 2026-08-29, immediately after six hooks moved out:
// 7 orphans reported, 6 of them freshly relocated on purpose.
//
// WHY BACKTICKS. §2.1 and §4 name a relocated memory by its bare slug in a code span —
// `some-memory-name` — and that convention is universal, not typical: measured across this
// project's 948 memory files, 137 slugs appear backticked in `AGENTS.md` and ZERO appear only in
// bare prose. Matching the backticked form rather than a loose substring is what keeps the match
// exact, so a slug cannot be satisfied by a longer one that merely contains it. (No slug is
// currently a substring of another, so a bare match would happen to work today — which is exactly
// the kind of accident that stops being true without warning.)
//
// THE DANGEROUS DIRECTION IS ONE-WAY, as in `memory-index-budget.mjs`. An unreadable or missing
// `AGENTS.md` yields an empty string, every file falls through to the pre-2026-08-29 answer, and
// genuinely relocated hooks are reported as orphans. That is the safe failure: a false orphan costs
// someone a minute, while a false "reachable" hides a memory nothing can recall.

/**
 * The one place that decides whether an index text points at a memory file. Both the reachability
 * classifier and the marker check below call it, deliberately: they ask different questions of the
 * same relation, and a second hand-inlined copy of this substring is how the two answers would
 * quietly stop agreeing about the same file.
 *
 * @param {string} indexText an index file's contents (or several concatenated)
 * @param {string} file a memory filename, e.g. `some-slug.md`
 */
function indexLinksMemory(indexText, file) {
  return indexText.includes("](" + file + ")");
}

/**
 * Split memory files into the three ways one can be reachable, or not.
 *
 * Linked wins over relocated when a file is both, so the two buckets never double-count and
 * `linked.length + relocated.length + orphans.length` always equals the file count.
 *
 * @param {object} input
 * @param {string[]} input.files memory filenames (`*.md`), indexes and `.bak` copies already excluded
 * @param {string} input.indexText `MEMORY.md` and `MEMORY-ARCHIVE.md` concatenated
 * @param {string} input.agentsText the repo's `AGENTS.md`; empty when it could not be read
 * @returns {{ linked: string[], relocated: string[], orphans: string[] }}
 */
export function classifyMemoryReachability({ files, indexText = "", agentsText = "" }) {
  const linked = [];
  const relocated = [];
  const orphans = [];

  for (const file of files) {
    if (indexLinksMemory(indexText, file)) {
      linked.push(file);
      continue;
    }
    if (namedInAgents(file, agentsText)) {
      relocated.push(file);
      continue;
    }
    orphans.push(file);
  }

  return { linked: linked.sort(), relocated: relocated.sort(), orphans: orphans.sort() };
}

/**
 * Like {@link classifyMemoryReachability}, but for `repo-doctor.mjs`'s REPORTING question rather
 * than `memory-index-reachability.mjs`'s own CLI TRIMMING question — see docs/memory-index-budget.md,
 * "The same trap, fired the other way".
 *
 * A relocated memory is reachable the moment its slug is backticked ANYWHERE a session might load
 * `AGENTS.md` from — which includes `origin/main`, not only the working tree this happens to run
 * in. A checkout can be behind `origin/main` (a merge landed and this disk has not pulled it yet),
 * and reporting that as an ORPHAN is actively wrong: the printed remedy is to add an index line,
 * which would create a SECOND hook for a rule that already shipped.
 *
 * This must NOT be used for a trim decision — deleting a line from `AGENTS.md` has to key on what
 * THIS checkout holds after the edit, never on what a different ref happens to have; `origin/main`
 * having a slug today says nothing about whether the edit in progress is about to remove the only
 * copy that will exist once it merges. `memory-index-reachability.mjs`'s own CLI stays
 * local-only for exactly that reason.
 *
 * @param {object} input
 * @param {string[]} input.files
 * @param {string} input.indexText
 * @param {string} input.agentsText the working tree's `AGENTS.md`; empty when unreadable
 * @param {string} input.originAgentsText `origin/main`'s `AGENTS.md`; empty when unreadable or
 *   unreachable (offline, no remote-tracking ref) — degrades to the local-only answer, never to a
 *   false "reachable"
 * @returns {{ linked: string[], relocated: string[], orphans: string[], rescuedByOrigin: string[] }}
 */
export function classifyMemoryReachabilityAcrossRefs({
  files,
  indexText = "",
  agentsText = "",
  originAgentsText = "",
}) {
  const localOnly = classifyMemoryReachability({ files, indexText, agentsText });
  const combined = classifyMemoryReachability({
    files,
    indexText,
    agentsText: agentsText + "\n" + originAgentsText,
  });
  // Reachable in the union but not locally: the checkout is behind, not the memory. Named
  // separately so the caller can say so rather than folding it into a silent "reachable".
  const rescuedByOrigin = localOnly.orphans.filter((f) => !combined.orphans.includes(f)).sort();
  return { ...combined, rescuedByOrigin };
}

/**
 * Is this memory named in `AGENTS.md` as a backticked slug?
 *
 * @param {string} file a memory filename ending in `.md`
 * @param {string} agentsText
 * @returns {boolean}
 */
export function namedInAgents(file, agentsText) {
  if (!agentsText || !file.endsWith(".md")) return false;
  const backtick = String.fromCharCode(96);
  return agentsText.includes(backtick + file.slice(0, -".md".length) + backtick);
}

/**
 * The lines repo-doctor prints about relocated memories and what to do with a real orphan. Kept
 * beside the classification so the count and the advice cannot drift apart — the drift is what made
 * the original defect harmful rather than merely noisy.
 *
 * @param {{ relocated: string[], orphans: string[], broken: string[] }} input
 * @returns {string[]}
 */
export function memoryReachabilityLines({ relocated, orphans, broken }) {
  const lines = [];

  if (relocated.length > 0) {
    lines.push(
      "  " +
        relocated.length +
        " memory file(s) are reachable from AGENTS.md or its module memory rather than the",
      "  index — filed on purpose (AGENTS.md 2.2; since 2026-10-02 a module's own",
      "  .claude/rules/<module>.md is where the fold files a note).",
      "  Do NOT give these an index line: that would undo the filing and put MEMORY.md back",
      "  over budget.",
    );
  }

  if (orphans.length === 0 && broken.length === 0) {
    lines.push("  -> none. Every memory file is reachable and every pointer resolves.");
    return lines;
  }

  lines.push(
    "  -> " +
      orphans.length +
      " orphan(s), " +
      broken.length +
      " broken pointer(s). Nothing was changed — give each orphan a line in MEMORY.md if it is a",
    "  live rule, MEMORY-ARCHIVE.md if it is depth or history, or relocate it into AGENTS.md",
    "  2.1 / 2.3 / 4 if it is an agent-operating, production or owner rule — that file auto-loads",
    "  in full and has no cliff, so it costs the index nothing.",
  );
  return lines;
}

/**
 * Wrap text to a width, on word boundaries.
 *
 * Not a nicety: the owner's standing rule is that text is NEVER truncated with an ellipsis, and a
 * memory's `description` is the field that decides whether it is recalled at all (§2.2). Trimming
 * one to fit a terminal would cut away the exact half that tells the reader where the hook belongs.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
function wrapAt(text, width) {
  const out = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out.length > 0 ? out : [""];
}

/**
 * The stranded section — the memories nothing points at, BY NAME.
 *
 * WHY THIS EXISTS. Until 2026-09-04 this command printed the stranded COUNT and nothing else, and
 * the gap was found the only way it could be: a real trim, on 2026-09-04, moved the `gh pr merge`
 * hook out of `MEMORY.md` after its AGENTS.md half had merged to `main`. The command answered
 * "1 reachable from neither" — correct, and useless. Which one it was took three greps by hand,
 * and the answer mattered, because the cause was that the checkout loading `AGENTS.md` sat on a
 * branch predating the merge. A count says a memory is unrecallable; only a name says WHICH, and
 * the whole point of §2.2's both-halves rule is to act on that one file before anything else.
 *
 * The `type` and `description` come with it because they are what route the fix: §2.2 sends a live
 * rule to `MEMORY.md`, depth or history to `MEMORY-ARCHIVE.md`, and an agent-operating, production
 * or owner rule into `AGENTS.md` §2.1 / §2.3 / §4.
 *
 * NO SILENT CAP, the same rule `repo-doctor` states at its own list: a truncated list that does not
 * say it was truncated reads as "that is all of them".
 *
 * @param {object} input
 * @param {string[]} input.orphans memory filenames reachable from neither index nor `AGENTS.md`
 * @param {(file: string) => ({ type?: string, description?: string } | undefined)} [input.describe]
 * @param {number} [input.limit] `Infinity` prints every one
 * @returns {string[]}
 */
export function strandedLines({ orphans, describe = () => ({}), limit = 20 }) {
  const lines = ["  STRANDED — no index links these and AGENTS.md does not name them:"];

  if (orphans.length === 0) {
    lines.push("    none — every memory file is reachable.");
    return lines;
  }

  const shown = Number.isFinite(limit) ? orphans.slice(0, limit) : orphans;
  for (const file of shown) {
    const { type = "", description = "" } = describe(file) || {};
    lines.push("    " + file.replace(/\.md$/, "") + (type ? "  (" + type + ")" : ""));
    // A memory with no description is worse off than the others, not better: recall matches on that
    // field, so an empty one cannot be found even after it is re-indexed. Say so rather than
    // printing a blank line that reads like tidy output.
    const detail = description || "(no description — recall cannot match this one even once re-indexed)";
    for (const wrapped of wrapAt(detail, 92)) lines.push("        " + wrapped);
  }

  if (orphans.length > shown.length) {
    lines.push(
      "    ... and " + (orphans.length - shown.length) + " more not listed — re-run with --all for the full list.",
    );
  }

  lines.push(
    "    -> Nothing was changed. Give each a line in MEMORY.md if it is a live rule,",
    "       MEMORY-ARCHIVE.md if it is depth or history, or relocate it into AGENTS.md",
    "       §2.1 / §2.3 / §4 if it is an agent-operating, production or owner rule — that file",
    "       auto-loads in full and has no cliff, so it costs the index nothing.",
  );
  return lines;
}

// ── THE COMMAND ────────────────────────────────────────────────────────────────────
// WHY A CLI WHEN repo-doctor ALREADY PRINTS THIS. `AGENTS.md` §2.2 tells a session to re-run the
// classifier before removing any slug, and the question it actually needs answered is not "how many
// memories are relocated" — it is "would cutting THIS slug strand its memory". `repo:doctor --deep`
// names the relocated files and stops; `tests/memory-index-reachability.test.ts` guards one
// direction only (a slug the MAP marks load-bearing must still be named in `AGENTS.md`). Nothing
// checked the map against LIVE reachability, so a memory that becomes AGENTS.md-only WITHOUT
// gaining its marker is guarded by no test and named in no report — and that is exactly the state
// every relocation passes through before its map row is written.
//
// THE STALE-COUNT LESSON. Until 2026-09-04 §2.2 carried a written count of the load-bearing set
// ("only the 18 load-bearing ones inline"). A count is precisely what goes quietly wrong here: it
// reads as authoritative, it costs nothing to leave alone, and it drifts on every relocation. The
// count is gone from §2.2 and this command is what replaced it, so the number is always measured
// rather than remembered.
//
// READ-ONLY, ALWAYS. It prints. It never writes an index line, a map row, or a memory file.

/** Read a file, or a fallback when it is missing or unreadable. */
function readTextOr(file, fallback = "") {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

/**
 * Module memory (docs/module-memory.md, 2026-10-02): every `.claude/rules/<id>.md` plus the history
 * list. A note named there in backticks is as reachable as one named in AGENTS.md — the module file
 * loads the moment a session works in that module. Missing or unreadable reads as "" (under-claims).
 */
export function readModuleMemoryText(root) {
  let text = readTextOr(join(root, "docs", "module-memory", "history.md"));
  try {
    for (const f of readdirSync(join(root, ".claude", "rules"))) {
      if (f.endsWith(".md")) text += "\n" + readTextOr(join(root, ".claude", "rules", f));
    }
  } catch {
    /* no module memory in this checkout */
  }
  return text;
}

/**
 * The same module-memory text, read from a GIT REF instead of from disk.
 *
 * WHY THIS EXISTS — THE STALENESS RESCUE WAS ASYMMETRIC. `repo-doctor.mjs`'s MEMORY INDEX section
 * deliberately unions the working tree's `AGENTS.md` with `git show origin/main:AGENTS.md` before
 * calling a memory an orphan, because a checkout sitting behind `main` is this repo's normal state
 * and a slug merged minutes ago is absent from the disk for no reason that concerns the memory
 * (the 2026-09-05 incident, and section 9 of the test beside this file). Module memory never got
 * that second chance: `readModuleMemoryText` reads the working tree only, so from 2026-10-02 — when
 * module memory became the PRESCRIBED home for a note — every freshly folded note read as an ORPHAN
 * on any lagging checkout, and the printed remedy ("give each orphan a line in MEMORY.md") is the
 * one thing AGENTS.md section 2.2 forbids: re-adding a module fact to the index.
 *
 * MEASURED 2026-10-08, on the primary at `31d89debe` (17 commits behind): five notes the fold had
 * filed in `#5455` the previous night — `a-failed-push-resurfaces-as-no-commits-between-main-and-branch`,
 * `a-pdf-page-count-from-the-first-count-is-a-subtree`, `period-card-call-tables-use-the-tight-density`,
 * `portal-418-hydration-is-external-dom-rewriting`, `the-crm-departed-exclusion-is-119-ids-not-56` —
 * all reported ORPHAN, all backticked in a `.claude/rules/*.md` on `origin/main`. The fold runs three
 * times a day, so on a lagging checkout the list grows rather than settling.
 *
 * NOT `assignments.json`, deliberately. That file is the filing LEDGER; the rules file is the
 * emitted ARTEFACT, and a note is listed in the ledger before `build.mjs` has written its line into
 * a module file. Keying reachability on the ledger would call a note reachable while no file a
 * session loads actually names it — a fail-OPEN answer, which is the one direction this module
 * never takes. Reachability keeps asking what a loaded file says, at both refs.
 *
 * FAIL-CLOSED, like its neighbour: an unknown ref, a shallow clone with no `origin/main`, no git at
 * all, or a tree with no `.claude/rules` all yield "" — every memory then falls through to the
 * local-only answer, a false ORPHAN and never a false "reachable".
 *
 * @param {string} root the repository root whose git dir the ref is resolved in
 * @param {string} ref e.g. `origin/main`
 * @returns {string} the concatenated module-memory text at that ref, or "" when unreadable
 */
export function readModuleMemoryTextAtRef(root, ref) {
  const show = (pathInRepo) => {
    try {
      return execFileSync("git", ["show", ref + ":" + pathInRepo], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 1 << 28,
      });
    } catch {
      return "";
    }
  };

  let text = show("docs/module-memory/history.md");
  let names = "";
  try {
    names = execFileSync("git", ["ls-tree", "--name-only", ref + ":.claude/rules"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1 << 24,
    });
  } catch {
    return text; // no module memory at that ref — "" plus whatever history.md gave, never a throw
  }
  for (const name of names.split(/\r?\n/)) {
    if (name.endsWith(".md")) text += "\n" + show(".claude/rules/" + name);
  }
  return text;
}

/**
 * EVERYTHING AT `ref` THAT CAN MAKE A MEMORY REACHABLE: `AGENTS.md` plus that ref's module memory.
 *
 * This is the whole of `originAgentsText` for `repo-doctor.mjs`'s MEMORY INDEX section, in ONE
 * place, because the 2026-10-08 defect was precisely that the caller assembled it from one of the
 * two channels. The working-tree side already reads both (`AGENTS.md` + `readModuleMemoryText`), so
 * a second-ref read that covers only `AGENTS.md` is not a smaller rescue — it is a rescue that
 * misses the channel §2.2 now prescribes, and the notes it misses are the NEWEST ones, because the
 * fold files three times a day.
 *
 * Fail-closed throughout: an unresolvable ref gives "", and the caller then falls back to the
 * local-only answer — a false ORPHAN, never a false "reachable".
 *
 * NOT for a trim decision, exactly like `classifyMemoryReachabilityAcrossRefs`: what another ref
 * holds says nothing about whether the edit in progress is about to remove the only copy that will
 * exist once it merges.
 *
 * @param {string} root repository root whose git dir resolves the ref
 * @param {string} ref e.g. `origin/main`
 * @returns {string}
 */
export function readReachabilityTextAtRef(root, ref) {
  let agents = "";
  try {
    agents = execFileSync("git", ["show", ref + ":AGENTS.md"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1 << 28,
    });
  } catch {
    // Unresolvable ref or no AGENTS.md there — under-claim, never throw.
  }
  return agents + "\n" + readModuleMemoryTextAtRef(root, ref);
}

/**
 * The PRIMARY checkout's root, never the worktree this happens to run in.
 *
 * Memory belongs to the project, and §2.2's both-halves rule keys on the merged file: a hook
 * written on an unmerged branch SHOULD still read as an orphan here. Reading the worktree's
 * `AGENTS.md` would certify a relocation that no session can yet see.
 */
function primaryRootOrNull() {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return commonDir ? resolve(dirname(commonDir)) : null;
  } catch {
    return null;
  }
}

/**
 * This checkout's session memory directory, or null when there is none.
 *
 * Same lookup as `scripts/repo-doctor.mjs`: `<config>/projects/<slug>/memory`, where the slug is
 * the absolute project path with every non-alphanumeric character replaced by a hyphen. Returning
 * null rather than guessing keeps this quiet in CI and on machines with no memory directory.
 */
function memoryDirOrNull(projectRoot) {
  const configRoot = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const dir = join(configRoot, "projects", resolve(projectRoot).replace(/[^A-Za-z0-9]/g, "-"), "memory");
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * A memory's `type` and `description` from its frontmatter, or empty strings when it has none.
 *
 * Called only for the stranded files that actually get printed — never across the whole directory.
 * When `AGENTS.md` cannot be read every memory falls through to stranded (the deliberate one-way
 * failure above), and reading 900-odd files to describe a report nobody asked for would turn a
 * degraded read into a slow one.
 *
 * @param {string} dir
 * @param {string} file
 * @returns {{ type: string, description: string }}
 */
function frontmatterOf(dir, file) {
  const text = readTextOr(join(dir, file));
  const close = text.indexOf("\n---", 3);
  // Anything that is not a frontmatter block yields "" for both, and the caller says so out loud.
  const head = text.startsWith("---") && close !== -1 ? text.slice(3, close) : "";
  const grab = (key) => head.match(new RegExp("^[ \\t]*" + key + ":[ \\t]*(.+)$", "m"))?.[1].trim() ?? "";
  return { type: grab("type"), description: grab("description") };
}

/** Backticked slugs in a chunk of text — the same convention `namedInAgents` matches. */
/**
 * WHAT THE LOADER ACTUALLY SEES OF `MEMORY.md`, WHICH IS NOT THE WHOLE FILE.
 *
 * The index is auto-loaded up to `MEMORY_INDEX_READ_CEILING` bytes and truncated there **silently**
 * (§2.2). So "does `MEMORY.md` link this memory?" and "will a session SEE that link?" are the same
 * question only while the file is under the cliff. Past it, a link sitting in the tail is invisible
 * to every session, and reading the whole file would classify it `recallable` — the CLI would then
 * call the marker a harmless over-claim and invite a session to delete the last pointer anybody
 * loads. That is the same failure as the archive-only case below, one level down, and it bites in
 * exactly the situation this tool exists for: an index over budget, being trimmed.
 *
 * Truncation is done in BYTES, against the same ceiling the loader uses, so the prefix is faithful.
 * A link straddling the boundary is half-present here and half-present there, and counts in neither.
 * A multibyte character split at the boundary decodes to U+FFFD, which cannot complete a link match.
 *
 * @param {string} text the full index file
 * @param {number} [ceilingBytes] the loader's read ceiling
 * @returns {{ text: string, bytes: number, truncated: boolean }} `text` is the visible prefix;
 *   `bytes` is the FULL size, so a caller can report how much is invisible
 */
export function loaderVisiblePrefix(text = "", ceilingBytes = MEMORY_INDEX_READ_CEILING) {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= ceilingBytes) return { text, bytes: buf.byteLength, truncated: false };
  return {
    text: buf.subarray(0, ceilingBytes).toString("utf8"),
    bytes: buf.byteLength,
    truncated: true,
  };
}

/**
 * AN ARCHIVE-ONLY LINK DOES NOT MAKE A MARKER SAFE TO REMOVE.
 *
 * The orphan question above counts `MEMORY-ARCHIVE.md` as a pointer on purpose, and that is right
 * for the question it asks: the archive advertises grep-findability, and a memory linked from it is
 * not stranded. The MARKER question is a different one — "is it safe to cut this slug from
 * `AGENTS.md`?" — and there the two index files are not interchangeable. §2.2: **`MEMORY.md` is the
 * ONLY auto-loaded memory file**, and `docs/agents-memory-map.md` states the marker rule in those
 * exact terms — a slug removed from `AGENTS.md` orphans that memory *unless `MEMORY.md` also links
 * it*. Cut a slug whose only index link is in the archive and nothing is stranded, but the rule
 * leaves every session's context: it survives only for whoever thinks to open a file that never
 * loads. That is precisely the invisibility the marker exists to prevent, so the marker is CORRECT
 * and must stay.
 *
 * Measured 2026-09-21, which is why this exists: three marked slugs
 * (`ats-candidate-children-one-has-no-fk-and-one-is-a-view`,
 * `offer-chain-was-live-in-the-registry-with-a-hole-past-approval`,
 * `owner-sheet-vocabulary-stores-is-office-upa-is-a-channel`) have ZERO matches in `MEMORY.md` and
 * appear only in `MEMORY-ARCHIVE.md`. The CLI printed all three as "an index links it too, so the
 * marker over-claims — not a risk", which is an invitation to delete the last auto-loaded pointer
 * to three live rules. The reassurance was the defect, not the markers.
 *
 * THE DEGRADE DIRECTION IS THE SAFE ONE, as everywhere else in this file. An unreadable `MEMORY.md`
 * arrives here as `""`, which puts every over-marked slug in `archiveOnly` — "keep the marker". A
 * marker kept for nothing costs a reader a line; a marker dropped on a bad reassurance costs a live
 * rule its only auto-loaded pointer.
 *
 * @param {object} input
 * @param {string[]} input.overMarked marked slugs that an index links, so not AGENTS.md-only
 * @param {string} input.autoLoadedIndexText `MEMORY.md` ALONE — never the archive concatenated in
 * @returns {{ recallable: string[], archiveOnly: string[] }} `recallable` over-claims harmlessly;
 *   `archiveOnly` is a marker that is still load-bearing and must not be trimmed
 */
export function splitOverMarkedByAutoLoadedIndex({ overMarked = [], autoLoadedIndexText = "" }) {
  const recallable = [];
  const archiveOnly = [];
  for (const slug of overMarked) {
    if (indexLinksMemory(autoLoadedIndexText, slug + ".md")) recallable.push(slug);
    else archiveOnly.push(slug);
  }
  return { recallable: recallable.sort(), archiveOnly: archiveOnly.sort() };
}

function slugsIn(text) {
  const tick = String.fromCharCode(96);
  const pattern = new RegExp(tick + "([a-z0-9]+(?:-[a-z0-9]+){2,})" + tick, "g");
  return new Set([...text.matchAll(pattern)].map((m) => m[1]));
}

function main() {
  // Read-only either way. `--all` only lifts the printed cap on the stranded list; there is no flag
  // that writes an index line, a map row or a memory file, and there must never be one.
  const printAll = process.argv.slice(2).includes("--all");
  const root = primaryRootOrNull();
  if (root === null) {
    console.error("memory-index-reachability: not inside a git repository.");
    process.exit(1);
  }

  const memoryDir = memoryDirOrNull(root);
  if (memoryDir === null) {
    console.log("SKIPPED — this checkout has no session memory directory.");
    console.log(
      "Expected " +
        join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects", "<slug>", "memory"),
    );
    return;
  }

  // Both files answer "is this memory stranded" (the archive's contract is grep-findability, and a
  // file linked from it is findable). Only `MEMORY.md` answers "will a session SEE this without
  // being told to look" — §2.2: it is the only auto-loaded memory file. The marker check below needs
  // that narrower text on its own, so keep the two readable separately and never let the
  // concatenation stand in for the auto-loaded one.
  const AUTO_LOADED_INDEX = "MEMORY.md";
  const INDEX_FILES = [AUTO_LOADED_INDEX, "MEMORY-ARCHIVE.md"];
  // Only the prefix the loader actually reads counts as "a session will see this" — see
  // loaderVisiblePrefix. The FULL text still feeds the stranding question below: a link past the
  // cliff is invisible in context but perfectly greppable, exactly like an archive link, so it is
  // reachability without recall rather than a stranded memory.
  const autoLoaded = loaderVisiblePrefix(readTextOr(join(memoryDir, AUTO_LOADED_INDEX)));
  const autoLoadedIndexText = autoLoaded.text;
  const indexText = INDEX_FILES.map((f) => readTextOr(join(memoryDir, f))).join("\n");
  const files = readdirSync(memoryDir).filter(
    (f) => f.endsWith(".md") && !INDEX_FILES.includes(f) && !f.includes(".bak"),
  );
  // LOCAL ONLY, deliberately — this CLI answers "is it safe to trim a line from THIS checkout's
  // AGENTS.md", and that question must key on what this checkout holds, never on what merged
  // elsewhere (see primaryRootOrNull above, and "Merged is not the condition" in
  // docs/memory-index-budget.md). `repo-doctor.mjs`'s own MEMORY INDEX section asks a different
  // question — "has this memory been relocated anywhere a session might load it from" — and for
  // THAT question it additionally unions in `git show origin/main:AGENTS.md` before calling this
  // same classifier. Do not import that union here: it would tell someone mid-trim that a slug is
  // still safe to delete because origin/main has it, which says nothing about whether their own
  // edit is about to remove the only copy that matters once it merges.
  const agentsText = readTextOr(join(root, "AGENTS.md")) + "\n" + readModuleMemoryText(root);
  const { linked, relocated, orphans } = classifyMemoryReachability({ files, indexText, agentsText });

  // The map is §2.2's authority on which memories AGENTS.md is the ONLY pointer for. Compare it
  // against what is true right now, in BOTH directions — a marker is every bit as capable of going
  // stale as the count it replaced.
  const mapPath = "docs/agents-memory-map.md";
  const mapText = readTextOr(join(root, mapPath));
  const marked = new Set();
  for (const line of mapText.split(/\r?\n/)) {
    if (!/inline\s*[—-]\s*load-bearing/.test(line)) continue;
    for (const slug of slugsIn(line)) marked.add(slug);
  }

  const relocatedSlugs = relocated.map((f) => f.slice(0, -".md".length)).sort();
  const live = new Set(relocatedSlugs);
  const present = new Set(files.map((f) => f.slice(0, -".md".length)));
  const unmarked = relocatedSlugs.filter((s) => !marked.has(s));

  // THREE ways a marker can be out of step, with different severities, so never print them as one
  // list. DEAD is a defect — the map points at a memory that no longer exists, and the test's
  // by-name check then guards a slug for nothing. The other two both look like "an index links it
  // too", and they are not the same finding: only a link from the AUTO-LOADED index makes the marker
  // a harmless over-claim. An archive-only link leaves the AGENTS.md slug as the last pointer any
  // session actually loads, so that marker is still load-bearing — see
  // splitOverMarkedByAutoLoadedIndex, and the three real slugs that occasioned it.
  const dead = [...marked].filter((s) => !present.has(s)).sort();
  const overMarked = [...marked].filter((s) => present.has(s) && !live.has(s)).sort();
  const { recallable: overMarkedRecallable, archiveOnly: overMarkedArchiveOnly } =
    splitOverMarkedByAutoLoadedIndex({ overMarked, autoLoadedIndexText });

  console.log("MEMORY REACHABILITY (which memories AGENTS.md is the only pointer for)");
  console.log("  repo:   " + root);
  console.log("  memory: " + memoryDir);
  console.log(
    "  " +
      files.length +
      " memory files — " +
      linked.length +
      " linked from an index, " +
      relocated.length +
      " reachable only via AGENTS.md, " +
      orphans.length +
      " reachable from neither",
  );
  if (agentsText === "") {
    console.log("  WARNING: AGENTS.md could not be read, so every memory falls through to orphan.");
  }
  if (autoLoaded.truncated) {
    console.log(
      "  🔴 " +
        AUTO_LOADED_INDEX +
        " is " +
        autoLoaded.bytes +
        " bytes, OVER the " +
        MEMORY_INDEX_READ_CEILING +
        "-byte loader cliff — its last " +
        (autoLoaded.bytes - MEMORY_INDEX_READ_CEILING) +
        " bytes are invisible to every session.",
    );
    console.log("  Marker verdicts below are graded against the VISIBLE prefix only, which is the");
    console.log("  whole point: a link past the cliff cannot make a marker safe to trim.");
  }
  console.log("");

  // Stranded comes FIRST because it is the worse condition. An UNMARKED slug below is a missing
  // guard against a future mistake; a stranded memory is that mistake already made — the file is
  // on disk and nothing can recall it.
  for (const line of strandedLines({
    orphans,
    describe: (file) => frontmatterOf(memoryDir, file),
    limit: printAll ? Infinity : 20,
  })) {
    console.log(line);
  }
  console.log("");

  console.log("  LOAD-BEARING — cutting one of these slugs from AGENTS.md strands its memory:");
  if (relocatedSlugs.length === 0) console.log("    none — every memory is linked from an index.");
  for (const slug of relocatedSlugs) {
    console.log("    " + (marked.has(slug) ? "ok      " : "UNMARKED") + "  " + slug);
  }
  console.log("");

  console.log('  vs ' + mapPath + " (" + marked.size + ' rows marked "(inline — load-bearing)"):');
  if (mapText === "") {
    console.log("    the map could not be read — the comparison below says nothing. Fix that first.");
  }
  if (unmarked.length > 0) {
    console.log(
      "    " + unmarked.length + " UNMARKED above: reachable only via AGENTS.md but carrying no map row, so",
    );
    console.log("    tests/memory-index-reachability.test.ts does NOT guard them. Add the row, or give the");
    console.log("    memory an index line — §2.2, both halves or neither.");
  }
  for (const slug of dead) {
    console.log("    DEAD    " + slug + "  (marked load-bearing, but no such memory file exists)");
  }
  for (const slug of overMarkedRecallable) {
    console.log(
      "    over-marked  " + slug + "  (" + AUTO_LOADED_INDEX + " links it too, so the marker over-claims — not a risk)",
    );
  }
  if (overMarkedArchiveOnly.length > 0) {
    console.log(
      "    " +
        overMarkedArchiveOnly.length +
        " marked slug(s) an index links, but only MEMORY-ARCHIVE.md — which does NOT auto-load (§2.2),",
    );
    console.log("    so the AGENTS.md slug is the last pointer a session sees. KEEP THE MARKER; do not trim:");
    for (const slug of overMarkedArchiveOnly) {
      console.log("      keep    " + slug);
    }
    if (autoLoadedIndexText === "") {
      console.log(
        "    NOTE: " + AUTO_LOADED_INDEX + " could not be read, so every one of these is listed on the safe",
      );
      console.log("    side rather than measured. Fix that before acting on the list.");
    }
  }
  if (mapText !== "" && unmarked.length === 0 && dead.length === 0 && overMarkedRecallable.length === 0) {
    console.log("    -> in step. Every AGENTS.md-only memory is marked, and every marker is still true.");
  }
}

// The import stays inert: repo-doctor and the test load the exports above without any of this
// running. `pathToFileURL` rather than a path compare, because argv[1] and import.meta.url disagree
// on slash and drive-letter case on Windows.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
