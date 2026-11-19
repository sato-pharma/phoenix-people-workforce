import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import { ApiError } from "../src/lib/http/api-errors.ts";
import { DIRECT_ORDER_COLLECTION_CONFLICT_MESSAGE } from "../src/lib/direct-orders/collection-rules.ts";
import { recordDirectOrderCollection } from "../src/lib/direct-orders/service.ts";
import { invalidateEmployeeDirectoryCache } from "../src/lib/employees/employee-directory.ts";
import { cancelMarketingRequest } from "../src/lib/marketing-requests/cancel.ts";
import { decideMarketingRequestWorkflow } from "../src/lib/marketing-requests/service.ts";
import { clearTelegramGovernanceCache } from "../src/lib/notifications/telegram-governance.ts";
import { forgetNotificationTemplates } from "../src/lib/notifications/templates.ts";
import {
  anyWrite,
  atomically,
  RpcRaise,
  rpcCalls,
  snapshot,
  STAND_IN_ORIGIN,
  withStandIn,
  writesTo,
  type Row,
  type RpcAnswer,
  type Seen,
  type StandIn,
  type Tables,
} from "./support/postgrest-transaction-stand-in.ts";

// BEHAVIOUR, NOT SOURCE TEXT, for three money and status changes PR #333 (REC-038) made one database
// function each. Every test calls the REAL domain function, through the REAL Supabase admin client,
// against the in-memory PostgREST in tests/support/postgrest-transaction-stand-in.ts, and checks what happened to
// the stored rows. Each database function is modelled from its migration — the lock, the guards and
// every write, in the migration's order — inside `atomically`, so a raise part-way keeps nothing, as
// Postgres does.
//
//   1. Direct-order collection (recordDirectOrderCollection, phx_record_direct_order_collection,
//      20261113161617). (a) The function is stopped AFTER its UPDATE has written the new paid amount:
//      the order, its offsets and every other table read exactly as before, the app writes no audit
//      row, no order event and pings no sheet, and Finance is refused — never told "saved".
//      (b) Two saves from the same screen at once: one wins, the other gets the 409 the
//      compare-and-set promises, and the order carries ONE collection, one event, one audit row.
//   2. Marketing decision (decideMarketingRequestWorkflow, phx_decide_marketing_request_step,
//      20261113161619). (a) Stopped after the step and the request were written (a final approval at
//      its finance-requirement insert; a reject after it closed the later rungs): nothing kept, no
//      audit row, nobody notified. (b) Two presses of Approve at once — on a middle rung (the step's
//      compare-and-set decides) and on the final rung (the request lock decides): one decision, one
//      409, one audit row, one notice; and a decision racing a cancel, in both orders: exactly one
//      lands, so a cancelled request is never written back to approved and an approval never cancelled.
//   3. Marketing cancel (cancelMarketingRequest, phx_cancel_marketing_request, same migration).
//      (a) Stopped after the request was flipped to cancelled but before the open rungs were closed:
//      nothing kept, no audit row. (b) Two cancels at once: one cancel, one 409, rungs closed once.
//
// Every race holds both database calls until both callers have arrived (RaceGate below), so each has
// already read the record and passed every TypeScript pre-check: the database function's own lock and
// compare-and-set is the only thing left that can pick one winner, and the test proves it does.
//
// Nothing here reaches a network, an environment file or a real database: the stand-in refuses any
// other host, the two sheet pings are pointed at a trap that records them, and every other outside
// call is recorded so a refusal can prove nobody was notified.

// ─────────────────────────────────────────────────────────────────────────────── shared harness

const DIRECT_ORDER_SHEET = "https://sheet-ping.invalid/direct-orders";
const MARKETING_SHEET = "https://sheet-ping.invalid/marketing";
const PING_ENV: Record<string, string> = {
  MARKETING_SHEET_REFRESH_WEBHOOK_SECRET: "stand-in-secret-never-sent",
  MARKETING_SHEET_REFRESH_WEBHOOK_URL: MARKETING_SHEET,
  SHEET_REFRESH_WEBHOOK_SECRET: "stand-in-secret-never-sent",
  SHEET_REFRESH_WEBHOOK_URL: DIRECT_ORDER_SHEET,
};

type Outside = { hosts: string[]; pings: string[] };

/**
 * The worst interleaving of two server requests, made certain: each call to one of `rpc` is held until
 * `arrivals` of them have arrived, then they run in the order they came. So both callers have done
 * every read and passed every TypeScript pre-check before either database function runs — only the
 * function's own lock and compare-and-set can pick the winner. (A lone arrival is let go after a second.)
 * `first` names the function that runs first when two different ones meet, so both orders can be tried.
 */
type RaceGate = { arrivals: number; first?: string; rpc: string[] };

/**
 * Runs `body` against the stand-in with the two sheet pings pointed at a trap, and every request to a
 * host other than the stand-in recorded (the stand-in still refuses it). Puts the fetch, the four ping
 * settings and the in-process caches the marketing path fills (employee directory, notification
 * templates, Telegram governance) back afterwards, so nothing later in the shard reads this test's data.
 */
async function harness(
  standIn: StandIn,
  body: (seen: Seen[], outside: Outside) => Promise<void>,
  gate?: RaceGate,
): Promise<void> {
  await withStandIn(standIn, async (seen) => {
    const env = process.env as Record<string, string | undefined>;
    const saved = Object.fromEntries(Object.keys(PING_ENV).map((key) => [key, env[key]]));
    const standInFetch = globalThis.fetch;
    const outside: Outside = { hosts: [], pings: [] };
    const held: Array<{ name: string; release: () => void }> = [];
    let lonelyTimer: ReturnType<typeof setTimeout> | null = null;
    const releaseAll = () => {
      if (lonelyTimer) clearTimeout(lonelyTimer);
      lonelyTimer = null;
      const queue = held.splice(0);
      const order = (name: string) => (gate?.first && name === gate.first ? 0 : 1);
      for (const entry of queue.sort((left, right) => order(left.name) - order(right.name))) entry.release();
    };
    Object.assign(env, PING_ENV);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === DIRECT_ORDER_SHEET || url === MARKETING_SHEET) {
        outside.pings.push(url);
        return new Response("ok", { status: 200 });
      }
      if (!url.startsWith(STAND_IN_ORIGIN)) outside.hosts.push(new URL(url).origin);
      const rpcName = url.startsWith(`${STAND_IN_ORIGIN}/rest/v1/rpc/`) ? url.slice(`${STAND_IN_ORIGIN}/rest/v1/rpc/`.length).split("?")[0] : null;
      if (gate && rpcName && gate.rpc.includes(rpcName)) {
        await new Promise<void>((resolve) => {
          held.push({ name: rpcName, release: resolve });
          // Released on a later tick, once every held call is awaiting, so they resume in release order.
          if (held.length >= gate.arrivals) setTimeout(releaseAll, 0);
          else lonelyTimer ??= setTimeout(releaseAll, 1000);
        });
      }
      return standInFetch(input, init);
    }) as typeof fetch;
    try {
      await body(seen, outside);
    } finally {
      releaseAll();
      globalThis.fetch = standInFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      invalidateEmployeeDirectoryCache();
      forgetNotificationTemplates();
      clearTelegramGovernanceCache();
    }
  });
}

