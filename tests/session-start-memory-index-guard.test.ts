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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { cloudMirrorSessionLines } from "../scripts/cloud-mirror-drift.mjs";
import { settingsHookGroups } from "./support/hook-wiring.ts";

/** The hook under test, resolved from the repo root the suite runs in. */
const hookPath = resolve(".claude/hooks/memory-index-guard.mjs");
/** The async SessionStart entry that takes the cloud mirror's drift reading for it (2026-10-09). */
const refresherPath = resolve("scripts/cloud-mirror-drift-refresh.mjs");
/** Records every subprocess / network call of the process it is preloaded into (tests/support). */
const spawnProbeUrl = pathToFileURL(resolve("tests/support/spawn-probe.mjs")).href;

type HookOutput = { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };

/** The hook's own slug arithmetic, reproduced so a fixture lands where it will actually look. */
const slugFor = (root: string): string => resolve(root).replace(/[^A-Za-z0-9]/g, "-");

/**
 * The child's temp folder. 2026-10-09 (hook speed fixes): the guard now reads a cached drift reading
 * from os.tmpdir(), so every run points TMP/TEMP/TMPDIR at a throwaway folder beside the throwaway
 * config root — a test must never read or write the real temp folder's reading, nor the real
 * ~/.claude (CLAUDE_CONFIG_DIR already sandboxes that).
 */
const tmpFor = (configRoot: string): string => {
  const dir = `${configRoot}-tmp`;
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** The cache file the refresher writes and the guard reads, named from the memory directory. */
const driftCacheFor = (tmp: string, memoryDir: string): string =>
  join(tmp, `phx-cloud-mirror-drift-${resolve(memoryDir).replace(/[^A-Za-z0-9]/g, "-")}.json`);

function sandboxEnv(configRoot: string, probeOut?: string): NodeJS.ProcessEnv {
  const tmp = tmpFor(configRoot);
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configRoot, TMP: tmp, TEMP: tmp, TMPDIR: tmp };
  delete env.SPAWN_PROBE_OUT;
  if (probeOut) env.SPAWN_PROBE_OUT = probeOut;
  return env;
}

/** Every call the spawn probe recorded, as `{kind, what}` — an absent file means none. */
const probeCalls = (file: string): Array<{ kind: string; what: string }> =>
  existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; what: string })
    : [];

/**
 * Runs the guard with the project directory as argv[2] — the first place it looks; the exec-form
 * SessionStart entry passes none and the guard falls back to CLAUDE_PROJECT_DIR, which argv[2]
 * overrides here so a test run inside a live session cannot read that session's project.
 */
function runHook(
  projectDir: string,
  configRoot: string,
  probeOut?: string,
): { raw: string; out: HookOutput | null } {
  const preload = probeOut ? ["--import", spawnProbeUrl] : [];
  const raw = execFileSync(process.execPath, [...preload, hookPath, projectDir], {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    env: sandboxEnv(configRoot, probeOut),
  });
  return { raw, out: raw.trim() ? (JSON.parse(raw) as HookOutput) : null };
}

/**
 * Runs the drift refresher the way its async SessionStart entry does: no argv, CLAUDE_PROJECT_DIR
 * set, the hook's JSON on stdin (which it never reads). Returns what it printed — which must be nothing.
 */
