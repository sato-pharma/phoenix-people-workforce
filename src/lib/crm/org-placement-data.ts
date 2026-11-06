/**
 * The one database read behind "where does this person sit in the organogram".
 *
 * Kept apart from `org-placement.ts` for the same reason `coverage-filters-data.ts` is kept apart
 * from `coverage-filters.ts`: that module stays pure so the resolution is testable without a
 * database, and it stops being pure the moment a Supabase import lands in it.
 *
 * `au_v_org_tree` is the organogram — one row per seat, EVERY tier, with the occupant and (below
 * the area layer) a line and a region. It is deliberately the whole tree and not a rep-only slice:
 * reading a rep-only view is exactly the mistake this file exists to stop repeating.
 */

import { unstable_cache } from "next/cache";

import { buildOrgPlacementTree, type OrgPlacementTree, type OrgTreeNode } from "@/lib/crm/org-placement";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Read the tree.
 *
 * NOT paginated, and that is a measured decision rather than an omission: `au_v_org_tree` held 133
 * rows on 2026-08-28 against PostgREST's 1,000-row cap. An unbounded select past that cap returns
 * exactly 1,000 rows with NO error and no marker — the array simply ends — so the row count is
 * asserted below rather than trusted. If the organogram ever approaches the cap this throws instead
 * of silently resolving half the company to "no seat", which is the failure this whole module is
 * about.
 *
 * Cached 5 minutes under `sos-reference`, alongside the other geography reads: the org chart does
 * not move during a session, and the board calls this on every render.
 *
 * ── WHAT IS CACHED IS THE ROWS, NEVER THE TREE ──────────────────────────────────────────────────
 * `unstable_cache` SERIALIZES what it stores. `buildOrgPlacementTree` returns an index that is a
 * `Map`, and a Map does not survive that trip — it comes back `{}`. So caching the tree worked
 * exactly once, on the render that filled the cache, and every render after it died with
 * `TypeError: index.get is not a function` inside the page. Nothing in the unit tests could see it:
 * they call `buildOrgPlacementTree` directly, where the Map is a Map. It took loading the page
 * twice.
 *
 * The rows are plain strings and string arrays, so they round-trip intact. Rebuilding the tree from
 * them is one pass over 133 rows on every render, which is nothing next to the read it replaces.
 */
const loadOrgTreeNodes = unstable_cache(
  async (): Promise<OrgTreeNode[]> => {
    const supabase = getSupabaseAdmin();
    // Paged to the last row, never a truncated tree: a handover seat is two rows, so (seat, occupant) closes the order.
    const rows = await fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from("au_v_org_tree")
          .select("seat_id, path, seat_tier, occupant_hr_id, line_code, line_name, region_code, region_name")
          .order("seat_id", { ascending: true }),
      "occupant_hr_id",
    ).catch((error: unknown) => {
      throw toQueryError(error);
    });

    const nodes: OrgTreeNode[] = rows.flatMap((row) => {
      const record = row as Record<string, unknown>;
      const seatId = text(record.seat_id);
      const seatTier = text(record.seat_tier);
      if (!seatId || !seatTier) return [];
      // `path` is a text ARRAY of ancestor seat ids in this view, not a delimited string.
      const rawPath = Array.isArray(record.path) ? record.path : [];
      return [
        {
          seatId,
          path: rawPath.map((entry) => text(entry)).filter((entry): entry is string => entry !== null),
          seatTier,
          occupantHrId: text(record.occupant_hr_id),
          lineCode: text(record.line_code),
          lineName: text(record.line_name),
          regionCode: text(record.region_code),
          regionName: text(record.region_name),
        },
      ];
    });

    return nodes;
  },
  ["crm-org-placement-tree"],
  { revalidate: 300, tags: ["sos-reference"] },
);

/**
 * The organogram, ready to resolve. Built fresh from the cached rows on every call — see the note
 * above for why the tree itself must never be the thing that goes into the cache.
 */
export async function loadOrgPlacementTree(): Promise<OrgPlacementTree> {
  return buildOrgPlacementTree(await loadOrgTreeNodes());
}
