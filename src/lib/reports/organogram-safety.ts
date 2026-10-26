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

/**
 * The key one sales seat is counted under. A seat-model row counts BY ITS SEAT (2026-10-26): a seat
 * in handover is drawn twice — the leaver until her last day and her successor — and it is still
 * ONE seat, filled. Counting people there gave Pedia "37 employees" over "32 / 47" seats. A row with
 * no seat (the legacy mirror) keeps the old person / vacancy-slot key.
 */
export function organogramSeatCountKey(row: OrganogramReportRow): string {
  if (row.seatId) return `seat:${row.seatId}`;
  // Dedupe key intentionally excludes the array index so genuinely duplicated
  // logical rows (same person / same vacancy slot) collapse to a single KPI
  // count instead of being counted twice.
  return row.type === "vacancy"
    ? `vacancy:${normalizeCode(row.vacancyCode ?? row.hrId)}:${row.sourceRowNumber ?? ""}`
    : `${row.type}:${normalizeCode(row.hrId)}:${row.vacancyCode ?? ""}:${row.sourceRowNumber ?? ""}`;
}

export function calculateOrganogramStructureKpis(rows: OrganogramReportRow[]) {
  const summary: StructureKpiSummary = {
    dsm: emptyKpi(),
    medicalRep: emptyKpi(),
    nsm: emptyKpi(),
    rsm: emptyKpi(),
    total: emptyKpi(),
  };
  // One entry per seat. A seat is FILLED when anyone sits on it, whichever of its rows came first.
  const seats = new Map<string, { filled: boolean; level: StructureKpiLevel }>();

  rows.forEach((row) => {
    const level = classifyOrganogramStructureLevel(row);
    if (!level) return;
    const key = organogramSeatCountKey(row);
    const seat = seats.get(key);
    if (seat) {
      if (row.type !== "vacancy") seat.filled = true;
      return;
    }
    seats.set(key, { filled: row.type !== "vacancy", level });
  });

  seats.forEach(({ filled, level }) => {
    summary[level].total += 1;
    summary.total.total += 1;
    if (filled) {
      summary[level].actual += 1;
      summary.total.actual += 1;
    } else {
      summary[level].vacant += 1;
      summary.total.vacant += 1;
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

// Statuses on position_vacancies that mean the seat was deliberately REMOVED
// from the fixed structure (not merely vacated). These always hide a seat.
function isRemovedVacancyStatus(status: string | null | undefined) {
  const normalized = normalizeText(status);
  return (
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "closed" ||
    normalized === "removed"
  );
}

// The identity of a FIXED structural seat: its level + line + area + the manager
// it reports to. The org structure per line is fixed — each area under a manager
// is ONE seat, either FILLED (an active employee is on this key) or VACANT (no
// active employee is). This is the authoritative filled/vacant signal and it is
// INDEPENDENT of the mutable position_vacancies.status: a resigned-but-unreplaced
// area (whose stale record may still say "filled") stays visible as vacant, and a
// re-hired area's stale vacancy record is hidden. Area is keyed by SPECIFIC name
// only — region is never a fallback (a broad region like "Cairo" spans many
// distinct area seats, so matching on it could wrongly mark a real vacant area as
// filled). Rows without a specific area/line/manager are under-specified and
// return null, so they are never suppressed on a guess.
//
// Exported (and narrowed to just the fields it reads) so callers outside the
// organogram tree — e.g. reconciling the flat position_vacancies-sourced
// Vacancy Report against the organogram's own occupancy truth — can reuse this
// exact key instead of standing up a second, parallel "is this seat filled"
// implementation.
export function seatOccupancyKey(
  row: Pick<OrganogramReportRow, "jobTitle" | "positionTitle" | "managerHrId" | "managerName" | "areaName" | "lineName">,
): string | null {
  const level = classifyOrganogramStructureLevel(row);
  if (!level) return null;

  const manager = normalizeCode(row.managerHrId) || normalizeText(row.managerName);
  const area = normalizeText(row.areaName);
  const line = normalizeText(row.lineName);

  if (!area || !line || !manager) return null;

  return `${level}|${line}|${area}|${manager}`;
}

// The PHYSICAL seat identity: level + line + specific area, WITHOUT the manager.
// The org model is one seat per area per line — the manager (an NSM/RSM one level
// up) is not what makes an area seat distinct. seatOccupancyKey deliberately
// includes the manager, which is correct for the common case but breaks when the
// manager one level up changes: the occupant's manager shifts (e.g. B-157 -> the
// new NSM AI-0008) while a stale FILLED vacancy record keeps the OLD manager, so
// the two manager-aware keys never match and the filled area wrongly renders as a
// phantom vacant box. This manager-agnostic key lets suppression recognize that
// the physical area is occupied regardless of which manager either record names.
// Area is the SPECIFIC name only (never region) for the same reason as
// seatOccupancyKey — a broad region spans many area seats.
export function seatIdentityKey(
  row: Pick<OrganogramReportRow, "jobTitle" | "positionTitle" | "areaName" | "lineName">,
): string | null {
  const level = classifyOrganogramStructureLevel(row);
  if (!level) return null;

  const area = normalizeText(row.areaName);
  const line = normalizeText(row.lineName);

  if (!area || !line) return null;

  return `${level}|${line}|${area}`;
}

export function suppressFilledVacancyRows(rows: OrganogramReportRow[]) {
  // Seats occupied by an active employee. Occupancy — not the status field —
  // decides filled-vs-vacant, so the fixed area structure never loses a seat to
  // an employee's lifecycle: hire fills the seat, resignation empties it.
  const occupiedSeatKeys = new Set<string>();
  // The same occupancy keyed manager-agnostically (level|line|area), but ONLY for
  // MANAGER-level seats (DSM/RSM/NSM). There is exactly one such seat per area per
  // line, so a stale FILLED vacancy that still points at a PREVIOUS manager (e.g.
  // after the NSM one level up changed) is recognized as filled and hidden instead
  // of rendering as a phantom "Open Seat" next to the real hire. Rep areas are NOT
  // collapsed this way: a broad rep area (e.g. "Cairo") can legitimately repeat
  // under two different DSMs, so a filled rep area must never hide another DSM's
  // same-named rep seat — rep occupancy stays manager-aware via occupiedSeatKeys.
  const occupiedManagerSeatIdentityKeys = new Set<string>();
  for (const row of rows) {
    if (row.type !== "employee") continue;
    const key = seatOccupancyKey(row);
    if (key) occupiedSeatKeys.add(key);
    const level = classifyOrganogramStructureLevel(row);
    if (level === "dsm" || level === "rsm" || level === "nsm") {
      const identity = seatIdentityKey(row);
      if (identity) occupiedManagerSeatIdentityKeys.add(identity);
    }
  }

  // Physical seats that already have a vacancy record carrying a REAL manager id.
  // A second record for the same physical seat that has only a free-text
  // placeholder manager (no manager_hr_id, e.g. a stale "Vacant Cairo District
  // Manager" stub left over after the area's real DSM was hired) is debris — the
  // real-manager record is the canonical box, so the placeholder is dropped to
  // stop one area rendering twice. Two DISTINCT real managers for one area are
  // left untouched (a genuine, if rare, split): only the id-less placeholder loses.
  const seatIdentityHasRealManagerVacancy = new Set<string>();
  for (const row of rows) {
    if (row.type !== "vacancy") continue;
    if (!classifyOrganogramStructureLevel(row)) continue;
    if (isRemovedVacancyStatus(row.status)) continue;
    if (!normalizeCode(row.managerHrId)) continue;
    const identity = seatIdentityKey(row);
    if (identity) seatIdentityHasRealManagerVacancy.add(identity);
  }

  // One vacant box per fixed seat: collapse duplicate vacancy records (several
  // import/resignation rows for the same area under the same manager) to one.
  const emittedSeatKeys = new Set<string>();
  const seenVacancyCodes = new Set<string>();

  return rows.filter((row) => {
    if (row.type !== "vacancy") return true;

    const level = classifyOrganogramStructureLevel(row);
    if (!level) return true;

    // Deliberately-removed seats never render.
    if (isRemovedVacancyStatus(row.status)) return false;

    // A manager-level (DSM/RSM/NSM) vacancy with no manager to report to AND no
    // seat-continuity marker is structurally unplaceable (a vacant manager seat
    // must report to a known manager). These are orphaned import/test debris.
    const isManagerLevelSeat = level === "dsm" || level === "rsm" || level === "nsm";
    if (
      isManagerLevelSeat &&
      !normalizeCode(row.managerHrId) &&
      !normalizeCode(row.managerReplacementForHrId)
    ) {
      return false;
    }

    const identityKey = seatIdentityKey(row);

    // A MANAGER-level physical seat (one DSM/RSM/NSM per area per line) that is
    // occupied by an active employee → this vacancy is stale, even if it names a
    // different (older) manager than the occupant now reports to. Hide it. (Fixes
    // phantom vacant DSM seats after an NSM change.) Rep seats are excluded here on
    // purpose: two reps can share a broad area name under different DSMs, so a rep
    // vacancy is only suppressed when its manager also matches (the seatKey path).
    if (isManagerLevelSeat && identityKey && occupiedManagerSeatIdentityKeys.has(identityKey)) {
      return false;
    }

    // A manager-less placeholder for a seat that also has a real-manager record →
    // drop the placeholder so the area doesn't render twice. (Fixes a same-area
    // duplicate rep seat: one real record + one leftover "Vacant … Manager" stub.)
    if (
      identityKey &&
      !normalizeCode(row.managerHrId) &&
      seatIdentityHasRealManagerVacancy.has(identityKey)
    ) {
      return false;
    }

    const seatKey = seatOccupancyKey(row);
    if (seatKey) {
      // Seat filled by an active employee → the stale vacancy record is hidden.
      if (occupiedSeatKeys.has(seatKey)) return false;
      // Duplicate vacancy record for a seat already shown → collapse to one box.
      if (emittedSeatKeys.has(seatKey)) return false;
      emittedSeatKeys.add(seatKey);
      return true;
    }

    // No resolvable seat key (missing area/line/manager) — dedupe by code only so
    // a genuinely under-specified vacancy still renders exactly once.
    const vacancyCodeKey = normalizeCode(row.vacancyCode ?? row.hrId);
    if (vacancyCodeKey) {
      if (seenVacancyCodes.has(vacancyCodeKey)) return false;
      seenVacancyCodes.add(vacancyCodeKey);
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