function runRefresher(projectDir: string, configRoot: string, probeOut?: string): string {
  const preload = probeOut ? ["--import", spawnProbeUrl] : [];
  return execFileSync(process.execPath, [...preload, refresherPath], {
    cwd: projectDir,
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: projectDir }),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
    env: { ...sandboxEnv(configRoot, probeOut), CLAUDE_PROJECT_DIR: projectDir },
  });
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
  //
  // Read through `settingsHookGroups`, not JSON.parse: since 2026-10-09 (hook speed fixes) the node
  // hooks are exec-form entries (`"command": "node", "args": ["${CLAUDE_PROJECT_DIR}/…"]`), and the
  // helper folds either spelling into one `node "<script>"` command line, so "which hook does this
  // entry run" reads the same both ways.
  const startGroups = settingsHookGroups("SessionStart");
  const startEntries = startGroups.flatMap((group) => group.hooks ?? []);

  // 1a. A COMPACTION IS A SessionStart TOO (source `compact`), and it re-runs every entry with no
  // matcher. Measured 2026-10-08 from three days of transcripts: 1,087 SessionStart runs on compact
  // against 514 at startup, inside 176 compactions that each already froze the session for a median
  // 132s. The two heavy entries — the all-worktrees provisioning sweep (worst 17.5s) and this
  // guard (worst 11s) — add to that freeze and answer nothing a compaction changed, so they fire on
  // startup, resume and clear only. The lock keeps firing on every source: it is what re-states
  // "another session holds this folder" after the summary has dropped it.
  const firesOn = (group: { matcher?: string } | undefined, source: string): boolean =>
    !!group && (!group.matcher || group.matcher === "*" || new RegExp(group.matcher).test(source));
  const groupOf = (needle: string) =>
    startGroups.find((g) => (g.hooks ?? []).some((h) => (h.command ?? "").includes(needle)));
  for (const heavy of ["sync-worktree-env.mjs", "memory-index-guard.mjs"]) {
    for (const source of ["startup", "resume", "clear"]) {
      assert.ok(firesOn(groupOf(heavy), source), `${heavy} must still run on SessionStart source "${source}"`);
    }
    assert.ok(
      !firesOn(groupOf(heavy), "compact"),
      `${heavy} must NOT re-run on every compaction — give its SessionStart group "matcher": "startup|resume|clear"`,
    );
  }
  for (const source of ["startup", "resume", "clear", "compact"]) {
    assert.ok(firesOn(groupOf("session-lock.mjs"), source), `session-lock start must fire on "${source}" as well`);
  }
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

  // 1b. THE DRIFT READING HAS ITS OWN ASYNC ENTRY (2026-10-09, hook speed fixes). The guard no longer
  // takes the cloud mirror's drift reading — 1,225 notes read in full plus a git ls-tree and cat-file
  // over the whole mirror, on every session start — it prints the one this refresher cached. Unwired,
  // the cache is never written and the "CLOUD MIRROR IS STALE" alarm goes quiet for good with nothing
  // failing; wired blocking, every session waits for the very scan this moved off its path; wired
  // with no matcher, it re-runs inside every compaction's freeze, as the guard used to.
  const refresherEntries = startEntries.filter((h) => (h.command ?? "").includes("cloud-mirror-drift-refresh.mjs"));
  assert.equal(
    refresherEntries.length,
    1,
    "scripts/cloud-mirror-drift-refresh.mjs must be registered exactly once as a SessionStart hook — "
      + "without it the guard has no drift reading to print",
  );
  assert.equal(
    refresherEntries[0]?.async,
    true,
    "the drift refresher must be an \"async\": true entry — a blocking one puts the whole mirror scan "
      + "back on every session's start",
  );
  for (const source of ["startup", "resume", "clear"]) {
    assert.ok(
      firesOn(groupOf("cloud-mirror-drift-refresh.mjs"), source),
      `the drift refresher must run on SessionStart source "${source}"`,
    );
  }
  assert.ok(
    !firesOn(groupOf("cloud-mirror-drift-refresh.mjs"), "compact"),
    "the drift refresher must NOT re-run on every compaction — keep it in the \"startup|resume|clear\" group",
  );

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
      /files it under its module and empties the inbox/,
      "it must tell the session what to do about it — the fold, not merely that the file is big",
    );
    assert.match(
      contextOf(over.out),
      /Route by WHERE a fact applies/,
      "filing is not enough — it must say WHERE, or the session picks a home by guesswork",
    );
    // Module memory (2026-10-02, docs/module-memory.md): a fact about ONE module goes to that module's
    // memory. The pre-module advice — relocate a hook into AGENTS.md — is what kept both files full.
    assert.match(
      contextOf(over.out),
      /one module to its memory \(\.claude\/rules\/<module>\.md/,
      "a module fact belongs in its module's memory, never back in the index or AGENTS.md",
    );
    assert.doesNotMatch(
      contextOf(over.out),
      /relocate it into AGENTS\.md/,
      "the retired advice must not come back — it is the cycle module memory replaced",
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

    // The drift refresher must land on the SAME memory directory from a worktree, or it caches a
    // reading under a name the guard never looks up and the alarm goes quiet in exactly the
    // sessions that do most of the work (2026-10-09, hook speed fixes).
    runRefresher(worktree, config);
    const wtTmp = tmpFor(config);
    assert.ok(
      existsSync(driftCacheFor(wtTmp, join(config, "projects", slugFor(primary), "memory"))),
      "a worktree's drift refresher must cache its reading under the PRIMARY's memory directory — the one the guard reads",
    );
    assert.ok(
      !existsSync(driftCacheFor(wtTmp, join(config, "projects", slugFor(worktree), "memory"))),
      "and never under the worktree-slug decoy",
    );
  } finally {
    rmSync(wtRoot, { recursive: true, force: true });
  }

  // 10. THE DRIFT READING IS A CACHE, NOT A SCAN (2026-10-09, hook speed fixes).
  //
  // The guard used to read every live memory note in full and run `git ls-tree` plus a
  // `git cat-file --batch` over the whole mirror on every session start — 1,225 notes and ~1,222
  // blobs here, p50 2.0 s and worst 11.1 s for the hook, every session waiting. The reading moved
  // to `scripts/cloud-mirror-drift-refresh.mjs`, an async entry, which caches it; the guard prints
  // the cached one. What must hold, each asserted below against a real repository whose mirror on
  // `origin/main` has really drifted:
  //   · no cache → no drift section, and the guard starts no git beyond its three checkout-position
  //     calls (the spawn probe records every process it starts);
  //   · the refresher writes the cache, prints nothing, and skips while the reading is under 30 min;
  //   · a cached drift prints the stale-mirror section and its alarm word for word, under 24 hours.
  const driftRoot = mkdtempSync(join(tmpdir(), "phx-mig-drift-"));
  try {
    const repo = join(driftRoot, "repo");
    const config = join(driftRoot, "config");
    const tmp = tmpFor(config);
    execFileSync("git", ["init", "-b", "main", repo], { stdio: ["ignore", "ignore", "pipe"] });
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Guard Test"]);
    git(repo, ["config", "commit.gpgsign", "false"]);

    // The mirror a cloud session would clone: committed, and `origin/main` pointing at it.
    const index = "x".repeat(20_000);
    const mirrorDir = join(repo, ".claude", "cloud-context", "memory-mirror");
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, "MEMORY.md"), index);
    writeFileSync(join(mirrorDir, "same.md"), "unchanged\n");
    writeFileSync(join(mirrorDir, "moved-on.md"), "OPEN GAP, NOT yet fixed\n");
    writeFileSync(join(mirrorDir, "retired.md"), "a memory deleted upstream, still shipping to cloud\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "mirror"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    // The live memory it has drifted from: one stale, one missing from the mirror, one retired.
    const memoryDir = join(config, "projects", slugFor(repo), "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), index);
    writeFileSync(join(memoryDir, "same.md"), "unchanged\n");
    writeFileSync(join(memoryDir, "moved-on.md"), "the gap is FIXED and the migration applied\n");
    writeFileSync(join(memoryDir, "brand-new.md"), "written since the last refresh\n");
    const cacheFile = driftCacheFor(tmp, memoryDir);

    // Since 2026-10-09 (memory-check speed) the two ids are read off disk and the calls name them, so
    // each call is matched in both shapes; hook-hot-path.test.ts pins that a repeat start makes none.
    const CHECKOUT_POSITION_CALLS = {
      has: (call: string) =>
        /^child_process\.execFileSync git (rev-parse --git-dir|rev-parse --short (HEAD|[0-9a-f]{40})|rev-list --count (HEAD\.\.origin\/main|[0-9a-f]{40}\.\.[0-9a-f]{40}))$/.test(call),
    };
    const mirrorReads = (calls: Array<{ kind: string; what: string }>) =>
      calls.filter((call) => /\bls-tree\b|\bcat-file\b/.test(call.what));

    // 10a. NO CACHE: no drift section, and nothing started but the checkout position.
    assert.ok(!existsSync(cacheFile), "precondition: no drift reading is cached yet");
    const probeNoCache = join(driftRoot, "probe-guard-no-cache.jsonl");
    const noCache = runHook(repo, config, probeNoCache);
    assert.match(contextOf(noCache.out), /2000 bytes of budget left/, "with no reading cached the index is still reported");
    assert.doesNotMatch(
      contextOf(noCache.out),
      /CLOUD MIRROR IS STALE/,
      "with NO cached reading the guard must print no drift section — it no longer takes the reading itself",
    );
    assert.equal(noCache.out?.systemMessage, undefined, "and must raise no drift alarm");
    const noCacheCalls = probeCalls(probeNoCache);
    assert.ok(
      noCacheCalls.length > 0,
      "the spawn probe recorded nothing at all — it was not loaded, so the two checks below would pass for free",
    );
    assert.deepEqual(
      mirrorReads(noCacheCalls),
      [],
      "the blocking guard must not read the mirror — no git ls-tree, no git cat-file on the session-start path",
    );
    for (const call of noCacheCalls) {
      assert.ok(
        CHECKOUT_POSITION_CALLS.has(`${call.kind} ${call.what}`),
        `the blocking guard may start only its three checkout-position git calls, and it started: ${call.kind} ${call.what}`,
      );
    }

    // 10b. THE REFRESHER WRITES THE CACHE, and says nothing.
    const before = Date.now();
    const printed = runRefresher(repo, config);
    const after = Date.now();
    assert.equal(printed, "", "the refresher prints nothing — an async entry's output would land in a later turn");
    assert.ok(existsSync(cacheFile), `the refresher must write its reading to ${cacheFile}`);
    const first = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.equal(first.memoryDir, memoryDir, "the reading must record which memory directory it measured");
    assert.ok(first.at >= before && first.at <= after, "and when, as epoch milliseconds");
    assert.equal(first.source, "ref", "it must read origin/main's mirror — the copy a cloud session clones");
    assert.deepEqual(
      [first.drift?.stale, first.drift?.missing, first.drift?.extra, first.drift?.drifted, first.drift?.compared],
      [["moved-on.md"], ["brand-new.md"], ["retired.md"], 3, 4],
      "the cached reading must be cloudMirrorDrift's own answer for live memory against origin/main's mirror",
    );

    // 10c. A CACHED DRIFT PRINTS THE SECTION AND ITS ALARM, word for word, without scanning anything.
    const probeCached = join(driftRoot, "probe-guard-cached.jsonl");
    const cached = runHook(repo, config, probeCached);
    assert.ok(
      contextOf(cached.out).includes(cloudMirrorSessionLines(first.drift).join("\n")),
      "a cached drift must print the CLOUD MIRROR IS STALE section exactly as cloudMirrorSessionLines words it",
    );
    assert.ok(
      (cached.out?.systemMessage ?? "").includes(
        "Cloud mirror 3 file(s) stale — a cloud session would read those memories wrong; "
          + "run node scripts/sync-cloud-context.mjs before sending work there.",
      ),
      "and the human must get the drift alarm, word for word as before",
    );
    assert.deepEqual(mirrorReads(probeCalls(probeCached)), [], "printing a cached reading must not scan the mirror");

    // 10d. UNDER 30 MINUTES OLD, THE REFRESHER SKIPS. A note written since would change the reading,
    // so an unchanged cache proves the work was not redone — and the probe proves no scan started.
    writeFileSync(join(memoryDir, "another-new.md"), "written after the reading was taken\n");
    const probeSkip = join(driftRoot, "probe-refresh-skip.jsonl");
    runRefresher(repo, config, probeSkip);
    const second = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.equal(second.at, first.at, "a reading under 30 minutes old must be left as it is");
    assert.equal(second.drift?.drifted, 3, "and not re-taken — the note written since is not in it");
    assert.deepEqual(mirrorReads(probeCalls(probeSkip)), [], "a skipped refresh must not scan the mirror at all");

    // Past 30 minutes it is re-taken, and sees the new note.
    writeFileSync(cacheFile, JSON.stringify({ ...second, at: Date.now() - 31 * 60 * 1000 }));
    runRefresher(repo, config);
    const third = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.ok(third.at > second.at, "a reading over 30 minutes old must be re-taken");
    assert.equal(third.drift?.drifted, 4, "and the new reading must count the note written since");

    // 10e. THE GUARD PRINTS A READING UNDER 24 HOURS OLD, AND NOT AN OLDER ONE. Past a day the reading
    // may describe a mirror since refreshed and merged, and a false alarm is the one sessions learn
    // to skip.
    writeFileSync(cacheFile, JSON.stringify({ ...third, at: Date.now() - 23 * 60 * 60 * 1000 }));
    assert.match(
      contextOf(runHook(repo, config).out),
      /CLOUD MIRROR IS STALE/,
      "a cached reading under 24 hours old must still be printed",
    );
    writeFileSync(cacheFile, JSON.stringify({ ...third, at: Date.now() - 25 * 60 * 60 * 1000 }));
    const stale = runHook(repo, config);
    assert.doesNotMatch(
      contextOf(stale.out),
      /CLOUD MIRROR IS STALE/,
      "a reading over 24 hours old must not be printed — it may describe a mirror already refreshed",
    );
    assert.equal(stale.out?.systemMessage, undefined, "nor raise the drift alarm");
  } finally {
    rmSync(driftRoot, { recursive: true, force: true });
  }
}
