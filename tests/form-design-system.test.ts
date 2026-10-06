import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─── The one form design, pinned ──────────────────────────────────────────────
//
// 🔒 OWNER RULE, 2026-10-06: "sweep the system wide everywhere admin or emp any
// form or any thing applicable make it follow this form design." The design is
// the Adverse Drug Reaction Report wizard; the sweep put its class strings in
// `src/components/ui/form-tokens.ts` and pointed 1,171 of the app's 1,485 real
// form controls at them — including the `<Input>`, `<Textarea>` and
// `<SearchableSelect>` wrappers — plus 101 per-file style constants that each
// used to carry a near-copy of the same string. The rest paint nothing at all:
// they are chromeless inline editors inside a wrapper that draws the box.
//
// This test is what stops it drifting back apart, and it holds THREE things:
//
//   1. The identity itself — square corners, the 40px field, the orange focus
//      ring, the micro-caps label, the near-black primary and orange submit.
//      A radius or a second accent colour sneaking into a token fails here.
//   2. The reference form still consumes the kit rather than re-skinning
//      itself, so "change the token and the whole system follows" stays true.
//   3. A RATCHET at ZERO on controls that paint their own box. A new
//      `<input className="… border … bg-white …">` anywhere in the app fails
//      this job, which is how a session learns before the owner does. It
//      resolves a className THROUGH the file's own constants and through an
//      imported alias, masks comments (this repo's prose quotes JSX), and
//      counts the wrapper components too — the three gaps that let the first
//      version of this guard pass with 376 painted controls in the tree.

const TOKENS_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/ui/form-tokens.ts", import.meta.url)),
  "utf8",
);
const KIT_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/ui/form-kit.tsx", import.meta.url)),
  "utf8",
);
const REPORT_IT_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/report-it/report-it-form.tsx", import.meta.url)),
  "utf8",
);

/**
 * The value of an exported `const <name> = "…"` in form-tokens.ts, with any
 * `${otherToken}` reference resolved — several tokens are built from each other
 * (the select is the field plus a cursor, the label is its own typography plus
 * a box), and the assertions below are about the FINAL class list.
 */
function token(name: string, seen = new Set<string>()): string {
  assert.ok(!seen.has(name), `form-tokens.ts has a circular reference at ${name}`);
  seen.add(name);
  const re = new RegExp(`export const ${name}[^=]*=\\s*(?:\`([^\`]*)\`|"([^"]*)")`, "s");
  const m = TOKENS_SOURCE.match(re);
  assert.ok(m, `form-tokens.ts no longer exports a string constant named ${name}`);
  return (m[1] ?? m[2]).replace(/\$\{(\w+)\}/g, (_all, ref: string) => token(ref, seen));
}

// ── 1. The identity ──────────────────────────────────────────────────────────

