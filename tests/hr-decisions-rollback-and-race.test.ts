import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import { ApiError } from "../src/lib/http/api-errors.ts";
import { createRetentionConversation, updateRetentionConversation } from "../src/lib/retention/service.ts";
import { decideVacationRequest } from "../src/lib/vacation/service.ts";
import {
  atomically,
  RpcRaise,
  rpcCalls,
  snapshot,
  withStandIn,
  writesTo,
  type Row,
  type Seen,
  type Tables,
} from "./support/postgrest-transaction-stand-in.ts";

// BEHAVIOUR TESTS FOR TWO HR DECISIONS THAT MUST BE ALL OR NOTHING (F-HR-010, F-HR-011).
//
// tests/hr-atomic-writes.test.ts pins the SOURCE of these fixes (the SQL text, the service text) and
// one refused call. This file runs the REAL domain functions against the shared in-memory PostgREST
// (tests/support/postgrest-transaction-stand-in.ts) — no network, no environment file, no real database, nobody
// notified — and checks what they DO, in two ways each:
//
//   (a) A FAILURE AFTER THE FIRST WRITE CHANGES NOTHING. The database function is modelled from its
//       migration statement by statement, inside `atomically`, and is made to raise AFTER its first
//       write. The tables afterwards must equal the tables before, the app must write nothing more
//       (no audit row, no event, no notice), and the caller must be refused — never told "saved".
//   (b) TWO CALLERS, ONE WINNER. Two calls of the same operation on the same record start at once
//       against ONE shared state. Exactly one succeeds, the other gets the Conflict (409) the code
//       promises, and the stored state shows the operation applied exactly once.
//
// 1. Retention conversations — createRetentionConversation / updateRetentionConversation, through
//    phx_create_retention_conversation / phx_update_retention_conversation
//    (supabase/migrations/20261113161724_retention_themes_replace_atomic.sql).
// 2. Leave decisions — decideVacationRequest (the real entry point: permission, request read, approver
//    resolution, workflow registry, sequencing, pricing), through phx_apply_vacation_step_decision and
//    phx_apply_vacation_paid_approval_with_step
//    (supabase/migrations/20261113161725_vacation_step_and_request_atomic.sql), the paid part modelled
//    from phx_apply_vacation_paid_approval (supabase/migrations/20260915210000_weekly_digest_release_and_balance_choice.sql).

/** Lets any detached follow-up (the audit outbox's opportunistic drain) finish inside the stand-in. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every write the app made outside a database function: table writes only, reads and RPCs excluded. */
const tableWrites = (seen: Seen[]) =>
  seen.filter((request) => request.rpc === null && request.method !== "GET" && request.method !== "HEAD");

/**
 * The stored state, for "afterwards equals before". A read of a table the stand-in did not hold
 * creates it empty, so an empty table and an absent one are the same fact here.
 */
function stored(tables: Tables): Tables {
  return Object.fromEntries(Object.entries(snapshot(tables)).filter(([, rows]) => rows.length > 0));
}

/**
 * Holds every call to one database function until `parties` callers have reached it (or a second has
 * passed), then lets them through together — two server requests whose writes arrive at the same
 * moment, after both have read. The stand-in answers each call in one step, as a function holding its
 * row locks does, so the calls then run one after the other.
 */
function releaseTogether(rpcName: string, parties: number): void {
  const inner = globalThis.fetch;
  const waiting: Array<() => void> = [];
  let arrived = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const openGate = () => {
    if (timer) clearTimeout(timer);
    while (waiting.length > 0) waiting.shift()?.();
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(`/rest/v1/rpc/${rpcName}`) && arrived < parties) {
      arrived += 1;
      if (arrived === parties) openGate();
      else {
        timer ??= setTimeout(openGate, 1000);
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    }
    return inner(input, init);
  }) as typeof fetch;
}

/** A timestamptz as microseconds, so `is distinct from` compares instants, never spellings. */
function micros(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const textValue = String(value);
  const fraction = /\.(\d+)/.exec(textValue)?.[1] ?? "";
  const millis = Date.parse(textValue.replace(/\.\d+/, ""));
  if (Number.isNaN(millis)) throw new RpcRaise("22007", `invalid input syntax for type timestamp with time zone: "${textValue}"`);
  return millis * 1000 + Number((fraction + "000000").slice(0, 6));
}

// ─────────────────────────────────────────────────────────────────────────── 1. retention conversations

const CONVERSATION_ID = "6f0c5d4e-1111-4222-8333-944455566677";
const LOADED_AT = "2026-11-13T09:15:42.123456+00:00";

const RETENTION_CREATE_COLUMNS = [
  "kind",
  "employee_hr_id",
  "employee_name",
  "job_title",
  "conducted_on",
  "conducted_by",
  "resignation_id",
  "retention_risk",
  "is_regrettable",
  "would_rejoin",
  "summary",
  "follow_up_action",
  "follow_up_due",
  "created_by",
];
const RETENTION_UPDATE_COLUMNS = [
  "updated_at",
  "summary",
  "retention_risk",
  "is_regrettable",
  "would_rejoin",
  "follow_up_action",
  "follow_up_due",
  "follow_up_done_at",
];

