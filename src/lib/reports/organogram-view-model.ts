import {
  districtBucketMatches,
  isOrganogramSalesStructureRole,
  organogramPositionSlotKey,
} from "@/lib/reports/organogram-safety";
import type { VacancyReportData } from "@/lib/reports/vacancies";

export type OrganogramRow = VacancyReportData["organogramRows"][number];

export type MemberNode = {
  children: MemberNode[];
  key: string;
  row: OrganogramRow;
};

export type ManagerLane = {
  dsm: OrganogramRow | null;
  members: OrganogramRow[];
  name: string;
  title: string;
};

export type TopManagerLane = ManagerLane & {
  childLanes?: ManagerLane[];
  rsm?: OrganogramRow | null;
};

export function emptyText(value: string | number | null | undefined) {
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

export function titleText(row: OrganogramRow) {
  return `${row.positionTitle ?? row.jobTitle ?? ""}`.toLowerCase();
}

export function isOfficeLine(row: OrganogramRow) {
  const line = row.lineName?.trim().toLowerCase();
  return line === "office" || line === "head office";
}

export function isSalesDepartment(row: OrganogramRow) {
  return row.departmentName?.trim().toLowerCase() === "sales";
}

export function isMarketingDepartment(row: OrganogramRow) {
  return row.departmentName?.trim().toLowerCase() === "marketing";
}

export function isOrganogramVisibleRow(row: OrganogramRow) {
  return (
    isSalesDepartment(row) ||
    isMarketingDepartment(row) ||
    isOfficeLine(row) ||
    isOrganogramSalesStructureRole(row)
  );
}

export function normalizeNameKey(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

export function normalizeHrIdKey(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? "";
}

export function normalizeSearchValue(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

export function organogramSearchText(row: OrganogramRow) {
  return [
    row.hrId,
    row.fullName,
    row.managerHrId,
    row.managerName,
    row.jobTitle,
    row.positionTitle,
    row.departmentName,
    row.lineName,
    row.areaName,
    row.regionName,
    row.teamName,
  ]
    .map((value) => normalizeSearchValue(value))
    .filter(Boolean)
    .join(" ");
}

export function rowMatchesOrganogramSearch(row: OrganogramRow, query: string) {
  if (!query) return true;
  const compactQuery = query.replace(/[^a-z0-9]/g, "");
  const compactHrId = normalizeSearchValue(row.hrId).replace(/[^a-z0-9]/g, "");
  const compactManagerHrId = normalizeSearchValue(row.managerHrId).replace(/[^a-z0-9]/g, "");

  return (
    organogramSearchText(row).includes(query) ||
    Boolean(compactQuery && (compactHrId.includes(compactQuery) || compactManagerHrId.includes(compactQuery)))
  );
}

export function rowKey(row: OrganogramRow) {
  return `${row.type}-${row.hrId}-${row.sourceRowNumber ?? ""}`;
}

export function isNationalSalesManager(row: OrganogramRow) {
  const title = titleText(row);

  return title.includes("national sales manager") || title === "nsm";
}

export function isRegionalSalesManager(row: OrganogramRow) {
  const title = titleText(row);

  return title.includes("regional sales manager") || title === "rsm";
}

export function isChiefExecutive(row: OrganogramRow) {
  const title = titleText(row);

  return (
    row.hrId.trim().toUpperCase() === "AA" ||
    title === "ceo" ||
    title.includes("chief executive")
  );
}

export function isDistrictSalesManager(row: OrganogramRow) {
  const title = titleText(row);

  return (
    title.includes("district sales manager") ||
    title.includes("district manager") ||
    title === "dsm"
  );
}

export function isMedicalRep(row: OrganogramRow) {
  const title = titleText(row);

  return (
    title.includes("medical representative") ||
    title.includes("medical rep") ||
    title === "mr"
  );
}

export function isManagerLevel(row: OrganogramRow) {
  return (
    isNationalSalesManager(row) ||
    isRegionalSalesManager(row) ||
    isDistrictSalesManager(row)
  );
}

function managerIdentityKey(row: OrganogramRow) {
  if (row.type === "vacancy" && isManagerLevel(row)) {
    const slotKey = organogramPositionSlotKey(row);
    if (slotKey) return `vacancy-slot:${slotKey}`;
  }

  const hrId = normalizeHrIdKey(row.hrId);
  if (hrId) return `hr:${hrId}`;

  return `name:${normalizeNameKey(row.fullName)}`;
}

function isSamePersonOrSlot(row: OrganogramRow, manager: OrganogramRow) {
  const managerHrId = normalizeHrIdKey(manager.hrId);
  const rowManagerHrId = normalizeHrIdKey(row.managerHrId);

  if (managerHrId && rowManagerHrId && managerHrId === rowManagerHrId) {
    return true;
  }

  const managerNameKey = normalizeNameKey(manager.fullName);
  const rowManagerNameKey = normalizeNameKey(row.managerName);

  return Boolean(managerNameKey && rowManagerNameKey && managerNameKey === rowManagerNameKey);
}

function reportsToVacantReplacementOwner(row: OrganogramRow, managerSlot: OrganogramRow) {
  if (managerSlot.type !== "vacancy") {
    return false;
  }

  const managerReplacementHrId = normalizeHrIdKey(managerSlot.replacementForHrId);
  const rowManagerReplacementHrId = normalizeHrIdKey(row.managerReplacementForHrId);

  return Boolean(
    managerReplacementHrId &&
      rowManagerReplacementHrId &&
      managerReplacementHrId === rowManagerReplacementHrId,
  );
}

export function reportsUpTo(
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

function reportsToKnownManager(row: OrganogramRow, manager: OrganogramRow, rows: OrganogramRow[]) {
  return (
    isSamePersonOrSlot(row, manager) ||
    reportsToVacantReplacementOwner(row, manager) ||
    reportsUpTo(row, manager, rows)
  );
}

function reportsToVacantManagerSlot(row: OrganogramRow, managerSlot: OrganogramRow) {
  if (managerSlot.type !== "vacancy" || !isDistrictSalesManager(managerSlot) || isManagerLevel(row)) {
    return false;
  }

  return isMedicalRep(row) && districtBucketMatches(row, managerSlot);
}

function isMarketingManager(row: OrganogramRow) {
  return titleText(row).includes("marketing manager");
}

export function buildMemberTree(members: OrganogramRow[]) {
  const memberIds = new Set(
    members.map((member) => normalizeHrIdKey(member.hrId)).filter(Boolean),
  );
  const parentByNodeKey = new Map<string, string>();
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

    if (managerHrId && memberHrId !== managerHrId && memberIds.has(managerHrId)) {
      const managerNode = nodesByHrId.get(managerHrId)?.[0];
      let cursor = managerNode?.key;
      let createsCycle = false;

      while (cursor) {
        if (cursor === node.key) {
          createsCycle = true;
          break;
        }

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

  const sortNodes = (nodes: MemberNode[]) => {
    nodes.sort((left, right) => left.row.fullName.localeCompare(right.row.fullName));

    for (const node of nodes) {
      sortNodes(node.children);
    }
  };

  sortNodes(roots);

  return roots;
}

export function buildOrganogramLanes(rows: OrganogramRow[]) {
  const chiefExecutive = rows.find((row) => isChiefExecutive(row)) ?? null;
  const lineLeader = rows.find((row) => isNationalSalesManager(row)) ?? null;
  const rsmRows = rows
    .filter((row) => isRegionalSalesManager(row))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
  // Detect MedRep employees who have direct reports among non-manager rows.
  // They are filling a DSM role temporarily (acting DSM) and get their own lane.
  const managerHrIdsOfNonManagers = new Set(
    rows
      .filter(
        (row) =>
          row.type === "employee" &&
          row.managerHrId &&
          !isChiefExecutive(row) &&
          !isNationalSalesManager(row) &&
          !isRegionalSalesManager(row) &&
          !isDistrictSalesManager(row),
      )
      .map((row) => normalizeHrIdKey(row.managerHrId))
      .filter(Boolean),
  );
  const actingDsmHrIds = new Set(
    rows
      .filter(
        (row) =>
          row.type === "employee" &&
          isMedicalRep(row) &&
          managerHrIdsOfNonManagers.has(normalizeHrIdKey(row.hrId)),
      )
      .map((row) => normalizeHrIdKey(row.hrId))
      .filter(Boolean),
  );
  const dsmRows = rows
    .filter(
      (row) =>
        isDistrictSalesManager(row) ||
        (row.type === "employee" && actingDsmHrIds.has(normalizeHrIdKey(row.hrId))),
    )
    .sort((left, right) =>
      left.type === right.type
        ? left.fullName.localeCompare(right.fullName)
        : left.type === "employee"
          ? -1
          : 1,
    );
  const dsmHrIds = new Set(dsmRows.map((row) => normalizeHrIdKey(row.hrId)));
  const dsmNameKeys = new Set(dsmRows.map((row) => normalizeNameKey(row.fullName)));
  const teamRows = rows.filter(
    (row) =>
      !isChiefExecutive(row) &&
      !isNationalSalesManager(row) &&
      !isRegionalSalesManager(row) &&
      !isDistrictSalesManager(row) &&
      !(row.type === "employee" && actingDsmHrIds.has(normalizeHrIdKey(row.hrId))),
  );
  const assignedToDsm = new Set<string>();
  const dsmGroups: ManagerLane[] = groupBy(dsmRows, managerIdentityKey).map(([, dsms]) => {
    const primaryDsm = [...dsms].sort((left, right) =>
      left.type === right.type
        ? left.fullName.localeCompare(right.fullName)
        : left.type === "employee"
          ? -1
          : 1,
    )[0];
    const members = teamRows
      .filter((row) => {
        const key = rowKey(row);
        if (assignedToDsm.has(key)) {
          return false;
        }

        return dsms.some(
          (dsm) =>
            reportsToKnownManager(row, dsm, rows) ||
            reportsToVacantManagerSlot(row, dsm),
        );
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
  const visibleDsmGroups = dsmGroups;
  const directDsmGroups = visibleDsmGroups.filter((lane) => !childDsmLaneKeys.has(dsmLaneKey(lane)));
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
  const allGroups: TopManagerLane[] = [
    ...directDsmGroups,
    ...rsmGroups,
    ...marketingGroups,
    ...fallbackManagerGroups,
    ...(unassignedMembers.length > 0
      ? [{ dsm: null, members: unassignedMembers, name: "Unassigned Manager", title: "Manager" }]
      : []),
  ];
  const groups = allGroups.filter(
    (group) => group.members.length > 0 || group.dsm || group.rsm || (group.childLanes?.length ?? 0) > 0,
  );
  const filledLaneCount = groups.filter(
    (group) => group.members.length > 0 || (group.childLanes ?? []).some((lane) => lane.members.length > 0),
  ).length;
  const laneCount = Math.max(
    groups.reduce((count, group) => count + Math.max(group.childLanes?.length ?? 1, 1), 0),
    1,
  );

  return { chiefExecutive, filledLaneCount, groups, laneCount, lineLeader };
}

export function filterOrganogramRows(
  rows: OrganogramRow[],
  effectiveLineFilter: string,
  search: string,
) {
  const managerHrIdsToKeep = new Set<string>();
  const officeDescendantHrIdsToKeep = new Set<string>();
  const rowsByHrId = new Map<string, OrganogramRow>();

  for (const row of rows) {
    const key = normalizeHrIdKey(row.hrId);
    if (key) rowsByHrId.set(key, row);
  }

  const selectedLineKey = effectiveLineFilter.trim().toLowerCase();
  const isOfficeSelected = selectedLineKey === "office" || selectedLineKey === "head office";
  const selectedLineRows = effectiveLineFilter
    ? rows.filter((row) =>
        isOfficeSelected
          ? normalizeNameKey(row.lineName) === normalizeNameKey(effectiveLineFilter)
          : normalizeNameKey(row.lineName) === normalizeNameKey(effectiveLineFilter) &&
            isOrganogramVisibleRow(row),
      )
    : rows;

  if (effectiveLineFilter) {
    let frontier = selectedLineRows
      .map((row) => normalizeHrIdKey(row.managerHrId))
      .filter((value): value is string => Boolean(value));

    while (frontier.length > 0) {
      const nextFrontier: string[] = [];

      for (const managerHrId of frontier) {
        if (managerHrIdsToKeep.has(managerHrId)) continue;

        managerHrIdsToKeep.add(managerHrId);

        const nextManagerHrId = normalizeHrIdKey(rowsByHrId.get(managerHrId)?.managerHrId);
        if (nextManagerHrId) nextFrontier.push(nextManagerHrId);
      }

      frontier = nextFrontier;
    }

    if (isOfficeSelected) {
      const officeManagerHrIds = new Set(
        rows
          .filter((row) => normalizeNameKey(row.lineName) === normalizeNameKey(effectiveLineFilter) && !isChiefExecutive(row))
          .map((row) => normalizeHrIdKey(row.hrId)),
      );

      for (const row of rows) {
        if (normalizeNameKey(row.lineName) === normalizeNameKey(effectiveLineFilter) || isChiefExecutive(row)) continue;

        let managerHrId = normalizeHrIdKey(row.managerHrId);
        const visited = new Set<string>();

        while (managerHrId) {
          if (officeManagerHrIds.has(managerHrId)) {
            officeDescendantHrIdsToKeep.add(row.hrId);
            break;
          }

          if (visited.has(managerHrId)) break;

          visited.add(managerHrId);
          managerHrId = normalizeHrIdKey(rowsByHrId.get(managerHrId)?.managerHrId);
        }
      }
    }
  }

  const lineScopedRows = rows.filter((row) => {
    const keepLeadershipChain =
      Boolean(effectiveLineFilter) &&
      (isChiefExecutive(row) ||
        managerHrIdsToKeep.has(normalizeHrIdKey(row.hrId)) ||
        officeDescendantHrIdsToKeep.has(row.hrId));
    const matchesSelectedLine =
      !effectiveLineFilter ||
      (isOfficeSelected
        ? normalizeNameKey(row.lineName) === normalizeNameKey(effectiveLineFilter) || officeDescendantHrIdsToKeep.has(row.hrId)
        : normalizeNameKey(row.lineName) === normalizeNameKey(effectiveLineFilter) &&
          isOrganogramVisibleRow(row));

    return keepLeadershipChain || matchesSelectedLine;
  });

  if (!search) {
    return lineScopedRows;
  }

  const scopedKeys = new Set(lineScopedRows.map(rowKey));
  const matchedRows = lineScopedRows.filter((row) =>
    rowMatchesOrganogramSearch(row, search),
  );
  const keepHrIds = new Set<string>();
  const keepKeys = new Set<string>();

  for (const match of matchedRows) {
    keepKeys.add(rowKey(match));
    keepHrIds.add(normalizeHrIdKey(match.hrId));

    let managerHrId = normalizeHrIdKey(match.managerHrId);
    const visited = new Set<string>();

    while (managerHrId && !visited.has(managerHrId)) {
      visited.add(managerHrId);
      keepHrIds.add(managerHrId);
      const managerRow = rowsByHrId.get(managerHrId);
      managerHrId = normalizeHrIdKey(managerRow?.managerHrId);
    }
  }

  for (const row of lineScopedRows) {
    let managerHrId = normalizeHrIdKey(row.managerHrId);
    const visited = new Set<string>();

    while (managerHrId && !visited.has(managerHrId)) {
      if (keepHrIds.has(managerHrId)) {
        keepKeys.add(rowKey(row));
        break;
      }

      visited.add(managerHrId);
      managerHrId = normalizeHrIdKey(rowsByHrId.get(managerHrId)?.managerHrId);
    }
  }

  return rows.filter((row) =>
    scopedKeys.has(rowKey(row)) &&
    (keepKeys.has(rowKey(row)) || keepHrIds.has(normalizeHrIdKey(row.hrId))),
  );
}
