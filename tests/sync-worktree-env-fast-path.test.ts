import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { gitLayout } from "../scripts/lib/git-layout.mjs";

// The SessionStart fast paths of scripts/sync-worktree-env.mjs (2026-10-09, hook speed fixes).
//
// It runs at EVERY Phoenix session start. Until 2026-10-09 that was `--all` behind a bash
// one-liner: two `git rev-parse` processes before it even knew where it was, one
// `git check-ignore` PER env file in the primary (7 of them), then a sweep of every other worktree
// on the machine — all while the session waited (p50 1.7 s, worst 17.6 s). It is now two entries:
// a BLOCKING `--hook` run for the session's own folder and an ASYNC `--sweep-only` for the rest.
// "It still works, just slower" is invisible to a test that only reads output, so this drives the
// real script against throwaway repos under tests/support/spawn-probe.mjs, which records every
// process the script starts, and pins:
//   1. in the PRIMARY, the no-flag and --hook runs start NO process and print the same line,
//   2. in a WORKTREE, exactly the gitignored .env files are copied — never *.example, never one
//      git does not call ignored — with ONE check-ignore and no rev-parse,
//   3. --sweep-only provisions a SIBLING and leaves its own folder — env, node_modules and
//      settings.local.json — exactly as it was, however the folder's path is cased,
//   4. a primary with no ignored .env file (check-ignore exits 1) is an answer, not a crash,
//   5. outside any repository, --sweep-only and --hook exit 0 with one stderr line, while the
//      no-flag run new-session.mjs relies on still exits non-zero,
//   6. a THROWN error, not only a fail() path, is fail-open under --hook the same way.

const SCRIPT = path.resolve("scripts/sync-worktree-env.mjs");
const PROBE = pathToFileURL(path.resolve("tests/support/spawn-probe.mjs")).href;
const NOTHING_TO_SYNC = "sync-worktree-env: this IS the primary worktree — nothing to sync.";

// The env of every child: no GIT_DIR and friends (a test run from inside a git hook would
// otherwise point git — and gitLayout's null fallback — at the real repo), and a throwaway home
// so the script's memory lookup never reads the real ~/.claude.
function childEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  for (const k of Object.keys(env)) {
    if (env[k] === undefined || /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CEILING_DIRECTORIES|PREFIX)$/.test(k)) delete env[k];
  }
  return env;
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: childEnv(os.homedir()) });
}

