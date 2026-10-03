import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadPerformanceCard } from "@/lib/employee-portal/performance-card";
import { renderPerformanceCardPdf, renderPerformanceCardPng } from "@/lib/employee-portal/performance-card-render";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { issueShareCardToken, shareCardPublicUrl } from "@/lib/share/share-card-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A Medical Rep's OWN performance card, as a picture or a PDF — and the public link that lets
 * LinkedIn and Facebook show it in a post preview.
 *
 * SELF ONLY, AND IT IS NOT A CHOICE THE WIRE MAKES. The HR id is `access.hrId` from the session.
 * The body carries a format and nothing else; there is no identity field to tamper with, which is
 * why no scope check is needed beyond the permission itself.
 *
 * THE GATE IS A PUBLISHED WINDOW, enforced HERE and not only in the button state. A rep with no
 * published closing has nothing to put on a keepsake, and a page that merely hid the button would
 * leave this route callable — so it refuses with the same sentence the screen shows.
 *
 * Gated on `performance_card_self:export`, its own narrow right. Deliberately NOT
 * `employee_profile:export` — that is a broad record-export right a rep does not hold and must not
 * gain in order to save a picture of himself — and NOT `spotlight_self`, which carries the
 * spotlight's own 90% rule and would silently tie this card to a threshold nobody asked it to have.
 */
const NOTHING_PUBLISHED =
  "Your card is ready once a Monthly Closing is published for your line. Nothing on your page is affected.";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "performance_card_self", "export");
    if (!access.hrId) {
      return Response.json({ error: "This card is for employees with an HR record." }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const format = body?.format === "pdf" ? "pdf" : "png";
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: `export:performance-card:${format}`,
    });

    const card = await loadPerformanceCard(access.hrId);
    if (!card) return Response.json({ error: NOTHING_PUBLISHED }, { status: 403 });

    const stem = `sato-performance-${card.fromPeriod}${card.toPeriod === card.fromPeriod ? "" : `_${card.toPeriod}`}`;
    if (format === "pdf") {
      const pdf = await renderPerformanceCardPdf(card);
      return new Response(new Uint8Array(pdf), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${stem}.pdf"`,
          "Content-Type": "application/pdf",
        },
      });
    }
    const png = await renderPerformanceCardPng(card);
    return new Response(new Uint8Array(png), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${stem}.png"`,
        "Content-Type": "image/png",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "This card is for employees with an HR record." }, { status: 403 });
    }
    if (isApiRateLimitError(error)) return Response.json({ error: error.message }, { status: 429 });
    if (error instanceof ChromiumUnavailableError) {
      return Response.json(
        { error: "This server cannot render the card right now. Your performance on screen is unaffected." },
        { status: 503 },
      );
    }
    return Response.json({ error: clientSafeErrorMessage(error, "Your card could not be rendered.") }, { status: 500 });
  }
}

/**
 * Mint the PUBLIC, expiring link to the caller's OWN card, so LinkedIn and Facebook can scrape the
 * picture into a post preview.
 *
 * A GET because minting writes nothing and renders nothing — it signs a subject. Same permission
 * and the same published-window gate as the render, so a link can never exist for a card that
 * cannot be drawn.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "performance_card_self", "export");
    if (!access.hrId) {
      return Response.json({ error: "This card is for employees with an HR record." }, { status: 403 });
    }
    const card = await loadPerformanceCard(access.hrId);
    if (!card) return Response.json({ error: NOTHING_PUBLISHED }, { status: 403 });

    const token = issueShareCardToken({ kind: "performance", hrId: access.hrId });
    return Response.json({ shareUrl: shareCardPublicUrl(token) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "This card is for employees with an HR record." }, { status: 403 });
    }
    return Response.json({ error: clientSafeErrorMessage(error, "Your share link could not be created.") }, { status: 500 });
  }
}
