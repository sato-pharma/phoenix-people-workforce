"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { PortalRecordCard } from "@/components/employee-portal/portal-primitives";
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

// The same flat, square look as the desktop tree: no round corners, no gradients, no shadows,
// and nothing below 11px (`text-phx-xs`).
const DARK_CARD = "bg-slate-900 px-4 py-3 text-white";
const ORANGE_CARD = "border border-orange-300 bg-orange-50 px-4 py-3 text-slate-900";
const DARK_SUMMARY = "flex min-h-11 cursor-pointer list-none flex-col gap-1 bg-slate-900 px-3 py-2.5 text-white";
const TIER_LABEL = "text-phx-xs font-bold uppercase tracking-[0.14em]";
const EMPTY = "border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600";

/** A block by its name; the code only when the block has no description on file. */
function blockLabel(block: TerritoryBlockNode): string {
  return block.blockName || block.blockCode;
}

function PharmacyRecord({ pharmacy }: { pharmacy: TerritoryPharmacy }) {
  const [showTrend, setShowTrend] = useState(false);
  return (
    <PortalRecordCard
      accent="orange"
      meta={<MonthChipRow pharmacy={pharmacy} />}
      status={<span className="text-xs font-bold tabular-nums text-slate-700">{formatEgp(pharmacy.totalValue)}</span>}
      title={pharmacy.clientName}
    >
      <button
        aria-expanded={showTrend}
        className="inline-flex min-h-10 items-center text-phx-xs font-bold text-orange-700 underline underline-offset-2"
        onClick={() => setShowTrend((value) => !value)}
        type="button"
      >
        {showTrend ? "Hide monthly trend" : "View monthly trend"}
      </button>
      {showTrend ? (
        <div className="mt-2">
          <PharmacyTrendSparkline months={pharmacy.months} />
        </div>
      ) : null}
    </PortalRecordCard>
  );
}

