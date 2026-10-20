import { toOrgTitleCase } from "@/lib/imports/org-title-case";

const EMPTY_VALUES = new Set(["", "-", "n/a", "na", "null", "undefined"]);
const ORGANIZATION_ALIASES: Record<string, string> = {
  alex: "alexandria",
  alex_bhr: "alexandria",
  alex_behiera: "alexandria",
  alexandria_behiera: "alexandria",
  banha: "qalyubia",
  domiat: "damietta",
  kafr_el_sheikh: "kafr_el_sheikh",
  kfs: "kafr_el_sheikh",
  monofia: "menoufia",
  cairo_city: "cairo",
  nasr_city: "nasr",
  qaluibia: "qalyubia",
};

const AREA_PREFIX_RULES: Array<[RegExp, string]> = [
  [/^cairo(?:_|$)/, "cairo"],
  [/^(downtown|heliopolis|helwan|maadi|nasr|shoubra)(?:_|$)/, "cairo"],
  [/^alex(?:_|$)/, "alexandria"],
  [/^alexandria(?:_|$)/, "alexandria"],
  [/^behira(?:_|$)/, "beheira"],
  [/^beheira(?:_|$)/, "beheira"],
  [/^giza(?:_|$)/, "giza"],
  [/^(dokki|faisal|haram|imbaba|mohandsen|mohandesen|october|zayed)(?:_|$)/, "giza"],
  [/^assuit(?:_|)?\d*$/, "assuit"],
  [/^asyut(?:_|)?\d*$/, "assuit"],
  [/^bani_suef(?:_|$)/, "bani_suef"],
  [/^dakahlia(?:_|$)/, "dakahlia"],
  [/^delta(?:_|$)/, "delta"],
  [/^fayoum(?:_|$)/, "fayoum"],
  [/^gharbia(?:_|$)/, "gharbia"],
  [/^kafr_el_sheikh(?:_|$)/, "kafr_el_sheikh"],
  [/^kfs(?:_|$)/, "kafr_el_sheikh"],
  [/^mahalla(?:_|$)/, "gharbia"],
  [/^menoufia(?:_|$)/, "menoufia"],
  [/^minia(?:_|$)/, "minia"],
  [/^monofia(?:_|$)/, "menoufia"],
  [/^port_said(?:_|$)/, "port_said"],
  [/^qalyubia(?:_|$)/, "qalyubia"],
  [/^qaluibia(?:_|$)/, "qalyubia"],
  [/^qena(?:_|$)/, "qena"],
  [/^sharkia(?:_|$)/, "sharkia"],
  [/^sohag(?:_|)?\d*$/, "sohag"],
  [/^tanta(?:_|$)/, "gharbia"],
];

const DISTRICT_PATTERNS = [
  "center",
  "east",
  "west",
  "downtown",
  "heliopolis",
  "helwan",
  "maadi",
  "nasr",
  "shoubra",
  "dokki",
  "faisal",
  "haram",
  "imbaba",
  "mohandsen",
  "mohandesen",
  "october",
  "zayed",
];

export function normalizeHeaderName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeTextValue(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().replace(/\s+/g, " ");

  if (EMPTY_VALUES.has(normalized.toLowerCase())) {
    return null;
  }

  return normalized;
}

// Parse a spreadsheet yes/no-style flag into a boolean. Returns null when the cell is blank or
// unrecognized, so callers can tell "not provided" apart from an explicit true/false and avoid
// clobbering a value the org set deliberately (e.g. an executive's payroll_eligible=false).
// ONE vocabulary for the whole import: the confirm route writes with it, and the salary-blind
// seat's pay-flag check (src/lib/employees/salary-blind-pay-flags.ts) compares with it, so a word
// the write would honour can never slip past the comparison.
export function parseImportBooleanFlag(value: string | null): boolean | null {
  if (value === null) {
    return null;
  }

  const text = value.trim().toLowerCase();

  if (["yes", "y", "true", "1", "eligible", "visible", "active", "enabled"].includes(text)) {
    return true;
  }

  if (["no", "n", "false", "0", "ineligible", "hidden", "inactive", "disabled"].includes(text)) {
    return false;
  }

  return null;
}

