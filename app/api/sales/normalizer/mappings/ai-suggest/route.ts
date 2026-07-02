import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { aiSuggest, hasAiKey, type AiKind, type AiReferenceAlias, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { geocodeValidateCustomerBrick } from "@/lib/sales/normalizer/geo-validate";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Suggest-only: ask the AI to match unknown product / territory / customer rows to Phoenix
// products / bricks. Returns {raw, code} pairs the client uses to pre-fill the dropdowns. No DB write.
//
// Context loaded per kind so the AI pattern-matches from everything already learned:
//  - product:   product catalog + all product aliases + resolved import product_name→product_code
//  - territory: bricks (with area+region) + all territory aliases
//  - customer:  bricks (with area+region) + customer_map (name/address→brick) + import client→brick
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

    // Candidate list. Product → catalog. Territory/customer → bricks enriched with "area, region"
    // so the AI has the geography it needs to place a pharmacy or district.
    const candidates = kind === "product"
      ? refs.products.map((p) => ({ code: p.productCode, label: p.productName }))
      : (refs.bricks ?? []).map((b) => ({
          code: b.brickId,
          label: [b.brickName, [b.areaName, b.regionName].filter(Boolean).join(", ")].filter(Boolean).join(" — "),
        }));

    // Reference aliases — historical raw→code patterns, by kind. Each query is run for effect and the
    // rows read back as a plain shape; the helper keeps Supabase's deep builder types out of Promise.all.
    type Rows = { data: unknown[] | null };
    // Each query is assigned to a `let: unknown` so TS never computes a union of the deep Supabase
    // builder generics (which overflows the instantiation depth). run() awaits the thenable.
    const run = async (q: unknown): Promise<Rows> => (q ? ((await (q as PromiseLike<Rows>)) ?? { data: [] }) : { data: [] });

    let aliasQuery: unknown = null;
    if (kind === "product") aliasQuery = supabase.from("source_of_sales_product_aliases").select("alias,product_code").eq("active", true).neq("product_code", "IGNORE").limit(1000);
    else if (kind === "territory") aliasQuery = supabase.from("source_of_sales_territory_aliases").select("alias,target_code").eq("active", true).limit(1000);

    let importQuery: unknown = null;
    if (kind === "product") importQuery = supabase.from("source_of_sales_import_rows").select("product_name,product_code").not("product_name", "is", null).not("product_code", "is", null).neq("product_code", "IGNORE").limit(800);
    else if (kind === "customer") importQuery = supabase.from("source_of_sales_import_rows").select("client_name,client_address,brick_id").not("brick_id", "is", null).not("client_name", "is", null).limit(800);

    let customerMapQuery: unknown = null;
    if (kind === "customer") customerMapQuery = supabase.from("source_of_sales_customer_map").select("customer_name,address,brick_id").eq("active", true).not("brick_id", "is", null).limit(1000);

    const [aliasResult, importResult, customerMapResult] = await Promise.all([run(aliasQuery), run(importQuery), run(customerMapQuery)]);

    const seen = new Set<string>();
    const referenceAliases: AiReferenceAlias[] = [];
    const push = (raw: string, code: string) => {
      const r = String(raw ?? "").trim();
      const c = String(code ?? "").trim();
      if (!r || !c) return;
      const key = `${r.toLowerCase()}:${c}`;
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
        // customer: combine name + address as the reference text → brick
        const text = [String(r.client_name ?? "").trim(), String(r.client_address ?? "").trim()].filter(Boolean).join(" | ");
        push(text, String(r.brick_id ?? ""));
      }
    }
    for (const row of customerMapResult.data ?? []) {
      const r = row as Record<string, unknown>;
      const text = [String(r.customer_name ?? "").trim(), String(r.address ?? "").trim()].filter(Boolean).join(" | ");
      push(text, String(r.brick_id ?? ""));
    }

    const suggestions = await aiSuggest(kind, unknowns, candidates, referenceAliases.length ? referenceAliases : undefined);

    if (kind === "customer") {
      const brickMap = new Map((refs.bricks ?? []).map((b) => [b.brickId, b]));
      const unknownMap = new Map(unknowns.map((u) => [u.raw, u]));
      const CONCURRENCY = 8;
      for (let i = 0; i < suggestions.length; i += CONCURRENCY) {
        const chunk = suggestions.slice(i, i + CONCURRENCY);
        await Promise.all(
          chunk.map(async (s) => {
            const brick = brickMap.get(s.code);
            const u = unknownMap.get(s.raw);
            if (!brick || !u) return;
            try {
              const result = await geocodeValidateCustomerBrick(
                u.rawName ?? u.raw,
                u.rawAddress ?? "",
                brick,
              );
              s.confidence = result.confidence;
            } catch {
              s.confidence = s.confidence != null ? Math.round(s.confidence * 0.5) : 30;
            }
          }),
        );
      }
    }

    return NextResponse.json({ success: true, data: { suggestions } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "AI suggestion failed." }, { status: 500 });
  }
}
