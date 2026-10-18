// Weekly Sales — serializable shapes for the upload pipeline and dashboard. A separate module from
// the monthly Source-of-Sales surface; nothing here is read by or merged with the monthly tables.

import type { WeeklyVerifyAiState } from "@/lib/sales/weekly/verify-ai-state";

export type WeeklyValidationIssue = {
  field: string;
  message: string;
  rowNumber: number;
  severity: "failure" | "warning";
  value: string | null;
};

export type WeeklyTotals = {
  rowCount: number;
  /** gross sales units (before returns) */
  salesQty: number;
  /** returned units (always >= 0) */
  returnQty: number;
  /** net units = salesQty - returnQty (the priced quantity) */
  netQty: number;
  bonusQty: number;
  /** salesValue = netQty x factory_price (discount + sheet value columns ignored) */
  salesValue: number;
  /** stock is units only — there is deliberately no stock value */
  stockQty: number;
};

export type WeeklyRegionSummary = WeeklyTotals & { regionCode: string; regionName: string };
export type WeeklyProductSummary = WeeklyTotals & {
  productCode: string;
  productName: string;
  officialLine: string;
};
export type WeeklyBranchSummary = WeeklyTotals & {
  branchCode: string;
  branchName: string;
  regionCode: string;
  regionName: string;
};

/**
 * One product's own By branch and By region. Units of different products are never added (owner rule,
 * 2026-08-27), so once a sheet carries several products a branch's or region's units mean something only
 * product by product — these are the tables the Upload screen shows for the product picked there.
 * `productCode` is byProduct's key, so the two join one to one.
 */
export type WeeklyProductGeography = {
  productCode: string;
  byRegion: WeeklyRegionSummary[];
  byBranch: WeeklyBranchSummary[];
};

// One parsed fact row (branch × product × week). Internal — persisted to weekly_sales_rows.
export type WeeklyParsedRow = {
  rowNumber: number;
  weekStart: string | null; // YYYY-MM-DD
  distributorCode: string;
  distributorName: string;
  regionCode: string;
  regionName: string;
  /**
   * The area this branch belongs to, when the owner explicitly mapped one (weekly_sales_branch_region_map).
   * null is normal: a branch is a distributor depot, not a rep territory. A null area leaves the row
   * region-scoped, exactly as before areas existed.
   */
  areaCode: string | null;
  branchCode: string;
  branchName: string;
  itemCode: string;
  /**
   * The distributor's own item NAME exactly as the sheet spelled it, kept apart from productName.
   * productName holds the RESOLVED master name once an alias matches, so on a resolved row it no
   * longer tells you what the sheet said — which is precisely what the normalizer needs to write a
   * `name`-kind alias. Optional so already-persisted rows and hand-built fixtures stay valid.
   */
  itemName?: string;
  /** Which side of the upload this branch was read from — the `${fileType}|key` half of a branch-map lookup. */
  branchFileType?: "sales" | "stock";
  /** PS stock matrix only: the 1-based column this branch sat in (the branch map's other lookup key). */
  branchColumnIndex?: number | null;
  /** PS stock matrix only: the raw location header text at that column, before normalization. */
  branchColumnHeader?: string;
  productCode: string;
  productName: string;
  officialLine: string;
  /** gross sales units (before returns) */
  salesQty: number;
  /** returned units, always stored as a positive number */
  returnQty: number;
  /** net units = salesQty - returnQty; this is the priced quantity */
  netQty: number;
  bonusQty: number; // free units — read for audit, never priced
  salesValue: number; // netQty x factory_price (no discount, no sheet value)
  stockQty: number; // units only
  validationState: "valid" | "warning" | "failed";
  validationIssues: WeeklyValidationIssue[];
  rawRow: Record<string, string>;
};

export type WeeklyDistributorOption = { code: string; name: string };

