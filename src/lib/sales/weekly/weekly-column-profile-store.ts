// Weekly column contract: code defaults (column-contract.ts) MERGED with a governed, DB-backed editable
// override (weekly_sales_distributor_column_profile). An active DB row WHOLLY overrides the code contract
// for that distributor (whole-profile override, mirroring the monthly source_of_sales_distributor_profile
// model). Code is the fallback/seed. Server-only.
//
// Resolution is DB-first with a short cache. If the table is absent (unapplied migration) the load fails
// CLOSED to the code contract and LOGS — so an unapplied migration degrades to exactly the current parsing
// behaviour, never a silent blank. The parser keeps the code contract as its compiled default and only
// reads an override when one is resolved, so "no DB override == byte-identical current parse".

import { logError } from "@/lib/observability/log";
import {
  listCodeWeeklyContracts,
  weeklyContractByCode,
  type WeeklyContractMatrix,
  type WeeklyContractMatrixKind,
  type WeeklyContractField,
  type WeeklyContractFieldRole,
  type WeeklyContractSheet,
  type WeeklyContractSheetRole,
  type WeeklyDistributorContract,
} from "@/lib/sales/weekly/column-contract";
import { weeklySheetMatcher } from "@/lib/sales/weekly/sheet-match";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const PROFILE_TABLE = "weekly_sales_distributor_column_profile";
const CACHE_TTL_MS = 30_000;

export type WeeklyColumnProfileRow = {
  distributor_code: string;
  distributor_name?: string | null;
  split_files?: boolean | null;
  sheets?: unknown;
  active?: boolean | null;
};

/** An editor-facing contract: the resolved contract plus whether it came from a DB override. */
export type EditableWeeklyContract = WeeklyDistributorContract & { isCustom: boolean };

let cache: { at: number; byCode: Map<string, WeeklyColumnProfileRow> } | null = null;

/** Drop the cached DB overrides so the next read reflects a just-saved edit. */
export function invalidateWeeklyColumnProfileCache(): void {
  cache = null;
}

function codeKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

// ── defensive jsonb → typed contract reconstruction ──────────────────────────────────────────────

const FIELD_ROLES: readonly WeeklyContractFieldRole[] = ["key", "value", "context"];
const SHEET_ROLES: readonly WeeklyContractSheetRole[] = ["combined", "sales", "returns", "stock"];
const MATRIX_KINDS: readonly WeeklyContractMatrixKind[] = ["branch-headers", "location-columns"];
const FORM_FIELDS = ["file", "salesFile", "stockFile"] as const;

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(asString(value));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function parseField(raw: unknown): WeeklyContractField | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const field = asString(r.field).trim();
  if (!field) return null;
  const role = FIELD_ROLES.includes(r.role as WeeklyContractFieldRole) ? (r.role as WeeklyContractFieldRole) : "context";
  return {
    field,
    label: asString(r.label).trim() || field,
    columnIndex: asInt(r.columnIndex),
    expectedHeaderHint: asString(r.expectedHeaderHint),
    role,
  };
}

function parseMatrix(raw: unknown): WeeklyContractMatrix | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const kind = MATRIX_KINDS.includes(r.kind as WeeklyContractMatrixKind) ? (r.kind as WeeklyContractMatrixKind) : undefined;
  if (!kind) return undefined;
  const matrix: WeeklyContractMatrix = {
    kind,
    firstColumn: asInt(r.firstColumn),
    note: asString(r.note),
  };
  if (r.lastColumn != null && asInt(r.lastColumn) > 0) matrix.lastColumn = asInt(r.lastColumn);
  if (typeof r.stopAtHeaderPattern === "string" && r.stopAtHeaderPattern.trim()) matrix.stopAtHeaderPattern = r.stopAtHeaderPattern;
  return matrix;
}

function parseSheet(raw: unknown, code: string): WeeklyContractSheet | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const role = SHEET_ROLES.includes(r.role as WeeklyContractSheetRole) ? (r.role as WeeklyContractSheetRole) : null;
  if (!role) return null;
  const formField = (FORM_FIELDS as readonly string[]).includes(asString(r.formField)) ? (asString(r.formField) as WeeklyContractSheet["formField"]) : "file";
  const fields = Array.isArray(r.fields) ? r.fields.map(parseField).filter((f): f is WeeklyContractField => f !== null) : [];
  const sheet: WeeklyContractSheet = {
    role,
    headerRowNumber: asInt(r.headerRowNumber) || 1,
    formField,
    fields,
  };
  // Sheet names are never taken from storage: a saved override holds whatever the code contract said on
  // the day it was saved (EGD's stock sheet was once "Stock"). They come from sheet-match.ts, the rule the
  // importer itself uses to pick a worksheet.
  const matcher = weeklySheetMatcher(code, role);
  if (matcher) {
    sheet.sheetName = matcher.name;
    sheet.sheetIncludes = matcher.includes;
  }
  const matrix = parseMatrix(r.matrix);
  if (matrix) sheet.matrix = matrix;
  return sheet;
}

