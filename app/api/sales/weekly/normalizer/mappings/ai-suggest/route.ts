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
// names match against the master territory list via the "territory" (place-name) prompt.
//
// A BRANCH IS SUGGESTED AS AN AREA FIRST, AND THE REGION IS DERIVED FROM IT.
// Weekly sales arrive at distributor-BRANCH grain, so a branch is the only place an area can be
// attached — and until it carries one, nothing downstream can cut weekly by area, or resolve the
// lines whose organogram splits a region across two managers (Anti Infective's Upper Egypt).
// This route used to suggest ONLY a region, which left every area to be typed by hand, one branch
// at a time; measured 2026-08-26, 68.4% of tracked-line value sat on branches with no area.
//
// Deriving the region from the suggested area (rather than suggesting both independently) is what
// keeps the pair valid: an area must sit inside its branch's region, and the save rejects a
// mismatched pair rather than quietly fixing it. Branches the area pass cannot place confidently
// fall back to a region-only suggestion — exactly the previous behaviour, so nothing regresses.
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

    const body = (await request.json().catch(() => ({}))) as { distributorCode?: string; kind?: string; unknowns?: AiUnknown[] };
    const kind = body.kind === "branch" ? "branch" : "product";
    const distributorCode = String(body.distributorCode ?? "").trim();
    const unknowns = (Array.isArray(body.unknowns) ? body.unknowns : []).filter((u) => u && u.raw).slice(0, 300);
    if (unknowns.length === 0) return NextResponse.json({ success: true, data: { suggestions: [], areaSuggestions: [] } });

    // The model gets the master list AND what this dictionary has already been taught, so a value
    // an operator answered last week steers the guess instead of being re-derived from scratch.
    const [references, referenceAliases] = await Promise.all([
      listWeeklyNormalizeReferences(),
      listWeeklyAiReferenceAliases(kind, distributorCode),
    ]);
    const history = referenceAliases.length > 0 ? referenceAliases : undefined;

    if (kind === "product") {
      const suggestions = await aiSuggest(
        "product",
        unknowns,
        references.products.map((product) => ({ code: product.code, label: product.name })),
        history,
      );
      return NextResponse.json({ success: true, data: { suggestions, areaSuggestions: [] } });
    }

    const regionByArea = new Map(references.areas.map((area) => [area.areaCode.toUpperCase(), area.regionCode.toUpperCase()]));

    // Pass 1 — the area. Labelled "Area — Region" so the model can use the region as a disambiguator
    // between two similarly-named areas without being able to answer with a region.
    const areaHistory = await listWeeklyAiReferenceAliases("branch-area", distributorCode);
    const areaSuggestions = (
      await aiSuggest(
        "territory",
        unknowns,
        references.areas.map((area) => ({
          code: area.areaCode,
          label: `${area.areaName} — ${references.regions.find((r) => r.regionCode === area.regionCode)?.regionName ?? area.regionCode}`,
        })),
        areaHistory.length > 0 ? areaHistory : undefined,
      )
    ).filter((suggestion) => regionByArea.has(String(suggestion.code ?? "").toUpperCase()));

    // The region every placed branch inherits from its area — never a second, independent guess.
    const suggestions = areaSuggestions.map((suggestion) => ({
      ...suggestion,
      code: regionByArea.get(String(suggestion.code).toUpperCase()) as string,
    }));

    // Pass 2 — region only, for the branches pass 1 could not place. A depot serving several areas
    // genuinely has no single area, so this is a real answer, not a consolation prize.
    const placed = new Set(areaSuggestions.map((suggestion) => suggestion.raw));
    const unplaced = unknowns.filter((unknown) => !placed.has(unknown.raw));
    // Unfiltered on purpose, matching the behaviour that shipped before: history can legitimately
    // teach the "exclude this branch" sentinel, which is not a region and must survive.
    if (unplaced.length > 0) {
      suggestions.push(
        ...(await aiSuggest(
          "territory",
          unplaced,
          references.regions.map((region) => ({ code: region.regionCode, label: region.regionName })),
          history,
        )),
      );
    }
    return NextResponse.json({ success: true, data: { suggestions, areaSuggestions } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "AI suggestion failed.") }, { status: 500 });
  }
}
