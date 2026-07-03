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
  // Prefer a non-empty positionTitle; an empty-string positionTitle falls back to
  // jobTitle so classification/KPIs don't blank out on "" (vs null).
  return String((row.positionTitle?.trim() ? row.positionTitle : row.jobTitle) ?? "")
    .trim()
    .toLowerCase();
}

export function classifyOrganogramStructureLevel(
  row: Pick<OrganogramReportRow, "jobTitle" | "positionTitle">,
): StructureKpiLevel | null {
  const title = organogramTitleText(row);

  if (
    title.includes("medical representative") ||
    title.includes("medical rep") ||
    title === "mr"
  ) {
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

  rows.forEach((row) => {
    const level = classifyOrganogramStructureLevel(row);
    // Dedupe key intentionally excludes the array index so genuinely duplicated
    // logical rows (same person / same vacancy slot) collapse to a single KPI
    // count instead of being counted twice.
    const key = row.type === "vacancy"
      ? `vacancy:${normalizeCode(row.vacancyCode ?? row.hrId)}:${row.sourceRowNumber ?? ""}`
      : `${row.type}:${normalizeCode(row.hrId)}:${row.vacancyCode ?? ""}:${row.sourceRowNumber ?? ""}`;

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

// Base-36 hash of the FULL input string (never a truncated substring), so two
// distinct DB-unique codes can't collapse to the same suffix just because they
// share a common tail. This matters concretely for resignation vacancy codes:
// the timestamp segment is YYYYMMDDHHMMSS (14 digits), so slicing the last 6
// digits keeps only HH:MM:SS and discards the date entirely — two resignations
// on different dates at the same clock time would otherwise produce an
// identical label, and since sanitizeOrganogramVacancyCodes rewrites both hrId
// and vacancyCode to that label, the two rows would collide under the same
// rowKey and one would silently vanish from the chart. Base-36 also packs far
// more entropy per character than base-10 (36^6 ≈ 2.2B vs 10^6 = 1M values),
// shrinking the residual birthday-paradox collision risk for the ~1M+ space.
function hashSuffix(input: string, length = 6): string {
  let hash = 0;
  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(length, "0").slice(-length);
}

export function publicVacancyLabel(vacancyCode: string | null | undefined) {
  const raw = String(vacancyCode ?? "").trim();

  if (/^resignation/i.test(raw)) {
    return `VAC-RES-${hashSuffix(raw)}`;
  }

  const vacancyMatch = raw.match(/^vacancy_(?:vac_)?(\d+)/i);

  if (vacancyMatch) {
    return `VAC-${vacancyMatch[1]}`;
  }

  if (raw.length > 18 && !raw.toUpperCase().startsWith("VAC-")) {
    return raw ? `VAC-${hashSuffix(raw)}` : raw;
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
    isCairoMarketName(row.regionName);

  // A broad Cairo manager slot without team context is not unique enough to
  // prove that an active manager fills the exact vacancy box.
  if (!hasTeamContext && broadArea) {
    return null;
  }

  return slotKey;
}

export function suppressFilledVacancyRows(rows: OrganogramReportRow[]) {
  // Count active employees per slot key rather than a boolean "filled" flag.
  // organogramPositionSlotKey has no per-seat instance number, so two
  // co-located seats of the same title/manager/line/area/team/department
  // (e.g. 2 budgeted DSM headcount on one team, one filled, one open) share
  // an identical key. N active employees on a key can plausibly explain away
  // at most N same-key vacancies as "already filled, stale record" — any
  // vacancy beyond that count is a genuinely open additional seat and must
  // not be suppressed just because the key collides with a filled one.
  const filledSlotCounts = new Map<string, number>();

  for (const row of rows) {
    if (row.type !== "employee") continue;
    const level = classifyOrganogramStructureLevel(row);
    if (!level) continue;

    const slotKey = exactEmployeeFilledSlotKey(row);
    if (slotKey) {
      filledSlotCounts.set(slotKey, (filledSlotCounts.get(slotKey) ?? 0) + 1);
    }
  }

  const suppressedSlotCounts = new Map<string, number>();
  const seenOpenVacancySlots = new Set<string>();

  return rows.filter((row) => {
    if (row.type !== "vacancy") return true;

    const level = classifyOrganogramStructureLevel(row);
    if (!level) return true;

    if (normalizeText(row.status) && normalizeText(row.status) !== "open") return false;

    const slotKey = exactEmployeeFilledSlotKey(row);
    if (slotKey) {
      const filledCount = filledSlotCounts.get(slotKey) ?? 0;
      const suppressedSoFar = suppressedSlotCounts.get(slotKey) ?? 0;
      if (suppressedSoFar < filledCount) {
        suppressedSlotCounts.set(slotKey, suppressedSoFar + 1);
        return false;
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
