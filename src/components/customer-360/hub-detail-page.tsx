import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";

import { HubDetail } from "@/components/customer-360/hub-view";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { hubHref } from "@/lib/customer-360/list";
import { loadCustomer360Report } from "@/lib/customer-360/server/report";
import type { HubKind } from "@/lib/customer-360/validated";

/**
 * One validated doctor's or account's page. Both routes render this: the hub is looked up in the
 * viewer's OWN scoped report, so a typed URL can never reach a customer the list would not offer.
 */
export async function Customer360HubPage({ kind, hubId }: { kind: HubKind; hubId: string }) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  await assertPermission(access, "sales", "read");

  const id = decodeURIComponent(hubId);
  const report = await loadCustomer360Report(access);
  const hub = report.hubs.find((entry) => entry.id === id);
  if (!hub) redirect("/customer-360");
  // A doctor's link opened under accounts (or the reverse) goes to the right address.
  if (hub.kind !== kind) redirect(hubHref(hub.kind, hub.id));

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <Link
        href={`/customer-360?kind=${hub.kind}`}
        className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-700 hover:underline"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Back to Customer 360
      </Link>
      <HubDetail hub={hub} lastMonths={report.lastMonths} closedMonths={report.months.all} distributorNames={report.distributorNames} />
    </div>
  );
}
