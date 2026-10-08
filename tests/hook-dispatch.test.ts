// .claude/hooks/hook-dispatch.mjs runs every PreToolUse hook in ONE node process (2026-10-08).
//
// Measured on the owner's laptop the same day: a Bash or Edit call matched 7 project hooks, each its
// own node process, costing ~850 ms of CPU and ~400 MB of short-lived memory per call; the same seven
// in one isolate cost ~100 ms and ~60 MB. Every guard keeps its own file, logic and tests — the
// dispatcher only changes WHERE they run — so what this pins is that the change of venue changes
// nothing a session can see:
//
//   1. the merge is Claude Code's own: exit 2 blocks, deny > ask > allow, every reason and every
//      additionalContext kept, a crashed hook reported and never blocking;
//   2. settings.json runs the dispatcher for EVERY tool any dispatched hook matches, and nothing
//      else in PreToolUse — a guard wired in both places would run twice;
//   3. every in-process hook keeps the contract: its work ends when its module finishes loading (no
//      floating async main()), and no catch around an exit swallows the exit;
//   4. over a corpus of real tool calls — a denied typecheck, a frozen mobile path, a protected
//      file, a risky settings allow, a module-memory read, a git command — the dispatcher's answer
//      is byte-identical to the answer of the same hooks run the old way, one process each.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { DISPATCHER_SCRIPT, dispatchedHookGroups, settingsHookGroups } from "./support/hook-wiring.ts";

const DISPATCHER = resolve(".claude/hooks", DISPATCHER_SCRIPT);
const EXIT_SYMBOL = "phx.hook-exit";

type Result = { command: string; code: number | null; stdout: string; stderr: string; timedOut: boolean };
type Merged = { code: number; stdout: string; stderr: string };
type DispatchModule = {
  matcherFits: (matcher: string | undefined, tool: string) => boolean;
  parseCommand: (command: string) => { script: string; args: string[] } | null;
  selectHooks: (table: unknown, event: string, tool: string) => Array<{ command: string; run: string }>;
  mergeHookResults: (results: Result[], event?: string) => Merged;
};

const r = (over: Partial<Result>): Result => ({ command: 'node "x/.claude/hooks/a.mjs"', code: 0, stdout: "", stderr: "", timedOut: false, ...over });
const decide = (decision: string, reason: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });
const context = (text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });

