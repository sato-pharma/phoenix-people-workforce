import type { SupabaseClient } from "@supabase/supabase-js";

import { logWarning } from "@/lib/observability/log";

// ─────────────────────────────────────────────────────────────────────────────
// A captured venue belongs to the territory it STANDS IN, not to the person who photographed it.
//
// WHAT WAS WRONG. Both insert sites in `createMarketingValidationRecord` stamp
// `area_id: owner.areaId ?? null` — the capturing employee's own area. For a medical rep that is
// right: their area IS their patch. For head office it is wrong, and silently so. Since PR #2223
// (`canSeeMarketingCustomer`) that stored `area_id` is what decides WHO CAN SEE the customer, so a
// venue filed under a nationwide bucket is not a cosmetic mapping gap — it is a customer nobody in
// the field can see, sitting in a report that looks complete.
//
// Measured on production 2026-08-23: Nahed Hattab (`A-10`, Product Manager, area `egypt`) captured
// pharmacy هاني ابو العزم and two doctors in Kafr El Dawwar. All three were filed under "Egypt"
// while the registered distributor code resolved EXACTLY to `AB5` — Behira 2 — and the matched
// brick was `B114-87`, كفر الدوار. Three independent sources said Beheira; the row said Egypt.
// 33 active employees sit on an area that is not a selling territory (head_office 13, egypt 7,
// delta_2 3, giza 3, cairo 3, upper_egypt 2, alex_bhr 2), so this was not one unlucky capture.
//
// WHAT THIS DOES. After the Source-of-Sales master resolver has run over the codes a submission
// just wrote, and ONLY when the capturer's own area is not a selling territory, the venue and the
// customers minted with it adopt the area the registered code resolved to. That is the owner's
// standing rule — the registered code beats live GPS — applied to the column that governs sight.
//
// WHAT IT DELIBERATELY DOES NOT DO. A capturer who already sits on a real territory is left
// completely alone: their area is their patch, and a rep must not have their own customer moved out
// from under them by a mapping table. Nothing here infers a territory from GPS either — an
// unmatched code yields no claim, and no claim means no change.
//
// WHY IT NEVER THROWS — READ THIS BEFORE CHANGING ANYTHING HERE. The only caller is
// `createMarketingValidationRecord`, and it calls this from INSIDE the try block whose catch
// DELETES every customer and pharmacy the submission just wrote. A throw escaping this module would
// destroy a completed field visit — GPS fix, live shop-front photo and all — and report it as a
// failed save, to fix a mapping column. This is an enrichment of rows that are already correct and
// already committed without it. Every failure path logs and returns null. Same contract, and the
// same reason, as `src/lib/marketing-requests/master-resolution.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/** The methods this needs from a Supabase client — reads and two narrow updates, no RPC. */
export type VenueTerritoryClient = Pick<SupabaseClient, "from">;

/**
 * The one area code every supplied code row agrees on, or null when they do not speak with one
 * voice.
 *
 * The agreement test is deliberately as strict as the resolver's own, in
 * `20260819234500_resolver_keeps_an_agreed_area.sql`: agreement requires BOTH that there is exactly
 * one distinct value AND that no row is missing it. A submission that writes two codes where only
 * one resolved is a submission whose territory is not established, and a single row must never be
 * allowed to speak for the whole set.
 *
 * An empty list is null — there is nothing to agree about.
 */
export function agreedMasterAreaCode(
  codes: readonly (string | null | undefined)[],
): string | null {
  if (codes.length === 0) return null;
  const seen = new Set<string>();
  for (const raw of codes) {
    const code = String(raw ?? "").trim();
    // A row the resolver could not place vetoes the whole set rather than being skipped over.
    if (!code) return null;
    seen.add(code);
  }
  if (seen.size !== 1) return null;
  return seen.values().next().value ?? null;
}

/**
 * Is this area one a rep actually sells in?
 *
 * Decided from data, never from a hardcoded list or a shape-of-the-string guess: the selling
 * territories are exactly the area codes present in `source_of_sales_bricks`, which is the
 * authority for territory in this repository. Everything else — `head_office`, `egypt`, `cairo`,
 * `giza`, `delta_2`, `upper_egypt`, `alex_bhr` — is an organisational bucket that no brick belongs
 * to. Verified against production 2026-08-23: the split is exact, with no area falling on the wrong
 * side of it.
 *
 * A blank code is not a territory. An unreadable table is reported by the caller as "unknown", and
 * unknown means we change nothing.
 */
export async function isSellingTerritory(
  supabase: VenueTerritoryClient,
  areaCode: string | null,
): Promise<boolean | null> {
  const code = String(areaCode ?? "").trim();
  if (!code) return false;
  const { data, error } = await supabase
    .from("source_of_sales_bricks")
    .select("area_code")
    .eq("area_code", code)
    .limit(1);
  if (error) return null;
  return (data ?? []).length > 0;
}

