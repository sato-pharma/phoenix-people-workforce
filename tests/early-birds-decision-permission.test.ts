import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { POST as decisionPost } from "../app/api/approvals/early-bird/[id]/decision/route.ts";
import {
  createAccessContext,
  permissionMatrix,
  phoenixRoles,
  seedPermissionMatrixWithDefaultsForTests,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { decideEarlyBirdsCandidate, listPendingEarlyBirdsRecommendations } from "../src/lib/early-birds/decisions.ts";
import { invalidateEmployeeDirectoryCache } from "../src/lib/employees/employee-directory.ts";

// Enterprise audit F-CRM-016 (19 Nov 2026): the Early Birds decision was authorised by district
// scope alone, so a Medical Rep could decide the district he competes in and seven read-only
// company-wide seats could decide any district. The decision now needs `early_birds:approve`
// (Super Admin, District Manager, Regional Manager, National Sales Manager) AND the district inside
// the decider's scope, and nobody decides a recommendation that names them.
//
// Every refusal below is proven twice: the answer is a refusal, and nothing was written — no row,
// and no call to the decision function.

const SUPABASE = "https://early-birds-decision.invalid";
const STAND_IN_SETTINGS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE,
  NODE_ENV: "development",
  PHOENIX_ENABLE_DEV_AUTH_HEADERS: "true",
  SUPABASE_SERVICE_ROLE_KEY: "stand-in-service-role-key",
};

type Seen = { method: string; path: string; body: string };

// One line, one Regional Manager, two districts. R-1 and R-3 compete in DM-1's district.
const EMPLOYEES = [
  { hr_id: "NSM-1", full_name: "Nadia National", job_title: "National Sales Manager", manager_hr_id: null },
  { hr_id: "RM-1", full_name: "Rami Regional", job_title: "Regional Manager", manager_hr_id: "NSM-1" },
  { hr_id: "DM-1", full_name: "Dina District", job_title: "District Manager", manager_hr_id: "RM-1" },
  { hr_id: "DM-2", full_name: "Dalia District", job_title: "District Manager", manager_hr_id: "NSM-1" },
  { hr_id: "R-1", full_name: "Rana Rep", job_title: "Medical Representative", manager_hr_id: "DM-1" },
  { hr_id: "R-2", full_name: "Raed Rep", job_title: "Medical Representative", manager_hr_id: "DM-2" },
  { hr_id: "R-3", full_name: "Rasha Rep", job_title: "Medical Representative", manager_hr_id: "DM-1" },
  { hr_id: "SA-1", full_name: "Samir Admin", job_title: "HR Manager", manager_hr_id: null },
].map((row) => ({
  ...row,
  employment_status: "active",
  hire_date: "2025-01-01",
  line_id: 1,
  organogram_visible: true,
  payroll_eligible: true,
}));

