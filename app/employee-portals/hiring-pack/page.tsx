import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { HiringPackManager } from "@/components/hiring-pack/hiring-pack-manager";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { hrFormsAccessFor, packForViewer, type HrFormsAccess } from "@/lib/hiring-pack/paper-access";
import {
  getHiringPack,
  hiringPackErrorMessage,
  isHiringPackEmployeeMissing,
  isHiringPackSchemaMissing,
  listHiringPackCandidates,
  listHiringPackLines,
} from "@/lib/hiring-pack/service";
import type { HiringPackCandidate, HiringPackData } from "@/lib/hiring-pack/types";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

function hiringPackPageError(error: unknown) {
  if (isHiringPackSchemaMissing(error)) {
    return "HR forms schema is not ready. Run the Supabase migrations for employee_hiring_profile and employee_offboarding_profile.";
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

  // The same answer as the admin twin (paper-access.ts): employee_documents for an HR authority
  // seat, or a seat named in SEAT_PRINTABLE_DOCUMENTS on its own papers' grants.
  const forms = await hrFormsAccessFor(access);

  if (!forms.canRead) {
    return (
      <EmployeePortalEmptyState
        message="The hiring pack is available to the HR Generalist, the HR Operations Specialist and the Super Admin only."
        title="HR Forms Unavailable"
      />
    );
  }

  const { hrId } = await searchParams;

  return (
    <EmployeePortalPageShell
      badge="Recruitment & Hiring"
      description="Fill, print and record the employment contract and social insurance Form 1."
      errorBoundaryTitle="HR Forms unavailable"
      title="HR Forms"
    >
      <Suspense
        fallback={
          <AppRouteLoadingState
            description="Preparing the employment contract and social insurance Form 1."
            title="Loading HR Forms"
          />
        }
      >
        <HiringPackContent access={access} forms={forms} hrId={hrId ?? null} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}

async function HiringPackContent({
  access,
  forms,
  hrId,
}: {
  access: AccessContext;
  forms: HrFormsAccess;
  hrId: string | null;
}) {
  let candidates: HiringPackCandidate[] = [];
  let lines: { id: number; name: string }[] = [];
  let initialPack: HiringPackData | null = null;
  let initialError: string | null = null;

  try {
    candidates = await listHiringPackCandidates();
  } catch (error) {
    initialError = hiringPackPageError(error);
  }

  try {
    lines = await listHiringPackLines();
  } catch (error) {
    // Its sibling catch above sets `initialError`, which the manager sees. This one only empties
    // the LINE picker, so a banner would overstate it — but it was silent, and an empty line list
    // looks to the person filling a contract like the company has no lines on file. Logged, the
    // way its sibling at :103 is, so the failure is findable instead of invisible.
    logPortalFailure(
      { route: "/employee-portals/hiring-pack", module: "hiring-pack-lines", hrId },
      error,
    );
    lines = [];
  }

  if (hrId) {
    try {
      // Blanked of money for the salary-blind seat, the same as the pack route answers her.
      initialPack = packForViewer(access, await getHiringPack(hrId));
    } catch (error) {
      initialError = hiringPackPageError(error);
    }
  }

  return (
    <HiringPackManager
      canManage={forms.canManage}
      candidates={candidates}
      initialError={initialError}
      initialPack={initialPack}
      lines={lines}
      paperScope={forms.paperScope}
      salaryReadOnly={forms.salaryReadOnly}
    />
  );
}
