import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./system-audit-routes-access.test.ts";

// The System Error & Data Integrity Audit wears the owner's locked look:
//   · FITS THE SCREEN — never a horizontal scroll: every table is `w-full table-fixed` with a
//     `<colgroup>` whose widths add to 100%, columns are MERGED to fit (never shrunk type), and a
//     table switches on its OWN width (`@container` + `@min-[Npx]:`), never a viewport breakpoint;
//   · SQUARE EDGES — no `rounded` anywhere;
//   · NOTHING CUT — no `truncate`, `line-clamp`, `text-ellipsis`; no `overflow-x-auto` or `min-w-[`
//     (a min-width with a sideways scroll IS the bug);
//   · the Incidents table shows the owner's 11 columns in order from 1,120px, 7 merged columns
//     from 760px and cards below that;
//   · a client component never imports a server-only module (the ledger, the service-role client).

const ROOT = process.cwd();
const DIR = "src/components/admin/system-audit";

/** The files this build owns. The sibling sections are held to the same look by their own tests. */
const FILES = [
  `${DIR}/system-audit-page.tsx`,
  `${DIR}/incidents-workspace.tsx`,
  `${DIR}/incidents-filters.tsx`,
  `${DIR}/incidents-table.tsx`,
  `${DIR}/incident-drawer.tsx`,
  `${DIR}/integrity-checks.tsx`,
  "app/(admin)/admin/system-audit/page.tsx",
] as const;

const BANNED: Array<[RegExp, string]> = [
  [/(?<![\w-])rounded(?!-none(?![\w-]))(?:-[\w[\].%/]+)?(?![\w-])/, "a rounded corner (the square-edge golden rule)"],
  [/(?<![\w-])truncate(?![\w-])/, "truncate (text is never cut)"],
  [/(?<![\w-])line-clamp-[\w[\]]+/, "line-clamp (text is never cut)"],
  [/(?<![\w-])text-ellipsis(?![\w-])/, "text-ellipsis (text is never cut)"],
  [/(?<![\w-])overflow-x-(?:auto|scroll)(?![\w-])/, "a horizontal scroll"],
  [/(?<![\w-])min-w-\[/, "a fixed min-width (it forces a sideways scroll)"],
  [/(?<![\w-])(?:sm|md|lg|xl|2xl):(?:table|hidden)(?![\w-])/, "a viewport breakpoint on a table (a table switches on its container's width)"],
];

/** Server-only modules a "use client" file may import only as `import type`. */
const SERVER_ONLY = [
  "@/lib/supabase/server",
  "@/lib/auth/server",
  "@/lib/system-audit/repository",
  "@/lib/system-audit/occurrence-detail",
  "@/lib/system-audit/integrity-runs",
  "@/lib/system-audit/incidents-lookup",
  "@/lib/system-audit/export",
  "exceljs",
];

function read(relative: string): string {
  return stripComments(readFileSync(path.join(ROOT, relative), "utf8"));
}

type Table = { className: string; widths: number[]; file: string };

function tables(file: string, code: string): Table[] {
  const found: Table[] = [];
  const pattern = /<table\s+className="([^"]*)"[^>]*>\s*<colgroup>([\s\S]*?)<\/colgroup>/g;
  for (const match of code.matchAll(pattern)) {
    const widths = [...match[2].matchAll(/<col\s+className="w-\[(\d+(?:\.\d+)?)%\]"\s*\/>/g)].map((col) => Number(col[1]));
    found.push({ className: match[1], widths, file });
  }
  return found;
}

function lookTests() {
  for (const file of FILES) {
    const code = read(file);
    for (const [pattern, what] of BANNED) {
      const hit = pattern.exec(code);
      assert.equal(hit, null, `${file} uses ${what}: "${hit?.[0]}"`);
    }
  }
}

function tableTests() {
  let total = 0;
  for (const file of FILES) {
    const code = read(file);
    const tableCount = (code.match(/<table[\s>]/g) ?? []).length;
    const found = tables(file, code);
    assert.equal(found.length, tableCount, `${file}: every <table> opens with a <colgroup> (${found.length} of ${tableCount})`);
    if (tableCount > 0) assert.match(code, /@container/, `${file} measures its own width with @container`);
    for (const [index, table] of found.entries()) {
      const where = `${file} table ${index + 1}`;
      assert.match(table.className, /(?<![\w-])w-full(?![\w-])/, `${where} is w-full`);
      assert.match(table.className, /(?<![\w-])table-fixed(?![\w-])/, `${where} is table-fixed`);
      assert.match(table.className, /@min-\[\d+px\]:table/, `${where} switches on its container's width`);
      assert.ok(table.widths.length > 0, `${where} sets every column's width in its colgroup`);
      const sum = table.widths.reduce((acc, width) => acc + width, 0);
      assert.ok(Math.abs(sum - 100) < 0.01, `${where}'s column widths add to ${sum}%, not 100%`);
    }
    total += found.length;
  }
  assert.ok(total >= 4, "the incidents and integrity tables were all found");

  const incidents = tables("incidents-table", read(`${DIR}/incidents-table.tsx`));
  const wide = incidents.find((table) => table.className.includes("@min-[1120px]:table"));
  const merged = incidents.find((table) => table.className.includes("@min-[760px]:table"));
  assert.equal(wide?.widths.length, 11, "from 1,120px the Incidents table shows all 11 columns");
  assert.equal(merged?.widths.length, 7, "from 760px the Incidents table merges into 7 columns");
  assert.match(merged?.className ?? "", /@min-\[1120px\]:hidden/, "the merged table steps aside once the wide one fits");

  const table = read(`${DIR}/incidents-table.tsx`);
  assert.match(table, /INCIDENT_COLUMN_HEADINGS\.map\(/, "the wide table's headings are the owner's 11, in order");
  assert.match(table, /@min-\[760px\]:hidden/, "below 760px the rows are cards");
}

function clientBoundaryTests() {
  for (const file of FILES) {
    const raw = readFileSync(path.join(ROOT, file), "utf8");
    if (!/^\s*["']use client["'];?/.test(raw)) continue;
    for (const match of raw.matchAll(/^import\s+(type\s+)?[\s\S]*?\s+from\s+"([^"]+)";?$/gm)) {
      if (match[1]) continue;
      assert.ok(!SERVER_ONLY.includes(match[2]), `${file} is a client component and imports the server-only ${match[2]}`);
    }
  }
}

function serverPageTests() {
  const page = read(`${DIR}/system-audit-page.tsx`);
  assert.doesNotMatch(page, /^\s*["']use client["']/, "the tab shell renders on the server");
  // The tabs are Links: a tab change is a navigation that re-runs the Super Admin guard.
  assert.match(page, /<Link\b/, "the tab bar is made of links");
  assert.match(page, /aria-current=\{/, "the active tab is announced");
  // Nothing refreshes on a timer.
  for (const file of FILES) {
    assert.doesNotMatch(read(file), /setInterval\(/, `${file} polls on a timer`);
  }
}

export function runSystemAuditPageDesignTests() {
  lookTests();
  tableTests();
  clientBoundaryTests();
  serverPageTests();
}
