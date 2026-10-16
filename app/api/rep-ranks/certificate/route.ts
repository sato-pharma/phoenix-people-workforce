import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { RANK_ADMIN_ROLES } from "@/lib/rep-ranks/admin-audience";
import { RankCertificateError, loadRankCertificate, renderRankCertificatePdf } from "@/lib/rep-ranks/server/certificate-pdf";
import { RANK_WINDOW_KINDS, type RankWindowKind } from "@/lib/rep-ranks/windows";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A rep's Phoenix Ranks certificate, as a PDF (owner, 2026-10-05: "any rep who is taking a rank or a
 * title to be able to export a premium polished PDF").
 *
 * SELF ONLY ON THE PORTAL. A rep prints their own certificate: `?rep=` naming anyone else is refused
 * unless the caller is the admin twin's audience. A GET because it writes nothing, so the board can
 * offer it as a plain link with no client island. Gated on the board's own right, `early_birds:read`,
 * and issued only for a window the rep is RANKED in — the route refuses the rest with the reason.
 *
 * URL: ?window=day|week|month|quarter|semester&key=<window key>&rep=<HR id>.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "early_birds", "read");

    const params = new URL(request.url).searchParams;
    const own = normalizeHrIdForAccess(access.hrId);
    const requested = normalizeHrIdForAccess(params.get("rep")) ?? own;
    if (!requested) {
      return Response.json({ error: "The certificate is for medical representatives on Phoenix Ranks." }, { status: 403 });
    }
    const mayCertifyAnyone = access.scope === "system" || RANK_ADMIN_ROLES.has(access.role);
    if (requested !== own && !mayCertifyAnyone) {
      return Response.json({ error: "You can print your own certificate only." }, { status: 403 });
    }

    await assertExportRateLimit({ actor: access.loginId ?? access.hrId ?? requested, request, scope: "export:rep-ranks:certificate" });

    const windowParam = params.get("window");
    const kind: RankWindowKind = RANK_WINDOW_KINDS.includes(windowParam as RankWindowKind) ? (windowParam as RankWindowKind) : "month";
    const certificate = await loadRankCertificate({ hrIdKey: requested, kind, windowKey: params.get("key") });
    const pdf = await renderRankCertificatePdf(certificate);

    const stem = `phoenix-ranks-${certificate.repName}-${certificate.windowLabel}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${stem || "phoenix-ranks-certificate"}.pdf"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "Phoenix Ranks is open to the field force and their managers." }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    if (error instanceof RankCertificateError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ChromiumUnavailableError) {
      return Response.json({ error: "This server cannot render the certificate right now. Your standing on the board is unaffected." }, { status: 503 });
    }
    return Response.json({ error: clientSafeErrorMessage(error, "The certificate failed to render.") }, { status: 500 });
  }
}
