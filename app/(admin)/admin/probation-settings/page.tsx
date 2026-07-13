import { redirect } from "next/navigation";

import { ProbationSettingsEditor } from "@/components/probation/probation-settings-editor";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { isProbationAdministrator } from "@/lib/probation/service";
import { getProbationConfig } from "@/lib/probation/intelligence/config";

export const dynamic = "force-dynamic";

// Admin editor for probation policy (weights, requirements, SLA, scorecard, HR toggle). Super-Admin only.
export default async function ProbationSettingsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!isProbationAdministrator(access)) {
    redirect("/admin");
  }

  const config = await getProbationConfig();

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">Probation Settings</h1>
        <p className="text-sm text-slate-500">Requirements, role weights, scoring scale, feedback SLA, scorecard dimensions, and the HR-assessment toggle.</p>
      </div>
      <ProbationSettingsEditor initial={config} />
    </div>
  );
}