function retentionTables(): Tables {
  return {
    audit_log_outbox: [],
    audit_logs: [],
    employees: [{ full_name: "Mona Adel Hassan", hr_id: "B-200", job_title: "Medical Representative", nickname: "Mona" }],
    hr_retention_conversation_themes: [
      { conversation_id: CONVERSATION_ID, created_at: "2026-11-01T08:00:00+00:00", id: "theme-1", note: "fair", sentiment: "driver", theme_key: "pay" },
      { conversation_id: CONVERSATION_ID, created_at: "2026-11-01T08:00:00+00:00", id: "theme-2", note: null, sentiment: "blocker", theme_key: "manager" },
    ],
    hr_retention_conversations: [
      {
        conducted_by: "hr.advisor",
        conducted_on: "2026-11-01",
        created_at: "2026-11-01T08:00:00+00:00",
        created_by: "hr.advisor",
        employee_hr_id: "B-200",
        employee_name: "Mona",
        follow_up_action: null,
        follow_up_done_at: null,
        follow_up_due: null,
        id: CONVERSATION_ID,
        is_regrettable: null,
        job_title: "Medical Representative",
        kind: "stay",
        line_name: null,
        resignation_id: null,
        retention_risk: "medium",
        summary: "Feels the new route is too long.",
        updated_at: LOADED_AT,
        would_rejoin: null,
      },
    ],
  };
}

type RetentionFault = { at: "themes_insert"; raise: RpcRaise } | null;

/**
 * The three retention functions, statement by statement as the migration writes them. `trace` records
 * each statement as it runs (it lives outside the transaction, so it survives a raise and shows WHERE
 * the raise came); `fault` raises at the named statement, once.
 */
function retentionFunctions(trace: string[], faultBox: { fault: RetentionFault }) {
  let serial = 0;

  // The type check and the column whitelist each function runs first, with its own sentences.
  function whitelist(payload: unknown, allowed: string[], notObject: string, refused: (column: string) => string) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RpcRaise("22023", notObject);
    const unknown = Object.keys(payload).find((key) => !allowed.includes(key));
    if (unknown) throw new RpcRaise("22023", refused(unknown));
  }

  function checkKindFields(row: Row) {
    const stay = row.kind === "stay" && row.retention_risk != null && row.is_regrettable == null && row.would_rejoin == null;
    const exit = row.kind === "exit" && row.retention_risk == null && row.is_regrettable != null;
    if (!stay && !exit) {
      throw new RpcRaise("23514", 'new row for relation "hr_retention_conversations" violates check constraint "hr_retention_kind_fields"');
    }
    if (String(row.summary ?? "").trim() === "") {
      throw new RpcRaise("23514", 'new row for relation "hr_retention_conversations" violates check constraint "hr_retention_conversations_summary_check"');
    }
  }

  // phx_replace_retention_conversation_themes: lock the conversation, delete every theme, insert the set.
  function replaceThemes(draft: Tables, conversationId: string, themes: unknown): number {
    if (!Array.isArray(themes)) throw new RpcRaise("22023", "Retention themes must be a list.");
    const locked = draft.hr_retention_conversations.find((row) => row.id === conversationId);
    if (!locked) throw new RpcRaise("P0002", "That conversation no longer exists.");
    trace.push("lock conversation (themes)");
    draft.hr_retention_conversation_themes = draft.hr_retention_conversation_themes.filter((row) => row.conversation_id !== conversationId);
    trace.push("delete themes");
    if (faultBox.fault?.at === "themes_insert") {
      const { raise } = faultBox.fault;
      faultBox.fault = null;
      trace.push("insert themes -> RAISED");
      throw raise;
    }
    for (const theme of themes as Row[]) {
      if (theme.sentiment !== "driver" && theme.sentiment !== "blocker") {
        throw new RpcRaise("23514", 'new row for relation "hr_retention_conversation_themes" violates check constraint');
      }
      const duplicate = draft.hr_retention_conversation_themes.some(
        (row) => row.conversation_id === conversationId && row.theme_key === theme.theme_key && row.sentiment === theme.sentiment,
      );
      if (duplicate) throw new RpcRaise("23505", "duplicate key value violates unique constraint");
      serial += 1;
      draft.hr_retention_conversation_themes.push({
        conversation_id: conversationId,
        created_at: "2026-11-19T10:00:00+00:00",
        id: `theme-new-${serial}`,
        note: theme.note ?? null,
        sentiment: theme.sentiment,
        theme_key: theme.theme_key,
      });
    }
    trace.push("insert themes");
    return themes.length;
  }

  return {
    phx_create_retention_conversation: (args: Record<string, unknown>, tables: Tables) => {
      whitelist(
        args.p_conversation,
        RETENTION_CREATE_COLUMNS,
        "A retention conversation must be an object.",
        (column) => `A new retention conversation cannot set "${column}".`,
      );
      return atomically(tables, (draft) => {
        serial += 1;
        const id = `7a1b2c3d-0000-4000-8000-${String(serial).padStart(12, "0")}`;
        const row: Row = {
          created_at: "2026-11-19T10:00:00+00:00",
          follow_up_done_at: null,
          id,
          line_name: null,
          updated_at: "2026-11-19T10:00:00+00:00",
          ...(args.p_conversation as Row),
        };
        checkKindFields(row);
        draft.hr_retention_conversations.push(row);
        trace.push("insert conversation");
        replaceThemes(draft, id, args.p_themes ?? []);
        return { body: id, status: 200 };
      });
    },
    phx_update_retention_conversation: (args: Record<string, unknown>, tables: Tables) => {
      whitelist(
        args.p_patch,
        RETENTION_UPDATE_COLUMNS,
        "A retention conversation update must be an object.",
        (column) => `A retention conversation update cannot change "${column}".`,
      );
      return atomically(tables, (draft) => {
        const row = draft.hr_retention_conversations.find((candidate) => candidate.id === args.p_conversation_id);
        if (!row) throw new RpcRaise("P0002", "That conversation no longer exists.");
        trace.push("lock conversation");
        if (args.p_expected_updated_at != null && micros(row.updated_at) !== micros(args.p_expected_updated_at)) {
          throw new RpcRaise("40001", "This conversation was changed by someone else since you opened it. Reload it and try again.");
        }
        Object.assign(row, args.p_patch as Row);
        checkKindFields(row);
        trace.push("update conversation");
        if (args.p_themes != null) replaceThemes(draft, String(args.p_conversation_id), args.p_themes);
        return { body: row.updated_at, status: 200 };
      });
    },
  };
}

