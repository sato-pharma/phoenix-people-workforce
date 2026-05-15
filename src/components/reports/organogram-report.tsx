"use client";

import {
  AlertCircle,
  Building2,
  Crown,
  Network,
  RefreshCw,
  UsersRound,
  X,
} from "lucide-react";
import * as React from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { formatDateOnly } from "@/lib/date-only";
import {
  calculateOrganogramStructureKpis,
  findOrganogramDiagnostics,
  type OrganogramKpiBreakdown,
} from "@/lib/reports/organogram-safety";
import type { VacancyReportData } from "@/lib/reports/vacancies";
import { cn } from "@/lib/utils";

type OrganogramRow = VacancyReportData["organogramRows"][number];
type MemberNode = {
  children: MemberNode[];
  key: string;
  row: OrganogramRow;
};

type OrganogramReportProps = {
  fixedLine?: string | null;
  initialError?: string | null;
  initialReport?: VacancyReportData | null;
};

function groupBy<T>(items: T[], keyFor: (item: T) => string) {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = keyFor(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return Array.from(groups.entries()).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
}

const selectClassName =
  "h-11 w-full rounded-2xl border border-[#D7E0EA] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-sm outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/12";

const panelClassName =
  "rounded-[24px] border border-[#D8E0EA] bg-white shadow-[0_8px_30px_rgb(0,0,0,0.04)]";

function OrganogramPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-[34px] border border-[#D8E0EA] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.08),transparent_35%),linear-gradient(135deg,#FFF9F5_0%,#FFFFFF_50%,#F8FAFC_100%)] p-4 shadow-[0_20px_50px_rgba(15,23,42,0.08)] sm:p-5">
      <div className="relative space-y-6">{children}</div>
    </div>
  );
}

