// THE MEMORY INDEX HAS A HARD CLIFF AND A SOFT BUDGET, AND THE GAP BETWEEN THEM IS THE POINT.
//
// The cliff belongs to the loader. `MEMORY.md` is the only memory file that auto-loads, and it is
// truncated at 24,400 bytes SILENTLY — no error, no marker, no ellipsis. The tail simply stops
// existing, so a hook can be present in the file and absent from every session that reads it. That
// is not a tidiness problem; it is a correctness one, and it has already eaten real hooks twice.
//
// `repo-doctor.mjs` used to warn only ONCE OVER that line. That is too late by construction: by the
// time it fires, sessions have been loading a partial index for however long it took someone to
// run the doctor. An alarm that can only tell you about damage already done is not a gate.
//
// WHY A BUDGET AND NOT JUST A CEILING. The index is append-only in practice — every session adds a
// hook, almost none retires one. Measured 2026-08-28: two parallel sessions added 567 bytes in the
// 40 minutes between one trim finishing and the next check, which is why "sitting just under the
// ceiling" is not a state you get to hold. A trim that lands on 335 bytes of headroom is undone by
// the next append, and the two lines that landed that day were 330 and 235 bytes — each one on its
// own larger than the headroom that had just been bought.
//
// WHY 22,000. The gap is 2,400 bytes, which is about ten hooks at the file's own average — ~230
// bytes across 101 hook lines, stable across every measurement so far. Ten hooks is enough slack
// that several parallel sessions can append before anyone has to act, which is the difference
// between a budget and a fire alarm. It also sits well clear of the structural floor — roughly
// 13,000 bytes of hooks that genuinely have to exist — so the budget constrains growth without
// asking anyone to gut the index chasing a smaller number.
//
// THE ARITHMETIC IS DELIBERATELY ONE-WAY. An unreadable or missing file reports `unknown`, never
// `ok`. A size check that answers "fine" when it could not measure is how the cliff gets crossed
// while the doctor prints a clean bill.
export const MEMORY_INDEX_READ_CEILING = 24_400;
export const MEMORY_INDEX_BUDGET = 22_000;

/**
 * Grade the memory index against its budget and the loader's read ceiling.
 *
 * @param {number} bytes size of MEMORY.md on disk, in bytes
 * @returns {{
 *   status: "unknown" | "ok" | "over_budget" | "over_ceiling",
 *   bytes: number, budget: number, ceiling: number,
 *   headroomToBudget: number, headroomToCeiling: number, mustFree: number,
 * }}
 */
export function assessMemoryIndexSize(bytes) {
  const base = {
    bytes: Number.isFinite(bytes) ? bytes : 0,
    budget: MEMORY_INDEX_BUDGET,
    ceiling: MEMORY_INDEX_READ_CEILING,
  };

  // Not a measurement. `fs.statSync` throwing, a missing file, or a nonsense value all land here,
  // and none of them are evidence the index is healthy.
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ...base, status: "unknown", headroomToBudget: 0, headroomToCeiling: 0, mustFree: 0 };
  }

  const headroomToBudget = MEMORY_INDEX_BUDGET - bytes;
  const headroomToCeiling = MEMORY_INDEX_READ_CEILING - bytes;
  // What it would take to get back inside the budget. Zero when already inside, so a caller can
  // print it unconditionally without special-casing the healthy path.
  const mustFree = Math.max(0, bytes - MEMORY_INDEX_BUDGET);

  const status =
    bytes > MEMORY_INDEX_READ_CEILING ? "over_ceiling" : bytes > MEMORY_INDEX_BUDGET ? "over_budget" : "ok";

  return { ...base, status, headroomToBudget, headroomToCeiling, mustFree };
}

/**
 * The lines repo-doctor prints for the index size. Kept here with the arithmetic so the number and
 * the sentence describing it cannot drift apart — a report that says "healthy" beside a figure over
 * the cliff is worse than no report.
 *
 * @param {ReturnType<typeof assessMemoryIndexSize>} verdict
 * @returns {string[]}
 */