/**
 * "The stored state equals the state before": every table the test seeded is deep-equal to its copy,
 * and a table the run created (the stand-in makes one for every read) is still empty.
 */
function assertNothingChanged(tables: Tables, before: Tables, message: string): void {
  for (const name of new Set([...Object.keys(before), ...Object.keys(tables)])) {
    assert.deepEqual(tables[name] ?? [], before[name] ?? [], `${message} — table ${name}`);
  }
}

/** A hook a modelled function calls after each write; a test makes one stage throw. */
type Fault = (stage: string, draft: Tables) => void;

/** What Postgres answers when statement_timeout stops a function part-way: the transaction rolls back. */
const statementTimeout = () => new RpcRaise("57014", "canceling statement due to statement timeout", 500);

function failAt(stage: string, error: () => RpcRaise, onReach?: (draft: Tables) => void): Fault {
  return (reached, draft) => {
    if (reached !== stage) return;
    onReach?.(draft);
    throw error();
  };
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
/** SQL `a IS DISTINCT FROM b` for the scalar columns compared here. */
const distinct = (left: unknown, right: unknown) =>
  left == null || right == null ? (left == null) !== (right == null) : String(left) !== String(right) && Number(left) !== Number(right);

const settledWins = <T>(results: PromiseSettledResult<T>[]) =>
  results.filter((result): result is PromiseFulfilledResult<T> => result.status === "fulfilled").map((result) => result.value);
const settledLosses = <T>(results: PromiseSettledResult<T>[]) =>
  results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason as unknown);

const notificationWrites = (seen: Seen[]) =>
  seen.filter((request) => request.method !== "GET" && request.method !== "HEAD" && /notification/i.test(request.table ?? request.rpc ?? ""));

const SUPER_ADMIN = createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin" });

// ─────────────────────────────────────────────────────────────────────────────── 1. direct-order collection

const COLLECTION_RPC = "phx_record_direct_order_collection";
const ORDER_ID = "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const SCREEN_LOADED = { paidAmount: 200, paymentDate: "2026-11-01" };

function collectionTables(): Tables {
  return {
    audit_logs: [],
    direct_order_events: [],
    // A 100 EGP marketing request already settled against this order: remaining = 1000 − 200 − 100.
    direct_order_marketing_offsets: [
      { amount: 100, direct_order_id: ORDER_ID, id: "c0ffee00-0000-4000-8000-000000000001", marketing_request_id: "c0ffee00-0000-4000-8000-0000000000aa" },
    ],
    direct_order_requests: [
      {
        bonus: 0,
        created_at: "2026-10-01T08:00:00Z",
        id: ORDER_ID,
        line: "Pedia",
        paid_amount: 200,
        payment_date: "2026-11-01",
        pharmacy_id: "11111111-2222-4333-8444-555555555555",
        product_code: "P1",
        product_name: "Product One",
        qty: 10,
        remaining_amount: 700,
        request_code: "DO-TEST-1",
        requester_hr_id: "PD-0001",
        requester_role: "Medical Rep",
        sales_month: "2026-10",
        sales_value: 1000,
        status: "approved",
        updated_at: "2026-11-01T08:00:00Z",
      },
    ],
  };
}

/**
 * public.phx_record_direct_order_collection as its latest form writes it (20261119145916, the 7-argument form): the
 * order row locked FOR UPDATE (a handler runs as one indivisible step), the compare-and-set on paid_amount and
 * payment_date, the offsets summed under the lock, the money re-checked, ONE update, then — in the same transaction —
 * the audit row and the order's event row (REC-038), then the jsonb answer.
 */
function recordCollection(fault?: Fault) {
  return (args: Record<string, unknown>, tables: Tables): RpcAnswer =>
    atomically(tables, (draft) => {
      const order = (draft.direct_order_requests ?? []).find((row) => row.id === args.p_order_id);
      if (!order) throw new RpcRaise("P0001", "direct_order_collection_order_not_found");
      if (distinct(order.paid_amount, args.p_expected_paid_amount) || distinct(order.payment_date, args.p_expected_payment_date)) {
        throw new RpcRaise("P0001", `direct_order_collection_conflict: the collection on order ${String(args.p_order_id)} changed since it was read`);
      }
      const offsets = round2(
        (draft.direct_order_marketing_offsets ?? [])
          .filter((row) => row.direct_order_id === args.p_order_id)
          .reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
      );
      const value = round2(Number(order.sales_value ?? 0));
      const previous = { paid: order.paid_amount, date: order.payment_date, remaining: order.remaining_amount };
      let paid: number | null = null;
      let remaining: number | null;
      if (args.p_paid_amount == null) {
        remaining = offsets <= 0 ? null : Math.max(0, round2(value - offsets));
      } else {
        if (String(order.status ?? "") !== "approved") throw new RpcRaise("P0001", "direct_order_collection_not_approved");
        if (Number(args.p_paid_amount) <= 0) throw new RpcRaise("P0001", "direct_order_collection_amount_invalid");
        if (value <= 0) throw new RpcRaise("P0001", "direct_order_collection_no_value");
        paid = round2(Number(args.p_paid_amount));
        if (paid > value) throw new RpcRaise("P0001", "direct_order_collection_exceeds_value");
        if (offsets > 0 && round2(paid + offsets) > value) throw new RpcRaise("P0001", "direct_order_collection_exceeds_net_value");
        if (args.p_payment_date == null) throw new RpcRaise("P0001", "direct_order_collection_date_required");
        remaining = round2(value - paid - offsets);
      }
      Object.assign(order, {
        paid_amount: paid,
        payment_date: paid == null ? null : args.p_payment_date,
        remaining_amount: remaining,
        updated_at: new Date().toISOString(),
      });
      fault?.("after_update", draft);
      // The records, inside the transaction, with the figures written under the lock.
      const audit = (args.p_audit ?? {}) as Row;
      (draft.audit_logs ??= []).push({
        actor_login_id: String(audit.actor_login_id ?? "") || "system",
        entity_id: String(args.p_order_id),
        entity_type: "direct_order_request",
        new_values: { paidAmount: paid, paymentDate: paid == null ? null : args.p_payment_date, remainingAmount: remaining },
        old_values: { paidAmount: previous.paid, paymentDate: previous.date, remainingAmount: previous.remaining },
        summary: audit.summary,
      });
      fault?.("after_audit", draft);
      const event = (args.p_event ?? {}) as Row;
      (draft.direct_order_events ??= []).push({
        actor_hr_id: String(event.actor_hr_id ?? "") || null,
        event_type: event.event_type,
        message:
          paid != null && (remaining ?? 0) > 0 && event.message_outstanding != null
            ? String(event.message_outstanding).replace("{remaining}", String(remaining))
            : event.message,
        metadata: {
          paidAmount: paid,
          paymentDate: paid == null ? null : args.p_payment_date,
          previousPaidAmount: previous.paid,
          remainingAmount: remaining,
          salesMonthUnchanged: String(order.sales_month ?? "") || null,
        },
        request_id: args.p_order_id,
      });
      return {
        body: {
          paidAmount: paid,
          paymentDate: paid == null ? null : args.p_payment_date,
          previousPaidAmount: previous.paid,
          previousPaymentDate: previous.date,
          previousRemainingAmount: previous.remaining,
          remainingAmount: remaining,
        },
        status: 200,
      };
    });
}

