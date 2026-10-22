#!/usr/bin/env node
// PostToolUse + PostToolUseFailure(…__execute_sql) hint — A GUESSED COLUMN NAME.
//
// On 22 Oct 2026 at 02:47 Cairo an audit session asked phoenix_crm_places for `pin_captured_at`.
// No such column exists: the place's pin time is `captured_at`, and the only column with that name
// in it is `pharmacy_pin_captured_at` on phoenix_crm_customers. Postgres answered 42703, the session
// guessed again, and the owner saw the raw error. The cause was never the database: it was writing
// a column from memory instead of reading the table.
//
// This hook turns that error into the answer. When an execute_sql call fails with "column … does not
// exist", it works out which table the alias points at (from the query's own FROM/JOIN clauses),
// reads that table's REAL columns from PostgREST's schema (production only, through .env.local's
// service key; no key or no network → it names the information_schema query to run instead), and
// tells the session the nearest real names. So the next query is right, instead of a second guess.
//
// It WARNS, it never blocks: the tool already ran. Fails open, silent, on any error.
// Owner instruction: "fix the error reason", 2026-10-22.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MISSING_COLUMN = /column\s+"?(?:(\w+)\.)?(\w+)"?\s+(?:of relation\s+"?(\w+)"?\s+)?does not exist/i;
const PG_HINT = /HINT:\s*([^\n"\\]+)/;
const FROM_JOIN = /\b(?:from|join)\s+(?:only\s+)?((?:"?\w+"?\.)?"?\w+"?)(?:\s+(?:as\s+)?("?\w+"?))?/gi;
const NOT_AN_ALIAS = new Set([
  'where', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'lateral', 'using',
  'group', 'order', 'limit', 'offset', 'union', 'except', 'intersect', 'window', 'having', 'set', 'returning',
  'for', 'fetch', 'and', 'or', 'with', 'select', 'tablesample',
]);
const unquote = (s) => String(s ?? '').replace(/"/g, '');

/** The text of the tool's answer, whichever shape the event carries it in. */
export function errorText(payload) {
  const parts = [];
  const take = (v) => {
    if (v == null) return;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(take);
    else if (typeof v === 'object' && typeof v.text === 'string') parts.push(v.text);
    else parts.push(JSON.stringify(v));
  };
  take(payload?.error);
  take(payload?.tool_response);
  return parts.join('\n').replace(/\\"/g, '"').replace(/\\n/g, '\n');
}

/** `{ qualifier, column, relation, hint }` for a 42703 "column does not exist", or null. */
export function parseMissingColumn(text) {
  const m = MISSING_COLUMN.exec(String(text ?? ''));
  if (!m) return null;
  const hint = PG_HINT.exec(String(text))?.[1]?.trim() ?? null;
  return { qualifier: m[1] ?? null, column: m[2], relation: m[3] ?? null, hint };
}

/** alias → table, from the query's FROM and JOIN clauses. A table is also its own alias. */
export function aliasMap(query) {
  const map = new Map();
  for (const m of String(query ?? '').matchAll(FROM_JOIN)) {
    const table = unquote(m[1]).split('.').pop();
    if (!table || NOT_AN_ALIAS.has(table.toLowerCase())) continue;
    map.set(table.toLowerCase(), table);
    const alias = unquote(m[2]);
    if (alias && !NOT_AN_ALIAS.has(alias.toLowerCase())) map.set(alias.toLowerCase(), table);
  }
  return map;
}

/** The CTE names the query defines — an alias that resolves to one is not a table we can list. */
export function cteNames(query) {
  return new Set(
    [...String(query ?? '').matchAll(/(?:\bwith\s+(?:recursive\s+)?|,\s*)"?(\w+)"?\s+as\s+(?:(?:not\s+)?materialized\s+)?\(/gi)].map((m) =>
      m[1].toLowerCase(),
    ),
  );
}

/** Which tables the missing column could belong to. */
export function candidateTables(missing, query) {
  if (missing.relation) return [missing.relation];
  const map = aliasMap(query);
  if (missing.qualifier) {
    const t = map.get(missing.qualifier.toLowerCase());
    return t ? [t] : [];
  }
  return [...new Set(map.values())];
}

/** Real columns ranked by how many name parts they share with the guess. */
export function nearestColumns(guess, columns, limit = 5) {
  const parts = String(guess).toLowerCase().split('_').filter(Boolean);
  return columns
    .map((c) => {
      const lc = c.toLowerCase();
      const cparts = lc.split('_');
      let score = parts.filter((p) => cparts.includes(p)).length;
      if (lc.includes(guess.toLowerCase()) || guess.toLowerCase().includes(lc)) score += 2;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.length - b.c.length)
    .slice(0, limit)
    .map((x) => x.c);
}

function readEnv(dir) {
  const env = {};
  const file = join(dir, '.env.local');
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/** table → columns for the project, from PostgREST's own schema. null when it cannot be read. */
async function liveColumns(projectId, dir) {
  if (process.env.PHX_SQL_HINT_COLUMNS_JSON) return JSON.parse(process.env.PHX_SQL_HINT_COLUMNS_JSON);
  if (process.env.PHX_SQL_HINT_OFFLINE === '1') return null;
  const env = { ...readEnv(dir), ...process.env };
  const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !projectId || !url.includes(projectId)) return null;
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return null;
  const spec = await res.json();
  const out = {};
  for (const [name, def] of Object.entries(spec?.definitions ?? {})) out[name] = Object.keys(def?.properties ?? {});
  return out;
}

export async function buildHint(payload, dir) {
  if (!/__execute_sql$/.test(String(payload?.tool_name ?? ''))) return null;
  const missing = parseMissingColumn(errorText(payload));
  if (!missing) return null;
  const query = String(payload?.tool_input?.query ?? '');
  const label = missing.qualifier ? `${missing.qualifier}.${missing.column}` : missing.column;
  const ctes = cteNames(query);
  const tables = candidateTables(missing, query).filter((t) => !ctes.has(t.toLowerCase()));

  const lines = [`COLUMN GUESSED, NOT READ: \`${label}\` does not exist.`];
  if (missing.qualifier && ctes.has(missing.qualifier.toLowerCase())) {
    lines.push(`\`${missing.qualifier}\` is a CTE in this query — use a column name its own SELECT list gives.`);
  }
  let schema = null;
  try {
    schema = tables.length ? await liveColumns(payload?.tool_input?.project_id, dir) : null;
  } catch {
    schema = null;
  }
  let listed = false;
  for (const t of tables) {
    const cols = schema?.[t];
    if (!cols?.length) continue;
    listed = true;
    const near = nearestColumns(missing.column, cols);
    lines.push(
      `${t}'s real columns${near.length ? ` — nearest to \`${missing.column}\`: ${near.map((c) => `\`${c}\``).join(', ')}` : ''}. ` +
        `All ${cols.length}: ${cols.join(', ')}.`,
    );
  }
  if (!listed && tables.length) {
    lines.push(
      `Read the real columns before the next query: select table_name, column_name from information_schema.columns ` +
        `where table_schema = 'public' and table_name in (${tables.map((t) => `'${t}'`).join(', ')}) order by table_name, ordinal_position;`,
    );
  }
  if (missing.hint) lines.push(`Postgres hint: ${missing.hint}`);
  lines.push('Never write a column from memory: correct the query from the real list, and do not guess a second name.');
  return lines.join(' ');
}

try {
  const raw = readFileSync(0, 'utf8');
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const hint = await buildHint(payload, process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());
  if (hint) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: { hookEventName: payload.hook_event_name || 'PostToolUse', additionalContext: hint },
      })}\n`,
    );
  }
} catch {
  process.exit(0); // fail open, always
}
