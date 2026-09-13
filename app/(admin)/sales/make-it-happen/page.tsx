import { redirect } from "next/navigation";

import { MakeItHappenPlanner } from "@/components/sales/make-it-happen/make-it-happen-planner";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canUseMakeItHappen } from "@/lib/sales/make-it-happen/scope";
import { buildMakeItHappenWorkspace } from "@/lib/sales/make-it-happen/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Make It Happen — admin-shell surface for SFE Manager and Super Admin. Portal-shell roles are sent
// to their own twin at /employee-portals/make-it-happen; admin roles the owner did not name (the CEO
// among them) go back to Sales vs Target rather than meeting a planner they were not given.
export default async function AdminMakeItHappenPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; period?: string; rep?: string }>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/make-it-happen");
  }
  await assertPermission(access, "sales", "read");
  if (!canUseMakeItHappen(access.role)) redirect("/sales/vs-target");

  const sp = await searchParams;
  const data = await buildMakeItHappenWorkspace(access, { kind: sp.kind, period: sp.period, rep: sp.rep });

  return (
    <div className="p-4 sm:p-6">
      <MakeItHappenPlanner
        key={`${data.periodKind}|${data.periodKey}|${data.viewingRep?.key ?? ""}`}
        basePath="/sales/make-it-happen"
        data={data}
        kicker="Commercial Performance"
      />
    </div>
  );
}
