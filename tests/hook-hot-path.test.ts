// A blocking project hook starts NO process on an ordinary tool call or prompt (2026-10-09).
//
// WHY THIS EXISTS. Every slowdown of the week of 2–9 Oct 2026 ran for days before a manual audit
// caught it, and every one had the same shape: a hook that still WORKED, only slower. A test that
// reads a hook's output cannot see that. Measured on the owner's laptop that morning, from the
// session transcripts:
//
//   - every Phoenix Read went from 45 ms to 210–260 ms, Grep 185 → 547 ms, Write 155 → 634 ms, since
//     the project hooks grew; on that laptop a process start is the expensive part of a hook;
//   - primary-write-guard ran `git rev-parse` on EVERY Write/Edit (~75 ms of its own);
//   - every project hook ran through Git Bash first (node alone 52 ms, through Git Bash 109 ms);
//   - a Phoenix session start waited p50 2.0 s (worst 11.1 s) for the memory-index guard to re-read
//     1,225 notes and run `git ls-tree` + `git cat-file` over the cloud mirror, and p50 1.7 s (worst
//     17.6 s) for the all-worktrees provisioning sweep.
//
// So this pins the SHAPE that removed those costs, mechanically, so the next hook cannot quietly
// bring one back:
//
//   1. settings.json runs every node hook in exec form (`"command": "node", "args": [...]`), which
//      Claude Code spawns with no shell; a shell-form entry is allowed only from a named list.
//   2. Every SessionStart entry either prints what the session needs / writes files it reads at once
//      (a named list, each with its reason), or is `"async": true` so no session waits for it.
//   3. Run under tests/support/spawn-probe.mjs — which records every child_process, net, http(s),
//      dns and fetch call — the blocking hooks record NOTHING for an ordinary Read, Edit, Write,
//      Grep, Glob, Bash `ls` / `git status`, PowerShell `Get-ChildItem`, PostToolUse after an Edit,
//      or an ordinary prompt. Hooks are taken from settings.json itself, so a new one is covered the
//      day it is wired.
//   4. A session start may make only the memory-index guard's three bounded checkout-position git
//      calls (5 s timeout each, no fetch — pinned in session-start-checkout-behind-main.test.ts).
//
// NOT ordinary, and deliberately not covered: `git push` (the secret scan), `gh pr merge` (the merge
// checks), a pnpm command in a worktree, folder removals, SessionEnd. Their process starts are the
// point of those guards and were settled before this test existed.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SETTINGS = ".claude/settings.json";
const PROBE = pathToFileURL(resolve("tests/support/spawn-probe.mjs")).href;
const PROJECT_TOKEN = "${CLAUDE_PROJECT_DIR}/";

type RawHook = { type?: string; command?: string; args?: string[]; async?: boolean; timeout?: number; shell?: string };
type RawGroup = { matcher?: string; hooks?: RawHook[] };
const settingsHooks = (): Record<string, RawGroup[]> =>
  (JSON.parse(readFileSync(SETTINGS, "utf8")) as { hooks?: Record<string, RawGroup[]> }).hooks ?? {};

/** The ONLY entries allowed to keep a shell-form command, each with the reason it needs a shell. */
const SHELL_FORM_ALLOWED: Record<string, string> = {
  "session-start-remote.sh": "the cloud-only Linux setup script: it runs only when CLAUDE_CODE_REMOTE is true",
};

/**
 * The SessionStart entries a session is allowed to WAIT for, each with its reason. Anything else at
 * session start must be `"async": true`: housekeeping that answers nothing this session needs now
 * belongs off the path every session start pays.
 */
const BLOCKING_START_ALLOWED: Record<string, string> = {
  "session-lock.mjs start": "prints the warning that another session holds this folder",
  "memory-index-guard.mjs": "prints the memory-index budget, the footprint and the checkout position",
  "sync-worktree-env.mjs --hook": "writes this worktree's settings.local.json and .env files, which the session reads at once",
  "session-start-remote.sh": "prepares a cloud session's Node and dependencies before its first command",
};

