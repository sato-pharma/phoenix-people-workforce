import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { directOrderCollectionDbError } from "../src/lib/direct-orders/collection-rules.ts";
import { recordDirectOrderCollection } from "../src/lib/direct-orders/service.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Two writes that raced their own siblings (enterprise audit, November 2026).
 *
 * F-MKT-005 — recording a direct-order collection read the order with no lock, read the offset total
 * in a second query, derived remaining_amount in TypeScript and wrote it back with a plain update.
 * The marketing-offset functions lock the same order row and rewrite remaining_amount too, so the two
 * writers could overwrite each other, and a second Finance save silently won over the first. Now
 * phx_record_direct_order_collection takes the order lock, compare-and-sets the paid amount and date
 * the caller read, sums the offsets under the lock and writes everything in one UPDATE.
 *
 * F-MKT-006 — phx_decide_marketing_request_step compare-and-set only the STEP; its writes to
 * marketing_requests carried no status condition, and cancel left the request's `current` rung open.
 * A decision could write a cancelled request back to approved. Now the decision locks the request
 * and refuses unless it is still pending_approval, and cancel closes the open rungs in the same
 * transaction that flips the status.
 */

const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);
const COLLECTION_MIGRATION = "20261113161617_direct_order_collection_atomic.sql";
const DECIDE_MIGRATION = "20261113161619_marketing_decide_requires_pending_request.sql";
const PREVIOUS_DECIDE_MIGRATION = "20260829180000_marketing_finance_requirement_on_approval.sql";

const readMigration = (name: string) => readFileSync(new URL(name, MIGRATIONS), "utf8");
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The text of one exported function, from its signature to the first `}` in column 0. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `could not find the end of ${signature}`);
  return source.slice(start, end);
}

/** One `create or replace function public.<name>(` … `$function$;` block, comments stripped. */
function sqlFunction(sql: string, name: string): string {
  const match = new RegExp(`create or replace function public\\.${name}\\(`, "i").exec(sql);
  assert.ok(match, `${name} must be defined`);
  const end = sql.indexOf("$function$;", match.index);
  assert.ok(end > match.index, `could not find the end of ${name}`);
  return sql.slice(match.index, end);
}

type Captured = { method: string; path: string; body: unknown };

/**
 * Runs `body` against the REAL admin client with a stand-in project URL and key and a global fetch
 * that answers from `respond`. Every request is recorded. Both are restored afterwards; the client
 * memo is keyed on URL and key, so nothing downstream keeps talking to the stand-in.
 */
