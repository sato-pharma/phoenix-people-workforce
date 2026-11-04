import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isSalesPeriodReleasedCompanyWide, loadSalesReleaseKeys } from "@/lib/sales/unpublished-sales-access";
import { facetsFrom, loadSpotlightOrg } from "@/lib/spotlight/org";
import { selectableWindows } from "@/lib/spotlight/period";

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
    const isPublished = (period: string) => isSalesPeriodReleasedCompanyWide(period, publishedKeys);

    return Response.json(
      {
        windows: {
          month: selectableWindows("month", undefined, 18, isPublished),
          quarter: selectableWindows("quarter", undefined, 8, isPublished),
          semester: selectableWindows("semester", undefined, 4, isPublished),
          year: selectableWindows("year", undefined, 4, isPublished),
        },
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
