#!/usr/bin/env node
// SELECT CENSUS — every place the code reads or writes one table through PostgREST, with the columns
// each call names, resolved to plain names. The deterministic half of the select-auditor subagent
// (.claude/agents/select-auditor.md), which probes these names against the live database.
//
//   node scripts/select-census.mjs employees                  # every .from("employees") site
//   node scripts/select-census.mjs employees --column team_name
//   node scripts/select-census.mjs line_area_map --schema au --json
//   node scripts/select-census.mjs employees --include-scripts --root <repo>
//
// WHY IT EXISTS (2026-09-29, docs/agents-session-traps.md "A GREP IS NOT A CENSUS OF THE READS").
// A select is a STRING: the compiler cannot see into it, and PostgREST answers a missing column with
// an ERROR for the whole read, not a null for that one field. employees.department_name was dropped
// on the strength of a grep, and reports/organogram-au-source.ts — which named it in a 16-column
// select and discarded the error — took every occupant off the seat chart. A later probe of all 99
// employees selects found a second, unrelated live 42703 (`position_title`, never a column).
//
// This generalises the one-table scanner in tests/employee-line-is-read-from-the-link.test.ts, and
// fixes the two things a grep gets wrong there:
//   - A SELECT PASSED AS A CONSTANT (`.select(EMPLOYEE_COLUMNS)`) is resolved — in the same file, or
//     one import away — instead of reading as an identifier with no columns in it.
//   - AN EMBEDDED RELATION (`teams(name)`) is read with balanced parentheses; a `[^)]*` match stops
//     at its first `)` and silently drops every column after it.
// Anything it cannot resolve is reported as UNRESOLVED, never as clean. It never touches a database.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ arguments */

function parseArgs(argv) {
  const args = { table: null, schema: 'public', column: null, json: false, root: process.cwd(), scripts: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--schema') args.schema = argv[++i];
    else if (a === '--column') args.column = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--root') args.root = resolve(argv[++i]);
    else if (a === '--include-scripts') args.scripts = true;
    else if (!a.startsWith('--') && !args.table) args.table = a;
  }
  return args;
}

/* ------------------------------------------------------------- source walking */

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'mobile']);

export function sourceFiles(root, includeScripts = false) {
  const dirs = ['src', 'app', ...(includeScripts ? ['scripts'] : [])].map((d) => join(root, d)).filter(existsSync);
  const out = [];
  const stack = [...dirs];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (/\.(?:tsx?|mjs|js)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  }
  return out;
}

/* ------------------------------------------------------ balanced text helpers */

