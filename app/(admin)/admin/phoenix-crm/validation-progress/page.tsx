import { redirect } from "next/navigation";
import { BadgeCheck, ClipboardList, FileSpreadsheet, ShieldAlert } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard } from "@/components/admin/admin-design-system";
import { phxButtonGhostClassName, phxButtonPrimaryClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cairoDate } from "@/lib/format/cairo-datetime";
import { NEW_STARTER_DAYS, validatedShare, type ValidationProgressReport, type ValidationRepRow } from "@/lib/phoenix-crm/validation-progress-rules";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canReadValidationProgress, loadValidationProgress } from "@/lib/phoenix-crm/server/validation-progress";

export const dynamic = "force-dynamic";

const EXPORT_ROUTE = "/api/admin/phoenix-crm/validation-progress/export";
const PAGE_PATH = "/admin/phoenix-crm/validation-progress";

/**
 * Doctor list validation (owner, 26 Nov 2026: "build a page for administrator to be able to export the sheet … any
 * update happens in the system, the sheet is updated when I export it"). Each rep's AM and PM list — validated, not
 * validated, and of those, tried and blocked or never tried — with the hiring date, and one button that downloads the
 * same figures as a workbook read live at that moment.
 *
 * The Super Admin's and the SFE Manager's, asked here, on the route and in the loader; anybody else is sent to /admin.
 * Nothing on this page acts: no decision, no write, no notification, and no rep is told he was looked at.
 */
function shortDay(iso: string): string {
  return cairoDate(`${iso}T12:00:00Z`);
}

function hired(rep: ValidationRepRow): string {
  if (!rep.hireDate) return "No hiring date on file";
  const days = rep.daysSinceHire === null ? "" : ` · ${rep.daysSinceHire} ${rep.daysSinceHire === 1 ? "day" : "days"}`;
  return `Hired ${shortDay(rep.hireDate)}${days}`;
}

