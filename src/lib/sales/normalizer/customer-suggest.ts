import { hasGoogleServerKey } from "@/lib/google-maps/server";
import { aiSuggest, type AiReferenceAlias, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { loadBrickCentroids } from "@/lib/sales/normalizer/brick-centroids";
import { normalizeCustomerNameKey } from "@/lib/sales/normalizer/customer-normalize";
import { buildPropagationIndex, propagateSuggestions, type MappedCustomerRow, type PropagatedSuggestion } from "@/lib/sales/normalizer/customer-propagate";
import { NO_KEY_CONFIDENCE, scoreCustomerBrick, type GeoSignals } from "@/lib/sales/normalizer/geo-validate";
import { pharmacyGeoKey, resolvePharmacyGeo } from "@/lib/sales/normalizer/pharmacy-geocode";
import { loadSalesReferenceData, type SalesBrickReference } from "@/lib/sales/monthly-distributor-import";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// The full customer suggestion pipeline, shared by the suggest-only ai-suggest route and the
// auto-map route (which additionally partitions + saves). Server-side end to end — the client
// never gets to assert a confidence.
//
//   1. deterministic cross-distributor propagation (customer-propagate.ts)
//   2. AI for the remainder, with historical mappings as reference context
//   3. geographic scoring for EVERY suggestion (geo-validate.ts) — cache-first pharmacy
//      geocoding + brick centroid distance tiers replace the AI's self-reported confidence

export type CustomerSuggestion = {
  raw: string;
  code: string;
  confidence?: number;
  source: "ai" | "propagated";
  matchedFrom?: PropagatedSuggestion["matchedFrom"];
  signals?: GeoSignals;
};

type CustomerMapDbRow = {
  id: number;
  customer_name: string | null;
  address: string | null;
  brick_id: string | null;
  customer_code: string | null;
  distributor_code: string | null;
};

/**
 * Every active customer→brick mapping.
 *
 * This used to stop after 20,000 rows (`for (from = 0; from < CUSTOMER_MAP_MAX_ROWS; …)`). Production
 * holds 49,745 active mappings, every one with a brick, so 29,745 of them — 59.8% — never reached
 * the resolver. Because the walk is ordered by ascending id, the discarded rows were always the
 * NEWEST: every mapping an admin had recently corrected was invisible, and the customer fell through
 * to the AI branch or stayed unmapped, sending that customer's sales to the wrong area or nowhere.
 *
 * It also treated a query error as end-of-data (`if (error || !data …) break`), which turned a
 * transient failure into a silently short map that looked complete.
 */
async function loadActiveCustomerMap(): Promise<CustomerMapDbRow[]> {
  const supabase = getSupabaseAdmin();
  return fetchAllRowsKeyset<CustomerMapDbRow>(
    () =>
      supabase
        .from("source_of_sales_customer_map")
        .select("id,customer_name,address,brick_id,customer_code,distributor_code")
        .eq("active", true)
        .not("brick_id", "is", null),
    { cursorColumn: "id", cursorOf: (row) => row.id },
  );
}

export async function suggestCustomerBricks(unknowns: AiUnknown[]): Promise<{ suggestions: CustomerSuggestion[]; bricks: Map<string, SalesBrickReference> }> {
  const refs = await loadSalesReferenceData();
  const brickMap = new Map((refs.bricks ?? []).map((b) => [b.brickId, b]));
  const candidates = (refs.bricks ?? []).map((b) => ({
    code: b.brickId,
    label: [b.brickName, [b.areaName, b.regionName].filter(Boolean).join(", ")].filter(Boolean).join(" — "),
  }));

  const customerMapRows = await loadActiveCustomerMap();

  // 1. Deterministic propagation — resolved twins skip the AI entirely.
  let propagated: PropagatedSuggestion[] = [];
  let aiUnknowns = unknowns;
  if (customerMapRows.length > 0) {
    const mapped: MappedCustomerRow[] = customerMapRows.map((r) => ({
      address: String(r.address ?? ""),
      brickId: String(r.brick_id ?? "").trim(),
      customerCode: String(r.customer_code ?? ""),
      customerName: String(r.customer_name ?? ""),
      distributorCode: String(r.distributor_code ?? ""),
    }));
    const index = buildPropagationIndex(mapped);
    // Only propagate bricks that still exist in the master — the map can hold retired ids.
    propagated = propagateSuggestions(unknowns, index).filter((p) => brickMap.has(p.code));
    const propagatedRaws = new Set(propagated.map((p) => p.raw));
    aiUnknowns = unknowns.filter((u) => !propagatedRaws.has(u.raw));
  }

  // 2. Reference aliases for the AI: historical import rows + the customer map, deduped on the
  // normalized pharmacy name so respellings don't eat the limited reference budget.
  const supabase = getSupabaseAdmin();
  const referenceAliases: AiReferenceAlias[] = [];
  if (aiUnknowns.length > 0) {
    const seen = new Set<string>();
    const push = (raw: string, code: string) => {
      const r = String(raw ?? "").trim();
      const c = String(code ?? "").trim();
      if (!r || !c) return;
      const dedupText = normalizeCustomerNameKey(r.split("|")[0]) || r.toLowerCase();
      const key = `${dedupText}:${c}`;
      if (!seen.has(key)) { seen.add(key); referenceAliases.push({ raw: r, code: c }); }
    };
    try {
      const { data } = await supabase
        .from("source_of_sales_import_rows")
        .select("client_name,client_address,brick_id")
        .not("brick_id", "is", null)
        .not("client_name", "is", null)
        .limit(800);
      for (const row of data ?? []) {
        const r = row as Record<string, unknown>;
        const text = [String(r.client_name ?? "").trim(), String(r.client_address ?? "").trim()].filter(Boolean).join(" | ");
        push(text, String(r.brick_id ?? ""));
      }
    } catch { /* reference context is optional */ }
    for (const row of customerMapRows) {
      const text = [String(row.customer_name ?? "").trim(), String(row.address ?? "").trim()].filter(Boolean).join(" | ");
      push(text, String(row.brick_id ?? ""));
    }
  }

  const aiSuggestions = aiUnknowns.length > 0
    ? await aiSuggest("customer", aiUnknowns, candidates, referenceAliases.length ? referenceAliases : undefined)
    : [];

  let suggestions: CustomerSuggestion[] = [
    ...propagated.map((p) => ({ code: p.code, confidence: p.confidence, matchedFrom: p.matchedFrom, raw: p.raw, source: "propagated" as const })),
    ...aiSuggestions.map((s) => ({ ...s, source: "ai" as const })),
  ];

  // 3. Geographic scoring — replaces AI self-reported confidence and validates propagation
  // (blend: geo confirms → boost capped at 97, geo contradicts → demote to 45).
  if (suggestions.length > 0) {
    const unknownMap = new Map(unknowns.map((u) => [u.raw, u]));
    if (!hasGoogleServerKey()) {
      suggestions = suggestions.map((s) => (s.source === "ai" ? { ...s, confidence: NO_KEY_CONFIDENCE } : s));
    } else {
      const geoEntries = suggestions
        .map((s) => unknownMap.get(s.raw))
        .filter((u): u is AiUnknown => u != null)
        .map((u) => ({ address: u.rawAddress ?? "", name: u.rawName ?? u.raw }));
      const [pharmacyGeoByKey, centroids] = await Promise.all([
        resolvePharmacyGeo(geoEntries),
        loadBrickCentroids(),
      ]);
      suggestions = suggestions.map((s) => {
        const brick = brickMap.get(s.code);
        const u = unknownMap.get(s.raw);
        if (!brick || !u) return s;
        const geo = pharmacyGeoByKey.get(pharmacyGeoKey(u.rawName ?? u.raw, u.rawAddress ?? "")) ?? null;
        const { confidence, signals } = scoreCustomerBrick(geo, brick, centroids.get(s.code));
        if (s.source === "propagated") {
          const base = s.confidence ?? 90;
          const blended = confidence >= 80
            ? Math.min(97, Math.max(base, confidence))
            : confidence <= 20
            ? 45
            : base;
          return { ...s, confidence: blended, signals };
        }
        return { ...s, confidence, signals };
      });
    }
  }

  return { bricks: brickMap, suggestions };
}
