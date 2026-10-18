import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadMovedBricks } from "@/lib/sales/master-data/moved-bricks";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { aiSuggest, hasAiKey, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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
        { success: false, error: "AI is not configured. Add an OPENAI_API_KEY (or compatible) or an ANTHROPIC_API_KEY to enable suggestions." },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { kind?: "product" | "territory"; unknowns?: AiUnknown[] };
    const kind = body.kind === "territory" ? "territory" : "product";
    const unknowns = (Array.isArray(body.unknowns) ? body.unknowns : []).filter((u) => u && u.raw).slice(0, 300);
    if (unknowns.length === 0) return NextResponse.json({ success: true, data: { suggestions: [] } });

    const [refs, movedBricks] = await Promise.all([
      loadSalesReferenceData({ includeCustomerBricks: false }),
      kind === "territory" ? loadMovedBricks() : Promise.resolve(new Map<string, string>()),
    ]);
    const candidates = kind === "product"
      ? refs.products.map((p) => ({ code: p.productCode, label: p.productName }))
      // A brick kept only as history after a move is never an answer: it credits the area it left.
      : (refs.bricks ?? []).filter((b) => !movedBricks.has(b.brickId)).map((b) => ({ code: b.brickId, label: b.brickName }));

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
