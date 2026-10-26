import ExcelJS from "exceljs";

import { writeAuditLog } from "@/lib/admin/audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { IGNORE_PRODUCT_CODE } from "@/lib/sales/normalizer/types";
import {
  listWeeklyBranchAreaExamples,
  listWeeklyBranchRegionExamples,
  loadBranchRegionIndex,
  upsertBranchRegionRow,
  WEEKLY_BRANCH_EXCLUDE_CODE,
  type WeeklyBranchFileType,
  type WeeklyMasterArea,
  type WeeklyMasterRegion,
} from "@/lib/sales/weekly/branch-region-map";
import { canonicalWeeklyDistributorCode, WEEKLY_DISTRIBUTORS, weeklyDistributorByCode } from "@/lib/sales/weekly/distributors";
import { normalizeCode, normalizeKey } from "@/lib/sales/weekly/mapping-normalize";
import { parseWeeklyWorkbookBuffer } from "@/lib/sales/weekly/parser";
import { listWeeklyProductAliasExamples, loadProductAliasIndex, upsertProductAlias, type WeeklyAliasKind } from "@/lib/sales/weekly/product-aliases";
import { resolveWeeklyContractWithSource } from "@/lib/sales/weekly/weekly-column-profile-store";
import type { WeeklyExcludedBranch, WeeklyExcludedItem, WeeklyParsedRow } from "@/lib/sales/weekly/types";

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Sales — the NORMALIZER surface: the weekly twin of the monthly Source Normalizer.
//
// Monthly lets an operator drop a raw distributor sheet, see how much of it auto-codes, map the
// handful of codes the dictionary has never seen, and watch coverage climb — all before anything is
// persisted. Weekly only ever had the tail of that loop (a list of items that ALREADY failed a real
// upload). This module supplies the head: analyze a raw weekly file with zero side effects, group
// every unresolved value by the dimension that can fix it, and write the fixes back into the SAME
// two dictionaries the weekly upload reads (product aliases + branch→region map).
//
// Weekly's mappable dimensions are PRODUCT (distributor item → master product) and BRANCH
// (distributor depot → master region, optionally an area) — the exact counterparts of monthly's
// product / territory / customer. Anything that a mapping cannot fix (a master product with no
// price or line; a Direct sheet naming a region that isn't in the master) is reported separately
// rather than dressed up as a mapping gap, so the operator is never sent to fix the wrong thing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Value the branch picker sends to mean "this depot's rows never count" (weekly's IGNORE).
 * Defined in branch-region-map.ts, with the map it applies to; re-exported here so every caller of
 * the normalizer keeps importing it from one place.
 */
export { WEEKLY_BRANCH_EXCLUDE_CODE } from "@/lib/sales/weekly/branch-region-map";

/** A distributor item the alias dictionary has never seen — one row per distinct raw item. */
export type WeeklyNormalizeUnknownProduct = {
  /** stable UI key */
  key: string;
  itemCode: string;
  itemName: string;
  /** which dictionary column a save writes into — "code" when the sheet carried an item code */
  aliasKind: WeeklyAliasKind;
  /** the exact text the alias is stored under */
  alias: string;
  /** distinct (product × branch) sheet aggregates carrying this item */
  rows: number;
  netQty: number;
  stockQty: number;
};

/** A distributor branch/depot the branch→region map has never seen. */
export type WeeklyNormalizeUnknownBranch = {
  key: string;
  /** the text the map joins on — branch code when present, else branch name */
  rawBranch: string;
  branchName: string;
  /** "any" when the same depot appeared on both the sales and the stock side */
  sourceFileType: WeeklyBranchFileType;
  /** PS stock matrix only — the column this depot sat in */
  branchColumnIndex: number | null;
  branchColumnHeader: string;
  rows: number;
  netQty: number;
  stockQty: number;
};

/** A blocker no mapping on this page can clear — shown so it is never mistaken for a mapping gap. */
export type WeeklyNormalizeBlockedIssue = {
  field: string;
  message: string;
  value: string | null;
  rows: number;
};

export type WeeklyNormalizeCodedRow = {
  itemCode: string;
  productCode: string;
  productName: string;
  officialLine: string;
  branchCode: string;
  branchName: string;
  regionCode: string;
  regionName: string;
  areaCode: string | null;
  netQty: number;
  stockQty: number;
  salesValue: number;
};

/**
 * Which column layout the analyze actually read the file with — the same one the real upload uses.
 * Reported so the operator can see the normalizer knows this distributor's sheet, and see instantly
 * when it is running on the built-in layout rather than an override he saved.
 */
export type WeeklyNormalizeTemplate = {
  /** "override" = a layout saved for this distributor in Phoenix; "code" = the built-in one */
  source: "code" | "override";
  name: string;
  /** how the adapter finds its columns — Direct's hand-made sheet matches by header text instead */
  matching: "header-name" | "position";
  splitFiles: boolean;
  sheets: { role: string; sheetName: string; headerRow: number; fields: number; matrix: boolean }[];
};

