import { normalizeArabic } from "@/lib/geo/egypt-locations";
import { canonicalHrIdKey } from "@/lib/hr-id";
import {
  classifyOrganogramStructureLevel,
  districtBucketMatches,
  isOrganogramSalesStructureRole,
  organogramPositionSlotKey,
} from "@/lib/reports/organogram-safety";
import type { VacancyReportData } from "@/lib/reports/vacancies";
import {
  formatVacantSeatLabel,
  isWithinManagerHierarchy,
  type SeatContinuitySubject,
} from "@/lib/workforce/hierarchy-resolver";

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
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return Array.from(groups.entries()).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
}

export function titleText(row: OrganogramRow) {
  // Prefer a non-empty positionTitle; fall back to jobTitle so an empty-string
  // positionTitle ("" rather than null) does not blank out classification.
  return String((row.positionTitle?.trim() ? row.positionTitle : row.jobTitle) ?? "")
    .trim()
    .toLowerCase();
}

export function isOfficeLine(row: OrganogramRow) {
  const line = row.lineName?.trim().toLowerCase();
  return line === "office" || line === "head office";
}

/**
 * The options offered by a portal/admin line picker.
 *
 * Head Office is deliberately NOT a product line. It reaches the report by two
 * very different routes and only one of them may be selectable:
 *
 *  - As reporting-chain CONTEXT — e.g. a multi-line Product Manager's report
 *    carries his Marketing Manager and CEO ancestors so the tree has a root.
 *    Those one or two rows are not a department the viewer may browse, and
 *    offering "Head Office" there would open a branch the viewer cannot see.
 *  - As a real BRANCH — the 13-person Head Office tree built by
 *    organogram-head-office.ts, sent only to viewers who pass
 *    canAccessHeadOffice — which since 2026-09-03 names exactly the same set as
 *    canAccessCompanyOrganogram (Super Admin, CEO, Finance Manager, HR Advisory,
 *    HR Operations, Training Manager, SFE Manager, Marketing Manager, system scope
 *    and the A-3 account pin). The two are still asked separately here because a
 *    line-scoped viewer holds Office rows as CHAIN CONTEXT and must not be offered
 *    the branch — that case is unaffected by the two sets converging.
 *
 * The caller decides which case it is via `includeHeadOffice`; the server sets
 * it from the entitlement, never the client. Without it the picker silently
 * dropped a branch the viewer was already cleared to see — Talent Acquisition
 * was granted Head Office on 2026-08-25 and still saw only the four sales lines,
 * because this filter ran after the permission gate had already said yes.
 */
export function buildLinePickerOptions(
  rows: OrganogramRow[],
  options: { includeHeadOffice?: boolean } = {},
) {
  const includeHeadOffice = options.includeHeadOffice ?? false;
  const seen = new Set<string>();

  for (const row of rows) {
    if (isOfficeLine(row) && !includeHeadOffice) continue;
    const line = row.lineName?.trim();
    if (line) seen.add(line);
  }

  return Array.from(seen).sort((left, right) => left.localeCompare(right));
}

export function isSalesDepartment(row: OrganogramRow) {
  return row.departmentName?.trim().toLowerCase() === "sales";
}

export function isMarketingDepartment(row: OrganogramRow) {
  return row.departmentName?.trim().toLowerCase() === "marketing";
}

export function isOrganogramVisibleRow(row: OrganogramRow) {
  return (
    // The CEO's seat row carries no department and no line (departmentName is null on every seat
    // row, and the CEO seat belongs to no line), so none of the four tests below ever admitted him.
    // filterOrganogramRows and buildOrganogramLanes both look for him — the spine's CEO box is
    // backed by his row — but this predicate runs first in both pages, so the box read "Executive
    // Leadership" with no name and no data, and everyone reporting to him was grouped under
    // "Manager AA".
    isChiefExecutive(row) ||
    isSalesDepartment(row) ||
    isMarketingDepartment(row) ||
    isOfficeLine(row) ||
    isOrganogramSalesStructureRole(row)
  );
}

