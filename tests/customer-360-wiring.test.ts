import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { HUB_LINES } from "../src/lib/customer-360/hub.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Customer 360's wiring (owner, 2026-10-18): it UPDATES ITSELF after every write that changes it, it
 * reads sales from the Monthly Closing alone, its gates sit in the handlers, nothing outside it ever
 * reads its verdict to stop a marketing request, and the identity sources the code accepts are the
 * ones the database allows.
 */

const read = (relative: string): string => readFileSync(relative, "utf8").replace(/\r\n/g, "\n");
const code = (relative: string): string => stripComments(read(relative));

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full.replace(/\\/g, "/"));
  }
  return out;
}

/** Every app write that changes the report, and how many times its file refreshes it. */
const WRITERS: ReadonlyArray<readonly [string, number, string]> = [
  ["src/lib/phoenix-crm/server/db.ts", 1, "Phoenix CRM validation, drops, places and visits"],
  ["src/lib/marketing-requests/sheet-webhook.ts", 1, "every marketing request change"],
  ["src/lib/direct-orders/sheet-webhook.ts", 1, "every direct order and venue change"],
  ["src/lib/customer-pharmacy-mapping/actions.ts", 2, "a customer→pharmacy link approved or rejected"],
  ["src/lib/marketing-requests/cancel.ts", 1, "a marketing request cancelled"],
  ["src/lib/marketing-requests/finance-hold.ts", 2, "a marketing request held or released by Finance"],
  ["src/lib/marketing-requests/service.ts", 1, "two marketing venues merged"],
  ["src/lib/direct-orders/pharmacy-validation.ts", 1, "a direct-order pharmacy validated"],
  ["src/lib/direct-orders/pharmacy-probation.ts", 1, "a venue promoted out of probation"],
  ["src/lib/customer-identity/server/decisions.ts", 3, "an identity link confirmed, ruled apart or withdrawn"],
  ["src/lib/sales/monthly-closing-publication.ts", 2, "a closing published or unpublished"],
  ["src/lib/customer-360/server/pharmacy-matches.ts", 2, "a pharmacy match decided or undone"],
];

function quotedWords(fragment: string): string[] {
  return [...fragment.matchAll(/'([a-z_0-9]+)'|"([a-z_0-9]+)"/g)].map((match) => match[1] ?? match[2]).sort();
}

