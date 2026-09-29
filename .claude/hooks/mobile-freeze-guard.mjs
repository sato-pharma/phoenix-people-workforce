#!/usr/bin/env node
// PreToolUse(Write|Edit|NotebookEdit|Bash|PowerShell) guard — the MOBILE-APP FREEZE.
//
// THE RULE, IN HIS OWN WORDS (owner, 2026-09-29):
//
//     "the mobile app do not work or touch or think in it. Do not work or touch or even think or
//      ask me in it. Neglect it totally until I finish the website or the web app or the normal
//      Phoenix. After this, I will tell you, delete this golden rule ... Until I say this word,
//      never suggest on me, never ask me, never consider it in any of my wording."
//
// WHY A HOOK AND NOT ONLY A RULE. AGENTS.md §4 carries the freeze and auto-loads on every request,
// which reaches every NEW session — and reaches none of the dozen already open, including the one
// literally titled "Mobile app Phoenix CRM module" that was mid-task when he said this. A hook is
// re-read by node on every single tool call, so an open session hits it on its next command. The
// same argument that put C8 (the local typecheck) into bash-guard.mjs.
//
// WHAT IT REFUSES, AND WHAT IT DELIBERATELY DOES NOT.
//
//   - It refuses WRITES into `mobile/` (Write/Edit/NotebookEdit, and the shell forms: a redirect,
//     sed -i, rm/mv/cp/touch/mkdir, git apply/checkout/restore naming a mobile path).
//   - It refuses the mobile TOOLCHAIN anywhere: `eas ...`, `expo ...`, `npx expo`, and a
//     `gh workflow run` naming the Mobile workflow — an EAS build ships an APK to the rep fleet,
//     which is exactly the "work in it" he stopped.
//   - It does NOT refuse READS. `git grep`, a repo-wide sweep, `git log`, a CI script and
//     `repo:doctor` all touch mobile paths incidentally, and a guard that denies commands which
//     work is a guard that gets switched off inside a day (bash-guard retired its jq rule for
//     exactly that). The freeze's "never think about it" half is behavioural, held by AGENTS.md.
//   - It does NOT refuse `node_modules` paths that happen to contain a `mobile` segment.
//
// LIFTING IT. He lifts the freeze in his own words, and lifting it means DELETING this hook, its
// registration in .claude/settings.json, tests/mobile-freeze.test.ts and its registration in
// tests/run-tests.ts, and the §4 rule — he asked for a rule he can order deleted in one sentence.
// `PHX_MOBILE_FREEZE_OFF=1` stands it down for one command; it is not the lift.

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const STAND_DOWN = 'PHX_MOBILE_FREEZE_OFF';

const HIS_WORDS =
  'THE MOBILE APP IS FROZEN (owner, 2026-09-29): "do not work or touch or even think or ask me in ' +
  'it. Neglect it totally until I finish the website ... never suggest on me, never ask me, never ' +
  'consider it in any of my wording."';

const HOW_TO_PROCEED =
  'Do the web-app half of the task and leave the mobile half undone — say in one line that the ' +
  'mobile side is frozen, and do NOT ask him about it. Only he lifts the freeze, in his own words, ' +
  `about the mobile app; nothing else does. ${STAND_DOWN}=1 stands this down for one command, and ` +
  'that is for him to ask for, not for you to reach for.';

/* ------------------------------------------------------------------ path rule */

/**
 * True when a file path is inside the frozen mobile app.
 *
 * The test is a path SEGMENT equal to `mobile`, not a substring: `_wt-mobile-freeze`,
 * `mobile-freeze.test.ts` and `src/components/mobile-card.tsx` are all untouched, while
 * `mobile/src/app/index.tsx` and an absolute path to it are caught. `mobile/` is the only tracked
 * directory of that name in this repo (checked 2026-09-29), so the segment is unambiguous.
 * Anything under `node_modules` is a dependency, never his app.
 */
export function isMobilePath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return false;
  const segments = rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.includes('node_modules')) return false;
  return segments.includes('mobile');
}

/* ----------------------------------------------------------------- shell rule */

