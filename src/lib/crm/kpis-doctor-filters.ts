/**
 * KPIs — the filters on ONE rep's doctor list, for the Frequency and Coverage reports.
 *
 * DELIBERATELY DEPENDENCY-FREE, for the reason kpis-filters.ts and kpis-tabs.ts give: the bar that
 * edits these is a `"use client"` component, so every runtime import here would travel to the
 * browser. The doctor is described structurally (`KpiDoctorFilterable`), which also keeps the whole
 * engine fixture-testable with no database near it.
 *
 * ## What it can and cannot do
 *
 * The doctor lists are built for ONE rep per page load (kpis-board.ts, `coverageDetail`) so a
 * company-wide doctor list never travels to a browser. These filters therefore narrow the open
 * rep's list and nothing else: they cannot widen the rep set, and a `dq=` typed into the URL for a
 * board with no open rep does nothing at all. The rep-level filters in kpis-filters.ts decide whose
 * list can be opened; these decide which of that rep's doctors are shown.
 *
 * ## The tiles do not move
 *
 * The coverage and frequency tiles above the list describe the rep's WHOLE list and add up to the
 * numbers on his row. Narrowing the table must never change them, so the view filters the rows it
 * prints and leaves the arithmetic on the full list. The table's own heading says "Showing N of M".
 */

/** A doctor row as the filter reads it. `KpiCoverageDoctor` satisfies this structurally. */
export type KpiDoctorFilterable = {
  name: string | null;
  speciality: string | null;
  grade: string | null;
  /** Visits inside the period that count toward coverage. */
  visits: number;
  /** YYYY-MM-DD, or null when there is no visit in the period. */
  lastVisitDate: string | null;
  /** False when every day the plan booked this doctor is still ahead. */
  due: boolean;
  frequency?: { status: string } | undefined;
  /**
   * The brick of the doctor's VALIDATED live photo (`phoenix_crm_places.brick_name`), stamped by the
   * board for the one open rep. Read together with `placeValidated`:
   *   - `placeValidated` undefined: the brick was never read (or the read failed). The doctor is in no
   *     brick, the Brick filter is not offered for him, and he is never called "not validated".
   *   - `placeValidated` false: the read ran and he has no validated customer yet.
   *   - `placeValidated` true and `brick` null: validated, but the photo is further than the trust
   *     radius from any Phoenix brick, or the customer has no active place.
   */
  brick?: string | null;
  placeValidated?: boolean;
};

/** The Frequency report's verdicts, worst first — the order the chips are offered in. */
export const KPI_DOCTOR_STATUSES = [
  "not-visited",
  "below",
  "above",
  "not-due",
  "ungraded",
  "exact",
  "at-norm",
] as const;

export type KpiDoctorStatus = (typeof KPI_DOCTOR_STATUSES)[number];

/** The same words the verdict chips wear (reps-list-activity.ts ACTIVITY_LABEL, "Exact / Below / Above"). */
export const KPI_DOCTOR_STATUS_LABEL: Record<KpiDoctorStatus, string> = {
  "not-visited": "Not visited",
  below: "Below",
  above: "Above",
  "not-due": "Not due yet",
  ungraded: "Ungraded",
  exact: "Exact",
  "at-norm": "At norm",
};

export const KPI_DOCTOR_SEEN = ["covered", "not-covered"] as const;
export type KpiDoctorSeen = (typeof KPI_DOCTOR_SEEN)[number];
export const KPI_DOCTOR_SEEN_LABEL: Record<KpiDoctorSeen, string> = {
  covered: "Covered",
  "not-covered": "Not covered",
};

/** Only a doctor with no visit can be late; a covered doctor is neither late nor early. */
export const KPI_DOCTOR_TIMING = ["late", "not-due"] as const;
export type KpiDoctorTiming = (typeof KPI_DOCTOR_TIMING)[number];
export const KPI_DOCTOR_TIMING_LABEL: Record<KpiDoctorTiming, string> = {
  late: "Late · planned day passed",
  "not-due": "Not due yet",
};

export const KPI_DOCTOR_SORTS = ["default", "name", "speciality", "grade", "visits", "last"] as const;
export type KpiDoctorSort = (typeof KPI_DOCTOR_SORTS)[number];
export const KPI_DOCTOR_SORT_LABEL: Record<KpiDoctorSort, string> = {
  default: "Report order",
  name: "Doctor",
  speciality: "Speciality",
  grade: "Grade",
  visits: "Visits made",
  last: "Last visit",
};

