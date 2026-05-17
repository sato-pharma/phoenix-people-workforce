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
    const key = `${row.type}:${row.hrId}:${row.vacancyCode ?? ""}:${row.sourceRowNumber ?? ""}:${index}`;

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
  const legacyResignationMatch = raw.match(/^resignation_[^_]+_(\d{8,})$/i);
  const generatedResignationMatch = raw.match(/^resignation_vac_(\d{8,})(?:_[a-z0-9]+)?$/i);
  const resignationStamp = generatedResignationMatch?.[1] ?? legacyResignationMatch?.[1];

  if (resignationStamp) {
    return `VAC-RES-${resignationStamp.slice(-6)}`;
  }

  const vacancyMatch = raw.match(/^vacancy_(?:vac_)?(\d+)/i);

  return vacancyMatch ? `VAC-${vacancyMatch[1]}` : raw;
}

function slotPart(id: string | number | null | undefined, label: string | null | undefined) {
  const normalizedId = normalizeCode(id);
  if (normalizedId) return `id:${normalizedId}`;

  const normalizedLabel = normalizeText(label);
  return normalizedLabel ? `name:${normalizedLabel}` : "";
}

export function organogramPositionSlotKey(row: OrganogramReportRow) {
  const manager = normalizeCode(row.managerHrId);
  const line = slotPart(row.lineId, row.lineName);
  const area = slotPart(row.areaId, row.areaName);
  const team = slotPart(row.teamId, row.teamName);
  const position = slotPart(row.positionId, row.positionTitle ?? row.jobTitle);
  const department = slotPart(row.departmentId, row.departmentName);

  if (!manager || !line || !area || !position) {
    return null;
  }

  return [
    `manager:${manager}`,
    `line:${line}`,
    `area:${area}`,
    team ? `team:${team}` : "team:none",
    `position:${position}`,
    department ? `department:${department}` : "department:none",
  ].join("|");
}

export function suppressFilledVacancyRows(rows: OrganogramReportRow[]) {
  const filledSlots = new Set<string>();

  for (const row of rows) {
    if (row.type !== "employee") continue;
    const slotKey = organogramPositionSlotKey(row);
    if (slotKey) filledSlots.add(slotKey);
  }

  const seenOpenVacancySlots = new Set<string>();

  return rows.filter((row) => {
    if (row.type !== "vacancy") return true;
    if (normalizeText(row.status) && normalizeText(row.status) !== "open") return false;

    const slotKey = organogramPositionSlotKey(row);
    if (!slotKey) return true;
    if (filledSlots.has(slotKey)) return false;
    if (seenOpenVacancySlots.has(slotKey)) return false;

    seenOpenVacancySlots.add(slotKey);
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
  return Boolean(normalized) && (cairoAliases.has(normalized) || normalized.includes("cairo"));
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
