import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { aiSuggest, hasAiKey, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { listWeeklyAiReferenceAliases, listWeeklyNormalizeReferences } from "@/lib/sales/weekly/normalizer";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pre-fill the weekly mapping dropdowns. Suggest-only — nothing is written; the operator confirms
// each pick and presses Save. Runs on the same AI engine as the monthly normalizer (one engine for
// the whole Sales module): raw item names match against the master product list, and raw branch
// names match against the master region list via the "territory" (place-name) prompt.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");
    if (!hasAiKey()) {
      return NextResponse.json(
        { success: false, error: "AI is not configured. Add an OPENAI_API_KEY (or compatible) to enable suggestions." },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { distributorCode?: string; kind?: string; unknowns?: AiUnknown[] };
    const kind = body.kind === "branch" ? "branch" : "product";
    const distributorCode = String(body.distributorCode ?? "").trim();
    const unknowns = (Array.isArray(body.unknowns) ? body.unknowns : []).filter((u) => u && u.raw).slice(0, 300);
    if (unknowns.length === 0) return NextResponse.json({ success: true, data: { suggestions: [] } });

    // The model gets the master list AND what this dictionary has already been taught, so a value
    // an operator answered last week steers the guess instead of being re-derived from scratch.
    const [references, referenceAliases] = await Promise.all([
      listWeeklyNormalizeReferences(),
      listWeeklyAiReferenceAliases(kind, distributorCode),
    ]);
    const history = referenceAliases.length > 0 ? referenceAliases : undefined;
    const suggestions =
      kind === "branch"
        ? await aiSuggest(
            "territory",
            unknowns,
            references.regions.map((region) => ({ code: region.regionCode, label: region.regionName })),
            history,
          )
        : await aiSuggest(
            "product",
            unknowns,
            references.products.map((product) => ({ code: product.code, label: product.name })),
            history,
          );
    return NextResponse.json({ success: true, data: { suggestions } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "AI suggestion failed.") }, { status: 500 });
  }
}
