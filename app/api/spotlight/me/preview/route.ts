import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { RepSpotlightError, loadRepSpotlight, parseRepSpotlightRange } from "@/lib/spotlight/rep-self";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A medical rep's own spotlight numbers over a period he chooses — the on-screen half of the feature.
 *
 * SELF ONLY. The HR id is the caller's own, taken from the access context; the request body carries a
 * range and nothing else, so a rep cannot ask about anyone but himself. Gated on `spotlight_self`,
 * which the Medical Rep role holds and the company-wide `spotlight` routes do not accept — the two are
 * deliberately different resources so this route can never read the whole company.
 *
 * Returns his achievement and whether the sheet is available (90%+ against the published closing), so
 * the picker can show the number and enable or explain the download without a second round trip. It
 * never returns the sheet itself — that is /api/spotlight/me/sheet, which re-checks the gate.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "spotlight_self", "read");
    if (!access.hrId) {
      return Response.json({ error: "This spotlight is for medical representatives." }, { status: 403 });
    }

    const range = parseRepSpotlightRange(await request.json().catch(() => null));
    const spotlight = await loadRepSpotlight(access.hrId, range);

    // Only the caller's own summary — never the ranked field, never anyone else's numbers.
    return Response.json(
      {
        from: spotlight.from,
        to: spotlight.to,
        rangeLabel: spotlight.rangeLabel,
        requestedPeriods: spotlight.requestedPeriods,
        publishedPeriods: spotlight.publishedPeriods,
        pendingPeriods: spotlight.pendingPeriods,
        achievement: spotlight.achievement,
        eligible: spotlight.eligible,
        threshold: spotlight.threshold,
        reason: spotlight.reason,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "This spotlight is for medical representatives." }, { status: 403 });
    }
    if (error instanceof RepSpotlightError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: clientSafeErrorMessage(error, "Spotlight failed to load.") }, { status: 500 });
  }
}