const STATEMENT_TIMEOUT = () => new RpcRaise("57014", "canceling statement due to statement timeout", 500);

async function retentionCreateRollsBack(): Promise<void> {
  const tables = retentionTables();
  const before = snapshot(tables);
  const trace: string[] = [];
  await withStandIn({ rpc: retentionFunctions(trace, { fault: { at: "themes_insert", raise: STATEMENT_TIMEOUT() } }), tables }, async (seen) => {
    let refusal: unknown = null;
    let answer: unknown = null;
    try {
      answer = await createRetentionConversation(
        {
          conductedOn: "2026-11-19",
          employeeHrId: "B-200",
          kind: "stay",
          retentionRisk: "high",
          summary: "Has an offer from a competitor.",
          themes: [{ sentiment: "blocker", themeKey: "pay" }, { sentiment: "driver", themeKey: "team" }],
        },
        "hr.advisor",
      );
    } catch (error) {
      refusal = error;
    }
    await settle();
    assert.equal(answer, null, "(a) create: a create whose themes failed must not hand back a conversation id");
    assert.ok(refusal instanceof Error, "(a) create: the caller is refused when the function raises after inserting the conversation");
    assert.equal((refusal as Error).message, "canceling statement due to statement timeout", "(a) create: the refusal carries the database's own reason");
    assert.deepEqual(
      trace,
      ["insert conversation", "lock conversation (themes)", "delete themes", "insert themes -> RAISED"],
      "(a) create: the forced raise came AFTER the function's first write (the conversation insert)",
    );
    assert.equal(rpcCalls(seen, "phx_create_retention_conversation").length, 1, "(a) create: one call carries the conversation and its themes");
    assert.deepEqual(tableWrites(seen), [], "(a) create: after the refusal the app writes NOTHING — no audit row, no separate conversation or theme write");
    assert.deepEqual(stored(tables), stored(before), "(a) create: every table afterwards equals the tables before — no theme-less conversation is left for a retry to duplicate");
  });
}

async function retentionUpdateRollsBack(): Promise<void> {
  const tables = retentionTables();
  const before = snapshot(tables);
  const trace: string[] = [];
  await withStandIn({ rpc: retentionFunctions(trace, { fault: { at: "themes_insert", raise: STATEMENT_TIMEOUT() } }), tables }, async (seen) => {
    let refusal: unknown = null;
    let saved = false;
    try {
      await updateRetentionConversation(
        {
          expectedUpdatedAt: LOADED_AT,
          id: CONVERSATION_ID,
          retentionRisk: "high",
          summary: "Now says the route AND the pay are the problem.",
          themes: [{ sentiment: "blocker", themeKey: "pay" }, { sentiment: "blocker", themeKey: "route" }],
        },
        "hr.advisor",
      );
      saved = true;
    } catch (error) {
      refusal = error;
    }
    await settle();
    assert.equal(saved, false, "(a) update: an update whose theme insert failed must never answer \"saved\"");
    assert.ok(refusal instanceof Error, "(a) update: the caller is refused when the function raises after updating the conversation");
    assert.ok(!(refusal instanceof ApiError && refusal.status === 409), "(a) update: a database failure is not dressed up as someone else's edit (409)");
    assert.deepEqual(
      trace,
      ["lock conversation", "update conversation", "lock conversation (themes)", "delete themes", "insert themes -> RAISED"],
      "(a) update: the forced raise came AFTER the function's first write (the conversation update) and its theme delete",
    );
    assert.deepEqual(tableWrites(seen), [], "(a) update: after the refusal the app writes NOTHING — no audit row, no separate theme call");
    assert.deepEqual(
      snapshot(tables).hr_retention_conversation_themes,
      before.hr_retention_conversation_themes,
      "(a) update: the conversation keeps its confidential themes — the delete before the failed insert is rolled back",
    );
    assert.deepEqual(stored(tables), stored(before), "(a) update: every table afterwards equals the tables before — the summary, the risk and updated_at included");
  });
}