function SelectFilter({
  className,
  label,
  onChange,
  options,
  value,
}: {
  className?: string;
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-text-secondary">
        {label}
      </span>
      <select
        className={selectClassName}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">All {label}s</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function titleText(row: OrganogramRow) {
  return `${row.positionTitle ?? row.jobTitle ?? ""}`.toLowerCase();
}

function isOfficeLine(row: OrganogramRow) {
  return row.lineName?.trim().toLowerCase() === "office";
}

function isSalesDepartment(row: OrganogramRow) {
  return row.departmentName?.trim().toLowerCase() === "sales";
}

function isMarketingDepartment(row: OrganogramRow) {
  return row.departmentName?.trim().toLowerCase() === "marketing";
}

function isVacancyRow(row: OrganogramRow) {
  return row.type === "vacancy";
}

function isOrganogramVisibleRow(row: OrganogramRow) {
  return (
    isVacancyRow(row) ||
    isSalesDepartment(row) ||
    isMarketingDepartment(row) ||
    isOfficeLine(row)
  );
}

function normalizeNameKey(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function normalizeHrIdKey(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? "";
}

function rowKey(row: OrganogramRow) {
  return `${row.type}-${row.hrId}-${row.sourceRowNumber ?? ""}`;
}

function managerIdentityKey(row: OrganogramRow) {
  const hrId = normalizeHrIdKey(row.hrId);
  if (hrId) return `hr:${hrId}`;

  return `name:${normalizeNameKey(row.fullName)}`;
}

function hasCircularManagerChain(
  row: OrganogramRow,
  rowsByHrId: Map<string, OrganogramRow>,
) {
  const rowHrId = normalizeHrIdKey(row.hrId);
  const visited = new Set<string>();
  let managerHrId = normalizeHrIdKey(row.managerHrId);

  while (managerHrId) {
    if (managerHrId === rowHrId || visited.has(managerHrId)) {
      return true;
    }

    visited.add(managerHrId);
    managerHrId = normalizeHrIdKey(rowsByHrId.get(managerHrId)?.managerHrId);
  }

  return false;
}

function isNationalSalesManager(row: OrganogramRow) {
  const title = titleText(row);

  return title.includes("national sales manager") || title === "nsm";
}

function isChiefExecutive(row: OrganogramRow) {
  const title = titleText(row);

  return (
    row.hrId.trim().toUpperCase() === "AA" ||
    title === "ceo" ||
    title.includes("chief executive")
  );
}

function isDistrictSalesManager(row: OrganogramRow) {
  const title = titleText(row);

  return (
    title.includes("district sales manager") ||
    title.includes("district manager") ||
    title === "dsm"
  );
}

function isRegionalSalesManager(row: OrganogramRow) {
  const title = titleText(row);

  return title.includes("regional sales manager") || title === "rsm";
}

function isMedicalRep(row: OrganogramRow) {
  const title = titleText(row);

  return (
    title.includes("medical representative") ||
    title.includes("medical rep") ||
    title === "mr"
  );
}

function isMarketingManager(row: OrganogramRow) {
  return titleText(row).includes("marketing manager");
}

function reportsUpTo(
  row: OrganogramRow,
  manager: OrganogramRow,
  rows: OrganogramRow[],
) {
  const visited = new Set<string>();
  const managerHrIdKey = normalizeHrIdKey(manager.hrId);
  let managerHrId = normalizeHrIdKey(row.managerHrId);

  while (managerHrId) {
    if (managerHrId === managerHrIdKey) {
      return true;
    }

    if (visited.has(managerHrId)) {
      return false;
    }

    visited.add(managerHrId);
    managerHrId = normalizeHrIdKey(
      rows.find((candidate) => normalizeHrIdKey(candidate.hrId) === managerHrId)?.managerHrId,
    );
  }

  return false;
}

function reportsToManagerGroup(
  row: OrganogramRow,
  managerHrIdsForGroup: Set<string>,
  managerNameKeysForGroup: Set<string>,
) {
  const managerHrId = normalizeHrIdKey(row.managerHrId);
  const managerNameKey = normalizeNameKey(row.managerName);

  if (managerHrId && managerHrIdsForGroup.has(managerHrId)) {
    return true;
  }

  return row.type === "vacancy" && managerNameKey
    ? managerNameKeysForGroup.has(managerNameKey)
    : !managerHrId && managerNameKeysForGroup.has(managerNameKey);
}

function hierarchyMemberRank(row: OrganogramRow) {
  if (isRegionalSalesManager(row)) return 0;
  if (isDistrictSalesManager(row)) return 1;
  if (row.type === "employee") return 2;
  return 3;
}

function sortHierarchyMembers(left: OrganogramRow, right: OrganogramRow) {
  const leftRank = hierarchyMemberRank(left);
  const rightRank = hierarchyMemberRank(right);

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return left.fullName.localeCompare(right.fullName);
}

function formatDate(value: string | null | undefined) {
  return formatDateOnly(value, "en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function HierarchyNode({
  className,
  hireDate,
  hrId,
  icon,
  label,
  name,
  tone = "default",
}: {
  className?: string;
  hireDate?: string | null;
  hrId?: string;
  icon?: React.ReactNode;
  label: string;
  name: string;
  tone?: "dark" | "default" | "primary";
}) {
  const isDark = tone === "dark";
  const isPrimary = tone === "primary";
  return (
    <div
      className={cn(
        "group relative w-full rounded-xl border px-3 py-2.5 transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md",
        isDark
          ? "max-w-[280px] border-slate-900 bg-slate-900 text-white shadow-lg"
          : isPrimary
            ? "max-w-[320px] border-orange-200 bg-orange-50 text-text shadow-sm"
            : "max-w-[220px] border-slate-200 bg-white text-[#0F172A] shadow-sm",
        className,
      )}
    >
      <div className="mb-1.5 flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[#F97316]">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          "flex flex-col items-center gap-1 text-xs font-semibold leading-snug",
          isDark ? "text-white" : "text-text",
        )}
      >
        <span className={cn(isDark || isPrimary ? "whitespace-normal text-center w-full" : "truncate")}>
          {name}
        </span>
        {isPrimary && hireDate && (
          <span className="text-[10px] font-medium opacity-70">
            Hired {formatDate(hireDate)}
          </span>
        )}
        {hrId && (
          <span className={cn(
            "font-mono text-[10px] font-medium opacity-60",
            isDark ? "absolute right-2 top-2" : "mt-0.5"
          )}>
            {hrId}
          </span>
        )}
      </div>
    </div>
  );
}

