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
type ManagerLane = {
  childLanes?: ManagerLane[];
  dsm: OrganogramRow | null;
  hireDate: string | null;
  hrId: string | null;
  level: "dsm" | "manager" | "rsm";
  members: OrganogramRow[];
  name: string;
  region: string | null;
  reportsTo?: string | null;
  title: string;
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
    isSalesStructureRole(row) ||
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

function orgContextKey(
  id: number | null | undefined,
  name: string | null | undefined,
) {
  if (typeof id === "number" && Number.isFinite(id)) {
    return `id:${id}`;
  }

  const nameKey = normalizeNameKey(name);
  return nameKey ? `name:${nameKey}` : "";
}

function contextMatches(
  leftId: number | null | undefined,
  leftName: string | null | undefined,
  rightId: number | null | undefined,
  rightName: string | null | undefined,
) {
  const leftKey = orgContextKey(leftId, leftName);
  const rightKey = orgContextKey(rightId, rightName);

  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function textContextMatches(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const leftKey = normalizeNameKey(left);
  const rightKey = normalizeNameKey(right);

  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function normalizedDistrictText(value: string | null | undefined) {
  return normalizeNameKey(value)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function districtBucketKey(value: string | null | undefined) {
  const text = normalizedDistrictText(value);

  if (!text) return "";
  if (/\b(cairo|new cairo|nasr|heliopolis|helwan|maadi|shoubra|sheraton|nozha|airport|tagamoa|tagamo3)\b/.test(text)) {
    return "cairo";
  }
  if (/\b(giza|dokki|faisal|haram|imbaba|mohandsen|mohandesen|october|zayed)\b/.test(text)) {
    return "giza";
  }
  if (/\b(alex|alexandria|behira|beheira)\b/.test(text)) {
    return "alexandria";
  }
  if (/\b(delta|gharbia|mahalla|tanta|menoufia|monofia|kafr|kfs|qalyubia|qaluibia|dakahlia)\b/.test(text)) {
    return "delta";
  }
  if (/\b(upper egypt|assuit|asyut|sohag|qena|minia|bani suef|fayoum)\b/.test(text)) {
    return "upper egypt";
  }
  if (/\b(canal|port said|domiat|damietta)\b/.test(text)) {
    return "canal";
  }

  return text;
}

function isDistrictBucketLabel(value: string | null | undefined) {
  const text = normalizedDistrictText(value);

  return [
    "cairo",
    "greater cairo",
    "giza",
    "alexandria",
    "delta",
    "delta 1",
    "delta 2",
    "upper egypt",
    "canal",
    "east",
    "west",
  ].includes(text);
}

function districtBucketMatches(row: OrganogramRow, vacantManager: OrganogramRow) {
  const vacancyRegionBucket = districtBucketKey(vacantManager.regionName);
  const vacancyAreaBucket = isDistrictBucketLabel(vacantManager.areaName)
    ? districtBucketKey(vacantManager.areaName)
    : "";
  const vacancyBucket = vacancyRegionBucket || vacancyAreaBucket;

  if (!vacancyBucket) {
    return false;
  }

  const rowBucket =
    districtBucketKey(row.regionName) ||
    districtBucketKey(row.areaName) ||
    districtBucketKey(row.teamName);

  return Boolean(rowBucket && rowBucket === vacancyBucket);
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

function isSalesStructureRole(row: OrganogramRow) {
  return (
    isMedicalRep(row) ||
    isDistrictSalesManager(row) ||
    isRegionalSalesManager(row) ||
    isNationalSalesManager(row)
  );
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

function reportsToKnownManager(
  row: OrganogramRow,
  managerHrIds: Set<string>,
  managerNameKeys: Set<string>,
) {
  const managerHrId = normalizeHrIdKey(row.managerHrId);
  const managerNameKey = normalizeNameKey(row.managerName);

  return (
    Boolean(managerHrId && managerHrIds.has(managerHrId)) ||
    Boolean(managerNameKey && managerNameKeys.has(managerNameKey))
  );
}

function reportsToVacantManagerSlot(row: OrganogramRow, vacantManager: OrganogramRow) {
  if (vacantManager.type !== "vacancy") {
    return false;
  }

  if (!contextMatches(row.lineId, row.lineName, vacantManager.lineId, vacantManager.lineName)) {
    return false;
  }

  if (
    orgContextKey(vacantManager.teamId, vacantManager.teamName) &&
    !contextMatches(row.teamId, row.teamName, vacantManager.teamId, vacantManager.teamName)
  ) {
    return false;
  }

  if (districtBucketMatches(row, vacantManager)) {
    return true;
  }

  if (orgContextKey(vacantManager.areaId, vacantManager.areaName)) {
    return contextMatches(row.areaId, row.areaName, vacantManager.areaId, vacantManager.areaName);
  }

  return textContextMatches(row.regionName, vacantManager.regionName);
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
  const nodes: MemberNode[] = members.map((member, index) => ({
    children: [] as MemberNode[],
    key: `${rowKey(member)}-${index}`,
    row: member,
  }));
  const vacantManagerNodes = nodes.filter(
    (node) =>
      node.row.type === "vacancy" &&
      (isDistrictSalesManager(node.row) || isRegionalSalesManager(node.row)),
  );

  for (const node of nodes) {
    const hrId = normalizeHrIdKey(node.row.hrId);
    nodesByHrId.set(hrId, [...(nodesByHrId.get(hrId) ?? []), node]);
  }

  const roots: MemberNode[] = [];

  for (const node of nodes) {
    const member = node.row;
    const memberHrId = normalizeHrIdKey(member.hrId);
    const managerHrId = normalizeHrIdKey(member.managerHrId);
    const canUseVacantManagerFallback =
      !isChiefExecutive(member) &&
      !isNationalSalesManager(member) &&
      !isRegionalSalesManager(member) &&
      !isDistrictSalesManager(member);
    const vacantManagerNode = canUseVacantManagerFallback && !memberIds.has(managerHrId)
      ? vacantManagerNodes.find((candidate) =>
          candidate !== node && reportsToVacantManagerSlot(member, candidate.row),
        )
      : null;

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
    } else if (vacantManagerNode) {
      vacantManagerNode.children.push(node);
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
  tone = "medical",
}: {
  breakdown: OrganogramKpiBreakdown;
  title: string;
  tone?: "medical" | "dsm" | "nsm" | "rsm" | "total";
}) {
  const completion = breakdown.total > 0
    ? Math.min(100, Math.round((breakdown.actual / breakdown.total) * 100))
    : 0;
  const displayTitle =
    {
      medical: "Medical Sales Representatives",
      dsm: "District Sales Managers",
      nsm: "National Sales Managers",
      rsm: "Regional Sales Managers",
      total: "Total Line Structure",
    }[tone] ?? title;
  const isTotal = tone === "total";

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border p-4 shadow-[0_12px_30px_rgba(15,23,42,0.06)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_18px_42px_rgba(15,23,42,0.11)]",
        isTotal
          ? "border-[#FDBA74]/80 bg-[linear-gradient(135deg,#FFFFFF_0%,#FFF7ED_50%,#F8FAFC_100%)] ring-1 ring-[#F97316]/10"
          : "border-[#E2E8F0] bg-white",
      )}
    >
      <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-[#F97316]/10 blur-3xl" />
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-[#F97316] to-transparent" />

      <div className="relative">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-h-[32px] break-words text-[11px] font-black uppercase leading-4 tracking-[0.12em] text-slate-700">
            {displayTitle}
          </h3>
          <span className="shrink-0 rounded-full bg-[#F97316]/10 px-2 py-1 text-[9px] font-black uppercase tracking-[0.12em] text-[#EA580C] ring-1 ring-[#FDBA74]/70">
            {completion}%
          </span>
        </div>

        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
          <div>
            <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">
              Actual / Total Structure
            </p>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-3xl font-black text-slate-950">
                {breakdown.actual}
              </span>
              <span className="text-sm font-black text-slate-400">/</span>
              <span className="text-xl font-black text-slate-500">
                {breakdown.total}
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-[#FDBA74]/55 bg-[#FFF7ED] px-3 py-2 text-right shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
            <p className="text-[9px] font-black uppercase tracking-[0.14em] text-[#EA580C]">
              Vacant
            </p>
            <p className="mt-0.5 text-2xl font-black leading-none text-[#C2410C]">
              {breakdown.vacant}
            </p>
          </div>
        </div>

        <div className="mt-4">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100 shadow-inner">
            <div
              className={cn(
                "h-full rounded-full bg-gradient-to-r from-[#F97316] to-[#FDBA74] transition-all duration-700 ease-out",
              )}
              style={{ width: `${completion}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">
            <span>Completion</span>
            <span className="text-[#EA580C]">{completion}%</span>
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
  const rsmGroups: ManagerLane[] = groupBy(rsmRows, managerIdentityKey).map(([, rsms]) => {
    const primaryRsm = [...rsms].sort((left, right) =>
      left.fullName.localeCompare(right.fullName),
    )[0];
    const rsmHrIdsForGroup = new Set(rsms.map((row) => normalizeHrIdKey(row.hrId)));
    const rsmNameKeysForGroup = new Set(rsms.map((row) => normalizeNameKey(row.fullName)));
    const dsmsUnderRsm = dsmRows.filter((row) =>
      reportsToManagerGroup(row, rsmHrIdsForGroup, rsmNameKeysForGroup),
    );
    const childLanes: ManagerLane[] = groupBy(dsmsUnderRsm, managerIdentityKey)
      .map(([, dsms]) => {
        const primaryDsm = [...dsms].sort((left, right) =>
          left.fullName.localeCompare(right.fullName),
        )[0];
        const dsmHrIdsForGroup = new Set(dsms.map((row) => normalizeHrIdKey(row.hrId)));
        const dsmNameKeysForGroup = new Set(dsms.map((row) => normalizeNameKey(row.fullName)));
        const members = teamRows
          .filter((row) => {
            if (assignedToManager.has(rowKey(row))) {
              return false;
            }

            if (reportsToManagerGroup(row, dsmHrIdsForGroup, dsmNameKeysForGroup)) {
              return true;
            }

            return (
              isMedicalRep(row) &&
              !reportsToKnownManager(row, dsmHrIds, dsmNameKeys) &&
              !reportsToKnownManager(row, rsmHrIds, rsmNameKeys) &&
              reportsToVacantManagerSlot(row, primaryDsm)
            );
          })
          .sort(sortHierarchyMembers);

        for (const dsm of dsms) {
          assignedToManager.add(rowKey(dsm));
        }
        for (const member of members) {
          assignedToManager.add(rowKey(member));
        }

        return {
          dsm: primaryDsm,
          hireDate: primaryDsm.hireDate,
          hrId: primaryDsm.hrId,
          level: "dsm",
          members,
          name: primaryDsm.fullName,
          region: primaryDsm.regionName ?? primaryDsm.areaName,
          reportsTo: primaryDsm.managerName ?? primaryRsm.fullName,
          title: primaryDsm.positionTitle ?? primaryDsm.jobTitle ?? "District Sales Manager",
        };
      });
    const childDsmHrIds = new Set(dsmsUnderRsm.map((row) => normalizeHrIdKey(row.hrId)));
    const childDsmNameKeys = new Set(dsmsUnderRsm.map((row) => normalizeNameKey(row.fullName)));
    const members = teamRows
      .filter((row) =>
        !assignedToManager.has(rowKey(row)) &&
        !reportsToKnownManager(row, childDsmHrIds, childDsmNameKeys) &&
        (
          reportsToManagerGroup(row, rsmHrIdsForGroup, rsmNameKeysForGroup) ||
          rsms.some((rsm) => reportsUpTo(row, rsm, rows))
        ),
      )
      .sort(sortHierarchyMembers);

    for (const member of members) {
      assignedToManager.add(rowKey(member));
    }

    return {
      childLanes,
      dsm: primaryRsm,
      hireDate: primaryRsm.hireDate,
      hrId: primaryRsm.hrId,
      level: "rsm",
      members,
      name: primaryRsm.fullName,
      region: primaryRsm.regionName,
      reportsTo: primaryRsm.managerName ?? lineLeader?.fullName ?? null,
      title: primaryRsm.positionTitle ?? primaryRsm.jobTitle ?? "Regional Sales Manager",
    };
  });
  const dsmGroups: ManagerLane[] = groupBy(
    dsmRows.filter((row) => !assignedToManager.has(rowKey(row))),
    managerIdentityKey,
  ).map(([, dsms]) => {
    const primaryDsm = [...dsms].sort((left, right) =>
      left.fullName.localeCompare(right.fullName),
    )[0];
    const dsmHrIdsForGroup = new Set(dsms.map((row) => normalizeHrIdKey(row.hrId)));
    const dsmNameKeysForGroup = new Set(dsms.map((row) => normalizeNameKey(row.fullName)));
    const members = teamRows
      .filter((row) => {
        if (assignedToManager.has(rowKey(row))) {
          return false;
        }

        if (reportsToManagerGroup(row, dsmHrIdsForGroup, dsmNameKeysForGroup)) {
          return true;
        }

        return (
          isDistrictSalesManager(primaryDsm) &&
          !reportsToKnownManager(row, dsmHrIds, dsmNameKeys) &&
          !reportsToKnownManager(row, rsmHrIds, rsmNameKeys) &&
          reportsToVacantManagerSlot(row, primaryDsm)
        );
      })
      .sort(sortHierarchyMembers);

    for (const member of members) {
      assignedToManager.add(rowKey(member));
    }

    return {
      dsm: primaryDsm,
      hireDate: primaryDsm.hireDate,
      hrId: primaryDsm.hrId,
      level: "dsm",
      members,
      name: primaryDsm.fullName,
      region: primaryDsm.regionName ?? primaryDsm.areaName,
      reportsTo: primaryDsm.managerName ?? lineLeader?.fullName ?? null,
      title: primaryDsm.positionTitle ?? primaryDsm.jobTitle ?? "District Sales Manager",
    };
  });
  const marketingManagers = teamRows
    .filter((row) => !assignedToManager.has(rowKey(row)) && isMarketingManager(row))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
  const marketingGroups: ManagerLane[] = groupBy(marketingManagers, managerIdentityKey).map(([, managers]) => {
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
      level: "manager",
      members,
      name: primaryManager.fullName,
      region: primaryManager.regionName,
      reportsTo: primaryManager.managerName ?? null,
      title: primaryManager.positionTitle ?? primaryManager.jobTitle ?? "Marketing Manager",
    } satisfies ManagerLane;
  });
  const fallbackManagerGroups: ManagerLane[] = groupBy(
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
      level: "manager",
      members,
      name,
      region: firstMember?.regionName,
      reportsTo: firstMember?.managerName ?? null,
      title: "Manager",
    } satisfies ManagerLane;
  });
  const unassignedMembers = teamRows.filter((row) => {
    const key = rowKey(row);

    return !assignedToManager.has(key) && !row.managerHrId;
  });
  const unassignedGroup: ManagerLane | null = unassignedMembers.length > 0
    ? {
        dsm: null,
        hireDate: null,
        hrId: null,
        level: "manager",
        members: unassignedMembers,
        name: "Unassigned Manager",
        region: null,
        reportsTo: null,
        title: "Manager",
      }
    : null;
  const groups: ManagerLane[] = [
    ...rsmGroups,
    ...dsmGroups,
    ...marketingGroups,
    ...fallbackManagerGroups,
    ...(unassignedGroup ? [unassignedGroup] : []),
  ].filter((group) => group.members.length > 0 || group.dsm);
  const filledLaneCount = groups.filter((group) => group.members.length > 0).length;
  const laneSpanForGroup = (group: ManagerLane) =>
    group.level === "rsm" ? Math.max(group.childLanes?.length ?? 0, 1) : 1;
  const laneCount = Math.max(
    groups.reduce((total, group) => total + laneSpanForGroup(group), 0),
    1,
  );
  const structureKpis = React.useMemo(
    () => calculateOrganogramStructureKpis(rows),
    [rows],
  );

  const displayedEmployees = rows.filter((row) => row.type === "employee");
  const displayedVacancies = rows.filter((row) => row.type === "vacancy");
  const vacancyCountForLane = (group: ManagerLane): number => {
    const managerVacancy = group.dsm?.type === "vacancy" ? 1 : 0;
    const directVacancies = group.members.filter((member) => member.type === "vacancy").length;
    const childVacancies = (group.childLanes ?? []).reduce(
      (total, child) => total + vacancyCountForLane(child),
      0,
    );

    return managerVacancy + directVacancies + childVacancies;
  };
  const renderManagerLane = (
    group: ManagerLane,
    groupKey: string,
    compact = false,
  ) => {
    const isRsmLane = group.level === "rsm";
    const groupVacancies = vacancyCountForLane(group);

    return (
      <div
        className={cn(
          "group relative min-w-[250px] rounded-xl border bg-white p-2 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md",
          isRsmLane ? "border-[#FDBA74]/80 ring-1 ring-[#F97316]/15" : "border-slate-200",
          compact ? "min-w-0" : null,
        )}
        key={groupKey}
      >
        <div className="absolute -top-5 left-1/2 h-5 w-px -translate-x-1/2 bg-slate-200" />
        <div
          className={cn(
            "absolute left-3 right-3 top-0 h-1 rounded-b-full",
            isRsmLane
              ? "bg-gradient-to-r from-[#F97316] via-[#FDBA74] to-[#F97316]"
              : "bg-[#F97316]",
          )}
        />
        <div
          className={cn(
            "rounded-xl px-2 py-2 text-white shadow-md",
            isRsmLane
              ? "bg-[linear-gradient(135deg,#0F172A_0%,#1E293B_62%,#431407_100%)] ring-1 ring-[#FDBA74]/25"
              : "bg-slate-900",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="w-full min-w-0 text-left">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[10px] font-bold uppercase leading-3 tracking-[0.08em]">
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
              {isRsmLane && group.reportsTo ? (
                <p className="mt-1 break-words text-[9px] font-semibold text-[#FDBA74] opacity-90">
                  Reports to NSM: {group.reportsTo}
                </p>
              ) : null}
              {group.region && (
                <p className="mt-1 break-words text-[9px] font-bold text-[#FDBA74] opacity-90">
                  {group.region}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[9px] text-[#64748B]">
          <span className="truncate font-medium">
            {group.members.length} {isRsmLane ? "direct rows" : "team rows"}
          </span>
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
  };

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
                    const groupKey = group.dsm
                      ? `manager-${rowKey(group.dsm)}-${groupIndex}`
                      : `manager-${group.name}-${group.title}-${groupIndex}`;
                    const childLanes = group.childLanes ?? [];

                    if (group.level === "rsm" && childLanes.length > 0) {
                      return (
                        <div
                          className="relative min-w-[250px] rounded-2xl border border-[#FDBA74]/70 bg-white/80 p-3 shadow-sm ring-1 ring-[#F97316]/10"
                          key={groupKey}
                          style={{
                            gridColumn: `span ${Math.max(childLanes.length, 1)}`,
                          }}
                        >
                          <div className="mx-auto max-w-[320px]">
                            {renderManagerLane(group, `${groupKey}-rsm`, true)}
                          </div>
                          <div className="mx-auto h-5 w-px bg-slate-200" />
                          <div className="relative h-px bg-slate-200">
                            <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#F97316]" />
                          </div>
                          <div
                            className="grid gap-3 pt-5"
                            style={{
                              gridTemplateColumns: `repeat(${childLanes.length}, minmax(250px, 1fr))`,
                            }}
                          >
                            {childLanes.map((child, childIndex) =>
                              renderManagerLane(
                                child,
                                `${groupKey}-dsm-${child.dsm ? rowKey(child.dsm) : child.name}-${childIndex}`,
                                true,
                              ),
                            )}
                          </div>
                          {group.members.length > 0 ? (
                            <div className="mt-3 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-2">
                              <p className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-500">
                                Direct RSM rows
                              </p>
                              <div className="space-y-1.5">
                                {buildMemberTree(group.members).map((node) => (
                                  <TeamMemberNode key={node.key} node={node} />
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    }

                    return renderManagerLane(group, groupKey);
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
              (isVacancyRow(row) || isSalesDepartment(row) || isSalesStructureRole(row)),
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
            (isVacancyRow(row) || isSalesDepartment(row) || isSalesStructureRole(row)));

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