export function normalizeNameKey(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

// HR_ID key for grouping/comparison. Routes through the canonical alias table
// (e.g. legacy AAA -> AA) so the organogram groups people exactly as the rest of
// the app does; returns "" for empty so callers can treat it as "no key".
export function normalizeHrIdKey(value: string | null | undefined) {
  return canonicalHrIdKey(value)?.toUpperCase() ?? "";
}

/**
 * One spelling policy for both halves of a search: the row's text and the query the viewer typed
 * both come through here, so folding has to happen in this one function or not at all. Folding only
 * the row would mean an Arabic name matched a query nobody could type.
 *
 * `normalizeArabic` is imported rather than re-implemented. Its own comment says the same thing for
 * the geography module — one spelling policy, not two — and a private copy here would drift the
 * first time a variant is added to either.
 */
export function normalizeSearchValue(value: string | null | undefined) {
  return normalizeArabic(value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "");
}

export function organogramSearchText(row: OrganogramRow) {
  return [
    row.hrId,
    row.fullName,
    // The name the card prints, so a person is found by either name.
    row.displayName,
    // Every employee record carries an Arabic name and HR types in Arabic. Without this the
    // organogram search answered "nobody" for a name spelled the way it appears on the person's
    // own contract — an empty result that reads as "she is not on the chart" rather than as a
    // search that never looked. Owner instruction, 2026-09-09.
    row.nameAr,
    row.managerHrId,
    row.managerName,
    row.jobTitle,
    row.positionTitle,
    row.departmentName,
    row.lineName,
    row.areaName,
    row.regionName,
    row.teamName,
    // Work email is searchable so the audience picker can be driven by an address the
    // viewer already has in hand ("who is jane.doe@…?"), not only by a name.
    row.workEmail,
  ]
    .map((value) => normalizeSearchValue(value))
    .filter(Boolean)
    .join(" ");
}

export function rowMatchesOrganogramSearch(row: OrganogramRow, query: string) {
  // Normalized here rather than trusted from the caller. Both live callers already normalize, so
  // this changes nothing for them — normalizeSearchValue is idempotent. It matters for the next
  // caller: the row side is always folded, so an unfolded query silently matches NOTHING, and an
  // empty chart reads as "these people are not in the organogram" rather than as a bad comparison.
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return true;
  const compactQuery = normalizedQuery.replace(/[^a-z0-9]/g, "");
  const compactHrId = normalizeSearchValue(row.hrId).replace(/[^a-z0-9]/g, "");
  const compactManagerHrId = normalizeSearchValue(row.managerHrId).replace(/[^a-z0-9]/g, "");

  return (
    organogramSearchText(row).includes(normalizedQuery) ||
    Boolean(compactQuery && (compactHrId.includes(compactQuery) || compactManagerHrId.includes(compactQuery)))
  );
}

export function rowKey(row: OrganogramRow) {
  // seatId keeps two seats held by one person distinct: without it, a dual-seated
  // occupant produced two identical keys and every lane sink silently dropped the
  // second box - the seat looked deleted from the organogram.
  return `${row.type}-${row.hrId}-${row.sourceRowNumber ?? ""}-${row.seatId ?? ""}`;
}

// The four sales-structure predicates delegate to the single canonical classifier
// in organogram-safety.ts so lane grouping and KPI counting can never disagree
// (previously a bare "MR" title was a rep for lanes but not for KPIs).
export function isNationalSalesManager(row: OrganogramRow) {
  return classifyOrganogramStructureLevel(row) === "nsm";
}

export function isRegionalSalesManager(row: OrganogramRow) {
  return classifyOrganogramStructureLevel(row) === "rsm";
}

export function isChiefExecutive(row: OrganogramRow) {
  const title = titleText(row);

  return (
    canonicalHrIdKey(row.hrId) === "aa" ||
    title === "ceo" ||
    title.includes("chief executive")
  );
}

export function isDistrictSalesManager(row: OrganogramRow) {
  return classifyOrganogramStructureLevel(row) === "dsm";
}

export function isMedicalRep(row: OrganogramRow) {
  return classifyOrganogramStructureLevel(row) === "medicalRep";
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

function toSeatSubject(row: OrganogramRow): SeatContinuitySubject {
  return {
    managerHrId: row.managerHrId,
    pendingManagerReplacementForHrId: row.managerReplacementForHrId,
  };
}

// Canonical HR_ID -> seat-continuity subject for every row, built once per
// buildOrganogramLanes call so the hierarchy climb below is a Map lookup per
// step instead of an O(rows) linear scan.
function buildCanonicalHrIdIndex(rows: OrganogramRow[]): Map<string, SeatContinuitySubject> {
  const index = new Map<string, SeatContinuitySubject>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hrId);
    if (key && !index.has(key)) index.set(key, toSeatSubject(row));
  }
  return index;
}

