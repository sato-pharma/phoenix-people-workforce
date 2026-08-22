import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { HiringPackManager } from "@/components/hiring-pack/hiring-pack-manager";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, isHrAuthorityRole, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getHiringPack,
  hiringPackErrorMessage,
  isHiringPackEmployeeMissing,
  isHiringPackSchemaMissing,
  listHiringPackCandidates,
} from "@/lib/hiring-pack/service";
import type { HiringPackCandidate, HiringPackData } from "@/lib/hiring-pack/types";

export const dynamic = "force-dynamic";

function hiringPackPageError(error: unknown) {
  if (isHiringPackSchemaMissing(error)) {
    return "Hiring pack schema is not ready. Run the Supabase migration for employee_hiring_profile.";
  }
  if (isHiringPackEmployeeMissing(error)) {
    return "That employee does not exist. Choose one from the list.";
  }

  return hiringPackErrorMessage(error);
}

// Portal mirror of app/(admin)/hiring-pack/page.tsx.
//
// This is not duplication for its own sake: Talent Acquisition is a portal-shell role, and
// app/(admin)/layout.tsx redirects portal-shell roles out of the entire (admin) group before any
// page in it renders. Without this twin, the only role that actually prints new-hire contracts
// could not open the screen — see tests/recruitment-hub-portal-coverage.test.ts, which fails if the
// hub card and this route ever drift apart.
export default async function EmployeePortalHiringPackPage({
  searchParams,
}: {
  searchParams: Promise<{ hrId?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/hiring-pack");
  }

  const [canRead, canManage] = await Promise.all([
    canAccess(access, "employee_documents", "read"),
    canAccess(access, "employee_documents", "update"),
  ]);

  if (!isHrAuthorityRole(access.role) || !canRead) {
    return (
      <EmployeePortalEmptyState
        message="The hiring pack is available to Talent Acquisition and Super Admin only."
        title="Contract & Form 1 Unavailable"
      />
    );
  }

  const { hrId } = await searchParams;

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="Fill, print and record the employment contract and social insurance Form 1."
      errorBoundaryTitle="Contract & Form 1 unavailable"
      title="Contract & Form 1"
    >
      <Suspense
        fallback={
          <AppRouteLoadingState
            description="Preparing the employment contract and social insurance Form 1."
            title="Loading Contract & Form 1"
          />
        }
      >
        <HiringPackContent canManage={canManage} hrId={hrId ?? null} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}

async function HiringPackContent({
  canManage,
  hrId,
}: {
  canManage: boolean;
  hrId: string | null;
}) {
  let candidates: HiringPackCandidate[] = [];
  let initialPack: HiringPackData | null = null;
  let initialError: string | null = null;

  try {
    candidates = await listHiringPackCandidates();
  } catch (error) {
    initialError = hiringPackPageError(error);
  }

  if (hrId) {
    try {
      initialPack = await getHiringPack(hrId);
    } catch (error) {
      initialError = hiringPackPageError(error);
    }
  }

  return (
    <HiringPackManager
      canManage={canManage}
      candidates={candidates}
      initialError={initialError}
      initialPack={initialPack}
    />
  );
}
