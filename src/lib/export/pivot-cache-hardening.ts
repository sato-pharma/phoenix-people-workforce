import JSZip from "jszip";

// ──────────────────────────────────────────────────────────────────────────────
// ExcelForge pivot caches — refresh on load, and read the table rather than a range.
//
// ExcelForge writes a pivot cache that is correct but inert. Its `PivotTable` input
// (`node_modules/@node-projects/excelforge/dist/core/types.d.ts`) offers only
// `sourceSheet` + `sourceRef` and no refresh setting at all, so neither defect can be
// expressed through the API — the emitted package is the only place to fix them:
//
//   <pivotCacheDefinition ... recordCount="7" saveData="1">      <- no refreshOnLoad
//     <cacheSource type="worksheet"><worksheetSource ref="A1:O8" sheet="Data"/></cacheSource>
//
//  1. NO `refreshOnLoad`, so the pivot opens showing whatever was cached at BUILD time
//     rather than the workbook's own data — with nothing on screen saying so. That is the
//     one a reader is hurt by: a stale cross-tab looks exactly like a live one.
//  2. A RAW RANGE source, pinned to the row count the file was built with. Append rows to
//     the `Data` table and the pivot keeps reading `A1:O8`, so the new rows are invisible
//     to it even after a manual refresh.
//
// Excel's own form — read out of the owner's `assets/closing-engine/template.xlsm`, which
// he built by hand in Excel — is the target this produces:
//
//   <pivotCacheDefinition refreshOnLoad="1" ...>
//     <cacheSource type="worksheet"><worksheetSource name="SalesData"/></cacheSource>
//
// A table-named source carries neither `sheet` nor `ref`: the table IS the extent, which is
// what makes it grow. Paired with `refreshOnLoad="1"`, opening the workbook rebuilds the
// cache from the table's current rows.
//
// 🔴 WHAT THIS MUST NOT DO — the trap next door. `refreshOnLoad="1"` does NOT license
// emptying the cache: **Excel validates the pivots against the cache BEFORE it honours the
// refresh**, so a cleared record set or a stripped `<sharedItems>` pool leaves every
// `<item x="n"/>` in `xl/pivotTables/*.xml` pointing into nothing, and Excel removes the
// views and declares the workbook damaged. That is the bug that prompted "We found a
// problem with some content" on every premium closing export until 2026-09-02 — see the
// long note on `restorePivotCacheSharedItems` in `src/lib/sales/closing-engine-fill.ts`.
// So this rewrites the source POINTER and the refresh flag, and touches neither
// `<cacheFields>`, `<sharedItems>`, `recordCount` nor `pivotCacheRecords1.xml`.
// ──────────────────────────────────────────────────────────────────────────────

const CACHE_DEFINITION = /^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/;
const TABLE_PART = /^xl\/tables\/table\d+\.xml$/;

/** Sheet names reach these parts XML-escaped; the values they are compared against do not. */
const decodeEntities = (text: string): string =>
  text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * Every attribute on a tag, keyed by name.
 *
 * A TOKENIZER, not a per-name regex, for two reasons. `name` is a SUFFIX of `displayName`, which a
 * loose pattern happily returns instead — an Excel Table carries both, spelled identically, so the
 * wrong one reads as correct. And attribute ORDER is not fixed in OOXML: ExcelForge writes the
 * table's `xmlns` first and puts `name` on the second line of a tag that spans three, so nothing
 * here may assume a position.
 */
