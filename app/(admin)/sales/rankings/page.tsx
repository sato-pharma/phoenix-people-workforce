import { redirect } from "next/navigation";

import { RankingsExplorer } from "@/components/sales/rankings/rankings-explorer";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { buildRankingsPage, type RankingsSearchParams } from "@/lib/sales/rankings-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Rankings — the standing of the whole field, over any window, through any slice (owner,
// 2026-10-03: the rep's two ranking cards, "built as a new tab", never inside an overview).
//
// Admin-shell surface. Portal-shell roles are redirected to their own scoped analytics rather
// than denied, exactly as /sales/vs-target does: a field role reaches its numbers through the
// portal, never through an /admin path — and a rep's own standing is already on his landing page.
export default async function AdminSalesRankingsPage({
  searchParams,
}: {
  searchParams: Promise<RankingsSearchParams>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/sales-vs-target");
  }
  await assertPermission(access, "sales", "read");

  const data = await buildRankingsPage(await searchParams);

  return (
    <div className="p-4 sm:p-6">
      <RankingsExplorer data={data} />
    </div>
  );
}
