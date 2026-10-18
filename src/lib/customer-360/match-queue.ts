/**
 * Customer 360 — the Pharmacy matches tab's items, as the browser receives them.
 *
 * Built server-side so the client component imports nothing but this file's TYPES: line labels and
 * the wait-reason words are resolved here, every code becomes a name, and the browser bundle never
 * pulls in the matcher or the CRM vocabularies.
 *
 * His words (2026-10-18): "you must show the location of the validated customer and the address of
 * the pharmacy and show full data." So every candidate carries its name, address, brick, area, each
 * distributor by name with that distributor's own code for the shop, and its recent closing value.
 */

import { hubLineLabel } from "./hub";
import { WAIT_REASON_TEXT, type MatchStatus } from "./pharmacy-matcher";
import type { MatchItemView } from "./report";
import { candidateSalesKey } from "./report";

export type MatchQueueShop = {
  name: string;
  address: string | null;
  brickName: string | null;
  areaName: string | null;
  why: string | null;
  /** Every distributor this shop is bought from, by name, with its code there and its recent value. */
  codes: Array<{ distributorCode: string; distributorName: string; customerCode: string; recentValue: number }>;
};

export type MatchQueueSighting = {
  customerName: string;
  customerKind: "Doctor" | "Account";
  customerHref: string;
  address: string | null;
  mapUrl: string | null;
  repName: string;
  lineLabel: string;
  visitDate: string;
  typed: string;
};

export type MatchQueueItem = {
  key: string;
  nameKey: string;
  brickId: string | null;
  brickName: string | null;
  areaName: string | null;
  typedAs: string[];
  status: MatchStatus;
  reasonText: string | null;
  decidedAt: string | null;
  /** The shops tied now (auto or confirmed). */
  tied: MatchQueueShop[];
  /** The shops offered for a waiting item. */
  candidates: MatchQueueShop[];
  /** The raw pairs, for the confirm POST — keyed by shop index in `candidates`. */
  candidatePairs: Array<Array<{ distributorCode: string; customerCode: string; customerName: string; brickId: string | null }>>;
  sightings: MatchQueueSighting[];
};

const WHY_TEXT: Record<string, string> = {
  near_name_same_brick: "A similar name in the same brick",
  same_name_other_brick: "The same name in another brick of the area",
  same_name_same_brick: "The same name in the same brick",
};

function mapUrl(lat: number | null, lon: number | null): string | null {
  if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return `https://www.google.com/maps?q=${lat},${lon}`;
}

type PairLike = { distributorCode: string; customerCode: string; customerName: string; brickId: string | null; address?: string | null; areaCode?: string | null; why?: string };

/** One shop = one folded name at one address; its pairs at several distributors are grouped. */
function groupShops(
  pairs: readonly PairLike[],
  item: MatchItemView,
  distributorNames: Record<string, string>,
  brickNames: Record<string, string>,
): { shops: MatchQueueShop[]; raw: MatchQueueItem["candidatePairs"] } {
  const shops = new Map<string, { shop: MatchQueueShop; raw: MatchQueueItem["candidatePairs"][number] }>();
  for (const pair of pairs) {
    const distributorCode = pair.distributorCode.trim().toUpperCase();
    const distributorName = distributorNames[distributorCode];
    // A distributor this viewer may not see is never offered.
    if (distributorName === undefined) continue;
    const key = `${pair.customerName.trim()}|${pair.brickId ?? ""}|${(pair.address ?? "").trim()}`;
    let entry = shops.get(key);
    if (!entry) {
      entry = {
        raw: [],
        shop: {
          address: pair.address ?? null,
          areaName: item.areaName,
          brickName: pair.brickId ? (brickNames[pair.brickId] ?? null) : null,
          codes: [],
          name: pair.customerName,
          why: pair.why ? (WHY_TEXT[pair.why] ?? null) : null,
        },
      };
      shops.set(key, entry);
    }
    entry.shop.codes.push({
      customerCode: pair.customerCode.trim(),
      distributorCode,
      distributorName,
      recentValue: item.candidateSales[candidateSalesKey(distributorCode, pair.customerCode)] ?? 0,
    });
    entry.raw.push({ brickId: pair.brickId, customerCode: pair.customerCode.trim(), customerName: pair.customerName, distributorCode });
  }
  const list = [...shops.values()];
  return { raw: list.map((entry) => entry.raw), shops: list.map((entry) => entry.shop) };
}

export function toMatchQueueItems(
  items: readonly MatchItemView[],
  distributorNames: Record<string, string>,
  brickNames: Record<string, string>,
  hubHrefFor: (kind: "doctor" | "account", id: string) => string,
): MatchQueueItem[] {
  return items.map((item) => {
    const tied = groupShops(item.result.pairs, item, distributorNames, brickNames);
    const offered = groupShops(item.result.candidates, item, distributorNames, brickNames);
    return {
      areaName: item.areaName,
      brickId: item.brickId,
      brickName: item.brickName,
      candidatePairs: offered.raw,
      candidates: offered.shops,
      decidedAt: item.result.decision?.decidedAt ?? null,
      key: item.key,
      nameKey: item.nameKey,
      reasonText: item.result.reason ? WAIT_REASON_TEXT[item.result.reason] : null,
      sightings: item.sightings.map((sighting) => ({
        address: sighting.placeAddress,
        customerHref: hubHrefFor(sighting.hubKind, sighting.hubId),
        customerKind: sighting.hubKind === "doctor" ? "Doctor" : "Account",
        customerName: sighting.hubName,
        lineLabel: sighting.line ? hubLineLabel(sighting.line) : "Line not recorded",
        mapUrl: mapUrl(sighting.lat, sighting.lon),
        repName: sighting.repName,
        typed: sighting.typed,
        visitDate: sighting.visitDate,
      })),
      status: item.result.status,
      tied: tied.shops,
      typedAs: item.typedAs,
    };
  });
}
