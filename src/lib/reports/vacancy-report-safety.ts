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
  if (normalizeSeatPart(row.status) !== "open") return null;

  const level = classifyOrganogramStructureLevel(row);
  if (!level || level === "medicalRep") return null;

  const line = vacancySeatPart(row.lineId, row.lineName);
  const market = managerMarketScope(row);
  const position = vacancySeatPart(row.positionId, row.positionTitle ?? row.jobTitle);

  if (!line || !market || !position) return null;

  return [
    `level:${level}`,
    `line:${line}`,
    `market:${market}`,
    `position:${position}`,
  ].join("|");
}

export function dedupeVacancyReportRows<Row extends VacancySeatRow>(rows: Row[]) {
  const seenManagerSeats = new Set<string>();

  return rows.filter((row) => {
    const key = vacancyReportSeatKey(row);
    if (!key) return true;
    if (seenManagerSeats.has(key)) return false;

    seenManagerSeats.add(key);
    return true;
  });
}