async function retentionUpdateRace(): Promise<void> {
  const tables = retentionTables();
  const trace: string[] = [];
  const edits = [
    { summary: "Editor ONE: the route is fixed, she is staying.", themes: [{ sentiment: "driver" as const, themeKey: "route" }] },
    { summary: "Editor TWO: she still wants a raise.", themes: [{ sentiment: "blocker" as const, themeKey: "pay" }] },
  ];
  await withStandIn({ rpc: retentionFunctions(trace, { fault: null }), tables }, async (seen) => {
    // Two editors opened the same conversation (the same loaded version) and press Save together.
    releaseTogether("phx_update_retention_conversation", 2);
    const results = await Promise.allSettled(
      edits.map((edit) =>
        updateRetentionConversation({ expectedUpdatedAt: LOADED_AT, id: CONVERSATION_ID, ...edit }, "hr.advisor"),
      ),
    );
    await settle();
    const winners = results.flatMap((result, index) => (result.status === "fulfilled" ? [index] : []));
    const losers = results.flatMap((result, index) => (result.status === "rejected" ? [{ index, reason: result.reason as unknown }] : []));
    assert.equal(rpcCalls(seen, "phx_update_retention_conversation").length, 2, "(b) both editors reached the database function");
    assert.equal(winners.length, 1, "(b) HEADLINE: exactly one of two simultaneous saves of the same conversation succeeds");
    assert.equal(losers.length, 1, "(b) and exactly one is refused");
    const loser = losers[0].reason;
    assert.ok(loser instanceof ApiError, "(b) the losing save is an ApiError the route can answer");
    assert.equal((loser as ApiError).status, 409, "(b) the losing save is the Conflict (409) the code promises, never a 500");
    assert.equal((loser as ApiError).code, "retention_conversation_changed", "(b) with the retention conflict code");
    assert.match((loser as ApiError).message, /changed by someone else/, "(b) and the function's own sentence");

    const winner = edits[winners[0]];
    const stored = tables.hr_retention_conversations.find((row) => row.id === CONVERSATION_ID)!;
    assert.equal(stored.summary, winner.summary, "(b) the stored summary is the winner's — applied exactly once, never the loser's over it");
    assert.deepEqual(
      tables.hr_retention_conversation_themes
        .filter((row) => row.conversation_id === CONVERSATION_ID)
        .map((row) => `${row.theme_key}:${row.sentiment}`),
      winner.themes.map((theme) => `${theme.themeKey}:${theme.sentiment}`),
      "(b) the stored themes are exactly the winner's set — no mix of both editors' themes",
    );
    assert.notEqual(stored.updated_at, LOADED_AT, "(b) the winner moved the version on");
    assert.equal(writesTo(seen, "audit_logs").length, 1, "(b) one audit row — for the one save that landed, none for the refused one");
  });
}

// ─────────────────────────────────────────────────────────────────────────────────── 2. leave decisions

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const SUBMITTED_AT = "2026-11-18T08:00:00+00:00";

/** The twenty request columns phx_apply_vacation_step_decision accepts in its patch (v_allowed). */
const VACATION_PATCH_COLUMNS = [
  "status",
  "updated_at",
  "hr_decision",
  "hr_decision_at",
  "hr_decision_by_hr_id",
  "hr_decision_comment",
  "manager_decision",
  "manager_decision_at",
  "manager_decision_by_hr_id",
  "manager_decision_comment",
  "balance_after_days",
  "balance_before_days",
  "entitlement_days",
  "payment_status",
  "paid_duration_days",
  "period_end",
  "period_start",
  "unpaid_reason",
  "unpaid_duration_days",
  "used_paid_days",
];

function step(id: string, stepKey: string, order: number, approverHrId: string, status: string): Row {
  return {
    approver_hr_id: approverHrId,
    approver_user_id: null,
    created_at: SUBMITTED_AT,
    decided_at: status === "pending" ? null : "2026-11-18T12:00:00+00:00",
    decision_comment: null,
    id,
    overridden_at: null,
    overridden_by_hr_id: null,
    request_id: REQUEST_ID,
    status,
    step_key: stepKey,
    step_order: order,
    updated_at: SUBMITTED_AT,
  };
}

/**
 * A two-day Annual request by Mona Adel Hassan (B-200), whose chain is her District Manager (B-118),
 * then HR — two Super Admin accounts (B-10, B-11), each holding its own HR step row. `atHr` puts the
 * request past the manager. She already took five paid days this year (VAC-0801), so a final approval
 * prices this one against 21 - 5 = 16 days left.
 */
