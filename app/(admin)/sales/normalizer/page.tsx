import { redirect } from "next/navigation";

import { NormalizerTabs } from "@/components/sales/normalizer-tabs";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { hasAiKey } from "@/lib/sales/normalizer/ai-suggest";
import { listMappingReferences, listNormalizerDistributors, type MappingReferences } from "@/lib/sales/normalizer/service";

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
  try { references = await listMappingReferences(); } catch { /* dropdowns degrade gracefully */ }
  return <NormalizerTabs aiEnabled={hasAiKey()} distributors={listNormalizerDistributors()} references={references} />;
}
