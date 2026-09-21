import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * A session lock is stale by AGE alone. Nothing may teach a reader to judge one by its PID.
 *
 * WHY THIS EXISTS. `.claude/hooks/session-lock.mjs` writes `pid: process.ppid` — the hook's
 * short-lived parent shell, which exits within seconds of the lock being written. Its own header
 * says PID-liveness checks are "intentionally not used to decide staleness". So EVERY session lock
 * on the machine names a dead PID, forever, and "the PID is gone" is not evidence of anything.
 *
 * Three places said otherwise, and each one was read and believed:
 *
 *   1. `~/.claude/scripts/claude-hygiene.mjs` decided staleness with `pidAlive(pid)`. On 2026-09-05
 *      it reported a lock written FIVE MINUTES earlier by a live session as stale — and the
 *      scheduled task `ClaudeCode Hygiene - Weekly` runs it with `--fix`, so it had been deleting
 *      live session locks every week. That file lives outside this repository, so CI cannot see it
 *      and this test cannot reach it; it is fixed, and named here so the next reader knows where
 *      the fourth copy of this mistake would hide.
 *   2. This hook's OWN warning text — the paragraph injected into every session that opens on a
 *      locked folder — ended "if the reported PID is not a running process, the lock is stale".
 *   3. AGENTS.md said the same thing twice.
 *
 * The cost of believing it is not a stale report. It is deleting the only guard against two
 * sessions in one folder, which in this repo has meant a session git-detached by another's
 * checkout, a branch auto-deleted mid-work, and a swarm dropping a staged file.
 *
 * So what is pinned here is that the hook DECIDES by age, and that no shipped text tells anyone to
 * decide any other way.
 */

const HOOK = ".claude/hooks/session-lock.mjs";

/** Any way of asking "is this process alive", in the spellings that would actually appear here. */
const LIVENESS_CALLS = [
  "pidAlive",
  "process.kill",
  "Get-Process",
  "tasklist",
  "isProcessAlive",
  "execFileSync",
];

function testTheHookDecidesByAge() {
  const code = stripComments(readFileSync(HOOK, "utf8"));

  assert.match(
    code,
    /STALE_MS\s*=\s*2\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    "the two-hour expiry is the whole staleness rule; if it moves, claude-hygiene.mjs's " +
      "SESSION_LOCK_STALE_MS must move with it",
  );

  // The decision itself: non-finite age OR older than the window. Nothing else.
  assert.match(
    code,
    /!Number\.isFinite\(ageMs\)\s*\|\|\s*ageMs\s*>\s*STALE_MS/,
    "staleness must be decided from the lock's AGE — an undated lock stale, an old one stale",
  );

  for (const call of LIVENESS_CALLS) {
    assert.ok(
      !code.includes(call),
      `session-lock.mjs must not ask whether a process is alive (${call}): the pid it stores is ` +
        "its own parent shell, so the answer is always 'dead' and the check always fires",
    );
  }

  // The pid may still be WRITTEN — it is a useful breadcrumb in the warning — but it must never be
  // read back to make a decision.
  assert.ok(code.includes("pid: process.ppid"), "the pid breadcrumb is expected to stay");
}

function testNoShippedTextTeachesThePidRule() {
  const hook = readFileSync(HOOK, "utf8");
  const agents = readFileSync("AGENTS.md", "utf8");

  // The exact sentence that was wrong, and the shapes a rewrite would most likely take.
  const WRONG = [
    /PID is not a running process, the lock is stale/i,
    /if the (reported )?PID is (not|no longer) (a )?running/i,
    /stale lock proves the PID is dead/i,
    /a lock whose PID is not a running process is stale/i,
  ];

  for (const source of [
    { name: HOOK, text: hook },
    { name: "AGENTS.md", text: agents },
  ]) {
    for (const pattern of WRONG) {
      assert.ok(
        !pattern.test(source.text),
        `${source.name} must not teach the PID staleness rule (${pattern}) — every session lock ` +
          "names a dead PID, so that rule condemns live sessions",
      );
    }
  }

  // And the replacement has to actually say what the rule IS, or the next reader invents one.
  assert.match(
    hook,
    /that AGE is the only staleness test/i,
    "the warning must name the real rule, not merely drop the wrong one",
  );
  assert.match(
    agents,
    /that AGE is the ONLY staleness test/,
    "AGENTS.md section 5 must carry the age rule",
  );
}

/*
 * AGE OF WHAT. Until 2026-09-17 the lock was written once, at SessionStart, and never touched again —
 * so its age was the SESSION's age, not how long it had been idle. Sessions here run for hours or
 * days; every one past two hours left a lock reading abandoned while it was still editing, and a
 * second session opening that folder was told nothing. The hook now refreshes the lock on every
 * Bash, PowerShell, Edit or Write call ("beat"), and age is measured from the last refresh.
 *
 * These run the real hook as a subprocess against throwaway folders, exactly as settings.json runs it.
 */

