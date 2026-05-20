import {
  classifyOrganogramStructureLevel,
  isCairoMarketName,
} from "@/lib/reports/organogram-safety";

export type VacancySeatRow = {
  areaId: number | null;
  areaName: string | null;
  jobTitle: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  positionId: number | null;
  positionTitle: string | null;
  regionName: string | null;
  status: string;
  teamId: number | null;
  teamName: string | null;
};

function normalizeSeatPart(value: string | number | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function vacancySeatPart(id: number | null, label: string | null) {
  const normalizedId = normalizeSeatPart(id);
  if (normalizedId) return `id:${normalizedId}`;

  const normalizedLabel = normalizeSeatPart(label);
  return normalizedLabel ? `name:${normalizedLabel}` : "";
}

function managerMarketScope(row: VacancySeatRow) {
  if (
    isCairoMarketName(row.areaName) ||
    isCairoMarketName(row.regionName) ||
    isCairoMarketName(row.teamName)
  ) {
    return "market:cairo";
  }

  return (
    vacancySeatPart(row.areaId, row.areaName) ||
    normalizeSeatPart(row.regionName) ||
    normalizeSeatPart(row.teamName)
  );
}

export function vacancyReportSeatKey(row: VacancySeatRow) {
  const level = classifyOrganogramStructureLevel(row);
  if (!level) return null;

  const line = vacancySeatPart(row.lineId, row.lineName);
  const position = vacancySeatPart(row.positionId, row.positionTitle ?? row.jobTitle);

  if (level === "medicalRep") {
    const area = vacancySeatPart(row.areaId, row.areaName);
    const team = vacancySeatPart(row.teamId, row.teamName);

    if (!line || !area || !position) return null;

    return [
      `level:${level}`,
      `line:${line}`,
      `area:${area}`,
      team ? `team:${team}` : "team:none",
      `position:${position}`,
    ].join("|");
  }

  const market = managerMarketScope(row);
  if (!line || !market || !position) return null;

  return [
    `level:${level}`,
    `line:${line}`,
    `market:${market}`,
    `position:${position}`,
  ].join("|");
}

export function dedupeVacancyReportRows<Row extends VacancySeatRow>(rows: Row[]) {
  const seenSeats = new Set<string>();

  return rows.filter((row) => {
    const key = vacancyReportSeatKey(row);
    if (!key) return true;
    if (seenSeats.has(key)) return false;

    seenSeats.add(key);
    return true;
  });
}
