import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// The System Error & Data Integrity Audit is the Super Admin's alone. Every handler under
// /api/admin/system-audit and the page at /admin/system-audit must run
// assertSystemAdministratorWorkspaceAccess BEFORE it reads or writes anything — a guard placed
// after the first read leaks the ledger to whoever reaches the route. The guard is the security
// boundary (CLAUDE.md: the sidebar hiding a link is UX only), so it is pinned on the source:
// comments are stripped first, so a guard that is only MENTIONED in a comment does not count.

const ROOT = process.cwd();
const API_DIR = "app/api/admin/system-audit";
const GUARD = "assertSystemAdministratorWorkspaceAccess(access";

/** The routes this build owns, each held to the full order: CSRF → session → 401 → guard → work. */
const OWNED_ROUTES = [
  "app/api/admin/system-audit/route.ts",
  "app/api/admin/system-audit/export/route.ts",
  "app/api/admin/system-audit/issues/[id]/status/route.ts",
  "app/api/admin/system-audit/occurrences/[id]/route.ts",
] as const;

/** Every call that reads or writes data, or spends a rate-limit token. None may run before the guard. */
const DATA_CALLS = [
  "getSupabaseAdmin",
  "loadSystemAuditPage",
  "iterateSystemAuditExport",
  "listAuditModuleLabels",
  "lookupAuditPeople",
  "loadIntegrityOverview",
  "loadOccurrenceDetail",
  "triageOccurrence",
  "transitionIssueStatus",
  "writeAuditLog",
  "assertExportRateLimit",
  "resolveCurrentUserDisplay",
  "request.json",
  "loadIncidents",
  "loadIntegrity",
] as const;

/** Source with every comment removed; string and template literals are kept as they are. */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    // An apostrophe straight after a letter is English in JSX text ("person's"), never a string.
    const apostrophe = character === "'" && /\w/.test(source[index - 1] ?? "");
    if (!apostrophe && (character === '"' || character === "'" || character === "`")) {
      const quote = character;
      out += character;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          out += source[index] + (source[index + 1] ?? "");
          index += 2;
          continue;
        }
        out += source[index];
        index += 1;
      }
      out += source[index] ?? "";
      index += 1;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

function read(relative: string): string {
  return stripComments(readFileSync(path.join(ROOT, relative), "utf8"));
}

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const relative = `${dir}/${entry}`;
    if (statSync(path.join(ROOT, relative)).isDirectory()) out.push(...routeFiles(relative));
    else if (entry === "route.ts") out.push(relative);
  }
  return out;
}

type Handler = { method: string; body: string; start: number };

function handlers(code: string): Handler[] {
  const pattern = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g;
  const found: Handler[] = [];
  const starts = [...code.matchAll(pattern)];
  starts.forEach((match, position) => {
    const start = match.index ?? 0;
    const end = starts[position + 1]?.index ?? code.length;
    found.push({ method: match[1], body: code.slice(start, end), start });
  });
  return found;
}

function firstCall(code: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?<![\\w.])${escaped}\\s*\\(`).exec(code);
  return match ? match.index : -1;
}

function everyRouteIsGuarded() {
  const all = routeFiles(API_DIR);
  for (const owned of OWNED_ROUTES) {
    assert.ok(all.includes(owned), `${owned} exists`);
  }
  // Any route under the folder — this build's or a sibling's — runs the Super Admin guard in every
  // handler, after resolving the caller and before anything else it calls.
  for (const file of all) {
    const code = read(file);
    const list = handlers(code);
    assert.ok(list.length > 0, `${file} exports at least one handler`);
    for (const handler of list) {
      const resolved = firstCall(handler.body, "resolveAccessContext");
      const guard = handler.body.indexOf(GUARD);
      assert.ok(resolved >= 0, `${file} ${handler.method} resolves the caller`);
      assert.ok(guard > resolved, `${file} ${handler.method} runs ${GUARD}) after resolving the caller`);
    }
  }
}

function ownedRoutesKeepTheOrder() {
  for (const file of OWNED_ROUTES) {
    const code = read(file);
    assert.doesNotMatch(code, /getSupabaseAdmin/, `${file} never opens the service-role client itself — it reads through the system-audit library`);
    assert.match(code, /export const runtime = "nodejs"/, `${file} runs on Node`);
    assert.match(code, /export const dynamic = "force-dynamic"/, `${file} is never cached`);

    const list = handlers(code);
    const prelude = code.slice(0, list[0]?.start ?? code.length);
    for (const name of DATA_CALLS) {
      assert.equal(firstCall(prelude, name), -1, `${file} calls ${name} at module level, outside any guarded handler`);
    }

    for (const handler of list) {
      const where = `${file} ${handler.method}`;
      const resolved = firstCall(handler.body, "resolveAccessContext");
      const expired = firstCall(handler.body, "unauthenticatedSessionResponse");
      const guard = handler.body.indexOf(GUARD);
      assert.ok(resolved >= 0, `${where} resolves the caller`);
      assert.ok(expired > resolved, `${where} answers an expired session with 401 (unauthenticatedSessionResponse) after resolving it`);
      assert.ok(guard > expired, `${where} runs the Super Admin guard after the expired-session check`);
      for (const name of DATA_CALLS) {
        const call = firstCall(handler.body, name);
        if (call === -1) continue;
        assert.ok(call > guard, `${where} calls ${name} BEFORE the Super Admin guard`);
      }
      assert.match(handler.body, /isForbiddenError\(error\)/, `${where} turns the guard's refusal into a 403`);
      assert.match(handler.body, /status: 403/, `${where} answers 403 to a caller who is not the Super Admin`);

      if (handler.method !== "GET") {
        const csrf = firstCall(handler.body, "assertSameOriginMutation");
        assert.ok(csrf >= 0 && csrf < resolved, `${where} refuses a cross-site request (same-origin check) before anything else`);
      }
    }
  }
}

