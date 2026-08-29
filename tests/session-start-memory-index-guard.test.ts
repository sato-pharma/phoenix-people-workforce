// THE BUDGET HAS TO REACH A SESSION AT THE MOMENT IT APPENDS, NOT WHEN SOMEONE AUDITS.
//
// WHY THIS EXISTS. `scripts/memory-index-budget.mjs` grades `MEMORY.md` against a 22,000-byte
// budget below the loader's silent 24,400-byte cliff, and `tests/memory-index-budget.test.ts` pins
// that arithmetic. But the only thing printing the grade was `repo-doctor.mjs`, which reports when
// somebody runs it — never the moment a hook line is being written. The append is the event.
//
// The gap is not theoretical. Measured 2026-08-28: 1,619 bytes of new hook lines landed in about
// 30 minutes across parallel sessions; a retirement that freed 196 bytes was outrun by 331 bytes of
// fresh ones while it was being made; and the index went from 22,774 to 23,463 bytes — 937 from the
// cliff — during the hour this hook was written. Nobody was careless. Nothing told them.
//
// THESE TESTS DRIVE THE REAL HOOK AS A SUBPROCESS against real throwaway config roots, because the
// properties that matter are runtime ones: does a number actually reach a session's context, and is
// it the number for the RIGHT index. A test that imported a formatter and asserted on strings would
// pass against a hook that was never wired up, or one that looked in the wrong directory — which is
// precisely how the worktree exit guard's SessionEnd leg sat silent for a full day with the script
// still on disk and still registered.
//
// TWO CASES CARRY THE WEIGHT. The WIRING case, because a hook that exists and is not registered as
// its own SessionStart entry does nothing — and folding it into `session-lock.mjs` would mute it in
// the one situation that produces colliding appends, since that script returns early when another
// session's lock is live. And the WORKTREE case, because memory belongs to the project, not to the
// `_wt-*` folder a session sits in: resolve the slug from the worktree and the guard finds no
// directory and says nothing, silently, for the sessions that do most of the appending.
//
// The healthy case is asserted as hard as the alarming ones, in both directions — it must carry the
// figure and must NOT interrupt the human. A guard that only speaks up on failure cannot be told
// apart from a guard that is broken.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The hook under test, resolved from the repo root the suite runs in. */
const hookPath = resolve(".claude/hooks/memory-index-guard.mjs");

type HookOutput = { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };

/** The hook's own slug arithmetic, reproduced so a fixture lands where it will actually look. */
const slugFor = (root: string): string => resolve(root).replace(/[^A-Za-z0-9]/g, "-");

/** Runs the guard exactly as the SessionStart entry does: project directory as argv[2]. */
function runHook(projectDir: string, configRoot: string): { raw: string; out: HookOutput | null } {
  const raw = execFileSync(process.execPath, [hookPath, projectDir], {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
  });
  return { raw, out: raw.trim() ? (JSON.parse(raw) as HookOutput) : null };
}

/** Gives `root` a memory directory holding a MEMORY.md of exactly `bytes` bytes (null = no file). */
function seedIndex(configRoot: string, root: string, bytes: number | null): void {
  const dir = join(configRoot, "projects", slugFor(root), "memory");
  mkdirSync(dir, { recursive: true });
  if (bytes !== null) writeFileSync(join(dir, "MEMORY.md"), "x".repeat(bytes));
}

const contextOf = (out: HookOutput | null): string => out?.hookSpecificOutput?.additionalContext ?? "";