export type KpiDoctorFilter = {
  /** Free text matched against the doctor's name, speciality, grade and brick. */
  query: string;
  specialities: string[];
  /** Brick names, or `KPI_DOCTOR_BRICK_NONE` / `KPI_DOCTOR_NOT_VALIDATED` (owner, 2026-10-29). */
  bricks: string[];
  /** `Grade A`, `Grade B`, `Grade C` or `No grade` — the groups the report's own breakdown uses. */
  grades: string[];
  statuses: KpiDoctorStatus[];
  seen: KpiDoctorSeen[];
  timing: KpiDoctorTiming[];
  visitsMin: number | null;
  visitsMax: number | null;
  /** YYYY-MM-DD bounds on the latest visit; blank is open. */
  lastFrom: string;
  lastTo: string;
  sort: KpiDoctorSort;
  direction: "asc" | "desc";
};

export const EMPTY_KPI_DOCTOR_FILTER: KpiDoctorFilter = {
  query: "",
  specialities: [],
  bricks: [],
  grades: [],
  statuses: [],
  seen: [],
  timing: [],
  visitsMin: null,
  visitsMax: null,
  lastFrom: "",
  lastTo: "",
  sort: "default",
  direction: "asc",
};

/** The URL parameter each doctor filter rides in. Prefixed `d` so none can collide with a rep filter. */
export const KPI_DOCTOR_PARAMS = {
  query: "dq",
  specialities: "dspec",
  bricks: "dbrick",
  grades: "dgrade",
  statuses: "dstat",
  seen: "dseen",
  timing: "dtime",
  visitsMin: "dvmin",
  visitsMax: "dvmax",
  lastFrom: "dfrom",
  lastTo: "dto",
  sort: "dsort",
  direction: "ddir",
} as const;

export const KPI_DOCTOR_PARAM_KEYS: readonly string[] = Object.values(KPI_DOCTOR_PARAMS);

/** The Brick filter's two values that are not a brick name. Brackets keep them clear of any real brick. */
export const KPI_DOCTOR_BRICK_NONE = "(no-brick)";
export const KPI_DOCTOR_BRICK_NONE_LABEL = "Validated · no brick on record";
export const KPI_DOCTOR_NOT_VALIDATED = "(not-validated)";
export const KPI_DOCTOR_NOT_VALIDATED_LABEL = "Not validated yet";

/**
 * The value the Brick filter files a doctor under: his brick's name, `KPI_DOCTOR_BRICK_NONE`,
 * `KPI_DOCTOR_NOT_VALIDATED`, or undefined when the brick was never read — and an undefined doctor
 * matches no brick choice and is counted in no brick.
 */
export function kpiDoctorBrickValue(doctor: Pick<KpiDoctorFilterable, "brick" | "placeValidated">): string | undefined {
  if (doctor.placeValidated === undefined) return undefined;
  if (!doctor.placeValidated) return KPI_DOCTOR_NOT_VALIDATED;
  return doctor.brick?.trim() || KPI_DOCTOR_BRICK_NONE;
}

/** The words a brick value is printed in; undefined (never read) prints nothing. */
export function kpiDoctorBrickLabel(doctor: Pick<KpiDoctorFilterable, "brick" | "placeValidated">): string | undefined {
  const value = kpiDoctorBrickValue(doctor);
  if (value === KPI_DOCTOR_NOT_VALIDATED) return KPI_DOCTOR_NOT_VALIDATED_LABEL;
  if (value === KPI_DOCTOR_BRICK_NONE) return KPI_DOCTOR_BRICK_NONE_LABEL;
  return value;
}

/** The value a facet uses for "this doctor has no speciality on the plan". */
export const KPI_DOCTOR_NO_SPECIALITY = "(none)";
export const KPI_DOCTOR_NO_SPECIALITY_LABEL = "No speciality on the plan";

/** `Grade A` / `Grade B` / `Grade C` / `No grade` — the same grouping the Coverage breakdown prints. */
export function kpiDoctorGradeGroup(grade: string | null): string {
  const letter = (grade ?? "").trim().toUpperCase().charAt(0);
  return letter === "A" || letter === "B" || letter === "C" ? `Grade ${letter}` : "No grade";
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function splitList(raw: string | undefined, separator: string): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(separator)
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  );
}

