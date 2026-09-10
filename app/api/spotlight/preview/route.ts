import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { SpotlightRequestError, parseSelection } from "@/lib/spotlight/request";
import { SpotlightWindowError, loadSpotlight } from "@/lib/spotlight/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The same selection the export renders, as rows — so the screen and the sheet cannot disagree.
 *
 * ONE SERVICE CALL BEHIND BOTH. If this route ranked rows of its own the preview would eventually
 * drift from the PDF, and the drift would surface as the owner exporting a sheet that does not
 * match what he just approved on screen. Both go through `loadSpotlight`.
 *
 * Gated on `spotlight:read` — the Super Admin and the CEO. The read is company-wide with no scope
 * narrowing, so there is no narrower version of this route to offer anyone else.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "spotlight", "read");

    const selection = parseSelection(await request.json().catch(() => null));
    const result = await loadSpotlight(selection);

    return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json(
        { error: "Spotlight is available to the system administrator and the CEO only." },
        { status: 403 },
      );
    }
    if (error instanceof SpotlightWindowError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof SpotlightRequestError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: clientSafeErrorMessage(error, "Spotlight failed to load.") }, { status: 500 });
  }
}