export type WeeklyNormalizePreview = {
  distributorCode: string;
  distributorName: string;
  fileName: string;
  sheetName: string;
  /** null only when this distributor has no pinned column contract at all */
  template: WeeklyNormalizeTemplate | null;
  /** the single week date the sheet carries (YYYY-MM-DD), or null when it is undated */
  weekStart: string | null;
  status: "blocked" | "validated";
  blockingReasons: string[];
  summary: {
    totalRows: number;
    productResolved: number;
    regionResolved: number;
    fullyCoded: number;
    /** distinct raw items deliberately held out via an IGNORE alias */
    excludedItems: number;
    /** distinct depots deliberately held out via an excluded branch→region mapping */
    excludedBranches: number;
  };
  sampleCoded: WeeklyNormalizeCodedRow[];
  unknownProducts: WeeklyNormalizeUnknownProduct[];
  unknownBranches: WeeklyNormalizeUnknownBranch[];
  blockedIssues: WeeklyNormalizeBlockedIssue[];
  excludedItems: WeeklyExcludedItem[];
  excludedBranches: WeeklyExcludedBranch[];
};

/** The two controlled vocabularies the mapping dropdowns bind to. */
export type WeeklyNormalizeReferences = {
  products: { code: string; name: string; line: string; priced: boolean }[];
  regions: WeeklyMasterRegion[];
  areas: WeeklyMasterArea[];
};

const SAMPLE_CODED_ROWS = 60;

/** Issue fields that a product alias can fix. */
const PRODUCT_FIELDS = new Set(["productCode"]);
/** Issue fields that a branch→region mapping can fix. */
const REGION_FIELDS = new Set(["regionCode"]);

const round2 = (value: number) => Number(value.toFixed(2));

function hasIssue(row: WeeklyParsedRow, fields: Set<string>): boolean {
  return row.validationIssues.some((issue) => issue.severity === "failure" && fields.has(issue.field));
}

/**
 * A product failure the operator can clear HERE is only the "no alias yet" case. An alias that
 * points at a code missing from the master, or a master with no price / no line, is a master-data
 * repair — mapping the same raw text again would change nothing.
 */
function isMappableProductFailure(message: string): boolean {
  return message.startsWith("No product alias maps");
}

/** Direct maps its branch straight to a region, so its region failures are not branch-map gaps. */
function isMappableRegionFailure(distributorCode: string, message: string): boolean {
  if (distributorCode === "Direct") return false;
  return !message.includes("is not in the Source of Sales master region table") && !message.startsWith("Region ID is required");
}

/**
 * What the weekly dictionary has ALREADY been taught, as worked examples for the AI.
 *
 * Without this the model matches cold — it sees the master list and the unknown text and nothing
 * else, so it cannot know that this distributor writes "AMOXIL 500MG CAP.20" for the product Phoenix
 * calls something shorter, even though an operator answered that exact question last week. The
 * monthly normalizer has fed its confirmed aliases back to the model since it was built; this is the
 * weekly equivalent, over the two weekly dictionaries.
 *
 * The distributor being mapped comes FIRST. ai-suggest keeps only the first
 * AI_SUGGEST_MAX_REFERENCE_ALIASES (120) lines per request to stay inside the token budget, so
 * ordering decides what survives — and one distributor's own naming habits beat everyone else's.
 * Other distributors follow, because the same medicine is often spelled the same way across sheets.
 */
