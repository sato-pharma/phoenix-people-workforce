// The form-design detector, in ONE place.
//
// `tests/form-design-system.test.ts` is the required-CI side and
// `.claude/hooks/form-design-guard.mjs` is the Write-time side, and both read this file. Keeping
// two copies of a scan this fiddly is how a hook starts refusing what CI accepts, or waving through
// what CI will fail — so every shape below is defined once, here, and `tests/form-design-guard.test.ts`
// fails if either side grows its own copy back.
//
// WHAT IS A SHAPE HERE. Two of the zero-tolerance assertions in that test:
//
//   1. A SELF-SKINNED CONTROL. A form control whose className paints a box of its own — a radius, a
//      full border, or a white/card background — without reaching one of the shared tokens. The cap
//      is 0 with no grandfather list, so the first one fails the required `validate` job.
//   2. A TOKEN IN A TEMPLATE LITERAL with a tail that conflicts with it. `` `${phxSelectClassName}
//      h-9` `` ships BOTH heights in one class attribute and nothing resolves that at runtime —
//      tailwind-merge is `cn()`, a template is string concatenation — so the caller asks for a 36px
//      dense field and renders the token's 40px one. 177 of these existed the day the design was
//      swept, every one written by a codemod that looked correct.
//
// The comments on each function below are the measurements that shaped it; they were written
// against real sites and must travel with the code rather than being summarised away.

/**
 * Printed-document editors follow the house document identity, not the form design, and two menus
 * render on a DARK ground where a white field would punch a light box through the panel.
 *
 * 🔴 The AUTH screens are the same dark case, and the sweep got them wrong before this exemption
 * existed: the login page and the password-setup page are a deliberate dark glass identity
 * (`border-white/14`, `bg-white/[0.045]`, white text, the brand's own `#ff7900` focus) at
 * `h-12`/`h-14` and `text-base`. Given the light token they became white boxes on a dark panel — on
 * the app's FRONT DOOR, and inconsistently, because one of the login page's two fields kept its dark
 * overrides and the other did not. They are restored to their own strings byte for byte.
 * 🔴 AND THAT IS HIS OWN RULING, NOT THE SWEEP'S JUDGEMENT: asked directly whether the front door
 * should wear the form design too, he answered *"keep the login screen out of the form design"*
 * (2026-10-06). Never bring `src/components/auth/` into line later, and never ask him again.
 *
 * 🔴 EVERY DARK GROUND IS EXEMPT BY HIS OWN RULING, 2026-10-06. Told that the dark ones below had
 * been kept dark on the SWEEP'S judgement rather than his, he answered *"keep the dark menus and
 * bands out of the form design too"*. So this is a decision, not a session's taste: never convert
 * one later, and never ask him again.
 *
 * 🔴 Three DARK grounds the first pass turned white, each restored byte for byte: the ADMIN
 * SIDEBAR's module search (the sidebar is `bg-[#000000]`, so a white field was a lit box in the
 * chrome of every admin page), the weekly Field Force header band (`bg-slate-900`), and the weekly
 * column editor's header-row select (`bg-[#020617]`). A dark ground is NOT always spelled with a
 * slate class — two of these were arbitrary hex — so a sweep cannot find them by colour name; read
 * the container. That is also why the Write-time guard can never find a dark case on its own: it
 * sees a fragment, not the panel around it.
 */
export const EXEMPT = [
  'src/components/hiring-pack/',
  'src/components/offers/',
  'src/components/auth/',
  'src/components/layout/sidebar.tsx',
  'src/components/sales/weekly/portal-weekly-field-force-view.tsx',
  'src/components/sales/weekly/weekly-distributor-column-editor.tsx',
  // The outstation expense review's APPROVED-AMOUNT field, pinned verbatim by
  // `tests/expense-review-row-height.test.ts`: this is where money is approved and "the controls
  // are moved, never reshaped".
  'src/components/outstation/expense-report.tsx',
  'src/components/ui/form-tokens',
  'src/components/ui/form-kit',
  'src/components/ui/input.tsx',
  'src/components/layout/nav-row-add-button.tsx',
  'src/components/layout/internal-messages-menu.tsx',
  'src/components/layout/in-app-notifications-bell.tsx',
];

export const TOKEN_NAMES = [
  'phxFieldClassName',
  'phxSelectClassName',
  'phxTextareaClassName',
  'phxFieldInvalidClassName',
  'phxCheckInputClassName',
];

export const CONTROL_TAGS = ['input', 'select', 'textarea', 'Input', 'Textarea', 'SearchableSelect'];
export const WRAPPERS = new Set(['Input', 'Textarea', 'SearchableSelect']);

