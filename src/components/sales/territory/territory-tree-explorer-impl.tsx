"use client";

import type { TerritorySkeleton } from "@/lib/sales/territory/types";

import { TerritoryTreeDesktop } from "./territory-tree-desktop";
import { TerritoryTreeMobile } from "./territory-tree-mobile";
import { useTerritoryTree } from "./use-territory-tree";

/**
 * One shared fetch/expand hook instance driving two presentations, mounted simultaneously and
 * toggled purely by Tailwind's `md:` breakpoint (both always in the DOM — the same CSS-only
 * convention as PortalResponsiveDataList/PortalDesktopTable, not a JS viewport check). An area
 * expanded/loaded on one layout stays loaded if the viewport crosses the breakpoint, since both
 * renderers read from the same hook state.
 */
export function TerritoryTreeExplorer({ skeleton }: { skeleton: TerritorySkeleton }) {
  const tree = useTerritoryTree(skeleton);

  return (
    <>
      <div className="hidden md:block">
        <TerritoryTreeDesktop tree={tree} />
      </div>
      <div className="md:hidden">
        <TerritoryTreeMobile tree={tree} />
      </div>
    </>
  );
}