function runSync(cwd: string, home: string, args: string[], { probeOut, extraEnv = {} }: { probeOut?: string; extraEnv?: Record<string, string> } = {}) {
  const nodeArgs = probeOut ? ["--import", PROBE, SCRIPT, ...args] : [SCRIPT, ...args];
  const env = childEnv(home, probeOut ? { ...extraEnv, SPAWN_PROBE_OUT: probeOut } : extraEnv);
  const r = spawnSync(process.execPath, nodeArgs, { cwd, env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function probeCalls(file: string): { kind: string; what: string }[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const lines = (text: string) => text.split(/\r?\n/).filter((l) => l.trim() !== "");

// A throwaway primary with three gitignored env files, an ignored-but-*.example template, an env
// file git does NOT ignore, a real node_modules and its own settings.local.json — plus `count`
// linked worktrees of it, each a sibling folder exactly like this repo's `_wt-<task>` ones.
function makeFixture(root: string, names: string[]) {
  const primary = path.join(root, "primary");
  git(root, ["init", "-q", "-b", "main", primary]);
  git(primary, ["config", "user.email", "test@example.com"]);
  git(primary, ["config", "user.name", "Sync Fast Path Test"]);
  git(primary, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(primary, ".gitignore"), ".env*\n!.env.notignored\nnode_modules/\n.claude/settings.local.json*\n");
  fs.writeFileSync(path.join(primary, "keep.txt"), "seed\n");
  git(primary, ["add", "."]);
  git(primary, ["commit", "-q", "-m", "seed"]);
  const worktrees: Record<string, string> = {};
  for (const name of names) {
    worktrees[name] = path.join(root, name);
    git(primary, ["worktree", "add", "-q", "-b", name, worktrees[name]]);
  }
  return { primary, worktrees };
}

const IGNORED = [".env.analytics", ".env.local", ".env.production.rls.local"];
const NOT_COPIED = [".env.local.example", ".env.notignored"];

export function runSyncWorktreeEnvFastPathTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swe-fast-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  try {
    const { primary, worktrees } = makeFixture(root, ["_wt-a", "_wt-b", "_wt-c", "_wt-d"]);
    for (const name of [...IGNORED, ...NOT_COPIED]) fs.writeFileSync(path.join(primary, name), `FROM_PRIMARY=${name}\n`);
    fs.mkdirSync(path.join(primary, "node_modules", "some-dep"), { recursive: true });
    fs.writeFileSync(path.join(primary, "node_modules", "some-dep", "index.js"), "module.exports = 7;\n");
    fs.mkdirSync(path.join(primary, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(primary, ".claude", "settings.local.json"), '{"permissions":{"allow":["Bash(ls)"]}}\n');

    // Precondition: the folders read as git lays them out, so the fast path is what runs.
    assert.equal(gitLayout(primary)?.linked, false, "precondition: the fixture primary reads as a primary checkout");
    assert.equal(gitLayout(worktrees["_wt-a"])?.linked, true, "precondition: the fixture worktree reads as a linked worktree");

    // ── 1. The PRIMARY: same line, no process at all — no-flag and --hook alike ──
    for (const flags of [[], ["--hook"]]) {
      const probeOut = path.join(root, `probe-primary${flags.join("")}.jsonl`);
      const r = runSync(primary, home, flags, { probeOut });
      assert.equal(r.status, 0, `primary ${flags.join(" ") || "no-flag"} run must exit 0 (stderr: ${r.stderr})`);
      assert.deepEqual(lines(r.stdout), [NOTHING_TO_SYNC], "the primary prints exactly the old 'nothing to sync' line");
      assert.deepEqual(
        probeCalls(probeOut),
        [],
        "a session start in the PRIMARY must start NO process — read the layout off disk, not with git rev-parse",
      );
    }

    // ── 2. A WORKTREE: exactly the ignored env files, ONE check-ignore, no rev-parse ──
    {
      const wt = worktrees["_wt-a"];
      const probeOut = path.join(root, "probe-wt-a.jsonl");
      const r = runSync(wt, home, [], { probeOut });
      assert.equal(r.status, 0, `worktree no-flag run must exit 0 (stderr: ${r.stderr})`);
      for (const name of IGNORED) {
        assert.equal(
          fs.readFileSync(path.join(wt, name), "utf8"),
          `FROM_PRIMARY=${name}\n`,
          `${name} is gitignored in the primary and must be copied into the worktree`,
        );
      }
      for (const name of NOT_COPIED) {
        assert.equal(fs.existsSync(path.join(wt, name)), false, `${name} must NOT be copied (a *.example, or not gitignored)`);
      }
      const out = lines(r.stdout);
      assert.deepEqual(
        out.filter((l) => l.trim().startsWith("copied ")).map((l) => l.trim().split(" ")[1]),
        IGNORED,
        "the copied lines name exactly the ignored env files, in sorted order",
      );
      assert.equal(out.at(-1), "sync-worktree-env: done — 3 copied, 0 skipped.", "the closing line is unchanged");

      const gitCalls = probeCalls(probeOut).filter((c) => /^git\b/.test(c.what));
      assert.equal(
        gitCalls.filter((c) => c.what.includes("check-ignore")).length,
        1,
        `ONE git check-ignore for every candidate, never one per file — got: ${JSON.stringify(gitCalls)}`,
      );
      assert.equal(
        gitCalls.filter((c) => c.what.includes("rev-parse")).length,
        0,
        `the common dir and toplevel come off disk, not from git rev-parse — got: ${JSON.stringify(gitCalls)}`,
      );
      assert.equal(gitCalls.length, 1, `check-ignore is the only git process a worktree start needs — got: ${JSON.stringify(gitCalls)}`);
    }

    // ── 3. --sweep-only provisions a SIBLING and never touches its own folder ──
    {
      const own = worktrees["_wt-b"];
      const sibling = worktrees["_wt-c"];
      const ownSettings = path.join(own, ".claude", "settings.local.json");
      fs.mkdirSync(path.dirname(ownSettings), { recursive: true });
      // Differs from the primary's, so a no-flag run WOULD rewrite it and leave a .bak-prev.
      const before = Buffer.from('{\n  "permissions": { "allow": ["Bash(git push *)"] }\n}\n');
      fs.writeFileSync(ownSettings, before);

      const r = runSync(own, home, ["--sweep-only"]);
      assert.equal(r.status, 0, `--sweep-only must exit 0 (stderr: ${r.stderr})`);
      assert.ok(fs.readFileSync(ownSettings).equals(before), "--sweep-only must leave its own settings.local.json byte-identical");
      assert.equal(fs.existsSync(ownSettings + ".bak-prev"), false, "--sweep-only must not even back its own settings up");
      assert.equal(fs.existsSync(path.join(own, ".env.local")), false, "--sweep-only must not copy env into its own folder");
      assert.throws(() => fs.lstatSync(path.join(own, "node_modules")), "--sweep-only must not link its own node_modules");

      const siblingEnv = path.join(sibling, ".env.local");
      const siblingDep = path.join(sibling, "node_modules", "some-dep", "index.js");
      assert.ok(fs.existsSync(siblingEnv), "--sweep-only must still copy a SIBLING worktree's missing .env");
      assert.equal(fs.readFileSync(siblingEnv, "utf8"), "FROM_PRIMARY=.env.local\n", "the sibling's .env is the primary's");
      assert.ok(fs.existsSync(siblingDep), "--sweep-only must still junction a SIBLING worktree's node_modules");
      assert.equal(fs.readFileSync(siblingDep, "utf8"), "module.exports = 7;\n", "the sibling's junction resolves to the primary's");
      assert.ok(lines(r.stdout).some((l) => l.includes("sweep _wt-c:")), `the sweep reports the sibling it provisioned:\n${r.stdout}`);

      // The session's folder can reach the script spelled differently from `git worktree list`
      // (drive-letter or path case on Windows); the sweep must still recognise it as its own.
      if (process.platform === "win32") {
        const again = runSync(own.toUpperCase(), home, ["--sweep-only"]);
        assert.equal(again.status, 0, `--sweep-only from a re-cased path must exit 0 (stderr: ${again.stderr})`);
        assert.equal(
          fs.existsSync(path.join(own, ".env.local")),
          false,
          "--sweep-only must skip its own folder even when the path reaches it in a different case",
        );
      }
    }

    // ── 4. No env file is ignored (check-ignore exits 1): an answer, not a crash ──
    {
      const bare = path.join(root, "noignore");
      fs.mkdirSync(bare);
      const fx = makeFixture(bare, ["_wt-x"]);
      fs.writeFileSync(path.join(fx.primary, ".env.notignored"), "PLAIN=1\n");
      const r = runSync(fx.worktrees["_wt-x"], home, []);
      assert.equal(r.status, 0, `a primary whose env files are all un-ignored must still sync cleanly (stderr: ${r.stderr})`);
      assert.ok(
        lines(r.stdout).includes("  (no local env files found in the primary worktree)"),
        `check-ignore exiting 1 means 'none ignored':\n${r.stdout}`,
      );
      assert.equal(fs.existsSync(path.join(fx.worktrees["_wt-x"], ".env.notignored")), false, "an un-ignored env file is never copied");
    }

    // ── 5. Outside any repository: the hook entries fail OPEN, the no-flag run does not ──
    {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "swe-outside-"));
      try {
        // gitLayout walks to the drive root; a repo above tmp would make this sweep a REAL repo.
        assert.equal(gitLayout(outside), null, `precondition: ${outside} must not be inside any git repository`);
        const extraEnv = { GIT_CEILING_DIRECTORIES: path.dirname(outside) };
        for (const flag of ["--sweep-only", "--hook"]) {
          const r = runSync(outside, home, [flag], { extraEnv });
          assert.equal(r.status, 0, `${flag} outside a repository must exit 0 (fail-open), got ${r.status}: ${r.stderr}`);
          assert.equal(lines(r.stderr).length, 1, `${flag} outside a repository prints ONE stderr line, got:\n${r.stderr}`);
        }
        const plain = runSync(outside, home, [], { extraEnv });
        assert.notEqual(plain.status, 0, "the no-flag run outside a repository must still fail — new-session.mjs reads that exit code");
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }

    // ── 6. A THROWN error (not a fail() path) is fail-open under --hook too ──
    //
    // `.claude` is a plain file here, so writing settings.local.json throws ENOTDIR/EEXIST.
    {
      const wt = worktrees["_wt-d"];
      fs.writeFileSync(path.join(wt, ".claude"), "not a folder\n");
      const r = runSync(wt, home, ["--hook"]);
      assert.equal(r.status, 0, `--hook must exit 0 when the sync throws, got ${r.status}: ${r.stderr}`);
      assert.equal(lines(r.stderr).length, 1, `--hook prints ONE stderr line for a thrown error, got:\n${r.stderr}`);
      const plain = runSync(wt, home, []);
      assert.notEqual(plain.status, 0, "the no-flag run must still fail when the sync throws");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
