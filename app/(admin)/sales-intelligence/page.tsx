import { redirect } from "next/navigation";

import { SalesIntelligenceDashboard } from "@/components/sales/intelligence/sales-intelligence-dashboard";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveSalesAccessScope } from "@/lib/sales/access-scope";
import type { SiDetailsFilters } from "@/lib/sales/intelligence/derive";
import { getSiDashboardBundle } from "@/lib/sales/intelligence/service";
import type { SiDashboardBundle } from "@/lib/sales/intelligence/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Source-of-Sales aggregates scan the validated fact rows server-side; raise the ceiling
// so a cold/loaded read renders instead of being killed mid-flight.
export const maxDuration = 60;

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint, record.code]
      .filter((part): part is string => typeof part === "string" && part.length > 0);
    if (parts.length > 0) return parts.join(" — ");
  }
  return "Failed to load Sales Intelligence.";
}

export default async function SalesIntelligencePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  // Server-side gate — every sales role may open this (scope decides WHAT they see). Sidebar
  // visibility is UX only, never the security boundary.
  if (!(await canAccess(access, "sales", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const requested = typeof params.period === "string" ? params.period : undefined;
  const period = !requested || requested === "all" ? null : requested;
  // Only CEO/Super Admin can opt in; resolveSalesAccessScope ignores this flag for any other role.
  const includeRestricted = params.includeRestricted === "1";

  const scope = await resolveSalesAccessScope(access, { includeRestricted });

  // Advanced-filter toolbar (?distributor/region/area/line/productFilter). These NARROW within the
  // already-resolved scope — they can only subtract, never widen. `productFilter` is distinct from
  // the drill deep-link `?product=` so opening a product drill never doubles as a page filter.
  const str = (value: string | string[] | undefined) =>
    typeof value === "string" && value.trim() ? value : null;
  const filters: SiDetailsFilters = {
    distributorCode: str(params.distributor),
    regionCode: str(params.region),
    areaCode: str(params.area),
    officialLine: str(params.line),
    productCode: str(params.productFilter),
  };

  let bundle: SiDashboardBundle | null = null;
  let error: string | null = null;
  try {
    bundle = await getSiDashboardBundle(period, scope, filters);
  } catch (caught) {
    console.error("[sales-intelligence] bundle load failed:", caught);
    error = describeError(caught);
  }

  return <SalesIntelligenceDashboard bundle={bundle} error={error} />;
}