function BrickDetails({ brick, pharmacies }: { brick: TerritoryBrickNode; pharmacies: TerritoryPharmacy[] | null }) {
  const total = (pharmacies ?? []).reduce((sum, pharmacy) => sum + pharmacy.totalValue, 0);
  return (
    <details className="group border border-slate-200 bg-white open:pb-2">
      {/* Name gets its own full-width line and wraps instead of truncating — a two-line
          summary so the brick name is never squeezed out by the stats row below it. The chevron
          says the row opens, as the desktop tree's does; the brick is named, never shown by its ID. */}
      <summary className="flex min-h-11 cursor-pointer list-none flex-col gap-1 px-3 py-2.5">
        <span className="flex items-start gap-2">
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform group-open:rotate-90 group-open:text-orange-600" />
          <span className="min-w-0 flex-1 break-words text-phx-sm font-bold leading-snug text-slate-900">{brick.brickName}</span>
        </span>
        {pharmacies ? (
          <span className="break-words pl-[22px] text-phx-xs font-bold tabular-nums text-slate-600">
            {pharmacyCount(pharmacies.length)} · {formatEgp(total)}
          </span>
        ) : null}
      </summary>
      <div className="border-t border-slate-100 px-3 pt-2">
        {pharmacies === null ? (
          <p className="py-1 text-phx-xs font-semibold text-slate-600">Loading the pharmacies…</p>
        ) : pharmacies.length === 0 ? (
          <p className="py-1 text-phx-xs font-semibold text-slate-600">No pharmacy in this brick has a sale in your line yet.</p>
        ) : (
          // One full-width card per pharmacy, stacked. Never a two-column field grid: at 375px that
          // left each pharmacy about 90px, its name broke every few letters and the month chips
          // stacked one per line. Named, never labelled with the customer code.
          <>
            <MonthChipLegend className="pb-1" />
            <div className="divide-y divide-slate-100">
              {pharmacies.map((pharmacy) => (
                <PharmacyRecord key={pharmacy.clientCode} pharmacy={pharmacy} />
              ))}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function BlockDetails({
  block,
  bricks,
  pharmaciesByBrick,
}: {
  block: TerritoryBlockNode;
  bricks: TerritoryBrickNode[];
  pharmaciesByBrick: Map<string, TerritoryPharmacy[]> | null;
}) {
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
    <details className="border border-slate-200 bg-white" open>
      <summary className="flex min-h-11 cursor-pointer list-none flex-col gap-1 bg-slate-900 px-3 py-2.5 text-white">
        <span className={cn("text-orange-300", TIER_LABEL)}>Block</span>
        <span className="break-words text-phx-base font-bold leading-snug">{blockLabel(block)}</span>
        {/* Stats on their own line, so a long block name is never squeezed beside them. */}
        <span className="text-phx-xs font-bold tabular-nums text-slate-200">
          {structureLine({ bricks: bricks.length, pharmacies: blockPharmacyCount })}
          {blockTotal !== null ? ` · ${formatEgp(blockTotal)}` : ""}
        </span>
      </summary>
      <div className="space-y-2 p-2.5">
        {orderedBrickStats.map(({ brick, pharmacies }) => (
          <BrickDetails brick={brick} key={brick.brickId} pharmacies={pharmacies} />
        ))}
      </div>
    </details>
  );
}

/** Groups bricks by block and renders the block-details list — shared by AreaSection (Area is
 *  the root, Medical Rep) and AreaDetails (Area is a lazy nested lane, District Manager+). */
function AreaBlocksList({
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

  return (
    <div className="space-y-2">
      {blocks.map((block) => (
        <BlockDetails
          block={block}
          bricks={blocksByCode.get(block.blockCode) ?? []}
          key={block.blockCode}
          pharmaciesByBrick={pharmaciesByBrick}
        />
      ))}
    </div>
  );
}

function AreaSection({
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

  return (
    <div className="space-y-3">
      <div className={DARK_CARD}>
        <p className={cn("text-orange-300", TIER_LABEL)}>Your area</p>
        <p className="mt-0.5 break-words text-base font-bold">{area.areaName}</p>
        <div aria-live="polite" className="mt-1 space-y-0.5 text-phx-xs font-semibold text-slate-200">
          {state.status === "loading" && <p>Loading your territory…</p>}
          {state.status === "error" && <p className="text-rose-200">{state.message}</p>}
          {state.status === "loaded" && (
            <>
              <p>
                {structureLine({
                  blocks: blocks.length,
                  pharmacies: state.payload.bricks.reduce((sum, brick) => sum + brick.pharmacies.length, 0),
                })}
              </p>
              <p className="tabular-nums">{pharmacySheetsLine(formatEgp(state.payload.totalValue), state.payload.reconciled)}</p>
            </>
          )}
        </div>
        <TerritoryClosingTotal
          className="mt-1 block text-phx-xs font-bold tabular-nums text-white"
          code={area.areaCode}
          kind="area"
          tree={tree}
        />
      </div>
      <AreaBlocksList blocks={blocks} bricks={bricks} pharmaciesByBrick={pharmaciesByBrick} />
    </div>
  );
}

/** An Area as a native-<details> lane — used whenever Area isn't the root (a District
 *  Manager's region root today; Regional Manager/National Sales Manager next). Fetches its own
 *  pharmacy data only the first time it's opened, via the native toggle event — a region can
 *  hold many areas, so eager-loading all of them the way AreaSection does for a Medical Rep's
 *  one or two locked areas would defeat lazy-loading. */
function AreaDetails({
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
    <details
      className="border border-slate-200 bg-white open:pb-2.5"
      onToggle={(event) => {
        if (event.currentTarget.open) tree.loadArea(area.areaCode);
      }}
    >
      <summary className={DARK_SUMMARY}>
        <span className={cn("text-orange-300", TIER_LABEL)}>Area</span>
        <span className="break-words text-phx-base font-bold leading-snug">{area.areaName}</span>
        <span className="text-phx-xs font-bold tabular-nums text-slate-200">
          {structureLine({ blocks: blocks.length, pharmacies: pharmacyTotal })}
        </span>
        {state.status === "loaded" ? (
          <span className="text-phx-xs font-semibold tabular-nums text-slate-200">
            {pharmacySheetsLine(formatEgp(state.payload.totalValue), state.payload.reconciled)}
          </span>
        ) : null}
        <TerritoryClosingTotal
          className="text-phx-xs font-bold tabular-nums text-white"
          code={area.areaCode}
          kind="area"
          tree={tree}
        />
      </summary>
      <div className="space-y-2 border-t border-slate-100 px-2.5 pt-2.5">
        {state.status === "idle" || state.status === "loading" ? (
          <p className="text-phx-xs font-semibold text-slate-600">Loading this area…</p>
        ) : state.status === "error" ? (
          <p className="text-phx-xs font-semibold text-rose-700" role="alert">{state.message}</p>
        ) : (
          <AreaBlocksList blocks={blocks} bricks={bricks} pharmaciesByBrick={pharmaciesByBrick} />
        )}
      </div>
    </details>
  );
}

/** One District Manager's region (or, later, one of a Regional Manager's regions), rendered as
 *  the root section one tier above AreaSection. Never eager-loads anything itself — see
 *  AreaDetails, which only fetches once a user actually taps an area open. */
function RegionSection({
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
    <div className="space-y-3">
      <div className={DARK_CARD}>
        <p className={cn("text-orange-300", TIER_LABEL)}>Your region</p>
        <p className="mt-0.5 break-words text-base font-bold">{region.regionName}</p>
        <p className="mt-1 text-phx-xs font-semibold text-slate-200">
          {countOf(areas.length, "area")}. Tap any area to load its pharmacies.
        </p>
        <TerritoryClosingTotal
          className="mt-1 block text-phx-xs font-bold tabular-nums text-white"
          code={region.regionCode}
          kind="region"
          tree={tree}
        />
      </div>
      {areas.length === 0 ? (
        <p className="text-sm font-semibold text-slate-600">No area is on file for this region yet.</p>
      ) : (
        <div className="space-y-2">
          {areas.map((area) => (
            <AreaDetails
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

/** A Region as a native-<details> lane — used only when the viewer's subtree spans more than
 *  one region (a Regional Manager). Nothing to fetch on open: it just reveals its own
 *  (already-in-skeleton) Area accordions, each of which lazy-loads independently — see
 *  AreaDetails. A flat orange head, so a region is told from the dark area heads beneath it. */
function RegionDetails({
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
    <details className="border border-orange-200 bg-white open:pb-2.5" open>
      <summary className="flex min-h-11 cursor-pointer list-none flex-col gap-1 border-b border-orange-200 bg-orange-50 px-4 py-3 text-slate-900">
        <span className={cn("text-orange-700", TIER_LABEL)}>Region</span>
        <span className="break-words text-phx-lg font-bold leading-snug">{region.regionName}</span>
        <span className="text-phx-xs font-bold tabular-nums text-slate-700">{countOf(areas.length, "area")}</span>
        <TerritoryClosingTotal
          className="text-phx-xs font-bold tabular-nums text-slate-900"
          code={region.regionCode}
          kind="region"
          tree={tree}
        />
      </summary>
      <div className="space-y-2 px-2.5 pt-2.5">
        {areas.length === 0 ? (
          <p className="py-1 text-sm font-semibold text-slate-600">No area is on file for this region yet.</p>
        ) : (
          areas.map((area) => (
            <AreaDetails
              area={area}
              blocks={blocks.filter((block) => block.areaCode === area.areaCode)}
              bricks={bricks.filter((brick) => brick.areaCode === area.areaCode)}
              key={area.areaCode}
              tree={tree}
            />
          ))
        )}
      </div>
    </details>
  );
}

/** Synthetic "My Regions" root section — used only when the viewer's own subtree spans more
 *  than one region (a Regional Manager). A single-region viewer (District Manager) renders
 *  RegionSection directly instead — see the rootLevel === "region" branch below. */
function RegionsSection({
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
    <div className="space-y-3">
      <div className={ORANGE_CARD}>
        <p className={cn("text-orange-700", TIER_LABEL)}>My regions</p>
        <p className="mt-1 text-phx-xs font-semibold text-slate-700">
          {structureLine({ areas: skeletonAreas.length })} in {countOf(regions.length, "region")}. Tap any region to see its areas.
        </p>
        <TerritoryClosingTotal className="mt-1 block text-phx-xs font-bold tabular-nums text-slate-900" kind="all" tree={tree} />
      </div>
      <div className="space-y-2">
        {regions.map((region) => (
          <RegionDetails
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

export function TerritoryTreeMobile({ tree }: { tree: UseTerritoryTreeResult }) {
  const { skeleton } = tree;

  if (skeleton.rootLevel === "area") {
    if (skeleton.areas.length === 0) {
      return <p className={EMPTY}>No area is on file for your account yet.</p>;
    }
    return (
      <div className="space-y-6">
        {skeleton.areas.map((area) => (
          <AreaSection
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
    // Exactly one region (District Manager): render it directly. More than one (Regional
    // Manager's reporting subtree, or a National Sales Manager's whole line nationwide): a
    // synthetic "My Regions" section — see RegionsSection.
    if (skeleton.regions.length === 1) {
      const region = skeleton.regions[0];
      return (
        <RegionSection
          areas={skeleton.areas.filter((area) => area.regionCode === region.regionCode)}
          blocks={skeleton.blocks}
          bricks={skeleton.bricks}
          region={region}
          tree={tree}
        />
      );
    }
    return (
      <RegionsSection
        blocks={skeleton.blocks}
        bricks={skeleton.bricks}
        regions={skeleton.regions}
        skeletonAreas={skeleton.areas}
        tree={tree}
      />
    );
  }

  return <p className={EMPTY}>This view of the territory is not open to your role yet.</p>;
}
