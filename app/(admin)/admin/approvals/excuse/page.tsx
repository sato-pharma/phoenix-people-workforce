import { redirect } from "next/navigation";
import { Clock } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { ExcuseApprovalsBody } from "@/components/approvals-hub/excuse-approvals-body";
import { getExcuseWorkspaceData } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminExcuseApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/approvals/excuse");
  const data = await getExcuseWorkspaceData(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Approvals Hub"
        title="Excuse Approvals"
        description="Excuse requests waiting on your response, and your full response history."
        icon={<Clock className="h-3.5 w-3.5" />}
      />
      <ExcuseApprovalsBody data={data} />
    </div>
  );
}
