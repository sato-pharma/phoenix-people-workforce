import assert from "node:assert/strict";

import { loadHeldBalances } from "../src/lib/automated-payroll/held-settlements.ts";
import { markRunPublished } from "../src/lib/automated-payroll/draft-store.ts";
import { TRANSITION_CLAIM_LOST } from "../src/lib/automated-payroll/transition-claim.ts";
import { recordDecision } from "../src/lib/deductions/service.ts";
import { clearModuleLockCache, NEVER_LOCKABLE_RESOURCES } from "../src/lib/auth/module-locks.ts";
import {
  assertPermission,
  canAccess,
  clearPermissionMatrixCache,
  createAccessContext,
  permissionMatrix,
  portalMinimumPermissions,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { SignedOutRefusal } from "../src/lib/auth/signed-out-refusal.ts";

// REC-078 (enterprise audit 2026-11-13): behaviour tests, not source pins, for three things a payroll or
// an access decision rests on. Each runs the REAL domain code against a stand-in PostgREST held in memory
// — no network, no environment file, nothing from production — and asserts what the code DOES:
//
//   1. The held-salary record (F-PAY-002). loadHeldBalances is the ledger every release offer reads, so
//      it may never answer "nobody is held" by accident: a published run with no `published` record, or
//      a ledger table that cannot be read, must refuse instead of returning []. markRunPublished must
//      hand the held list to the one database call that publishes, and say plainly when it did not land.
//   2. The deduction decision gates (F-PAY-003/004). Only the Super Admin decides; a candidate a
//      publication locked is refused before any write; and the database trigger's late refusal (the
//      lock landed between the read and the write) reaches the reviewer as a Conflict, never "saved".
//      The compare-and-set itself is pinned in tests/dispute-and-deduction-atomic.test.ts.
//   3. The permission lookups. A deny row in role_permission_overrides takes a compiled grant away; a
//      later failed reload keeps the last matrix that loaded (it neither restores the revoked grant nor
//      takes the others away); a module lock suspends a grant the role still holds; a signed-out caller
//      gets the signed-out refusal. The cold start is pinned in tests/permission-matrix-cold-start.test.ts.

type Row = Record<string, unknown>;
type Failure = { status: number; body: Record<string, unknown> };
type Seen = { method: string; table: string | null; rpc: string | null; params: URLSearchParams; body: unknown };
type RpcAnswer = { status: number; body: unknown };
type StandIn = {
  tables: Record<string, Row[]>;
  failReads?: Record<string, Failure>;
  failWrites?: Record<string, Failure>;
  rpc?: Record<string, (args: Record<string, unknown>) => RpcAnswer>;
};

const STAND_IN_ORIGIN = "http://127.0.0.1:54397";
const RESERVED_PARAMS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function matchesFilter(row: Row, key: string, raw: string): boolean {
  const value = row[key];
  if (raw.startsWith("eq.")) return String(value ?? "") === raw.slice(3);
  if (raw.startsWith("neq.")) return String(value ?? "") !== raw.slice(4);
  if (raw.startsWith("is.")) return raw.slice(3) === "null" ? value == null : String(value) === raw.slice(3);
  if (raw.startsWith("in.(") && raw.endsWith(")")) {
    return raw
      .slice(4, -1)
      .split(",")
      .map((item) => item.replace(/^"|"$/g, ""))
      .includes(String(value ?? ""));
  }
  throw new Error(`the stand-in does not understand the filter ${key}=${raw}`);
}

function filtered(rows: Row[], params: URLSearchParams): Row[] {
  let out = rows.filter((row) => {
    for (const [key, raw] of params) {
      if (RESERVED_PARAMS.has(key)) continue;
      if (!matchesFilter(row, key, raw)) return false;
    }
    return true;
  });
  const order = params.get("order");
  if (order) {
    const [column, direction] = order.split(".");
    out = [...out].sort((left, right) => {
      const a = String(left[column] ?? "");
      const b = String(right[column] ?? "");
      return direction === "desc" ? b.localeCompare(a) : a.localeCompare(b);
    });
  }
  return out;
}

/**
 * Runs `body` against the REAL admin client pointed at an in-memory PostgREST. Every request is recorded;
 * a request to any other host throws. The fetch, both settings and the permission and lock caches are put
 * back afterwards, so nothing later in the shard talks to the stand-in (a leaked stub hangs a later test).
 */
async function withStandIn(standIn: StandIn, body: (seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const env = process.env as Record<string, string | undefined>;
  const realFetch = globalThis.fetch;
  const realUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const realKey = env.SUPABASE_SERVICE_ROLE_KEY;
  env.NEXT_PUBLIC_SUPABASE_URL = STAND_IN_ORIGIN;
  env.SUPABASE_SERVICE_ROLE_KEY = "stand-in-key-never-sent";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    if (url.origin !== STAND_IN_ORIGIN) throw new Error(`the stand-in refuses to reach ${url.origin}`);
    const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers ?? undefined);
    const wantsObject = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
    const parsed: unknown = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : null;

    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = decodeURIComponent(url.pathname.slice("/rest/v1/rpc/".length));
      seen.push({ body: parsed, method, params: url.searchParams, rpc: name, table: null });
      const handler = standIn.rpc?.[name];
      if (!handler) return json({ code: "PGRST202", message: `stand-in has no function ${name}` }, 404);
      const answer = handler((parsed ?? {}) as Record<string, unknown>);
      return json(answer.body, answer.status);
    }
    if (!url.pathname.startsWith("/rest/v1/")) {
      seen.push({ body: parsed, method, params: url.searchParams, rpc: null, table: url.pathname });
      return json({}, 200);
    }

    const table = decodeURIComponent(url.pathname.slice("/rest/v1/".length));
    seen.push({ body: parsed, method, params: url.searchParams, rpc: null, table });
    const rows = (standIn.tables[table] ??= []);

    if (method === "GET" || method === "HEAD") {
      const failure = standIn.failReads?.[table];
      if (failure) return json(failure.body, failure.status);
      const matches = filtered(rows, url.searchParams);
      if (wantsObject) {
        if (matches.length !== 1) {
          return json(
            { code: "PGRST116", details: `The result contains ${matches.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" },
            406,
          );
        }
        return json(matches[0]);
      }
      return json(matches);
    }

    const failure = standIn.failWrites?.[table];
    if (failure) return json(failure.body, failure.status);
    let written: Row[] = [];
    if (method === "POST") {
      written = (Array.isArray(parsed) ? parsed : [parsed]) as Row[];
      rows.push(...written.map((row) => ({ ...row })));
    } else if (method === "PATCH") {
      for (const row of filtered(rows, url.searchParams)) {
        Object.assign(row, parsed as Row);
        written.push({ ...row });
      }
    } else if (method === "DELETE") {
      written = filtered(rows, url.searchParams);
      standIn.tables[table] = rows.filter((row) => !written.includes(row));
    }
    return json(wantsObject ? written[0] ?? null : written, method === "POST" ? 201 : 200);
  }) as typeof fetch;

  try {
    await body(seen);
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete env.NEXT_PUBLIC_SUPABASE_URL;
    else env.NEXT_PUBLIC_SUPABASE_URL = realUrl;
    if (realKey === undefined) delete env.SUPABASE_SERVICE_ROLE_KEY;
    else env.SUPABASE_SERVICE_ROLE_KEY = realKey;
    clearPermissionMatrixCache();
    clearModuleLockCache();
  }
}

const writesTo = (seen: Seen[], table: string) => seen.filter((request) => request.table === table && request.method !== "GET");
const auditWrites = (seen: Seen[]) =>
  seen.filter((request) => request.method !== "GET" && /audit/i.test(request.table ?? "") && !/automated_payroll/.test(request.table ?? ""));

// ─────────────────────────────────────────────────────────────────────────────── 1. held-salary record

const RETRIED_EARLIER = {
  action: "published",
  created_at: "2026-10-05T09:00:00+00:00",
  // The interrupted first attempt at the same publish. If its list were read, B-77 would owe 9,999 and
  // B-99, who was never held in the publish that stands, would appear.
  detail: {
    held: [
      { hrId: "B-77", name: "Held Person", secondPartWithheld: 9999 },
      { hrId: "B-99", name: "Never Held", secondPartWithheld: 100 },
    ],
  },
  run_id: "run-sep",
};
const PUBLISHED_STANDS = {
  action: "published",
  created_at: "2026-10-05T10:00:00+00:00",
  detail: {
    deferred: [{ amount: 1500, hrId: "B-88", name: "Deferred Person", releaseIn: "2026-12" }],
    held: [
      {
        firstPartAlreadyPaid: 4000,
        firstPartWithheld: 0,
        hrId: "B-77",
        name: "Held Person",
        reason: "Bank account not confirmed",
        secondPartWithheld: 6000,
      },
    ],
  },
  run_id: "run-sep",
};

function heldTables(): Record<string, Row[]> {
  return {
    // Oldest first ON PURPOSE: the newest `published` row must win by the read's own ordering, not by
    // the order the rows happen to sit in.
    automated_payroll_audit: [
      { action: "part2_confirmed", created_at: "2026-10-04T09:00:00+00:00", detail: {}, run_id: "run-sep" },
      structuredClone(RETRIED_EARLIER),
      structuredClone(PUBLISHED_STANDS),
    ],
    automated_payroll_held_entered: [],
    automated_payroll_held_part1_unpaid: [],
    automated_payroll_held_releases: [],
    automated_payroll_held_settlements: [],
    automated_payroll_runs: [{ id: "run-sep", month: 9, month_key: "2026-09", phase: "published", year: 2026 }],
  };
}

async function heldRecordReads(): Promise<void> {
  // (a) The ledger reads who is held, from the publish that stands.
  await withStandIn({ tables: heldTables() }, async () => {
    const balances = await loadHeldBalances();
    const byHrId = new Map(balances.map((balance) => [balance.hrId, balance]));
    assert.deepEqual([...byHrId.keys()].sort(), ["B-77", "B-88"], "the held and the deferred person, and nobody from the retried attempt");
    const held = byHrId.get("B-77")!;
    assert.equal(held.month, 9);
    assert.equal(held.year, 2026);
    assert.equal(held.secondPartWithheld, 6000, "the second instalment the run withheld");
    assert.equal(held.firstPartAlreadyPaid, 4000);
    assert.equal(held.reason, "Bank account not confirmed");
    assert.equal(held.outstanding, 6000, "nothing settled or released, so the whole withheld amount is owed");
    const deferred = byHrId.get("B-88")!;
    assert.equal(deferred.deferred, 1500);
    assert.equal(deferred.deferredTo, "2026-12");
    assert.equal(deferred.outstanding, 1500);
  });

  // (b) HEADLINE (F-PAY-002): a published run whose record of who was held is missing is REFUSED by
  // name — never answered with a list that silently leaves its people out.
  {
    const tables = heldTables();
    tables.automated_payroll_runs.push({ id: "run-oct", month: 10, month_key: "2026-10", phase: "published", year: 2026 });
    await withStandIn({ tables }, async () => {
      await assert.rejects(
        loadHeldBalances(),
        (error: Error) =>
          /^Conflict: Held salary cannot be shown: the payroll for October 2026 is published but its record of who was held is missing/.test(
            error.message,
          ),
        "HEADLINE: a published run with no `published` record refuses, naming the month, instead of returning a short list",
      );
    });
  }

  // …and a published run with no record is refused even when NO run has a record — the empty answer is
  // exactly the one that must not come back.
  {
    const tables = heldTables();
    tables.automated_payroll_audit = [];
    await withStandIn({ tables }, async () => {
      await assert.rejects(
        loadHeldBalances(),
        (error: Error) => /^Conflict: Held salary cannot be shown: the payroll for September 2026/.test(error.message),
        "no record at all for a published run is a refusal, never []",
      );
    });
  }

  // (c) A ledger table that cannot be read refuses — a failed read never becomes "nobody is held".
  for (const table of ["automated_payroll_audit", "automated_payroll_runs", "automated_payroll_held_releases", "automated_payroll_held_part1_unpaid"]) {
    await withStandIn(
      { failReads: { [table]: { body: { code: "XX000", details: null, hint: null, message: "stand-in read failure" }, status: 500 } }, tables: heldTables() },
      async () => {
        await assert.rejects(
          loadHeldBalances(),
          (error: { message?: string }) => error?.message === "stand-in read failure",
          `an unreadable ${table} refuses instead of answering with fewer held people`,
        );
      },
    );
  }

  // (d) The audit table missing from the environment is a refusal too: unlike the optional tables, the
  // ledger has no "not migrated yet" answer.
  await withStandIn(
    { failReads: { automated_payroll_audit: { body: { code: "PGRST205", details: null, hint: null, message: "Could not find the table 'public.automated_payroll_audit' in the schema cache" }, status: 404 } }, tables: heldTables() },
    async () => {
      await assert.rejects(loadHeldBalances(), (error: { code?: string }) => error?.code === "PGRST205", "a missing ledger table refuses");
    },
  );
}

async function markPublishedHandsOverTheHeldList(): Promise<void> {
  const detail = {
    held: [{ firstPartAlreadyPaid: 4000, hrId: "B-77", name: "Held Person", reason: "Bank account not confirmed", secondPartWithheld: 6000 }],
    heldCount: 1,
  };
  const input = { action: "published" as const, batchId: "batch-sep", detail, publishedBy: "B-10" };

  // The phase and the held record travel in ONE database call, with the held list exactly as given.
  await withStandIn(
    {
      rpc: {
        phx_mark_automated_payroll_run_published: () => ({
          body: [{ id: "run-sep", month: 9, month_key: "2026-09", phase: "published", published_batch_id: "batch-sep", published_by: "B-10", year: 2026 }],
          status: 200,
        }),
      },
      tables: {},
    },
    async (seen) => {
      const run = await markRunPublished("run-sep", input, { transitionToken: "token-1" });
      assert.equal(run.phase, "published");
      assert.equal(run.publishedBatchId, "batch-sep");
      const calls = seen.filter((request) => request.rpc === "phx_mark_automated_payroll_run_published");
      assert.equal(calls.length, 1, "one call publishes the run and records who was held");
      const args = calls[0].body as Record<string, unknown>;
      assert.equal(args.p_run_id, "run-sep");
      assert.equal(args.p_transition_token, "token-1", "under the publish's own claim on the run");
      assert.equal(args.p_batch_id, "batch-sep");
      assert.equal(args.p_published_by, "B-10");
      assert.deepEqual(args.p_detail, detail, "the held list reaches the database unchanged");
      assert.equal(
        seen.filter((request) => request.table === "automated_payroll_runs" && request.method !== "GET").length,
        0,
        "the phase is never written by a second, separate call that could land without the held record",
      );
    },
  );

  // A failed call says the run was NOT marked published and warns against reopening — never a bare failure.
  await withStandIn(
    {
      rpc: {
        phx_mark_automated_payroll_run_published: () => ({
          body: { code: "P0001", details: null, hint: null, message: "automated_payroll_mark_published_failed: held list missing" },
          status: 400,
        }),
      },
      tables: {},
    },
    async () => {
      await assert.rejects(
        markRunPublished("run-sep", input, { transitionToken: "token-1" }),
        (error: Error) =>
          error.message.startsWith("Conflict: the payslips for this run WERE written") &&
          error.message.includes("NOT marked published") &&
          error.message.includes("Do NOT reopen or cancel this run"),
        "a publish whose held record could not be written says so, as a Conflict",
      );
    },
  );

  // A lost claim (another action took the run) is its own Conflict, naming the claim.
  await withStandIn(
    {
      rpc: {
        phx_mark_automated_payroll_run_published: () => ({
          body: { code: "P0001", details: null, hint: null, message: "automated_payroll_transition_claim_lost" },
          status: 400,
        }),
      },
      tables: {},
    },
    async () => {
      await assert.rejects(
        markRunPublished("run-sep", input, { transitionToken: "token-1" }),
        (error: Error) => error.message.startsWith(`Conflict: ${TRANSITION_CLAIM_LOST}`),
        "a lapsed claim is reported as the claim, not as a database failure",
      );
    },
  );

  // No row back means no run: refused, never mapped into an empty run.
  await withStandIn(
    { rpc: { phx_mark_automated_payroll_run_published: () => ({ body: [], status: 200 }) }, tables: {} },
    async () => {
      await assert.rejects(
        markRunPublished("run-sep", input, { transitionToken: "token-1" }),
        (error: Error) => error.message === "Not found: payroll run does not exist.",
      );
    },
  );
}

export async function runHeldSalaryRecordBehaviourTests(): Promise<void> {
  await heldRecordReads();
  await markPublishedHandsOverTheHeldList();
}

// ─────────────────────────────────────────────────────────────────────────────── 2. deduction decisions

const SEEN_REVISION = "2026-11-13T09:00:00.654321+00:00";
const SUPER_ADMIN = { hrId: "B-10", loginId: "b-10", role: "Super Admin" } as const;

function decisionTables(lockedAt: string | null): Record<string, Row[]> {
  return {
    deductions_candidates: [
      {
        category: "dsm_no_record",
        dates: ["2026-10-05", "2026-10-06"],
        employee_hr_id: "B-77",
        employee_hr_id_compact: "b77",
        estimated_amount: 600,
        id: "cand-41",
        locked_at: lockedAt,
        month_key: "2026-10",
        raw_value: 2,
        unit: "days",
      },
    ],
    deductions_decisions: [
      {
        actor_role_at_decision: "Super Admin",
        applied_amount: null,
        applied_dates: null,
        applied_value: null,
        candidate_id: "cand-41",
        decided_at: null,
        decided_by: null,
        decision_reason: "",
        decision_status: "Pending",
        hr_note: "",
        id: "dec-41",
        updated_at: SEEN_REVISION,
      },
    ],
  };
}

const LATE_LOCK_REFUSAL: Failure = {
  body: { code: "55000", details: null, hint: null, message: "deduction candidate cand-41 is locked by a publication" },
  status: 400,
};

export async function runDeductionDecisionGateBehaviourTests(): Promise<void> {
  // (a) Only the Super Admin decides — refused before a single read, so nothing is even looked up.
  for (const role of ["HR Operations", "Finance Manager", "CEO"]) {
    await withStandIn({ tables: decisionTables(null) }, async (seen) => {
      await assert.rejects(
        recordDecision({ actor: { hrId: "B-20", loginId: "b-20", role } as never, candidateId: "cand-41", decisionReason: "", decisionStatus: "Approved for Payroll" }),
        (error: Error) => error.message === "Forbidden: only Super Admin can record or update a deduction decision.",
        `${role} cannot decide a deduction`,
      );
      assert.equal(seen.length, 0, `${role}'s refused decision reads nothing and writes nothing`);
    });
  }

  // (b) HEADLINE: a candidate a publication has locked is refused BEFORE any write.
  for (const expectedUpdatedAt of [undefined, SEEN_REVISION] as const) {
    const tables = decisionTables("2026-11-01T08:00:00+00:00");
    const before = structuredClone(tables);
    await withStandIn({ tables }, async (seen) => {
      await assert.rejects(
        recordDecision({ actor: SUPER_ADMIN, candidateId: "cand-41", decisionReason: "", decisionStatus: "Do Not Take Action", expectedUpdatedAt }),
        (error: Error) => error.message === "Conflict: this candidate is locked by a publication — it can no longer be decided directly.",
        "HEADLINE: a locked candidate cannot be decided directly",
      );
      assert.equal(writesTo(seen, "deductions_decisions").length, 0, "no decision write was even attempted");
      assert.equal(auditWrites(seen).length, 0, "and no audit row for a decision that did not happen");
    });
    assert.deepEqual(tables, before, "the locked decision is exactly as it was");
  }

  // (c) The lock landed between the read and the write: the trigger refuses it, and the reviewer reads a
  // Conflict — for the plain upsert (bridges, leave balance) and for the compare-and-set alike.
  for (const expectedUpdatedAt of [undefined, SEEN_REVISION] as const) {
    const tables = decisionTables(null);
    const before = structuredClone(tables);
    await withStandIn({ failWrites: { deductions_decisions: LATE_LOCK_REFUSAL }, tables }, async (seen) => {
      await assert.rejects(
        recordDecision({ actor: SUPER_ADMIN, candidateId: "cand-41", decisionReason: "", decisionStatus: "Do Not Take Action", expectedUpdatedAt }),
        (error: Error) =>
          error.message === "Conflict: this candidate was locked by a publication a moment ago — it can no longer be decided directly.",
        `the database's late lock refusal is a Conflict (${expectedUpdatedAt === undefined ? "upsert" : "compare-and-set"})`,
      );
      assert.equal(writesTo(seen, "deductions_decisions").length, 1, "exactly the one refused write");
      assert.equal(auditWrites(seen).length, 0, "no audit row claims a decision the database refused");
    });
    assert.deepEqual(tables, before, "nothing changed");
  }

  // (d) An open candidate still saves through the plain upsert, with the amount derived from the
  // candidate on record — so the refusals above are about the lock, not a decision path that never saves.
  {
    const tables = decisionTables(null);
    await withStandIn({ tables }, async (seen) => {
      const saved = await recordDecision({
        actor: SUPER_ADMIN,
        appliedDates: ["2026-10-05"],
        candidateId: "cand-41",
        decisionReason: "One day confirmed",
        decisionStatus: "Do Not Take Action",
      });
      assert.equal(saved.decisionStatus, "Do Not Take Action");
      const [write] = writesTo(seen, "deductions_decisions");
      assert.ok(write, "the decision was written");
      const body = (Array.isArray(write.body) ? write.body[0] : write.body) as Row;
      assert.deepEqual(body.applied_dates, ["2026-10-05"], "the day the reviewer chose");
      assert.equal(body.applied_value, 1);
      assert.equal(body.applied_amount, 300, "half of the 600 the candidate holds for two days, derived here — never taken from the request");
      assert.equal(body.decided_by, "B-10");
      assert.equal(body.actor_role_at_decision, "Super Admin");
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────── 3. permission lookups

type Grant = [PermissionResource, PermissionAction];

function grantsOf(role: PhoenixRole): Grant[] {
  const map = permissionMatrix[role] ?? {};
  return (Object.entries(map) as Array<[PermissionResource, PermissionAction[] | undefined]>).flatMap(([resource, actions]) =>
    (actions ?? []).map((action) => [resource, action] as Grant),
  );
}

const isFloor = (role: PhoenixRole, [resource, action]: Grant) =>
  portalMinimumPermissions.some((floor) => floor.resource === resource && floor.action === action && floor.roles.includes(role));

/** A signed-in role with two grants on two different modules, the first not a portal floor (a floor survives a deny row by design). */
function pickSubject(): { role: PhoenixRole; revoked: Grant; kept: Grant } {
  for (const role of Object.keys(permissionMatrix) as PhoenixRole[]) {
    if (role === "Super Admin") continue;
    const scope = createAccessContext({ hrId: "STAND-IN-1", loginId: "stand.in", role, source: "session" }).scope;
    if (scope === "system" || scope === "none") continue;
    const grants = grantsOf(role).filter(([resource]) => !NEVER_LOCKABLE_RESOURCES.includes(resource));
    const revoked = grants.find((grant) => !isFloor(role, grant));
    const kept = revoked && grants.find(([resource]) => resource !== revoked[0]);
    if (revoked && kept) return { kept, revoked, role };
  }
  throw new Error("no role has two lockable grants on two modules — the permission matrix changed shape");
}

export async function runPermissionLookupBehaviourTests(): Promise<void> {
  const { role, revoked, kept } = pickSubject();
  const person = createAccessContext({ hrId: "STAND-IN-1", loginId: "stand.in", role, source: "session" });
  const colleague = createAccessContext({ hrId: "STAND-IN-2", loginId: "stand.in.two", role, source: "session" });
  const denyRow = { action: revoked[1], is_allowed: false, resource: revoked[0], role_name: role };
  const realNow = Date.now;

  // (a) HEADLINE: a deny row in role_permission_overrides takes a compiled grant away, through the very
  // assertPermission every route calls; the role's other grants stand.
  const standIn: StandIn = { tables: { role_permission_overrides: [denyRow], user_module_locks: [] } };
  await withStandIn(standIn, async () => {
    clearPermissionMatrixCache();
    clearModuleLockCache();
    assert.equal(await canAccess(person, revoked[0], revoked[1]), false, `HEADLINE: the deny row takes ${revoked[1]} ${revoked[0]} from ${role}`);
    await assert.rejects(
      assertPermission(person, revoked[0], revoked[1]),
      (error: Error) => error.message === `Forbidden: ${role} cannot ${revoked[1]} ${revoked[0]}.`,
      "the route sees the standard refusal",
    );
    assert.equal(await canAccess(person, kept[0], kept[1]), true, `${role} keeps ${kept[1]} ${kept[0]}`);

    // (b) The override table then becomes unreadable and the cached matrix goes stale: the last matrix
    // that loaded is kept — the revoked grant does NOT come back from the compiled defaults, and the
    // role's other grants are NOT taken away.
    standIn.failReads = { role_permission_overrides: { body: { code: "XX000", message: "stand-in read failure" }, status: 500 } };
    Date.now = () => realNow() + 10 * 60 * 1000;
    try {
      assert.equal(await canAccess(person, revoked[0], revoked[1]), false, "a failed reload never restores a revoked grant");
      assert.equal(await canAccess(person, kept[0], kept[1]), true, "…and never takes the others away");
    } finally {
      Date.now = realNow;
    }
  });

  // (c) A module lock suspends a grant the role still holds — for that person only, and only while it runs.
  await withStandIn(
    {
      tables: {
        role_permission_overrides: [],
        user_module_locks: [
          {
            hr_id: "STAND-IN-1",
            id: "lock-1",
            locked_at: "2026-11-19T00:00:00+00:00",
            locked_by_login_id: "b-10",
            locked_by_name: "Owner",
            login_id: "stand.in",
            module_key: kept[0],
            note: null,
            released_at: null,
            released_by_name: null,
            unlock_at: null,
          },
        ],
      },
    },
    async () => {
      clearPermissionMatrixCache();
      clearModuleLockCache();
      assert.equal(await canAccess(person, kept[0], kept[1]), false, "a running lock suspends the grant");
      await assert.rejects(
        assertPermission(person, kept[0], kept[1]),
        (error: Error) => error.message === `Forbidden: ${kept[0]} is temporarily locked by the system administrator.`,
        "the locked person is told it is a lock, not that the role lacks it",
      );
      assert.equal(await canAccess(colleague, kept[0], kept[1]), true, "the same role on another account is untouched");
    },
  );
  await withStandIn(
    {
      tables: {
        role_permission_overrides: [],
        user_module_locks: [
          {
            hr_id: "STAND-IN-1",
            id: "lock-2",
            locked_at: "2026-11-01T00:00:00+00:00",
            locked_by_login_id: "b-10",
            locked_by_name: "Owner",
            login_id: "stand.in",
            module_key: kept[0],
            note: null,
            released_at: null,
            released_by_name: null,
            unlock_at: "2026-11-02T00:00:00+00:00",
          },
        ],
      },
    },
    async () => {
      clearPermissionMatrixCache();
      clearModuleLockCache();
      assert.equal(await canAccess(person, kept[0], kept[1]), true, "a lock past its unlock time no longer applies");
    },
  );

  // (d) A signed-out caller gets the signed-out refusal, still starting "Forbidden:" for the routes'
  // 403 handling — and no lookup is spent on it.
  await withStandIn({ tables: { role_permission_overrides: [], user_module_locks: [] } }, async (seen) => {
    const guest = createAccessContext({ source: "guest" });
    await assert.rejects(
      assertPermission(guest, kept[0], kept[1]),
      (error: Error) => error instanceof SignedOutRefusal && error.message.startsWith("Forbidden:"),
      "a signed-out caller is refused as signed out",
    );
    assert.equal(seen.length, 0, "a guest is refused without a database read");
  });
}

// ─────────────────────────────────────────────────────────────── 4. overrides that grant, and the cold start

/**
 * REC-078, phase 2 — the rest of the permission matrix, extending section 3 rather than repeating it.
 * Section 3 proves a deny row takes a grant away, a failed reload keeps the last matrix, a lock
 * suspends a grant and a guest is refused. This proves the other three ways an override row meets
 * the compiled matrix, all through the same assertPermission every route calls:
 *
 *   (a) an ALLOW row grants what the compiled matrix lacks — the Super Admin's edit takes effect;
 *   (b) no row can cross a hard boundary — an allow row for the admin console or the Field Absence
 *       list is ignored for a seat the boundary shuts out, and a deny row cannot strip a portal floor;
 *   (c) the fail-closed cold start (#327, REC-058) as a route meets it — a signed-in seat is refused
 *       with the plain refusal (never the signed-out one), the Super Admin still gets in, and the
 *       next readable load serves the defaults WITH the override rows, so nothing degraded was kept.
 */
export async function runPermissionOverrideBehaviourTests(): Promise<void> {
  const rep = createAccessContext({ hrId: "STAND-IN-3", loginId: "stand.in.rep", role: "Medical Rep", source: "session" });
  const manager = createAccessContext({ hrId: "STAND-IN-4", loginId: "stand.in.dm", role: "District Manager", source: "session" });
  const owner = createAccessContext({ hrId: "STAND-IN-0", loginId: "stand.in.owner", role: "Super Admin", source: "session" });
  assert.ok(!(permissionMatrix["Medical Rep"].vacancies ?? []).includes("read"), "precondition: the compiled matrix gives a Medical Rep no vacancies:read");
  const grantRow = { action: "read", is_allowed: true, resource: "vacancies", role_name: "Medical Rep" };

  // (a) An allow row grants it, through assertPermission.
  await withStandIn({ tables: { role_permission_overrides: [grantRow], user_module_locks: [] } }, async () => {
    clearPermissionMatrixCache();
    clearModuleLockCache();
    assert.equal(await canAccess(rep, "vacancies", "read"), true, "HEADLINE: an allow row grants what the compiled matrix lacks");
    await assertPermission(rep, "vacancies", "read");
    assert.equal(await canAccess(rep, "vacancies", "update"), false, "only the action the row names");
  });

  // (b) No row crosses a hard boundary, and a deny row cannot strip a portal floor.
  const floor = portalMinimumPermissions.find(
    (entry) => entry.roles.includes("Medical Rep") && (permissionMatrix["Medical Rep"][entry.resource] ?? []).includes(entry.action),
  );
  assert.ok(floor, "precondition: a Medical Rep holds at least one portal floor permission");
  await withStandIn(
    {
      tables: {
        role_permission_overrides: [
          { action: "read", is_allowed: true, resource: "admin", role_name: "Medical Rep" },
          { action: "read", is_allowed: true, resource: "field_absence", role_name: "District Manager" },
          { action: floor.action, is_allowed: false, resource: floor.resource, role_name: "Medical Rep" },
        ],
        user_module_locks: [],
      },
    },
    async () => {
      clearPermissionMatrixCache();
      clearModuleLockCache();
      assert.equal(await canAccess(rep, "admin", "read"), false, "HEADLINE: an allow row never opens the admin console to a Medical Rep");
      await assert.rejects(assertPermission(rep, "admin", "read"), (error: Error) => error.message === "Forbidden: Medical Rep cannot read admin.");
      assert.equal(await canAccess(manager, "field_absence", "read"), false, "nor the Field Absence list to a district manager");
      assert.equal(await canAccess(rep, floor.resource, floor.action), true, `a deny row cannot strip the ${floor.resource}:${floor.action} portal floor`);
    },
  );

  // (c) The cold start, as a route meets it, and the recovery with the override rows.
  const standIn: StandIn = {
    failReads: { role_permission_overrides: { body: { code: "XX000", message: "stand-in read failure" }, status: 500 } },
    tables: { role_permission_overrides: [grantRow], user_module_locks: [] },
  };
  await withStandIn(standIn, async () => {
    clearPermissionMatrixCache(); // a real cold start: no matrix ever loaded
    clearModuleLockCache();
    const [resource, action] = grantsOf("Medical Rep").find(([candidate]) => !NEVER_LOCKABLE_RESOURCES.includes(candidate))!;
    await assert.rejects(
      assertPermission(rep, resource, action),
      (error: Error) => !(error instanceof SignedOutRefusal) && error.message === `Forbidden: Medical Rep cannot ${action} ${resource}.`,
      "HEADLINE (#327): with the overrides unreadable on a cold start a signed-in seat is refused — the plain refusal, never the signed-out one",
    );
    await assertPermission(owner, "admin", "read");

    // The table reads again: the very next call serves the real matrix, override rows included.
    delete standIn.failReads;
    assert.equal(await canAccess(rep, resource, action), true, "the degraded matrix was never kept");
    assert.equal(await canAccess(rep, "vacancies", "read"), true, "and the recovered matrix carries the override rows, not just the defaults");
  });
}