function TeamMemberCard({ row }: { row: OrganogramRow }) {
  const isVacancy = row.type === "vacancy";
  const showRepFields = isVacancy || isMedicalRep(row);
  const title = row.positionTitle ?? row.jobTitle;

  return (
    <div
      className={cn(
        "group relative rounded-lg border px-2.5 py-2 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md",
        isVacancy
          ? "border-orange-200 bg-orange-50"
          : "border-slate-200 bg-white",
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-1 rounded-l-lg",
          isVacancy ? "bg-[#F97316]" : "bg-slate-300",
        )}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="w-full min-w-0">
          <div className="flex items-center justify-between gap-2 text-text">
            <span className="truncate text-[11px] font-semibold leading-tight">
              {row.fullName}
            </span>
            <span className="shrink-0 font-mono text-[10px] font-medium opacity-60">
              {row.hrId}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-text-secondary">
            {title && !showRepFields ? (
              <span className="break-words leading-snug text-text">{title}</span>
            ) : null}
          </div>
        </div>
      </div>

      {showRepFields ? (
        <dl className="mt-2.5 space-y-1 rounded-md bg-slate-50/50 p-1.5 ring-1 ring-slate-100">
          <div className="flex items-center justify-between text-[10px]">
            <dt className="font-medium text-slate-500">Area</dt>
            <dd className="font-bold tracking-tight text-slate-700">
              {row.areaName || "-"}
            </dd>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <dt className="font-medium text-slate-500">Hiring</dt>
            <dd className="font-semibold text-slate-600">
              {formatDate(row.hireDate)}
            </dd>
          </div>
          <div className="flex items-center justify-between text-[9px] opacity-60">
            <dt className="text-slate-400">Position</dt>
            <dd className="truncate font-medium text-slate-500">
              {title || "-"}
            </dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

function buildMemberTree(members: OrganogramRow[]) {
  const memberIds = new Set(
    members.map((member) => normalizeHrIdKey(member.hrId)).filter(Boolean),
  );
  const rowByHrId = new Map(
    members
      .map((member) => [normalizeHrIdKey(member.hrId), member] as const)
      .filter(([hrId]) => Boolean(hrId)),
  );
  const nodesByHrId = new Map<string, MemberNode[]>();
  const nodes = members.map((member, index) => ({
    children: [],
    key: `${rowKey(member)}-${index}`,
    row: member,
  }) satisfies MemberNode);

  for (const node of nodes) {
    const hrId = normalizeHrIdKey(node.row.hrId);
    nodesByHrId.set(hrId, [...(nodesByHrId.get(hrId) ?? []), node]);
  }

  const roots: MemberNode[] = [];

  for (const node of nodes) {
    const member = node.row;
    const memberHrId = normalizeHrIdKey(member.hrId);
    const managerHrId = normalizeHrIdKey(member.managerHrId);

    if (
      managerHrId &&
      managerHrId !== memberHrId &&
      memberIds.has(managerHrId) &&
      !hasCircularManagerChain(member, rowByHrId)
    ) {
      const managerNode = nodesByHrId.get(managerHrId)?.[0];
      if (managerNode && managerNode !== node) {
        managerNode.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (nodes: MemberNode[]) => {
    nodes.sort((left, right) => left.row.fullName.localeCompare(right.row.fullName));

    for (const node of nodes) {
      sortNodes(node.children);
    }
  };

  sortNodes(roots);

  return roots;
}

function TeamMemberNode({ node }: { node: MemberNode }) {
  return (
    <div>
      <TeamMemberCard row={node.row} />

      {node.children.length > 0 ? (
        <div className="ml-3 mt-1.5 border-l border-slate-300 pl-2">
          <div className="-ml-[13px] mb-1.5 h-2.5 w-2.5 rounded-bl-lg border-b border-l border-slate-300" />
          <div className="space-y-1.5">
            {node.children.map((child) => (
              <TeamMemberNode key={child.key} node={child} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StructureKpiCard({
  breakdown,
  title,
}: {
  breakdown: OrganogramKpiBreakdown;
  title: string;
  tone?: "medical" | "dsm" | "nsm" | "rsm" | "total";
}) {
  const isTotal = title.toLowerCase().includes("total");
  const isMedicalRep = title.toLowerCase().includes("medical");
  const isDsm = title.toLowerCase().includes("dsm");
  const isNsm = title.toLowerCase().includes("nsm");
  const isRsm = title.toLowerCase().includes("rsm");

  const displayTitle = isNsm
    ? "National Sales Managers"
    : isDsm
      ? "District Sales Managers"
      : isRsm
        ? "Regional Sales Managers"
        : isMedicalRep
          ? "Medical Sales Representatives"
          : title;

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border transition-all duration-300 hover:-translate-y-1 hover:shadow-xl",
        isTotal
          ? "border-slate-800 bg-slate-900 text-white shadow-2xl"
          : "border-slate-200 bg-white shadow-sm",
      )}
    >
      {/* Premium Glass Effect Header */}
      <div
        className={cn(
          "flex items-center justify-between px-4 py-2 border-b",
          isTotal ? "border-white/10 bg-white/5" : "border-slate-100 bg-slate-50/50",
        )}
      >
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "h-1.5 w-1.5 rounded-full animate-pulse",
              isTotal
                ? "bg-orange-400 shadow-[0_0_8px_rgba(251,146,60,0.8)]"
                : isMedicalRep
                  ? "bg-blue-500"
                  : isDsm
                    ? "bg-purple-500"
                    : "bg-orange-500",
            )}
          />
          <p
            className={cn(
              "text-[9px] font-black uppercase tracking-[0.12em]",
              isTotal ? "text-white" : "text-slate-600",
            )}
          >
            {displayTitle}
          </p>
        </div>
        {isTotal && (
          <div className="rounded-full bg-orange-500/20 px-2 py-0.5 text-[7px] font-bold text-orange-400 ring-1 ring-orange-500/30">
            ENTERPRISE
          </div>
        )}
      </div>

      <div className="p-3 pt-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p
              className={cn(
                "text-[8px] font-bold uppercase tracking-[0.05em]",
                isTotal ? "text-slate-400" : "text-slate-400",
              )}
            >
              Headcount
            </p>
            <p
              className={cn(
                "text-3xl font-black tracking-tighter",
                isTotal ? "text-white" : "text-slate-900",
              )}
            >
              {breakdown.total}
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="flex items-center justify-end gap-1">
                <p
                  className={cn(
                    "text-[8px] font-bold uppercase tracking-wider",
                    isTotal ? "text-slate-400" : "text-slate-500",
                  )}
                >
                  Actual
                </p>
                <div className={cn("h-1 w-1 rounded-full", isTotal ? "bg-emerald-400" : "bg-emerald-500")} />
              </div>
              <p
                className={cn(
                  "text-3xl font-black tracking-tighter leading-none mt-0.5",
                  isTotal ? "text-emerald-400" : "text-slate-800",
                )}
              >
                {breakdown.actual}
              </p>
            </div>

            <div className="text-right">
              <div className="flex items-center justify-end gap-1">
                <p
                  className={cn(
                    "text-[8px] font-bold uppercase tracking-wider",
                    isTotal ? "text-orange-400/80" : "text-orange-600",
                  )}
                >
                  Vacants
                </p>
                <div className={cn("h-1 w-1 rounded-full", isTotal ? "bg-orange-400" : "bg-orange-500")} />
              </div>
              <p
                className={cn(
                  "text-3xl font-black tracking-tighter leading-none mt-0.5",
                  isTotal ? "text-orange-400" : "text-orange-700",
                )}
              >
                {breakdown.vacant}
              </p>
            </div>
          </div>
        </div>

        {/* Progress Bar Visualizer */}
        <div className="mt-4">
          <div className={cn("h-1 w-full rounded-full overflow-hidden", isTotal ? "bg-white/10" : "bg-slate-100")}>
            <div
              className={cn(
                "h-full rounded-full transition-all duration-1000 ease-out",
                isTotal
                  ? "bg-gradient-to-r from-orange-500 via-orange-400 to-amber-300"
                  : isMedicalRep
                    ? "bg-gradient-to-r from-blue-600 via-blue-500 to-cyan-400"
                    : isDsm
                      ? "bg-gradient-to-r from-emerald-600 via-teal-500 to-cyan-400"
                      : "bg-gradient-to-r from-slate-800 to-slate-600",
              )}
              style={{ width: `${(breakdown.actual / (breakdown.total || 1)) * 100}%` }}
            />
          </div>
          <div className="mt-1.5 flex justify-end">
            <span className={cn(
              "text-[9px] font-black tracking-widest",
              isTotal ? "text-orange-400" : "text-slate-600"
            )}>
              {Math.round((breakdown.actual / (breakdown.total || 1)) * 100)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function OrganogramView({
  rows,
  selectedLine,
}: {
  rows: OrganogramRow[];
  selectedLine: string | null;
}) {
  const lineName = selectedLine ?? "Select Line";
  const chiefExecutive = rows.find((row) => isChiefExecutive(row)) ?? null;
  const lineLeader =
    rows.find((row) =>
      isNationalSalesManager(row),
    ) ?? null;
  const rsmRows = rows
    .filter((row) => isRegionalSalesManager(row))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
  const rsmHrIds = new Set(rsmRows.map((row) => normalizeHrIdKey(row.hrId)));
  const rsmNameKeys = new Set(
    rsmRows.map((row) => normalizeNameKey(row.fullName)),
  );
  const dsmRows = rows
    .filter((row) => isDistrictSalesManager(row))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
  const dsmHrIds = new Set(dsmRows.map((row) => normalizeHrIdKey(row.hrId)));
  const dsmNameKeys = new Set(
    dsmRows.map((row) => normalizeNameKey(row.fullName)),
  );
  const teamRows = rows.filter(
    (row) =>
      !isChiefExecutive(row) &&
      !isNationalSalesManager(row) &&
      !isRegionalSalesManager(row) &&
      !isDistrictSalesManager(row),
  );
  const assignedToManager = new Set<string>();
  const rsmGroups = groupBy(rsmRows, managerIdentityKey).map(([, rsms]) => {
    const primaryRsm = [...rsms].sort((left, right) =>
      left.fullName.localeCompare(right.fullName),
    )[0];
    const rsmHrIdsForGroup = new Set(rsms.map((row) => normalizeHrIdKey(row.hrId)));
    const rsmNameKeysForGroup = new Set(rsms.map((row) => normalizeNameKey(row.fullName)));
    const dsmsUnderRsm = dsmRows.filter((row) =>
      reportsToManagerGroup(row, rsmHrIdsForGroup, rsmNameKeysForGroup),
    );
    const dsmHrIdsForGroup = new Set(dsmsUnderRsm.map((row) => normalizeHrIdKey(row.hrId)));
    const dsmNameKeysForGroup = new Set(dsmsUnderRsm.map((row) => normalizeNameKey(row.fullName)));
    const members = [
      ...dsmsUnderRsm,
      ...teamRows.filter((row) =>
        reportsToManagerGroup(row, rsmHrIdsForGroup, rsmNameKeysForGroup) ||
        reportsToManagerGroup(row, dsmHrIdsForGroup, dsmNameKeysForGroup) ||
        rsms.some((rsm) => reportsUpTo(row, rsm, rows)),
      ),
    ].sort(sortHierarchyMembers);

    for (const dsm of dsmsUnderRsm) {
      assignedToManager.add(rowKey(dsm));
    }
    for (const member of members) {
      assignedToManager.add(rowKey(member));
    }

    return {
      dsm: primaryRsm,
      hireDate: primaryRsm.hireDate,
      hrId: primaryRsm.hrId,
      members,
      name: primaryRsm.fullName,
      region: primaryRsm.regionName,
      title: primaryRsm.positionTitle ?? primaryRsm.jobTitle ?? "Regional Sales Manager",
    };
  });
  const dsmGroups = groupBy(
    dsmRows.filter((row) => !assignedToManager.has(rowKey(row))),
    managerIdentityKey,
  ).map(([, dsms]) => {
    const primaryDsm = [...dsms].sort((left, right) =>
      left.fullName.localeCompare(right.fullName),
    )[0];
    const dsmHrIdsForGroup = new Set(dsms.map((row) => normalizeHrIdKey(row.hrId)));
    const dsmNameKeysForGroup = new Set(dsms.map((row) => normalizeNameKey(row.fullName)));
    const members = teamRows
      .filter((row) =>
        !assignedToManager.has(rowKey(row)) &&
        reportsToManagerGroup(row, dsmHrIdsForGroup, dsmNameKeysForGroup),
      )
      .sort(sortHierarchyMembers);

    for (const member of members) {
      assignedToManager.add(rowKey(member));
    }

    return {
      dsm: primaryDsm,
      hireDate: primaryDsm.hireDate,
      hrId: primaryDsm.hrId,
      members,
      name: primaryDsm.fullName,
      region: primaryDsm.regionName,
      title: primaryDsm.positionTitle ?? primaryDsm.jobTitle ?? "District Sales Manager",
    };
  });
  const marketingManagers = teamRows
    .filter((row) => !assignedToManager.has(rowKey(row)) && isMarketingManager(row))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
  const marketingGroups = groupBy(marketingManagers, managerIdentityKey).map(([, managers]) => {
    const primaryManager = [...managers].sort((left, right) =>
      left.fullName.localeCompare(right.fullName),
    )[0];
    const managerHrIds = new Set(managers.map((manager) => normalizeHrIdKey(manager.hrId)));
    const members = teamRows
      .filter((row) =>
        !managerHrIds.has(normalizeHrIdKey(row.hrId)) &&
        managers.some((manager) => reportsUpTo(row, manager, rows)),
      )
      .sort((left, right) => left.fullName.localeCompare(right.fullName));

    for (const manager of managers) {
      assignedToManager.add(rowKey(manager));
    }

    return {
      dsm: null,
      hireDate: primaryManager.hireDate,
      hrId: primaryManager.hrId,
      members,
      name: primaryManager.fullName,
      region: primaryManager.regionName,
      title: primaryManager.positionTitle ?? primaryManager.jobTitle ?? "Marketing Manager",
    };
  });
  const fallbackManagerGroups = groupBy(
    teamRows.filter((row) => {
      const key = rowKey(row);
      const managerNameKey = normalizeNameKey(row.managerName);
      const managerHrId = normalizeHrIdKey(row.managerHrId);
      const reportsToLineLeader =
        Boolean(lineLeader) &&
        (managerHrId === normalizeHrIdKey(lineLeader?.hrId) ||
          managerNameKey === normalizeNameKey(lineLeader?.fullName));

      return (
        !assignedToManager.has(key) &&
        !reportsToLineLeader &&
        (managerHrId || row.managerName) &&
        (!managerHrId || !dsmHrIds.has(managerHrId)) &&
        (!managerHrId || !rsmHrIds.has(managerHrId)) &&
        (!managerNameKey || !dsmNameKeys.has(managerNameKey)) &&
        (!managerNameKey || !rsmNameKeys.has(managerNameKey))
      );
    }),
    (row) => {
      const managerHrId = normalizeHrIdKey(row.managerHrId);
      const managerNameKey = normalizeNameKey(row.managerName);

      if (
        chiefExecutive &&
        (managerHrId === normalizeHrIdKey(chiefExecutive.hrId) ||
          managerNameKey === normalizeNameKey(chiefExecutive.fullName))
      ) {
        return "ceo-direct-reports";
      }

      if (managerHrId) return `hr:${managerHrId}`;
      return `name:${managerNameKey}`;
    },
  ).map(([managerKey, members]) => {
    const firstMember = members[0];
    const name = managerKey === "ceo-direct-reports"
      ? "CEO Direct Reports"
      : firstMember?.managerName ?? `Manager ${firstMember?.managerHrId ?? "Unknown"}`;

    return {
      dsm: null,
      hireDate: firstMember?.hireDate,
      hrId: firstMember?.managerHrId,
      members,
      name,
      region: firstMember?.regionName,
      title: "Manager",
    };
  });
  const unassignedMembers = teamRows.filter((row) => {
    const key = rowKey(row);

    return !assignedToManager.has(key) && !row.managerHrId;
  });
  const groups = [
    ...rsmGroups,
    ...dsmGroups,
    ...marketingGroups,
    ...fallbackManagerGroups,
    ...(unassignedMembers.length > 0
      ? [
          {
            dsm: null,
            hireDate: null,
            hrId: null,
            members: unassignedMembers,
            name: "Unassigned Manager",
            region: null,
            title: "Manager",
          },
        ]
      : []),
  ].filter((group) => group.members.length > 0 || group.dsm);
  const filledLaneCount = groups.filter((group) => group.members.length > 0).length;
  const laneCount = Math.max(groups.length, 1);
  const structureKpis = React.useMemo(
    () => calculateOrganogramStructureKpis(rows),
    [rows],
  );

  const displayedEmployees = rows.filter((row) => row.type === "employee");
  const displayedVacancies = rows.filter((row) => row.type === "vacancy");

  return (
    <Card className={cn(panelClassName, "overflow-hidden p-0")}>
      <AdminSectionHeader
        action={null}
        description="Executive leadership, manager lanes, active employees, and open vacancies in one operational view."
        title={selectedLine ? `${selectedLine} structure` : "Select a line"}
      />
      <div className="overflow-hidden bg-[#F8FAFC] px-3 py-5 sm:px-4">
        {!selectedLine ? (
          <div className="rounded-3xl border border-dashed border-[#CBD5E1] bg-white/90 p-10 text-center shadow-sm">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[#F97316]/10 text-[#F97316]">
              <Network className="h-5 w-5" />
            </div>
            <h2 className="text-base font-semibold text-text">
              Select a line to view the organogram
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-text-secondary">
              The hierarchy stays hidden until a line is selected, so the chart
              only shows the exact structure you are reviewing.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-[#CBD5E1] bg-white/90 p-8 text-center text-sm text-[#64748B]">
            No organogram rows match the current filters.
          </div>
        ) : (
          <div className="w-full">
            <div className="mb-5 grid w-full gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <StructureKpiCard
                breakdown={structureKpis.medicalReps}
                title="Medical Reps"
                tone="medical"
              />
              <StructureKpiCard
                breakdown={structureKpis.dsms}
                title="DSMs"
                tone="dsm"
              />
              <StructureKpiCard
                breakdown={structureKpis.nsms}
                title="NSMs"
                tone="nsm"
              />
              <StructureKpiCard
                breakdown={structureKpis.rsms}
                title="RSMs"
                tone="rsm"
              />
              <StructureKpiCard
                breakdown={structureKpis.totalLineStructure}
                title="Total Line Structure"
                tone="total"
              />
            </div>

            <div className="relative flex flex-col items-center">
              <HierarchyNode
                hrId={chiefExecutive?.hrId}
                icon={<Crown className="h-3.5 w-3.5" />}
                label={chiefExecutive ? chiefExecutive.positionTitle ?? chiefExecutive.jobTitle ?? "CEO" : "CEO"}
                name={chiefExecutive ? chiefExecutive.fullName : "Executive Leadership"}
                tone="dark"
              />
              <div className="h-5 w-px bg-border" />
              <HierarchyNode
                icon={<Network className="h-3.5 w-3.5" />}
                label="Line"
                name={lineName}
                tone="default"
              />
              <div className="h-5 w-px bg-border" />
              <HierarchyNode
                hrId={lineLeader?.hrId}
                hireDate={lineLeader?.hireDate}
                icon={<UsersRound className="h-3.5 w-3.5" />}
                label={lineLeader ? lineLeader.positionTitle ?? lineLeader.jobTitle ?? "Line Leadership" : "Line Leadership"}
                name={lineLeader ? lineLeader.fullName : lineName}
                tone="primary"
              />
              <div className="h-5 w-px bg-border" />
              <div className="relative h-px w-[92%] bg-slate-200">
                <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#F97316]" />
              </div>
            </div>

            {groups.length === 0 ? (
              <div className="mx-auto mt-8 max-w-md rounded-xl border border-dashed border-[#CBD5E1] bg-white p-8 text-center text-sm text-[#64748B]">
                No manager lanes found for this line.
              </div>
            ) : (
              <div className="relative mt-6 overflow-x-auto pb-2">
                <div className="absolute left-0 right-0 top-0 h-px bg-slate-200" />
                <div
                  className="grid min-w-full gap-3 pt-5"
                  style={{
                    gridTemplateColumns: `repeat(${laneCount}, minmax(250px, 1fr))`,
                    minWidth: `${laneCount * 250}px`,
                  }}
                >
                  {groups.map((group, groupIndex) => {
                    const groupVacancies = group.members.filter(
                      (member) => member.type === "vacancy",
                    ).length;
                    const groupKey = group.dsm
                      ? `manager-${rowKey(group.dsm)}-${groupIndex}`
                      : `manager-${group.name}-${group.title}-${groupIndex}`;

                    return (
                      <div
                        className="group relative min-w-[250px] rounded-xl border border-slate-200 bg-white p-2 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md"
                        key={groupKey}
                      >
                        <div className="absolute -top-5 left-1/2 h-5 w-px -translate-x-1/2 bg-slate-200" />
                        <div className="absolute left-3 right-3 top-0 h-1 rounded-b-full bg-[#F97316]" />
                        <div
                          className={cn(
                            "rounded-xl bg-slate-900 px-2 py-2 text-white shadow-md",
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="w-full min-w-0 text-left">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-[10px] font-bold uppercase tracking-[0.08em] leading-3">
                                  {group.name}
                                </span>
                                {group.hrId && (
                                  <span className="shrink-0 font-mono text-[9px] font-medium opacity-60">
                                    {group.hrId}
                                  </span>
                                )}
                              </div>
                              <p className="mt-1 break-words text-[9px] font-medium leading-3 opacity-80">
                                {group.title}
                              </p>
                              {group.hireDate && (
                                <p className="mt-1 text-[9px] font-medium opacity-70">
                                  Hired {formatDate(group.hireDate)}
                                </p>
                              )}
                              {group.region && (
                                <p className="mt-1 break-words text-[9px] font-bold text-[#FDBA74] opacity-90">
                                  {group.region}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="mt-2 flex items-center justify-between gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[9px] text-[#64748B]">
                          <span className="truncate font-medium">{group.members.length} team rows</span>
                          {groupVacancies > 0 ? (
                            <span className="shrink-0 font-bold uppercase tracking-[0.06em] text-primary">
                              {groupVacancies} vacant
                            </span>
                          ) : (
                            <span className="shrink-0">No vacancies</span>
                          )}
                        </div>

                        <div className="mt-2 space-y-1.5">
                          {group.members.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-text-secondary">
                              No team rows under this manager.
                            </div>
                          ) : (
                            buildMemberTree(group.members).map((node) => (
                              <TeamMemberNode key={node.key} node={node} />
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export function OrganogramReport({
  fixedLine = null,
  initialError = null,
  initialReport = null,
}: OrganogramReportProps) {
  const [report, setReport] = React.useState<VacancyReportData | null>(
    initialReport,
  );
  const [error, setError] = React.useState<string | null>(initialError);
  const [isLoading, setIsLoading] = React.useState(false);
  const [lineFilter, setLineFilter] = React.useState("");
  const effectiveLineFilter = fixedLine ?? lineFilter;

  const loadReport = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/reports/organogram", {
        cache: "no-store",
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "organogram_failed");
        return;
      }

      setReport(payload);
    } catch {
      setError("Unable to load organogram.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const rows = React.useMemo(
    () =>
      (report?.organogramRows ?? []).filter(isOrganogramVisibleRow),
    [report],
  );
  const lineOptions = React.useMemo(() => {
    const options = new Set<string>();

    for (const row of rows) {
      if (!row.lineName) {
        continue;
      }

      if (isVacancyRow(row) || isSalesDepartment(row) || isOfficeLine(row)) {
        options.add(row.lineName);
      }
    }

    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [rows]);
  const filterOptions = React.useMemo(
    () => ({
      lines: lineOptions,
    }),
    [lineOptions],
  );
  const filteredRows = React.useMemo(() => {
    const managerHrIdsToKeep = new Set<string>();
    const officeDescendantHrIdsToKeep = new Set<string>();
    const isOfficeSelected = effectiveLineFilter.trim().toLowerCase() === "office";
    const selectedLineRows = effectiveLineFilter
      ? rows.filter((row) =>
          isOfficeSelected
            ? row.lineName === effectiveLineFilter
            : row.lineName === effectiveLineFilter &&
              (isVacancyRow(row) || isSalesDepartment(row)),
        )
      : rows;

    if (effectiveLineFilter) {
      let frontier = selectedLineRows
        .map((row) => row.managerHrId)
        .filter((value): value is string => Boolean(value));

      while (frontier.length > 0) {
        const nextFrontier: string[] = [];

        for (const managerHrId of frontier) {
          const normalizedManagerHrId = normalizeHrIdKey(managerHrId);

          if (managerHrIdsToKeep.has(normalizedManagerHrId)) {
            continue;
          }

          managerHrIdsToKeep.add(normalizedManagerHrId);

          const managerRow = rows.find((row) => normalizeHrIdKey(row.hrId) === normalizedManagerHrId);

          if (managerRow?.managerHrId) {
            nextFrontier.push(managerRow.managerHrId);
          }
        }

        frontier = nextFrontier;
      }

      if (isOfficeSelected) {
        const officeManagerHrIds = new Set(
          rows
            .filter((row) => row.lineName === effectiveLineFilter && !isChiefExecutive(row))
            .map((row) => normalizeHrIdKey(row.hrId)),
        );

        for (const row of rows) {
          if (row.lineName === effectiveLineFilter || isChiefExecutive(row)) {
            continue;
          }

          let managerHrId = row.managerHrId;
          const visited = new Set<string>();

          while (managerHrId) {
            const normalizedManagerHrId = normalizeHrIdKey(managerHrId);

            if (officeManagerHrIds.has(normalizedManagerHrId)) {
              officeDescendantHrIdsToKeep.add(row.hrId);
              break;
            }

            if (visited.has(normalizedManagerHrId)) {
              break;
            }

            visited.add(normalizedManagerHrId);
            managerHrId = rows.find((candidate) => normalizeHrIdKey(candidate.hrId) === normalizedManagerHrId)?.managerHrId ?? null;
          }
        }
      }
    }

    return rows.filter((row) => {
      const keepLeadershipChain =
        Boolean(effectiveLineFilter) &&
        (isChiefExecutive(row) ||
          managerHrIdsToKeep.has(row.hrId) ||
          managerHrIdsToKeep.has(normalizeHrIdKey(row.hrId)) ||
          officeDescendantHrIdsToKeep.has(row.hrId));
      const matchesSelectedLine =
        !effectiveLineFilter ||
        (isOfficeSelected
          ? row.lineName === effectiveLineFilter || officeDescendantHrIdsToKeep.has(row.hrId)
          : row.lineName === effectiveLineFilter &&
            (isVacancyRow(row) || isSalesDepartment(row)));

      if (keepLeadershipChain) {
        return true;
      }

      return matchesSelectedLine;
    });
  }, [effectiveLineFilter, rows]);
  const diagnostics = React.useMemo(
    () => findOrganogramDiagnostics(filteredRows),
    [filteredRows],
  );
  const hasActiveFilters = Boolean(effectiveLineFilter) && !fixedLine;
  const canShowChart = Boolean(effectiveLineFilter);

  function clearFilters() {
    setLineFilter("");
  }

  return (
    <OrganogramPageShell>
      <AdminPageHero
        actions={
          <Button
            className="h-11 rounded-2xl px-4 text-xs"
            disabled={isLoading}
            onClick={() => void loadReport()}
            variant="secondary"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        }
        badges={
          <div className="flex flex-wrap gap-2 text-xs text-[#475569]">
            <AdminInsightChip>
              {effectiveLineFilter ? `${effectiveLineFilter} selected` : "Select line"}
            </AdminInsightChip>
            <AdminInsightChip tone="orange">
              {rows.length} total rows cached
            </AdminInsightChip>
          </div>
        }
        description="Sales lines show Sales and Marketing leadership. Office shows the full office structure."
        eyebrow="People"
        icon={<Building2 className="h-3.5 w-3.5" />}
        title="Organogram"
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
          <div>
            <h2 className="text-base font-semibold text-text">Organogram unavailable</h2>
            <p className="mt-1 text-sm text-text-secondary">{error}</p>
          </div>
        </AdminCallout>
      ) : null}

      {isLoading && !report ? (
        <Card className={`${panelClassName} p-4`}>
          <div className="flex items-center gap-3 text-sm text-[#64748B]">
            <LoadingSpinner />
            Loading organogram...
          </div>
        </Card>
      ) : null}

      {report ? (
        <>
          <AdminTableShell
            action={
              !fixedLine ? (
                <Button
                  className="h-11 gap-2 rounded-2xl"
                  disabled={!hasActiveFilters}
                  onClick={clearFilters}
                  variant="secondary"
                >
                  <X className="h-4 w-4" />
                  Reset
                </Button>
              ) : null
            }
            description="Select a line to reveal the matching hierarchy."
            title="Hierarchy Scope"
          >
            <div className="grid gap-3 p-4 md:grid-cols-[minmax(240px,360px)_1fr]">
              {!fixedLine ? (
                <SelectFilter
                  label="Line"
                  onChange={setLineFilter}
                  options={filterOptions.lines}
                  value={lineFilter}
                />
              ) : null}
              <div className="flex items-end">
                <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm text-text-secondary shadow-sm">
                  {effectiveLineFilter
                    ? `Showing ${filteredRows.length} rows inside ${effectiveLineFilter}.`
                    : "Pick a line to render the hierarchy in one focused view."}
                </div>
              </div>
            </div>
          </AdminTableShell>

          {diagnostics.length > 0 ? (
            <AdminCallout tone="warning">
              <AlertCircle className="mt-0.5 h-5 w-5 text-amber-600" />
              <div>
                <h2 className="text-base font-semibold text-text">
                  Hierarchy data needs review
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  {diagnostics
                    .map((diagnostic) => {
                      const label = {
                        circular_manager: "circular manager links",
                        missing_manager: "missing or inactive managers",
                        self_manager: "self-manager links",
                      }[diagnostic.code];

                      return `${diagnostic.count} ${label}`;
                    })
                    .join(", ")}
                  . The Organogram is still read-only and renders defensively.
                </p>
              </div>
            </AdminCallout>
          ) : null}

          <OrganogramView
            rows={canShowChart ? filteredRows : []}
            selectedLine={effectiveLineFilter || null}
          />
        </>
      ) : null}
    </OrganogramPageShell>
  );
}