// The open fortnight of DM-1's district. C-1 names R-1; C-SELF names the Super Admin (lower-cased,
// as a stored row may be), which only the never-your-own-name rule can refuse.
const CANDIDATES: Record<string, { id: string; employee_hr_id: string; snapshot_id: string }> = {
  "C-1": { employee_hr_id: "R-1", id: "C-1", snapshot_id: "S-1" },
  "C-SELF": { employee_hr_id: "sa-1", id: "C-SELF", snapshot_id: "S-1" },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

async function withStandIn(run: (seen: Seen[]) => Promise<void>): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.keys(STAND_IN_SETTINGS).map((name) => [name, env[name]] as const);
  const realFetch = globalThis.fetch;
  const seen: Seen[] = [];
  Object.assign(env, STAND_IN_SETTINGS);
  seedPermissionMatrixWithDefaultsForTests();
  invalidateEmployeeDirectoryCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    seen.push({ body: typeof init.body === "string" ? init.body : "", method, path: url.pathname });
    if (method === "GET" && url.pathname === "/rest/v1/employees") {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return json(200, offset > 0 ? [] : EMPLOYEES);
    }
    if (method === "GET" && url.pathname === "/rest/v1/early_birds_period_snapshots") {
      return json(200, [{ id: "S-1", manager_hr_id: "DM-1", period_key: "2026-11-a" }]);
    }
    if (method === "GET" && url.pathname === "/rest/v1/early_birds_candidates") {
      const wanted = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
      return json(200, CANDIDATES[wanted] ? [CANDIDATES[wanted]] : []);
    }
    if (method === "POST" && url.pathname === "/rest/v1/rpc/phx_decide_early_birds_candidate") {
      return json(200, { status: "approved", winner_id: "C-1" });
    }
    if (method === "GET" || method === "HEAD") return json(200, []);
    return json(201, []);
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = realFetch;
    invalidateEmployeeDirectoryCache();
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

const decisionCalls = (seen: Seen[]) => seen.filter((entry) => entry.path === "/rest/v1/rpc/phx_decide_early_birds_candidate");
const writes = (seen: Seen[]) => seen.filter((entry) => entry.method !== "GET" && entry.method !== "HEAD");

function routeCall(role: PhoenixRole | null): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: "localhost:3000",
    origin: "http://localhost:3000",
  };
  if (role) {
    headers["x-phoenix-role"] = role;
    headers["x-phoenix-hr-id"] = "PREVIEW-NOBODY";
  }
  return new Request("http://localhost:3000/api/approvals/early-bird/S-1/decision", {
    body: JSON.stringify({ candidateId: "C-1", decision: "approve" }),
    headers,
    method: "POST",
  });
}

const holders = (resource: string, action: string) =>
  phoenixRoles.filter((role) => (permissionMatrix[role] as Record<string, string[] | undefined>)[resource]?.includes(action) ?? false);

/** The seats that must never decide the board — all but Finance Manager read it. */
const NON_DECIDERS = [
  "Medical Rep",
  "CEO",
  "SFE Manager",
  "Marketing Manager",
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
  "HR Resourcing",
  "Finance Manager",
] as const satisfies readonly PhoenixRole[];

const approveC1 = { candidateId: "C-1", decision: "approve" as const, snapshotId: "S-1" };

