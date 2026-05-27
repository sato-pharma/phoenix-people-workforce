"use client";

import { useCallback, useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { formatDateOnly } from "@/lib/date-only";
import {
  calculateOrganogramStructureKpis,
  districtBucketMatches,
  isOrganogramSalesStructureRole,
} from "@/lib/reports/organogram-safety";
import { vacancyReportSeatKey } from "@/lib/reports/vacancy-report-safety";
import type { VacancyReportData } from "@/lib/reports/vacancies";
import { formatEmployeeDisplayName } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type OrganogramRow = VacancyReportData["organogramRows"][number];
type MemberNode = {
  children: MemberNode[];
  key: string;
  row: OrganogramRow;
};
type ManagerLane = {
  dsm: OrganogramRow | null;
  members: OrganogramRow[];
  name: string;
  title: string;
};
type TopManagerLane = ManagerLane & {
  childLanes?: ManagerLane[];
  rsm?: OrganogramRow | null;
};

type EmployeeOrganogramDashboardProps = {
  fixedLine?: string | null;
  initialError?: string | null;
  initialReport?: VacancyReportData | null;
};

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const inputClassName =
  "w-full rounded-md border border-gray-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]";

const labelClassName =
  "text-[11px] font-semibold uppercase tracking-wider text-slate-400";

const cardShadow = "shadow-[0_1px_3px_rgba(15,23,42,0.08)]";

/* ------------------------------------------------------------------ */
/*  Business Logic Helpers                                            */
/* ------------------------------------------------------------------ */

function emptyText(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function groupBy<T>(items: T[], keyFor: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
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

function isOrganogramVisibleRow(row: OrganogramRow) {
  return (
    isSalesDepartment(row) ||
    isMarketingDepartment(row) ||
    isOfficeLine(row) ||
    isOrganogramSalesStructureRole(row)
  );
}

function normalizeNameKey(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function normalizeHrIdKey(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? "";
}

function normalizeSearchValue(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function organogramSearchText(row: OrganogramRow) {
  return [
    row.hrId, row.fullName, row.managerHrId, row.managerName,
    row.jobTitle, row.positionTitle, row.departmentName,
    row.lineName, row.areaName, row.regionName, row.teamName,
  ]
    .map((v) => normalizeSearchValue(v))
    .filter(Boolean)
    .join(" ");
}

function rowMatchesOrganogramSearch(row: OrganogramRow, query: string) {
  if (!query) return true;
  const compactQuery = query.replace(/[^a-z0-9]/g, "");
  const compactHrId = normalizeSearchValue(row.hrId).replace(/[^a-z0-9]/g, "");
  const compactManagerHrId = normalizeSearchValue(row.managerHrId).replace(/[^a-z0-9]/g, "");
  return (
    organogramSearchText(row).includes(query) ||
    Boolean(compactQuery && (compactHrId.includes(compactQuery) || compactManagerHrId.includes(compactQuery)))
  );
}

function rowKey(row: OrganogramRow) {
  return `${row.type}-${row.hrId}-${row.sourceRowNumber ?? ""}`;
}

function managerIdentityKey(row: OrganogramRow) {
  if (row.type === "vacancy" && isManagerLevel(row)) {
    const key = vacancyReportSeatKey(row);
    if (key) return `vacancy-seat:${key}`;
  }
  const hrId = normalizeHrIdKey(row.hrId);
  if (hrId) return `hr:${hrId}`;
  return `name:${normalizeNameKey(row.fullName)}`;
}

function isNationalSalesManager(row: OrganogramRow) {
  const t = titleText(row);
  return t.includes("national sales manager") || t === "nsm";
}

function isRegionalSalesManager(row: OrganogramRow) {
  const t = titleText(row);
  return t.includes("regional sales manager") || t === "rsm";
}

function isChiefExecutive(row: OrganogramRow) {
  const t = titleText(row);
  return row.hrId.trim().toUpperCase() === "AA" || t === "ceo" || t.includes("chief executive");
}

function isDistrictSalesManager(row: OrganogramRow) {
  const t = titleText(row);
  return t.includes("district sales manager") || t.includes("district manager") || t === "dsm";
}

function isMedicalRep(row: OrganogramRow) {
  const t = titleText(row);
  return t.includes("medical representative") || t.includes("medical rep") || t === "mr";
}

function isManagerLevel(row: OrganogramRow) {
  return isNationalSalesManager(row) || isRegionalSalesManager(row) || isDistrictSalesManager(row);
}

function isSamePersonOrSlot(row: OrganogramRow, manager: OrganogramRow) {
  const mHrId = normalizeHrIdKey(manager.hrId);
  const rMgrHrId = normalizeHrIdKey(row.managerHrId);
  if (mHrId && rMgrHrId && mHrId === rMgrHrId) return true;
  const mName = normalizeNameKey(manager.fullName);
  const rMgrName = normalizeNameKey(row.managerName);
  return Boolean(mName && rMgrName && mName === rMgrName);
}

function reportsUpTo(row: OrganogramRow, manager: OrganogramRow, rows: OrganogramRow[]) {
  const visited = new Set<string>();
  const mgrHrIdKey = normalizeHrIdKey(manager.hrId);
  let managerHrId = normalizeHrIdKey(row.managerHrId);
  while (managerHrId) {
    if (managerHrId === mgrHrIdKey) return true;
    if (visited.has(managerHrId)) return false;
    visited.add(managerHrId);
    managerHrId = normalizeHrIdKey(
      rows.find((c) => normalizeHrIdKey(c.hrId) === managerHrId)?.managerHrId,
    );
  }
  return false;
}

function reportsToKnownManager(row: OrganogramRow, manager: OrganogramRow, rows: OrganogramRow[]) {
  return isSamePersonOrSlot(row, manager) || reportsUpTo(row, manager, rows);
}

function reportsToVacantManagerSlot(row: OrganogramRow, managerSlot: OrganogramRow) {
  if (managerSlot.type !== "vacancy" || !isDistrictSalesManager(managerSlot) || isManagerLevel(row)) return false;
  return isMedicalRep(row) && districtBucketMatches(row, managerSlot);
}

function isMarketingManager(row: OrganogramRow) {
  return titleText(row).includes("marketing manager");
}

function formatDate(value: string | null | undefined) {
  return formatDateOnly(value, "en", { day: "2-digit", month: "short", year: "numeric" });
}

/* ------------------------------------------------------------------ */
/*  Tree Builder                                                      */
/* ------------------------------------------------------------------ */

function buildMemberTree(members: OrganogramRow[]) {
  const memberIds = new Set(members.map((m) => normalizeHrIdKey(m.hrId)).filter(Boolean));
  const parentByNodeKey = new Map<string, string>();
  const nodesByHrId = new Map<string, MemberNode[]>();
  const nodes = members.map((m, i) => ({
    children: [],
    key: `${rowKey(m)}-${i}`,
    row: m,
  }) satisfies MemberNode);

  for (const node of nodes) {
    const hrId = normalizeHrIdKey(node.row.hrId);
    nodesByHrId.set(hrId, [...(nodesByHrId.get(hrId) ?? []), node]);
  }

  const roots: MemberNode[] = [];
  for (const node of nodes) {
    const memberHrId = normalizeHrIdKey(node.row.hrId);
    const managerHrId = normalizeHrIdKey(node.row.managerHrId);
    if (managerHrId && memberHrId !== managerHrId && memberIds.has(managerHrId)) {
      const managerNode = nodesByHrId.get(managerHrId)?.[0];
      let cursor = managerNode?.key;
      let createsCycle = false;
      while (cursor) {
        if (cursor === node.key) { createsCycle = true; break; }
        cursor = parentByNodeKey.get(cursor);
      }
      if (managerNode && !createsCycle) {
        managerNode.children.push(node);
        parentByNodeKey.set(node.key, managerNode.key);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (n: MemberNode[]) => {
    n.sort((a, b) => a.row.fullName.localeCompare(b.row.fullName));
    for (const nd of n) sortNodes(nd.children);
  };
  sortNodes(roots);
  return roots;
}

/* ------------------------------------------------------------------ */
/*  Lane Builder                                                      */
/* ------------------------------------------------------------------ */

function buildOrganogramLanes(rows: OrganogramRow[]) {
  const chiefExecutive = rows.find((r) => isChiefExecutive(r)) ?? null;
  const lineLeader = rows.find((r) => isNationalSalesManager(r)) ?? null;

  const rsmRows = rows
    .filter((r) => isRegionalSalesManager(r))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const dsmRows = rows
    .filter((r) => isDistrictSalesManager(r))
    .sort((a, b) =>
      a.type === b.type ? a.fullName.localeCompare(b.fullName) : a.type === "employee" ? -1 : 1,
    );

  const dsmHrIds = new Set(dsmRows.map((r) => normalizeHrIdKey(r.hrId)));
  const dsmNameKeys = new Set(dsmRows.map((r) => normalizeNameKey(r.fullName)));

  const teamRows = rows.filter(
    (r) => !isChiefExecutive(r) && !isNationalSalesManager(r) && !isRegionalSalesManager(r) && !isDistrictSalesManager(r),
  );

  const assignedToDsm = new Set<string>();

  const dsmGroups: ManagerLane[] = groupBy(dsmRows, managerIdentityKey).map(([, dsms]) => {
    const primaryDsm = [...dsms].sort((a, b) =>
      a.type === b.type ? a.fullName.localeCompare(b.fullName) : a.type === "employee" ? -1 : 1,
    )[0];
    const members = teamRows
      .filter((r) => {
        const key = rowKey(r);
        if (assignedToDsm.has(key)) return false;
        return dsms.some(
          (dsm) => reportsToKnownManager(r, dsm, rows) || reportsToVacantManagerSlot(r, dsm),
        );
      })
      .sort((a, b) =>
        a.type === b.type ? a.fullName.localeCompare(b.fullName) : a.type === "vacancy" ? 1 : -1,
      );
    for (const m of members) assignedToDsm.add(rowKey(m));
    return {
      dsm: primaryDsm,
      members,
      name: primaryDsm.fullName,
      title: primaryDsm.positionTitle ?? primaryDsm.jobTitle ?? "District Sales Manager",
    };
  });

  const dsmLaneKey = (lane: ManagerLane) =>
    lane.dsm ? managerIdentityKey(lane.dsm) : `${lane.name}:${lane.title}`;

  const childDsmLaneKeys = new Set<string>();

  const rsmGroups: TopManagerLane[] = rsmRows.map((rsm) => {
    const childLanes = dsmGroups.filter((lane) => {
      if (!lane.dsm) return false;
      return reportsToKnownManager(lane.dsm, rsm, rows);
    });
    childLanes.forEach((lane) => childDsmLaneKeys.add(dsmLaneKey(lane)));
    return {
      childLanes,
      dsm: null,
      members: [],
      name: rsm.fullName,
      rsm,
      title: rsm.positionTitle ?? rsm.jobTitle ?? "Regional Sales Manager",
    };
  });

  const directDsmGroups = dsmGroups.filter((lane) => !childDsmLaneKeys.has(dsmLaneKey(lane)));

  const marketingManagers = teamRows
    .filter((r) => isMarketingManager(r))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  const marketingGroups = groupBy(marketingManagers, managerIdentityKey).map(([, managers]) => {
    const primaryManager = [...managers].sort((a, b) => a.fullName.localeCompare(b.fullName))[0];
    const managerHrIds = new Set(managers.map((m) => normalizeHrIdKey(m.hrId)));
    const members = teamRows
      .filter(
        (r) =>
          !managerHrIds.has(normalizeHrIdKey(r.hrId)) &&
          managers.some((m) => reportsUpTo(r, m, rows)),
      )
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    for (const m of managers) assignedToDsm.add(rowKey(m));
    for (const m of members) assignedToDsm.add(rowKey(m));
    return {
      dsm: null,
      members,
      name: primaryManager.fullName,
      title: primaryManager.positionTitle ?? primaryManager.jobTitle ?? "Marketing Manager",
    };
  });

  const fallbackManagerGroups = groupBy(
    teamRows.filter((r) => {
      const key = rowKey(r);
      const mgrName = normalizeNameKey(r.managerName);
      const mgrHrId = normalizeHrIdKey(r.managerHrId);
      const reportsToLL =
        Boolean(lineLeader) &&
        (mgrHrId === normalizeHrIdKey(lineLeader?.hrId) ||
          mgrName === normalizeNameKey(lineLeader?.fullName));
      return (
        !assignedToDsm.has(key) &&
        !reportsToLL &&
        (mgrHrId || r.managerName) &&
        (!mgrHrId || !dsmHrIds.has(mgrHrId)) &&
        (!mgrName || !dsmNameKeys.has(mgrName))
      );
    }),
    (r) => {
      const mgrHrId = normalizeHrIdKey(r.managerHrId);
      const mgrName = normalizeNameKey(r.managerName);
      if (
        chiefExecutive &&
        (mgrHrId === normalizeHrIdKey(chiefExecutive.hrId) ||
          mgrName === normalizeNameKey(chiefExecutive.fullName))
      )
        return "ceo-direct-reports";
      if (mgrHrId) return `hr:${mgrHrId}`;
      return `name:${mgrName}`;
    },
  ).map(([managerKey, members]) => {
    const first = members[0];
    return {
      dsm: null,
      members,
      name:
        managerKey === "ceo-direct-reports"
          ? "CEO Direct Reports"
          : first?.managerName ?? `Manager ${first?.managerHrId ?? "Unknown"}`,
      title: "Manager",
    };
  });

  const unassignedMembers = teamRows.filter((r) => {
    const key = rowKey(r);
    return !assignedToDsm.has(key) && !r.managerHrId && !r.managerName;
  });

  const allGroups: TopManagerLane[] = [
    ...directDsmGroups,
    ...rsmGroups,
    ...marketingGroups,
    ...fallbackManagerGroups,
    ...(unassignedMembers.length > 0
      ? [{ dsm: null, members: unassignedMembers, name: "Unassigned", title: "Manager" }]
      : []),
  ];

  const groups = allGroups.filter(
    (g) => g.members.length > 0 || g.dsm || g.rsm || (g.childLanes?.length ?? 0) > 0,
  );

  const laneCount = Math.max(
    groups.reduce((c, g) => c + Math.max(g.childLanes?.length ?? 1, 1), 0),
    1,
  );

  return { chiefExecutive, groups, lineLeader, laneCount };
}

/* ------------------------------------------------------------------ */
/*  Filter Logic                                                      */
/* ------------------------------------------------------------------ */

function filterOrganogramRows(
  rows: OrganogramRow[],
  effectiveLineFilter: string,
  search: string,
) {
  const managerHrIdsToKeep = new Set<string>();
  const officeDescendantHrIdsToKeep = new Set<string>();
  const isOfficeSelected = effectiveLineFilter.trim().toLowerCase() === "office";

  const selectedLineRows = effectiveLineFilter
    ? rows.filter((r) =>
        isOfficeSelected
          ? r.lineName === effectiveLineFilter
          : r.lineName === effectiveLineFilter &&
            (isSalesDepartment(r) || isOrganogramSalesStructureRole(r)),
      )
    : rows;

  if (effectiveLineFilter) {
    let frontier = selectedLineRows
      .map((r) => r.managerHrId)
      .filter((v): v is string => Boolean(v));

    while (frontier.length > 0) {
      const next: string[] = [];
      for (const mHrId of frontier) {
        if (managerHrIdsToKeep.has(mHrId)) continue;
        managerHrIdsToKeep.add(mHrId);
        const mRow = rows.find((r) => r.hrId === mHrId);
        if (mRow?.managerHrId) next.push(mRow.managerHrId);
      }
      frontier = next;
    }

    if (isOfficeSelected) {
      const officeManagerHrIds = new Set(
        rows
          .filter((r) => r.lineName === effectiveLineFilter && !isChiefExecutive(r))
          .map((r) => r.hrId),
      );
      for (const r of rows) {
        if (r.lineName === effectiveLineFilter || isChiefExecutive(r)) continue;
        let mHrId: string | null | undefined = r.managerHrId;
        const visited = new Set<string>();
        while (mHrId) {
          if (officeManagerHrIds.has(mHrId)) {
            officeDescendantHrIdsToKeep.add(r.hrId);
            break;
          }
          if (visited.has(mHrId)) break;
          visited.add(mHrId);
          mHrId = rows.find((c) => c.hrId === mHrId)?.managerHrId ?? null;
        }
      }
    }
  }

  const lineScopedRows = rows.filter((r) => {
    const keepChain =
      Boolean(effectiveLineFilter) &&
      (isChiefExecutive(r) ||
        managerHrIdsToKeep.has(r.hrId) ||
        officeDescendantHrIdsToKeep.has(r.hrId));
    const matchesLine =
      !effectiveLineFilter ||
      (isOfficeSelected
        ? r.lineName === effectiveLineFilter || officeDescendantHrIdsToKeep.has(r.hrId)
        : r.lineName === effectiveLineFilter &&
          (isSalesDepartment(r) || isOrganogramSalesStructureRole(r)));
    return keepChain || matchesLine;
  });

  if (!search) return lineScopedRows;

  const scopedKeys = new Set(lineScopedRows.map(rowKey));
  const matched = lineScopedRows.filter((r) => rowMatchesOrganogramSearch(r, search));
  const keepHrIds = new Set<string>();
  const keepKeys = new Set<string>();

  for (const m of matched) {
    keepKeys.add(rowKey(m));
    keepHrIds.add(normalizeHrIdKey(m.hrId));
    let mHrId = normalizeHrIdKey(m.managerHrId);
    const visited = new Set<string>();
    while (mHrId && !visited.has(mHrId)) {
      visited.add(mHrId);
      keepHrIds.add(mHrId);
      const parent = rows.find((r) => normalizeHrIdKey(r.hrId) === mHrId);
      mHrId = normalizeHrIdKey(parent?.managerHrId);
    }
  }

  for (const r of lineScopedRows) {
    let mHrId = normalizeHrIdKey(r.managerHrId);
    const visited = new Set<string>();
    while (mHrId && !visited.has(mHrId)) {
      if (keepHrIds.has(mHrId)) { keepKeys.add(rowKey(r)); break; }
      visited.add(mHrId);
      mHrId = normalizeHrIdKey(rows.find((c) => normalizeHrIdKey(c.hrId) === mHrId)?.managerHrId);
    }
  }

  return rows.filter(
    (r) => scopedKeys.has(rowKey(r)) && (keepKeys.has(rowKey(r)) || keepHrIds.has(normalizeHrIdKey(r.hrId))),
  );
}

/* ------------------------------------------------------------------ */
/*  UI Sub-Components                                                 */
/* ------------------------------------------------------------------ */

function TeamMemberCardUI({ row }: { row: OrganogramRow }) {
  const isVacancy = row.type === "vacancy";
  const showRepFields = isVacancy || isMedicalRep(row);

  return (
    <div
      className={`border-l-[3px] px-2.5 py-2 ${
        isVacancy
          ? "border-l-orange-400 bg-orange-50/50"
          : "border-l-slate-200 bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold leading-tight text-slate-800">
            {formatEmployeeDisplayName(row.fullName)}
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-slate-400">{row.hrId}</p>
        </div>
        {isVacancy && (
          <span className="shrink-0 rounded-md bg-orange-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-orange-700">
            Vacant
          </span>
        )}
      </div>
      {showRepFields && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
          <span>Hired {formatDate(row.hireDate)}</span>
          <span>{emptyText(row.areaName)}</span>
        </div>
      )}
    </div>
  );
}

function TeamMemberNodeUI({ node }: { node: MemberNode }) {
  return (
    <div>
      <TeamMemberCardUI row={node.row} />
      {node.children.length > 0 && (
        <div className="ml-3 space-y-px border-l border-orange-200 pl-1.5">
          {node.children.map((child) => (
            <TeamMemberNodeUI key={child.key} node={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function ManagerLaneUI({
  group,
  groupKey,
}: {
  group: ManagerLane;
  groupKey: string;
}) {
  const isVacantSeat = group.dsm?.type === "vacancy";
  const groupVacancies =
    group.members.filter((m) => m.type === "vacancy").length + (isVacantSeat ? 1 : 0);
  const scope = isVacantSeat
    ? [group.dsm?.lineName, group.dsm?.areaName ?? group.dsm?.regionName].filter(Boolean).join(" / ")
    : null;

  return (
    <div
      className={`overflow-hidden rounded-lg border border-gray-100 ${cardShadow}`}
      key={groupKey}
    >
      {/* Manager header */}
      <div className="border-b border-gray-100 bg-slate-800 px-3 py-2.5 text-white">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">
          {group.title}
        </p>
        <p className="mt-0.5 text-xs font-bold leading-snug">
          {formatEmployeeDisplayName(group.name)}
        </p>
        {scope && (
          <p className="mt-0.5 text-[10px] font-medium text-orange-300">{scope}</p>
        )}
      </div>

      {/* Team summary */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-slate-50 px-3 py-1.5 text-[10px]">
        <span className="text-slate-500">{group.members.length} team members</span>
        {groupVacancies > 0 ? (
          <span className="font-semibold text-orange-600">{groupVacancies} vacant</span>
        ) : (
          <span className="text-slate-400">Fully staffed</span>
        )}
      </div>

      {/* Team members */}
      <div className="divide-y divide-gray-50 bg-white">
        {group.members.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-slate-400">
            No team members assigned.
          </div>
        ) : (
          buildMemberTree(group.members).map((node) => (
            <TeamMemberNodeUI key={node.key} node={node} />
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export function EmployeeOrganogramDashboard({
  fixedLine = null,
  initialError = null,
  initialReport = null,
}: EmployeeOrganogramDashboardProps) {
  const [report, setReport] = useState<VacancyReportData | null>(initialReport);
  const [error, setError] = useState<string | null>(initialError);
  const [isLoading, setIsLoading] = useState(false);
  const [organogramSearch, setOrganogramSearch] = useState("");
  const effectiveLineFilter = fixedLine ?? "";
  const normalizedSearch = normalizeSearchValue(organogramSearch);

  const loadReport = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/reports/vacancies", { cache: "no-store" });
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

  const rows = useMemo(
    () => (report?.organogramRows ?? []).filter((r) => isOrganogramVisibleRow(r)),
    [report],
  );

  const filteredRows = useMemo(
    () => filterOrganogramRows(rows, effectiveLineFilter, normalizedSearch),
    [effectiveLineFilter, normalizedSearch, rows],
  );

  const employees = useMemo(
    () => filteredRows.filter((r) => r.type === "employee"),
    [filteredRows],
  );

  const structureKpis = useMemo(
    () => calculateOrganogramStructureKpis(filteredRows),
    [filteredRows],
  );

  // Build a list of vacant area names for each structure role
  // so we can display "Vacant: <area>, <area>" under each KPI card.
  const vacantAreas = useMemo(() => {
    const acc: { medicalRep: string[]; dsm: string[]; rsm: string[]; nsm: string[] } = {
      dsm: [],
      medicalRep: [],
      nsm: [],
      rsm: [],
    };
    for (const row of filteredRows) {
      if (row.type !== "vacancy") continue;
      const t = titleText(row);
      const area = row.areaName?.trim() || row.regionName?.trim() || row.teamName?.trim() || "—";
      if (t.includes("medical representative") || t.includes("medical rep")) {
        acc.medicalRep.push(area);
      } else if (
        t.includes("district sales manager") ||
        t.includes("district manager") ||
        t === "dsm"
      ) {
        acc.dsm.push(area);
      } else if (t.includes("regional sales manager") || t === "rsm") {
        acc.rsm.push(area);
      } else if (t.includes("national sales manager") || t === "nsm") {
        acc.nsm.push(area);
      }
    }
    return acc;
  }, [filteredRows]);

  const lanes = useMemo(
    () => (effectiveLineFilter || normalizedSearch ? buildOrganogramLanes(filteredRows) : null),
    [effectiveLineFilter, filteredRows, normalizedSearch],
  );

  const completionPercent =
    structureKpis.total.total > 0
      ? Math.round((structureKpis.total.actual / structureKpis.total.total) * 100)
      : 0;

  /* KPI card data */
  const kpiCards = [
    {
      accent: "border-l-emerald-400",
      actual: structureKpis.medicalRep.actual,
      label: "Medical Reps",
      total: structureKpis.medicalRep.total,
      vacant: structureKpis.medicalRep.vacant,
    },
    {
      accent: "border-l-sky-400",
      actual: structureKpis.dsm.actual,
      label: "District Managers",
      total: structureKpis.dsm.total,
      vacant: structureKpis.dsm.vacant,
    },
    {
      accent: "border-l-amber-400",
      actual: structureKpis.rsm.actual,
      label: "Regional Managers",
      total: structureKpis.rsm.total,
      vacant: structureKpis.rsm.vacant,
    },
    {
      accent: "border-l-orange-400",
      actual: structureKpis.nsm.actual,
      label: "National Managers",
      total: structureKpis.nsm.total,
      vacant: structureKpis.nsm.vacant,
    },
    {
      accent: "border-l-slate-400",
      actual: structureKpis.total.actual,
      label: "Total Structure",
      total: structureKpis.total.total,
      vacant: structureKpis.total.vacant,
    },
  ];

  const lineName = effectiveLineFilter || "Select Line";

  return (
    <div className="space-y-5" dir="auto">
      {/* ---- Stat Cards ---- */}
      <Card className={`overflow-hidden rounded-lg border border-gray-100 p-0 ${cardShadow}`}>
        <div className="grid grid-cols-2 divide-x divide-y divide-gray-100 sm:grid-cols-3 xl:grid-cols-5">
          {kpiCards.map((kpi) => {
            const pct = kpi.total > 0 ? Math.round((kpi.actual / kpi.total) * 100) : 0;
            return (
              <div className={`border-l-2 ${kpi.accent} px-4 py-4`} key={kpi.label}>
                <p className={labelClassName}>{kpi.label}</p>
                <div className="mt-1 flex items-end gap-1.5">
                  <span className="text-2xl font-bold text-slate-800">{kpi.actual}</span>
                  <span className="pb-0.5 text-sm text-slate-400">/ {kpi.total}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div
                    aria-label={`${kpi.label} completion ${pct}%`}
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={pct}
                    className="h-1 flex-1 overflow-hidden rounded bg-slate-100"
                    role="progressbar"
                  >
                    <div
                      className="h-full rounded bg-orange-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-semibold text-slate-400">{pct}%</span>
                </div>
                {kpi.vacant > 0 && (
                  <p className="mt-1 text-[10px] font-semibold text-orange-600">
                    {kpi.vacant} vacant
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* ---- Vacant Positions Block ---- */}
      {structureKpis.total.vacant > 0 && (
        <Card
          className={`overflow-hidden rounded-lg border border-gray-100 p-4 sm:p-5 ${cardShadow}`}
        >
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">
                Vacant Positions
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Open positions by role and area
              </p>
            </div>
            <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
              {structureKpis.total.vacant} total
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                accent: "border-l-sky-400",
                areas: vacantAreas.dsm,
                count: vacantAreas.dsm.length,
                label: "DSM vacant",
              },
              {
                accent: "border-l-amber-400",
                areas: vacantAreas.rsm,
                count: vacantAreas.rsm.length,
                label: "RSM vacant",
              },
              {
                accent: "border-l-orange-400",
                areas: vacantAreas.nsm,
                count: vacantAreas.nsm.length,
                label: "NSM vacant",
              },
              {
                accent: "border-l-emerald-400",
                areas: vacantAreas.medicalRep,
                count: vacantAreas.medicalRep.length,
                label: "Medical Representative vacants",
              },
            ]
              .filter((block) => block.count > 0)
              .map((block) => (
                <div
                  className={`rounded-md border border-gray-100 border-l-2 bg-slate-50/60 px-3 py-2.5 ${block.accent}`}
                  key={block.label}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      {block.label}
                    </p>
                    <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-orange-600">
                      {block.count}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {block.areas.map((area, idx) => (
                      <li
                        className="flex items-start gap-1.5 text-[11px] text-slate-700"
                        key={`${block.label}-${idx}-${area}`}
                      >
                        <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-sm bg-orange-400" />
                        <span className="leading-snug">{area}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </Card>
      )}

      {/* ---- Structure Completion Bar ---- */}
      <WorkspaceErrorBoundary fallbackTitle="Structure overview unavailable">
        <Card className={`rounded-lg border border-gray-100 p-4 sm:p-5 ${cardShadow}`}>
          <div className="mb-3">
            <h3 className="text-sm font-bold text-slate-800">Structure Completion</h3>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {employees.length} employees across {effectiveLineFilter || "all lines"}
            </p>
          </div>
          {structureKpis.total.total > 0 ? (
            <>
              <div
                aria-label="Structure completion chart"
                className="flex h-4 w-full overflow-hidden rounded-md"
                role="img"
              >
                <div
                  aria-label={`Filled positions: ${completionPercent}%`}
                  className="bg-emerald-500"
                  role="img"
                  style={{
                    width: `${completionPercent}%`,
                    minWidth: structureKpis.total.actual > 0 ? "2px" : "0",
                  }}
                />
                <div
                  aria-label={`Vacant positions: ${100 - completionPercent}%`}
                  className="bg-orange-400"
                  role="img"
                  style={{
                    width: `${100 - completionPercent}%`,
                    minWidth: structureKpis.total.vacant > 0 ? "2px" : "0",
                  }}
                />
              </div>
              <div className="mt-2.5 flex flex-wrap gap-4 text-[11px] text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
                  Filled {completionPercent}%
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm bg-orange-400" />
                  Vacant {100 - completionPercent}%
                </span>
              </div>
            </>
          ) : (
            <div className="flex h-4 w-full items-center justify-center rounded-md bg-slate-100">
              <span className="text-[10px] text-slate-400">No data</span>
            </div>
          )}
        </Card>
      </WorkspaceErrorBoundary>

      {/* ---- Error Message ---- */}
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm">
          <p className="font-semibold text-rose-800">Organogram unavailable</p>
          <p className="mt-0.5 text-rose-700">{error}</p>
        </div>
      )}

      {/* ---- Loading ---- */}
      {isLoading && !report && (
        <Card className={`rounded-lg border border-gray-100 p-6 ${cardShadow}`}>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
            Loading organogram...
          </div>
        </Card>
      )}

      {/* ---- Search & Info ---- */}
      {report && (
        <Card className={`rounded-lg border border-gray-100 p-4 sm:p-5 ${cardShadow}`}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-md bg-orange-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-orange-600">
              Filters
            </span>
            <span className="text-[11px] text-slate-400">
              {filteredRows.length} of {rows.length} positions shown
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className={`mb-1.5 block ${labelClassName}`}>Search</span>
              <input
                className={inputClassName}
                onChange={(e) => setOrganogramSearch(e.target.value)}
                placeholder="Search name, HR ID, manager..."
                type="text"
                value={organogramSearch}
              />
            </label>
            <div className="flex items-end gap-2">
              {organogramSearch && (
                <button
                  aria-label="Clear search"
                  className="rounded-md border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
                  onClick={() => setOrganogramSearch("")}
                  type="button"
                >
                  Reset
                </button>
              )}
              <button
                aria-label="Refresh organogram data"
                className="rounded-md bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:opacity-50"
                disabled={isLoading}
                onClick={() => void loadReport()}
                type="button"
              >
                {isLoading ? "Loading..." : "Refresh"}
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* ---- Organogram Tree ---- */}
      {report && lanes && (
        <WorkspaceErrorBoundary fallbackTitle="Organogram tree unavailable">
          <Card className={`overflow-hidden rounded-lg border border-gray-100 p-0 ${cardShadow}`}>
            {/* Section header */}
            <div className="border-b border-gray-100 px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-slate-800">
                    {lineName} Structure
                  </h3>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    Leadership, manager lanes, employees, and vacancies
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600">
                    {employees.length} employees
                  </span>
                  {structureKpis.total.vacant > 0 && (
                    <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-semibold text-orange-600">
                      {structureKpis.total.vacant} vacancies
                    </span>
                  )}
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600">
                    {lanes.groups.length} lanes
                  </span>
                </div>
              </div>
            </div>

            {/* Hierarchy & Lanes */}
            <div className="bg-slate-50/70 px-3 py-5 sm:px-5">
              {/* Executive Hierarchy — NSM only */}
              <div className="relative mb-6 flex flex-col items-center">
                {/* NSM / Line Leader */}
                <div className="w-full max-w-[240px] rounded-lg border border-orange-200 bg-orange-50 px-3 py-2.5 text-center">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-600">
                    {lanes.lineLeader
                      ? lanes.lineLeader.positionTitle ?? lanes.lineLeader.jobTitle ?? "Line Leader"
                      : "Line Leadership"}
                  </p>
                  <p className="mt-0.5 text-xs font-bold text-slate-800">
                    {lanes.lineLeader
                      ? formatEmployeeDisplayName(lanes.lineLeader.fullName)
                      : lineName}
                  </p>
                </div>
                <div className="h-5 w-px bg-slate-300" />

                {/* Horizontal connector */}
                <div className="relative hidden h-px w-[85%] bg-slate-300 sm:block">
                  <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-orange-500" />
                </div>
              </div>

              {/* Manager Lanes */}
              {lanes.groups.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">
                  No manager lanes found for this structure.
                </div>
              ) : (
                <div className="relative overflow-x-auto pb-2">
                  {/* Desktop Grid */}
                  <div className="hidden sm:block">
                    <div
                      className="grid min-w-max gap-3"
                      style={{
                        gridTemplateColumns: `repeat(${lanes.laneCount}, minmax(220px, 1fr))`,
                      }}
                    >
                      {lanes.groups.map((group, gi) => {
                        const childCount = Math.max(group.childLanes?.length ?? 1, 1);
                        const gKey = group.dsm
                          ? `mgr-${rowKey(group.dsm)}-${gi}`
                          : group.rsm
                            ? `rsm-${rowKey(group.rsm)}-${gi}`
                            : `mgr-${group.name}-${gi}`;

                        if (group.rsm) {
                          const groupVacancies =
                            (group.childLanes ?? []).reduce(
                              (t, l) =>
                                t +
                                l.members.filter((m) => m.type === "vacancy").length +
                                (l.dsm?.type === "vacancy" ? 1 : 0),
                              0,
                            );

                          return (
                            <div
                              className="min-w-[220px]"
                              key={gKey}
                              style={{ gridColumn: `span ${childCount}` }}
                            >
                              <div className={`overflow-hidden rounded-lg border border-orange-200 ${cardShadow}`}>
                                {/* RSM header */}
                                <div className="border-b border-orange-200 bg-orange-50 px-3 py-2.5 text-center">
                                  <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-700">
                                    {group.title}
                                  </p>
                                  <p className="mt-0.5 text-xs font-bold text-slate-800">
                                    {formatEmployeeDisplayName(group.name)}
                                  </p>
                                  <p className="mt-0.5 text-[10px] text-slate-500">
                                    Reports to NSM:{" "}
                                    {lanes.lineLeader
                                      ? formatEmployeeDisplayName(lanes.lineLeader.fullName)
                                      : lineName}
                                  </p>
                                  <p className="mt-1 text-[10px] font-semibold text-orange-600">
                                    {group.childLanes?.length ?? 0} DSM lanes &middot; {groupVacancies} vacant
                                  </p>
                                </div>
                                {/* Child DSM lanes */}
                                <div
                                  className="grid gap-2 bg-white p-2"
                                  style={{
                                    gridTemplateColumns: `repeat(${childCount}, minmax(220px, 1fr))`,
                                  }}
                                >
                                  {(group.childLanes ?? []).length > 0 ? (
                                    group.childLanes?.map((lane, li) => (
                                      <ManagerLaneUI
                                        group={lane}
                                        groupKey={`${gKey}-child-${li}`}
                                        key={`${gKey}-child-${li}`}
                                      />
                                    ))
                                  ) : (
                                    <div className="p-4 text-center text-[11px] text-slate-400">
                                      No DSM lanes under this regional manager.
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <ManagerLaneUI
                            group={group}
                            groupKey={gKey}
                            key={gKey}
                          />
                        );
                      })}
                    </div>
                  </div>

                  {/* Mobile Card View */}
                  <div className="space-y-3 sm:hidden">
                    {lanes.groups.map((group, gi) => {
                      const gKey = group.dsm
                        ? `m-mgr-${rowKey(group.dsm)}-${gi}`
                        : group.rsm
                          ? `m-rsm-${rowKey(group.rsm)}-${gi}`
                          : `m-mgr-${group.name}-${gi}`;

                      if (group.rsm) {
                        const groupVacancies =
                          (group.childLanes ?? []).reduce(
                            (t, l) =>
                              t +
                              l.members.filter((m) => m.type === "vacancy").length +
                              (l.dsm?.type === "vacancy" ? 1 : 0),
                            0,
                          );

                        return (
                          <div
                            className={`overflow-hidden rounded-lg border border-orange-200 ${cardShadow}`}
                            key={gKey}
                          >
                            <div className="border-b border-orange-200 bg-orange-50 px-3 py-2.5">
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-700">
                                {group.title}
                              </p>
                              <p className="mt-0.5 text-xs font-bold text-slate-800">
                                {formatEmployeeDisplayName(group.name)}
                              </p>
                              <div className="mt-1 flex gap-2 text-[10px]">
                                <span className="text-slate-500">
                                  {group.childLanes?.length ?? 0} DSM lanes
                                </span>
                                {groupVacancies > 0 && (
                                  <span className="font-semibold text-orange-600">
                                    {groupVacancies} vacant
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="space-y-2 bg-white p-2">
                              {(group.childLanes ?? []).map((lane, li) => (
                                <ManagerLaneUI
                                  group={lane}
                                  groupKey={`${gKey}-m-child-${li}`}
                                  key={`${gKey}-m-child-${li}`}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      }

                      return (
                        <ManagerLaneUI
                          group={group}
                          groupKey={gKey}
                          key={gKey}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </WorkspaceErrorBoundary>
      )}

      {/* No line selected message */}
      {report && !effectiveLineFilter && !normalizedSearch && (
        <Card className={`rounded-lg border border-gray-100 p-8 text-center ${cardShadow}`}>
          <h3 className="text-sm font-semibold text-slate-700">
            Select a line to view the organogram
          </h3>
          <p className="mx-auto mt-2 max-w-md text-[11px] text-slate-400">
            The hierarchy stays hidden until a line is selected, so the chart
            only shows the exact structure you are reviewing.
          </p>
        </Card>
      )}
    </div>
  );
}
