import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    if (indexText.includes("](" + file + ")")) {
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
        " memory file(s) are reachable from AGENTS.md rather than the index — relocated on purpose",
      "  (AGENTS.md 2.2). Do NOT give these an index line: that would undo the relocation and put",
      "  MEMORY.md back over budget.",
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

/** Backticked slugs in a chunk of text — the same convention `namedInAgents` matches. */
function slugsIn(text) {
  const tick = String.fromCharCode(96);
  const pattern = new RegExp(tick + "([a-z0-9]+(?:-[a-z0-9]+){2,})" + tick, "g");
  return new Set([...text.matchAll(pattern)].map((m) => m[1]));
}

function main() {
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

  const INDEX_FILES = ["MEMORY.md", "MEMORY-ARCHIVE.md"];
  const indexText = INDEX_FILES.map((f) => readTextOr(join(memoryDir, f))).join("\n");
  const files = readdirSync(memoryDir).filter(
    (f) => f.endsWith(".md") && !INDEX_FILES.includes(f) && !f.includes(".bak"),
  );
  const agentsText = readTextOr(join(root, "AGENTS.md"));
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

  // Two ways a marker goes stale, with opposite severities, so never print them as one list. DEAD
  // is a defect — the map points at a memory that no longer exists, and the test's by-name check
  // then guards a slug for nothing. OVER-MARKED is not: an index also links the memory, so the
  // marker merely over-claims and nothing can be stranded by removing it.
  const dead = [...marked].filter((s) => !present.has(s)).sort();
  const overMarked = [...marked].filter((s) => present.has(s) && !live.has(s)).sort();

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
  for (const slug of overMarked) {
    console.log("    over-marked  " + slug + "  (an index links it too, so the marker over-claims — not a risk)");
  }
  if (mapText !== "" && unmarked.length === 0 && dead.length === 0 && overMarked.length === 0) {
    console.log("    -> in step. Every AGENTS.md-only memory is marked, and every marker is still true.");
  }
}

// The import stays inert: repo-doctor and the test load the exports above without any of this
// running. `pathToFileURL` rather than a path compare, because argv[1] and import.meta.url disagree
// on slash and drive-letter case on Windows.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
