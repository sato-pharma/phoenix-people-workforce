"use client";

import {
  AlertCircle,
  BriefcaseBusiness,
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
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { formatDateOnly } from "@/lib/date-only";
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

function emptyText(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

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
  "h-11 w-full rounded-2xl border border-[#D7E0EA] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15";

const panelClassName =
  "rounded-[28px] border border-white/75 bg-white/94 shadow-[0_28px_90px_rgba(15,23,42,0.12)] ring-1 ring-slate-900/5";

function OrganogramPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-[34px] border border-[#FED7AA]/80 bg-[radial-gradient(circle_at_12%_0%,rgba(249,115,22,0.12),transparent_32%),linear-gradient(135deg,#FFF7ED_0%,#F8FAFC_42%,#FFFFFF_100%)] p-4 shadow-[0_30px_110px_rgba(15,23,42,0.10)] sm:p-5">
      <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-[#F97316]/45 to-transparent" />
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

function formatDate(value: string | null | undefined) {
  return formatDateOnly(value, "en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function HierarchyNode({
  className,
  icon,
  label,
  name,
  tone = "default",
}: {
  className?: string;
  icon?: React.ReactNode;
  label: string;
  name: string;
  tone?: "dark" | "default" | "primary";
}) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden w-full max-w-[220px] rounded-xl border px-3 py-2.5 text-center shadow-[0_4px_14px_rgba(15,23,42,0.04)] transition-all duration-160 ease-out hover:-translate-y-px hover:shadow-md",
        tone === "dark"
          ? "border-[#0F172A] bg-gradient-to-br from-[#0F172A] to-[#1E293B] text-white shadow-lg hover:shadow-[0_8px_20px_rgba(15,23,42,0.12)]"
          : tone === "primary"
            ? "border-orange-200/90 bg-gradient-to-br from-orange-50 to-orange-100/50 text-text shadow-md hover:shadow-lg hover:border-orange-300"
            : "border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 text-[#0F172A] hover:border-slate-300",
        className,
      )}
    >
      <div className="mb-1.5 flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[#F97316]">
        {icon}
        {label}
      </div>
      <p
        className={cn(
          "text-xs font-semibold leading-snug",
          tone === "dark" ? "text-bg dark:text-white" : "text-text",
        )}
      >
        {name}
      </p>
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
        "group relative overflow-hidden rounded-xl border px-2.5 py-2 shadow-[0_4px_14px_rgba(15,23,42,0.04)] transition-all duration-160 ease-out hover:-translate-y-px hover:shadow-md",
        isVacancy
          ? "border-orange-200/90 bg-gradient-to-br from-orange-50 to-orange-100/50 hover:border-orange-300"
          : "border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 hover:border-slate-300",
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          isVacancy ? "bg-[#F97316]" : "bg-slate-300",
        )}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="whitespace-normal break-words text-[11px] font-semibold leading-tight text-text">
            {row.fullName}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-text-secondary">
            <span className="font-mono font-medium">{row.hrId}</span>
            {title && !showRepFields ? (
            <span className="break-words leading-snug text-text">{title}</span>
            ) : null}
          </div>
        </div>
        {isVacancy ? <Badge variant="warning">Vacant</Badge> : null}
      </div>

      {showRepFields ? (
        <dl className="mt-2 grid grid-cols-[48px_minmax(0,1fr)] gap-y-0.5 text-[10px]">
          <dt className="text-text-secondary">Hiring</dt>
          <dd className="truncate text-right font-medium text-text">
            {formatDate(row.hireDate)}
          </dd>
          <dt className="text-text-secondary">Area</dt>
          <dd className="truncate text-right font-medium text-text">
            {emptyText(row.areaName)}
          </dd>
        </dl>
      ) : null}
    </div>
  );
}

