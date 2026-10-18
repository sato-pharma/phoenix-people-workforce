/**
 * Customer 360 — one list row from a hub's view. Server-side only: it reads the assembly's shapes,
 * which import the matcher and the CRM vocabularies, none of which belongs in the browser bundle.
 */

import { hubLineLabel } from "./hub";
import { hubHref, type HubListRow } from "./list";
import type { HubView } from "./report";
import { VERDICT_LABELS } from "./verdict";

/** One list row from a hub's view. `lastMonths` are the last three closed months. */
export function hubListRow(view: HubView, lastMonths: readonly string[]): HubListRow {
  const recent = new Set(lastMonths);
  const pharmaciesSelling = view.pharmacies.filter((pharmacy) => {
    const sales = view.pharmacySales[pharmacy.key];
    return sales ? Object.entries(sales.byMonth).some(([month, value]) => recent.has(month) && value > 0) : false;
  }).length;
  const salesLast3 = Object.entries(view.salesByMonth).reduce((sum, [month, value]) => (recent.has(month) ? sum + value : sum), 0);
  const committedCost = view.requests.filter((request) => request.committed).reduce((sum, request) => sum + request.cost, 0);
  return {
    areaName: view.place?.areaName ?? null,
    brickName: view.place?.brickName ?? null,
    directOrderValue: view.directOrders.value,
    directOrderVenues: view.directOrders.venues,
    dropped: view.dropped,
    early: view.verdict.early,
    grade: view.grade,
    headline: view.verdict.reasons[0] ?? "",
    href: hubHref(view.kind, view.id),
    id: view.id,
    kind: view.kind,
    linesVisiting: view.linesVisiting.map(hubLineLabel),
    marketingCost: view.moneyVisible ? committedCost : null,
    name: view.name,
    namedOnVisit: view.pharmacies.filter((pharmacy) => pharmacy.sources.includes("named_on_visit")).length,
    pharmacies: view.pharmacies.length,
    pharmaciesSelling,
    regionName: view.place?.regionName ?? null,
    requests: view.requests.length,
    salesLast3,
    salesTotal: view.salesTotal,
    speciality: view.speciality,
    validatedOnLines: view.validatedOnLines.map(hubLineLabel),
    verdict: view.verdict.verdict,
    verdictLabel: VERDICT_LABELS[view.verdict.verdict],
  };
}
