import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// A PUBLISH OR AN UNPUBLISH REFRESHES EVERY CACHE THAT HOLDS THE CLOSING'S FIGURES
// (enterprise audit REC-030, F-SAL-009; 14 Nov 2026).
//
// `onClosingPublicationChanged` (src/lib/sales/closing-publication-refresh.ts) is the one refresh both
// writers of `monthly_closing_publications` call. This file pins:
//   1. both writers call it, and no other file writes the table;
//   2. it expires every tag it lists, and the Customer 360 cache;
//   3. every cached read in the app that reads the publication either wears one of those tags, or reads
//      the publication on every request, outside its cache (so a stale cache cannot show a withdrawn
//      month). A new cache that does neither fails here;
//   4. the two caches the audit named (Weekly Stock, Source of Sales dashboard) were checked: Weekly
//      Stock reads no closing at all, and the dashboard reads the publication outside its cache.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const HELPER = "src/lib/sales/closing-publication-refresh.ts";
const WRITER = "src/lib/sales/monthly-closing-publication.ts";
const READS_PUBLICATION = /loadPublishedPeriodKeys|loadSalesReleaseKeys|monthly_closing_publications/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}
const ALL_FILES = [...sourceFiles("src"), ...sourceFiles("app")].sort();

/** The helper's own tag list, read from its source. */
function helperTags(): string[] {
  const block = read(HELPER).match(/CLOSING_PUBLICATION_CACHE_TAGS = \[([\s\S]*?)\] as const/);
  assert.ok(block, "the helper exports its tag list");
  return [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

/** Tag constant name → value, from the invalidation module. */
function tagConstants(): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of read("src/lib/dashboard/invalidation.ts").matchAll(/export const ([A-Z0-9_]+_TAG) = "([a-z0-9-]+)";/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

/** Every tag a file's `tags: [...]` arrays name, resolved to its string. */
function tagsIn(text: string, constants: Map<string, string>): string[] {
  const tags: string[] = [];
  for (const block of text.matchAll(/tags: \[([^\]]*)\]/g)) {
    for (const token of block[1].split(",").map((t) => t.trim()).filter(Boolean)) {
      const literal = token.match(/^"([a-z0-9-]+)"$/);
      tags.push(literal ? literal[1] : (constants.get(token) ?? token));
    }
  }
  return tags;
}

/**
 * Cached reads whose publication read runs on every request, OUTSIDE the cache. Each names the line
 * that reads it and the line that closes its cache, and the read must come after the cache is defined.
 */
const READ_OUTSIDE_THE_CACHE: Readonly<Record<string, { cacheEnd: string; publicationRead: string; why: string }>> = {
  "src/lib/sales/sos-dashboard.ts": {
    cacheEnd: '{ revalidate: 300, tags: ["sos-dashboard"] }',
    publicationRead: "readsUnpublishedSalesTools(accessContext) ? null : loadSalesReleaseKeys()",
    why: "the dashboard caches imported rows only; which months a viewer may see is gated per request",
  },
  "src/lib/crm/brick-coverage.ts": {
    cacheEnd: '{ revalidate: 300, tags: ["sos-reference"] }',
    publicationRead: "const publishedKeys = includeUnpublishedSales ? null : await loadPublishedPeriodKeys(month, month);",
    why: "the cache holds rep territories; the published month is read per request",
  },
};

function testBothWritersCallTheOneRefresh() {
  // HEADLINE: publish and unpublish each call the helper once, and nothing else writes the table.
  const writer = read(WRITER);
  assert.equal(writer.split("onClosingPublicationChanged(").length - 1, 2, "publish and unpublish both call the one refresh");
  assert.match(writer, /onClosingPublicationChanged\(`closing published — /, "a publish refreshes");
  assert.match(writer, /onClosingPublicationChanged\(`closing unpublished — /, "an unpublish refreshes");
  for (const fn of ["invalidateClosingStoreSplitCache(", "invalidateCrmDailyForecastCache(", "invalidateAchievementStampedCaches(", "bumpCustomer360Cache("]) {
    assert.equal(writer.includes(fn), false, `the writer keeps no copy of the list (${fn} is the helper's)`);
  }
  const writers = ALL_FILES.filter((file) =>
    /from\("monthly_closing_publications"\)\s*\.(upsert|insert|update|delete)\(/.test(read(file)),
  );
  assert.deepEqual(writers, [WRITER], "only publish and unpublish write monthly_closing_publications");
}

function testTheHelperExpiresEveryListedCache() {
  const helper = read(HELPER);
  const invalidation = read("src/lib/dashboard/invalidation.ts");
  const constants = tagConstants();
  const fired = new Map<string, string>([
    ["invalidateClosingStoreSplitCache", "CLOSING_STORE_SPLIT_CACHE_TAG"],
    ["invalidateCrmDailyForecastCache", "CRM_DAILY_FORECAST_CACHE_TAG"],
    ["invalidateAchievementStampedCaches", "SALES_ACHIEVEMENT_STAMPED_CACHE_TAG"],
  ]);
  const expired: string[] = [];
  for (const [fn, constant] of fired) {
    assert.match(helper, new RegExp(`${fn}\\(reason\\);`), `the helper calls ${fn}`);
    assert.match(invalidation, new RegExp(`export function ${fn}\\([\\s\\S]{0,200}?revalidateTag\\(${constant},`), `${fn} expires ${constant}`);
    expired.push(constants.get(constant) ?? constant);
  }
  assert.deepEqual(helperTags().sort(), expired.sort(), "the helper's tag list is exactly what it expires");
  assert.match(helper, /bumpCustomer360Cache\(reason\);/, "and it refreshes Customer 360");
}

function testEveryCacheThatReadsThePublicationIsCovered() {
  // HEADLINE: a cached read of the publication wears a refreshed tag or reads it outside the cache.
  const covered = new Set(helperTags());
  const constants = tagConstants();
  const unsorted: string[] = [];
  const seen = new Set<string>();
  for (const file of ALL_FILES) {
    const text = read(file);
    if (!/unstable_cache\(/.test(text) || !READS_PUBLICATION.test(text)) continue;
    seen.add(file);
    const tags = tagsIn(text, constants);
    if (tags.some((tag) => covered.has(tag))) continue;
    const outside = READ_OUTSIDE_THE_CACHE[file];
    if (outside) {
      const end = text.indexOf(outside.cacheEnd);
      const readAt = text.indexOf(outside.publicationRead);
      assert.ok(end >= 0, `${file}: its cache still closes with ${outside.cacheEnd}`);
      assert.ok(readAt > end, `${file}: the publication is read after the cache, per request (${outside.why})`);
      continue;
    }
    unsorted.push(`${file} (tags: ${tags.join(", ") || "none"})`);
  }
  assert.deepEqual(
    unsorted,
    [],
    "a cache that reads the closing publication: tag it with one of CLOSING_PUBLICATION_CACHE_TAGS, or read the publication outside the cache and list it in READ_OUTSIDE_THE_CACHE",
  );
  for (const file of Object.keys(READ_OUTSIDE_THE_CACHE)) assert.ok(seen.has(file), `${file} still caches and reads the publication`);
}

function testTheAuditsTwoCachesWereChecked() {
  // Weekly Stock reads weekly distributor stock, never the closing, so a publish cannot stale it.
  const stock = read("src/lib/sales/weekly/stock-dashboard-service.ts");
  assert.match(stock, /weekly-stock-payload/, "Weekly Stock is the weekly-stock-payload cache");
  assert.equal(READS_PUBLICATION.test(stock), false, "Weekly Stock reads no closing publication");
  assert.equal(/monthly-closing|vs-target|unpublished-sales-access/.test(stock), false, "nor any closing module");
  // The Source of Sales dashboard is listed above: its cache holds rows, the gate runs per request.
  assert.ok(READ_OUTSIDE_THE_CACHE["src/lib/sales/sos-dashboard.ts"], "the Source of Sales dashboard is checked");
  assert.match(read("docs/source-of-sales-decisions.md"), /onClosingPublicationChanged/, "the decision is written down");
}

export function runClosingPublicationRefreshTests() {
  testBothWritersCallTheOneRefresh();
  testTheHelperExpiresEveryListedCache();
  testEveryCacheThatReadsThePublicationIsCovered();
  testTheAuditsTwoCachesWereChecked();
}
