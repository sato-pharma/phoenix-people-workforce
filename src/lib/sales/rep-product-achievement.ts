// ─────────────────────────────────────────────────────────────────────────────
// REP ACHIEVEMENT BY PRODUCT — the Training Manager's view of every rep, product by product,
// month by month, with the quarter and the semester beside the months.
//
// Owner, 2026-10-26: "for the training manager ... filter by line, she finds reps' achievement per
// product %, only — ex July Aug Sep Q3 Oct Nov Dec Q4 S2 — Gaumycin 70% July, 80% Aug and so on ...
// make her able to filter, export to xlsx".
//
// CLIENT-SAFE. This file holds the shapes, the period columns, the one filter and the sort the page
// and the export BOTH use — so the file she downloads is always the list she was looking at. The
// arithmetic that produces a cell lives in `rep-product-achievement-build.ts` (server and tests),
// the reads in `rep-product-achievement-server.ts`.
//
// WHAT A CELL IS. Percent only, never money (her words: "per product % only"). A cell is ALL of the
// rep's sales of that product over the column's PUBLISHED months, divided once by the target over the
// same months — the closing engine's arithmetic and the Rankings board's (vs-target.ts, rankings.ts).
// A quarter is summed and divided once, never an average of its three monthly percentages. A month
// whose line has not published its closing reads "not published", never a live number and never 0%.
// ─────────────────────────────────────────────────────────────────────────────

export const REP_ACHIEVEMENT_ALL = "all";

export type SemesterKey = string; // "2026-S2"

export type PeriodColumnKind = "month" | "quarter" | "semester";

export type PeriodColumn = {
  /** "2026-07", "2026-Q3", "2026-S2". */
  id: string;
  /** "Jul", "Q3", "S2" — the head of the on-screen column. */
  label: string;
  /** "July 2026", "Q3 2026", "S2 2026" — the export's head and the mobile card's label. */
  fullLabel: string;
  kind: PeriodColumnKind;
  /** The months the column sums, ascending. */
  months: string[];
};

/**
 * - `graded`      — a published month carried a target; `value` is the ratio (0.7 = 70%).
 * - `no-target`   — published, sales or not, but no target to divide by. NEVER 0%.
 * - `none`        — published, and this rep had neither a sale nor a target of this product.
 * - `unpublished` — every month of the column that has started is still unpublished for the line.
 * - `upcoming`    — no month of the column has started yet.
 */
export type AchievementCellState = "graded" | "no-target" | "none" | "unpublished" | "upcoming";

export type AchievementCell = {
  state: AchievementCellState;
  /** The ratio, only when `state === "graded"`. Negative is legitimate (returns). */
  value: number | null;
  /** A quarter or semester graded on fewer months than it holds — "to date". */
  partial: boolean;
};

export type RepAchievementProduct = {
  productCode: string;
  productName: string;
  cells: AchievementCell[];
};

export type RepAchievementRecord = {
  /** `${lineCode}|${hr key}` — one row per rep per line. */
  key: string;
  lineCode: string;
  lineName: string;
  name: string;
  jobTitle: string;
  areaName: string;
  regionName: string;
  managerName: string;
  /** His hire date from the employee list, date-only (`YYYY-MM-DD`); null when HR never entered one. */
  hireDate: string | null;
  /** Left the company — his months stay his (seat-tenure credit), tagged so she can tell. */
  left: boolean;
  /** Every product of his together — by VALUE, the only way products may be added. */
  overall: AchievementCell[];
  products: RepAchievementProduct[];
};

export type RepAchievementOption = { value: string; label: string };

export type RepAchievementData = {
  semester: SemesterKey;
  semesters: RepAchievementOption[];
  columns: PeriodColumn[];
  lines: RepAchievementOption[];
  records: RepAchievementRecord[];
  /** Per line, the months of this semester whose closing is published — for the page's notes. */
  publishedMonths: Record<string, string[]>;
  /** The current Cairo month — a column holding a later month is graded "to date". */
  currentPeriod: string;
  generatedAt: string;
};

export type RepAchievementFilters = {
  line: string;
  region: string;
  manager: string;
  /** A product code, or REP_ACHIEVEMENT_ALL. */
  product: string;
  status: "active" | "left" | "all";
  search: string;
};

export const DEFAULT_REP_ACHIEVEMENT_FILTERS: RepAchievementFilters = {
  line: REP_ACHIEVEMENT_ALL,
  manager: REP_ACHIEVEMENT_ALL,
  product: REP_ACHIEVEMENT_ALL,
  region: REP_ACHIEVEMENT_ALL,
  search: "",
  status: "all",
};

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SEMESTER_PATTERN = /^(\d{4})-S([12])$/;
const PERIOD_PATTERN = /^(\d{4})-(\d{2})$/;

export function isSemesterKey(value: string | null | undefined): value is SemesterKey {
  return typeof value === "string" && SEMESTER_PATTERN.test(value);
}

