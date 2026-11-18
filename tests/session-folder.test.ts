import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectSlug, sameFolder, sessionFolder, transcriptSlugs } from "../scripts/lib/session-folder.mjs";

/**
 * A hook acts on the folder its SESSION belongs to — in the desktop app too.
 *
 * WHY THIS EXISTS (2026-11-18, desktop-app audit). The folder-keyed hooks took CLAUDE_PROJECT_DIR as
 * "the session's own worktree". In the desktop app a session runs in its own
 * `.claude/worktrees/<name>` folder, but its hooks are handed the PRIMARY checkout as
 * CLAUDE_PROJECT_DIR and run with the primary as their working directory (measured: session-lock.mjs
 * printed the primary's path from inside a worktree session). So in every desktop session:
 *   - primary-write-guard.mjs allowed every write into every other session's worktree, because every
 *     worktree sits inside the primary it took as the session's own tree;
 *   - session-lock.mjs kept the PRIMARY's lock, and the app copies that lock into each new worktree,
 *     so each new session was told "another session is ACTIVE in this folder";
 *   - worktree-exit-guard.mjs saw the primary and stayed silent at every session end;
 *   - sync-worktree-env.mjs --hook said "this IS the primary — nothing to sync".
 *
 * Each case below drives the REAL hook as a subprocess the way the desktop app runs it: working
 * directory and CLAUDE_PROJECT_DIR both the primary, the payload's `transcript_path` filed under the
 * worktree's project slug. Point any of them back at CLAUDE_PROJECT_DIR and its case goes red.
 */

const ROOT = process.cwd();
const LOCK_HOOK = path.join(ROOT, ".claude", "hooks", "session-lock.mjs");
const WRITE_GUARD = path.join(ROOT, ".claude", "hooks", "primary-write-guard.mjs");
const EXIT_GUARD = path.join(ROOT, ".claude", "hooks", "worktree-exit-guard.mjs");
const ENV_SYNC = path.join(ROOT, "scripts", "sync-worktree-env.mjs");
const DISPATCHER = path.join(ROOT, ".claude", "hooks", "hook-dispatch.mjs");
const DISPATCH_WORKER = path.join(ROOT, ".claude", "hooks", "hook-dispatch-worker.mjs");

function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  for (const k of Object.keys(env)) {
    if (env[k] === undefined || /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CEILING_DIRECTORIES|PREFIX)$/.test(k)) delete env[k];
    if (/^PHX_.*_OFF$/.test(k)) delete env[k];
  }
  return env;
}

function git(cwd: string, args: string[], home: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cleanEnv(home) });
}

/** A primary with two app-style worktrees INSIDE it, as `.claude/worktrees/<name>` — the desktop layout. */
function makeFixture(root: string, home: string) {
  const primary = path.join(root, "primary");
  git(root, ["init", "-q", "-b", "main", primary], home);
  git(primary, ["config", "user.email", "test@example.com"], home);
  git(primary, ["config", "user.name", "Session Folder Test"], home);
  git(primary, ["config", "commit.gpgsign", "false"], home);
  fs.writeFileSync(path.join(primary, ".gitignore"), ".env*\nnode_modules/\n.claude/\n");
  fs.writeFileSync(path.join(primary, "keep.txt"), "seed\n");
  git(primary, ["add", "."], home);
  git(primary, ["commit", "-q", "-m", "seed"], home);
  const mine = path.join(primary, ".claude", "worktrees", "mine");
  const theirs = path.join(primary, ".claude", "worktrees", "theirs");
  git(primary, ["worktree", "add", "-q", "-b", "claude/mine", mine], home);
  git(primary, ["worktree", "add", "-q", "-b", "claude/theirs", theirs], home);
  return { primary, mine, theirs };
}

/** The payload a hook of a session that STARTED in `folder` receives; `cwd` is wherever it stands now. */
function payloadFor(root: string, folder: string, extra: Record<string, unknown> = {}) {
  const transcript = path.join(root, "config", "projects", projectSlug(folder), "6f1c2d3e.jsonl");
  return { session_id: "me", transcript_path: transcript, cwd: folder, ...extra };
}

/** Runs a hook the way the desktop app does: cwd and CLAUDE_PROJECT_DIR are the PRIMARY. */
function runHook(script: string, args: string[], primary: string, home: string, payload: unknown) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: primary,
    env: cleanEnv(home, { CLAUDE_PROJECT_DIR: primary }),
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 60000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const lockPath = (folder: string) => path.join(folder, ".claude", "session.lock");
const readLock = (folder: string) => JSON.parse(fs.readFileSync(lockPath(folder), "utf8"));

