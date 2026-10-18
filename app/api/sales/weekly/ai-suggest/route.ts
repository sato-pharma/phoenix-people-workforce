import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { aiSuggest, hasAiKey, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Weekly AI-suggest: match unknown weekly item names/codes to Phoenix products. Same suggester the
// monthly normalizer uses (one AI engine across the module). Suggest-only — no DB write.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");
    if (!hasAiKey()) {
      return NextResponse.json(
        { success: false, error: "AI is not configured. Add an OPENAI_API_KEY (or compatible) or an ANTHROPIC_API_KEY to enable suggestions." },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { unknowns?: AiUnknown[] };
    const unknowns = (Array.isArray(body.unknowns) ? body.unknowns : []).filter((u) => u && u.raw).slice(0, 300);
    if (unknowns.length === 0) return NextResponse.json({ success: true, data: { suggestions: [] } });

    const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
    const candidates = refs.products.map((p) => ({ code: p.productCode, label: p.productName }));
    const suggestions = await aiSuggest("product", unknowns, candidates);
    return NextResponse.json({ success: true, data: { suggestions } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "AI suggestion failed.") }, { status: 500 });
  }
}
