import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  isPersonalNavigationLayout,
  layoutKeyFor,
  type PersonalNavigationLayout,
} from "./personal-layout";

export { layoutKeyFor };

/**
 * Storage for one person's own sidebar arrangement.
 *
 * Two rules run through every function here:
 *
 * 1. **The hr_id is always lowercased.** Casing is genuinely inconsistent in this database —
 *    `activity_events.hr_id` is mixed case, the direct-order tables carry both spellings, and a
 *    plain `.eq()` on the raw value once hid 28% of reps' own orders. The table CHECKs that stored
 *    keys are lowercase; these helpers are the other half of that guarantee.
 *
 * 2. **Every failure degrades to "no layout".** A missing table, a malformed document, an
 *    unreadable row — all return null, and null means the sidebar renders exactly as the code
 *    defines it. That is why the migration and the code can ship in either order. The one thing
 *    this must never do is throw on the render path: a cosmetic preference cannot be allowed to
 *    take down navigation.
 */

const TABLE = "nav_personal_layout";

/** True when a Supabase error means the table doesn't exist yet — i.e. the migration hasn't run. */
function isMissingRelationError(error: { code?: string | null; message?: string | null }): boolean {
  if (error?.code === "42P01" || error?.code === "PGRST205") return true;
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("does not exist") ||
    message.includes("could not find the table") ||
    message.includes("schema cache")
  );
}

/**
 * Read a person's saved layout, or null if they have none.
 *
 * Never throws. A null return is indistinguishable from "no layout saved" by design — every caller
 * is on a render path where the correct response to any problem is the default sidebar.
 */
export async function loadPersonalLayout(
  hrId: string | null | undefined,
): Promise<PersonalNavigationLayout | null> {
  const key = layoutKeyFor(hrId);
  if (!key) return null;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from(TABLE)
      .select("layout")
      .eq("hr_id", key)
      .maybeSingle();

    if (error) {
      // A table that isn't there yet is the expected state before the migration is applied, not a
      // fault worth logging on every page render.
      if (!isMissingRelationError(error)) {
        console.warn(`[nav] could not read personal layout for ${key}: ${error.message}`);
      }
      return null;
    }

    const layout = (data as { layout?: unknown } | null)?.layout;
    // Validate rather than trust. A layout written by an older version of this code, or edited by
    // hand in the dashboard, must fall back to the default sidebar instead of rendering as junk.
    return isPersonalNavigationLayout(layout) ? layout : null;
  } catch (cause) {
    console.warn(`[nav] personal layout read failed for ${key}`, cause);
    return null;
  }
}

/**
 * Write a person's layout. Unlike the reader this DOES throw — it is called from a route handler
 * responding to a deliberate save, where a silent failure would tell the owner his arrangement was
 * stored when it was not.
 */
export async function savePersonalLayout(
  hrId: string | null | undefined,
  layout: PersonalNavigationLayout,
): Promise<void> {
  const key = layoutKeyFor(hrId);
  if (!key) throw new Error("Cannot save a navigation layout without an hr_id.");
  if (!isPersonalNavigationLayout(layout)) throw new Error("Refusing to store a malformed navigation layout.");

  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert({ hr_id: key, layout, updated_at: new Date().toISOString() }, { onConflict: "hr_id" });

  if (error) {
    if (isMissingRelationError(error)) {
      throw new Error(
        "The nav_personal_layout table does not exist yet — the migration has not been applied to this environment.",
      );
    }
    throw new Error(`Could not save the navigation layout: ${error.message}`);
  }
}

/** Reset a person back to the code-defined sidebar by deleting their row. */
export async function clearPersonalLayout(hrId: string | null | undefined): Promise<void> {
  const key = layoutKeyFor(hrId);
  if (!key) return;

  const { error } = await getSupabaseAdmin().from(TABLE).delete().eq("hr_id", key);
  if (error && !isMissingRelationError(error)) {
    throw new Error(`Could not reset the navigation layout: ${error.message}`);
  }
}
