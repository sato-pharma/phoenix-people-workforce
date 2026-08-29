import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The admin shell's warm-neutral identity, and the two things that make it safe.
//
// WHY THE REMAP EXISTS. The admin shell ran two families of grey at once: the warm --phx-
// tokens (paper #f7f6f3, hairline #e0dcd4, orange accent) against 12,015 cool `slate-*`
// utilities on a cool #F3F6FA ground. Card edge to card edge that is a 26-point blue-minus-red
// swing, which is what reads as "mismatched identity". Tailwind v4 compiles `bg-slate-50` to
// `background-color: var(--color-slate-50)`, so redefining those variables retints every one of
// them at once, with no file sweep.
//
// WHY IT MUST STAY SCOPED. src/components/admin/admin-design-system.tsx is not admin-only
// despite its name — 52 of the employee portal's 114 pages render it. The remap is therefore
// safe ONLY because it is scoped to `.admin-shell`, which is stamped in two admin-only files
// (app-shell.tsx, app-shell-loading.tsx) and never wraps the portal. Move these declarations to
// `:root` and the portal silently changes colour. That is the failure this test exists to catch.
//
// WHY LIGHTNESS IS PINNED. The ramp keeps Tailwind's OKLCH lightness EXACTLY and rotates only
// hue and chroma, which is what preserves every contrast ratio in the shell (measured: no pair
// moves by more than 0.08, and slate-500-on-white stays AA at 4.76 -> 4.76). A later "tidy up
// the ramp" that nudges an L value would dim real text with nothing to catch it — no lint rule
// and no build error sees a colour that is merely harder to read. So each L is compared against
// Tailwind's own slate ramp, read from the installed package rather than copied here.

const GLOBALS_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8",
);

const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
const ALIAS_FAMILIES = ["gray", "zinc", "neutral", "stone"];

/** The block that carries the remap, identified by its opening selector. */
function adminScopedBlock(): string {
  const start = GLOBALS_SOURCE.indexOf(".admin-shell,\nhtml:has(.admin-shell)");
  assert.notEqual(
    start,
    -1,
    "could not find the admin-shell palette block in app/globals.css — it is expected to open " +
      "with `.admin-shell,` followed by an `html:has(.admin-shell)` selector",
  );
  const open = GLOBALS_SOURCE.indexOf("{", start);
  const close = GLOBALS_SOURCE.indexOf("\n}", open);
  assert.ok(open !== -1 && close !== -1, "admin-shell palette block is not brace-balanced");
  return GLOBALS_SOURCE.slice(start, close);
}

/**
 * CSS comments, removed before any rule is parsed.
 *
 * The blocks below document themselves, and the prose quotes the very things the parsers
 * look for -- `<CartesianGrid stroke="#e2e8f0">` sits in a comment, not a rule. Reading a
 * comment as a selector pairs a colour from the prose with a target from the next real rule,
 * which is a FALSE failure: it reports drift that does not exist while saying nothing about
 * the rule it actually inspected. Strip first, then parse.
 */
function documentedBlockAt(markerIndex: number, endMarkerIndex?: number): string {
  // Each block is found by a marker written INSIDE its own comment, so slice from the `/*`
  // that opens that comment -- otherwise the stripper never sees an opener, treats the
  // comment's tail as rules, and reads the prose as selectors.
  //
  // The end matters just as much. Slicing to EOF makes every later block part of this one, so
  // a failure in the LAST block is reported against the FIRST -- the assertion is right and
  // the message sends you to the wrong place, which costs more than a missing check.
  const opener = GLOBALS_SOURCE.lastIndexOf("/*", markerIndex);
  const start = opener === -1 ? markerIndex : opener;
  const end =
    endMarkerIndex === undefined
      ? GLOBALS_SOURCE.length
      : GLOBALS_SOURCE.lastIndexOf("/*", endMarkerIndex);
  return stripComments(GLOBALS_SOURCE.slice(start, end === -1 ? undefined : end));
}

/**
 * Every selector in every rule -- not only the one on the line carrying the `{`.
 *
 * A multi-selector rule lists its earlier selectors on preceding lines, and that is exactly
 * where an unscoped one hides: the rule still looks scoped because its LAST selector is.
 */
