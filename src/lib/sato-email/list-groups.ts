import type { DistributionListSpec } from "@/lib/distribution-lists/spec";

/**
 * How the composer LAYS OUT the distribution lists, and which picked list already carries another.
 *
 * Owner 2026-09-13: "make the dls appears horizontly grouped and tidy and user friendly". The lists
 * used to be one stacked column of ~70 checkboxes, every regional one carrying the same sentence
 * about region names and codes, so finding "Pedia · Giza · Medical Reps" meant scrolling past
 * forty-odd near-identical rows.
 *
 * Two jobs, kept apart on purpose:
 *
 *  - GROUPING is presentation. It reads the LABEL ("Line - Region - Role"), because the label is
 *    what the sender reads and a line's display name is nowhere else on the list row. A label that
 *    does not fit a known shape lands in "Other lists" — it is never dropped, since a list the
 *    sender cannot see is a list they cannot pick.
 *
 *  - COVERAGE decides who is ALREADY reached, and it reads the RULE, never the label. A relabelled
 *    list must not claim to include people it does not match, because the sender acts on that claim
 *    by not ticking the narrower list. So it answers "covered" only when it can prove it, and "not
 *    covered" for everything it cannot — a missed hint costs a redundant tick, a wrong one costs
 *    recipients.
 */

export type SatoListGroupItem = {
  /** Lists whose rule reaches everyone this one does. Picking any of them already covers it. */
  coveredBy: string[];
  description: string;
  label: string;
  listKey: string;
};

export type SatoLineRegionRow = {
  districtManagers: SatoListGroupItem | null;
  medicalReps: SatoListGroupItem | null;
  region: string;
};

export type SatoLineGroup = {
  districtManagers: SatoListGroupItem | null;
  everyone: SatoListGroupItem | null;
  line: string;
  medicalReps: SatoListGroupItem | null;
  regions: SatoLineRegionRow[];
};

export type SatoListGroups = {
  /** "All District Managers", "All Medical Reps" — one role, every line. */
  companyWide: SatoListGroupItem[];
  lines: SatoLineGroup[];
  /** Anything whose label fits no known shape. Shown, never hidden. */
  other: SatoListGroupItem[];
  /** Head Office, HR Team, Finance Team — a named team rather than a slice of the field force. */
  teams: SatoListGroupItem[];
};

const ROLE_SEGMENT = {
  "district managers": "districtManagers",
  everyone: "everyone",
  "medical reps": "medicalReps",
} as const;

type RoleSlot = (typeof ROLE_SEGMENT)[keyof typeof ROLE_SEGMENT];

/**
 * The organogram's own order, north to south with Others last — the order a sales manager reads
 * the regions in. A region not named here (a new split) follows, alphabetically, rather than
 * vanishing.
 */
const REGION_ORDER = [
  "cairo",
  "giza",
  "alex-bhr",
  "delta (1)",
  "delta (2)",
  "delta (3)",
  "upper egypt",
  "upper egypt 1",
  "upper egypt 2",
  "others",
];

function roleSlot(segment: string): RoleSlot | null {
  return (ROLE_SEGMENT as Record<string, RoleSlot>)[segment.trim().toLowerCase()] ?? null;
}

function regionRank(region: string): number {
  const index = REGION_ORDER.indexOf(region.trim().toLowerCase());
  return index === -1 ? REGION_ORDER.length : index;
}

function byLabel(left: SatoListGroupItem, right: SatoListGroupItem): number {
  return left.label.localeCompare(right.label);
}