function testTheSlugIsClaudeCodesOwn() {
  // Read off this laptop on 2026-11-18: the session's transcript folder for its worktree.
  assert.equal(
    projectSlug("F:\\Phoenix Workforce\\phoenix-workforce\\.claude\\worktrees\\password-change-data-leak-c6b1b5"),
    "F--Phoenix-Workforce-phoenix-workforce--claude-worktrees-password-change-data-leak-c6b1b5",
  );
  assert.equal(projectSlug("/home/user/phoenix-people-workforce"), "-home-user-phoenix-people-workforce");
  const slugs = transcriptSlugs("C:\\Users\\x\\.claude\\projects\\F--A-b\\9c1e\\subagents\\agent-1.jsonl");
  assert.ok(slugs.has("f--a-b"), "a subagent's transcript, filed deeper under the same slug folder, still names it");
  assert.equal(transcriptSlugs(undefined).size, 0);
  assert.ok(sameFolder("C:/A/b/", "c:\\a\\B"), "one folder written two ways is one folder");
  assert.ok(!sameFolder("C:/A/b", "C:/A/bc"));
}

function testTheResolver(root: string, fx: ReturnType<typeof makeFixture>) {
  const desktop = { env: { CLAUDE_PROJECT_DIR: fx.primary }, cwd: fx.primary };
  const same = (got: string, want: string, why: string) => assert.ok(sameFolder(got, want), `${why}: got ${got}, want ${want}`);

  same(sessionFolder(payloadFor(root, fx.mine), desktop), fx.mine, "a desktop session resolves to its own worktree, not CLAUDE_PROJECT_DIR");
  same(
    sessionFolder(payloadFor(root, fx.mine, { cwd: fx.primary }), desktop),
    fx.mine,
    "a session that cd-ed into the primary still resolves to the worktree it started in",
  );
  same(
    sessionFolder(payloadFor(root, fx.mine, { cwd: fx.theirs }), desktop),
    fx.mine,
    "a session standing in another worktree still resolves to its own",
  );
  const upper = payloadFor(root, fx.mine);
  upper.transcript_path = upper.transcript_path.replace(projectSlug(fx.mine), projectSlug(fx.mine).toUpperCase());
  same(sessionFolder(upper, desktop), fx.mine, "the slug is matched without regard to letter case");
  same(sessionFolder(payloadFor(root, fx.primary), desktop), fx.primary, "a session started in the primary resolves to the primary");
  const sub = path.join(fx.mine, "src");
  fs.mkdirSync(sub, { recursive: true });
  same(sessionFolder(payloadFor(root, sub), desktop), fx.mine, "a session started in a subfolder answers with its checkout's root");
  same(sessionFolder({ session_id: "me" }, desktop), fx.primary, "no transcript path: CLAUDE_PROJECT_DIR, as before");
  same(sessionFolder({}, { env: {}, cwd: fx.theirs }), fx.theirs, "no transcript path and no CLAUDE_PROJECT_DIR: the working directory");
}

function testTheLockIsTheWorktrees(root: string, home: string, fx: ReturnType<typeof makeFixture>) {
  const r = runHook(LOCK_HOOK, ["start"], fx.primary, home, payloadFor(root, fx.mine));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(lockPath(fx.mine)), "the desktop session's lock is written in its own worktree");
  assert.equal(fs.existsSync(lockPath(fx.primary)), false, "and the primary's lock is never touched by it");
  assert.equal(readLock(fx.mine).sessionId, "me");
  assert.ok(sameFolder(readLock(fx.mine).folder, fx.mine), "the lock names the folder it belongs to");
  fs.rmSync(lockPath(fx.mine));
}

