/**
 * Raw read-only table access, for the owner's seat alone (`TABLE_TOOL_ROLES`, table-guard.ts).
 *
 * One fixed query shape through the PostgREST builder on the service client — select an explicit
 * column list, filter, order, limit. Never raw SQL, never `.rpc`, never a write. The table list and
 * each table's columns come from PostgREST's own OpenAPI document, so a name that is not a real
 * public table or view is refused before any query is built.
 */
import { z } from "zod";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { capRows, cappedNote, normalizeSearchText } from "@/lib/chatgpt-connector/tools/helpers";
import {
  TABLE_FILTER_OPS,
  TABLE_READ_MAX_ROWS,
  TABLE_TOOL_ROLES,
  planTableRead,
  readableTables,
  schemaFromOpenApi,
} from "@/lib/chatgpt-connector/tools/table-guard";
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
    "Owner only. The Phoenix database's public tables and views with their readable columns (sign-in, session, token and other security tables and columns are never listed). " +
    "Use it before phoenix_read_table, and only when no other phoenix_ tool answers the question. " +
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

export const readTableTool = defineTool({
  name: "phoenix_read_table",
  title: "Read a database table",
  description:
    "Owner only. Read rows from one public table or view, read-only: choose columns, filter (eq, neq, gt, gte, lt, lte, ilike, in, is), order and limit (at most 500). " +
    "Security tables and columns are refused. Prefer the other phoenix_ tools — they apply Phoenix's business rules; a raw table does not. " +
    SALES_TRUTH_NOTE,
  roles: TABLE_TOOL_ROLES,
  input: {
    table: z.string().min(1).max(80),
    columns: z.array(z.string().max(80)).max(60).optional().describe("Default: every readable column."),
    filters: z
      .array(
        z.object({
          column: z.string().max(80),
          op: z.enum(TABLE_FILTER_OPS),
          value: z.union([scalar, z.array(scalar)]).optional(),
        }),
      )
      .max(20)
      .optional(),
    orderBy: z.object({ column: z.string().max(80), ascending: z.boolean().optional() }).optional(),
    limit: z.number().int().min(1).max(TABLE_READ_MAX_ROWS).optional(),
  },
  run: async (_ctx, input) => {
    const plan = planTableRead(input, await loadPublicSchema());
    let query = getSupabaseAdmin().from(plan.table).select(plan.columns.join(","));
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
    if (plan.orderBy) query = query.order(plan.orderBy.column, { ascending: plan.orderBy.ascending });
    const { data, error } = await query.limit(plan.limit);
    if (error) throw new ToolRefusal(`The read of ${plan.table} failed: ${error.message}`);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    return {
      summary: `${rows.length} row${rows.length === 1 ? "" : "s"} from ${plan.table}${rows.length === plan.limit ? ` (the limit of ${plan.limit}; there may be more)` : ""}.`,
      data: { table: plan.table, columns: plan.columns, rows, limit: plan.limit },
    };
  },
});
