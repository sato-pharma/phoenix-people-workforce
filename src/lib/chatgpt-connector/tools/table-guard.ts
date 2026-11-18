/**
 * The raw-table reader's guard: which tables and columns may ever leave the server, and the one
 * fixed query shape a read may take. Pure — no database — so tests/chatgpt-connector-tools.test.ts
 * pins every rule here. The reader itself is tools/tables.ts.
 *
 * The owner and the CEO (`TABLE_TOOL_ROLES`) — the owner's word, 17 Nov 2026: "read every single table
 * in the system, every single letter … answer me or Dr. Anwar". A raw read shows the CEO more than his
 * screens do, and that is the decision. Only credentials stay out (the deny lists below).
 */
import { ToolRefusal, type ConnectorRole } from "@/lib/chatgpt-connector/types";
import { POSTGREST_ROW_CEILING } from "@/lib/supabase/row-cap-watch";

export const TABLE_TOOL_ROLES: readonly ConnectorRole[] = ["Super Admin", "CEO"];

/** One page of a read — one PostgREST page. A whole table is read page after page with `offset`; nothing is left out. */
export const TABLE_READ_MAX_ROWS = POSTGREST_ROW_CEILING;
export const TABLE_READ_DEFAULT_ROWS = 200;
/** A whole-table export reads at most this many rows into one workbook. */
export const TABLE_EXPORT_MAX_ROWS = 50_000;

export const TABLE_NAME_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Tables that hold credentials, sessions, one-time codes, sign-in links or share/approval tokens.
 * Never listed, never read, whatever columns are asked for.
 */
const DENIED_TABLE_PATTERNS: readonly RegExp[] = [
  /^app_auth_(?!users$)/, // credentials, second step, recovery codes, trusted devices, webauthn
  /^connector_oauth_/,
  /^connector_files$/,
  /^push_subscriptions$/,
  /^recovery$/,
  /^api_rate_limit_buckets$/,
  /password/,
  /passkey/,
  /webauthn/,
  /secret/,
  /token/,
  /credential/,
  /second_step/,
  /trusted_device/,
  /(^|_)otp(_|s?$)/,
  /vault/,
  /share_links?$/,
  /_shares$/,
  /preview_links?$/,
  /calendar_links?$/,
];

/**
 * Columns that are, or can stand in for, a credential: passwords and their hashes, secrets, tokens,
 * one-time and recovery codes, API/private/signing keys, sealed values, nonces, cookies. Every
 * `*hash*` column is held back too — some are only content fingerprints, but a hash is never what a
 * business question needs.
 */
const DENIED_COLUMN_PATTERNS: readonly RegExp[] = [
  /password/,
  /passcode/,
  /secret/,
  /token/,
  /hash/,
  /(^|_)otp(_|s?$)/,
  /recovery_code/,
  /credential/,
  /sealed/,
  /nonce/,
  /cookie/,
  /salt$/,
  /(^|_)(api|private|access|signing|encryption|service|session|secret)_?key/,
  /^key$/,
];

export function isDeniedTable(table: string): boolean {
  const name = table.trim().toLowerCase();
  return DENIED_TABLE_PATTERNS.some((pattern) => pattern.test(name));
}

export function isDeniedColumn(column: string): boolean {
  const name = column.trim().toLowerCase();
  return DENIED_COLUMN_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * A column that is a credential in ONE table only. `app_sessions.id` is the session id a signed-in
 * browser carries, so the sign-in history is readable without it.
 */
const DENIED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  app_sessions: ["id"],
};

function isDeniedTableColumn(table: string | undefined, column: string): boolean {
  if (!table) return false;
  return (DENIED_TABLE_COLUMNS[table.trim().toLowerCase()] ?? []).includes(column.trim().toLowerCase());
}

/** The columns of a table that may be read: well-formed names, none on the deny lists. */
export function readableColumns(columns: readonly string[], table?: string): string[] {
  return columns.filter((column) => TABLE_NAME_RE.test(column) && !isDeniedColumn(column) && !isDeniedTableColumn(table, column));
}

/** The readable tables of a schema map (table → its columns), sorted, deny-listed ones gone. */
export function readableTables(schema: ReadonlyMap<string, readonly string[]>): Array<{ table: string; columns: string[] }> {
  return [...schema.entries()]
    .filter(([table]) => TABLE_NAME_RE.test(table) && !isDeniedTable(table))
    .map(([table, columns]) => ({ table, columns: readableColumns(columns, table) }))
    .sort((left, right) => left.table.localeCompare(right.table));
}