async function collectionStoppedAfterItsWriteKeepsNothing(): Promise<void> {
  const tables = collectionTables();
  const before = snapshot(tables);
  let writtenBeforeTheStop: Row | null = null;
  const fault = failAt("after_update", statementTimeout, (draft) => {
    writtenBeforeTheStop = { ...draft.direct_order_requests[0] };
  });
  await harness({ rpc: { [COLLECTION_RPC]: recordCollection(fault) }, tables }, async (seen, outside) => {
    let thrown: unknown = null;
    let answered: unknown = null;
    try {
      answered = await recordDirectOrderCollection(SUPER_ADMIN, {
        expected: SCREEN_LOADED,
        paidAmount: 500,
        paymentDate: "2026-11-02",
        requestId: ORDER_ID,
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(answered, null, "a collection the database rolled back must never come back to Finance as a saved order");
    assert.ok(thrown, "Finance is refused when the collection function is stopped part-way");
    assert.equal((thrown as { code?: string }).code, "57014", "the refusal is the database's own error, passed on unchanged");
    const stopped = writtenBeforeTheStop as Row | null;
    assert.ok(stopped, "precondition: the stop struck after the function's UPDATE");
    assert.equal(stopped.paid_amount, 500, "precondition: inside the function the new paid amount had already been written");
    assert.equal(stopped.remaining_amount, 400, "precondition: and the remainder computed under the lock (1000 − 500 − 100)");
    assert.equal(rpcCalls(seen, COLLECTION_RPC).length, 1, "the locked function was asked once");
    assert.deepEqual(anyWrite(seen), [], "NO audit row, NO direct_order_events row, no table write of any kind follows a refused collection");
    assert.deepEqual(outside.pings, [], "the live sheet is not told about a collection that did not happen");
    assert.deepEqual(outside.hosts, [], "and nothing else outside Phoenix is called");
    assertNothingChanged(tables, before, "ROLLBACK: the order, its offsets and every other table read exactly as before the save");
  });
}

async function twoCollectionSavesOneWinner(): Promise<void> {
  const tables = collectionTables();
  await harness({ rpc: { [COLLECTION_RPC]: recordCollection() }, tables }, async (seen, outside) => {
    // Two Finance tabs opened on the same order (200 on 1 November) and saved at the same moment.
    const save = (paidAmount: number) =>
      recordDirectOrderCollection(SUPER_ADMIN, { expected: SCREEN_LOADED, paidAmount, paymentDate: "2026-11-02", requestId: ORDER_ID });
    const results = await Promise.allSettled([save(500), save(600)]);
    const wins = settledWins(results);
    const losses = settledLosses(results);
    assert.equal(wins.length, 1, "RACE: exactly one of two simultaneous collection saves is accepted");
    assert.equal(losses.length, 1, "RACE: and the other is refused");
    const lost = losses[0] as ApiError;
    assert.ok(lost instanceof ApiError && lost.status === 409, `RACE: the losing save gets the 409 Conflict (got ${String((lost as { status?: unknown })?.status)} ${String((lost as Error)?.message)})`);
    assert.equal(lost.message, DIRECT_ORDER_COLLECTION_CONFLICT_MESSAGE, "in the words the screen shows");
    assert.equal(rpcCalls(seen, COLLECTION_RPC).length, 2, "both saves reached the locked function — the compare-and-set under the lock picked the winner");

    const winner = wins[0];
    const order = tables.direct_order_requests[0];
    assert.equal(order.paid_amount, winner.paidAmount, "the stored collection is the winner's, written once");
    assert.equal(order.payment_date, "2026-11-02");
    assert.equal(order.remaining_amount, round2(1000 - Number(winner.paidAmount) - 100), "the remainder is the winner's, net of the offset");
    assert.equal(winner.remainingAmount, order.remaining_amount, "and the winner was told the remainder the function wrote");
    assert.equal(tables.direct_order_events.length, 1, "ONE collection event on the order's timeline");
    assert.equal(tables.direct_order_events[0].event_type, "collection_recorded");
    assert.equal((tables.direct_order_events[0].metadata as Row).paidAmount, winner.paidAmount, "the event is the winner's");
    assert.equal(tables.audit_logs.length, 1, "ONE audit row");
    assert.deepEqual(anyWrite(seen), [], "every row — the collection, its audit row and its event — was written by the one call");
    assert.equal(outside.pings.length, 1, "the sheet is pinged once, for the save that happened");
    assert.deepEqual(outside.hosts, [], "nothing else outside Phoenix is called");
  }, { arrivals: 2, rpc: [COLLECTION_RPC] });
}

/** A record failing INSIDE the call — the event insert, after the audit row — rolls the collection back with it. */
async function collectionRecordFailingInsideTheCallKeepsNothing(): Promise<void> {
  const tables = collectionTables();
  const before = snapshot(tables);
  let auditWrittenBeforeTheStop = false;
  const fault = failAt("after_audit", statementTimeout, (draft) => {
    auditWrittenBeforeTheStop = draft.audit_logs.length === 1 && draft.direct_order_requests[0].paid_amount === 500;
  });
  await harness({ rpc: { [COLLECTION_RPC]: recordCollection(fault) }, tables }, async (seen, outside) => {
    let thrown: unknown = null;
    let answered: unknown = null;
    try {
      answered = await recordDirectOrderCollection(SUPER_ADMIN, { expected: SCREEN_LOADED, paidAmount: 500, paymentDate: "2026-11-02", requestId: ORDER_ID });
    } catch (error) {
      thrown = error;
    }
    assert.ok(auditWrittenBeforeTheStop, "precondition: inside the call the new collection AND its audit row were written before the stop");
    assert.equal(answered, null, "RECORD: a collection whose record failed is never answered as saved");
    assert.equal((thrown as { code?: string } | null)?.code, "57014", "RECORD: Finance is refused with the database's own error");
    assert.deepEqual(anyWrite(seen), [], "RECORD: the app wrote nothing outside the call");
    assert.deepEqual(outside.pings, [], "RECORD: the sheet is not told about a collection that did not happen");
    assertNothingChanged(tables, before, "RECORD: HEADLINE: the collection does not stand without its record — every table reads as before");
  });
}

/** The records land with the collection, in the call, saying exactly what the app used to write after it. */
async function collectionRecordsLandWithIt(): Promise<void> {
  for (const shape of ["outstanding", "paid_in_full", "cleared"] as const) {
    const tables = collectionTables();
    const paidAmount = shape === "outstanding" ? 500 : shape === "paid_in_full" ? 900 : null;
    await harness({ rpc: { [COLLECTION_RPC]: recordCollection() }, tables }, async (seen, outside) => {
      const order = await recordDirectOrderCollection(SUPER_ADMIN, {
        expected: SCREEN_LOADED,
        paidAmount,
        paymentDate: paidAmount == null ? null : "2026-11-02",
        requestId: ORDER_ID,
      });
      const label = `RECORDS (${shape})`;
      assert.equal(rpcCalls(seen, COLLECTION_RPC).length, 1, `${label}: one call`);
      assert.deepEqual(anyWrite(seen), [], `${label}: HEADLINE: the audit row and the event row were written inside the call, not after it`);
      const remaining = shape === "outstanding" ? 400 : shape === "paid_in_full" ? 0 : 900;
      assert.equal(order.remainingAmount, remaining, `${label}: Finance is told the remainder the function wrote`);
      const [audit] = tables.audit_logs;
      assert.deepEqual(
        [audit.entity_type, audit.entity_id, audit.actor_login_id, audit.summary],
        [
          "direct_order_request",
          ORDER_ID,
          SUPER_ADMIN.loginId,
          paidAmount == null
            ? `Direct order collection cleared by ${SUPER_ADMIN.hrId}.`
            : `Direct order collection of ${paidAmount} EGP recorded by ${SUPER_ADMIN.hrId}.`,
        ],
        `${label}: one audit row, in the words the app used to write`,
      );
      assert.deepEqual(audit.old_values, { paidAmount: 200, paymentDate: "2026-11-01", remainingAmount: 700 }, `${label}: naming what the collection replaced`);
      assert.deepEqual(
        audit.new_values,
        { paidAmount, paymentDate: paidAmount == null ? null : "2026-11-02", remainingAmount: remaining },
        `${label}: and what it wrote`,
      );
      const [event] = tables.direct_order_events;
      const expectedMessage =
        shape === "outstanding"
          ? "Collected 500 EGP on 2026-11-02; 400 EGP still outstanding."
          : shape === "paid_in_full"
            ? "Collected 900 EGP on 2026-11-02 — paid in full."
            : "Collection cleared — nothing is recorded as paid against this order.";
      assert.deepEqual(
        [event.event_type, event.message, event.actor_hr_id],
        [paidAmount == null ? "collection_cleared" : "collection_recorded", expectedMessage, "B-10"],
        `${label}: one event on the order's timeline, in the words the app used to write`,
      );
      assert.equal((event.metadata as Row).salesMonthUnchanged, "2026-10", `${label}: the event proves the sales month was untouched`);
      assert.equal(outside.pings.length, 1, `${label}: the sheet is pinged once, after the commit`);
    });
  }
}

/** A collection that committed is answered as saved even when the read-back after it fails. */
async function collectionSavedEvenWhenTheReadBackFails(): Promise<void> {
  const tables = collectionTables();
  await harness({ rpc: { [COLLECTION_RPC]: recordCollection() }, tables }, async () => {
    const inner = globalThis.fetch;
    let orderReads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = String(init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.pathname === "/rest/v1/direct_order_requests" && (orderReads += 1) === 2) {
        return new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), {
          headers: { "content-type": "application/json" },
          status: 500,
        });
      }
      return inner(input, init);
    }) as typeof fetch;
    let refusal: unknown = null;
    let order: Awaited<ReturnType<typeof recordDirectOrderCollection>> | null = null;
    try {
      order = await recordDirectOrderCollection(SUPER_ADMIN, { expected: SCREEN_LOADED, paidAmount: 500, paymentDate: "2026-11-02", requestId: ORDER_ID });
    } catch (error) {
      refusal = error;
    }
    assert.equal(orderReads, 2, "precondition: the read-back after the call was the read that failed");
    assert.equal(refusal, null, "READ-BACK: HEADLINE: Finance is never refused for a collection that committed");
    assert.deepEqual(
      [order?.paidAmount, order?.paymentDate, order?.remainingAmount],
      [500, "2026-11-02", 400],
      "READ-BACK: HEADLINE: a committed collection is answered as saved, with the figures written, never refused",
    );
    assert.equal(tables.audit_logs.length, 1, "READ-BACK: and its record stands with it");
  });
}

