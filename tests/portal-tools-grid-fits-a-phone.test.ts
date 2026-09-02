import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A grid of PremiumNavTiles must be SINGLE-COLUMN on a phone. Two columns cannot hold one.
 *
 * Measured 2026-09-02 on /employee-portals, signed in as a Medical Rep. The "My Tools" grid was
 * `grid-cols-2` at every width, while the "My Workspace" grid six lines below — holding the same
 * component — was already `grid-cols-1 sm:grid-cols-2`. Only the first one was wrong.
 *
 * A tile's min-content floor measured 172px:
 *
 *   3px rail + 24px padding + 32px icon + 12px gap + 73px label + 12px gap + 16px arrow
 *
 * where 73px is "Dashboard", the widest single word across every label the tile is given
 * ("Sales Dashboard" wraps to two lines, but a word cannot break, so the WORD sets the floor).
 * Two columns give a 146px column at 320px and 166px at 360px. Grid items are `min-width: auto`,
 * so the tile refused to shrink to its column and bled out of it — by 26px at 320 and 6px at 360.
 *
 * It hid from the usual check twice over. The card's own `overflow-hidden` CLIPPED the bleed, so
 * it never reached `scrollWidth`: `main` measured a clean 375/375 and 320/320 throughout. And at
 * 360px the bleed stayed inside the viewport, so even a viewport-edge sweep called it clean —
 * only comparing each tile against its GRID column finds it.
 *
 * The remedy is the one the owner's fits-the-screen golden rule names first: MERGE the columns.
 * The type is untouched. Explicitly not an ellipsis, not `overflow-x-auto` over a min-width floor
 * (the rule calls that the bug, not the fix), and not `break-words` on the label — breaking
 * "Dashboard" mid-word to save a column is worse than giving it the row.
 *
 * Pinned by SHAPE rather than a byte window, and comments are stripped before reading: the prose
 * above and the component's own comment both spell `grid-cols-2`, and a test that matched its own
 * explanation would pin the anti-pattern (AGENTS.md §2.1).
 */

const CENTER = "src/components/employee-portal/portal-command-center.tsx";

/** Drop block comments (JSX `{/* … *\/}` included) and whole-line `//` comments. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const tokensOf = (classAttr: string) => new Set(classAttr.split(/\s+/).filter(Boolean));

export function runPortalToolsGridFitsAPhoneTests() {
  const lines = stripComments(readFileSync(CENTER, "utf8")).split("\n");

  assert.ok(
    lines.some((line) => line.includes("export function PremiumNavTile")),
    `${CENTER}: PremiumNavTile is gone — this test pins a component that no longer exists.`,
  );

  // Every grid that directly holds tiles: from each tile, walk back to its nearest grid container.
  const gridsByLine = new Map<number, string>();
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes("<PremiumNavTile")) continue;
    let found = -1;
    for (let j = i; j >= 0 && j > i - 40; j -= 1) {
      const match = lines[j].match(/className="(grid [^"]*)"/);
      if (match) {
        found = j;
        gridsByLine.set(j, match[1]);
        break;
      }
    }
    assert.notEqual(
      found,
      -1,
      `${CENTER}:${i + 1}: this <PremiumNavTile> has no grid container within 40 lines above it. ` +
        `If the tiles moved into a different layout, re-point this test at it — do not delete it.`,
    );
  }

  // Vacuity guards: this test is worthless if the file stopped matching what it reads.
  const tileCount = lines.filter((line) => line.includes("<PremiumNavTile")).length;
  assert.ok(
    tileCount >= 6,
    `${CENTER}: only ${tileCount} <PremiumNavTile> usages found (expected at least 6). The test ` +
      `would pass vacuously — re-point it rather than lowering this floor.`,
  );
  assert.ok(
    gridsByLine.size >= 2,
    `${CENTER}: found ${gridsByLine.size} tile grid(s), expected at least 2 ("My Tools" and ` +
      `"My Workspace"). One of them has stopped matching, so its column count is going unchecked.`,
  );

  for (const [line, classAttr] of gridsByLine) {
    const tokens = tokensOf(classAttr);
    const where = `${CENTER}:${line + 1}: "${classAttr}"`;

    assert.ok(
      tokens.has("grid-cols-1"),
      `${where} — a PremiumNavTile grid must start at "grid-cols-1". The tile's min-content floor ` +
        `is 172px and two columns give only 146px at 320px and 166px at 360px, so the tile bleeds ` +
        `out of its own column. The card's overflow-hidden then clips it, which is why the page ` +
        `still measures a clean 375/375 while a rep sees a cut-off tile.`,
    );

    assert.ok(
      !tokens.has("grid-cols-2"),
      `${where} — carries an unprefixed "grid-cols-2", so it is two columns on a 320px phone too. ` +
        `Two columns are only safe from "sm:" up. Write "grid-cols-1 … sm:grid-cols-2".`,
    );

    assert.ok(
      tokens.has("sm:grid-cols-2"),
      `${where} — missing "sm:grid-cols-2". Single-column is right on a phone, but the tiles should ` +
        `still pair up from the "sm" breakpoint, which is what the "My Workspace" grid has always done.`,
    );
  }

  // The remedies the golden rule forbids, scoped to the tile itself — the rest of this file holds
  // other components (KeycardGrid legitimately truncates), so a file-wide ban would be wrong.
  const start = lines.findIndex((line) => line.includes("export function PremiumNavTile"));
  const after = lines.findIndex((line, i) => i > start && line.startsWith("export function "));
  const tile = lines.slice(start, after === -1 ? lines.length : after).join("\n");
  const tileTokens = new Set(
    [...tile.matchAll(/className="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)),
  );
  const applied = (utility: string) =>
    [...tileTokens].some((token) => token === utility || token.endsWith(`:${utility}`));

  for (const banned of ["truncate", "text-ellipsis", "overflow-x-auto", "whitespace-nowrap"]) {
    assert.ok(
      !applied(banned),
      `${CENTER}: PremiumNavTile applies "${banned}". The golden rule (AGENTS.md §4) bans the ` +
        `ellipsis outright and calls overflow-x-auto over a min-width floor the bug rather than the ` +
        `fix. If a tile stops fitting, merge its columns — that is what this test exists to hold.`,
    );
  }

  // The label wrapper must stay shrinkable, or the tile's floor climbs back past its column.
  assert.ok(
    /className="min-w-0 flex-1"/.test(tile),
    `${CENTER}: PremiumNavTile's label wrapper is no longer "min-w-0 flex-1". Without min-w-0 the ` +
      `label cannot shrink at all and the tile overflows even a single column.`,
  );
}