function buildMemberTree(members: OrganogramRow[]) {
  const memberIds = new Set(members.map((member) => member.hrId).filter(Boolean));
  const nodesByHrId = new Map<string, MemberNode[]>();
  const nodes = members.map((member, index) => ({
    children: [],
    key: `${rowKey(member)}-${index}`,
    row: member,
  }) satisfies MemberNode);

  for (const node of nodes) {
    nodesByHrId.set(node.row.hrId, [...(nodesByHrId.get(node.row.hrId) ?? []), node]);
  }

  const roots: MemberNode[] = [];

  for (const node of nodes) {
    const member = node.row;

    if (member.managerHrId && memberIds.has(member.managerHrId)) {
      const managerNode = nodesByHrId.get(member.managerHrId)?.[0];
      if (managerNode) {
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
        <div className="ml-3 mt-1.5 border-l border-[#F97316]/35 pl-2">
          <div className="-ml-[13px] mb-1.5 h-2.5 w-2.5 rounded-bl-lg border-b border-l border-[#F97316]/35" />
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

function OrganogramView({
  rows,
  selectedLine,
}: {
  rows: OrganogramRow[];
  selectedLine: string | null;
}) {
  const employees = rows.filter((row) => row.type === "employee");
  const vacancies = rows.filter((row) => row.type === "vacancy");
  const lineName = selectedLine ?? "Select Line";
  const chiefExecutive = rows.find((row) => isChiefExecutive(row)) ?? null;
  const lineLeader =
    rows.find((row) =>
      isNationalSalesManager(row),
    ) ?? null;
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
      !isDistrictSalesManager(row),
  );
  const assignedToDsm = new Set<string>();
  const dsmGroups = groupBy(dsmRows, managerIdentityKey).map(([, dsms]) => {
    const primaryDsm = [...dsms].sort((left, right) =>
      left.fullName.localeCompare(right.fullName),
    )[0];
    const dsmHrIdsForGroup = new Set(dsms.map((row) => normalizeHrIdKey(row.hrId)));
    const dsmNameKeysForGroup = new Set(dsms.map((row) => normalizeNameKey(row.fullName)));
    const members = teamRows
      .filter((row) => {
        const managerHrId = normalizeHrIdKey(row.managerHrId);
        return managerHrId
          ? dsmHrIdsForGroup.has(managerHrId)
          : dsmNameKeysForGroup.has(normalizeNameKey(row.managerName));
      })
      .sort((left, right) =>
        left.type === right.type
          ? left.fullName.localeCompare(right.fullName)
          : left.type === "vacancy"
            ? 1
            : -1,
    );

    for (const member of members) {
      assignedToDsm.add(rowKey(member));
    }

    return {
      dsm: primaryDsm,
      members,
      name: primaryDsm.fullName,
      title: primaryDsm.positionTitle ?? primaryDsm.jobTitle ?? "District Sales Manager",
    };
  });
  const marketingManagers = teamRows
    .filter((row) => isMarketingManager(row))
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
      assignedToDsm.add(rowKey(manager));
    }

    for (const member of members) {
      assignedToDsm.add(rowKey(member));
    }

    return {
      dsm: null,
      members,
      name: primaryManager.fullName,
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
        !assignedToDsm.has(key) &&
        !reportsToLineLeader &&
        (managerHrId || row.managerName) &&
        (!managerHrId || !dsmHrIds.has(managerHrId)) &&
        (!managerNameKey || !dsmNameKeys.has(managerNameKey))
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
      members,
      name,
      title: "Manager",
    };
  });
  const unassignedMembers = teamRows.filter((row) => {
    const key = rowKey(row);

    return !assignedToDsm.has(key) && !row.managerHrId && !row.managerName;
  });
  const groups = [
    ...dsmGroups,
    ...marketingGroups,
    ...fallbackManagerGroups,
    ...(unassignedMembers.length > 0
      ? [{ dsm: null, members: unassignedMembers, name: "Unassigned Manager", title: "Manager" }]
      : []),
  ].filter((group) => group.members.length > 0 || group.dsm);
  const filledLaneCount = groups.filter((group) => group.members.length > 0).length;
  const laneCount = Math.max(groups.length, 1);

  return (
    <Card className={cn(panelClassName, "overflow-hidden p-0")}>
      <AdminSectionHeader
        action={
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral">{employees.length} employees</Badge>
            <Badge variant={vacancies.length > 0 ? "warning" : "neutral"}>
              {vacancies.length} vacancies
            </Badge>
            <Badge variant="neutral">{filledLaneCount} lanes</Badge>
          </div>
        }
        description="Executive leadership, manager lanes, active employees, and open vacancies in one operational view."
        title={selectedLine ? `${selectedLine} structure` : "Select a line"}
      />
      <div
        className="overflow-hidden bg-[#F8FAFC] px-3 py-5 sm:px-4"
        style={{
          backgroundImage:
            "linear-gradient(rgba(226, 232, 240, 0.55) 1px, transparent 1px), linear-gradient(90deg, rgba(226, 232, 240, 0.55) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      >
        {!selectedLine ? (
          <div className="rounded-3xl border border-dashed border-[#CBD5E1] bg-white/90 p-10 text-center shadow-[0_18px_55px_rgba(15,23,42,0.08)]">
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
            <div className="mb-5 grid w-full gap-2 md:grid-cols-3 xl:max-w-2xl">
              <AdminStatCard
                description="Active employees included in this scope."
                icon={<UsersRound className="h-4 w-4" />}
                label="Employees"
                value={employees.length}
              />
              <AdminStatCard
                description="Vacant positions tracked with active line visibility."
                icon={<BriefcaseBusiness className="h-4 w-4" />}
                label="Vacancies"
                value={vacancies.length}
              />
              <AdminStatCard
                description="Combined records represented in the chart."
                icon={<Network className="h-4 w-4" />}
                label="Rows"
                value={rows.length}
              />
            </div>

            <div className="relative flex flex-col items-center">
              <HierarchyNode
                icon={<Crown className="h-3.5 w-3.5" />}
                label={chiefExecutive ? chiefExecutive.positionTitle ?? chiefExecutive.jobTitle ?? "CEO" : "CEO"}
                name={chiefExecutive?.fullName ?? "Executive Leadership"}
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
                icon={<UsersRound className="h-3.5 w-3.5" />}
                label={lineLeader ? lineLeader.positionTitle ?? lineLeader.jobTitle ?? "Line Leadership" : "Line Leadership"}
                name={lineLeader?.fullName ?? lineName}
                tone="primary"
              />
              <div className="h-5 w-px bg-border" />
              <div className="relative h-px w-[92%] bg-[#CBD5E1]">
                <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#F97316]" />
              </div>
            </div>

            {groups.length === 0 ? (
              <div className="mx-auto mt-8 max-w-md rounded-xl border border-dashed border-[#CBD5E1] bg-white p-8 text-center text-sm text-[#64748B]">
                No manager lanes found for this line.
              </div>
            ) : (
              <div className="relative mt-6">
                <div className="absolute left-0 right-0 top-0 h-px bg-[#CBD5E1]" />
                <div
                  className="grid w-full gap-2 pt-5"
                  style={{
                    gridTemplateColumns: `repeat(${laneCount}, minmax(0, 1fr))`,
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
                        className={cn(
                          "group relative min-w-0 overflow-hidden rounded-xl border border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 p-2 shadow-[0_4px_14px_rgba(15,23,42,0.04)] transition-all duration-160 ease-out hover:-translate-y-px hover:shadow-md hover:border-slate-300",
                        )}
                        key={groupKey}
                      >
                        <div className="absolute -top-5 left-1/2 h-5 w-px -translate-x-1/2 bg-[#CBD5E1]" />
                        <div className="absolute left-3 right-3 top-0 h-1 rounded-b-full bg-[#F97316] ring-1 ring-orange-100" />
                        <div className="rounded-xl bg-gradient-to-br from-[#0F172A] to-[#1E293B] px-2 py-2 text-white shadow-[0_4px_12px_rgba(15,23,42,0.15)]">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 text-left">
                              <div className="mb-1 flex h-5 w-5 items-center justify-center rounded-md bg-white/10 ring-1 ring-white/20">
                                <BriefcaseBusiness className="h-3 w-3" />
                              </div>
                              <p className="break-words text-[10px] font-bold uppercase tracking-[0.08em] leading-3">
                                {group.name}
                              </p>
                              <p className="mt-1 break-words text-[9px] font-medium leading-3 opacity-80">
                                {group.title}
                              </p>
                            </div>
                            <div className="shrink-0 rounded-md bg-white/10 ring-1 ring-white/20 px-1.5 py-1 text-center text-[9px] font-bold uppercase tracking-[0.06em]">
                              <p className="text-[10px] leading-none">{group.members.length}</p>
                              <p className="mt-0.5 opacity-70">rows</p>
                            </div>
                          </div>
                        </div>

                        <div className="mt-2 flex items-center justify-between gap-1.5 rounded-lg border border-slate-200/90 bg-gradient-to-br from-slate-50 to-slate-100/50 px-2 py-1.5 text-[9px] text-[#64748B]">
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
      const response = await fetch("/api/reports/vacancies", {
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
      (report?.organogramRows ?? []).filter(
        (row) =>
          isSalesDepartment(row) ||
          isMarketingDepartment(row) ||
          isOfficeLine(row),
      ),
    [report],
  );
  const lineOptions = React.useMemo(() => {
    const options = new Set<string>();

    for (const row of rows) {
      if (!row.lineName) {
        continue;
      }

      if (isSalesDepartment(row) || isOfficeLine(row)) {
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
            : row.lineName === effectiveLineFilter && isSalesDepartment(row),
        )
      : rows;

    if (effectiveLineFilter) {
      let frontier = selectedLineRows
        .map((row) => row.managerHrId)
        .filter((value): value is string => Boolean(value));

      while (frontier.length > 0) {
        const nextFrontier: string[] = [];

        for (const managerHrId of frontier) {
          if (managerHrIdsToKeep.has(managerHrId)) {
            continue;
          }

          managerHrIdsToKeep.add(managerHrId);

          const managerRow = rows.find((row) => row.hrId === managerHrId);

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
            .map((row) => row.hrId),
        );

        for (const row of rows) {
          if (row.lineName === effectiveLineFilter || isChiefExecutive(row)) {
            continue;
          }

          let managerHrId = row.managerHrId;
          const visited = new Set<string>();

          while (managerHrId) {
            if (officeManagerHrIds.has(managerHrId)) {
              officeDescendantHrIdsToKeep.add(row.hrId);
              break;
            }

            if (visited.has(managerHrId)) {
              break;
            }

            visited.add(managerHrId);
            managerHrId = rows.find((candidate) => candidate.hrId === managerHrId)?.managerHrId ?? null;
          }
        }
      }
    }

    return rows.filter((row) => {
      const keepLeadershipChain =
        Boolean(effectiveLineFilter) &&
        (isChiefExecutive(row) ||
          managerHrIdsToKeep.has(row.hrId) ||
          officeDescendantHrIdsToKeep.has(row.hrId));
      const matchesSelectedLine =
        !effectiveLineFilter ||
        (isOfficeSelected
          ? row.lineName === effectiveLineFilter || officeDescendantHrIdsToKeep.has(row.hrId)
          : row.lineName === effectiveLineFilter && isSalesDepartment(row));

      if (keepLeadershipChain) {
        return true;
      }

      return matchesSelectedLine;
    });
  }, [effectiveLineFilter, rows]);
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
                <div className="rounded-2xl border border-[#E2E8F0] bg-white/80 px-4 py-3 text-sm text-text-secondary shadow-[0_12px_36px_rgba(15,23,42,0.06)]">
                  {effectiveLineFilter
                    ? `Showing ${filteredRows.length} rows inside ${effectiveLineFilter}.`
                    : "Pick a line to render the hierarchy in one focused view."}
                </div>
              </div>
            </div>
          </AdminTableShell>

          <OrganogramView
            rows={canShowChart ? filteredRows : []}
            selectedLine={effectiveLineFilter || null}
          />
        </>
      ) : null}
    </OrganogramPageShell>
  );
}