// The mobile toolchain, wherever it is run from. `eas`/`expo` exist in this repo for one app.
const TOOLCHAIN = [
  /(^|[\s;&|(])(?:npx\s+|pnpm\s+(?:exec|dlx)\s+|yarn\s+|bunx\s+)?eas(?:-cli)?(?=\s|$)/i,
  /(^|[\s;&|(])(?:npx\s+|pnpm\s+(?:exec|dlx)\s+|yarn\s+|bunx\s+)?expo(?=\s|$)/i,
  /gh\s+workflow\s+run\s+["']?mobile/i,
];

// Shell verbs that WRITE. Each must also name a mobile path for the clause to fire.
const WRITE_VERBS = [
  /(^|[\s;&|])(?:rm|mv|cp|touch|mkdir|rmdir|chmod|ln)(?=\s)/i,
  /(^|[\s;&|])sed\s+[^|;]*-i/i,
  /(^|[\s;&|])(?:tee|dd)(?=\s)/i,
  /(^|[\s;&|])git\s+(?:apply|checkout|restore|rm|add|clean)(?=\s)/i,
  /(^|[\s;&|])(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item)(?=\s)/i,
];

const REDIRECT_INTO_MOBILE = /(?:^|[^>])>>?\s*["']?(?:[^\s"';|&]*[/\\])?mobile[/\\]/i;

/** Every whitespace-delimited word of a command that looks like a path naming `mobile/`. */
function commandNamesMobilePath(command) {
  return /(^|[\s"'=(,])(?:[^\s"';|&]*[/\\])?mobile[/\\]/i.test(command);
}

/**
 * The verdict for a shell command: `null` to allow, or a short reason to deny.
 *
 * Reads are allowed on purpose — see the header. A command is only refused when it runs the mobile
 * toolchain, or when a writing verb (or a redirect) is pointed at a mobile path.
 */
export function shellVerdict(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  if (TOOLCHAIN.some((re) => re.test(command))) {
    return 'it runs the Expo/EAS mobile toolchain';
  }
  if (REDIRECT_INTO_MOBILE.test(command)) {
    return 'it redirects output into `mobile/`';
  }
  if (commandNamesMobilePath(command) && WRITE_VERBS.some((re) => re.test(command))) {
    return 'it writes to a path inside `mobile/`';
  }
  return null;
}

/* ------------------------------------------------------------------ hook entry */

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  if (process.env[STAND_DOWN] === '1') return;

  const payload = readStdin();
  if (!payload.trim()) return;

  let input;
  try {
    input = JSON.parse(payload);
  } catch {
    return; // unparseable stdin is not something to deny
  }

  const tool = input.tool_name || '';
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};

  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const raw = toolInput.file_path || toolInput.notebook_path || toolInput.path || '';
    const target = raw && !isAbsolute(raw) ? resolve(process.cwd(), raw) : raw;
    if (!isMobilePath(target)) return;
    return deny(
      `${HIS_WORDS}\n\n${target} is inside the frozen mobile app, so this edit is refused.\n\n${HOW_TO_PROCEED}`,
    );
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const why = shellVerdict(toolInput.command);
    if (!why) return;
    return deny(
      `${HIS_WORDS}\n\nThis command is refused because ${why}. Reading mobile files is not blocked ` +
        `— only working in the app is.\n\n${HOW_TO_PROCEED}`,
    );
  }
}

/* -------------------------------------------------------------------- selftest */

function selftest() {
  let total = 0;
  let failed = 0;
  const check = (label, actual, expected) => {
    total += 1;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
      failed += 1;
      console.error(`  FAIL ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
    }
  };

  check('a mobile source file is frozen', isMobilePath('mobile/src/app/index.tsx'), true);
  check('an absolute mobile path is frozen', isMobilePath('F:/Phoenix Workforce/x/mobile/app.json'), true);
  check('a windows-separator mobile path is frozen', isMobilePath('F:\\repo\\mobile\\eas.json'), true);
  check('a web file is not', isMobilePath('src/app/employee-portals/page.tsx'), false);
  check('a mobile-named web file is not', isMobilePath('src/components/mobile-card.tsx'), false);
  check('this worktree is not', isMobilePath('F:/Phoenix Workforce/_wt-mobile-freeze/AGENTS.md'), false);
  check('a dependency is not', isMobilePath('node_modules/x/mobile/index.js'), false);

  check('eas build is refused', shellVerdict('eas build --profile mdm'), 'it runs the Expo/EAS mobile toolchain');
  check('npx expo is refused', shellVerdict('npx expo start'), 'it runs the Expo/EAS mobile toolchain');
  check('a write into mobile is refused', shellVerdict('rm -rf mobile/src/app'), 'it writes to a path inside `mobile/`');
  check('a redirect into mobile is refused', shellVerdict('echo x > mobile/app.json'), 'it redirects output into `mobile/`');
  check('reading mobile is allowed', shellVerdict('cat mobile/app.json'), null);
  check('grepping for mobile is allowed', shellVerdict('git grep -n mobile -- .'), null);
  check('the web dev server is allowed', shellVerdict('node scripts/dev-server.mjs --port 3000'), null);
  check('a commit mentioning mobile is allowed', shellVerdict('git commit -m "docs: the mobile freeze"'), null);

  console.log(`  ${total} cases, ${failed} failed`);
  if (failed) {
    console.error('SELFTEST FAILED');
    process.exit(1);
  }
  console.log('SELFTEST OK');
}

try {
  main();
} catch {
  process.exit(0); // fail open, always
}