/** DB row → typed WeeklyDistributorContract (defensive). Returns null if the row has no usable sheets. */
export function dbRowToContract(row: WeeklyColumnProfileRow): WeeklyDistributorContract | null {
  const code = codeKey(row.distributor_code);
  if (!code) return null;
  const sheetsRaw = Array.isArray(row.sheets) ? row.sheets : [];
  const sheets = sheetsRaw.map((raw) => parseSheet(raw, code)).filter((s): s is WeeklyContractSheet => s !== null);
  if (sheets.length === 0) return null;
  const codeContract = weeklyContractByCode(code);
  return {
    code,
    name: asString(row.distributor_name).trim() || codeContract?.name || code,
    splitFiles: row.split_files != null ? Boolean(row.split_files) : Boolean(codeContract?.splitFiles),
    sheets,
  };
}

// Active DB override rows keyed by canonical code. Fail-closed to {} on a missing table / error, but LOG.
async function loadWeeklyColumnProfiles(): Promise<Map<string, WeeklyColumnProfileRow>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.byCode;
  const byCode = new Map<string, WeeklyColumnProfileRow>();
  // Only a read that SUCCEEDED is cached (cache audit, 2026-10-26). A failed one used to cache the
  // empty map for the whole TTL, so every upload in that window parsed on the code defaults with the
  // saved overrides ignored; now it answers this one call and the next call reads again.
  let loaded = false;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from(PROFILE_TABLE).select("*").eq("active", true);
    if (error) {
      logError("Weekly column profile override load failed", {
        labels: { event: "weekly_column_profile_load_failed", errorCode: error.code ?? "unknown" },
        error,
      });
    } else {
      for (const raw of data ?? []) {
        const row = raw as WeeklyColumnProfileRow;
        const code = codeKey(row.distributor_code);
        if (code) byCode.set(code, row);
      }
      loaded = true;
    }
  } catch (e) {
    logError("Weekly column profile override load threw", {
      labels: { event: "weekly_column_profile_load_threw" },
      error: e,
    });
  }
  if (loaded) cache = { at: Date.now(), byCode };
  return byCode;
}

// ── PURE merge ────────────────────────────────────────────────────────────────────────────────

/** code ∪ DB contracts, DB wins whole-row (unit-tested precedence). */
export function mergeWeeklyContractsByCode(
  codeContracts: readonly WeeklyDistributorContract[],
  dbContracts: readonly WeeklyDistributorContract[],
): WeeklyDistributorContract[] {
  const byCode = new Map<string, WeeklyDistributorContract>();
  for (const c of codeContracts) byCode.set(codeKey(c.code), c);
  for (const c of dbContracts) byCode.set(codeKey(c.code), c);
  return [...byCode.values()];
}

// ── resolution (DB-first, code fallback) ─────────────────────────────────────────────────────────

/**
 * Resolve a distributor's weekly column contract: an active DB override first, else the code contract.
 * Returns undefined only when neither exists (an unknown distributor). The parser calls this and, when
 * the table is empty/absent, gets exactly the code contract → byte-identical parsing.
 */
export async function resolveWeeklyContract(code: string | null | undefined): Promise<WeeklyDistributorContract | undefined> {
  const key = codeKey(code);
  if (!key) return undefined;
  const db = await loadWeeklyColumnProfiles();
  const row = db.get(key);
  return (row && dbRowToContract(row)) || weeklyContractByCode(key);
}

/**
 * Resolve the contract AND report whether it came from an in-app DB override ('override') or the
 * built-in code contract ('code'). Used to stamp each upload batch for traceability.
 */
export async function resolveWeeklyContractWithSource(
  code: string | null | undefined,
): Promise<{ contract: WeeklyDistributorContract | undefined; source: "code" | "override" }> {
  const key = codeKey(code);
  if (!key) return { contract: undefined, source: "code" };
  const db = await loadWeeklyColumnProfiles();
  const row = db.get(key);
  const dbContract = row && dbRowToContract(row);
  if (dbContract) return { contract: dbContract, source: "override" };
  return { contract: weeklyContractByCode(key), source: "code" };
}

/** All known weekly contracts as editor shapes (code defaults overlaid by DB rows, with isCustom). */
export async function listEditableWeeklyContracts(): Promise<EditableWeeklyContract[]> {
  const db = await loadWeeklyColumnProfiles();
  const byCode = new Map<string, EditableWeeklyContract>();
  for (const c of listCodeWeeklyContracts()) byCode.set(codeKey(c.code), { ...c, isCustom: false });
  for (const [key, row] of db) {
    const contract = dbRowToContract(row);
    if (contract) byCode.set(key, { ...contract, isCustom: true });
  }
  return [...byCode.values()];
}