export async function listWeeklyAiReferenceAliases(
  kind: "product" | "branch" | "branch-area",
  distributorCode?: string | null,
): Promise<{ raw: string; code: string }[]> {
  let focus = "";
  try {
    focus = distributorCode ? canonicalWeeklyDistributorCode(distributorCode) : "";
  } catch {
    focus = "";
  }

  // Two queries, not one capped list: a distributor with 30 mappings would be squeezed out entirely
  // by one that has thousands, and its own history is exactly the part that must survive the cap.
  const read: (code?: string | null, limit?: number) => Promise<{ raw: string; code: string; distributorCode: string }[]> =
    kind === "branch-area"
      ? listWeeklyBranchAreaExamples
      : kind === "branch"
        ? listWeeklyBranchRegionExamples
        : listWeeklyProductAliasExamples;
  const [mineRows, allRows] = await Promise.all([focus ? read(focus, 300) : Promise.resolve([]), read(null, 600)]);

  const out: { raw: string; code: string }[] = [];
  const seen = new Set<string>();
  const push = (example: { raw: string; code: string }) => {
    const key = `${example.raw.toLowerCase()}:${example.code}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ raw: example.raw, code: example.code });
  };
  for (const example of mineRows) push(example);
  for (const example of allRows) push(example);
  return out;
}

/**
 * The distributor picker's options. `weeklyDistributorOptions()` returns code+name only, and the
 * normalizer additionally needs to know who ships two files (Overseas) so it can show the second
 * file input — one list, so the picker can never offer a distributor the parser does not know.
 */
export function listWeeklyNormalizerDistributors(): { code: string; name: string; separateSalesStockFiles: boolean }[] {
  return WEEKLY_DISTRIBUTORS.map((distributor) => ({
    code: distributor.code,
    name: distributor.name,
    separateSalesStockFiles: Boolean(distributor.separateSalesStockFiles),
  }));
}

/**
 * The three master lists the mapping dropdowns bind to, from ONE reference load.
 *
 * listMasterRegions() and listMasterAreas() each call loadSalesReferenceData() themselves, so asking
 * all three separately would cross the Atlantic three times for one page. Same derivation, one trip.
 */
export async function listWeeklyNormalizeReferences(): Promise<WeeklyNormalizeReferences> {
  const references = await loadSalesReferenceData({ includeCustomerBricks: false });

  const regionNameByCode = new Map<string, string>();
  for (const region of references.regions ?? []) {
    const regionCode = normalizeCode(region.regionCode);
    const regionName = String(region.regionName ?? "").trim();
    if (regionCode && !regionNameByCode.has(regionCode)) regionNameByCode.set(regionCode, regionName || regionCode);
  }
  const regions: WeeklyMasterRegion[] = [...regionNameByCode.entries()]
    .map(([regionCode, regionName]) => ({ regionCode, regionName }))
    .sort((left, right) => left.regionName.localeCompare(right.regionName) || left.regionCode.localeCompare(right.regionCode));

  const seenAreas = new Set<string>();
  const areas: WeeklyMasterArea[] = [];
  for (const area of references.areas ?? []) {
    const areaCode = normalizeCode(area.areaCode);
    const regionCode = normalizeCode(area.regionCode);
    if (!areaCode || seenAreas.has(areaCode)) continue;
    seenAreas.add(areaCode);
    areas.push({ areaCode, areaName: String(area.areaName ?? "").trim() || areaCode, regionCode });
  }
  areas.sort((left, right) => left.regionCode.localeCompare(right.regionCode) || left.areaCode.localeCompare(right.areaCode));

  const products = references.products
    .map((product) => {
      const price = Number(product.factoryPrice);
      return {
        code: product.productCode.trim(),
        name: (product.productName || product.productCode).trim(),
        line: (product.line ?? "").trim(),
        priced: Number.isFinite(price) && price > 0,
      };
    })
    .filter((product) => product.code)
    .sort((left, right) => left.name.localeCompare(right.name));
  return { products, regions, areas };
}

// ── analyze ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Parse a raw weekly file and report what would and would not code — WITHOUT writing anything.
 *
 * Deliberately a separate entry point from importWeeklySalesFile: that function's dry-run returns the
 * summary only, and the normalizer needs the fact ROWS to group unresolved values by their raw
 * identity. It loads the same references, alias index, branch index and column contract, so what it
 * reports is exactly what the real upload would decide.
 */
export async function analyzeWeeklyForNormalization(input: {
  distributorCode: string;
  /** combined / single workbook (everyone except PS) */
  file?: File | null;
  /** PS two-file form */
  salesFile?: File | null;
  stockFile?: File | null;
  /** explicit period (YYYY-MM-DD) for undated / multi-dated sheets */
  periodDate?: string | null;
}): Promise<WeeklyNormalizePreview> {
  const rawCode = (input.distributorCode ?? "").trim();
  if (!rawCode) throw new SalesWorkflowError("invalid_request", "Pick a distributor before analyzing.", 400);

  let distributorCode: string;
  try {
    distributorCode = canonicalWeeklyDistributorCode(rawCode);
  } catch {
    throw new SalesWorkflowError("unsupported_template", `Unknown weekly distributor "${rawCode}".`, 422);
  }

  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const distributorName =
    references.distributors.find((row) => row.code.toUpperCase() === distributorCode.toUpperCase())?.name ??
    weeklyDistributorByCode(distributorCode)?.name ??
    distributorCode;

  const [aliasIndex, branchMapIndex, resolved] = await Promise.all([
    loadProductAliasIndex(),
    loadBranchRegionIndex(distributorCode),
    resolveWeeklyContractWithSource(distributorCode),
  ]);

  const isPS = distributorCode === "PS";
  const fileNameParts: string[] = [];
  const buffer = input.file ? await input.file.arrayBuffer() : undefined;
  const salesBuffer = input.salesFile ? await input.salesFile.arrayBuffer() : isPS ? buffer : undefined;
  const stockBuffer = input.stockFile ? await input.stockFile.arrayBuffer() : undefined;
  if (input.file) fileNameParts.push(input.file.name);
  if (input.salesFile) fileNameParts.push(input.salesFile.name);
  if (input.stockFile) fileNameParts.push(input.stockFile.name);
  const fileName = fileNameParts.join(" + ") || `${distributorCode}.xlsx`;

  const parsed = await parseWeeklyWorkbookBuffer({
    buffer: isPS ? undefined : buffer,
    salesBuffer: isPS ? salesBuffer : undefined,
    stockBuffer: isPS ? stockBuffer : undefined,
    distributorCode,
    distributorName,
    fileName,
    references,
    aliasIndex,
    branchMapIndex,
    periodDate: input.periodDate ?? null,
    contract: resolved.contract,
  });
  if (!parsed.ok) {
    const status = parsed.error.code === "unsupported_template" ? 422 : 400;
    throw new SalesWorkflowError(parsed.error.code, parsed.error.message, status);
  }

  const definition = weeklyDistributorByCode(distributorCode);
  // Direct is exempt from a positional contract on purpose — its hand-made sheet is matched by
  // header text — so it reports "header-name" rather than the "no template" the absent contract
  // would otherwise imply.
  const template: WeeklyNormalizeTemplate | null = resolved.contract
    ? {
        source: resolved.source,
        name: resolved.contract.name || distributorName,
        matching: definition?.headerNameMatched ? "header-name" : "position",
        splitFiles: Boolean(resolved.contract.splitFiles),
        sheets: resolved.contract.sheets.map((sheet) => ({
          role: sheet.role,
          sheetName: sheet.sheetName ?? sheet.sheetIncludes ?? "",
          headerRow: sheet.headerRowNumber,
          fields: sheet.fields.length,
          matrix: Boolean(sheet.matrix),
        })),
      }
    : definition?.headerNameMatched
    ? { source: "code", name: distributorName, matching: "header-name", splitFiles: false, sheets: [] }
    : null;

  return summarizeWeeklyNormalization(distributorCode, distributorName, fileName, parsed.rows, {
    sheetName: parsed.result.sheetName,
    weekStart: parsed.result.weekStart,
    status: parsed.result.status,
    blockingReasons: parsed.result.blockingReasons,
    excludedItems: parsed.result.excludedItems,
    excludedBranches: parsed.result.excludedBranches,
    template,
  });
}

/** Group the parsed rows into the coverage + unknowns shape the workspace renders. Pure. */
export function summarizeWeeklyNormalization(
  distributorCode: string,
  distributorName: string,
  fileName: string,
  rows: WeeklyParsedRow[],
  meta: {
    sheetName: string;
    weekStart: string | null;
    status: "blocked" | "validated";
    blockingReasons: string[];
    excludedItems: WeeklyExcludedItem[];
    excludedBranches?: WeeklyExcludedBranch[];
    template?: WeeklyNormalizeTemplate | null;
  },
): WeeklyNormalizePreview {
  const unknownProducts = new Map<string, WeeklyNormalizeUnknownProduct>();
  const unknownBranches = new Map<string, WeeklyNormalizeUnknownBranch>();
  const blockedIssues = new Map<string, WeeklyNormalizeBlockedIssue>();
  const sampleCoded: WeeklyNormalizeCodedRow[] = [];
  let productResolved = 0;
  let regionResolved = 0;
  let fullyCoded = 0;

  for (const row of rows) {
    const productFailed = hasIssue(row, PRODUCT_FIELDS);
    const regionFailed = hasIssue(row, REGION_FIELDS);
    if (!productFailed) productResolved += 1;
    if (!regionFailed) regionResolved += 1;
    if (row.validationState !== "failed") {
      fullyCoded += 1;
      if (sampleCoded.length < SAMPLE_CODED_ROWS) {
        sampleCoded.push({
          itemCode: row.itemCode,
          productCode: row.productCode,
          productName: row.productName,
          officialLine: row.officialLine,
          branchCode: row.branchCode,
          branchName: row.branchName,
          regionCode: row.regionCode,
          regionName: row.regionName,
          areaCode: row.areaCode,
          netQty: round2(row.netQty),
          stockQty: round2(row.stockQty),
          salesValue: round2(row.salesValue),
        });
      }
    }

    for (const issue of row.validationIssues) {
      if (issue.severity !== "failure") continue;

      if (PRODUCT_FIELDS.has(issue.field) && isMappableProductFailure(issue.message)) {
        const itemCode = row.itemCode.trim();
        const itemName = (row.itemName ?? "").trim();
        const aliasKind: WeeklyAliasKind = itemCode ? "code" : "name";
        const alias = itemCode || itemName;
        if (!alias) continue;
        const key = `${aliasKind}:${aliasKind === "code" ? normalizeCode(alias) : normalizeKey(alias)}`;
        const entry = unknownProducts.get(key) ?? { key, itemCode, itemName, aliasKind, alias, rows: 0, netQty: 0, stockQty: 0 };
        entry.rows += 1;
        entry.netQty += row.netQty;
        entry.stockQty += row.stockQty;
        // Keep the first non-blank name we see: some sides of a sheet carry only the code.
        if (!entry.itemName && itemName) entry.itemName = itemName;
        unknownProducts.set(key, entry);
        continue;
      }

      if (REGION_FIELDS.has(issue.field) && isMappableRegionFailure(distributorCode, issue.message)) {
        const rawBranch = (row.branchCode || row.branchName).trim();
        const columnIndex = row.branchColumnIndex ?? null;
        if (!rawBranch && columnIndex == null) continue;
        const key = columnIndex != null ? `col#${columnIndex}` : normalizeKey(rawBranch);
        const fileType: WeeklyBranchFileType = row.branchFileType ?? "any";
        const entry =
          unknownBranches.get(key) ??
          ({
            key,
            rawBranch,
            branchName: row.branchName.trim(),
            sourceFileType: fileType,
            branchColumnIndex: columnIndex,
            branchColumnHeader: (row.branchColumnHeader ?? "").trim(),
            rows: 0,
            netQty: 0,
            stockQty: 0,
          } satisfies WeeklyNormalizeUnknownBranch);
        entry.rows += 1;
        entry.netQty += row.netQty;
        entry.stockQty += row.stockQty;
        // Seen on both sides of the upload → one mapping must serve both, so widen it to "any".
        if (entry.sourceFileType !== fileType) entry.sourceFileType = "any";
        unknownBranches.set(key, entry);
        continue;
      }

      // Everything else — a master product with no price or line, an alias pointing at a code that
      // left the master, a Direct sheet naming an unknown region. Reported, never mapped here.
      const issueKey = `${issue.field}|${issue.message}`;
      const blocked = blockedIssues.get(issueKey) ?? { field: issue.field, message: issue.message, value: issue.value, rows: 0 };
      blocked.rows += 1;
      blockedIssues.set(issueKey, blocked);
    }
  }

  const byImpact = <T extends { netQty: number; stockQty: number; rows: number }>(left: T, right: T) =>
    Math.abs(right.netQty) - Math.abs(left.netQty) || right.stockQty - left.stockQty || right.rows - left.rows;

  return {
    distributorCode,
    distributorName,
    fileName,
    sheetName: meta.sheetName,
    template: meta.template ?? null,
    weekStart: meta.weekStart,
    status: meta.status,
    blockingReasons: meta.blockingReasons,
    summary: {
      totalRows: rows.length,
      productResolved,
      regionResolved,
      fullyCoded,
      excludedItems: meta.excludedItems.length,
      excludedBranches: (meta.excludedBranches ?? []).length,
    },
    sampleCoded,
    unknownProducts: [...unknownProducts.values()]
      .map((entry) => ({ ...entry, netQty: round2(entry.netQty), stockQty: round2(entry.stockQty) }))
      .sort(byImpact),
    unknownBranches: [...unknownBranches.values()]
      .map((entry) => ({ ...entry, netQty: round2(entry.netQty), stockQty: round2(entry.stockQty) }))
      .sort(byImpact),
    blockedIssues: [...blockedIssues.values()].sort((left, right) => right.rows - left.rows),
    excludedItems: meta.excludedItems,
    excludedBranches: meta.excludedBranches ?? [],
  };
}

