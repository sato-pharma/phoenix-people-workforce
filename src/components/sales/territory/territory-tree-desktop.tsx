"use client";

import { ChevronRight, Loader2, MapPin } from "lucide-react";
import { useEffect, useState } from "react";

import { formatEgp } from "@/components/sales/target-visuals";
import { cn } from "@/lib/utils";
import { countOf, pharmacyCount, pharmacySheetsLine, structureLine } from "@/lib/sales/territory/drilldown-words";
import type {
  TerritoryAreaNode,
  TerritoryBlockNode,
  TerritoryBrickNode,
  TerritoryPharmacy,
  TerritoryRegionNode,
} from "@/lib/sales/territory/types";

import { PharmacyTrendSparkline } from "./pharmacy-trend-sparkline";
import { TerritoryClosingTotal } from "./territory-closing-total";
import { MonthChipLegend, MonthChipRow } from "./territory-month-chips";
import type { UseTerritoryTreeResult } from "./use-territory-tree";

// The look, one place: flat fills, square edges, no shadows and no gradients (the square-edge
// golden rule and the house's flat-colour rule). Dark slate heads the region, area and block
// tiers; orange marks a region lane. 11px (`text-phx-xs`) is the smallest type on the page.
const ROOT_CARD = "w-full max-w-md border border-slate-900 bg-slate-900 px-5 py-3.5 text-center text-white";
const ROOT_CARD_ORANGE = "w-full max-w-md border border-orange-300 bg-orange-50 px-5 py-3.5 text-center text-slate-900";
const LANE = "border border-slate-200 bg-white";
const DARK_HEAD = "flex w-full flex-col gap-1 bg-slate-900 px-3 py-2.5 text-left text-white";
const TIER_LABEL = "text-phx-xs font-bold uppercase tracking-[0.14em]";
const EMPTY = "border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-600";

/** A block by its name; the code only when the block has no description on file. */
function blockLabel(block: TerritoryBlockNode): string {
  return block.blockName || block.blockCode;
}

/** The trunk and branch bar under a root card — a square node, never a round dot. */
function Spine() {
  return (
    <>
      <div aria-hidden className="h-5 w-0.5 bg-orange-300" />
      <div aria-hidden className="relative h-0.5 w-[92%] max-w-3xl bg-orange-300">
        <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 bg-orange-500" />
      </div>
    </>
  );
}

