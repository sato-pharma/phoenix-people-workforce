import { logWarning } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// A moved brick stays in the master as history (20260918150000): active, so published months keep
// resolving, and pointing at the brick that replaced it through superseded_by_brick_id. No new mapping
// may pick one — its pharmacies' sales would credit the area the brick left.
//
// Kept apart from brick-moves.ts, which imports the rollup refresh: the mapping save reads this, and
// the rollup refresh's module imports the mapping module.

// Every brick kept as history, pointing at the brick it moved to. A failed read answers an empty map
// (logged): the pickers then offer the history bricks too, which is how they behaved before a move
// kept them, rather than failing the whole page.
export async function loadMovedBricks(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  try {
    const rows = await fetchAllRows<{ brick_id: string | null; superseded_by_brick_id: string | null }>(
      () =>
        supabase
          .from("source_of_sales_bricks")
          .select("brick_id,superseded_by_brick_id")
          .not("superseded_by_brick_id", "is", null),
      "brick_id",
    );
    const moved = new Map<string, string>();
    for (const row of rows) {
      const from = String(row.brick_id ?? "").trim();
      const to = String(row.superseded_by_brick_id ?? "").trim();
      if (from && to && from !== to) moved.set(from, to);
    }
    return moved;
  } catch (error) {
    logWarning("Could not read the moved bricks; the brick pickers offer history bricks too.", { error });
    return new Map();
  }
}