export function groupSatoEmailLists(items: readonly SatoListGroupItem[]): SatoListGroups {
  const companyWide: SatoListGroupItem[] = [];
  const teams: SatoListGroupItem[] = [];
  const other: SatoListGroupItem[] = [];
  const lines = new Map<string, SatoLineGroup>();

  const lineGroup = (line: string): SatoLineGroup => {
    let group = lines.get(line);
    if (!group) {
      group = { districtManagers: null, everyone: null, line, medicalReps: null, regions: [] };
      lines.set(line, group);
    }
    return group;
  };

  for (const item of items) {
    const parts = item.label.split(" - ").map((part) => part.trim());

    if (parts.length === 1 && parts[0]) {
      (/^all\s/i.test(parts[0]) ? companyWide : teams).push(item);
      continue;
    }

    if (parts.length === 2 && parts[0]) {
      const slot = roleSlot(parts[1]);
      const group = slot ? lineGroup(parts[0]) : null;
      // A second list claiming the same slot goes to Other rather than overwriting the first.
      if (group && slot && group[slot] === null) {
        group[slot] = item;
        continue;
      }
    }

    if (parts.length === 3 && parts[0] && parts[1]) {
      const slot = roleSlot(parts[2]);
      if (slot === "districtManagers" || slot === "medicalReps") {
        const group = lineGroup(parts[0]);
        let row = group.regions.find((entry) => entry.region === parts[1]);
        if (!row) {
          row = { districtManagers: null, medicalReps: null, region: parts[1] };
          group.regions.push(row);
        }
        if (row[slot] === null) {
          row[slot] = item;
          continue;
        }
      }
    }

    other.push(item);
  }

  const orderedLines = Array.from(lines.values()).sort((left, right) => left.line.localeCompare(right.line));
  for (const group of orderedLines) {
    group.regions.sort(
      (left, right) => regionRank(left.region) - regionRank(right.region) || left.region.localeCompare(right.region),
    );
  }

  return {
    companyWide: companyWide.sort(byLabel),
    lines: orderedLines,
    other: other.sort(byLabel),
    teams: teams.sort(byLabel),
  };
}

// ── Coverage ─────────────────────────────────────────────────────────────────────────────────

function dimensionCovers<T>(wide: readonly T[], narrow: readonly T[]): boolean {
  // An empty dimension on the wide list is "no constraint" (matchesDistributionRule), so it covers
  // anything. A constrained one covers only a narrow list constrained to a subset of it — an empty
  // narrow dimension means the narrow list reaches values the wide one refuses.
  if (wide.length === 0) return true;
  if (narrow.length === 0) return false;
  return narrow.every((value) => wide.includes(value));
}

function upper(values: readonly string[]): string[] {
  return values.map((value) => value.trim().toUpperCase()).filter(Boolean);
}

/**
 * Does every person `narrow` reaches also get reached by `wide`?
 *
 * Proven dimension by dimension against the matcher's own semantics (AND across dimensions, OR
 * within one, empty = unconstrained). Anything the matcher treats specially is answered "no":
 * a list with no rule, a dropped role, the company-wide flag, a hand-added name or outside address
 * on the narrow list, an exclusion on the wide one.
 */
export function distributionListCovers(wide: DistributionListSpec, narrow: DistributionListSpec): boolean {
  if (wide.listKey === narrow.listKey) return false;
  if (!wide.enabled || !narrow.enabled) return false;
  if (wide.allEmployees || narrow.allEmployees) return false;
  if (wide.rolesDropped || narrow.rolesDropped) return false;
  if (narrow.includedHrIds.length > 0 || narrow.externalEmails.length > 0) return false;
  if (wide.excludedHrIds.length > 0) return false;

  const wideHasRule =
    wide.roles.length + wide.lineIds.length + wide.areaIds.length + wide.departmentIds.length + wide.positionIds.length +
      wide.regionCodes.length >
    0;
  if (!wideHasRule) return false;

  return (
    dimensionCovers(wide.roles, narrow.roles) &&
    dimensionCovers(wide.lineIds, narrow.lineIds) &&
    dimensionCovers(wide.areaIds, narrow.areaIds) &&
    dimensionCovers(wide.departmentIds, narrow.departmentIds) &&
    dimensionCovers(wide.positionIds, narrow.positionIds) &&
    // A region rule matches the CODE or the NAME, so the narrow list's values being a subset of the
    // wide list's values is enough: any person matching one narrow value matches that same value.
    dimensionCovers(upper(wide.regionCodes), upper(narrow.regionCodes))
  );
}

/** For each list, the keys of the other offered lists that already reach everyone it does. */
export function computeListCoverage(specs: readonly DistributionListSpec[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const narrow of specs) {
    out.set(
      narrow.listKey,
      specs.filter((wide) => distributionListCovers(wide, narrow)).map((wide) => wide.listKey),
    );
  }
  return out;
}
