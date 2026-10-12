#!/usr/bin/env node
// PreToolUse(Write|Edit|MultiEdit) guard — a new test file that strips comments BY HAND is refused
// as it is written, instead of five minutes into CI.
//
// WHY THIS EXISTS. `tests/comment-strip-ratchet.test.ts` is zero-tolerance: no test under `tests/`
// may decide line by line whether something is a comment — not with a `.filter`, not with an
// `if (…) continue`, not with a whole-line `.replace` — because a line judged by how it STARTS
// cannot know a block comment is already open. The remedy has been one import since #4382:
//
//     import { stripComments } from "./support/comment-strip.ts";
//
// The rule is right and the detector works. What it costs is the TIMING. It is the last assertion
// of a 977-test shard inside the required `validate` job: on PR 5700 (2026-10-09) it named its
// offender after 5m34s with `checks` already green, so the run looks healthy until the final
// second. On 12 Oct 2026, four of the twenty-five red PR runs of the day were this one ratchet
// firing on a newly added test file — a full CI round each, to be told a one-line import was
// missing. This hook moves that same verdict to the Write or Edit that introduces the shape.
//
// WHY IT DENIES RATHER THAN WARNS. `test-registration-check.mjs` next to it only warns, and that is
// right for registration: a session normally writes the test first and registers it one edit later,
// so the first warning of that pair is a nudge, not a fault. There is no such two-step here. A
// hand-rolled strip is wrong the moment it is written, the budget is 0 with an empty grandfather
// list, and no later edit makes it acceptable — so the honest answer is to refuse the text and name
// the import. It refuses an EDIT, never a push: AGENTS.md §7's "no step stands in front of the
// push" and the owner's 2026-10-04 "keep the pre-push test as a rule, no guard" are about the test
// SUITE, and this hook neither runs nor waits for one.
//
// WHAT IT READS. Only the text being introduced — `content` for Write, `new_string` for Edit, each
// edit's `new_string` for MultiEdit. Not the file on disk: a pre-existing site elsewhere in the
// file must not block an unrelated edit, and a session must always be able to EDIT an offender away.
// The three sanctioned files (the stripper itself, the ratchet, and this guard's test, whose
// fixtures ARE the shapes) are skipped exactly as the sweep skips them.
//
// ONE DEFINITION. The detector lives in `./lib/comment-strip-shapes.mjs` and the ratchet imports it
// from there too, so the hook cannot drift into refusing what CI accepts. `tests/comment-strip-guard.test.ts`
// fails if either side grows its own copy back.
//
// FAILS OPEN. Any error, any missing field, unparseable stdin: exit 0 with no output, which the
// engine reads as "no opinion". A hook bug must never block a real edit.
//
// ESCAPE HATCH: PHX_COMMENT_STRIP_OFF=1 in the session's environment turns it off, the same shape
// as PHX_PRIMARY_GUARD_OFF. The one legitimate case is a fourth sanctioned file being written for
// the first time — add it to SANCTIONED_TEST_FILES in the same change.
//
//   node .claude/hooks/comment-strip-guard.mjs --selftest

import { readFileSync } from 'node:fs';

import { isSanctioned, lineWiseStripSites } from './lib/comment-strip-shapes.mjs';

/** Exactly what the ratchet's own sweep reads: every `.ts` file under `tests/`, at any depth. */
const SWEPT_TEST_FILE = /(?:^|\/)tests\/(?:[^/]+\/)*[^/]+\.ts$/;

/**
 * Is this path a file the CI ratchet will sweep? `.tsx` is deliberately NOT included: the sweep
 * reads `.ts` only, and a hook stricter than the check it fronts for refuses work CI would accept.
 */
export function isSweptTestFile(file) {
  const slashed = String(file || '').replace(/\\/g, '/');
  return SWEPT_TEST_FILE.test(slashed) && !isSanctioned(slashed);
}

/**
 * The text a tool call is about to introduce, in the order it appears in the call. One string per
 * piece of new text, so a reported line number is a line of that piece.
 */
export function incomingText(tool, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (tool === 'Write') return [String(input.content ?? '')];
  if (tool === 'Edit') return [String(input.new_string ?? '')];
  if (tool === 'MultiEdit') {
    return (Array.isArray(input.edits) ? input.edits : []).map((edit) => String(edit?.new_string ?? ''));
  }
  return [];
}

/**
 * The shapes this call would introduce: one entry per site, naming the line WITHIN the piece of new
 * text and the line itself, so the message points at something the session can see in its own call.
 */
export function offendingSites(tool, toolInput) {
  const found = [];
  for (const [piece, text] of incomingText(tool, toolInput).entries()) {
    const lines = text.split('\n');
    for (const line of lineWiseStripSites(text)) {
      found.push({ piece, line, text: (lines[line - 1] ?? '').trim() });
    }
  }
  return found;
}