// Climbs manager_hr_id toward `manager`, seat-continuity aware at EVERY level
// (not just the immediate parent) via the same hierarchy-resolver.ts helper
// Sales/Medical Reps Performance and the Vacation Report use — the single
// source of truth this module's own docstring calls for, so a fix to
// seat-continuity there (e.g. the orphan-to-NSM vacancy fallback) now flows
// into the organogram automatically instead of silently drifting.
export function reportsUpTo(
  row: OrganogramRow,
  manager: OrganogramRow,
  byCanonicalHrId: ReadonlyMap<string, SeatContinuitySubject>,
) {
  const viewerCanonicalHrId = canonicalHrIdKey(manager.hrId);
  if (!viewerCanonicalHrId) return false;

  return isWithinManagerHierarchy({
    byCanonicalHrId,
    canonicalize: canonicalHrIdKey,
    employee: toSeatSubject(row),
    viewerCanonicalHrId,
  });
}

function reportsToKnownManager(
  row: OrganogramRow,
  manager: OrganogramRow,
  byCanonicalHrId: ReadonlyMap<string, SeatContinuitySubject>,
) {
  return (
    isSamePersonOrSlot(row, manager) ||
    reportsToVacantReplacementOwner(row, manager) ||
    reportsUpTo(row, manager, byCanonicalHrId)
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
  // rowKey (type+hrId+sourceRowNumber) is already a stable per-person identity;
  // an appended array index would make the key (and therefore collapse state)
  // depend on position, so a reordered/filtered render could cross-bind a
  // collapsed node onto a different person.
  const nodes = members.map((member) => ({
    children: [],
    key: rowKey(member),
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
  const byCanonicalHrId = buildCanonicalHrIdIndex(rows);
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
  // A team row can broad-match MULTIPLE vacant DSM slots via the geographic
  // Cairo fallback (e.g. two open Cairo DSM seats in one line). dsmGroups is
  // built by iterating a SORTED list of slot keys, so without this guard
  // whichever slot's key happens to sort first — an arbitrary artifact of
  // organogramPositionSlotKey's plain string concatenation, not a meaningful
  // signal — would deterministically claim the row every time, silently
  // starving the other slot. Mirrors hierarchy-resolver.ts's own
  // selectVacantManagerSeat: when a geographic fallback is ambiguous, refuse
  // to guess rather than pick an arbitrary winner. Exact matches
  // (reportsToKnownManager: direct report, or held via a seat-continuity
  // marker) are unaffected — only the broad-bucket guess is withheld.
  const vacantDsmSlots = dsmRows.filter(
    (row) => row.type === "vacancy" && isDistrictSalesManager(row),
  );
  const ambiguousBroadCairoRowKeys = new Set(
    teamRows
      .filter(
        (row) => vacantDsmSlots.filter((slot) => reportsToVacantManagerSlot(row, slot)).length > 1,
      )
      .map(rowKey),
  );
  const assignedToDsm = new Set<string>();
  const dsmIdentityGroups = groupBy(dsmRows, managerIdentityKey);
  // A rep row can have NO manager link at all (managerHrId and the
  // seat-continuity marker both empty) purely from an import gap — e.g. a
  // seeded vacancy missing its manager_hr_id even though its sibling rows for
  // the same manager correctly have it (confirmed case: a CNS Delta 2 rep
  // vacancy with manager_hr_id NULL and a typo'd managerName, while its 3
  // sibling vacancies for the same real DSM correctly link by ID). Recognize it
  // by its REGION instead: when the row's region exactly matches a DSM's own
  // area/territory, AND exactly one DSM group owns that area (no ambiguity),
  // it unambiguously belongs to that DSM's team — mirrors this file's existing
  // "exact match only, refuse to guess when ambiguous" rule for the Cairo
  // broad-fallback above, just keyed on the DSM's own territory instead.
  const dsmGroupsByOwnAreaKey = new Map<string, unknown[]>();
  for (const [, dsms] of dsmIdentityGroups) {
    const areaKey = normalizeNameKey(dsms[0]?.areaName);
    if (!areaKey) continue;
    dsmGroupsByOwnAreaKey.set(areaKey, [...(dsmGroupsByOwnAreaKey.get(areaKey) ?? []), dsms]);
  }
  function unambiguousRegionOwnerDsms(row: OrganogramRow): OrganogramRow[] | null {
    if (row.managerHrId || row.managerReplacementForHrId) return null;
    if (!isMedicalRep(row)) return null;
    const regionKey = normalizeNameKey(row.regionName);
    if (!regionKey) return null;
    const owners = dsmGroupsByOwnAreaKey.get(regionKey);
    return owners?.length === 1 ? (owners[0] as OrganogramRow[]) : null;
  }
  const dsmGroups: ManagerLane[] = dsmIdentityGroups.map(([, dsms]) => {
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
            reportsToKnownManager(row, dsm, byCanonicalHrId) ||
            (!ambiguousBroadCairoRowKeys.has(key) && reportsToVacantManagerSlot(row, dsm)) ||
            unambiguousRegionOwnerDsms(row) === dsms,
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
      name: primaryDsm.displayName,
      title: primaryDsm.positionTitle ?? primaryDsm.jobTitle ?? "District Sales Manager",
    };
  });
  const dsmLaneKey = (lane: ManagerLane) =>
    lane.dsm ? managerIdentityKey(lane.dsm) : `${lane.name}:${lane.title}`;
  const childDsmLaneKeys = new Set<string>();
  const rsmGroups: TopManagerLane[] = rsmRows.map((rsm) => {
    const childLanes = dsmGroups.filter((lane) => {
      if (!lane.dsm) return false;
      return reportsToKnownManager(lane.dsm, rsm, byCanonicalHrId);
    });

    childLanes.forEach((lane) => childDsmLaneKeys.add(dsmLaneKey(lane)));

    return {
      childLanes,
      dsm: null,
      members: [],
      name: rsm.displayName,
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
        managers.some((manager) => reportsUpTo(row, manager, byCanonicalHrId)),
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
      name: primaryManager.displayName,
      title: primaryManager.positionTitle ?? primaryManager.jobTitle ?? "Marketing Manager",
    };
  });
  const fallbackManagerGroups = groupBy(
    teamRows.filter((row) => {
      const key = rowKey(row);
      const managerNameKey = normalizeNameKey(row.managerName);
      const managerHrId = normalizeHrIdKey(row.managerHrId);
      // A report whose manager seat resigned is reassigned UP to the line leader
      // and stamped with a replacement marker. Without this, that report would be
      // excluded here (reportsToLineLeader) yet has no DSM/vacancy lane to land
      // in, and would vanish. Recognizing the marker rescues it under a vacant
      // seat (mirrors resolveSeatGrouping's marker precedence).
      const heldByVacantSeat = Boolean(normalizeHrIdKey(row.managerReplacementForHrId));
      const reportsToLineLeader =
        Boolean(lineLeader) &&
        (managerHrId === normalizeHrIdKey(lineLeader?.hrId) ||
          managerNameKey === normalizeNameKey(lineLeader?.fullName));

      return (
        !assignedToDsm.has(key) &&
        (!reportsToLineLeader || heldByVacantSeat) &&
        (managerHrId || row.managerName || heldByVacantSeat) &&
        (!managerHrId || !dsmHrIds.has(managerHrId)) &&
        (!managerNameKey || !dsmNameKeys.has(managerNameKey)) &&
        // A vacancy stub with no manager ID and no seat-continuity marker has an
        // unverified free-text managerName — it could be an honest placeholder
        // ("Vacant Cairo District Manager") or a broken/typo'd reference to a
        // real person (e.g. "Sally Saeed" vs. the real "Sally Saied") or import
        // test debris. Only trust it as a real fallback lane when it explicitly
        // self-declares as a vacant placeholder; otherwise route to Unassigned
        // rather than fabricating a one-off manager identity from unverified
        // text (see unassignedMembers below).
        (row.type !== "vacancy" ||
          Boolean(managerHrId) ||
          heldByVacantSeat ||
          managerNameKey.includes("vacant"))
      );
    }),
    (row) => {
      const heldSeatKey = normalizeHrIdKey(row.managerReplacementForHrId);
      if (heldSeatKey) return `held-seat:${heldSeatKey}`;

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
    const isHeldSeat = managerKey.startsWith("held-seat:");
    const name =
      managerKey === "ceo-direct-reports"
        ? "CEO Direct Reports"
        : isHeldSeat
          ? formatVacantSeatLabel(
              {
                areaName: firstMember?.areaName,
                teamName: firstMember?.teamName,
                lineName: firstMember?.lineName,
              },
              "DSM seat",
            )
          : firstMember?.managerName ?? `Manager ${firstMember?.managerHrId ?? "Unknown"}`;

    return {
      dsm: null,
      members,
      name,
      title: isHeldSeat ? "Vacant seat" : "Manager",
    };
  });
  const unassignedMembers = teamRows.filter((row) => {
    const key = rowKey(row);
    if (assignedToDsm.has(key)) return false;

    // No manager info at all.
    if (!row.managerHrId && !row.managerName) return true;

    // Mirrors the fallbackManagerGroups exclusion above: a vacancy stub with an
    // unverified free-text managerName (no ID, no seat-continuity marker, not a
    // self-declared "vacant" placeholder) is rescued here instead of vanishing,
    // rather than fabricating a one-off manager lane from that unverified text.
    if (
      row.type === "vacancy" &&
      !normalizeHrIdKey(row.managerHrId) &&
      !normalizeHrIdKey(row.managerReplacementForHrId) &&
      Boolean(row.managerName) &&
      !normalizeNameKey(row.managerName).includes("vacant")
    ) {
      return true;
    }

    // Reports STRAIGHT to the line leader (NSM) with no vacant-seat marker. The
    // fallbackManagerGroups filter excludes exactly this case (reportsToLineLeader
    // && !heldByVacantSeat) because a line-leader report has no DSM/vacancy lane
    // to land in — the NSM spine card doesn't render its own non-manager direct
    // reports either. Without catching it here the row lands in NO bucket and
    // vanishes from the chart. Route it to Unassigned so it stays visible. (No
    // live victim today — the only NSM-direct report is an acting DSM, pulled out
    // of teamRows above — but a single manager repoint would otherwise drop a rep.)
    const managerHrId = normalizeHrIdKey(row.managerHrId);
    const managerNameKey = normalizeNameKey(row.managerName);
    const heldByVacantSeat = Boolean(normalizeHrIdKey(row.managerReplacementForHrId));
    const reportsToLineLeader =
      Boolean(lineLeader) &&
      (managerHrId === normalizeHrIdKey(lineLeader?.hrId) ||
        managerNameKey === normalizeNameKey(lineLeader?.fullName));
    if (reportsToLineLeader && !heldByVacantSeat) {
      return true;
    }

    return false;
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

  // Diagnostic only (not used for grouping): count of team rows whose
  // managerHrId is set but doesn't match any row actually present in this
  // scoped set — a genuinely dangling reference (bad data, or the manager
  // sits outside the current scope), distinct from the normal, fine case of
  // reporting to a real but non-sales-structure manager (fallbackManagerGroups
  // handles that silently and correctly). Lets a consumer surface "N rows
  // have an unresolved manager" instead of the mismatch being absorbed
  // invisibly into the Unassigned/fallback buckets.
  const allHrIdKeys = new Set(rows.map((r) => normalizeHrIdKey(r.hrId)).filter(Boolean));
  const unresolvedManagerCount = teamRows.filter((row) => {
    const managerHrId = normalizeHrIdKey(row.managerHrId);
    return Boolean(managerHrId) && !allHrIdKeys.has(managerHrId);
  }).length;

  return { chiefExecutive, filledLaneCount, groups, lineLeader, unresolvedManagerCount };
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
  // A sales line also holds the Head Office marketers whose OWN line it is — the Product and Group
  // Product Managers of that line (owner, 2026-10-20; `ownLineName`, organogram-head-office.ts).
  // Their Head Office managers then ride in through the leadership chain below, so each one is
  // drawn under a manager who is on the chart.
  const onSelectedSalesLine = (row: OrganogramRow) =>
    normalizeNameKey(row.lineName) === normalizeNameKey(effectiveLineFilter) ||
    (Boolean(row.ownLineName) && normalizeNameKey(row.ownLineName) === normalizeNameKey(effectiveLineFilter));
  const selectedLineRows = effectiveLineFilter
    ? rows.filter((row) =>
        isOfficeSelected
          ? normalizeNameKey(row.lineName) === normalizeNameKey(effectiveLineFilter)
          : onSelectedSalesLine(row) && isOrganogramVisibleRow(row),
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
            officeDescendantHrIdsToKeep.add(normalizeHrIdKey(row.hrId));
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
        officeDescendantHrIdsToKeep.has(normalizeHrIdKey(row.hrId)));
    const matchesSelectedLine =
      !effectiveLineFilter ||
      (isOfficeSelected
        ? normalizeNameKey(row.lineName) === normalizeNameKey(effectiveLineFilter) || officeDescendantHrIdsToKeep.has(normalizeHrIdKey(row.hrId))
        : onSelectedSalesLine(row) && isOrganogramVisibleRow(row));

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
