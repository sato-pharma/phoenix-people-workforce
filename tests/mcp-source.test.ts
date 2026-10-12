import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";

import { POST as authorizePost } from "../app/api/mcp-source/authorize/route.ts";
import { decideLiveIdentity, type LiveInputs } from "../src/lib/mcp-source/live-authorization.ts";
import { parseContentRange, runWithReadRecorder, type RecordedRead } from "../src/lib/mcp-source/read-recorder.ts";
import { SPECS } from "../src/lib/mcp-source/source-registry.ts";
import {
  SourceProofError,
  contentSnapshotId,
  sealFreshness,
  summarizeReads,
  verifySourceProof,
  type SourceSpec,
  type Watermark,
} from "../src/lib/mcp-source/source-proof.ts";

// The owner-only MCP source host: a proof that a report was read COMPLETELY and CONSISTENTLY, and a
// live authorization bridge that fails closed. Nothing here touches a real database: the recorder is
// exercised against a local HTTP server that answers like PostgREST.

const read = (over: Partial<RecordedRead> = {}): RecordedRead => ({
  key: "GET /rest/v1/employees",
  method: "GET",
  relation: "employees",
  kind: "table",
  status: 200,
  ok: true,
  limited: false,
  rangeStart: 0,
  rangeEnd: 9,
  total: null,
  ...over,
});

const spec: SourceSpec = {
  dataset: "employees",
  watched: ["employees", "teams"],
  coverage: { employees: ["employees"], teams: ["teams"] },
  required: ["employees"],
};
const mark = (stamp = "2026-10-11T09:00:00.000Z", rows = 5, digest = "d1"): Watermark => ({
  employees: { rows, stamp, digest },
  teams: { rows: 1, stamp, digest: "t1" },
});
const proofInput = (over: Record<string, unknown> = {}) => ({
  spec,
  period: "",
  startedAt: "2026-10-11T09:00:10.000Z",
  finishedAt: "2026-10-11T09:00:12.000Z",
  reads: [read(), read({ key: "GET /rest/v1/teams", relation: "teams" })],
  before: mark(),
  after: mark(),
  ...over,
});
const refusal = (input: ReturnType<typeof proofInput>) => {
  try {
    verifySourceProof(input as Parameters<typeof verifySourceProof>[0]);
  } catch (error) {
    assert.ok(error instanceof SourceProofError, "refusals are typed");
    return error.reason;
  }
  return "accepted";
};

// Other suites in the same process swap globalThis.fetch for stubs, so this suite takes the native
// one captured at import time (before any test runs) and installs the recorder over it afresh.
const nativeFetch = globalThis.fetch;
const recorderFlag = Symbol.for("phoenix.mcpSource.fetchRecorder");

export async function runMcpSourceTests() {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  const priorFetch = globalThis.fetch;
  const priorFlag = holder[recorderFlag];
  globalThis.fetch = nativeFetch;
  delete holder[recorderFlag];
  try {
    await runSuite();
  } finally {
    globalThis.fetch = priorFetch;
    if (priorFlag === undefined) delete holder[recorderFlag];
    else holder[recorderFlag] = priorFlag;
  }
}

