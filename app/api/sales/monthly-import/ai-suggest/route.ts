import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { aiSuggest, hasAiKey, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Suggest-only: ask the AI to match unknown item/territory NAMES to Phoenix products/bricks.
// Returns {raw, code} pairs to pre-fill the inputs. No DB write; only names are sent (no customer data).
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    if (!hasAiKey()) {
      return NextResponse.json(
        { success: false, error: "AI is not configured. Add an OPENAI_API_KEY (or compatible) to enable suggestions." },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { kind?: "product" | "territory"; unknowns?: AiUnknown[] };
    const kind = body.kind === "territory" ? "territory" : "product";
    const unknowns = (Array.isArray(body.unknowns) ? body.unknowns : []).filter((u) => u && u.raw).slice(0, 300);
    if (unknowns.length === 0) return NextResponse.json({ success: true, data: { suggestions: [] } });

    const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
    const candidates = kind === "product"
      ? refs.products.map((p) => ({ code: p.productCode, label: p.productName }))
      : (refs.bricks ?? []).map((b) => ({ code: b.brickId, label: b.brickName }));

    const suggestions = await aiSuggest(kind, unknowns, candidates);
    return NextResponse.json({ success: true, data: { suggestions } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "AI suggestion failed." },
      { status: 500 },
    );
  }
}
