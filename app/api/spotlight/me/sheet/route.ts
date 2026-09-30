import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { issueShareCardToken, shareCardPublicUrl } from "@/lib/share/share-card-token";
import { renderRepSpotlightPdf, renderRepSpotlightPng } from "@/lib/spotlight/pdf";
import { RepSpotlightError, loadRepSpotlight, parseRepSpotlightRange } from "@/lib/spotlight/rep-self";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A medical rep's own spotlight, as a picture or a PDF.
 *
 * THE 90% GATE IS ENFORCED HERE, not only in the button state. Owner, 2026-09-30: the pic or the PDF
 * is generated only when the rep's achievement over the chosen period, against the PUBLISHED monthly
 * closing, is 90% or more. A page that hid the button would still leave the route callable, so the
 * route refuses an ineligible sheet with the same words the screen shows.
 *
 * SELF ONLY. The HR id is the caller's own, from the access context; the body carries a range and a
 * format and no identity. Gated on `spotlight_self` — never the company-wide `spotlight` right.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "spotlight_self", "export");
    if (!access.hrId) {
      return Response.json({ error: "This spotlight is for medical representatives." }, { status: 403 });
    }

    const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const format =
      payload?.format === "png" ? "png" : payload?.format === "share-link" ? "share-link" : "pdf";
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: `export:spotlight:me:${format}`,
    });

    const range = parseRepSpotlightRange(payload);
    const spotlight = await loadRepSpotlight(access.hrId, range);

    // The gate. A window with no published closing, no target, or below the floor is not an error —
    // it is a legitimate request that is simply not available yet, answered with the reason (403).
    if (!spotlight.eligible || !spotlight.result) {
      return Response.json(
        { error: spotlight.reason ?? `The spotlight sheet is available at ${spotlight.threshold}% and above.` },
        { status: 403 },
      );
    }

    // A public, expiring link to this sheet — only ever for an ELIGIBLE period (the gate above), so a
    // link can never outlive the achievement. Minted from the caller's own resolved range.
    if (format === "share-link") {
      const token = issueShareCardToken({
        kind: "spotlight",
        hrId: access.hrId,
        from: spotlight.from,
        to: spotlight.to,
      });
      return Response.json({ shareUrl: shareCardPublicUrl(token) }, { headers: { "Cache-Control": "no-store" } });
    }

    const stem = `sato-spotlight-${spotlight.from}${spotlight.to === spotlight.from ? "" : `_${spotlight.to}`}`;
    if (format === "png") {
      const png = await renderRepSpotlightPng(spotlight.result);
      return new Response(new Uint8Array(png), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${stem}.png"`,
          "Content-Type": "image/png",
        },
      });
    }

    const pdf = await renderRepSpotlightPdf(spotlight.result);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${stem}.pdf"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "This spotlight is for medical representatives." }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    if (error instanceof RepSpotlightError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ChromiumUnavailableError) {
      return Response.json(
        { error: "This server cannot render the sheet right now. Your achievement on screen is unaffected." },
        { status: 503 },
      );
    }
    return Response.json({ error: clientSafeErrorMessage(error, "Spotlight sheet failed to render.") }, { status: 500 });
  }
}
