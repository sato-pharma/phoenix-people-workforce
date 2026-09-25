import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The Territory Drilldown desktop tree — District Manager, Regional Manager and National Sales
 * Manager alike — pinned against the owner's FITS-THE-SCREEN golden rule (AGENTS.md §4): never a
 * horizontal scroll, always mobile AND desktop friendly, and `overflow-x-auto` over a `min-width`
 * floor IS the bug rather than the fix.
 *
 * The Medical Rep's own branch (AreaRoot, and the rootLevel === "area" wrapper around it) was
 * fixed the same way first; the manager branches — RegionRoot, RegionsRoot and their spine cards,
 * AreaLane, BlockLane — carried the same `overflow-x-auto` / `min-w-[…]` shape until this file's
 * own fix. Pinned across the WHOLE file, not just the manager branches, so neither side can drift
 * back on its own.
 */

const TREE = "src/components/sales/territory/territory-tree-desktop.tsx";

export function runTerritoryTreeDesktopFitsTheScreenTests() {
  const source = readFileSync(TREE, "utf8");

  // Every class this file actually APPLIES. Scoped deliberately: several comments in this file
  // explain, in prose, why `overflow-x-auto` and a bracketed `min-w-[…]` are gone — a plain
  // substring search over the source would read that prose as the defect it is warning against.
  const classValues = [
    ...[...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1]),
    ...[...source.matchAll(/className=\{`([^`]*)`\}/g)].map((m) => m[1]),
    ...[...source.matchAll(/className=\{cn\(\s*"([^"]*)"/g)].map((m) => m[1]),
  ];
  const classTokens = new Set(classValues.flatMap((value) => value.split(/\s+/)).filter(Boolean));

  // 1. Nothing in this file may scroll sideways — Medical Rep or manager branch alike.
  assert.ok(
    !classTokens.has("overflow-x-auto"),
    `${TREE}: "overflow-x-auto" is present. The golden rule names that class over a min-width ` +
      `floor as the bug itself — a scrolling wrapper absorbs the overflow, so a page-level ` +
      `scrollWidth check reads clean while the tree hangs off the side. Let lanes stack or wrap.`,
  );

  // 2. ...and nothing may set a min-width floor. `min-w-0` is the opposite thing and stays; only a
  //    bracketed floor is the defect — it is exactly what forced the scroll in the first place.
  const minWidths = [...classTokens].filter((token) => token.startsWith("min-w-[")).sort();
  assert.deepEqual(
    minWidths,
    [],
    `${TREE}: found min-width floors ${JSON.stringify(minWidths)}. A fixed floor on a block/area ` +
      `lane or a chart-root spine card is exactly how the sideways scroll came back; let the card ` +
      `size to its parent ("w-full max-w-md" on a spine card, no width class on a lane).`,
  );

  // 3. Names wrap, they are never cut with an ellipsis (AGENTS.md §4) — the block code line used to
  //    truncate, which is the same defect in miniature: the manager tree's block card also hung a
  //    fixed-width name off the side rather than fitting it.
  for (const banned of ["truncate", "text-ellipsis"]) {
    assert.ok(
      !classTokens.has(banned),
      `${TREE}: "${banned}" is present. Block/area/region names wrap, they are never cut.`,
    );
  }
}
