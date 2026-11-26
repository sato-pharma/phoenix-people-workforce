import { redirect } from "next/navigation";
import { FileSpreadsheet } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { RepExportDesk } from "@/components/rep-visits-export/rep-export-desk";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cairoTodayIso } from "@/lib/crm/dates";
import { addMonths, REVIEW_MAX_KPI_MONTHS, REVIEW_MAX_PERIOD_MONTHS } from "@/lib/sales/rep-effectiveness/model";
import { REP_VISITS_EXPORT_MAX_DAYS } from "@/lib/rep-visits-export/rules";
import { canExportRepVisits, loadRepVisitsExportOptions, type RepVisitsExportOption } from "@/lib/rep-visits-export/server";

export const dynamic = "force-dynamic";

const EXPORT_ROUTE = "/api/admin/rep-visits-export";
const REVIEW_ROUTE = "/api/admin/rep-effectiveness-export";

/**
 * Rep visits export (owner, 24 Nov 2026): choose a rep and a range, download the workbook. Since 26 Nov 2026 the
 * reps are filtered by line and probation zone and one or many are chosen, each over the chosen range or from
 * their own hire date ("filter line pedia probation status critical and filter from their hire date to utd";
 * "one or multiple as i want") — the desk is `RepExportDesk`, and several reps save as one zip — the Cover, the
 * visits day by day, the area's bricks, repeat visits, every day of the range with its record, the visits as
 * a pivot-ready table, and the doctor list by brick. The Super Admin's alone, asked here, on the route and in
 * the loader; anybody else is redirected rather than told the page exists.
 *
 * Below it, the effectiveness review (owner, 25 Nov 2026: "i want to be able to export from system xlsx and
 * pdf"), for the months the viewer chooses ("i want to be able to export per rep in the chosen period"): the
 * same rep's area over the published closing months inside them — customers per product per month first,
 * then KPIs and sales against target — as Excel or as a PDF.
 */
export default async function RepVisitsExportPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!canExportRepVisits(access)) redirect(resolveLandingPathForRole(access.role));
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");

  const today = cairoTodayIso();
  const monthStart = `${today.slice(0, 7)}-01`;
  const currentMonth = today.slice(0, 7);
  const reviewFrom = addMonths(currentMonth, -(REVIEW_MAX_PERIOD_MONTHS - 1));
  const [options, failed] = await loadRepVisitsExportOptions(access).then(
    (value) => [value, false] as const,
    () => [[] as RepVisitsExportOption[], true] as const,
  );

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Rep visits export"
        description="One rep or many, filtered by line and probation, each as an Excel workbook: the rep's cover, the visits day by day, the area's bricks, repeat visits, every day of the range with its record, a table ready to pivot, and the doctor list by brick."
        icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
      />

      {failed ? (
        <AdminCallout tone="warning">
          <span>The list of reps could not be read just now. Reload the page to try again.</span>
        </AdminCallout>
      ) : null}

      <RepExportDesk
        options={options}
        today={today}
        visitsRoute={EXPORT_ROUTE}
        reviewRoute={REVIEW_ROUTE}
        visitsMaxDays={REP_VISITS_EXPORT_MAX_DAYS}
        reviewMaxMonths={REVIEW_MAX_PERIOD_MONTHS}
        visitsDefaultFrom={monthStart}
        reviewDefaultFrom={reviewFrom}
      />

      <p className="text-sm leading-6 text-slate-600">
        The effectiveness review covers up to {REVIEW_MAX_PERIOD_MONTHS} months at a time. Sales and targets are the published monthly closing, so
        a month not yet published is left out; the KPIs are the latest {REVIEW_MAX_KPI_MONTHS} months of the period from the rep&apos;s hire
        month. Each review takes up to a minute to prepare, so several reps take several minutes; keep the page open until the zip is saved.
      </p>
    </div>
  );
}