export function memoryIndexBudgetLines(verdict) {
  const kb = (n) => (n / 1024).toFixed(1) + "KB";

  if (verdict.status === "unknown") {
    return ["  MEMORY.md could not be measured — treat the index as UNKNOWN, not as healthy."];
  }

  const scale = `MEMORY.md ${kb(verdict.bytes)} — budget ${kb(verdict.budget)}, loader cliff ${kb(verdict.ceiling)}`;

  if (verdict.status === "over_ceiling") {
    return [
      "  " + scale,
      `  OVER THE CLIFF — the last ${verdict.bytes - verdict.ceiling} bytes are already invisible to every`,
      "  session. Hooks are being dropped silently right now. Free bytes before trusting the index.",
    ];
  }

  if (verdict.status === "over_budget") {
    return [
      "  " + scale,
      `  OVER BUDGET — free ${verdict.mustFree} bytes. Only ${verdict.headroomToCeiling} left before the loader`,
      "  starts dropping the tail silently. Retire a resolved hook, or relocate one to AGENTS.md and",
      "  its ACCOUNT to docs/ — AGENTS.md has no cliff of its own but is inside the footprint budget.",
      "  Do not add a new line until this is back inside budget (AGENTS.md 2.2).",
    ];
  }

  return ["  " + scale + ` — ${verdict.headroomToBudget} bytes of budget left`];
}

// ─── THE WHOLE AUTO-LOADED FOOTPRINT ──────────────────────────────────────────────────────────────
//
// THE INDEX BUDGET ABOVE POLICED THE WRONG FILE, ALONE. `MEMORY.md` is capped at 22,000 bytes and a
// SessionStart hook enforces it. `AGENTS.md` had no budget at all — and AGENTS.md 2.2 prescribes it
// as the RELIEF VALVE for an over-budget index, on the stated grounds that it "auto-loads in full
// and has no cliff". Both files load into the same context window, so a relocation frees nothing.
// It moves the bytes past the only counter that was watching them.
//
// WHAT THAT COST, MEASURED. `AGENTS.md` went 32,243 bytes on 2026-08-19 to 146,898 on 2026-08-29 —
// 4.6x in ten days, +54KB on one day. Section 2.1 alone reached 57,982, and every byte of it was
// re-sent on every single request, because `CLAUDE.md` pulls the file in via `@AGENTS.md` in full.
// That is roughly 15,000 tokens of fixed occupancy taken out of the working space the conversation
// had left, and compaction fired proportionally sooner. #2620 moved 2.1's detail into
// `docs/agents-session-traps.md` and brought the total 176,363 -> 139,898. This budget is what keeps
// it there; without one the same growth resumes, and nothing reports it until sessions feel slow.
//
// THERE IS DELIBERATELY NO CLIFF HERE, AND INVENTING ONE WOULD BE A LIE. The index's 24,400 is a
// real loader limit: cross it and bytes genuinely stop existing. The constraint on the total is the
// model's context window — soft, model-dependent, and shared with tool output and the conversation
// itself. So this grades against a budget only. A caller must not print a "ceiling" for the
// footprint, because there is no number to honestly put there.
//
// WHY 150,000. A judgement, not a measurement, and worth saying so. It leaves ~10KB of slack over
// the post-#2620 total — about 40 hooks at AGENTS.md's own ~230-byte average — which is enough that
// several parallel sessions can append before anyone must act. Same "budget, not fire alarm"
// reasoning as the 2,400-byte index gap, scaled to a file whose entries are larger.
//
// THE REMEDY IS NOT THE INDEX'S REMEDY. When the INDEX is over, the answer is to relocate a hook
// into `AGENTS.md`, and that is still right — it buys scannability at no cost to the index. When the
// TOTAL is over, relocation buys nothing at all, because both files are already inside the number.
// The only thing that helps is moving detail OUT of the auto-loaded set into `docs/`, read on
// demand. Any caller that prints this verdict must say so, or a session will do the very thing that
// caused the problem while believing it is following the rule.
export const AUTOLOAD_FOOTPRINT_BUDGET = 150_000;