// ── save ─────────────────────────────────────────────────────────────────────────────────────────

export type WeeklyNormalizeProductMapping = {
  alias: string;
  aliasKind: WeeklyAliasKind;
  productCode: string;
  /** the filled list's sheet row, when the pick came from one — so a failure can name its line */
  row?: number;
};

export type WeeklyNormalizeBranchMapping = {
  rawBranch: string;
  branchName?: string | null;
  sourceFileType?: WeeklyBranchFileType;
  branchColumnIndex?: number | null;
  /** a master region code, or WEEKLY_BRANCH_EXCLUDE_CODE to drop this depot from every total */
  regionCode: string;
  areaCode?: string | null;
  /** the filled list's sheet row, when the pick came from one — so a failure can name its line */
  row?: number;
};

export type WeeklyNormalizeSaveResult = {
  savedProducts: number;
  savedBranches: number;
  failed: { kind: "product" | "branch"; label: string; reason: string; row?: number }[];
};

/**
 * Write the operator's picks into the two live weekly dictionaries.
 *
 * Each mapping is applied on its own and its failure recorded rather than thrown: a single bad pick
 * (an alias already committed to another product, an area outside the branch's region) must not
 * discard the twenty good picks saved alongside it. The caller reports the per-item reasons.
 */
export async function saveWeeklyNormalizerMappings(input: {
  distributorCode: string;
  actorId: string | null;
  products?: WeeklyNormalizeProductMapping[];
  branches?: WeeklyNormalizeBranchMapping[];
}): Promise<WeeklyNormalizeSaveResult> {
  const distributorCode = canonicalWeeklyDistributorCode(input.distributorCode);
  const failed: WeeklyNormalizeSaveResult["failed"] = [];
  let savedProducts = 0;
  let savedBranches = 0;

  for (const mapping of input.products ?? []) {
    const alias = String(mapping.alias ?? "").trim();
    const productCode = String(mapping.productCode ?? "").trim();
    if (!alias || !productCode) continue;
    try {
      await upsertProductAlias({
        distributorCode,
        alias,
        aliasKind: mapping.aliasKind === "name" ? "name" : "code",
        productCode,
        actorId: input.actorId,
      });
      savedProducts += 1;
    } catch (error) {
      failed.push({ kind: "product", label: alias, reason: errorText(error), ...(mapping.row ? { row: mapping.row } : {}) });
    }
  }

  for (const mapping of input.branches ?? []) {
    const rawBranch = String(mapping.rawBranch ?? "").trim();
    const columnIndex = mapping.branchColumnIndex == null ? null : Number(mapping.branchColumnIndex);
    const regionCode = String(mapping.regionCode ?? "").trim();
    if (!regionCode) continue;
    if (!rawBranch && columnIndex == null) continue;
    const excluded = regionCode.toUpperCase() === WEEKLY_BRANCH_EXCLUDE_CODE;
    try {
      await upsertBranchRegionRow({
        distributorCode,
        rawBranch,
        branchName: mapping.branchName ?? null,
        regionCode: excluded ? "" : regionCode,
        areaCode: excluded ? null : (mapping.areaCode ?? null),
        sourceFileType: mapping.sourceFileType ?? "any",
        branchColumnIndex: columnIndex,
        excluded,
        actorId: input.actorId,
      });
      savedBranches += 1;
    } catch (error) {
      failed.push({ kind: "branch", label: rawBranch || `column ${columnIndex}`, reason: errorText(error), ...(mapping.row ? { row: mapping.row } : {}) });
    }
  }

  return { savedProducts, savedBranches, failed };
}

