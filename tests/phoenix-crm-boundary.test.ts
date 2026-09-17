import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { permissionMatrix, permissionResources, phoenixRoles, type PermissionAction, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { MODULE_LABELS } from "../src/lib/navigation/module-catalog.ts";
import { accessRegistry, findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

/**
 * Phoenix CRM's edges (the owner, 2026-09-16: a clean new module, built from scratch, "we will not throw
 * it onto the old CRM and wire it in").
 *
 * Nothing about an edge fails loudly when it moves, so each one is pinned here:
 *
 *   1. who holds `phoenix_crm`, and with which actions. The matrix is gate one of two (the organogram,
 *      in src/lib/phoenix-crm/server, is gate two), so a role that gains a grant gains a module;
 *   2. every route asserts exactly the action this file lists, on the caller's own access context,
 *      BEFORE it reads a body, a query or the organogram, and every POST refuses a cross-site request
 *      first; the access registry says the same thing, and the screens call only those routes;
 *   3. nothing in the module reaches the 2026-09-13 pilot (crm_native_*, its cutover date, its contact
 *      list changes, its pages) or iReports360's own tables;
 *   4. the rules the phone runs, and the screens, import no server code, so a service-role client can
 *      never be bundled for a phone;
 *   5. the migration: service-role-only tables and functions, writes to its own tables only, a private
 *      JPEG bucket, and the Cairo day always stated (never the database's `current_date`).
 */

// ── 1. The permission grants ─────────────────────────────────────────────────────────────────────────

const GRANTS: ReadonlyArray<readonly [PhoenixRole, readonly PermissionAction[]]> = [
  // Tries the module in test mode on any territory; `update` is the Settings tab.
  ["Super Admin", ["read", "create", "update", "approve"]],
  ["CEO", ["read"]],
  // Validates the territory's customers, plans the week and enters visits: its own territory only.
  ["Medical Rep", ["read", "create"]],
  // Decides grades, drops and plans beneath them; enters a visit when the rep does not.
  ["District Manager", ["read", "create", "approve"]],
  // Decides plans where the district seat is vacant; the rep enters a chain visit.
  ["Regional Manager", ["read", "approve"]],
  ["National Sales Manager", ["read", "approve"]],
  // Sees every plan and may return one (narrowed to returning in the service).
  ["SFE Manager", ["read", "approve"]],
];

function runPermissionTests() {
  assert.ok(permissionResources.includes("phoenix_crm"), "phoenix_crm is a runtime resource — a key missing from the lookup reads as ALLOWED in navigation");
  assert.equal(MODULE_LABELS.phoenix_crm, "Phoenix CRM");

  const designed = new Map<PhoenixRole, readonly PermissionAction[]>(GRANTS);
  for (const role of phoenixRoles) {
    const held = [...(permissionMatrix[role].phoenix_crm ?? [])].sort();
    const wanted = [...(designed.get(role) ?? [])].sort();
    // Exact, so nobody gains delete, export or import either: nothing in the module is deleted or exported.
    assert.deepEqual(
      held,
      wanted,
      `${role} holds phoenix_crm [${held.join(", ")}] but the module was designed for [${wanted.join(", ")}] — a new holder opens the module to a whole role`,
    );
  }
}

// ── 2. The routes, the registry and the screens' calls ──────────────────────────────────────────────

type RouteGate = {
  route: string;
  method: "GET" | "POST";
  action: PermissionAction;
  audit: "mutation" | "access-read" | null;
  auditRequired: boolean;
};

function get(route: string, action: PermissionAction = "read"): RouteGate {
  return { route, method: "GET", action, audit: null, auditRequired: false };
}

function post(route: string, action: PermissionAction): RouteGate {
  return { route, method: "POST", action, audit: "mutation", auditRequired: true };
}

const API_ROOT = "app/api/phoenix-crm";

const ROUTE_GATES: RouteGate[] = [
  get("overview"),
  get("visits"),
  post("visits", "create"),
  // Only someone who may enter a visit opens its form.
  get("visits/form", "create"),
  get("list"),
  post("list/validate", "create"),
  post("list/places", "create"),
  post("list/places/update", "create"),
  post("list/requests", "create"),
  post("list/requests/withdraw", "create"),
  post("list/requests/decide", "approve"),
  get("plans"),
  post("plans", "create"),
  post("plans/submit", "create"),
  post("plans/decide", "approve"),
  get("plans/reviews"),
  get("team"),
  get("reports"),
  post("photos/upload-slot", "create"),
  // A read sent as a POST (a batch of photo paths does not belong in a URL), audited as a read.
  { route: "photos/sign", method: "POST", action: "read", audit: "access-read", auditRequired: true },
  // The place stamp burned into a live photo: same gate as taking the photo; it persists nothing.
  { route: "location", method: "POST", action: "create", audit: "access-read", auditRequired: false },
  get("settings", "update"),
  post("settings", "update"),
];

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files.sort();
}

function methodBlocks(source: string): Map<string, string> {
  const starts = [...source.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)];
  const blocks = new Map<string, string>();
  starts.forEach((match, index) => {
    const from = Number(match.index);
    const to = index + 1 < starts.length ? Number(starts[index + 1].index) : source.length;
    blocks.set(match[1], source.slice(from, to));
  });
  return blocks;
}

