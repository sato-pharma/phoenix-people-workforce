import { redirect } from "next/navigation";

import { ClosingCorrectionsView } from "@/components/sales/closing-corrections-view";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  loadClosingCorrections,
  type ClosingCorrectionsResult,
} from "@/lib/sales/closing-corrections";

export const dynamic = "force-dynamic";

// Closing Corrections — situations where the data is booked exactly as the distributor sent it
// and one month still reads wrong: cross-month reversals, returns exceeding sales, late returns.
export default async function ClosingCorrectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  // Same admin-account boundary as /sales/monthly-closing. Server-side enforcement.
  if (access.role !== "Super Admin" && access.scope !== "system") {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const periodRaw = params.period;
  const period = typeof periodRaw === "string" ? periodRaw : Array.isArray(periodRaw) ? periodRaw[0] : null;

  let initialData: ClosingCorrectionsResult | null = null;
  let initialError: string | null = null;

  try {
    await assertPermission(access, "sales", "import");
    initialData = await loadClosingCorrections({ period });
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Closing Corrections.";
  }

  return <ClosingCorrectionsView initialData={initialData} initialError={initialError} />;
}