export async function runEarlyBirdsDecisionPermissionTests() {
  // ── Who holds the key: the four deciding seats, nobody else ────────────────────────────────
  assert.deepEqual(
    [...holders("early_birds", "approve")].sort(),
    ["District Manager", "National Sales Manager", "Regional Manager", "Super Admin"],
    "early_birds:approve is held by the Super Admin and the district's manager chain only",
  );
  // Finance Manager never read the board; every other refused seat still does.
  for (const role of NON_DECIDERS.filter((seat) => seat !== "Finance Manager")) {
    assert.ok(
      (permissionMatrix[role] as Record<string, string[] | undefined>).early_birds?.includes("read") ?? false,
      `${role} still reads the Early Birds board — the fix narrows the decision, never the view`,
    );
  }

  // ── The route asserts the key itself, before the rate limit and before the service ─────────
  // The service refuses too, so a route that dropped its own check would still answer 403 below;
  // this pin is what catches that.
  const routeSource = readFileSync(
    fileURLToPath(new URL("../app/api/approvals/early-bird/[id]/decision/route.ts", import.meta.url)),
    "utf8",
  );
  const keyAt = routeSource.indexOf('assertPermission(access, "early_birds", "approve")');
  assert.ok(keyAt > 0, "HEADLINE: the decision route asserts early_birds:approve itself");
  assert.ok(keyAt < routeSource.indexOf("assertApiRateLimit("), "the key is checked before the rate limit");
  assert.ok(keyAt < routeSource.indexOf("decideEarlyBirdsCandidate("), "the key is checked before the decision service runs");

  // ── The route: a non-decider and a signed-out caller are refused, and nothing is written ───
  for (const role of [null, ...NON_DECIDERS] as const) {
    const who = role ?? "no session";
    await withStandIn(async (seen) => {
      const response = await decisionPost(routeCall(role), { params: Promise.resolve({ id: "S-1" }) });
      assert.ok(
        response.status === 401 || response.status === 403,
        `HEADLINE: decision route (${who}) must be refused (got ${response.status} ${await response.clone().text()})`,
      );
      assert.deepEqual(writes(seen), [], `decision route (${who}): a refused call writes nothing`);
      assert.deepEqual(decisionCalls(seen), [], `decision route (${who}): a refused call never reaches the decision function`);
    });
  }

  // ── The service: the same refusal holds without the route in front of it ────────────────────
  // The Medical Rep is R-3, deciding the recommendation of R-1 in the district they both compete
  // in; the company-wide seats see every district. Neither is the candidate, so only the key can
  // refuse them, and the message proves it was the key.
  for (const role of NON_DECIDERS) {
    await withStandIn(async (seen) => {
      const hrId = role === "Medical Rep" ? "R-3" : "X-9";
      const result = await decideEarlyBirdsCandidate(createAccessContext({ hrId, role }), approveC1);
      assert.equal(result.ok, false, `HEADLINE: ${role}: the service refuses`);
      assert.equal(!result.ok && result.error, "forbidden", `${role}: refused as forbidden`);
      assert.match(!result.ok ? result.message : "", /Your role cannot decide/, `${role}: refused by the approve key itself`);
      assert.deepEqual(writes(seen), [], `${role}: the service writes nothing`);
      assert.deepEqual(decisionCalls(seen), [], `${role}: never reaches the decision function`);
    });
  }

  // ── The deciders inside their own scope get through ────────────────────────────────────────
  for (const [hrId, role] of [
    ["DM-1", "District Manager"],
    ["RM-1", "Regional Manager"],
    ["NSM-1", "National Sales Manager"],
    ["SA-1", "Super Admin"],
  ] as const) {
    await withStandIn(async (seen) => {
      const result = await decideEarlyBirdsCandidate(createAccessContext({ hrId, role }), approveC1);
      assert.deepEqual(result, { ok: true, status: "approved", winnerId: "C-1" }, `${role} decides a district in their scope`);
      const calls = decisionCalls(seen);
      assert.equal(calls.length, 1, `${role}: exactly one decision is recorded`);
      const sent = JSON.parse(calls[0].body) as { p_actor_role: string; p_decided_by: string };
      assert.equal(sent.p_decided_by, hrId, `${role}: the decision names the person who made it`);
      assert.equal(sent.p_actor_role, role);
    });
  }

  // ── The district scope still holds for a key-holder ────────────────────────────────────────
  await withStandIn(async (seen) => {
    const result = await decideEarlyBirdsCandidate(createAccessContext({ hrId: "DM-2", role: "District Manager" }), approveC1);
    assert.equal(!result.ok && result.error, "forbidden", "a District Manager cannot decide another district");
    assert.match(!result.ok ? result.message : "", /not yours to decide/, "refused by the district scope");
    assert.deepEqual(decisionCalls(seen), [], "another district's manager never reaches the decision function");
  });

  // ── Nobody decides a recommendation that names them ────────────────────────────────────────
  await withStandIn(async (seen) => {
    const result = await decideEarlyBirdsCandidate(createAccessContext({ hrId: "SA-1", role: "Super Admin" }), {
      ...approveC1,
      candidateId: "C-SELF",
    });
    assert.equal(!result.ok && result.error, "forbidden", "HEADLINE: a decision on one's own name is refused");
    assert.match(!result.ok ? result.message : "", /names you/, "refused by the never-your-own-name rule");
    assert.deepEqual(decisionCalls(seen), [], "one's own name never reaches the decision function");
  });

  // ── The decision page lists nothing for a seat that cannot decide ──────────────────────────
  await withStandIn(async (seen) => {
    const pending = await listPendingEarlyBirdsRecommendations(createAccessContext({ hrId: "SA-1", role: "Marketing Manager" }));
    assert.deepEqual(pending, [], "a read-only seat has nothing waiting on it");
    assert.equal(
      seen.some((entry) => entry.path === "/rest/v1/early_birds_period_snapshots"),
      false,
      "a read-only seat's empty list is answered before any recommendation is read",
    );
  });
}
