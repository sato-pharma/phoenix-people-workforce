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
 *   4. portal-command-center.tsx — QuickActions. Not a clip: a fixed `grid-cols-2` gave every
 *      action 172px at 375px, so "Review Marketing Requests" wrapped three lines deep, one word
 *      per line. Re-shaped so a label wider than half the row claims the whole row, while short
 *      labels stay two-up. Added 2026-09-05 at the owner's request after the first three shipped.
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

  // ── 4. QuickActions: a long label takes the whole row ──────────────────────────────────────
  const actionsStart = command.indexOf("export function QuickActions");
  assert.notEqual(
    actionsStart,
    -1,
    `${COMMAND}: QuickActions is gone — this test is pinning a component that no longer exists.`,
  );
  const actions = command.slice(actionsStart, actionsStart + 1600);

  const row = actions.match(/<div className="([^"]*)">/);
  assert.ok(row, `${COMMAND}: QuickActions no longer opens with a literal className.`);
  const rowTokens = tokens(row[1]);
  const fixedCols = rowTokens.filter((token) => /(^|:)grid-cols-/.test(token));
  assert.deepEqual(
    fixedCols,
    [],
    `${COMMAND}: QuickActions carries fixed column classes ${JSON.stringify(fixedCols)}. A fixed ` +
      `two-column grid gives every action the same 172px at 375px, and "Review Marketing ` +
      `Requests" — the longest action label in the repo — then breaks over THREE lines, one word ` +
      `per line. The row has to size to its content instead.`,
  );

  const item = actions.match(/className="(flex min-h-\[48px\][^"]*)"/);
  assert.ok(item, `${COMMAND}: the QuickActions item no longer opens "flex min-h-[48px] …".`);
  const itemTokens = tokens(item[1]);
  for (const required of ["min-w-fit", "grow", "basis-[calc(50%-0.25rem)]"]) {
    assert.ok(
      itemTokens.includes(required),
      `${COMMAND}: the QuickActions item is "${item[1]}" — missing "${required}". The three work ` +
        `together and none is decorative: "basis-[calc(50%-0.25rem)]" puts two per row allowing ` +
        `for gap-2, "min-w-fit" lets a label wider than half the row push its own item past that ` +
        `basis so it can no longer share a row, and "grow" then fills the row it lands on alone. ` +
        `Drop any one and a long label either wraps three deep again or leaves a ragged half-row.`,
    );
  }
  for (const required of ["sm:grow-0", "sm:basis-auto"]) {
    assert.ok(
      itemTokens.includes(required),
      `${COMMAND}: the QuickActions item is "${item[1]}" — missing "${required}". Above sm these ` +
        `actions are compact content-width pills, measured pixel-identical to the pre-fix markup ` +
        `at 1280px; without this the mobile 50% basis would leak into the desktop row.`,
    );
  }
}