export const NON_FIELD_TYPE =
  /type=(?:"|')(?:checkbox|radio|file|hidden|range|color|image|submit|button|reset)(?:"|')/;

/**
 * A per-character "inside a comment" mask.
 *
 * 🔴 THIS REPO'S COMMENTS QUOTE JSX. `select-field.tsx` says "A labeled <select> with a custom
 * chevron"; `kpis-period-picker.tsx` says "a native `<select>` is the one control it names as
 * unshrinkable". An unmasked scan reads 26 of those as controls — and the codemod that trusted the
 * same scan was one run away from writing ` className={…}` into the prose.
 */
export function commentMask(src) {
  const mask = new Uint8Array(src.length);
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      mask.fill(1, i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      mask.fill(1, i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return mask;
}

/**
 * Every form control with its FULL attribute list. Scanned, not regexed: a pattern ending the tag
 * at the first `>` ends it inside `(e) => …`, which hid the className on most real controls and
 * made the first audit call them "built at runtime".
 */
export function findControls(src, mask) {
  const out = [];
  const re = new RegExp(`<(${CONTROL_TAGS.join('|')})(?=[\\s/>])`, 'g');
  let m;
  while ((m = re.exec(src))) {
    if (mask[m.index]) continue;
    let i = re.lastIndex;
    const attrsStart = i;
    let depth = 0;
    let quote = null;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (quote) {
        if (c === '\\') {
          i += 1;
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        continue;
      }
      if (c === '{') {
        depth += 1;
        continue;
      }
      if (c === '}') {
        depth -= 1;
        continue;
      }
      if (c === '>' && depth === 0) break;
    }
    if (i >= src.length) break;
    out.push({ tag: m[1], attrs: src.slice(attrsStart, i), index: m.index });
    re.lastIndex = i + 1;
  }
  return out;
}

/** The className expression — the literal with its quotes, or the inner `{…}`. */
export function classNameExpr(attrs) {
  const lit = /className="([^"]*)"/.exec(attrs);
  if (lit) return `"${lit[1]}"`;
  const at = attrs.indexOf('className={');
  if (at < 0) return null;
  let i = at + 'className={'.length;
  const from = i;
  let depth = 1;
  let quote = null;
  for (; i < attrs.length; i += 1) {
    const c = attrs[i];
    if (quote) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{') {
      depth += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      if (!depth) break;
      continue;
    }
  }
  return attrs.slice(from, i);
}

/**
 * The file's own string constants, so a className that is a REFERENCE can be followed to what it
 * actually paints.
 *
 * 🔴 A `+`-CONCATENATED one counts, and so does a plain ALIAS. `scope-filter.client.tsx` wraps its
 * field across two lines with `+`; `portal-primitives.tsx` writes
 * `export const portalInputClassName = phxFieldClassName`. Missing either does not merely skip the
 * constant — it makes the call site look unresolvable, which reported 341 already-swept controls as
 * unswept.
 */
export function fileConstants(src, mask) {
  const map = new Map();
  const str = '(?:"[^"]*"|`[^`]*`)';
  // 🔴 NEVER WRITE `\s*\n?\s*` IN THESE THREE PATTERNS — IT IS `\s*` WITH AN EXPONENT ON IT. `\n`
  // is already inside `\s`, so the pair matches exactly the same text; what it adds is O(k²) ways
  // to split every whitespace run, and inside the `(… + …)*` chain below those multiply.
  // `src/lib/phoenix-crm/server/signboard-check.ts` is a 26-term `+` chain whose strings carry
  // ESCAPED quotes — `"[^"]*"` cannot match one, so the chain fails mid-way and the engine walks
  // every partition. Measured 2026-10-12: that ONE file cost 209,644ms of the CI sweep's
  // 210,151ms and 194,342ms of the 313s unit-test step, on every PR and every `main` push;
  // collapsed to `\s*` it is 0ms and the whole sweep is 369ms. The capture language is UNCHANGED —
  // proven over 3,916 files and 4,275 constants, zero differences — so the ratchet counts this
  // feeds are untouched, and the Write-time guard stops being able to hang on one import.
  // Pinned by `constantSweepIsLinearTests` in tests/form-design-guard.test.ts: a BUDGET, because
  // nothing noticed the old cost — the sweep returned the right answer, slowly.
  const re = new RegExp(
    `(?:^|\\n)[ \\t]*(?:export\\s+)?const\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*(?::\\s*string\\s*)?=\\s*(${str}(?:\\s*\\+\\s*${str})*)\\s*;`,
    'g',
  );
  let m;
  while ((m = re.exec(src))) {
    if (mask[m.index + 1]) continue;
    const value = [...m[2].matchAll(/"([^"]*)"|`([^`]*)`/g)]
      .map((x) => x[1] ?? x[2])
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    map.set(m[1], value);
  }
  const alias =
    /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*string\s*)?=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;/g;
  while ((m = alias.exec(src))) {
    if (mask[m.index + 1] || map.has(m[1])) continue;
    map.set(m[1], m[2]);
  }
  // And a `cn(…)`-valued one. The merge-semantics rule REQUIRES an override to be written as
  // `const FIELD = cn(phxSelectClassName, "h-9 px-2")` rather than a template, so a resolver
  // reading only string constants would stop following exactly the form it mandates — and would
  // then report ~200 swept controls as unswept, which is how a guard quietly loses its teeth.
  const call =
    /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*string\s*)?=\s*(cn\([^;]*?\))\s*;/g;
  while ((m = call.exec(src))) {
    if (mask[m.index + 1] || map.has(m[1])) continue;
    map.set(m[1], m[2]);
  }
  return map;
}

