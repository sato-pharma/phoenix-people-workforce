"use client";

import { ChevronRight, Loader2, MapPin } from "lucide-react";
import { useEffect, useState } from "react";

import { formatEgp } from "@/components/sales/target-visuals";
import { cn } from "@/lib/utils";
import { periodProseLabel } from "@/lib/sales/periods";
import type {
  TerritoryAreaNode,
  TerritoryBlockNode,
  TerritoryBrickNode,
  TerritoryPharmacy,
  TerritoryRegionNode,
} from "@/lib/sales/territory/types";

import { PharmacyTrendSparkline } from "./pharmacy-trend-sparkline";
import { TerritoryClosingTotal } from "./territory-closing-total";
import type { UseTerritoryTreeResult } from "./use-territory-tree";

/** "12 pharmacies" / "1 pharmacy" — a pharmacy count is spelled out, never abbreviated (AGENTS.md §4). */
function pharmacyCount(count: number): string {
  return `${count} ${count === 1 ? "pharmacy" : "pharmacies"}`;
}

/** A block by its name; the code only when the block has no description on file. */
function blockLabel(block: TerritoryBlockNode): string {
  return block.blockName || block.blockCode;
}

function PharmacyCard({ pharmacy }: { pharmacy: TerritoryPharmacy }) {
  const [showTrend, setShowTrend] = useState(false);
  return (
    <li className="relative before:absolute before:-left-4 before:top-5 before:h-px before:w-4 before:bg-orange-200/80">
      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 break-words text-phx-sm font-bold leading-tight text-slate-900">
            {pharmacy.clientName}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-phx-xs font-black tabular-nums text-slate-500">
              {formatEgp(pharmacy.totalValue)}
            </span>
            <button
              className="rounded-md border border-slate-200 px-1.5 py-1 text-phx-2xs font-bold text-slate-500 transition hover:border-orange-300 hover:text-orange-600"
              onClick={() => setShowTrend((value) => !value)}
              type="button"
            >
              {showTrend ? "Hide trend" : "Trend"}
            </button>
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {pharmacy.months.map((month) => (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-phx-2xs font-black",
                month.hasSales
                  ? "bg-orange-50 text-orange-700 ring-1 ring-orange-200"
                  : "bg-slate-50 text-slate-400 ring-1 ring-slate-200",
              )}
              key={month.period}
              title={periodProseLabel(month.period)}
            >
              {periodProseLabel(month.period).slice(0, 3)}
            </span>
          ))}
        </div>
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
    <li className="relative before:absolute before:-left-4 before:top-5 before:h-px before:w-4 before:bg-orange-200/80">
      <button
        aria-expanded={open}
        className="group relative flex w-full flex-col gap-1 overflow-hidden rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left shadow-[0_2px_10px_rgba(15,23,42,0.05)] transition hover:border-slate-300"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-slate-300" />
        {/* Line 1: the brick name gets the FULL row width, always — never squeezed by the
            stats, which move to their own line below. Wraps rather than truncates. The brick is
            named, never shown by its ID. */}
        <span className="flex items-center gap-2">
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform", open && "rotate-90 text-orange-500")} />
          <span className="min-w-0 flex-1 break-words text-phx-sm font-bold leading-snug text-slate-900">
            {brick.brickName}
          </span>
        </span>
        {pharmacies ? (
          <span className="break-words pl-[22px] text-phx-2xs font-black tabular-nums text-slate-500">
            {pharmacyCount(pharmacies.length)} · {formatEgp(total)}
          </span>
        ) : null}
      </button>
      {open ? (
        <ul className="ml-4 mt-2 space-y-2 border-l-2 border-orange-200/80 pl-4" role="group">
          {pharmacies === null ? (
            <li className="py-1 text-phx-xs font-semibold text-slate-400">Loading…</li>
          ) : pharmacies.length === 0 ? (
            <li className="py-1 text-phx-xs font-semibold text-slate-400">No pharmacies with sales in your line here yet.</li>
          ) : (
            pharmacies.map((pharmacy) => <PharmacyCard key={pharmacy.clientCode} pharmacy={pharmacy} />)
          )}
        </ul>
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
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_2px_12px_rgba(15,23,42,0.06)]">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 bg-gradient-to-br from-slate-800 to-slate-950 px-3 py-2.5 text-left text-white"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-phx-2xs font-black uppercase tracking-[0.14em] text-orange-300">Block</span>
          <span className="block break-words text-phx-base font-black leading-snug">{blockLabel(block)}</span>
        </span>
        <span className="shrink-0 text-right text-phx-2xs font-black tabular-nums text-white/80">
          <span className="block">
            {bricks.length} brick{bricks.length === 1 ? "" : "s"}
            {blockPharmacyCount !== null ? ` · ${pharmacyCount(blockPharmacyCount)}` : ""}
          </span>
          <span className="block text-white">{blockTotal !== null ? formatEgp(blockTotal) : "—"}</span>
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
    return <p className="text-sm font-semibold text-slate-400">No blocks found for this area yet.</p>;
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
  const totalValue = state.status === "loaded" ? state.payload.totalValue : null;
  const reconciled = state.status === "loaded" ? state.payload.reconciled : null;
  const pharmacyTotal =
    state.status === "loaded"
      ? state.payload.bricks.reduce((sum, brick) => sum + brick.pharmacies.length, 0)
      : null;

  return (
    <div className="flex flex-col items-center">
      <div className="w-full max-w-md rounded-xl border border-slate-900 bg-gradient-to-br from-slate-800 to-slate-950 px-5 py-3.5 text-center text-white shadow-[0_16px_36px_rgba(15,23,42,0.35)]">
        <div className="flex items-center justify-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-300">
          <MapPin className="h-3.5 w-3.5" />
          Your area
        </div>
        <p className="mt-1 break-words text-sm font-bold leading-snug">{area.areaName}</p>
        <p className="mt-1 text-phx-xs font-semibold text-white/70">
          {state.status === "loading" ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading your territory…
            </span>
          ) : state.status === "error" ? (
            <span className="text-rose-300">{state.message}</span>
          ) : totalValue !== null ? (
            <>
              {blocks.length} block{blocks.length === 1 ? "" : "s"}
              {pharmacyTotal !== null ? ` · ${pharmacyCount(pharmacyTotal)}` : ""}
              {" · "}
              {formatEgp(totalValue)}
              {reconciled ? <>{" · "}<span className="text-emerald-300">Reconciled ✓</span></> : null}
            </>
          ) : null}
        </p>
        <TerritoryClosingTotal
          className="mt-1 block text-phx-xs font-bold tabular-nums text-white"
          code={area.areaCode}
          kind="area"
          tree={tree}
        />
      </div>
      <div aria-hidden className="h-5 w-0.5 bg-orange-300/80" />
      <div aria-hidden className="relative h-0.5 w-[92%] max-w-3xl bg-orange-300/70">
        <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-500" />
      </div>

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
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_2px_12px_rgba(15,23,42,0.06)]">
      <button
        aria-expanded={open}
        className="flex w-full flex-col gap-1 bg-gradient-to-br from-slate-800 to-slate-950 px-3 py-2.5 text-left text-white"
        onClick={handleToggle}
        type="button"
      >
        <span className="flex items-center gap-2">
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-orange-300 transition-transform", open && "rotate-90")} />
          <span className="text-phx-3xs font-black uppercase tracking-[0.14em] text-orange-300">Area</span>
        </span>
        <span className="break-words pl-[22px] text-phx-base font-black leading-snug">{area.areaName}</span>
        <span className="pl-[22px] text-phx-2xs font-black tabular-nums text-white/80">
          {blocks.length} block{blocks.length === 1 ? "" : "s"}
          {pharmacyTotal !== null ? ` · ${pharmacyCount(pharmacyTotal)}` : ""}
          {state.status === "loaded" ? (
            <>
              {" · "}
              {formatEgp(state.payload.totalValue)}
              {state.payload.reconciled ? <>{" · "}<span className="text-emerald-300">Reconciled ✓</span></> : null}
            </>
          ) : null}
        </span>
        <TerritoryClosingTotal
          className="pl-[22px] text-phx-2xs font-black tabular-nums text-white"
          code={area.areaCode}
          kind="area"
          tree={tree}
        />
      </button>
      {open ? (
        <div className="px-3 py-3">
          {state.status === "loading" ? (
            <p className="flex items-center gap-1 text-phx-xs font-semibold text-slate-400">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading this area…
            </p>
          ) : state.status === "error" ? (
            <p className="text-phx-xs font-semibold text-rose-500">{state.message}</p>
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
      <div className="w-full max-w-md rounded-xl border border-slate-900 bg-gradient-to-br from-slate-800 to-slate-950 px-5 py-3.5 text-center text-white shadow-[0_16px_36px_rgba(15,23,42,0.35)]">
        <div className="flex items-center justify-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-300">
          <MapPin className="h-3.5 w-3.5" />
          Your region
        </div>
        <p className="mt-1 break-words text-sm font-bold leading-snug">{region.regionName}</p>
        <p className="mt-1 text-phx-xs font-semibold text-white/70">
          {areas.length} area{areas.length === 1 ? "" : "s"} — expand any to load its sales
        </p>
        <TerritoryClosingTotal
          className="mt-1 block text-phx-xs font-bold tabular-nums text-white"
          code={region.regionCode}
          kind="region"
          tree={tree}
        />
      </div>
      <div aria-hidden className="h-5 w-0.5 bg-orange-300/80" />
      <div aria-hidden className="relative h-0.5 w-[92%] max-w-3xl bg-orange-300/70">
        <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-500" />
      </div>

      {areas.length === 0 ? (
        <p className="mt-8 text-sm font-semibold text-slate-400">No areas found for this region yet.</p>
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
 *  under a single-region root — see AreaLane. Same dark-slate header every other tier uses;
 *  the uppercase "Region" label is what tells it apart, not a competing accent color. */
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
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_2px_12px_rgba(15,23,42,0.06)]">
      <button
        aria-expanded={open}
        className="flex w-full flex-col gap-1 bg-gradient-to-br from-orange-50 to-orange-100 px-4 py-3 text-left text-slate-900"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="flex items-center gap-2">
          <ChevronRight className={cn("h-4 w-4 shrink-0 text-orange-600 transition-transform", open && "rotate-90")} />
          <span className="text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-600">Region</span>
        </span>
        <span className="break-words pl-6 text-phx-lg font-black leading-snug">{region.regionName}</span>
        <span className="pl-6 text-phx-2xs font-black tabular-nums text-slate-700">
          {areas.length} area{areas.length === 1 ? "" : "s"}
        </span>
        <TerritoryClosingTotal
          className="pl-6 text-phx-2xs font-black tabular-nums text-slate-900"
          code={region.regionCode}
          kind="region"
          tree={tree}
        />
      </button>
      {open ? (
        areas.length === 0 ? (
          <p className="p-4 text-sm font-semibold text-slate-400">No areas found for this region yet.</p>
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
      <div className="w-full max-w-md rounded-xl border border-orange-200 bg-gradient-to-br from-orange-50 to-orange-100 px-5 py-3.5 text-center text-slate-900 shadow-[0_16px_36px_rgba(15,23,42,0.1)]">
        <div className="flex items-center justify-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-600">
          <MapPin className="h-3.5 w-3.5" />
          My regions
        </div>
        <p className="mt-1 text-sm font-bold leading-snug">
          {regions.length} regions — expand any to see its areas
        </p>
        <TerritoryClosingTotal className="mt-1 block text-phx-xs font-bold tabular-nums text-slate-900" kind="all" tree={tree} />
      </div>
      <div aria-hidden className="h-5 w-0.5 bg-orange-300/80" />
      <div aria-hidden className="relative h-0.5 w-[92%] max-w-3xl bg-orange-300/70">
        <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-500" />
      </div>

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
      return (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No area is on file for you yet.
        </p>
      );
    }
    // No overflow-x-auto and no width floor on a rep's own tree (fits-the-screen rule): it opens at
    // 768px, where its column is at least ~586px, and every card in it wraps rather than widening.
    return (
      <div className="space-y-10 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-8 sm:px-6">
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
      return (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No region is on file for you yet.
        </p>
      );
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
        <div className="space-y-10 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-8 sm:px-6">
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
      <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-8 sm:px-6">
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

  return (
    <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      This role&apos;s territory view isn&apos;t available yet.
    </p>
  );
}
