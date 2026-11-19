import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describeSchemaIssue, parseFormBody, parseJsonBody } from "../src/lib/http/request-body.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * EVERY MONEY ROUTE JUDGES ITS BODY WITH A SCHEMA (REC-060, money slice, 19 Nov 2026).
 *
 * The money areas are payroll and automated payroll, deductions (monthly and daily) and their disputes,
 * expense and outstation claims, the salary flags and the direct-order collection. Incentive payouts have
 * no write route of their own: an incentive reaches a payslip as an Additions figure typed into the
 * Automated Payroll wizard, so it is covered by the automated payroll routes.
 *
 * Every POST, PATCH, PUT and DELETE handler in those areas reads its body ONLY through parseJsonBody or
 * parseFormBody (src/lib/http/request-body.ts), each with a zod schema. A raw `request.json()`,
 * `request.formData()` or `request.text()` in one of these files is listed here, and the list must be
 * empty — so a new money route, or a new handler in an old one, that skips the schema fails CI.
 *
 * A handler that reads no body at all has nothing to judge. Those files are pinned by name in
 * NO_BODY_ROUTES, so a new money route that reads its body some other way (handing `request` to a helper)
 * cannot slip through as "no body": it fails here until someone looks.
 */

/** Every money area, as a folder (or one route's folder) under app/api. */
export const MONEY_ROUTE_ROOTS = [
  "app/api/payroll",
  "app/api/automated-payroll",
  "app/api/admin/deductions",
  "app/api/deductions",
  "app/api/admin/daily-deductions",
  "app/api/daily-deductions",
  "app/api/dispute-center",
  "app/api/attendance/disputes",
  "app/api/admin/outstation",
  "app/api/outstation",
  "app/api/admin/salary-flags",
  "app/api/direct-orders/[id]/collection",
] as const;

/** Money routes whose mutating handlers read no body: nothing to judge. Pinned by name. */
export const NO_BODY_ROUTES = new Set<string>([
  "app/api/admin/outstation/[id]/recalculate-distance/route.ts",
  "app/api/admin/outstation/[id]/reminder/route.ts",
  "app/api/automated-payroll/runs/[runId]/non-employees/sync/route.ts",
  "app/api/automated-payroll/runs/[runId]/publish/route.ts",
  "app/api/automated-payroll/runs/[runId]/steps/[stepKey]/confirm/route.ts",
  "app/api/payroll/[id]/route.ts",
  "app/api/payroll/copilot/[runId]/cancel/route.ts",
  "app/api/payroll/copilot/[runId]/materialize/route.ts",
]);