function keepKnown<T extends string>(values: string[], allowed: readonly T[]): T[] {
  const set = new Set<string>(allowed);
  return values.filter((value): value is T => set.has(value));
}

function wholeNumber(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100000 ? Math.floor(value) : null;
}

/**
 * Reads the doctor filters out of the URL. An unrecognised value is DROPPED, never rendered as an
 * empty list — a blank list reads as "this rep planned nobody", which is a statement about a person.
 */
export function parseKpiDoctorFilter(params: Record<string, string | string[] | undefined>): KpiDoctorFilter {
  const read = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const sortRaw = (read(KPI_DOCTOR_PARAMS.sort) ?? "").trim().toLowerCase();
  const directionRaw = (read(KPI_DOCTOR_PARAMS.direction) ?? "").trim().toLowerCase();
  let visitsMin = wholeNumber(read(KPI_DOCTOR_PARAMS.visitsMin));
  let visitsMax = wholeNumber(read(KPI_DOCTOR_PARAMS.visitsMax));
  if (visitsMin != null && visitsMax != null && visitsMin > visitsMax) [visitsMin, visitsMax] = [visitsMax, visitsMin];
  let lastFrom = (read(KPI_DOCTOR_PARAMS.lastFrom) ?? "").trim();
  let lastTo = (read(KPI_DOCTOR_PARAMS.lastTo) ?? "").trim();
  if (!ISO_DAY.test(lastFrom)) lastFrom = "";
  if (!ISO_DAY.test(lastTo)) lastTo = "";
  if (lastFrom && lastTo && lastFrom > lastTo) [lastFrom, lastTo] = [lastTo, lastFrom];
  return {
    query: (read(KPI_DOCTOR_PARAMS.query) ?? "").trim().slice(0, 120),
    // A pipe, not a comma: a speciality's own name may carry a comma.
    specialities: splitList(read(KPI_DOCTOR_PARAMS.specialities), "|"),
    // A pipe for the same reason: a brick's name may carry a comma.
    bricks: splitList(read(KPI_DOCTOR_PARAMS.bricks), "|"),
    grades: splitList(read(KPI_DOCTOR_PARAMS.grades), ","),
    statuses: keepKnown(splitList(read(KPI_DOCTOR_PARAMS.statuses), ","), KPI_DOCTOR_STATUSES),
    seen: keepKnown(splitList(read(KPI_DOCTOR_PARAMS.seen), ","), KPI_DOCTOR_SEEN),
    timing: keepKnown(splitList(read(KPI_DOCTOR_PARAMS.timing), ","), KPI_DOCTOR_TIMING),
    visitsMin,
    visitsMax,
    lastFrom,
    lastTo,
    sort: (KPI_DOCTOR_SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as KpiDoctorSort) : "default",
    direction: directionRaw === "desc" ? "desc" : "asc",
  };
}

/** Serialises the doctor filters, omitting everything at its default. */
export function kpiDoctorFilterToParams(filter: KpiDoctorFilter): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, values: readonly string[], separator = ",") => {
    if (values.length > 0) out[key] = values.join(separator);
  };
  if (filter.query.trim()) out[KPI_DOCTOR_PARAMS.query] = filter.query.trim();
  put(KPI_DOCTOR_PARAMS.specialities, filter.specialities, "|");
  put(KPI_DOCTOR_PARAMS.bricks, filter.bricks, "|");
  put(KPI_DOCTOR_PARAMS.grades, filter.grades);
  put(KPI_DOCTOR_PARAMS.statuses, filter.statuses);
  put(KPI_DOCTOR_PARAMS.seen, filter.seen);
  put(KPI_DOCTOR_PARAMS.timing, filter.timing);
  if (filter.visitsMin != null) out[KPI_DOCTOR_PARAMS.visitsMin] = String(filter.visitsMin);
  if (filter.visitsMax != null) out[KPI_DOCTOR_PARAMS.visitsMax] = String(filter.visitsMax);
  if (filter.lastFrom) out[KPI_DOCTOR_PARAMS.lastFrom] = filter.lastFrom;
  if (filter.lastTo) out[KPI_DOCTOR_PARAMS.lastTo] = filter.lastTo;
  if (filter.sort !== "default") out[KPI_DOCTOR_PARAMS.sort] = filter.sort;
  if (filter.direction !== "asc") out[KPI_DOCTOR_PARAMS.direction] = filter.direction;
  return out;
}

