import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { CvFieldSettingsView } from "@/components/recruitment/cv-field-settings-view";
import { canAccess, isHrAuthorityRole, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canManageCvFieldSettings } from "@/lib/recruitment/access";
import { listCvFieldSettingsView } from "@/lib/recruitment/cv-field-settings";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/recruitment/cv-field-settings/page.tsx — same data, same gate,
// wrapped in the employee-portal shell instead of the admin shell. Kept in sync by hand, exactly
// like the CV Review Queue and CV Extraction Accuracy pairs next door.
//
// This mirror is what makes the switch reachable at all by the person who uses it. The owner ruled
// on 2026-08-14 that Talent Acquisition gets this tool, and Talent Acquisition is a member of
// portalNavigationRoles — so resolveNavigationMode puts them in the portal shell, and
// app/(admin)/layout.tsx redirects portal-mode users out of the entire admin group before any page
// in it renders. Without this file the hub card would have been a link they could not open.
// tests/recruitment-hub-portal-coverage.test.ts fails if a Talent-Acquisition-gated hub tool ever
// ships without its mirror.
export default async function EmployeePortalCvFieldSettingsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/recruitment/cv-field-settings");
  }
  if (
    !isHrAuthorityRole(access.role) ||
    !(await canAccess(access, "recruitment", "read")) ||
    !canManageCvFieldSettings(access)
  ) {
    return (
      <EmployeePortalEmptyState
        message="CV field settings are available to Talent Acquisition and Super Admin only."
        title="CV Field Settings Unavailable"
      />
    );
  }

  let fields;
  try {
    fields = await listCvFieldSettingsView();
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return <EmployeePortalEmptyState message={message} title="CV Field Settings Unavailable" />;
  }

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="Every field the CV reader can extract, for any job title. Switch one off and it is dropped from the AI request entirely — no tokens spent, no value returned. Identity fields stay on because candidate matching is built on them."
      errorBoundaryTitle="CV field settings unavailable"
      title="CV Field Settings"
    >
      <CvFieldSettingsView fields={fields} />
    </EmployeePortalPageShell>
  );
}
