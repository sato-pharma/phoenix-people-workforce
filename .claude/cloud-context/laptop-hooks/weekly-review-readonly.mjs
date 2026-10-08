// weekly-review-readonly.mjs â€” PreToolUse guard for the claude-config-weekly-review scheduled run.
//
// WHY THIS EXISTS. The skill at ~/.claude/scheduled-tasks/claude-config-weekly-review/SKILL.md
// has always said, in capitals:
//
//     READ-ONLY. Change nothing in this run: no edits, no moves, no deletes, no git writes
//     (no fetch, commit, push or checkout), no settings changes.
//
// On 2026-09-21, between 01:41 and 02:21 Cairo, the automated run
// (session e346b8b6-dd26-4a32-b0f4-74546265fe7b) did all of the following anyway, unattended:
//   - rewrote  ~/.claude/scripts/xlsx-snapshot.cmd
//   - exported and RE-REGISTERED the "Phoenix xlsx Snapshot - Hourly" task XML
//   - rewrote  ~/.claude/scripts/claude-config-review.mjs
//   - ran      schtasks /run on the snapshot tasks 43 times in one hour
// The owner asked for the rule to be real rather than written down ("make the weekly config
// review read-only for real"), because prose in the skill did not hold.
//
// WHAT IT DOES. Nothing at all to any other session. It identifies the weekly-review run
// STRUCTURALLY â€” the first line of that run's transcript is a queue-operation whose content
// begins with the scheduled-task marker â€” and only then enforces:
//   - Write / Edit / NotebookEdit  -> denied outright. The run has never needed one: the
//     review SCRIPT writes the report, the model only reads it and reports to the owner.
//   - Bash / PowerShell            -> DEFAULT DENY. Every segment of the command (split on
//     ; && || |) must match the read-only allow-list below, which is drawn from what the
//     SKILL.md actually instructs: STEP 1's review script, STEP 2's `git show origin/main:â€¦`,
//     and ordinary readers.
//
// Denying is the safe direction here. A blocked run still produces its report and tells the
// owner what it could not do; an unblocked one rewrites the machine at 2am with nobody watching.
//
// IT FAILS OPEN on any error, and stays silent for every non-review session, so a bug here
// cannot wedge the owner's other sessions. PHX_WEEKLY_REVIEW_GUARD_OFF=1 stands it down.
//
// Self-test:  node weekly-review-readonly.mjs --selftest

import fs from 'node:fs';

const MARKER = '<scheduled-task name="claude-config-weekly-review"';
const LOG = 'C:/Users/satoh/.claude/hooks/weekly-review-readonly.log';