/** The semester a "YYYY-MM" month falls in. */
export function semesterOf(period: string): SemesterKey {
  const match = PERIOD_PATTERN.exec(period);
  if (!match) return period;
  return `${match[1]}-S${Number(match[2]) <= 6 ? 1 : 2}`;
}

/** The six months of a semester, ascending. */
export function semesterMonths(semester: SemesterKey): string[] {
  const match = SEMESTER_PATTERN.exec(semester);
  if (!match) return [];
  const first = match[2] === "1" ? 1 : 7;
  return Array.from({ length: 6 }, (_, index) => `${match[1]}-${String(first + index).padStart(2, "0")}`);
}

export function semesterLabel(semester: SemesterKey): string {
  const match = SEMESTER_PATTERN.exec(semester);
  if (!match) return semester;
  return match[2] === "1" ? `S1 ${match[1]} · January to June` : `S2 ${match[1]} · July to December`;
}

/**
 * Jul · Aug · Sep · Q3 · Oct · Nov · Dec · Q4 · S2 — her order, word for word: each quarter
 * straight after its three months, the semester last.
 */
export function semesterColumns(semester: SemesterKey): PeriodColumn[] {
  const match = SEMESTER_PATTERN.exec(semester);
  if (!match) return [];
  const year = match[1];
  const half = Number(match[2]);
  const months = semesterMonths(semester);
  const columns: PeriodColumn[] = [];
  for (let quarter = 0; quarter < 2; quarter += 1) {
    const quarterMonths = months.slice(quarter * 3, quarter * 3 + 3);
    for (const month of quarterMonths) {
      const index = Number(month.slice(5, 7)) - 1;
      columns.push({
        fullLabel: `${MONTH_LONG[index]} ${year}`,
        id: month,
        kind: "month",
        label: MONTH_SHORT[index],
        months: [month],
      });
    }
    const quarterNumber = (half - 1) * 2 + quarter + 1;
    columns.push({
      fullLabel: `Q${quarterNumber} ${year}`,
      id: `${year}-Q${quarterNumber}`,
      kind: "quarter",
      label: `Q${quarterNumber}`,
      months: quarterMonths,
    });
  }
  columns.push({ fullLabel: `S${half} ${year}`, id: semester, kind: "semester", label: `S${half}`, months });
  return columns;
}

/** Every semester from the floor's to the current month's, newest first. */
export function semesterOptions(floorPeriod: string, currentPeriod: string): RepAchievementOption[] {
  const first = semesterOf(floorPeriod);
  const last = semesterOf(currentPeriod);
  if (!isSemesterKey(first) || !isSemesterKey(last)) return [];
  const options: RepAchievementOption[] = [];
  let cursor = first;
  for (let guard = 0; guard < 40 && cursor <= last; guard += 1) {
    options.push({ label: semesterLabel(cursor), value: cursor });
    const [year, half] = [Number(cursor.slice(0, 4)), cursor.endsWith("S1") ? 1 : 2];
    cursor = half === 1 ? `${year}-S2` : `${year + 1}-S1`;
  }
  return options.reverse();
}

// ── Reading a cell ──────────────────────────────────────────────────────────

const HIRE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

