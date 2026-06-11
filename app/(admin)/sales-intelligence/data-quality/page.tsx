import { redirect } from "next/navigation";

import { DataQualityCenter } from "@/components/sales/intelligence/data-quality-center";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSiDataQuality } from "@/lib/sales/intelligence/data-quality";
import type { SiDataQuality } from "@/lib/sales/intelligence/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function SalesIntelligenceDataQualityPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  // The data-quality view exposes the upload pipeline (file names, uploaders, validation state),
  // so it is gated to the import-capable admins, not every sales role.
  if (!(await canAccess(access, "sales", "import"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const requested = typeof params.period === "string" ? params.period : undefined;
  const period = !requested || requested === "all" ? null : requested;

  let data: SiDataQuality | null = null;
  let error: string | null = null;
  try {
    data = await getSiDataQuality(period);
  } catch (caught) {
    console.error("[sales-intelligence/data-quality] load failed:", caught);
    error = caught instanceof Error ? caught.message : "Failed to load Data Quality Center.";
  }

  return <DataQualityCenter data={data} error={error} />;
}
