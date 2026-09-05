// THE SQUARE-EDGE GOLDEN RULE, made mechanical.
//
// The owner's rule (AGENTS.md §4, locked 2026-09-04) is "no round or semi-round corners, anywhere".
// Two CSS sweeps in app/globals.css are supposed to enforce it:
//
//   .admin-shell           [class*="rounded"] { border-radius: 0 !important; }
//   .employee-portal-shell [class*="rounded"] { border-radius: 0 !important; }
//
// BOTH HAVE THE SAME TWO BLIND SPOTS, and this file exists because each one has already shipped a
// live breach that no tooling could see.
//
//   1. THEY MATCH A CLASS, NOT A DECLARATION. `[class*="rounded"]` catches Tailwind's `rounded-*`
//      utilities and nothing else. A hand-written `border-radius:` on an element carrying no
//      `rounded` class is never selected, so it survives the sweep untouched.
//
//   2. THEY ARE SCOPED TO TWO SHELLS. Anything rendered outside `.admin-shell` /
//      `.employee-portal-shell` is not swept at all: the login page, `app/global-error.tsx` (which
//      renders its own <html> and therefore never loads globals.css), every generated document, and
//      any iframe — a separate document that does not load globals.css either.
//
// Both breaches found by hand on 2026-09-05 were invisible for those reasons:
//   PR #3195 — `border-radius: 4px` on `.print-banner__action`, on screen above all twelve hiring
//              documents.
//   PR #3203 — `border-radius: 2px` on `[data-hp-live]` in the paper editor's injected stylesheet,
//              which rounded SIX editing rings at once because `outline` follows the element's own
//              `border-radius`.
//
// A THIRD BLIND SPOT neither sweep can ever reach, found by this audit: `border-radius` does not
// apply to SVG at all, so Recharts' `radius={[8, 8, 0, 0]}` prop — which draws a rounded bar top as
// path geometry — is untouchable from CSS. 27 rounded chart bars were live across 13 dashboards.
// The rule names "bars" explicitly, and two components in this repo had already been squared by
// hand (`radius={0}`, `radius={[0, 0, 0, 0]}`), so those 27 were finishing an unfinished sweep.
//
// WHAT THIS TEST DOES. It measures rounding three ways and pins the result:
//   * the EMITTED stylesheet constants, never the source file they were read out of;
//   * every rounding site in the two shipped stylesheets, keyed by selector and value;
//   * a whole-tree inventory of the rounding the CSS sweeps structurally cannot see.
// Anything NEW fails. A file that is not in the inventory at all and grows a radius fails on the
// first one, which is the case that matters.
//
// ON PINNING BY CONTENT, NOT BY POSITION. Nothing here slices a byte window or a line number — a
// source-pinning test that does false-fails the moment the file above it shifts. Sites are keyed by
// `selector | property: value`, so moving a rule does not break the pin and changing one does.

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { EDITOR_CSS } from "../src/lib/hiring-pack/paper-editor-css.ts";
import { PRINT_BANNER_CSS } from "../src/lib/hiring-pack/render-shared.ts";

// ── The instruments ────────────────────────────────────────────────────────────────────────────

/**
 * Rounding in a STYLESHEET. Permissive on purpose: it takes `-webkit-border-radius`, the physical
 * corners (`border-top-left-radius`), the logical family (`border-start-start-radius`), and a bare
 * `radius:`. This is the regex PR #3203 shipped, unchanged.
 */
const STYLESHEET_ROUNDING = /(?:^|[;{}\s])((?:-[a-z]+-)?(?:border-[a-z-]*)?radius)\s*:\s*([^;}]+)/gi;

/**
 * Rounding in a CSS string embedded in TypeScript or HTML.
 *
 * DELIBERATELY NARROWER THAN THE STYLESHEET FORM — it requires the literal `border-...radius` and
 * will not accept a bare `radius:`. That is not fussiness. A bare `radius:` outside a stylesheet is
 * almost never a corner: this repo has a Google Places search radius in metres
 * (`src/lib/google-maps/server.ts`), a CRM neighbour radius (`src/lib/crm/location-confidence.ts`),
 * a pharmacy-search radius in km (`pharmacy-search-workspace.tsx`) and a `polarToCartesian(cx, cy,
 * radius, angle)` geometry parameter (`payroll-dashboard.tsx`). The permissive form counted all
 * four as rounding. That is worse than a noisy report: pinning a file at a non-zero count because
 * of a false positive is what would let a REAL radius appear in it later without moving the number.
 * The negative control at the bottom of this file holds that line.
 */
