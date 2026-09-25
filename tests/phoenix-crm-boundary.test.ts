import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { permissionMatrix, permissionResources, phoenixRoles, type PermissionAction, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { MODULE_LABELS } from "../src/lib/navigation/module-catalog.ts";
import { accessRegistry, findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { stripComments } from "./support/comment-strip.ts";

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
 *      JPEG bucket, and the Cairo day always stated (never the database's `current_date`);
 *   6. the risk review's fixes (2026-09-17), in the database and in the services: plan against actual
 *      keeps a finished day when a plan is reopened or returned, a readiness gap never reads as ready, an
 *      empty reference list is never stamped ready, a week that is over keeps its plan, a photo slot
 *      lasts 2 hours, the migration never queues uploads behind a lock, the product list is paged, and
 *      the paid street-address lookup is limited per person.
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
  // The Doctors directory and NOTHING else. Owner, 2026-09-22: "give SFE and Training Manager the
  // full company list too", then, asked whether he should also reach a customer's page: "The list is
  // enough for him." He holds no sales seat, so `territoryForRead` refuses him every territory and
  // the list is where he stops — measured 403 on list and visits. READ alone is the whole grant:
  // `create`, `update` and `approve` are what resolvePhoenixCrmViewer turns into entering visits,
  // requesting list changes and deciding them, and he does none of those.
  ["Training Manager", ["read"]],
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
  // The same territory's list as the Reps List board holds it — by brick, with the month's activity.
  // It reads a SECOND source beside the CRM's own, so it is authorised through the CRM's own seat
  // gate (`loadTerritoryList`) before the board is ever loaded, and is scoped to that seat's rep.
  get("list/board"),
  post("list/validate", "create"),
  // The name and speciality, corrected after validating (owner, 2026-09-22): the rep's own write.
  post("list/rename", "create"),
  // The pharmacy the rep pins as this doctor's primary (owner, 2026-09-24): his own write.
  post("list/primary-pharmacy", "create"),
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
  // The Doctors directory: validated customers across territories, scoped downward on the server.
  get("doctors"),
  // Location integrity evidence. `update` is the OUTER gate only — the service refuses every holder
  // of it but the Super Admin, because a rep who learned this board exists would learn what it
  // measures. Read-only by design: there is no POST, so nothing here can be cleared or edited away.
  get("integrity", "update"),
  get("reports"),
  post("photos/upload-slot", "create"),
  // The native app's live photo: the phone sends the stamped JPEG as a base64 data URL and the server
  // does the PUT to the slot itself. Same create gate as upload-slot, which it calls to issue the slot.
  post("photos/upload", "create"),
  // A read sent as a POST (a batch of photo paths does not belong in a URL), audited as a read.
  { route: "photos/sign", method: "POST", action: "read", audit: "access-read", auditRequired: true },
  // The voice note's slot: the same create gate as the photo's, because whoever may enter this
  // territory's visits is exactly who may attach a recording to one. It is a SEPARATE route rather
  // than a purpose argument on photos/upload-slot for the reason the table is separate — a recording
  // is not evidence of presence and must never be reachable through the path that issues one.
  post("voice/upload-slot", "create"),
  // Playback, on the photo's own pattern: a read sent as a POST, audited because hearing what a rep
  // said on a call discloses as much as seeing where they stood.
  { route: "voice/sign", method: "POST", action: "read", audit: "access-read", auditRequired: true },
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

/**
 * The migrations that follow the first one, in order. Each is held to the same hygiene — one
 * transaction, SECURITY DEFINER with a fixed search path, service-role-only execute, its own tables
 * only — and the functions it adds join the set the services may call.
 */
const LATER_MIGRATIONS = [
  "supabase/migrations/20260922180258_phoenix_crm_pending_customers.sql",
  "supabase/migrations/20260924234547_add_doctor_primary_pharmacy.sql",
  // The voice note, and it must stay LAST: liveMigrationSql swaps in the text of the final entry that
  // names a function, and this is the most recent migration to replace phoenix_crm_save_visit. Listed
  // earlier, it would leave the checks below reading a body the database has already stopped running —
  // the exact failure the comment above this array warns about.
  "supabase/migrations/20260925030047_phoenix_crm_visit_voice_note.sql",
  // Location integrity evidence. It adds a TABLE and no function, which is why the loop below accepts
  // either — and it may sit after the voice note without breaking the ordering rule above, because
  // that rule is about the last entry to name a FUNCTION, and this one names none.
  "supabase/migrations/20260925033551_phoenix_crm_location_integrity.sql",
];

/** A migration without its comments (the rollback lives in comments and drops everything). */
function migrationSql(path = MIGRATION): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/--.*$/gm, "");
}

/** The functions a migration creates or replaces, each held to the same header and grants. */
function functionsIn(sql: string, path: string): string[] {
  const functions = [...sql.matchAll(/\bcreate or replace function public\.(phoenix_crm_[a-z_]+)\(/g)].map((match) => match[1]);
  assert.equal(functions.length, (sql.match(/\bcreate\s+(?:or\s+replace\s+)?function\b/gi) ?? []).length, `${path}: every function is a public.phoenix_crm_* function`);
  assert.equal(new Set(functions).size, functions.length, `${path}: no function is defined twice — an overload would escape its revoke`);
  for (const name of functions) {
    const header = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\nas \\$\\$`).exec(sql);
    assert.ok(header, `${path}: ${name}'s header ends in "as $$"`);
    assert.match(header[1], /\n\s*security definer\n/, `${path}: ${name} is SECURITY DEFINER`);
    assert.match(header[1], /\n\s*set search_path to 'public'\s*$/, `${path}: ${name} fixes its search path`);
  }
  return functions;
}

/**
 * The module's SQL as the database actually holds it: the first migration, with every function a later
 * one replaced swapped for its live text, and every function a later one added appended.
 *
 * Pinning a rule against the first migration alone is how a check quietly starts reading dead SQL — the
 * text is still in the file, and the database stopped running it the day a later migration replaced it.
 */
function liveMigrationSql(): string {
  let sql = migrationSql();
  for (const path of LATER_MIGRATIONS) {
    const later = migrationSql(path);
    for (const name of [...later.matchAll(/\bcreate or replace function public\.(phoenix_crm_[a-z_]+)\(/g)].map((match) => match[1])) {
      const live = functionSql(later, name);
      if (sql.includes(`create or replace function public.${name}(`)) sql = sql.replace(functionSql(sql, name), live);
      else sql += `\n${live}\n$$;\n`;
    }
  }
  return sql;
}

/** Every function a migration introduces is taken from everyone and given to the service role alone. */
function assertFunctionGrants(sql: string, path: string, expected: readonly string[]) {
  const revoked = [...sql.matchAll(/^revoke execute on function public\.(phoenix_crm_[a-z_]+)\([^)]*\) from public, anon, authenticated;$/gm)].map((match) => match[1]);
  const granted = [...sql.matchAll(/^grant execute on function public\.(phoenix_crm_[a-z_]+)\([^)]*\) to service_role;$/gm)].map((match) => match[1]);
  assert.deepEqual([...revoked].sort(), [...expected].sort(), `${path}: every function it introduces is taken away from public, anon and authenticated`);
  assert.deepEqual([...granted].sort(), [...expected].sort(), `${path}: and given to the service role`);
}

/** What every migration in the module must do, whichever one it is. */
function assertMigrationHygiene(sql: string, path: string) {
  assert.match(sql.trim(), /^begin;/, `${path} runs in one transaction`);
  assert.match(sql.trim(), /commit;$/, `${path} commits at the very end`);
  assert.match(sql, /\nnotify pgrst, 'reload schema';\n/, `${path}: the API sees the new functions without a restart`);
  const opening = sql.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(opening.slice(0, 2), ["begin;", "set local lock_timeout = '5s';"], `${path} waits at most 5 seconds for any lock`);
  assert.doesNotMatch(sql, /\bgrant\b[^;]*\bto\s+[^;]*\b(?:anon|authenticated|public)\b/i, `${path}: nothing is granted to anon, authenticated or public`);
  assert.doesNotMatch(sql, /\bsecurity\s+invoker\b/i, `${path}: no function runs as its caller`);
  assert.doesNotMatch(sql, /\btruncate\b/i, `${path}: nothing is truncated`);
  assert.doesNotMatch(sql, /crm_native_|crm_cutover|crm_contact_list_changes/, `${path} touches nothing of the pilot's`);
  assert.doesNotMatch(sql, /\bcurrent_date\b/i, `${path}: a day is always the Cairo day, stated — current_date is the database's UTC day`);
  const writes = [...sql.matchAll(/\b(insert\s+into|delete\s+from|update)\s+([a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?)/gi)]
    .filter((match) => !(match[1].toLowerCase() === "update" && match[2].toLowerCase() === "set"))
    .map((match) => match[2].toLowerCase());
  for (const target of writes) {
    assert.ok(
      /^public\.phoenix_crm_[a-z_]+$/.test(target) || target === "storage.buckets",
      `${path} writes ${target} — Phoenix CRM writes its own tables only`,
    );
  }
  for (const match of sql.matchAll(/\bdrop\s+(\w+)((?:\s+if\s+exists)?\s+[a-z_][a-z_0-9]*)?/gi)) {
    const what = match[1].toLowerCase();
    // "drop not null" widens a column of its own; "drop constraint" replaces one of its own CHECKs.
    if (what === "not") continue;
    if (what === "constraint") {
      const named = (match[2] ?? "").trim().replace(/^if\s+exists\s+/i, "");
      assert.match(named, /^phoenix_crm_[a-z_0-9]+$/, `${path} drops the constraint ${named} — it only ever replaces its own`);
      continue;
    }
    assert.equal(what, "policy", `${path} drops a ${match[1]} — it only ever replaces its own policies and constraints`);
  }
}

function runMigrationTests() {
  const sql = migrationSql();
  assertMigrationHygiene(sql, MIGRATION);

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
  const functions = functionsIn(sql, MIGRATION);
  assert.equal(functions.length, 17, "Phoenix CRM's seventeen functions");
  assertFunctionGrants(sql, MIGRATION, functions);

  // Writes: its own tables, and the bucket row. Reads of the organogram and the reference list are by design.
  const writes = [...sql.matchAll(/\b(insert\s+into|delete\s+from|update)\s+([a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?)/gi)]
    .filter((match) => !(match[1].toLowerCase() === "update" && match[2].toLowerCase() === "set"))
    .map((match) => match[2].toLowerCase());
  assert.ok(writes.length >= 40, `found only ${writes.length} writes — the scan has stopped seeing the functions`);
  // Against the SQL the database runs today, never a function a later migration has replaced.
  runMigrationReviewFixTests(liveMigrationSql());

  // The migrations that follow it are held to the same hygiene, and their functions join the set the
  // services may call. A function replaced by a later migration is not counted twice.
  const callable = new Set(functions);
  const allTables = [...tables];
  for (const path of LATER_MIGRATIONS) {
    const later = migrationSql(path);
    assertMigrationHygiene(later, path);
    const added = functionsIn(later, path);

    // A table a LATER migration adds. It cannot join the first migration's lock loop, so it states the
    // same four statements itself — and the check has to be made here, because until this loop existed
    // a table added after the first migration was invisible to every rule below: the services could
    // read it, and nothing said whether anon and authenticated could too.
    const laterTables = [...later.matchAll(/\bcreate table if not exists public\.(phoenix_crm_[a-z_]+) \(/g)].map((match) => match[1]);

    // A migration must contribute something this scan can SEE. The guard is against a rename quietly
    // matching nothing — an entry that parses to no functions and no tables proves only that the
    // regexes have stopped working. A table-only migration is legitimate and satisfies it.
    assert.ok(
      added.length > 0 || laterTables.length > 0,
      `${path} adds no function and no table — have they been renamed, or the regexes outgrown?`,
    );
    assertFunctionGrants(later, path, added.filter((name) => !callable.has(name)));
    for (const name of added) callable.add(name);
    assert.equal(
      laterTables.length,
      (later.match(/\bcreate\s+table\b/gi) ?? []).length,
      `${path}: every table it creates is a public.phoenix_crm_* table`,
    );
    for (const table of laterTables) {
      for (const statement of [
        `alter table public.${table} enable row level security;`,
        `create policy ${table}_service_role\n  on public.${table} for all to service_role using (true) with check (true);`,
        `revoke all on table public.${table} from public, anon, authenticated;`,
        `grant all on table public.${table} to service_role;`,
      ]) {
        assert.ok(later.includes(statement), `${path}: ${table} is locked to the service role — missing: ${statement.split("\n")[0]}`);
      }
      allTables.push(table);
    }
  }

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
        assert.ok(allTables.includes(table), `${file} uses ${table}, which no migration in this module creates`);
        continue;
      }
      assert.ok(READ_ONLY_SOURCES.includes(table), `${file} uses ${table} — outside its own tables Phoenix CRM reads only the organogram, people's names and the product list`);
      const chain = source.slice(Number(match.index) + match[0].length).split(";")[0];
      assert.match(chain, /^\s*\.select\(/, `${file} only ever reads ${table}`);
      assert.doesNotMatch(chain, /\.(?:insert|update|upsert|delete)\(/, `${file} writes ${table}`);
    }
    for (const match of source.matchAll(/(?:\.rpc|\bcallPhoenixCrm(?:<[^();{}\n]*>)?|\brpcAll(?:<[^();{}\n]*>)?\([^,()]*(?:\(\))?,)\(?\s*"([a-z_]+)"/g)) {
      rpcUses += 1;
      assert.ok(callable.has(match[1]), `${file} calls ${match[1]}, which no Phoenix CRM migration creates`);
    }
    // The module has two buckets, and each file reaches exactly one of them. Stated per file rather
    // than as "either of ours": the two hold different kinds of evidence — a photo says somebody was
    // there, a recording says nothing about where it was made — and a file that could open both is a
    // file that could quietly file a recording where the photos are read from.
    const bucketFor = file.endsWith("/voice-notes.ts") ? "PHOENIX_CRM_VOICE_BUCKET" : "PHOENIX_CRM_PHOTO_BUCKET";
    for (const match of source.matchAll(/\.storage\.from\(\s*([^)]*)\)/g)) {
      assert.equal(match[1].trim(), bucketFor, `${file} opens a bucket other than the one it owns`);
    }
  }
  assert.ok(tableUses >= 20, `found only ${tableUses} table reads in the services`);
  assert.ok(rpcUses >= 12, `found only ${rpcUses} function calls in the services`);
  assert.match(readFileSync("src/lib/phoenix-crm/server/photos.ts", "utf8"), /export const PHOENIX_CRM_PHOTO_BUCKET = "phoenix-crm-photos";/);
  assert.match(readFileSync("src/lib/phoenix-crm/server/voice-notes.ts", "utf8"), /export const PHOENIX_CRM_VOICE_BUCKET = "phoenix-crm-voice";/);

  // The voice note's own rule, and the reason it is asserted rather than written down: a recording
  // carries no authority over when a visit happened, so phoenix_crm_take_voice returns void where its
  // photo sibling returns the issue time that becomes captured_at. Returning nothing is what makes the
  // rule unbreakable by a later edit — and voice-notes.ts exports no issuedAt for one to reach for.
  const voiceSql = migrationSql("supabase/migrations/20260925030047_phoenix_crm_visit_voice_note.sql");
  assert.match(
    voiceSql,
    /create or replace function public\.phoenix_crm_take_voice\([\s\S]*?\)\s*\nreturns void\n/,
    "phoenix_crm_take_voice returns void — a recording may not date a visit",
  );
  assert.doesNotMatch(
    // Stripped, because the comment explaining the absence necessarily names the thing that is absent.
    stripComments(readFileSync("src/lib/phoenix-crm/server/voice-notes.ts", "utf8")),
    /\bissuedAt\b/,
    "voice-notes.ts hands back no issue time — there must be nothing here for a later change to date a visit with",
  );
}

// ── 6. The risk review's fixes (2026-09-17) ─────────────────────────────────────────────────────────

/** One function's text in the comment-free migration, from its header to its closing `$$;`. */
function functionSql(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is still in the migration`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${name} ends in "$$;"`);
  return sql.slice(start, end);
}

function runMigrationReviewFixTests(sql: string) {
  // Replacing the photo policy locks storage.objects until COMMIT, and every upload in the app waits
  // behind it: the migration gives up after 5 seconds instead of queueing them.
  const opening = sql.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(opening.slice(0, 2), ["begin;", "set local lock_timeout = '5s';"], "the migration waits at most 5 seconds for any lock");

  // An empty reference list is ready but never stamped, so a list that reaches the territory later
  // (a new rep's first iReports360 list) is finished before planning.
  assert.match(
    functionSql(sql, "phoenix_crm_seat_readiness"),
    /where p_mark_ready\s+and c\.reference_total > 0\s+and c\.open_count = 0\s+and c\.drop_pending_count = 0\s+on conflict \(seat_id\) do nothing/,
    "a territory is stamped ready only when it has a reference list and all of it is done",
  );

  // A slot is asked for right after the photo is taken: 2 hours covers the wait for the doctor, never
  // the next morning's visits dated to the night before.
  assert.match(
    functionSql(sql, "phoenix_crm_take_photo"),
    /if v_slot\.issued_at < now\(\) - interval '2 hours' then\s+raise exception 'phoenix_crm:photo_expired';/,
    "a photo slot lasts 2 hours",
  );
  assert.equal((sql.match(/phoenix_crm:photo_expired/g) ?? []).length, 1, "one photo window");

  // Once the week's Thursday has passed (Cairo), its plan stays as it stood; a late approval still records.
  const transition = functionSql(sql, "phoenix_crm_plan_transition");
  assert.match(transition, /\n\s*v_today date := \(now\(\) at time zone 'Africa\/Cairo'\)::date;\n/, "the transition reads the Cairo day");
  const weekCheck = transition.search(
    /if v_action <> 'approve' and v_plan\.week_start \+ 5 < v_today then\s+raise exception 'phoenix_crm:week_passed';/,
  );
  assert.ok(weekCheck >= 0, "a plan whose week is over cannot be sent, reopened or returned");
  assert.ok(weekCheck < transition.indexOf("if v_action = 'submit' then"), "the week is checked before any action runs");

  // Plan against actual counts a day when the plan stood sent at the END of that Cairo day, read from
  // the plan's own events — never from the plan's status today, which a reopen or a return changes.
  const planVsActual = functionSql(sql, "phoenix_crm_report_plan_vs_actual");
  assert.match(
    planVsActual,
    /select e\.to_status\s+from public\.phoenix_crm_plan_events e\s+where e\.plan_id = d\.plan_id\s+and e\.to_status is not null\s+and e\.created_at < \(\(d\.plan_date \+ 1\)::timestamp at time zone 'Africa\/Cairo'\)\s+order by e\.created_at desc, e\.id desc\s+limit 1\s+\) in \('submitted', 'approved', 'returned'\)/,
    "a plan day counts when the plan's last status before that Cairo day ended was sent, approved or returned",
  );
  assert.match(
    planVsActual,
    /from sent_days s\s+join public\.phoenix_crm_plans pl on pl\.id = s\.plan_id\s+join public\.phoenix_crm_plan_items i on i\.plan_id = s\.plan_id and i\.plan_date = s\.plan_date/,
    "the planned customers are the items of those sent days only",
  );
  assert.doesNotMatch(planVsActual, /\bpl\.status\b/, "plan against actual never reads a plan's status today — a reopened or returned plan would take finished days out");
  // The report trusts every plan event to carry the status it left the plan in.
  const eventInserts = [...sql.matchAll(/insert into public\.phoenix_crm_plan_events \(([^)]*)\)/g)];
  assert.equal(eventInserts.length, 3, "plans write their events in three places");
  for (const insert of eventInserts) {
    assert.ok(insert[1].split(",").map((column) => column.trim()).includes("to_status"), `a plan event is written without its status: (${insert[1]})`);
  }
}

function runServiceReviewFixTests() {
  const source = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

  // A readiness answer missing for a territory is a fault: it throws, and never reads as ready.
  const list = source("src/lib/phoenix-crm/server/list.ts");
  assert.match(
    list,
    /const unanswered = asked\.filter\(\(seatId\) => !readiness\.has\(seatId\)\);\n\s*if \(unanswered\.length > 0\) \{\n\s*throw new Error\(/,
    "loadReadiness throws when the database leaves a territory out",
  );
  const plans = source("src/lib/phoenix-crm/server/plans.ts");
  assert.match(plans, /if \(!entry\) return \{ ready: false,/, "the planner stays closed for a territory with no readiness answer");
  const team = source("src/lib/phoenix-crm/server/team.ts");
  assert.doesNotMatch(team, /ready: true/, "the Team view never makes up a ready territory");
  assert.doesNotMatch(`${plans}\n${team}`, /noReferenceList|if \(!entry\) return \{ ready: true/);

  // A week that is over keeps its plan: no return is offered or accepted.
  assert.match(plans, /canReturn: weekOpen && canReturnTerritoryPlan\(viewer, seat, isTest\)/, "the planner offers no return once the week is over");
  assert.match(plans, /const weekOpen = editablePlanDays\(weekStart, viewer\.cairoToday\)\.length > 0;/, "the review list knows whether the week is over");
  assert.match(plans, /canReturn: weekOpen && \(plan\?\.status === "submitted"/, "the review list offers no return once the week is over");
  assert.match(
    plans,
    /decidedAs = assertCanReturnPlan\(viewer, seat, isTest\);[\s\S]{0,300}if \(editablePlanDays\(String\(planRow\.week_start\), today\)\.length === 0\) \{\n\s*throw conflictError\(/,
    "returning a plan whose week is over is refused before the database is asked",
  );
  const db = source("src/lib/phoenix-crm/server/db.ts");
  assert.match(db, /\n\s*week_passed: \{ status: 409, message: "[^"]+" \},\n/, "the database's week_passed refusal reads as a sentence");
  assert.match(db, /photo_expired: \{ status: 409, message: "This photo was taken more than 2 hours ago\. Take a new photo\." \}/);

  // The product list is paged on its key, never cut at the database's per-answer row cap. product_name
  // rides along so the pharmacy-stock check can group the products under their family.
  const products = source("src/lib/phoenix-crm/server/products.ts");
  assert.match(
    products,
    /fetchAllRowsKeyset<Record<string, unknown>>\(\s*\(\) => getSupabaseAdmin\(\)\.from\("source_of_sales_products"\)\.select\("product_code, product_name, family, line"\)\.eq\("active", true\),\s*\{ cursorColumn: "product_code",/,
    "the product families come from every active product",
  );
  assert.doesNotMatch(products, /\.limit\(/, "no fixed cap on the product list");

  // The street-address lookup (a paid call per photo) is limited per person, after the permission
  // check and before the body is read; a refusal answers 429, not a server error.
  const location = methodBlocks(source(`${API_ROOT}/location/route.ts`)).get("POST") ?? "";
  const gateAt = location.indexOf('await assertPermission(access, "phoenix_crm", "create");');
  const limitAt = location.search(/await assertApiRateLimit\(\{\n\s*identifier: rateLimitIdentity\(\{ actor: access\.hrId \|\| access\.loginId, request \}\),\n\s*limit: LOOKUPS_PER_HOUR,\n\s*scope: "phoenix_crm_location",\n\s*windowMs: 60 \* 60 \* 1000,\n\s*\}\);/);
  assert.ok(gateAt >= 0 && limitAt > gateAt, "the location lookup is limited per person, after its permission check");
  assert.ok(limitAt < location.indexOf("request.json("), "the limit is checked before the body is read");
  assert.match(source(`${API_ROOT}/location/route.ts`), /const LOOKUPS_PER_HOUR = \d+;/);
  const http = source("src/lib/phoenix-crm/server/http.ts");
  const limited = http.search(/if \(isApiRateLimitError\(error\)\) \{\n\s*return NextResponse\.json\([\s\S]{0,400}\{ headers: \{ "Retry-After": String\(error\.retryAfterSeconds\) \}, status: 429 \}/);
  assert.ok(limited >= 0 && limited < http.indexOf("toApiError(error, fallback)"), "a rate-limit refusal answers 429 with Retry-After, before the generic mapping turns it into a 500");
}

export function runPhoenixCrmBoundaryTests() {
  runPermissionTests();
  runRouteTests();
  runIsolationTests();
  runImportTests();
  runMigrationTests();
  runServiceReviewFixTests();
}