export async function runDirectOrderCollectionRollbackAndRaceTests(): Promise<void> {
  await collectionStoppedAfterItsWriteKeepsNothing();
  await twoCollectionSavesOneWinner();
  await collectionRecordFailingInsideTheCallKeepsNothing();
  await collectionRecordsLandWithIt();
  await collectionSavedEvenWhenTheReadBackFails();
}

// ─────────────────────────────────────────────────────────────────────────────── 2. marketing decision

const DECIDE_RPC = "phx_decide_marketing_request_step";
const CANCEL_RPC = "phx_cancel_marketing_request";
const MKT_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const STEP_DM = "5e000000-0000-4000-8000-000000000001";
const STEP_MARKETING = "5e000000-0000-4000-8000-000000000002";
const STEP_MARKETING_CC = "5e000000-0000-4000-8000-000000000003";
const STEP_CEO = "5e000000-0000-4000-8000-000000000004";
const MARKETING_MANAGER = createAccessContext({ hrId: "A-9", loginId: "a-9", role: "Marketing Manager" });

/**
 * One request waiting at the Marketing Manager's rung. "middle": the CEO's rung is still ahead.
 * "final": the Marketing Manager's rung is the last gating one, so approving it approves the request.
 */
function marketingTables(shape: "middle" | "final"): Tables {
  const step = (fields: Row): Row => ({
    allow_reject: true,
    allow_return: true,
    decision_at: null,
    decision_by_hr_id: null,
    decision_note: null,
    executed_at: null,
    is_cc: false,
    request_id: MKT_ID,
    terminal_status: null,
    updated_at: "2026-11-18T08:00:00Z",
    ...fields,
  });
  const steps: Row[] = [
    step({ assigned_hr_id: "B-20", decision_at: "2026-11-18T09:00:00Z", decision_by_hr_id: "B-20", id: STEP_DM, sequence: 1, status: "approved", step_code: "dm_review", step_name: "District Manager review" }),
    step({ assigned_hr_id: "A-9", id: STEP_MARKETING, sequence: 2, status: "current", step_code: "marketing_review", step_name: "Marketing review", terminal_status: shape === "final" ? "approved" : null }),
    step({ assigned_hr_id: "A-10", id: STEP_MARKETING_CC, is_cc: true, sequence: 2, status: "skipped", step_code: "marketing_review", step_name: "Marketing review (copy)" }),
  ];
  if (shape === "middle") {
    steps.push(step({ assigned_hr_id: "AA", id: STEP_CEO, sequence: 3, status: "pending", step_code: "ceo_approval", step_name: "CEO approval", terminal_status: "approved" }));
  }
  return {
    audit_logs: [],
    marketing_control_settings: [{ setting_key: "finance_invoice_deadline_days", setting_value: { days: 7 } }],
    marketing_request_approval_steps: steps,
    marketing_request_finance_requirements: [],
    marketing_requests: [
      {
        approved_at: null,
        customer_id: null,
        estimated_cost: 5000,
        executed_at: null,
        id: MKT_ID,
        rejected_at: null,
        request_code: "MKT-REQ-20261118-STANDIN1",
        request_type_id: 1,
        requester_hr_id: "PD-0001",
        returned_at: null,
        returned_step_sequence: null,
        status: "pending_approval",
        updated_at: "2026-11-18T09:00:00Z",
        updated_by_hr_id: "B-20",
      },
    ],
  };
}

