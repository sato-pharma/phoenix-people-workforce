import { redirect } from "next/navigation";
import { BriefcaseBusiness, Building2, MapPinned, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  EmployeePortalActionBar,
  EmployeePortalPageShell,
  EmployeePortalEmptyState,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeePortalVacancies } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

function normalizeFilter(value: string | undefined) {
  const normalized = String(value ?? "").trim();
  return normalized || "";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function statusVariant(status: string) {
  const normalized = String(status).trim().toLowerCase();
  if (normalized === "open") return "warning" as const;
  if (normalized === "filled") return "success" as const;
  if (normalized === "cancelled") return "danger" as const;
  return "neutral" as const;
}

function titleCaseWords(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function formatVacancyCode(code: string) {
  const parts = String(code).trim().split("_").filter(Boolean);
  if (parts.length === 0) return { label: code, meta: "" };

  const numberMatch = code.match(/vacancy_(?:vac_)?(\d+)/i);
  const label = numberMatch ? `VAC-${numberMatch[1].padStart(3, "0")}` : code;

  const detailParts = parts.slice(numberMatch ? 2 : 1).map((part) => {
    if (/^\d+$/.test(part)) return `#${part}`;
    return titleCaseWords(part.replace(/-/g, " "));
  });

  return {
    label,
    meta: detailParts.join(" • "),
  };
}

export default async function EmployeePortalVacanciesPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string; manager?: string }>;
}) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  await assertPermission(access, "vacancies", "read");

  const data = await getEmployeePortalVacancies(access);

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="This page is available for DSM and NSM roles when vacancy scope can be resolved."
        title="Vacancies Unavailable"
      />
    );
  }

  const isNsm = data.roleView === "nsm";
  const params = await searchParams;
  const areaFilter = normalizeFilter(params.area);
  const managerFilter = normalizeFilter(params.manager);
  const areaOptions = Array.from(
    new Set(
      data.vacancies
        .map((vacancy) => vacancy.areaName)
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort((left, right) => left.localeCompare(right));
  const managerOptions = Array.from(
    new Set(
      data.vacancies
        .map((vacancy) => vacancy.managerName ?? vacancy.managerHrId)
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort((left, right) => left.localeCompare(right));
  const filteredVacancies = data.vacancies.filter((vacancy) => {
    const matchesArea = !areaFilter || vacancy.areaName === areaFilter;
    const managerValue = vacancy.managerName ?? vacancy.managerHrId ?? "";
    const matchesManager = !managerFilter || managerValue === managerFilter;
    return matchesArea && matchesManager;
  });
  const pageTitle = isNsm ? "Line Vacancies" : "Team Vacancies";
  const pageSubtitle = isNsm
    ? `Open vacancies across ${data.scopeLabel}. DSM vacancies are highlighted separately.`
    : `Open vacancies assigned under ${data.scopeLabel}.`;

  return (
    <EmployeePortalPageShell description={pageSubtitle} title={pageTitle}>
      <Card className="rounded-2xl border border-slate-100 bg-white p-6 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
              {isNsm ? "National Sales View" : "District Sales View"}
            </p>
            <p className="mt-1 text-sm text-slate-500">{pageTitle}</p>
          </div>
          <EmployeePortalActionBar
            actions={
              <Badge className="px-3 py-1.5 text-xs font-semibold" variant="warning">
                {filteredVacancies.length} Open
              </Badge>
            }
          />
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
            <div className="mb-1 flex items-center gap-2 text-slate-500">
              <BriefcaseBusiness className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Open Vacancies</span>
            </div>
            <p className="text-2xl font-black text-slate-900">{filteredVacancies.length}</p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
            <div className="mb-1 flex items-center gap-2 text-slate-500">
              <MapPinned className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Affected Areas</span>
            </div>
            <p className="text-2xl font-black text-slate-900">
              {new Set(filteredVacancies.map((vacancy) => vacancy.areaName).filter(Boolean)).size}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
            <div className="mb-1 flex items-center gap-2 text-slate-500">
              <Users className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">DSM Vacancies</span>
            </div>
            <p className="text-2xl font-black text-slate-900">
              {filteredVacancies.filter((vacancy) => vacancy.isDistrictManagerVacancy).length}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
            <div className="mb-1 flex items-center gap-2 text-slate-500">
              <Building2 className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">Scope</span>
            </div>
            <p className="text-lg font-bold text-slate-900">{data.scopeLabel}</p>
          </div>
        </div>

        <form className="mt-6 grid gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 lg:grid-cols-[1fr_1fr_auto]" method="get">
          <label className="space-y-2">
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">Area</span>
            <select
              className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-orange-300"
              defaultValue={areaFilter}
              name="area"
            >
              <option value="">All areas</option>
              {areaOptions.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">Manager</span>
            <select
              className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-orange-300"
              defaultValue={managerFilter}
              name="manager"
            >
              <option value="">All managers</option>
              {managerOptions.map((manager) => (
                <option key={manager} value={manager}>
                  {manager}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end gap-2">
            <button
              className="h-11 rounded-xl bg-slate-900 px-4 text-sm font-medium text-white transition hover:bg-slate-800"
              type="submit"
            >
              Apply
            </button>
            <a
              className="inline-flex h-11 items-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              href="/employee-portals/vacancies"
            >
              Reset
            </a>
          </div>
        </form>
      </Card>

      {filteredVacancies.length === 0 ? (
        <Card className="rounded-3xl border border-slate-100 bg-white p-12 text-center shadow-sm">
          <BriefcaseBusiness className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <p className="text-base font-semibold text-slate-700">No matching vacancies</p>
          <p className="mt-1 text-sm text-slate-400">
            Adjust the area or manager filter to broaden the results.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden rounded-3xl border border-slate-100 bg-white p-0 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
          <div className="border-b border-slate-100 px-6 py-5">
            <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Open Positions</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">Vacancy List</h2>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-6 py-4 font-medium">Vacancy</th>
                  <th className="px-6 py-4 font-medium">Position</th>
                  <th className="px-6 py-4 font-medium">Area</th>
                  <th className="px-6 py-4 font-medium">Manager</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                  <th className="px-6 py-4 font-medium">Opened</th>
                </tr>
              </thead>
              <tbody>
                {filteredVacancies.map((vacancy) => {
                  const formattedCode = formatVacancyCode(vacancy.vacancyCode);
                  return (
                  <tr key={vacancy.id} className="border-t border-slate-100 align-top">
                    <td className="px-6 py-4">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold text-slate-900">{formattedCode.label}</p>
                          {vacancy.lineName ? <Badge variant="neutral">{vacancy.lineName}</Badge> : null}
                        </div>
                        {formattedCode.meta ? (
                          <p className="text-xs text-slate-500">{formattedCode.meta}</p>
                        ) : (
                          <p className="text-xs text-slate-400">{vacancy.vacancyCode}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="space-y-1">
                        <p className="font-medium text-slate-900">
                          {vacancy.positionTitle ?? vacancy.jobTitle ?? "Unspecified Position"}
                        </p>
                        {vacancy.note ? (
                          <p className="text-xs text-slate-500">{vacancy.note}</p>
                        ) : null}
                        {vacancy.isDistrictManagerVacancy ? (
                          <Badge variant="neutral">DSM Vacancy</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-slate-600">
                      <div>{vacancy.areaName ?? "Unknown Area"}</div>
                      {vacancy.regionName ? (
                        <div className="mt-1 text-xs text-slate-400">{vacancy.regionName}</div>
                      ) : null}
                    </td>
                    <td className="px-6 py-4 text-slate-600">
                      <div>{vacancy.managerName ?? vacancy.managerHrId ?? "Unassigned"}</div>
                    </td>
                    <td className="px-6 py-4">
                      <Badge variant={statusVariant(vacancy.status)}>{vacancy.status}</Badge>
                    </td>
                    <td className="px-6 py-4 text-slate-600">{formatDate(vacancy.createdAt)}</td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </EmployeePortalPageShell>
  );
}