function selectorsIn(css: string): string[] {
  return css
    .split("}")
    .filter((chunk) => chunk.includes("{"))
    .flatMap((chunk) => splitSelectorList(chunk.slice(0, chunk.indexOf("{"))))
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0);
}

/**
 * Split a selector list on its top-level commas only.
 *
 * `.admin-shell :where(a, button)` is ONE scoped selector. Splitting on every comma turns it
 * into `.admin-shell :where(a` and `button)`, and that second fragment does not start with
 * `.admin-shell` -- so the scope check fails on a rule that is perfectly scoped. A false red
 * on a required CI job reads as "your change is wrong" rather than "the parser is", which is
 * the more expensive of the two mistakes. Three rules in the palette block use `:where()`.
 */
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

function stripComments(css: string): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    const open = css.indexOf("/*", cursor);
    if (open === -1) return out + css.slice(cursor);
    out += css.slice(cursor, open);
    const close = css.indexOf("*/", open + 2);
    if (close === -1) return out;
    cursor = close + 2;
  }
}

/** Tailwind's own slate ramp, read live from the installed package rather than copied. */
function tailwindSlateLightness(): Map<string, number> {
  const require = createRequire(import.meta.url);
  const themePath = require.resolve("tailwindcss/theme.css");
  const theme = readFileSync(themePath, "utf8");
  const out = new Map<string, number>();
  for (const match of theme.matchAll(/--color-slate-(\d+):\s*oklch\(\s*([0-9.]+)%/g)) {
    out.set(match[1], Number(match[2]));
  }
  assert.equal(
    out.size,
    SHADES.length,
    `expected ${SHADES.length} slate shades in tailwindcss/theme.css, read ${out.size} — the ` +
      `matcher is probably stale rather than the package`,
  );
  return out;
}

export async function runAdminShellPaletteScopeTests(): Promise<void> {
  const block = adminScopedBlock();

  // --- 1. the remap never escapes the admin shell ---------------------------
  // Every --color-slate-* declaration in globals.css must sit inside the admin-scoped block.
  // One declared at :root would repaint the employee portal.
  const allSlateDecls = [...GLOBALS_SOURCE.matchAll(/--color-slate-\d+\s*:/g)].length;
  const scopedSlateDecls = [...block.matchAll(/--color-slate-\d+\s*:/g)].length;
  assert.equal(
    allSlateDecls,
    scopedSlateDecls,
    `app/globals.css declares ${allSlateDecls} --color-slate-* variables but only ` +
      `${scopedSlateDecls} are inside the .admin-shell block. A neutral-palette override outside ` +
      `that scope repaints the employee portal, which 52 of its 114 pages would inherit.`,
  );

  // --- 2. the document-level selector excludes portal pages -----------------
  // `html:has(.admin-shell)` also covers content rendered through createPortal(…, document.body)
  // — 16 components do that and would otherwise escape the shell. But /payslips can render
  // EITHER chrome, so the selector must stand down whenever a portal shell is in the document.
  assert.match(
    block,
    /html:has\(\.admin-shell\):not\(:has\(\.employee-portal-shell\)\)/,
    "the document-level selector must be " +
      "`html:has(.admin-shell):not(:has(.employee-portal-shell))`. Without the :not() guard, a " +
      "page rendering both chromes (app/payslips/page.tsx branches between them) would push the " +
      "warm ramp onto the portal subtree too.",
  );

  // --- 3. every shade is remapped ------------------------------------------
  // A partial remap is the original bug in miniature: a shell mixing warm and cool greys.
  const remapped = new Map<string, { l: number; hue: number }>();
  for (const match of block.matchAll(
    /--color-slate-(\d+)\s*:\s*oklch\(\s*([0-9.]+)%\s+([0-9.]+)\s+([0-9.]+)\s*\)/g,
  )) {
    remapped.set(match[1], { l: Number(match[2]), hue: Number(match[4]) });
  }
  const missing = SHADES.filter((shade) => !remapped.has(shade));
  assert.deepEqual(
    missing,
    [],
    `slate shade(s) not remapped: ${missing.join(", ")}. A partially remapped ramp leaves the ` +
      `admin shell mixing warm and cool greys, which is the defect this block removes.`,
  );

  // --- 4. lightness is identical to Tailwind's slate ------------------------
  const reference = tailwindSlateLightness();
  const drifted: string[] = [];
  for (const shade of SHADES) {
    const ours = remapped.get(shade)!.l;
    const theirs = reference.get(shade)!;
    if (ours !== theirs) drifted.push(`slate-${shade}: ${ours}% vs Tailwind's ${theirs}%`);
  }
  assert.deepEqual(
    drifted,
    [],
    `the warm ramp must copy Tailwind's slate LIGHTNESS exactly and change only hue/chroma — ` +
      `that is what preserves every contrast ratio in the admin shell. Drifted: ` +
      `${drifted.join("; ")}.`,
  );

  // --- 5. every remapped hue is actually warm -------------------------------
  // Blue sits around 200-320deg in OKLCH; the warm ramp lives at 70-95deg. A value drifting back
  // into the blue band would silently restore the temperature clash.
  const stillCool = SHADES.filter((shade) => {
    const hue = remapped.get(shade)!.hue;
    return hue >= 180 && hue <= 320;
  });
  assert.deepEqual(
    stillCool,
    [],
    `slate shade(s) remapped to a cool hue: ${stillCool.join(", ")}. The warm ramp is defined ` +
      `at 70-95deg; 180-320deg is the blue band the remap exists to leave.`,
  );

  // --- 6. the other four neutral families follow the same ramp --------------
  // gray/zinc/neutral/stone are the same neutral intent spelled four other ways. Aliasing them
  // means a future `bg-gray-100` cannot reintroduce a second temperature.
  const unaliased: string[] = [];
  for (const family of ALIAS_FAMILIES) {
    for (const shade of SHADES) {
      const pattern = new RegExp(
        `--color-${family}-${shade}\\s*:\\s*var\\(--color-slate-${shade}\\)`,
      );
      if (!pattern.test(block)) unaliased.push(`${family}-${shade}`);
    }
  }
  assert.deepEqual(
    unaliased,
    [],
    `neutral alias(es) missing from the admin-shell block: ${unaliased.join(", ")}. Without ` +
      `them a future gray-/zinc-/neutral-/stone- class reintroduces a cool grey.`,
  );

  // --- 7. the locked rules are still there and still locked ----------------
  // This block sits directly beneath them; a careless edit to the region could take them out.
  assert.match(
    GLOBALS_SOURCE,
    /\.admin-shell \[class\*="rounded"\]\s*\{\s*border-radius:\s*0\s*!important;/,
    "the LOCKED admin-shell square-corner rule is missing from app/globals.css",
  );
  assert.match(
    GLOBALS_SOURCE,
    /\.admin-shell thead th\s*\{[^}]*background-color:\s*#000000\s*!important/,
    "the LOCKED admin-shell flat-black table header is missing from app/globals.css",
  );

  // --- 8. the arbitrary-hex residue -----------------------------------------
  // The variable remap cannot reach a literal: `border-[#DDE6F1]` compiles to
  // `border-color:#DDE6F1` with no variable in between. A second block overrides those by
  // class selector. It carries three failure modes that nothing else in the repo can see.
  const residueStart = GLOBALS_SOURCE.indexOf("-- The arbitrary-hex residue");
  assert.notEqual(
    residueStart,
    -1,
    "could not find the arbitrary-hex residue block in app/globals.css",
  );
  const svgStart = GLOBALS_SOURCE.indexOf("-- Chart furniture drawn as SVG presentation attributes");
  assert.notEqual(
    svgStart,
    -1,
    "could not find the SVG presentation-attribute block in app/globals.css",
  );
  const residue = documentedBlockAt(residueStart, svgStart);
  const residueRules = [...residue.matchAll(/(\.admin-shell [^{}]+)\{([^}]*)\}/g)];
  assert.ok(
    residueRules.length >= 20,
    `expected the residue block to carry the overrides, parsed only ${residueRules.length} rules`,
  );

  // Everything from the residue block to the end of the file: the class overrides, the SVG
  // overrides, and any block a later change appends after them. The two checks that carry
  // real safety — scope, and the protected colours in section 10 — run over ALL of it, so a
  // future block cannot escape them simply by being new. The per-block checks stay per-block.
  const allOverrides = documentedBlockAt(residueStart);

  // 8a. Every selector stays inside the shell. A bare `.bg-\[\#FCFDFE\]` would repaint the
  // portal, which uses the same literal — this is the section-1 failure in its second form.
  const unscoped = selectorsIn(allOverrides).filter((sel) => !sel.startsWith(".admin-shell "));
  assert.deepEqual(
    unscoped,
    [],
    `override selector(s) below the palette block are not scoped to .admin-shell: ` +
      `${unscoped.join(", ")}. The employee portal renders these same literals and the same ` +
      `chart components, so an unscoped override repaints it.`,
  );

  // 8b. Every arbitrary-value selector is escaped. `.bg-[#FCFDFE]` unescaped is not a valid
  // selector — it silently matches nothing, so the block would look present and do nothing.
  // This is not hypothetical: a heredoc ate the backslashes while this block was generated.
  const unescaped = [...allOverrides.matchAll(/\.(?:text|bg|border|ring|divide|outline|fill|stroke)-\[#/g)];
  assert.equal(
    unescaped.length,
    0,
    `${unescaped.length} residue selector(s) use an UNESCAPED arbitrary value such as ` +
      `\`.bg-[#FCFDFE]\`. A class selector must escape both characters (\`.bg-\\[\\#FCFDFE\\]\`); ` +
      `unescaped it parses as an attribute selector and matches nothing at all, which fails silently.`,
  );

  // 8c. `divide-*` compiles to `> :not(:last-child)` in Tailwind 4, so an override written
  // against the element itself paints the wrong box — the parent's border, not the separators.
  for (const [, selector] of residueRules) {
    if (!selector.includes("divide-")) continue;
    assert.ok(
      selector.includes("> :not(:last-child)"),
      `residue override \`${selector.trim()}\` targets a divide-* utility but not its child ` +
        `selector. Tailwind 4.3 emits \`.divide-… > :not(:last-child)\`, so this rule sets the ` +
        `border on the wrong element.`,
    );
  }

  // --- 9. the residue keeps lightness, exactly like the ramp ----------------
  // Same invariant as section 4, applied to the literals: hue and chroma may move, lightness
  // may not. A drifting L dims real text and nothing in lint, typecheck or the build sees it.
  const drift: string[] = [];
  const stillCoolLiterals: string[] = [];
  for (const [, selector, body] of residueRules) {
    const target = /:\s*(#[0-9a-fA-F]{6})/.exec(body);
    if (!target) continue;
    const sources = [...selector.matchAll(/\\\[\\#([0-9a-fA-F]{6})\\\]/g)].map((m) => m[1]);
    const to = oklch(target[1]);
    if (to.h >= 180 && to.h <= 320 && to.c > 0.002) stillCoolLiterals.push(`${target[1]}`);
    for (const source of sources) {
      const from = oklch(`#${source}`);
      if (Math.abs(from.l - to.l) > 0.6) {
        drift.push(`#${source} (L ${from.l.toFixed(1)}) -> ${target[1]} (L ${to.l.toFixed(1)})`);
      }
    }
  }
  assert.deepEqual(
    drift,
    [],
    `residue override(s) changed OKLCH LIGHTNESS, not just hue: ${drift.join("; ")}. Lightness ` +
      `is what carries contrast — only hue and chroma may move.`,
  );
  assert.deepEqual(
    stillCoolLiterals,
    [],
    `residue override(s) resolve to a cool hue: ${stillCoolLiterals.join(", ")}. An override ` +
      `that stays in the 180-320deg blue band does nothing at all.`,
  );

  // --- 10. the semantic and brand colours stay out of it --------------------
  // The standing temptation is for a later session to "finish the job" by sweeping the cool
  // colours this block deliberately skips. #1D4ED8 is the link blue, #25D366 is WhatsApp's
  // brand green, and the pale tints below are each HALF of a tone pair — #EFF6FF carries
  // #1D4ED8 text, #F0F9FF sits inside a #E0F2FE border. Warming one half of a pair and
  // leaving the other is a worse result than leaving both alone.
  const MUST_NOT_BE_OVERRIDDEN = [
    "1d4ed8", "25d366", "3b82f6", "8b5cf6", "1e3a8a", "bfdbfe",
    "eff6ff", "dbeafe", "e0f2fe", "f0f9ff", "eef2ff", "cfe0fb", "d7eaf8", "f8fcff",
  ];
  // Both spellings, across every override block: the escaped class `.bg-\[\#EFF6FF\]` and the
  // attribute `[stroke="#EFF6FF"]`. Section 11's chroma cut-off catches a saturated colour in
  // attribute form, but these pale tints sit BELOW it — #EFF6FF reads as a neutral by chroma
  // and is in fact the ground half of a blue tone pair.
  const overridden = new Set([
    ...[...allOverrides.matchAll(/\\\[\\#([0-9a-fA-F]{6})\\\]/g)].map((m) => m[1].toLowerCase()),
    ...[...allOverrides.matchAll(/="#([0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase()),
  ]);
  const swept = MUST_NOT_BE_OVERRIDDEN.filter((hex) => overridden.has(hex));
  assert.deepEqual(
    swept,
    [],
    `an override block targets colour(s) that must stay cool: ${swept.join(", ")}. These are ` +
      `semantic, brand, or one half of a blue tone pair — warming them is a defect, not a polish.`,
  );

  // --- 11. the SVG presentation-attribute overrides -------------------------
  // Recharts writes gridlines and axis labels as `stroke="#e2e8f0"` presentation ATTRIBUTES,
  // which neither the variable remap nor the class overrides can reach. These rules do, and
  // they carry the same two obligations: stay inside the shell (the chart components are
  // shared with the portal), and move hue without moving lightness.
  const svgBlock = documentedBlockAt(svgStart);
  const svgRules = [...svgBlock.matchAll(/([^{}]*\[(?:fill|stroke|stop-color)=[^{}]*)\{([^}]*)\}/g)];
  assert.ok(
    svgRules.length >= 12,
    `expected the SVG block to carry the chart-furniture overrides, parsed only ${svgRules.length}`,
  );
  const svgDrift: string[] = [];
  const svgSaturated: string[] = [];
  for (const [, selector, body] of svgRules) {
    const target = /:\s*(#[0-9a-fA-F]{6})/.exec(body);
    if (!target) continue;
    const to = oklch(target[1]);
    for (const source of [...selector.matchAll(/="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1])) {
      const from = oklch(source);
      // A saturated source is a real data series. Recolouring one changes what the chart MEANS.
      if (from.c >= 0.045) svgSaturated.push(source);
      if (Math.abs(from.l - to.l) > 0.6) {
        svgDrift.push(`${source} (L ${from.l.toFixed(1)}) -> ${target[1]} (L ${to.l.toFixed(1)})`);
      }
    }
  }
  assert.deepEqual(
    svgDrift,
    [],
    `SVG attribute override(s) changed OKLCH LIGHTNESS, not just hue: ${svgDrift.join("; ")}. ` +
      `Chart furniture has to keep its lightness or gridlines stop reading as gridlines.`,
  );
  assert.deepEqual(
    svgSaturated,
    [],
    `SVG attribute override(s) target a SATURATED colour: ${svgSaturated.join(", ")}. Those are ` +
      `data series, not furniture — recolouring one changes what the chart means.`,
  );
}

/** sRGB hex -> OKLCH. Enough precision to compare lightness and classify hue. */
function oklch(hex: string): { l: number; c: number; h: number } {
  const int = Number.parseInt(hex.replace("#", ""), 16);
  const toLinear = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = toLinear((int >> 16) & 255);
  const g = toLinear((int >> 8) & 255);
  const b = toLinear(int & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(okB, okA) * 180) / Math.PI;
  return { l: okL * 100, c: Math.hypot(okA, okB), h: hue < 0 ? hue + 360 : hue };
}
