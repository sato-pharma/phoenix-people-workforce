/**
 * Finds, from source, every address the visual explorer must never request because reading it acts:
 *
 *   - API routes whose GET writes (a database write, an audit row, a message) or serves a file of real
 *     data, or spends a paid quota (Maps Static);
 *   - pages whose SERVER RENDER writes (the browser fence never sees those: the write happens while the
 *     server answers the page's GET), so the only guard is never to open the page at all.
 *
 * Two sources, merged:
 *   1. a scan of `app/**` route and page files for write, file and quota signals; and
 *   2. `accessRegistry` (src/lib/security/access-registry.ts): every GET-capable API entry whose audit is
 *      REQUIRED and classed export, mutation or access-read writes an audit row when read.
 *
 * The scan is deliberately conservative: in a route file that also exports POST/PUT/PATCH/DELETE, only
 * those handlers' own bodies are set aside, and everything else (module-level helpers included) counts
 * toward GET. Over-fencing costs a blank pane in an inspection; under-fencing costs a real write.
 * What it cannot see: a write hidden inside a domain function the route or page calls. The registry
 * covers the audited ones; the rest is why the explorer runs on staging only.
 *
 * Output (scripts/phoenix-inspect/generated/side-effect-routes.json, written by
 * scripts/phoenix-inspect/side-effect-routes.ts and pinned current by
 * tests/phoenix-inspect-route-fence.test.ts) is read by lib/fence.mjs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { accessRegistry } from "../../../src/lib/security/access-registry.ts";

export type SideEffectReason = string;
export type SideEffectRoute = { pattern: string; file: string | null; reasons: SideEffectReason[] };
export type SideEffectList = {
  note: string;
  apiRoutes: SideEffectRoute[];
  renderWriterPages: SideEffectRoute[];
};

/** A database or message write. `.update(` alone would also match a crypto hash, so it is anchored to a query chain. */
export const WRITE_SIGNALS: ReadonlyArray<[string, RegExp]> = [
  ["db-insert", /\.insert\(/],
  ["db-upsert", /\.upsert\(/],
  ["db-update", /\.from\(\s*["'`][\w.]+["'`]\s*\)[\s\S]{0,80}?\.update\(/],
  ["db-delete", /\.from\(\s*["'`][\w.]+["'`]\s*\)[\s\S]{0,80}?\.delete\(/],
  ["write-rpc", /\.rpc\(\s*["'`]\w*(?:insert|upsert|update|delete|record|log|write|set_|apply|claim|mark|bump|touch|enqueue|consume)\w*["'`]/i],
  ["audit-write", /\b(?:writeAuditLog|recordAudit\w*|logAudit\w*|insertAudit\w*|recordAccessRead\w*|auditAccessRead\w*|writeAccessAudit\w*)\s*\(/],
  ["record-shown", /\brecordShown\w*\s*\(/],
  ["message-send", /\b(?:sendEmail|sendMail|enqueueEmail|queueEmail|sendTelegram\w*|sendWhatsApp\w*|sendPush\w*)\s*\(/],
];

/** A response that hands over a file. */
export const FILE_SIGNALS: ReadonlyArray<[string, RegExp]> = [
  ["content-disposition", /content-disposition/i],
  ["pdf", /application\/pdf|renderToBuffer|pdf-lib|puppeteer/],
  ["spreadsheet", /spreadsheetml|application\/vnd\.ms-excel|exceljs|ExcelJS|writeBuffer\(/],
  ["image", /["'`]image\/(?:png|jpe?g|webp|gif|svg\+xml)["'`]/],
  ["csv", /["'`]text\/csv/],
  ["archive", /application\/zip|application\/octet-stream/],
  ["signed-url", /createSignedUrl/],
];

/** A paid quota spent on the server while it answers a read. */
export const QUOTA_SIGNALS: ReadonlyArray<[string, RegExp]> = [["maps-static", /maps\.googleapis\.com|staticmap/i]];

const OTHER_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * The end index (exclusive) of the bracket group that opens at `start` ("{", "(" or "["), skipping
 * strings, template literals and comments. Returns -1 when it cannot be matched.
 */
export function matchBracket(source: string, start: number): number {
  const open = source[start];
  if (!"{([".includes(open)) return -1;
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") { i = source.indexOf("\n", i); if (i < 0) return -1; continue; }
    if (c === "/" && next === "*") { i = source.indexOf("*/", i + 2); if (i < 0) return -1; i += 1; continue; }
    if (c === '"' || c === "'") {
      for (i += 1; i < source.length && source[i] !== c; i += 1) if (source[i] === "\\") i += 1;
      continue;
    }
    if (c === "`") {
      for (i += 1; i < source.length && source[i] !== "`"; i += 1) {
        if (source[i] === "\\") i += 1;
        else if (source[i] === "$" && source[i + 1] === "{") {
          const end = matchBracket(source, i + 1);
          if (end < 0) return -1;
          i = end - 1;
        }
      }
      continue;
    }
    if ("{([".includes(c)) depth += 1;
    else if ("})]".includes(c)) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The source text of each exported handler for the named methods, as [start, end) ranges. */
export function handlerRanges(source: string, methods: readonly string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (methods.length === 0) return ranges; // an empty alternation would match EVERY exported function
  const names = methods.join("|");
  const declaration = new RegExp(`export\\s+(?:async\\s+)?function\\s+(?:${names})\\b`, "g");
  for (const match of source.matchAll(declaration)) {
    const params = source.indexOf("(", match.index);
    const paramsEnd = params < 0 ? -1 : matchBracket(source, params);
    const body = paramsEnd < 0 ? -1 : source.indexOf("{", paramsEnd);
    const end = body < 0 ? -1 : matchBracket(source, body);
    if (end > 0) ranges.push([match.index ?? 0, end]);
  }
  const constant = new RegExp(`export\\s+const\\s+(?:${names})\\b[^=]*=`, "g");
  for (const match of source.matchAll(constant)) {
    // The value runs to the first ";" outside brackets, or to the first line break outside brackets
    // once a bracket group has been read (a statement with no semicolon).
    let i = (match.index ?? 0) + match[0].length;
    let end = -1;
    let readGroup = false;
    while (i < source.length) {
      const c = source[i];
      if ("{([".includes(c)) {
        const close = matchBracket(source, i);
        if (close < 0) break;
        i = close;
        readGroup = true;
        continue;
      }
      if (c === ";" || (c === "\n" && readGroup)) {
        end = i;
        break;
      }
      i += 1;
    }
    if (end > 0) ranges.push([match.index ?? 0, end]);
  }
  return ranges;
}

/** Removes the given ranges from a source text. */
function without(source: string, ranges: Array<[number, number]>): string {
  let out = "";
  let at = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start < at) continue;
    out += source.slice(at, start);
    at = end;
  }
  return out + source.slice(at);
}

/** Server actions ("use server" bodies) run on a POST, which the browser fence stops; a page's render does not run them. */
export function withoutServerActions(source: string): string {
  const ranges: Array<[number, number]> = [];
  for (const match of source.matchAll(/["']use server["']/g)) {
    const at = match.index ?? 0;
    const before = source.slice(0, at);
    if (!/\S/.test(before.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""))) return ""; // a whole server-actions file
    const open = before.lastIndexOf("{");
    if (open < 0) continue;
    const end = matchBracket(source, open);
    if (end > at) ranges.push([open, end]);
  }
  return without(source, ranges);
}

export function exportedMethods(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g)) found.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(name)) found.add(name);
    }
  }
  return [...found].sort();
}

function signalsIn(text: string, table: ReadonlyArray<[string, RegExp]>): string[] {
  return table.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/** What reading this route file with GET would do, from its own source. Empty when nothing was found. */
export function classifyGetRoute(source: string): string[] {
  const methods = exportedMethods(source);
  if (!methods.includes("GET")) return [];
  const getText = without(source, handlerRanges(source, OTHER_METHODS.filter((m) => methods.includes(m))));
  return [
    ...signalsIn(getText, WRITE_SIGNALS).map((s) => `writes:${s}`),
    ...signalsIn(getText, FILE_SIGNALS).map((s) => `file:${s}`),
    ...signalsIn(getText, QUOTA_SIGNALS).map((s) => `quota:${s}`),
  ];
}

/** What rendering this page or layout would write, from its own source. */
export function classifyRenderWriter(source: string): string[] {
  return signalsIn(withoutServerActions(source), WRITE_SIGNALS).map((s) => `render-writes:${s}`);
}

/** `app/api/foo/[id]/route.ts` → `/api/foo/:id`; route groups and parallel slots drop out. */
export function appFileToPattern(relativeFile: string): string {
  const parts = relativeFile.replace(/\\/g, "/").split("/").slice(1, -1); // drop "app" and the file name
  const segments = parts
    .filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"))
    .map((segment) => {
      if (/^\[\[\.\.\..+\]\]$/.test(segment) || /^\[\.\.\..+\]$/.test(segment)) return "**";
      const dynamic = segment.match(/^\[(.+)\]$/);
      return dynamic ? `:${dynamic[1]}` : segment;
    });
  return `/${segments.join("/")}`.replace(/\/$/, "") || "/";
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith("_") || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function buildSideEffectList(repoRoot: string): SideEffectList {
  const appDir = path.join(repoRoot, "app");
  const files = walk(appDir, []).map((full) => path.relative(repoRoot, full).replace(/\\/g, "/")).sort();
  const api = new Map<string, SideEffectRoute>();
  const pages = new Map<string, SideEffectRoute>();
  const add = (map: Map<string, SideEffectRoute>, pattern: string, file: string | null, reasons: string[]) => {
    const held = map.get(pattern) ?? { pattern, file, reasons: [] };
    held.file ??= file;
    held.reasons = [...new Set([...held.reasons, ...reasons])].sort();
    map.set(pattern, held);
  };

  for (const file of files) {
    if (/^app\/api\/.*\/route\.(?:ts|tsx|js|mjs)$/.test(file)) {
      const reasons = classifyGetRoute(readFileSync(path.join(repoRoot, file), "utf8"));
      if (reasons.length > 0) add(api, appFileToPattern(file), file, reasons);
    } else if (/\/(?:page|layout)\.(?:tsx|ts|jsx|js)$/.test(file) && !file.startsWith("app/api/")) {
      const reasons = classifyRenderWriter(readFileSync(path.join(repoRoot, file), "utf8"));
      if (reasons.length > 0) add(pages, appFileToPattern(file), file, reasons);
    }
  }

  for (const entry of accessRegistry as readonly { surface: string; methods: readonly string[]; pattern: string; audit: { classification?: string; required: boolean } }[]) {
    if (entry.surface !== "api" || !entry.methods.includes("GET") || !entry.audit.required) continue;
    const kind = entry.audit.classification;
    if (kind === "export" || kind === "mutation" || kind === "access-read") add(api, entry.pattern, null, [`registry:${kind}`]);
  }

  const sorted = (map: Map<string, SideEffectRoute>) => [...map.values()].sort((a, b) => a.pattern.localeCompare(b.pattern));
  return {
    note: "Generated by scripts/phoenix-inspect/side-effect-routes.ts from app/** and src/lib/security/access-registry.ts. Do not edit by hand; tests/phoenix-inspect-route-fence.test.ts fails when it is stale.",
    apiRoutes: sorted(api),
    renderWriterPages: sorted(pages),
  };
}