async function withFakeSupabase(
  respond: (request: Captured) => { status: number; json: unknown },
  body: () => Promise<void>,
): Promise<Captured[]> {
  const requests: Captured[] = [];
  const realFetch = globalThis.fetch;
  const realUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const realKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54398";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in-key-never-sent";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const parsed: unknown = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : null;
    const captured = { method, path: url.pathname, body: parsed };
    requests.push(captured);
    const { status, json } = respond(captured);
    return new Response(json === undefined ? null : JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = realUrl;
    if (realKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = realKey;
  }
  return requests;
}

const FINANCE = {
  hrId: "B-10",
  loginId: "B-10",
  role: "Super Admin",
  scope: "system",
  source: "session",
} as unknown as AccessContext;

const ORDER_ID = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const ORDER_ROW = {
  id: ORDER_ID,
  request_code: "DO-TEST-1",
  requester_hr_id: "PD-0001",
  requester_role: "Medical Rep",
  status: "approved",
  line: "Pedia",
  product_code: "P1",
  product_name: "Product One",
  qty: 10,
  bonus: 0,
  sales_value: 1000,
  pharmacy_id: "11111111-2222-4333-8444-555555555555",
  sales_month: "2026-10",
  paid_amount: 200,
  payment_date: "2026-11-01",
  remaining_amount: 800,
  created_at: "2026-10-01T08:00:00Z",
  updated_at: "2026-11-01T08:00:00Z",
};

const RPC_PATH = "/rest/v1/rpc/phx_record_direct_order_collection";

export async function runDirectOrdersAndMarketingAtomicTests() {
  // ── 1. The collection function: locked, compare-and-set, offsets under the lock ────────────────
  const collectionSql = stripSqlComments(readMigration(COLLECTION_MIGRATION));
  const collectionFn = sqlFunction(collectionSql, "phx_record_direct_order_collection");
  const lockAt = collectionFn.search(/from public\.direct_order_requests where id = p_order_id for update/);
  assert.ok(lockAt > 0, "THE HEADLINE: the order row is locked FOR UPDATE before anything is read or written");
  const casAt = collectionFn.indexOf("v_order.paid_amount is distinct from p_expected_paid_amount");
  assert.ok(casAt > lockAt, "compare-and-set on the paid amount the caller read, after the lock");
  assert.ok(
    collectionFn.includes("v_order.payment_date is distinct from p_expected_payment_date"),
    "compare-and-set on the payment date the caller read",
  );
  assert.ok(
    collectionFn.includes("raise exception 'direct_order_collection_conflict"),
    "a stale caller loses with its own exception code, which the service maps to a 409",
  );
  const offsetsAt = collectionFn.indexOf("from public.direct_order_marketing_offsets");
  assert.ok(offsetsAt > lockAt, "the offsets are summed UNDER the lock, so an offset recorded a moment ago is counted");
  // The same rules collection-rules.ts and offset-rules.ts apply — not a second opinion.
  for (const rule of [
    "if coalesce(v_order.status, '') <> 'approved' then",
    "if p_paid_amount <= 0 then",
    "v_value := round(coalesce(v_order.sales_value, 0)::numeric, 2);",
    "if v_value <= 0 then",
    "v_paid := round(p_paid_amount, 2);",
    "if v_paid > v_value then",
    "if v_offsets > 0 and round(v_paid + v_offsets, 2) > v_value then",
    "v_remaining := round(v_value - v_paid - v_offsets, 2);",
    "if v_offsets <= 0 then v_remaining := null;",
    "v_remaining := greatest(0, round(v_value - v_offsets, 2));",
  ]) {
    assert.ok(squash(collectionFn).includes(rule), `the function must apply the TypeScript rule: ${rule}`);
  }
  assert.ok(
    squash(collectionFn).includes(
      "set paid_amount = v_paid, payment_date = p_payment_date, remaining_amount = v_remaining, updated_at = now() where id = p_order_id",
    ),
    "the amount, the date and the remainder are written together in ONE update",
  );
  assert.ok(
    squash(collectionFn).includes("set paid_amount = null, payment_date = null, remaining_amount = v_remaining"),
    "clearing resets the amount and the date together — a date left behind reads as proof money arrived",
  );
  assert.ok(!/sales_month/.test(collectionFn), "a collection is not a sales event: the function never touches sales_month");
  const collectionSig = "phx_record_direct_order_collection(uuid, numeric, date, numeric, date)";
  assert.ok(
    collectionSql.includes(`revoke execute on function public.${collectionSig} from public, anon, authenticated;`),
    "closed to the browser roles",
  );
  assert.ok(collectionSql.includes(`grant execute on function public.${collectionSig} to service_role;`), "open to the service role");
  assert.match(collectionFn, /security definer/i);
  assert.match(collectionFn, /set search_path = public/i);

  // ── 2. The service calls it, and no longer writes the order itself ─────────────────────────────
  const service = stripComments(read("../src/lib/direct-orders/service.ts"));
  const recordBody = functionBody(service, "export async function recordDirectOrderCollection(");
  assert.ok(
    recordBody.includes('supabase.rpc("phx_record_direct_order_collection"'),
    "THE HEADLINE: recordDirectOrderCollection writes through the locked function",
  );
  assert.ok(
    !squash(recordBody).replace(/\s/g, "").includes('.from("direct_order_requests").update('),
    "and never with its own unlocked update of the order",
  );
  assert.ok(!recordBody.includes(".update("), "no direct update of any table inside recordDirectOrderCollection");
  assert.ok(recordBody.includes("p_expected_paid_amount: before.paidAmount"), "the before-values it read are the expected values");
  assert.ok(recordBody.includes("p_expected_payment_date: before.paymentDate"), "both of them");
  assert.ok(
    recordBody.indexOf("deriveDirectOrderCollection(") < recordBody.indexOf('supabase.rpc("phx_record_direct_order_collection"'),
    "the TypeScript rules (the Cairo future-date check included) still run first",
  );
  assert.ok(recordBody.includes("directOrderCollectionDbError(rpcError)"), "the function's refusals are turned into words");

  // ── 3. The words ───────────────────────────────────────────────────────────────────────────────
  const conflict = directOrderCollectionDbError({ message: "direct_order_collection_conflict: the collection on order x changed" });
  assert.equal(conflict?.kind, "conflict", "a compare-and-set loss is a conflict, never a validation error");
  assert.equal(
    conflict?.message,
    "Conflict: this order's collection was changed by someone else a moment ago; refresh and try again.",
  );
  assert.equal(directOrderCollectionDbError(new Error("direct_order_collection_not_approved"))?.kind, "validation");
  assert.equal(
    directOrderCollectionDbError(new Error("direct_order_collection_exceeds_net_value"))?.code,
    "direct_order_collection_exceeds_net_value",
    "the net-of-offsets refusal is not mistaken for the plain over-value one",
  );
  assert.equal(directOrderCollectionDbError(new Error("direct_order_collection_exceeds_value"))?.code, "direct_order_collection_exceeds_value");
  assert.equal(directOrderCollectionDbError({ message: "connection reset" }), null, "an error that is not ours is left alone");

  // ── 4. Through the real client: a lost compare-and-set writes nothing else ─────────────────────
  let thrown: unknown = null;
  const lost = await withFakeSupabase(
    (request) => {
      if (request.path === RPC_PATH) {
        return {
          status: 400,
          json: {
            code: "P0001",
            details: null,
            hint: null,
            message: `direct_order_collection_conflict: the collection on order ${ORDER_ID} changed since it was read`,
          },
        };
      }
      if (request.method === "GET" && request.path.endsWith("/direct_order_requests")) return { status: 200, json: [ORDER_ROW] };
      if (request.method === "GET") return { status: 200, json: [] };
      return { status: 201, json: undefined };
    },
    async () => {
      try {
        await recordDirectOrderCollection(FINANCE, { requestId: ORDER_ID, paidAmount: 500, paymentDate: "2026-11-02" });
      } catch (error) {
        thrown = error;
      }
    },
  );
  assert.ok(thrown, "a lost compare-and-set must throw, never report success");
  assert.equal((thrown as { status?: number }).status, 409, "and it is a 409 conflict");
  assert.ok(String((thrown as Error).message).startsWith("Conflict: this order's collection was changed"), "in words");
  assert.equal(lost.filter((r) => r.path === RPC_PATH).length, 1, "the locked function was asked exactly once");
  assert.deepEqual(
    lost.filter((r) => r.method !== "GET" && r.path !== RPC_PATH),
    [],
    "NO audit row, NO direct_order_events row and no other write follows a lost compare-and-set",
  );
  const lostRpc = lost.find((r) => r.path === RPC_PATH)?.body as Record<string, unknown>;
  assert.deepEqual(
    lostRpc,
    {
      p_expected_paid_amount: 200,
      p_expected_payment_date: "2026-11-01",
      p_order_id: ORDER_ID,
      p_paid_amount: 500,
      p_payment_date: "2026-11-02",
    },
    "the function is asked for the new figures, compared against the ones that were read",
  );

  // ── 5. And a win records what the FUNCTION wrote, not what TypeScript guessed ──────────────────
  // TypeScript read no offsets; by the time the lock was taken, a 100 EGP settlement had landed.
  // The remainder the function computed under the lock (400) is the one recorded everywhere.
  const won = await withFakeSupabase(
    (request) => {
      if (request.path === RPC_PATH) {
        return {
          status: 200,
          json: {
            paidAmount: 500,
            paymentDate: "2026-11-02",
            previousPaidAmount: 200,
            previousPaymentDate: "2026-11-01",
            previousRemainingAmount: 800,
            remainingAmount: 400,
          },
        };
      }
      if (request.method === "GET" && request.path.endsWith("/direct_order_requests")) {
        return { status: 200, json: [ORDER_ROW] };
      }
      if (request.method === "GET") return { status: 200, json: [] };
      return { status: 201, json: undefined };
    },
    async () => {
      const after = await recordDirectOrderCollection(FINANCE, { requestId: ORDER_ID, paidAmount: 500, paymentDate: "2026-11-02" });
      assert.equal(after.paidAmount, 500);
      assert.equal(after.remainingAmount, 400, "the caller gets the remainder written under the lock");
      assert.equal(after.salesMonth, "2026-10", "and the sales month is untouched");
    },
  );
  const event = won.find((r) => r.method === "POST" && r.path.endsWith("/direct_order_events"))?.body as
    | Record<string, unknown>
    | undefined;
  assert.ok(event, "a won write still records its direct_order_events row");
  assert.equal(event?.event_type, "collection_recorded");
  assert.equal((event?.metadata as Record<string, unknown>).remainingAmount, 400, "the event carries the locked remainder");
  assert.equal((event?.metadata as Record<string, unknown>).previousPaidAmount, 200);
  assert.ok(
    won.some((r) => r.method === "POST" && r.path.endsWith("/audit_logs")),
    "and its audit row",
  );

  // ── 6. The decision: request locked, still pending, both request writes guarded ────────────────
  const decideRaw = readMigration(DECIDE_MIGRATION);
  const decideSql = stripSqlComments(decideRaw);
  const decideFn = sqlFunction(decideSql, "phx_decide_marketing_request_step");
  const requestLockAt = squash(decideFn).search(
    /SELECT r\.status INTO v_request_status FROM marketing_requests r WHERE r\.id = p_request_id FOR UPDATE;/,
  );
  assert.ok(requestLockAt > 0, "THE HEADLINE: the decision locks the request row FOR UPDATE");
  assert.ok(
    requestLockAt < squash(decideFn).indexOf("UPDATE marketing_request_approval_steps SET decision_at"),
    "before the step is stamped — so the request lock is taken first, the order cancel, reopen and resubmit use",
  );
  assert.ok(
    squash(decideFn).includes(
      "IF v_request_status IS DISTINCT FROM 'pending_approval' THEN RAISE EXCEPTION 'marketing_request_not_pending",
    ),
    "a request that is no longer pending approval is refused",
  );
  const requestUpdates = squash(decideFn).match(/UPDATE marketing_requests SET .*? RETURNING \* INTO v_request;/g) ?? [];
  assert.equal(requestUpdates.length, 2, "two writes to the request: reject/return, and final approval");
  for (const update of requestUpdates) {
    assert.ok(update.includes("WHERE id = p_request_id AND status = 'pending_approval'"), `the request write is guarded: ${update.slice(0, 60)}`);
  }
  assert.equal(
    (squash(decideFn).match(/RETURNING \* INTO v_request; (?:\w+ )?IF NOT FOUND THEN RAISE EXCEPTION 'marketing_request_not_pending/g) ?? [])
      .length,
    2,
    "and each one refuses when no row was updated",
  );
  // VERBATIM: every line of the previous definition is still there, in order.
  const previous = readMigration(PREVIOUS_DECIDE_MIGRATION);
  const previousBody = previous
    .slice(previous.indexOf("CREATE OR REPLACE FUNCTION public.phx_decide_marketing_request_step("), previous.indexOf("  to service_role;") + 18)
    .split("\n");
  const currentLines = decideRaw.split("\n");
  let cursor = 0;
  for (const line of previousBody) {
    const found = currentLines.indexOf(line, cursor);
    assert.ok(found >= 0, `the previous definition's line is missing or out of order: ${JSON.stringify(line)}`);
    cursor = found + 1;
  }
  // No later migration redefines it.
  const redefiners = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => /create\s+or\s+replace\s+function\s+public\.phx_decide_marketing_request_step\(/i.test(readMigration(name)));
  assert.equal(redefiners.at(-1), DECIDE_MIGRATION, "this is the latest definition of phx_decide_marketing_request_step");
  const decideSig = "phx_decide_marketing_request_step(uuid, uuid, text, text, text, timestamptz)";
  assert.ok(squash(decideSql).includes(`revoke execute on function public.${decideSig} from public, anon, authenticated;`));
  assert.ok(squash(decideSql).includes(`grant execute on function public.${decideSig} to service_role;`));

  // ── 7. Cancel: one transaction, open rungs closed ──────────────────────────────────────────────
  const cancelFn = squash(sqlFunction(decideSql, "phx_cancel_marketing_request"));
  assert.ok(/from marketing_requests r where r\.id = p_request_id for update;/.test(cancelFn), "cancel locks the request");
  assert.ok(cancelFn.includes("if v_status is distinct from p_expected_status then"), "compare-and-set on the status the caller read");
  assert.ok(
    cancelFn.includes(
      "update marketing_request_approval_steps set status = 'skipped', updated_at = p_cancelled_at where request_id = p_request_id and status in ('current', 'pending') and is_cc = false;",
    ),
    "the rungs still open are closed as skipped — the status a reject gives the rungs it ends",
  );
  const cancelSig = "phx_cancel_marketing_request(uuid, text, text, timestamptz)";
  assert.ok(squash(decideSql).includes(`revoke execute on function public.${cancelSig} from public, anon, authenticated;`));
  assert.ok(squash(decideSql).includes(`grant execute on function public.${cancelSig} to service_role;`));

  const cancel = stripComments(read("../src/lib/marketing-requests/cancel.ts"));
  const cancelBody = functionBody(cancel, "export async function cancelMarketingRequest(");
  assert.ok(cancelBody.includes('supabase.rpc("phx_cancel_marketing_request"'), "cancel goes through the one-transaction function");
  assert.ok(cancelBody.includes("p_expected_status: request.status"), "with the status it read as the expected one");
  assert.ok(!cancelBody.includes(".update("), "and no longer flips the status with its own update");
  assert.ok(cancelBody.includes('"marketing_cancel_conflict"'), "a lost cancel is still the same 409");

  // ── 8. The service maps the decision's refusal to the pre-check's own 409 ──────────────────────
  const marketing = stripComments(read("../src/lib/marketing-requests/service.ts"));
  assert.match(
    marketing,
    /rpcErr\.message\?\.includes\("marketing_request_not_pending"\)\) \{\s*throw conflictError\("This marketing request is no longer pending approval\."\);/,
    "the database refusal reads exactly like the application's own pending-approval pre-check",
  );
  assert.match(
    marketing,
    /if \(request\.status !== "pending_approval"\) \{\s*throw conflictError\("This marketing request is no longer pending approval\."\);/,
    "and that pre-check is still there",
  );

  console.log("  direct-order collection and marketing decision: locked, compare-and-set, guarded");
}
