import { NextResponse } from "next/server";

import { hasGoogleServerKey } from "@/lib/google-maps/server";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { aiSuggest, hasAiKey, type AiKind, type AiReferenceAlias, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { loadBrickCentroids } from "@/lib/sales/normalizer/brick-centroids";
import { normalizeCustomerNameKey } from "@/lib/sales/normalizer/customer-normalize";
import { buildPropagationIndex, propagateSuggestions, type MappedCustomerRow, type PropagatedSuggestion } from "@/lib/sales/normalizer/customer-propagate";
import { NO_KEY_CONFIDENCE, scoreCustomerBrick, type GeoSignals } from "@/lib/sales/normalizer/geo-validate";
import { pharmacyGeoKey, resolvePharmacyGeo } from "@/lib/sales/normalizer/pharmacy-geocode";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Suggest-only: match unknown product / territory / customer rows to Phoenix products / bricks.
// Returns {raw, code, confidence?, source?, matchedFrom?, signals?} pairs the client uses to
// pre-fill the dropdowns. No DB write.
//
// Customer pipeline (product/territory go straight to the AI, unchanged):
//   1. deterministic cross-distributor propagation — exact normalized-name / chain-branch twins
//      already mapped anywhere are suggested without AI (customer-propagate.ts)
//   2. AI for the remainder, with historical mappings as reference context
//   3. geographic scoring for EVERY suggestion — cache-first pharmacy geocoding + brick centroid
//      distance tiers replace the AI's self-reported confidence (geo-validate.ts)

type OutSuggestion = {
  raw: string;
  code: string;
  confidence?: number;
  source?: "ai" | "propagated";
  matchedFrom?: PropagatedSuggestion["matchedFrom"];
  signals?: GeoSignals;
};

const CUSTOMER_MAP_MAX_ROWS = 20000;
const PAGE = 1000;

type CustomerMapRow = {
  customer_name: string | null;
  address: string | null;
  brick_id: string | null;
  customer_code: string | null;
  distributor_code: string | null;
};

async function loadActiveCustomerMap(): Promise<CustomerMapRow[]> {
  const supabase = getSupabaseAdmin();
  const rows: CustomerMapRow[] = [];
  for (let from = 0; from < CUSTOMER_MAP_MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from("source_of_sales_customer_map")
      .select("customer_name,address,brick_id,customer_code,distributor_code")
      .eq("active", true)
      .not("brick_id", "is", null)
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    rows.push(...(data as CustomerMapRow[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");
    if (!hasAiKey()) {
      return NextResponse.json({ success: false, error: "AI is not configured. Add an OPENAI_API_KEY to enable suggestions." }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as { kind?: AiKind; unknowns?: AiUnknown[] };
    const kind: AiKind = body.kind === "territory" ? "territory" : body.kind === "customer" ? "customer" : "product";
    const unknowns = (Array.isArray(body.unknowns) ? body.unknowns : []).filter((u) => u && u.raw).slice(0, 300);
    if (unknowns.length === 0) return NextResponse.json({ success: true, data: { suggestions: [] } });

    const supabase = getSupabaseAdmin();
    const refs = await loadSalesReferenceData();
    const brickMap = new Map((refs.bricks ?? []).map((b) => [b.brickId, b]));

    // Candidate list. Product → catalog. Territory/customer → bricks enriched with "area, region"
    // so the AI has the geography it needs to place a pharmacy or district.
    const candidates = kind === "product"
      ? refs.products.map((p) => ({ code: p.productCode, label: p.productName }))
      : (refs.bricks ?? []).map((b) => ({
          code: b.brickId,
          label: [b.brickName, [b.areaName, b.regionName].filter(Boolean).join(", ")].filter(Boolean).join(" — "),
        }));

    // Full active customer map (paged) — feeds BOTH the propagation index and the AI reference
    // aliases for customer kind.
    const customerMapRows = kind === "customer" ? await loadActiveCustomerMap() : [];

    // Deterministic propagation pre-pass — resolved twins skip the AI entirely.
    let propagated: PropagatedSuggestion[] = [];
    let aiUnknowns = unknowns;
    if (kind === "customer" && customerMapRows.length > 0) {
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

    // Reference aliases — historical raw→code patterns, by kind. Each query is run for effect and the
    // rows read back as a plain shape; the helper keeps Supabase's deep builder types out of Promise.all.
    type Rows = { data: unknown[] | null };
    const run = async (q: unknown): Promise<Rows> => (q ? ((await (q as PromiseLike<Rows>)) ?? { data: [] }) : { data: [] });

    let aliasQuery: unknown = null;
    if (kind === "product") aliasQuery = supabase.from("source_of_sales_product_aliases").select("alias,product_code").eq("active", true).neq("product_code", "IGNORE").limit(1000);
    else if (kind === "territory") aliasQuery = supabase.from("source_of_sales_territory_aliases").select("alias,target_code").eq("active", true).limit(1000);

    let importQuery: unknown = null;
    if (kind === "product") importQuery = supabase.from("source_of_sales_import_rows").select("product_name,product_code").not("product_name", "is", null).not("product_code", "is", null).neq("product_code", "IGNORE").limit(800);
    else if (kind === "customer") importQuery = supabase.from("source_of_sales_import_rows").select("client_name,client_address,brick_id").not("brick_id", "is", null).not("client_name", "is", null).limit(800);

    const [aliasResult, importResult] = await Promise.all([run(aliasQuery), run(importQuery)]);

    const seen = new Set<string>();
    const referenceAliases: AiReferenceAlias[] = [];
    const push = (raw: string, code: string) => {
      const r = String(raw ?? "").trim();
      const c = String(code ?? "").trim();
      if (!r || !c) return;
      // Customer references dedup on the normalized pharmacy name so respellings of the same
      // pharmacy (صيدلية/صيدليه, د/دكتور, ة/ه …) don't eat the limited reference budget.
      const dedupText = kind === "customer" ? normalizeCustomerNameKey(r.split("|")[0]) || r.toLowerCase() : r.toLowerCase();
      const key = `${dedupText}:${c}`;
      if (!seen.has(key)) { seen.add(key); referenceAliases.push({ raw: r, code: c }); }
    };

    for (const row of aliasResult.data ?? []) {
      const r = row as Record<string, unknown>;
      push(String(r.alias ?? ""), String(r.product_code ?? r.target_code ?? ""));
    }
    for (const row of importResult.data ?? []) {
      const r = row as Record<string, unknown>;
      if (kind === "product") {
        push(String(r.product_name ?? ""), String(r.product_code ?? ""));
      } else {
        const text = [String(r.client_name ?? "").trim(), String(r.client_address ?? "").trim()].filter(Boolean).join(" | ");
        push(text, String(r.brick_id ?? ""));
      }
    }
    for (const row of customerMapRows) {
      const text = [String(row.customer_name ?? "").trim(), String(row.address ?? "").trim()].filter(Boolean).join(" | ");
      push(text, String(row.brick_id ?? ""));
    }

    const aiSuggestions = aiUnknowns.length > 0
      ? await aiSuggest(kind, aiUnknowns, candidates, referenceAliases.length ? referenceAliases : undefined)
      : [];

    let suggestions: OutSuggestion[] = [
      ...propagated.map((p) => ({ code: p.code, confidence: p.confidence, matchedFrom: p.matchedFrom, raw: p.raw, source: "propagated" as const })),
      ...aiSuggestions.map((s) => ({ ...s, source: "ai" as const })),
    ];

    // Customer kind: geographic scoring replaces AI self-reported confidence and validates
    // propagated suggestions (blend: geo confirms → boost, geo contradicts → demote).
    if (kind === "customer" && suggestions.length > 0) {
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

    return NextResponse.json({ success: true, data: { suggestions } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "AI suggestion failed." }, { status: 500 });
  }
}
