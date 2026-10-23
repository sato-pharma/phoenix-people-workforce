// bash-guard C20: a push that touches `.claude/` must carry a FRESH cloud mirror (owner, 2026-10-23
// — "make it mechanical", after "refresh the cloud mirror in the next PR that touches .claude").
//
// `.claude/cloud-context/memory-mirror/` IS the Phoenix memory a cloud session wakes up with, because
// a cloud clone never sees `~/.claude`. It is therefore only ever as fresh as its last MERGED
// refresh, and the drift was measured but never acted on: on 2026-10-02 the mirror still told a cloud
// session an `analytics.sos_fact` price gap was OPEN, 86 minutes after it was fixed and shipped. The
// clause makes the PR that already touches `.claude/` carry the refresh.
//
// 🔴 THE READING IS TAKEN AGAINST THE MIRROR IN **HEAD**, WHICH IS WHAT MAKES THE REFUSAL FIXABLE —
// the case that proves it is `a refresh committed here clears the refusal`. Keyed off `origin/main`
// or off the 24-hour SessionStart cache, the refusal would survive the fix and the guard would be
// switched off within the hour.
//
// Hermetic: every case builds its own bare origin plus work repo and its own memory directory under
// `CLAUDE_CONFIG_DIR`, so the suite never reads the laptop's real memory and passes on a CI runner
// that has none. It drives the real hook as a subprocess, the way settings.json runs it.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");

const MIRROR_DIR = ".claude/cloud-context/memory-mirror";
const NOTE = "note-one.md";
/** What the mirror committed in the fixture holds. A live copy differing from this IS the drift. */
const MIRROR_TEXT = "the mirrored copy, as a cloud session would read it\n";

type Decision = { decision: "allow" | "deny"; reason: string };

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"], timeout: 60000 });
}

function write(root: string, rel: string, text: string): void {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

/**
 * A work repo on a branch off `origin/main`, plus the memory directory the guard will resolve for
 * it. `touches` is the file the branch commit adds — that is what decides whether C20 looks at all.
 *
 * The memory copy of {@link NOTE} is written with `liveText`: equal to {@link MIRROR_TEXT} for a
 * fresh mirror, different for a stale one, and `null` for a machine with no memory directory at all
 * (a cloud runner), which must fail open.
 */
function fixture(
  liveText: string | null,
  touches = ".claude/hooks/placeholder.md",
  { refreshOnBranch = false }: { refreshOnBranch?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "phx-mirror-guard-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const config = join(root, "config");

  mkdirSync(origin, { recursive: true });
  git(origin, ["init", "--bare", "-b", "main"]);
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-b", "main"]);
  git(work, ["config", "user.email", "fixture@example.invalid"]);
  git(work, ["config", "user.name", "Fixture"]);
  git(work, ["config", "commit.gpgsign", "false"]);

  // `scripts/sync-cloud-context.mjs` is how the clause recognises THIS repo, and the mirror is what
  // it compares. Both must exist on `main` so the branch is measured against them.
  write(work, "scripts/sync-cloud-context.mjs", "// stub: the command the refusal names\n");
  write(work, `${MIRROR_DIR}/${NOTE}`, MIRROR_TEXT);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "base"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-u", "origin", "main"]);

  git(work, ["switch", "-c", "codex/probe"]);
  write(work, touches, "a change this branch adds\n");
  // The refresh as a session would commit it: `main`'s mirror stays behind, the BRANCH's is current.
  // That is the one state that tells `ref: "HEAD"` apart from `ref: "origin/main"`.
  if (refreshOnBranch && liveText !== null) write(work, `${MIRROR_DIR}/${NOTE}`, liveText);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "the branch change"]);

  if (liveText !== null) {
    const slug = resolve(work).replace(/[^A-Za-z0-9]/g, "-");
    write(config, join("projects", slug, "memory", NOTE), liveText);
  } else {
    mkdirSync(config, { recursive: true });
  }

  return { root, work, config };
}

function runGuard(
  work: string,
  config: string,
  command = "git push -u origin codex/probe",
  tool = "Bash",
): Decision {
  // Annotated, not inferred: Next augments NodeJS.ProcessEnv, so a bare object literal is typed as
  // exactly the keys written here and `delete env.CLAUDE_PROJECT_DIR` is then TS2339 (checks/Typecheck
  // red on 2e06e88df). `tests/ci-eslint-cache-node-runtime.test.ts` carries the same annotation.
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: config };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_MIRROR_OK;
  const raw = execFileSync(process.execPath, [guardPath], {
    cwd: work,
    input: JSON.stringify({ tool_name: tool, cwd: work, tool_input: { command } }),
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });
  if (!raw.trim()) return { decision: "allow", reason: "" };
  const start = raw.indexOf('{"hookSpecificOutput"');
  assert.ok(start >= 0, `hook emitted something that is not a decision:\n${raw}`);
  const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return { decision: output.permissionDecision, reason: String(output.permissionDecisionReason ?? "") };
}

