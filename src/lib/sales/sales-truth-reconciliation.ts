// ─────────────────────────────────────────────────────────────────────────────
// ONE AREA, ONE NUMBER. The reconciliation that makes a sales mismatch impossible to ship quietly.
//
// Monthly Closing is the only sales truth in this system. Four surfaces quote a per-area monthly
// sales figure, and they reach it by three different routes:
//
//   1. Monthly Closing — the screen, the frozen XLSX export, and the premium .xlsm engine. All
//      three call loadMonthlyClosingPartsWithStoreSplit, so they share one matrix by construction
//      and cannot disagree (tests/closing-export-matches-screen.test.ts pins the XLSX half).
//   2. Sales vs Target, the portal, employee-360, the business review, SFE team performance and
//      the canonical admin dashboard — every one of them reads loadAchievementRange, i.e. the SQL
//      function phx_sales_vs_target_range.
//   3. Source of Sales — its own aggregates over the import rollup.
//
// Route 1 applies TypeScript transforms that route 2 has never seen: the owner's hand-mapped July
// direct orders (july-2026-direct-orders.ts), the Fayoum/Beni Suef area merge, the store city
// split, and the organogram region relabelling. Whenever one of those places money on an area that
// the database does not itself carry, the two routes print different numbers for the same area and
// nothing anywhere notices.
//
// THAT IS NOT HYPOTHETICAL — it was live in production on the only published month when this file
// was written (2026-09-01). For Anti Infective 2026-07, 149,288.50 EGP of direct orders sits on a
// BLANK area_code in source_of_sales_fact_rollup. Monthly Closing spreads it across 12 real areas
// from the owner's overlay; Sales vs Target leaves it unattributed. Kafr El-Sheikh 1 read 30,123.30
// on one screen and 3,651.30 on the other — the same area, the same month, 8x apart. Pedia's
// equivalent money was stamped into the database on 2026-08-07 and reconciles perfectly, which is
// exactly why the defect is invisible: two of three lines look fine.
//
// ── WHY VALUE AND NOT UNITS ──────────────────────────────────────────────────────────────────
// An area row totals across products, and units of different products are never added in this
// company (owner's rule). So a unit total is not a quantity anybody may quote, and comparing one
// would manufacture disagreements out of a number neither screen is entitled to print. Money is
// additive across products; money is what this reconciles.
//
// ── PURE, AND A LEAF ON PURPOSE ──────────────────────────────────────────────────────────────
// Structural input types, no imports. The loaders live in ./sales-truth-report.ts, which reaches
// the database. Keeping the arithmetic here means the test suite can prove the comparator fires
// without a network round trip, and a client component can render a report object safely.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bucket every surface must use for money it could not tie to an area.
 *
 * Both routes produce such money and they spell it differently: the closing invents a synthetic
 * pseudo-area coded "DIRECT", the achievement engine returns a null/empty `area_code`. Folding
 * both onto one key is what lets "the closing attributed it, the achievement engine did not" show
 * up as two findings that balance — an area short by X, and X sitting in UNATTRIBUTED — instead
 * of one silent hole.
 */
// Spelled in the SAME case the keys are built in, deliberately. `salesTruthKey` upper-cases every
// area code, so a lower-case sentinel would key as "(UNATTRIBUTED)" when it arrives as a value and
// as "(unattributed)" when it arrives as the empty-string fallback — two buckets for one concept,
// splitting exactly the money this file exists to keep whole.
export const UNATTRIBUTED_AREA = "(UNATTRIBUTED)";

/** The bucket for rows carrying no line at all. They belong to no closing, so they are always a finding. */
export const UNLINED = "(no line)";

/** The synthetic area code injectDirectIntoMatrix stamps on the company Direct row. */
const SYNTHETIC_DIRECT_AREA_CODE = "DIRECT";

/** Money below this is rounding, not a discrepancy. One piastre. */
export const SALES_TRUTH_TOLERANCE_EGP = 0.01;

export type SalesAreaTotal = {
  lineCode: string;
  areaCode: string;
  salesValue: number;
  /** Human-readable labels where the source carries them. Codes are never shown to the owner alone. */
  lineName?: string;
  areaName?: string;
  regionName?: string;
};

/** `${lineCode}|${areaCode}` -> total. Built by the two builders below and never by hand. */
export type SalesAreaTotals = Map<string, SalesAreaTotal>;

