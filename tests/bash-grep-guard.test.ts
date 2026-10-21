// bash-guard C1: a recursive grep is refused where it hangs, and allowed where it cannot (2026-10-17,
// turned into a deny-list 2026-10-22).
//
// WHY THIS EXISTS. C1 refused EVERY recursive grep, on the measured ground that one from the repo
// root walks ~346k path entries (the worktree payload and node_modules) and takes 10-40 s. A /doctor
// pass over 50 sessions (15-17 Oct 2026) found the blanket refusal had stopped 124 commands, and
// about 70 of them named one small tracked folder — `src` (3,460 tracked files), `app` (1,808),
// `tests` (2,470), `scripts` (287), `supabase` (1,442), `docs` (173) — which cannot hang. A few
// more only QUOTED `grep -r` inside a search pattern. Every one of them cost the session a round
// trip, and a guard that is wrong that often is the one that gets switched off.
//
// So the clause now refuses what hangs and allows what cannot: a recursive grep passes only when
// every path is under one of those folders. No path (it walks the cwd), `.`, `..`, an absolute path,
// a glob or a variable, `node_modules`, `.claude/worktrees` — all still refused, and so is anything
// the parser cannot place. The allow half is asserted first and as hard as the deny half: it is the
// half that fails if the narrowing is reverted.
//
// 2026-10-22 (owner: "fix"): the seven-folder allow-list was the next false positive — 20-21 Oct it
// refused ~60 greps that could not hang (`.claude/rules`, `.github/workflows/*.yml`, `docs/*.md`,
// `package.json`, the memory folder, a scratchpad). The clause now refuses only a BIG TREE, with every
// path resolved where it runs: the cwd (moved by any `cd`), `~`, and variables set in the command.
// The new ALLOWED rows below are those refused commands, cut down.
//
// It drives the real hook as a subprocess, exactly as settings.json runs it, because a test that
// imported the matcher would pass against a hook wired to nothing.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");

type Decision = { decision: "allow" | "deny"; reason: string };