/**
 * De-cumulation preview shown at the Validate step. Distributor sheets are cumulative within a month,
 * so a sheet's true "this week only" sales = its cumulative totals minus the previous cumulative sheet
 * of the same month-cycle. Stock is a snapshot, never subtracted.
 */
export type WeeklyThisWeekOnly = {
  /** the previous cumulative sheet this was de-cumulated against, or null when this is the cycle's first week */
  priorWeekStart: string | null;
  priorWeekNumber: number | null;
  /** de-cumulated real sales value for THIS week = current cumulative − prior cumulative */
  salesValue: number;
  /** de-cumulated real net units for THIS week */
  netQty: number;
  /** stock-on-hand snapshot for this sheet (shown as-is, never subtracted) */
  stockQty: number;
  /**
   * The same net-units de-cumulation, ONE PRODUCT AT A TIME, keyed exactly as `byProduct` is. `netQty`
   * above adds every product, so it is only a real figure for a one-product sheet; this is what the
   * screen prints once the sheet holds several (owner, 2026-09-19). Null when the previous sheet's rows
   * could not be read: the screen then shows a dash rather than a figure it cannot stand behind.
   */
  productNetQty: WeeklyThisWeekProductNet[] | null;
};

/** One product's de-cumulated net units for the week. `productCode` is the key `byProduct` carries. */
export type WeeklyThisWeekProductNet = {
  productCode: string;
  netQty: number;
};

/**
 * One raw distributor item whose alias points at the `IGNORE` master product — deliberately kept out
 * of the numbers ("we don't sell this"). Counted and shown, never silently dropped (owner's rule).
 */
export type WeeklyExcludedItem = {
  itemCode: string;
  itemName: string;
  /** distinct source sheet rows dropped */
  rows: number;
  /** net units (sales − returns) that did NOT enter the totals */
  netQty: number;
  /** stock units that did NOT enter the totals */
  stockQty: number;
};

/**
 * One distributor depot whose branch→region mapping is marked excluded ("this depot's rows never
 * count" — a warehouse, platform or tender channel). The twin of WeeklyExcludedItem, and it exists
 * for the same reason: an excluded branch used to drop out of the totals with no count anywhere, so
 * a mis-ticked exclusion silently removed a depot's whole volume. Counted and shown, never silently
 * dropped (owner's rule).
 */
export type WeeklyExcludedBranch = {
  /** the text the branch→region map joins on — branch code when present, else branch name */
  rawBranch: string;
  branchName: string;
  /** PS stock matrix only — the 1-based column this depot sat in */
  branchColumnIndex: number | null;
  /**
   * The distinct items (normalised code | name) this depot's held-out rows carried. Its units add them,
   * so the screen shows those units only while they are one item's (unit-totals.ts).
   */
  itemKeys: string[];
  /** distinct source sheet rows dropped */
  rows: number;
  /** net units (sales − returns) that did NOT enter the totals */
  netQty: number;
  /** stock units that did NOT enter the totals */
  stockQty: number;
};

/**
 * One comparison of what the adapter READ against a total the FILE ITSELF states.
 *
 * This exists because the 2026-08 POS batch stored 172,046 units against a true 1,048 and passed
 * validation cleanly — nothing anywhere compared the parsed result to anything. A distributor export
 * that states its own total hands us a free, independent check on whether we read it the way it was
 * meant, and every format that states one now gets checked.
 *
 * `severity` is deliberately per-check, not global. `block` is used only where the invariant has been
 * proven against real files; `report` where the check is expected to hold but no real file has
 * confirmed it yet — so a first mismatch surfaces loudly instead of stopping a legitimate weekly
 * upload on a format nobody has seen. A `report` earns promotion to `block` once real files back it.
 */
export type WeeklyFileTotalCheck = {
  /** what the file calls the figure, verbatim where the file names it (e.g. `"Total Units" row`) */
  label: string;
  /** where in the file the declared figure lives — for the operator-facing message */
  where: string;
  /** the number the file states */
  declared: number;
  /** the number the adapter read for the same scope */
  parsed: number;
  severity: "block" | "report";
  status: "ok" | "mismatch";
  /** what a mismatch of this shape usually means, when there is a known diagnosis */
  hint?: string;
};