export function mergeTests(d: DispatchModule): void {
  // Nothing to say → nothing said.
  assert.deepEqual(d.mergeHookResults([r({}), r({})]), { code: 0, stdout: "", stderr: "" });

  // deny beats ask beats allow, and only the winning decision's reasons are carried.
  const m1 = JSON.parse(d.mergeHookResults([r({ stdout: decide("allow", "fine") }), r({ stdout: decide("deny", "no") }), r({ stdout: decide("ask", "maybe") })]).stdout);
  assert.equal(m1.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(m1.hookSpecificOutput.permissionDecisionReason, "no");
  const m2 = JSON.parse(d.mergeHookResults([r({ stdout: decide("allow", "fine") }), r({ stdout: decide("ask", "a1") }), r({ stdout: decide("ask", "a2") })]).stdout);
  assert.equal(m2.hookSpecificOutput.permissionDecision, "ask");
  assert.equal(m2.hookSpecificOutput.permissionDecisionReason, "a1\n\na2", "two asks keep both reasons");

  // Every additionalContext survives, beside a decision.
  const m3 = JSON.parse(d.mergeHookResults([r({ stdout: context("memory") }), r({ stdout: decide("deny", "C8") }), r({ stdout: context("traps") })]).stdout);
  assert.equal(m3.hookSpecificOutput.additionalContext, "memory\n\ntraps");
  assert.equal(m3.hookSpecificOutput.permissionDecision, "deny");

  // A blocking exit 2 wins over everything, with its stderr.
  assert.deepEqual(d.mergeHookResults([r({ stdout: decide("allow", "fine") }), r({ code: 2, stderr: "blocked here\n" })]), { code: 2, stdout: "", stderr: "blocked here\n" });

  // A crash or a timeout is reported and never blocks — it was non-blocking as a process too.
  const m4 = JSON.parse(d.mergeHookResults([r({ code: 1, stderr: "TypeError: boom\n  at x" }), r({ timedOut: true, code: null })]).stdout);
  assert.equal(m4.hookSpecificOutput, undefined, "a crash carries no decision");
  assert.match(m4.systemMessage, /a exited 1: TypeError: boom/);
  assert.match(m4.systemMessage, /a timed out/);

  // Plain text alone passes through untouched (transcript-only, as before).
  assert.deepEqual(d.mergeHookResults([r({ stdout: "gitleaks is not installed\n" })]), { code: 0, stdout: "gitleaks is not installed", stderr: "" });
  // A systemMessage hook (session-lock) survives beside a deny.
  const m5 = JSON.parse(d.mergeHookResults([r({ stdout: JSON.stringify({ systemMessage: "lock held" }) }), r({ stdout: decide("deny", "no") })]).stdout);
  assert.equal(m5.systemMessage, "lock held");
}

export function matcherTests(d: DispatchModule): void {
  // Claude Code's rule: plain names and pipes are an EXACT list; anything else is a regex.
  assert.ok(d.matcherFits("Bash|PowerShell", "Bash"));
  assert.ok(!d.matcherFits("Bash|PowerShell", "BashOutput"), "an exact list never matches a longer name");
  assert.ok(!d.matcherFits("Edit", "MultiEdit"));
  assert.ok(d.matcherFits("mcp__supabase.*", "mcp__supabase-production__execute_sql"));
  assert.ok(!d.matcherFits("mcp__supabase.*", "mcp__github__list"));
  assert.ok(d.matcherFits("", "Anything") && d.matcherFits("*", "Anything"));
  assert.deepEqual(d.parseCommand('node "${CLAUDE_PROJECT_DIR}/.claude/hooks/session-lock.mjs" beat')?.args, ["beat"]);
  assert.equal(d.parseCommand("bash something.sh"), null, "anything but a node hook falls back to a process");
}

/** Every tool name worth checking: each exact name the table names, plus a Supabase MCP tool. */
function toolNames(): string[] {
  const names = new Set<string>(["mcp__supabase-production__execute_sql", "mcp__supabase-staging__list_tables"]);
  for (const group of dispatchedHookGroups("PreToolUse")) {
    for (const name of (group.matcher ?? "").split("|")) if (/^[A-Za-z0-9_]+$/.test(name)) names.add(name);
  }
  return [...names];
}

export function wiringTests(d: DispatchModule): void {
  const own = settingsHookGroups("PreToolUse");
  assert.equal(own.length, 1, "settings.json's PreToolUse holds exactly ONE entry — the dispatcher. A guard wired there AND in the table runs twice.");
  const entry = own[0].hooks ?? [];
  assert.equal(entry.length, 1);
  assert.match(entry[0].command ?? "", /^node "\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/hook-dispatch\.mjs" PreToolUse$/);
  const tableTimeouts = dispatchedHookGroups("PreToolUse").flatMap((g) => (g.hooks ?? []).map((h) => h.timeout ?? 60));
  assert.ok((entry[0].timeout ?? 60) >= Math.max(60, ...tableTimeouts), "the dispatcher's timeout covers its slowest hook");

  const table = { hooks: { PreToolUse: dispatchedHookGroups("PreToolUse") } };
  assert.ok(table.hooks.PreToolUse.length >= 9, `expected the nine PreToolUse guards in the dispatch table, found ${table.hooks.PreToolUse.length}`);
  for (const tool of toolNames()) {
    if (d.selectHooks(table, "PreToolUse", tool).length === 0) continue;
    assert.ok(
      d.matcherFits(own[0].matcher, tool),
      `${tool} matches a dispatched hook but NOT settings.json's dispatcher matcher (${own[0].matcher}) — that hook would never run for it`,
    );
  }
  for (const group of table.hooks.PreToolUse) {
    for (const hook of group.hooks ?? []) {
      assert.ok(d.parseCommand(hook.command ?? ""), `dispatch table command is not a node hook the dispatcher can run in-process: ${hook.command}`);
    }
  }
}

/**
 * The in-process contract, read from each hook's syntax tree: no floating async main(), and every
 * catch around code that can exit either exits too or rethrows the dispatcher's exit marker.
 */
export function contractViolations(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  const fns = new Map<string, ts.Node>();
  const asyncFns = new Set<string>();
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name) {
      fns.set(n.name.text, n);
      if (n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) asyncFns.add(n.name.text);
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      fns.set(n.name.text, n.initializer);
      if (n.initializer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) asyncFns.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const exiting = new Set<string>();
  const reachesExit = (node: ts.Node): boolean => {
    let hit = false;
    const visit = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf);
        if (callee === "process.exit" || exiting.has(callee)) { hit = true; return; }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return hit;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, fn] of fns) if (!exiting.has(name) && reachesExit(fn)) { exiting.add(name); changed = true; }
  }
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const walk = (n: ts.Node, depth: number): void => {
    if (ts.isTryStatement(n) && n.catchClause && reachesExit(n.tryBlock)) {
      const body = n.catchClause.block;
      if (!reachesExit(body) && !body.getText(sf).includes(EXIT_SYMBOL)) {
        problems.push(`line ${line(n.catchClause)}: a catch around code that can exit neither exits nor rethrows Symbol.for('${EXIT_SYMBOL}')`);
      }
    }
    // A call to a local async function at module level that is not awaited: its work outlives the
    // module's load, so in one shared process its output would land in the NEXT hook.
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && asyncFns.has(n.expression.text) && depth === 0) {
      let p: ts.Node = n.parent;
      while (p && (ts.isPropertyAccessExpression(p) || ts.isCallExpression(p))) p = p.parent;
      if (!(p && ts.isAwaitExpression(p)) && !ts.isAwaitExpression(n.parent)) {
        problems.push(`line ${line(n)}: async ${n.expression.text}() is called without a top-level await`);
      }
    }
    const inFunction = ts.isFunctionLike(n);
    ts.forEachChild(n, (c) => walk(c, inFunction ? depth + 1 : depth));
  };
  walk(sf, 0);
  return problems;
}