function cairoDatePlus(iso: string, days: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(iso));
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * public.phx_decide_marketing_request_step as 20261113161619 writes it: the REQUEST locked first and
 * refused unless still pending_approval, the decision mapped, the self-decision refused, the step
 * stamped under its own compare-and-set (status still 'current'), then reject/return (later rungs
 * skipped on a reject, the request written WHERE status = 'pending_approval') or approve (the next
 * pending rung opened, or the request approved WHERE status = 'pending_approval', the execution stamp,
 * and the finance requirement inserted ON CONFLICT DO NOTHING). The AFTER triggers that write
 * marketing_request_events are not modelled; they run in the same transaction and roll back with it.
 */
function decideStep(fault?: Fault) {
  return (args: Record<string, unknown>, tables: Tables): RpcAnswer =>
    atomically(tables, (draft) => {
      const requests = draft.marketing_requests ?? [];
      const steps = draft.marketing_request_approval_steps ?? [];
      const request = requests.find((row) => row.id === args.p_request_id);
      const requestStatus = (request?.status as string | undefined) ?? null;
      if (requestStatus !== "pending_approval") {
        throw new RpcRaise(
          "P0001",
          `marketing_request_not_pending: request ${String(args.p_request_id)} is ${requestStatus ?? "missing"}, not pending_approval`,
        );
      }
      const terminalStep = ({ approve: "approved", reject: "rejected", return: "returned" } as Record<string, string>)[String(args.p_decision)];
      if (!terminalStep) throw new RpcRaise("P0001", `Invalid marketing request decision: ${String(args.p_decision)}`);
      const requester = String(request?.requester_hr_id ?? "").trim().toLowerCase();
      if (requester && requester === String(args.p_decided_by ?? "").trim().toLowerCase()) {
        throw new RpcRaise("23514", `marketing_self_approval_refused: ${String(args.p_decided_by)} raised this request and may not decide it`);
      }
      const decidedAt = String(args.p_decided_at);
      const step = steps.find((row) => row.id === args.p_step_id && row.status === "current");
      if (!step) throw new RpcRaise("P0001", `marketing_step_already_decided: step ${String(args.p_step_id)} was no longer current`);
      const note = String(args.p_decision_note ?? "").trim();
      Object.assign(step, { decision_at: decidedAt, decision_by_hr_id: args.p_decided_by, decision_note: note || null, status: terminalStep, updated_at: decidedAt });
      fault?.("after_step_stamped", draft);

      if (args.p_decision === "reject" || args.p_decision === "return") {
        let terminalised = 0;
        if (args.p_decision === "reject") {
          for (const row of steps) {
            if (row.request_id === args.p_request_id && row.status === "pending" && row.is_cc === false) {
              Object.assign(row, { status: "skipped", updated_at: decidedAt });
              terminalised += 1;
            }
          }
        }
        fault?.("after_rungs_closed", draft);
        if (!request || request.status !== "pending_approval") {
          throw new RpcRaise("P0001", `marketing_request_not_pending: request ${String(args.p_request_id)} left pending_approval before the decision was written`);
        }
        Object.assign(request, {
          rejected_at: args.p_decision === "reject" ? decidedAt : request.rejected_at,
          returned_at: args.p_decision === "return" ? decidedAt : request.returned_at,
          returned_step_sequence: args.p_decision === "return" ? step.sequence : request.returned_step_sequence,
          status: args.p_decision === "reject" ? "rejected" : "returned",
          updated_at: decidedAt,
          updated_by_hr_id: args.p_decided_by,
        });
        return { body: { branch: args.p_decision, isExecution: false, nextStep: null, request: { ...request }, step: { ...step }, terminalised }, status: 200 };
      }

      const next = steps
        .filter((row) => row.request_id === args.p_request_id && row.status === "pending" && row.is_cc === false && Number(row.sequence) > Number(step.sequence))
        .sort((left, right) => Number(left.sequence) - Number(right.sequence))[0];
      if (next) {
        Object.assign(next, { status: "current", updated_at: decidedAt });
        return { body: { branch: "approve_next", isExecution: false, nextStep: { ...next }, request: { ...request }, step: { ...step } }, status: 200 };
      }

      const terminalStatus = String(step.terminal_status ?? "approved");
      const isExecution = terminalStatus === "active";
      if (!request || request.status !== "pending_approval") {
        throw new RpcRaise("P0001", `marketing_request_not_pending: request ${String(args.p_request_id)} left pending_approval before the decision was written`);
      }
      Object.assign(request, {
        approved_at: decidedAt,
        executed_at: isExecution ? decidedAt : request.executed_at,
        status: terminalStatus,
        updated_at: decidedAt,
        updated_by_hr_id: args.p_decided_by,
      });
      fault?.("after_request_written", draft);
      if (isExecution) Object.assign(step, { executed_at: decidedAt, updated_at: decidedAt });
      const setting = (draft.marketing_control_settings ?? []).find((row) => row.setting_key === "finance_invoice_deadline_days");
      const days = Number((setting?.setting_value as { days?: unknown } | undefined)?.days ?? Number.NaN);
      fault?.("finance_requirement_insert", draft);
      const finance = (draft.marketing_request_finance_requirements ??= []);
      if (!finance.some((row) => row.request_id === args.p_request_id)) {
        finance.push({
          created_at: decidedAt,
          invoice_deadline_date: cairoDatePlus(decidedAt, Number.isFinite(days) ? days : 7),
          invoice_required: true,
          invoice_status: "pending",
          request_id: args.p_request_id,
          updated_at: decidedAt,
        });
      }
      return { body: { branch: "approve_final", isExecution, nextStep: null, request: { ...request }, step: { ...step } }, status: 200 };
    });
}