const SOURCE_ROUNDING = /((?:-[a-z]+-)?border-[a-z-]*radius)\s*:\s*([^;}"'`]+)/gi;

/** A React inline style: `style={{ borderRadius: 4 }}`, `borderRadius: "0.375rem"`. */
const INLINE_ROUNDING = /\bborderRadius\s*:\s*("[^"]*"|'[^']*'|`[^`]*`|[^,\n}]+)/g;

/** Recharts' corner prop: `radius={[8, 8, 0, 0]}` on a <Bar>, or the scalar `radius={8}`. */
const CHART_ROUNDING = /\bradius=\{(\[[^\]]*\]|[^}]*)\}/g;

/** A custom property whose name carries `radius` — the token layer. */
const RADIUS_TOKEN = /(--[a-z0-9-]*radius[a-z0-9-]*)\s*:\s*([^;}]+)/gi;

/** True when a value is square: `0`, `0px`, `0 0 0 0`, `[0, 0, 0, 0]`, `"0"`. */
function isSquare(raw: string): boolean {
  const value = String(raw)
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/!important/i, "")
    .trim();
  if (value === "") return true;
  if (/^\[[\s0,]*\]$/.test(value)) return true;
  return /^0(px|rem|em|%|pt)?(\s+0(px|rem|em|%|pt)?)*$/.test(value);
}

/** Every rounding declaration in a stylesheet, as `property: value`. */
function roundingIn(css: string): string[] {
  return [...css.matchAll(STYLESHEET_ROUNDING)].map((m) => `${m[1]}: ${m[2].trim()}`);
}

/**
 * Every NON-SQUARE rounding site in a stylesheet, keyed by the rule that carries it.
 *
 * The selector is recovered by walking back to the rule's own `{` and then to the previous brace,
 * so a site keeps its identity when the file above it moves.
 */
function stylesheetSites(css: string): string[] {
  const sites: string[] = [];
  for (const match of css.matchAll(STYLESHEET_ROUNDING)) {
    if (isSquare(match[2])) continue;
    const at = match.index ?? 0;
    const open = css.lastIndexOf("{", at);
    const previous = Math.max(css.lastIndexOf("}", open), css.lastIndexOf("{", Math.max(open - 1, 0)));
    const selector = css
      .slice(previous + 1, open)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim()
      .replace(/\s+/g, " ");
    sites.push(`${selector} | ${match[1]}: ${match[2].trim()}`);
  }
  return sites;
}

/** Every radius TOKEN in a stylesheet, as `--name: value`. */
function radiusTokens(css: string): string[] {
  return [...css.matchAll(RADIUS_TOKEN)].map((m) => `${m[1]}: ${m[2].trim()}`);
}

/**
 * Every NON-SQUARE rounding site in a component, an API route or a static HTML file.
 *
 * A scalar `radius={n}` counts only in a file that imports Recharts, because `radius={500}` on a map
 * circle is a distance, not a corner. The array form `radius={[...]}` is unambiguous everywhere.
 */
function sourceSites(source: string): string[] {
  const sites: string[] = [];
  const usesRecharts = /from\s+["']recharts["']/.test(source);

  for (const match of source.matchAll(SOURCE_ROUNDING)) {
    if (!isSquare(match[2])) sites.push(`${match[1]}: ${match[2].trim()}`);
  }
  for (const match of source.matchAll(INLINE_ROUNDING)) {
    if (!isSquare(match[1])) sites.push(`borderRadius: ${match[1].trim()}`);
  }
  for (const match of source.matchAll(CHART_ROUNDING)) {
    const raw = match[1].trim();
    if (!raw.startsWith("[") && !usesRecharts) continue;
    if (!isSquare(raw)) sites.push(`radius={${raw}}`);
  }
  return sites;
}

/**
 * Every Tailwind class token containing `rounded`, WITH its variant prefix.
 *
 * Capturing the prefix is the whole point. `sm:rounded-2xl` and `rounded-2xl` are different corners
 * — the first appears only above the `sm` breakpoint — and a pattern anchored on the word alone
 * reports both as `rounded-2xl`, which is how a live one gets read as one already dealt with.
 */
function tailwindRounding(source: string): string[] {
  return [...source.matchAll(/[a-z0-9:[\]&_.-]*rounded[a-zA-Z0-9_.,:()[\]-]*/g)].map((m) => m[0]);
}

function walk(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // `pdfjs` is a vendored minified library — not ours to square.
      if (name === "node_modules" || name === ".next" || name === "pdfjs") continue;
      walk(full, found);
    } else if (/\.(tsx?|css|html)$/.test(name)) {
      found.push(full);
    }
  }
  return found;
}

