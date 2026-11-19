import assert from "node:assert/strict";

import { PATCH as controlPatch } from "../app/api/marketing-requests/control/route.ts";
import { POST as ceoApprovalsExportPost } from "../app/api/marketing-requests/ceo-approvals/export/route.ts";
import { POST as listCheckDecidePost } from "../app/api/marketing-requests/list-check/decide/route.ts";
import { clearPermissionMatrixCache, type PhoenixRole } from "../src/lib/auth/permissions.ts";

// REC-080, the marketing role list gap (19 Nov 2026). Three marketing writes admit a role list narrower than
// the marketing workspace: the controls and the Doctor-List Check answer are SFE Manager or Super Admin, and the
// CEO Approvals export is Marketing Manager, CEO or Super Admin. They used to read the body first, so a
// Financial Advisor (whom the workspace admits) sending an empty body was told "400: Control entity is invalid"
// instead of being refused. Each route now asks its role rule before the body. These calls go through the REAL
// route handlers with the dev-auth headers and a stand-in database, and prove the refusal comes first and
// nothing is written.

const SUPABASE = "https://marketing-role-gates.invalid";
const STAND_IN_SETTINGS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE,
  NODE_ENV: "development",
  PHOENIX_ENABLE_DEV_AUTH_HEADERS: "true",
  SUPABASE_SERVICE_ROLE_KEY: "stand-in-service-role-key",
};

type Seen = { method: string; path: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

async function withStandIn(run: (seen: Seen[]) => Promise<void>): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.keys(STAND_IN_SETTINGS).map((name) => [name, env[name]] as const);
  const realFetch = globalThis.fetch;
  const seen: Seen[] = [];
  Object.assign(env, STAND_IN_SETTINGS);
  clearPermissionMatrixCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    seen.push({ method, path: url.pathname });
    if (method === "GET" || method === "HEAD") return json(200, []);
    return json(201, []);
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = realFetch;
    clearPermissionMatrixCache();
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

function call(method: "PATCH" | "POST", path: string, role: PhoenixRole): Request {
  return new Request(`http://localhost:3000${path}`, {
    body: "{}",
    headers: {
      "content-type": "application/json",
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "x-phoenix-hr-id": "ROLE-GATES-NOBODY",
      "x-phoenix-role": role,
    },
    method,
  });
}

function writes(seen: Seen[]): Seen[] {
  return seen.filter((entry) => entry.method !== "GET" && entry.method !== "HEAD");
}

async function expectStatus(label: string, expected: number, invoke: () => Promise<Response>) {
  await withStandIn(async (seen) => {
    const response = await invoke();
    const text = await response.clone().text();
    assert.equal(response.status, expected, `${label}: expected ${expected}, got ${response.status} ${text}`);
    assert.deepEqual(writes(seen), [], `${label}: nothing may be written`);
  });
}

export async function runMarketingRoleGatesFirstTests() {
  // ── Refused before the body: roles the marketing workspace admits, but these three writes do not ─────────
  for (const role of ["Financial Advisor", "Finance Manager", "CEO", "Marketing Manager", "Product Manager"] as const) {
    await expectStatus(`controls PATCH (${role})`, 403, () =>
      controlPatch(call("PATCH", "/api/marketing-requests/control", role)));
    await expectStatus(`list-check decide POST (${role})`, 403, () =>
      listCheckDecidePost(call("POST", "/api/marketing-requests/list-check/decide", role)));
  }
  for (const role of ["Financial Advisor", "Finance Manager", "SFE Manager", "Product Manager"] as const) {
    await expectStatus(`CEO Approvals export POST (${role})`, 403, () =>
      ceoApprovalsExportPost(call("POST", "/api/marketing-requests/ceo-approvals/export", role)));
  }

  // ── The roles the rule admits still reach the body, which still judges it ───────────────────────────────
  for (const role of ["SFE Manager", "Super Admin"] as const) {
    await expectStatus(`controls PATCH (${role}, empty body)`, 400, () =>
      controlPatch(call("PATCH", "/api/marketing-requests/control", role)));
    await expectStatus(`list-check decide POST (${role}, empty body)`, 400, () =>
      listCheckDecidePost(call("POST", "/api/marketing-requests/list-check/decide", role)));
  }
}