function testACopiedLockIsNoLock(root: string, home: string, fx: ReturnType<typeof makeFixture>) {
  const fresh = { pid: 1, host: "h", sessionId: "them", startedAt: new Date().toISOString(), refreshedAt: new Date().toISOString() };
  // What the app does to a new worktree: the primary's gitignored .claude files, the lock among them.
  fs.mkdirSync(path.dirname(lockPath(fx.primary)), { recursive: true });
  fs.mkdirSync(path.dirname(lockPath(fx.mine)), { recursive: true });
  const primaryLock = JSON.stringify({ ...fresh, folder: fx.primary });
  fs.writeFileSync(lockPath(fx.primary), primaryLock);
  fs.writeFileSync(lockPath(fx.mine), primaryLock);

  const r = runHook(LOCK_HOOK, ["start"], fx.primary, home, payloadFor(root, fx.mine));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /ACTIVE|may still be/, "a copy of the primary's lock must not tell a new worktree session it is shared");
  assert.equal(readLock(fx.mine).sessionId, "me", "the session takes its own folder's lock");
  assert.equal(fs.readFileSync(lockPath(fx.primary), "utf8"), primaryLock, "the primary's real lock is left exactly as it was");

  // A lock an older hook wrote carries no folder, and it is read exactly as before: still a warning.
  fs.writeFileSync(lockPath(fx.mine), JSON.stringify(fresh));
  const old = runHook(LOCK_HOOK, ["start"], fx.primary, home, payloadFor(root, fx.mine));
  assert.match(old.stdout, /ACTIVE/, "a live lock with no folder still warns");
  fs.rmSync(lockPath(fx.mine));
  fs.rmSync(lockPath(fx.primary));
}

function testTheWriteGuardKnowsItsTree(root: string, home: string, fx: ReturnType<typeof makeFixture>) {
  const write = (target: string) =>
    runHook(WRITE_GUARD, [], fx.primary, home, payloadFor(root, fx.mine, { tool_name: "Write", tool_input: { file_path: target } }));
  const denied = (r: { stdout: string }) => /"permissionDecision":"deny"/.test(r.stdout);

  const into = write(path.join(fx.theirs, "keep.txt"));
  assert.equal(into.status, 0, into.stderr);
  assert.ok(denied(into), "a desktop session writing into another session's worktree is denied");
  assert.ok(denied(write(path.join(fx.primary, "keep.txt"))), "and so is a write into the primary checkout");
  assert.ok(!denied(write(path.join(fx.mine, "keep.txt"))), "a write into its own worktree goes through");
}

function testTheExitGuardSpeaks(root: string, home: string, fx: ReturnType<typeof makeFixture>) {
  fs.writeFileSync(path.join(fx.mine, "unsaved.txt"), "work\n");
  const r = runHook(EXIT_GUARD, [], fx.primary, home, { ...payloadFor(root, fx.mine), hook_event_name: "SessionEnd" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /uncommitted/, "a desktop session ending with uncommitted work is told so");
  fs.rmSync(path.join(fx.mine, "unsaved.txt"));
}

function testTheEnvSyncFindsTheWorktree(root: string, home: string, fx: ReturnType<typeof makeFixture>) {
  fs.writeFileSync(path.join(fx.primary, ".env.local"), "FROM_PRIMARY=1\n");
  const r = runHook(ENV_SYNC, ["--hook"], fx.primary, home, { ...payloadFor(root, fx.theirs), hook_event_name: "SessionStart" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /this IS the primary/, "a desktop session in a worktree is not told it is the primary");
  assert.equal(
    fs.readFileSync(path.join(fx.theirs, ".env.local"), "utf8"),
    "FROM_PRIMARY=1\n",
    "the session's own worktree receives the primary's env file",
  );
}

function testABrokenRunnerSaysSo(root: string) {
  const dir = path.join(root, "runner");
  fs.mkdirSync(dir);
  fs.copyFileSync(DISPATCHER, path.join(dir, "hook-dispatch.mjs"));
  fs.copyFileSync(DISPATCH_WORKER, path.join(dir, "hook-dispatch-worker.mjs"));
  const r = spawnSync(process.execPath, [path.join(dir, "hook-dispatch.mjs"), "PreToolUse"], {
    input: "{}",
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(r.status, 0, "a runner that cannot read its table still never refuses the tool call");
  const out = JSON.parse(r.stdout || "{}");
  assert.match(String(out.systemMessage ?? ""), /could not read dispatch\.json/, "but it says so instead of exiting silently");
}

export function runSessionFolderTests() {
  testTheSlugIsClaudeCodesOwn();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phx-session-folder-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  try {
    const fx = makeFixture(root, home);
    testTheResolver(root, fx);
    testTheLockIsTheWorktrees(root, home, fx);
    testACopiedLockIsNoLock(root, home, fx);
    testTheWriteGuardKnowsItsTree(root, home, fx);
    testTheExitGuardSpeaks(root, home, fx);
    testTheEnvSyncFindsTheWorktree(root, home, fx);
    testABrokenRunnerSaysSo(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
