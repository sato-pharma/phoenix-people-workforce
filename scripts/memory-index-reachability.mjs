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
