import { canonicalHrIdForDisplay } from "@/lib/hr-id";

export type WorkforceSeatInput = {
  areaId?: number | null;
  areaName?: string | null;
  lineId?: number | null;
  lineName?: string | null;
  managerHrId?: string | null;
  positionId?: number | null;
  positionTitle?: string | null;
};

export type WorkforceStructureSummary = {
  activeEmployees: number;
  openVacancies: number;
  totalStructure: number;
  vacancyRate: number;
};

export type SalesContinuityRecord = {
  employeeHrId?: string | null;
  hrId?: string | null;
  line?: string | null;
  lineId?: number | null;
  managerHrId?: string | null;
  territory?: string | null;
};

export type SalesContinuitySeat = WorkforceSeatInput & {
  currentHrId?: string | null;
  previousHrIds?: Array<string | null | undefined>;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function cleanLower(value: unknown) {
  return clean(value).toLowerCase();
}

export function normalizeWorkforceHrId(value: unknown) {
  return canonicalHrIdForDisplay(clean(value));
}

function sameNumber(left: unknown, right: unknown) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
}

function sameText(left: unknown, right: unknown) {
  const leftText = cleanLower(left);
  const rightText = cleanLower(right);
  return Boolean(leftText && rightText && leftText === rightText);
}

export function hasCompleteWorkforceSeat(input: WorkforceSeatInput) {
  return (
    typeof input.areaId === "number" &&
    typeof input.lineId === "number" &&
    typeof input.positionId === "number" &&
    Boolean(normalizeWorkforceHrId(input.managerHrId))
  );
}

export function workforceSeatKey(input: WorkforceSeatInput) {
  if (!hasCompleteWorkforceSeat(input)) return null;
  return [
    Number(input.areaId),
    Number(input.lineId),
    normalizeWorkforceHrId(input.managerHrId),
    Number(input.positionId),
  ].join(":");
}

export function workforceSeatsMatch(left: WorkforceSeatInput, right: WorkforceSeatInput) {
  const leftKey = workforceSeatKey(left);
  const rightKey = workforceSeatKey(right);
  if (leftKey && rightKey) return leftKey === rightKey;

  const lineMatches =
    sameNumber(left.lineId, right.lineId) ||
    sameText(left.lineName, right.lineName);
  const managerMatches =
    !left.managerHrId ||
    !right.managerHrId ||
    normalizeWorkforceHrId(left.managerHrId) === normalizeWorkforceHrId(right.managerHrId);
  const positionMatches =
    sameNumber(left.positionId, right.positionId) ||
    sameText(left.positionTitle, right.positionTitle);
  const areaMatches =
    sameNumber(left.areaId, right.areaId) ||
    sameText(left.areaName, right.areaName);

  return lineMatches && managerMatches && positionMatches && areaMatches;
}

export function shouldCloseVacancyForHire(input: WorkforceSeatInput & { employmentStatus?: string | null }) {
  const status = cleanLower(input.employmentStatus || "active");
  if (["inactive", "resigned", "terminated"].includes(status)) return false;
  return hasCompleteWorkforceSeat(input);
}

export function calculateWorkforceStructureSummary(input: {
  activeEmployees: number;
  openVacancies: number;
}): WorkforceStructureSummary {
  const activeEmployees = Math.max(0, Math.trunc(Number(input.activeEmployees) || 0));
  const openVacancies = Math.max(0, Math.trunc(Number(input.openVacancies) || 0));
  const totalStructure = activeEmployees + openVacancies;

  return {
    activeEmployees,
    openVacancies,
    totalStructure,
    vacancyRate: totalStructure > 0 ? openVacancies / totalStructure : 0,
  };
}

export function continuityHrIds(input: SalesContinuitySeat) {
  return Array.from(
    new Set(
      [input.currentHrId, ...(input.previousHrIds ?? [])]
        .map(normalizeWorkforceHrId)
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

export function salesRecordMatchesSeatContinuity(
  record: SalesContinuityRecord,
  seat: SalesContinuitySeat,
) {
  const hrIds = continuityHrIds(seat);
  const recordHrIds = [
    normalizeWorkforceHrId(record.employeeHrId),
    normalizeWorkforceHrId(record.hrId),
  ].filter(Boolean);
  if (recordHrIds.some((hrId) => hrIds.includes(hrId as string))) return true;

  const managerHrId = normalizeWorkforceHrId(record.managerHrId);
  if (managerHrId && hrIds.includes(managerHrId)) return true;

  const lineMatches =
    sameNumber(record.lineId, seat.lineId) ||
    sameText(record.line, seat.lineName);
  const territoryMatches =
    sameText(record.territory, seat.areaName) ||
    sameText(record.territory, seat.positionTitle);
  const managerMatches =
    !seat.managerHrId ||
    normalizeWorkforceHrId(seat.managerHrId) === managerHrId;

  return lineMatches && territoryMatches && managerMatches;
}
