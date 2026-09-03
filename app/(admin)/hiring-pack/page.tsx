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
  listHiringPackLines,
  loadHiringPackReadiness,
} from "@/lib/hiring-pack/service";
import type { HiringPackReadiness } from "@/lib/hiring-pack/readiness";
import type { HiringPackCandidate, HiringPackData } from "@/lib/hiring-pack/types";

export const dynamic = "force-dynamic";

// Gated by `employee_documents`, the same permission as the hiring documents tracker — see the note
// on the API route. Whoever can see an employee's document checklist is whoever can print the
// contract that fills it in.

function hiringPackPageError(error: unknown) {
  if (isHiringPackSchemaMissing(error)) {
    return "HR forms schema is not ready. Run the Supabase migrations for employee_hiring_profile and employee_offboarding_profile.";
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
          description="Preparing the contract, Form 1, Form 6 and the two exit forms."
          title="Loading HR Forms"
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
  let lines: { id: number; name: string }[] = [];
  let initialPack: HiringPackData | null = null;
  let initialError: string | null = null;
  let readiness: HiringPackReadiness | null = null;

  try {
    candidates = await listHiringPackCandidates();
  } catch (error) {
    initialError = hiringPackPageError(error);
  }

  // Never blocks the screen — the department picker just falls back to free text (see the
  // manager component) if this list cannot be loaded.
  try {
    lines = await listHiringPackLines();
  } catch {
    lines = [];
  }

  // The readiness board, and it fails the same way for the same reason: it is a view over the whole
  // payroll, and losing it must not cost HR the ability to type one person's contract. It is also
  // the one read here that touches every employee row, so before the hiring-profile migration has
  // run it is exactly the query that throws — the screen still has to work in that window.
  try {
    readiness = await loadHiringPackReadiness();
  } catch {
    readiness = null;
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
      lines={lines}
      readiness={readiness}
    />
  );
}