/**
 * The share of the budget the REPOSITORY's own auto-loaded files may occupy, and the only half of
 * this arithmetic a required check can enforce.
 *
 * `MEMORY.md` lives under `~/.claude` where CI cannot see it, so the gate in
 * `tests/autoload-footprint-budget.test.ts` grades `CLAUDE.md + AGENTS.md` against what remains once
 * the index is allowed its FULL cliff — not once it is allowed whatever it happens to weigh today.
 *
 * REPORTING ONLY THE TOTAL IS WHAT MISLED A SESSION INTO SHIPPING `main` RED (2026-09-09). It read
 * the total's slack, which credits the repository with the index's UNUSED headroom, and concluded a
 * ~900-byte hook fitted. It did not: the two figures disagreed by ~3,300 bytes, and the gate is the
 * smaller one. Both numbers are correct answers to different questions, and the banner was answering
 * the question nobody is graded on — so a caller that prints the total must print this beside it.
 */
export const AUTOLOAD_REPO_SHARE = AUTOLOAD_FOOTPRINT_BUDGET - MEMORY_INDEX_READ_CEILING;

/**
 * Bytes of an auto-loaded file with CRLF collapsed to LF, so the figure is a property of the
 * CONTENT rather than of the checkout that measured it.
 *
 * FOR THE CI GATE ONLY, and the split is deliberate. A reporter — the SessionStart hook,
 * repo-doctor — should say what this machine actually loads, so it measures raw bytes on disk. A
 * gate is answering a different question, "is this commit inside budget", and that answer must not
 * depend on whose checkout ran it.
 *
 * THIS IS NOT HYPOTHETICAL — a CRLF copy was live on this machine while the code was being written.
 * Measured 2026-08-29 in node, counting bytes 13/10 on a Buffer so no shell or encoding layer is in
 * the path: `.claude/worktrees/eloquent-moser-9c576c/CLAUDE.md` was 6,924 bytes with 106 CRLF pairs
 * against a 6,818-byte blob, while the primary checkout and this worktree both read 6,818 with zero
 * CR. `git status --porcelain -- CLAUDE.md` on that copy is EMPTY.
 *
 * `.gitattributes` pinning `* text=auto eol=lf` is what makes it invisible rather than what
 * prevents it. That governs what git WRITES on checkout; it does not govern what a local tool
 * writes afterwards, and the same rule normalises on READ before comparing — so the file reports
 * clean forever. The tell that it is a writer and not a checkout: it is selective. Three tracked
 * files in that worktree carry CR while `AGENTS.md` beside them is clean at 101,859/CR=0.
 *
 * Ungated, the gate would score ~1 byte per line it is not judging — ~1,100 on AGENTS.md alone, a
 * number that moves while the content does not.
 *
 * Counted byte-wise rather than via a string replace so a 112KB file is not re-encoded to measure
 * it, and so a LONE CR (a genuine byte) still counts. Raised by the parallel session cutting
 * AGENTS.md §2.2; this session first dismissed it as an MSYS artifact — MSYS `grep -c $'\r'` really
 * does report a match on every line of a pure-LF file — and was wrong. The shell reading was
 * garbage AND the CRLF copy was real.
 *
 * @param {Buffer | Uint8Array | string} contents the file as read from disk
 * @returns {number} bytes, with the CR of each CRLF pair discounted
 */
export function autoloadedFileBytes(contents) {
  const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
  let total = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue; // the CR of a CRLF pair
    total += 1;
  }
  return total;
}

/**
 * Grade the total bytes auto-loaded into every request against the footprint budget.
 *
 * Takes the parts rather than a total so the report can name WHERE the bytes are — a number with no
 * breakdown tells a session it is over without telling it what to move.
 *
 * THIS ANNOTATION IS THE DECLARED TYPE, not a comment. It OVERRIDES inference, so a field added to
 * the returned object and not added here does not exist as far as every TypeScript caller is
 * concerned — which is a compile error at the call site and no error at all here. That is exactly
 * how the repo-share fields first shipped: the runtime returned them, the JSDoc did not, and only
 * the `typecheck` job could see it, because the test runner strips types rather than checking them.
 *
 * @param {Array<{ label: string, bytes: number | null, inRepo?: boolean }>} parts one entry per
 *   auto-loaded file; a non-positive or non-finite `bytes` means present-but-unmeasurable and
 *   poisons the verdict, and `inRepo` marks the half a required check can enforce
 * @returns {{
 *   status: "not_applicable" | "unknown" | "ok" | "over_budget",
 *   bytes: number, budget: number, headroomToBudget: number, mustFree: number,
 *   parts: Array<{ label: string, bytes: number | null, inRepo?: boolean }>, unmeasured: string[],
 *   repoStatus: "not_applicable" | "unknown" | "ok" | "over",
 *   repoShare: number, repoBytes: number, repoHeadroom: number, repoMustFree: number,
 * }}
 */