export function runCloudMirrorPushGuardTests(): void {
  // 1. The refusal: a `.claude` push whose mirror is behind the live memory.
  {
    const { root, work, config } = fixture("the live copy, written after the last refresh\n");
    try {
      const result = runGuard(work, config);
      assert.equal(
        result.decision,
        "deny",
        `C20 must refuse a .claude push whose mirror has drifted; got: ${result.reason}`,
      );
      assert.match(result.reason, /^C20 /, "the refusal must name its clause");
      assert.ok(
        result.reason.includes(NOTE),
        `the refusal must NAME the drifted file, not just count it — a count is not actionable:\n${result.reason}`,
      );
      assert.ok(
        result.reason.includes("node scripts/sync-cloud-context.mjs"),
        "the refusal must carry the one command that fixes it",
      );
      assert.match(result.reason, /PHX_MIRROR_OK=1 </, "the refusal must carry its stand-down");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 2. A refresh committed ON THE BRANCH clears the refusal, while `origin/main` is still behind.
  //    🔴 THIS IS THE CASE THAT PINS THE REF, and the only one that can: with the mirror current
  //    everywhere, HEAD and origin/main give the same answer and the assertion proves nothing —
  //    measured 2026-10-23, when flipping the clause to `ref: "origin/main"` left the whole suite
  //    green. Here `main` holds MIRROR_TEXT, the branch holds the live text, so reading origin/main
  //    refuses a push that HAS been fixed — which is the refusal nobody could clear.
  {
    const live = "the live copy, written after the last refresh\n";
    const { root, work, config } = fixture(live, ".claude/hooks/placeholder.md", { refreshOnBranch: true });
    try {
      const result = runGuard(work, config);
      assert.equal(
        result.decision,
        "allow",
        "a refresh committed on the branch must clear the refusal even while origin/main is still " +
          `behind — otherwise the clause cannot be satisfied at all; got: ${result.reason}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 2b. The plain case: current everywhere, nothing to say.
  {
    const { root, work, config } = fixture(MIRROR_TEXT);
    try {
      const result = runGuard(work, config);
      assert.equal(
        result.decision,
        "allow",
        `a .claude push carrying a current mirror must pass; got: ${result.reason}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 3. Narrow on purpose: a push that touches nothing under `.claude/` is none of this clause's
  //    business, however stale the mirror is. Without this the clause would refuse every push on the
  //    machine, which is the shape of guard that gets switched off.
  {
    const { root, work, config } = fixture("the live copy, nothing like the mirror\n", "src/lib/thing.ts");
    try {
      const result = runGuard(work, config);
      assert.equal(
        result.decision,
        "allow",
        `a push touching no .claude file must pass even with a stale mirror; got: ${result.reason}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 4. The stand-down, for a `.claude` change that has to go out before the refresh.
  {
    const { root, work, config } = fixture("the live copy, nothing like the mirror\n");
    try {
      for (const command of [
        "PHX_MIRROR_OK=1 git push -u origin codex/probe",
        "$env:PHX_MIRROR_OK=1; git push -u origin codex/probe",
      ]) {
        const result = runGuard(work, config, command);
        assert.equal(result.decision, "allow", `the stand-down must not be refused: ${command}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 5. Fails open where it cannot read: a cloud runner has no memory directory, so there is no live
  //    side to compare and the push is none of the clause's business. Every other reading in this
  //    hook fails open the same way, and a guard that refused here would block every cloud push.
  {
    const { root, work, config } = fixture(null);
    try {
      const result = runGuard(work, config);
      assert.equal(
        result.decision,
        "allow",
        `with no memory directory the clause must fail open; got: ${result.reason}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 6. A dry run sends nothing, so it is never refused.
  {
    const { root, work, config } = fixture("the live copy, nothing like the mirror\n");
    try {
      const result = runGuard(work, config, "git push --dry-run -u origin codex/probe");
      assert.equal(result.decision, "allow", `a --dry-run push must pass; got: ${result.reason}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