/** A short name for an entry: the script's file name plus its arguments. */
function nameOf(hook: RawHook): string {
  if (hook.command === "node" && Array.isArray(hook.args)) {
    const [script, ...rest] = hook.args;
    return [String(script).replace(/.*\//, ""), ...rest].join(" ");
  }
  const sh = /[\w.-]+\.sh\b/.exec(hook.command ?? "");
  return sh ? sh[0] : String(hook.command ?? "");
}

export function settingsShapeTests(): void {
  const hooks = settingsHooks();
  let execForm = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        const command = hook.command ?? "";
        if (command === "node") {
          execForm += 1;
          assert.ok(
            Array.isArray(hook.args) && hook.args.length > 0 && hook.args[0].startsWith(PROJECT_TOKEN) && /\.mjs$/.test(hook.args[0]),
            `the ${event} exec-form entry must name its script as args[0], rooted at ${PROJECT_TOKEN}: ${JSON.stringify(hook)}`,
          );
          assert.ok(!hook.shell, `the ${event} exec-form entry ${nameOf(hook)} declares a shell it does not use`);
          continue;
        }
        assert.ok(
          !/^\s*node\s/.test(command),
          `the ${event} hook runs node through a shell: ${command}\nWrite it in exec form — `
            + `{"command": "node", "args": ["${PROJECT_TOKEN}<path>.mjs", …]} — which Claude Code spawns with `
            + `no shell (52 ms against 109 ms through Git Bash, measured 2026-10-09; more under load).`,
        );
        const allowed = Object.keys(SHELL_FORM_ALLOWED).find((needle) => command.includes(needle));
        assert.ok(allowed, `the ${event} hook is in shell form and not on the allowed list: ${command}`);
      }
    }
  }
  assert.ok(execForm >= 9, `expected at least 9 exec-form node hooks in ${SETTINGS}, found ${execForm}`);

  // Every SessionStart entry is either one a session must wait for (named, with its reason) or async.
  const start = (hooks.SessionStart ?? []).flatMap((group) => group.hooks ?? []);
  for (const hook of start) {
    if (hook.async === true) {
      assert.ok(
        typeof hook.timeout === "number" && hook.timeout > 0,
        `the async SessionStart entry ${nameOf(hook)} needs a timeout, so a hung background run is stopped`,
      );
      continue;
    }
    const name = nameOf(hook);
    assert.ok(
      Object.keys(BLOCKING_START_ALLOWED).includes(name),
      `the SessionStart entry "${name}" blocks every session start. Make it "async": true, or — if a `
        + `session truly needs its output before the first prompt — add it to BLOCKING_START_ALLOWED with the reason.`,
    );
  }
  // The two moved off the blocking path on 2026-10-09 stay off it.
  for (const name of ["sync-worktree-env.mjs --sweep-only", "cloud-mirror-drift-refresh.mjs"]) {
    const entry = start.find((hook) => nameOf(hook) === name);
    assert.ok(entry, `the SessionStart entry "${name}" is missing`);
    assert.equal(entry?.async, true, `"${name}" must stay "async": true — it was p50 1.7–2.0 s of every session start`);
  }
  assert.ok(
    !start.some((hook) => /sync-worktree-env\.mjs/.test(JSON.stringify(hook)) && /--all\b/.test(JSON.stringify(hook))),
    "the all-worktrees sweep is back on the session-start path as --all; it runs as the async --sweep-only entry",
  );
}

type ProbeRun = { code: number | null; calls: Array<{ kind: string; what: string }>; stdout: string };

