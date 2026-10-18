import { redirect } from "next/navigation";
import { CalendarX2 } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { FieldAbsenceCalendarView } from "@/components/field-absence/field-absence-calendar";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canReadFieldAbsence } from "@/lib/field-absence/access";
import { loadFieldAbsencePage } from "@/lib/field-absence/server/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

/**
 * Field Absence Calendar — the admin door, for the Super Admin, the CEO and the SFE Manager.
 *
 * The owner, 2026-10-18: *"At the end of the day, I want to be able to track daily who didn't go to
 * work."* Every working day lists the field people the system did not see at all — no CRM visit, no
 * double visit, no vacation filed, no business trip, no fingerprint punch. The rule and its sources
 * live in `src/lib/field-absence/`; this page is a gate and a shell.
 *
 * The National Sales Manager is a portal seat, so `app/(admin)/layout.tsx` sends him to the twin
 * before this page runs — the redirect below is the declaration `portal-twins.ts` lifts to the layout.
 */
export default async function FieldAbsencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/field-absence");
  if (!canReadFieldAbsence(access) || !(await canAccess(access, "field_absence", "read"))) redirect("/admin");

  const params = await searchParams;
  const data = await loadFieldAbsencePage(access, {
    line: first(params.line),
    month: first(params.month),
    view: first(params.view),
    week: first(params.week),
  });

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Every working day lists the field people the system did not see at all: no CRM visit, no double visit, no vacation filed, no business trip and no fingerprint punch. Friday, a Saturday off and national holidays are left out; Thursday is a half day."
        eyebrow="Sales force"
        icon={<CalendarX2 className="h-3.5 w-3.5" />}
        title="Field Absence Calendar"
      />
      <CrmSurfaceProvider surface="admin">
        <FieldAbsenceCalendarView basePath="/admin/field-absence" data={data} />
      </CrmSurfaceProvider>
    </div>
  );
}
