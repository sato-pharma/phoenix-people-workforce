#!/usr/bin/env node
// PreToolUse(Write|Edit|MultiEdit) guard — a form control that paints its own box, or a token
// override written as a template literal, is refused as it is written instead of deep inside CI.
//
// WHY THIS EXISTS. `tests/form-design-system.test.ts` holds the owner's 2026-10-06 rule that every
// form wears the Adverse Drug Reaction wizard's skin, and two of its assertions are zero-tolerance
// with no grandfather list:
//
//   1. SELF_SKINNED_CAP = 0 — a control whose className paints a radius, a full border or a white
//      ground without reaching `phxFieldClassName` / `phxSelectClassName` / `phxTextareaClassName`.
//      A number above zero is a new form that did not use the kit, which is the one thing the
//      ratchet exists to catch, and 🔴 it is NEVER raised.
//   2. The merge-semantics check — `` `${phxFieldClassName} h-9` `` ships both heights in one class
//      attribute, because tailwind-merge is `cn()` and a template is string concatenation. The
//      override silently loses to the token, and nothing in lint, typecheck or the DOM says so.
//
// The rules are right and the detector works. What it costs is the TIMING: the test runs inside the
// required `validate` job, which on 12 Oct 2026 was the slow half of 26 red PR runs in one day —
// thirteen of them repo-wide contract gates of exactly this kind, each a full CI round to be told
// that a className should have been a token. This hook moves the same verdict to the Write or Edit
// that introduces the shape, which is also the moment the author still has the design in mind.
//
// WHAT IT READS. Only the text being introduced — `content` for Write, `new_string` for Edit, each
// edit's `new_string` for MultiEdit — so a pre-existing control elsewhere in the file never blocks
// an unrelated edit, and a session can always EDIT an offender away. The file on disk and the files
// it imports are read for one purpose only: resolving a className that is a REFERENCE, so a control
// wearing `portalInputClassName` is recognised as on-design rather than reported as unresolvable.
//
// WHAT IT CANNOT KNOW, AND THEREFORE ALLOWS. A dark ground is not spelled by colour name — two of
// the exempt ones are arbitrary hex — so the container cannot be read from a fragment. Every
// exemption the sweep honours is honoured here from the same list (`EXEMPT` in the shared module),
// including the owner's own rulings that the login screen and the dark menus stay out of the form
// design. An unresolvable reference paints nothing and is allowed: the hook is deliberately no
// stricter than the check it fronts for.
//
// ONE DEFINITION. Every shape lives in `./lib/form-design-shapes.mjs`, which the CI test imports
// too, so the hook cannot drift into refusing what CI accepts. `tests/form-design-guard.test.ts`
// fails if either side grows its own copy back.
//
// FAILS OPEN. Any error, any missing field, unparseable stdin: exit 0 with no output, which the
// engine reads as "no opinion". A hook bug must never block a real edit.
//
// ESCAPE HATCH: PHX_FORM_DESIGN_OFF=1 turns it off for a session, the same shape as
// PHX_COMMENT_STRIP_OFF. The legitimate case is a new exemption the owner has ruled on — add it to
// `EXEMPT` in the same change.
//
//   node .claude/hooks/form-design-guard.mjs --selftest

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  commentMask,
  fileConstants,
  isMergeSweptFile,
  isSweptFormFile,
  repoRelative,
  selfSkinnedSites,
  templateConcatSites,
} from './lib/form-design-shapes.mjs';

const REPO_ROOT = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/** The two token files are always in scope: they declare the tokens and the constants built on them. */
const ALWAYS_READ = ['src/components/ui/form-tokens.ts', 'src/components/ui/form-kit.tsx'];