function runRouteTests() {
  const gateKeys = ROUTE_GATES.map((gate) => `${gate.method} ${gate.route}`).sort();
  assert.equal(new Set(gateKeys).size, gateKeys.length, "each route and method is listed once");

  // The handlers on disk are exactly the routes listed above.
  const files = walk(API_ROOT);
  assert.ok(files.length >= 20, `the route scan found only ${files.length} files — it has stopped seeing the module`);
  const onDisk: string[] = [];
  for (const file of files) {
    assert.match(file, /\/route\.ts$/, `${file}: only route handlers live under ${API_ROOT}`);
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /from "@\/lib\/supabase/, `${file} reaches the database only through the module's services`);
    const route = file.slice(API_ROOT.length + 1, file.length - "/route.ts".length);
    for (const method of methodBlocks(source).keys()) onDisk.push(`${method} ${route}`);
  }
  assert.deepEqual(onDisk.sort(), gateKeys, "a Phoenix CRM route was added, removed or given a method without its gate being decided in this file");

  // Each handler asserts its action once, first thing after resolving the caller.
  for (const gate of ROUTE_GATES) {
    const label = `${gate.method} /api/phoenix-crm/${gate.route}`;
    const block = methodBlocks(readFileSync(`${API_ROOT}/${gate.route}/route.ts`, "utf8")).get(gate.method);
    assert.ok(block, `${label} has no handler`);

    const asserted = [...block.matchAll(/assertPermission\(\s*(\w+)\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)].map(
      (match) => `${match[1]} ${match[2]}:${match[3]}`,
    );
    assert.deepEqual(asserted, [`access phoenix_crm:${gate.action}`], `${label} asserts phoenix_crm:${gate.action}, once, on the caller's own access`);
    assert.doesNotMatch(block, /\bcanAccess\(/, `${label}: the gate is assertPermission, never a softer canAccess branch`);

    const contextAt = block.indexOf("const access = await resolveAccessContext(request);");
    const gateAt = block.indexOf("await assertPermission(access,");
    assert.ok(contextAt >= 0 && gateAt > contextAt, `${label} resolves the caller, then asserts the permission`);
    for (const early of ["request.json(", "searchOf(", "resolvePhoenixCrmViewer(", "getSupabaseAdmin("]) {
      const at = block.indexOf(early);
      assert.ok(at === -1 || at > gateAt, `${label} calls ${early} before its permission check`);
    }

    if (gate.method === "POST") {
      const csrfAt = block.search(/const csrf = assertSameOriginMutation\(request\);\s+if \(csrf\) return csrf;/);
      assert.ok(csrfAt >= 0 && csrfAt < contextAt, `${label} refuses a cross-site request before anything else`);
    } else {
      assert.equal(block.includes("request.json("), false, `${label} reads no body`);
    }
  }

  // The access registry says the same thing, one entry per method.
  const registered: string[] = [];
  for (const entry of accessRegistry) {
    if (!entry.pattern.startsWith("/api/phoenix-crm/")) continue;
    assert.equal(entry.methods.length, 1, `${entry.pattern}: one registry entry per method, so each method's action is stated on its own`);
    const method = entry.methods[0];
    const route = entry.pattern.slice("/api/phoenix-crm/".length);
    const label = `${method} ${entry.pattern}`;
    registered.push(`${method} ${route}`);
    const gate = ROUTE_GATES.find((candidate) => candidate.route === route && candidate.method === method);
    if (!gate) continue; // named by the set comparison below
    assert.deepEqual(entry.permission, { resource: "phoenix_crm", action: gate.action }, `${label}: the registry declares the action the handler asserts`);
    assert.equal(entry.authMode, "session", `${label} is a session route`);
    assert.equal(entry.guard, "assert-permission", `${label} is gated by assertPermission`);
    assert.equal(entry.csrf.required, method === "POST", `${label}: every POST checks the origin, and no GET claims to`);
    assert.equal(entry.audit.classification, gate.audit ?? undefined, `${label}: audit classification`);
    assert.equal(entry.audit.required, gate.auditRequired, `${label}: audit required`);
    assert.equal(findAccessRegistryEntry(entry.pattern, method)?.pattern, entry.pattern, `${label} resolves to its own entry, never a blanket`);
  }
  assert.deepEqual(registered.sort(), gateKeys, "the access registry lists exactly the Phoenix CRM routes");

  // The screens call only those routes, each with a method it takes.
  const methodsByPath = new Map<string, Set<string>>();
  for (const gate of ROUTE_GATES) {
    const path = `/api/phoenix-crm/${gate.route}`;
    methodsByPath.set(path, new Set([...(methodsByPath.get(path) ?? []), gate.method]));
  }
  let calls = 0;
  for (const file of walk("src/components/phoenix-crm")) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["'`](\/api\/[^"'`?$]*)/g)) {
      assert.ok(methodsByPath.has(match[1]), `${file} calls ${match[1]}, which is not a Phoenix CRM route`);
    }
    for (const match of source.matchAll(/\bcrmPost(?:<[^();{}\n]*>)?\(\s*"([^"]+)"/g)) {
      calls += 1;
      assert.ok(methodsByPath.get(match[1])?.has("POST"), `${file} posts to ${match[1]}, which takes no POST`);
    }
    for (const match of source.matchAll(/\b(?:crmGet|crmUrl)(?:<[^();{}\n]*>)?\(\s*"([^"]+)"/g)) {
      calls += 1;
      assert.ok(methodsByPath.get(match[1])?.has("GET"), `${file} reads ${match[1]}, which takes no GET`);
    }
  }
  assert.ok(calls >= 15, `the screens' calls were found only ${calls} times — the scan has stopped seeing them`);
}

// ── 3. Isolation from the pilot and from iReports360 ────────────────────────────────────────────────

const MODULE_DIRECTORIES = [
  "src/lib/phoenix-crm",
  "src/components/phoenix-crm",
  API_ROOT,
  "app/employee-portals/field-crm",
  "app/(admin)/admin/field-crm",
];

const NOT_THIS_MODULE: ReadonlyArray<readonly [RegExp, string]> = [
  [/crm_native_/, "the 2026-09-13 pilot's crm_native_* tables"],
  [/crm_cutover/, "the pilot's cutover date"],
  [/crm_contact_list_changes/, "the pilot's contact-list changes"],
  [/@\/lib\/crm\/native-visits/, "the pilot's code"],
  [/@\/lib\/weekly-planning/, "the district managers' weekly plans, a different workflow that emails"],
  [/ireports360_/i, "iReports360's own tables"],
  [/["'`]\/api\/crm\//, "the old CRM's and the pilot's API routes"],
  [/["'`]\/(?:admin|employee-portals)\/phoenix-crm\b/, "the pilot's pages"],
];

function runIsolationTests() {
  const files = [...MODULE_DIRECTORIES.flatMap((directory) => walk(directory)), "src/lib/notifications/phoenix-crm-channel-guard.ts"];
  assert.ok(files.length >= 60, `the module scan found only ${files.length} files — it has stopped seeing the module`);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [pattern, what] of NOT_THIS_MODULE) {
      assert.doesNotMatch(source, pattern, `${file} reaches ${what} — Phoenix CRM is built clean, never wired into the old CRM`);
    }
  }
}

// ── 4. What the phone's code imports ────────────────────────────────────────────────────────────────

function importsOf(source: string): string[] {
  return [
    ...[...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1]),
    ...[...source.matchAll(/^\s*import\s+"([^"]+)"/gm)].map((match) => match[1]),
    ...[...source.matchAll(/\b(?:import|require)\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]),
  ];
}

const SERVER_SIDE: RegExp[] = [
  /^@\/lib\/phoenix-crm\/server(?:\/|$)/,
  /^@\/lib\/supabase(?:\/|$)/,
  /^server-only$/,
  /^@\/lib\/notifications(?:\/|$)/,
  /^@\/lib\/observability(?:\/|$)/,
  /^@\/lib\/auth\/server$/,
  /^next\/headers$/,
  /^node:/,
];

function runImportTests() {
  // The pure rules run on the phone AND on the server: no framework, no React, no permissions, no I/O.
  const rules = walk("src/lib/phoenix-crm").filter((file) => !file.includes("/server/") && !file.endsWith("/view-types.ts"));
  assert.ok(rules.length >= 10, `found only ${rules.length} rule modules`);
  for (const file of rules) {
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
      for (const pattern of [...SERVER_SIDE, /^next(?:\/|$)/, /^react(?:\/|$|-)/, /^@\/lib\/auth(?:\/|$)/]) {
        assert.doesNotMatch(specifier, pattern, `${file} imports ${specifier} — the module's rules stay pure, for the phone and the tests`);
      }
    }
  }

  // The screens borrow the server's shapes through view-types.ts, and nothing else of the server's.
  for (const file of walk("src/components/phoenix-crm")) {
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
      for (const pattern of SERVER_SIDE) {
        assert.doesNotMatch(specifier, pattern, `${file} imports ${specifier} — server code must never be bundled for a phone`);
      }
    }
  }

  const viewTypes = readFileSync("src/lib/phoenix-crm/view-types.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(viewTypes, /^\s*import\b/m, "view-types.ts imports nothing");
  const exported = viewTypes.match(/^\s*export\b.*$/gm) ?? [];
  assert.ok(exported.length >= 5, "view-types.ts still carries the screens' shapes");
  for (const line of exported) {
    assert.match(line, /^\s*export type \{/, `view-types.ts re-exports types only — a value would pull server code into the phone's bundle: ${line.trim()}`);
  }
}

// ── 5. The server's data access, and the migration ──────────────────────────────────────────────────

const MIGRATION = "supabase/migrations/20260916150000_phoenix_crm.sql";

/** The migration without its comments (the rollback lives in comments and drops everything). */
function migrationSql(): string {
  return readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n").replace(/--.*$/gm, "");
}

function runMigrationTests() {
  const sql = migrationSql();
  assert.match(sql.trim(), /^begin;/, "the migration runs in one transaction");
  assert.match(sql.trim(), /commit;$/, "and commits at the very end");
  assert.match(sql, /\nnotify pgrst, 'reload schema';\n/, "the API sees the new functions without a restart");

  // Tables: its own thirteen, every one locked to the service role.
  const tables = [...sql.matchAll(/\bcreate table if not exists public\.(phoenix_crm_[a-z_]+) \(/g)].map((match) => match[1]);
  assert.equal(tables.length, (sql.match(/\bcreate\s+table\b/gi) ?? []).length, "every table the migration creates is a public.phoenix_crm_* table");
  assert.equal(tables.length, 13, "Phoenix CRM's thirteen tables");
  const loop = /foreach v_table in array array\[([\s\S]*?)\] loop([\s\S]*?)end loop;/.exec(sql);
  assert.ok(loop, "the loop that locks every table to the service role is still there");
  assert.deepEqual(
    [...loop[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort(),
    [...tables].sort(),
    "every table goes through the lock loop — a table left out is open to the anon and authenticated roles",
  );
  for (const statement of [
    "execute format('alter table public.%I enable row level security', v_table);",
    "'create policy %I on public.%I for all to service_role using (true) with check (true)'",
    "execute format('revoke all on table public.%I from public, anon, authenticated', v_table);",
    "execute format('grant all on table public.%I to service_role', v_table);",
  ]) {
    assert.ok(loop[2].includes(statement), `the lock loop still runs: ${statement}`);
  }

  // Functions: seventeen, SECURITY DEFINER with a fixed search path, executable by the service role only.
  const functions = [...sql.matchAll(/\bcreate or replace function public\.(phoenix_crm_[a-z_]+)\(/g)].map((match) => match[1]);
  assert.equal(functions.length, (sql.match(/\bcreate\s+(?:or\s+replace\s+)?function\b/gi) ?? []).length, "every function is a public.phoenix_crm_* function");
  assert.equal(new Set(functions).size, functions.length, "no function is defined twice — an overload would escape its revoke");
  assert.equal(functions.length, 17, "Phoenix CRM's seventeen functions");
  for (const name of functions) {
    const header = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\nas \\$\\$`).exec(sql);
    assert.ok(header, `${name}: its header ends in "as $$"`);
    assert.match(header[1], /\n\s*security definer\n/, `${name} is SECURITY DEFINER`);
    assert.match(header[1], /\n\s*set search_path to 'public'\s*$/, `${name} fixes its search path`);
  }
  const revoked = [...sql.matchAll(/^revoke execute on function public\.(phoenix_crm_[a-z_]+)\([^)]*\) from public, anon, authenticated;$/gm)].map((match) => match[1]);
  const granted = [...sql.matchAll(/^grant execute on function public\.(phoenix_crm_[a-z_]+)\([^)]*\) to service_role;$/gm)].map((match) => match[1]);
  assert.deepEqual([...revoked].sort(), [...functions].sort(), "every function is taken away from public, anon and authenticated");
  assert.deepEqual([...granted].sort(), [...functions].sort(), "and given to the service role");
  assert.doesNotMatch(sql, /\bgrant\b[^;]*\bto\s+[^;]*\b(?:anon|authenticated|public)\b/i, "nothing is granted to anon, authenticated or public");
  assert.doesNotMatch(sql, /\bsecurity\s+invoker\b/i);

  // Writes: its own tables, and the bucket row. Reads of the organogram and the reference list are by design.
  const writes = [...sql.matchAll(/\b(insert\s+into|delete\s+from|update)\s+([a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?)/gi)]
    .filter((match) => !(match[1].toLowerCase() === "update" && match[2].toLowerCase() === "set"))
    .map((match) => match[2].toLowerCase());
  assert.ok(writes.length >= 40, `found only ${writes.length} writes — the scan has stopped seeing the functions`);
  for (const target of writes) {
    assert.ok(/^public\.phoenix_crm_[a-z_]+$/.test(target) || target === "storage.buckets", `the migration writes ${target} — Phoenix CRM writes its own tables only`);
  }
  for (const match of sql.matchAll(/\bdrop\s+(\w+)/gi)) {
    assert.equal(match[1].toLowerCase(), "policy", `the migration drops a ${match[1]} — it only ever replaces its own policies`);
  }
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /crm_native_|crm_cutover|crm_contact_list_changes/, "the migration touches nothing of the pilot's");
  assert.doesNotMatch(sql, /\bcurrent_date\b/i, "a day is always the Cairo day, stated — current_date is the database's UTC day");

  // The photo bucket: private, JPEG only, 2 MB; a re-run makes it private again.
  assert.match(
    sql,
    /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s+values \('phoenix-crm-photos', 'phoenix-crm-photos', false, 2097152, array\['image\/jpeg'\]\)\s+on conflict \(id\) do update\s+set public = false,/,
  );
  assert.match(
    sql,
    /create policy phoenix_crm_photos_service_role\s+on storage\.objects\s+for all\s+to service_role\s+using \(bucket_id = 'phoenix-crm-photos'\)\s+with check \(bucket_id = 'phoenix-crm-photos'\)/,
    "only the service role reaches the photos",
  );

  // The services read and call only what the migration creates, and read nothing else but three sources.
  const READ_ONLY_SOURCES = ["au_v_org_tree", "employees", "source_of_sales_products"];
  let tableUses = 0;
  let rpcUses = 0;
  for (const file of walk("src/lib/phoenix-crm/server")) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\.from\(\s*"([^"]+)"\s*\)/g)) {
      tableUses += 1;
      const table = match[1];
      if (table.startsWith("phoenix_crm_")) {
        assert.ok(tables.includes(table), `${file} uses ${table}, which the migration does not create`);
        continue;
      }
      assert.ok(READ_ONLY_SOURCES.includes(table), `${file} uses ${table} — outside its own tables Phoenix CRM reads only the organogram, people's names and the product list`);
      const chain = source.slice(Number(match.index) + match[0].length).split(";")[0];
      assert.match(chain, /^\s*\.select\(/, `${file} only ever reads ${table}`);
      assert.doesNotMatch(chain, /\.(?:insert|update|upsert|delete)\(/, `${file} writes ${table}`);
    }
    for (const match of source.matchAll(/(?:\.rpc|\bcallPhoenixCrm(?:<[^();{}\n]*>)?|\brpcAll(?:<[^();{}\n]*>)?\([^,()]*(?:\(\))?,)\(?\s*"([a-z_]+)"/g)) {
      rpcUses += 1;
      assert.ok(functions.includes(match[1]), `${file} calls ${match[1]}, which the migration does not create`);
    }
    for (const match of source.matchAll(/\.storage\.from\(\s*([^)]*)\)/g)) {
      assert.equal(match[1].trim(), "PHOENIX_CRM_PHOTO_BUCKET", `${file} opens a bucket other than the module's own`);
    }
  }
  assert.ok(tableUses >= 20, `found only ${tableUses} table reads in the services`);
  assert.ok(rpcUses >= 12, `found only ${rpcUses} function calls in the services`);
  assert.match(readFileSync("src/lib/phoenix-crm/server/photos.ts", "utf8"), /export const PHOENIX_CRM_PHOTO_BUCKET = "phoenix-crm-photos";/);
}

export function runPhoenixCrmBoundaryTests() {
  runPermissionTests();
  runRouteTests();
  runIsolationTests();
  runImportTests();
  runMigrationTests();
}