/**
 * What the file said about itself, and whether we read it that way. `absence` is set — and `checks`
 * left empty — for a format that states NO total of its own, recorded explicitly so "there is nothing
 * to check this against" is visible on the screen instead of being indistinguishable from a check
 * that quietly passed.
 */
export type WeeklyFileTotalsReport = {
  checks: WeeklyFileTotalCheck[];
  absence: { reason: string } | null;
};

export type WeeklySalesValidationResult = {
  advisories?: string[];
  /** what the file said about itself, and whether we read it that way — see WeeklyFileTotalCheck */
  fileTotals?: WeeklyFileTotalsReport;
  batchId?: string;
  createdAt?: string;
  distributor: WeeklyDistributorOption;
  fileName: string;
  sheetName: string;
  templateKey: string;
  templateName: string;
  /** the single week-start date carried in the sheet (YYYY-MM-DD), or null when undated */
  weekStart: string | null;
  /** which column contract parsed this batch: 'code' (built-in) or 'override' (in-app edit active) */
  contractSource?: "code" | "override";
  /** first day of the month-cycle (YYYY-MM-DD) this cumulative sheet belongs to (from weekStart, override-able) */
  cycleMonth: string | null;
  /** confirmed week-of-month 1–4 for this upload */
  weekNumber: number | null;
  /** week-of-month auto-suggested from the sheet date (before the user confirms/overrides) */
  suggestedWeekNumber: number | null;
  /** de-cumulated "this week only" preview vs the previous cumulative sheet of this cycle */
  thisWeekOnly?: WeeklyThisWeekOnly | null;
  status: "blocked" | "validated";
  blockingReasons: string[];
  rowCount: number;
  importableRows: number;
  failedRows: number;
  warningRows: number;
  totals: WeeklyTotals;
  byRegion: WeeklyRegionSummary[];
  byProduct: WeeklyProductSummary[];
  byBranch: WeeklyBranchSummary[];
  /** byBranch and byRegion again, one product at a time — see WeeklyProductGeography */
  byProductGeography: WeeklyProductGeography[];
  issues: WeeklyValidationIssue[];
  /** items excluded on purpose via an IGNORE alias — informational, never blocking */
  excludedItems: WeeklyExcludedItem[];
  /** depots excluded on purpose via the branch→region map — informational, never blocking */
  excludedBranches: WeeklyExcludedBranch[];
  /**
   * The tracked lines this sheet carries products for — i.e. exactly the lines whose District
   * Managers and NSM are emailed when the upload is confirmed. Computed on both the dry-run and the
   * real upload so the wizard can name the audience BEFORE the operator presses Confirm rather than
   * after the mail has gone. Head Office and IGNORE never appear here.
   *
   * The client cannot derive this itself: the tracked-line rule reaches the server Supabase client
   * through its line-code resolver, so it has to be answered here and carried down.
   *
   * Optional because the PARSER builds this result and the SERVICE fills this in, exactly as it does
   * for contractSource — an absent value means "not computed", never "no lines".
   */
  notifiableLines?: string[];
};

// ── Pre-upload verification (AI column check) ─────────────────────────────────────────────────────
// Produced by /api/sales/weekly/verify BEFORE upload. Reads only the uploaded file's HEADER ROW
// (never sales numbers) and compares it against the per-distributor column contract. Advisory only —
// it never persists and the server /validate step remains the real validation boundary.

/** "missing" = the file has no sheet the import would read for this column (sheet-match.ts). */
export type WeeklyVerifyColumnStatus = "match" | "drift" | "uncertain" | "empty" | "missing";

