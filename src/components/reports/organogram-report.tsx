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

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { VacancyReportData } from "@/lib/reports/vacancies";
import { cn } from "@/lib/utils";

type OrganogramRow = VacancyReportData["organogramRows"][number];
type MemberNode = {
  children: MemberNode[];
  row: OrganogramRow;
};

type OrganogramReportProps = {
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
        className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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

function rowKey(row: OrganogramRow) {
  return `${row.type}-${row.hrId}-${row.sourceRowNumber ?? ""}`;
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
  let managerHrId = row.managerHrId;

  while (managerHrId) {
    if (managerHrId === manager.hrId) {
      return true;
    }

    if (visited.has(managerHrId)) {
      return false;
    }

    visited.add(managerHrId);
    managerHrId = rows.find((candidate) => candidate.hrId === managerHrId)?.managerHrId ?? null;
  }

  return false;
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function StatTile({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold text-primary">
        {label[0]}
      </div>
      <p className="text-2xl font-semibold tracking-tight text-text">
        {value}
      </p>
      <p className="mt-1 text-xs font-medium uppercase tracking-[0.16em] text-text-secondary">
        {label}
      </p>
    </div>
  );
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
        "min-w-72 rounded-xl border px-8 py-4 text-center shadow-sm",
        tone === "dark"
          ? "border-text bg-text text-bg shadow-lg dark:border-primary dark:bg-primary dark:text-white"
          : tone === "primary"
            ? "border-primary/30 bg-primary/10 text-text shadow-md"
            : "border-border bg-card text-text",
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
        {icon}
        {label}
      </div>
      <p
        className={cn(
          "text-base font-semibold",
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
        "relative overflow-hidden rounded-xl border px-3.5 py-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md",
        isVacancy
          ? "border-primary/40 bg-primary/5"
          : "border-border bg-card",
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          isVacancy ? "bg-primary" : "bg-border",
        )}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text">
            {row.fullName}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span className="font-mono font-medium">{row.hrId}</span>
            {title && !showRepFields ? (
              <span className="max-w-[155px] truncate">{title}</span>
            ) : null}
          </div>
        </div>
        <Badge variant={isVacancy ? "warning" : "success"}>
          {isVacancy ? "Vacant" : "Active"}
        </Badge>
      </div>

      {showRepFields ? (
        <dl className="mt-3 grid grid-cols-[72px_minmax(0,1fr)] gap-y-1.5 text-xs">
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
  const memberIds = new Set(members.map((member) => member.hrId));
  const nodeById = new Map<string, MemberNode>();

  for (const member of members) {
    nodeById.set(member.hrId, {
      children: [],
      row: member,
    });
  }

  const roots: MemberNode[] = [];

  for (const member of members) {
    const node = nodeById.get(member.hrId);

    if (!node) {
      continue;
    }

    if (member.managerHrId && memberIds.has(member.managerHrId)) {
      nodeById.get(member.managerHrId)?.children.push(node);
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
        <div className="ml-6 mt-2 border-l border-primary/35 pl-3.5">
          <div className="-ml-[19px] mb-2 h-3 w-3 rounded-bl-lg border-b border-l border-primary/35" />
          <div className="space-y-2.5">
            {node.children.map((child) => (
              <TeamMemberNode key={rowKey(child.row)} node={child} />
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
  const dsmHrIds = new Set(dsmRows.map((row) => row.hrId));
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
  const dsmGroups = dsmRows.map((dsm) => {
    const dsmNameKey = normalizeNameKey(dsm.fullName);
    const members = teamRows
      .filter((row) =>
        row.managerHrId
          ? row.managerHrId === dsm.hrId
          : normalizeNameKey(row.managerName) === dsmNameKey,
      )
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
      dsm,
      members,
      name: dsm.fullName,
      title: dsm.positionTitle ?? dsm.jobTitle ?? "District Sales Manager",
    };
  });
  const marketingManagers = teamRows
    .filter((row) => isMarketingManager(row))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
  const marketingGroups = marketingManagers.map((manager) => {
    const members = teamRows
      .filter((row) => row.hrId !== manager.hrId && reportsUpTo(row, manager, rows))
      .sort((left, right) => left.fullName.localeCompare(right.fullName));

    assignedToDsm.add(rowKey(manager));

    for (const member of members) {
      assignedToDsm.add(rowKey(member));
    }

    return {
      dsm: null,
      members,
      name: manager.fullName,
      title: manager.positionTitle ?? manager.jobTitle ?? "Marketing Manager",
    };
  });
  const fallbackManagerGroups = groupBy(
    teamRows.filter((row) => {
      const key = rowKey(row);
      const managerNameKey = normalizeNameKey(row.managerName);
      const reportsToLineLeader =
        Boolean(lineLeader) &&
        (row.managerHrId === lineLeader?.hrId ||
          managerNameKey === normalizeNameKey(lineLeader?.fullName));

      return (
        !assignedToDsm.has(key) &&
        !reportsToLineLeader &&
        (row.managerHrId || row.managerName) &&
        (!row.managerHrId || !dsmHrIds.has(row.managerHrId)) &&
        (!managerNameKey || !dsmNameKeys.has(managerNameKey))
      );
    }),
    (row) =>
      chiefExecutive &&
      (row.managerHrId === chiefExecutive.hrId ||
        normalizeNameKey(row.managerName) === normalizeNameKey(chiefExecutive.fullName))
        ? "CEO Direct Reports"
        : row.managerName ?? `Manager ${row.managerHrId}`,
  ).map(([managerName, members]) => ({
    dsm: null,
    members,
    name: managerName,
    title: "Manager",
  }));
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

  return (
    <Card className="overflow-hidden p-0 shadow-sm">
      <div className="border-b border-border bg-card px-5 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
              <Building2 className="h-4 w-4" />
              Enterprise Hierarchy Map
            </div>
            <h2 className="mt-2 text-lg font-semibold text-text">
              {selectedLine ? `${selectedLine} structure` : "Select a line"}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              Executive leadership, manager lanes, active employees, and open
              vacancies in one operational view.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral">{employees.length} employees</Badge>
            <Badge variant={vacancies.length > 0 ? "warning" : "neutral"}>
              {vacancies.length} vacancies
            </Badge>
            <Badge variant="neutral">{filledLaneCount} lanes</Badge>
          </div>
        </div>
      </div>
      <div
        className="overflow-x-auto bg-bg-soft px-5 py-8"
        style={{
          backgroundImage:
            "linear-gradient(rgba(226, 232, 240, 0.55) 1px, transparent 1px), linear-gradient(90deg, rgba(226, 232, 240, 0.55) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      >
        {!selectedLine ? (
          <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
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
          <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-text-secondary">
            No organogram rows match the current filters.
          </div>
        ) : (
          <div className="min-w-[1120px]">
            <div className="mb-7 grid max-w-3xl gap-3 md:grid-cols-3">
              <StatTile label="Employees" value={employees.length} />
              <StatTile label="Vacancies" value={vacancies.length} />
              <StatTile label="Rows" value={rows.length} />
            </div>

            <div className="relative flex flex-col items-center">
              <HierarchyNode
                icon={<Crown className="h-3.5 w-3.5" />}
                label={chiefExecutive ? chiefExecutive.positionTitle ?? chiefExecutive.jobTitle ?? "CEO" : "CEO"}
                name={chiefExecutive?.fullName ?? "Executive Leadership"}
                tone="dark"
              />
              <div className="h-8 w-px bg-border" />
              <HierarchyNode
                icon={<Network className="h-3.5 w-3.5" />}
                label="Line"
                name={lineName}
                tone="default"
              />
              <div className="h-8 w-px bg-border" />
              <HierarchyNode
                icon={<UsersRound className="h-3.5 w-3.5" />}
                label={lineLeader ? lineLeader.positionTitle ?? lineLeader.jobTitle ?? "Line Leadership" : "Line Leadership"}
                name={lineLeader?.fullName ?? lineName}
                tone="primary"
              />
              <div className="h-8 w-px bg-border" />
              <div className="relative h-px w-[86%] bg-border">
                <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" />
              </div>
            </div>

            {groups.length === 0 ? (
              <div className="mx-auto mt-8 max-w-md rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-text-secondary">
                No manager lanes found for this line.
              </div>
            ) : (
              <div className="relative mt-8">
                <div className="absolute left-0 right-0 top-0 h-px bg-border" />
                <div className="grid auto-cols-[minmax(320px,1fr)] grid-flow-col gap-5 pt-6">
                  {groups.map((group) => {
                    const groupVacancies = group.members.filter(
                      (member) => member.type === "vacancy",
                    ).length;

                    return (
                      <div
                        className="relative rounded-2xl border border-border bg-card p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                        key={group.dsm?.hrId ?? group.name}
                      >
                        <div className="absolute -top-6 left-1/2 h-6 w-px -translate-x-1/2 bg-border" />
                        <div className="absolute left-4 right-4 top-0 h-1 rounded-b-full bg-primary" />
                        <div className="rounded-xl bg-text px-4 py-3 text-bg dark:bg-primary dark:text-white">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 text-left">
                              <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
                                <BriefcaseBusiness className="h-4 w-4" />
                              </div>
                              <p className="truncate text-sm font-semibold">
                                {group.name}
                              </p>
                              <p className="mt-1 text-xs font-medium opacity-70">
                                {group.title}
                              </p>
                            </div>
                            <div className="shrink-0 rounded-lg bg-white/10 px-2.5 py-1 text-center text-[11px] font-semibold">
                              <p className="text-sm leading-none">{group.members.length}</p>
                              <p className="mt-0.5 opacity-70">rows</p>
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-bg-soft px-3 py-2 text-xs text-text-secondary">
                          <span>{group.members.length} team rows</span>
                          {groupVacancies > 0 ? (
                            <span className="font-medium text-primary">
                              {groupVacancies} vacant
                            </span>
                          ) : (
                            <span>No vacancies</span>
                          )}
                        </div>

                        <div className="mt-4 space-y-2.5">
                          {group.members.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-text-secondary">
                              No team rows under this manager.
                            </div>
                          ) : (
                            buildMemberTree(group.members).map((node) => (
                              <TeamMemberNode key={rowKey(node.row)} node={node} />
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
  initialError = null,
  initialReport = null,
}: OrganogramReportProps) {
  const [report, setReport] = React.useState<VacancyReportData | null>(
    initialReport,
  );
  const [error, setError] = React.useState<string | null>(initialError);
  const [isLoading, setIsLoading] = React.useState(false);
  const [lineFilter, setLineFilter] = React.useState("");

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
    const isOfficeSelected = lineFilter.trim().toLowerCase() === "office";
    const selectedLineRows = lineFilter
      ? rows.filter((row) =>
          isOfficeSelected
            ? row.lineName === lineFilter
            : row.lineName === lineFilter && isSalesDepartment(row),
        )
      : rows;

    if (lineFilter) {
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
            .filter((row) => row.lineName === lineFilter && !isChiefExecutive(row))
            .map((row) => row.hrId),
        );

        for (const row of rows) {
          if (row.lineName === lineFilter || isChiefExecutive(row)) {
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
        Boolean(lineFilter) &&
        (isChiefExecutive(row) ||
          managerHrIdsToKeep.has(row.hrId) ||
          officeDescendantHrIdsToKeep.has(row.hrId));
      const matchesSelectedLine =
        !lineFilter ||
        (isOfficeSelected
          ? row.lineName === lineFilter || officeDescendantHrIdsToKeep.has(row.hrId)
          : row.lineName === lineFilter && isSalesDepartment(row));

      if (keepLeadershipChain) {
        return true;
      }

      return matchesSelectedLine;
    });
  }, [lineFilter, rows]);
  const hasActiveFilters = Boolean(lineFilter);
  const canShowChart = Boolean(lineFilter);

  function clearFilters() {
    setLineFilter("");
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-primary">
            Phoenix Workforce
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text">
            Organogram
          </h1>
          <p className="mt-2 max-w-2xl text-base text-text-secondary">
            Sales lines show Sales and Marketing leadership. Office shows the
            full office structure.
          </p>
        </div>
        <Button
          className="gap-2"
          disabled={isLoading}
          onClick={() => void loadReport()}
          variant="secondary"
        >
          {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {error ? (
        <Card className="border-danger/30">
          <div className="flex gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 text-danger" />
            <div>
              <h2 className="text-base font-semibold text-text">
                Organogram unavailable
              </h2>
              <p className="mt-1 text-sm text-text-secondary">{error}</p>
            </div>
          </div>
        </Card>
      ) : null}

      {report ? (
        <>
          <Card>
            <div className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">
                  Filters
                </p>
                <h2 className="mt-2 text-base font-semibold text-text">
                  Hierarchy Scope
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Select a line to reveal the matching hierarchy.
                </p>
              </div>
              <Button
                className="gap-2 whitespace-nowrap"
                disabled={!hasActiveFilters}
                onClick={clearFilters}
                variant="secondary"
              >
                <X className="h-4 w-4" />
                Reset
              </Button>
            </div>

            <div className="mt-5 max-w-sm">
              <SelectFilter
                label="Line"
                onChange={setLineFilter}
                options={filterOptions.lines}
                value={lineFilter}
              />
            </div>
          </Card>

          <OrganogramView
            rows={canShowChart ? filteredRows : []}
            selectedLine={lineFilter || null}
          />
        </>
      ) : isLoading ? (
        <Card>
          <div className="flex items-center gap-3 text-sm text-text-secondary">
            <LoadingSpinner />
            Loading organogram...
          </div>
        </Card>
      ) : null}
    </div>
  );
}
