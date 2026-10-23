import { Package } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { PmProductsEditor } from "@/components/admin/pm-products-editor";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveEmployee360RoleCategory } from "@/lib/employee-360/roles";
import { listPmProductAssignments, listPmProductOptions } from "@/lib/employee-360/pm-products";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";

export const dynamic = "force-dynamic";

const READ_ROLES = new Set<PhoenixRole>(["Super Admin", "CEO", "SFE Manager"]);

export default async function PmProductsPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/admin/pm-products");
  if (!READ_ROLES.has(access.role)) redirect("/");

  const [rows, options, assignments] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: false }),
    listPmProductOptions(),
    listPmProductAssignments(),
  ]);

  const pms = rows
    .filter((r) => resolveEmployee360RoleCategory(r.jobTitle ?? r.positionTitle) === "product-manager")
    .map((r) => ({
      hrId: r.hrId,
      name: r.displayName || r.fullName,
      jobTitle: r.jobTitle,
      line: r.lineName,
      codes: assignments.get(canonicalHrIdKey(r.hrId) ?? "") ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const assignedCount = pms.filter((p) => p.codes.length > 0).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <AdminPageHero
        eyebrow="SALES CONFIG"
        title="Product Manager — Product Master"
        description="Assign the products each Product / Group Product Manager owns. Employee 360 attributes a PM's sales by these products (they have no team to roll up). Super Admin edits; CEO and SFE Manager can view."
        icon={<Package className="h-3.5 w-3.5" />}
        badges={
          <>
            <AdminInsightChip tone="orange">{pms.length} product managers</AdminInsightChip>
            <AdminInsightChip>{assignedCount} with assignments</AdminInsightChip>
            <AdminInsightChip>{options.length} products</AdminInsightChip>
          </>
        }
      />
      <PmProductsEditor pms={pms} options={options} canEdit={access.role === "Super Admin"} />
    </div>
  );
}
