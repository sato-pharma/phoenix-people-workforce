import type { OrganogramReportRow } from "@/lib/reports/vacancies";

export type StructureKpiLevel = "medicalRep" | "dsm" | "nsm" | "rsm";

export type StructureKpi = {
  actual: number;
  total: number;
  vacant: number;
};

export type StructureKpiSummary = Record<StructureKpiLevel | "total", StructureKpi>;

const emptyKpi = (): StructureKpi => ({ actual: 0, total: 0, vacant: 0 });

function normalizeText(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function normalizeCode(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "";
  return String(value).trim().toUpperCase();
}

export function organogramTitleText(row: Pick<OrganogramReportRow, "jobTitle" | "positionTitle">) {
  return `${row.positionTitle ?? row.jobTitle ?? ""}`.trim().toLowerCase();
}

export function classifyOrganogramStructureLevel(
  row: Pick<OrganogramReportRow, "jobTitle" | "positionTitle">,
): StructureKpiLevel | null {
  const title = organogramTitleText(row);

  if (title.includes("medical representative") || title.includes("medical rep")) {
    return "medicalRep";
  }

  if (
    title.includes("district sales manager") ||
    title.includes("district manager") ||
    title === "dsm"
  ) {
    return "dsm";
  }

  if (title.includes("national sales manager") || title === "nsm") {
    return "nsm";
  }

  if (title.includes("regional sales manager") || title === "rsm") {
    return "rsm";
  }

  return null;
}

export function isOrganogramSalesStructureRole(
  row: Pick<OrganogramReportRow, "jobTitle" | "positionTitle">,
) {
  return classifyOrganogramStructureLevel(row) !== null;
}

export function calculateOrganogramStructureKpis(rows: OrganogramReportRow[]) {
  const summary: StructureKpiSummary = {
    dsm: emptyKpi(),
    medicalRep: emptyKpi(),
    nsm: emptyKpi(),
    rsm: emptyKpi(),
    total: emptyKpi(),
  };
  const counted = new Set<string>();

  rows.forEach((row, index) => {
    const level = classifyOrganogramStructureLevel(row);
    const key = row.type === "vacancy"
      ? `vacancy:${normalizeCode(row.vacancyCode ?? row.hrId)}:${row.sourceRowNumber ?? ""}:${index}`
      : `${row.type}:${normalizeCode(row.hrId)}:${row.vacancyCode ?? ""}:${row.sourceRowNumber ?? ""}:${index}`;

    if (!level || counted.has(key)) {
      return;
    }

    counted.add(key);
    summary[level].total += 1;
    summary.total.total += 1;

    if (row.type === "vacancy") {
      summary[level].vacant += 1;
      summary.total.vacant += 1;
    } else {
      summary[level].actual += 1;
      summary.total.actual += 1;
    }
  });

  return summary;
}

export function publicVacancyLabel(vacancyCode: string | null | undefined) {
  const raw = String(vacancyCode ?? "").trim();
  const legacyResignationMatch = raw.match(/^resignation_([^_]+)_(\d{8,})$/i);
  const generatedResignationMatch = raw.match(/^resignation_vac_(\d{8,})(?:_([a-z0-9]+))?$/i);
  const resignationStamp = generatedResignationMatch?.[1] ?? legacyResignationMatch?.[2];

  if (resignationStamp) {
    return `VAC-RES-${resignationStamp.slice(-6)}`;
  }

  if (/^resignation/i.test(raw)) {
    const compact = normalizeCode(raw).replace(/[^A-Z0-9]+/g, "");
    let hash = 0;

    for (const char of compact) {
      hash = (hash * 31 + char.charCodeAt(0)) % 1000000;
    }

    return `VAC-RES-${String(hash).padStart(6, "0")}`;
  }

  const vacancyMatch = raw.match(/^vacancy_(?:vac_)?(\d+)/i);

  if (vacancyMatch) {
    return `VAC-${vacancyMatch[1]}`;
  }

  if (raw.length > 18 && !raw.toUpperCase().startsWith("VAC-")) {
    const compact = normalizeCode(raw).replace(/[^A-Z0-9]+/g, "");
    return compact ? `VAC-${compact.slice(-6)}` : raw;
  }

  return raw;
}

function slotPart(id: string | number | null | undefined, label: string | null | undefined) {
  const normalizedId = normalizeCode(id);
  if (normalizedId) return `id:${normalizedId}`;

  const normalizedLabel = normalizeText(label);
  return normalizedLabel ? `name:${normalizedLabel}` : "";
}

function areaSlot(row: OrganogramReportRow) {
  return slotPart(row.areaId, row.areaName) || (normalizeText(row.regionName) ? `region:${normalizeText(row.regionName)}` : "");
}

export function organogramPositionSlotKey(row: OrganogramReportRow) {
  const level = classifyOrganogramStructureLevel(row);
  const manager = normalizeCode(row.managerHrId);
  const line = slotPart(row.lineId, row.lineName);
  const area = areaSlot(row);
  const team = slotPart(row.teamId, row.teamName);
  const position = slotPart(row.positionId, row.positionTitle ?? row.jobTitle);
  const department = slotPart(row.departmentId, row.departmentName);

  if (!manager || !line || !area || !position) {
    return null;
  }

  return [
    level ? `level:${level}` : "level:other",
    `manager:${manager}`,
    `line:${line}`,
    `area:${area}`,
    team ? `team:${team}` : "team:none",
    `position:${position}`,
    department ? `department:${department}` : "department:none",
  ].join("|");
}

function exactEmployeeFilledSlotKey(row: OrganogramReportRow) {
  const level = classifyOrganogramStructureLevel(row);
  const slotKey = organogramPositionSlotKey(row);

  if (!level || !slotKey) {
    return null;
  }

  // Medical Representative headcount is not one natural slot per
  // manager/area/team/title. Cairo teams can have several active reps plus
  // valid open boxes with the same metadata, so suppressing by natural key
  // hides real vacancies. Preserve those vacancies unless lifecycle status
  // has explicitly closed/filled them.
  if (level === "medicalRep") {
    return null;
  }

  const hasTeamContext = Boolean(slotPart(row.teamId, row.teamName));
  const broadArea =
    isCairoMarketName(row.areaName) ||
    normalizeText(row.areaName) === "greater cairo" ||
    normalizeText(row.regionName) === "greater cairo";

  // A broad Cairo manager slot without team context is not unique enough to
  // prove that an active manager fills the exact vacancy box.
  if (!hasTeamContext && broadArea) {
    return null;
  }

  return slotKey;
}

// For broad-area Cairo manager vacancies (no team context → exact slot key unavailable),
// build a softer match key: level + RSM manager + line. Used to suppress vacancies when
// an active employee already covers that same combination.
function softManagerLineKey(row: OrganogramReportRow): string | null {
  const level = classifyOrganogramStructureLevel(row);
  if (!level || level === "medicalRep") return null;

  const hasTeamContext = Boolean(slotPart(row.teamId, row.teamName));
  const broadArea =
    isCairoMarketName(row.areaName) ||
    normalizeText(row.areaName) === "greater cairo" ||
    normalizeText(row.regionName) === "greater cairo";

  if (hasTeamContext || !broadArea) return null;

  const manager = normalizeCode(row.managerHrId);
  const line = slotPart(row.lineId, row.lineName);
  if (!manager || !line) return null;

  return `soft|level:${level}|manager:${manager}|line:${line}`;
}

export function suppressFilledVacancyRows(rows: OrganogramReportRow[]) {
  const filledSlots = new Set<string>();
  const softFilledCounts = new Map<string, number>();

  for (const row of rows) {
    if (row.type !== "employee") continue;
    const level = classifyOrganogramStructureLevel(row);
    if (!level) continue;

    const slotKey = exactEmployeeFilledSlotKey(row);
    if (slotKey) {
      filledSlots.add(slotKey);
    }

    const softKey = softManagerLineKey(row);
    if (softKey) {
      softFilledCounts.set(softKey, (softFilledCounts.get(softKey) ?? 0) + 1);
    }
  }

  const seenOpenVacancySlots = new Set<string>();
  const softSuppressedCounts = new Map<string, number>();

  return rows.filter((row) => {
    if (row.type !== "vacancy") return true;

    const level = classifyOrganogramStructureLevel(row);
    if (!level) return true;

    if (normalizeText(row.status) && normalizeText(row.status) !== "open") return false;

    const slotKey = exactEmployeeFilledSlotKey(row);
    if (slotKey && filledSlots.has(slotKey)) return false;

    // For broad Cairo manager vacancies where exact slot matching is unavailable,
    // suppress vacancies up to the count of active employees at the same level/RSM/line.
    // This handles the case where a resigned Cairo DSM was replaced but the vacancy row
    // was never explicitly closed in the DB.
    if (!slotKey) {
      const softKey = softManagerLineKey(row);
      if (softKey) {
        const actualCount = softFilledCounts.get(softKey) ?? 0;
        const suppressedSoFar = softSuppressedCounts.get(softKey) ?? 0;
        if (suppressedSoFar < actualCount) {
          softSuppressedCounts.set(softKey, suppressedSoFar + 1);
          return false;
        }
      }
    }

    const vacancyCodeKey = normalizeCode(row.vacancyCode ?? row.hrId);
    if (vacancyCodeKey) {
      if (seenOpenVacancySlots.has(vacancyCodeKey)) return false;
      seenOpenVacancySlots.add(vacancyCodeKey);
    }

    return true;
  });
}

export function sanitizeOrganogramVacancyCodes(rows: OrganogramReportRow[]) {
  return rows.map((row) => {
    if (row.type !== "vacancy") return row;
    const label = publicVacancyLabel(row.vacancyCode ?? row.hrId);

    return {
      ...row,
      hrId: label,
      vacancyCode: label,
    };
  });
}

export function applyOrganogramMirrorSafety(rows: OrganogramReportRow[]) {
  return sanitizeOrganogramVacancyCodes(suppressFilledVacancyRows(rows));
}

const cairoAliases = new Set([
  "cairo",
  "greater cairo",
  "new cairo",
  "nasr city",
  "heliopolis",
  "maadi",
  "mokattam",
  "shorouk",
  "obour",
  "rehab",
  "madinaty",
  "tagamoa",
  "tagamo3",
  "fifth settlement",
  "5th settlement",
  "sheraton",
  "zamalek",
  "downtown cairo",
  "ain shams",
  "el marg",
  "helwan",
  "shubra",
  "hadayek el kobba",
]);

export function isCairoMarketName(value: string | null | undefined) {
  const normalized = normalizeText(value);
  return Boolean(normalized) && (
    cairoAliases.has(normalized) ||
    normalized.includes("cairo") ||
    normalized.includes("shoubra") ||
    normalized.includes("shubra") ||
    normalized.includes("downtown")
  );
}

function broadCairoSlot(value: string | null | undefined) {
  const normalized = normalizeText(value);
  return normalized === "cairo" || normalized === "greater cairo";
}

export function districtBucketMatches(member: OrganogramReportRow, managerSlot: OrganogramReportRow) {
  const sameLine =
    slotPart(member.lineId, member.lineName) &&
    slotPart(member.lineId, member.lineName) === slotPart(managerSlot.lineId, managerSlot.lineName);

  if (!sameLine) return false;

  const managerArea = managerSlot.areaName ?? managerSlot.regionName;
  const memberArea = member.areaName ?? member.regionName ?? member.teamName;

  if (broadCairoSlot(managerArea)) {
    return (
      isCairoMarketName(member.areaName) ||
      isCairoMarketName(member.regionName) ||
      isCairoMarketName(member.teamName)
    );
  }

  const managerAreaKey = slotPart(managerSlot.areaId, managerSlot.areaName);
  const memberAreaKey = slotPart(member.areaId, member.areaName);
  const managerRegion = normalizeText(managerSlot.regionName);
  const memberRegion = normalizeText(member.regionName);

  return Boolean(
    (managerAreaKey && managerAreaKey === memberAreaKey) ||
      (managerRegion && managerRegion === memberRegion) ||
      (managerArea && normalizeText(managerArea) === normalizeText(memberArea)),
  );
}
