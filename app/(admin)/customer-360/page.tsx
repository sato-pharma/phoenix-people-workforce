import { Building2 } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import {
  CustomerSearchList,
  type Customer360ListItem,
} from "@/components/customer-360/customer-search-list";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { filterCustomerSubjectsForViewer } from "@/lib/customer-360/access";
import { listCustomerSubjects } from "@/lib/customer-360/service";
import { resolveSalesAccessScope } from "@/lib/sales/access-scope";

export const dynamic = "force-dynamic";

export default async function Customer360IndexPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  await assertPermission(access, "sales", "read");

  // The picker is scoped, not just the detail page: the names this list offers ARE the
  // disclosure. See src/lib/customer-360/access.ts.
  const scope = await resolveSalesAccessScope(access);
  const visible = filterCustomerSubjectsForViewer(await listCustomerSubjects(), {
    allowedAreaCodes: scope.allowedAreaCodes,
    allowedLineNames: scope.allowedLineNames,
    allowedRegionNames: scope.allowedRegionNames,
    canViewAllSales: scope.canViewAllSales,
  });

  const customers: Customer360ListItem[] = visible.map((subject) => ({
    areaCode: subject.areaCode,
    areaName: subject.areaName,
    codeCount: subject.codeCount,
    displayName: subject.displayName,
    id: subject.id,
    lineName: subject.lineName,
    ownerName: subject.ownerName,
    register: subject.register,
    regionName: subject.regionName,
    validationStatus: subject.validationStatus,
    venueType: subject.venueType,
  }));

  const areaCount = new Set(customers.map((c) => c.areaName).filter(Boolean)).size;
  const withCodes = customers.filter((c) => c.codeCount > 0).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <AdminPageHero
        eyebrow="CUSTOMER INTELLIGENCE"
        title="Customer 360"
        description="One page per pharmacy: the campaigns raised for it, the orders placed on it, and the sales that actually landed — joined through the distributor code each distributor knows it by."
        icon={<Building2 className="h-3.5 w-3.5" />}
        badges={
          <>
            <AdminInsightChip tone="orange">{customers.length} customers</AdminInsightChip>
            <AdminInsightChip>
              {withCodes} with a distributor code · {areaCount} areas
            </AdminInsightChip>
          </>
        }
      />

      {customers.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">
            No customers are visible to your role here. Customer 360 covers the pharmacies your own
            territory engages through marketing or direct orders.
          </p>
        </Card>
      ) : (
        <CustomerSearchList customers={customers} />
      )}
    </div>
  );
}
