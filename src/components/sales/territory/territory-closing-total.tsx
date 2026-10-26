"use client";

import { formatEgp } from "@/components/sales/target-visuals";
import { periodSpanLabel } from "@/lib/sales/territory/window";

import type { UseTerritoryTreeResult } from "./use-territory-tree";

/**
 * A region's or area's sales at a glance, from the closing engine over the published months in the
 * window (the Monthly Closing golden rule). Renders nothing until the totals arrive, and nothing when
 * the read failed or no month is published — a missing figure is never shown as a zero.
 */
export function TerritoryClosingTotal({
  tree,
  kind,
  code,
  className,
}: {
  tree: UseTerritoryTreeResult;
  kind: "area" | "region" | "all";
  code?: string;
  className?: string;
}) {
  const totals = tree.closingTotals;
  if (!totals || totals.periods.length === 0) return null;
  const key = (code ?? "").trim().toUpperCase();
  const sumOf = (values: Record<string, number>) => Object.values(values).reduce((sum, value) => sum + value, 0);
  const outside = totals.outsideRegionsValue ?? 0;
  const value =
    kind === "all"
      ? sumOf(totals.regionValues) + outside
      : kind === "region"
        ? totals.regionValues[key]
        : totals.areaValues[key];
  if (value === undefined) return null;
  // Areas without a target have no lane in the tree, so say how much of a region's (or the whole
  // line's) closing figure sits in them — otherwise the lanes below never add up to the header.
  const other =
    kind === "all"
      ? sumOf(totals.regionOtherValues) + outside
      : kind === "region"
        ? (totals.regionOtherValues[key] ?? 0)
        : 0;
  return (
    <span className={className}>
      Closing {periodSpanLabel(totals.periods)}: {formatEgp(value)}
      {other > 0 ? `, of which ${formatEgp(other)} in areas without a target` : null}
    </span>
  );
}
