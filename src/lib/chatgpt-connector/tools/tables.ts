/**
 * Raw read-only table access, for the owner and the CEO (`TABLE_TOOL_ROLES`, table-guard.ts).
 *
 * One fixed query shape through the PostgREST builder on the service client — select an explicit
 * column list, filter, order, a page. Never raw SQL, never `.rpc`, never a write. The table list and
 * each table's columns come from PostgREST's own OpenAPI document, so a name that is not a real
 * public table or view is refused before any query is built.
 *
 * Every row and every character can be read (owner, 17 Nov 2026: "every single table … every single
 * letter"): a page that would not fit in one answer is shortened to whole rows and names the offset
 * the next read starts at, and `phoenix_export_table` puts a whole table in one workbook.
 */
import ExcelJS from "exceljs";
import { z } from "zod";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { storeConnectorFile } from "@/lib/chatgpt-connector/files";
import { capRows, cappedNote, normalizeSearchText } from "@/lib/chatgpt-connector/tools/helpers";
import {
  TABLE_EXPORT_MAX_ROWS,
  TABLE_FILTER_OPS,
  TABLE_READ_MAX_ROWS,
  TABLE_TOOL_ROLES,
  planTableRead,
  readableTables,
  rowsThatFit,
  schemaFromOpenApi,
  type TableReadPlan,
} from "@/lib/chatgpt-connector/tools/table-guard";
import { addPhoenixTableSheet, type ExportRow } from "@/lib/export/table-workbook";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import { defineTool, ToolRefusal } from "@/lib/chatgpt-connector/types";

const SCHEMA_TTL_MS = 10 * 60 * 1000;
let schemaCache: { at: number; schema: Map<string, string[]> } | null = null;

const SALES_TRUTH_NOTE =
  "Never use raw tables for sales, target or achievement figures — call phoenix_sales_achievement: the published Monthly Closing is the only sales truth, " +
  "and raw sales tables hold unpublished, unattributed and unmerged rows that will not match any Phoenix screen.";

