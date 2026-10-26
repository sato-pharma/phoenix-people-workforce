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
// just wrote, the venue and the customers minted with it adopt the area the registered code
// resolved to — and so does a customer this submission COMPLETED that was already stranded off
// every selling territory. That is the owner's standing rule — the registered code beats live GPS —
// applied to the column that governs sight.
//
// TWO SEPARATE GATES, BECAUSE THE TWO SETS ARE NOT ALIKE.
//   * Rows this submission MINTED carry the capturer's area by construction, so the question is
//     about the CAPTURER: only when they have no selling territory of their own is that area a
//     wrong answer worth replacing. A rep already on a real patch is left completely alone — a rep
//     must not have their own customer moved out from under them by a mapping table.
//   * A customer this submission merely COMPLETED predates it, and its area was chosen by whoever
//     created it — possibly on purpose. So the question is about the ROW: it is re-filed only when
//     it sits on no area at all, or on an organisational bucket no rep sells in. Either of those
//     means invisible to the entire field, and nobody chooses that on purpose. A completed customer
//     already on a real territory is never touched, whoever completes it.
//
// Nothing here infers a territory from GPS. An unmatched code yields no claim, and no claim means
// no change.
//
// WHICH CODES ANSWER THE QUESTION. The area comes from every code the submission ATTACHED, minted
// or already on file — never the narrower minted-only list the resolver is handed. A submission
// whose venues were all already on file mints no code at all, and reading only the minted ones
// would leave it unable to answer for either set: not the customer it completed there, and not the
// customer it minted there. A pharmacy already on file has a registered code and that code has
// already been resolved; there is nothing provisional about it. Disagreement between two attached
// codes vetoes everything, as it always has.
//
// WHY IT NEVER THROWS — READ THIS BEFORE CHANGING ANYTHING HERE. The only caller is
// `createMarketingValidationRecord`, and it calls this from INSIDE the try block whose catch
// DELETES every customer and pharmacy the submission just wrote. A throw escaping this module would
// destroy a completed field visit — GPS fix, live shop-front photo and all — and report it as a
// failed save, to fix a mapping column. This is an enrichment of rows that are already correct and
// already committed without it. Every failure path logs and returns null. Same contract, and the
// same reason, as `src/lib/marketing-requests/master-resolution.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/** The methods this needs from a Supabase client — reads and narrow updates, no RPC. */
export type VenueTerritoryClient = Pick<SupabaseClient, "from">;

/** A completed customer as this module weighs it: its id, and the area it is sitting on today. */
type CompletedCustomerRow = { areaId: number | null; id: string };

function uniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean)));
}

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
 * Each area id's code, read fresh. Null when the read failed — unknown, never "no codes". An id with
 * no `areas` row (or a blank code) is simply absent from the map.
 */