type LockFile = { sessionId?: string; startedAt?: string; refreshedAt?: string };

function runLockHook(mode: "start" | "beat" | "end", folder: string, sessionId: string): string {
  return execFileSync(process.execPath, [resolve(HOOK), mode, folder], {
    input: JSON.stringify({ session_id: sessionId }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
}

const lockOf = (folder: string): LockFile =>
  JSON.parse(readFileSync(join(folder, ".claude", "session.lock"), "utf8")) as LockFile;

/** Backdates the lock as if its holder had written it `hours` ago and never refreshed it since. */
function ageLock(folder: string, hours: number) {
  const then = new Date(Date.now() - hours * 3_600_000).toISOString();
  const lock = lockOf(folder);
  writeFileSync(
    join(folder, ".claude", "session.lock"),
    JSON.stringify({ ...lock, startedAt: then, refreshedAt: then }, null, 2),
  );
}

const warns = (output: string) => /ACTIVE in this exact working directory/.test(output);

function testALiveLongSessionStillWarnsASecondOne(root: string) {
  const folder = join(root, "long-session");
  mkdirSync(folder);
  runLockHook("start", folder, "long");
  ageLock(folder, 3);
  const started = lockOf(folder).startedAt;

  // Three hours in, the session runs a command.
  runLockHook("beat", folder, "long");
  const refreshed = lockOf(folder);
  assert.equal(refreshed.sessionId, "long", "a beat keeps the lock with the session that holds it");
  assert.equal(refreshed.startedAt, started, "a beat keeps the session's own start time");
  assert.ok(
    Date.now() - Date.parse(refreshed.refreshedAt ?? "") < 60_000,
    "a beat on a lock last refreshed hours ago must refresh it now",
  );

  assert.ok(
    warns(runLockHook("start", folder, "second")),
    "a session STARTED three hours ago that is still running commands must still warn a second session "
      + "opening its folder — the lock's age is time since its last refresh, not since the session began",
  );
  assert.equal(lockOf(folder).sessionId, "long", "a warned second session must not take the lock");
}

function testABeatNeverTakesAFreshLockAndReclaimsAStaleOne(root: string) {
  const folder = join(root, "contested");
  mkdirSync(folder);
  runLockHook("start", folder, "holder");

  runLockHook("beat", folder, "intruder");
  assert.equal(lockOf(folder).sessionId, "holder", "a beat from another session must never take a FRESH lock");

  ageLock(folder, 3);
  runLockHook("beat", folder, "intruder");
  const reclaimed = lockOf(folder);
  assert.equal(reclaimed.sessionId, "intruder", "a live session's beat takes over a lock idle for over two hours");
  assert.ok(
    Date.now() - Date.parse(reclaimed.startedAt ?? "") < 60_000,
    "a takeover starts its own clock rather than inheriting the abandoned session's start",
  );

  const beforeAnonymous = readFileSync(join(folder, ".claude", "session.lock"), "utf8");
  execFileSync(process.execPath, [resolve(HOOK), "beat", folder], { input: "{}", encoding: "utf8" });
  assert.equal(
    readFileSync(join(folder, ".claude", "session.lock"), "utf8"),
    beforeAnonymous,
    "a beat with no session id proves no ownership and must write nothing",
  );
}

function testTheLockIsPerFolder(root: string) {
  const primary = join(root, "primary");
  const worktree = join(primary, ".claude", "worktrees", "nested-session");
  mkdirSync(worktree, { recursive: true });

  runLockHook("start", primary, "primary-session");
  assert.equal(
    warns(runLockHook("start", worktree, "worktree-session")),
    false,
    "a session in a worktree must not be warned about the primary checkout's lock — even one nested inside it",
  );
  assert.equal(lockOf(primary).sessionId, "primary-session", "the primary's lock is untouched");
  assert.equal(lockOf(worktree).sessionId, "worktree-session", "the worktree holds its own lock");
}

function testTheHeartbeatIsWired() {
  const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
    hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; timeout?: number }> }>>;
  };
  const entries = (event: string, mode: string) =>
    (settings.hooks?.[event] ?? []).flatMap((group) =>
      (group.hooks ?? [])
        .filter((h) => (h.command ?? "").includes(`session-lock.mjs\\" ${mode} \\"$DIR\\"`)
          || (h.command ?? "").includes(`session-lock.mjs" ${mode} "$DIR"`))
        .map((h) => ({ ...h, matcher: group.matcher ?? "" })),
    );

  for (const [event, mode] of [["SessionStart", "start"], ["SessionEnd", "end"], ["PreToolUse", "beat"]] as const) {
    const found = entries(event, mode);
    assert.equal(found.length, 1, `session-lock.mjs ${mode} must be registered exactly once as a ${event} hook`);
    assert.ok(
      (found[0].command ?? "").includes("${CLAUDE_PROJECT_DIR"),
      `the ${event} lock hook must resolve its folder from CLAUDE_PROJECT_DIR — the session's own worktree`,
    );
  }
  const beat = entries("PreToolUse", "beat")[0];
  for (const tool of ["Bash", "PowerShell", "Edit", "Write"]) {
    assert.ok(beat.matcher.split("|").includes(tool), `the lock heartbeat must fire on ${tool}, but matches "${beat.matcher}"`);
  }
  assert.ok(typeof beat.timeout === "number" && beat.timeout <= 10, "the heartbeat runs on every tool call, so it needs a short timeout");
}

