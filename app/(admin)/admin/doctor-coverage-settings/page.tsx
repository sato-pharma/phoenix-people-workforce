import { redirect } from "next/navigation";

import { DoctorCoverageNormsEditor } from "@/components/crm/doctor-coverage-norms-editor";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { getDoctorCoverageConfig } from "@/lib/crm/doctor-coverage-config";
import { getDoctorCoverageOverrideOptions } from "@/lib/crm/doctor-coverage-scope";

export const dynamic = "force-dynamic";

// Admin editor for the Doctor Coverage visit norms — how many visits a month each grade needs,
// separately for doctors (SP) and for pharmacies/hospitals/contracts/insurance (HCP).
//
// Gated at crm_visits:update, held only by Super Admin and SFE Manager. The page gate mirrors the
// API route's gate exactly so the link, the page and the write all agree; the route is the real
// boundary, since a page gate alone protects nothing.
export default async function DoctorCoverageSettingsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!(await canAccess(access, "crm_visits", "update"))) {
    redirect("/admin");
  }

  // Options for the line-exception editor: who it can apply to, and the real line names.
  const [config, options] = await Promise.all([getDoctorCoverageConfig(), getDoctorCoverageOverrideOptions()]);

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">Doctor Coverage Settings</h1>
        <p className="text-sm text-slate-500">
          Visits required per month, by grade — set separately for doctors and for pharmacies, hospitals and
          contract/insurance accounts.
        </p>
      </div>
      <DoctorCoverageNormsEditor candidates={options.candidates} initial={config} lines={options.lines} />
    </div>
  );
}
