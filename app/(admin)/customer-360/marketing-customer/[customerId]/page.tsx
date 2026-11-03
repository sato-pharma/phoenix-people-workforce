import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";

import { adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { hubHref } from "@/lib/customer-360/list";
import { findHubHoldingMarketingCustomer } from "@/lib/customer-360/hrefs";
import { loadCustomer360Report } from "@/lib/customer-360/server/report";

export const dynamic = "force-dynamic";

/**
 * A marketing request knows its customer, and a Customer 360 page is keyed on the validated doctor or
 * account that customer belongs to, so this route finds one from the other and moves on. Same gate as
 * the hub page, and the lookup runs in the viewer's OWN scoped report: a typed address can never reach
 * a customer the list would not offer.
 */
export default async function Customer360MarketingCustomerPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  await assertPermission(access, "sales", "read");

  const { customerId } = await params;
  const report = await loadCustomer360Report(access);
  const hub = findHubHoldingMarketingCustomer(report.hubs, decodeURIComponent(customerId));
  if (hub) redirect(hubHref(hub.kind, hub.id));

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <Link href="/customer-360" className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-700 hover:underline">
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Back to Customer 360
      </Link>
      <p className={`${adminSoftPanelClassName} px-4 py-6 text-sm text-slate-600`}>
        This customer is not in your Customer 360. It may not be linked to a validated doctor or account yet, or it may
        be outside your territory.
      </p>
    </div>
  );
}
