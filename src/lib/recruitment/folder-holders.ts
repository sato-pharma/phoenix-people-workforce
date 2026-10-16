// Recruitment / ATS — who holds CV folders, and so who is NOT held to the 45-day window.
//
// The owner, 2026-10-16, asked whether the 45-day auto-return should stay for CVs in folders and
// answered "lift it". A manager who holds folders (a district manager, or a regional or national sales
// manager above districts) keeps a CV until Talent Acquisition takes it back or he returns it; every
// other manager keeps the 45 days of manager-hold-window.ts.
//
// This file reads the organogram and nothing else, and imports neither manager-sends.ts nor the
// folders reader, because both of them ask it a question — an import back would be a cycle.

import { cache } from "react";

import { canonicalHrIdKey } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import { DISTRICT_SEAT_COLUMNS, type DistrictSeatRow } from "@/lib/recruitment/district-manager-folders";
import { managerFolderShelves } from "@/lib/recruitment/manager-cv-folders";

/**
 * The organogram.
 *
 * A failed read degrades to no rows rather than throwing. The caller then treats nobody as a folder
 * holder, which is the safe direction for the window: the 45 days apply as they always did.
 *
 * ONCE PER SERVER RENDER (React `cache()`). One render asks it several times — the hiring-manager
 * picker for its seats AND its shelves, every `managerHoldsFolders` gate on a manager's inbox — and
 * the view takes no filter, so every caller gets the same rows. Outside a render it is a plain call.
 * The rows are shared: callers read them and never mutate them.
 */
export const loadDistrictSeatRows = cache(async (): Promise<DistrictSeatRow[]> => {
  const { data, error } = await recruitmentDb().from("au_v_org_tree").select(DISTRICT_SEAT_COLUMNS);
  if (error) {
    logError("Manager CV folders could not read the org tree", {
      error,
      labels: { event: "district_folders_tree_read_failed" },
    });
    return [];
  }
  return (data ?? []) as DistrictSeatRow[];
});

/** Canonical HR id keys of every manager with at least one shelf. Pure. */
export function folderHolderKeys(rows: readonly DistrictSeatRow[]): Set<string> {
  const keys = new Set<string>();
  for (const shelf of managerFolderShelves(rows)) {
    const key = canonicalHrIdKey(shelf.managerHrId);
    if (key) keys.add(key);
  }
  return keys;
}

export async function loadFolderHolderKeys(): Promise<Set<string>> {
  return folderHolderKeys(await loadDistrictSeatRows());
}

/** Does this manager hold folders, so the 45-day window does not apply to him? */
export async function managerHoldsFolders(managerHrId: string | null | undefined): Promise<boolean> {
  const key = canonicalHrIdKey(managerHrId);
  if (!key) return false;
  return (await loadFolderHolderKeys()).has(key);
}