/**
 * public.phx_cancel_marketing_request as its latest form writes it (20261119145916, the 5-argument form): the request
 * locked, compare-and-set on the status the caller read, flipped to 'cancelled', every 'current' or 'pending' non-CC
 * rung closed as 'skipped', then — in the same transaction — the cancel's audit row (REC-038).
 */
function cancelRequest(fault?: Fault) {
  return (args: Record<string, unknown>, tables: Tables): RpcAnswer =>
    atomically(tables, (draft) => {
      const request = (draft.marketing_requests ?? []).find((row) => row.id === args.p_request_id);
      if (!request) throw new RpcRaise("P0001", `marketing_request_not_found: request ${String(args.p_request_id)} does not exist`);
      const status = (request.status as string | null | undefined) ?? null;
      if (status !== ((args.p_expected_status as string | null | undefined) ?? null)) {
        throw new RpcRaise("P0001", `marketing_cancel_conflict: request ${String(args.p_request_id)} is ${String(status)}, not ${String(args.p_expected_status)}`);
      }
      Object.assign(request, { status: "cancelled", updated_at: args.p_cancelled_at, updated_by_hr_id: args.p_actor_hr_id });
      fault?.("after_request_cancelled", draft);
      let closedSteps = 0;
      for (const row of draft.marketing_request_approval_steps ?? []) {
        if (row.request_id === args.p_request_id && (row.status === "current" || row.status === "pending") && row.is_cc === false) {
          Object.assign(row, { status: "skipped", updated_at: args.p_cancelled_at });
          closedSteps += 1;
        }
      }
      fault?.("after_steps_closed", draft);
      const audit = (args.p_audit ?? {}) as Row;
      (draft.audit_logs ??= []).push({
        actor_login_id: String(audit.actor_login_id ?? "") || "system",
        entity_id: String(args.p_request_id),
        entity_type: "marketing_request",
        new_values: { closedApprovalSteps: closedSteps, status: "cancelled" },
        old_values: { status },
        summary: audit.summary,
      });
      return { body: { closedSteps, previousStatus: status, requestId: args.p_request_id, status: "cancelled" }, status: 200 };
    });
}

const stepById = (tables: Tables, id: string) => tables.marketing_request_approval_steps.find((row) => row.id === id) as Row;
const decisionAuditRows = (tables: Tables) => tables.audit_logs.filter((row) => row.entity_type === "marketing_request" && row.entity_id === MKT_ID);

async function decisionStoppedPartWayKeepsNothing(): Promise<void> {
  const cases = [
    {
      decision: "approve" as const,
      label: "a final approval stopped at its finance-requirement insert",
      // Inside the function the step was approved and the request flipped to approved before the stop.
      precondition: (draft: Tables) => {
        assert.equal(stepById(draft, STEP_MARKETING).status, "approved", "precondition: the step had been stamped approved");
        assert.equal(draft.marketing_requests[0].status, "approved", "precondition: the request had been written approved");
      },
      shape: "final" as const,
      stage: "finance_requirement_insert",
    },
    {
      decision: "reject" as const,
      label: "a reject stopped after it closed the later rungs",
      precondition: (draft: Tables) => {
        assert.equal(stepById(draft, STEP_MARKETING).status, "rejected", "precondition: the step had been stamped rejected");
        assert.equal(stepById(draft, STEP_CEO).status, "skipped", "precondition: the CEO's rung had been closed out");
      },
      shape: "middle" as const,
      stage: "after_rungs_closed",
    },
  ];
  for (const testCase of cases) {
    const tables = marketingTables(testCase.shape);
    const before = snapshot(tables);
    let reached = false;
    const fault = failAt(testCase.stage, statementTimeout, (draft) => {
      reached = true;
      testCase.precondition(draft);
    });
    await harness({ rpc: { [DECIDE_RPC]: decideStep(fault) }, tables }, async (seen, outside) => {
      let thrown: unknown = null;
      let answered: unknown = null;
      try {
        answered = await decideMarketingRequestWorkflow(MARKETING_MANAGER, {
          comment: testCase.decision === "reject" ? "Not within this quarter's budget." : null,
          decision: testCase.decision,
          requestId: MKT_ID,
        });
      } catch (error) {
        thrown = error;
      }
      assert.equal(answered, null, `${testCase.label}: the approver is never told the decision was saved`);
      assert.ok(thrown, `${testCase.label}: the approver is refused`);
      assert.equal((thrown as { code?: string }).code, "57014", `${testCase.label}: with the database's own error`);
      assert.ok(reached, `${testCase.label}: precondition — the stop struck after the function's first writes`);
      assert.equal(rpcCalls(seen, DECIDE_RPC).length, 1, `${testCase.label}: the decision function was asked once`);
      assert.deepEqual(notificationWrites(seen), [], `${testCase.label}: nobody is notified of a decision that did not happen`);
      assert.deepEqual(anyWrite(seen), [], `${testCase.label}: NO audit row, NO notification row, no table write of any kind follows the refusal`);
      assert.deepEqual(outside.pings, [], `${testCase.label}: the live sheet is not told`);
      assert.deepEqual(outside.hosts, [], `${testCase.label}: no email, Telegram or push leaves Phoenix`);
      assertNothingChanged(tables, before, `ROLLBACK (${testCase.label}): the request, every rung and the finance requirements read exactly as before`);
    });
  }
}

