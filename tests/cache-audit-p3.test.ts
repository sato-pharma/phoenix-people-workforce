import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { isDegraded, markDegraded, servedWithoutCachingValue, serveWithoutCaching, unwrapServedWithoutCaching } from "../src/lib/cache/serve-uncached.ts";
import { DOWNLOAD_NO_STORE_HEADERS } from "../src/lib/http/download-headers.ts";
import { createSignedLinkMemo } from "../src/lib/phoenix-crm/server/signed-link-memo.ts";
import { PLAN_DRAFT_KEY_PREFIX, PLAN_DRAFT_MAX_AGE_DAYS, stalePlanDraftKeys } from "../src/lib/weekly-planning/plan-draft-retention.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE CACHE AUDIT'S P3 FIXES (2026-10-26). The audit is docs/production-audits/cache-audit-2026-10-26.md;
 * its P0 to P2 are pinned by tests/browser-storage-owner-scoped.test.ts and tests/cache-audit-fixes.test.ts.
 *
 * P3 is the long tail: a download with no cache header, a degraded answer kept for the cache's whole
 * life, a cached row written in place, a bust in the wrong function, a browser-storage call that throws.
 * The pure pieces are run; the wiring is read as comment-stripped source, inside the run function so a
 * break-test in one process sees the edit.
 */

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

function count(text: string, pattern: RegExp): number {
  return (text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? []).length;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const CONTENT_DISPOSITION_HEADER = /["'`]content-disposition["'`]\s*[:,]/i;
const WINDOW_LINES = 8;

/**
 * Every place that sets a Content-Disposition header, and whether a Cache-Control sits beside it — a
 * literal, the shared DOWNLOAD_NO_STORE_HEADERS, or a spread of a local object that holds one.
 */
export function downloadHeaderMissesInText(file: string, text: string): { setters: number; misses: string[] } {
  let setters = 0;
  const misses: string[] = [];
  if (!CONTENT_DISPOSITION_HEADER.test(text)) return { setters, misses };
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!CONTENT_DISPOSITION_HEADER.test(line)) return;
    setters += 1;
    const near = lines.slice(Math.max(0, index - WINDOW_LINES), index + WINDOW_LINES + 1).join("\n");
    if (/cache-control/i.test(near) || near.includes("DOWNLOAD_NO_STORE_HEADERS")) return;
    const spreadsCacheHeader = [...near.matchAll(/\.\.\.(\w+)/g)].some(([, name]) => {
      const declared = new RegExp(`(?:const|let)\\s+${name}\\b[^=]*=\\s*\\{([\\s\\S]{0,400}?)\\}`).exec(text);
      return Boolean(declared && /cache-control|DOWNLOAD_NO_STORE_HEADERS/i.test(declared[1]));
    });
    if (!spreadsCacheHeader) misses.push(`${file.replace(/\\/g, "/")}:${index + 1}`);
  });
  return { setters, misses };
}

function downloadHeaderMisses(files: readonly string[]): { setters: number; misses: string[] } {
  let setters = 0;
  const misses: string[] = [];
  for (const file of files) {
    const found = downloadHeaderMissesInText(file, source(file));
    setters += found.setters;
    misses.push(...found.misses);
  }
  return { setters, misses };
}