export function runCustomer360WiringTests() {
  // ── 1. It updates itself ──────────────────────────────────────────────────────────────────────
  for (const [file, expected, what] of WRITERS) {
    const calls = (code(file).match(/bumpCustomer360Cache\(/g) ?? []).length;
    assert.ok(calls >= expected, `${file} must refresh Customer 360 after ${what} (found ${calls} of ${expected})`);
  }
  // The sheets are not configured in most environments; the report must refresh whether or not they are.
  for (const file of ["src/lib/marketing-requests/sheet-webhook.ts", "src/lib/direct-orders/sheet-webhook.ts"]) {
    const body = code(file);
    const bump = body.indexOf("bumpCustomer360Cache(");
    const unconfigured = body.indexOf("if (!url || !secret) return;");
    assert.ok(bump >= 0 && unconfigured > bump, `${file} refreshes Customer 360 before it gives up on an unconfigured sheet`);
  }
  const phoenixDb = code("src/lib/phoenix-crm/server/db.ts");
  for (const fn of ["phoenix_crm_validate_customer", "phoenix_crm_decide_validation_review", "phoenix_crm_save_visit", "phoenix_crm_restore_validation"]) {
    assert.match(phoenixDb, new RegExp(`"${fn}"`), `the Phoenix CRM write ${fn} refreshes Customer 360`);
  }
  assert.match(
    phoenixDb,
    /if \(CUSTOMER_360_PHOENIX_WRITERS\.has\(fn\)\) bumpCustomer360Cache\(fn\);\n\s*return data as T;/,
    "the Phoenix CRM refresh happens after a SUCCESSFUL write, never before the error check",
  );
  assert.doesNotMatch(read("src/lib/cache/namespaces.ts"), /^\s*import\b/m, "the cache generations import nothing, so any module may bump them");
  const report = code("src/lib/customer-360/server/report.ts");
  assert.match(report, /customer360CacheGeneration\(\)/, "the report rebuilds when the generation moves");
  assert.match(report, /CUSTOMER_360_CACHE_TTL_MS/, "and after ten minutes at most, for writes the app never sees");

  // ── 2. The Monthly Closing is the only sales source ───────────────────────────────────────────
  const moduleFiles = ["src/lib/customer-360", "src/components/customer-360", "app/(admin)/customer-360", "app/api/customer-360"].flatMap(sourceFiles);
  assert.ok(moduleFiles.length >= 25, `the module scan found only ${moduleFiles.length} files`);
  for (const file of moduleFiles) {
    const body = code(file);
    assert.doesNotMatch(body, /source_of_sales_channel_customer_rollup/, `${file} reads the rollup — Customer 360 reads the closing only`);
    assert.doesNotMatch(body, /phx_monthly_achievement|sales_import_rows/, `${file} reads a second sales source`);
  }
  const sales = code("src/lib/customer-360/server/sales.ts");
  assert.match(sales, /"phx_closing_customers_for_pairs"/, "the closing's own customer rows, narrowed to the linked pairs");
  assert.match(sales, /p_line: line\.officialLine/, "the wrapper is passed the closing's line NAME");
  for (const line of HUB_LINES) {
    assert.doesNotMatch(line.officialLine, /_/, `${line.officialLine}: the closing takes 'Anti Infective', never 'anti_infective'`);
  }
  assert.match(sales, /loadPublishedPeriodKeys\(/, "published months come from the publication gate");
  assert.match(sales, /loadUploadedPeriodsInRange\(/, "and the history months from the uploaded gate — two separate functions, never merged");
  assert.match(report, /withoutMaskedSourceRows\(/, "El Qema's rows leave every detail before a viewer who may not see them");
  assert.match(report, /withoutMaskedPharmacies\(base\.assembly, visibleCode\)/, "and so does any shop known only by an El Qema code");
  assert.match(report, /hideVerdictAmounts = reveal \? undefined : hubsWithMaskedCodes\(/, "and the verdict amounts that rest on its rows");
  const buildBase = report.slice(report.indexOf("async function buildBase("), report.indexOf("type Held"));
  assert.match(buildBase, /buildHubViews\(\{ assembly, moneyVisible: true,/, "the verdict is decided once, on the real rows, before any viewer's mask");
  assert.match(report, /verdicts: base\.verdicts/, "and every viewer reads that one verdict");
  assert.match(code("src/lib/customer-360/service.ts"), /\.filter\(pairCanBeRead\)/, "the pharmacy page never reads an EP-PHS code without its brick");
  const view = code("src/components/customer-360/customer-360-view.tsx");
  assert.doesNotMatch(view, />\s*Units\s*</, "the pharmacy page never adds units across different products");
  assert.doesNotMatch(view, /line\.units/, "no unit total is rendered");

  // ── 3. The gates sit in the handlers ──────────────────────────────────────────────────────────
  const matches = code("app/api/customer-360/pharmacy-matches/route.ts");
  const csrfAt = matches.indexOf("assertSameOriginMutation(request)");
  const accessAt = matches.indexOf("resolveAccessContext(request)");
  const gateAt = matches.indexOf('assertPermission(access, "customer_identity", "update")');
  const bodyAt = matches.indexOf("request.json(");
  assert.ok(csrfAt >= 0 && csrfAt < accessAt, "a cross-site decision is refused before anything else");
  assert.ok(gateAt > accessAt && bodyAt > gateAt, "the Super Admin gate runs before the body is read");
  assert.match(matches, /status: 403/, "a refused caller is told 403");

  const exportRoute = code("app/api/customer-360/export/route.ts");
  const exportGate = exportRoute.indexOf('assertPermission(access, "sales", "read")');
  assert.ok(exportGate >= 0 && exportGate < exportRoute.indexOf("loadCustomer360Report("), "the Excel file is gated before the report is built");
  assert.match(exportRoute, /assertExportRateLimit\(/, "and rate limited like every export");
  assert.match(exportRoute, /filterHubRows\(/, "and holds exactly the screen's rows, through the screen's own filter");
  assert.match(exportRoute, /resolveMarketingExporterName\(access\)/, "its cover names the person who exported it, never a login or an HR id");
  const hubView = code("src/components/customer-360/hub-view.tsx");
  assert.match(hubView, /className="@container"[\s\S]*@min-\[560px\]:hidden[\s\S]*@min-\[560px\]:table/, "Lines visiting is cards in a narrow column and a table only once its own width allows");

  for (const file of ["app/(admin)/customer-360/page.tsx", "src/components/customer-360/hub-detail-page.tsx"]) {
    const page = code(file);
    const gate = page.indexOf('assertPermission(access, "sales", "read")');
    assert.ok(gate >= 0 && gate < page.indexOf("loadCustomer360Report("), `${file} is gated before the report is built`);
    assert.match(page, /"employee-portal"\) \{\n\s*redirect\(/, `${file} sends portal roles away`);
  }
  assert.match(code("src/components/customer-360/hub-detail-page.tsx"), /report\.hubs\.find\(/, "a typed URL reaches only a customer in the viewer's own report");
  assert.match(code("app/(admin)/customer-360/page.tsx"), /report\.canDecideMatches \? <PharmacyMatchQueue/, "the confirm tab renders for the Super Admin only");

  const registry = read("src/lib/security/access-registry.ts");
  assert.match(
    registry,
    /audit: \{ classification: "export", required: true \}, methods: \["GET"\], pattern: "\/api\/customer-360\/export", permission: \{ resource: "sales", action: "read" \}/,
    "the export is registered as an audited export behind sales:read",
  );
  assert.match(
    registry,
    /csrfRequired: true, methods: \["POST"\], pattern: "\/api\/customer-360\/pharmacy-matches", permission: \{ resource: "customer_identity", action: "update" \}/,
    "the decision route is registered with its origin check and the Super Admin's permission",
  );

  // ── 4. Advisory only: nothing reads the verdict to stop a request ─────────────────────────────
  assert.doesNotMatch(read("src/lib/customer-360/verdict.ts"), /^\s*import\b/m, "the verdict is a pure function of the evidence");
  const allowed = /^(?:src\/lib\/customer-360\/|src\/components\/customer-360\/|app\/\(admin\)\/customer-360\/|app\/api\/customer-360\/)/;
  const everywhere = [...sourceFiles("src"), ...sourceFiles("app")];
  assert.ok(everywhere.length >= 1500, `the repo scan found only ${everywhere.length} files`);
  for (const file of everywhere) {
    if (allowed.test(file)) continue;
    assert.doesNotMatch(
      read(file),
      /from ["']@\/lib\/customer-360(?!\/validated["'])(?:\/|["'])/,
      `${file} imports Customer 360 — its verdict is advisory and must never reach a request, order or approval path (only the validated-customer rule may be shared)`,
    );
  }

  // ── 5. The identity sources the code accepts are the ones the database allows ─────────────────
  // SQL comments out first: a migration header quotes its own rollback, which names the OLD list.
  const sql = (name: string): string => read(`supabase/migrations/${name}`).replace(/--[^\n]*/g, "");
  const migrations = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort();
  const defining = migrations.filter((name) => /add constraint customer_identity_links_source_check/i.test(sql(name)));
  assert.ok(defining.length > 0, "a migration defines the identity source check");
  const latest = sql(defining[defining.length - 1]!);
  const constraint = latest.slice(latest.search(/add constraint customer_identity_links_source_check/i));
  const allowedInDatabase = quotedWords(constraint.slice(0, constraint.indexOf("]))")));
  const typesSource = read("src/lib/customer-identity/types.ts");
  const union = typesSource.slice(typesSource.indexOf("export type IdentitySource ="));
  const inTypes = quotedWords(union.slice(0, union.indexOf(";")));
  const decide = read("app/api/customer-identity/decide/route.ts");
  const sourcesSet = decide.slice(decide.indexOf("const SOURCES = new Set("));
  const inRoute = quotedWords(sourcesSet.slice(0, sourcesSet.indexOf(");")));
  assert.ok(allowedInDatabase.includes("visit_feedback"), "a typed-pharmacy link can be confirmed (it was refused by the database before)");
  assert.ok(allowedInDatabase.includes("marketing_customer"), "a marketing customer can be linked to its doctor");
  assert.deepEqual(inTypes, allowedInDatabase, "the identity source type lists exactly the sources the database allows");
  assert.deepEqual(inRoute, allowedInDatabase, "the decide route accepts exactly the sources the database allows");
}
