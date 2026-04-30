import {
  departmentRules,
  lineRules,
  positionRules,
} from "@/lib/imports/org-rules";

export type OrgValue = {
  rawValue: string | null;
  normalizedName: string | null;
  displayName: string | null;
  code: string | null;
};

export type OrgMappingWarning = {
  rowNumber: number;
  field: "department" | "line" | "area" | "team" | "position";
  code: "org_mapping_needs_review";
  rawValue: string;
  message: string;
};

export type OrgMappingSample = {
  rowNumber: number;
  rawDepartment: string | null;
  rawLine: string | null;
  rawArea: string | null;
  rawTeam: string | null;
  rawPosition: string | null;
  departmentName: string | null;
  lineName: string | null;
  areaName: string | null;
  teamName: string | null;
  positionTitle: string | null;
};

export type OrgClassification = {
  department: OrgValue;
  line: OrgValue;
  area: OrgValue;
  team: OrgValue;
  position: OrgValue;
  sourceArea: OrgValue;
  sourceTeam: OrgValue;
  warnings: OrgMappingWarning[];
  sample: OrgMappingSample;
};

const EMPTY_VALUES = new Set(["", "-", "n/a", "na", "null", "undefined"]);

function normalizeTextValue(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().replace(/\s+/g, " ");

  if (EMPTY_VALUES.has(normalized.toLowerCase())) {
    return null;
  }

  return normalized;
}

function toTitleCase(value: string) {
  return value
    .split(" ")
    .map((word) => {
      if (!/[a-z]/i.test(word)) {
        return word;
      }

      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

export function createOrgCode(value: string | null) {
  if (!value) {
    return null;
  }

  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[-_]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function fromCode(code: string | null, displayName?: string | null): OrgValue {
  if (!code) {
    return {
      rawValue: null,
      normalizedName: null,
      displayName: null,
      code: null,
    };
  }

  return {
    rawValue: displayName ?? code.replace(/_/g, " "),
    normalizedName: code,
    displayName: displayName ?? toTitleCase(code.replace(/_/g, " ")),
    code,
  };
}

function normalizeOrgValue(value: unknown): OrgValue {
  const rawValue = normalizeTextValue(value);

  if (!rawValue) {
    return fromCode(null);
  }

  const code = createOrgCode(rawValue);

  return {
    rawValue,
    normalizedName: code,
    displayName: code ? toTitleCase(code.replace(/_/g, " ")) : null,
    code,
  };
}

function preserveAreaValue(value: unknown): OrgValue {
  const rawValue = normalizeTextValue(value);

  if (!rawValue) {
    return fromCode(null);
  }

  const code = createOrgCode(rawValue);

  return {
    rawValue,
    normalizedName: code,
    displayName: rawValue,
    code,
  };
}

function normalizeByRules(value: unknown, rules: Record<string, string>) {
  const normalized = normalizeOrgValue(value);
  const mappedName = normalized.code ? rules[normalized.code] : null;

  if (!mappedName) {
    return normalized;
  }

  return {
    rawValue: normalized.rawValue,
    normalizedName: createOrgCode(mappedName),
    displayName: mappedName,
    code: createOrgCode(mappedName),
  };
}

function classifyAreaAndTeam(areaValue: unknown, teamValue: unknown) {
  const sourceArea = preserveAreaValue(areaValue);
  const sourceTeam = preserveAreaValue(teamValue);

  return {
    area: sourceArea,
    team: sourceTeam.code ? sourceTeam : fromCode(null),
    sourceArea,
    sourceTeam,
    warnings: [],
  };
}

export function classifyOrganizationRow({
  rowNumber,
  department,
  line,
  area,
  team,
  position,
}: {
  rowNumber: number;
  department: unknown;
  line: unknown;
  area: unknown;
  team: unknown;
  position: unknown;
}): OrgClassification {
  const departmentValue = normalizeByRules(department, departmentRules);
  const lineValue = normalizeByRules(line, lineRules);
  const areaResult = classifyAreaAndTeam(area, team);
  const positionValue = normalizeByRules(position, positionRules);

  return {
    department: departmentValue,
    line: lineValue,
    area: areaResult.area,
    team: areaResult.team,
    position: positionValue,
    sourceArea: areaResult.sourceArea,
    sourceTeam: areaResult.sourceTeam,
    warnings: areaResult.warnings,
    sample: {
      rowNumber,
      rawDepartment: departmentValue.rawValue,
      rawLine: lineValue.rawValue,
      rawArea: areaResult.sourceArea.rawValue,
      rawTeam: areaResult.sourceTeam.rawValue,
      rawPosition: positionValue.rawValue,
      departmentName: departmentValue.displayName,
      lineName: lineValue.displayName,
      areaName: areaResult.area.displayName,
      teamName: areaResult.team.displayName,
      positionTitle: positionValue.displayName,
    },
  };
}