export type WeeklyVerifyColumn = {
  /** which file/sheet this column belongs to ("sales" | "stock" | "returns" | "combined") */
  sheetRole: string;
  /** the actual sheet name found in the file */
  sheetName: string;
  field: string;
  label: string;
  /** 1-based column the engine reads */
  columnIndex: number;
  /** what the header at that column usually reads */
  expectedHeaderHint: string;
  /** the header text actually sitting at that column in the uploaded file */
  observedHeader: string;
  status: WeeklyVerifyColumnStatus;
  /** plain-English note (AI or deterministic) */
  note: string;
  /** true for key columns (product/branch/measure) where drift blocks a clean "pass" */
  critical: boolean;
};

export type WeeklyVerifyMatrix = {
  sheetRole: string;
  sheetName: string;
  kind: "branch-headers" | "location-columns";
  firstColumn: number;
  /** how many branch/location columns were detected in the uploaded file */
  detectedCount: number;
  /** first few detected headers, for the operator to eyeball */
  sampleHeaders: string[];
  note: string;
};

export type WeeklyVerifyResult = {
  distributor: WeeklyDistributorOption;
  /** "pass" = columns line up; "drift" = at least one key column doesn't match what's expected */
  verdict: "pass" | "drift";
  /** false when no AI key is set or the AI call failed — the deterministic column plan still shows */
  aiUsed: boolean;
  /** why AI did or did not judge the columns — the verify panel's badge reads this, never aiUsed alone */
  aiState: WeeklyVerifyAiState;
  /** plain-English summary from the AI, or a fallback message when AI is unavailable */
  aiNote: string | null;
  /** the files/sheets that were read */
  files: { role: string; fileName: string; sheetName: string }[];
  columns: WeeklyVerifyColumn[];
  matrices: WeeklyVerifyMatrix[];
  /** structural warnings (sheet not found, empty header cell, etc.) */
  warnings: string[];
};

// Upload-history list item (weekly_sales_batches).
export type WeeklyBatch = {
  id: string;
  distributorCode: string;
  distributorName: string;
  templateKey: string;
  fileName: string;
  sheetName: string;
  weekStart: string | null;
  /** first day of the month-cycle (YYYY-MM-DD) this sheet belongs to, or null when untagged */
  cycleMonth: string | null;
  /** week-of-month 1–4 (auto-tagged from the date, owner re-taggable), or null when untagged */
  weekNumber: number | null;
  status: "blocked" | "validated";
  totalRows: number;
  importableRows: number;
  failedRows: number;
  warningRows: number;
  // The six figures below are the upload's STORED totals, so they add every row the sheet holds —
  // the restricted products and the Head Office line included. They are null when the viewer's
  // weekly access scope hides any of those rows (batch-list-scope.ts): never zero, because a zero
  // reads as "this upload sold nothing".
  /** gross sales units (audit) */
  totalSalesQty: number | null;
  /** returned units */
  totalReturnQty: number | null;
  /** net units = gross - returns (the priced quantity) */
  totalNetQty: number | null;
  totalBonusQty: number | null;
  totalSalesValue: number | null;
  totalStockQty: number | null;
  blockingReasons: string[];
  uploadedBy: string | null;
  /** which column contract parsed this batch: 'code' (built-in) or 'override' (in-app edit active) */
  columnContractSource: "code" | "override";
  createdAt: string;
};

// ── Dashboard ────────────────────────────────────────────────────────────────────────────────

/** A multi-value filter is either an allow-list ("include") or a deny-list ("exclude"). */
export type WeeklyFilterMode = "include" | "exclude";

export type WeeklyRanked = {
  name: string;
  code: string;
  salesValue: number;
  salesUnits: number;
  stockUnits: number;
  /** share 0..1 of the scoped total sales value */
  share: number;
};

export type WeeklyBranchComparisonRow = WeeklyRanked & {
  regionName: string;
};

export type WeeklyDelta = {
  current: number;
  /** null = prior week not uploaded — render an em dash, never a fake 0 baseline */
  prior: number | null;
  pct: number | null;
};