/** The whole decision, as data: `null` for no opinion, or the sites to refuse over. */
export function verdict({ tool, filePath, toolInput }) {
  if (tool !== 'Write' && tool !== 'Edit' && tool !== 'MultiEdit') return null;
  if (!isSweptTestFile(filePath)) return null;
  const sites = offendingSites(tool, toolInput);
  return sites.length ? sites : null;
}

/** The refusal text. Named separately so the selftest can assert the remedy is in it. */
export function reasonFor(filePath, sites) {
  const where = sites
    .map((site) => `line ${site.line}${site.text ? `: ${site.text}` : ''}`)
    .join('\n    ');
  return (
    `This edit to ${filePath} strips comments line by line, at:\n    ${where}\n\n` +
    'Every spelling of that shape shares one blindness: a line is judged by how it STARTS, so ' +
    'nothing tracks whether a comment is already open. In JS/TSX the body of a multi-line ' +
    '`{/* … */}` is then scanned as code, and the whole line beginning `{/*` is dropped with any ' +
    'real code sharing it; in SQL a `--` written after code survives untouched and a block comment ' +
    'survives whole. A negative assertion then fails on a comment, and a POSITIVE one passes on a ' +
    'file that no longer holds the thing it pins.\n\n' +
    'Use the shared stripper instead — one import, and the same line keeps working:\n\n' +
    '    import { stripComments } from "./support/comment-strip.ts";   // JS/TSX\n' +
    '    import { stripSqlComments } from "./support/comment-strip.ts"; // SQL\n' +
    '    import { stripCssComments } from "./support/comment-strip.ts"; // CSS\n\n' +
    '    const code = stripComments(source);\n\n' +
    'This is not a style preference: `tests/comment-strip-ratchet.test.ts` fails the required ' +
    '`validate` job on the first new site, with a budget of 0 and an empty grandfather list. It is ' +
    'the LAST assertion of a 977-test shard, so the alternative to this refusal is a five-minute ' +
    'CI round that ends in the same one-line import (four of the twenty-five red PR runs on ' +
    '12 Oct 2026 were exactly that). If this file genuinely has to spell the shape out, add it to ' +
    'SANCTIONED_TEST_FILES in .claude/hooks/lib/comment-strip-shapes.mjs in the same change, or set ' +
    'PHX_COMMENT_STRIP_OFF=1 if the owner tells you to write it as it is.'
  );
}

/* ------------------------------------------------------------------ selftest */

