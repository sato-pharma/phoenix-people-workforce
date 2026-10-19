import { layoutKeyFor } from "@/lib/navigation/personal-layout";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { isPoolColumnLayouts, parsePoolColumnLayouts, type PoolColumnLayouts } from "./pool-column-layout-rules";

/**
 * Storage for each reader's candidate-pool column layouts — one row per person, every view in one
 * document (owner, 2026-10-19 — "Columns follow you"). The same two rules as the sidebar's own
 * layouts (navigation/personal-layout-store.ts):
 *
 * 1. **The hr_id is always lowercased**, and the table CHECKs it — hr_id casing is inconsistent in
 *    this database, and a row that can only exist in one casing cannot be missed by a lookup.
 * 2. **A read never throws.** A missing table, a missing row or an unreadable one all return null,
 *    which means "nothing saved" — the pool shows each view's own WhatsApp questions. So the code and
 *    the migration can ship in either order. A write DOES throw: it answers a deliberate save.
 *
 * The key always comes from the session (the route's `layoutOwnerKey(access)`), never the request.
 */

const TABLE = "ats_pool_column_layouts";

function isMissingRelationError(error: { code?: string | null; message?: string | null }): boolean {
  if (error?.code === "42P01" || error?.code === "PGRST205") return true;
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("does not exist") || message.includes("could not find the table") || message.includes("schema cache");
}

/** This person's saved layouts, or null when they saved none (or the read failed). Never throws. */
export async function loadPoolColumnLayouts(ownerKey: string | null | undefined): Promise<PoolColumnLayouts | null> {
  const key = layoutKeyFor(ownerKey);
  if (!key) return null;
  try {
    const { data, error } = await getSupabaseAdmin().from(TABLE).select("layouts").eq("hr_id", key).maybeSingle();
    if (error) {
      if (!isMissingRelationError(error)) console.warn(`[recruitment] could not read pool column layouts for ${key}: ${error.message}`);
      return null;
    }
    const layouts = (data as { layouts?: unknown } | null)?.layouts;
    return layouts === undefined || layouts === null ? null : parsePoolColumnLayouts(layouts);
  } catch (cause) {
    console.warn(`[recruitment] pool column layout read failed for ${key}`, cause);
    return null;
  }
}

/** Replace this person's layouts, whole. Throws on a malformed document or a failed write. */
export async function savePoolColumnLayouts(ownerKey: string | null | undefined, layouts: PoolColumnLayouts): Promise<void> {
  const key = layoutKeyFor(ownerKey);
  if (!key) throw new Error("Cannot save a column layout without a signed-in account.");
  if (!isPoolColumnLayouts(layouts)) throw new Error("Refusing to store a malformed column layout.");
  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert({ hr_id: key, layouts, updated_at: new Date().toISOString() }, { onConflict: "hr_id" });
  if (error) {
    if (isMissingRelationError(error)) {
      throw new Error("The ats_pool_column_layouts table does not exist yet — the migration has not been applied to this environment.");
    }
    throw new Error(`Could not save the column layout: ${error.message}`);
  }
}
