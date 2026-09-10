import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { exportFileName } from "@/lib/spotlight/headline";
import { renderSpotlightPdf } from "@/lib/spotlight/pdf";
import { SpotlightRequestError, parseSelection } from "@/lib/spotlight/request";
import { SpotlightWindowError, loadSpotlight } from "@/lib/spotlight/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Spotlight sheet, as a PDF.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHO MAY CALL IT. `spotlight:export`, which the permission matrix grants to the Super Admin and
 * the CEO and to nobody else, by the owner's instruction. THE GATE IS HERE AND NOT ONLY IN THE
 * SIDEBAR: `system-navigation.ts` hiding a card is UX, and this route is the security boundary.
 *
 * It is deliberately the only place in the app that reads every rep, district, region and line with
 * no scope narrowing at all. A scoped caller must never reach it — not because the numbers are
 * secret from their owner, but because this route composes them into a shareable document with
 * other people's names and achievement on it, and that is a publishing right, not a reading one.
 *
 * A POST rather than a GET, unlike the closing's PDF link: the selection is a nested object with
 * five filter lists, and it is not something anyone should be able to hand someone else as a URL.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "spotlight", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:spotlight:pdf",
    });

    const selection = parseSelection(await request.json().catch(() => null));
    const result = await loadSpotlight(selection);
    const pdf = await renderSpotlightPdf(result);

    return new Response(new Uint8Array(pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition":
          `attachment; filename="${exportFileName(result.headline, result.windowLabel, selection.direction)}"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json(
        { error: "Spotlight is available to the system administrator and the CEO only." },
        { status: 403 },
      );
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    // A window that has not finished yet is a 409, not a 400 and not a 500: the request is
    // well-formed and will succeed unchanged once the window closes, and the message says when.
    if (error instanceof SpotlightWindowError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof SpotlightRequestError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ChromiumUnavailableError) {
      return Response.json(
        { error: "This server cannot render PDFs right now. The on-screen spotlight is unaffected." },
        { status: 503 },
      );
    }
    return Response.json({ error: clientSafeErrorMessage(error, "Spotlight export failed.") }, { status: 500 });
  }
}
