import { layoutKeyFor } from "@/lib/navigation/personal-layout";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  isPoolColumnLayouts,
  parsePoolColumnLayouts,
  type PoolColumnLayoutRead,
  type PoolColumnLayouts,
} from "./pool-column-layout-rules";

/**
 * Storage for each reader's candidate-pool column layouts — one row per person, every view in one
 * document (owner, 2026-10-19 — "Columns follow you"). The same two rules as the sidebar's own
 * layouts (navigation/personal-layout-store.ts):
 *
 * 1. **The hr_id is always lowercased**, and the table CHECKs it — hr_id casing is inconsistent in
 *    this database, and a row that can only exist in one casing cannot be missed by a lookup.
 * 2. **A read never throws.** A missing table or a missing row is "none" — nothing saved, so the
 *    pool shows each view's own WhatsApp questions, and the code and the migration can ship in either
 *    order. A read that FAILED is "unavailable", never "none" (code review, 19 Oct 2026): answering a
 *    Supabase blip as "nothing saved" let the pool carry a browser's older copy up over the account's
 *    newer layout. A write DOES throw: it answers a deliberate save.
 *
 * The key always comes from the session (the route's `layoutOwnerKey(access)`), never the request.
 */

const TABLE = "ats_pool_column_layouts";

function isMissingRelationError(error: { code?: string | null; message?: string | null }): boolean {
  if (error?.code === "42P01" || error?.code === "PGRST205") return true;
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("does not exist") || message.includes("could not find the table") || message.includes("schema cache");
}

/** This person's saved layouts, "none" when they saved none, "unavailable" when the read failed. Never throws. */
export async function loadPoolColumnLayouts(ownerKey: string | null | undefined): Promise<PoolColumnLayoutRead> {
  const key = layoutKeyFor(ownerKey);
  if (!key) return { kind: "unavailable" };
  try {
    const { data, error } = await getSupabaseAdmin().from(TABLE).select("layouts").eq("hr_id", key).maybeSingle();
    if (error) {
      if (isMissingRelationError(error)) return { kind: "none" };
      console.warn(`[recruitment] could not read pool column layouts for ${key}: ${error.message}`);
      return { kind: "unavailable" };
    }
    const layouts = (data as { layouts?: unknown } | null)?.layouts;
    return layouts === undefined || layouts === null
      ? { kind: "none" }
      : { kind: "saved", layouts: parsePoolColumnLayouts(layouts) };
  } catch (cause) {
    console.warn(`[recruitment] pool column layout read failed for ${key}`, cause);
    return { kind: "unavailable" };
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