function vacationTables(atHr: boolean): Tables {
  const request = (overrides: Row): Row => ({
    balance_after_days: null,
    balance_before_days: null,
    created_at: SUBMITTED_AT,
    day_part: "full_day",
    department_name: "Sales",
    employee_hire_date: "2020-01-01",
    employee_hr_id: "B-200",
    employee_name: "Mona Adel Hassan",
    employee_work_email: null,
    entitlement_days: null,
    hr_decision: null,
    hr_decision_at: null,
    hr_decision_by_hr_id: null,
    hr_decision_comment: null,
    line_name: "Pedia",
    manager_decision: null,
    manager_decision_at: null,
    manager_decision_by_hr_id: null,
    manager_decision_comment: null,
    manager_hr_id: "B-118",
    manager_name: "Karim Fathy",
    manager_of_manager_hr_id: "B-50",
    manager_of_manager_name: "Hany Samir",
    paid_duration_days: 0,
    payment_status: "unpaid",
    period_end: null,
    period_start: null,
    unpaid_duration_days: 0,
    unpaid_reason: null,
    used_paid_days: null,
    ...overrides,
  });
  const leaveStatuses = ["pending_manager", "pending_hr", "needs_assignment", "approved", "rejected", "returned", "cancelled"];
  const action = (key: string, from: string, to: string, allowedRoles: string[]) => ({ allowedRoles, auditLog: key, from: [from], key, label: key, to });
  return {
    attendance_annual_balance_charges: [],
    audit_log_outbox: [],
    audit_logs: [],
    employees: [
      { employment_status: "active", full_name: "Mona Adel Hassan", hr_id: "B-200", is_active: true, job_title: "Medical Representative", manager_hr_id: "B-118" },
      { employment_status: "active", full_name: "Karim Fathy", hr_id: "B-118", is_active: true, job_title: "District Manager" },
      { employment_status: "active", full_name: "Omar Gawish", hr_id: "B-10", is_active: true, job_title: "HR Manager" },
      { employment_status: "active", full_name: "Second Admin", hr_id: "B-11", is_active: true, job_title: "System Administrator" },
    ],
    v2_vacation_approval_steps: [
      step("step-mgr", "manager_level_1", 1, "B-118", atHr ? "approved" : "pending"),
      step("step-hr-b10", "hr", 2, "B-10", "pending"),
      step("step-hr-b11", "hr", 2, "B-11", "pending"),
    ],
    v2_vacation_request_events: [],
    v2_vacation_requests: [
      request({
        duration_days: 2,
        end_date: "2026-12-07",
        id: REQUEST_ID,
        manager_decision: atHr ? "approved" : null,
        manager_decision_at: atHr ? "2026-11-18T12:00:00+00:00" : null,
        manager_decision_by_hr_id: atHr ? "B-118" : null,
        request_code: "VAC-0900",
        start_date: "2026-12-06",
        status: atHr ? "pending_hr" : "pending_manager",
        updated_at: atHr ? "2026-11-18T12:00:00+00:00" : SUBMITTED_AT,
        vacation_type: "annual",
      }),
      request({
        duration_days: 5,
        end_date: "2026-03-12",
        hr_decision: "approved",
        id: "22222222-2222-4333-8444-555555555555",
        paid_duration_days: 5,
        payment_status: "paid",
        request_code: "VAC-0801",
        start_date: "2026-03-08",
        status: "approved",
        updated_at: "2026-03-01T10:00:00+00:00",
        vacation_type: "annual",
      }),
    ],
    workflow_registry_modules: [
      {
        actions: [
          action("manager_approve", "pending_manager", "pending_hr", ["District Manager", "Super Admin"]),
          action("manager_reject", "pending_manager", "rejected", ["District Manager", "Super Admin"]),
          action("hr_approve", "pending_hr", "approved", ["Super Admin", "CEO"]),
          action("hr_reject", "pending_hr", "rejected", ["Super Admin", "CEO"]),
        ],
        created_at: "2026-01-01T00:00:00+00:00",
        created_by: "system",
        description: null,
        id: "wf-leave-requests",
        is_active: true,
        module_key: "leave_requests",
        module_name: "Leave requests",
        statuses: leaveStatuses.map((key) => ({ key, label: key })),
        updated_at: "2026-01-01T00:00:00+00:00",
        updated_by: "system",
        version: 1,
      },
    ],
  };
}

type VacationFault = "request_update" | "paid_update" | null;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * The two leave functions, statement by statement as the migrations write them, each run inside
 * `atomically` so a raise keeps nothing. `trace` records every statement that ran (outside the
 * transaction, so it survives the raise); the fault raises at the named statement, once.
 */
