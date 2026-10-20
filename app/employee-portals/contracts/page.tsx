import { redirect } from "next/navigation";

import { ContractRenewal } from "@/components/contracts/contract-renewal";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
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

// Portal mirror of app/(admin)/contracts/page.tsx.
export default async function EmployeePortalContractsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/contracts");
  }
  if (!(await canAccess(access, "contracts", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Contract renewal is available to the HR Generalist and the Super Admin only."
        title="Contract Renewal Unavailable"
      />
    );
  }

  let initialData: ContractRenewalDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getContractRenewalDashboardData(access);
  } catch (error) {
    initialError = contractsPageError(error);
  }

  return (
    <EmployeePortalPageShell
      badge="Employee Records"
      description="Manage upcoming and expiring employment contracts."
      errorBoundaryTitle="Contract Renewal unavailable"
      title="Contract Renewal"
    >
      <ContractRenewal initialData={initialData} initialError={initialError} />
    </EmployeePortalPageShell>
  );
}