export async function runCacheAuditP3Tests() {
  // ── 1. Every generated download says "never keep me" ─────────────────────────────────────────────────
  {
    assert.deepEqual(DOWNLOAD_NO_STORE_HEADERS, { "Cache-Control": "private, no-store" });
    const { setters, misses } = downloadHeaderMisses([...walk("app"), ...walk("src/lib")]);
    // 155 setters in 139 files when this was written, 30 of them with no Cache-Control; a sweep that finds
    // far fewer has stopped matching, and would pass on nothing.
    assert.ok(setters >= 150, `the sweep found only ${setters} Content-Disposition setters — the pattern has rotted`);
    assert.deepEqual(
      misses,
      [],
      "HEADLINE: a route that sends a download (Content-Disposition) must send Cache-Control beside it — spread " +
        "DOWNLOAD_NO_STORE_HEADERS from src/lib/http/download-headers.ts. Without it the browser may keep a payroll " +
        "or deductions workbook and hand it to the next person on a shared machine",
    );
    // The sweep itself fails a bare setter, and passes one with the shared header, or a local that holds one, beside it.
    const bare = 'return new Response(body, {\n  headers: {\n    "Content-Disposition": `attachment; filename="x.xlsx"`,\n  },\n});';
    assert.deepEqual(downloadHeaderMissesInText("bare.ts", bare), { setters: 1, misses: ["bare.ts:3"] });
    const shared = bare.replace("headers: {", "headers: {\n    ...DOWNLOAD_NO_STORE_HEADERS,");
    assert.deepEqual(downloadHeaderMissesInText("shared.ts", shared).misses, []);
    const local = `const fileHeaders = { "Cache-Control": "private, no-store" };\n${bare.replace("headers: {", "headers: {\n    ...fileHeaders,")}`;
    assert.deepEqual(downloadHeaderMissesInText("local.ts", local).misses, []);
    const unrelated = `const fileHeaders = { "Content-Type": "text/csv" };\n${bare.replace("headers: {", "headers: {\n    ...fileHeaders,")}`;
    assert.deepEqual(downloadHeaderMissesInText("unrelated.ts", unrelated).misses, ["unrelated.ts:5"], "a spread of a local with no Cache-Control is still a miss");
  }

  // ── 2. Private media is never kept; the share card and brand files are kept on purpose ──────────────
  {
    for (const route of ["app/api/dispute-center/attachments/[id]/route.ts", "app/api/whatsapp-inbox/media/[messageId]/route.ts"]) {
      assert.match(source(route), /"Cache-Control": "private, no-store"/, `${route}: a private attachment is never kept`);
    }
    for (const route of ["app/share/card/[token]/route.ts", "app/share/card/[token]/image/route.ts"]) {
      const text = source(route);
      assert.match(text, /"Cache-Control": "public, max-age=3600"/, `${route}: the share card is kept an hour`);
      assert.equal(/s-maxage/.test(text), false, `${route}: no shared-cache directive, since no CDN sits in front`);
    }
    assert.match(
      source("next.config.ts"),
      /source: "\/brand\/:path\*", headers: \[\{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" \}\]/,
      "the brand files are kept an hour and served stale for a day while they refresh",
    );
  }

  // ── 3. A CRM photo keeps the same link while it is still good ───────────────────────────────────────
  {
    const memo = createSignedLinkMemo({ max: 3, minLeftMs: 10 * 60_000 });
    const t0 = 1_000_000;
    memo.remember("a.jpg", "url-a", t0 + 15 * 60_000);
    assert.deepEqual(memo.take(["a.jpg", "b.jpg"], t0), { reused: { "a.jpg": "url-a" }, toSign: ["b.jpg"] }, "a good link is handed back");
    assert.deepEqual(
      memo.take(["a.jpg"], t0 + 5 * 60_000 + 1),
      { reused: {}, toSign: ["a.jpg"] },
      "a link with under ten minutes left is signed again — it would die on a screen that keeps it eight",
    );
    assert.equal(memo.size, 0, "and the tired link is dropped");
    for (const [path, url] of [["p1", "u1"], ["p2", "u2"], ["p3", "u3"], ["p4", "u4"]]) memo.remember(path, url, t0 + 15 * 60_000);
    assert.equal(memo.size, 3, "bounded");
    assert.deepEqual(memo.take(["p1"], t0).toSign, ["p1"], "the oldest link went first");

    const photos = source("src/lib/phoenix-crm/server/photos.ts");
    assert.match(photos, /const SIGNED_URL_SECONDS = 900;/, "a link lives fifteen minutes");
    assert.match(photos, /const SIGNED_LINK_MIN_LEFT_MS = 10 \* 60 \* 1000;/, "and is reused only with ten or more left");
    const scopeCheck = photos.indexOf('"A photo you asked for is outside your scope."');
    const lookup = photos.indexOf("signedLinks.take(paths, now)");
    assert.ok(scopeCheck > 0 && lookup > scopeCheck, "every path passes the scope check BEFORE a remembered link is looked up");
    assert.match(photos, /signedLinks\.remember\(entry\.path, entry\.signedUrl, expiresAt\);/);
  }

  // ── 4. A price edit expires every cache whose key cannot see the price ──────────────────────────────
  {
    const invalidation = source("src/lib/dashboard/invalidation.ts");
    assert.match(
      invalidation,
      /export function invalidatePriceDependentSalesCaches\(reason: string\) \{\s*for \(const tag of \[CLOSING_STORE_SPLIT_CACHE_TAG, SALES_ACHIEVEMENT_STAMPED_CACHE_TAG\]\) \{\s*try \{\s*revalidateTag\(tag, \{ expire: 0 \}\);/,
      "both price-blind tags are expired at once, so the editor's next screen shows the new price",
    );
    for (const [file, label] of [
      ["src/lib/sales/vs-target.ts", "the achievement month"],
      ["src/lib/sales/service.ts", "the sales platform metrics"],
      ["src/lib/business-review/service.ts", "the Business Review bundle"],
    ] as const) {
      assert.equal(count(source(file), /tags: \[SALES_ACHIEVEMENT_STAMPED_CACHE_TAG\]/), 1, `${label} carries the price-blind tag`);
    }
    const masterData = source("src/lib/sales/master-data/import-service.ts");
    assert.equal(
      count(masterData, /invalidatePriceDependentSalesCaches\(/),
      5,
      "every master-data write busts it: an import, an add, an edit, a (de)activation and a brick move",
    );
    assert.match(masterData, /if \(inserted \+ updated > 0\) invalidatePriceDependentSalesCaches\(/, "an import that changed nothing busts nothing");
  }

  // ── 5. A degraded answer is served once and never kept ───────────────────────────────────────────────
  {
    const view = { crmUnavailable: true };
    let thrown: unknown;
    try {
      serveWithoutCaching(view, "test");
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, "it throws — a cache callback that throws stores nothing");
    assert.equal(servedWithoutCachingValue(thrown)?.value, view, "carrying the very answer");
    assert.equal(servedWithoutCachingValue(new Error("boom")), null, "any other failure is not mistaken for one");
    assert.equal(servedWithoutCachingValue("boom"), null);
    assert.equal(await unwrapServedWithoutCaching(Promise.reject(thrown)), view, "the caller, outside the cache, serves it");
    await assert.rejects(unwrapServedWithoutCaching(Promise.reject(new Error("real"))), /real/, "a real failure still raises");
    assert.equal(await unwrapServedWithoutCaching(Promise.resolve(7)), 7);
    const plain = { facts: [] };
    assert.equal(isDegraded(plain), false);
    assert.equal(markDegraded(plain), plain, "marking returns the same object");
    assert.equal(isDegraded(plain), true);
    assert.equal(isDegraded({ facts: [] }), false, "a mark belongs to one object, never to a shape");
    assert.equal(isDegraded(null), false);
  }

  runDegradedWiringChecks();
  runRemainingChecks();
}

function runDegradedWiringChecks() {
  const retention = source("src/lib/retention-risk/service.ts");
  assert.match(retention, /if \(view\.crmUnavailable\) serveWithoutCaching\(view, /, "the retention board never keeps a CRM-less view for two hours");
  assert.match(retention, /return unwrapServedWithoutCaching\(computeRetentionRiskCached\(/);

  const admin = source("src/lib/admin/service.ts");
  assert.match(admin, /if \(stats\.unavailable\.length > 0\) \{\s*serveWithoutCaching\(stats, /, "data health never keeps a blank source");
  assert.match(admin, /return unwrapServedWithoutCaching\(getDataHealthStatsCached\(\)\);/);

  const coverage = source("src/lib/admin/role-coverage/audit.ts");
  assert.match(coverage, /if \(audit\.totals\.probeFailed > 0\) \{\s*serveWithoutCaching\(audit, /, "a failed probe is never kept as a measurement");
  assert.match(coverage, /return unwrapServedWithoutCaching\(getRoleCoverageAuditCached\(\)\);/);

  const asks = source("src/lib/phoenix-crm/server/visit-asks.ts");
  assert.match(asks, /if \(missedSomeone\) serveWithoutCaching\(reach, /, "a product-manager list with someone missing is never kept");
  assert.match(asks, /unwrapServedWithoutCaching\(cachedProductManagerReach\(\)\)/);

  const review = source("src/lib/business-review/service.ts");
  assert.match(review, /if \(isDegraded\(bundle\)\) serveWithoutCaching\(bundle, /, "a Business Review built on a failed source is never kept");
  assert.match(review, /const served = servedWithoutCachingValue<ReviewBundle>\(error\);/);
  assert.match(
    source("src/lib/business-review/canonical.ts"),
    /const sourceFailed = \[marketing, outstation, visits, directory, lineIdByCode\]\.some\(isDegraded\);\s*return sourceFailed \? markDegraded\(bundle\) : bundle;/,
    "the bundle is degraded when any source it was built from is",
  );
  for (const [file, expected] of [
    ["src/lib/business-review/sources/marketing.ts", 1],
    ["src/lib/business-review/sources/outstation.ts", 1],
    ["src/lib/business-review/sources/visits.ts", 1],
    ["src/lib/business-review/sources/roles.ts", 2],
  ] as const) {
    assert.equal(count(source(file), /return markDegraded\(/), expected, `${file}: each failed read marks its empty answer`);
  }

  const bricks = source("src/lib/crm/brick-geo.ts");
  assert.match(bricks, /if \(areasRes\.error\) throw areasRes\.error;\s*if \(regionsRes\.error\) throw regionsRes\.error;/, "a failed area or region read is thrown, never cached as bricks with no names");

  assert.match(
    source("src/lib/employees/employee-cv.ts"),
    /\.then\(\(ids\) => \{\s*if \(!ids\) return new Set<string>\(\);\s*cvIndexCache = /,
    "a failed CV index read is answered empty and never cached",
  );
  assert.match(
    source("src/lib/employees/employee-photo.ts"),
    /\.then\(\(map\) => \{\s*if \(!map\) return new Map<string, PhotoMapEntry>\(\);\s*photoMapCache = /,
    "a failed photo index read is answered empty and never cached",
  );

  const statutory = source("src/lib/payroll/statutory/config.ts");
  assert.match(
    statutory,
    /if \(error\) \{[\s\S]*?\} else \{\s*answered = true;\s*if \(data\) config = mapConfigRow\(/,
    "only an answer the table gave counts — a read error leaves `answered` false",
  );
  assert.match(statutory, /if \(answered\) cache\.set\(periodStart, /, "so the default after a failed read is never cached for the next minute");
  assert.equal(count(statutory, /cache\.set\(/), 1);
}

function runRemainingChecks() {
  // ── 6. Rows out of the triples and vacations memo are copied before they are decorated ──────────────
  const master = source("src/lib/crm/master.ts");
  assert.match(master, /function copyMemoRows\(rows: readonly CrmMasterRow\[\]\): CrmMasterRow\[\] \{\s*return rows\.map\(\(row\) => \(\{ \.\.\.row \}\)\);/);
  assert.equal(count(master, /const pageRows = copyMemoRows\(filtered\.slice\(start, start \+ pageSize\)\);/), 2, "both computed pages decorate copies");
  assert.equal(count(master, /const chunk = copyMemoRows\(rows\.slice\(i, i \+ CHUNK\)\);/), 2, "both computed exports decorate copies, a chunk at a time");
  assert.equal(count(master, /const pageRows = filtered\.slice\(/), 0, "no computed page decorates the memo's own rows");
  assert.equal(count(master, /attachAgentMeta\(rows, agentMeta, "base_hr_id"\)/), 0, "no export decorates the memo's own rows");

  // ── 7. A bust sits in the write that moves the figure, and nowhere it does nothing ──────────────────
  const sales = source("src/lib/sales/service.ts");
  const reconcile = sales.slice(sales.indexOf("function buildBatchReconciliation("), sales.indexOf("export async function listSalesHistory("));
  assert.ok(reconcile.length > 0, "the reconciliation builder is where it was");
  assert.equal(/invalidate\w*Cache/.test(reconcile), false, "the batch-detail read never empties every sales cache");
  const create = sales.slice(sales.indexOf("export async function createSalesImport("), sales.indexOf("export async function updateSalesBatchStatus("));
  assert.match(create, /invalidateExecutiveDashboardCache\("sales import created", \["sales"\]\);\s*return \{\s*\.\.\.payload\.batch,/, "the upload itself busts, after its rows are in");
  assert.equal(/revalidatePath\("\/overview"\)/.test(source("src/lib/dashboard/invalidation.ts")), false, "the redirect-only /overview is not revalidated");

  // ── 8. Browser storage never takes a page down ──────────────────────────────────────────────────────
  const storageAccess = /\blocalStorage\.(?:getItem|setItem|removeItem|key|length)\b|resolveStorage\(storage\)\?\./;
  for (const file of [
    "src/components/layout/theme-provider.tsx",
    "src/components/action-center/action-center-hub.tsx",
    "src/lib/auth/client-session.ts",
    "src/components/employee-portal/plans-workspace.tsx",
    "src/components/outstation/mobile-outstation-wizard.tsx",
  ]) {
    const lines = source(file).split(/\r?\n/);
    const unguarded = lines.flatMap((line, index) =>
      storageAccess.test(line) && !lines.slice(Math.max(0, index - 4), index + 1).some((near) => /\btry\b/.test(near)) ? [`${file}:${index + 1}`] : [],
    );
    assert.deepEqual(unguarded, [], `${file}: every storage access sits inside a try — a private window or blocked site data throws on it`);
  }

  // ── 9. Plan drafts for periods long gone are forgotten ──────────────────────────────────────────────
  const today = new Date(2026, 9, 26);
  const key = (version: string, start: string) => `${PLAN_DRAFT_KEY_PREFIX}${version}:B-1:weekly:${start}`;
  assert.equal(PLAN_DRAFT_MAX_AGE_DAYS, 60);
  assert.deepEqual(
    stalePlanDraftKeys(
      [key("v1", "2026-10-24"), key("v1", "2026-08-27"), key("v1", "2026-08-26"), key("v0", "2026-10-24"), key("v1", "soon"), "phoenix-theme"],
      { currentVersion: "v1", today },
    ),
    [key("v1", "2026-08-26"), key("v0", "2026-10-24")],
    "a period that started over 60 days ago goes, and so does an older version's draft; this month's, a key it cannot read and other keys stay",
  );
  const workspace = source("src/components/employee-portal/plans-workspace.tsx");
  assert.match(workspace, /return `phoenix:plan-draft:\$\{DRAFT_VERSION\}:\$\{hrId\}:\$\{kind\}:\$\{startDate\}`;/, "the key the sweep reads is the key the workspace writes");
  assert.equal(PLAN_DRAFT_KEY_PREFIX, "phoenix:plan-draft:");
  assert.match(
    workspace,
    /hydratedRef\.current = true;\s*try \{\s*const keys = Array\.from\(\{ length: localStorage\.length \}, \(_, index\) => localStorage\.key\(index\) \?\? ""\);\s*for \(const key of stalePlanDraftKeys\(keys, \{ currentVersion: DRAFT_VERSION, today: new Date\(\) \}\)\) \{\s*localStorage\.removeItem\(key\);/,
    "the workspace sweeps on mount, before it restores this period's draft",
  );
}
