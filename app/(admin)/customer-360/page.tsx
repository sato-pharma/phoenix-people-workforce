import { Building2 } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { Customer360HubList } from "@/components/customer-360/hub-list";
import { PharmacyMatchQueue } from "@/components/customer-360/pharmacy-match-queue";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { HUB_LINES } from "@/lib/customer-360/hub";
import { hubHref, hubListFiltersFromParams } from "@/lib/customer-360/list";
import { hubListRow } from "@/lib/customer-360/list-row";
import { toMatchQueueItems } from "@/lib/customer-360/match-queue";
import { loadCustomer360Report } from "@/lib/customer-360/server/report";
import { monthLabel } from "@/lib/customer-360/verdict";
import { cairoDateTime } from "@/lib/format/cairo-datetime";

export const dynamic = "force-dynamic";

/**
 * Customer 360 (owner, 2026-10-18): every VALIDATED doctor and account, linked to the lines that
 * visit it, the pharmacies tied to it, the marketing money and the direct orders — with a verdict on
 * whether the money came back. It updates itself: a customer validated this morning is on the next
 * read (`src/lib/customer-360/server/report.ts`).
 */
export default async function Customer360Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  await assertPermission(access, "sales", "read");

  const params = await searchParams;
  const filters = hubListFiltersFromParams(params);
  const report = await loadCustomer360Report(access);
  const rows = report.hubs.map((hub) => hubListRow(hub, report.lastMonths));
  const matchItems = toMatchQueueItems(report.matchItems, report.distributorNames, report.brickNames, hubHref);
  const waiting = matchItems.filter((item) => item.status === "waiting").length;
  const tab = params.tab === "matches" && report.canDecideMatches ? "matches" : filters.kind;
  const closedMonths = report.months.all;
  const closedRange = closedMonths.length > 0 ? `${monthLabel(closedMonths[0]!)} to ${monthLabel(closedMonths[closedMonths.length - 1]!)}` : null;
  const lastMonthsLabel = report.lastMonths.map(monthLabel).join(", ") || "the closed months";

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <AdminPageHero
        eyebrow="CUSTOMER INTELLIGENCE"
        title="Customer 360"
        description="Every validated doctor and account: the lines that visit them, the pharmacies tied to them, the marketing money spent on them and whether it came back."
        icon={<Building2 className="h-3.5 w-3.5" />}
        badges={
          <>
            <AdminInsightChip tone="orange">{rows.length.toLocaleString("en-US")} validated customers</AdminInsightChip>
            <AdminInsightChip>
              Updated {cairoDateTime(report.builtAt)}
              {report.refreshing ? " · refreshing" : ""}
            </AdminInsightChip>
            {closedRange ? <AdminInsightChip>Closed months {closedRange}</AdminInsightChip> : null}
          </>
        }
      />

      <Customer360HubList
        rows={rows}
        initialFilters={filters}
        initialTab={tab}
        lines={HUB_LINES.map((line) => line.label)}
        moneyVisible={report.moneyVisible}
        canDecideMatches={report.canDecideMatches}
        waitingMatches={waiting}
        matchesTab={report.canDecideMatches ? <PharmacyMatchQueue items={matchItems} lastMonthsLabel={lastMonthsLabel} /> : null}
      />
    </div>
  );
}