export const TABLE_FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "ilike", "in", "is"] as const;
export type TableFilterOp = (typeof TABLE_FILTER_OPS)[number];

export type TableScalar = string | number | boolean | null;

export type TableFilterInput = { column: string; op: TableFilterOp; value?: unknown };

export type TableReadInput = {
  table: string;
  columns?: string[];
  filters?: TableFilterInput[];
  orderBy?: { column: string; ascending?: boolean };
  limit?: number;
  offset?: number;
};

export type TableReadPlan = {
  table: string;
  columns: string[];
  filters: Array<{ column: string; op: TableFilterOp; value: TableScalar | TableScalar[] }>;
  orderBy: { column: string; ascending: boolean } | null;
  limit: number;
  offset: number;
};

/**
 * What breaks a tie on the order column, so rows that tie keep one order from page to page: `id` where the table
 * has one, else every other column the read selects (a relation with no id — `page_timings` orders by a
 * non-unique hour — is otherwise left to the planner's tie order, which can differ per OFFSET page). Only columns
 * the read already selects are used, so a credential column is never ordered by. Rows identical on all of them
 * are indistinguishable in the answer, so whichever page holds them says the same thing.
 */
export function orderTiebreakers(order: { column: string }, plan: Pick<TableReadPlan, "columns">, known: readonly string[]): string[] {
  if (known.includes("id")) return order.column === "id" ? [] : ["id"];
  return plan.columns.filter((column) => column !== order.column);
}

/** What a sign-in name that matches no account reads as. */
export const NOT_AN_ACCOUNT_TEXT = "(not an account)";

/** The two places sign-in text a person TYPED is stored: the attempts table and the audit rows of an auth_session. */
export function holdsTypedSignInText(table: string): boolean {
  return table === "auth_login_attempts" || table === "audit_logs";
}

/**
 * Columns the mask needs to judge a row that the caller did not ask for (an audit row is a sign-in row by its
 * `entity_type`, and its entity is typed text only when it equals its actor). Read internally, dropped from the answer.
 */
export function signInMaskExtraColumns(table: string, columns: readonly string[]): string[] {
  if (table !== "audit_logs" || !(columns.includes("actor_login_id") || columns.includes("entity_id"))) return [];
  return ["entity_type", "actor_login_id"].filter((column) => !columns.includes(column));
}

/**
 * A wrong sign-in name is stored as typed — a password pasted into the login-id box is stored as text — and the table
 * tools read every table, so what matches no account is shown as "(not an account)" instead. Real login ids and HR ids
 * (`accounts`, lower-cased) stay visible, so "who failed to sign in" still works; only text that proves nobody is hidden.
 * An audit row's entity is masked only when it IS its actor's typed text: another auth row's entity (a blocked address)
 * is not a sign-in name. `extraColumns` are removed from the answer.
 */
export function maskUnrecognizedIdentifiers(
  table: string,
  rows: readonly Record<string, unknown>[],
  accounts: ReadonlySet<string>,
  extraColumns: readonly string[] = [],
): Record<string, unknown>[] {
  const matchesAnAccount = (value: unknown) => {
    const text = String(value ?? "").trim().toLowerCase();
    return text === "" || text === "system" || accounts.has(text);
  };
  return rows.map((row) => {
    const next: Record<string, unknown> = { ...row };
    if (table === "auth_login_attempts") {
      if (typeof next.login_id === "string" && !matchesAnAccount(next.login_id)) next.login_id = NOT_AN_ACCOUNT_TEXT;
    } else if (table === "audit_logs" && row.entity_type === "auth_session") {
      const actor = row.actor_login_id;
      if (typeof actor === "string" && !matchesAnAccount(actor)) {
        next.actor_login_id = NOT_AN_ACCOUNT_TEXT;
        if (typeof row.entity_id === "string" && row.entity_id.trim().toLowerCase() === actor.trim().toLowerCase()) next.entity_id = NOT_AN_ACCOUNT_TEXT;
      }
    }
    for (const column of extraColumns) delete next[column];
    return next;
  });
}

function isScalar(value: unknown): value is TableScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Validate one read against the live schema and the deny lists, and return the only shape the
 * reader will run: an explicit column list (never `*`), filters on readable columns only (a filter
 * on a secret column would leak it one guess at a time), one order, a page size and where the page
 * starts. `maxRows` is the page ceiling (a whole-table export passes its own).
 */