// ── The pinned inventory ───────────────────────────────────────────────────────────────────────

/**
 * Every rounding site in the shipped stylesheets, exactly.
 *
 * BOTH ARE WITH THE OWNER as of 2026-09-05 and are deliberately NOT squared here. They are the two
 * decorative effects on the sign-in screen — a glow and an ember — and at 9999px each is a CIRCLE
 * rather than a rounded box, so squaring them turns a halo into a glowing square and a drifting
 * spark into falling confetti. That is a question for the owner, not an inference for a session.
 *
 * THIS LIST HELD SIX MORE UNTIL 2026-09-05: the scrollbar thumbs and tracks. PR #3209 squared them,
 * on a sharper reading of the mechanism than the one this file started with — RULE 1 sets a radius
 * on the ELEMENT, but a scrollbar thumb is painted on a `::-webkit-scrollbar-thumb` PSEUDO-element,
 * so the sweep can never reach one whatever classes the element carries. Its companion trap is
 * worth carrying: a div marked `[&::-webkit-scrollbar-thumb]:rounded-full` DOES contain the
 * substring "rounded", so `[class*="rounded"]` matches and RULE 1 fires — on the div, whose corners
 * were never the problem, while the thumb keeps its radius. Auditing by grepping `rounded-`
 * utilities and checking they sit inside a shell ticks that case off as handled.
 */
const STYLESHEET_INVENTORY: Record<string, string[]> = {
  "app/globals.css": [
    // NOTE: this rule carries ::before AND ::after, so it is two elements, not one.
    ".login-logo-glow::before, .login-logo-glow::after | border-radius: 9999px",
    ".login-ember | border-radius: 9999px",
  ],
  "src/styles/tokens.css": [],
};

/**
 * The token layer.
 *
 * `src/styles/tokens.css` says in its own header that nothing consumes the --phx- system yet. FOR
 * THE RADIUS GROUP THAT IS NO LONGER TRUE, and it is the reason a session copying a sibling
 * component inherits a corner silently: app/globals.css maps these straight into Tailwind's @theme,
 * so `--phx-radius: 4px` IS `rounded-lg`, app-wide. Inside the two shells the sweeps flatten the
 * result; everywhere else — the login page, an error page, a document — it renders.
 *
 * Retiring them or redefining them to 0 is an owner decision (the `pill` at 999px loudest of all),
 * so they are pinned, not changed. Pinning them also means a silent re-point of the @theme mapping
 * — which would move every `rounded-*` utility in the app at once — cannot pass unnoticed.
 */
const RADIUS_TOKEN_INVENTORY: Record<string, string[]> = {
  "src/styles/tokens.css": [
    "--phx-radius-xs: 2px",
    "--phx-radius-sm: 3px",
    "--phx-radius: 4px",
    "--phx-radius-lg: 6px",
    "--phx-radius-xl: 10px",
    "--phx-radius-pill: 999px",
  ],
  "app/globals.css": [
    "--radius: var(--phx-radius)",
    "--radius-sm: var(--phx-radius-xs)",
    "--radius-md: var(--phx-radius-sm)",
    "--radius-lg: var(--phx-radius)",
    "--radius-xl: var(--phx-radius-lg)",
    "--radius-2xl: var(--phx-radius-xl)",
    "--radius-3xl: 14px",
    "--radius-4xl: 18px",
  ],
};

/**
 * Everything else that still rounds, by file, with a count.
 *
 * A file absent from this map must have ZERO non-square rounding — that is the half of the gate
 * that catches a brand-new breach, on the first one, in a file nobody has looked at.
 *
 * Every entry here is either owned by another branch or waiting on the owner. None is an accident.
 */