export function assessAutoloadFootprint(parts) {
  const list = Array.isArray(parts) ? parts : [];
  // The repo-share fields sit on `base` so EVERY branch carries them. Not a typing convenience: a
  // union where `repoStatus` exists on only the healthy branch is one a caller cannot read without
  // narrowing first, and the natural way out of that is to stop reading it — which is how the
  // enforced figure would quietly go back to not being reported. Defaults are the unknown shape, so
  // a branch that never computes the share cannot present as having one.
  const base = {
    budget: AUTOLOAD_FOOTPRINT_BUDGET,
    parts: list,
    repoShare: AUTOLOAD_REPO_SHARE,
    repoStatus: "unknown",
    repoBytes: 0,
    repoHeadroom: 0,
    repoMustFree: 0,
  };

  // NOTHING TO GRADE is not the same as a failed measurement. A checkout with no auto-loaded
  // instruction files (a fresh clone, someone else's machine) should say nothing at all, exactly as
  // the hook already stays silent when there is no memory directory. Reporting "unknown" there
  // would cry wolf on every such session and train the reader to skip the line that matters.
  if (list.length === 0) {
    return {
      ...base,
      status: "not_applicable",
      bytes: 0,
      headroomToBudget: 0,
      mustFree: 0,
      unmeasured: [],
      repoStatus: "not_applicable",
    };
  }

  const unmeasured = list.filter((p) => !Number.isFinite(p.bytes) || p.bytes <= 0).map((p) => p.label);
  const bytes = list.reduce((sum, p) => sum + (Number.isFinite(p.bytes) && p.bytes > 0 ? p.bytes : 0), 0);

  // ONE-WAY, as above. A file we know is loaded but could not size makes the TOTAL unknowable, and a
  // partial sum graded "ok" is how the real figure drifts while the report reads clean.
  if (unmeasured.length > 0) {
    return { ...base, status: "unknown", bytes, headroomToBudget: 0, mustFree: 0, unmeasured };
  }

  // THE ENFORCED HALF. Graded separately and REFUSING TO GUESS which files are the repository's:
  // a caller marks each part `inRepo`, and one part without an explicit boolean makes the repo share
  // UNKNOWN rather than a plausible number. The failure direction is why. An unmarked repo file
  // would be left OUT of the sum, so the margin would read LARGER than the gate allows — silent
  // optimism, in the one figure a session consults before deciding an append is safe. Loud and
  // unknown is the same discipline `unmeasured` already applies to the total.
  const unlabelled = list.some((p) => typeof p.inRepo !== "boolean");
  const repoBytes = list.reduce((sum, p) => sum + (p.inRepo === true ? p.bytes : 0), 0);

  return {
    ...base,
    status: bytes > AUTOLOAD_FOOTPRINT_BUDGET ? "over_budget" : "ok",
    bytes,
    headroomToBudget: AUTOLOAD_FOOTPRINT_BUDGET - bytes,
    mustFree: Math.max(0, bytes - AUTOLOAD_FOOTPRINT_BUDGET),
    unmeasured: [],
    repoStatus: unlabelled ? "unknown" : repoBytes > AUTOLOAD_REPO_SHARE ? "over" : "ok",
    repoBytes: unlabelled ? 0 : repoBytes,
    repoHeadroom: unlabelled ? 0 : AUTOLOAD_REPO_SHARE - repoBytes,
    repoMustFree: unlabelled ? 0 : Math.max(0, repoBytes - AUTOLOAD_REPO_SHARE),
  };
}