/** Runs `node --import <probe> <script> …args` with `payload` on stdin; returns what the probe recorded. */
function underProbe(script: string, args: string[], payload: unknown, env: NodeJS.ProcessEnv, cwd: string): ProbeRun {
  const out = join(env.PHX_HOT_PATH_TMP as string, `probe-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(out, "");
  let code: number | null = 0;
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, ["--import", PROBE, script, ...args], {
      input: JSON.stringify(payload),
      env: { ...env, SPAWN_PROBE_OUT: out },
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string };
    code = e.status ?? null;
    stdout = e.stdout ?? "";
  }
  const calls = readFileSync(out, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; what: string });
  return { code, calls, stdout };
}

/** A sandboxed environment: HOME and the config root in a temp folder, no PHX_*_OK / _OFF overrides. */
function sandboxEnv(home: string, projectDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    PHX_HOT_PATH_TMP: home,
  };
  for (const key of Object.keys(env)) if (/^PHX_.*(_OK|_OFF)$/.test(key)) delete env[key];
  delete env.SPAWN_PROBE_OUT;
  return env;
}

/** settings.json's exec-form entries for `event`, as [script path, args]. */
function execEntries(event: string, root: string): Array<[string, string[]]> {
  return (settingsHooks()[event] ?? [])
    .flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.command === "node" && Array.isArray(hook.args) && hook.async !== true)
    .map((hook) => {
      const [script, ...rest] = (hook.args ?? []).map((a) => a.replace("${CLAUDE_PROJECT_DIR}", root));
      return [script, rest] as [string, string[]];
    });
}

export function probeSeesSpawns(): void {
  // The probe's silence proves nothing unless it hears a spawn made the way a hook makes one: a
  // NAMED ESM import bound after the preload ran.
  const home = mkdtempSync(join(tmpdir(), "phx-hot-probe-"));
  try {
    const script = join(home, "spawns.mjs");
    writeFileSync(script, "import { execFileSync } from 'node:child_process';\nexecFileSync(process.execPath, ['--version']);\n");
    const run = underProbe(script, [], {}, sandboxEnv(home, home), home);
    assert.equal(run.calls.length, 1, `the spawn probe must record a named-import execFileSync, recorded ${JSON.stringify(run.calls)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function ordinaryCallsSpawnNothing(): void {
  const root = resolve(".");
  const home = mkdtempSync(join(tmpdir(), "phx-hot-path-"));
  try {
    const env = sandboxEnv(home, root);
    const pre = (tool: string, input: Record<string, unknown>) => ({
      session_id: "hot-path", cwd: root, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input,
    });
    const cases: Array<[string, string, unknown]> = [
      ["PreToolUse", "Read of a source file", pre("Read", { file_path: resolve("src/lib/payroll/service.ts") })],
      ["PreToolUse", "Edit of a source file", pre("Edit", { file_path: resolve("src/lib/payroll/service.ts"), old_string: "a", new_string: "b" })],
      ["PreToolUse", "Write of a doc", pre("Write", { file_path: resolve("docs/scratch-note.md"), content: "x" })],
      ["PreToolUse", "Grep", pre("Grep", { pattern: "closing", path: resolve("src/lib/sales") })],
      ["PreToolUse", "Glob", pre("Glob", { pattern: "src/**/*.ts" })],
      ["PreToolUse", "Bash ls", pre("Bash", { command: "ls" })],
      ["PreToolUse", "Bash git status", pre("Bash", { command: "git status" })],
      ["PreToolUse", "PowerShell Get-ChildItem", pre("PowerShell", { command: "Get-ChildItem -Name" })],
      ["PostToolUse", "PostToolUse after an Edit", { ...pre("Edit", { file_path: resolve("src/lib/payroll/service.ts") }), hook_event_name: "PostToolUse" }],
      ["UserPromptSubmit", "an ordinary prompt", { session_id: "hot-path", cwd: root, hook_event_name: "UserPromptSubmit", prompt: "fix the label on the payroll page" }],
    ];
    let ran = 0;
    for (const [event, what, payload] of cases) {
      const entries = execEntries(event, root);
      assert.ok(entries.length > 0, `no blocking ${event} hook found in ${SETTINGS} — the shape test above should have said why`);
      for (const [script, args] of entries) {
        const run = underProbe(script, args, payload, env, root);
        ran += 1;
        assert.deepEqual(
          run.calls,
          [],
          `${script.replace(/.*\//, "")} started a process or touched the network on ${what}: `
            + `${JSON.stringify(run.calls)}\nA blocking hook pays that on EVERY such call in every Phoenix `
            + `session. Read it off disk (scripts/lib/git-layout.mjs for the checkout layout), cache it, or `
            + `move the work to an async entry.`,
        );
      }
    }
    assert.ok(ran >= 10, `expected at least 10 hook runs, made ${ran}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const CHECKOUT_POSITION_CALL = /^git (rev-parse --git-dir|rev-parse --short HEAD|rev-list --count HEAD\.\.origin\/main)$/;

export function sessionStartSpawnsOnlyCheckoutPosition(): void {
  // A throwaway PRIMARY checkout with one commit, and a memory directory for it in a sandboxed config
  // root, so the guard takes its whole path (index budget, footprint, checkout position, drift cache).
  const home = mkdtempSync(join(tmpdir(), "phx-hot-start-"));
  try {
    const repo = join(home, "repo");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed");
    const env = sandboxEnv(home, repo);
    const slug = resolve(repo).replace(/[^A-Za-z0-9]/g, "-");
    const memory = join(home, ".claude", "projects", slug, "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "MEMORY.md"), "# Memory\n\n- [A note](a-note.md) — a hook\n");
    writeFileSync(join(memory, "a-note.md"), "---\nname: a-note\ndescription: a note\n---\n\nbody\n");

    const root = resolve(".");
    const start = { session_id: "hot-path", cwd: repo, hook_event_name: "SessionStart", source: "startup" };
    const startEntries = execEntries("SessionStart", root);
    assert.ok(startEntries.some(([script]) => script.endsWith("memory-index-guard.mjs")), "the memory-index guard is not a blocking SessionStart entry");
    let guardPrinted = false;
    for (const [script, args] of startEntries) {
      const run = underProbe(script, args, start, env, repo);
      const name = script.replace(/.*\//, "");
      if (name === "memory-index-guard.mjs") {
        guardPrinted = run.stdout.trim().length > 0;
        const other = run.calls.filter((call) => !(call.kind === "child_process.execFileSync" && CHECKOUT_POSITION_CALL.test(call.what)));
        assert.deepEqual(
          other,
          [],
          `the memory-index guard made a call beyond its three checkout-position git calls at session start: `
            + `${JSON.stringify(other)}\nThe cloud-mirror drift reading belongs to the async `
            + `cloud-mirror-drift-refresh.mjs entry; the guard only reads its cache.`,
        );
        assert.ok(run.calls.length <= 3, `the memory-index guard made ${run.calls.length} git calls at session start, at most 3 allowed`);
        continue;
      }
      assert.deepEqual(run.calls, [], `${name} ${args.join(" ")} started a process at session start: ${JSON.stringify(run.calls)}`);
    }
    // It ran its whole path rather than bailing out early, or its silence above proves nothing.
    assert.ok(guardPrinted, "the memory-index guard printed nothing for a seeded memory directory");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function runHookHotPathTests(): void {
  settingsShapeTests();
  probeSeesSpawns();
  ordinaryCallsSpawnNothing();
  sessionStartSpawnsOnlyCheckoutPosition();
}
