// Recruitment — area and line names for the requisitions on a manager's page. SERVER ONLY.
//
// The requisition row stores ids (a snapshot of the seat it wraps); the page shows names. The names come
// from the cached reference lists (`src/lib/reference/reference-lists.ts`), never a read of their own —
// the performance test refuses a new direct read of `areas` or `lines`. A failed read answers an empty
// set, so a card falls back to the role alone rather than the page failing or a number being printed.

import { NO_REQUISITION_PLACES, type RequisitionPlaces } from "@/lib/recruitment/my-candidates-tidy";
import { loadReferenceAreas, loadReferenceLines } from "@/lib/reference/reference-lists";

type NameRow = { id: number | null; name: string | null };

function namesById(rows: ReadonlyArray<NameRow>, wanted: ReadonlySet<number>): Record<string, string> {
  const names: Record<string, string> = {};
  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (row.id !== null && wanted.has(row.id) && name) names[String(row.id)] = name;
  }
  return names;
}

export async function loadRequisitionPlaces(
  requisitions: ReadonlyArray<{ areaId: number | null; lineId: number | null } | null | undefined>,
): Promise<RequisitionPlaces> {
  const areaIds = new Set(requisitions.flatMap((r) => (r?.areaId == null ? [] : [r.areaId])));
  const lineIds = new Set(requisitions.flatMap((r) => (r?.lineId == null ? [] : [r.lineId])));
  if (areaIds.size === 0 && lineIds.size === 0) return NO_REQUISITION_PLACES;
  try {
    const [areas, lines] = await Promise.all([
      areaIds.size > 0 ? loadReferenceAreas() : [],
      lineIds.size > 0 ? loadReferenceLines() : [],
    ]);
    return { areas: namesById(areas, areaIds), lines: namesById(lines, lineIds) };
  } catch {
    return NO_REQUISITION_PLACES;
  }
}