const MUTATING_HANDLER = /export\s+(?:async\s+)?(?:function|const)\s+(POST|PATCH|PUT|DELETE)\b/g;
// A read straight off the request, through a clone of it, or of its raw body stream.
const RAW_BODY_READ = /\b(?:request|req)\s*(?:\.\s*clone\s*\(\s*\))?\s*\.\s*(?:(?:json|formData|text|arrayBuffer|blob)\s*\(|body\b)/;
const SCHEMA_READ = /\bparse(?:Json|Form)Body\s*(?:<[^>]*>)?\s*\(/;
const READER_IMPORT = /from\s+["']@\/lib\/http\/request-body(?:\.ts)?["']/;

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

export type MoneyRoute = { file: string; methods: string[]; source: string };

export function moneyRoutes(): MoneyRoute[] {
  const files = new Set<string>();
  for (const root of MONEY_ROUTE_ROOTS) for (const file of walk(root)) files.add(file.replace(/\\/g, "/"));
  return [...files]
    .sort()
    .map((file) => {
      const source = stripComments(readFileSync(file, "utf8"));
      const methods = [...source.matchAll(MUTATING_HANDLER)].map((match) => match[1]);
      return { file, methods, source };
    })
    .filter((route) => route.methods.length > 0);
}

/** Each mutating handler's own text: from its export to the next export (or the end of the file). */
export function handlerBodies(source: string): { method: string; body: string }[] {
  const starts = [...source.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\b/g)];
  return starts
    .map((match, index) => ({
      method: match[1],
      body: source.slice(match.index ?? 0, starts[index + 1]?.index ?? source.length),
    }))
    .filter((handler) => ["POST", "PATCH", "PUT", "DELETE"].includes(handler.method));
}

/** The money routes that read a body without a schema — the list this suite holds at empty. */
export function moneyRoutesWithoutSchema(routes: MoneyRoute[] = moneyRoutes()): string[] {
  const offenders: string[] = [];
  for (const route of routes) {
    const readsRaw = RAW_BODY_READ.test(route.source);
    const readsWithSchema = SCHEMA_READ.test(route.source);
    if (readsRaw) offenders.push(`${route.file}: reads its body without a schema`);
    else if (readsWithSchema && !READER_IMPORT.test(route.source)) offenders.push(`${route.file}: calls a body reader that is not request-body.ts`);
    else if (!readsWithSchema && !NO_BODY_ROUTES.has(route.file)) offenders.push(`${route.file}: reads no body it can show — add a schema, or pin it in NO_BODY_ROUTES`);
  }
  return offenders;
}

/** A handler that judges its body must have asked who the caller is first (REC-080, #585). */
export function bodiesJudgedBeforeTheCaller(routes: MoneyRoute[] = moneyRoutes()): string[] {
  const offenders: string[] = [];
  for (const route of routes) {
    for (const handler of handlerBodies(route.source)) {
      const read = handler.body.search(SCHEMA_READ);
      if (read < 0) continue;
      const access = handler.body.search(/\bresolveAccessContext\s*\(/);
      if (access < 0 || access > read) offenders.push(`${handler.method} ${route.file}`);
    }
  }
  return offenders;
}

export async function runMoneyRouteBodySchemaTests(): Promise<void> {
  const routes = moneyRoutes();

  // Nothing objecting is not proof anything was looked at: the census must actually see the money routes.
  for (const root of MONEY_ROUTE_ROOTS) assert.ok(existsSync(root), `${root} is a money area that no longer exists — update MONEY_ROUTE_ROOTS`);
  assert.ok(routes.length >= 80, `the census found only ${routes.length} money route files; it should see every one (86 on 19 Nov 2026)`);
  for (const file of NO_BODY_ROUTES) {
    const route = routes.find((entry) => entry.file === file);
    assert.ok(route, `${file} is pinned as reading no body but is not a money route any more — take it out`);
    assert.ok(!RAW_BODY_READ.test(route.source) && !SCHEMA_READ.test(route.source), `${file} reads a body now — give it a schema and take it out of NO_BODY_ROUTES`);
  }
  const withSchema = routes.filter((route) => SCHEMA_READ.test(route.source));
  assert.ok(withSchema.length >= 70, `only ${withSchema.length} money routes judge a body with a schema`);

  // THE LIST — empty, and a new money route without a schema fails here by name.
  assert.deepEqual(moneyRoutesWithoutSchema(routes), [], "every money route reads its body through a zod schema");
  assert.deepEqual(bodiesJudgedBeforeTheCaller(routes), [], "every money route asks who the caller is before it judges the body");

  // The census itself fires: a raw read, a stray reader and an unpinned bodiless route are each named.
  const fake = (file: string, source: string): MoneyRoute => ({ file, methods: ["POST"], source });
  assert.deepEqual(
    moneyRoutesWithoutSchema([
      fake("app/api/payroll/new/route.ts", "export async function POST(request) { const body = await request.json(); }"),
      fake("app/api/payroll/cloned/route.ts", "export async function POST(request) { const body = await request.clone().json(); }"),
      fake("app/api/payroll/stream/route.ts", "export async function POST(request) { const reader = request.body.getReader(); }"),
      fake("app/api/payroll/other/route.ts", "export async function POST(request) { await parseJsonBody(request, s); }"),
      fake("app/api/payroll/none/route.ts", "export async function POST(request) { return ok(); }"),
      fake(
        "app/api/payroll/good/route.ts",
        'import { parseJsonBody } from "@/lib/http/request-body";\nexport async function POST(request) { await parseJsonBody(request, s); }',
      ),
    ]),
    [
      "app/api/payroll/new/route.ts: reads its body without a schema",
      "app/api/payroll/cloned/route.ts: reads its body without a schema",
      "app/api/payroll/stream/route.ts: reads its body without a schema",
      "app/api/payroll/other/route.ts: calls a body reader that is not request-body.ts",
      "app/api/payroll/none/route.ts: reads no body it can show — add a schema, or pin it in NO_BODY_ROUTES",
    ],
  );
  assert.deepEqual(
    bodiesJudgedBeforeTheCaller([
      fake(
        "app/api/payroll/early/route.ts",
        "export async function POST(request) { const b = await parseJsonBody(request, s); const access = await resolveAccessContext(request); }",
      ),
    ]),
    ["POST app/api/payroll/early/route.ts"],
  );

  // ── The reader ──────────────────────────────────────────────────────────────────────────────────────
  const { z } = await import("zod");
  const schema = z.object({ amount: z.number(), note: z.string().optional() });
  const post = (body: string | undefined, contentType = "application/json") =>
    new Request("http://localhost/api/x", { method: "POST", body, headers: { "content-type": contentType } });

  assert.deepEqual(await parseJsonBody(post('{"amount":12.5}'), schema), { ok: true, data: { amount: 12.5 } });
  const wrong = await parseJsonBody(post('{"amount":"12.5"}'), schema);
  assert.equal(wrong.ok, false);
  assert.equal(!wrong.ok && wrong.reason, "schema");
  assert.match(!wrong.ok ? wrong.message : "", /^Invalid request body: amount: /, "the refusal names the field");
  const notJson = await parseJsonBody(post("{not json"), schema);
  assert.equal(!notJson.ok && notJson.reason, "invalid_json", "with no fallback, a body that is not JSON is refused");
  const empty = await parseJsonBody(post(undefined), z.object({ reason: z.string().optional() }), { fallback: {} });
  assert.deepEqual(empty, { ok: true, data: {} }, "a route that took an empty body as {} still does");
  const nullFallback = await parseJsonBody(post("nope"), z.null().or(z.object({})), { fallback: null });
  assert.deepEqual(nullFallback, { ok: true, data: null }, "the fallback is exactly what the route used to catch to");

  const form = new FormData();
  form.set("revision", "r1");
  form.append("tag", "a");
  form.append("tag", "b");
  form.set("file", new File(["x"], "sheet.xlsx"));
  const formSchema = z.object({ revision: z.string(), tag: z.array(z.string()), file: z.instanceof(File) });
  const parsedForm = await parseFormBody(new Request("http://localhost/api/x", { method: "POST", body: form }), formSchema);
  assert.equal(parsedForm.ok, true, "a form is judged field by field, a repeated field as a list");
  assert.equal(parsedForm.ok && parsedForm.data.tag.length, 2);
  assert.ok(parsedForm.ok && parsedForm.form instanceof FormData, "the raw form is handed back");
  const badForm = await parseFormBody(new Request("http://localhost/api/x", { method: "POST", body: new FormData() }), formSchema);
  assert.equal(badForm.ok, false, "a form missing its file is refused");

  assert.equal(describeSchemaIssue(undefined), "Invalid request body.");
  assert.equal(describeSchemaIssue([{ path: [], message: "Required" }]), "Invalid request body: Required");
}