/**
 * Give the venues a submission just minted the territory their registered code resolved to, when —
 * and only when — the capturer's own area is not one.
 *
 * Returns the `areas.id` actually applied, or null when nothing was changed for any reason: no
 * codes, a capturer already on a real territory, no agreed master area, an area code the `areas`
 * table does not carry, or any failure at all.
 *
 * Never throws. See the module header.
 */
export async function applyMasterTerritoryToVenues(params: {
  customerIds: readonly string[];
  distributorCodeIds: readonly string[];
  ownerAreaId: number | null;
  pharmacyIds: readonly string[];
  supabase: VenueTerritoryClient;
}): Promise<number | null> {
  const codeIds = Array.from(
    new Set(params.distributorCodeIds.map((id) => String(id ?? "").trim()).filter(Boolean)),
  );
  const pharmacyIds = Array.from(new Set(params.pharmacyIds.filter(Boolean)));
  const customerIds = Array.from(new Set(params.customerIds.filter(Boolean)));
  // A codeless venue — a nursery gets exactly one codeless pass — has nothing to derive a territory
  // from, and a submission that minted nothing has nothing to move.
  if (codeIds.length === 0) return null;
  if (pharmacyIds.length === 0 && customerIds.length === 0) return null;

  try {
    // STEP 1 — is the capturer already on a real patch? If so this module has no business here.
    // A capturer with NO area at all falls through deliberately: `area_id` null is just as
    // invisible as a nationwide bucket, and the registered code can answer for both.
    if (params.ownerAreaId !== null) {
      const ownerArea = await params.supabase
        .from("areas")
        .select("code")
        .eq("id", params.ownerAreaId)
        .maybeSingle();
      if (ownerArea.error) return null;
      const territorial = await isSellingTerritory(
        params.supabase,
        (ownerArea.data as { code?: string | null } | null)?.code ?? null,
      );
      // null = we could not tell. Unknown is not permission to move a rep's customer.
      if (territorial === null || territorial) return null;
    }

    // STEP 2 — what did the master say? Read back rather than passed in, because the resolver is a
    // database function: these columns did not exist in this process before it ran.
    const codeRows = await params.supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("mapped_area_code")
      .in("id", codeIds);
    if (codeRows.error) return null;
    const areaCode = agreedMasterAreaCode(
      ((codeRows.data ?? []) as Array<{ mapped_area_code?: string | null }>).map(
        (row) => row.mapped_area_code ?? null,
      ),
    );
    if (!areaCode) return null;

    // STEP 3 — the master speaks in area CODES; the venue is filed by area ID. An active row only:
    // the consolidations of 2026-08-22 left retired duplicates behind under the same names, and
    // filing a fresh capture into one of those would be a different flavour of invisible.
    const areaRow = await params.supabase
      .from("areas")
      .select("id")
      .eq("code", areaCode)
      .eq("is_active", true)
      .maybeSingle();
    if (areaRow.error) return null;
    const areaId = (areaRow.data as { id?: number | string | null } | null)?.id ?? null;
    if (areaId === null || areaId === undefined) return null;
    const resolvedAreaId = Number(areaId);
    if (!Number.isFinite(resolvedAreaId)) return null;
    if (resolvedAreaId === params.ownerAreaId) return null;

    // STEP 4 — move only rows that still carry the value this module is entitled to replace. If a
    // parallel session or a human has already put a considered area on the row, it stays.
    const applyTo = async (table: string, ids: readonly string[]) => {
      if (ids.length === 0) return;
      const update = params.supabase
        .from(table)
        .update({ area_id: resolvedAreaId })
        .in("id", ids);
      const guarded = params.ownerAreaId === null
        ? update.is("area_id", null)
        : update.eq("area_id", params.ownerAreaId);
      const { error } = await guarded;
      if (error) throw error;
    };
    await applyTo("marketing_pharmacies", pharmacyIds);
    await applyTo("marketing_customers", customerIds);

    return resolvedAreaId;
  } catch (error) {
    // WARNING, not ERROR: the venue is saved, correct and usable — it is simply filed under the
    // capturer's area, which is exactly where it would have been filed before this module existed.
    // Re-running is safe and idempotent.
    logWarning(
      "Marketing venue territory adoption failed (non-fatal — the capture is saved and keeps the capturer's area)",
      {
        labels: {
          codeCount: String(codeIds.length),
          event: "marketing_venue_territory_failed",
          reason: error instanceof Error ? error.message : String(error),
        },
      },
    );
    return null;
  }
}
