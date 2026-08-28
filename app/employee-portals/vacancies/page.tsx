import { redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import {
  EmployeePortalPageShell,
  EmployeePortalEmptyState,
} from "@/components/employee-portal/enterprise-shell";
import { ScopeBadge } from "@/components/employee-portal/scope-badge";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeePortalVacancies } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

/* ---------- print stylesheet ---------- */

const printStyles = `
@media print {
  body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  nav, header, footer, button, [data-no-print] { display: none !important; }
  .print\\:break-inside-avoid { break-inside: avoid; }
  .print\\:shadow-none { box-shadow: none !important; }
  * { border-color: #e2e8f0 !important; }
}
`;

/* ---------- helpers ---------- */

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

function statusStyle(status: string) {
  const n = String(status).trim().toLowerCase();
  if (n === "open")
    return {
      accent: "border-l-amber-400",
      bg: "bg-amber-50",
      border: "border-amber-200",
      text: "text-amber-700",
    };
  if (n === "filled")
    return {
      accent: "border-l-emerald-400",
      bg: "bg-emerald-50",
      border: "border-emerald-200",
      text: "text-emerald-700",
    };
  if (n === "cancelled")
    return {
      accent: "border-l-rose-400",
      bg: "bg-rose-50",
      border: "border-rose-200",
      text: "text-rose-700",
    };
  return {
    accent: "border-l-slate-300",
    bg: "bg-slate-50",
    border: "border-slate-200",
    text: "text-slate-600",
  };
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
    meta: detailParts.join(" · "),
  };
}

/* ---------- stat card border map ---------- */

const statBorders: Record<string, string> = {
  "Open Vacancies": "border-l-orange-400",
  "Affected Areas": "border-l-sky-400",
  "DSM Vacancies": "border-l-amber-400",
  Scope: "border-l-emerald-400",
};

/* ---------- page ---------- */

type VacanciesPageProps = {
  searchParams: Promise<{ area?: string; manager?: string }>;
};