async function twoApprovalsOneDecision(): Promise<void> {
  // (b1) A middle rung, Approve pressed twice at once (two tabs). The step's own compare-and-set
  // (status still 'current') is what refuses the second: the request is still pending approval.
  {
    const tables = marketingTables("middle");
    await harness({ rpc: { [DECIDE_RPC]: decideStep() }, tables }, async (seen, outside) => {
      const approve = () => decideMarketingRequestWorkflow(MARKETING_MANAGER, { decision: "approve", requestId: MKT_ID });
      const results = await Promise.allSettled([approve(), approve()]);
      const wins = settledWins(results);
      const losses = settledLosses(results);
      assert.equal(wins.length, 1, "RACE (middle rung): exactly one of two simultaneous approvals is recorded");
      assert.equal(losses.length, 1, "RACE (middle rung): the other is refused");
      const lost = losses[0] as ApiError;
      assert.ok(lost instanceof ApiError && lost.status === 409, `RACE (middle rung): the second approval gets the 409 Conflict (got ${String((lost as { status?: unknown })?.status)} ${String((lost as Error)?.message)})`);
      assert.equal(lost.message, "This marketing approval step was already decided. Refresh Phoenix and try again.");
      assert.equal(rpcCalls(seen, DECIDE_RPC).length, 2, "both presses reached the decision function — its compare-and-set picked the winner");
      assert.equal(stepById(tables, STEP_MARKETING).status, "approved", "the Marketing rung is approved once");
      assert.equal(stepById(tables, STEP_MARKETING).decision_by_hr_id, "A-9");
      assert.equal(stepById(tables, STEP_CEO).status, "current", "the CEO's rung is opened once");
      assert.equal(tables.marketing_requests[0].status, "pending_approval", "the request is still waiting for the CEO");
      assert.equal(tables.marketing_request_finance_requirements.length, 0, "no finance obligation for a request not yet approved");
      assert.equal(decisionAuditRows(tables).length, 1, "ONE decision audit row");
      assert.equal(writesTo(seen, "notification_events").length, 1, "ONE notice to the next approver, from the decision that happened");
      assert.deepEqual(outside.hosts, [], "nothing outside Phoenix is called");
    }, { arrivals: 2, rpc: [DECIDE_RPC] });
  }

  // (b2) The final rung, Approve pressed twice at once. The first approves the request, so the
  // second is refused by the REQUEST lock (no longer pending approval) before it touches the step.
  {
    const tables = marketingTables("final");
    await harness({ rpc: { [DECIDE_RPC]: decideStep() }, tables }, async (seen, outside) => {
      const approve = () => decideMarketingRequestWorkflow(MARKETING_MANAGER, { decision: "approve", requestId: MKT_ID });
      const results = await Promise.allSettled([approve(), approve()]);
      const wins = settledWins(results);
      const losses = settledLosses(results);
      assert.equal(wins.length, 1, "RACE (final rung): exactly one of two simultaneous final approvals is recorded");
      assert.equal(losses.length, 1, "RACE (final rung): the other is refused");
      const lost = losses[0] as ApiError;
      assert.ok(lost instanceof ApiError && lost.status === 409, `RACE (final rung): the second approval gets the 409 Conflict (got ${String((lost as { status?: unknown })?.status)} ${String((lost as Error)?.message)})`);
      assert.equal(lost.message, "This marketing request is no longer pending approval.");
      assert.equal(tables.marketing_requests[0].status, "approved", "the request is approved once");
      assert.equal(tables.marketing_request_finance_requirements.length, 1, "ONE finance obligation, from the one approval");
      assert.equal(stepById(tables, STEP_MARKETING).status, "approved");
      assert.equal(decisionAuditRows(tables).length, 1, "ONE decision audit row");
      assert.equal(writesTo(seen, "notification_events").length, 1, "ONE approval notice");
      assert.equal(outside.pings.length, 1, "the sheet is pinged once, for the approval that happened");
      assert.deepEqual(outside.hosts, [], "nothing outside Phoenix is called");
    }, { arrivals: 2, rpc: [DECIDE_RPC] });
  }

  // (b3) A decision racing a cancel (F-MKT-006, the race PR #333 closed): the Super Admin cancels while
  // the last approver presses Approve, both having read the request as pending. Tried in both orders.
  // Cancel first: the decision must not write the cancelled request back to approved (nor create its
  // finance obligation). Decision first: the cancel must not overwrite the approval from its stale read.
  await decisionRacingACancel(CANCEL_RPC);
  await decisionRacingACancel(DECIDE_RPC);
}

async function decisionRacingACancel(first: string): Promise<void> {
  const label = first === CANCEL_RPC ? "RACE (cancel lands first, then the decision)" : "RACE (decision lands first, then the cancel)";
  const tables = marketingTables("final");
  await harness({ rpc: { [CANCEL_RPC]: cancelRequest(), [DECIDE_RPC]: decideStep() }, tables }, async (seen) => {
    const [decided, cancelled] = await Promise.allSettled([
      decideMarketingRequestWorkflow(MARKETING_MANAGER, { decision: "approve", requestId: MKT_ID }),
      cancelMarketingRequest({ access: SUPER_ADMIN, reason: "Duplicate of another request.", requestId: MKT_ID }),
    ]);
    assert.equal(
      rpcCalls(seen, DECIDE_RPC).length + rpcCalls(seen, CANCEL_RPC).length,
      2,
      `${label}: both passed their own pre-check and reached their database function`,
    );
    const [winner, loser] = first === CANCEL_RPC ? [cancelled, decided] : [decided, cancelled];
    assert.equal(winner.status, "fulfilled", `${label}: the first to reach the database lands`);
    assert.equal(loser.status, "rejected", `${label}: exactly one of the two lands — the second is refused`);
    const lost = (loser as PromiseRejectedResult).reason as ApiError;
    assert.ok(lost instanceof ApiError && lost.status === 409, `${label}: the second gets the 409 Conflict (got ${String((lost as { status?: unknown })?.status)} ${String((lost as Error)?.message)})`);
    const request = tables.marketing_requests[0];
    if (first === CANCEL_RPC) {
      assert.equal(lost.message, "This marketing request is no longer pending approval.", `${label}: in the pre-check's own words`);
      assert.equal(request.status, "cancelled", `${label}: the cancel stands — the decision did not write the request back to approved`);
      assert.equal(request.approved_at, null, `${label}: no approval stamp on a cancelled request`);
      assert.equal(tables.marketing_request_finance_requirements.length, 0, `${label}: no finance obligation for a cancelled request`);
      assert.equal(stepById(tables, STEP_MARKETING).status, "skipped", `${label}: the open rung was closed by the cancel, never decided`);
      assert.equal(decisionAuditRows(tables).length, 1, `${label}: ONE audit row — the cancel's`);
    } else {
      assert.equal(lost.message, "The request changed status while it was being cancelled. Reload and try again.", `${label}: in the cancel's own words`);
      assert.equal(request.status, "approved", `${label}: the approval stands — the cancel did not overwrite it from a stale read`);
      assert.equal(tables.marketing_request_finance_requirements.length, 1, `${label}: the one finance obligation stands`);
      assert.equal(stepById(tables, STEP_MARKETING).status, "approved", `${label}: the rung keeps its decision`);
      assert.equal(decisionAuditRows(tables).length, 1, `${label}: ONE audit row — the decision's`);
    }
  }, { arrivals: 2, first, rpc: [DECIDE_RPC, CANCEL_RPC] });
}