function identityTests(): void {
  const field = token("phxFieldClassName");
  const textarea = token("phxTextareaClassName");
  const label = token("phxLabelClassName");

  // 🔒 THE SQUARE-EDGE GOLDEN RULE. The employee portal does NOT carry the
  // `.admin-shell [class*="rounded"]` reset, so a radius added here would show
  // on every portal form while looking fine in the admin shell.
  for (const [name, value] of [
    ["phxFieldClassName", field],
    ["phxTextareaClassName", textarea],
    ["phxSelectClassName", token("phxSelectClassName")],
    ["phxButtonGhostClassName", token("phxButtonGhostClassName")],
    ["phxButtonPrimaryClassName", token("phxButtonPrimaryClassName")],
    ["phxButtonAccentClassName", token("phxButtonAccentClassName")],
  ] as const) {
    assert.ok(
      !/\brounded/.test(value),
      `${name} carries a corner radius — the square-edge golden rule has no exception for a form field`,
    );
  }

  assert.match(field, /\bh-10\b/, "the field is 40px tall — every form in the system is measured against it");
  assert.match(field, /\bborder border-slate-300\b/, "the field's hairline is slate-300 on white");
  assert.match(field, /\bbg-white\b/, "the field sits on white");
  assert.match(field, /\bpx-3\b/, "the field's side padding is px-3 — icon clearance is added per field, never here");
  assert.match(field, /focus:border-orange-500/, "orange is the focus border");
  assert.match(field, /focus:ring-2 focus:ring-orange-500\/20/, "orange is the focus ring");
  assert.match(field, /disabled:/, "a disabled field must read as disabled");

  assert.match(textarea, /\bresize-y\b/, "a textarea grows vertically only — sideways resize breaks the fits-the-screen rule");
  assert.match(textarea, /focus:border-orange-500/, "the textarea shares the field's focus");

  assert.match(label, /text-phx-xs/, "the label is the micro size");
  assert.match(label, /font-black/, "the label is black weight");
  assert.match(label, /uppercase/, "the label is caps");
  assert.match(label, /text-slate-500/, "the label is slate-500, never full-strength ink");

  // The inline variant is the same typography with none of the box — it exists so
  // a label its container already places can be unified without being moved.
  const labelText = token("phxLabelTextClassName");
  assert.ok(
    !/\bblock\b|\bm[btlrxy]?-/.test(labelText),
    "phxLabelTextClassName must occupy no space — it is the typography only; the box lives on phxLabelClassName",
  );
  assert.ok(
    label.includes(labelText),
    "phxLabelClassName must be built FROM phxLabelTextClassName, or the two labels drift apart",
  );

  // One accent. Orange marks focus and progress; rose marks a problem. A third
  // colour in a token means two forms will stop looking like one system.
  const accentFamilies = new Set<string>();
  for (const m of TOKENS_SOURCE.matchAll(
    /\b(?:bg|border|text|ring|accent)-(orange|rose|slate|emerald|sky|violet|amber|indigo|teal|blue|red|green)-/g,
  )) {
    accentFamilies.add(m[1]);
  }
  assert.deepEqual(
    [...accentFamilies].sort(),
    ["orange", "rose", "slate"],
    "the form palette is slate + orange, with rose reserved for errors — a new colour family here " +
      "splits the system's look in two",
  );

  // The primary action is near-black and the submit is orange, in that order.
  assert.match(token("phxButtonPrimaryClassName"), /bg-slate-900/, "Next/Save is near-black");
  assert.match(token("phxButtonAccentClassName"), /bg-orange-600/, "Submit is orange");
  assert.match(token("phxButtonGhostClassName"), /bg-white/, "Back is the ghost button");

  // The grid reflows rather than scrolling sideways, including in a half-width
  // grid cell — a form is often rendered into one (see the @container rule).
  const grid = token("phxFieldGridClassName");
  assert.match(grid, /grid-cols-1/, "one column on a phone");
  assert.match(grid, /lg:grid-cols-1/, "back to one column at lg, for a form inside a half-width cell");
  assert.ok(!/overflow-x/.test(TOKENS_SOURCE), "no form token may reach for overflow-x — that IS the bug");
}

// ── 2. The kit is the single source, and the reference form consumes it ──────

function singleSourceTests(): void {
  for (const name of [
    "FormWizard",
    "FormField",
    "FieldLabel",
    "CheckTile",
    "FormError",
    "FormActions",
    "FormStepHeading",
    "FormProgress",
  ]) {
    assert.ok(
      KIT_SOURCE.includes(`export function ${name}(`),
      `form-kit.tsx must export ${name} — a form that cannot assemble from the kit re-skins itself instead`,
    );
  }

  assert.ok(
    REPORT_IT_SOURCE.includes('from "@/components/ui/form-kit"'),
    "the Report It form is the reference for this design — it must CONSUME the kit, not keep a private copy",
  );
  assert.ok(
    REPORT_IT_SOURCE.includes("<FormWizard"),
    "the Report It form must render the shared FormWizard, so the shell the owner approved is the shell every wizard gets",
  );
  // The literal it used to carry must not come back anywhere but the token file.
  assert.ok(
    !/h-10 w-full border border-slate-300 bg-white px-3/.test(REPORT_IT_SOURCE),
    "the field string belongs to form-tokens.ts only — a copy here is how 38 near-identical constants happened before",
  );

  // form-tokens.ts must stay importable from a server component: no "use client",
  // no React, nothing but strings and one helper.
  assert.ok(
    !/^"use client"/m.test(TOKENS_SOURCE),
    'form-tokens.ts must NOT be a client module — a server component has to be able to import a class string',
  );
  assert.ok(
    !/\bfrom "react"/.test(TOKENS_SOURCE),
    "form-tokens.ts holds strings, never components — the components live in form-kit.tsx",
  );
}

