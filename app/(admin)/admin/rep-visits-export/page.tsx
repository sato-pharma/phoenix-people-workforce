import { redirect } from "next/navigation";
import { FileSpreadsheet } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { phxButtonPrimaryClassName, phxFieldClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cairoTodayIso } from "@/lib/crm/dates";
import { REP_VISITS_EXPORT_MAX_DAYS } from "@/lib/rep-visits-export/rules";
import { canExportRepVisits, loadRepVisitsExportOptions, type RepVisitsExportOption } from "@/lib/rep-visits-export/server";

export const dynamic = "force-dynamic";

const EXPORT_ROUTE = "/api/admin/rep-visits-export";
const REVIEW_ROUTE = "/api/admin/rep-effectiveness-export";

/**
 * Rep visits export (owner, 24 Nov 2026): choose a rep and a range, download the workbook — the Cover, the
 * visits day by day, the area's bricks, repeat visits, every day of the range with its record, the visits as
 * a pivot-ready table, and the doctor list by brick. The Super Admin's alone, asked here, on the route and in
 * the loader; anybody else is redirected rather than told the page exists.
 *
 * Below it, the effectiveness review (owner, 25 Nov 2026: "i want to be able to export from system xlsx and
 * pdf"): the same rep's area over every published closing month — customers per product per month first,
 * then KPIs and sales against target — as Excel or as a PDF.
 */
export default async function RepVisitsExportPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!canExportRepVisits(access)) redirect(resolveLandingPathForRole(access.role));
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");

  const today = cairoTodayIso();
  const monthStart = `${today.slice(0, 7)}-01`;
  const [options, failed] = await loadRepVisitsExportOptions(access).then(
    (value) => [value, false] as const,
    () => [[] as RepVisitsExportOption[], true] as const,
  );

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Rep visits export"
        description="One rep, one range, as an Excel workbook: the rep's cover, the visits day by day, the area's bricks, repeat visits, every day of the range with its record, a table ready to pivot, and the doctor list by brick."
        icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
      />

      {failed ? (
        <AdminCallout tone="warning">
          <span>The list of reps could not be read just now. Reload the page to try again.</span>
        </AdminCallout>
      ) : null}

      <form action={EXPORT_ROUTE} method="get" className="grid grid-cols-1 gap-3 border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="min-w-0 sm:col-span-2 lg:col-span-1">
          <span className={phxLabelClassName}>Rep</span>
          <select name="rep" required defaultValue="" className={phxSelectClassName}>
            <option value="" disabled>
              Choose a rep
            </option>
            {options.map((option) => (
              <option key={option.hrId} value={option.hrId}>
                {option.name} · {option.territory}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0">
          <span className={phxLabelClassName}>From</span>
          <input type="date" name="from" required defaultValue={monthStart} max={today} className={phxFieldClassName} />
        </label>
        <label className="min-w-0">
          <span className={phxLabelClassName}>To</span>
          <input type="date" name="to" required defaultValue={today} max={today} className={phxFieldClassName} />
        </label>
        <div className="flex min-w-0 items-end">
          <button type="submit" className={phxButtonPrimaryClassName}>
            Download the workbook
          </button>
        </div>
      </form>

      <p className="text-sm leading-6 text-slate-600">
        Up to {REP_VISITS_EXPORT_MAX_DAYS} days at a time. Every visit the rep saved is listed, including visits still waiting for a decision.
        Brick sales appear only for months whose closing is published.
      </p>

      <section className="space-y-3 border-t border-slate-200 pt-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Effectiveness review</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            The rep&apos;s area over every published closing month: how many pharmacies bought each product each month, every
            pharmacy month by month, sales against target, the area&apos;s history before the rep, where the growth came from, and
            the KPIs against their targets beside the district colleagues.
          </p>
        </div>
        <form action={REVIEW_ROUTE} method="get" className="grid grid-cols-1 gap-3 border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="min-w-0 sm:col-span-2">
            <span className={phxLabelClassName}>Rep</span>
            <select name="rep" required defaultValue="" className={phxSelectClassName}>
              <option value="" disabled>
                Choose a rep
              </option>
              {options.map((option) => (
                <option key={option.hrId} value={option.hrId}>
                  {option.name} · {option.territory}
                </option>
              ))}
            </select>
          </label>
          <div className="flex min-w-0 items-end">
            <button type="submit" name="format" value="xlsx" className={phxButtonPrimaryClassName}>
              Download Excel
            </button>
          </div>
          <div className="flex min-w-0 items-end">
            <button type="submit" name="format" value="pdf" className={phxButtonPrimaryClassName}>
              Download PDF
            </button>
          </div>
        </form>
        <p className="text-sm leading-6 text-slate-600">
          Sales and targets are the published monthly closing, up to the last 12 published months. It takes up to a minute to
          prepare.
        </p>
      </section>
    </div>
  );
}