export default async function EmployeePortalVacanciesPage({
  searchParams,
}: VacanciesPageProps) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  if (!(await canAccess(access, "vacancies", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Vacancies are available for District Manager, Regional Manager, National Sales Manager, and Product / Group Product Manager roles when vacancy scope can be resolved."
        title="Vacancies Unavailable"
      />
    );
  }

  const data = await getEmployeePortalVacancies(access);

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="This page is available for District Manager, Regional Manager, National Sales Manager, and Product / Group Product Manager roles when vacancy scope can be resolved."
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
  const pageDescription = isNsm
    ? `Open vacancies across ${data.scopeLabel} · DSM vacancies highlighted separately`
    : `Open vacancies assigned under ${data.scopeLabel}`;

  const openCount = filteredVacancies.length;
  const areaCount = new Set(
    filteredVacancies.map((v) => v.areaName).filter(Boolean),
  ).size;
  const dsmCount = filteredVacancies.filter(
    (v) => v.isDistrictManagerVacancy,
  ).length;

  const stats = [
    {
      label: "Open Vacancies",
      sub: `of ${data.vacancies.length} total`,
      value: String(openCount),
    },
    {
      label: "Affected Areas",
      sub: "unique areas",
      value: String(areaCount),
    },
    {
      label: "DSM Vacancies",
      sub: dsmCount > 0 ? "positions flagged" : "none flagged",
      value: String(dsmCount),
    },
    {
      label: "Scope",
      sub: isNsm ? "Line view" : "District view",
      value: data.scopeLabel,
    },
  ];

  return (
    <EmployeePortalPageShell
      badge="Team Operations"
      description={pageDescription}
      title={pageTitle}
    >
      {/* Print stylesheet */}
      <style dangerouslySetInnerHTML={{ __html: printStyles }} />

      <div className="flex flex-wrap items-center gap-2">
        <ScopeBadge scope={access.scope} />
      </div>

      <div
        className="max-w-full min-w-0 space-y-5 overflow-x-hidden text-slate-900 sm:space-y-7"
        dir="auto"
      >
        {/* ── Filters Card ── */}
        <Card
          className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6 print:shadow-none"
          data-no-print
        >
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-phx-xs font-semibold uppercase tracking-wider text-orange-600">
              Filters
            </span>
            <span className="text-phx-xs font-medium text-slate-400">
              {isNsm ? "Line Sales View" : "District Sales View"} &middot;{" "}
              {filteredVacancies.length} matching
            </span>
          </div>

          <form
            className="grid gap-4 xl:grid-cols-[1fr_1fr_auto]"
            method="get"
          >
            <div>
              <label
                className="mb-2 block text-phx-xs font-semibold uppercase tracking-wider text-slate-400"
                htmlFor="vacancies-area"
              >
                Area
              </label>
              <select
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]"
                defaultValue={areaFilter}
                id="vacancies-area"
                name="area"
              >
                <option value="">All areas</option>
                {areaOptions.map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                className="mb-2 block text-phx-xs font-semibold uppercase tracking-wider text-slate-400"
                htmlFor="vacancies-manager"
              >
                Manager
              </label>
              <select
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]"
                defaultValue={managerFilter}
                id="vacancies-manager"
                name="manager"
              >
                <option value="">All managers</option>
                {managerOptions.map((manager) => (
                  <option key={manager} value={manager}>
                    {manager}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end gap-2">
              <button
                className="rounded-md bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-600"
                type="submit"
              >
                Apply
              </button>
              <a
                className="inline-flex items-center rounded-md border border-gray-200 px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
                href="/employee-portals/vacancies"
              >
                Reset
              </a>
            </div>
          </form>
        </Card>

        {/* ── Stat Cards ── */}
        <Card className="rounded-lg border border-gray-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)] print:shadow-none">
          <div className="grid grid-cols-2 divide-x divide-y divide-gray-100 lg:grid-cols-4">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className={`border-l-2 ${statBorders[stat.label] ?? "border-l-slate-300"} px-3 py-3 sm:px-4 sm:py-4`}
              >
                <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                  {stat.label}
                </p>
                <p className="mt-1 text-xl font-bold text-slate-900 sm:text-2xl">
                  {stat.value}
                </p>
                <p className="mt-0.5 text-phx-xs font-medium text-slate-400">
                  {stat.sub}
                </p>
              </div>
            ))}
          </div>
        </Card>

        {/* ── Vacancy Table or Empty State ── */}
        {filteredVacancies.length === 0 ? (
          <Card className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
            <p className="text-base font-semibold text-slate-700">
              No matching vacancies
            </p>
            <p className="mt-1 text-sm text-slate-400">
              Adjust the area or manager filter to broaden the results.
            </p>
          </Card>
        ) : (
          <Card className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)] print:shadow-none">
            <div className="border-b border-gray-100 px-4 py-4 sm:px-6">
              <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                Open Positions
              </p>
              <h2 className="mt-1 text-base font-semibold text-slate-900">
                Vacancy List
              </h2>
              <p className="mt-0.5 text-phx-xs font-medium text-slate-400">
                {filteredVacancies.length}{" "}
                {filteredVacancies.length === 1 ? "vacancy" : "vacancies"} in
                selected scope
              </p>
            </div>

            {/* Desktop Table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50/80 text-left text-phx-xs uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="border-r border-slate-100 px-3 py-3 font-semibold sm:px-4">
                      Vacancy
                    </th>
                    <th className="border-r border-slate-100 px-3 py-3 font-semibold sm:px-4">
                      Position
                    </th>
                    <th className="border-r border-slate-100 px-3 py-3 font-semibold sm:px-4">
                      Area
                    </th>
                    <th className="border-r border-slate-100 px-3 py-3 font-semibold sm:px-4">
                      Manager
                    </th>
                    <th className="border-r border-slate-100 px-3 py-3 font-semibold sm:px-4">
                      Status
                    </th>
                    <th className="px-3 py-3 font-semibold sm:px-4">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredVacancies.map((vacancy) => {
                    const formattedCode = formatVacancyCode(
                      vacancy.vacancyCode,
                    );
                    const style = statusStyle(vacancy.status);
                    return (
                      <tr
                        key={vacancy.id}
                        className="border-t border-gray-100 align-top transition-colors hover:bg-slate-50/50"
                      >
                        <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                          <p className="font-semibold text-slate-900">
                            {formattedCode.label}
                          </p>
                          {formattedCode.meta ? (
                            <p className="mt-0.5 text-phx-xs text-slate-400">
                              {formattedCode.meta}
                            </p>
                          ) : (
                            <p className="mt-0.5 text-phx-xs text-slate-400">
                              {vacancy.vacancyCode}
                            </p>
                          )}
                          {vacancy.lineName ? (
                            <span className="mt-1 inline-block rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-2xs font-medium text-slate-500">
                              {vacancy.lineName}
                            </span>
                          ) : null}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                          <p className="font-medium text-slate-900">
                            {vacancy.positionTitle ??
                              vacancy.jobTitle ??
                              "Unspecified Position"}
                          </p>
                          {vacancy.note ? (
                            <p className="mt-0.5 text-phx-xs text-slate-400">
                              {vacancy.note}
                            </p>
                          ) : null}
                          {vacancy.isDistrictManagerVacancy ? (
                            <span className="mt-1 inline-block rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-phx-2xs font-semibold text-amber-700">
                              DSM Vacancy
                            </span>
                          ) : null}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-3 text-slate-600 sm:px-4">
                          <p>{vacancy.areaName ?? "Unknown Area"}</p>
                          {vacancy.regionName ? (
                            <p className="mt-0.5 text-phx-xs text-slate-400">
                              {vacancy.regionName}
                            </p>
                          ) : null}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-3 text-slate-600 sm:px-4">
                          {vacancy.managerName ??
                            vacancy.managerHrId ??
                            "Unassigned"}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                          <span
                            className={`inline-block rounded border ${style.border} ${style.bg} px-2 py-0.5 text-phx-xs font-semibold ${style.text}`}
                          >
                            {titleCaseWords(vacancy.status)}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-slate-500 sm:px-4">
                          {formatDate(vacancy.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Card View */}
            <div className="divide-y divide-gray-100 md:hidden">
              {filteredVacancies.map((vacancy) => {
                const formattedCode = formatVacancyCode(vacancy.vacancyCode);
                const style = statusStyle(vacancy.status);
                return (
                  <div
                    key={vacancy.id}
                    className={`border-l-[3px] ${style.accent} px-3 py-3`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-slate-900">
                          {formattedCode.label}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-600">
                          {vacancy.positionTitle ??
                            vacancy.jobTitle ??
                            "Unspecified Position"}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded border ${style.border} ${style.bg} px-2 py-0.5 text-phx-2xs font-semibold ${style.text}`}
                      >
                        {titleCaseWords(vacancy.status)}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {vacancy.areaName ? (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-phx-2xs font-medium text-slate-500">
                          {vacancy.areaName}
                        </span>
                      ) : null}
                      {vacancy.regionName ? (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-phx-2xs font-medium text-slate-500">
                          {vacancy.regionName}
                        </span>
                      ) : null}
                      {vacancy.lineName ? (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-phx-2xs font-medium text-slate-500">
                          {vacancy.lineName}
                        </span>
                      ) : null}
                      {vacancy.isDistrictManagerVacancy ? (
                        <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-phx-2xs font-semibold text-amber-700">
                          DSM
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-2 flex items-center justify-between text-phx-xs text-slate-400">
                      <span>
                        {vacancy.managerName ??
                          vacancy.managerHrId ??
                          "Unassigned"}
                      </span>
                      <span>{formatDate(vacancy.createdAt)}</span>
                    </div>

                    {vacancy.note ? (
                      <p className="mt-1.5 text-phx-xs text-slate-400">
                        {vacancy.note}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </EmployeePortalPageShell>
  );
}
