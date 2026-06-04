import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { aiSuggest, hasGeminiKey, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Suggest-only: ask the AI to match the unknown item/territory NAMES to Phoenix products/bricks.
// Returns {raw, code} pairs the client uses to pre-fill the dropdowns. No DB write; no customer data.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");
    if (!hasGeminiKey()) {
      return NextResponse.json({ success: false, error: "AI is not configured. Add a free GEMINI_API_KEY to enable suggestions." }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as { kind?: "product" | "territory"; unknowns?: AiUnknown[] };
    const kind = body.kind === "territory" ? "territory" : "product";
    const unknowns = (Array.isArray(body.unknowns) ? body.unknowns : []).filter((u) => u && u.raw).slice(0, 300);
    if (unknowns.length === 0) return NextResponse.json({ success: true, data: { suggestions: [] } });

    const refs = await loadSalesReferenceData();
    const candidates = kind === "product"
      ? refs.products.map((p) => ({ code: p.productCode, label: p.productName }))
      : (refs.bricks ?? []).map((b) => ({ code: b.brickId, label: b.brickName }));

    const suggestions = await aiSuggest(kind, unknowns, candidates);
    return NextResponse.json({ success: true, data: { suggestions } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "AI suggestion failed." }, { status: 500 });
  }
}
