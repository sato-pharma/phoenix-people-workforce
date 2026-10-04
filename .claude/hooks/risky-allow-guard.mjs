#!/usr/bin/env node
// PreToolUse(Write|Edit|MultiEdit|NotebookEdit) guard — denies a SESSION edit that adds a risky
// "allow" wildcard to any Claude settings file committed in this repo
// (<repo>/.claude/settings*.json, or a user/managed settings file if one is ever edited here).
//
// WHY THIS EXISTS. 2026-10-05: a sweep found blanket inline-execution allow wildcards —
// `Bash(python -c ' *)`, `Bash(node -e ' *)`, `Bash(npx *)` — sitting in several repos'
// settings.local.json. Each one hands any future session the right to run arbitrary inline code
// (or, for `railway run *`, any command with the PRODUCTION Railway secrets injected) with the
// auto-mode classifier never looking at it.
//
// There is an identical guard on the laptop (~/.claude/hooks/risky-allow-guard.mjs), but that one
// is a USER-level hook and a CLOUD session never has ~/.claude — a cloud clone is repo-plus-prompt
// only (AGENTS.md §5). So a cloud session could still add a risky wildcard to this repo's committed
// .claude/settings.json with nothing to stop it. This repo copy closes that gap: it ships in the
// repo, so it loads for every session that opens this project, laptop or cloud.
//
// WHAT IT CATCHES — only a genuine blanket wildcard, never an exact command:
//   Bash(node -e ' *)   Bash(python -c ' *)   Bash(sh -c ' *)   Bash(npx *)   Bash(railway run *)
// An exact literal like `Bash(python -c 'print(1)')` is NOT a wildcard and is allowed through, same
// as the daily config review's RISKY table — the patterns are kept in sync deliberately.
//
// WHAT IT DOES NOT DO. It cannot intercept the harness writing an allow rule after a human clicks
// "always allow" in the permission UI — that is not a Write/Edit tool call. It guards the SESSION
// path: a Write of a whole settings file, or an Edit/MultiEdit/NotebookEdit whose new text
// introduces such an entry. It never touches a file and never denies a read.
//
// FAILS OPEN. Any error, any missing field, anything unparseable → exit 0 with no output ("no
// opinion"). A guard bug must never block a real edit.
//
// ESCAPE HATCH: PHX_RISKY_ALLOW_GUARD_OFF=1 in the environment turns it off, same shape as the other
// repo guards. A human deliberately adding a wildcard would do it with the guard stood down.
//
//   node .claude/hooks/risky-allow-guard.mjs --selftest

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// The SAME patterns as claude-config-review.mjs's RISKY table — one definition of "risky wildcard".
export const RISKY = [
  [/^(Bash|PowerShell)\(node -e ?['"]? ?\*\)$|^(Bash|PowerShell)\(node -e:\*\)$/i, 'any inline JavaScript runs without review'],
  [/^(Bash|PowerShell)\(python3? -c ?['"]? ?\*\)$|^(Bash|PowerShell)\(python3? -c:\*\)$/i, 'any inline Python runs without review'],
  [/^(Bash|PowerShell)\((bash|sh|zsh) -c ?['"]? ?\*\)$/i, 'any inline shell script runs without review'],
  [/^(Bash|PowerShell)\((pnpm|npm) exec[ :]\*\)$|^(Bash|PowerShell)\(npx[ :]\*\)$/i, 'any package binary runs without review'],
  [/^(Bash|PowerShell)\(railway run[ :]/i, 'any command with the production Railway secrets injected, unreviewed'],
];

/** Every risky hit in a list of candidate allow-entry strings: [{ entry, why }]. */
export function riskyHits(entries) {
  const out = [];
  for (const e of entries) {
    if (typeof e !== 'string') continue;
    for (const [re, why] of RISKY) if (re.test(e.trim())) { out.push({ entry: e.trim(), why }); break; }
  }
  return out;
}

/** Is this file a Claude settings file we should guard? */
export function isSettingsFile(file) {
  if (!file) return false;
  const p = String(file).replace(/\\/g, '/');
  const base = basename(p);
  if (base !== 'settings.json' && base !== 'settings.local.json' && base !== 'managed-settings.json') return false;
  return /(^|\/)\.claude\/|\/ClaudeCode\//i.test(p) || /\.claude\.json$/i.test(p); // repo .claude, user .claude, managed
}

/** Pull quoted string literals out of a text fragment (an Edit's new_string). */
export function quotedStrings(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    try { out.push(JSON.parse(`"${m[1]}"`)); } catch { out.push(m[1]); }
  }
  return out;
}

/** The permissions.allow array out of a whole settings-file body, or [] if it isn't one. */
function allowFromContent(raw) {
  try {
    const obj = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    const allow = obj?.permissions?.allow;
    return Array.isArray(allow) ? allow : [];
  } catch {
    // not valid JSON yet — fall back to scanning quoted strings so a partial write is still caught
    return quotedStrings(raw);
  }
}

/** Candidate allow entries introduced by a tool call. For Write: the file's permissions.allow.
 *  For Edit/MultiEdit/NotebookEdit: every quoted string in the new text (a conservative superset). */
export function candidatesFrom(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  if (toolName === 'Write' && typeof toolInput.content === 'string') {
    return allowFromContent(toolInput.content);
  }
  if (toolName === 'Edit') {
    return [toolInput.new_string, toolInput.replacement, toolInput.content]
      .filter((s) => typeof s === 'string')
      .flatMap(quotedStrings);
  }
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .flatMap((e) => (e && typeof e === 'object' ? [e.new_string, e.replacement] : []))
      .filter((s) => typeof s === 'string')
      .flatMap(quotedStrings);
  }
  if (toolName === 'NotebookEdit') {
    return [toolInput.new_source, toolInput.new_string]
      .filter((s) => typeof s === 'string')
      .flatMap(quotedStrings);
  }
  return [];
}

/* ------------------------------------------------------------------ selftest */

function selftest() {
  let total = 0, failed = 0;
  const check = (label, got, want) => { total++; if (JSON.stringify(got) !== JSON.stringify(want)) { failed++; console.error(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); } };

  console.log('SELFTEST risky-allow-guard:');

  // isSettingsFile
  check('repo settings', isSettingsFile('F:/Repo/.claude/settings.json'), true);
  check('repo local settings', isSettingsFile('F:/Repo/.claude/settings.local.json'), true);
  check('managed settings', isSettingsFile('C:/Program Files/ClaudeCode/managed-settings.json'), true);
  check('a backslash path', isSettingsFile('F:\\Repo\\.claude\\settings.local.json'), true);
  check('not a settings file', isSettingsFile('F:/Repo/src/config/system-settings.ts'), false);
  check('some other settings.json not under .claude', isSettingsFile('F:/Repo/.vscode/settings.json'), false);

  // riskyHits — positives
  const pos = ["Bash(python -c ' *)", 'Bash(node -e " *)', 'Bash(sh -c \' *)', 'Bash(npx *)', 'Bash(pnpm exec *)', 'Bash(railway run *)', 'PowerShell(python -c:*)'];
  check('all risky wildcards hit', riskyHits(pos).length, pos.length);
  // riskyHits — negatives (exact commands and benign rules must pass)
  const neg = ["Bash(python -c 'print(1)')", 'Bash(node scripts/foo.mjs)', 'Bash(FORMAT=vertical npx tsx record-demo.ts)', 'Bash(git status)', 'Bash(rm -rf .next node_modules/.cache)', 'Read(//c/Users/satoh/**)', 'Bash(python -)'];
  check('no benign rule hits', riskyHits(neg), []);

  // candidatesFrom — Write with a whole settings object
  const writeInput = { content: JSON.stringify({ permissions: { allow: ['Bash(git status)', "Bash(python -c ' *)"] } }) };
  check('Write surfaces the risky allow entry', riskyHits(candidatesFrom('Write', writeInput)).map((h) => h.entry), ["Bash(python -c ' *)"]);
  const writeClean = { content: JSON.stringify({ permissions: { allow: ['Bash(git status)', "Bash(python -c 'print(1)')"] } }) };
  check('Write with only an exact command is clean', riskyHits(candidatesFrom('Write', writeClean)), []);

  // candidatesFrom — Edit adding a single line
  const editInput = { old_string: '      "Bash(git status)",', new_string: '      "Bash(git status)",\n      "Bash(python -c \' *)",' };
  check('Edit adding the wildcard line is caught', riskyHits(candidatesFrom('Edit', editInput)).map((h) => h.entry), ["Bash(python -c ' *)"]);
  const editClean = { new_string: '      "Bash(gh pr view 5320)",' };
  check('Edit adding a benign exact command is clean', riskyHits(candidatesFrom('Edit', editClean)), []);

  // candidatesFrom — MultiEdit adding the wildcard in one of several edits
  const multiInput = { edits: [{ old_string: 'a', new_string: '"Bash(git status)"' }, { old_string: 'b', new_string: '"Bash(npx *)"' }] };
  check('MultiEdit adding the wildcard is caught', riskyHits(candidatesFrom('MultiEdit', multiInput)).map((h) => h.entry), ['Bash(npx *)']);
  const multiClean = { edits: [{ old_string: 'a', new_string: '"Bash(gh pr view 1)"' }] };
  check('MultiEdit with only exact commands is clean', riskyHits(candidatesFrom('MultiEdit', multiClean)), []);

  // candidatesFrom — NotebookEdit new_source
  const nbInput = { new_source: 'cfg = { "permissions": { "allow": ["Bash(railway run *)"] } }' };
  check('NotebookEdit new_source wildcard is caught', riskyHits(candidatesFrom('NotebookEdit', nbInput)).map((h) => h.entry), ['Bash(railway run *)']);

  console.log(`  ${total} cases, ${failed} failed`);
  if (failed) { console.error('SELFTEST FAILED'); process.exit(1); }
  console.log('SELFTEST OK');
}

/* ------------------------------------------------------------------ hook entry */

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  if (process.env.PHX_RISKY_ALLOW_GUARD_OFF === '1') return;

  let payload = '';
  try { payload = readFileSync(0, 'utf8'); } catch { return; }
  if (!payload.trim()) return;

  let input;
  try { input = JSON.parse(payload); } catch { return; }

  const toolName = input.tool_name;
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'NotebookEdit') return;
  const ti = input.tool_input || {};
  const file = ti.file_path || ti.path || ti.notebook_path;
  if (!isSettingsFile(file)) return;

  const hits = riskyHits(candidatesFrom(toolName, ti));
  if (!hits.length) return;

  const list = hits.slice(0, 5).map((h) => `  • ${h.entry} — ${h.why}`).join('\n');
  const reason =
    `This edit adds a blanket "allow" wildcard to ${file} that pre-approves arbitrary execution with ` +
    `no review:\n${list}\n\n` +
    'Add only an exact, scoped command (e.g. `Bash(python scripts/one-tool.py)`), not a `*` wildcard ' +
    'over an inline interpreter, `npx`, or `railway run`. The daily config review flags these and the ' +
    'owner had every one removed on 2026-10-05. If a human explicitly wants this wildcard, set ' +
    'PHX_RISKY_ALLOW_GUARD_OFF=1 for the command that writes it.';

  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  })}\n`);
}

try { main(); } catch { process.exit(0); } // fail open, always