async function runSuite() {
  // --- Content-Range ------------------------------------------------------------------------
  assert.deepEqual(parseContentRange("0-999/*"), { rangeStart: 0, rangeEnd: 999, total: null });
  assert.deepEqual(parseContentRange("0-9/10"), { rangeStart: 0, rangeEnd: 9, total: 10 });
  assert.deepEqual(parseContentRange("*/0"), { rangeStart: null, rangeEnd: null, total: 0 });
  assert.deepEqual(parseContentRange("garbage"), { rangeStart: null, rangeEnd: null, total: null });

  // --- the recorder sees swallowed failures, and only inside its scope -----------------------
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/rest/v1/boom")) return void req.socket.destroy();
    if (req.url?.startsWith("/rest/v1/down")) return void res.writeHead(500).end("{}");
    res.writeHead(200, { "content-range": "0-1/*", "content-type": "application/json" }).end("[1,2]");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const run = await runWithReadRecorder(async () => {
      await fetch(`${base}/rest/v1/employees?select=*&limit=2`);
      await fetch(`${base}/rest/v1/rpc/phx_closing_customers`, { method: "POST", body: "{}" });
      await fetch(`${base}/rest/v1/down`).catch(() => undefined);
      await fetch(`${base}/rest/v1/boom`).catch(() => undefined); // swallowed, as a loader would
      await fetch(`${base}/health`); // not a PostgREST read: ignored
      return "report returned normally";
    });
    assert.ok(run.ok, "the loader itself returned");
    const byRelation = Object.fromEntries(run.reads.map((r) => [r.relation, r]));
    assert.equal(run.reads.length, 4, "only PostgREST requests are recorded");
    assert.equal(byRelation.employees.limited, true);
    assert.equal(byRelation.employees.rangeEnd, 1);
    assert.equal(byRelation.phx_closing_customers.kind, "rpc");
    assert.equal(byRelation.down.status, 500);
    assert.equal(byRelation.boom.status, null, "a transport failure is recorded, not lost");
    assert.deepEqual(summarizeReads(run.reads).failed, ["boom", "down"], "a returned report does not hide a failed read");

    const outside = await runWithReadRecorder(async () => undefined);
    await fetch(`${base}/rest/v1/employees`);
    assert.equal(outside.reads.length, 0, "a request outside any scope is never recorded");

    const failed = await runWithReadRecorder(async () => {
      await fetch(`${base}/rest/v1/employees`);
      throw new Error("loader failed");
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reads.length, 1, "the read log survives a loader failure");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  // --- read summary: retries, truncation -----------------------------------------------------
  assert.deepEqual(
    summarizeReads([read({ status: 502, ok: false }), read()]).failed,
    [],
    "a request that failed and was then retried successfully is not a failure",
  );
  assert.deepEqual(summarizeReads([read(), read({ status: 502, ok: false })]).failed, ["employees"], "the LAST attempt decides");
  assert.deepEqual(summarizeReads([read({ rangeEnd: 999 })]).truncated, ["employees"], "an unpaged read at the row cap may have been cut");
  assert.deepEqual(summarizeReads([read({ rangeEnd: 999, limited: true })]).truncated, [], "an explicit limit is the loader's own paging");
  assert.deepEqual(summarizeReads([read({ rangeEnd: 9, total: 25 })]).truncated, ["employees"], "short of a known total");
  assert.deepEqual(summarizeReads([read({ rangeEnd: 24, total: 25 })]).truncated, []);

  // --- the proof: every refusal, then the acceptance ----------------------------------------
  assert.equal(refusal(proofInput({ reads: [] })), "no_reads", "no read at all means a cache answered");
  assert.equal(refusal(proofInput({ reads: [read({ status: 500, ok: false }), read({ key: "GET /rest/v1/teams", relation: "teams" })] })), "read_failed");
  assert.equal(refusal(proofInput({ reads: [read({ rangeEnd: 999 })] })), "truncated");
  assert.equal(refusal(proofInput({ reads: [read(), read({ key: "GET /rest/v1/secrets", relation: "secrets" })] })), "unwatched_read");
  assert.equal(refusal(proofInput({ reads: [read({ key: "GET /rest/v1/teams", relation: "teams" })] })), "required_read_missing");
  assert.equal(refusal(proofInput({ before: { teams: mark().teams } })), "watermark_missing");
  assert.equal(refusal(proofInput({ after: mark("2026-10-11T09:00:10.000Z", 6) })), "changed_during_read", "a row appeared");
  assert.equal(refusal(proofInput({ after: mark(undefined, 5, "d2") })), "changed_during_read", "same count and stamp, different content");
  assert.equal(refusal(proofInput({ finishedAt: "2026-10-11T09:00:05.000Z" })), "invalid_time");
  assert.equal(refusal(proofInput({ before: mark("2027-01-01T00:00:00.000Z"), after: mark("2027-01-01T00:00:00.000Z") })), "invalid_time", "a stamp from the future");
  const noStamp: Watermark = { employees: { rows: 5, stamp: null, digest: "d" }, teams: { rows: 1, stamp: null, digest: "t" } };
  assert.equal(refusal(proofInput({ before: noStamp, after: noStamp })), "no_change_stamp");
  assert.equal(refusal(proofInput()), "accepted");

  const proof = verifySourceProof(proofInput() as Parameters<typeof verifySourceProof>[0]);
  assert.equal(proof.observedAt, "2026-10-11T09:00:12.000Z");
  assert.equal(proof.updatedAt, "2026-10-11T09:00:00.000Z", "update time is the business change stamp, not the read time");
  assert.throws(() => sealFreshness({ ...proof } as typeof proof, []), SourceProofError, "a copied or hand-built proof is not a proof");

  // --- snapshot identity ---------------------------------------------------------------------
  const rows = [{ key: "a", n: 1 }, { key: "b", n: 2 }];
  const id = contentSnapshotId("organization", "", rows);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a valid UUID");
  assert.equal(contentSnapshotId("organization", "", [...rows].reverse()), id, "row order is irrelevant");
  assert.equal(contentSnapshotId("organization", "", [{ n: 1, key: "a" }, { key: "b", n: 2 }]), id, "key order is irrelevant");
  assert.notEqual(contentSnapshotId("organization", "", [{ key: "a", n: 1 }, { key: "b", n: 3 }]), id, "any changed value changes the identity");
  assert.notEqual(contentSnapshotId("vacancies", "", rows), id);
  assert.notEqual(contentSnapshotId("published_sales", "2026-09", rows), contentSnapshotId("published_sales", "2026-08", rows));

  // --- registry <-> watermark SQL stay in step ------------------------------------------------
  const sql = readFileSync(new URL("../infra/phoenix-mcp/proposal/source-watermark.sql", import.meta.url), "utf8");
  const declared = new Set([...sql.matchAll(/^\s*\('([a-z_]+)','/gm)].map((m) => m[1]));
  for (const [dataset, definition] of Object.entries(SPECS)) {
    for (const name of definition.watched) assert.ok(declared.has(name), `${dataset}: watched source ${name} has no entry in source-watermark.sql`);
    for (const [read, guards] of Object.entries(definition.coverage)) {
      assert.ok(guards.length > 0, `${dataset}: ${read} is covered by nothing`);
      for (const guard of guards) assert.ok(definition.watched.includes(guard), `${dataset}: ${read} names a guard (${guard}) that is not watched`);
    }
  }

  // --- live authorization decision ------------------------------------------------------------
  const live: LiveInputs = {
    subject: "11111111-1111-4111-8111-111111111111",
    accounts: [{ login_id: "owner", role: "Super Admin", hr_id: "B-10", is_active: true, is_test_persona: false, session_version: 3 }],
    authUser: { exists: true, bannedUntil: null, deletedAt: null },
    employee: { employment_status: "active", last_working_date: null },
    matrix: { "Super Admin": { employees: ["read"], vacancies: ["read"], organogram: ["read"], sales: [] } },
    locks: [],
    now: new Date("2026-10-11T09:00:00Z"),
  };
  const ok = decideLiveIdentity(live);
  assert.ok(ok && ok.active && ok.sessionVersion === 3);
  assert.deepEqual(ok?.permissions.find((p) => p.resource === "sales"), { resource: "sales", allowed: false }, "an effective read denial is reported, not dropped");
  assert.equal(decideLiveIdentity({ ...live, accounts: [] }), null);
  assert.equal(decideLiveIdentity({ ...live, authUser: { exists: true, bannedUntil: "2099-01-01T00:00:00Z", deletedAt: null } }), null);
  assert.equal(decideLiveIdentity({ ...live, authUser: { exists: true, bannedUntil: "2000-01-01T00:00:00Z", deletedAt: null } })?.active, true, "a lapsed ban is not a ban");
  assert.equal(decideLiveIdentity({ ...live, accounts: [{ ...live.accounts[0], role: "Employee" }] }), null);
  assert.equal(decideLiveIdentity({ ...live, employee: { employment_status: "resigned", last_working_date: "2026-01-01" } })?.active, false);
  assert.deepEqual(decideLiveIdentity({ ...live, locks: [{ login_id: "OWNER", hr_id: null, module_key: "sales", unlock_at: null }] })?.locks, ["sales"]);
  assert.throws(() => decideLiveIdentity({ ...live, employee: null }), "an HR-linked account with no employee row cannot be decided");
  assert.throws(() => decideLiveIdentity({ ...live, matrix: {} }), "a role missing from the matrix cannot be decided");

  // --- the route: off by default, bearer-only, single owner, and 503 on any source failure ----
  const subject = live.subject;
  const nonce = "22222222-2222-4222-8222-222222222222";
  const saved = { ...process.env };
  const post = (body: unknown, token?: string) =>
    authorizePost(new Request("https://phoenix.test/api/mcp-source/authorize", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" } : { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));
  const secret = "s".repeat(40);
  try {
    delete process.env.PHOENIX_MCP_SOURCE_ENABLED;
    assert.equal((await post({ subject, nonce }, secret)).status, 404, "disabled unless explicitly enabled");
    process.env.PHOENIX_MCP_SOURCE_ENABLED = "true";
    delete process.env.PHOENIX_MCP_SOURCE_AUTHORIZATION_KEY;
    process.env.PHOENIX_MCP_OWNER_SUBJECT = subject;
    assert.equal((await post({ subject, nonce })).status, 503, "an unset secret refuses everyone — there is no development bypass");
    process.env.PHOENIX_MCP_SOURCE_AUTHORIZATION_KEY = secret;
    assert.equal((await post({ subject, nonce })).status, 401);
    assert.equal((await post({ subject, nonce }, "w".repeat(40))).status, 401);
    assert.equal((await post("{not json", secret)).status, 400);
    assert.equal((await post({ subject: "nope", nonce }, secret)).status, 400);
    assert.equal((await post({ subject: "33333333-3333-4333-8333-333333333333", nonce }, secret)).status, 403, "only the configured owner");
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const unreadable = await post({ subject, nonce }, secret);
    assert.equal(unreadable.status, 503, "a source that cannot be read fails closed");
    assert.match(unreadable.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(unreadable.headers.get("content-type")?.includes("json"), true);
    assert.deepEqual(await unreadable.json(), { error: "unavailable" }, "no detail leaks");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}
