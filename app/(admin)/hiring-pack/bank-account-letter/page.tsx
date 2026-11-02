import { redirect } from "next/navigation";
import { Suspense } from "react";

import { BankAccountLetterManager } from "@/components/hiring-pack/bank-account-letter-manager";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import type { BankLetterEmployee } from "@/lib/hiring-pack/bank-account-letter";
import { listBankLetterEmployees } from "@/lib/hiring-pack/bank-account-letter-store";
import { hrFormsAccessFor } from "@/lib/hiring-pack/paper-access";

export const dynamic = "force-dynamic";

// The bank account-opening letter. Gated exactly as its API route: an HR seat that reads HR Forms
// on `employee_documents` — never a paper-grant seat, because the letter lists national IDs, mobiles,
// addresses and base salaries. The HR Operations Specialist has it with the rest of HR Forms
// (owner, 2026-11-02, "FULL MODULE").

export default async function BankAccountLetterPage() {
  const access = await resolveAccessContextFromPage();
  const forms = await hrFormsAccessFor(access);
  if (!forms.canRead || forms.paperScope !== null) redirect("/employee-portals");

  return (
    <Suspense fallback={<AppRouteLoadingState description="Preparing the active staff list." title="Loading Bank Account Letter" />}>
      <BankAccountLetterContent />
    </Suspense>
  );
}

async function BankAccountLetterContent() {
  let employees: BankLetterEmployee[] = [];
  let initialError: string | null = null;
  try {
    employees = await listBankLetterEmployees();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "The staff list could not be loaded.";
  }
  return <BankAccountLetterManager employees={employees} initialError={initialError} />;
}