/** Whether any doctor filter narrows the list. Sort order alone does not. */
export function hasActiveKpiDoctorFilter(filter: KpiDoctorFilter): boolean {
  return countActiveKpiDoctorFilter(filter) > 0;
}

/** How many doctor filters are live — the number on the bar's button. */
export function countActiveKpiDoctorFilter(filter: KpiDoctorFilter): number {
  return (
    (filter.query.trim() ? 1 : 0) +
    filter.specialities.length +
    filter.bricks.length +
    filter.grades.length +
    filter.statuses.length +
    filter.seen.length +
    filter.timing.length +
    (filter.visitsMin != null || filter.visitsMax != null ? 1 : 0) +
    (filter.lastFrom || filter.lastTo ? 1 : 0)
  );
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Whether one doctor passes every filter. Within one filter the choices are OR-ed, across filters AND-ed. */
export function matchesKpiDoctorFilter(doctor: KpiDoctorFilterable, filter: KpiDoctorFilter): boolean {
  const needle = filter.query.trim().toLowerCase();
  if (needle) {
    const haystack = [doctor.name, doctor.speciality, doctor.grade, doctor.brick].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (filter.specialities.length > 0) {
    const speciality = norm(doctor.speciality);
    const hit = filter.specialities.some((choice) =>
      norm(choice) === KPI_DOCTOR_NO_SPECIALITY ? speciality === "" : norm(choice) === speciality,
    );
    if (!hit) return false;
  }
  if (filter.bricks.length > 0) {
    // A doctor whose brick was never read is in NO brick — never silently in "not validated".
    const brick = kpiDoctorBrickValue(doctor);
    if (brick === undefined || !filter.bricks.some((choice) => norm(choice) === norm(brick))) return false;
  }
  if (filter.grades.length > 0 && !filter.grades.includes(kpiDoctorGradeGroup(doctor.grade))) return false;
  if (filter.statuses.length > 0) {
    const status = doctor.frequency?.status;
    if (!status || !(filter.statuses as readonly string[]).includes(status)) return false;
  }
  const covered = doctor.visits > 0;
  if (filter.seen.length > 0 && !filter.seen.includes(covered ? "covered" : "not-covered")) return false;
  if (filter.timing.length > 0) {
    const timing: KpiDoctorTiming | null = covered ? null : doctor.due ? "late" : "not-due";
    if (!timing || !filter.timing.includes(timing)) return false;
  }
  if (filter.visitsMin != null && doctor.visits < filter.visitsMin) return false;
  if (filter.visitsMax != null && doctor.visits > filter.visitsMax) return false;
  if (filter.lastFrom || filter.lastTo) {
    if (!doctor.lastVisitDate) return false;
    if (filter.lastFrom && doctor.lastVisitDate < filter.lastFrom) return false;
    if (filter.lastTo && doctor.lastVisitDate > filter.lastTo) return false;
  }
  return true;
}

function sortKey(doctor: KpiDoctorFilterable, sort: KpiDoctorSort): string | number | null {
  switch (sort) {
    case "name":
      return doctor.name ? doctor.name.toLowerCase() : null;
    case "speciality":
      return doctor.speciality ? doctor.speciality.toLowerCase() : null;
    case "grade":
      return kpiDoctorGradeGroup(doctor.grade);
    case "visits":
      return doctor.visits;
    case "last":
      return doctor.lastVisitDate;
    default:
      return null;
  }
}

/**
 * Filters a doctor list and, when a sort other than the report's own is asked for, orders it.
 *
 * The report order is the builder's (covered newest first, not-covered oldest booking first; the
 * Frequency list is worst verdict first), so `default` returns the narrowed list untouched. A doctor
 * with nothing to sort on parks last in BOTH directions, as the rep table does, so "last visit,
 * oldest first" starts with the doctor seen longest ago and not with the ones never seen.
 */
export function filterKpiDoctors<T extends KpiDoctorFilterable>(doctors: readonly T[], filter: KpiDoctorFilter): T[] {
  const kept = doctors.filter((doctor) => matchesKpiDoctorFilter(doctor, filter));
  if (filter.sort === "default") return kept;
  const sign = filter.direction === "desc" ? -1 : 1;
  return kept
    .map((doctor, index) => ({ doctor, index, key: sortKey(doctor, filter.sort) }))
    .sort((left, right) => {
      if (left.key == null && right.key == null) return left.index - right.index;
      if (left.key == null) return 1;
      if (right.key == null) return -1;
      if (left.key === right.key) return left.index - right.index;
      return (left.key < right.key ? -1 : 1) * sign;
    })
    .map((entry) => entry.doctor);
}

export type KpiDoctorFacetOption = { value: string; label: string; count: number };

export type KpiDoctorFacets = {
  specialities: KpiDoctorFacetOption[];
  /** Empty when no doctor's brick was read, so the bar offers no Brick filter at all. */
  bricks: KpiDoctorFacetOption[];
  grades: KpiDoctorFacetOption[];
  statuses: KpiDoctorFacetOption[];
  seen: KpiDoctorFacetOption[];
  timing: KpiDoctorFacetOption[];
};

/**
 * The options each doctor filter offers, counted against the rep's WHOLE list — so a choice that
 * would return nobody is never offered, and the counts do not collapse onto whatever is selected.
 */
export function buildKpiDoctorFacets(doctors: readonly KpiDoctorFilterable[]): KpiDoctorFacets {
  const specialities = new Map<string, KpiDoctorFacetOption>();
  const bricks = new Map<string, KpiDoctorFacetOption>();
  const grades = new Map<string, number>();
  const statuses = new Map<string, number>();
  let covered = 0;
  let late = 0;
  let notDue = 0;
  for (const doctor of doctors) {
    const raw = doctor.speciality?.trim() ?? "";
    const value = raw || KPI_DOCTOR_NO_SPECIALITY;
    const slot = specialities.get(value) ?? {
      value,
      label: raw || KPI_DOCTOR_NO_SPECIALITY_LABEL,
      count: 0,
    };
    slot.count += 1;
    specialities.set(value, slot);
    const brick = kpiDoctorBrickValue(doctor);
    if (brick !== undefined) {
      const brickSlot = bricks.get(brick) ?? { value: brick, label: kpiDoctorBrickLabel(doctor) ?? brick, count: 0 };
      brickSlot.count += 1;
      bricks.set(brick, brickSlot);
    }
    const grade = kpiDoctorGradeGroup(doctor.grade);
    grades.set(grade, (grades.get(grade) ?? 0) + 1);
    const status = doctor.frequency?.status;
    if (status) statuses.set(status, (statuses.get(status) ?? 0) + 1);
    if (doctor.visits > 0) covered += 1;
    else if (doctor.due) late += 1;
    else notDue += 1;
  }
  const only = (rows: KpiDoctorFacetOption[]) => rows.filter((row) => row.count > 0);
  return {
    specialities: [...specialities.values()].sort((left, right) => {
      if (left.value === KPI_DOCTOR_NO_SPECIALITY) return 1;
      if (right.value === KPI_DOCTOR_NO_SPECIALITY) return -1;
      return left.label.localeCompare(right.label);
    }),
    // Brick names A to Z; the validated-no-brick and the not-validated doctors park last, in that order.
    bricks: [...bricks.values()].sort((left, right) => {
      const rank = (value: string) => (value === KPI_DOCTOR_NOT_VALIDATED ? 2 : value === KPI_DOCTOR_BRICK_NONE ? 1 : 0);
      return rank(left.value) - rank(right.value) || left.label.localeCompare(right.label);
    }),
    grades: [...grades]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    statuses: KPI_DOCTOR_STATUSES.filter((status) => (statuses.get(status) ?? 0) > 0).map((status) => ({
      value: status,
      label: KPI_DOCTOR_STATUS_LABEL[status],
      count: statuses.get(status) ?? 0,
    })),
    seen: only([
      { value: "covered", label: KPI_DOCTOR_SEEN_LABEL.covered, count: covered },
      { value: "not-covered", label: KPI_DOCTOR_SEEN_LABEL["not-covered"], count: doctors.length - covered },
    ]),
    timing: only([
      { value: "late", label: KPI_DOCTOR_TIMING_LABEL.late, count: late },
      { value: "not-due", label: KPI_DOCTOR_TIMING_LABEL["not-due"], count: notDue },
    ]),
  };
}
