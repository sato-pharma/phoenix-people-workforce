import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { AuditLogInput } from "../src/lib/admin/audit.ts";

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
  "app/api/admin/system-audit/screens/[id]/route.ts",
  "app/api/admin/system-audit/security/route.ts",
  "app/api/admin/system-audit/block-ip/route.ts",
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
  "loadUserScreenImage",
  "recordScreenshotView",
  "recordSystemAuditRead",
  "loadLoginSecurityOverview",
  "blockIp",
  "unblockIp",
  "countRecentSuccessfulAccounts",
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

// ── The three audited reads write their row (deep audit, 17 Nov 2026) ───────────────────────────
// The access registry declares the Incidents read, the drawer's GET (a person's last page visits) and
// login security (people's sign-in addresses) audited reads, and none of them wrote a row. Each now
// writes one through recordSystemAuditRead: after the guard and the read, awaited, before the answer.

const AUDITED_READS: Array<{ file: string; route: string; answers: Array<[load: string, answer: string]> }> = [
  {
    file: "app/api/admin/system-audit/route.ts",
    route: "/api/admin/system-audit",
    answers: [
      ["lookupAuditPeople(", "NextResponse.json({ people }"],
      ["listAuditModuleLabels(", "NextResponse.json({ labels: modules.labels }"],
      ["loadSystemAuditPage(", "NextResponse.json({ page, query }"],
    ],
  },
  {
    file: "app/api/admin/system-audit/occurrences/[id]/route.ts",
    route: "/api/admin/system-audit/occurrences/:id",
    answers: [["loadOccurrenceDetail(", "NextResponse.json({ detail }"]],
  },
  {
    file: "app/api/admin/system-audit/security/route.ts",
    route: "/api/admin/system-audit/security",
    answers: [["loadLoginSecurityOverview(", "NextResponse.json({ overview })"]],
  },
];

