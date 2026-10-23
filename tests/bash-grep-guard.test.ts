// bash-guard C1: a recursive grep is refused where it hangs, and allowed where it cannot (2026-10-17,
// turned into a deny-list 2026-10-22, and a repo root rewritten instead of refused the same day).
//
// WHY THIS EXISTS. C1 refused EVERY recursive grep, on the measured ground that one from the repo
// root walks ~346k path entries (the worktree payload and node_modules) and takes 10-40 s. A /doctor
// pass over 50 sessions (15-17 Oct 2026) found the blanket refusal had stopped 124 commands, and
// about 70 of them named one small tracked folder — `src` (3,460 tracked files), `app` (1,808),
// `tests` (2,470), `scripts` (287), `supabase` (1,442), `docs` (173) — which cannot hang. A few
// more only QUOTED `grep -r` inside a search pattern. Every one of them cost the session a round
// trip, and a guard that is wrong that often is the one that gets switched off.
//
// 2026-10-22 (owner: "fix"): the seven-folder allow-list was the next false positive — 20-21 Oct it
// refused ~60 greps that could not hang (`.claude/rules`, `.github/workflows/*.yml`, `docs/*.md`,
// `package.json`, the memory folder, a scratchpad). The clause now refuses only a BIG TREE, with every
// path resolved where it runs: the cwd (moved by any `cd`), `~`, and variables set in the command.
// The ALLOWED rows below include those refused commands, cut down.
//
// 2026-10-22, later (owner: "fix the 7 grep refusals that remain"): the 7 left all searched a repo
// root (`.`) or its `.claude`. With --exclude-dir for node_modules, .git, .next, worktrees and
// .codex-worktrees that walk takes ~3.5 s warm over the primary, so the hook now ADDS those flags
// itself and allows the command — when every segment is read-only. Anything else is refused WITH the
// rewritten command in the message. `_wt-*` is not one of the flags: GNU grep 3.0 applies
// --exclude-dir to a folder named on the command line too, and a grep of a worktree root by its
// absolute path then searched nothing (measured: 0 hits against 1). The REWRITTEN rows pin both.
//
// 2026-10-23 (owner pasted the refusal itself): a scan of the 87 transcripts touched since #6231
// merged (21 Oct 22:42 UTC) found 21 real refusals in two days, and NOT ONE of them was a tree
// `git grep` could have searched — every path was either outside a repo (home, a drive root, Temp,
// the workspace folder) or inside a git-IGNORED tree, where `git grep` returns zero hits and reads
// as "no matches". The three real causes, each fixed here and pinned by the command as it was typed:
//   * 9 — a FILE glob judged by the folder holding it (`instrumentation*.ts`, `eslint.config.*`,
//     `docker-compose*.yml`, `src/**/*.ts`, `src/lib/expense*/*.ts`, `_wt-*/supabase/migrations/`).
//     Only `*.ext` in the last segment was allowed before. A glob can only NARROW a walk, so the
//     path is now judged with each glob replaced by a placeholder — trailing placeholders dropped
//     first, or `node_modules/*` reads as a small folder while it walks all of node_modules.
//   * 6 — `$TEMP` unseeded, so a path built from it could not be placed. One was retried 4 times.
//     The Temp ROOT stays refused on its own last segment, and `$PWD` is still not seeded.
//   * 2 — `~/.claude` refused whole, for the three STORES inside it. Measured over the live tree:
//     66,401 path entries and 13.9 GB, of which backups is 36,845 entries / 1.4 GB, projects (the
//     transcripts) 9,276 / 12.0 GB and file-history 6,196 / 278 MB — so excluding the three leaves
//     14,051 entries and 147 MB. Excluding only `projects`, the first cut of this fix, dropped 14%
//     of the entries and left the walk slow; grep's cost is the BYTES it reads. Excludes are
//     per-FAMILY and a segment naming two takes the union: a repo-root grep never gets the home
//     ones, because --exclude-dir applies to a folder NAMED on the command line too and an
//     unneeded one can silently search nothing.
// The 4 that remain refused are correct: ~/.claude/projects, a `$(…)` path, and two `..` escapes.
//
// It drives the real hook as a subprocess, exactly as settings.json runs it, because a test that
// imported the matcher would pass against a hook wired to nothing.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");