export type WeeklyBranchRow = {
  branchCode: string;
  branchName: string;
  regionName: string;
  salesValue: number;
  salesUnits: number;
  stockUnits: number;
};

/**
 * How a row reached a manager whose load follows his own areas (own-area-share.ts):
 *   mapped    — a depot mapped to one of his areas by hand: the depot's own sale there;
 *   allocated — the part of a depot the owner's split rule places in one of his areas;
 *   whole     — a depot no rule places in any area (a warehouse, a tender), which his own scope admits.
 */
export type WeeklyAreaBasis = "mapped" | "allocated" | "whole";

/**
 * A single de-cumulated, access-scoped, filter-applied fact row — the row-level grain that powers the
 * interactive BI export (its hidden Data sheet, pivots, charts and SUMIFS formulas). Only populated
 * when `includeFactRows` is requested (the export path), so the on-screen dashboard payload stays lean.
 */
export type WeeklyFactExportRow = {
  distributorCode: string;
  distributorName: string;
  productCode: string;
  productName: string;
  line: string;
  regionCode: string;
  regionName: string;
  /**
   * Sales AREA, from the branch->area map. null for the many branches that are deliberately
   * region-only: a key account, chain, wholesale depot, warehouse or governorate customer book
   * serves several areas at once, so no single area is correct for it. Measured 2026-08-12, that is
   * 98% of the unmapped VOLUME — so those rows must still be reported, under a named bucket, never
   * dropped.
   */
  areaCode: string | null;
  branchCode: string;
  branchName: string;
  cycleMonth: string;
  weekNumber: number | null;
  weekStart: string;
  /** The upload this row came from (weekly_sales_batches.id) — the only unambiguous sheet identity. */
  batchId: string;
  /**
   * Product family NAME from the master (e.g. "Tebofortin" covers its 7 concentrations).
   *
   * The name, never family_code: the code is not unique — "DO" belongs to both Dopaminict and
   * Dolabactin, so grouping on it silently merges two families. Empty when the master has no family.
   */
  family: string;
  salesValue: number;
  salesUnits: number;
  stockUnits: number;
  /**
   * Set only on a load that followed the viewer's own areas (ownAreaShare): how the row reached him.
   * Absent everywhere else, where a row carrying an area is hand-mapped and any other row is not placed.
   */
  areaBasis?: WeeklyAreaBasis;
};

