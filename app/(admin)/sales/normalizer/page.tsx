import { redirect } from "next/navigation";

import { NormalizerTabs } from "@/components/sales/normalizer-tabs";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { hasAiKey } from "@/lib/sales/normalizer/ai-suggest";
import { listMappingReferences, listNormalizerDistributors, type MappingReferences } from "@/lib/sales/normalizer/service";
import { listWeeklyNormalizeReferences, listWeeklyNormalizerDistributors, type WeeklyNormalizeReferences } from "@/lib/sales/weekly/normalizer";

export const dynamic = "force-dynamic";

export default async function NormalizerPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  if (access.role !== "Super Admin" && access.scope !== "system") {
    redirect(resolveLandingPathForRole(access.role));
  }
  let references: MappingReferences = { bricks: [], products: [] };
  let weeklyReferences: WeeklyNormalizeReferences = { areas: [], products: [], regions: [] };
  // Both reference loads degrade to empty dropdowns rather than a 500 — the page's own analyze step
  // still works, and an operator seeing an empty product list knows immediately what to report.
  // Loaded in parallel: each is a round trip to Frankfurt.
  const [monthly, weekly] = await Promise.allSettled([listMappingReferences(), listWeeklyNormalizeReferences()]);
  if (monthly.status === "fulfilled") references = monthly.value;
  if (weekly.status === "fulfilled") weeklyReferences = weekly.value;
  return (
    <NormalizerTabs
      aiEnabled={hasAiKey()}
      distributors={listNormalizerDistributors()}
      references={references}
      weeklyDistributors={listWeeklyNormalizerDistributors()}
      weeklyReferences={weeklyReferences}
    />
  );
}