export function contractTests(d: DispatchModule): void {
  for (const group of dispatchedHookGroups("PreToolUse")) {
    for (const hook of group.hooks ?? []) {
      if ((hook.run ?? "in-process") !== "in-process") continue;
      const parsed = d.parseCommand(hook.command ?? "");
      assert.ok(parsed);
      const problems = contractViolations(parsed.script, readFileSync(parsed.script, "utf8"));
      assert.deepEqual(problems, [], `${parsed.script} breaks the in-process contract — fix it or mark it "run": "worker" in dispatch.json:\n${problems.join("\n")}`);
    }
  }
  // The checker itself must see both defects, or its silence above proves nothing.
  const floating = "async function main() { process.exit(0); }\nmain().catch(() => {});\n";
  assert.equal(contractViolations("f.mjs", floating).length, 1, "a floating async main() is caught");
  assert.deepEqual(contractViolations("f.mjs", "async function main() {}\nawait main().catch(() => {});\n"), []);
  const swallow = "function deny() { process.exit(0); }\ntry { deny(); } catch { /* ignore */ }\n";
  assert.equal(contractViolations("f.mjs", swallow).length, 1, "a catch swallowing an exit is caught");
  const rethrow = "function deny() { process.exit(0); }\ntry { deny(); } catch (e) { if (e?.[Symbol.for('phx.hook-exit')]) throw e; }\n";
  assert.deepEqual(contractViolations("f.mjs", rethrow), []);
}

const CORPUS: Array<[string, Record<string, unknown>]> = [
  ["Bash", { command: ["pnpm", "run", "typecheck"].join(" ") }],
  ["Bash", { command: "git status" }],
  ["Bash", { command: "git push origin HEAD" }],
  ["PowerShell", { command: "Get-ChildItem -Name" }],
  ["Edit", { file_path: resolve("mobile/app/index.tsx"), old_string: "a", new_string: "b" }],
  ["Edit", { file_path: resolve("src/lib/payroll/policy.ts"), old_string: "a", new_string: "b" }],
  ["Edit", { file_path: resolve(".claude/settings.local.json"), old_string: "[", new_string: '["Bash(npx *)",' }],
  ["Write", { file_path: resolve("docs/scratch-note.md"), content: "x" }],
  ["Read", { file_path: resolve("src/lib/payroll/service.ts") }],
  ["Grep", { pattern: "closing", path: resolve("src/lib/sales") }],
  ["mcp__supabase-production__execute_sql", { project_id: "x", query: "select count(*) from salary_records" }],
];

function runDispatcher(tool: string, input: Record<string, unknown>, processes: boolean, home: string): Merged {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: resolve("."), HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (/^PHX_.*(_OK|_OFF)$/.test(key)) delete env[key];
  if (processes) env.PHX_HOOK_DISPATCH_PROCESSES = "1";
  else delete env.PHX_HOOK_DISPATCH_PROCESSES;
  const payload = JSON.stringify({ session_id: "dispatch-equivalence", cwd: resolve("."), hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
  try {
    const stdout = execFileSync(process.execPath, [DISPATCHER, "PreToolUse"], { input: payload, encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"], timeout: 120000 });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

export function equivalenceTests(): void {
  const homeShared = mkdtempSync(join(tmpdir(), "phx-dispatch-shared-"));
  const homeProc = mkdtempSync(join(tmpdir(), "phx-dispatch-proc-"));
  let decided = 0;
  try {
    for (const [tool, input] of CORPUS) {
      const shared = runDispatcher(tool, input, false, homeShared);
      const separate = runDispatcher(tool, input, true, homeProc);
      assert.deepEqual(shared, separate, `the dispatcher's in-process answer differs from the one-process-per-hook answer for ${tool} ${JSON.stringify(input)}`);
      if (/permissionDecision/.test(shared.stdout)) decided += 1;
    }
  } finally {
    rmSync(homeShared, { recursive: true, force: true });
    rmSync(homeProc, { recursive: true, force: true });
  }
  // The corpus must actually exercise the guards — identical silence on both sides proves nothing.
  assert.ok(decided >= 3, `expected the corpus to draw at least 3 allow/ask/deny decisions, it drew ${decided}`);
}

export async function runHookDispatchTests(): Promise<void> {
  const d = (await import(pathToFileURL(DISPATCHER).href)) as DispatchModule;
  mergeTests(d);
  matcherTests(d);
  wiringTests(d);
  contractTests(d);
  equivalenceTests();
}