async function auditedReadsWriteTheirRow() {
  const { findAccessRegistryEntry } = await import("../src/lib/security/access-registry.ts");
  for (const { file, route, answers } of AUDITED_READS) {
    const entry = findAccessRegistryEntry(route, "GET");
    assert.equal(entry?.audit.required, true, `${route} is declared an audited read — so it must write the row`);

    const get = handlers(read(file)).find((handler) => handler.method === "GET");
    assert.ok(get, `${file} has its GET`);
    const body = get.body;
    const guard = body.indexOf(GUARD);
    assert.equal(
      body.split("await recordSystemAuditRead(").length - 1,
      answers.length,
      `HEADLINE: ${file} writes exactly one awaited read audit row per answered view (${answers.length})`,
    );
    let from = 0;
    for (const [load, answer] of answers) {
      const loaded = body.indexOf(load, from);
      const recorded = body.indexOf("await recordSystemAuditRead(", loaded);
      const answered = body.indexOf(answer, loaded);
      assert.ok(guard !== -1 && loaded > guard, `${file}: ${load} runs after the Super Admin guard`);
      assert.ok(recorded !== -1 && recorded < answered, `HEADLINE: ${file} writes the read audit row after ${load} and BEFORE ${answer} leaves`);
      from = answered;
    }
    assert.doesNotMatch(body, /\bafterResponse\(|\bafter\(/, `${file} never defers the read audit row past the response`);
  }
  // The page's own first paint reads the ledger on the server, so it writes the same row, after the
  // read succeeded and before the page renders.
  const pageLoader = read("app/(admin)/admin/system-audit/page.tsx");
  const pageLoaded = pageLoader.indexOf("await Promise.allSettled([");
  const pageRecorded = pageLoader.indexOf("await recordSystemAuditRead(reader, {", pageLoaded);
  assert.ok(pageLoaded !== -1 && pageRecorded > pageLoaded, "HEADLINE: the page's first paint writes the incidents read row after its read");
  assert.match(pageLoader.slice(pageRecorded, pageRecorded + 120), /kind: "incidents"/, "the first paint's row is an incidents read");
  assert.ok(pageRecorded < pageLoader.indexOf("page: pageResult.status", pageRecorded), "the row is written before the page renders");

  // The drawer's 404 writes nothing: no occurrence, nothing seen.
  const drawer = handlers(read("app/api/admin/system-audit/occurrences/[id]/route.ts")).find((handler) => handler.method === "GET")!.body;
  assert.ok(drawer.indexOf("status: 404") < drawer.indexOf("await recordSystemAuditRead("), "a missing occurrence answers 404 before any row");
}

async function readAuditRowTests() {
  const { recordSystemAuditRead, systemAuditReadAuditRow } = await import("../src/lib/system-audit/read-audit.ts");
  const reader = { hrId: "B-10", loginId: "owner-login" };

  const drawer = systemAuditReadAuditRow(reader, {
    kind: "occurrence",
    occurrenceId: "8f6a3c1e-1b2d-4c5e-8f70-9a1b2c3d4e5f",
    personHrId: "M-204",
    personName: "Mona Adel",
    pageVisits: 5,
  });
  assert.equal(drawer.entityType, "system_audit_view", "the reads have their own entity type, so /admin/logs can pick them out");
  assert.equal(drawer.entityId, "8f6a3c1e-1b2d-4c5e-8f70-9a1b2c3d4e5f", "the drawer row names the occurrence");
  assert.equal(drawer.actorLoginId, "owner-login");
  assert.equal(drawer.newValues?.readerHrId, "B-10");
  assert.equal(drawer.summary, "Opened System Audit occurrence 8f6a3c1e — Mona Adel, with their last 5 page visits.");

  const security = systemAuditReadAuditRow(reader, { kind: "login_security", page: 2, search: "mona", addresses: 3 });
  assert.equal(security.summary, "Viewed login security — people's sign-in addresses (3 flagged), page 2, search “mona”.");

  const incidents = systemAuditReadAuditRow(reader, { kind: "incidents", filters: {}, offset: 50, rows: 50, total: 1234 });
  assert.match(incidents.summary, /^Viewed the System Audit incidents — rows 51–100 of 1,234\. Filters: /);

  // A trail that throws never refuses the read, and still tries exactly once.
  let attempts = 0;
  let threw = false;
  try {
    await recordSystemAuditRead(reader, { kind: "people", search: "mona", found: 1 }, {
      write: async (_input: AuditLogInput) => {
        attempts += 1;
        throw new Error("outbox down (expected by this test)");
      },
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "HEADLINE: a failing audit trail never refuses the read");
  assert.equal(attempts, 1, "one write per read");
}

/** The read rows' entity type must be a declared AuditEntityType (src/lib/admin/audit.ts). */
async function readAuditTypeIsDeclared() {
  const { AUDIT_ENTITY_TYPES } = await import("../src/lib/admin/audit-entity-types.ts");
  assert.ok(
    (AUDIT_ENTITY_TYPES as readonly string[]).includes("system_audit_view"),
    "system_audit_view is a declared AuditEntityType (src/lib/admin/audit.ts and audit-entity-types.ts)",
  );
}

// ── "Block for 30 days" blocks one real address, never the Super Admin, never a shared network ────

const STUB_SUPABASE = "http://system-audit-block-test.invalid";
type Seen = { method: string; url: string; body: string };

/**
 * Runs `run` with the admin client pointed at a stand-in that records every call and answers from
 * `answer` (or `[]`). Nothing reaches a database. Dev-auth headers are switched on for the run.
 */
async function withStubbedSupabase(answer: (call: Seen) => Response | null, run: (seen: Seen[]) => Promise<void>) {
  const env = process.env as Record<string, string | undefined>;
  const settings: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: STUB_SUPABASE,
    NODE_ENV: "development",
    PHOENIX_ENABLE_DEV_AUTH_HEADERS: "true",
    SUPABASE_SERVICE_ROLE_KEY: "stand-in-service-role-key",
  };
  const saved = Object.keys(settings).map((name) => [name, env[name]] as const);
  const realFetch = globalThis.fetch;
  const seen: Seen[] = [];
  Object.assign(env, settings);
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : request ? await request.clone().text() : "";
    const call = { body, method, url: decodeURIComponent(url) };
    seen.push(call);
    if (!url.startsWith(STUB_SUPABASE)) throw new Error(`the stand-in refuses to reach ${url}`);
    const answered = answer(call);
    if (answered) return answered;
    return new Response(method === "GET" ? "[]" : "[]", { headers: { "content-type": "application/json" }, status: method === "GET" ? 200 : 201 });
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

async function addressTests() {
  const { blockIp, countDistinctAccounts, countRecentSuccessfulAccounts, normalizeIpAddress, readIpBlock } = await import("../src/lib/auth/ip-blocklist.ts");
  assert.equal(normalizeIpAddress(" 203.0.113.7 "), "203.0.113.7");
  assert.equal(normalizeIpAddress("2001:DB8::1"), "2001:db8::1", "HEADLINE: an upper-case IPv6 is stored the way the sign-in records it");
  assert.equal(normalizeIpAddress("10.0.0.0/8"), null, "HEADLINE: a range is not one address, so it is never saved as a block");
  assert.equal(normalizeIpAddress("203.0.113.300"), null, "a typo is not an address");
  assert.equal(normalizeIpAddress("office wifi"), null);
  assert.equal(normalizeIpAddress(""), null);
  assert.equal(normalizeIpAddress(undefined), null);
  assert.equal(countDistinctAccounts([{ login_id: "B-10" }, { login_id: "b-10" }, { login_id: "M-204" }, { login_id: null }]), 2, "one person signing in twice is one person");

  await withStubbedSupabase(
    (call) => (call.url.includes("/auth_login_attempts") ? jsonResponse([{ id: "1", login_id: "B-10" }, { id: "2", login_id: "b-10" }, { id: "3", login_id: "M-204" }]) : null),
    async (seen) => {
      assert.equal(await countRecentSuccessfulAccounts(" 2001:DB8::1 "), 2, "two different people signed in from the address");
      const asked = seen.find((call) => call.url.includes("/auth_login_attempts"));
      assert.ok(asked, "it reads the sign-in attempts");
      assert.match(asked.url, /ip=eq\.2001:db8::1(&|$)/, "for the address in its stored spelling");
      assert.match(asked.url, /success=eq\.true/, "successful sign-ins only");
      assert.match(asked.url, /attempted_at=gte\./, "inside the lookback window");
    },
  );

  await withStubbedSupabase(
    () => null,
    async (seen) => {
      await readIpBlock(" 2001:DB8::1 ");
      const asked = seen.find((call) => call.url.includes("/blocked_ips"));
      assert.match(asked?.url ?? "", /ip=eq\.2001:db8::1(&|$)/, "HEADLINE: the sign-in check looks the address up in the spelling a block is stored in");
    },
  );

  await withStubbedSupabase(
    () => null,
    async (seen) => {
      await assert.rejects(blockIp({ ip: "10.0.0.0/8" }), /Only a single internet address can be blocked/, "HEADLINE: blockIp itself refuses a range");
      assert.equal(seen.filter((call) => call.method === "POST").length, 0, "and saves nothing");
    },
  );
}

async function lensCountsSuccessfulSignInsTests() {
  const { getLoginSecuritySignals } = await import("../src/lib/error-monitor/service.ts");
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const office = "203.0.113.7";
  const attacker = "198.51.100.4";
  const windowRows = [
    // The office: three people mistype once each (that alone flags it), and two of them get in.
    { attempted_at: at(50), id: "a1", ip: office, login_id: "B-10", success: false },
    { attempted_at: at(49), id: "a2", ip: office, login_id: "M-204", success: false },
    { attempted_at: at(48), id: "a3", ip: office, login_id: "K-77", success: false },
    { attempted_at: at(47), id: "a4", ip: office, login_id: "B-10", success: true },
    { attempted_at: at(46), id: "a5", ip: office, login_id: "b-10", success: true },
    { attempted_at: at(45), id: "a6", ip: office, login_id: "M-204", success: true },
    // One address hammering three accounts, never getting in.
    ...["X-1", "X-2", "X-3"].map((login, index) => ({ attempted_at: at(40 - index), id: `b${index}`, ip: attacker, login_id: login, success: false })),
  ];
  await withStubbedSupabase(
    (call) => {
      if (!call.url.includes("/auth_login_attempts")) return null;
      return jsonResponse(call.url.includes("attempted_at=lt.") ? [] : windowRows);
    },
    async () => {
      const signals = await getLoginSecuritySignals(7);
      assert.deepEqual(signals.unavailable, [], "every stand-in source was read");
      const officeEntry = signals.bruteForceIps.find((entry) => entry.ip === office);
      const attackerEntry = signals.bruteForceIps.find((entry) => entry.ip === attacker);
      assert.ok(officeEntry && attackerEntry, "both addresses are flagged by their failures");
      assert.equal(officeEntry.successfulAccounts, 2, "HEADLINE: the lens counts the different people who got in from the address");
      assert.equal(officeEntry.sharedNetwork, true, "two of them make it a shared network");
      assert.equal(attackerEntry.successfulAccounts, 0);
      assert.equal(attackerEntry.sharedNetwork, false, "an address nobody got in from is not a shared network");
    },
  );
}

function superAdminPress(body: unknown, callerAddress = "198.51.100.200"): Request {
  return new Request("http://127.0.0.1:8080/api/admin/system-audit/block-ip", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "x-phoenix-hr-id": "PREVIEW-NOBODY",
      "x-phoenix-role": "Super Admin",
      "x-real-ip": callerAddress,
    },
    method: "POST",
  });
}

async function blockRouteTests() {
  const { POST } = await import("../app/api/admin/system-audit/block-ip/route.ts");
  const press = (body: unknown, callerAddress?: string) => POST(superAdminPress(body, callerAddress) as never);
  const upserts = (seen: Seen[]) => seen.filter((call) => call.url.includes("/blocked_ips") && call.method === "POST");
  const people = (count: number) => (call: Seen) =>
    call.url.includes("/auth_login_attempts")
      ? jsonResponse(Array.from({ length: count }, (_, index) => ({ id: String(index), login_id: `P-${index}` })))
      : null;

  await withStubbedSupabase(people(0), async (seen) => {
    const response = await press({ action: "block", days: 30, ip: "10.0.0.0/8", reason: "test" });
    assert.equal(response.status, 400, "HEADLINE: a range is refused with 400");
    assert.equal(((await response.json()) as { error?: string }).error, "invalid_address");
    assert.equal(upserts(seen).length, 0, "and nothing is saved as a block that would match nobody");
  });

  await withStubbedSupabase(people(0), async (seen) => {
    const response = await press({ action: "block", days: 30, ip: "203.0.113.50" }, "203.0.113.50");
    assert.equal(response.status, 400, "HEADLINE: the Super Admin's own current address is refused");
    const body = (await response.json()) as { error?: string; message?: string };
    assert.equal(body.error, "own_address");
    assert.match(body.message ?? "", /signed in from right now/);
    assert.equal(upserts(seen).length, 0, "his own address is never blocked");
  });

  await withStubbedSupabase(people(2), async (seen) => {
    const response = await press({ action: "block", days: 30, ip: "203.0.113.7" });
    assert.equal(response.status, 409, "HEADLINE: an address two people signed in from is refused until he confirms");
    const body = (await response.json()) as { error?: string; successfulAccounts?: number; message?: string };
    assert.equal(body.error, "shared_address");
    assert.equal(body.successfulAccounts, 2, "with the count");
    assert.match(body.message ?? "", /^2 people signed in successfully from this address/);
    assert.equal(upserts(seen).length, 0, "nothing is blocked on the first press");
  });

  await withStubbedSupabase(people(2), async (seen) => {
    const response = await press({ action: "block", confirmShared: true, days: 30, ip: "203.0.113.7" });
    assert.equal(response.status, 200, "his second press blocks it");
    assert.equal(upserts(seen).length, 1);
  });

  await withStubbedSupabase(people(1), async (seen) => {
    const response = await press({ action: "block", days: 30, ip: " 2001:DB8::1 " });
    assert.equal(response.status, 200, "one person is not a shared network");
    const saved = JSON.parse(upserts(seen)[0]?.body ?? "{}") as { ip?: string } | Array<{ ip?: string }>;
    const row = Array.isArray(saved) ? saved[0] : saved;
    assert.equal(row?.ip, "2001:db8::1", "HEADLINE: the block is stored in the spelling the sign-in check looks up");
  });

  // Unblock stays as it is: it removes exactly the text it is given.
  await withStubbedSupabase(people(0), async (seen) => {
    const response = await press({ action: "unblock", ip: "10.0.0.0/8" });
    assert.equal(response.status, 200, "an old malformed entry can still be removed");
    assert.ok(seen.some((call) => call.url.includes("/blocked_ips") && call.method === "DELETE" && call.url.includes("ip=eq.10.0.0.0/8")));
  });

  // The caller's address comes from the edge rule, never a header read in the route.
  const route = read("app/api/admin/system-audit/block-ip/route.ts");
  assert.match(route, /clientAddress\(request\)/, "the caller's address is client-address.ts's");
  assert.doesNotMatch(route, /headers\.get\(/, "the route reads no header itself");
}

function blockedSignInTellsTheTruthTests() {
  for (const door of [
    "app/api/auth/login/route.ts",
    "app/api/auth/biometric/login/options/route.ts",
    "app/api/auth/biometric/login/verify/route.ts",
  ]) {
    const code = read(door);
    const blocked = code.indexOf('=== "blocked"');
    assert.ok(blocked !== -1, `${door} refuses a blocked address`);
    const answer = code.slice(blocked, code.indexOf("}", code.indexOf("429", blocked)));
    assert.match(answer, /BLOCKED_SIGN_IN_MESSAGE/, `HEADLINE: ${door} tells a blocked network the truth`);
    assert.match(answer, /"rate_limited"/, `${door} keeps the code`);
    assert.match(answer, /429/, `${door} keeps the status`);
    assert.doesNotMatch(answer, /Too many/, `${door} no longer says "too many attempts" to a block`);
  }
  assert.match(
    read("src/lib/auth/ip-blocklist.ts"),
    /BLOCKED_SIGN_IN_MESSAGE = "Sign-in from this network has been blocked\. Ask HR to lift it\."/,
  );
  // A no-script form post is redirected to /login?error=<code>, and the page prints its own words for
  // the code: a block lands on "network_blocked", whose words are the same sentence.
  assert.match(
    read("app/api/auth/login/route.ts"),
    /loginFailureResponse\(request, payload, "rate_limited", BLOCKED_SIGN_IN_MESSAGE, 429, "network_blocked"\)/,
    "HEADLINE: a no-script sign-in from a blocked network lands on its own code",
  );
  assert.match(
    read("src/components/auth/premium-login-page.tsx"),
    /network_blocked: "Sign-in from this network has been blocked\. Ask HR to lift it\."/,
    "the login page tells a no-script blocked sign-in the same truth",
  );
}

function panelAsksTwiceForASharedNetworkTests() {
  const panel = read("src/components/admin/system-audit/login-security-panel.tsx");
  assert.match(panel, /successfulSignInsLine\(entry\.successfulAccounts\)/, "the count of people who got in sits beside the address");
  const request = panel.slice(panel.indexOf("function requestBlock("), panel.indexOf("async function manageIp("));
  assert.match(request, /if \(sharedNetwork\) \{[\s\S]*?setSharedBlock\(/, "HEADLINE: a shared network opens the in-panel question instead of sending");
  assert.ok(request.indexOf("setSharedBlock(") < request.indexOf("manageIp("), "nothing is sent before that question");
  const question = panel.slice(panel.indexOf("{sharedBlock?.ip === entry.ip ? ("));
  assert.match(question, /signed in\s+successfully from this address — block it anyway\?/, "the question says how many and asks");
  assert.match(question, /manageIp\(sharedBlock\.ip, "block", sharedBlock\.reason, true\)/, "only Block anyway sends, with confirmShared");
  assert.doesNotMatch(question.slice(0, question.indexOf("</li>")), /window\.confirm\(/, "the second press is in the panel, never a browser dialog");
  assert.match(panel, /confirmShared \? \{ \.\.\.blockBody, confirmShared: true \} : blockBody/, "confirmShared travels only on the second press");
  assert.match(panel, /response\.status === 409 && body\?\.error === "shared_address"/, "a 409 from the server asks the same question");
}

function stripCommentsTests() {
  assert.equal(stripComments('a // assertX(access\nb'), "a \nb");
  assert.equal(stripComments("a /* guard */ b"), "a  b");
  assert.equal(stripComments('const url = "https://x"; // c'), 'const url = "https://x"; ');
  assert.equal(stripComments("const s = `/* not a comment */`;"), "const s = `/* not a comment */`;");
  assert.equal(stripComments("<p>the person's page</p> // gone"), "<p>the person's page</p> ");
}

export async function runSystemAuditRoutesAccessTests() {
  stripCommentsTests();
  everyRouteIsGuarded();
  ownedRoutesKeepTheOrder();
  mutationsAreAudited();
  pageIsGuarded();
  await auditedReadsWriteTheirRow();
  await readAuditRowTests();
  await addressTests();
  await lensCountsSuccessfulSignInsTests();
  await blockRouteTests();
  blockedSignInTellsTheTruthTests();
  panelAsksTwiceForASharedNetworkTests();
  // Last, so every check above has already run when it names the missing declaration.
  await readAuditTypeIsDeclared();
}