export async function areaCodesByIds(
  supabase: VenueTerritoryClient,
  areaIds: ReadonlyArray<number>,
): Promise<Map<number, string> | null> {
  const codeByAreaId = new Map<number, string>();
  if (areaIds.length === 0) return codeByAreaId;
  const areas = await supabase.from("areas").select("id, code").in("id", [...areaIds]);
  if (areas.error) return null;
  for (const row of (areas.data ?? []) as Array<{ code?: string | null; id?: number | string | null }>) {
    const id = Number(row.id);
    const code = String(row.code ?? "").trim();
    if (Number.isFinite(id) && code) codeByAreaId.set(id, code);
  }
  return codeByAreaId;
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
 * The batch form of the question above: which of these area codes are selling territories?
 *
 * Returns the subset that are, or null when the table could not be read — and null must be treated
 * exactly as `isSellingTerritory`'s null is, as "we could not tell", never as "none of them".
 * Reading a failed read as "none" would mark every customer stranded and move the lot.
 */
export async function sellingTerritoryCodes(
  supabase: VenueTerritoryClient,
  areaCodes: readonly string[],
): Promise<Set<string> | null> {
  const codes = Array.from(
    new Set(areaCodes.map((code) => String(code ?? "").trim()).filter(Boolean)),
  );
  if (codes.length === 0) return new Set<string>();
  const { data, error } = await supabase
    .from("source_of_sales_bricks")
    .select("area_code")
    .in("area_code", codes);
  if (error) return null;
  const found = new Set<string>();
  for (const row of (data ?? []) as Array<{ area_code?: string | null }>) {
    const code = String(row.area_code ?? "").trim();
    if (code) found.add(code);
  }
  return found;
}

/**
 * Of the customers this submission completed, which are stranded where no rep can see them?
 *
 * Stranded means: no area at all, or an area that is not a selling territory. Anything else — a
 * real territory, or an area row that could not be read — is left alone, because unknown is never
 * permission to move a row somebody else placed.
 *
 * Returns null when any read failed, which the caller turns into "change nothing".
 */
async function strandedCompletedCustomers(
  supabase: VenueTerritoryClient,
  ids: readonly string[],
): Promise<CompletedCustomerRow[] | null> {
  if (ids.length === 0) return [];
  const customers = await supabase
    .from("marketing_customers")
    .select("id, area_id")
    .in("id", ids);
  if (customers.error) return null;
  const rows = (customers.data ?? []) as Array<{
    area_id?: number | string | null;
    id?: string | null;
  }>;

  const areaIds = Array.from(
    new Set(
      rows
        .map((row) => (row.area_id === null || row.area_id === undefined ? null : Number(row.area_id)))
        .filter((value): value is number => value !== null && Number.isFinite(value)),
    ),
  );
  const codeByAreaId = await areaCodesByIds(supabase, areaIds);
  if (codeByAreaId === null) return null;

  const territorial = await sellingTerritoryCodes(supabase, Array.from(codeByAreaId.values()));
  if (territorial === null) return null;

  const stranded: CompletedCustomerRow[] = [];
  for (const row of rows) {
    const id = String(row.id ?? "").trim();
    if (!id) continue;
    const rawArea = row.area_id === null || row.area_id === undefined ? null : Number(row.area_id);
    if (rawArea !== null && !Number.isFinite(rawArea)) continue;
    if (rawArea === null) {
      // No area is exactly as invisible as a nationwide bucket, and nobody chose it.
      stranded.push({ areaId: null, id });
      continue;
    }
    const code = codeByAreaId.get(rawArea) ?? null;
    // An area id with no readable `areas` row is unknown, not stranded.
    if (code === null) continue;
    if (territorial.has(code)) continue;
    stranded.push({ areaId: rawArea, id });
  }
  return stranded;
}

/**
 * Give a submission's venues the territory their registered code resolved to.
 *
 * `customerIds` / `pharmacyIds` are the rows this submission MINTED; `completedCustomerIds` are
 * customers that already existed and were completed by it. The two sets are gated differently — see
 * the module header.
 *
 * `attachedDistributorCodeIds` is every code the submission attached to a venue — the ones it
 * minted and the ones that were already on file. Deliberately NOT the narrower minted-only list the
 * resolver is handed: a submission whose venues were all already on file mints nothing, and it
 * knows perfectly well where it stands.
 *
 * Returns the `areas.id` actually applied, or null when nothing was changed for any reason: no
 * codes, nothing eligible to move, no agreed master area, an area code the `areas` table does not
 * carry, or any failure at all.
 *
 * Never throws. See the module header.
 */
export async function applyMasterTerritoryToVenues(params: {
  attachedDistributorCodeIds: readonly string[];
  completedCustomerIds: readonly string[];
  customerIds: readonly string[];
  ownerAreaId: number | null;
  pharmacyIds: readonly string[];
  supabase: VenueTerritoryClient;
}): Promise<number | null> {
  const codeIds = uniqueIds(params.attachedDistributorCodeIds);
  const pharmacyIds = uniqueIds(params.pharmacyIds);
  const mintedCustomerIds = uniqueIds(params.customerIds);
  const mintedSet = new Set(mintedCustomerIds);
  // A row cannot be both minted and completed, but the caller assembles the two lists separately
  // and a row appearing in both would be updated twice, under two different guards.
  const completedCustomerIds = uniqueIds(params.completedCustomerIds)
    .filter((id) => !mintedSet.has(id));
  // A codeless venue — a nursery gets exactly one codeless pass — has nothing to derive a territory
  // from. With no code there is no claim to make about ANY of these rows, minted or completed.
  if (codeIds.length === 0) return null;
  if (
    pharmacyIds.length === 0
    && mintedCustomerIds.length === 0
    && completedCustomerIds.length === 0
  ) {
    return null;
  }

  try {
    // STEP 1 — GATE ON THE CAPTURER, for the rows this submission minted. If the capturer is
    // already on a real patch, this module has no business re-filing their own new rows.
    // A capturer with NO area at all falls through deliberately: `area_id` null is just as
    // invisible as a nationwide bucket, and the registered code can answer for both.
    let mintedMayMove = true;
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
      // null = we could not tell. Unknown is not permission to move anything at all.
      if (territorial === null) return null;
      if (territorial) mintedMayMove = false;
    }
    const movablePharmacyIds = mintedMayMove ? pharmacyIds : [];
    const movableMintedCustomerIds = mintedMayMove ? mintedCustomerIds : [];
    if (
      movablePharmacyIds.length === 0
      && movableMintedCustomerIds.length === 0
      && completedCustomerIds.length === 0
    ) {
      return null;
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

    // STEP 4 — GATE ON THE ROW, for the customers that predate this submission.
    const stranded = await strandedCompletedCustomers(params.supabase, completedCustomerIds);
    if (stranded === null) return null;

    // STEP 5 — move only rows that still carry the value this module is entitled to replace. If a
    // parallel session or a human has already put a considered area on the row, it stays.
    let applied = false;
    const applyTo = async (table: string, ids: readonly string[]) => {
      if (ids.length === 0) return;
      if (resolvedAreaId === params.ownerAreaId) return;
      const update = params.supabase
        .from(table)
        .update({ area_id: resolvedAreaId })
        .in("id", ids);
      const guarded = params.ownerAreaId === null
        ? update.is("area_id", null)
        : update.eq("area_id", params.ownerAreaId);
      const { error } = await guarded;
      if (error) throw error;
      applied = true;
    };
    await applyTo("marketing_pharmacies", movablePharmacyIds);
    await applyTo("marketing_customers", movableMintedCustomerIds);

    for (const row of stranded) {
      // Each completed customer is guarded on ITS OWN current area, because that is the value this
      // module read and judged — they do not share one.
      if (row.areaId === resolvedAreaId) continue;
      const update = params.supabase
        .from("marketing_customers")
        .update({ area_id: resolvedAreaId })
        .eq("id", row.id);
      const guarded = row.areaId === null
        ? update.is("area_id", null)
        : update.eq("area_id", row.areaId);
      const { error } = await guarded;
      if (error) throw error;
      applied = true;
    }

    return applied ? resolvedAreaId : null;
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
