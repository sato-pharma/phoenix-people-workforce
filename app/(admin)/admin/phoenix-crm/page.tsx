import { redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { parsePhoenixCrmTab, PhoenixCrmSpace } from "@/components/employee-portal/phoenix-crm-space";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getPhoenixCrmAccess } from "@/lib/crm/native-visits/phoenix-crm";

export const dynamic = "force-dynamic";

function preservedQuery(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const key of ["tab", "month"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

// Phoenix CRM in the admin shell (the owner, 2026-09-14). The employee portal twin is
// /employee-portals/phoenix-crm.
export default async function AdminPhoenixCrmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  const params = await searchParams;
  const tab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const month = Array.isArray(params.month) ? params.month[0] : params.month;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/phoenix-crm${preservedQuery(params)}`);
  }
  const { seat } = await getPhoenixCrmAccess(access);
  if (!seat) redirect("/admin");

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Phoenix CRM"
        description="Visits, weekly plans and KPIs of the pilot reps, from what they entered in Phoenix only. Pick the reps in the pilot under Pilot reps."
        icon={<ClipboardList className="h-3.5 w-3.5" />}
      />
      <PhoenixCrmSpace access={access} basePath="/admin/phoenix-crm" month={month} seat={seat} tab={parsePhoenixCrmTab(tab, seat)} />
    </div>
  );
}