export type WeeklyDashboard = {
  weekStart: string | null;
  priorWeekStart: string | null;
  /**
   * Which lines these numbers cover. `active` is true whenever the tracked-line default scope is in
   * force — CNS / Anti Infective / Pedia only, Head Office excluded (GOLDEN RULE, see
   * tracked-lines.ts). It goes false when the viewer names a line themselves, which is the escape
   * hatch. Travels with the data so the screen and the export cannot disagree about what was counted.
   */
  trackedScope: { active: boolean; note: string };
  availableWeeks: string[];
  /** Maps each canonical week date to all member dates in that group (for range labels in the UI). */
  weekGroupMembers: Record<string, string[]>;
  availableLines: string[];
  /** Stable filter-option universes (scoped by week + distributor only, so multi-select never collapses). */
  availableRegions: WeeklyDistributorOption[];
  availableProducts: WeeklyDistributorOption[];
  /** Cycle-month options ({ code: "YYYY-MM-DD", name: "May 2026" }), newest first. */
  availableMonths: WeeklyDistributorOption[];
  /** Week-of-month numbers present in the data (subset of 1–4), ascending. */
  availableWeekNumbers: number[];
  /**
   * Individual uploads the viewer can pick, newest first — `code` is `weekly_sales_batches.id`.
   *
   * The only unambiguous way to say "the sheet I am looking at". A week_start is not: two
   * distributors routinely share one, and computeWeekGroups() merges near dates into one group.
   */
  availableUploads: WeeklyDistributorOption[];
  distributors: WeeklyDistributorOption[];
  appliedFilters: {
    weekStart: string | null;
    weekStarts: string[];
    allWeeks: boolean;
    /** Legacy single-value mirrors (kept for back-compat: populated only when exactly one include code). */
    distributorCode: string | null;
    regionCode: string | null;
    productCode: string | null;
    lineCode: string | null;
    /** Multi-value selections (normalized codes) + their include/exclude mode. Empty array = "all". */
    productCodes: string[];
    productFilterMode: WeeklyFilterMode;
    distributorCodes: string[];
    distributorFilterMode: WeeklyFilterMode;
    regionCodes: string[];
    regionFilterMode: WeeklyFilterMode;
    lineCodes: string[];
    lineFilterMode: WeeklyFilterMode;
    cycleMonths: string[];
    cycleMonthMode: WeeklyFilterMode;
    weekNumbers: number[];
    weekNumberMode: WeeklyFilterMode;
  };
  kpis: {
    salesValue: number;
    salesUnits: number;
    stockUnits: number;
    branchCount: number;
    regionCount: number;
    productCount: number;
    distributorCount: number;
  };
  compare: { salesValue: WeeklyDelta; salesUnits: WeeklyDelta; stockUnits: WeeklyDelta };
  /** consolidated across all distributors for the selected week */
  regions: WeeklyRanked[];
  products: WeeklyRanked[];
  distributorBreakdown: WeeklyRanked[];
  branchBreakdown: WeeklyBranchComparisonRow[];
  /** branches with stock on hand but zero sales this week */
  zeroSalesBranches: WeeklyBranchRow[];
  /** true when the viewer's access scope has no product codes assigned — admin must configure. */
  scopeEmpty?: boolean;
  /**
   * De-cumulated week-by-week comparison: real per-week totals (this sheet − previous sheet of the
   * month), grouped by cycle month + week number, with the week-over-week % delta vs the previous week.
   */
  weekComparison: {
    cycleMonth: string;
    weekNumber: number;
    weekStart: string | null;
    /** Real per-week sales value; NULL when spansGap (the figure would silently include the missing
     *  week(s), so it is suppressed rather than shown as a true single-week value). */
    salesValue: number | null;
    /** Real per-week sales units; NULL when spansGap (same reason as salesValue). */
    salesUnits: number | null;
    stockUnits: number;
    /** % change vs the previous week number in the same month-cycle; null when no prior week OR when
     *  spansGap (the delta would be computed against a non-adjacent week). */
    deltaValuePct: number | null;
    /**
     * True when the immediately-preceding week number in this cycle was NOT uploaded (a gap in the
     * upload history). De-cumulation subtracts against the previous PRESENT week, so this week's
     * figure would silently span every missing week between them (audit finding M6 — the month total
     * stays correct via telescoping, but this single week's figure is inflated). Chosen remediation
     * ("suppress + flag"): salesValue/salesUnits/deltaValuePct are NULLED at the source for these
     * weeks and every consumer renders "—" next to the "spans gap" badge, so the inflated number is
     * never shown as a true single-week value.
     */
    spansGap: boolean;
    /**
     * True when money in this week came from a depot that sent no sheet for the week before
     * (depotWeekGaps in decumulate.ts), so that depot's part of the figure also holds the week it
     * skipped. The figure is kept and the week is marked (owner, 2026-09-17); only spansGap suppresses.
     * One depot's sheet cannot hide another depot's missing week here, as it can for spansGap.
     */
    depotSpansGap: boolean;
  }[];
  /** the validated source sheets this report was built from (powers the export's "Report Sources" block) */
  sources: {
    distributorCode: string;
    distributorName: string;
    cycleMonth: string | null;
    weekNumber: number | null;
    weekStart: string | null;
    fileName: string;
  }[];
  /** simple value trend across the available weeks (in-scope) — now de-cumulated (real per week) */
  trend: {
    weekStart: string;
    /** week-of-month 1–4 (for "W1 May" axis labels), or null when untagged */
    weekNumber: number | null;
    /** cycle month (YYYY-MM-DD), or null when untagged */
    cycleMonth: string | null;
    salesValue: number;
    salesUnits: number;
    stockUnits: number;
    byDistributor: { distributorCode: string; distributorName: string; salesValue: number }[];
  }[];
  /**
   * Row-level fact grain for the interactive BI export (hidden Data sheet → pivots/charts/formulas).
   * Only present when `includeFactRows` is requested; undefined for normal dashboard loads.
   */
  factRows?: WeeklyFactExportRow[];
  /**
   * Weekly Stock only (stock-dashboard.ts): every scoped, de-cumulated row across the fetched weeks,
   * with the live master price. Only present when `includeStockRows` is requested.
   */
  stockRows?: import("./stock-dashboard").WeeklyStockSourceRow[];
  /**
   * Every depot week that spans an upload gap (depotWeekGaps in decumulate.ts): the depot sent no sheet
   * for the week before it in that cycle month, so its de-cumulated figures hold more than one week.
   * Read over every loaded row, whatever the viewer's scope, so it names depots and weeks the viewer may
   * not see: server-only, stripped before any payload reaches the browser. Flags only, no money. Only
   * present when `includeFactRows` is requested.
   */
  factRowDepotWeekGaps?: import("./decumulate").DepotWeekGap[];
  /**
   * ONE product's units, for every unit figure above that would add products (owner, 2026-09-19): units of
   * different products are never added, so a selection holding several products shows its tiles, its
   * region, distributor and branch units and its week comparison for one product at a time — the one
   * picked on the screen (`unitProductCode`), else the top product by value. Present whenever no product
   * filter pins the selection to one code; see WeeklyDashboardUnitView.
   */
  unitView?: WeeklyDashboardUnitView | null;
};