function mutationsAreAudited() {
  const expected: Record<string, string> = {
    "app/api/admin/system-audit/issues/[id]/status/route.ts": "system_audit_status",
    "app/api/admin/system-audit/occurrences/[id]/route.ts": "system_audit_triage",
    "app/api/admin/system-audit/export/route.ts": "system_audit_export",
  };
  for (const [file, entityType] of Object.entries(expected)) {
    assert.match(read(file), new RegExp(`entityType: "${entityType}"`), `${file} writes one audit_logs row of type ${entityType}`);
  }
  const auditTypes = read("src/lib/admin/audit.ts");
  for (const entityType of Object.values(expected)) {
    assert.match(auditTypes, new RegExp(`"${entityType}"`), `${entityType} is a declared AuditEntityType`);
  }
  // FIXED — VERIFIED belongs to the verifier: the status route takes only what parseStatusChange allows.
  assert.match(read("app/api/admin/system-audit/issues/[id]/status/route.ts"), /parseStatusChange\(body\)/);
}

function pageIsGuarded() {
  const file = "app/(admin)/admin/system-audit/page.tsx";
  const code = read(file);
  const start = code.search(/export default async function/);
  assert.ok(start >= 0, `${file} has its default export`);
  const body = code.slice(start);
  const resolved = firstCall(body, "resolveAccessContextFromPage");
  const toLogin = body.indexOf('redirect("/login")');
  const guard = body.indexOf(GUARD);
  const bounce = body.indexOf('redirect("/admin")');
  assert.ok(resolved >= 0, `${file} resolves the caller`);
  assert.ok(toLogin > resolved, `${file} sends an expired session (the guest) to sign-in`);
  assert.ok(guard > toLogin, `${file} runs the Super Admin guard`);
  assert.ok(bounce > guard, `${file} bounces anyone else to /admin`);
  for (const name of DATA_CALLS) {
    const call = firstCall(body, name);
    if (call === -1) continue;
    assert.ok(call > bounce, `${file} calls ${name} BEFORE the Super Admin guard has bounced a non-admin`);
  }
  // The loaders above the default export are private: nothing else can call them unguarded.
  assert.doesNotMatch(code, /export\s+(async\s+)?function\s+load/, `${file} exports no data loader`);
  // redirect() throws by design — inside the guard's try it would be swallowed as a refusal.
  const tryBlock = /try\s*\{([^}]*)\}\s*catch/.exec(body)?.[1] ?? "";
  assert.ok(tryBlock.includes(GUARD), `${file} wraps the guard in a try`);
  assert.doesNotMatch(tryBlock, /redirect\(/, `${file} keeps redirect() outside the guard's try`);
}

function stripCommentsTests() {
  assert.equal(stripComments('a // assertX(access\nb'), "a \nb");
  assert.equal(stripComments("a /* guard */ b"), "a  b");
  assert.equal(stripComments('const url = "https://x"; // c'), 'const url = "https://x"; ');
  assert.equal(stripComments("const s = `/* not a comment */`;"), "const s = `/* not a comment */`;");
  assert.equal(stripComments("<p>the person's page</p> // gone"), "<p>the person's page</p> ");
}

export function runSystemAuditRoutesAccessTests() {
  stripCommentsTests();
  everyRouteIsGuarded();
  ownedRoutesKeepTheOrder();
  mutationsAreAudited();
  pageIsGuarded();
}