function errorText(error: unknown): string {
  if (error instanceof SalesWorkflowError) return error.message;
  return error instanceof Error ? error.message : "Save failed.";
}

// ── Excel round-trip ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_SHEET = "Unmapped Products";
const BRANCH_SHEET = "Unmapped Branches";
const PRODUCT_REF_SHEET = "Master Products";
const REGION_REF_SHEET = "Master Regions";
const AREA_REF_SHEET = "Master Areas";

const HEADER_FILL = "FFF97316";
const REF_HEADER_FILL = "FF0F172A";

function styleHeader(sheet: ExcelJS.Worksheet, fill: string) {
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function listValidation(formula: string, promptTitle: string, prompt: string): ExcelJS.DataValidation {
  return {
    type: "list",
    allowBlank: true,
    formulae: [formula],
    showErrorMessage: true,
    errorTitle: "Not in the list",
    error: "Pick a value from the dropdown list.",
    showInputMessage: true,
    promptTitle,
    prompt,
  };
}

const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'`;

/**
 * The unknowns from THIS file as a fillable workbook — the same "do it in Excel instead" escape
 * hatch monthly offers. Every answer column is a locked dropdown over the live master lists (the
 * owner's standing rule for any "which of these does each of these belong to" question), so a
 * hand-typed code that does not exist can never come back.
 */
export async function buildWeeklyUnmappedWorkbook(
  preview: WeeklyNormalizePreview,
  references: WeeklyNormalizeReferences,
): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const products = workbook.addWorksheet(PRODUCT_SHEET);
  products.columns = [
    { header: "DISTRIBUTOR", key: "distributor", width: 14 },
    { header: "ITEM_CODE", key: "itemCode", width: 20 },
    { header: "ITEM_NAME", key: "itemName", width: 46 },
    { header: "ALIAS_KIND", key: "aliasKind", width: 12 },
    { header: "ROWS", key: "rows", width: 9 },
    { header: "NET_UNITS", key: "netQty", width: 13 },
    { header: "PRODUCT_NAME", key: "productName", width: 46 },
  ];
  for (const item of preview.unknownProducts) {
    products.addRow({
      distributor: preview.distributorCode,
      itemCode: item.itemCode,
      itemName: item.itemName,
      aliasKind: item.aliasKind,
      rows: item.rows,
      netQty: item.netQty,
      productName: "",
    });
  }
  styleHeader(products, HEADER_FILL);

  const branches = workbook.addWorksheet(BRANCH_SHEET);
  branches.columns = [
    { header: "DISTRIBUTOR", key: "distributor", width: 14 },
    { header: "BRANCH", key: "rawBranch", width: 34 },
    { header: "BRANCH_NAME", key: "branchName", width: 34 },
    { header: "FILE_TYPE", key: "fileType", width: 12 },
    { header: "COLUMN_INDEX", key: "columnIndex", width: 14 },
    { header: "ROWS", key: "rows", width: 9 },
    { header: "NET_UNITS", key: "netQty", width: 13 },
    { header: "REGION_NAME", key: "regionName", width: 30 },
    { header: "AREA_NAME", key: "areaName", width: 30 },
  ];
  for (const branch of preview.unknownBranches) {
    branches.addRow({
      distributor: preview.distributorCode,
      rawBranch: branch.rawBranch,
      branchName: branch.branchName,
      fileType: branch.sourceFileType,
      columnIndex: branch.branchColumnIndex ?? "",
      rows: branch.rows,
      netQty: branch.netQty,
      regionName: "",
      areaName: "",
    });
  }
  styleHeader(branches, HEADER_FILL);

  // ── reference sheets (also feed the dropdowns) ──
  const productRef = workbook.addWorksheet(PRODUCT_REF_SHEET);
  productRef.columns = [
    { header: "PRODUCT_NAME", key: "name", width: 46 },
    { header: "PRODUCT_CODE", key: "code", width: 16 },
    { header: "LINE", key: "line", width: 22 },
  ];
  const productChoices = [
    { name: `${IGNORE_PRODUCT_CODE} — we don't sell this`, code: IGNORE_PRODUCT_CODE, line: "" },
    ...references.products.filter((product) => product.code.toUpperCase() !== IGNORE_PRODUCT_CODE).map((product) => ({
      name: `${product.name} (${product.code})`,
      code: product.code,
      line: product.line,
    })),
  ];
  for (const choice of productChoices) productRef.addRow(choice);
  styleHeader(productRef, REF_HEADER_FILL);

  const regionRef = workbook.addWorksheet(REGION_REF_SHEET);
  regionRef.columns = [
    { header: "REGION_NAME", key: "name", width: 30 },
    { header: "REGION_CODE", key: "code", width: 16 },
  ];
  const regionChoices = [
    { name: `${WEEKLY_BRANCH_EXCLUDE_CODE} — exclude this branch`, code: WEEKLY_BRANCH_EXCLUDE_CODE },
    ...references.regions.map((region) => ({ name: `${region.regionName} (${region.regionCode})`, code: region.regionCode })),
  ];
  for (const choice of regionChoices) regionRef.addRow(choice);
  styleHeader(regionRef, REF_HEADER_FILL);

  const areaRef = workbook.addWorksheet(AREA_REF_SHEET);
  areaRef.columns = [
    { header: "AREA_NAME", key: "name", width: 30 },
    { header: "AREA_CODE", key: "code", width: 16 },
    { header: "REGION_CODE", key: "region", width: 16 },
  ];
  const areaChoices = references.areas.map((area) => ({
    name: `${area.areaName} (${area.areaCode})`,
    code: area.areaCode,
    region: area.regionCode,
  }));
  for (const choice of areaChoices) areaRef.addRow(choice);
  styleHeader(areaRef, REF_HEADER_FILL);

  // ── dropdowns on every answer column ──
  const productDV = listValidation(
    `${quoteSheet(PRODUCT_REF_SHEET)}!$A$2:$A$${1 + Math.max(productChoices.length, 1)}`,
    "Phoenix product",
    "Pick the master product this distributor item is. Pick IGNORE if we don't sell it.",
  );
  for (let r = 2; r <= Math.max(preview.unknownProducts.length + 1, 2); r += 1) {
    products.getCell(r, 7).dataValidation = productDV;
  }
  const regionDV = listValidation(
    `${quoteSheet(REGION_REF_SHEET)}!$A$2:$A$${1 + Math.max(regionChoices.length, 1)}`,
    "Region",
    "Pick the master region this branch sells into, or __EXCLUDE__ to drop it from the numbers.",
  );
  const areaDV = listValidation(
    `${quoteSheet(AREA_REF_SHEET)}!$A$2:$A$${1 + Math.max(areaChoices.length, 1)}`,
    "Area (optional)",
    "Leave blank to keep the branch region-only. An area must sit inside the region picked to its left.",
  );
  for (let r = 2; r <= Math.max(preview.unknownBranches.length + 1, 2); r += 1) {
    branches.getCell(r, 8).dataValidation = regionDV;
    branches.getCell(r, 9).dataValidation = areaDV;
  }

  return workbook.xlsx.writeBuffer() as unknown as ArrayBuffer;
}

