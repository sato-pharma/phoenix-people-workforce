import { AppShell } from "@/components/layout/app-shell";
import { ContractRenewal } from "@/components/contracts/contract-renewal";
import {
  employeeDirectoryErrorMessage,
  getEmployeeDirectoryRows,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import type { ContractRow } from "@/lib/contracts/types";

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

  return employeeDirectoryErrorMessage(error);
}

function addYears(value: string | null, years: number) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setFullYear(date.getFullYear() + years);
  return date.toISOString().slice(0, 10);
}

export default async function ContractsPage() {
  let initialData: ContractRow[] | null = null;
  let initialError: string | null = null;

  try {
    const rows = await getEmployeeDirectoryRows();
    initialData = rows.map((employee) => {
      const renewalDate = addYears(employee.hireDate, 1);
      const renewalDay = renewalDate ? new Date(`${renewalDate}T00:00:00`).getDate() : 0;

      return {
        area: employee.areaName ?? "Unassigned",
        contract_renewal_date: renewalDate,
        contract_signed_date: employee.hireDate ?? "",
        crm_id: employee.crmId ?? "",
        full_name: employee.fullName,
        hr_id: employee.hrId,
        job_title: employee.jobTitle ?? "Unassigned",
        line: employee.lineName ?? "Unassigned",
        renewal_day: renewalDay,
      };
    });
  } catch (error) {
    initialError = contractsPageError(error);
  }

  return (
    <AppShell>
      <ContractRenewal
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