/** One product's sales (net) and stock units at one place. */
export type WeeklyUnitFigures = { salesUnits: number; stockUnits: number };

/**
 * The picked product's own units, keyed exactly as the dashboard's own rows are: `regions` by
 * WeeklyRanked.code of `regions`, `distributors` by that of `distributorBreakdown`, `branches` by that of
 * `branchBreakdown` (and `zeroSalesBranches`' branchCode), `weeks` by weeklyWeekKey(cycleMonth,
 * weekNumber). A place the product never reached is absent, and reads as zero units.
 */
export type WeeklyDashboardUnitView = {
  productCode: string;
  productName: string;
  kpis: WeeklyUnitFigures;
  compare: { salesUnits: WeeklyDelta; stockUnits: WeeklyDelta };
  regions: Record<string, WeeklyUnitFigures>;
  distributors: Record<string, WeeklyUnitFigures>;
  branches: Record<string, WeeklyUnitFigures>;
  /** salesUnits is null where the week spans an upload gap, exactly as weekComparison nulls it */
  weeks: Record<string, { salesUnits: number | null; stockUnits: number }>;
};

// ── Mapping pipeline ─────────────────────────────────────────────────────────────────────────────

/** A raw label captured from an uploaded file that the mapping engine couldn't resolve. */
export type WeeklyMissingLabel = { dimension: "product" | "region"; rawValue: string };

// ── product-scope administration (which PM/GPM/Marketing Manager owns which products) ──────────

export type WeeklyProductOption = { code: string; name: string; line: string };

export type WeeklyScopeAssignment = {
  hrId: string;
  name: string;
  role: string;
  productCodes: string[];
};

export type WeeklyProductScopeAdmin = {
  products: WeeklyProductOption[];
  /** People who currently hold (or are eligible to hold) a product scope. */
  assignments: WeeklyScopeAssignment[];
  /** Eligible people with no assignment yet (for the "add" picker). */
  eligibleWithoutScope: { hrId: string; name: string; role: string }[];
};