/** A cheap "could this text possibly offend" test, so the common Write pays almost nothing. */
const MIGHT_HOLD_CONTROL = /<(?:input|select|textarea|Input|Textarea|SearchableSelect)(?=[\s/>])/;
const MIGHT_HOLD_TEMPLATE = /ClassName\}/;

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
 * Class constants declared outside the text being written: the file on disk, the modules it imports,
 * and the two token files. Bounded on purpose — a dozen small reads, never a sweep of `src/` — so
 * the hook stays cheap enough to sit on every Write.
 */
export function importedConstants(filePath, texts, readFile = safeRead) {
  const exported = new Map();
  const rel = repoRelative(filePath);
  const dir = path.posix.dirname(rel);
  const sources = [...ALWAYS_READ];

  const onDisk = readFile(rel);
  const haystack = [...texts, onDisk ?? ''].join('\n');
  for (const m of haystack.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    let base = null;
    if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
    else if (spec.startsWith('./') || spec.startsWith('../')) base = path.posix.normalize(`${dir}/${spec}`);
    if (!base) continue;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (/\.tsx?$/.test(candidate)) sources.push(candidate);
    }
    if (sources.length > 40) break;
  }

  let read = 0;
  for (const source of [rel, ...sources]) {
    if (read >= 14) break;
    const src = source === rel ? onDisk : readFile(source);
    if (!src) continue;
    read += 1;
    if (!src.includes('const')) continue;
    for (const [name, value] of fileConstants(src, commentMask(src))) {
      if (!exported.has(name)) exported.set(name, value);
    }
  }
  return exported;
}