/** From `open` (index of a `(`), the text inside the matching `)`, honouring quotes. */
export function balancedArgument(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** Split on top-level commas (outside parentheses and quotes). */
function splitTopLevel(text, sep = ',') {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/* --------------------------------------------------- resolving a JS expression */

const IDENT = /^[A-Za-z_$][\w$]*$/;

function importedFrom(source, name, file, root) {
  const re = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*["']([^"']+)["']`, 'g');
  for (const m of source.matchAll(re)) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/));
    const hit = names.find((pair) => (pair[1] ?? pair[0]).trim() === name);
    if (!hit) continue;
    const spec = m[2];
    const base = spec.startsWith('@/')
      ? join(root, 'src', spec.slice(2))
      : spec.startsWith('.')
        ? resolve(dirname(file), spec)
        : null;
    if (!base) return null;
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts')]) {
      if (existsSync(cand) && statSync(cand).isFile()) return { file: cand, name: hit[0].trim() };
    }
    return null;
  }
  return null;
}

function constInitializer(source, name) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*`);
  const m = re.exec(source);
  if (!m) return null;
  // Read to the end of the statement: a `;` or a blank line at depth 0.
  let depth = 0;
  let quote = null;
  const from = m.index + m[0].length;
  for (let i = from; i < source.length && i < from + 4000; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(from, i).trim();
    else if (ch === '\n' && depth === 0 && source[i + 1] === '\n') return source.slice(from, i).trim();
  }
  return source.slice(from, from + 4000).trim();
}

/**
 * Evaluate a select argument to a plain string. Handles string, template (with ${CONST}), `+`
 * concatenation, an array `.join(",")`, `as const`, and identifiers resolved in the same file or
 * one import away. Returns { value, resolved, note }.
 */
export function evaluateExpression(expr, source, file, root, depth = 0) {
  let e = expr.trim().replace(/\s+as\s+const\s*$/, '').trim();
  if (depth > 3) return { value: '', resolved: false, note: `too deep: ${e.slice(0, 60)}` };

  if (IDENT.test(e)) {
    const local = constInitializer(source, e);
    if (local !== null) return evaluateExpression(local, source, file, root, depth + 1);
    const imp = importedFrom(source, e, file, root);
    if (imp) {
      const other = readFileSync(imp.file, 'utf8');
      const init = constInitializer(other, imp.name);
      if (init !== null) return evaluateExpression(init, other, imp.file, root, depth + 1);
    }
    return { value: '', resolved: false, note: `could not resolve identifier ${e}` };
  }

  const joinMatch = /^\[([\s\S]*)\]\s*\.join\(\s*(["'`])([\s\S]*?)\2\s*\)$/.exec(e);
  if (joinMatch || e.startsWith('[')) {
    const inner = joinMatch ? joinMatch[1] : e.replace(/^\[|\]$/g, '');
    const sep = joinMatch ? joinMatch[3] : ',';
    const items = splitTopLevel(inner).map((it) => evaluateExpression(it, source, file, root, depth + 1));
    return {
      value: items.map((i) => i.value).join(sep),
      resolved: items.every((i) => i.resolved),
      note: items.map((i) => i.note).filter(Boolean).join('; '),
    };
  }

  const pieces = splitTopLevel(e, '+');
  if (pieces.length > 1) {
    const parts = pieces.map((p) => evaluateExpression(p, source, file, root, depth + 1));
    return { value: parts.map((p) => p.value).join(''), resolved: parts.every((p) => p.resolved), note: parts.map((p) => p.note).filter(Boolean).join('; ') };
  }

  const str = /^(["'])([\s\S]*)\1$/.exec(e);
  if (str) return { value: str[2], resolved: true, note: '' };

  const tpl = /^`([\s\S]*)`$/.exec(e);
  if (tpl) {
    let resolved = true;
    const notes = [];
    const value = tpl[1].replace(/\$\{([^}]+)\}/g, (_, inner) => {
      const r = evaluateExpression(inner, source, file, root, depth + 1);
      if (!r.resolved) {
        resolved = false;
        if (r.note) notes.push(r.note);
      }
      return r.value;
    });
    return { value, resolved, note: notes.join('; ') };
  }

  return { value: '', resolved: false, note: `not a literal: ${e.slice(0, 80)}` };
}

/* ------------------------------------------------ parsing a PostgREST select */

/**
 * Parse a PostgREST select string into the columns it names on the table itself and the embedded
 * relations (each with its own columns). `alias:col`, `col::type`, `col->>key`, `...rel(...)`,
 * `rel!hint(...)` and aggregates are all reduced to the real name.
 */
export function parseSelect(select) {
  const columns = [];
  const embeds = [];
  let star = false;
  for (const raw of splitTopLevel(String(select).replace(/\s+/g, ' '))) {
    let item = raw.replace(/^\.\.\./, '').trim();
    const paren = item.indexOf('(');
    if (paren > 0 && item.endsWith(')') && !/^\w+\.\w+\(\)$/.test(item) && !/^count\(\)$/.test(item)) {
      let head = item.slice(0, paren).trim();
      if (head.includes(':')) head = head.split(':').pop().trim();
      const [relation, hint] = head.split('!');
      const inner = item.slice(paren + 1, -1);
      embeds.push({ relation: relation.trim(), hint: hint ?? null, ...parseSelect(inner) });
      continue;
    }
    if (item.includes(':') && !item.includes('::')) item = item.split(':').pop();
    else if (/^[^:]+:[^:]/.test(item)) item = item.slice(item.indexOf(':') + 1);
    item = item.split('::')[0].split('->')[0].trim();
    item = item.replace(/\.(?:sum|avg|min|max|count)\(\)$/, '');
    if (item === '*') star = true;
    else if (item === 'count()' || item === '') continue;
    else columns.push(item);
  }
  return { columns: [...new Set(columns)], embeds, star };
}

/* ------------------------------------------------------------ chain scanning */

const FILTER_METHODS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy', 'overlaps', 'order', 'not', 'filter', 'textSearch', 'rangeGt', 'rangeLt'];

/** The call chain that starts at `.from(...)`, up to the end of its statement. */
function chainAfter(source, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length && i < start + 6000; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth < 0) return source.slice(start, i);
    } else if (ch === ';' && depth === 0) return source.slice(start, i);
    else if (ch === '\n' && depth === 0) {
      const rest = source.slice(i + 1).trimStart();
      if (!rest.startsWith('.')) return source.slice(start, i);
    }
  }
  return source.slice(start, start + 6000);
}

export function censusOfFile(file, source, { table, schema = 'public', root }) {
  const sites = [];
  const fromRe = new RegExp(`\\.from\\(\\s*(["'\`])${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\s*\\)`, 'g');
  for (const m of source.matchAll(fromRe)) {
    // Schema: a `.schema("x")` immediately before `.from(` on the same chain.
    const before = source.slice(Math.max(0, m.index - 120), m.index);
    const schemaHit = /\.schema\(\s*["'`](\w+)["'`]\s*\)\s*$/.exec(before);
    const siteSchema = schemaHit ? schemaHit[1] : 'public';
    if (siteSchema !== schema) continue;

    const chain = chainAfter(source, m.index + m[0].length);
    const line = source.slice(0, m.index).split('\n').length;
    const site = { file: relative(root, file).replace(/\\/g, '/'), line, kind: 'read', select: null, resolved: true, note: '', columns: [], embeds: [], star: false, filters: [], writeKeys: [] };

    const selectAt = chain.search(/\.select\(/);
    const writeAt = chain.search(/\.(insert|update|upsert|delete)\(/);
    if (writeAt >= 0 && (selectAt < 0 || writeAt < selectAt)) {
      site.kind = /\.delete\(/.test(chain.slice(writeAt, writeAt + 9)) ? 'delete' : 'write';
      const open = chain.indexOf('(', writeAt);
      const payload = balancedArgument(chain, open) ?? '';
      const obj = /^\s*\{([\s\S]*)\}\s*$/.exec(payload);
      if (obj) {
        site.writeKeys = splitTopLevel(obj[1])
          .map((kv) => /^\s*["']?([A-Za-z_]\w*)["']?\s*:/.exec(kv)?.[1] ?? (IDENT.test(kv.trim()) ? kv.trim() : null))
          .filter(Boolean);
      } else if (payload.trim() && site.kind === 'write') {
        site.note = 'write payload is not an object literal — its columns are not checked';
      }
    }

    if (selectAt >= 0) {
      const open = chain.indexOf('(', selectAt);
      const arg = balancedArgument(chain, open);
      const firstArg = arg === null ? '' : splitTopLevel(arg)[0] ?? '';
      if (!firstArg.trim()) {
        site.select = '*';
        site.star = true;
      } else {
        const ev = evaluateExpression(firstArg, source, file, root);
        site.select = ev.value || firstArg.trim();
        site.resolved = ev.resolved;
        if (ev.note) site.note = ev.note;
        if (ev.resolved) Object.assign(site, parseSelect(ev.value));
      }
    } else if (site.kind === 'read') {
      site.kind = 'other';
    }

    for (const fm of chain.matchAll(new RegExp(`\\.(${FILTER_METHODS.join('|')})\\(\\s*(["'\`])(\\w+)\\2`, 'g'))) {
      site.filters.push(fm[3]);
    }
    for (const om of chain.matchAll(/\.or\(\s*(["'`])([^"'`]*)\1/g)) {
      for (const clause of om[2].split(',')) {
        const col = /^\s*(\w+)\./.exec(clause)?.[1];
        if (col && !['and', 'or', 'not'].includes(col)) site.filters.push(col);
      }
    }
    for (const mm of chain.matchAll(/\.match\(\s*\{([^}]*)\}/g)) {
      for (const kv of splitTopLevel(mm[1])) {
        const k = /^\s*["']?(\w+)["']?\s*:/.exec(kv)?.[1];
        if (k) site.filters.push(k);
      }
    }
    site.filters = [...new Set(site.filters)];
    sites.push(site);
  }
  return sites;
}

export function runCensus({ table, schema = 'public', root = process.cwd(), includeScripts = false }) {
  const files = sourceFiles(root, includeScripts);
  const sites = [];
  const needle = `from(`;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes(needle) || !source.includes(table)) continue;
    sites.push(...censusOfFile(file, source, { table, schema, root }));
  }
  return { table, schema, filesScanned: files.length, sites };
}

/** Every site that names `column` — in its select, a filter, or a write. */
export function sitesNaming(census, column) {
  return census.sites.filter(
    (s) => s.columns.includes(column) || s.filters.includes(column) || s.writeKeys.includes(column) || (!s.resolved && String(s.select).includes(column)),
  );
}

/* ----------------------------------------------------------------------- CLI */

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.table) {
    console.error('usage: node scripts/select-census.mjs <table> [--schema au] [--column name] [--json] [--include-scripts] [--root dir]');
    process.exit(2);
  }
  const census = runCensus({ table: args.table, schema: args.schema, root: args.root, includeScripts: args.scripts });
  const shown = args.column ? sitesNaming(census, args.column) : census.sites;
  const unresolved = census.sites.filter((s) => !s.resolved);
  const distinctColumns = [...new Set(census.sites.flatMap((s) => [...s.columns, ...s.filters, ...s.writeKeys]))].sort();

  if (args.json) {
    console.log(JSON.stringify({ ...census, distinctColumns, unresolvedCount: unresolved.length, shown: args.column ? shown : undefined }, null, 2));
  } else {
    console.log(`${args.schema}.${args.table}: ${census.sites.length} call sites in ${census.filesScanned} files scanned`);
    console.log(`  reads ${census.sites.filter((s) => s.kind === 'read').length} · writes ${census.sites.filter((s) => s.kind === 'write').length} · deletes ${census.sites.filter((s) => s.kind === 'delete').length} · other ${census.sites.filter((s) => s.kind === 'other').length}`);
    console.log(`  UNRESOLVED selects ${unresolved.length}${unresolved.length ? ' — these are NOT checked, never clean:' : ''}`);
    for (const s of unresolved) console.log(`    ${s.file}:${s.line}  ${s.note}`);
    console.log(`  distinct column names named: ${distinctColumns.length}`);
    console.log(`    ${distinctColumns.join(', ')}`);
    if (args.column) {
      console.log(`\n  sites naming "${args.column}": ${shown.length}`);
      for (const s of shown) console.log(`    ${s.file}:${s.line}  [${s.kind}]  ${String(s.select ?? '').slice(0, 140)}`);
    }
  }
  if (census.filesScanned < 200) {
    console.error(`WARNING: only ${census.filesScanned} files scanned — run from the repo root (or pass --root); an empty result proves nothing.`);
    process.exitCode = 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
