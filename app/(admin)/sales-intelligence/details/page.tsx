import { redirect } from "next/navigation";

import { SalesDetailsPage } from "@/components/sales/intelligence/sales-details-page";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveSalesAccessScope } from "@/lib/sales/access-scope";
import { getSiDetailsBundle } from "@/lib/sales/intelligence/service";
import type { SiDetailsBundle } from "@/lib/sales/intelligence/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load Sales Details.";
}

export default async function SalesIntelligenceDetailsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (!(await canAccess(access, "sales", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const str = (value: string | string[] | undefined) =>
    typeof value === "string" && value.trim() ? value : undefined;
  const requested = str(params.period);
  const period = !requested || requested === "all" ? null : requested;
  const includeRestricted = params.includeRestricted === "1";

  const scope = await resolveSalesAccessScope(access, { includeRestricted });
  const filters = {
    distributorCode: str(params.distributor),
    regionCode: str(params.region),
    areaCode: str(params.area),
    officialLine: str(params.line),
    productCode: str(params.product),
  };

  let bundle: SiDetailsBundle | null = null;
  let error: string | null = null;
  try {
    bundle = await getSiDetailsBundle(period, scope, filters);
  } catch (caught) {
    console.error("[sales-intelligence/details] load failed:", caught);
    error = describeError(caught);
  }

  return <SalesDetailsPage bundle={bundle} error={error} />;
}