function PharmacyCard({ pharmacy }: { pharmacy: TerritoryPharmacy }) {
  const [showTrend, setShowTrend] = useState(false);
  return (
    <li className="relative before:absolute before:-left-4 before:top-5 before:h-px before:w-4 before:bg-orange-200">
      <div className="border border-slate-200 bg-white px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 break-words text-phx-sm font-bold leading-tight text-slate-900">
            {pharmacy.clientName}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-phx-xs font-bold tabular-nums text-slate-700">
              {formatEgp(pharmacy.totalValue)}
            </span>
            <button
              aria-expanded={showTrend}
              className="border border-slate-300 px-2 py-1 text-phx-xs font-bold text-slate-700 transition hover:border-orange-400 hover:text-orange-700"
              onClick={() => setShowTrend((value) => !value)}
              type="button"
            >
              {showTrend ? "Hide trend" : "Trend"}
            </button>
          </div>
        </div>
        <MonthChipRow className="mt-1.5" pharmacy={pharmacy} />
        {showTrend ? (
          <div className="mt-2 border-t border-slate-100 pt-2">
            <PharmacyTrendSparkline months={pharmacy.months} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function BrickBranch({
  brick,
  pharmacies,
}: {
  brick: TerritoryBrickNode;
  pharmacies: TerritoryPharmacy[] | null;
}) {
  const [open, setOpen] = useState(false);
  const total = (pharmacies ?? []).reduce((sum, pharmacy) => sum + pharmacy.totalValue, 0);

  return (
    <li className="relative before:absolute before:-left-4 before:top-5 before:h-px before:w-4 before:bg-orange-200">
      <button
        aria-expanded={open}
        className="group relative flex w-full flex-col gap-1 overflow-hidden border border-slate-200 bg-white py-2.5 pl-4 pr-3 text-left transition hover:border-slate-400"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", open ? "bg-orange-500" : "bg-slate-300")} />
        {/* Line 1: the brick name gets the FULL row width, always — never squeezed by the
            stats, which move to their own line below. Wraps rather than truncates. The brick is
            named, never shown by its ID. */}
        <span className="flex items-center gap-2">
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform", open && "rotate-90 text-orange-600")} />
          <span className="min-w-0 flex-1 break-words text-phx-sm font-bold leading-snug text-slate-900">
            {brick.brickName}
          </span>
        </span>
        {pharmacies ? (
          <span className="break-words pl-[22px] text-phx-xs font-bold tabular-nums text-slate-600">
            {pharmacyCount(pharmacies.length)} · {formatEgp(total)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="ml-4 mt-2 border-l-2 border-orange-200 pl-4">
          {pharmacies && pharmacies.length > 0 ? <MonthChipLegend className="mb-2" /> : null}
          <ul className="space-y-2" role="group">
            {pharmacies === null ? (
              <li className="py-1 text-phx-xs font-semibold text-slate-600">Loading the pharmacies…</li>
            ) : pharmacies.length === 0 ? (
              <li className="py-1 text-phx-xs font-semibold text-slate-600">No pharmacy in this brick has a sale in your line yet.</li>
            ) : (
              pharmacies.map((pharmacy) => <PharmacyCard key={pharmacy.clientCode} pharmacy={pharmacy} />)
            )}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

function BlockLane({
  block,
  bricks,
  pharmaciesByBrick,
}: {
  block: TerritoryBlockNode;
  bricks: TerritoryBrickNode[];
  pharmaciesByBrick: Map<string, TerritoryPharmacy[]> | null;
}) {
  const [open, setOpen] = useState(true);

  // Highest-selling brick first — computed once pharmacy data has loaded; before that,
  // bricks stay in their skeleton order (nothing to rank yet).
  const brickStats = bricks.map((brick) => {
    const pharmacies = pharmaciesByBrick ? pharmaciesByBrick.get(brick.brickId) ?? [] : null;
    const total = (pharmacies ?? []).reduce((sum, pharmacy) => sum + pharmacy.totalValue, 0);
    return { brick, pharmacies, total };
  });
  const orderedBrickStats = pharmaciesByBrick
    ? [...brickStats].sort((a, b) => b.total - a.total)
    : brickStats;

  const blockPharmacyCount = pharmaciesByBrick
    ? brickStats.reduce((sum, stat) => sum + (stat.pharmacies?.length ?? 0), 0)
    : null;
  const blockTotal = pharmaciesByBrick ? brickStats.reduce((sum, stat) => sum + stat.total, 0) : null;

  return (
    <div className={LANE}>
      <button
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 bg-slate-900 px-3 py-2.5 text-left text-white"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronRight className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-300 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1">
          <span className={cn("block text-orange-300", TIER_LABEL)}>Block</span>
          <span className="block break-words text-phx-base font-bold leading-snug">{blockLabel(block)}</span>
        </span>
        <span className="shrink-0 text-right text-phx-xs font-bold tabular-nums text-slate-200">
          <span className="block">{structureLine({ bricks: bricks.length, pharmacies: blockPharmacyCount })}</span>
          {/* Nothing until the pharmacies arrive: a missing figure is never a dash or a zero. */}
          {blockTotal !== null ? <span className="block text-white">{formatEgp(blockTotal)}</span> : null}
        </span>
      </button>
      {open ? (
        <div className="px-3 py-3">
          <ul aria-label="Bricks, highest sales first" className="space-y-2" role="tree">
            {orderedBrickStats.map(({ brick, pharmacies }) => (
              <BrickBranch brick={brick} key={brick.brickId} pharmacies={pharmacies} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Groups bricks by block and renders the block-lane grid — the shared body used by both
 *  AreaRoot (Area is the chart root, Medical Rep) and AreaLane (Area is a lazy nested lane
 *  under a Region root, District Manager+). */
function AreaBody({
  blocks,
  bricks,
  pharmaciesByBrick,
}: {
  blocks: TerritoryBlockNode[];
  bricks: TerritoryBrickNode[];
  pharmaciesByBrick: Map<string, TerritoryPharmacy[]> | null;
}) {
  const blocksByCode = new Map<string, TerritoryBrickNode[]>();
  for (const brick of bricks) {
    if (!blocksByCode.has(brick.blockCode)) blocksByCode.set(brick.blockCode, []);
    blocksByCode.get(brick.blockCode)!.push(brick);
  }

  if (blocks.length === 0) {
    return <p className="text-sm font-semibold text-slate-600">No block is on file for this area yet.</p>;
  }

  // A vertical stack, not a multi-column grid: a CSS grid row's height is shared by every
  // item in that row, so one block with far more bricks than its row-mates (a real, common
  // case — a block can range from 1 brick to 30+) would silently stretch the whole row,
  // stranding the shorter block's card at the top of an oversized cell with a large dead gap
  // below it. Stacking removes any row to share.
  return (
    <div className="w-full space-y-3">
      {blocks.map((block) => (
        <BlockLane
          block={block}
          bricks={blocksByCode.get(block.blockCode) ?? []}
          key={block.blockCode}
          pharmaciesByBrick={pharmaciesByBrick}
        />
      ))}
    </div>
  );
}

/** One Medical Rep's locked area, rendered as the chart root — spine card + trunk + branch bar,
 *  fanning out into block lanes. Auto-loads its own pharmacy data on mount (there's only ever
 *  one or a small handful of these, unlike an Area lane under a Region/Nationwide root, which
 *  loads lazily on click instead — see AreaLane below). */
function AreaRoot({
  area,
  blocks,
  bricks,
  tree,
}: {
  area: TerritoryAreaNode;
  blocks: TerritoryBlockNode[];
  bricks: TerritoryBrickNode[];
  tree: UseTerritoryTreeResult;
}) {
  useEffect(() => {
    tree.loadArea(area.areaCode);
  }, [area.areaCode, tree]);

  const state = tree.areaState(area.areaCode);
  const pharmaciesByBrick =
    state.status === "loaded"
      ? new Map(state.payload.bricks.map((brick) => [brick.brickId, brick.pharmacies]))
      : null;
  const pharmacyTotal =
    state.status === "loaded"
      ? state.payload.bricks.reduce((sum, brick) => sum + brick.pharmacies.length, 0)
      : null;

  return (
    <div className="flex flex-col items-center">
      <div className={ROOT_CARD}>
        <div className={cn("flex items-center justify-center gap-1.5 text-orange-300", TIER_LABEL)}>
          <MapPin aria-hidden className="h-3.5 w-3.5" />
          Your area
        </div>
        <p className="mt-1 break-words text-sm font-bold leading-snug">{area.areaName}</p>
        <div aria-live="polite" className="mt-1 space-y-0.5 text-phx-xs font-semibold text-slate-200">
          {state.status === "loading" ? (
            <p className="inline-flex items-center gap-1">
              <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> Loading your territory…
            </p>
          ) : state.status === "error" ? (
            <p className="text-rose-200">{state.message}</p>
          ) : state.status === "loaded" ? (
            <>
              <p>{structureLine({ blocks: blocks.length, pharmacies: pharmacyTotal })}</p>
              <p className="tabular-nums">{pharmacySheetsLine(formatEgp(state.payload.totalValue), state.payload.reconciled)}</p>
            </>
          ) : null}
        </div>
        <TerritoryClosingTotal
          className="mt-1 block text-phx-xs font-bold tabular-nums text-white"
          code={area.areaCode}
          kind="area"
          tree={tree}
        />
      </div>
      <Spine />

      <div className="mt-6 w-full">
        <AreaBody blocks={blocks} bricks={bricks} pharmaciesByBrick={pharmaciesByBrick} />
      </div>
    </div>
  );
}

/** An Area as a collapsible lane — used whenever Area is NOT the chart root (a District
 *  Manager's region root today; Regional Manager/National Sales Manager next). Unlike AreaRoot,
 *  this never eager-loads: a region can hold many areas, and fetching all of them upfront would
 *  defeat lazy-loading per level, so the pharmacy data only fetches the first time this lane is
 *  expanded. */
function AreaLane({
  area,
  blocks,
  bricks,
  tree,
}: {
  area: TerritoryAreaNode;
  blocks: TerritoryBlockNode[];
  bricks: TerritoryBrickNode[];
  tree: UseTerritoryTreeResult;
}) {
  const [open, setOpen] = useState(false);
  const state = tree.areaState(area.areaCode);
  const pharmaciesByBrick =
    state.status === "loaded"
      ? new Map(state.payload.bricks.map((brick) => [brick.brickId, brick.pharmacies]))
      : null;
  const pharmacyTotal =
    state.status === "loaded"
      ? state.payload.bricks.reduce((sum, brick) => sum + brick.pharmacies.length, 0)
      : null;

  const handleToggle = () => {
    setOpen((value) => {
      const next = !value;
      if (next) tree.loadArea(area.areaCode);
      return next;
    });
  };

  return (
    <div className={LANE}>
      <button aria-expanded={open} className={DARK_HEAD} onClick={handleToggle} type="button">
        <span className="flex items-center gap-2">
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-orange-300 transition-transform", open && "rotate-90")} />
          <span className={cn("text-orange-300", TIER_LABEL)}>Area</span>
        </span>
        <span className="break-words pl-[22px] text-phx-base font-bold leading-snug">{area.areaName}</span>
        <span className="pl-[22px] text-phx-xs font-bold tabular-nums text-slate-200">
          {structureLine({ blocks: blocks.length, pharmacies: pharmacyTotal })}
        </span>
        {state.status === "loaded" ? (
          <span className="pl-[22px] text-phx-xs font-semibold tabular-nums text-slate-200">
            {pharmacySheetsLine(formatEgp(state.payload.totalValue), state.payload.reconciled)}
          </span>
        ) : null}
        <TerritoryClosingTotal
          className="pl-[22px] text-phx-xs font-bold tabular-nums text-white"
          code={area.areaCode}
          kind="area"
          tree={tree}
        />
      </button>
      {open ? (
        <div className="px-3 py-3">
          {state.status === "loading" ? (
            <p className="flex items-center gap-1 text-phx-xs font-semibold text-slate-600">
              <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> Loading this area…
            </p>
          ) : state.status === "error" ? (
            <p className="text-phx-xs font-semibold text-rose-700" role="alert">{state.message}</p>
          ) : (
            <AreaBody blocks={blocks} bricks={bricks} pharmaciesByBrick={pharmaciesByBrick} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** One District Manager's region (or, later, one of a Regional Manager's regions), rendered as
 *  the chart root one tier above AreaRoot. Never eager-loads anything itself — a region can
 *  hold many areas, so each fans out below as its own lazy AreaLane instead, and the region
 *  card only ever shows structural counts already known from the skeleton (no sales total is
 *  fetched at this tier — see AreaLane for where the real numbers come from). */
function RegionRoot({
  region,
  areas,
  blocks,
  bricks,
  tree,
}: {
  region: TerritoryRegionNode;
  areas: TerritoryAreaNode[];
  blocks: TerritoryBlockNode[];
  bricks: TerritoryBrickNode[];
  tree: UseTerritoryTreeResult;
}) {
  return (
    <div className="flex flex-col items-center">
      <div className={ROOT_CARD}>
        <div className={cn("flex items-center justify-center gap-1.5 text-orange-300", TIER_LABEL)}>
          <MapPin aria-hidden className="h-3.5 w-3.5" />
          Your region
        </div>
        <p className="mt-1 break-words text-sm font-bold leading-snug">{region.regionName}</p>
        <p className="mt-1 text-phx-xs font-semibold text-slate-200">
          {countOf(areas.length, "area")}. Open any area to load its pharmacies.
        </p>
        <TerritoryClosingTotal
          className="mt-1 block text-phx-xs font-bold tabular-nums text-white"
          code={region.regionCode}
          kind="region"
          tree={tree}
        />
      </div>
      <Spine />

      {areas.length === 0 ? (
        <p className="mt-8 text-sm font-semibold text-slate-600">No area is on file for this region yet.</p>
      ) : (
        // A vertical stack, not a multi-column grid — see AreaBody's comment: a shared grid
        // row would stretch every area in it to match whichever one happens to be expanded
        // with the most blocks/bricks, stranding shorter areas with a large dead gap below them.
        <div className="mt-6 w-full max-w-3xl space-y-4">
          {areas.map((area) => (
            <AreaLane
              area={area}
              blocks={blocks.filter((block) => block.areaCode === area.areaCode)}
              bricks={bricks.filter((brick) => brick.areaCode === area.areaCode)}
              key={area.areaCode}
              tree={tree}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A Region as a collapsible lane — used only when the viewer's subtree spans more than one
 *  region (a Regional Manager). Nothing to fetch on expand: opening a region just reveals its
 *  own (already-in-skeleton) Area lanes, each of which lazy-loads independently exactly like
 *  under a single-region root — see AreaLane. A flat orange head, so a region is told from the
 *  dark area and block heads beneath it at a glance. */
function RegionLane({
  region,
  areas,
  blocks,
  bricks,
  tree,
}: {
  region: TerritoryRegionNode;
  areas: TerritoryAreaNode[];
  blocks: TerritoryBlockNode[];
  bricks: TerritoryBrickNode[];
  tree: UseTerritoryTreeResult;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="border border-orange-200 bg-white">
      <button
        aria-expanded={open}
        className="flex w-full flex-col gap-1 border-b border-orange-200 bg-orange-50 px-4 py-3 text-left text-slate-900"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="flex items-center gap-2">
          <ChevronRight className={cn("h-4 w-4 shrink-0 text-orange-700 transition-transform", open && "rotate-90")} />
          <span className={cn("text-orange-700", TIER_LABEL)}>Region</span>
        </span>
        <span className="break-words pl-6 text-phx-lg font-bold leading-snug">{region.regionName}</span>
        <span className="pl-6 text-phx-xs font-bold tabular-nums text-slate-700">{countOf(areas.length, "area")}</span>
        <TerritoryClosingTotal
          className="pl-6 text-phx-xs font-bold tabular-nums text-slate-900"
          code={region.regionCode}
          kind="region"
          tree={tree}
        />
      </button>
      {open ? (
        areas.length === 0 ? (
          <p className="p-4 text-sm font-semibold text-slate-600">No area is on file for this region yet.</p>
        ) : (
          // A vertical stack, not a multi-column grid — see AreaBody's comment: a shared grid
          // row would stretch every area in it to match whichever one happens to be expanded
          // with the most blocks/bricks, stranding shorter areas with a large dead gap below.
          <div className="space-y-4 p-4">
            {areas.map((area) => (
              <AreaLane
                area={area}
                blocks={blocks.filter((block) => block.areaCode === area.areaCode)}
                bricks={bricks.filter((brick) => brick.areaCode === area.areaCode)}
                key={area.areaCode}
                tree={tree}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

/** Synthetic "My Regions" chart root — used only when the viewer's own subtree spans more
 *  than one region (a Regional Manager). A single-region viewer (District Manager) renders
 *  RegionRoot directly instead; this wrapper exists purely to give a multi-region viewer one
 *  unifying head instead of several disconnected "Your region" cards. Like RegionRoot, this
 *  never fetches anything itself — see RegionLane/AreaLane for where fetching happens. */
function RegionsRoot({
  regions,
  skeletonAreas,
  blocks,
  bricks,
  tree,
}: {
  regions: TerritoryRegionNode[];
  skeletonAreas: TerritoryAreaNode[];
  blocks: TerritoryBlockNode[];
  bricks: TerritoryBrickNode[];
  tree: UseTerritoryTreeResult;
}) {
  return (
    <div className="flex flex-col items-center">
      <div className={ROOT_CARD_ORANGE}>
        <div className={cn("flex items-center justify-center gap-1.5 text-orange-700", TIER_LABEL)}>
          <MapPin aria-hidden className="h-3.5 w-3.5" />
          My regions
        </div>
        <p className="mt-1 text-sm font-bold leading-snug">
          {structureLine({ areas: skeletonAreas.length })} in {countOf(regions.length, "region")}. Open any region to see its areas.
        </p>
        <TerritoryClosingTotal className="mt-1 block text-phx-xs font-bold tabular-nums text-slate-900" kind="all" tree={tree} />
      </div>
      <Spine />

      <div className="mt-6 w-full space-y-4">
        {regions.map((region) => (
          <RegionLane
            areas={skeletonAreas.filter((area) => area.regionCode === region.regionCode)}
            blocks={blocks}
            bricks={bricks}
            key={region.regionCode}
            region={region}
            tree={tree}
          />
        ))}
      </div>
    </div>
  );
}

export function TerritoryTreeDesktop({ tree }: { tree: UseTerritoryTreeResult }) {
  const { skeleton } = tree;

  if (skeleton.rootLevel === "area") {
    if (skeleton.areas.length === 0) {
      return <p className={EMPTY}>No area is on file for your account yet.</p>;
    }
    // No overflow-x-auto and no width floor on a rep's own tree (fits-the-screen rule): it opens at
    // 768px, where its column is at least ~586px, and every card in it wraps rather than widening.
    return (
      <div className="space-y-10 border border-slate-200 bg-slate-50 px-3 py-8 sm:px-6">
        {skeleton.areas.map((area) => (
          <AreaRoot
            area={area}
            blocks={skeleton.blocks.filter((block) => block.areaCode === area.areaCode)}
            bricks={skeleton.bricks.filter((brick) => brick.areaCode === area.areaCode)}
            key={area.areaCode}
            tree={tree}
          />
        ))}
      </div>
    );
  }

  if (skeleton.rootLevel === "region" || skeleton.rootLevel === "nationwide") {
    if (skeleton.regions.length === 0) {
      return <p className={EMPTY}>No region is on file for your account yet.</p>;
    }
    // Exactly one region (District Manager): that region IS the chart root. More than one
    // (Regional Manager's reporting subtree, or a National Sales Manager's whole line
    // nationwide): a synthetic "My Regions" head with region lanes beneath it, instead of
    // several disconnected "Your region" root cards — see RegionsRoot.
    if (skeleton.regions.length === 1) {
      const region = skeleton.regions[0];
      return (
        // No overflow-x-auto and no width floor on a manager's tree (fits-the-screen rule):
        // every card in it wraps rather than widening past the viewport — see AreaRoot.
        <div className="space-y-10 border border-slate-200 bg-slate-50 px-3 py-8 sm:px-6">
          <RegionRoot
            areas={skeleton.areas.filter((area) => area.regionCode === region.regionCode)}
            blocks={skeleton.blocks}
            bricks={skeleton.bricks}
            region={region}
            tree={tree}
          />
        </div>
      );
    }
    return (
      <div className="border border-slate-200 bg-slate-50 px-3 py-8 sm:px-6">
        <RegionsRoot
          blocks={skeleton.blocks}
          bricks={skeleton.bricks}
          regions={skeleton.regions}
          skeletonAreas={skeleton.areas}
          tree={tree}
        />
      </div>
    );
  }

  return <p className={EMPTY}>This view of the territory is not open to your role yet.</p>;
}