export type SalesTruthFinding = {
  /** Which surface disagreed with the closing. */
  surface: string;
  lineCode: string;
  areaCode: string;
  /** What to print. Never show the owner a bare code — his standing rule. */
  lineName: string;
  areaName: string;
  regionName: string;
  /** What Monthly Closing says — the truth. */
  closingValue: number;
  /** What the other surface says. */
  surfaceValue: number;
  /** surfaceValue - closingValue. Negative means the surface under-reports the area. */
  diff: number;
  kind: "value-mismatch" | "missing-on-surface" | "absent-from-closing";
};

export type SalesTruthSurfaceResult = {
  surface: string;
  ok: boolean;
  findings: SalesTruthFinding[];
  /** Σ|diff| — the total money misplaced between the two views. */
  totalAbsDiff: number;
  /** Σ diff — near zero when money was merely moved between areas rather than lost. */
  netDiff: number;
  closingTotal: number;
  surfaceTotal: number;
};

export type SalesTruthReport = {
  period: string;
  ok: boolean;
  surfaces: SalesTruthSurfaceResult[];
  /** Lines whose closing could not be read at all — never silently treated as zero. */
  unreadableLines: string[];
  generatedAt: string;
};

function upper(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/** `${lineCode}|${areaCode}`, both normalised. The only key any of this compares on. */
export function salesTruthKey(lineCode: string | null | undefined, areaCode: string | null | undefined): string {
  const line = String(lineCode ?? "").trim().toLowerCase() || UNLINED;
  const area = upper(areaCode) || UNATTRIBUTED_AREA; // sentinel is already upper-case — see above
  return `${line}|${area}`;
}

function addTo(
  totals: SalesAreaTotals,
  lineCode: string,
  areaCode: string,
  salesValue: number,
  labels?: { lineName?: string; areaName?: string; regionName?: string },
): void {
  const key = salesTruthKey(lineCode, areaCode);
  const existing = totals.get(key);
  if (existing) {
    existing.salesValue += salesValue;
    // First non-empty label wins. A later row for the same area cannot blank a name already found.
    existing.lineName ||= labels?.lineName;
    existing.areaName ||= labels?.areaName;
    existing.regionName ||= labels?.regionName;
    return;
  }
  const [line, area] = key.split("|");
  totals.set(key, {
    lineCode: line,
    areaCode: area,
    salesValue,
    lineName: labels?.lineName,
    areaName: labels?.areaName,
    regionName: labels?.regionName,
  });
}

/** The slice of a closing matrix this module reads — structural, so nothing has to import back. */
export type ClosingMatrixShape = {
  regions: ReadonlyArray<{
    areas: ReadonlyArray<{
      areaCode: string;
      areaName?: string;
      regionName?: string;
      isDirect?: boolean;
      rowTotal: { salesValue: number };
    }>;
  }>;
};

/**
 * THE TRUTH. Per-area money exactly as the Monthly Closing screen renders it.
 *
 * The synthetic company-Direct pseudo-area folds into UNATTRIBUTED rather than becoming an area
 * called "DIRECT": it is money with no geography, which is precisely what the achievement engine's
 * blank `area_code` also means. A real area that merely *absorbed* hand-mapped direct money keeps
 * its own code — reading `isDirect` alone would rename Dakahlia 1 and drop it out of the
 * comparison entirely (see closing-direct-area.ts for why that flag answers two questions).
 */
export function closingAreaTotals(
  matrix: ClosingMatrixShape,
  lineCode: string,
  lineName?: string,
): SalesAreaTotals {
  const totals: SalesAreaTotals = new Map();
  for (const region of matrix.regions) {
    for (const area of region.areas) {
      const synthetic =
        Boolean(area.isDirect) && upper(area.areaCode) === SYNTHETIC_DIRECT_AREA_CODE;
      addTo(totals, lineCode, synthetic ? UNATTRIBUTED_AREA : area.areaCode, area.rowTotal.salesValue, {
        lineName,
        areaName: synthetic ? undefined : area.areaName,
        regionName: synthetic ? undefined : area.regionName,
      });
    }
  }
  return totals;
}

/** The slice of an achievement row this module reads. Matches AchievementRow structurally. */
export type AchievementRowShape = {
  lineCode: string | null;
  areaCode: string | null;
  actualValue: number;
};

/**
 * Per-area money as every achievement-engine surface reports it.
 *
 * Feed this rows that have ALREADY been through applyAchievementAreaMerges — the closing folds
 * Fayoum into Beni Suef on Pedia and CNS, so comparing unmerged rows would report that merge as a
 * two-area discrepancy on every single month. `loadSalesTruthReport` does the merge for you.
 */
export function achievementAreaTotals(rows: readonly AchievementRowShape[]): SalesAreaTotals {
  const totals: SalesAreaTotals = new Map();
  for (const row of rows) {
    addTo(totals, row.lineCode ?? UNLINED, row.areaCode ?? UNATTRIBUTED_AREA, row.actualValue);
  }
  return totals;
}

/**
 * Compare one surface against the closing and report every area that disagrees.
 *
 * Both directions are findings, and they are named differently on purpose. An area the closing
 * knows and the surface does not (`missing-on-surface`) is a rep or a district reading low. A
 * line/area the surface carries and the closing does not (`absent-from-closing`) is money being
 * reported that the source of truth never booked — which is how the 462 EGP of line-less rows in
 * phx_sales_vs_target_range came to light.
 */
export function reconcileAreaTotals(input: {
  surface: string;
  truth: SalesAreaTotals;
  candidate: SalesAreaTotals;
  toleranceEgp?: number;
}): SalesTruthSurfaceResult {
  const tolerance = input.toleranceEgp ?? SALES_TRUTH_TOLERANCE_EGP;
  const findings: SalesTruthFinding[] = [];
  let closingTotal = 0;
  let surfaceTotal = 0;

  for (const total of input.truth.values()) closingTotal += total.salesValue;
  for (const total of input.candidate.values()) surfaceTotal += total.salesValue;

  for (const key of new Set([...input.truth.keys(), ...input.candidate.keys()])) {
    const truthRow = input.truth.get(key);
    const candidateRow = input.candidate.get(key);
    const closingValue = truthRow?.salesValue ?? 0;
    const surfaceValue = candidateRow?.salesValue ?? 0;
    // Rounded to the piastre before it is judged. These are money columns, and in binary floats
    // 100.01 - 100 is 0.010000000000005116 — a hair over a one-piastre tolerance, so an exact
    // rounding difference would be reported as a discrepancy and the owner would be sent chasing
    // a figure that is right. It also keeps the reported diff printable.
    const diff = Math.round((surfaceValue - closingValue) * 100) / 100;
    if (Math.abs(diff) <= tolerance) continue;

    const [lineCode, areaCode] = key.split("|");
    // Names come from whichever side carries them — in practice the closing, since the achievement
    // engine returns codes only. An area the closing has never heard of has no name anywhere, and
    // showing its code is then the honest answer rather than inventing one.
    const labelled = truthRow ?? candidateRow;
    findings.push({
      surface: input.surface,
      lineCode,
      areaCode,
      lineName: labelled?.lineName?.trim() || lineCode,
      areaName: labelled?.areaName?.trim() || areaCode,
      regionName: labelled?.regionName?.trim() || "",
      closingValue,
      surfaceValue,
      diff,
      kind: !truthRow ? "absent-from-closing" : !candidateRow ? "missing-on-surface" : "value-mismatch",
    });
  }

  findings.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    surface: input.surface,
    ok: findings.length === 0,
    findings,
    totalAbsDiff: findings.reduce((sum, finding) => sum + Math.abs(finding.diff), 0),
    netDiff: findings.reduce((sum, finding) => sum + finding.diff, 0),
    closingTotal,
    surfaceTotal,
  };
}

/**
 * One human sentence per surface. Written for the owner, not for a log reader.
 *
 * The net-vs-gross distinction is the whole diagnosis and is stated explicitly: a net of zero with
 * a large gross means the month's total is right and the money is on the wrong AREAS, which is the
 * failure mode that survives every total-level check anyone has ever written here.
 */
export function describeSurfaceResult(result: SalesTruthSurfaceResult): string {
  if (result.ok) return `${result.surface}: matches Monthly Closing on every area.`;
  const areas = result.findings.length === 1 ? "1 area" : `${result.findings.length} areas`;
  const money = result.totalAbsDiff.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const shape =
    Math.abs(result.netDiff) <= SALES_TRUTH_TOLERANCE_EGP
      ? "the line total is right, so this is money sitting on the wrong areas"
      : `the total is off by ${result.netDiff.toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP as well`;
  return `${result.surface}: ${areas} disagree with Monthly Closing, ${money} EGP misplaced — ${shape}.`;
}