function git(at: string, args: string[]): string {
  return execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function runSessionStartMemoryIndexGuardTests() {
  // 1. THE WIRING. A hook nobody invokes is a file, not a guard.
  const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
    hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
  };
  const startEntries = (settings.hooks?.SessionStart ?? []).flatMap((group) => group.hooks ?? []);
  const guardEntries = startEntries.filter((h) => (h.command ?? "").includes("memory-index-guard.mjs"));
  assert.equal(
    guardEntries.length,
    1,
    "the memory index guard must be registered exactly once as a SessionStart hook in .claude/settings.json",
  );

  // Folding it into the lock script would mute it whenever another session's lock is live — which
  // is exactly when two sessions are appending to one index.
  for (const entry of startEntries) {
    const command = entry.command ?? "";
    assert.ok(
      !(command.includes("session-lock.mjs") && command.includes("memory-index-guard.mjs")),
      "the guard must be its OWN SessionStart entry: session-lock.mjs returns early when another "
        + "session's lock is live, so anything sharing its process is silent in the colliding case",
    );
  }

  // 2. THE MEASURED CASE — over budget, under the cliff. 23,463 bytes, measured live 2026-08-28.
  // This is the size at which the old ceiling-only rule said nothing at all, with 937 bytes of room
  // left and parallel sessions still appending.
  const root = mkdtempSync(join(tmpdir(), "phx-mig-"));
  try {
    const project = join(root, "project");
    const config = join(root, "config");
    mkdirSync(project, { recursive: true });

    seedIndex(config, project, 23_463);
    const over = runHook(project, config);
    assert.match(contextOf(over.out), /OVER BUDGET/, "an over-budget index must say so in the session's context");
    assert.match(contextOf(over.out), /free 1463 bytes/, "the context must name the exact number of bytes to free");
    assert.match(contextOf(over.out), /937 left before the loader/, "it must name the remaining room to the cliff");
    assert.match(
      contextOf(over.out),
      /displacement-only/,
      "it must tell the session what to do about it — displace, not merely that the file is big",
    );
    assert.match(
      contextOf(over.out),
      /Route by KIND of fact/,
      "displacing is not enough — it must say WHERE, or the session picks a section by guesswork",
    );
    // §4 is the one that gets left out. The first version of this hook named only 2.1/2.3, the two
    // session-trap sections — so an OWNER PRODUCT RULE, which is what #2566 relocated seven of, had
    // no home in the guidance and would have been filed among the tooling traps.
    assert.match(
      contextOf(over.out),
      /an owner product rule to 4\./,
      "an owner product rule belongs in §4, not among the session traps in §2.1",
    );
    assert.match(
      over.out?.systemMessage ?? "",
      /23463 bytes/,
      "the human is interrupted with the figure when action is due",
    );

    // 3. THE HEALTHY CASE, BOTH DIRECTIONS.
    rmSync(join(config, "projects"), { recursive: true, force: true });
    seedIndex(config, project, 20_000);
    const healthy = runHook(project, config);
    assert.match(contextOf(healthy.out), /2000 bytes of budget left/, "a healthy index still reports its headroom");
    assert.doesNotMatch(contextOf(healthy.out), /OVER/, "a healthy index must not carry an alarm word");
    assert.equal(
      healthy.out?.systemMessage,
      undefined,
      "a healthy index must NOT interrupt the human — the session gets the number, nobody gets nagged",
    );

    // 4. OVER THE CLIFF.
    rmSync(join(config, "projects"), { recursive: true, force: true });
    seedIndex(config, project, 24_500);
    const cliff = runHook(project, config);
    assert.match(contextOf(cliff.out), /OVER THE CLIFF/, "past the loader ceiling the context must say so");
    assert.match(
      contextOf(cliff.out),
      /invisible/,
      "it must say hooks are being dropped, not merely that the file is big",
    );
    assert.match(cliff.out?.systemMessage ?? "", /OVER THE LOADER CLIFF/, "and the human must be told plainly");

    // 5. THE ONE-WAY RULE — a file it found but could not measure. The directory exists, so this
    // checkout HAS an index; the file does not answer. That must read as unknown, never as healthy:
    // a size check that says "fine" when statSync threw is how the cliff gets crossed while the
    // report reads clean.
    rmSync(join(config, "projects"), { recursive: true, force: true });
    seedIndex(config, project, null);
    const unknown = runHook(project, config);
    assert.match(contextOf(unknown.out), /UNKNOWN/, "an unmeasurable index must be reported as unknown out loud");
    assert.doesNotMatch(contextOf(unknown.out), /budget left/, "it must never borrow the healthy phrasing");
    assert.match(unknown.out?.systemMessage ?? "", /UNKNOWN/, "and it must interrupt, because it is not an all-clear");

    // 6. NO INDEX AT ALL — silence is correct here, and only here.
    rmSync(join(config, "projects"), { recursive: true, force: true });
    mkdirSync(config, { recursive: true });
    const none = runHook(project, config);
    assert.equal(none.raw.trim(), "", "a checkout with no memory directory (CI, a fresh clone) must say nothing");

    // 8. THE WHOLE AUTO-LOADED FOOTPRINT REACHES THE SESSION, not just the index.
    //
    // This is the wiring property, and it is the one that was missing for as long as the budget has
    // existed: the guard policed a ~21KB file and said nothing about the ~112KB loaded beside it, so
    // AGENTS.md §2.2's own advice — relocate a hook into AGENTS.md, which "auto-loads in full and
    // has no cliff" — moved bytes out of the only counter watching them into a file loaded on
    // exactly the same terms. Asserting the arithmetic in `autoload-footprint-budget.test.ts` proves
    // nothing about whether a session is ever told, which is how the worktree exit guard's
    // SessionEnd leg sat silent for a full day with the script still on disk and still registered.
    //
    // Seeded with NO memory directory on purpose. It proves two things at once: the footprint is
    // reported on its own merits, and case 6's silence really was "nothing to report" rather than an
    // early exit that would now swallow the instruction files too.
    writeFileSync(join(project, "CLAUDE.md"), "c".repeat(7_000));
    writeFileSync(join(project, "AGENTS.md"), "a".repeat(112_000));
    const repoOnly = runHook(project, config);
    assert.match(contextOf(repoOnly.out), /AUTO-LOADED/, "the footprint must reach the session's context");
    assert.match(contextOf(repoOnly.out), /AGENTS\.md/, "and it must name where the bytes are, not just a total");
    assert.equal(
      repoOnly.out?.systemMessage,
      undefined,
      "a footprint inside budget must not interrupt the human, exactly as a healthy index does not",
    );

    // Now with the index too: all three must be in ONE number, or the total under-reports by
    // whichever file the report forgot.
    seedIndex(config, project, 20_000);
    const all = runHook(project, config);
    assert.match(
      contextOf(all.out),
      /CLAUDE\.md[\s\S]*AGENTS\.md[\s\S]*MEMORY\.md/,
      "all three auto-loaded files must appear in the breakdown, in load order",
    );
    // 139,000 bytes / 1024 = 135.7KB. The figure is asserted as the reader sees it, so a change to
    // the formatter cannot quietly alter what the number means.
    assert.match(contextOf(all.out), /135\.7KB/, "the total must be the sum of all three (7,000 + 112,000 + 20,000)");

    // 9. OVER THE FOOTPRINT BUDGET — and the remedy must NOT be the index's remedy. When the index
    // is over, relocating a hook into AGENTS.md is right. When the TOTAL is over it buys nothing,
    // because both files are already inside the number, and a session told to relocate would do the
    // very thing that caused the problem. The index here is deliberately HEALTHY, so the only thing
    // that can raise the alarm is the footprint.
    writeFileSync(join(project, "AGENTS.md"), "a".repeat(130_000));
    const fat = runHook(project, config);
    assert.match(contextOf(fat.out), /OVER FOOTPRINT BUDGET/, "an over-budget footprint must say so");
    assert.match(contextOf(fat.out), /does NOT help/, "it must say relocating into AGENTS.md does not help here");
    assert.match(contextOf(fat.out), /docs\//, "and it must name the remedy that does");
    assert.match(contextOf(fat.out), /2000 bytes of budget left/, "the healthy index must still report normally");
    assert.match(
      fat.out?.systemMessage ?? "",
      /footprint 157000 bytes/,
      "the human must be interrupted by the footprint even when the index is fine",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // 7. A WORKTREE MUST READ THE PRIMARY CHECKOUT'S INDEX. Memory belongs to the project. Resolve
  // the slug from the `_wt-*` folder and the guard finds nothing and stays silent for the sessions
  // that do most of the appending. Both directories are seeded, at different sizes, so picking the
  // wrong one fails loudly instead of passing for free.
  const wtRoot = mkdtempSync(join(tmpdir(), "phx-mig-wt-"));
  try {
    const repo = join(wtRoot, "repo");
    const worktree = join(wtRoot, "_wt-probe");
    const config = join(wtRoot, "config");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: ["ignore", "ignore", "pipe"] });
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Guard Test"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, ["add", "seed.txt"]);
    git(repo, ["commit", "-m", "seed"]);
    git(repo, ["worktree", "add", worktree, "-b", "probe"]);

    // Resolve the primary the way the hook does, from inside the worktree, so the fixture lands
    // where it will actually look — git and node disagree about slashes and case on Windows.
    const primary = resolve(dirname(git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
    seedIndex(config, primary, 23_463);
    seedIndex(config, worktree, 20_000);

    const fromWorktree = runHook(worktree, config);
    assert.match(
      contextOf(fromWorktree.out),
      /OVER BUDGET/,
      "a session in a worktree must be graded against the PRIMARY checkout's index, not an empty one of its own",
    );
    assert.match(
      contextOf(fromWorktree.out),
      /free 1463 bytes/,
      "it must report the primary's size (23,463), not the worktree-slug decoy seeded at 20,000",
    );
    assert.doesNotMatch(
      contextOf(fromWorktree.out),
      /budget left/,
      "reading the worktree's own slug would have reported the 20,000-byte decoy as healthy",
    );
  } finally {
    rmSync(wtRoot, { recursive: true, force: true });
  }
}