/*
 * ASKING COSTS A TURN, AND THE ANSWER WAS ALWAYS YES. Measured 2026-09-21: 170 of the 198 sessions
 * in the primary checkout hit the non-stale branch, so the old single warning told 86% of them to
 * stop and "confirm with the user whether that other session is still running". A lock refreshed
 * within LIVE_MS already answers that: a live session rewrites it on every Bash, PowerShell, Edit
 * and Write call, so a fresh `refreshedAt` cannot survive its holder's death. Below LIVE_MS the
 * hook therefore answers the question and the session isolates itself; above it the holder may have
 * crashed mid-task, which is the one case still worth the owner's turn. Both halves keep the
 * canonical warning phrase and every destructive-command ban — the split is about who answers, not
 * about relaxing the guard.
 */
const asksTheOwner = (output: string) => /confirm with the owner/.test(output);
const isolatesAndContinues = (output: string) => /WITHOUT stopping/.test(output);
const keepsTheBans = (output: string) => /do NOT commit or push/.test(output);

function testAProvablyLiveLockIsolatesInsteadOfAsking(root: string) {
  const folder = join(root, "provably-live");
  mkdirSync(folder);
  runLockHook("start", folder, "holder");

  // Two minutes since the holder's last refresh: it is provably alive.
  ageLock(folder, 2 / 60);
  const fresh = runLockHook("start", folder, "second");
  assert.ok(warns(fresh), "a live holder must still warn the second session");
  assert.ok(keepsTheBans(fresh), "the commit/push/edit bans must survive the live branch");
  assert.ok(
    isolatesAndContinues(fresh),
    "a lock refreshed two minutes ago must send the session to its own worktree and let it carry on",
  );
  assert.ok(
    !asksTheOwner(fresh),
    "a lock refreshed two minutes ago already proves the holder is alive — asking the owner to " +
      "confirm it spends his turn on a question the lock has answered",
  );
  assert.equal(lockOf(folder).sessionId, "holder", "a warned second session must not take the lock");

  // Half an hour: past any live session's refresh interval, so the holder may have crashed.
  ageLock(folder, 0.5);
  const ambiguous = runLockHook("start", folder, "third");
  assert.ok(warns(ambiguous), "an ambiguous holder must still warn the second session");
  assert.ok(keepsTheBans(ambiguous), "the commit/push/edit bans must survive the ambiguous branch");
  assert.ok(
    asksTheOwner(ambiguous),
    "a lock last refreshed 30 minutes ago may belong to a crashed session — only the owner knows",
  );
  assert.ok(
    !isolatesAndContinues(ambiguous),
    "an ambiguous lock must not be treated as a live one",
  );
  assert.equal(lockOf(folder).sessionId, "holder", "an ambiguous lock must not be taken either");

  // The threshold is expressed in beats so it can never sink below one refresh interval, which
  // would let a live holder be read as crashed.
  const hook = readFileSync(HOOK, "utf8");
  const beats = /const LIVE_MS = (\d+) \* BEAT_EVERY_MS/.exec(hook);
  assert.ok(beats, "LIVE_MS must be defined as a multiple of BEAT_EVERY_MS, not a bare duration");
  assert.ok(
    Number(beats![1]) >= 2,
    `LIVE_MS must span at least two heartbeats (found ${beats![1]}) — a live session refreshes at ` +
      "most every BEAT_EVERY_MS, so a narrower window reads a live holder as crashed",
  );
}

export function runSessionLockStalenessIsAgeTests() {
  testTheHookDecidesByAge();
  testNoShippedTextTeachesThePidRule();
  testTheHeartbeatIsWired();

  const root = mkdtempSync(join(tmpdir(), "phx-session-lock-"));
  try {
    testALiveLongSessionStillWarnsASecondOne(root);
    testABeatNeverTakesAFreshLockAndReclaimsAStaleOne(root);
    testTheLockIsPerFolder(root);
    testAProvablyLiveLockIsolatesInsteadOfAsking(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
