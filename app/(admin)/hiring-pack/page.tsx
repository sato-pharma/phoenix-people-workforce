import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HiringPackManager } from "@/components/hiring-pack/hiring-pack-manager";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
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

// Gated by `employee_documents`, the same permission as the hiring documents tracker — see the note
// on the API route. Whoever can see an employee's document checklist is whoever can print the
// contract that fills it in.

function hiringPackPageError(error: unknown) {
  if (isHiringPackSchemaMissing(error)) {
    return "Hiring pack schema is not ready. Run the Supabase migration for employee_hiring_profile.";
  }
  if (isHiringPackEmployeeMissing(error)) {
    return "That employee does not exist. Choose one from the list.";
  }

  return hiringPackErrorMessage(error);
}

export default async function HiringPackPage({
  searchParams,
}: {
  searchParams: Promise<{ hrId?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  const [canRead, canManage] = await Promise.all([
    canAccess(access, "employee_documents", "read"),
    canAccess(access, "employee_documents", "update"),
  ]);

  if (!isHrAuthorityRole(access.role) || !canRead) {
    redirect("/employee-portals");
  }

  const { hrId } = await searchParams;

  return (
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

  // A `?hrId=` deep link opens straight on that person — that is how the hiring documents tracker
  // hands over. A bad id reports itself and still leaves the picker usable, rather than 404ing the
  // whole screen.
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