// ── 3. The ratchet ───────────────────────────────────────────────────────────

/**
 * The cap on form controls that still paint their own skin.
 *
 * 🔴 IT IS ZERO, AND THAT TOOK TWO PASSES. The first ratchet capped a count of
 * 15 and read only bare `<input>`/`<select>`/`<textarea>` tags carrying a STATIC
 * className. It therefore missed three whole classes of control — the wrappers
 * (`<Input>`, `<Textarea>`, `<SearchableSelect>`), constants named in another
 * style (`FIELD_CLASS`, `SELECT_CLASS`, `CONTROL`, `cell`), and any className
 * that reached its skin THROUGH one of those constants, which it counted as
 * on-design because the className was a reference. Resolving constants, 376 of 1,485
 * controls were still painting, `ui/searchable-select.tsx` among them: its
 * `rounded-[6px]` was a square-edge breach in a primitive the whole app renders.
 *
 * 🔴 NEVER RAISE IT. A number above zero is a new form that did not use the kit,
 * which is the one thing this guard exists to catch.
 */
const SELF_SKINNED_CAP = 0;

/**
 * Printed-document editors follow the house document identity, not the form
 * design, and two menus render on a DARK ground where a white field would punch
 * a light box through the panel.
 *
 * 🔴 The AUTH screens are the same dark case, and the sweep got them wrong before this
 * exemption existed: the login page and the password-setup page are a deliberate dark
 * glass identity (`border-white/14`, `bg-white/[0.045]`, white text, the brand's own
 * `#ff7900` focus) at `h-12`/`h-14` and `text-base`. Given the light token they became
 * white boxes on a dark panel — on the app's FRONT DOOR, and inconsistently, because one
 * of the login page's two fields kept its dark overrides and the other did not. They are
 * restored to their own strings byte for byte. 🔴 AND THAT IS HIS OWN RULING, NOT THE SWEEP'S
 * JUDGEMENT: asked directly whether the front door should wear the form design too, he answered
 * *"keep the login screen out of the form design"* (2026-10-06). Never bring `src/components/auth/`
 * into line later, and never ask him again.
 *
 * 🔴 Three more DARK grounds the first pass turned white, each restored byte for byte: the
 * ADMIN SIDEBAR's module search (the sidebar is `bg-[#000000]`, so a white field was a lit box in
 * the chrome of every admin page), the weekly Field Force header band (`bg-slate-900`), and the
 * weekly column editor's header-row select (`bg-[#020617]`). A dark ground is NOT always spelled
 * with a slate class — two of these were arbitrary hex — so a sweep cannot find them by colour
 * name; read the container.
 */
const EXEMPT = [
  "src/components/hiring-pack/",
  "src/components/offers/",
  "src/components/auth/",
  "src/components/layout/sidebar.tsx",
  "src/components/sales/weekly/portal-weekly-field-force-view.tsx",
  "src/components/sales/weekly/weekly-distributor-column-editor.tsx",
  // 🔴 The outstation expense review's APPROVED-AMOUNT field. `tests/expense-review-row-height.test.ts`
  // pins its exact string, because this is where money is approved and an earlier attempt to
  // shorten that row reshaped the control: "the controls are moved, never reshaped". The sweep
  // took its `h-8 text-xs` up to the design's 40px and the guard fired. Restored verbatim.
  "src/components/outstation/expense-report.tsx",
  "src/components/ui/form-tokens",
  "src/components/ui/form-kit",
  "src/components/ui/input.tsx",
  "src/components/layout/nav-row-add-button.tsx",
  "src/components/layout/internal-messages-menu.tsx",
  "src/components/layout/in-app-notifications-bell.tsx",
];