/** `<HOME>` is the real home: the hook resolves `~/.claude` against its own, never the fake cwd. */
function fillPlaceholders(text: string, cwd: string, scratch: string): string {
  return text
    .replaceAll("<ROOT>", cwd.replace(/\\/g, "/"))
    .replaceAll("<SCRATCH>", scratch.replace(/\\/g, "/"))
    .replaceAll("<HOME>", homedir().replace(/\\/g, "/"));
}

type Decision = { decision: "allow" | "deny"; reason: string; command: string | null };

/** The flags the hook adds, in its own order. */
const EXCLUDES = "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=worktrees --exclude-dir=.codex-worktrees";
/** The three stores under ~/.claude — 13.7 GB of its 13.9 GB, and no rule or script lives in them. */
const HOME_EXCLUDES = "--exclude-dir=projects --exclude-dir=backups --exclude-dir=file-history";

/** The tool payload on stdin, in a folder that is not a git repository, so no other clause answers. */
function runGuard(cwd: string, scratch: string, command: string, tool = "Bash"): Decision {
  command = fillPlaceholders(command, cwd, scratch);
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  // The hook seeds $TEMP/$TMP/$TMPDIR, so the test must OWN them: a CI runner has no $TEMP at all,
  // and its `/tmp` is two segments deep, where this laptop's Temp is six. Pinning them to a folder
  // inside the scratch whose last segment is `Temp` makes both rows deterministic on either
  // platform — the Temp ROOT refused on its own last segment, a path under it placed.
  const temp = join(scratch, "Temp").replace(/\\/g, "/");
  Object.assign(env, { TEMP: temp, TMP: temp, TMPDIR: temp });
  const raw = execFileSync(process.execPath, [guardPath], {
    cwd,
    input: JSON.stringify({ tool_name: tool, cwd, tool_input: { command } }),
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
  if (!raw.trim()) return { decision: "allow", reason: "", command: null };
  const start = raw.indexOf('{"hookSpecificOutput"');
  assert.ok(start >= 0, `hook emitted something that is not a decision:\n${raw}`);
  const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return {
    decision: output.permissionDecision,
    reason: String(output.permissionDecisionReason ?? ""),
    command: output.updatedInput ? String(output.updatedInput.command) : null,
  };
}

/** A heredoc BODY that documents the rule. Writing it down must not trip it. */
const HEREDOC_NOTE = ["cat > note.md <<'EOF'", "Never run grep -r from the root:", "grep -rn x .", "EOF"].join("\n");

/** Recursive greps that cannot hang, passed through untouched. */
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
  { what: "a ~/.claude store NAMED directly still passes untouched", command: "grep -rn x ~/.claude/backups --include=*.mjs | head" },
  { what: "the dot after a cd into a named folder", command: "cd src && grep -rn x ." },
  { what: "the dot after a cd into a scratchpad", command: "cd \"C:/Users/someone/AppData/Local/Temp/claude/x/scratchpad\" && grep -rn x ." },
  { what: "the root with every exclude already given", command: `grep -rn x ${EXCLUDES} .` },
  { what: "the root with the excludes in one brace list", command: "grep -rn x --exclude-dir={node_modules,.git,.next,worktrees,.codex-worktrees} ." },
  { what: "a cd first", command: 'cd "F:/Phoenix Workforce/_wt-x" && grep -rn x src' },
  { what: "a pipe onward", command: "grep -rn x src | head -20" },
  { what: "stderr folded in", command: "grep -rn x src 2>&1 | head" },
  { what: "stderr discarded", command: "grep -rn x src tests 2>/dev/null" },
  { what: "egrep over a named folder", command: "egrep -rn 'a|b' app" },
  // The nine file-glob refusals of 22-23 Oct 2026, as they were typed. A glob naming a FILE matches
  // files, and grep never recurses into a file, so the folder holding it does not matter.
  { what: "a file glob at the root beside a named folder", command: 'grep -rnE "PHOENIX_LIVE_CRM_POLL" src/ instrumentation*.ts 2>/dev/null | grep -v test | head -8' },
  { what: "a dotted config glob at the root", command: 'grep -rn "import-x/order\\|simple-import-sort" eslint.config.* 2>/dev/null | head -3' },
  { what: "a compose glob at the root", command: 'grep -rn "tomcat/work" docker-compose*.yml infra/ 2>/dev/null | head -5' },
  { what: "a double-star glob under a named folder", command: 'grep -rn "stripComments" tests/*.ts src/**/*.ts 2>/dev/null | head -5' },
  { what: "a glob in the MIDDLE of a path", command: "grep -rnoE 'rpc\\(' src/lib/payroll/service.ts src/lib/expense*/*.ts 2>/dev/null | head" },
  { what: "a brace list of extensions", command: 'grep -rn x src/lib/sales/*.{ts,tsx} 2>/dev/null | head' },
  { what: "a glob two levels up from the files", command: 'grep -rl "mdm-console" "<SCRATCH>/"*/scratchpad/*.mjs 2>/dev/null | head' },
  { what: "a worktree glob with a literal path under it", command: 'cd "<SCRATCH>/Phoenix Workforce" && grep -rl "notification_backup" _wt-*/supabase/migrations/ 2>/dev/null' },
  // The six $TEMP refusals: it is set in every shell here, so the path CAN be placed.
  { what: "a folder under $TEMP", command: 'grep -rln "@Path" --include=*.java "$TEMP/hmdm-src"' },
  { what: "a deep POSIX scratchpad path, as a CI runner sees it", command: 'grep -rn \'"salary_records"\' /tmp/claude/proj/sess/scratchpad/tree/src | head -30' },
  { what: "a variable built from $TEMP", command: 'T="$TEMP/hmdm-src/tree"; grep -rn \'"salary_records"\' "$T/src" "$T/app" | head -30' },
  { what: "the dot after a cd into a $TEMP folder", command: 'cd "$TEMP/hmdm-src/h-mdm-server" && grep -rln "@Path" --include=*.java .' },
  { what: "a non-recursive grep of a file", command: "grep -n x package.json" },
  { what: "a non-recursive grep at the root", command: "grep x ." },
  { what: "git grep", command: "git grep -n x" },
  { what: "git grep whose PATTERN quotes the flag", command: 'git grep -n "grep -r" -- tests' },
  { what: "an echo that mentions it", command: 'echo "never run grep -rn x . from the root"' },
  { what: "a commit message about it", command: "git commit -m 'fix(hooks): grep -r over named folders is allowed'" },
  { what: "a heredoc body documenting it", command: HEREDOC_NOTE },
  { what: "a PowerShell here-string documenting it", command: ["$m = @'", "grep -rn x .", "'@", "git commit -m $m"].join("\n"), tool: "PowerShell" },
];

/**
 * A repo or worktree root, or its `.claude`, in a read-only command: allowed, with the excludes the
 * grep lacks added right after its `grep` word. `expect` is the exact command that must run.
 */
const REWRITTEN: Array<{ what: string; command: string; expect: string }> = [
  { what: "the dot", command: "grep -rn x .", expect: `grep ${EXCLUDES} -rn x .` },
  { what: "the dot with ./", command: "grep -rn x ./", expect: `grep ${EXCLUDES} -rn x ./` },
  { what: "no path at all — it walks the cwd", command: "grep -rn x", expect: `grep ${EXCLUDES} -rn x` },
  { what: "the long flag with no path", command: "grep --recursive x", expect: `grep ${EXCLUDES} --recursive x` },
  { what: "-e with no path", command: "grep -r -e x", expect: `grep ${EXCLUDES} -r -e x` },
  { what: "egrep", command: "egrep -r x", expect: `egrep ${EXCLUDES} -r x` },
  { what: "fgrep", command: "fgrep -r x .", expect: `fgrep ${EXCLUDES} -r x .` },
  { what: "a named folder plus the dot", command: "grep -rn x src .", expect: `grep ${EXCLUDES} -rn x src .` },
  { what: "the .claude folder", command: "grep -rn x .claude", expect: `grep ${EXCLUDES} -rn x .claude` },
  { what: "only the missing excludes are added", command: "grep -rn x --exclude-dir=node_modules --exclude-dir=.git .", expect: "grep --exclude-dir=.next --exclude-dir=worktrees --exclude-dir=.codex-worktrees -rn x --exclude-dir=node_modules --exclude-dir=.git ." },
  { what: "no path, behind a cd to a worktree", command: 'cd "F:/Phoenix Workforce/_wt-x" && grep -rl x', expect: `cd "F:/Phoenix Workforce/_wt-x" && grep ${EXCLUDES} -rl x` },
  { what: "the repo root by absolute path", command: 'grep -rn x "<ROOT>"', expect: `grep ${EXCLUDES} -rn x "<ROOT>"` },
  { what: "a worktree root by absolute path — no _wt-* exclude, or it would search nothing", command: 'grep -rn x "F:\\Phoenix Workforce\\_wt-foo"', expect: `grep ${EXCLUDES} -rn x "F:\\Phoenix Workforce\\_wt-foo"` },
  { what: "a folder that holds .git", command: 'grep -rn x "<SCRATCH>/somerepo"', expect: `grep ${EXCLUDES} -rn x "<SCRATCH>/somerepo"` },
  // ~/.claude is one folder of hooks, scripts, skills, docs and memory plus ONE big child — the
  // transcript store. Refusing the whole tree for it cost two refusals on 23 Oct 2026.
  { what: "home .claude gets its three stores excluded", command: "grep -rn x ~/.claude", expect: `grep ${HOME_EXCLUDES} -rn x ~/.claude` },
  { what: "home .claude by absolute path", command: 'grep -rn "CRON_SECRET" "<HOME>/.claude" --include=*.mjs -l | head -20', expect: `grep ${HOME_EXCLUDES} -rn "CRON_SECRET" "<HOME>/.claude" --include=*.mjs -l | head -20` },
  { what: "a repo root AND home .claude in one segment take the union", command: "grep -rln x . ~/.claude", expect: `grep ${EXCLUDES} ${HOME_EXCLUDES} -rln x . ~/.claude` },
  { what: "only the home exclude that is missing is added", command: "grep -rn x --exclude-dir=backups ~/.claude", expect: "grep --exclude-dir=projects --exclude-dir=file-history -rn x --exclude-dir=backups ~/.claude" },
  { what: "the second grep of a pipeline", command: "grep -rn x src | grep -rn y .", expect: `grep -rn x src | grep ${EXCLUDES} -rn y .` },
  { what: "after a semicolon", command: "echo hi; grep -rn x", expect: `echo hi; grep ${EXCLUDES} -rn x` },
  { what: "inside a command substitution", command: "echo $(grep -rn x .)", expect: `echo $(grep ${EXCLUDES} -rn x .)` },
  { what: "stderr folded in, still no path", command: "grep -rn x 2>&1 | head", expect: `grep ${EXCLUDES} -rn x 2>&1 | head` },
  { what: "an escaped quote does not hide the dot", command: 'grep -rn "a\\"|b" --include=*.ts . 2>/dev/null', expect: `grep ${EXCLUDES} -rn "a\\"|b" --include=*.ts . 2>/dev/null` },
  { what: "beside a sed that only prints", command: "sed -n '296,312p' src/a.ts && grep -rn x . | head", expect: `sed -n '296,312p' src/a.ts && grep ${EXCLUDES} -rn x . | head` },
  { what: "beside a git log and an ls", command: 'ls -la *.pdf 2>/dev/null | head; git log --oneline -i --grep="x" | head; grep -ril x . 2>/dev/null', expect: `ls -la *.pdf 2>/dev/null | head; git log --oneline -i --grep="x" | head; grep ${EXCLUDES} -ril x . 2>/dev/null` },
  { what: "the real refusal that skipped only node_modules", command: 'grep -rn "admin_work\\|dayActivit" --include=*.ts -l . --exclude-dir=node_modules --exclude-dir=.next | head -50; ls supabase/migrations | tail -3', expect: 'grep --exclude-dir=.git --exclude-dir=worktrees --exclude-dir=.codex-worktrees -rn "admin_work\\|dayActivit" --include=*.ts -l . --exclude-dir=node_modules --exclude-dir=.next | head -50; ls supabase/migrations | tail -3' },
];

/** A fixable root grep beside something that is not read-only: refused, WITH the fixed command. */
const REFUSED_WITH_FIX: Array<{ what: string; command: string; expect: string | null; tool?: string }> = [
  { what: "an output file", command: "grep -rln x . > hits.txt", expect: `grep ${EXCLUDES} -rln x . > hits.txt` },
  { what: "a pipe into a writer", command: "grep -rln x . | xargs sed -i s/a/b/", expect: `grep ${EXCLUDES} -rln x . | xargs sed -i s/a/b/` },
  { what: "a git command beside it", command: "git fetch -q && grep -rn x .", expect: `git fetch -q && grep ${EXCLUDES} -rn x .` },
  { what: "a sed that edits in place", command: "grep -rl x . | head; sed -i s/a/b/ src/a.ts", expect: `grep ${EXCLUDES} -rl x . | head; sed -i s/a/b/ src/a.ts` },
  { what: "a sed script that writes a file", command: "grep -rl x .; sed -n 's/a/b/w out.txt' src/a.ts", expect: `grep ${EXCLUDES} -rl x .; sed -n 's/a/b/w out.txt' src/a.ts` },
  { what: "a git log into a file", command: "git log --output=log.txt; grep -rn x .", expect: `git log --output=log.txt; grep ${EXCLUDES} -rn x .` },
  { what: "the PowerShell tool — no rewrite there", command: "grep -rn x .", expect: null, tool: "PowerShell" },
];

/** Recursive greps that walk somewhere they must not, excludes or not. All must be refused. */
const REFUSED: Array<{ what: string; command: string; tool?: string }> = [
  { what: "the parent — the workspace folder", command: "grep -rn x .." },
  { what: "a named folder plus the parent", command: "grep -r x src .." },
  { what: "an escape out of a named folder", command: "grep -r x src/../.." },
  { what: "a glob at the root", command: "grep -r x *" },
  { what: "a variable", command: "grep -rn x $PWD" },
  { what: "the home shortcut", command: "grep -R x docs ~" },
  { what: "node_modules", command: "grep -r x node_modules" },
  { what: "the worktrees", command: "grep -rn x .claude/worktrees" },
  { what: "an escape through a named folder", command: "grep -rn x public/../node_modules" },
  { what: "an absolute path", command: "grep -rn x /f/Phoenix" },
  { what: "a drive path", command: "grep -rn x C:/Users" },
  { what: "the dot after a cd to the workspace folder", command: "cd .. && grep -rn x ." },
  { what: "the workspace folder, even with every exclude", command: `grep -rn x ${EXCLUDES} ..` },
  { what: "a cd to an unknown variable, then the dot", command: "cd \"$NOWHERE\" && grep -rn x ." },
  { what: "the Temp ROOT itself, even though $TEMP now resolves", command: "grep -rn x \"$TEMP\"" },
  { what: "the POSIX temp root", command: "grep -rn x /tmp" },
  { what: "a variable that is genuinely unset", command: "grep -rn x \"$NO_SUCH_VAR_HERE\"" },
  { what: "the transcript store", command: "grep -rn x C:/Users/someone/.claude/projects" },
  { what: "the real transcript store, which the .claude allowance must not reach", command: "grep -rl 'AssertionError: 0' <HOME>/.claude/projects/" },
  { what: "everything under node_modules via a glob", command: "grep -rn x node_modules/*" },
  { what: "a bare glob under the home folder", command: "grep -rn x ~/*" },
  { what: "Temp", command: "grep -rn x C:/Users/someone/AppData/Local/Temp" },
  { what: "every dot folder", command: "grep -rn x .*" },
  { what: "the pnpm store", command: "grep -rn x node_modules/.pnpm" },
  { what: "the build output", command: "grep -r x .next" },
  { what: "a glob above a folder", command: "grep -r x */src" },
  { what: "a root grep beside a big one", command: "grep -rn x . ; grep -rn y node_modules" },
  { what: "an alias that would make every grep recursive", command: "alias grep='grep -r'" },
  { what: "the alias the old message warned against", command: "alias grep=rg" },
];

export function runBashGrepGuardTests(): void {
  assert.ok(existsSync(guardPath), `bash-guard not found at ${guardPath}`);
  // The cwd is a REPO ROOT inside a workspace folder, as every session here runs, so `.` and `..`
  // resolve to the trees that hang. `somerepo` is a repo root known only by its `.git`.
  const scratch = mkdtempSync(join(tmpdir(), "phx-grep-guard-"));
  const cwd = join(scratch, "Phoenix Workforce", "phoenix-workforce");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(scratch, "somerepo", ".git"), { recursive: true });
  const fill = (text: string) => fillPlaceholders(text, cwd, scratch);
  mkdirSync(join(scratch, "Phoenix Workforce", "_wt-one", "supabase", "migrations"), { recursive: true });
  mkdirSync(join(scratch, "Temp"), { recursive: true }); // what runGuard points $TEMP at
  try {
    for (const { what, command, tool } of ALLOWED) {
      const { decision, reason, command: rewritten } = runGuard(cwd, scratch, command, tool ?? "Bash");
      assert.equal(decision, "allow", `C1 must allow a recursive grep that cannot hang, and a mere mention (${what}):\n  ${command}\n  ${reason}`);
      assert.equal(rewritten, null, `C1 must leave a grep that cannot hang untouched (${what}):\n  ${command}\n  → ${rewritten}`);
    }

    for (const { what, command, expect } of REWRITTEN) {
      const { decision, reason, command: rewritten } = runGuard(cwd, scratch, command);
      assert.equal(decision, "allow", `C1 must allow a read-only grep of a repo root, with the excludes added (${what}):\n  ${command}\n  ${reason}`);
      assert.equal(rewritten, fill(expect), `C1 must add exactly the excludes the grep lacks, after its grep word (${what}):\n  ${command}`);
    }

    for (const { what, command, expect, tool } of REFUSED_WITH_FIX) {
      const { decision, reason, command: rewritten } = runGuard(cwd, scratch, command, tool ?? "Bash");
      assert.equal(decision, "deny", `C1 must not auto-allow a root grep beside a command that is not read-only (${what}):\n  ${command}`);
      assert.equal(rewritten, null, `a refusal must not carry a rewritten input (${what})`);
      assert.match(reason, /--exclude-dir=worktrees/, `the refusal must name the excludes (${what}):\n${reason}`);
      if (expect) assert.ok(reason.includes(fill(expect)), `the refusal must hand back the exact fixed command (${what}):\n${reason}`);
    }

    for (const { what, command, tool } of REFUSED) {
      const { decision, reason } = runGuard(cwd, scratch, command, tool ?? "Bash");
      assert.equal(decision, "deny", `C1 must refuse a recursive grep that walks a big tree (${what}):\n  ${command}`);
      assert.match(reason, /Recursive grep hangs/, `the refusal must say why (${what}):\n${reason}`);
      // The refusal has to hand back both the way out and the allowance, or the next session reads
      // it as the old blanket rule and argues with it.
      assert.match(reason, /NAMED folders/, `the refusal must say what IS allowed (${what}):\n${reason}`);
      assert.match(reason, /git grep/, `the refusal must name git grep as the way out (${what}):\n${reason}`);
    }

    // Other tools are none of this hook's business.
    assert.equal(runGuard(cwd, scratch, "grep -rn x .", "Read").decision, "allow", "the hook must return silently for any tool but Bash and PowerShell");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
