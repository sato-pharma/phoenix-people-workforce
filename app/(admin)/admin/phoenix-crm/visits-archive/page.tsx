import Link from "next/link";
import { redirect } from "next/navigation";
import { Archive, ArrowRight, Copy, Megaphone, MapPinOff, Ruler } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { phxButtonGhostClassName, phxButtonPrimaryClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import {
  canReadVisitArchive,
  loadVisitArchiveOptions,
  loadVisitArchivePage,
  loadVisitArchiveTotals,
  type VisitArchiveOptions,
  type VisitArchiveRow,
} from "@/lib/phoenix-crm/server/visit-archive";
import {
  VISIT_ARCHIVE_PAGE_SIZE,
  VISIT_ARCHIVE_PATH,
  VISIT_ARCHIVE_REASON_LABELS,
  VISIT_ARCHIVE_TAB_LABELS,
  VISIT_ARCHIVE_TAB_REASONS,
  VISIT_ARCHIVE_TABS,
  parseVisitArchiveFilter,
  visitArchiveDateText,
  visitArchiveDistanceText,
  visitArchiveHref,
  visitArchiveMonthLabel,
  visitArchivePointText,
  visitArchiveReasonLabel,
} from "@/lib/phoenix-crm/visit-archive-rules";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * The visits archive — the old iReports360 visits Phoenix CRM did not carry over as visits (owner,
 * 2026-11-07), in two tabs: "Campaign and no location" (a campaign visit, or a visit with no check-in
 * location) and "Far from the doctor" (a converted visit whose check-in lay more than visit_far_meters from
 * the doctor's validated place, with the distance and both points — no map). Read-only: nothing on this
 * page acts, and nothing here is a verdict on anybody. Both tabs sit behind the one gate below.
 *
 * 🔴 THE ADMIN CRM WORKSPACE'S TWO PEOPLE — `canUseAdminCrmWorkspace` (Super Admin + SFE Manager), the
 * same gate as /admin/crm, asked here and again inside every loader. It sits under /admin, which a rep or
 * a field manager cannot open, and anybody else is redirected rather than told the page exists.
 *
 * The rows come a page at a time, by keyset on (visit_date desc, crm_visit_id desc); the address carries
 * the filter and the cursor, so a page can be bookmarked and the browser's Back returns to the one before.
 */

const EMPTY_OPTIONS: VisitArchiveOptions = { months: [], reps: [], lines: [], rowsWithoutHrId: 0, capped: false };

function RepName({ row }: { row: VisitArchiveRow }) {
  return (
    <span className="break-words">
      {row.repName}
      {row.repLeft ? <span className="text-xs font-semibold text-slate-500"> · Left</span> : null}
    </span>
  );
}

function FarPoints({ row }: { row: VisitArchiveRow }) {
  return (
    <span className="block break-words text-xs leading-5 text-slate-600">
      <span className="font-semibold text-slate-700">Check-in</span> {visitArchivePointText(row.checkin?.lat, row.checkin?.lon)}
      <br />
      <span className="font-semibold text-slate-700">Validated place</span> {visitArchivePointText(row.place?.lat, row.place?.lon)}
    </span>
  );
}

function Copied({ row }: { row: VisitArchiveRow }) {
  return <span className={row.copiedIntoPhoenix ? "text-slate-900" : "text-slate-500"}>{row.copiedIntoPhoenix ? "Yes" : "No"}</span>;
}

export default async function PhoenixCrmVisitsArchivePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  // The admin CRM workspace's gate, as on /admin/crm: Super Admin and SFE Manager.
  if (!canUseAdminCrmWorkspace(access) || !canReadVisitArchive(access)) redirect(resolveLandingPathForRole(access.role));
  // And a per-account module lock on Phoenix CRM closes it too, as it closes every page beside it.
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");

  const filter = parseVisitArchiveFilter(await searchParams);
  const base = { tab: filter.tab, month: filter.month, reason: filter.reason, rep: filter.rep, line: filter.line };
  const far = filter.tab === "far";
  const tabReasons = VISIT_ARCHIVE_TAB_REASONS[filter.tab];

  const [options, optionsFailed] = await loadVisitArchiveOptions(access).then(
    (value) => [value, false] as const,
    () => [EMPTY_OPTIONS, true] as const,
  );
  const lineNames = new Map(options.lines.map((line) => [line.code, line.name]));
  const [page, totals] = await Promise.all([loadVisitArchivePage(access, filter, lineNames), loadVisitArchiveTotals(access, filter)]);

  const filtered = Boolean(filter.month || filter.reason || filter.rep || filter.line);
  const scopeText = filter.month ? visitArchiveMonthLabel(filter.month) : "Every month";

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Visits archive"
        description="The old iReports360 visits Phoenix CRM did not take over as visits — campaign visits, visits that carried no check-in location, and visits whose check-in lay far from the doctor's validated place. They are kept here as they were recorded, they count in no visit figure, and nothing on this page changes them."
        icon={<Archive className="h-3.5 w-3.5" />}
      />

      {/* The tabs: the same look as the sibling CRM boards' tabs, as links so the address carries the tab. */}
      <nav aria-label="Archive tabs" className="flex min-w-0 flex-wrap border-b border-slate-200">
        {VISIT_ARCHIVE_TABS.map((tab) => (
          <Link
            key={tab}
            aria-current={filter.tab === tab ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex min-h-11 min-w-0 flex-wrap items-center gap-2 border-b-2 px-4 py-2.5 text-left text-sm font-black",
              filter.tab === tab ? "border-orange-500 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700",
            )}
            href={visitArchiveHref({ tab, month: filter.month, reason: null, rep: filter.rep, line: filter.line })}
          >
            <span className="break-words">
              {VISIT_ARCHIVE_TAB_LABELS[tab]} ({totals.byTab[tab].toLocaleString("en-US")})
            </span>
          </Link>
        ))}
      </nav>

      {far ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <AdminStatCard
            icon={<Ruler className="h-5 w-5" />}
            label={VISIT_ARCHIVE_REASON_LABELS.far}
            value={totals.total}
            description={filtered ? "Matching the filter below" : "Check-in farther than the far line from the validated place"}
            tone="orange"
            size="compact"
          />
          <AdminStatCard icon={<Copy className="h-5 w-5" />} label="Copied into Phoenix" value={totals.copiedIntoPhoenix} description="Held as a Phoenix CRM visit, counted nowhere" tone="emerald" size="compact" />
        </div>
      ) : (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard icon={<Archive className="h-5 w-5" />} label="Archived visits" value={totals.total} description={filtered ? "Matching the filter below" : "Campaign visits and visits with no location"} tone="blue" size="compact" />
        <AdminStatCard
          icon={<Megaphone className="h-5 w-5" />}
          label={VISIT_ARCHIVE_REASON_LABELS.campaign}
          value={totals.byReason.campaign}
          description="Campaign days recorded in the old CRM"
          tone="violet"
          size="compact"
        />
        <AdminStatCard
          icon={<MapPinOff className="h-5 w-5" />}
          label={VISIT_ARCHIVE_REASON_LABELS.no_checkin_location}
          value={totals.byReason.no_checkin_location}
          description="Visits the old CRM saved with no position"
          tone="orange"
          size="compact"
        />
        <AdminStatCard icon={<Copy className="h-5 w-5" />} label="Copied into Phoenix" value={totals.copiedIntoPhoenix} description="Also held as a Phoenix CRM visit" tone="emerald" size="compact" />
      </div>
      )}

      {optionsFailed ? (
        <AdminCallout tone="warning">
          <span>The month, rep and line lists could not be read just now, so only the reason can be chosen. The rows and the totals below are complete.</span>
        </AdminCallout>
      ) : null}

      {options.capped ? (
        <AdminCallout tone="neutral">
          <span>The archive holds more rows than the filter lists read, so a month, a rep or a line may be missing from them. The rows and the totals are complete.</span>
        </AdminCallout>
      ) : null}

      <form
        action={VISIT_ARCHIVE_PATH}
        method="get"
        className={cn("grid grid-cols-1 gap-3 border border-slate-200 bg-white p-4 sm:grid-cols-2", far ? "lg:grid-cols-4" : "lg:grid-cols-5")}
      >
        {far ? <input type="hidden" name="tab" value="far" /> : null}
        <label className="min-w-0">
          <span className={phxLabelClassName}>Month</span>
          <select name="month" defaultValue={filter.month ?? ""} className={phxSelectClassName}>
            <option value="">Every month</option>
            {options.months.map((month) => (
              <option key={month} value={month}>
                {visitArchiveMonthLabel(month)}
              </option>
            ))}
          </select>
        </label>
        {tabReasons.length > 1 ? (
          <label className="min-w-0">
            <span className={phxLabelClassName}>Reason</span>
            <select name="reason" defaultValue={filter.reason ?? ""} className={phxSelectClassName}>
              <option value="">Every reason</option>
              {tabReasons.map((reason) => (
                <option key={reason} value={reason}>
                  {VISIT_ARCHIVE_REASON_LABELS[reason]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="min-w-0">
          <span className={phxLabelClassName}>Rep</span>
          <select name="rep" defaultValue={filter.rep ?? ""} className={phxSelectClassName}>
            <option value="">Every rep</option>
            {options.reps.map((rep) => (
              <option key={rep.hrId} value={rep.hrId}>
                {rep.left ? `${rep.name} · Left` : rep.name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0">
          <span className={phxLabelClassName}>Line</span>
          <select name="line" defaultValue={filter.line ?? ""} className={phxSelectClassName}>
            <option value="">Every line</option>
            {options.lines.map((line) => (
              <option key={line.code} value={line.code}>
                {line.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <button type="submit" className={phxButtonPrimaryClassName}>
            Show
          </button>
          {filtered ? (
            <Link href={visitArchiveHref({ tab: filter.tab, month: null, reason: null, rep: null, line: null })} className={phxButtonGhostClassName}>
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {page.rows.length === 0 ? (
        <AdminCallout tone="neutral">
          <span>{filter.cursor ? "There are no more archived visits for this choice." : "No archived visit matches this choice."}</span>
        </AdminCallout>
      ) : (
        <AdminTableShell
          title={filter.cursor ? `${scopeText} · a later page` : scopeText}
          description={`Newest first, ${VISIT_ARCHIVE_PAGE_SIZE} to a page. A rep who has left the company is marked so; a rep the old CRM did not tie to an employee is shown by the name it recorded.`}
        >
          {far ? (
            <>
              {/* Far from the doctor — desktop: the full table, fitted to the screen. */}
              <div className="hidden lg:block">
                <table className="w-full table-fixed border-collapse">
                  <colgroup>
                    <col className="w-[14%]" />
                    <col className="w-[22%]" />
                    <col className="w-[24%]" />
                    <col className="w-[12%]" />
                    <col className="w-[28%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                      <th className="px-5 py-3">Date</th>
                      <th className="px-5 py-3">Rep</th>
                      <th className="px-5 py-3">Doctor</th>
                      <th className="px-5 py-3">Distance</th>
                      <th className="px-5 py-3">Check-in vs validated place</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((row) => (
                      <tr key={row.crmVisitId} className="border-b border-slate-100 align-top even:bg-slate-50/60">
                        <td className="px-5 py-3 text-sm text-slate-700">{visitArchiveDateText(row.visitDate)}</td>
                        <td className="px-5 py-3 text-sm font-semibold text-slate-900">
                          <RepName row={row} />
                          {row.lineName ? <div className="text-xs font-normal text-slate-500">{row.lineName}</div> : null}
                        </td>
                        <td className="break-words px-5 py-3 text-sm text-slate-700" dir="auto">
                          {row.customerName ?? "—"}
                        </td>
                        <td className="px-5 py-3 text-sm font-semibold text-slate-900">{visitArchiveDistanceText(row.distanceMeters)}</td>
                        <td className="px-5 py-3">
                          <FarPoints row={row} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Far from the doctor — mobile: the same visits as cards. */}
              <div className="space-y-3 px-5 py-4 sm:px-6 lg:hidden">
                {page.rows.map((row) => (
                  <div key={row.crmVisitId} className="border border-slate-200 bg-white p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="text-sm font-bold text-slate-900">
                        <RepName row={row} />
                      </span>
                      <span className="text-xs text-slate-500">{visitArchiveDateText(row.visitDate)}</span>
                    </div>
                    <p className="mt-1 break-words text-sm text-slate-700" dir="auto">
                      {row.customerName ?? "Doctor not recorded"}
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">{visitArchiveDistanceText(row.distanceMeters)} from the validated place</p>
                    <div className="mt-1">
                      <FarPoints row={row} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
          <>
          {/* Desktop: the full table. `table-fixed` with a colgroup, never a min-width in a scroller. */}
          <div className="hidden lg:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[16%]" />
                <col className="w-[24%]" />
                <col className="w-[30%]" />
                <col className="w-[18%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Rep</th>
                  <th className="px-5 py-3">Customer</th>
                  <th className="px-5 py-3">Reason</th>
                  <th className="px-5 py-3">In Phoenix</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={row.crmVisitId} className="border-b border-slate-100 align-top even:bg-slate-50/60">
                    <td className="px-5 py-3 text-sm text-slate-700">{visitArchiveDateText(row.visitDate)}</td>
                    <td className="px-5 py-3 text-sm font-semibold text-slate-900">
                      <RepName row={row} />
                      {row.lineName ? <div className="text-xs font-normal text-slate-500">{row.lineName}</div> : null}
                    </td>
                    <td className="break-words px-5 py-3 text-sm text-slate-700" dir="auto">
                      {row.customerName ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-700">{visitArchiveReasonLabel(row.reason)}</td>
                    <td className="px-5 py-3 text-sm">
                      <Copied row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: the same visits as cards. */}
          <div className="space-y-3 px-5 py-4 sm:px-6 lg:hidden">
            {page.rows.map((row) => (
              <div key={row.crmVisitId} className="border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-bold text-slate-900">
                    <RepName row={row} />
                  </span>
                  <span className="text-xs text-slate-500">{visitArchiveDateText(row.visitDate)}</span>
                </div>
                <p className="mt-1 break-words text-sm text-slate-700" dir="auto">
                  {row.customerName ?? "Customer not recorded"}
                </p>
                <p className="mt-2 break-words text-xs text-slate-500">
                  {visitArchiveReasonLabel(row.reason)}
                  {row.lineName ? ` · ${row.lineName}` : ""} · {row.copiedIntoPhoenix ? "Copied into Phoenix" : "Not in Phoenix"}
                </p>
              </div>
            ))}
          </div>
          </>
          )}
        </AdminTableShell>
      )}

      {filter.cursor || page.next ? (
        <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3">
          {filter.cursor ? (
            <Link href={visitArchiveHref(base)} className={phxButtonGhostClassName}>
              First page
            </Link>
          ) : (
            <span />
          )}
          {page.next ? (
            <Link href={visitArchiveHref(base, page.next)} className={phxButtonPrimaryClassName}>
              Next page
              <ArrowRight aria-hidden className="h-4 w-4 shrink-0" />
            </Link>
          ) : null}
        </nav>
      ) : null}

      {options.rowsWithoutHrId > 0 ? (
        <p className="text-xs leading-5 text-slate-500">
          {options.rowsWithoutHrId.toLocaleString("en-US")} archived {options.rowsWithoutHrId === 1 ? "visit carries" : "visits carry"} no employee link, so their rep
          cannot be chosen in the Rep list; they are listed under the name the old CRM recorded.
        </p>
      ) : null}
    </div>
  );
}
