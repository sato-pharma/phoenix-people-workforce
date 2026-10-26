import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2, Eye, Layers, MapPinned } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { MasterListBoard } from "@/components/phoenix-crm/master-list-board";
import { phxButtonPrimaryClassName, phxFieldClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { areaRowsOf, bricksOf, countsOf, filterProfiles, STATUS_TEXT, type MasterStatus } from "@/lib/phoenix-crm/master-list";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canReadMasterList, loadMasterList } from "@/lib/phoenix-crm/server/master-list";

export const dynamic = "force-dynamic";

/**
 * The Master List — every validated customer once, at the place the photographs agree on (owner,
 * 2026-10-26: "build a master page for only the admin, and the CEO ... the list source of trust ...
 * separate regions and areas ... and bricks, and put in each brick per speciality").
 *
 * 🔴 THE SUPER ADMIN AND THE CEO ONLY, and under /admin for the same reason as the integrity board: it
 * sets one rep's readings beside another's, and a rep cannot open /admin at all. The CEO reads; the Super
 * Admin's click confirms ("my click and automatic").
 *
 * The overview is one row per region and area. Profiles are drawn only once an area, a brick or a name is
 * chosen, so the page never ships three thousand photographs at once.
 */

const STATUSES: MasterStatus[] = ["confirmed", "needs_look", "rejected"];

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? (value[0] ?? "") : (value ?? "")).trim();
}

function hrefOf(params: Record<string, string>): string {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value));
  const text = query.toString();
  return text ? `/admin/phoenix-crm/master-list?${text}` : "/admin/phoenix-crm/master-list";
}