export async function runMarketingDecisionRollbackAndRaceTests(): Promise<void> {
  await decisionStoppedPartWayKeepsNothing();
  await twoApprovalsOneDecision();
}

// ─────────────────────────────────────────────────────────────────────────────── 3. marketing cancel

async function cancelStoppedPartWayKeepsNothing(): Promise<void> {
  const tables = marketingTables("middle");
  const before = snapshot(tables);
  let reached = false;
  const fault = failAt("after_request_cancelled", statementTimeout, (draft) => {
    reached = true;
    assert.equal(draft.marketing_requests[0].status, "cancelled", "precondition: the request had been flipped to cancelled inside the function");
    assert.equal(stepById(draft, STEP_MARKETING).status, "current", "precondition: the open rungs were not yet closed");
  });
  await harness({ rpc: { [CANCEL_RPC]: cancelRequest(fault) }, tables }, async (seen, outside) => {
    let thrown: unknown = null;
    let answered: unknown = null;
    try {
      answered = await cancelMarketingRequest({ access: SUPER_ADMIN, reason: "Duplicate of another request.", requestId: MKT_ID });
    } catch (error) {
      thrown = error;
    }
    assert.equal(answered, null, "a cancel the database rolled back is never reported as cancelled");
    assert.ok(thrown, "the Super Admin is refused");
    assert.equal((thrown as { code?: string }).code, "57014", "with the database's own error");
    assert.ok(reached, "precondition: the stop struck after the function's first write");
    assert.equal(rpcCalls(seen, CANCEL_RPC).length, 1, "the cancel function was asked once");
    assert.deepEqual(anyWrite(seen), [], "NO audit row and no table write of any kind follows a refused cancel");
    assert.deepEqual(notificationWrites(seen), [], "nobody is notified");
    assert.deepEqual(outside.hosts, [], "nothing outside Phoenix is called");
    assertNothingChanged(tables, before, "ROLLBACK: the request is still pending approval and every rung is exactly as it was");
  });
}

async function twoCancelsOneWinner(): Promise<void> {
  const tables = marketingTables("middle");
  await harness({ rpc: { [CANCEL_RPC]: cancelRequest() }, tables }, async (seen, outside) => {
    const cancel = (reason: string) => cancelMarketingRequest({ access: SUPER_ADMIN, reason, requestId: MKT_ID });
    const results = await Promise.allSettled([cancel("Duplicate of another request."), cancel("Raised by mistake.")]);
    const wins = settledWins(results);
    const losses = settledLosses(results);
    assert.equal(wins.length, 1, "RACE: exactly one of two simultaneous cancels is recorded");
    assert.equal(losses.length, 1, "RACE: the other is refused");
    const lost = losses[0] as ApiError;
    assert.ok(lost instanceof ApiError && lost.status === 409, `RACE: the second cancel gets the 409 Conflict (got ${String((lost as { status?: unknown })?.status)} ${String((lost as Error)?.message)})`);
    assert.equal(lost.message, "The request changed status while it was being cancelled. Reload and try again.");
    assert.equal(rpcCalls(seen, CANCEL_RPC).length, 2, "both reached the cancel function — its compare-and-set picked the winner");
    assert.equal(wins[0].status, "cancelled");
    assert.equal(tables.marketing_requests[0].status, "cancelled", "the request is cancelled once");
    assert.equal(stepById(tables, STEP_MARKETING).status, "skipped", "the open rung is closed");
    assert.equal(stepById(tables, STEP_CEO).status, "skipped", "the pending rung is closed");
    assert.equal(stepById(tables, STEP_DM).status, "approved", "a rung already decided keeps its decision");
    assert.equal(stepById(tables, STEP_MARKETING_CC).status, "skipped", "the copy row is untouched");
    const audits = decisionAuditRows(tables);
    assert.equal(audits.length, 1, "ONE cancel audit row");
    assert.equal((audits[0].new_values as Row).closedApprovalSteps, 2, "naming the two rungs that one cancel closed");
    assert.deepEqual(anyWrite(seen), [], "the cancel and its audit row were written by the one call");
    assert.deepEqual(outside.hosts, [], "nothing outside Phoenix is called");
  }, { arrivals: 2, rpc: [CANCEL_RPC] });
}

/** The audit row failing INSIDE the call rolls the cancel back with it; written, it says what the app used to write. */
async function cancelRecordInsideTheCall(): Promise<void> {
  {
    const tables = marketingTables("middle");
    const before = snapshot(tables);
    let closedBeforeTheStop = false;
    const fault = failAt("after_steps_closed", statementTimeout, (draft) => {
      closedBeforeTheStop = draft.marketing_requests[0].status === "cancelled" && stepById(draft, STEP_MARKETING).status === "skipped";
    });
    await harness({ rpc: { [CANCEL_RPC]: cancelRequest(fault) }, tables }, async (seen) => {
      let thrown: unknown = null;
      try {
        await cancelMarketingRequest({ access: SUPER_ADMIN, reason: "Duplicate of another request.", requestId: MKT_ID });
      } catch (error) {
        thrown = error;
      }
      assert.ok(closedBeforeTheStop, "precondition: inside the call the request was cancelled and its rungs closed before the stop");
      assert.equal((thrown as { code?: string } | null)?.code, "57014", "RECORD: the Super Admin is refused with the database's own error");
      assert.deepEqual(anyWrite(seen), [], "RECORD: the app wrote nothing outside the call");
      assertNothingChanged(tables, before, "RECORD: HEADLINE: the cancel does not stand without its audit row — every table reads as before");
    });
  }
  {
    const tables = marketingTables("middle");
    await harness({ rpc: { [CANCEL_RPC]: cancelRequest() }, tables }, async (seen) => {
      await cancelMarketingRequest({ access: SUPER_ADMIN, reason: "Duplicate of another request.", requestId: MKT_ID });
      assert.deepEqual(anyWrite(seen), [], "RECORDS: HEADLINE: the audit row was written inside the call, not after it");
      const [audit] = decisionAuditRows(tables);
      const code = String(tables.marketing_requests[0].request_code ?? MKT_ID);
      assert.deepEqual(
        [audit.actor_login_id, audit.summary, audit.old_values, audit.new_values],
        [
          SUPER_ADMIN.loginId,
          `Marketing request ${code} cancelled (was "pending_approval"). Reason: Duplicate of another request.`,
          { status: "pending_approval" },
          { closedApprovalSteps: 2, status: "cancelled" },
        ],
        "RECORDS: one audit row, in the words and with the values the app used to write",
      );
    });
  }
}

export async function runMarketingCancelRollbackAndRaceTests(): Promise<void> {
  await cancelStoppedPartWayKeepsNothing();
  await twoCancelsOneWinner();
  await cancelRecordInsideTheCall();
}