export function planTableRead(
  input: TableReadInput,
  schema: ReadonlyMap<string, readonly string[]>,
  maxRows: number = TABLE_READ_MAX_ROWS,
): TableReadPlan {
  const table = String(input.table ?? "").trim();
  if (!TABLE_NAME_RE.test(table)) throw new ToolRefusal(`"${table}" is not a table name.`);
  if (isDeniedTable(table)) throw new ToolRefusal(`${table} holds sign-in or security data and is never read through this connector.`);
  const known = schema.get(table);
  if (!known) throw new ToolRefusal(`There is no table or view called ${table}. Call phoenix_list_tables for the list.`);
  const allowed = new Set(readableColumns(known, table));
  if (allowed.size === 0) throw new ToolRefusal(`${table} has no column this connector may read.`);

  const askColumn = (column: string, purpose: string): string => {
    const name = String(column ?? "").trim();
    if (isDeniedColumn(name) || isDeniedTableColumn(table, name)) {
      throw new ToolRefusal(`${table}.${name} is a security column and is never read or filtered.`);
    }
    if (!allowed.has(name)) throw new ToolRefusal(`${table} has no readable column called ${name} (${purpose}).`);
    return name;
  };

  const columns = input.columns && input.columns.length > 0
    ? [...new Set(input.columns.map((column) => askColumn(column, "columns")))]
    : [...allowed];

  const filters = (input.filters ?? []).slice(0, 20).map((filter) => {
    const column = askColumn(filter.column, "filters");
    if (!(TABLE_FILTER_OPS as readonly string[]).includes(filter.op)) throw new ToolRefusal(`Unknown filter operator ${filter.op}.`);
    if (filter.op === "in") {
      const values = Array.isArray(filter.value) ? filter.value : [];
      if (values.length === 0 || values.length > 200 || !values.every(isScalar)) {
        throw new ToolRefusal(`The "in" filter on ${column} needs a list of 1 to 200 plain values.`);
      }
      return { column, op: filter.op, value: values as TableScalar[] };
    }
    if (filter.op === "is") {
      if (filter.value !== null && filter.value !== true && filter.value !== false) {
        throw new ToolRefusal(`The "is" filter on ${column} takes null, true or false.`);
      }
      return { column, op: filter.op, value: filter.value as TableScalar };
    }
    if (!isScalar(filter.value) || filter.value === null) {
      throw new ToolRefusal(`The ${filter.op} filter on ${column} needs one plain value (use "is" for null).`);
    }
    if (filter.op === "ilike" && typeof filter.value !== "string") throw new ToolRefusal(`ilike on ${column} needs text.`);
    return { column, op: filter.op, value: filter.value };
  });

  const orderBy = input.orderBy
    ? { column: askColumn(input.orderBy.column, "orderBy"), ascending: input.orderBy.ascending !== false }
    : null;

  const requested = Number(input.limit ?? TABLE_READ_DEFAULT_ROWS);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), maxRows) : Math.min(TABLE_READ_DEFAULT_ROWS, maxRows);
  const from = Number(input.offset ?? 0);
  const offset = Number.isFinite(from) ? Math.max(Math.trunc(from), 0) : 0;

  return { table, columns, filters, orderBy, limit, offset };
}

/**
 * How many rows of a page fit in one answer without cutting a single character. ChatGPT's answer is
 * capped (`CONNECTOR_MAX_TEXT_CHARS`), and a cut answer loses the end of the data; so a page is
 * shortened to whole rows that fit, and the next read starts where this one stopped. At least one
 * row is always sent.
 */
export const TABLE_PAGE_BUDGET_CHARS = 150_000;

export function rowsThatFit(rows: readonly Record<string, unknown>[], budgetChars: number = TABLE_PAGE_BUDGET_CHARS): number {
  let used = 2;
  for (let index = 0; index < rows.length; index += 1) {
    // Measured the way the answer is written (indented JSON, nested three deep), so the page fits.
    const written = JSON.stringify(rows[index], null, 1);
    used += written.length + written.split("\n").length * 4 + 2;
    if (used > budgetChars) return Math.max(index, 1);
  }
  return rows.length;
}

/**
 * Table → column names from PostgREST's OpenAPI document (`definitions`). Anything that is not an
 * object with `properties` is skipped.
 */
export function schemaFromOpenApi(document: unknown): Map<string, string[]> {
  const schema = new Map<string, string[]>();
  const definitions = (document as { definitions?: Record<string, unknown> } | null)?.definitions;
  if (!definitions || typeof definitions !== "object") return schema;
  for (const [table, definition] of Object.entries(definitions)) {
    const properties = (definition as { properties?: Record<string, unknown> } | null)?.properties;
    if (!properties || typeof properties !== "object") continue;
    schema.set(table, Object.keys(properties));
  }
  return schema;
}