function vacationFunctions(trace: string[], faultBox: { fault: VacationFault }) {
  const raiseIf = (at: VacationFault) => {
    if (faultBox.fault !== at) return;
    faultBox.fault = null;
    trace.push(`${at} -> RAISED`);
    throw STATEMENT_TIMEOUT();
  };

  // phx_apply_vacation_step_decision
  function stepDecision(draft: Tables, args: Record<string, unknown>): Row {
    if (args.p_step_status !== "approved" && args.p_step_status !== "rejected") {
      throw new RpcRaise("22023", `A vacation step decision is approved or rejected, not "${String(args.p_step_status)}".`);
    }
    if (args.p_now == null) throw new RpcRaise("22023", "A vacation step decision needs its decision time.");
    const patch = args.p_request_patch as Row | null;
    if (patch != null) {
      if (typeof patch !== "object" || Array.isArray(patch)) throw new RpcRaise("22023", "A vacation request patch must be an object.");
      const unknown = Object.keys(patch).find((key) => !VACATION_PATCH_COLUMNS.includes(key));
      if (unknown) throw new RpcRaise("22023", `A vacation decision cannot change "${unknown}".`);
    }
    const request = draft.v2_vacation_requests.find((row) => row.id === args.p_request_id);
    if (!request) throw new RpcRaise("P0002", "Vacation request was not found.");
    trace.push("lock request");
    if (request.status !== args.p_expected_status) {
      throw new RpcRaise("40001", "Vacation request was updated by another user. Refresh and try again.");
    }
    const overriddenBy = args.p_overridden_by_hr_id ? String(args.p_overridden_by_hr_id) : null;
    const decided = draft.v2_vacation_approval_steps.find(
      (row) => row.id === args.p_step_id && row.request_id === args.p_request_id && row.status === "pending",
    );
    if (!decided) {
      const exists = draft.v2_vacation_approval_steps.some((row) => row.id === args.p_step_id && row.request_id === args.p_request_id);
      if (exists) throw new RpcRaise("55000", "This vacation approval step was already decided.");
      throw new RpcRaise("22023", "This vacation approval step does not belong to this request.");
    }
    Object.assign(decided, {
      decided_at: args.p_now,
      decision_comment: args.p_decision_comment ?? null,
      overridden_at: overriddenBy ? args.p_now : null,
      overridden_by_hr_id: overriddenBy,
      status: args.p_step_status,
      updated_at: args.p_now,
    });
    trace.push(`decide step ${String(decided.id)}`);
    if (decided.step_key === "hr") {
      for (const sibling of draft.v2_vacation_approval_steps) {
        if (sibling.request_id !== args.p_request_id || sibling.step_key !== "hr" || sibling.status !== "pending" || sibling.id === args.p_step_id) continue;
        Object.assign(sibling, {
          decided_at: args.p_now,
          decision_comment: `Auto-completed: HR step already decided by ${String(args.p_actor_hr_id ?? "another HR/Super Admin account")}.`,
          status: args.p_step_status,
          updated_at: args.p_now,
        });
        trace.push(`close HR sibling ${String(sibling.id)}`);
      }
    }
    if (patch == null) return { ...request };
    raiseIf("request_update");
    Object.assign(request, patch);
    trace.push("move request");
    return { ...request };
  }

  // phx_apply_vacation_paid_approval (20260915210000), unchanged by the wrapper.
  function paidApproval(draft: Tables, args: Record<string, unknown>): Row {
    const request = draft.v2_vacation_requests.find((row) => row.id === args.p_request_id);
    if (!request) throw new RpcRaise("P0002", "Vacation request was not found.");
    if (request.status !== args.p_expected_status) {
      throw new RpcRaise("40001", "Vacation request was updated by another user. Refresh and try again.");
    }
    const employee = String(request.employee_hr_id).toLowerCase();
    const periodStart = String(args.p_period_start);
    const periodEnd = String(args.p_period_end);
    const annualPool = (type: unknown) => type === "annual" || type === "emergency";
    let used = draft.v2_vacation_requests
      .filter(
        (row) =>
          String(row.employee_hr_id).toLowerCase() === employee &&
          row.status === "approved" &&
          row.id !== args.p_request_id &&
          String(row.start_date) >= periodStart &&
          String(row.start_date) < periodEnd &&
          (annualPool(args.p_vacation_type) ? annualPool(row.vacation_type) : row.vacation_type === args.p_vacation_type),
      )
      .reduce((sum, row) => sum + Number(row.paid_duration_days ?? 0), 0);
    if (annualPool(args.p_vacation_type)) {
      used += (draft.attendance_annual_balance_charges ?? [])
        .filter((row) => String(row.employee_hr_id).toLowerCase() === employee && String(row.work_date) >= periodStart && String(row.work_date) < periodEnd)
        .reduce((sum, row) => sum + Number(row.days ?? 0), 0);
    }
    used = round2(used);
    const entitlement = Number(args.p_entitlement_days);
    const duration = Number(args.p_duration_days);
    const balanceBefore = round2(Math.max(0, entitlement - used));
    const paid = round2(Math.min(duration, Math.max(0, balanceBefore)));
    const unpaid = round2(Math.max(0, duration - paid));
    const balanceAfter = round2(Math.max(0, balanceBefore - paid));
    const paymentStatus = unpaid > 0 && paid > 0 ? "partial" : unpaid > 0 ? "unpaid" : "paid";
    raiseIf("paid_update");
    const hr = args.p_step === "hr";
    Object.assign(request, {
      balance_after_days: balanceAfter,
      balance_before_days: balanceBefore,
      entitlement_days: round2(entitlement),
      paid_duration_days: paid,
      payment_status: paymentStatus,
      period_end: periodEnd,
      period_start: periodStart,
      status: args.p_next_status,
      unpaid_duration_days: unpaid,
      unpaid_reason: unpaid > 0 ? "insufficient_balance" : null,
      updated_at: args.p_now,
      used_paid_days: used,
      ...(hr
        ? { hr_decision: "approved", hr_decision_at: args.p_now, hr_decision_by_hr_id: args.p_decision_by_hr_id, hr_decision_comment: args.p_decision_comment }
        : { manager_decision: "approved", manager_decision_at: args.p_now, manager_decision_by_hr_id: args.p_decision_by_hr_id, manager_decision_comment: args.p_decision_comment }),
    });
    trace.push("pay and move request");
    return { ...request };
  }

  return {
    phx_apply_vacation_paid_approval_with_step: (args: Record<string, unknown>, tables: Tables) =>
      atomically(tables, (draft) => {
        stepDecision(draft, {
          p_actor_hr_id: args.p_decision_by_hr_id,
          p_decision_comment: args.p_decision_comment,
          p_expected_status: args.p_expected_status,
          p_now: args.p_now,
          p_overridden_by_hr_id: args.p_overridden_by_hr_id,
          p_request_id: args.p_request_id,
          p_request_patch: null,
          p_step_id: args.p_step_id,
          p_step_status: "approved",
        });
        const row = paidApproval(draft, args);
        if (row.id == null) throw new RpcRaise("40001", "Vacation request was updated by another user. Refresh and try again.");
        return { body: row, status: 200 };
      }),
    phx_apply_vacation_step_decision: (args: Record<string, unknown>, tables: Tables) =>
      atomically(tables, (draft) => ({ body: stepDecision(draft, args), status: 200 })),
  };
}

