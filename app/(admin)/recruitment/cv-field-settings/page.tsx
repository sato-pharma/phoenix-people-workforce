import { redirect } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { PageContainer } from "@/components/layout/page-container";
import { CvFieldSettingsView } from "@/components/recruitment/cv-field-settings-view";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canManageCvFieldSettings } from "@/lib/recruitment/access";
import { listCvFieldSettingsView } from "@/lib/recruitment/cv-field-settings";

export const dynamic = "force-dynamic";

// Runtime include/exclude switch for every field CV extraction can read — the owner's "an option
// to exclude or include this field" (see src/lib/recruitment/cv-field-settings.ts). Enabled is the
// default; an off field is dropped from the AI request schema itself.
export default async function CvFieldSettingsPage() {
  const access = await resolveAccessContextFromPage();
  // Guarded like app/(admin)/recruitment/cv-review-queue/page.tsx, NOT on
  // resolveNavigationMode(access) === "employee-portal": Talent Acquisition is a member of
  // portalNavigationRoles, so that test would send this page's primary user straight back out.
  // Role + permission is what actually expresses "may an HR authority configure this here".
  // Talent Acquisition reaches it through the portal twin at
  // app/employee-portals/cv-field-settings/page.tsx.
  //
  // The gate that actually holds is server-side: PATCH /api/recruitment/cv-field-settings asserts
  // recruitment:update before any write.
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    redirect("/employee-portals");
  }
  if (!canManageCvFieldSettings(access)) {
    redirect("/employee-portals");
  }

  let fields;
  try {
    fields = await listCvFieldSettingsView();
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-lg font-semibold text-slate-900">CV field settings unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
      </div>
    );
  }

  return (
    <PageContainer>
      <div className="mx-auto max-w-5xl space-y-6">
        <AdminPageHero
          description="Every field the CV reader can extract, for any job title. Switch one off and it is dropped from the AI request entirely — no tokens spent, no value returned. Identity fields stay on because candidate matching is built on them."
          eyebrow="Recruitment"
          icon={<SlidersHorizontal className="h-5 w-5" />}
          title="CV Field Settings"
        />
        <CvFieldSettingsView fields={fields} />
      </div>
    </PageContainer>
  );
}
