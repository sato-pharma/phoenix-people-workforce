import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  COMPANY_DEFAULT_LAYOUT_KEY,
  isPersonalNavigationLayout,
  layoutKeyFor,
  type LayoutSource,
  type PersonalNavigationLayout,
} from "./personal-layout";

export { layoutKeyFor };
export type { LayoutSource };

/**
 * Storage for navigation layouts — one row per person, plus one reserved row holding the company
 * default that everybody without their own arrangement falls back to.
 *
 * Three rules run through every function here:
 *
 * 1. **The hr_id is always lowercased.** Casing is genuinely inconsistent in this database —
 *    `activity_events.hr_id` is mixed case, the direct-order tables carry both spellings, and a
 *    plain `.eq()` on the raw value once hid 28% of reps' own orders. The table CHECKs that stored
 *    keys are lowercase; these helpers are the other half of that guarantee.
 *
 * 2. **Every READ failure degrades to "no layout".** A missing table, a malformed document, an
 *    unreadable row — all return null, and null means the sidebar renders exactly as the code
 *    defines it. That is why the migration and the code can ship in either order. The one thing a
 *    read must never do is throw on the render path: a cosmetic preference cannot be allowed to
 *    take down navigation. Writes are the opposite and DO throw — they answer a deliberate save,
 *    where a silent failure would report an arrangement stored that was not.
 *
 * 3. **The company-default row is reachable only through the functions named for it.** The personal
 *    save and clear paths refuse the reserved key outright, so no request routed through them can
 *    reach everybody's navigation however its identity resolved.
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

/** Shared by both writers. Never called with a key the caller has not already decided is legal. */
async function upsertLayoutRow(key: string, layout: PersonalNavigationLayout): Promise<void> {
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

/** Shared by both clear paths. */
async function deleteLayoutRow(key: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from(TABLE).delete().eq("hr_id", key);
  if (error && !isMissingRelationError(error)) {
    throw new Error(`Could not reset the navigation layout: ${error.message}`);
  }
}

/**
 * Read one key's stored layout, or null. Never throws.
 *
 * A null return is indistinguishable from "no layout saved" by design — every caller is on a render
 * path where the correct response to any problem is the default sidebar.
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
 * What this viewer's navigation should render from: their own layout if they saved one, otherwise
 * the company default, otherwise null.
 *
 * ONE ROUND TRIP, NOT TWO — this is the whole reason the function exists rather than the shell
 * calling loadPersonalLayout and then falling back. It runs on every admin page render, and every
 * database round trip from here crosses the Atlantic to Frankfurt; a sequential fallback would
 * double the shell's latency for exactly the population that HAS no personal layout, which is
 * almost everybody. Two keys is nowhere near the length at which a PostgREST `.in()` starts
 * silently returning an empty set.
 *
 * PERSONAL ALWAYS WINS. A company default is a starting point for people who have arranged nothing,
 * never an override of someone who has — otherwise publishing one would silently discard every
 * arrangement already saved, which is the one way this feature could destroy work.
 *
 * Never throws, for the same reason loadPersonalLayout doesn't.
 */
export async function loadEffectiveLayout(
  hrId: string | null | undefined,
): Promise<{ layout: PersonalNavigationLayout | null; source: LayoutSource }> {
  const key = layoutKeyFor(hrId);
  const personalKey = key && key !== COMPANY_DEFAULT_LAYOUT_KEY ? key : null;
  const keys = personalKey ? [personalKey, COMPANY_DEFAULT_LAYOUT_KEY] : [COMPANY_DEFAULT_LAYOUT_KEY];

  try {
    const { data, error } = await getSupabaseAdmin().from(TABLE).select("hr_id, layout").in("hr_id", keys);

    if (error) {
      if (!isMissingRelationError(error)) {
        console.warn(`[nav] could not read layouts for ${personalKey ?? "(no key)"}: ${error.message}`);
      }
      return { layout: null, source: null };
    }

    const rows = (data ?? []) as { hr_id?: string | null; layout?: unknown }[];
    const pick = (wanted: string): PersonalNavigationLayout | null => {
      const found = rows.find((row) => row.hr_id === wanted)?.layout;
      return isPersonalNavigationLayout(found) ? found : null;
    };

    const personal = personalKey ? pick(personalKey) : null;
    if (personal) return { layout: personal, source: "personal" };

    const company = pick(COMPANY_DEFAULT_LAYOUT_KEY);
    return company ? { layout: company, source: "company" } : { layout: null, source: null };
  } catch (cause) {
    console.warn(`[nav] effective layout read failed for ${personalKey ?? "(no key)"}`, cause);
    return { layout: null, source: null };
  }
}

/**
 * Write a person's layout.
 *
 * Refuses the reserved company key. layoutOwnerKey already cannot return it, so this is the second
 * of two independent guards on the same failure: a personal save reaching everybody's navigation.
 */
export async function savePersonalLayout(
  hrId: string | null | undefined,
  layout: PersonalNavigationLayout,
): Promise<void> {
  const key = layoutKeyFor(hrId);
  if (!key) throw new Error("Cannot save a navigation layout without an hr_id.");
  if (key === COMPANY_DEFAULT_LAYOUT_KEY) {
    throw new Error("That key is reserved for the company default layout and cannot be saved as a personal one.");
  }
  await upsertLayoutRow(key, layout);
}

/** Reset a person back to the company default (or the code-defined sidebar) by deleting their row. */
export async function clearPersonalLayout(hrId: string | null | undefined): Promise<void> {
  const key = layoutKeyFor(hrId);
  if (!key || key === COMPANY_DEFAULT_LAYOUT_KEY) return;
  await deleteLayoutRow(key);
}

/** The company default itself, or null when none has been published. */
export async function loadCompanyDefaultLayout(): Promise<PersonalNavigationLayout | null> {
  return loadPersonalLayout(COMPANY_DEFAULT_LAYOUT_KEY);
}

/**
 * Publish a company default. Super-Admin-gated at the route; this is the storage half.
 *
 * It changes what people who have saved NOTHING see, and nobody else — every existing personal
 * layout still wins in loadEffectiveLayout. So the blast radius of a bad default is "the standard
 * menu looks different until it is cleared", never lost work.
 */
export async function saveCompanyDefaultLayout(layout: PersonalNavigationLayout): Promise<void> {
  await upsertLayoutRow(COMPANY_DEFAULT_LAYOUT_KEY, layout);
}

/** Withdraw the company default — everyone without a personal layout returns to the code-defined sidebar. */
export async function clearCompanyDefaultLayout(): Promise<void> {
  await deleteLayoutRow(COMPANY_DEFAULT_LAYOUT_KEY);
}