const districtManager = () => createAccessContext({ hrId: "B-118", loginId: "karim.fathy", role: "District Manager", source: "session" });
const superAdmin = (hrId: "B-10" | "B-11") => createAccessContext({ hrId, loginId: `admin.${hrId.toLowerCase()}`, role: "Super Admin", source: "session" });

const decisionAudits = (tables: Tables) => tables.audit_logs.filter((row) => row.entity_type === "vacation_request");
const decisionEvents = (tables: Tables) => tables.v2_vacation_request_events.filter((row) => String(row.event_type).startsWith("approval_"));

async function leaveStepDecisionRollsBack(): Promise<void> {
  // HR (B-10) rejects at the HR step. The function decides B-10's step, closes B-11's sibling step,
  // and is then made to fail on the request update: both step writes must roll back.
  const tables = vacationTables(true);
  const before = snapshot(tables);
  const trace: string[] = [];
  await withStandIn({ rpc: vacationFunctions(trace, { fault: "request_update" }), tables }, async (seen) => {
    let refusal: unknown = null;
    let decided: unknown = null;
    try {
      decided = await decideVacationRequest(superAdmin("B-10"), {
        decision: "reject",
        decisionComment: "The dates clash with the cycle meeting.",
        requestId: REQUEST_ID,
      });
    } catch (error) {
      refusal = error;
    }
    await settle();
    assert.equal(decided, null, "(a) leave step: a decision whose request update failed must not hand back a decided request");
    assert.ok(refusal instanceof Error, "(a) leave step: the approver is refused when the function raises after deciding the step");
    assert.equal((refusal as Error).message, "canceling statement due to statement timeout", "(a) leave step: the refusal carries the database's own reason");
    assert.ok(!(refusal instanceof ApiError && refusal.status === 409), "(a) leave step: a database failure is not dressed up as a lost race (409)");
    assert.deepEqual(
      trace,
      ["lock request", "decide step step-hr-b10", "close HR sibling step-hr-b11", "request_update -> RAISED"],
      "(a) leave step: the forced raise came AFTER the function's first write (the approver's step) and the sibling close",
    );
    assert.equal(rpcCalls(seen, "phx_apply_vacation_step_decision").length, 1, "(a) leave step: the step and the request travel in one call");
    assert.deepEqual(tableWrites(seen), [], "(a) leave step: after the refusal the app writes NOTHING — no event, no audit row, no notice to anyone");
    assert.deepEqual(
      stored(tables).v2_vacation_approval_steps,
      before.v2_vacation_approval_steps,
      "(a) leave step: HEADLINE — no step is left decided against a request that never moved (F-HR-010)",
    );
    assert.deepEqual(stored(tables), stored(before), "(a) leave step: every table afterwards equals the tables before");
  });
}

async function leavePaidApprovalRollsBack(): Promise<void> {
  // HR (B-10) gives the final approval, which prices the leave against the balance. The wrapper decides
  // the step and closes the sibling, then the paid approval is made to fail at its request update.
  const tables = vacationTables(true);
  const before = snapshot(tables);
  const trace: string[] = [];
  await withStandIn({ rpc: vacationFunctions(trace, { fault: "paid_update" }), tables }, async (seen) => {
    let refusal: unknown = null;
    let decided: unknown = null;
    try {
      decided = await decideVacationRequest(superAdmin("B-10"), { decision: "approve", requestId: REQUEST_ID });
    } catch (error) {
      refusal = error;
    }
    await settle();
    assert.equal(decided, null, "(a) leave paid: a final approval whose balance write failed must not hand back an approved request");
    assert.ok(refusal instanceof Error, "(a) leave paid: the approver is refused when the paid approval raises after the step was decided");
    assert.ok(!(refusal instanceof ApiError && refusal.status === 409), "(a) leave paid: a database failure is not dressed up as a lost race (409)");
    assert.equal(rpcCalls(seen, "phx_apply_vacation_paid_approval_with_step").length, 1, "(a) leave paid: the final approval goes through the paid wrapper");
    assert.deepEqual(
      trace,
      ["lock request", "decide step step-hr-b10", "close HR sibling step-hr-b11", "paid_update -> RAISED"],
      "(a) leave paid: the forced raise came AFTER the wrapper's first write (the approver's step) and the sibling close",
    );
    assert.deepEqual(tableWrites(seen), [], "(a) leave paid: after the refusal the app writes NOTHING — no event, no audit row, no notice to anyone");
    assert.deepEqual(stored(tables), stored(before), "(a) leave paid: every table afterwards equals the tables before — no step decided, no balance consumed");
  });
}