function cellText(row: ExcelJS.Row, index: number): string {
  const value = row.getCell(index).value as unknown;
  if (value == null) return "";
  if (typeof value === "object") {
    const obj = value as { text?: unknown; result?: unknown; richText?: { text?: string }[] };
    if (obj.richText) return obj.richText.map((part) => part.text).join("").trim();
    if (obj.result != null) return String(obj.result).trim();
    if (obj.text != null) return String(obj.text).trim();
  }
  return String(value).trim();
}

/**
 * Pull a code back out of a "Display Name (CODE)" dropdown label — the templates show names because
 * that is what an operator recognises, while the dictionaries key on codes. A bare code typed by
 * hand still works, so a file edited outside the dropdown is not rejected.
 */
function codeFromLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  const match = /\(([^()]+)\)\s*$/.exec(trimmed);
  if (match) return match[1].trim();
  const dash = trimmed.indexOf(" — ");
  if (dash > 0) return trimmed.slice(0, dash).trim();
  return trimmed;
}

/** The picks a filled unmapped workbook carries: every answered row, each naming its sheet row. */
export async function parseWeeklyFilledWorkbook(buffer: ArrayBuffer | Buffer): Promise<{
  products: WeeklyNormalizeProductMapping[];
  branches: WeeklyNormalizeBranchMapping[];
  scannedRows: number;
}> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const productSheet = workbook.getWorksheet(PRODUCT_SHEET);
  const branchSheet = workbook.getWorksheet(BRANCH_SHEET);
  if (!productSheet && !branchSheet) {
    throw new SalesWorkflowError(
      "invalid_mapping_template",
      `This workbook has neither an "${PRODUCT_SHEET}" nor an "${BRANCH_SHEET}" sheet. Download the list from this page, fill it, and upload that file.`,
      400,
    );
  }

  const products: WeeklyNormalizeProductMapping[] = [];
  const branches: WeeklyNormalizeBranchMapping[] = [];
  let scannedRows = 0;

  if (productSheet) {
    for (let r = 2; r <= productSheet.rowCount; r += 1) {
      const row = productSheet.getRow(r);
      const itemCode = cellText(row, 2);
      const itemName = cellText(row, 3);
      const aliasKind: WeeklyAliasKind = cellText(row, 4).toLowerCase() === "name" ? "name" : "code";
      const productCode = codeFromLabel(cellText(row, 7));
      if (!itemCode && !itemName) continue;
      scannedRows += 1;
      if (!productCode) continue;
      products.push({ alias: aliasKind === "code" ? itemCode || itemName : itemName || itemCode, aliasKind, productCode, row: r });
    }
  }

  if (branchSheet) {
    for (let r = 2; r <= branchSheet.rowCount; r += 1) {
      const row = branchSheet.getRow(r);
      const rawBranch = cellText(row, 2);
      const branchName = cellText(row, 3);
      const fileTypeRaw = cellText(row, 4).toLowerCase();
      const columnIndexRaw = cellText(row, 5);
      const regionCode = codeFromLabel(cellText(row, 8));
      const areaCode = codeFromLabel(cellText(row, 9));
      const columnIndex = columnIndexRaw ? Number(columnIndexRaw) : null;
      if (!rawBranch && columnIndex == null) continue;
      scannedRows += 1;
      if (!regionCode) continue;
      branches.push({
        rawBranch,
        branchName: branchName || null,
        sourceFileType: fileTypeRaw === "sales" || fileTypeRaw === "stock" ? fileTypeRaw : "any",
        branchColumnIndex: Number.isFinite(columnIndex) ? columnIndex : null,
        regionCode,
        areaCode: areaCode || null,
        row: r,
      });
    }
  }

  return { products, branches, scannedRows };
}

