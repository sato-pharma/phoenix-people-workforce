import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Every trap cluster must be REACHABLE — some command a session really runs has to deliver it.
 *
 * WHY THIS EXISTS. AGENTS.md §2.1 moved its traps into `docs/agents-session-traps-clusters.md` on
 * 2026-09-12, and `.claude/hooks/trap-injector.mjs` delivers a cluster only when a command matches
 * one of its `RULES`. A cluster with no rule is never delivered to anyone, and the hook says nothing
 * about it — it fails open and silent by design. That is exactly what happened to **Parallel
 * sessions**: it had no rule from the day it moved until 2026-09-17, so its "one approval can reach
 * several sessions" trap never reached a session about to merge.
 *
 * So this runs the real hook, as settings.json runs it, once per cluster heading in the doc, and
 * fails on any heading that no sample command delivers. A new cluster needs a rule in the hook AND
 * a sample here.
 */

const HOOK = resolve(".claude/hooks/trap-injector.mjs");
const CLUSTERS_DOC = "docs/agents-session-traps-clusters.md";

/** A command a session would really run for each cluster — not a string built to match the regex. */
const SAMPLES: Record<string, string> = {
  "Shell and tooling": "sed -n 1,5p notes.txt",
  Git: "git status",
  "CI and PRs": "gh run list --limit 5",
  Migrations: "node scripts/check-migrations.mjs",
  "Database, grants and RLS": 'psql -c "select 1"',
  "Probing, attributing and reporting production": "railway status",
  Validation: "node --test tests/example.test.ts",
  "Memory and this index": "wc -c MEMORY.md",
  "Parallel sessions": "gh pr merge 3950",
  Worktrees: "git worktree list",
  "Next.js runtime": "next dev --webpack",
  "Browser and dev-auth": 'curl -H "x-phoenix-role: CEO" localhost:3000',
  "Machine ceiling": "Get-NetTCPConnection -LocalPort 3000",
};

/** The hook's own heading rule: a bold run alone on a line, optionally followed by a parenthetical. */
function headingsOf(doc: string): string[] {
  return doc
    .split(/\r?\n/)
    .map((line) => /^\*\*([A-Z][^*]{2,60})\*\*\s*(\(.*\))?\s*$/.exec(line)?.[1].trim())
    .filter((name): name is string => Boolean(name));
}

type Run = { home: string; projectDir?: string; cwd?: string; sessionId: string; command: string };

function runInjector({ home, projectDir, cwd, sessionId, command }: Run): string {
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, HOME: home };
  delete env.CLAUDE_PROJECT_DIR;
  if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir;
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, session_id: sessionId, cwd }),
    encoding: "utf8",
    env,
    timeout: 30000,
  });
  if (!out.trim()) return "";
  return String(JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? "");
}

const delivered = (context: string, cluster: string) => context.includes(`**${cluster}**\n`);

/** A folder shaped like a Claude Code worktree, holding only what the hook reads. */
function makeWorktree(root: string): string {
  const worktree = join(root, "primary", ".claude", "worktrees", "some-session");
  mkdirSync(join(worktree, "docs"), { recursive: true });
  copyFileSync(CLUSTERS_DOC, join(worktree, CLUSTERS_DOC));
  writeFileSync(join(worktree, "AGENTS.md"), "# stub — the hook only looks for this file to find the project\n");
  return worktree;
}

function testEveryClusterIsDelivered(root: string) {
  const headings = headingsOf(readFileSync(CLUSTERS_DOC, "utf8"));
  assert.ok(headings.length >= 13, `expected the thirteen clusters, parsed ${headings.length}`);

  const home = join(root, "home-every-cluster");
  mkdirSync(home);
  const worktree = makeWorktree(join(root, "every-cluster"));

  for (const cluster of headings) {
    const command = SAMPLES[cluster];
    assert.ok(
      command,
      `cluster "${cluster}" has no sample command here — add a rule for it to RULES in trap-injector.mjs `
        + "and a sample here, or no session will ever be shown it",
    );
    const context = runInjector({ home, projectDir: worktree, sessionId: `every-${cluster}`, command });
    assert.ok(
      delivered(context, cluster),
      `"${command}" must deliver the "${cluster}" cluster — no rule in trap-injector.mjs reaches it, `
        + "so it is never shown to any session",
    );
  }
}

function testOncePerSession(root: string) {
  const home = join(root, "home-once");
  mkdirSync(home);
  const worktree = makeWorktree(join(root, "once"));
  const first = runInjector({ home, projectDir: worktree, sessionId: "once", command: "gh pr merge 3950" });
  assert.ok(delivered(first, "Parallel sessions"), "the first merge of a session is shown the parallel-session traps");
  // A merge also matches CI and Git; at most two clusters go per call, so Git may follow on the next.
  assert.equal(
    delivered(runInjector({ home, projectDir: worktree, sessionId: "once", command: "gh pr merge 3951" }), "Parallel sessions"),
    false,
    "a cluster is delivered once per session, not on every call",
  );
  assert.equal(
    runInjector({ home, projectDir: worktree, sessionId: "once", command: "gh pr merge 3952" }),
    "",
    "once every cluster a command matches has been shown, the command adds nothing",
  );
}

function testItFindsTheProjectFromTheWorkingDirectory(root: string) {
  const home = join(root, "home-cwd");
  mkdirSync(home);
  const worktree = makeWorktree(join(root, "cwd"));
  const deep = join(worktree, "src", "lib");
  mkdirSync(deep, { recursive: true });
  assert.ok(
    delivered(runInjector({ home, cwd: deep, sessionId: "cwd", command: "git status" }), "Git"),
    "with no CLAUDE_PROJECT_DIR the hook walks up from the session's cwd to the worktree holding AGENTS.md",
  );
}

function testItStandsDownForARegisteredMachineCopy(root: string) {
  const home = join(root, "home-wired");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "node ~/.claude/hooks/trap-injector.mjs" }] }] } }),
  );
  const worktree = makeWorktree(join(root, "wired"));
  assert.equal(
    runInjector({ home, projectDir: worktree, sessionId: "wired", command: "git status" }),
    "",
    "when a user-level copy is registered the repo copy stands down, or every cluster arrives twice",
  );
}

function testItIsRegisteredWithATimeout() {
  const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
    hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; timeout?: number }> }>>;
  };
  const registered = Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((group) =>
      (group.hooks ?? [])
        .filter((h) => (h.command ?? "").includes("trap-injector.mjs"))
        .map((h) => ({ event, matcher: group.matcher ?? "", ...h })),
    ),
  );
  assert.equal(registered.length, 1, "trap-injector.mjs must be registered exactly once");
  const [hook] = registered;
  assert.equal(hook.event, "PreToolUse", "the injector reads the tool call, so it is a PreToolUse hook");
  assert.ok((hook.command ?? "").includes("${CLAUDE_PROJECT_DIR"), "it resolves the session's own worktree first");
  for (const tool of ["Bash", "PowerShell"]) {
    assert.ok(hook.matcher.split("|").includes(tool), `the injector must see ${tool} calls`);
  }
  assert.ok(
    typeof hook.timeout === "number" && hook.timeout > 0 && hook.timeout <= 30,
    "it runs before every matching tool call, so it needs a short explicit timeout",
  );
}

export function runTrapInjectorClustersTests() {
  testItIsRegisteredWithATimeout();

  const root = mkdtempSync(join(tmpdir(), "phx-trap-injector-"));
  try {
    testEveryClusterIsDelivered(root);
    testOncePerSession(root);
    testItFindsTheProjectFromTheWorkingDirectory(root);
    testItStandsDownForARegisteredMachineCopy(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
