import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildPlan, MODULES } from "../scripts/phoenix-inspect/explore.mjs";
import { SIDE_EFFECT_ROUTES, STAGING_ORIGIN, classifyRequest, routePatternToRegex } from "../scripts/phoenix-inspect/lib/fence.mjs";
import {
  appFileToPattern,
  buildSideEffectList,
  classifyGetRoute,
  classifyRenderWriter,
  exportedMethods,
} from "../scripts/phoenix-inspect/lib/side-effect-routes.ts";

/**
 * Phoenix Visual Intelligence, the roadmap's B3 and B4: the explorer must never request an address that
 * acts when it is read. The list of such addresses is BUILT FROM SOURCE (app/** plus the access
 * registry) by scripts/phoenix-inspect/side-effect-routes.ts, and this test:
 *   1. proves the scanner on fixtures (a GET that writes, a GET beside a POST that writes, a file
 *      response, a page that writes while it renders, a server action that does not);
 *   2. fails when the committed generated/side-effect-routes.json is stale against today's source;
 *   3. walks every API route and page the scan names and fails on any one the fence lets through,
 *      as a navigation and as an RSC fetch;
 *   4. is the gate before a module is enabled: every address any registered module's plan opens must
 *      pass the fence, so a module whose states reach a writing page cannot be added.
 */