export default async function PhoenixCrmMasterListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadMasterList(viewer)) redirect("/admin");

  const params = await searchParams;
  const status = STATUSES.includes(first(params.status) as MasterStatus) ? first(params.status) : "";
  const filter = { region: first(params.region), area: first(params.area), brick: first(params.brick), status, q: first(params.q) };

  const read = await loadMasterList(viewer);
  const counts = countsOf(read.profiles);
  const regions = [...new Set(read.profiles.map((profile) => profile.regionName))].sort();
  const areas = [...new Set(read.profiles.filter((profile) => !filter.region || profile.regionName === filter.region).map((profile) => profile.areaName))].sort();
  const bricks = filter.area
    ? [...new Set(read.profiles.filter((profile) => profile.areaName === filter.area).map((profile) => profile.brickName))].sort()
    : [];
  const drilled = Boolean(filter.area || filter.brick || filter.q);
  const shown = filterProfiles(read.profiles, filter);
  const overview = areaRowsOf(filterProfiles(read.profiles, { region: filter.region, status: filter.status }));

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Master List"
        description="Every validated customer once, at the place the reps' photographs agree on — by region, area, brick and speciality, with who holds the customer, on which lines, and when the visits happen. A profile is confirmed automatically when the photographs and the visits agree; the Super Admin's own click overrides it either way. No rep's place is ever moved from here."
        icon={<MapPinned className="h-3.5 w-3.5" />}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AdminStatCard icon={<MapPinned className="h-5 w-5" />} label="Profiles" value={counts.profiles} description="One per real place" tone="blue" size="compact" />
        <AdminStatCard icon={<CheckCircle2 className="h-5 w-5" />} label="Confirmed" value={counts.confirmed} description="By the photographs, the visits or the Super Admin's click" tone="emerald" size="compact" />
        <AdminStatCard icon={<Eye className="h-5 w-5" />} label="Needs a look" value={counts.needsLook} description="Not yet settled either way" tone="orange" size="compact" />
        <AdminStatCard icon={<Layers className="h-5 w-5" />} label="Held by more than one rep" value={counts.folded} description="Several validations, one profile" tone="violet" size="compact" />
      </div>

      {read.capped ? (
        <AdminCallout tone="warning">
          <span>There are more rows than this page reads at once, so some places or visits are missing from these counts.</span>
        </AdminCallout>
      ) : null}

      <form action="/admin/phoenix-crm/master-list" method="get" className="grid grid-cols-1 gap-3 border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-6">
        <label className="min-w-0">
          <span className={phxLabelClassName}>Region</span>
          <select name="region" defaultValue={filter.region} className={phxSelectClassName}>
            <option value="">Every region</option>
            {regions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0">
          <span className={phxLabelClassName}>Area</span>
          <select name="area" defaultValue={filter.area} className={phxSelectClassName}>
            <option value="">Every area</option>
            {areas.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0">
          <span className={phxLabelClassName}>Brick</span>
          <select name="brick" defaultValue={filter.brick} className={phxSelectClassName} disabled={bricks.length === 0}>
            <option value="">{bricks.length ? "Every brick" : "Choose an area first"}</option>
            {bricks.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0">
          <span className={phxLabelClassName}>Status</span>
          <select name="status" defaultValue={filter.status} className={phxSelectClassName}>
            <option value="">Every status</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_TEXT[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0">
          <span className={phxLabelClassName}>Customer name</span>
          <input name="q" defaultValue={filter.q} className={phxFieldClassName} dir="auto" />
        </label>
        <div className="flex min-w-0 items-end">
          <button type="submit" className={phxButtonPrimaryClassName}>
            Show
          </button>
        </div>
      </form>

      {drilled ? (
        shown.length === 0 ? (
          <AdminCallout tone="neutral">
            <span>No profile matches this choice.</span>
          </AdminCallout>
        ) : (
          <CrmSurfaceProvider surface="admin">
            <MasterListBoard bricks={bricksOf(shown)} canDecide={read.canDecide} />
          </CrmSurfaceProvider>
        )
      ) : (
        <AdminTableShell
          title="By region and area"
          description="Choose an area to open its bricks, each with its specialities and its pharmacies."
        >
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[20%]" />
                <col className="w-[24%]" />
                <col className="w-[10%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[10%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3">Region</th>
                  <th className="px-4 py-3">Area</th>
                  <th className="px-4 py-3">Bricks</th>
                  <th className="px-4 py-3">Profiles</th>
                  <th className="px-4 py-3">Confirmed</th>
                  <th className="px-4 py-3">Needs a look</th>
                  <th className="px-4 py-3">Not confirmed</th>
                </tr>
              </thead>
              <tbody>
                {overview.map((row) => (
                  <tr key={`${row.regionName}|${row.areaName}`} className="border-b border-slate-100 align-top even:bg-slate-50/60">
                    <td className="break-words px-4 py-3 text-sm text-slate-700">{row.regionName}</td>
                    <td className="break-words px-4 py-3 text-sm font-semibold">
                      <Link className="text-orange-700 underline-offset-2 hover:underline" href={hrefOf({ region: row.regionName, area: row.areaName, status: filter.status })}>
                        {row.areaName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-700">{row.bricks}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-slate-900">{row.counts.profiles}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{row.counts.confirmed}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{row.counts.needsLook}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{row.counts.rejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-3 px-5 py-4 md:hidden">
            {overview.map((row) => (
              <Link
                key={`${row.regionName}|${row.areaName}`}
                href={hrefOf({ region: row.regionName, area: row.areaName, status: filter.status })}
                className="block border border-slate-200 bg-white p-4"
              >
                <p className="break-words text-sm font-black text-slate-900">{row.areaName}</p>
                <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">
                  {row.regionName} · {row.bricks} bricks
                </p>
                <p className="mt-2 break-words text-xs font-semibold text-slate-700">
                  {row.counts.profiles} profiles · {row.counts.confirmed} confirmed · {row.counts.needsLook} need a look
                  {row.counts.rejected ? ` · ${row.counts.rejected} not confirmed` : ""}
                </p>
              </Link>
            ))}
          </div>
        </AdminTableShell>
      )}
    </div>
  );
}
