import { AppShell } from "@/components/layout/app-shell";
import { ContractRenewal } from "@/components/contracts/contract-renewal";
import { redirect } from "next/navigation";

import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  contractRenewalErrorMessage,
  getContractRenewalDashboardData,
  isContractRenewalSchemaMissing,
} from "@/lib/contracts/service";
import {
  employeeDirectoryErrorMessage,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import type { ContractRenewalDashboardData } from "@/lib/contracts/types";

export const dynamic = "force-dynamic";

function contractsPageError(error: unknown) {
  if (isEmployeeDirectoryTimeout(error)) {
    return "Supabase request timed out. Check your connection and try again.";
  }

  if (isEmployeeDirectoryEnvMissing(error)) {
    return "Supabase environment variables are missing.";
  }

  if (isEmployeeDirectorySchemaMissing(error)) {
    return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in Supabase SQL editor.";
  }

  if (isContractRenewalSchemaMissing(error)) {
    return "Contract renewal workflow schema is not ready. Run supabase/20260509_contract_renewal_workflow.sql in Supabase SQL editor.";
  }

  return contractRenewalErrorMessage(error) || employeeDirectoryErrorMessage(error);
}

export default async function ContractsPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "contracts", "read")) {
    redirect("/employee-portals");
  }
  let initialData: ContractRenewalDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getContractRenewalDashboardData(access);
  } catch (error) {
    initialError = contractsPageError(error);
  }

  return (
    <AppShell navigationMode="admin">
      <ContractRenewal
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
