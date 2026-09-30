import { redirect } from "next/navigation";

import { CustomerLinksWorkspace } from "@/components/customer-identity/customer-links-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listIdentityMasters } from "@/lib/customer-identity/server/profile";
import { loadIdentitySuggestions } from "@/lib/customer-identity/server/reads";
import type { IdentityKind } from "@/lib/customer-identity/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Phoenix CRM Wave 2 — the Super Admin decides who a customer IS.
 *
 * Gated on `customer_identity:read`, which the matrix grants to the Super Admin alone (owner,
 * 2026-09-30). The gate is here AND on both API routes: hiding a link in the sidebar is UX, and
 * this page reads every customer in all four systems at once with no scope narrowing.
 */
function kindParam(value: string | string[] | undefined): IdentityKind | null {
  return value === "PM" || value === "AM" || value === "pharmacy" ? value : null;
}

export default async function CustomerLinksPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!(await canAccess(access, "customer_identity", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const kind = kindParam(params.kind);
  const [{ clusters, totalClusters, totalPairs }, masters] = await Promise.all([
    loadIdentitySuggestions({ kind, limit: 100 }),
    listIdentityMasters(50),
  ]);

  return (
    <CustomerLinksWorkspace
      clusters={clusters}
      kind={kind}
      masters={masters}
      totalClusters={totalClusters}
      totalPairs={totalPairs}
    />
  );
}
