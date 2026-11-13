import { redirect } from "next/navigation";

import { ContractRenewal } from "@/components/contracts/contract-renewal";
import { TeamRenewalsList } from "@/components/contracts/manager-recommendation-body";
import { listTeamRenewals } from "@/lib/contracts/manager-recommendation";
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
    return "Contract renewal workflow schema is not ready. Run supabase/scripts/20260509_contract_renewal_workflow.sql in Supabase SQL editor.";
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
    // A manager without the board sees his own team's coming renewals, each with the way to
    // recommend (owner, 2026-11-11). This is also where the reminders already sent with the old
    // /contracts button now land, instead of the portal home.
    const renewals = await listTeamRenewals(access).catch((error: unknown) => {
      console.error(error, { tags: { module: "contracts", read: "team-renewals" } });
      return null;
    });
    if (renewals === null) {
      return (
        <EmployeePortalEmptyState
          message="Your team's contract renewals could not be read just now. Try again in a minute."
          title="Contract renewals unavailable"
        />
      );
    }
    return (
      <EmployeePortalPageShell
        badge="Contract Renewal"
        description="Everyone in your team whose contract renews in the next 90 days. Tell HR whether to renew."
        errorBoundaryTitle="Contract Renewal unavailable"
        title="My team's contract renewals"
      >
        <TeamRenewalsList renewals={renewals} />
      </EmployeePortalPageShell>
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