/** Bare identifiers in an expression, outside its string literals. */
export function identifiers(text) {
  const bare = text.replace(/"[^"]*"|'[^']*'/g, '""');
  return [...bare.matchAll(/(?:^|[^A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[1]);
}

/**
 * Does this className reach a shared token, directly or through any chain of constants?
 *
 * `exported` is the map of class constants declared OUTSIDE the file — the CI side passes every
 * `export const` in `src/`, the hook passes the ones the file imports. An unresolvable name simply
 * does not reach a token, which leaves the verdict to `paintsItsOwnBox` on whatever literals are
 * actually visible: an unknown reference paints nothing, so neither side invents an offence.
 */
export function reachesToken(text, consts, exported = new Map(), seen = new Set()) {
  if (TOKEN_NAMES.some((t) => text.includes(t))) return true;
  for (const name of identifiers(text)) {
    if (seen.has(name)) continue;
    const value = consts.get(name) ?? exported.get(name);
    if (value === undefined) continue;
    seen.add(name);
    if (reachesToken(value, consts, exported, seen)) return true;
  }
  return false;
}

/**
 * Does this class list paint a BOX of its own?
 *
 * A directional border (`border-l`, `border-t`) is a divider, not a box — the segmented control in
 * `monitoring-dashboard.tsx` draws its separators that way on a `bg-transparent` input — so a
 * colour counts only when a full `border` is present too. `border-0`/`border-none` is the opposite
 * of painting.
 */
export function paintsItsOwnBox(body) {
  if (/\bborder-(?:0|none)\b/.test(body)) return false;
  if (/(?:^|\s)(?:[a-z]+:)?rounded(?:-|\s|$)/.test(body)) return true;
  const hasFullBorder = /(?:^|\s)(?:[a-z]+:)?border(?:-[0-8])?(?:\s|$)/.test(body);
  if (hasFullBorder) return true;
  return /(?:^|\s)bg-(?:white|card|background|input|popover|(?:slate|gray)-(?:50|100)|phx-paper)/.test(body);
}

/**
 * One pass over a file's form controls: how many there are, how many reach a shared token, and
 * which ones paint a box of their own.
 *
 * This is the whole per-control decision of the cap-zero assertion, so the hook and the CI test
 * reach the same verdict on the same text by construction rather than by review. The two counts
 * travel with the offenders because the measurement has to stay honest: if the scan stops finding
 * controls — a renamed wrapper, a broken glob — a cap of zero would pass on nothing at all.
 */
export function scanControls(src, { exported = new Map() } = {}) {
  const mask = commentMask(src);
  const consts = fileConstants(src, mask);
  const out = [];
  let total = 0;
  let onDesign = 0;
  for (const { tag, attrs, index } of findControls(src, mask)) {
    if (NON_FIELD_TYPE.test(attrs)) continue;
    total += 1;
    const expr = classNameExpr(attrs);
    if (expr === null) {
      // A wrapper with no className already wears the token.
      if (WRAPPERS.has(tag)) onDesign += 1;
      continue;
    }
    if (reachesToken(expr, consts, exported)) {
      onDesign += 1;
      continue;
    }
    // Resolve one level of constant so the report names what is really painted.
    let resolved = expr;
    for (const [name, value] of consts) {
      const re = new RegExp(`(?:^|[^A-Za-z0-9_$.])${name}(?![A-Za-z0-9_$])`, 'g');
      if (re.test(resolved)) resolved = resolved.replace(re, ` ${value} `);
    }
    const literals = [...resolved.matchAll(/"([^"]*)"/g), ...resolved.matchAll(/`([^`$]*)`/g)].map(
      (x) => x[1],
    );
    const flat = (literals.length ? literals.join(' ') : resolved).replace(/\s+/g, ' ').trim();
    if (paintsItsOwnBox(flat)) out.push({ tag, flat, line: lineOf(src, index) });
  }
  return { total, onDesign, offenders: out };
}

/** Just the offenders — what the Write-time guard needs, since a fragment has no counts worth asserting. */
export function selfSkinnedSites(src, options) {
  return scanControls(src, options).offenders;
}

/** Which utility groups the shared field token already sets — a tail touching one of these conflicts. */
export const TOKEN_GROUPS = [
  /^(?:h|min-h|max-h)-/,
  /^w-/,
  /^(?:p|px|py|pt|pr|pb|pl|ps|pe)-/,
  /^text-/,
  /^bg-/,
  /^border(?:-|$)/,
  /^rounded(?:-|$)/,
  /^font-/,
  /^transition(?:-|$)/,
  /^shadow(?:-|$)/,
  /^(?:resize|outline|cursor)(?:-|$)/,
  /^placeholder:/,
  /^focus:/,
  /^focus-visible:/,
  /^disabled:/,
];

export function conflictsWithTheToken(cls) {
  const bare = cls.replace(/^[a-z-]+:/, '');
  return TOKEN_GROUPS.some((re) => re.test(bare) || re.test(cls));
}

/** `${token} tail` and `head ${token}` — both concatenate without merging. */
export const TEMPLATE_TOKEN_SHAPES = [
  /`\$\{(phx[A-Za-z]+ClassName)\}([^`$]*)`/g,
  /`([^`$]+)\$\{(phx[A-Za-z]+ClassName)\}`/g,
];

/**
 * Every template literal in `src` that concatenates a token with classes the token already sets.
 * A tail conflicting with NOTHING in `TOKEN_GROUPS` (`tabular-nums`, `truncate`) may stay a template.
 *
 * 🔴 WHICH GROUP IS THE TAIL. It is read exactly as the CI side reads it — by asking whether the
 * SECOND group is the token — because a head can itself begin with `phx`: in
 * `` `phx-foo ${phxFieldClassName}` `` a check on the first group picks the head as the token and
 * then measures the token NAME for conflicts, which finds none and lets the real tail through.
 */
export function templateConcatSites(src) {
  const mask = commentMask(src);
  const out = [];
  for (const shape of TEMPLATE_TOKEN_SHAPES) {
    const re = new RegExp(shape.source, 'g');
    let m;
    while ((m = re.exec(src))) {
      if (mask[m.index]) continue;
      const secondIsToken = String(m[2] ?? '').startsWith('phx');
      const token = secondIsToken ? m[2] : m[1];
      const tail = (secondIsToken ? m[1] : m[2]) ?? '';
      const bad = tail.split(/\s+/).filter(Boolean).filter(conflictsWithTheToken);
      if (bad.length) out.push({ token, bad, line: lineOf(src, m.index) });
    }
  }
  return out;
}

/** 1-indexed line of a character offset, so a message points at something the reader can see. */
export function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

/** Normalise a path the way both sweeps read it: forward slashes, repo-relative where possible. */
export function repoRelative(file) {
  const slashed = String(file || '').replace(/\\/g, '/');
  const at = slashed.search(/(?:^|\/)(?:src|app)\//);
  if (at < 0) return slashed;
  return slashed.slice(slashed[at] === '/' ? at + 1 : at);
}

export function isExempt(file) {
  const rel = repoRelative(file);
  return EXEMPT.some((e) => rel.startsWith(e) || rel.includes(e));
}

/**
 * The cap-zero sweep's own scope: `git ls-files src/components/*.tsx app/*.tsx` — which in a git
 * pathspec matches at any depth — minus the exemptions.
 */
export function isSweptFormFile(file) {
  const rel = repoRelative(file);
  if (!rel.endsWith('.tsx')) return false;
  if (!(rel.startsWith('src/components/') || rel.startsWith('app/'))) return false;
  return !isExempt(file);
}

/**
 * The merge-semantics sweep is wider — every `.ts`/`.tsx` under `src/` and `app/` — and skips only
 * the token file itself, where the tokens are declared.
 */
export function isMergeSweptFile(file) {
  const rel = repoRelative(file);
  if (!/\.tsx?$/.test(rel)) return false;
  if (!(rel.startsWith('src/') || rel.startsWith('app/'))) return false;
  return rel !== 'src/components/ui/form-tokens.ts';
}
