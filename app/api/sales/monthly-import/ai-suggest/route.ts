import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadMovedBricks } from "@/lib/sales/master-data/moved-bricks";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { aiSuggest, hasAiKey, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { suggestProducts } from "@/lib/sales/normalizer/product-suggest";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Suggest-only: match unknown item / territory NAMES to Phoenix products / bricks. No DB write; only
// names and item codes are sent to the AI (no customer data).
//
// Products run the shared pipeline in product-suggest.ts: a sister distributor's mapping of the same
// item code, then the same name mapped anywhere, then the one product of the same strength, and only
// then the AI — shown every product with the names distributors already use for it. Each answer comes
// back as {raw, code, confidence, source, reason}. The free steps need no AI key. Territories go
// straight to the AI, unchanged.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => ({}))) as { distributorCode?: string; kind?: "product" | "territory"; unknowns?: AiUnknown[] };
    const kind = body.kind === "territory" ? "territory" : "product";
    if (kind === "territory" && !hasAiKey()) {
      return NextResponse.json(
        { success: false, error: "AI is not configured. Add an OPENAI_API_KEY (or compatible) or an ANTHROPIC_API_KEY to enable suggestions." },
        { status: 400 },
      );
    }
    const unknowns = (Array.isArray(body.unknowns) ? body.unknowns : []).filter((u) => u && u.raw).slice(0, 300);
    if (unknowns.length === 0) return NextResponse.json({ success: true, data: { suggestions: [] } });

    if (kind === "product") {
      const distributorCode = String(body.distributorCode ?? "").trim();
      // Paged: one read stops at a fixed row count with no error, and the mapping table only grows.
      const [refs, aliasRows] = await Promise.all([
        loadSalesReferenceData({ includeCustomerBricks: false }),
        fetchAllRows<{ alias: string | null; distributor_code: string | null; product_code: string | null }>(
          () => getSupabaseAdmin().from("source_of_sales_product_aliases").select("alias,distributor_code,product_code").eq("active", true),
          "id",
        ).catch((error: unknown) => {
          throw new Error(`Could not read the product mappings: ${toQueryError(error).message}`);
        }),
      ]);
      const aliases = aliasRows.map((row) => ({
        alias: String(row.alias ?? ""),
        distributorCode: String(row.distributor_code ?? ""),
        productCode: String(row.product_code ?? ""),
      }));
      const suggestions = await suggestProducts(
        unknowns.map((u) => ({ raw: u.raw, rawName: u.rawName })),
        {
          aliases,
          catalog: refs.products.map((p) => ({ code: p.productCode, family: p.family, line: p.line, name: p.productName })),
          distributorCode,
          distributorNames: new Map(refs.distributors.map((d) => [d.code.trim().toUpperCase(), d.name])),
        },
        hasAiKey() ? (items, candidates) => aiSuggest("product", items, candidates) : null,
      );
      return NextResponse.json({ success: true, data: { suggestions } });
    }

    const [refs, movedBricks] = await Promise.all([
      loadSalesReferenceData({ includeCustomerBricks: false }),
      kind === "territory" ? loadMovedBricks() : Promise.resolve(new Map<string, string>()),
    ]);
    // A brick kept only as history after a move is never an answer: it credits the area it left.
    const candidates = (refs.bricks ?? []).filter((b) => !movedBricks.has(b.brickId)).map((b) => ({ code: b.brickId, label: b.brickName }));

    const suggestions = await aiSuggest(kind, unknowns, candidates);
    return NextResponse.json({ success: true, data: { suggestions } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "AI suggestion failed.") },
      { status: 500 },
    );
  }
}