// How many failed rows one upload's history record keeps, and how long each cell may run — the
// customer map import's bounds (normalizer/customer-map.ts), for its reason: writeAuditLog bounds its
// first attempt at 8 seconds (3 until 26 Oct 2026), then queues a write it could not land rather than
// losing it, and never throws back at this caller, so only a pathological sheet is ever cut and the
// record itself always saves.
export const WEEKLY_LIST_FAILED_ROWS_KEPT = 5000;
const FAILED_LABEL_MAX = 200;
const FAILED_REASON_MAX = 400;

type WeeklyFailedRow = WeeklyNormalizeSaveResult["failed"][number];

/**
 * The failed rows of one weekly "upload filled list", in the shape its history record keeps them:
 * the product sheet's rows first, then the branch sheet's, each in sheet order. The screen names only
 * the first three failures and no record held any of them, so a fourth could not be found again.
 */
export function weeklyListFailedRecord(failed: WeeklyFailedRow[]): {
  note: string;
  values: { failedRows: WeeklyFailedRow[]; failedRowsKept: number };
} {
  const sheetOrder = (f: WeeklyFailedRow) => (f.kind === "product" ? 0 : 1);
  const kept = [...failed]
    .sort((a, b) => sheetOrder(a) - sheetOrder(b) || (a.row ?? 0) - (b.row ?? 0))
    .slice(0, WEEKLY_LIST_FAILED_ROWS_KEPT)
    .map((f) => ({ kind: f.kind, label: f.label.slice(0, FAILED_LABEL_MAX), reason: f.reason.slice(0, FAILED_REASON_MAX), ...(f.row ? { row: f.row } : {}) }));
  const note = failed.length === 0
    ? ""
    : kept.length === failed.length
      ? " (each listed in this record)"
      : ` (the first ${kept.length} listed in this record)`;
  return { note, values: { failedRows: kept, failedRowsKept: kept.length } };
}