export function normalizeOrganizationName(value: unknown) {
  const rawValue = normalizeTextValue(value);

  if (!rawValue) {
    return {
      rawValue: null,
      normalizedName: null,
      displayName: null,
      code: null,
    };
  }

  const compactName = rawValue
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[-_]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compactCode = createCode(compactName);
  const canonicalCode = compactCode
    ? ORGANIZATION_ALIASES[compactCode] ?? compactCode
    : null;
  const canonicalText = canonicalCode?.replace(/_/g, " ") ?? null;

  return {
    rawValue,
    normalizedName: canonicalCode,
    displayName: canonicalText ? toOrgTitleCase(canonicalText) : null,
    code: canonicalCode,
  };
}

function organizationNameFromCode(code: string | null) {
  if (!code) {
    return {
      rawValue: null,
      normalizedName: null,
      displayName: null,
      code: null,
    };
  }

  const canonicalCode = ORGANIZATION_ALIASES[code] ?? code;
  const canonicalText = canonicalCode.replace(/_/g, " ");

  return {
    rawValue: canonicalText,
    normalizedName: canonicalCode,
    displayName: toOrgTitleCase(canonicalText),
    code: canonicalCode,
  };
}

function inferAreaCode(code: string | null) {
  if (!code) {
    return null;
  }

  const aliasCode = ORGANIZATION_ALIASES[code] ?? code;

  for (const [pattern, areaCode] of AREA_PREFIX_RULES) {
    if (pattern.test(aliasCode)) {
      return areaCode;
    }
  }

  return aliasCode.replace(/(?:_|)\d+$/g, "");
}

function isDetailedAreaValue(code: string | null, broadAreaCode: string | null) {
  if (!code || !broadAreaCode) {
    return false;
  }

  if (code !== broadAreaCode) {
    return true;
  }

  if (/\d/.test(code)) {
    return true;
  }

  return DISTRICT_PATTERNS.some((pattern) =>
    code.split("_").includes(pattern),
  );
}

export function classifyAreaAndTeam(
  areaValue: unknown,
  explicitTeamValue?: unknown,
) {
  const sourceArea = normalizeOrganizationName(areaValue);
  const explicitTeam = normalizeOrganizationName(explicitTeamValue);
  const areaCode = inferAreaCode(sourceArea.normalizedName);
  const area = organizationNameFromCode(areaCode);
  const sourceIsTeam = isDetailedAreaValue(sourceArea.code, area.code);
  const team = explicitTeam.code
    ? explicitTeam
    : sourceIsTeam
      ? sourceArea
      : organizationNameFromCode(null);

  return {
    area,
    team,
    sourceArea,
  };
}

export function normalizeEmail(value: unknown) {
  const text = normalizeTextValue(value);
  return text ? text.toLowerCase() : null;
}

export function normalizeHrId(value: unknown) {
  return normalizeTextValue(value)?.toUpperCase() ?? null;
}

function toImportDateOnlyString(value: Date | string) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const text = value.trim();
  const datePrefix = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (datePrefix) return `${datePrefix[1]}-${datePrefix[2]}-${datePrefix[3]}`;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isVacancyPlaceholderHrId(value: string | null) {
  if (!value) {
    return false;
  }

  return /^(VAC|VACANCY)[-_ ]*\d+$/i.test(value.trim());
}

export function isValidHrId(value: string) {
  return /^[A-Z0-9][A-Z0-9_-]*$/.test(value);
}

export function normalizeDateValue(value: unknown) {
  if (value instanceof Date) {
    return toImportDateOnlyString(value);
  }

  const text = normalizeTextValue(value);

  if (!text) {
    return null;
  }

  return toImportDateOnlyString(text);
}

export function normalizeNumberValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const text = normalizeTextValue(value);

  if (!text) {
    return null;
  }

  const normalized = text.replace(/,/g, "");
  const numericValue = Number(normalized);

  return Number.isFinite(numericValue) ? numericValue : null;
}

export function createCode(value: string | null) {
  if (!value) {
    return null;
  }

  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

export function createScopedCode(...parts: Array<string | null>) {
  return createCode(parts.filter(Boolean).join("_"));
}
