import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { RepProductAchievementWorkspace } from "@/components/sales/rep-product-achievement-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { parseRepAchievementFilters, type RepAchievementData } from "@/lib/sales/rep-product-achievement";
import { loadRepProductAchievement } from "@/lib/sales/rep-product-achievement-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type SearchParams = { [key: string]: string | string[] | undefined };

function toSearchParams(params: SearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") out.set(key, value);
  }
  return out;
}

export default async function TrainingManagerRepAchievementPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!(await canAccess(access, "rep_product_achievement", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = toSearchParams(await searchParams);
  const canExport = await canAccess(access, "rep_product_achievement", "export");

  let data: RepAchievementData | null = null;
  try {
    data = await loadRepProductAchievement(params.get("semester"));
  } catch (error) {
    logPortalFailure(
      {
        hrId: access.hrId,
        module: "rep-product-achievement",
        role: access.role,
        route: "/employee-portals/training-manager/rep-achievement",
      },
      error,
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Training"
      description="Every rep's achievement, product by product — each month, each quarter and the semester — from the published Monthly Closing. Filter by line, product, region or manager and export what you see to Excel."
      errorBoundaryTitle="Rep Achievement unavailable"
      title="Rep Achievement by Product"
    >
      {data ? (
        <RepProductAchievementWorkspace
          canExport={canExport}
          data={data}
          initialFilters={parseRepAchievementFilters(params)}
        />
      ) : (
        <div className="border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-500">
          We couldn&apos;t load Rep Achievement right now. This is usually temporary — please refresh in a moment.
        </div>
      )}
    </EmployeePortalPageShell>
  );
}