/** "12 Mar 2024", read straight off the date-only string so no timezone can move the day; null when absent. */
export function formatRepHireDate(hireDate: string | null | undefined): string | null {
  const match = hireDate?.match(HIRE_DATE_PATTERN);
  if (!match) return null;
  const month = MONTH_SHORT[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : null;
}

/** "70%" — whole percent on screen, as she wrote it. The export keeps the exact ratio. */

export function formatAchievementPercent(value: number): string {
  const percent = value * 100;
  const rounded = Math.round(percent);
  return `${Object.is(rounded, -0) ? 0 : rounded}%`;
}

const CELL_WORDS: Record<Exclude<AchievementCellState, "graded">, { short: string; long: string }> = {
  "no-target": { long: "No target", short: "No target" },
  none: { long: "No sales and no target", short: "—" },
  unpublished: { long: "Closing not published yet", short: "Not published" },
  upcoming: { long: "Not started yet", short: "Upcoming" },
};

/** What a cell says, in words — the screen and the export read the same words. */
export function describeAchievementCell(cell: AchievementCell): { short: string; long: string } {
  if (cell.state === "graded" && cell.value != null) {
    const text = formatAchievementPercent(cell.value);
    return { long: cell.partial ? `${text} to date` : text, short: text };
  }
  return CELL_WORDS[cell.state === "graded" ? "no-target" : cell.state];
}

/** The tone band a graded value sits in — 100% and over, 80% to 99%, under 80%. */
export function achievementBand(value: number | null): "good" | "warn" | "bad" | null {
  if (value == null) return null;
  if (value >= 1) return "good";
  if (value >= 0.8) return "warn";
  return "bad";
}

/** A graded cell's value, or null — the sort and the counts read only real percentages. */
export function gradedValue(cell: AchievementCell | undefined): number | null {
  return cell && cell.state === "graded" ? cell.value : null;
}

// ── The one filter ──────────────────────────────────────────────────────────

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * The records her filters keep. A product filter keeps only that product on each rep and drops a
 * rep who never carried it — the page and the export call this, never a second copy.
 */
export function filterRepAchievement(
  records: readonly RepAchievementRecord[],
  filters: RepAchievementFilters,
): RepAchievementRecord[] {
  const search = norm(filters.search);
  const out: RepAchievementRecord[] = [];
  for (const record of records) {
    if (filters.line !== REP_ACHIEVEMENT_ALL && record.lineCode !== filters.line) continue;
    if (filters.region !== REP_ACHIEVEMENT_ALL && record.regionName !== filters.region) continue;
    if (filters.manager !== REP_ACHIEVEMENT_ALL && record.managerName !== filters.manager) continue;
    if (filters.status === "active" && record.left) continue;
    if (filters.status === "left" && !record.left) continue;
    if (search) {
      const haystack = norm(
        [record.name, record.areaName, record.regionName, record.managerName, record.jobTitle, record.lineName].join(" "),
      );
      if (!haystack.includes(search)) continue;
    }
    if (filters.product !== REP_ACHIEVEMENT_ALL) {
      const products = record.products.filter((product) => product.productCode === filters.product);
      if (products.length === 0) continue;
      out.push({ ...record, products });
      continue;
    }
    out.push(record);
  }
  return out;
}

/** The cells the "by product" table reads for one record: the picked product's, or his overall. */
export function focusCells(record: RepAchievementRecord, productCode: string): AchievementCell[] {
  if (productCode === REP_ACHIEVEMENT_ALL) return record.overall;
  return record.products.find((product) => product.productCode === productCode)?.cells ?? [];
}

export type RepAchievementSort = { column: number; direction: "asc" | "desc" } | { column: "name"; direction: "asc" | "desc" };

/**
 * Highest first on the chosen column; a cell with no percentage always sinks to the bottom in both
 * directions — "no target" is not the worst performer and must never read as one.
 */
export function sortRepAchievement(
  records: readonly RepAchievementRecord[],
  productCode: string,
  sort: RepAchievementSort,
): RepAchievementRecord[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...records].sort((left, right) => {
    if (sort.column === "name") return sign * left.name.localeCompare(right.name);
    const a = gradedValue(focusCells(left, productCode)[sort.column]);
    const b = gradedValue(focusCells(right, productCode)[sort.column]);
    if (a == null && b == null) return left.name.localeCompare(right.name);
    if (a == null) return 1;
    if (b == null) return -1;
    return sign * (a - b) || left.name.localeCompare(right.name);
  });
}

/** The options each filter offers, read off the records the line filter leaves. */
export function repAchievementFilterOptions(records: readonly RepAchievementRecord[], line: string) {
  const inLine = line === REP_ACHIEVEMENT_ALL ? records : records.filter((record) => record.lineCode === line);
  const regions = new Set<string>();
  const managers = new Set<string>();
  const products = new Map<string, string>();
  for (const record of inLine) {
    if (record.regionName) regions.add(record.regionName);
    if (record.managerName) managers.add(record.managerName);
    for (const product of record.products) products.set(product.productCode, product.productName);
  }
  const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b));
  return {
    managers: sorted(managers),
    products: [...products.entries()]
      .map(([value, label]) => ({ label, value }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    regions: sorted(regions),
  };
}

/** Her filters as a query string — the export link carries exactly what the page shows. */
export function repAchievementQuery(semester: SemesterKey, filters: RepAchievementFilters): string {
  const params = new URLSearchParams();
  params.set("semester", semester);
  if (filters.line !== REP_ACHIEVEMENT_ALL) params.set("line", filters.line);
  if (filters.region !== REP_ACHIEVEMENT_ALL) params.set("region", filters.region);
  if (filters.manager !== REP_ACHIEVEMENT_ALL) params.set("manager", filters.manager);
  if (filters.product !== REP_ACHIEVEMENT_ALL) params.set("product", filters.product);
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.search.trim()) params.set("q", filters.search.trim());
  return params.toString();
}

/** The same query read back — the route's half of `repAchievementQuery`. */
export function parseRepAchievementFilters(params: URLSearchParams): RepAchievementFilters {
  const pick = (key: string) => {
    const value = params.get(key)?.trim();
    return value ? value : REP_ACHIEVEMENT_ALL;
  };
  const status = params.get("status");
  return {
    line: pick("line"),
    manager: pick("manager"),
    product: pick("product"),
    region: pick("region"),
    search: (params.get("q") ?? "").slice(0, 120),
    status: status === "active" || status === "left" ? status : "all",
  };
}