function lastValidation(rep: ValidationRepRow): string {
  return rep.lastValidatedDay ? `Last ${shortDay(rep.lastValidatedDay)}` : "None yet";
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function RepIdentity({ rep }: { rep: ValidationRepRow }) {
  return (
    <>
      <div className="text-sm font-semibold text-slate-900">{rep.repName}</div>
      <div className="text-xs text-slate-500">{rep.vacant ? "Nobody on this seat" : hired(rep)}</div>
      {rep.newStarter ? <div className="text-xs font-semibold text-amber-700">New starter</div> : null}
    </>
  );
}

function RepPlace({ rep }: { rep: ValidationRepRow }) {
  return (
    <>
      <div className="text-sm text-slate-700">
        {rep.lineName} · {rep.areaName}
      </div>
      <div className="text-xs text-slate-500">{rep.managerName}</div>
    </>
  );
}

function RepsTable({ report }: { report: ValidationProgressReport }) {
  return (
    <>
      <div className="hidden border border-slate-200 bg-white md:block">
        <table className="w-full table-fixed text-left">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[22%]" />
            <col className="w-[8%]" />
            <col className="w-[9%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[8%]" />
            <col className="w-[11%]" />
          </colgroup>
          <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Medical rep</th>
              <th className="px-3 py-2">Line · area · manager</th>
              <th className="px-3 py-2 text-right">Total list</th>
              <th className="px-3 py-2 text-right">Validated</th>
              <th className="px-3 py-2 text-right">Not validated</th>
              <th className="px-3 py-2 text-right">Tried, blocked</th>
              <th className="px-3 py-2 text-right">Never tried</th>
              <th className="px-3 py-2 text-right">Done</th>
            </tr>
          </thead>
          <tbody>
            {report.reps.map((rep) => (
              <tr key={rep.seatId} className="border-b border-slate-100 align-top last:border-b-0">
                <td className="px-3 py-2">
                  <RepIdentity rep={rep} />
                </td>
                <td className="px-3 py-2">
                  <RepPlace rep={rep} />
                </td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-slate-700">{rep.total}</td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-slate-700">{rep.validated}</td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-slate-700">{rep.notValidated}</td>
                <td className={`px-3 py-2 text-right text-sm tabular-nums ${rep.triedBlocked > 0 ? "font-semibold text-rose-700" : "text-slate-700"}`}>{rep.triedBlocked}</td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-slate-700">{rep.neverTried}</td>
                <td className="px-3 py-2 text-right">
                  <div className="text-sm tabular-nums text-slate-900">{percent(validatedShare(rep))}</div>
                  <div className="text-xs text-slate-500">{lastValidation(rep)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {report.reps.map((rep) => (
          <li key={rep.seatId} className="border border-slate-200 bg-white p-3">
            <RepIdentity rep={rep} />
            <div className="mt-1">
              <RepPlace rep={rep} />
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div>
                <dt className="text-slate-500">Total list</dt>
                <dd className="text-sm tabular-nums text-slate-900">{rep.total}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Validated</dt>
                <dd className="text-sm tabular-nums text-slate-900">
                  {rep.validated} · {percent(validatedShare(rep))}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Not validated</dt>
                <dd className="text-sm tabular-nums text-slate-900">{rep.notValidated}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Tried, blocked</dt>
                <dd className={`text-sm tabular-nums ${rep.triedBlocked > 0 ? "font-semibold text-rose-700" : "text-slate-900"}`}>{rep.triedBlocked}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Never tried</dt>
                <dd className="text-sm tabular-nums text-slate-900">{rep.neverTried}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Last validation</dt>
                <dd className="text-sm text-slate-900">{lastValidation(rep)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

export default async function PhoenixCrmValidationProgressPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadValidationProgress(viewer)) redirect("/admin");

  const params = await searchParams;
  const asked = typeof params.line === "string" ? params.line : null;
  const [report, failed] = await loadValidationProgress(viewer, { line: asked }).then(
    (value) => [value, false] as const,
    () => [null, true] as const,
  );

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="List validation"
        description="Each medical rep's AM and PM list: how many customers are validated, how many are still waiting, and of those, which the rep tried and was blocked on and which were never tried. The export is read from the system at the moment you press it."
        icon={<ClipboardList className="h-3.5 w-3.5" />}
      />

      <div className="grid gap-3 border border-slate-200 bg-white p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <form action={PAGE_PATH} method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1">
            <span className={phxLabelClassName}>Line</span>
            <select name="line" defaultValue={report?.line ?? ""} className={phxSelectClassName}>
              <option value="">Every line</option>
              {(report?.lines ?? []).map((line) => (
                <option key={line} value={line}>
                  {line}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={phxButtonGhostClassName}>
            Show
          </button>
        </form>
        <form action={EXPORT_ROUTE} method="get" className="flex flex-wrap items-end gap-3">
          {report?.line ? <input type="hidden" name="line" value={report.line} /> : null}
          <button type="submit" className={phxButtonPrimaryClassName}>
            <FileSpreadsheet className="mr-2 inline h-4 w-4" />
            Export to Excel
          </button>
          <p className="min-w-0 flex-1 text-sm leading-6 text-slate-600">
            {report?.line ?? "Every line"}: the cover, each rep with the hiring date and last validation, each district manager, and every customer not validated yet with the days the rep tried and was blocked.
          </p>
        </form>
      </div>

      {failed || !report ? (
        <AdminCallout tone="warning">
          <span>The lists could not be read just now. Reload the page to try again — the export reads them afresh when you press it.</span>
        </AdminCallout>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <AdminStatCard icon={<ClipboardList className="h-5 w-5" />} label="On the AM and PM lists" value={report.totals.total} description={`${report.totals.reps} reps · ${report.reps.filter((rep) => rep.newStarter).length} new starters (under ${NEW_STARTER_DAYS} days) · ${report.totals.vacantSeats} vacant seats`} tone="blue" size="compact" />
            <AdminStatCard icon={<BadgeCheck className="h-5 w-5" />} label="Validated" value={report.totals.validated} description={`${percent(report.totals.total === 0 ? 0 : report.totals.validated / report.totals.total)} of the lists`} tone="emerald" size="compact" />
            <AdminStatCard icon={<ClipboardList className="h-5 w-5" />} label="Never tried" value={report.totals.neverTried} description="Not validated, and no try recorded" tone="orange" size="compact" />
            <AdminStatCard icon={<ShieldAlert className="h-5 w-5" />} label="Tried and blocked" value={report.totals.triedBlocked} description="Not validated, at least one try refused" tone="rose" size="compact" />
          </div>
          <RepsTable report={report} />
        </>
      )}
    </div>
  );
}