const REMAINING_ROUNDING: Record<string, number> = {
  // LEGAL, AND DELIBERATELY NOT ZERO. The survivor here is
  // `.payroll-dashboard-surface .rounded-xl.border.bg-card { border-radius: 20px }`. The element
  // necessarily carries `rounded-xl`, so RULE 1's `!important` out-ranks it and the corner computes
  // 0px on the live page — measured in a browser by PR #3209, which squared this file's OTHER
  // radius (`.phoenix-glow-bar`, at `18px 18px 6px 6px`, on a bar with no `rounded-*` hook at all
  // and therefore unreachable by RULE 1). Pinning mere absence would have forced this dead
  // declaration out on a false pretext, so it stays and is counted.
  "src/components/payroll/payroll-dashboard.tsx": 1,
  //
  // The payslip route USED to sit here at 11 corners, held for PR #3200. That PR merged on
  // 2026-09-05 and settled them: the stylesheet moved to `src/lib/payroll/payslip-document.ts`,
  // an 18px page, 14px cards and a 999px status pill went, and the document now opens with
  // `*, *::before, *::after { border-radius: 0 !important; }` so it cannot inherit a corner from
  // whatever stylesheet renders it. Both files are therefore absent from this map, which is the
  // correct state — and it is the strongest answer to the token problem in the row below: a
  // generated document that resets rounding at its own root does not care what tokens.css ships.

  // WITH THE OWNER — the two stylesheet sites above, counted again by the tree walk.
  "app/globals.css": 2,

  // WITH THE OWNER — email. A mail client is a different medium from the app and from a printed
  // company document, and rounded corners are ordinary there. 11 + 1 + 4 sites.
  "src/emails/phoenix-email-layout.tsx": 11,
  "src/emails/telegram-connect.tsx": 1,
  "templates/phoenix-google-style-email.html": 4,

  // WITH THE OWNER — a standalone static guide served at /marketing-guide.html, referenced from
  // nowhere in the codebase and outside both shells.
  "public/marketing-guide.html": 37,

  // WITH THE OWNER — the signature card. Two are the employee portrait's own corners and one is a
  // 5px decorative dot at 50%. The identity card that mounts this component is a PROTECTED file.
  "src/components/phoenix-signature-card/EmployeePortrait.tsx": 2,
  "src/components/phoenix-signature-card/PhoenixSignatureCard.tsx": 1,

  // WITH THE OWNER — `.lede-mark` is a 34px circular mark on the offer letter. Note the print
  // stylesheet in the same file already sets it to 0, so the paper is square and only the screen
  // preview is round.
  "src/lib/offers/render.ts": 1,
};

const SCANNED_ROOTS = ["app", "src", "templates", "public"];

/**
 * Tailwind rounding on the surfaces NO sweep covers.
 *
 * THIS SECTION EXISTS BECAUSE THE REST OF THIS FILE MISSED A LIVE CORNER. Everything above hunts
 * hand-written declarations, on the reasoning that Tailwind's `rounded-*` utilities are handled by
 * the two shell sweeps. That reasoning has a hole exactly the size of the second blind spot: a file
 * rendered OUTSIDE both shells gets no sweep, so its `rounded-*` classes render as written.
 *
 * The login page shipped squared on 2026-09-05 with `sm:rounded-2xl` still on its three feature
 * tiles, and it reached production. Two things hid it. The VARIANT PREFIX sits before the word —
 * a census keyed on `rounded[...]` finds the token but reads it as a bare `rounded-2xl`, so it
 * looks like one of the ones already dealt with. And inside a shell that class IS handled, because
 * `[class*="rounded"]` matches the attribute by substring, which makes the utility look safe
 * everywhere.
 *
 * So these files are pinned by their full class token, prefix included. Anything but the listed
 * classes fails.
 */
