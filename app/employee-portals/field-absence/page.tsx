import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { FieldAbsenceCalendarView } from "@/components/field-absence/field-absence-calendar";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canReadFieldAbsence } from "@/lib/field-absence/access";
import { loadFieldAbsencePage } from "@/lib/field-absence/server/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

/**
 * Field Absence Calendar, the PORTAL half — the National Sales Manager's door, his own line only.
 *
 * Deliberately thin, like the admin page: both call `loadFieldAbsencePage`, which checks the grant,
 * the four roles and the scope again, so neither door can reach further than the other.
 */
export default async function FieldAbsencePortalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!canReadFieldAbsence(access) || !(await canAccess(access, "field_absence", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const data = await loadFieldAbsencePage(access, {
    line: first(params.line),
    month: first(params.month),
    view: first(params.view),
    week: first(params.week),
  });

  return (
    <EmployeePortalPageShell
      badge="Sales force"
      description="Every working day lists the people on your line the system did not see at all: no CRM visit, no double visit, no vacation filed, no business trip and no fingerprint punch."
      errorBoundaryTitle="Field Absence Calendar unavailable"
      title="Field Absence Calendar"
    >
      <CrmSurfaceProvider surface="portal">
        <FieldAbsenceCalendarView basePath="/employee-portals/field-absence" data={data} />
      </CrmSurfaceProvider>
    </EmployeePortalPageShell>
  );
}
