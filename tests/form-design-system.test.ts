import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 🔴 ONE DEFINITION, SHARED WITH THE WRITE-TIME GUARD. Every shape this file scans for — the
// exemptions, the comment mask, the control scanner, the className resolver, the paint test and the
// template-override test — lives in `.claude/hooks/lib/form-design-shapes.mjs`, because
// `.claude/hooks/form-design-guard.mjs` refuses the same shapes at the Write that introduces them,
// and a second copy is how a hook starts refusing what CI accepts. Each function's measurements
// travel with it, there. `tests/form-design-guard.test.ts` fails if either side grows a copy back.
import {
  commentMask,
  EXEMPT,
  fileConstants,
  scanControls,
  templateConcatSites,
} from "../.claude/hooks/lib/form-design-shapes.mjs";

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
    ["phxButtonApproveClassName", token("phxButtonApproveClassName")],
    ["phxButtonDangerClassName", token("phxButtonDangerClassName")],
    ["phxButtonApproveDenseClassName", token("phxButtonApproveDenseClassName")],
    ["phxButtonDangerDenseClassName", token("phxButtonDangerDenseClassName")],
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

  // One accent. Orange marks focus and progress; rose marks a problem.
  //
  // 🔴 EMERALD WAS ADDED ON 2026-10-07 AND IS NOT A SECOND ACCENT — the owner asked for "an
  // approve-green button token to the form kit" so a decision pair stops being hand-written on
  // every screen that has one. It is allowed for exactly that: `phxButtonApproveClassName`,
  // rendered beside `phxButtonDangerClassName`. A form's own terminal commit is still orange, and
  // the assertion below is what stops green leaking into Save, Next or Submit — adding a FIFTH
  // family needs the owner's word the way this one had it.
  const accentFamilies = new Set<string>();
  for (const m of TOKENS_SOURCE.matchAll(
    /\b(?:bg|border|text|ring|accent)-(orange|rose|slate|emerald|sky|violet|amber|indigo|teal|blue|red|green)-/g,
  )) {
    accentFamilies.add(m[1]);
  }
  assert.deepEqual(
    [...accentFamilies].sort(),
    ["emerald", "orange", "rose", "slate"],
    "the form palette is slate + orange, rose reserved for errors, and emerald reserved for the " +
      "approve half of a decision pair — a new colour family here splits the system's look in two",
  );

  // Emerald earns its place only as that pair, so the pair is pinned: same geometry, and green
  // confined to the approve token. A green Submit is the failure this guards.
  const approve = token("phxButtonApproveClassName");
  const danger = token("phxButtonDangerClassName");
  assert.match(approve, /bg-emerald-600/, "Approve is emerald-600");
  assert.match(danger, /bg-rose-600/, "Reject is the danger token, rose-600");
  for (const dimension of ["px-4", "py-2", "text-sm", "font-bold", "inline-flex", "items-center"]) {
    assert.ok(
      approve.includes(dimension) && danger.includes(dimension),
      `the decision pair must share ${dimension} — they only ever render side by side, and a pair ` +
        "of different sizes is exactly what every hand-written pair produced",
    );
  }
  // 🔴 EMERALD LIVES IN EXACTLY TWO TOKENS, and this asks the FILE rather than a hand-written
  // list — a list is what let the first version of the ratchet pass with 376 painted controls in
  // the tree, because a token added later is never in it. A green Save, Next or Submit fails here.
  const GREEN_IS_THEIRS = new Set(["phxButtonApproveClassName", "phxButtonApproveDenseClassName"]);
  const everyToken = [...TOKENS_SOURCE.matchAll(/export const (phx\w+)\s*(?::[^=]*)?=/g)].map(
    (m) => m[1],
  );
  assert.ok(everyToken.length > 10, "the export scan found almost nothing — the regex has rotted");
  for (const name of everyToken) {
    if (GREEN_IS_THEIRS.has(name)) continue;
    assert.ok(
      !/emerald|\bgreen-/.test(token(name)),
      `${name} has gone green — emerald is the approve half of a decision pair and nothing else. ` +
        "A form's own terminal commit is phxButtonAccentClassName, which is orange.",
    );
  }

  // The dense pair exists ONLY because the <Button> primitive and a table row bring their own
  // geometry (the owner's 2026-10-06 h-8/h-9 exemption). The moment one of them carries a
  // dimension it stops being droppable onto a dense control, and the two halves can diverge in
  // size again — which is the defect the whole token set exists to end.
  const DIMENSION =
    /\b(?:p[xytrbl]?-\d|h-\d|w-\d|min-h-|max-w-|gap-\d|text-(?:xs|sm|base|lg|xl|phx-)|inline-flex|flex\b|grid\b|border(?![-\w])|border-\d)/;
  for (const name of ["phxButtonApproveDenseClassName", "phxButtonDangerDenseClassName"] as const) {
    const value = token(name);
    const hit = DIMENSION.exec(value);
    assert.ok(
      hit === null,
      `${name} has grown geometry (${hit?.[0]}) — the dense pair is COLOUR ONLY, so it can sit on ` +
        "an h-8 <Button> or a table-row chip without resizing it, and so whatever supplies the " +
        "geometry supplies it to BOTH halves",
    );
    assert.match(
      value,
      /^border-(?:emerald|rose)-600 bg-(?:emerald|rose)-600 text-white hover:bg-(?:emerald|rose)-700$/,
      `${name} is the colour contract and nothing more — the border COLOUR belongs to it (a swept ` +
        "button with a hairline must not name emerald itself) and the border WIDTH does not, which " +
        "is what keeps it inert on an element that has no border",
    );
  }

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