/** The public schema's tables and views with their columns, from PostgREST's OpenAPI root. */
async function loadPublicSchema(): Promise<Map<string, string[]>> {
  if (schemaCache && Date.now() - schemaCache.at < SCHEMA_TTL_MS) return schemaCache.schema;
  const base = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  if (!base || !key) throw new ToolRefusal("The database is not configured on this server.");
  const response = await fetch(`${base}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new ToolRefusal(`The table list could not be read (HTTP ${response.status}).`);
  const schema = schemaFromOpenApi(await response.json());
  if (schema.size === 0) throw new ToolRefusal("The table list came back empty.");
  schemaCache = { at: Date.now(), schema };
  return schema;
}

export const listTablesTool = defineTool({
  name: "phoenix_list_tables",
  title: "List database tables",
  description:
    "Owner and CEO. Every Phoenix database table and view with its readable columns (only passwords, tokens, one-time codes and other credentials are left out). " +
    "Use it before phoenix_read_table or phoenix_export_table, and only when no other phoenix_ tool answers the question. " +
    SALES_TRUTH_NOTE,
  roles: TABLE_TOOL_ROLES,
  input: {
    search: z.string().max(80).optional().describe("Only tables whose name contains this text."),
  },
  run: async (_ctx, input) => {
    const wanted = normalizeSearchText(input.search).replace(/ /g, "_");
    const tables = readableTables(await loadPublicSchema()).filter((entry) => !wanted || entry.table.includes(wanted));
    const capped = capRows(tables, 400);
    return {
      summary: `${capped.total} readable table${capped.total === 1 ? "" : "s"}${wanted ? ` matching "${input.search}"` : ""}.${cappedNote(capped.total, capped.rows.length)} ${SALES_TRUTH_NOTE}`,
      data: { tables: capped.rows, total: capped.total, capped: capped.capped },
    };
  },
});

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const filterInput = z
  .array(
    z.object({
      column: z.string().max(80),
      op: z.enum(TABLE_FILTER_OPS),
      value: z.union([scalar, z.array(scalar)]).optional(),
    }),
  )
  .max(20)
  .optional();

const orderInput = z.object({ column: z.string().max(80), ascending: z.boolean().optional() }).optional();

/** A stable order, so page after page neither repeats nor skips a row: the asked one, else `id`, else the first column. */
export function stableOrder(plan: TableReadPlan, known: readonly string[]): { column: string; ascending: boolean } {
  if (plan.orderBy) return plan.orderBy;
  if (known.includes("id")) return { column: "id", ascending: true };
  return { column: plan.columns[0], ascending: true };
}

/** One page of a guarded plan, with PostgREST's row count (exact on small tables, the planner's estimate on huge ones). */
async function readPage(plan: TableReadPlan, known: readonly string[], offset: number, size: number) {
  let query = getSupabaseAdmin().from(plan.table).select(plan.columns.join(","), { count: "estimated" });
  for (const filter of plan.filters) {
    switch (filter.op) {
      case "eq":
        query = query.eq(filter.column, filter.value);
        break;
      case "neq":
        query = query.neq(filter.column, filter.value);
        break;
      case "gt":
        query = query.gt(filter.column, filter.value);
        break;
      case "gte":
        query = query.gte(filter.column, filter.value);
        break;
      case "lt":
        query = query.lt(filter.column, filter.value);
        break;
      case "lte":
        query = query.lte(filter.column, filter.value);
        break;
      case "ilike":
        query = query.ilike(filter.column, String(filter.value));
        break;
      case "in":
        query = query.in(filter.column, filter.value as Array<string | number | boolean | null>);
        break;
      case "is":
        query = query.is(filter.column, filter.value as boolean | null);
        break;
    }
  }
  const order = stableOrder(plan, known);
  query = query.order(order.column, { ascending: order.ascending });
  // Rows that tie on the asked column must keep one order from page to page, or offset paging repeats some and
  // skips others while the answer says every row was read: `id` breaks the tie where the table has one.
  if (order.column !== "id" && known.includes("id")) query = query.order("id", { ascending: true });
  const { data, error, count } = await query.range(offset, offset + size - 1);
  if (error) throw new ToolRefusal(`The read of ${plan.table} failed: ${error.message}`);
  return { rows: (data ?? []) as unknown as Record<string, unknown>[], count: typeof count === "number" ? count : null };
}

const n = (value: number) => value.toLocaleString("en-US");

export const readTableTool = defineTool({
  name: "phoenix_read_table",
  title: "Read a database table",
  description:
    "Owner and CEO. Read rows from any Phoenix table or view, read-only, every column and every character: choose columns, filter (eq, neq, gt, gte, lt, lte, ilike, in, is), order, and page with limit (up to 1000) and offset. " +
    "The answer gives the table's row count and next_offset while rows remain — keep reading with that offset to read the whole table. For a whole table as a file, use phoenix_export_table. " +
    "Only credential columns (passwords, tokens, codes) are refused. Prefer the other phoenix_ tools when one answers the question — they apply Phoenix's business rules; a raw table does not. " +
    SALES_TRUTH_NOTE,
  roles: TABLE_TOOL_ROLES,
  input: {
    table: z.string().min(1).max(80),
    columns: z.array(z.string().max(80)).max(200).optional().describe("Default: every readable column."),
    filters: filterInput,
    orderBy: orderInput,
    limit: z.number().int().min(1).max(TABLE_READ_MAX_ROWS).optional().describe("Rows in this page, up to 1000 (default 200)."),
    offset: z.number().int().min(0).optional().describe("Where this page starts: 0 for the first page, then the next_offset the last answer gave."),
  },
  run: async (_ctx, input) => {
    const schema = await loadPublicSchema();
    const plan = planTableRead(input, schema);
    const page = await readPage(plan, schema.get(plan.table) ?? [], plan.offset, plan.limit);
    // Whole rows only: a page too big for one answer is shortened, never cut mid-row or mid-word.
    const kept = page.rows.slice(0, rowsThatFit(page.rows));
    const first = plan.offset + 1;
    const last = plan.offset + kept.length;
    const more = kept.length < page.rows.length || page.rows.length === plan.limit;
    const nextOffset = more ? last : null;
    const total = page.count;
    const filtered = plan.filters.length > 0;
    const remaining = more && total !== null ? Math.max(total - last, 0) : null;
    const summary =
      kept.length === 0
        ? `No rows in ${plan.table}${plan.offset > 0 ? ` from row ${n(first)}` : ""}${filtered ? " matching these filters" : ""}.`
        : `Rows ${n(first)} to ${n(last)} of ${plan.table}` +
          (total !== null ? ` (the table${filtered ? " with these filters" : ""} holds about ${n(total)})` : "") +
          "." +
          (nextOffset !== null
            ? ` More rows remain${remaining !== null ? ` (about ${n(remaining)})` : ""}: read again with offset ${n(nextOffset)}, or use phoenix_export_table for the whole table as a file.`
            : " That is the last row.");
    return {
      summary,
      data: { table: plan.table, columns: plan.columns, offset: plan.offset, rows: kept, total_rows: total, next_offset: nextOffset },
    };
  },
});

/** Excel holds at most 32,767 characters in one cell. */
const EXCEL_CELL_MAX_CHARS = 32_000;
/** Stop reading pages here and hand over what was read, so the call finishes inside its 40-second limit. */
const EXPORT_READ_BUDGET_MS = 25_000;
const EXPORT_PAGE_ROWS = TABLE_READ_MAX_ROWS;

export function exportCell(value: unknown, cut: { count: number }): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= EXCEL_CELL_MAX_CHARS) return text;
  cut.count += 1;
  return text.slice(0, EXCEL_CELL_MAX_CHARS);
}

export const exportTableTool = defineTool({
  name: "phoenix_export_table",
  title: "Export a whole table to Excel",
  description:
    "Owner and CEO. Put a whole Phoenix table or view — every row and every readable column, optionally filtered — into one Excel workbook and return a download link only this person can open. " +
    "Use it when the person wants all of a table (every employee, every request) rather than an answer about it. It copies ids and codes as stored — for the CRM customer lists (doctors, pharmacies) use phoenix_export_customer_list, which gives names. " +
    "If the table is too big for one file, the answer names the offset to export the rest from. Only credential columns are left out. " +
    SALES_TRUTH_NOTE,
  roles: TABLE_TOOL_ROLES,
  input: {
    table: z.string().min(1).max(80),
    columns: z.array(z.string().max(80)).max(200).optional().describe("Default: every readable column."),
    filters: filterInput,
    orderBy: orderInput,
    offset: z.number().int().min(0).optional().describe("Start from this row (0 = the first). Use the offset a previous export named to get the rest."),
    title: z.string().max(150).optional().describe("The workbook's title. Default: the table's name."),
  },
  async run(ctx, input) {
    const schema = await loadPublicSchema();
    const plan = planTableRead({ ...input, limit: TABLE_EXPORT_MAX_ROWS }, schema, TABLE_EXPORT_MAX_ROWS);
    const known = schema.get(plan.table) ?? [];
    const started = Date.now();
    const rows: Record<string, unknown>[] = [];
    let total: number | null = null;
    let offset = plan.offset;
    let exhausted = false;
    while (rows.length < TABLE_EXPORT_MAX_ROWS && Date.now() - started < EXPORT_READ_BUDGET_MS) {
      const size = Math.min(EXPORT_PAGE_ROWS, TABLE_EXPORT_MAX_ROWS - rows.length);
      const page = await readPage(plan, known, offset, size);
      if (total === null) total = page.count;
      rows.push(...page.rows);
      offset += page.rows.length;
      if (page.rows.length < size) {
        exhausted = true;
        break;
      }
    }
    const filtered = plan.filters.length > 0;
    if (rows.length === 0) {
      return {
        summary: `No rows in ${plan.table}${filtered ? " matching these filters" : ""}${plan.offset > 0 ? ` from row ${n(plan.offset + 1)}` : ""}; no file was made.`,
        data: { table: plan.table, rows: 0 },
      };
    }

    const cut = { count: 0 };
    const sheetRows: ExportRow[] = rows.map((row) => Object.fromEntries(plan.columns.map((column) => [column, exportCell(row[column], cut)])));
    const title = (input.title ?? "").trim() || plan.table;
    const first = plan.offset + 1;
    const last = plan.offset + rows.length;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Phoenix Workforce";
    workbook.created = new Date();
    addPhoenixTableSheet(workbook, {
      title,
      subtitle: `${plan.table} · rows ${n(first)} to ${n(last)} · built ${cairoDateTimeSortable(new Date().toISOString())} Cairo`,
      sheetName: plan.table.slice(0, 31),
      columns: plan.columns.map((column) => ({ key: column, label: column })),
      rows: sheetRows,
      theme: "house",
    });
    const body = Buffer.from(await workbook.xlsx.writeBuffer());
    const file = await storeConnectorFile(ctx, { kind: "xlsx", title, body });
    const nextOffset = exhausted ? null : last;
    return {
      summary:
        `The sheet is ready: ${file.fileName}, rows ${n(first)} to ${n(last)} of ${plan.table}` +
        (total !== null ? ` (about ${n(total)} in all${filtered ? " with these filters" : ""})` : "") +
        `, ${plan.columns.length} columns. Download it here (it opens for you only, while you are signed in to Phoenix, until ${cairoDateTimeSortable(file.expiresAt)} Cairo): ${file.url}` +
        (nextOffset !== null ? ` More rows remain: export again with offset ${n(nextOffset)} for the next file.` : " That is every row.") +
        (cut.count > 0
          ? ` ${n(cut.count)} cell${cut.count === 1 ? " was" : "s were"} longer than Excel can hold (32,000 characters) and shortened; read ${cut.count === 1 ? "that row" : "those rows"} with phoenix_read_table for the whole text.`
          : ""),
      data: {
        download_url: file.url,
        file_name: file.fileName,
        table: plan.table,
        first_row: first,
        last_row: last,
        total_rows: total,
        next_offset: nextOffset,
        columns: plan.columns,
        size_bytes: file.sizeBytes,
        expires_at: file.expiresAt,
      },
    };
  },
});