const UNSWEPT_SURFACE_ROUNDING: Record<string, string[]> = {
  // The sign-in screen. Its card, inputs, checkbox, error callout and both buttons were squared;
  // what is left is a glowing dot and the two button spinners, all three with the owner. A spinner
  // has to be a circle to read as spinning.
  "src/components/auth/premium-login-page.tsx": ["rounded-full", "rounded-full", "rounded-full"],
  "app/login/page.tsx": [],
  // Renders its own <html>, so app/globals.css never loads here at all — not the sweeps, not the
  // tokens, nothing. Its one corner was a hand-written borderRadius, already squared.
  "app/global-error.tsx": [],
};

// ── The test ───────────────────────────────────────────────────────────────────────────────────

export function runSquareEdgeGoldenRuleTests() {
  // ── 1. The emitted stylesheets, never the source file ────────────────────────────────────────
  //
  // These two constants are the artifacts the browser receives. Reading the .ts file back as text
  // would prove nothing about what is emitted — that mistake has shipped three defects in this
  // repo, including a `\/` that survived the file and died in the browser.
  {
    assert.ok(
      EDITOR_CSS.includes("[data-hp-live] {"),
      "EDITOR_CSS must actually carry the editor rules — an empty constant would pass vacuously",
    );
    assert.deepEqual(
      roundingIn(EDITOR_CSS),
      [],
      "the paper editor may not round any affordance it draws on a company paper (PR #3203)",
    );

    assert.ok(
      PRINT_BANNER_CSS.includes(".print-banner__action"),
      "PRINT_BANNER_CSS must carry the action button — an empty constant would pass vacuously",
    );
    assert.deepEqual(
      roundingIn(PRINT_BANNER_CSS),
      [],
      "the print banner sits above all twelve hiring papers, so a radius here is twelve breaches (PR #3195)",
    );
  }

  // ── 2. The two sweeps still exist ────────────────────────────────────────────────────────────
  //
  // Everything downstream assumes they run. If either is deleted or renamed, thousands of
  // `rounded-*` utilities light up at once and nothing else in this file would notice, because the
  // inventory below counts hand-written declarations rather than Tailwind classes.
  {
    const globals = readFileSync("app/globals.css", "utf8");
    for (const shell of ["admin-shell", "employee-portal-shell"]) {
      assert.match(
        globals,
        new RegExp(`\\.${shell} \\[class\\*="rounded"\\]\\s*\\{\\s*border-radius:\\s*0\\s*!important;`),
        `the ${shell} square-edge sweep is missing — every rounded-* utility inside it would render round`,
      );
    }
  }

  // ── 3. The shipped stylesheets, site by site ─────────────────────────────────────────────────
  for (const [file, expected] of Object.entries(STYLESHEET_INVENTORY)) {
    const css = readFileSync(file, "utf8");
    assert.ok(css.length > 200, `${file} is empty or unreadable — the scan below would pass vacuously`);
    assert.deepEqual(
      stylesheetSites(css),
      expected,
      `${file}: a rounding site changed. Square it, or add it here with the reason it stays.`,
    );
  }

  // ── 4. The token layer ───────────────────────────────────────────────────────────────────────
  for (const [file, expected] of Object.entries(RADIUS_TOKEN_INVENTORY)) {
    assert.deepEqual(
      radiusTokens(readFileSync(file, "utf8")),
      expected,
      `${file}: a radius token moved. These feed Tailwind's rounded-* utilities app-wide.`,
    );
  }

  // ── 5. The whole-tree inventory ──────────────────────────────────────────────────────────────
  {
    const files = SCANNED_ROOTS.flatMap((root) => walk(root));
    assert.ok(
      files.length > 2_000,
      `expected the whole app and src tree, found only ${files.length} files — the scan would pass vacuously`,
    );

    const measured: Record<string, number> = {};
    for (const file of files) {
      const key = relative(".", file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      const sites = key.endsWith(".css") ? stylesheetSites(text) : sourceSites(text);
      if (sites.length > 0) measured[key] = sites.length;
    }

    assert.deepEqual(
      measured,
      REMAINING_ROUNDING,
      [
        "A hand-written corner appeared, moved, or was fixed without updating this inventory.",
        "Neither globals.css sweep can see any of these: they match a `rounded` CLASS, and they are",
        "scoped to two shells. If you added one, square it. If it must stay, add it above WITH THE",
        "REASON — and if the reason is a judgement call about house style, it is the owner's call.",
      ].join(" "),
    );
  }

  // ── 5b. Tailwind rounding where no sweep reaches ─────────────────────────────────────────────
  for (const [file, expected] of Object.entries(UNSWEPT_SURFACE_ROUNDING)) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.length > 200, `${file} is empty or unreadable — the scan below would pass vacuously`);
    assert.deepEqual(
      tailwindRounding(source),
      expected,
      `${file} renders outside .admin-shell and .employee-portal-shell, so a rounded-* class here is `
        + "a real corner on a real page. Square it, or list it above with the reason it stays.",
    );
  }

  // ── 6. The controls — the instrument must still be able to see a corner ──────────────────────
  //
  // Without these, a regex that silently stopped matching would report a clean sweep forever. That
  // is not hypothetical: `git grep -o` on this machine returns ZERO matches on a file `rg` finds
  // nine in, so "0 hits" here would have read as "the code is clean".
  {
    // 6a. A rounded corner injected into the emitted editor stylesheet must be seen — exactly one.
    assert.equal(
      roundingIn(EDITOR_CSS.replace("outline-offset: 2px;", "outline-offset: 2px;\n    border-radius: 2px;")).length,
      1,
      "the stylesheet sweep can no longer see a rounded corner — it certifies nothing",
    );

    // 6b. A new rule in a stylesheet must show up as a new SITE, keyed by its selector.
    const globals = readFileSync("app/globals.css", "utf8");
    const withBreach = `${globals}\n.square-edge-control { border-radius: 6px; }\n`;
    const extra = stylesheetSites(withBreach).filter((site) => site.startsWith(".square-edge-control |"));
    assert.deepEqual(
      extra,
      [".square-edge-control | border-radius: 6px"],
      "the stylesheet site scan must attribute a new corner to its own selector",
    );

    // 6c. Each of the three source forms must be seen, and a square one must NOT be.
    assert.deepEqual(
      sourceSites('const css = `.card { border-radius: 4px; }`;'),
      ["border-radius: 4px"],
      "a hand-written border-radius inside a CSS string must be seen",
    );
    assert.deepEqual(
      sourceSites('<div style={{ borderRadius: "0.375rem" }} />'),
      ['borderRadius: "0.375rem"'],
      "a React inline borderRadius must be seen — this is exactly what app/global-error.tsx carried",
    );
    assert.deepEqual(
      sourceSites('import { Bar } from "recharts";\n<Bar radius={[8, 8, 0, 0]} />'),
      ["radius={[8, 8, 0, 0]}"],
      "a rounded Recharts bar must be seen — border-radius does not apply to SVG, so no CSS sweep can",
    );
    assert.deepEqual(
      sourceSites('<Bar radius={[0, 0, 0, 0]} />\n<div style={{ borderRadius: 0 }} />\n.x { border-radius: 0 }'),
      [],
      "a square value must not be reported as rounding",
    );

    // 6e. The variant prefix must survive the read. This is the control for the corner that
    // actually reached production: reported as a bare `rounded-2xl` it reads as one of the classes
    // already squared, and the miss is invisible.
    assert.deepEqual(
      tailwindRounding('<span className="flex h-[52px] w-[52px] sm:h-[62px] sm:rounded-2xl" />'),
      ["sm:rounded-2xl"],
      "a responsive variant must be reported WITH its prefix, not as a bare rounded-2xl",
    );
    assert.deepEqual(
      tailwindRounding('<div className="rounded-full animate-spin" /><div className="hover:rounded-lg" />'),
      ["rounded-full", "hover:rounded-lg"],
      "every rounding utility on an unswept surface must be seen, prefixed or not",
    );

    // 6d. THE NEGATIVE CONTROL. A distance called `radius` is not a corner. Four real files in this
    // repo carry one, and counting them would pin those files at a non-zero number — which would
    // then absorb a real corner appearing in them later without moving the count.
    assert.deepEqual(
      sourceSites(
        [
          "const params = new URLSearchParams({ radius: String(radiusKm) });",
          "radius: Math.min(50_000, Math.max(1, options.radiusMeters)),",
          "function polarToCartesian(cx: number, cy: number, radius: number, angle: number) {}",
          "<Circle radius={500} />",
        ].join("\n"),
      ),
      [],
      "a search radius in metres, a geometry parameter and a map circle are distances, not corners",
    );
  }
}