// The exemptions, the token names, the control tags, the wrappers and the non-field types are in
// `.claude/hooks/lib/form-design-shapes.mjs` — with his own words on each dark ground and on the
// login screen, which are rulings, not taste. `EXEMPT` is imported above; adding a file to it is
// one edit that both this check and the Write-time guard obey.

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

// The identifier walk, the token-reachability chase and the paint test live in the shared module,
// with the measurements that shaped each one. `scanControls` is the whole per-control decision, so
// this job and the Write-time guard cannot disagree about one control.

function ratchetTests(): void {
  const files = execFileSync("git", ["ls-files", "src/components/*.tsx", "app/*.tsx"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !EXEMPT.some((e) => f.startsWith(e) || f.includes(e)));

  const exported = exportedConstants();
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
    const scan = scanControls(src, { exported });
    total += scan.total;
    onDesign += scan.onDesign;
    for (const { tag, flat } of scan.offenders) {
      offenders.push(`${rel} [${tag}] ${flat.slice(0, 90)}`);
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
// `TOKEN_GROUPS`, the conflict test and the two template shapes are in the shared module, so the
// Write-time guard refuses the same tail this job fails on.

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
    for (const { bad } of templateConcatSites(src)) {
      offenders.push(`${rel} — \`…\${token} ${bad.join(" ")}\``);
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

/**
 * 🔴 HIS RULING, 2026-10-06: *"keep the dark menus and bands out of the form design too"*.
 * Listing a file in EXEMPT only stops the ratchet counting it — nothing stopped the next sweep
 * handing it the light token again, which is exactly what happened to the admin sidebar's module
 * search: it shipped as `cn(phxFieldClassName, "pl-9 pr-8")`, a lit white box inside a bare
 * `bg-[#000000]` sidebar, on the chrome of every admin page. So each dark ground is pinned by the
 * fragment that MAKES it dark. A control sitting on a dark ground either names its own dark
 * classes or overrides the token through cn() — it is never left on the bare light token.
 */
const DARK_GROUND_KEEPS: Array<{ file: string; keep: string; why: string }> = [
  {
    file: "src/components/layout/sidebar.tsx",
    keep: "bg-white/5 pl-9 pr-8",
    why: "the admin sidebar's module search, inside a bare bg-[#000000] sidebar",
  },
  {
    file: "src/components/sales/weekly/weekly-distributor-column-editor.tsx",
    keep: "border border-white/20 bg-[#020617]",
    why: "the weekly column editor's header-row select, on a near-black band",
  },
  {
    file: "src/components/sales/weekly/portal-weekly-field-force-view.tsx",
    keep: "border border-slate-700 bg-slate-800",
    why: "the Field Force band's rep search, on bg-slate-900",
  },
  {
    file: "src/components/layout/internal-messages-menu.tsx",
    keep: 'isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white',
    why: "the internal messages composer, whose admin mode is near-black",
  },
  {
    file: "src/components/auth/premium-login-page.tsx",
    keep: "border border-white/14 bg-white/[0.045]",
    why: "the login fields — the screen every employee meets first",
  },
  {
    file: "src/components/auth/password-setup-form.tsx",
    keep: "border border-white/14 bg-white/[0.045]",
    why: "the password-setup fields, same dark glass identity",
  },
];

function darkGroundKeepTests(): void {
  for (const { file, keep, why } of DARK_GROUND_KEEPS) {
    const src = readFileSync(file, "utf8");
    assert.ok(
      src.includes(keep),
      `${file}: ${why} — it lost the dark ground \`${keep}\`. The owner ruled on 2026-10-06 ` +
        `"keep the dark menus and bands out of the form design too", so a control on a dark ground ` +
        `is never handed the light form token. Restore the dark classes; do not relax this.`,
    );
  }
}

// ── 4. ONE wizard shell ──────────────────────────────────────────────────────
//
// 🔴 The owner's rule is "every form wears THIS form's design", and a second
// COPY of the shell satisfies that on the day it is written and quietly stops
// satisfying it on the day a token changes. Until 2026-10-07 the app held the
// kit's `FormWizard` and a class-for-class copy of it in Phoenix CRM's
// `step-form.tsx` — so a change to the orange strip or the 244px rail reached
// one of the two screens and the pair drifted with nothing going red.
//
// So the rail and the phone's stepper may be DECLARED in exactly one file. A
// form that needs something the kit does not do adds a PROP to the kit — which
// every other form then inherits — and never a fork of it.

const WIZARD_SHELL = "src/components/ui/form-kit.tsx";

/**
 * 🔴 THE ONE EXEMPTION IS THE OWNER'S OWN, AND IT IS NOT A STYLE OPINION.
 *
 * The self spotlight was held against the Report It form until 2026-09-30, when he said "premium
 * polish the page to follow the portal style" and moved it onto the EMPLOYEE PORTAL's look
 * instead. `tests/spotlight-portal-look.test.ts` pins that new look — down to the portal's own
 * card, which is `rounded` — so dragging the page back onto the kit's shell reverts an
 * instruction he gave, and that test fails rather than this one. Measured on 2026-10-07: it was
 * converted here, and the spotlight test caught it.
 *
 * Nothing goes in this map because a conversion was awkward. It takes HIS words putting that
 * screen on another design, and the test that holds it there, named.
 */
const NOT_THE_KIT_BY_HIS_OWN_INSTRUCTION: ReadonlyArray<readonly [string, string]> = [
  [
    "src/components/spotlight/rep-spotlight-workspace.tsx",
    "tests/spotlight-portal-look.test.ts",
  ],
];

/** Every `.tsx` under src/components and app, from git rather than a walk. */
function appTsxFiles(): string[] {
  return execFileSync("git", ["ls-files", "src/components", "app"], { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.endsWith(".tsx"));
}

function oneWizardShellTests(): void {
  const kit = readFileSync(WIZARD_SHELL, "utf8");
  // Anti-vacuity: if the kit stops declaring them, this whole check means nothing.
  for (const name of ["VerticalStepper", "MobileStepper"]) {
    assert.match(
      kit,
      new RegExp(`function ${name}\\b`),
      `${WIZARD_SHELL} must declare ${name} — it is the one shell this check measures against`,
    );
  }

  // Anti-vacuity for the exemption: an entry whose keeper has gone is a free pass nobody is
  // holding any more, so it must be re-decided rather than inherited.
  const exempt = new Set<string>();
  for (const [file, keeper] of NOT_THE_KIT_BY_HIS_OWN_INSTRUCTION) {
    assert.ok(
      existsSync(file),
      `${file} is exempt from the one-shell rule but no longer exists — drop the exemption`,
    );
    assert.ok(
      existsSync(keeper),
      `${file} is exempt because ${keeper} pins it to another design, and that test is gone — ` +
        "re-decide the exemption instead of leaving it standing on nothing",
    );
    exempt.add(file);
  }

  const forks: string[] = [];
  for (const file of appTsxFiles()) {
    if (file === WIZARD_SHELL || exempt.has(file)) continue;
    const code = readFileSync(file, "utf8");
    if (/function (?:Vertical|Mobile)Stepper\b/.test(code)) forks.push(file);
  }
  assert.deepEqual(
    forks,
    [],
    `these files declare a step rail of their own instead of rendering ${WIZARD_SHELL}'s FormWizard:\n  ` +
      `${forks.join("\n  ")}\n` +
      "A second copy of the shell is how the one form design dies: it looks identical the day it is " +
      "written, and a token change afterwards reaches one screen and not the other. Render FormWizard " +
      "and pass what you need as a prop — canJump, footer, panel, bleed and footnoteIcon all exist " +
      "because the Phoenix CRM copy needed them. A screen the OWNER put on another design is " +
      "exempted in NOT_THE_KIT_BY_HIS_OWN_INSTRUCTION above, with the test that holds it there.",
  );
}

// ── 5. The forms that are square stay square ─────────────────────────────────
//
// 🔒 THE SQUARE-EDGE GOLDEN RULE is the other half of the one form design: the Adverse Drug
// Reaction form has no corner radius anywhere, and neither do `form-kit.tsx` or
// `form-tokens.ts`. 132 radius classes came out of the five forms below on 2026-10-07, and this
// is what stops them coming back one `rounded-sm` at a time — which is how they got there.
//
// 🔴 THIS CHECK MEASURES CORNER RADII AND IS NOT THE AUTHORITY ON `rounded-full`. The platform
// module already owns that one, measured: `rounded-full` is the single radius class no
// `--phx-radius-*` token reaches, so it is square ONLY because `.admin-shell`/
// `.employee-portal-shell` zero `[class*="rounded"]`, and the same markup mounted outside a shell
// renders `calc(infinity * 1px)`. A NEW one is therefore a defect wherever it is written — see
// `.claude/rules/platform-design-tokens.md` — and the two pills on the attendance-exceptions
// form were removed on 2026-10-07 for exactly that reason. It is not failed HERE only because the
// one left in the system is the reference form's own decorative blur circle
// (`h-48 w-48 rounded-full ... blur-2xl`), and that form's design is the owner's, not ours to
// edit. `rounded-none` passes because it is a file saying square on purpose.
//
// This is a LIST, not a sweep of every file: a page the owner put on another design (the self
// spotlight on the portal's own rounded card, section 4) must not be dragged in by a rule that
// grew past what he asked for. A form converted to square is ADDED here in the PR that converts
// it, and nothing is ever removed.

const SQUARE_FORMS = [
  "src/components/ui/form-kit.tsx",
  "src/components/ui/form-tokens.ts",
  "src/components/report-it/report-it-form.tsx",
  "src/components/phoenix-crm/step-form.tsx",
  "src/components/probation/structured-feedback-form.tsx",
  "src/components/direct-orders/direct-order-correct-resubmit.tsx",
  "src/components/coaching/coaching-report-form.tsx",
  "src/components/vacation/vacation-request-form.tsx",
  "src/components/employee-portal/medical-rep-expenses.tsx",
  "src/components/employee-portal/marketing-request-drafts.tsx",
  "src/components/employee-portal/employee-excuses-workspace.tsx",
  "src/components/employee-portal/contact-hr-support-page.tsx",
  "src/components/admin/private-calendar-disputes-workspace.tsx",
  "src/components/attendance/attendance-exceptions-manager.tsx",
];

/** Every corner radius except `full` and `none`. */
const CORNER_RADIUS = /\brounded(?:-(?:sm|md|lg|xl|2xl|3xl|\[[^\]]*\]))?(?![\w-])/g;

function squareFormsTests(): void {
  const offenders: string[] = [];
  for (const file of SQUARE_FORMS) {
    const src = readFileSync(file, "utf8");
    // Anti-vacuity: an empty or renamed file must not pass by having no classes at all.
    assert.match(
      src,
      /[cC]lassName/,
      `${file} is pinned square but names no class at all — the pin is measuring nothing`,
    );
    const mask = commentMask(src);
    for (const match of src.matchAll(CORNER_RADIUS)) {
      // A radius NAMED in a comment (this file's own prose, a note on why it went) is not one.
      if (mask[match.index]) continue;
      const line = src.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${line}  ${match[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these forms are pinned to square edges and have grown a corner radius again:\n  " +
      `${offenders.join("\n  ")}\n` +
      "The square-edge golden rule has no exceptions on a form: drop the class — no class at all " +
      "is square in every context, which rounded-md is only by token and rounded-full is not at " +
      "all (.claude/rules/platform-design-tokens.md). A file that means square writes " +
      "rounded-none. If the owner has put one of these screens on another design, take it OUT of " +
      "SQUARE_FORMS with his words and the test that holds it there, the way section 4 does.",
  );
}

// ── 6. No hand-written decision green ────────────────────────────────────────
//
// 🔒 OWNER, 2026-10-07: "put the approve token on the five decision-pair screens", then "sweep the
// ten lone green buttons too". Twenty-three hand-written green buttons went onto the token; this is
// what stops the twenty-fourth. A green fill WITH a green hover is the button signature — a status
// chip, a legend dot and a progress bar have no hover, so none of them is caught here.
//
// 🔴 THE LIST IS EMPTY, AND THAT IS THE POINT. The two WhatsApp share buttons were its only
// entries; on 2026-10-07 the owner asked for them to get their own brand constant
// (`phxWhatsAppShareButtonClassName` in `src/components/ui/brand-tokens.ts`), so the green left
// the `.tsx` files altogether. **It may grow again only for a green that is genuinely not a
// decision** — a brand, a chip — and each entry carries its reason. A new decision green belongs on
// `phxButtonApproveDenseClassName` (colour only, so the control keeps whatever geometry it has) or
// on `phxButtonApproveClassName` at full size.
//
// 🔴 AN EMPTY LIST CANNOT PROVE THE PATTERN STILL WORKS, so the pattern is self-tested against two
// probes below instead of against whatever happens to be in the tree. That was the hole: the first
// draft of this check asserted "an exception matched something", which went vacuous the moment the
// exceptions were swept — the check would then have passed for the rest of time, whatever anyone
// added.
const GREEN_THAT_IS_NOT_A_DECISION: ReadonlyArray<readonly [string, string]> = [];

function decisionGreenTests(): void {
  const allowed = new Map(GREEN_THAT_IS_NOT_A_DECISION);

  // The brand constant is a button too, so the square-edge rule reaches it — and it must NOT be in
  // form-tokens.ts, where the palette assertion would read it as a fifth accent.
  const brand = readFileSync(
    fileURLToPath(new URL("../src/components/ui/brand-tokens.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    brand,
    /export const phxWhatsAppShareButtonClassName/,
    "brand-tokens.ts must keep the WhatsApp share button's one definition",
  );
  assert.match(
    brand,
    /export const phxWhatsAppSendButtonClassName/,
    "brand-tokens.ts must keep the full-size WhatsApp button too — the send pair is not dense",
  );
  for (const name of ["phxWhatsAppShareButtonClassName", "phxWhatsAppSendButtonClassName"] as const) {
    const value = brand.match(new RegExp(`export const ${name}\\s*=\\s*\n?\\s*"([^"]*)"`))?.[1];
    assert.ok(value, `brand-tokens.ts no longer exports a string constant named ${name}`);
    // 🔴 A FIXED FILL NEEDS A FIXED INK, and this is asserted on the CLASS STRING rather than on
    // the file, whose own prose names the trap and would fail the check it documents. `--phx-ink`
    // is near-black in light mode and near-WHITE in dark (`src/styles/tokens.css`), so a
    // theme-following ink on this green would flip to white when the theme did and put back the
    // 1.98:1 contrast the owner ruled against on 2026-10-08 ("use near-black ink on the WhatsApp
    // buttons") — with nothing to catch it, because the brand fill cannot follow the theme.
    assert.ok(
      !/text-phx-ink|text-\[var\(/.test(value),
      `${name} must not take a theme-following ink — --phx-ink flips to near-white in dark mode ` +
        "while the brand fill cannot, which silently restores the 1.98:1 contrast. A fixed " +
        "near-black (text-slate-900) measures 9.00:1 on the fill and 5.76:1 on the hover.",
    );
    assert.ok(
      !/text-white/.test(value),
      `${name} has gone back to white ink — 1.98:1 on #25D366, which the owner ruled against on ` +
        "2026-10-08 after being shown the measurement",
    );

    for (const shared of ["bg-[#25D366]", "border-[#1DA851]", "hover:bg-[#1DA851]", "text-slate-900"]) {
      assert.ok(
        value.includes(shared),
        `${name} must carry ${shared} — the two sizes are ONE look, so a change to the brand ` +
          "reaches every WhatsApp button rather than whichever one somebody remembered",
      );
    }

  }
  assert.match(
    brand,
    /bg-\[#25D366\]/,
    "the share button must carry WhatsApp's real #25D366 (owner, 2026-10-07: \"repaint the " +
      "WhatsApp share buttons to the real #25D366\") — it wore emerald-600 before that, which is " +
      "what made the app disagree with itself about what WhatsApp looks like",
  );

  // 🔴 AND THE BRAND GREEN STAYS IN ONE PLACE. A fill written straight into a .tsx is how there
  // came to be two WhatsApp greens in the first place, and this check found two more buttons the
  // green-button ratchet could never see: that one looks for `bg-emerald-*`/`bg-green-*`, so a
  // button painted with the raw hex was invisible to it.
  //
  // It matches a RESTING fill only. The organogram's WhatsApp button needs no exception for that
  // reason — it paints the hex on text and on a hover, never as a fill — and the one named
  // exception is a 6px dot, which is not a button at all.
  const BRAND_FILL = /className="[^"]*(?<!hover:)bg-\[#25D366\][^"]*"/g;
  const BRAND_FILL_IS_NOT_A_BUTTON: ReadonlyArray<readonly [string, string]> = [
    ["app/(admin)/recruitment/whatsapp-templates/page.tsx", "a 6px status dot, not a button"],
  ];
  const brandAllowed = new Set(BRAND_FILL_IS_NOT_A_BUTTON.map(([f]) => f));
  for (const [file, why] of BRAND_FILL_IS_NOT_A_BUTTON) {
    assert.ok(
      existsSync(fileURLToPath(new URL("../" + file, import.meta.url))),
      `${file} is named as a brand-fill exception (${why}) but no longer exists — drop the entry`,
    );
  }
  const brandOffenders: string[] = [];
  for (const file of appTsxFiles()) {
    if (brandAllowed.has(file)) continue;
    const src = readFileSync(fileURLToPath(new URL("../" + file, import.meta.url)), "utf8");
    const mask = commentMask(src);
    for (const m of src.matchAll(BRAND_FILL)) {
      if (mask[m.index ?? 0] === 1) continue;
      brandOffenders.push(`${file} — ${m[0].slice(0, 110)}`);
    }
  }
  assert.deepEqual(
    brandOffenders,
    [],
    "WhatsApp's brand green is painted straight into a component:\n  " +
      brandOffenders.join("\n  ") +
      "\n\nUse phxWhatsAppShareButtonClassName from src/components/ui/brand-tokens.ts. If the fill " +
      "genuinely is not a share button, name the file in BRAND_FILL_IS_NOT_A_BUTTON with its reason.",
  );
  assert.ok(
    !/\brounded/.test(brand),
    "a brand button carries no corner radius either — the square-edge golden rule has no exception",
  );
  assert.ok(
    !/whatsApp|WhatsApp/i.test(TOKENS_SOURCE),
    "a brand colour has moved into form-tokens.ts — it belongs in brand-tokens.ts, or a future " +
      "change to the approve green will silently restyle a WhatsApp button",
  );
  for (const [file, why] of GREEN_THAT_IS_NOT_A_DECISION) {
    assert.ok(
      existsSync(fileURLToPath(new URL("../" + file, import.meta.url))),
      `${file} is named as a ${why} exception but no longer exists — drop the entry`,
    );
  }

  // A className literal that fills green AND hovers green: that is a button, not a chip.
  const GREEN_BUTTON = /className="[^"]*\bbg-(?:emerald|green)-[56]00\b[^"]*hover:bg-(?:emerald|green)-[0-9]{3}[^"]*"/g;
  const offenders: string[] = [];
  let allowedSeen = 0;
  for (const file of appTsxFiles()) {
    const src = readFileSync(fileURLToPath(new URL("../" + file, import.meta.url)), "utf8");
    const mask = commentMask(src);
    for (const m of src.matchAll(GREEN_BUTTON)) {
      if (mask[m.index ?? 0] === 1) continue; // the repo's prose quotes JSX
      if (allowed.has(file)) {
        allowedSeen += 1;
        continue;
      }
      offenders.push(`${file} — ${m[0].slice(0, 110)}`);
    }
  }

  void allowedSeen;

  // The pattern's own self-test: it must catch a green button and ignore a green chip.
  assert.match(
    'className="bg-emerald-600 text-white hover:bg-emerald-700"',
    new RegExp(GREEN_BUTTON.source),
    "the GREEN_BUTTON pattern no longer matches a plain green button — this check has gone vacuous",
  );
  assert.doesNotMatch(
    'className="inline-block h-2 w-2 bg-emerald-500"',
    new RegExp(GREEN_BUTTON.source),
    "the GREEN_BUTTON pattern now catches a status chip — a legend swatch has no hover and must " +
      "stay out of this check, or the next session will repaint a status as a decision",
  );
  assert.deepEqual(
    offenders,
    [],
    "a decision button is painting its own green:\n  " +
      offenders.join("\n  ") +
      "\n\nUse phxButtonApproveDenseClassName — it is COLOUR ONLY, so the control keeps the exact " +
      "padding, height and font size it has now — or phxButtonApproveClassName where the button is " +
      "full size and renders beside phxButtonDangerClassName. If the green is NOT a decision (a " +
      "brand colour, a chip), name the file in GREEN_THAT_IS_NOT_A_DECISION with its reason.",
  );
}

export async function runFormDesignSystemTests(): Promise<void> {
  identityTests();
  singleSourceTests();
  ratchetTests();
  mergeSemanticsTests();
  sixteenPixelKeepTests();
  darkGroundKeepTests();
  oneWizardShellTests();
  squareFormsTests();
  decisionGreenTests();
}