function attrsOf(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const pair of tag.matchAll(/([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"/g)) {
    if (!found.has(pair[1])) found.set(pair[1], pair[2]);
  }
  return found;
}

const attr = (tag: string, name: string): string | null => attrsOf(tag).get(name) ?? null;

type SourceTable = { name: string; sheet: string; ref: string };

/**
 * Every Excel Table in the package, with the sheet it sits on.
 *
 * ATTRIBUTE ORDER IS NOT FIXED IN OOXML and ExcelForge does not write `name` first, so every
 * read here is by attribute rather than by position — the mistake that once made
 * `scripts/check-workbook-integrity.mjs` match an empty sheet list and report seven false
 * alarms on a correct file.
 */
async function readSourceTables(zip: JSZip): Promise<SourceTable[]> {
  const read = async (path: string): Promise<string> => (await zip.file(path)?.async("string")) ?? "";

  const workbook = await read("xl/workbook.xml");
  const wbRels = await read("xl/_rels/workbook.xml.rels");
  const relTarget = new Map(
    [...wbRels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id") ?? "", attr(m[0], "Target") ?? ""]),
  );

  const tables: SourceTable[] = [];
  for (const tag of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const sheetName = decodeEntities(attr(tag[0], "name") ?? "");
    const target = relTarget.get(attr(tag[0], "r:id") ?? "");
    if (!sheetName || !target) continue;
    // `worksheets/sheet1.xml` -> `xl/worksheets/_rels/sheet1.xml.rels`
    const sheetPath = `xl/${target}`;
    const relsPath = sheetPath.replace(/([^/]+)$/, "_rels/$1.rels");
    for (const rel of (await read(relsPath)).matchAll(/<Relationship\b[^>]*>/g)) {
      const tablePath = `xl/${(attr(rel[0], "Target") ?? "").replace(/^\.\.\//, "")}`;
      if (!TABLE_PART.test(tablePath)) continue;
      const root = ((await read(tablePath)).match(/<table\b[^>]*>/) ?? [""])[0];
      const name = attr(root, "name");
      const ref = attr(root, "ref");
      if (name && ref) tables.push({ name, sheet: sheetName, ref });
    }
  }
  return tables;
}

/** `refreshOnLoad="1"` on the root tag. Idempotent: any existing value is replaced, never doubled. */
function setRefreshOnLoad(cacheDef: string): string {
  return cacheDef.replace(
    /<pivotCacheDefinition\b([^>]*)>/,
    (_match, attrs: string) => `<pivotCacheDefinition refreshOnLoad="1"${attrs.replace(/\s+refreshOnLoad="[^"]*"/g, "")}>`,
  );
}

/**
 * Repoint a `sheet`+`ref` cache source at the Table that occupies exactly that range.
 *
 * ONLY on an exact match. A cache whose range merely OVERLAPS a table is a different query,
 * and silently widening it to the table's extent would change the numbers the pivot reports —
 * the plausible-and-wrong shape that is worse than the stale cache this file exists to fix.
 * No match leaves the source alone, and `scripts/check-workbook-integrity.mjs` goes on saying so.
 */
function pointCacheAtTable(cacheDef: string, tables: SourceTable[]): string {
  return cacheDef.replace(/<worksheetSource\b[^>]*\/>/, (tag) => {
    if (attr(tag, "name")) return tag; // already a named source
    const sheet = decodeEntities(attr(tag, "sheet") ?? "");
    const ref = attr(tag, "ref");
    if (!sheet || !ref) return tag;
    const table = tables.find((t) => t.sheet === sheet && t.ref === ref);
    return table ? `<worksheetSource name="${table.name}"/>` : tag;
  });
}

/**
 * Harden every pivot cache in an emitted ExcelForge workbook.
 *
 * A workbook with no pivot cache — the weekly BI export's `interactive: false` build — is
 * returned as the very bytes that came in, never re-zipped, so the non-interactive path
 * cannot be affected by this at all.
 */
export async function hardenPivotCaches(workbook: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(workbook);
  const caches = zip.file(CACHE_DEFINITION);
  if (caches.length === 0) return workbook;

  const tables = await readSourceTables(zip);
  let rewritten = false;
  for (const cache of caches) {
    const before = await cache.async("string");
    const after = pointCacheAtTable(setRefreshOnLoad(before), tables);
    if (after !== before) {
      zip.file(cache.name, after);
      rewritten = true;
    }
  }
  if (!rewritten) return workbook;

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