function selftest() {
  let total = 0;
  let failed = 0;
  const check = (label, got, want) => {
    total += 1;
    if (got !== want) {
      failed += 1;
      console.error(`  FAIL  ${label}\n        got  ${got}\n        want ${want}`);
    }
  };

  console.log('SELFTEST comment-strip-guard:');

  // The shapes, each taken from a real site the ratchet was measured over. Built by joining lines
  // so this file carries no literal chain of its own.
  const filterShape = [
    'const code = component',
    '  .split("\\n")',
    '  .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))',
    '  .join("\\n");',
  ].join('\n');
  const sqlShape = [
    'const sqlCode = read(path)',
    '  .split("\\n")',
    '  .filter((line) => !line.trimStart().startsWith("--"))',
    '  .join("\\n");',
  ].join('\n');
  const regexShape = [
    'const adminListCode = adminList',
    '  .split("\\n")',
    '  .filter((line) => !/^\\s*(\\/\\/|\\*|\\/\\*)/.test(line))',
    '  .join("\\n");',
  ].join('\n');
  const skipShape = [
    'for (const line of block.split("\\n")) {',
    '  const trimmed = line.trim();',
    '  if (trimmed.startsWith("//")) continue;',
    '  keys.add(trimmed);',
    '}',
  ].join('\n');
  const replaceShape = 'const panelCode = panel.replace(/^\\s*\\/\\/.*$/gm, "");';
  const remedy = 'const code = stripComments(source);';

  const TEST = 'tests/new-screen-pins.test.ts';
  const decide = (tool, filePath, toolInput) => {
    const sites = verdict({ tool, filePath, toolInput });
    return sites ? 'deny' : 'allow';
  };
  const write = (filePath, content) => decide('Write', filePath, { content });

  // --- the five shapes, written into a new test file ---------------------------
  check('the filter shape', write(TEST, filterShape), 'deny');
  check('the SQL `--` filter', write(TEST, sqlShape), 'deny');
  check('the prefix test as a regex', write(TEST, regexShape), 'deny');
  check('the `if (…) continue` skip', write(TEST, skipShape), 'deny');
  check('the whole-line replace', write(TEST, replaceShape), 'deny');

  // --- the same shapes arriving as an Edit or a MultiEdit ----------------------
  check('an Edit introducing it', decide('Edit', TEST, { new_string: filterShape }), 'deny');
  check('a MultiEdit whose second edit introduces it', decide('MultiEdit', TEST, { edits: [{ new_string: remedy }, { new_string: sqlShape }] }), 'deny');
  check('an Edit that REMOVES one (old_string only) is allowed', decide('Edit', TEST, { old_string: filterShape, new_string: remedy }), 'allow');

  // --- what must stay quiet ---------------------------------------------------
  check('the sanctioned remedy', write(TEST, remedy), 'allow');
  check('a split/join filter that is not about comments', write(TEST, 'const body = source\n  .split("\\n")\n  .filter((line) => !line.trim().startsWith("import "))\n  .join("\\n");'), 'allow');
  check('a comment-prefix filter that COUNTS rather than strips', write(TEST, 'const docLines = collected.filter((line) => line.trim().startsWith("//")).length;'), 'allow');
  check('a CSS custom-property prefix', write(TEST, 'const custom = names.filter((name) => !name.startsWith("--phx-")).join("\\n");'), 'allow');
  check('a replace that strips the `--` MARKER to read the prose', write(TEST, 'const prose = raw.replace(/^\\s*--/gm, "").replace(/\\s+/g, " ");'), 'allow');
  check('a guard that returns on something which is not a comment', write(TEST, 'if (trimmed.startsWith("import ")) return;'), 'allow');

  // --- scope: only files the CI sweep reads ----------------------------------
  check('a source file outside tests/', write('src/lib/sales/office-allocation.ts', filterShape), 'allow');
  check('a script outside tests/', write('scripts/check-migrations.mjs', filterShape), 'allow');
  check('a .tsx under tests/, which the sweep does not read', write('tests/x.test.tsx', filterShape), 'allow');
  check('a test support file, which the sweep DOES read', write('tests/support/new-helper.ts', filterShape), 'deny');
  check('a nested test file', write('tests/fixtures/deep/thing.ts', filterShape), 'deny');
  check('an absolute Windows path', write('F:\\Phoenix Workforce\\_wt-x\\tests\\new-screen-pins.test.ts', filterShape), 'deny');

  // --- the three sanctioned files ---------------------------------------------
  check('the stripper itself', write('tests/support/comment-strip.ts', filterShape), 'allow');
  check('the ratchet', write('tests/comment-strip-ratchet.test.ts', filterShape), 'allow');
  check('this guard own test', write('tests/comment-strip-guard.test.ts', filterShape), 'allow');
  check('a sanctioned file by absolute path', write('F:/Phoenix Workforce/phoenix-workforce/tests/comment-strip-ratchet.test.ts', filterShape), 'allow');
  check('a file whose name merely ENDS like a sanctioned one', write('tests/not-comment-strip-ratchet.test.ts', filterShape), 'deny');

  // --- missing or odd payloads must never deny --------------------------------
  check('no file path', write(null, filterShape), 'allow');
  check('no content', write(TEST, undefined), 'allow');
  check('a Read call', decide('Read', TEST, { content: filterShape }), 'allow');
  check('a Bash call', decide('Bash', TEST, { command: filterShape }), 'allow');
  check('a MultiEdit with no edits', decide('MultiEdit', TEST, {}), 'allow');

  // --- the message must carry the remedy, not just the complaint ---------------
  const reason = reasonFor(TEST, offendingSites('Write', { content: filterShape }));
  check('the reason names the shared stripper', reason.includes('stripComments'), true);
  check('the reason names the import path', reason.includes('./support/comment-strip.ts'), true);
  check('the reason names the line it saw', reason.includes('line 3'), true);
  check('the reason names the escape hatch', reason.includes('PHX_COMMENT_STRIP_OFF=1'), true);

  // --- one detector, not two copies -------------------------------------------
  const ratchet = (() => {
    try {
      return readFileSync(new URL('../../tests/comment-strip-ratchet.test.ts', import.meta.url), 'utf8');
    } catch {
      return '';
    }
  })();
  check('the ratchet imports the shared detector', ratchet.includes('comment-strip-shapes.mjs'), true);
  check('the ratchet defines no detector of its own', /function\s+lineWiseStripSites/.test(ratchet), false);

  console.log(`  ${total} cases, ${failed} failed`);
  if (failed) {
    console.error('SELFTEST FAILED');
    process.exit(1);
  }
  console.log('SELFTEST OK');
}

/* ------------------------------------------------------------------ hook entry */

function main() {
  if (process.argv.includes('--selftest') || process.argv.includes('selftest')) return selftest();
  if (process.env.PHX_COMMENT_STRIP_OFF === '1') return;

  const payload = (() => {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      return '';
    }
  })();
  if (!payload.trim()) return;

  let input;
  try {
    input = JSON.parse(payload);
  } catch {
    return; // unparseable stdin is not an edit to refuse
  }

  const filePath = String(input.tool_input?.file_path || '');
  const sites = verdict({ tool: String(input.tool_name || ''), filePath, toolInput: input.tool_input });
  if (!sites) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reasonFor(filePath, sites),
      },
    })}\n`,
  );
}

try {
  main();
} catch {
  process.exit(0); // fail open, always
}