/** Read a filled unmapped workbook back and apply every answered row. */
export async function importWeeklyFilledWorkbook(input: {
  distributorCode: string;
  file: File;
  actorId: string | null;
}): Promise<WeeklyNormalizeSaveResult & { scannedRows: number }> {
  const { products, branches, scannedRows } = await parseWeeklyFilledWorkbook(await input.file.arrayBuffer());

  const result = await saveWeeklyNormalizerMappings({
    distributorCode: input.distributorCode,
    actorId: input.actorId,
    products,
    branches,
  });
  if (products.length + branches.length === 0) return { ...result, scannedRows };

  // The failed rows ride on the upload's own history record, so the list outlives the notice that
  // named three of them — the record the customer map import keeps for its blocked rows.
  const failedRecord = weeklyListFailedRecord(result.failed);
  const distributor = weeklyDistributorByCode(input.distributorCode);
  await writeAuditLog({
    actorLoginId: input.actorId ?? "system",
    entityId: "weekly_unmapped_list",
    entityType: "sales_import_batch",
    newValues: { distributor_code: distributor?.code ?? input.distributorCode, failed: result.failed.length, ...failedRecord.values, savedBranches: result.savedBranches, savedProducts: result.savedProducts, scannedRows, source: "weekly_unmapped_list_upload" },
    summary: `Weekly unmapped list upload for ${distributor?.name ?? input.distributorCode} — ${scannedRows} rows read: ${result.savedProducts} product and ${result.savedBranches} branch mapping(s) saved, ${result.failed.length} could not be saved${failedRecord.note}.`,
  });
  return { ...result, scannedRows };
}
