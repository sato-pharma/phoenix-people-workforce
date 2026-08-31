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

/**
 * One row per structural seat — and when several rows claim the same seat, the OPEN one.
 *
 * Rows arrive newest-first, so "keep the first" used to mean "keep the newest", and a newer
 * `cancelled` or `filled` row silently ate the open row behind it. That is not a hypothetical:
 * on 2026-08-31 the Anti Infective rep seat in Nasr City (`SEAT-AIF-REP-CA2`) had three rows —
 * 174 filled (May), 298 open (18 Jul), 300 cancelled (20 Jul) — the organogram called the seat
 * VACANT, and the cancelled row won. The consequence was invisible rather than loud: the seat
 * vanished from the requisition and CV-send pickers, and `createRequisition` answered "Selected
 * vacancy was not found." for an id the screening page had just offered.
 *
 * Preferring open cannot resurrect a seat somebody actually sits in: `reconcileVacancyRowsAgainstOccupancy`
 * reads live occupancy afterwards and turns a stale open row back into a filled one. Status here is
 * a mutable import artefact; occupancy is the fact. Same reasoning as `organogramVacancyRows`, which
 * already refuses to drop a seat because a stale record marks it filled.
 */
export function dedupeVacancyReportRows<Row extends VacancySeatRow>(rows: Row[]) {
  // Which row SPEAKS for each seat. An open row wins over any other status whatever its date;
  // between two rows of equal standing the first (newest) still wins, exactly as before.
  const spokesman = new Map<string, Row>();
  for (const row of rows) {
    const key = vacancyReportSeatKey(row);
    if (!key) continue;
    const held = spokesman.get(key);
    if (!held) spokesman.set(key, row);
    else if (held.status !== "open" && row.status === "open") spokesman.set(key, row);
  }

  const emitted = new Set<string>();
  return rows.filter((row) => {
    const key = vacancyReportSeatKey(row);
    // A row that maps to no structural seat is not a duplicate of anything — keep every one.
    if (!key) return true;
    if (emitted.has(key) || spokesman.get(key) !== row) return false;

    emitted.add(key);
    return true;
  });
}
