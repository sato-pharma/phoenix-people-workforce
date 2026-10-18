import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { aiSuggest, hasAiKey, type AiKind, type AiReferenceAlias, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { suggestCustomerBricks } from "@/lib/sales/normalizer/customer-suggest";
import { loadMovedBricks } from "@/lib/sales/master-data/moved-bricks";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Customer kind runs the full pipeline (customer-map load + AI batches + up to 150 live
// geocodes) — identical work to the auto-map route. Without the extended budget a first-time
// run (nothing cached yet) overran the default limit and Vercel returned its non-JSON error
// page, which surfaced to the operator as "Unexpected token 'A' … is not valid JSON".
export const maxDuration = 300;

// Suggest-only: match unknown product / territory / customer rows to Phoenix products / bricks.
// Returns {raw, code, confidence?, source?, matchedFrom?, signals?} pairs the client uses to
// pre-fill the dropdowns. No DB write.
//
// Customer kind delegates to the shared pipeline in customer-suggest.ts (free steps → stored AI
// answers → AI → geographic scoring) — the same pipeline the auto-map route uses, so what the
// operator previews is exactly what auto-apply would evaluate. `freeOnly: true` stops before the
// AI: the workspace sends every customer that way first, then only the rest with the AI. Product
// and territory go straight to the AI, unchanged.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => ({}))) as { freeOnly?: boolean; kind?: AiKind; unknowns?: AiUnknown[] };
    const kind: AiKind = body.kind === "territory" ? "territory" : body.kind === "customer" ? "customer" : "product";
    // The free customer pass needs no AI key; everything else does.
    const freeOnly = kind === "customer" && body.freeOnly === true;
    if (!freeOnly && !hasAiKey()) {
      return NextResponse.json({ success: false, error: "AI is not configured. Add an OPENAI_API_KEY or an ANTHROPIC_API_KEY to enable suggestions." }, { status: 400 });
    }
    const unknowns = (Array.isArray(body.unknowns) ? body.unknowns : []).filter((u) => u && u.raw).slice(0, 300);
    if (unknowns.length === 0) return NextResponse.json({ success: true, data: { suggestions: [] } });

    if (kind === "customer") {
      const { suggestions } = await suggestCustomerBricks(unknowns, { ai: !freeOnly });
      return NextResponse.json({ success: true, data: { suggestions } });
    }

    const supabase = getSupabaseAdmin();
    const [refs, movedBricks] = await Promise.all([
      loadSalesReferenceData({ includeCustomerBricks: false }),
      kind === "territory" ? loadMovedBricks() : Promise.resolve(new Map<string, string>()),
    ]);

    const candidates = kind === "product"
      ? refs.products.map((p) => ({ code: p.productCode, label: p.productName }))
      // A brick kept only as history after a move is never an answer: it credits the area it left.
      : (refs.bricks ?? []).filter((b) => !movedBricks.has(b.brickId)).map((b) => ({
          code: b.brickId,
          label: [b.brickName, [b.areaName, b.regionName].filter(Boolean).join(", ")].filter(Boolean).join(" — "),
        }));

    // Reference aliases — historical raw→code patterns, by kind. Each query is run for effect and the
    // rows read back as a plain shape; the helper keeps Supabase's deep builder types out of Promise.all.
    type Rows = { data: unknown[] | null };
    const run = async (q: unknown): Promise<Rows> => (q ? ((await (q as PromiseLike<Rows>)) ?? { data: [] }) : { data: [] });

    let aliasQuery: unknown = null;
    if (kind === "product") aliasQuery = supabase.from("source_of_sales_product_aliases").select("alias,product_code").eq("active", true).neq("product_code", "IGNORE").limit(1000);
    else aliasQuery = supabase.from("source_of_sales_territory_aliases").select("alias,target_code").eq("active", true).limit(1000);

    let importQuery: unknown = null;
    if (kind === "product") importQuery = supabase.from("source_of_sales_import_rows").select("product_name,product_code").not("product_name", "is", null).not("product_code", "is", null).neq("product_code", "IGNORE").limit(800);

    const [aliasResult, importResult] = await Promise.all([run(aliasQuery), run(importQuery)]);

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
      push(String(r.product_name ?? ""), String(r.product_code ?? ""));
    }

    const suggestions = await aiSuggest(kind, unknowns, candidates, referenceAliases.length ? referenceAliases : undefined);
    return NextResponse.json({ success: true, data: { suggestions } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "AI suggestion failed.") }, { status: 500 });
  }
}