const TOKEN_NAMES = [
  "phxFieldClassName",
  "phxSelectClassName",
  "phxTextareaClassName",
  "phxFieldInvalidClassName",
  "phxCheckInputClassName",
];

const CONTROL_TAGS = ["input", "select", "textarea", "Input", "Textarea", "SearchableSelect"];
const WRAPPERS = new Set(["Input", "Textarea", "SearchableSelect"]);

const NON_FIELD_TYPE =
  /type=(?:"|')(?:checkbox|radio|file|hidden|range|color|image|submit|button|reset)(?:"|')/;

/**
 * A per-character "inside a comment" mask.
 *
 * 🔴 THIS REPO'S COMMENTS QUOTE JSX. `select-field.tsx` says "A labeled
 * <select> with a custom chevron"; `kpis-period-picker.tsx` says "a native
 * `<select>` is the one control it names as unshrinkable". An unmasked scan
 * reads 26 of those as controls — and the codemod that trusted the same scan
 * was one run away from writing ` className={…}` into the prose.
 */
function commentMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length);
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      mask.fill(1, i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
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
 * Every form control with its FULL attribute list. Scanned, not regexed: a
 * pattern ending the tag at the first `>` ends it inside `(e) => …`, which hid
 * the className on most real controls and made the first audit call them
 * "built at runtime".
 */
function findControls(src: string, mask: Uint8Array): { tag: string; attrs: string }[] {
  const out: { tag: string; attrs: string }[] = [];
  const re = new RegExp(`<(${CONTROL_TAGS.join("|")})(?=[\\s/>])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (mask[m.index]) continue;
    let i = re.lastIndex;
    const attrsStart = i;
    let depth = 0;
    let quote: string | null = null;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (quote) {
        if (c === "\\") {
          i += 1;
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "{") {
        depth += 1;
        continue;
      }
      if (c === "}") {
        depth -= 1;
        continue;
      }
      if (c === ">" && depth === 0) break;
    }
    if (i >= src.length) break;
    out.push({ tag: m[1], attrs: src.slice(attrsStart, i) });
    re.lastIndex = i + 1;
  }
  return out;
}

/** The className expression — the literal with its quotes, or the inner `{…}`. */
function classNameExpr(attrs: string): string | null {
  const lit = /className="([^"]*)"/.exec(attrs);
  if (lit) return `"${lit[1]}"`;
  const at = attrs.indexOf("className={");
  if (at < 0) return null;
  let i = at + "className={".length;
  const from = i;
  let depth = 1;
  let quote: string | null = null;
  for (; i < attrs.length; i += 1) {
    const c = attrs[i];
    if (quote) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") {
      depth += 1;
      continue;
    }
    if (c === "}") {
      depth -= 1;
      if (!depth) break;
      continue;
    }
  }
  return attrs.slice(from, i);
}

/**
 * The file's own string constants, so a className that is a REFERENCE can be
 * followed to what it actually paints.
 *
 * 🔴 A `+`-CONCATENATED one counts, and so does a plain ALIAS. `scope-filter.client.tsx`
 * wraps its field across two lines with `+`; `portal-primitives.tsx` writes
 * `export const portalInputClassName = phxFieldClassName`. Missing either does
 * not merely skip the constant — it makes the call site look unresolvable, which
 * reported 341 already-swept controls as unswept.
 */
function fileConstants(src: string, mask: Uint8Array): Map<string, string> {
  const map = new Map<string, string>();
  const str = `(?:"[^"]*"|\`[^\`]*\`)`;
  const re = new RegExp(
    `(?:^|\\n)[ \\t]*(?:export\\s+)?const\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*(?::\\s*string\\s*)?=\\s*\\n?\\s*(${str}(?:\\s*\\+\\s*\\n?\\s*${str})*)\\s*;`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (mask[m.index + 1]) continue;
    const value = [...m[2].matchAll(/"([^"]*)"|`([^`]*)`/g)]
      .map((x) => x[1] ?? x[2])
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    map.set(m[1], value);
  }
  const alias =
    /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*string\s*)?=\s*\n?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;/g;
  while ((m = alias.exec(src))) {
    if (mask[m.index + 1] || map.has(m[1])) continue;
    map.set(m[1], m[2]);
  }
  // And a `cn(…)`-valued one. Part 4 below REQUIRES an override to be written as
  // `const FIELD = cn(phxSelectClassName, "h-9 px-2")` rather than a template, so a resolver
  // reading only string constants would stop following exactly the form it mandates — and would
  // then report ~200 swept controls as unswept, which is how a guard quietly loses its teeth.
  const call =
    /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*string\s*)?=\s*\n?\s*(cn\([^;]*?\))\s*;/g;
  while ((m = call.exec(src))) {
    if (mask[m.index + 1] || map.has(m[1])) continue;
    map.set(m[1], m[2]);
  }
  return map;
}