/** The tool payload on stdin, in a folder that is not a git repository, so no other clause answers. */
function runGuard(cwd: string, command: string, tool = "Bash"): Decision {
  command = command.replaceAll("<ROOT>", cwd.replace(/\\/g, "/"));
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  const raw = execFileSync(process.execPath, [guardPath], {
    cwd,
    input: JSON.stringify({ tool_name: tool, cwd, tool_input: { command } }),
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
  if (!raw.trim()) return { decision: "allow", reason: "" };
  const start = raw.indexOf('{"hookSpecificOutput"');
  assert.ok(start >= 0, `hook emitted something that is not a decision:\n${raw}`);
  const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return { decision: output.permissionDecision, reason: String(output.permissionDecisionReason ?? "") };
}

/** A heredoc BODY that documents the rule. Writing it down must not trip it. */
const HEREDOC_NOTE = ["cat > note.md <<'EOF'", "Never run grep -r from the root:", "grep -rn x .", "EOF"].join("\n");

/** Recursive greps over named folders. Each of these is a shape the 124 refusals contained. */
const ALLOWED: Array<{ what: string; command: string; tool?: string }> = [
  { what: "one named folder", command: 'grep -rn "x" src' },
  { what: "several named folders", command: "grep -rln x src app tests" },
  { what: "a folder with a trailing slash", command: "grep -rn x src/" },
  { what: "a folder written with ./", command: "grep -rn x ./scripts" },
  { what: "a subfolder", command: "grep -rn x src/lib/payroll" },
  { what: "supabase", command: "grep -rn x supabase" },
  { what: "docs", command: "grep -rn x docs" },
  { what: "the pattern given with -e", command: "grep -r -e x tests" },
  { what: "an uppercase -R", command: "grep -R x app" },
  { what: "the long flag", command: "grep --recursive x src" },
  { what: "context flags with values", command: "grep -rn -A 3 -B 2 x src" },
  { what: "an --include with a glob in a QUOTE", command: 'grep -rn --include="*.ts" "x" src' },
  { what: "--include=value form after the paths", command: "grep -rn x src --include=*.tsx" },
  { what: "a pattern that itself contains an r", command: "grep -rn -ereturn src" },
  { what: "an escaped quote inside a quoted pattern", command: 'grep -rn "\\"edit_expired\\"\\|removal_decided\\"" src app --include=*.ts' },
  { what: "an escaped quote, then a pipe", command: 'grep -rln "offer-composer\\"" app src | head -5' },
  { what: "a dot folder that is small", command: "grep -rn x .claude/rules" },
  { what: "a dot folder plus files", command: "grep -rli x .claude/rules docs AGENTS.md package.json" },
  { what: "a glob of files in a folder", command: "grep -rn x .github/workflows/*.yml scripts/*.mjs" },
  { what: "globs in docs", command: "grep -rn -i -E \"a|b\" docs/devices/*.md docs/*.md 2>/dev/null | head" },
  { what: "a glob inside a deep folder", command: "grep -rn x src/lib/production-planning/*.ts" },
  { what: "every entry of a named folder", command: "grep -r x src/*" },
  { what: "a file-extension glob at the root", command: "grep -rn x *.md" },
  { what: "a folder that is not tracked", command: "grep -rn x lib instrumentation.ts next.config.ts --include=*.ts" },
  { what: "one package in node_modules", command: "grep -rn x node_modules/@supabase/storage-js/dist" },
  { what: "an absolute small folder", command: "grep -rl x \"C:/Users/someone/.claude/projects/F--x/memory\"" },
  { what: "a variable set earlier in the command", command: "M=\"C:/Users/someone/.claude/projects/F--x/memory\"; grep -rl x \"$M\"" },
  { what: "a folder under home", command: "grep -rn x ~/.claude/hooks" },
  { what: "the dot after a cd into a named folder", command: "cd src && grep -rn x ." },
  { what: "the dot after a cd into a scratchpad", command: "cd \"C:/Users/someone/AppData/Local/Temp/claude/x/scratchpad\" && grep -rn x ." },
  { what: "a cd first", command: 'cd "F:/Phoenix Workforce/_wt-x" && grep -rn x src' },
  { what: "a pipe onward", command: "grep -rn x src | head -20" },
  { what: "stderr folded in", command: "grep -rn x src 2>&1 | head" },
  { what: "stderr discarded", command: "grep -rn x src tests 2>/dev/null" },
  { what: "egrep over a named folder", command: "egrep -rn 'a|b' app" },
  { what: "a non-recursive grep of a file", command: "grep -n x package.json" },
  { what: "a non-recursive grep at the root", command: "grep x ." },
  { what: "git grep", command: "git grep -n x" },
  { what: "git grep whose PATTERN quotes the flag", command: 'git grep -n "grep -r" -- tests' },
  { what: "an echo that mentions it", command: 'echo "never run grep -rn x . from the root"' },
  { what: "a commit message about it", command: "git commit -m 'fix(hooks): grep -r over named folders is allowed'" },
  { what: "a heredoc body documenting it", command: HEREDOC_NOTE },
  { what: "a PowerShell here-string documenting it", command: ["$m = @'", "grep -rn x .", "'@", "git commit -m $m"].join("\n"), tool: "PowerShell" },
];

/** Recursive greps that walk somewhere they must not. All must be refused. */
const REFUSED: Array<{ what: string; command: string; tool?: string }> = [
  { what: "no path at all — it walks the cwd", command: "grep -rn x" },
  { what: "no path, behind a cd", command: 'cd "F:/Phoenix Workforce/_wt-x" && grep -rl x' },
  { what: "the dot", command: "grep -rn x ." },
  { what: "the dot with ./", command: "grep -rn x ./" },
  { what: "the parent", command: "grep -rn x .." },
  { what: "a named folder plus the dot", command: "grep -rn x src ." },
  { what: "a named folder plus the parent", command: "grep -r x src .." },
  { what: "an escape out of a named folder", command: "grep -r x src/../.." },
  { what: "a glob at the root", command: "grep -r x *" },
  { what: "a variable", command: "grep -rn x $PWD" },
  { what: "the home shortcut", command: "grep -R x docs ~" },
  { what: "node_modules", command: "grep -r x node_modules" },
  { what: "the worktrees", command: "grep -rn x .claude/worktrees" },
  { what: "the .claude folder", command: "grep -rn x .claude" },
  { what: "an escape through a named folder", command: "grep -rn x public/../node_modules" },
  { what: "an absolute path", command: "grep -rn x /f/Phoenix" },
  { what: "a drive path", command: "grep -rn x C:/Users" },
  { what: "the long flag with no path", command: "grep --recursive x" },
  { what: "-e with no path", command: "grep -r -e x" },
  { what: "egrep", command: "egrep -r x" },
  { what: "fgrep", command: "fgrep -r x ." },
  { what: "the dot, excluding node_modules — the worktrees are still walked", command: "grep -rn x --exclude-dir=node_modules ." },
  { what: "the dot after a cd to the workspace folder", command: "cd .. && grep -rn x ." },
  { what: "the repo root by absolute path", command: "grep -rn x \"<ROOT>\"" },
  { what: "a worktree root by absolute path", command: "grep -rn x \"F:\\Phoenix Workforce\\_wt-foo\"" },
  { what: "a cd to an unknown variable, then the dot", command: "cd \"$NOWHERE\" && grep -rn x ." },
  { what: "an unset variable", command: "grep -rn x \"$TEMP\"" },
  { what: "home .claude", command: "grep -rn x ~/.claude" },
  { what: "the transcript store", command: "grep -rn x C:/Users/someone/.claude/projects" },
  { what: "Temp", command: "grep -rn x C:/Users/someone/AppData/Local/Temp" },
  { what: "every dot folder", command: "grep -rn x .*" },
  { what: "the pnpm store", command: "grep -rn x node_modules/.pnpm" },
  { what: "an escaped quote does not hide the dot", command: 'grep -rn "a\\"|b" --include=*.ts . 2>/dev/null' },
  { what: "the build output", command: "grep -r x .next" },
  { what: "a glob above a folder", command: "grep -r x */src" },
  { what: "one good grep and one bad, in a pipeline", command: "grep -rn x src | grep -rn y ." },
  { what: "after a semicolon", command: "echo hi; grep -rn x" },
  { what: "inside a command substitution", command: "echo $(grep -rn x .)" },
  { what: "stderr folded in, still no path", command: "grep -rn x 2>&1 | head" },
  { what: "the PowerShell tool", command: "grep -rn x .", tool: "PowerShell" },
  { what: "an alias that would make every grep recursive", command: "alias grep='grep -r'" },
  { what: "the alias the old message warned against", command: "alias grep=rg" },
];

export function runBashGrepGuardTests(): void {
  assert.ok(existsSync(guardPath), `bash-guard not found at ${guardPath}`);
  // The cwd is a REPO ROOT inside a workspace folder, as every session here runs, so `.` and `..`
  // resolve to the trees that hang.
  const scratch = mkdtempSync(join(tmpdir(), "phx-grep-guard-"));
  const cwd = join(scratch, "Phoenix Workforce", "phoenix-workforce");
  mkdirSync(cwd, { recursive: true });
  try {
    for (const { what, command, tool } of ALLOWED) {
      const { decision, reason } = runGuard(cwd, command, tool ?? "Bash");
      assert.equal(
        decision,
        "allow",
        `C1 must allow a recursive grep over named folders, and a mere mention (${what}):\n  ${command}\n  ${reason}`,
      );
    }

    for (const { what, command, tool } of REFUSED) {
      const { decision, reason } = runGuard(cwd, command, tool ?? "Bash");
      assert.equal(decision, "deny", `C1 must refuse a recursive grep that walks the root (${what}):\n  ${command}`);
      assert.match(reason, /Recursive grep hangs/, `the refusal must say why (${what}):\n${reason}`);
      // The refusal has to hand back both the way out and the allowance, or the next session reads
      // it as the old blanket rule and argues with it.
      assert.match(reason, /NAMED folders/, `the refusal must say what IS allowed (${what}):\n${reason}`);
      assert.match(reason, /git grep/, `the refusal must name git grep as the way out (${what}):\n${reason}`);
    }

    // Other tools are none of this hook's business.
    assert.equal(runGuard(cwd, "grep -rn x .", "Read").decision, "allow", "the hook must return silently for any tool but Bash and PowerShell");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
