import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { stripComments } from "./support/comment-strip.ts";
import { wiredHookEvents, wiredHookGroups } from "./support/hook-wiring.ts";

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
  // The launcher, not a raw `next dev`: bash-guard C7 refuses that form since 2026-09-21.
  "Next.js runtime": "node scripts/dev-server.mjs --port 3000",
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

type Run = {
  home: string;
  projectDir?: string;
  cwd?: string;
  sessionId: string;
  command?: string;
  /** Defaults to Bash. The browser-pane tools became real callers on 2026-09-29. */
  toolName?: string;
  /** A pane call's own input — a url, or nothing at all for `computer` / `javascript_tool`. */
  toolInput?: Record<string, unknown>;
};

function runInjector({ home, projectDir, cwd, sessionId, command, toolName, toolInput }: Run): string {
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, HOME: home };
  delete env.CLAUDE_PROJECT_DIR;
  if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir;
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: toolName ?? "Bash",
      tool_input: toolInput ?? { command },
      session_id: sessionId,
      cwd,
    }),
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

/**
 * 🔴 A BROWSER-PANE CALL MUST DELIVER THE BROWSER CLUSTER.
 *
 * Until 2026-09-29 the hook exited immediately for any tool outside
 * `Bash|PowerShell|Grep|Glob|Edit|Write`, so the cluster whose entire subject is driving a browser
 * was reachable only from a SHELL command that happened to mention one of its words. A session
 * actually driving the pane — the one session that needs it — got nothing.
 *
 * What that cost, measured: the pane cannot set request headers, so `x-phoenix-role` is unreachable
 * from it and a role-gated page appears impossible to open. The clusters doc says exactly how to get
 * in (`GET /api/dev-auth?role=…`, which mints the cookie the browser CAN carry) — and a session hit
 * the wall, wrote "NOT yet measured live" into a commit, and parked the measurement for three days
 * with the answer already written down. A trap nobody is handed is a trap nobody has.
 *
 * Two shapes have to work, because a pane call frequently carries no command and no url at all:
 * a `navigate` with a url, and a `javascript_tool` with neither.
 */
function testABrowserPaneCallIsShownTheBrowserTraps(root: string) {
  const home = join(root, "home-pane");
  mkdirSync(home);
  const worktree = makeWorktree(join(root, "pane"));

  const withUrl = runInjector({
    home,
    projectDir: worktree,
    sessionId: "pane-navigate",
    toolName: "mcp__Claude_Browser__navigate",
    toolInput: { url: "http://localhost:3001/admin/outstation/expenses" },
  });
  assert.ok(
    delivered(withUrl, "Browser and dev-auth"),
    "a pane `navigate` must be shown the browser traps — it is the call that walks into the "
      + "headers-cannot-be-set wall",
  );

  const withNothing = runInjector({
    home: join(root, "home-pane-2"),
    projectDir: worktree,
    sessionId: "pane-js",
    toolName: "mcp__Claude_Browser__javascript_tool",
    toolInput: { action: "javascript_exec", text: "document.title" },
  });
  assert.ok(
    delivered(withNothing, "Browser and dev-auth"),
    "and so must a pane call carrying NEITHER a command nor a url — matching on arguments alone let "
      + "`javascript_tool`, `computer` and `resize_window` through with nothing delivered",
  );

  const chrome = runInjector({
    home: join(root, "home-pane-3"),
    projectDir: worktree,
    sessionId: "pane-chrome",
    toolName: "mcp__claude-in-chrome__computer",
    toolInput: { action: "screenshot" },
  });
  assert.ok(
    delivered(chrome, "Browser and dev-auth"),
    "the Chrome extension is the same class of work and must be shown the same traps",
  );
}

/** The doc's own text for one cluster: every line after its heading, up to the next heading. */
function clusterBody(doc: string, cluster: string): string {
  const lines = doc.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\*\*([A-Z][^*]{2,60})\*\*\s*(\(.*\))?\s*$/.exec(line)?.[1].trim() === cluster);
  assert.ok(start >= 0, `cluster "${cluster}" not found in ${CLUSTERS_DOC}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\*\*([A-Z][^*]{2,60})\*\*\s*(\(.*\))?\s*$/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * 🔴 HEADLINES, NOT THE WHOLE CLUSTER (owner, 2026-10-08, perf plan P2-3). The clusters grew from
 * 30 KB to 131 KB and one `gh pr merge` pasted 46 KB into a single tool call. Each trap now arrives
 * as its bold first sentence under a banner that says it is NOT the whole rule and names the file —
 * so nothing may be dropped (every bullet's headline arrives) and nothing may pose as complete.
 */
function testItDeliversEveryHeadlineAndNotTheWholeText(root: string) {
  const home = join(root, "home-headlines");
  mkdirSync(home);
  const worktree = makeWorktree(join(root, "headlines"));
  const context = runInjector({ home, projectDir: worktree, sessionId: "headlines", command: "gh run list --limit 5" });
  assert.ok(delivered(context, "CI and PRs"), "the CI cluster must still be delivered");

  const body = clusterBody(readFileSync(CLUSTERS_DOC, "utf8"), "CI and PRs");
  const bullets = body.split("\n").filter((line) => line.startsWith("- "));
  assert.ok(bullets.length >= 10, `expected the CI cluster's bullets, parsed ${bullets.length}`);
  for (const bullet of bullets) {
    const lead = /\*\*(.+?)\*\*/.exec(bullet)?.[1].trim() ?? bullet;
    assert.ok(context.includes(lead), `a trap was dropped — its headline is missing from the injection: ${lead.slice(0, 90)}`);
  }
  assert.ok(
    /HEADLINES ONLY/.test(context) && /NOT the whole rule/.test(context) && context.includes("agents-session-traps-clusters.md"),
    "the injection must say it is headlines only and name the file holding the full text",
  );
  assert.ok(
    Buffer.byteLength(context) < Buffer.byteLength(body) * 0.4,
    `the injection must be the headlines, not the cluster: ${Buffer.byteLength(context)} bytes for a ${Buffer.byteLength(body)}-byte cluster`,
  );
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
  const registered = wiredHookEvents().flatMap((event) =>
    wiredHookGroups(event).flatMap((group) =>
      (group.hooks ?? [])
        .filter((h) => (h.command ?? "").includes("trap-injector.mjs"))
        .map((h) => ({ event, matcher: group.matcher ?? "", ...h })),
    ),
  );
  assert.equal(registered.length, 1, "trap-injector.mjs must be registered exactly once");
  const [hook] = registered;
  assert.equal(hook.event, "PreToolUse", "the injector reads the tool call, so it is a PreToolUse hook");
  // The folder is resolved inside the hook now (process.env.CLAUDE_PROJECT_DIR), not expanded in the
  // command — the shell-expanded form errored under any non-bash runtime reading .claude/settings.json.
  // Comments are stripped first: the hook's own prose names the variable, so a raw `includes` would
  // stay green on a hook whose real read had been deleted and only its comment left behind.
  assert.ok(
    stripComments(readFileSync(HOOK, "utf8")).includes("process.env.CLAUDE_PROJECT_DIR"),
    "trap-injector.mjs must resolve the session's own worktree from CLAUDE_PROJECT_DIR first",
  );
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
    testABrowserPaneCallIsShownTheBrowserTraps(root);
    testItDeliversEveryHeadlineAndNotTheWholeText(root);
    testOncePerSession(root);
    testItFindsTheProjectFromTheWorkingDirectory(root);
    testItStandsDownForARegisteredMachineCopy(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
