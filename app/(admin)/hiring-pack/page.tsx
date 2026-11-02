import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HiringPackManager } from "@/components/hiring-pack/hiring-pack-manager";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import type { AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { BANK_LETTER_PAGE } from "@/lib/hiring-pack/bank-account-letter";
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
  // An HR seat holding employee_documents (the HR Operations Specialist too since 2026-11-02), or a
  // seat named in SEAT_PRINTABLE_DOCUMENTS on its own papers' grants.
  const forms = await hrFormsAccessFor(access);

  if (!forms.canRead) {
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
      <HiringPackContent access={access} forms={forms} hrId={hrId ?? null} />
    </Suspense>
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

  // Never blocks the screen — the department picker just falls back to free text (see the
  // manager component) if this list cannot be loaded.
  try {
    lines = await listHiringPackLines();
  } catch {
    lines = [];
  }

  // A `?hrId=` deep link opens straight on that person — that is how the hiring documents tracker
  // hands over. A bad id reports itself and still leaves the picker usable, rather than 404ing the
  // whole screen.
  if (hrId) {
    try {
      initialPack = packForViewer(access, await getHiringPack(hrId));
    } catch (error) {
      initialError = hiringPackPageError(error);
    }
  }

  return (
    <HiringPackManager
      bankLetterHref={forms.paperScope === null ? BANK_LETTER_PAGE.href : null}
      canManage={forms.canManage}
      candidates={candidates}
      initialError={initialError}
      initialPack={initialPack}
      lines={lines}
      paperScope={forms.paperScope}
      salaryReadOnly={forms.salaryReadOnly}
      contractTermsReadOnly={forms.contractTermsReadOnly}
    />
  );
}