/**
 * The lines a caller prints for the footprint. Beside the arithmetic for the same reason as
 * `memoryIndexBudgetLines`: the figure and the sentence explaining what to do about it must not be
 * able to drift apart.
 *
 * @param {ReturnType<typeof assessAutoloadFootprint>} verdict
 * @returns {string[]} empty when there is nothing to say
 */
export function autoloadFootprintLines(verdict) {
  if (verdict.status === "not_applicable") return [];

  const kb = (n) => (n / 1024).toFixed(1) + "KB";
  const size = (b) => (Number.isFinite(b) && b > 0 ? kb(b) : "UNMEASURED");
  const breakdown = verdict.parts.map((p) => `${p.label} ${size(p.bytes)}`).join(" + ");

  if (verdict.status === "unknown") {
    return [
      `  AUTO-LOADED FOOTPRINT: ${breakdown}`,
      `  Could not measure ${verdict.unmeasured.join(", ")} — treat the footprint as UNKNOWN, not healthy.`,
    ];
  }

  const scale = `AUTO-LOADED EVERY REQUEST: ${breakdown} = ${kb(verdict.bytes)} — budget ${kb(verdict.budget)}`;

  if (verdict.status === "over_budget") {
    return [
      "  " + scale,
      `  OVER FOOTPRINT BUDGET — free ${verdict.mustFree} bytes. These files are re-sent on EVERY`,
      "  request, so this is context the conversation never gets and compaction arrives sooner.",
      "  Relocating a hook from MEMORY.md into AGENTS.md does NOT help here — both are already inside",
      "  this number. Move the DETAIL out of the auto-loaded set into docs/, read on demand, leaving a",
      "  one-line hook behind (docs/agents-session-traps.md is the worked example).",
      // Printed here too: the two are INDEPENDENT. A total over budget with a huge index can still
      // leave the repo share healthy, and a session told only "over" would not know which of the two
      // its next edit is actually graded against.
      ...repoShareLines(verdict),
    ];
  }

  // "bytes of slack", NOT "bytes of budget left". The index's healthy line owns that phrasing, and
  // `tests/session-start-memory-index-guard.test.ts` asserts a worktree session never sees it — the
  // decoy that assertion exists to catch is an index misread as healthy. Two different figures
  // wearing one sentence is how that check would start passing for the wrong reason.
  return ["  " + scale + ` — ${verdict.headroomToBudget} bytes of slack`, ...repoShareLines(verdict)];
}

/**
 * The enforced margin, printed under the total.
 *
 * It goes LAST and it names the gate, because the reader has just been given a bigger, friendlier
 * number and needs to know which of the two CI actually fails on. The total's slack credits the
 * repository with the index's unused headroom; this does not.
 *
 * @param {ReturnType<typeof assessAutoloadFootprint>} verdict
 * @returns {string[]}
 */
function repoShareLines(verdict) {
  if (verdict.repoStatus === "not_applicable") return [];

  if (verdict.repoStatus === "unknown") {
    return [
      "  REPO SHARE UNKNOWN — a caller did not mark every part `inRepo`, so the enforced margin",
      "  could not be computed. Treat it as unknown, never as the slack above.",
    ];
  }

  // 🔴 THE LABEL NAMES WHERE CI GRADES IT, BECAUSE THIS NUMBER IS MEASURED SOMEWHERE ELSE. CI grades
  // the PR HEAD; this is measured from the checkout the session is sitting in, and in the shared
  // primary that tree is routinely a commit or two behind `origin/main` — sessions here merge about
  // 46 times a day. The old label, "what CI grades", read as a verdict on the merged repository.
  //
  // Measured 2026-10-02: the banner reported `125586 of 125600 — 14 bytes left` while `origin/main`
  // stood at 124819, i.e. 781 bytes of room. The checkout was ONE commit behind, and that commit
  // (#5089) had just moved an account out of AGENTS.md and freed 767 bytes. A session reading 14
  // bytes concludes it cannot add a single hook and starts trimming room that already exists — the
  // exact opposite of what the session that freed it was doing.
  //
  // It is not fixed by measuring `origin/main` instead: §2.2 allows a union for REPORTING, but the
  // figure above it is deliberately the SESSION'S OWN tree (see the hook's note on why a worktree's
  // half-finished AGENTS.md must count), and two figures from two refs in one block is worse than
  // one figure that says which ref it came from.
  const enforced = `  ENFORCED SHARE (CI grades it on your PR head): CLAUDE.md + AGENTS.md ${verdict.repoBytes} of ${verdict.repoShare} bytes`;

  if (verdict.repoStatus === "over") {
    return [
      enforced,
      `  OVER THE REPO SHARE — free ${verdict.repoMustFree} bytes or the required \`validate\` check fails.`,
      "  This is the number to budget against; the slack above is larger because it lends you the",
      "  memory index's unused room, which the gate does not.",
    ];
  }

  return [
    enforced + ` — ${verdict.repoHeadroom} bytes left`,
    "  Budget against THIS, not the slack above: the gate allows the index its full cliff whatever",
    "  it weighs today, so the total's slack is always the friendlier of the two figures.",
    "  Measured from THIS checkout — one behind `origin/main` reports a stale margin in either",
    "  direction, so `git fetch` before acting on a tight one.",
  ];
}