/** Every exported class constant in src/, so an IMPORTED alias resolves too. */
let EXPORTED: Map<string, string> | null = null;
function exportedConstants(): Map<string, string> {
  if (EXPORTED) return EXPORTED;
  EXPORTED = new Map();
  const files = execFileSync("git", ["ls-files", "src/*.ts", "src/*.tsx"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(rel, "utf8");
    } catch {
      continue;
    }
    if (!src.includes("export const")) continue;
    for (const [name, value] of fileConstants(src, commentMask(src))) {
      if (!EXPORTED.has(name) && new RegExp(`export\\s+const\\s+${name}\\b`).test(src)) {
        EXPORTED.set(name, value);
      }
    }
  }
  return EXPORTED;
}

/** Bare identifiers in an expression, outside its string literals. */
function identifiers(text: string): string[] {
  const bare = text.replace(/"[^"]*"|'[^']*'/g, '""');
  return [...bare.matchAll(/(?:^|[^A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[1]);
}

function reachesToken(text: string, consts: Map<string, string>, seen = new Set<string>()): boolean {
  if (TOKEN_NAMES.some((t) => text.includes(t))) return true;
  const exported = exportedConstants();
  for (const name of identifiers(text)) {
    if (seen.has(name)) continue;
    const value = consts.get(name) ?? exported.get(name);
    if (value === undefined) continue;
    seen.add(name);
    if (reachesToken(value, consts, seen)) return true;
  }
  return false;
}

/**
 * Does this class list paint a BOX of its own?
 *
 * A directional border (`border-l`, `border-t`) is a divider, not a box — the
 * segmented control in `monitoring-dashboard.tsx` draws its separators that way
 * on a `bg-transparent` input — so a colour counts only when a full `border` is
 * present too. `border-0`/`border-none` is the opposite of painting.
 */
function paintsItsOwnBox(body: string): boolean {
  if (/\bborder-(?:0|none)\b/.test(body)) return false;
  if (/(?:^|\s)(?:[a-z]+:)?rounded(?:-|\s|$)/.test(body)) return true;
  const hasFullBorder = /(?:^|\s)(?:[a-z]+:)?border(?:-[0-8])?(?:\s|$)/.test(body);
  if (hasFullBorder) return true;
  return /(?:^|\s)bg-(?:white|card|background|input|popover|(?:slate|gray)-(?:50|100)|phx-paper)/.test(body);
}

function ratchetTests(): void {
  const files = execFileSync("git", ["ls-files", "src/components/*.tsx", "app/*.tsx"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !EXEMPT.some((e) => f.startsWith(e) || f.includes(e)));

  let total = 0;
  let onDesign = 0;
  const offenders: string[] = [];
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(rel, "utf8");
    } catch {
      continue;
    }
    const mask = commentMask(src);
    const consts = fileConstants(src, mask);
    for (const { tag, attrs } of findControls(src, mask)) {
      if (NON_FIELD_TYPE.test(attrs)) continue;
      total += 1;
      const expr = classNameExpr(attrs);
      if (expr === null) {
        // A wrapper with no className already wears the token.
        if (WRAPPERS.has(tag)) onDesign += 1;
        continue;
      }
      if (reachesToken(expr, consts)) {
        onDesign += 1;
        continue;
      }
      // Resolve one level of constant so the report names what is really painted.
      let resolved = expr;
      for (const [name, value] of consts) {
        const re = new RegExp(`(?:^|[^A-Za-z0-9_$.])${name}(?![A-Za-z0-9_$])`, "g");
        if (re.test(resolved)) resolved = resolved.replace(re, ` ${value} `);
      }
      const literals = [
        ...resolved.matchAll(/"([^"]*)"/g),
        ...resolved.matchAll(/`([^`$]*)`/g),
      ].map((x) => x[1]);
      const flat = (literals.length ? literals.join(" ") : resolved).replace(/\s+/g, " ").trim();
      if (paintsItsOwnBox(flat)) offenders.push(`${rel} [${tag}] ${flat.slice(0, 90)}`);
    }
  }

  // The measurement itself has to stay honest: if the scan stops finding controls
  // (a renamed wrapper, a broken glob), a cap of zero would pass on nothing at all.
  assert.ok(
    total > 1200,
    `the control scan found only ${total} form controls — it found 1,485 when this guard was written, so the scan itself is broken and a green run here would mean nothing`,
  );
  assert.ok(
    onDesign > 1000,
    `only ${onDesign} of ${total} form controls reach a shared token — 1,171 did when this guard was written, so the design has been unwired rather than merely extended`,
  );
  assert.ok(
    offenders.length <= SELF_SKINNED_CAP,
    `${offenders.length} form control(s) paint their own box, over the cap of ${SELF_SKINNED_CAP}. ` +
      "Import phxFieldClassName / phxSelectClassName / phxTextareaClassName from " +
      "@/components/ui/form-tokens instead of writing the border, background, radius and focus " +
      `ring by hand (owner rule, 2026-10-06). Offenders:\n  ${offenders.join("\n  ")}`,
  );
}

// ── 4. Merge semantics: a token override must go through cn() ────────────────

/**
 * 🔴 A TEMPLATE LITERAL GETS NO TAILWIND-MERGE, SO THE OVERRIDE SILENTLY LOSES.
 *
 * `const FIELD = \`${phxSelectClassName} h-9 px-2\`` puts BOTH `h-10` (the
 * token's) and `h-9` into one class attribute, and nothing resolves that at
 * runtime — `cn()` is tailwind-merge, a template is string concatenation. The
 * winner is then whichever utility Tailwind emitted LATER in the stylesheet,
 * which on a numeric scale is the LARGER one: the caller asks for a 36px dense
 * field and renders a 40px one.
 *
 * It is the same shape as the `text-phx-*` defect of 2026-08-28 — right there in
 * the source, absent from the rendered DOM, invisible to lint, to typecheck and
 * to any test that only reads classes. 177 of these existed the day the design
 * was swept, every one of them written by a codemod that looked correct.
 *
 * `cn(token, "h-9 px-2")` resolves it: last writer wins, per utility group.
 * A tail that conflicts with NOTHING the token sets (`cursor-pointer`,
 * `font-mono`, `tabular-nums`, `truncate`) may stay a template.
 */
const TOKEN_GROUPS = [
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

function conflictsWithTheToken(cls: string): boolean {
  const bare = cls.replace(/^[a-z-]+:/, "");
  return TOKEN_GROUPS.some((re) => re.test(bare) || re.test(cls));
}

function mergeSemanticsTests(): void {
  const files = execFileSync(
    "git",
    ["ls-files", "src/*.ts", "src/*.tsx", "app/*.ts", "app/*.tsx"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => f !== "src/components/ui/form-tokens.ts");

  const offenders: string[] = [];
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(rel, "utf8");
    } catch {
      continue;
    }
    if (!src.includes("ClassName}")) continue;
    const mask = commentMask(src);
    // `${token} tail` and `head ${token}` — both concatenate without merging.
    for (const re of [
      /`\$\{(phx[A-Za-z]+ClassName)\}([^`$]*)`/g,
      /`([^`$]+)\$\{(phx[A-Za-z]+ClassName)\}`/g,
    ]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (mask[m.index]) continue;
        const tail = (m[2].startsWith("phx") ? m[1] : m[2]) ?? "";
        const bad = tail.split(/\s+/).filter(Boolean).filter(conflictsWithTheToken);
        if (bad.length) offenders.push(`${rel} — \`…\${token} ${bad.join(" ")}\``);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a form token override must go through cn(), never a template literal: a template does not " +
      "tailwind-merge, so the token's own h-10/px-3/text-sm wins and the override renders as " +
      "nothing. Write cn(phxFieldClassName, \"h-9 px-2\").\n  " +
      offenders.join("\n  "),
  );
}

/**
 * \U0001f534 THE 16px KEEPS, pinned together because each one cost a full round on the box.
 *
 * The shared field token is `text-sm` = 14px, and iOS Safari zooms the WHOLE viewport when it
 * focuses an input, select or textarea whose text is under 16px \u2014 which the owner's
 * fits-the-screen golden rule forbids. Three screens had already decided that in their own source,
 * two of them with a comment saying exactly why, and the sweep flattened all three to the bare
 * token. Two were caught only by the full unit suite, one box round each, because
 * `tests/run-tests.ts` stops at the first throw \u2014 and the third was found only by diffing every
 * swept file against `origin/main` for a `text-base` that had gone missing.
 *
 * So the keeps live HERE, in one list, owned by the guard that owns the token: a fourth screen that
 * needs 16px joins the list instead of being discovered on somebody's iPhone. Each must compose
 * through `cn()`, never a template literal \u2014 a template ships both sizes and lets the stylesheet
 * pick, and on a numeric scale the larger value wins, which would be right here by accident and
 * wrong everywhere else.
 *
 * \U0001f534 Never "fix" one of these by changing the token to 16px: that redesigns the owner's own form.
 */
const SIXTEEN_PX_KEEPS: Array<{ file: string; why: string }> = [
  {
    file: "src/components/approvals-hub/decision-actions.tsx",
    why: "the reason box an employee reads, on the screen where money moves",
  },
  {
    file: "src/components/employee-portal/rep-kpi-month-picker.tsx",
    why: "a native select \u2014 the one control the fits-the-screen rule names as unshrinkable",
  },
  {
    file: "src/components/crm/kpis-filter-bar.tsx",
    why: "the KPIs board's search field, which carries its own comment saying 16px is deliberate",
  },
];

function sixteenPixelKeepTests(): void {
  for (const { file, why } of SIXTEEN_PX_KEEPS) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /cn\(\s*phx[A-Za-z]+ClassName,[\s\S]{0,160}?"[^"]*\btext-base\b/,
      `${file}: ${why} \u2014 it must keep text-base through cn(), or iOS Safari zooms the whole page ` +
        `when the field is focused. The token's own text-sm is 14px.`,
    );
    assert.ok(
      !/`\$\{\s*phx[A-Za-z]+ClassName\s*\}[^`]*\btext-base\b/.test(src),
      `${file}: the 16px keep must go through cn(), not a template literal \u2014 a template emits both ` +
        `text-sm and text-base and lets the stylesheet decide.`,
    );
  }
}

export async function runFormDesignSystemTests(): Promise<void> {
  identityTests();
  singleSourceTests();
  ratchetTests();
  mergeSemanticsTests();
  sixteenPixelKeepTests();
}
