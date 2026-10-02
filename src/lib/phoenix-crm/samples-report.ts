/**
 * Phoenix CRM — samples and materials left, month by month: what the reps handed over, by product and
 * by territory, AM and PM apart. No I/O.
 *
 * Owner, 2026-10-02, one of the five reports he picked that day: the monthly totals of the free samples
 * and the materials — pens, block notes, giveaways — recorded on the visits.
 *
 * ## 🔴 A RECORD OF WHAT WAS LEFT — NEVER A STOCK
 *
 * `samples.ts` is the rule and this board obeys it: there is no allocation, no balance, nothing
 * subtracted, and no figure of what a rep was issued set beside what he recorded. The moment those two
 * stand side by side a mismatch reads as an accusation, and an accusation is exactly what Golden Rule #1
 * keeps away from the field. This module adds quantities up and does nothing else.
 *
 * Junk is dropped exactly as the visit form drops it (`parseSamplesGiven`): a quantity that is not a
 * whole number of at least one, a key that is neither one of the three materials nor a product name.
 *
 * ## 🔴 UNITS OF DIFFERENT PRODUCTS ARE NEVER ADDED
 *
 * A unit total is valid for ONE product only (the owner's standing rule): three sample packs of one
 * product and two of another are not "five samples". So a quantity is only ever summed within its own
 * item, and what this report counts ACROSS items is VISITS — how many visits left samples, how many left
 * materials — which add up honestly. A visit that left both is counted in both, and the two are never
 * added either.
 */

import { isSampleMaterial, parseSamplesGiven, sampleItemLabel, SAMPLE_MATERIALS } from "@/lib/phoenix-crm/samples";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

export type SamplesVisit = {
  seatId: string;
  listType: PhoenixCrmListType;
  /** `samples_given` as stored — read through `parseSamplesGiven`, never trusted as it comes. */
  samples: unknown;
};

export type SampleItemTotal = {
  key: string;
  label: string;
  kind: "sample" | "material";
  /** Quantities left on AM visits and on PM visits — never added together. */
  am: number;
  pm: number;
};

export type SamplesTerritory = { seatId: string; territoryName: string; lineName: string | null; repName: string | null };

/** Visits, AM and PM apart: the one thing this report adds up across different items. */
export type SamplesVisitCounts = { am: number; pm: number };

export type SamplesTerritoryRow = SamplesTerritory & {
  /** Visits that left anything at all, AM and PM apart. */
  visits: SamplesVisitCounts;
  /** Visits that left at least one free sample. */
  visitsWithSamples: SamplesVisitCounts;
  /** Visits that left at least one material — a pen, a block note, a giveaway. */
  visitsWithMaterials: SamplesVisitCounts;
  items: SampleItemTotal[];
};

export type SamplesReportResult = {
  /** The month's totals: the sampled products by name, then the three materials in their fixed order. */
  items: SampleItemTotal[];
  /** Every territory chosen, including the ones that left nothing — a gap shows instead of vanishing. */
  territories: SamplesTerritoryRow[];
  visits: SamplesVisitCounts;
  visitsWithSamples: SamplesVisitCounts;
  visitsWithMaterials: SamplesVisitCounts;
};

type ItemMap = Map<string, SampleItemTotal>;

function add(map: ItemMap, key: string, side: "am" | "pm", quantity: number): void {
  const item: SampleItemTotal = map.get(key) ?? { key, label: sampleItemLabel(key), kind: isSampleMaterial(key) ? "material" : "sample", am: 0, pm: 0 };
  item[side] += quantity;
  map.set(key, item);
}

const MATERIAL_ORDER = new Map<string, number>(SAMPLE_MATERIALS.map((entry, index) => [entry.key, index]));

/** Samples by product name first, then the materials in the form's own order. */
function ordered(map: ItemMap): SampleItemTotal[] {
  return [...map.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "sample" ? -1 : 1;
    if (left.kind === "material") return (MATERIAL_ORDER.get(left.key) ?? 0) - (MATERIAL_ORDER.get(right.key) ?? 0);
    return left.label.localeCompare(right.label);
  });
}

type SeatTally = { items: ItemMap; visits: SamplesVisitCounts; visitsWithSamples: SamplesVisitCounts; visitsWithMaterials: SamplesVisitCounts };

function noVisits(): SamplesVisitCounts {
  return { am: 0, pm: 0 };
}

export function buildSamplesReport(visits: ReadonlyArray<SamplesVisit>, territories: ReadonlyArray<SamplesTerritory>): SamplesReportResult {
  const totals: ItemMap = new Map();
  const bySeat = new Map<string, SeatTally>();
  const wanted = new Set(territories.map((territory) => territory.seatId));
  const visitTotals = noVisits();
  const withSamples = noVisits();
  const withMaterials = noVisits();

  for (const visit of visits) {
    // A visit in a territory the reader did not choose is never counted, whoever passed it in.
    if (!wanted.has(visit.seatId)) continue;
    const samples = parseSamplesGiven(visit.samples);
    const entries = Object.entries(samples);
    if (entries.length === 0) continue;
    const side = visit.listType === "AM" ? "am" : "pm";
    const seat: SeatTally = bySeat.get(visit.seatId) ?? { items: new Map(), visits: noVisits(), visitsWithSamples: noVisits(), visitsWithMaterials: noVisits() };
    seat.visits[side] += 1;
    visitTotals[side] += 1;
    // Counted per VISIT, never per unit: did this visit leave a sample, did it leave a material.
    if (entries.some(([key]) => !isSampleMaterial(key))) {
      seat.visitsWithSamples[side] += 1;
      withSamples[side] += 1;
    }
    if (entries.some(([key]) => isSampleMaterial(key))) {
      seat.visitsWithMaterials[side] += 1;
      withMaterials[side] += 1;
    }
    for (const [key, quantity] of entries) {
      add(totals, key, side, quantity);
      add(seat.items, key, side, quantity);
    }
    bySeat.set(visit.seatId, seat);
  }

  return {
    items: ordered(totals),
    territories: territories
      .map((territory) => {
        const seat = bySeat.get(territory.seatId);
        return {
          ...territory,
          visits: seat?.visits ?? noVisits(),
          visitsWithSamples: seat?.visitsWithSamples ?? noVisits(),
          visitsWithMaterials: seat?.visitsWithMaterials ?? noVisits(),
          items: seat ? ordered(seat.items) : [],
        };
      })
      .sort((left, right) => left.territoryName.localeCompare(right.territoryName)),
    visits: visitTotals,
    visitsWithSamples: withSamples,
    visitsWithMaterials: withMaterials,
  };
}