function safeRead(rel) {
  try {
    const full = path.join(REPO_ROOT, rel);
    if (!existsSync(full)) return null;
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/** The whole decision, as data: `null` for no opinion, or the findings to refuse over. */
export function verdict({ tool, filePath, toolInput, readFile }) {
  if (tool !== 'Write' && tool !== 'Edit' && tool !== 'MultiEdit') return null;
  const texts = incomingText(tool, toolInput);
  if (!texts.some((text) => MIGHT_HOLD_CONTROL.test(text) || MIGHT_HOLD_TEMPLATE.test(text))) return null;

  const swept = isSweptFormFile(filePath);
  const merge = isMergeSweptFile(filePath);
  if (!swept && !merge) return null;

  let exported = null;
  const findings = [];
  for (const [piece, text] of texts.entries()) {
    if (swept && MIGHT_HOLD_CONTROL.test(text)) {
      if (!exported) exported = importedConstants(filePath, texts, readFile ?? safeRead);
      for (const site of selfSkinnedSites(text, { exported })) {
        findings.push({ kind: 'self-skinned', piece, ...site });
      }
    }
    if (merge && MIGHT_HOLD_TEMPLATE.test(text)) {
      for (const site of templateConcatSites(text)) {
        findings.push({ kind: 'template', piece, ...site });
      }
    }
  }
  return findings.length ? findings : null;
}

/** The refusal text. Named separately so the selftest can assert the remedy is in it. */
export function reasonFor(filePath, findings) {
  const rel = repoRelative(filePath);
  const skinned = findings.filter((f) => f.kind === 'self-skinned');
  const templated = findings.filter((f) => f.kind === 'template');
  const parts = [];

  if (skinned.length) {
    parts.push(
      `This edit to ${rel} gives a form control its own skin, at:\n    ` +
        skinned.map((f) => `line ${f.line} <${f.tag}>: ${f.flat.slice(0, 90)}`).join('\n    ') +
        '\n\nEvery form in this app — admin shell and employee portal alike — wears the Adverse Drug ' +
        'Reaction wizard\'s skin (owner rule, 2026-10-06), so a field\'s border, background, radius, ' +
        'height and focus ring are never written by hand. Import the token instead, and assemble the ' +
        'field from the kit:\n\n' +
        '    import { phxFieldClassName, phxSelectClassName, phxTextareaClassName } from "@/components/ui/form-tokens";\n' +
        '    import { FormField } from "@/components/ui/form-kit";\n\n' +
        '    <FormField label="Governorate">\n' +
        '      <select className={phxSelectClassName}>…</select>\n' +
        '    </FormField>\n\n' +
        'A dense table or filter control at `h-8`/`h-9` keeps its own height through ' +
        'cn(phxFieldClassName, "h-9") — see the next paragraph for why that cannot be a template.',
    );
  }

  if (templated.length) {
    parts.push(
      `This edit to ${rel} overrides a form token inside a template literal, at:\n    ` +
        templated
          .map((f) => `line ${f.line}: \`…\${${f.token}} ${f.bad.join(' ')}\``)
          .join('\n    ') +
        '\n\nA template literal is string concatenation, not tailwind-merge, so BOTH values reach the ' +
        'class attribute and nothing resolves them at runtime: the winner is whichever utility ' +
        'Tailwind emitted later, which on a numeric scale is the LARGER one. The caller asks for a ' +
        '36px dense field and renders the token\'s 40px one — present in the source, absent from the ' +
        'rendered DOM, invisible to lint and to typecheck. 177 of these existed the day the design ' +
        'was swept.\n\n' +
        '    cn(' +
        templated[0].token +
        ', "' +
        templated[0].bad.join(' ') +
        '")   // last writer wins, per utility group',
    );
  }

  parts.push(
    'This is not a style preference: `tests/form-design-system.test.ts` fails the required ' +
      '`validate` job on the first new site — the self-skinned cap is 0 and the override check ' +
      'asserts an empty list — so the alternative to this refusal is a CI round that ends in the ' +
      'same import. If this file is a case the owner has ruled exempt (a dark ground, the login ' +
      'screen, a printed document), add it to EXEMPT in .claude/hooks/lib/form-design-shapes.mjs in ' +
      'the same change, or set PHX_FORM_DESIGN_OFF=1 if he tells you to write it as it is.',
  );

  return parts.join('\n\n');
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

  console.log('SELFTEST form-design-guard:');

  // Nothing on disk: the selftest resolves only what each fixture declares, so a real checkout is
  // never needed and the cases read the same in CI as on a laptop.
  const noDisk = () => null;
  const tokens = (rel) =>
    rel === 'src/components/ui/form-tokens.ts'
      ? 'export const phxFieldClassName = "h-10 w-full rounded-none border border-slate-300 bg-white px-3 text-sm";\n'
      : null;

  const FORM = 'src/components/hr/new-leave-form.tsx';
  const decide = (tool, filePath, toolInput, readFile = noDisk) =>
    verdict({ tool, filePath, toolInput, readFile }) ? 'deny' : 'allow';
  const write = (filePath, content, readFile = noDisk) =>
    decide('Write', filePath, { content }, readFile);

  // --- the self-skinned control, in the spellings the sweep measured ----------
  check(
    'a hand-written input skin',
    write(FORM, '<input className="h-10 w-full rounded border border-slate-300 bg-white px-3 text-sm" />'),
    'deny',
  );
  check(
    'a select with only a radius',
    write(FORM, '<select className="rounded-md px-2">{options}</select>'),
    'deny',
  );
  check(
    'a textarea with a full border',
    write(FORM, '<textarea className="border border-slate-200 p-2" rows={3} />'),
    'deny',
  );
  check(
    'a white ground with no border at all',
    write(FORM, '<input className="bg-white px-3 py-2" />'),
    'deny',
  );
  check(
    'the Input WRAPPER given its own box',
    write(FORM, '<Input className="rounded-lg border bg-white" value={name} />'),
    'deny',
  );
  check(
    'a className reached THROUGH a local constant',
    write(
      FORM,
      'const FIELD = "h-9 rounded border border-slate-300 bg-white px-2";\n<input className={FIELD} />',
    ),
    'deny',
  );
  check(
    'a className built with cn() from literals',
    write(FORM, '<input className={cn("rounded border bg-white px-3", dense && "h-8")} />'),
    'deny',
  );

  // --- what must stay quiet ---------------------------------------------------
  check('the token itself', write(FORM, '<input className={phxFieldClassName} />'), 'allow');
  check(
    'the token with a dense height through cn()',
    write(FORM, '<input className={cn(phxFieldClassName, "h-9")} />'),
    'allow',
  );
  check(
    'a local constant that reaches the token',
    write(FORM, 'const FIELD = cn(phxFieldClassName, "h-9");\n<input className={FIELD} />'),
    'allow',
  );
  check(
    'an IMPORTED alias that reaches the token on disk',
    write(
      FORM,
      'import { phxFieldClassName } from "@/components/ui/form-tokens";\nconst F = phxFieldClassName;\n<input className={F} />',
      tokens,
    ),
    'allow',
  );
  check('a wrapper with no className', write(FORM, '<Input value={name} onChange={set} />'), 'allow');
  check(
    'a checkbox, which is not a field',
    write(FORM, '<input type="checkbox" className="rounded border bg-white" />'),
    'allow',
  );
  check(
    'a file input, which is not a field',
    write(FORM, '<input type="file" className="rounded border bg-white" />'),
    'allow',
  );
  check(
    'a divider border, which is not a box',
    write(FORM, '<input className="border-l border-slate-200 bg-transparent px-2" />'),
    'allow',
  );
  check(
    'border-0, the opposite of painting',
    write(FORM, '<input className="border-0 bg-white/0 px-2" />'),
    'allow',
  );
  check(
    'a control quoted in a COMMENT',
    write(FORM, '// A labeled <select className="rounded border bg-white"> with a chevron\nexport const X = 1;'),
    'allow',
  );
  check('an unresolvable reference paints nothing', write(FORM, '<input className={props.className} />'), 'allow');

  // --- the template-literal override ------------------------------------------
  check(
    'a token with a conflicting height in a template',
    write(FORM, 'const F = `${phxSelectClassName} h-9 px-2`;'),
    'deny',
  );
  check(
    'the head form of the same shape',
    write(FORM, 'const F = `text-xs ${phxFieldClassName}`;'),
    'deny',
  );
  check(
    'a head that itself begins with phx',
    write(FORM, 'const F = `phx-x h-9 ${phxFieldClassName}`;'),
    'deny',
  );
  check(
    'a tail that conflicts with nothing the token sets',
    write(FORM, 'const F = `${phxFieldClassName} tabular-nums truncate`;'),
    'allow',
  );
  check(
    'the override written through cn()',
    write(FORM, 'const F = cn(phxFieldClassName, "h-9 px-2");'),
    'allow',
  );
  check(
    'the template shape inside a comment',
    write(FORM, '// never write `${phxFieldClassName} h-9`\nexport const X = 1;'),
    'allow',
  );

  // --- the same shapes arriving as an Edit or a MultiEdit ----------------------
  const skin = '<input className="rounded border border-slate-300 bg-white px-3" />';
  check('an Edit introducing it', decide('Edit', FORM, { new_string: skin }), 'deny');
  check(
    'a MultiEdit whose second edit introduces it',
    decide('MultiEdit', FORM, { edits: [{ new_string: '<input className={phxFieldClassName} />' }, { new_string: skin }] }),
    'deny',
  );
  check(
    'an Edit that REMOVES one is allowed',
    decide('Edit', FORM, { old_string: skin, new_string: '<input className={phxFieldClassName} />' }),
    'allow',
  );

  // --- scope: the two sweeps, and the exemptions -------------------------------
  check('an app/ page', write('app/hr/leave/page.tsx', skin), 'deny');
  check('a nested component', write('src/components/sales/deep/filter-row.tsx', skin), 'deny');
  check('an absolute Windows path', write('F:\\Phoenix Workforce\\_wt-x\\src\\components\\hr\\x.tsx', skin), 'deny');
  check('a .ts file, which the control sweep does not read', write('src/lib/hr/leave.ts', skin), 'allow');
  check('a component outside src/components and app/', write('src/pages-old/thing.tsx', skin), 'allow');
  check('the hiring pack, exempt by the house document identity', write('src/components/hiring-pack/paper.tsx', skin), 'allow');
  check('an offer letter, exempt', write('src/components/offers/offer-letter.tsx', skin), 'allow');
  check('the login screen, exempt by his own ruling', write('src/components/auth/login-form.tsx', skin), 'allow');
  check('the admin sidebar, a dark ground he ruled exempt', write('src/components/layout/sidebar.tsx', skin), 'allow');
  check('the expense review, pinned verbatim where money is approved', write('src/components/outstation/expense-report.tsx', skin), 'allow');
  check('the token file itself', write('src/components/ui/form-tokens.ts', 'const F = `${phxFieldClassName} h-9`;'), 'allow');
  check('the kit itself', write('src/components/ui/form-kit.tsx', skin), 'allow');
  check(
    'a .ts file still gets the TEMPLATE check, whose sweep is wider',
    write('src/lib/hr/leave-classes.ts', 'const F = `${phxFieldClassName} h-9`;'),
    'deny',
  );

  // --- missing or odd payloads must never deny --------------------------------
  check('no file path', write(null, skin), 'allow');
  check('no content', write(FORM, undefined), 'allow');
  check('a Read call', decide('Read', FORM, { content: skin }), 'allow');
  check('a Bash call', decide('Bash', FORM, { command: skin }), 'allow');
  check('a MultiEdit with no edits', decide('MultiEdit', FORM, {}), 'allow');
  check('text with no control and no token at all', write(FORM, 'export const rows = data.map(toRow);'), 'allow');

  // --- the message must carry the remedy, not just the complaint ---------------
  const skinReason = reasonFor(FORM, verdict({ tool: 'Write', filePath: FORM, toolInput: { content: skin }, readFile: noDisk }));
  check('the reason names the token', skinReason.includes('phxFieldClassName'), true);
  check('the reason names the import path', skinReason.includes('@/components/ui/form-tokens'), true);
  check('the reason names the kit', skinReason.includes('form-kit'), true);
  check('the reason names his rule and its date', skinReason.includes('2026-10-06'), true);
  check('the reason names the escape hatch', skinReason.includes('PHX_FORM_DESIGN_OFF=1'), true);
  const tmplReason = reasonFor(
    FORM,
    verdict({ tool: 'Write', filePath: FORM, toolInput: { content: 'const F = `${phxSelectClassName} h-9 px-2`;' }, readFile: noDisk }),
  );
  check('the template reason writes the cn() remedy out', tmplReason.includes('cn(phxSelectClassName, "h-9 px-2")'), true);
  check('the template reason explains the silent loss', tmplReason.includes('tailwind-merge'), true);

  // --- one detector, not two copies -------------------------------------------
  const ratchet = (() => {
    try {
      return readFileSync(new URL('../../tests/form-design-system.test.ts', import.meta.url), 'utf8');
    } catch {
      return '';
    }
  })();
  check('the CI test imports the shared detector', ratchet.includes('form-design-shapes.mjs'), true);
  check('the CI test defines no paint detector of its own', /function\s+paintsItsOwnBox/.test(ratchet), false);
  check('the CI test defines no control scanner of its own', /function\s+findControls/.test(ratchet), false);
  check('the CI test keeps no EXEMPT list of its own', /const\s+EXEMPT\s*=/.test(ratchet), false);

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
  if (process.env.PHX_FORM_DESIGN_OFF === '1') return;

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
  const findings = verdict({
    tool: String(input.tool_name || ''),
    filePath,
    toolInput: input.tool_input,
  });
  if (!findings) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reasonFor(filePath, findings),
      },
    })}\n`,
  );
}

try {
  main();
} catch {
  process.exit(0); // fail open, always
}
