import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

/**
 * getSalesPlatformMetrics returns seven numbers but rebuilds the whole monthly sales dashboard to
 * get them — 3.1–3.7 s even with the achievement month cache warm, measured on production
 * 2026-09-21, and /admin asks for it three times per render. It is now cached across requests.
 *
 * The cache is only safe because of HOW it is keyed, so this pins all three halves:
 *  - the achievement cache stamp is in the key, so new actuals, targets or seat moves miss;
 *  - a null stamp builds live and never reads the cache (slow-but-correct, never stale);
 *  - the viewer's access context is in the key, so a scoped viewer never reads another's figures.
 */

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `expected to find ${signature}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `expected ${signature} to close`);
  return source.slice(start, end);
}

export function runSalesPlatformMetricsCacheTests() {
  const source = readFileSync("src/lib/sales/service.ts", "utf8");
  const body = functionBody(source, "export async function getSalesPlatformMetrics(");

  assert.ok(body.includes("await loadAchievementCacheStamp()"), "the cache must be keyed on the achievement stamp");
  assert.ok(
    body.includes("if (!stamp) return buildSalesPlatformMetrics(context);"),
    "a null stamp must build live, never from the cache",
  );
  assert.ok(body.includes("unstable_cache("), "the sales platform metrics must be cached across requests");
  assert.ok(
    body.includes(`["sales-platform-metrics", stamp, JSON.stringify(context)]`),
    "the key must carry both the stamp and the viewer's access context",
  );
  assert.ok(
    !body.includes("getSalesDashboard("),
    "the exported entry must not rebuild the dashboard itself — only the cached builder may",
  );
}
