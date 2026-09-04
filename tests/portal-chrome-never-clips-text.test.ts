import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Three places in the portal chrome that CLIPPED text rather than wrapping it, and one that broke a
 * label one word per line. Found 2026-09-05 by a width-ladder sweep (7 roles x 640/768/1024/1440 on
 * /employee-portals) run after the Stars of the Fortnight fix, to see whether that card was the only
 * instance of its bug class. It was not.
 *
 * All four hid from the usual check. `main` measured a clean 736/736, 795/795 and 608/608 the whole
 * time, because content clipped by an `overflow-hidden` ancestor contributes nothing to
 * `scrollWidth` — the blindness the owner's fits-the-screen golden rule names by hand (AGENTS.md §4).
 * The only visible symptom was a word ending mid-letter, with NO ellipsis to say anything was gone.
 *
 *   1. employee-portal-layout.tsx — the header role label. `flex-1` is `flex: 1 1 0%`, so the
 *      identity block's basis is ZERO; at 768px it was squeezed to 80px while the search input kept
 *      its full 384px. Every one of the seven roles lost 8-41px: "Medical Representative" read
 *      "Medical Represent". Fixed by `md:flex-none` (content width) plus dropping the nowrap.
 *   2. marketing-manager-command-center.tsx — the intel tile label and description, pinned with
 *      `whitespace-nowrap` inside an `overflow-hidden` card. At 1024px "Distributor sell-in by line,
 *      region, product" lost 20px and read "…region, produc".
 *   3. portal-command-center.tsx — GlanceStrip went to three columns at `sm:` (a 640px WINDOW) while
 *      `main` was 608px, leaving the label 75px: "plans awaiting approval", one word per line, three
 *      lines deep. Re-keyed to the strip's OWN width with a container query.
 *
 * Pinned by SHAPE, not by a byte window. Comments are stripped first: the prose above and each
 * component's own header comment name the banned utilities, and a pinning test that matched its own
 * explanation would pin the anti-pattern (AGENTS.md §2.1).
 */

const LAYOUT = "src/components/employee-portal/employee-portal-layout.tsx";
const MM = "src/components/employee-portal/dashboards/marketing-manager-command-center.tsx";
const COMMAND = "src/components/employee-portal/portal-command-center.tsx";

/**
 * Drop block comments and whole-line `//` comments; a JSX comment collapses to a harmless `{}`.
 * Deliberately NOT a brace-aware rule: one written as an opening brace, newline, then a block
 * comment also matches a FUNCTION BODY brace, and the lazy quantifier then swallows everything
 * up to the next comment close — which ate a whole component here and made the GlanceStrip
 * assertion below read the wrong element entirely.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

export function runPortalChromeNeverClipsTextTests() {
  // ── 1. the header role label ───────────────────────────────────────────────────────────────
  const layout = stripComments(readFileSync(LAYOUT, "utf8"));

  const label = layout.match(/<p className="([^"]*)">\{data\.employee\.roleLabel\}<\/p>/);
  assert.ok(
    label,
    `${LAYOUT}: the header no longer renders {data.employee.roleLabel} in a <p> with a literal ` +
      `className. Re-point this test at whatever prints the role in the header — do not drop it.`,
  );
  assert.ok(
    !tokens(label[1]).includes("whitespace-nowrap"),
    `${LAYOUT}: the header role label is "${label[1]}" — "whitespace-nowrap" is back. The header ` +
      `bar clips, so a pinned label is CUT, not scrolled, and no ellipsis appears to say so. It has ` +
      `to be able to wrap; "leading-tight" is what keeps two lines inside the 56px bar.`,
  );

  const identity = layout.match(/<div className="(flex min-w-0 flex-1 items-center[^"]*)">/);
  assert.ok(
    identity,
    `${LAYOUT}: the header identity block is no longer "flex min-w-0 flex-1 items-center …".`,
  );
  assert.ok(
    tokens(identity[1]).includes("md:flex-none"),
    `${LAYOUT}: the identity block is "${identity[1]}" — missing "md:flex-none". The search input ` +
      `appears at md and takes 384px; with only "flex-1" (basis 0%) this block collapses to 80px ` +
      `and the role label is cut mid-word. It must take its content width from md up, and the ` +
      `input — which can spare 41px — absorbs the difference.`,
  );

  // ── 2. the Marketing Manager intel tiles ───────────────────────────────────────────────────
  const mm = stripComments(readFileSync(MM, "utf8"));
  for (const [what, pattern] of [
    ["label", /<p className="([^"]*)">\{tile\.label\}<\/p>/],
    ["description", /<p className="([^"]*)">\{tile\.description\}<\/p>/],
  ] as const) {
    const match = mm.match(pattern);
    assert.ok(
      match,
      `${MM}: the intel tile ${what} is no longer a <p> with a literal className rendering ` +
        `{tile.${what}}. Re-point this test rather than letting the check pass vacuously.`,
    );
    assert.ok(
      !tokens(match[1]).includes("whitespace-nowrap"),
      `${MM}: the tile ${what} is "${match[1]}" — "whitespace-nowrap" is back. This card is ` +
        `overflow-hidden, so the line is clipped rather than scrolled: at 1024px the description ` +
        `lost its last 20px and read "…region, produc". Wrap instead.`,
    );
  }

  // ── 3. GlanceStrip's column count ──────────────────────────────────────────────────────────
  const command = stripComments(readFileSync(COMMAND, "utf8"));
  const stripStart = command.indexOf("export function GlanceStrip");
  assert.notEqual(
    stripStart,
    -1,
    `${COMMAND}: GlanceStrip is gone — this test is pinning a component that no longer exists.`,
  );
  const strip = command.slice(stripStart, stripStart + 1200);
  const grid = strip.match(/<div className="([^"]*grid[^"]*)"/);
  assert.ok(grid, `${COMMAND}: GlanceStrip no longer opens with a literal grid className.`);
  const gridTokens = tokens(grid[1]);
  assert.ok(
    gridTokens.includes("@container") && gridTokens.includes("@2xl:grid-cols-3"),
    `${COMMAND}: GlanceStrip's grid is "${grid[1]}" — it needs "@container" and "@2xl:grid-cols-3". ` +
      `Three columns must be keyed to the STRIP's own width: at a 640px window "sm:grid-cols-3" ` +
      `fired while main was 608px, leaving the label 75px and breaking "plans awaiting approval" ` +
      `one word per line.`,
  );
  const viewportCols = gridTokens.filter((token) => /^(sm|md|lg|xl|2xl):grid-cols-/.test(token));
  assert.deepEqual(
    viewportCols,
    [],
    `${COMMAND}: GlanceStrip carries viewport column breakpoints ${JSON.stringify(viewportCols)}. ` +
      `This strip is rendered inside command centers of very different widths — a window-sized ` +
      `query cannot see the one it is actually in.`,
  );
}