/**
 * How far behind `origin/main` the checkout these numbers were measured in is.
 *
 * 🔴 WHY A NUMBER, WHEN THE CAVEAT WAS ALREADY THERE. `autoloadFootprintLines` has ended with
 * "one behind `origin/main` reports a stale margin in either direction" for weeks, and the comment
 * above `enforced` carries the whole account of the 14-byte misread. Neither stopped it happening
 * again on 2026-10-02: the primary's banner read **14 bytes left** while `origin/main` had
 * **1,277**, because that checkout was 20 commits behind a trim that had already landed. A session
 * read 14, treated it as an emergency, and spent a turn trimming room that existed. A prose caveat
 * is easy to read past; `20 commit(s) BEHIND origin/main` is not, and it names the remedy by naming
 * the cause.
 *
 * It is not only about bytes. The same stale folder ran a superseded `new-session.mjs --remove`
 * gate an hour later — so this is the one fact that makes every other number in the banner
 * conditional, which is why it prints whatever the footprint verdict says.
 *
 * THE COUNT IS A FLOOR, AND SAYING SO IS NOT A HEDGE. The local `origin/main` ref is only as fresh
 * as the last fetch, and a SessionStart hook must not reach the network: seconds added to every
 * session start is the worse trade. `check-required-checks.mjs` prints the same shape for the same
 * reason and MAY fetch, because it is a command somebody chose to run.
 *
 * `null` means this is not a git checkout at all — a scratch session, a folder that is not a repo —
 * and then this says NOTHING. That is this file's own rule: nothing to measure is silence,
 * something present that could not be measured is loud.
 */
export function checkoutPositionLines(position) {
  if (position === null || position === undefined) return [];
  const sha =
    typeof position.sha === "string" && position.sha.trim() !== "" ? position.sha.trim() : "?";

  // Present but unreadable: say so out loud rather than let it pass for current. A detached HEAD, a
  // missing `origin/main` ref and a git that errored all land here, each carrying its own note.
  if (position.note) {
    return [`  CHECKOUT ${sha} — POSITION UNKNOWN: ${position.note}. Read every figure above as unverified.`];
  }

  const behind = Number(position.behind);
  if (!Number.isFinite(behind) || behind < 0) {
    return [`  CHECKOUT ${sha} — POSITION UNKNOWN: the origin/main comparison returned no usable count.`];
  }
  if (behind === 0) {
    return [`  CHECKOUT ${sha} — level with the local origin/main ref (a floor: as fresh as the last fetch).`];
  }
  return [
    `  🔴 CHECKOUT ${sha} — ${behind} commit(s) BEHIND origin/main, so every figure above is THIS`,
    "  checkout's and not `main`'s. A stale tree has reported 14 bytes left where main had 1,277, and",
    "  has run a superseded repo script from the same folder. At least this many — the local",
    "  origin/main ref is as fresh as the last fetch. `git fetch` and re-read before trimming;",
    "  `git merge --ff-only origin/main` where that folder is safe to move.",
  ];
}