const logLine = (s) => {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()}  ${s}\n`); } catch { /* never fatal */ }
};

// ---------------------------------------------------------------- detection
// Read only the FIRST line of the transcript. This matters: a normal session that merely
// DISCUSSES the weekly review (as the session that wrote this guard did, at length) has the
// skill name all over its transcript. Only the scheduled run BEGINS with the marker, as a
// queue-operation record, so that is the one thing tested.
export function isWeeklyReviewFirstLine(line) {
  if (typeof line !== 'string' || !line.trim()) return false;
  let o;
  try { o = JSON.parse(line); } catch { return false; }
  if (o?.type !== 'queue-operation') return false;
  return typeof o.content === 'string' && o.content.trimStart().startsWith(MARKER);
}

function firstLineOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8').replace(/^\uFEFF/, '');
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// ---------------------------------------------------------------- allow-list
// Read-only git verbs only. `branch`, `checkout`, `fetch`, `worktree remove`, `config --set`
// and friends are deliberately absent â€” SKILL.md forbids git writes and needs none of them.
const GIT_READ = 'show|log|diff|status|rev-parse|cat-file|ls-files|ls-tree|rev-list|merge-base|describe|blame|shortlog|for-each-ref';

const ALLOW = [
  // STEP 1 â€” the review script itself. It is the one thing permitted to write, and it writes
  // only ~/.claude/reviews/ (report, dated copy, JSON snapshot).
  /^node\s+"?[A-Za-z]:[\\/]Users[\\/]satoh[\\/]\.claude[\\/]scripts[\\/]claude-config-review\.mjs"?(\s+--[\w-]+)*$/i,

  // STEP 2 â€” read-only git, with or without -C <path>.
  new RegExp(`^git\\s+(-C\\s+("[^"]*"|'[^']*'|\\S+)\\s+)?(${GIT_READ})\\b`, 'i'),
  /^git\s+(-C\s+("[^"]*"|'[^']*'|\S+)\s+)?worktree\s+list\b/i,
  /^git\s+(-C\s+("[^"]*"|'[^']*'|\S+)\s+)?config\s+(--get|--list)\b/i,

  // Ordinary readers.
  /^(cat|head|tail|wc|ls|dir|pwd|echo|type|file|stat|basename|dirname|sort|uniq|cut|tr|awk|jq|find|which|where)\b/i,
  /^sed\s+-n\b/i,                       // -n prints; -i edits in place and is NOT allowed
  /^(grep|egrep|fgrep|rg|findstr|Select-String)\b/i,

  // PowerShell readers and pipeline verbs.
  /^(Get-Content|Get-ChildItem|Get-Item|Get-ItemProperty|Test-Path|Resolve-Path|Get-Process|Get-WinEvent|Get-ScheduledTask|Get-ScheduledTaskInfo|Get-Date|Get-Command|Get-Module|Get-Variable)\b/i,
  /^(Select-Object|Where-Object|ForEach-Object|Sort-Object|Measure-Object|Group-Object|Format-Table|Format-List|Out-String|Write-Host|Write-Output|ConvertFrom-Json|ConvertTo-Json|ConvertFrom-StringData)\b/i,
];

// ---------------------------------------------------------------- MCP tools
// SKILL.md needs no MCP server at all, but plenty of them mutate â€” the scheduled-tasks server
// can re-register the very jobs the 2026-09-21 run rewrote by hand, and supabase can write
// production. Read-only verbs stay available so a future step can still LOOK at something.
const MCP_READONLY = /__(list|get|read|search|describe|show|query_logs|status|check|resolve|count|view)[_a-z0-9]*$/i;

export function isReadOnlyMcpTool(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return true; // not an MCP tool
  return MCP_READONLY.test(name);
}

// Redirections that only discard output are harmless; anything else writes a file.
const HARMLESS_REDIRECT = /(^|\s)(2>&1|2>\/dev\/null|>\/dev\/null|2>\$null|>\$null)(\s|$)/gi;

export function isReadOnlyCommand(raw) {
  if (typeof raw !== 'string') return false;
  const cmd = raw.trim();
  if (!cmd) return true;

  // A redirection to a real path is a write, whatever the verb in front of it.
  const stripped = cmd.replace(HARMLESS_REDIRECT, ' ');
  if (/[^2]>|^>/.test(stripped.replace(/2>&1/g, ''))) return false;

  // Backticks and $( ) can smuggle a second command past the segment split.
  if (/\$\(|`/.test(cmd)) return false;

  // Every segment must stand on its own.
  const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter(Boolean);
  return segments.every((seg) => ALLOW.some((re) => re.test(seg)));
}

// ---------------------------------------------------------------- hook body
const RECOVERY =
  'A fresh Claude Code session in this folder has no such guard - start one and repeat the instruction there.';

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function main() {
  if (process.env.PHX_WEEKLY_REVIEW_GUARD_OFF === '1') process.exit(0);

  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '') || '{}'); } catch { process.exit(0); }

  const transcript = input.transcript_path;
  if (!transcript) process.exit(0);
  if (!isWeeklyReviewFirstLine(firstLineOf(transcript))) process.exit(0); // every other session

  const tool = input.tool_name;

  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '(unnamed)';
    logLine(`DENY ${tool} ${target}`);
    deny(
      `The weekly config review is READ-ONLY (its own SKILL.md: "Change nothing in this run"), ` +
      `and that is now enforced, after the 2026-09-21 run rewrote scripts and re-registered a ` +
      `scheduled task unattended. ${tool} on ${target} is blocked. Do not work around this: ` +
      `finish the review and REPORT the change you wanted as a finding for the owner to approve. ${RECOVERY}`,
    );
  }

  if (!isReadOnlyMcpTool(tool)) {
    logLine(`DENY ${tool}`);
    deny(
      `The weekly config review is READ-ONLY and this MCP tool (${tool}) can change things. ` +
      `Its own SKILL.md needs no MCP server â€” read-only verbs (list/get/read/search) are still ` +
      `available. Report what you wanted to change as a finding for the owner instead. ${RECOVERY}`,
    );
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = input.tool_input?.command ?? '';
    if (!isReadOnlyCommand(cmd)) {
      logLine(`DENY ${tool} ${cmd.slice(0, 200)}`);
      deny(
        `The weekly config review is READ-ONLY and may run only read-only commands â€” the review ` +
        `script from STEP 1 and the read-only "git show" from STEP 2. This command is not one of ` +
        `them, so it is blocked (default-deny, after the 2026-09-21 run ran schtasks 43 times and ` +
        `rewrote two scripts unattended). Do not rephrase it to get past this: report what you ` +
        `wanted to change as a finding for the owner. ${RECOVERY}`,
      );
    }
  }

  process.exit(0);
}

// ---------------------------------------------------------------- self-test
if (process.argv.includes('--selftest')) {
  let bad = 0;
  // Counted at RUNTIME, never written as a literal: the count is what CI ratchets on
  // (tests/weekly-review-readonly-pin.test.ts), and a hand-kept total silently drifts from the cases
  // it claims to describe — the memory guard's selftest printed 16 for 18 of them the first time it
  // ran. The pin asserts this total equals the `ok` lines actually printed, so the two cannot diverge.
  let ran = 0;
  const check = (name, got, want) => {
    ran++;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${got}, want ${want})`}`);
  };

  const qop = (content) => JSON.stringify({ type: 'queue-operation', content });

  // --- detection: only the real run is caught -------------------------------
  check('detects the scheduled run', isWeeklyReviewFirstLine(qop(`${MARKER} file="x">\nrun it`)), true);
  check('ignores a human session', isWeeklyReviewFirstLine(JSON.stringify({ type: 'user', message: { content: 'hi' } })), false);
  check('ignores a session DISCUSSING the review',
    isWeeklyReviewFirstLine(JSON.stringify({ type: 'user', message: { content: `talk about ${MARKER}` } })), false);
  check('ignores a different scheduled task',
    isWeeklyReviewFirstLine(qop('<scheduled-task name="some-other-task" file="y">')), false);
  check('ignores junk', isWeeklyReviewFirstLine('not json'), false);
  check('ignores empty', isWeeklyReviewFirstLine(''), false);

  // --- what the skill legitimately needs ------------------------------------
  check('STEP 1 review script', isReadOnlyCommand('node "C:/Users/satoh/.claude/scripts/claude-config-review.mjs" --quiet'), true);
  check('STEP 2 git show', isReadOnlyCommand('git -C "F:/Phoenix Workforce/phoenix-workforce" show origin/main:AGENTS.md'), true);
  check('reading a file', isReadOnlyCommand('cat C:/Users/satoh/.claude/settings.json'), true);
  check('grep pipeline', isReadOnlyCommand('grep -n autoMode settings.json | head -5'), true);
  check('powershell read', isReadOnlyCommand('Get-ScheduledTask | Where-Object { $_.State -eq "Ready" } | Select-Object TaskName'), true);
  check('sed -n prints', isReadOnlyCommand('sed -n 1,40p SKILL.md'), true);

  // --- exactly what the 2026-09-21 run actually did --------------------------
  check('schtasks /run', isReadOnlyCommand("schtasks /run /tn 'Phoenix xlsx Snapshot - Fetch'"), false);
  check('Set-ScheduledTask', isReadOnlyCommand('Set-ScheduledTask -TaskName "Phoenix xlsx Snapshot - Hourly" -Action $a'), false);
  check('Register-ScheduledTask', isReadOnlyCommand('Register-ScheduledTask -Xml $x -TaskName "t" -Force'), false);
  check('node -e rewriting a file', isReadOnlyCommand('node -e \'require("fs").writeFileSync("x.cmd","boom")\''), false);
  check('cp over a script', isReadOnlyCommand('cp xlsx-snapshot.fixed.cmd scripts/xlsx-snapshot.cmd'), false);
  check('mv', isReadOnlyCommand('mv a.cmd b.cmd'), false);
  check('mkdir && mv chain', isReadOnlyCommand('mkdir -p backups/x && mv a b'), false);

  // --- bypass shapes ---------------------------------------------------------
  check('redirect to a file', isReadOnlyCommand('cat a.txt > b.txt'), false);
  check('append to a file', isReadOnlyCommand('echo hi >> settings.json'), false);
  check('tee', isReadOnlyCommand('cat a | tee b.txt'), false);
  check('sed -i', isReadOnlyCommand('sed -i s/a/b/ settings.json'), false);
  check('command substitution', isReadOnlyCommand('cat $(find . -name x)'), false);
  check('backtick substitution', isReadOnlyCommand('cat `ls`'), false);
  check('good verb, bad second segment', isReadOnlyCommand('cat a.txt && rm -rf b'), false);
  check('git write verb', isReadOnlyCommand('git -C . checkout main'), false);
  check('git fetch', isReadOnlyCommand('git fetch origin'), false);
  check('git branch -D', isReadOnlyCommand('git branch -D codex/x'), false);
  check('Remove-Item', isReadOnlyCommand('Remove-Item -LiteralPath x -Force'), false);
  check('Set-Content', isReadOnlyCommand('Set-Content -Path settings.json -Value $v'), false);
  check('Out-File', isReadOnlyCommand('Get-Content a | Out-File b.txt'), false);
  check('pnpm install', isReadOnlyCommand('pnpm install'), false);

  // --- MCP tools -------------------------------------------------------------
  check('mcp update_scheduled_task', isReadOnlyMcpTool('mcp__scheduled-tasks__update_scheduled_task'), false);
  check('mcp run_scheduled_task', isReadOnlyMcpTool('mcp__scheduled-tasks__run_scheduled_task'), false);
  check('mcp delete_scheduled_task', isReadOnlyMcpTool('mcp__scheduled-tasks__delete_scheduled_task'), false);
  check('mcp supabase execute_sql', isReadOnlyMcpTool('mcp__supabase-production__execute_sql'), false);
  check('mcp supabase apply_migration', isReadOnlyMcpTool('mcp__supabase-production__apply_migration'), false);
  check('mcp list_scheduled_tasks reads', isReadOnlyMcpTool('mcp__scheduled-tasks__list_scheduled_tasks'), true);
  check('mcp list_task_runs reads', isReadOnlyMcpTool('mcp__scheduled-tasks__list_task_runs'), true);
  check('mcp get_project reads', isReadOnlyMcpTool('mcp__supabase-production__get_project'), true);
  check('mcp search_docs reads', isReadOnlyMcpTool('mcp__supabase-production__search_docs'), true);
  check('non-mcp tool untouched here', isReadOnlyMcpTool('Bash'), true);

  // --- harmless redirects still pass ----------------------------------------
  check('2>/dev/null tolerated', isReadOnlyCommand('cat missing.txt 2>/dev/null'), true);
  check('2>&1 tolerated', isReadOnlyCommand('git status 2>&1'), true);

  // The summary line is a CONTRACT, not prose. `claude-scripts-backup.mjs` (HOOK_SELFTESTS) accepts a
  // hook as healthy only on `exit 0` AND a line matching `0 failed`, so the old wording — "all checks
  // passed" — would have had the hourly run report this perfectly good guard as BROKEN. Changed with
  // the pin rather than teaching the runner a sixth spelling: one shape across every hook is what
  // makes a single `0 failed` test trustworthy. Keep `cases, failed` if this line is ever reworded.
  console.log(`\nSELFTEST weekly-review-readonly: ${ran} cases, ${bad} failed`);
  process.exit(bad === 0 ? 0 : 1);
} else {
  try { main(); } catch (e) {
    if (e?.[Symbol.for('phx.hook-exit')]) throw e; // main's own exit, under hook-dispatch.mjs — not an error
    logLine(`hook error (failed open): ${e.message}`); process.exit(0);
  }
}
