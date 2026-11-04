import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isSalesPeriodReleasedForLines, loadSalesReleaseKeys } from "@/lib/sales/unpublished-sales-access";
import { windowsByLineSet } from "@/lib/spotlight/line-windows";
import { facetsFrom, loadSpotlightOrg } from "@/lib/spotlight/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the picker may offer: the lines, regions, areas and people that exist, and the windows that
 * have actually finished.
 *
 * 🔒 THE WINDOW LIST COMES FROM THE SAME GATE THE EXPORT USES. Deriving it any other way is how a
 * picker ends up offering a month the export then refuses — the user's own screen tells them to do
 * something the server will not do, and that reads as a broken feature rather than as a rule.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "spotlight", "read");

    const [index, publishedKeys] = await Promise.all([loadSpotlightOrg(), loadSalesReleaseKeys()]);
    // Keyed by the set of lines ticked (`lineSetKey`); the default sheet reads all three.
    const windowsByLines = windowsByLineSet((period, lines) =>
      isSalesPeriodReleasedForLines(period, lines, publishedKeys),
    );

    return Response.json(
      {
        windowsByLines,
        facets: facetsFrom(index),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json(
        { error: "Spotlight is available to the system administrator and the CEO only." },
        { status: 403 },
      );
    }
    return Response.json({ error: clientSafeErrorMessage(error, "Spotlight options failed to load.") }, { status: 500 });
  }
}