async function leaveManagerDoubleApproval(): Promise<void> {
  // The District Manager's Approve arrives twice at once (two tabs, or a double press on a slow line).
  const tables = vacationTables(false);
  const trace: string[] = [];
  await withStandIn({ rpc: vacationFunctions(trace, { fault: null }), tables }, async (seen) => {
    releaseTogether("phx_apply_vacation_step_decision", 2);
    const results = await Promise.allSettled([
      decideVacationRequest(districtManager(), { decision: "approve", requestId: REQUEST_ID }),
      decideVacationRequest(districtManager(), { decision: "approve", requestId: REQUEST_ID }),
    ]);
    await settle();
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    assert.equal(rpcCalls(seen, "phx_apply_vacation_step_decision").length, 2, "(b) leave manager: both approvals reached the database function");
    assert.equal(fulfilled.length, 1, "(b) leave manager: HEADLINE — exactly one of two simultaneous approvals of the same step succeeds");
    assert.equal(rejected.length, 1, "(b) leave manager: and exactly one is refused");
    assert.ok(rejected[0] instanceof ApiError, "(b) leave manager: the losing approval is an ApiError the route can answer");
    assert.equal((rejected[0] as ApiError).status, 409, "(b) leave manager: the losing approval is the Conflict (409) the code promises, never a 500");
    assert.equal((rejected[0] as ApiError).code, "vacation_decision_conflict", "(b) leave manager: with the leave conflict code");
    assert.match((rejected[0] as ApiError).message, /updated by another user/, "(b) leave manager: and the function's own sentence");

    const request = tables.v2_vacation_requests.find((row) => row.id === REQUEST_ID)!;
    assert.equal(request.status, "pending_hr", "(b) leave manager: the request moved on exactly once, to HR");
    assert.equal(request.manager_decision_by_hr_id, "B-118", "(b) leave manager: recording the manager's decision once");
    const managerStep = tables.v2_vacation_approval_steps.find((row) => row.id === "step-mgr")!;
    assert.equal(managerStep.status, "approved", "(b) leave manager: the manager's step is decided");
    assert.equal(
      tables.v2_vacation_approval_steps.filter((row) => row.step_key === "hr" && row.status === "pending").length,
      2,
      "(b) leave manager: both HR steps are still waiting — nothing was decided twice or skipped",
    );
    assert.equal(decisionEvents(tables).length, 1, "(b) leave manager: one approval event on the request's timeline, not two");
    assert.equal(decisionAudits(tables).length, 1, "(b) leave manager: one decision audit row, not two");
  });
}

async function leaveTwoAdminsFinalApproval(): Promise<void> {
  // Both Super Admins hold an HR step and press Approve on the same request at the same moment. HR is
  // one authority: one approval prices the leave against the balance, the other is refused.
  const tables = vacationTables(true);
  const trace: string[] = [];
  await withStandIn({ rpc: vacationFunctions(trace, { fault: null }), tables }, async (seen) => {
    releaseTogether("phx_apply_vacation_paid_approval_with_step", 2);
    const results = await Promise.allSettled([
      decideVacationRequest(superAdmin("B-10"), { decision: "approve", requestId: REQUEST_ID }),
      decideVacationRequest(superAdmin("B-11"), { decision: "approve", requestId: REQUEST_ID }),
    ]);
    await settle();
    const winners = results.flatMap((result, index) => (result.status === "fulfilled" ? [index] : []));
    const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    assert.equal(rpcCalls(seen, "phx_apply_vacation_paid_approval_with_step").length, 2, "(b) leave paid: both final approvals reached the database function");
    assert.equal(winners.length, 1, "(b) leave paid: HEADLINE — exactly one of two simultaneous final approvals succeeds");
    assert.equal(rejected.length, 1, "(b) leave paid: and exactly one is refused");
    assert.ok(rejected[0] instanceof ApiError, "(b) leave paid: the losing approval is an ApiError the route can answer");
    assert.equal((rejected[0] as ApiError).status, 409, "(b) leave paid: the losing approval is the Conflict (409) the code promises");
    assert.equal((rejected[0] as ApiError).code, "vacation_decision_conflict", "(b) leave paid: with the leave conflict code");

    const winnerHrId = winners[0] === 0 ? "B-10" : "B-11";
    const loserHrId = winnerHrId === "B-10" ? "B-11" : "B-10";
    const request = tables.v2_vacation_requests.find((row) => row.id === REQUEST_ID)!;
    assert.equal(request.status, "approved", "(b) leave paid: the request is approved once");
    assert.equal(request.hr_decision_by_hr_id, winnerHrId, "(b) leave paid: by the winner, never overwritten by the loser");
    assert.deepEqual(
      [request.payment_status, request.used_paid_days, request.balance_before_days, request.paid_duration_days, request.balance_after_days],
      ["paid", 5, 16, 2, 14],
      "(b) leave paid: the balance is consumed exactly once — 5 used before, 16 left, 2 paid, 14 after",
    );
    const winnerStep = tables.v2_vacation_approval_steps.find((row) => row.approver_hr_id === winnerHrId && row.step_key === "hr")!;
    const loserStep = tables.v2_vacation_approval_steps.find((row) => row.approver_hr_id === loserHrId && row.step_key === "hr")!;
    assert.equal(winnerStep.status, "approved", "(b) leave paid: the winner's HR step is decided");
    assert.equal(
      loserStep.decision_comment,
      `Auto-completed: HR step already decided by ${winnerHrId}.`,
      "(b) leave paid: the loser's HR step is closed by the winner's decision, never decided again by the loser",
    );
    assert.equal(decisionEvents(tables).length, 1, "(b) leave paid: one approval event on the request's timeline, not two");
    assert.equal(decisionAudits(tables).length, 1, "(b) leave paid: one decision audit row, not two");
  });
}

export async function runHrDecisionsRollbackAndRaceTests(): Promise<void> {
  await retentionCreateRollsBack();
  await retentionUpdateRollsBack();
  await retentionUpdateRace();
  await leaveStepDecisionRollsBack();
  await leavePaidApprovalRollsBack();
  await leaveManagerDoubleApproval();
  await leaveTwoAdminsFinalApproval();
}