export function runPhoenixInspectRouteFenceTests() {
  const policy = { origin: STAGING_ORIGIN };
  const at = (pathname: string) => `${STAGING_ORIGIN}${pathname}`;

  // ── 1. The scanner on fixtures ────────────────────────────────────────────────────────────────
  const getWrites = `export async function GET() { await supabase.from("t").insert({ a: 1 }); return Response.json({}); }`;
  assert.deepEqual(classifyGetRoute(getWrites), ["writes:db-insert"]);
  const postOnlyWrites = `
    export async function GET() { const { data } = await supabase.from("t").select("*"); return Response.json(data); }
    export async function POST(request) { await supabase.from("t").insert(await request.json()); return Response.json({}); }`;
  assert.deepEqual(classifyGetRoute(postOnlyWrites), [], "a write inside POST's own body is not GET's");
  const postConstWrites = `
    export async function GET() { return Response.json({}); }
    export const POST = withRoute(async (request) => { await writeAuditLog({ a: 1 }); return Response.json({}); });`;
  assert.deepEqual(classifyGetRoute(postConstWrites), [], "a write inside an exported POST constant is not GET's");
  const helperWrites = `
    async function touch() { await supabase.from("links").update({ n: 2 }).eq("id", 1); }
    export async function GET() { await touch(); return new Response(buffer, { headers: { "Content-Disposition": "attachment" } }); }`;
  assert.deepEqual(classifyGetRoute(helperWrites).sort(), ["file:content-disposition", "writes:db-update"], "a module-level helper counts toward GET");
  assert.deepEqual(classifyGetRoute(`export async function POST() { await supabase.from("t").insert({}); }`), [], "no GET, nothing to fence");
  assert.deepEqual(classifyGetRoute(`export async function GET() { return Response.json(createHash("sha256").update("x").digest("hex")); }`), [], "a hash update is not a database update");
  assert.deepEqual(classifyGetRoute(`export async function GET() { return fetch("https://maps.googleapis.com/maps/api/staticmap?x"); }`), ["quota:maps-static"]);
  assert.deepEqual(exportedMethods(`async function handler() {}\nexport { handler as GET, handler as HEAD };`), ["GET", "HEAD"]);
  assert.deepEqual(classifyRenderWriter(`export default async function Page() { await recordShownIncentive(access, data); return null; }`), ["render-writes:record-shown"]);
  assert.deepEqual(
    classifyRenderWriter(`export default function Page() { async function save() { "use server"; await writeAuditLog({}); } return <form action={save} />; }`),
    [],
    "a server action runs on a POST, which the fence stops, not on the render",
  );
  assert.equal(appFileToPattern("app/api/payroll/[id]/bank-file/route.ts"), "/api/payroll/:id/bank-file");
  assert.equal(appFileToPattern("app/(admin)/admin/kpis/page.tsx"), "/admin/kpis");
  assert.equal(appFileToPattern("app/api/files/[...path]/route.ts"), "/api/files/**");
  assert.ok(routePatternToRegex("/api/payroll/:id/bank-file").test("/api/payroll/42/bank-file"));
  assert.ok(routePatternToRegex("/api/files/**").test("/api/files/a/b.pdf"));
  assert.ok(routePatternToRegex("/api/files/**").test("/api/files"));
  assert.ok(!routePatternToRegex("/api/payroll/:id/bank-file").test("/api/payroll/42/bank-file-preview"));

  // ── 2. The committed list is today's source ───────────────────────────────────────────────────
  const repoRoot = process.cwd();
  const fresh = buildSideEffectList(repoRoot);
  const committed = JSON.parse(readFileSync(path.join(repoRoot, "scripts/phoenix-inspect/generated/side-effect-routes.json"), "utf8"));
  const patterns = (items: { pattern: string }[]) => items.map((item) => item.pattern);
  assert.deepEqual(
    patterns(committed.apiRoutes),
    patterns(fresh.apiRoutes),
    "generated/side-effect-routes.json is stale: re-run scripts/phoenix-inspect/side-effect-routes.ts and commit it",
  );
  assert.deepEqual(patterns(committed.renderWriterPages), patterns(fresh.renderWriterPages), "generated/side-effect-routes.json pages are stale");
  assert.ok(SIDE_EFFECT_ROUTES.ok, "the fence could not read generated/side-effect-routes.json");

  // The two render-time writers the roadmap found by hand are found by the scan.
  for (const page of ["/employee-portals/incentive", "/employee-portals/marketing-requests/decision/:requestId"]) {
    assert.ok(patterns(fresh.renderWriterPages).includes(page), `the scan no longer finds ${page}`);
  }
  // The routes the roadmap marked "unfenced" are refused now.
  for (const route of [
    "/api/phoenix-crm/list/template",
    "/api/share/marketing-requests/tok123/file",
    "/api/share/direct-orders/tok123/file",
    "/api/rep-ranks/certificate",
    "/api/reports/organogram/contact-numbers",
    "/api/payroll/42/bank-file",
    "/api/admin/field-workforce-compliance/live-snapshots/2026-08",
    "/api/sales/normalizer/phoenix-template",
    "/api/sales/source-of-sales/raw-template",
    "/api/phoenix-crm/day-interviews/cv",
    "/api/admin/phoenix-crm/case-map-basemap",
    "/api/business-review/pack",
  ]) {
    assert.equal(classifyRequest({ method: "GET", url: at(route) }, policy).allow, false, `${route} is let through`);
  }

  // ── 3. Every scanned address is refused, as a navigation and as an RSC fetch ─────────────────
  const sample = (pattern: string) => pattern.replace(/\/\*\*$/, "/a/b").replace(/:[^/]+|\*/g, "x1");
  const leaks: string[] = [];
  for (const route of [...fresh.apiRoutes, ...fresh.renderWriterPages]) {
    for (const url of [at(sample(route.pattern)), at(`${sample(route.pattern)}?_rsc=abc`)]) {
      if (classifyRequest({ method: "GET", url }, policy).allow) leaks.push(`${route.pattern} (${route.reasons.join(", ")})`);
    }
  }
  assert.deepEqual(leaks, [], `the fence lets through ${leaks.length} address(es) that act when read`);

  // The board's own reads still pass (positive control): every address of every KPIs state, its
  // static assets, and the read-only session pulse.
  for (const pathname of ["/_next/static/chunks/app/admin/templates/page.js", "/api/auth/pulse", "/admin/kpis?month=2026-08", "/employee-portals/kpis"]) {
    assert.deepEqual(classifyRequest({ method: "GET", url: at(pathname) }, policy), { allow: true }, `${pathname} must stay readable`);
  }

  // ── 4. The module gate: no registered module may plan an address the fence refuses ───────────
  for (const [id, spec] of Object.entries(MODULES) as [string, Parameters<typeof buildPlan>[0]][]) {
    const refused = buildPlan(spec)
      .jobs.map((job: { address: string }) => job.address)
      .filter((address: string) => !classifyRequest({ method: "GET", url: at(address) }, policy).allow);
    assert.deepEqual(refused, [], `module ${id} plans addresses the fence refuses; it cannot be enabled until they leave its states`);
  }
}
