/**
 * The link from an OPEN SEAT on the organogram to the Add Employee form, pre-filled.
 *
 * Pressing a vacant box on the chart used to end in a popup that described the seat and
 * offered nothing to do about it — whoever was hiring into it then walked to Employees and
 * retyped the line, the area, the position and the manager that the box had just shown them.
 * This carries those four (plus department, region and a human label for the banner) across
 * in the query string, so the form opens on the seat that was pressed.
 *
 * It is a PRE-FILL, not a binding. The employee is still created by the real form, and the
 * seat itself is still resolved server-side by the vacancy-autofill trigger chain on the
 * `employees` insert — this never claims to seat anybody. Everything here is therefore a
 * default the person filling the form can see and change, which is why plain query params
 * are safe: nothing is trusted, only offered.
 */

export type VacancyHireSeat = {
  areaId: string;
  departmentId: string;
  jobTitle: string;
  lineId: string;
  managerHrId: string;
  positionId: string;
  regionName: string;
  /** "Medical Rep · Cairo 1 · CNS" — shown on the form so the seat being filled is named. */
  seatLabel: string;
};

/**
 * The shape this reads off an organogram row. Structural rather than an import of
 * `OrganogramRow` so the employees module does not take a dependency on the reports one.
 */
export type VacancyHireSource = {
  areaId?: number | string | null;
  areaName?: string | null;
  departmentId?: number | string | null;
  jobTitle?: string | null;
  lineId?: number | string | null;
  lineName?: string | null;
  managerHrId?: string | null;
  positionId?: number | string | null;
  positionTitle?: string | null;
  regionName?: string | null;
};

/** Marker param. Present => the form should open pre-filled for a seat. */
export const VACANCY_HIRE_MARKER = "hireVacancy";

const PARAM_KEYS = {
  areaId: "vacancyArea",
  departmentId: "vacancyDepartment",
  jobTitle: "vacancyTitle",
  lineId: "vacancyLine",
  managerHrId: "vacancyManager",
  positionId: "vacancyPosition",
  regionName: "vacancyRegion",
  seatLabel: "vacancySeat",
} as const satisfies Record<keyof VacancyHireSeat, string>;

function text(value: number | string | null | undefined) {
  if (value === null || value === undefined) return "";
  const trimmed = String(value).trim();
  // A numeric id of 0 is not a real id here; every lookup id is a positive identity value.
  return trimmed === "0" ? "" : trimmed;
}

/** "Medical Rep · Cairo 1 · CNS" — whichever of the three the row actually carries. */
export function formatVacancySeatLabel(source: VacancyHireSource) {
  const title = text(source.positionTitle) || text(source.jobTitle);
  const parts = [title, text(source.areaName), text(source.lineName)].filter(Boolean);
  return parts.join(" · ");
}

export function buildVacancyHireSeat(source: VacancyHireSource): VacancyHireSeat {
  return {
    areaId: text(source.areaId),
    departmentId: text(source.departmentId),
    // The chart prefers positionTitle over jobTitle for exactly this reason — an empty-string
    // positionTitle must not blank out a title the job title still carries.
    jobTitle: text(source.positionTitle) || text(source.jobTitle),
    lineId: text(source.lineId),
    managerHrId: text(source.managerHrId),
    positionId: text(source.positionId),
    regionName: text(source.regionName),
    seatLabel: formatVacancySeatLabel(source),
  };
}

/** The query string alone (no leading "?"), marker first. */
export function buildVacancyHireQuery(source: VacancyHireSource) {
  const seat = buildVacancyHireSeat(source);
  const params = new URLSearchParams();
  params.set(VACANCY_HIRE_MARKER, "1");
  for (const [field, key] of Object.entries(PARAM_KEYS) as Array<
    [keyof VacancyHireSeat, string]
  >) {
    const value = seat[field];
    if (value) params.set(key, value);
  }
  return params.toString();
}

/** `/employees?hireVacancy=1&…` — basePath decides admin shell vs employee portal. */
export function buildVacancyHireHref(basePath: string, source: VacancyHireSource) {
  return `${basePath}?${buildVacancyHireQuery(source)}`;
}

/**
 * The hire link for a vacant seat that MAY already have a letter out against it.
 *
 * When an ACCEPTED offer names the seat, the one thing the person hiring wants is that
 * candidate in that chair — so the link goes to the Add Employee form's OFFER prefill
 * (`?fromOffer=<id>`), which fills the candidate's name, the agreed net salary and generates
 * the Employee ID. The seat-only prefill (`?hireVacancy=1&…`) carries the line/area/manager but
 * NOT the person, so hiring an accepted offer through it opened a form blank on name and id, and
 * the form refused to save ("Employee ID / Full Name is required") before anything was ever sent.
 * The offer draft already carries the same seat (it reads the offer's own vacancy), so nothing is
 * lost by dropping the seat params here.
 *
 * Only `accepted` routes this way. A letter merely `sent` is not a hire yet, and a seat with no
 * offer — the common case — keeps the plain seat prefill unchanged.
 */
export function buildSeatHireHref(
  basePath: string,
  source: VacancyHireSource,
  pendingOffer?: { offerId?: string | null; status?: "accepted" | "sent" | null } | null,
): string {
  const offerId =
    pendingOffer?.status === "accepted" ? String(pendingOffer.offerId ?? "").trim() : "";
  if (offerId) {
    return `${basePath}?fromOffer=${encodeURIComponent(offerId)}`;
  }
  return buildVacancyHireHref(basePath, source);
}

/**
 * Read the seat back out. Takes a getter rather than a URLSearchParams so it serves both a
 * plain URLSearchParams and Next's ReadonlyURLSearchParams without a cast.
 *
 * Returns null when the marker is absent, so an unrelated visit to /employees is untouched.
 */
export function readVacancyHireSeat(
  get: (key: string) => string | null,
): VacancyHireSeat | null {
  if (!text(get(VACANCY_HIRE_MARKER))) return null;
  return {
    areaId: text(get(PARAM_KEYS.areaId)),
    departmentId: text(get(PARAM_KEYS.departmentId)),
    jobTitle: text(get(PARAM_KEYS.jobTitle)),
    lineId: text(get(PARAM_KEYS.lineId)),
    managerHrId: text(get(PARAM_KEYS.managerHrId)),
    positionId: text(get(PARAM_KEYS.positionId)),
    regionName: text(get(PARAM_KEYS.regionName)),
    seatLabel: text(get(PARAM_KEYS.seatLabel)),
  };
}

/** Stable identity for one seat prefill — used to apply it exactly once per arrival. */
export function vacancyHireSeatKey(seat: VacancyHireSeat) {
  return [
    seat.lineId,
    seat.areaId,
    seat.positionId,
    seat.departmentId,
    seat.managerHrId,
    seat.jobTitle,
  ].join("|");
}
