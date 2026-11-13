import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ApiError } from "../src/lib/http/api-errors.ts";
import { createRetentionConversation, updateRetentionConversation } from "../src/lib/retention/service.ts";
import { vacationDecisionWriteError } from "../src/lib/vacation/service.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// Enterprise audit, 13 Nov 2026 — two HR writes that could half-land.
//
// F-HR-011 (retention): a conversation's confidential themes were replaced by a DELETE of every row
// and then an INSERT of the new set, two calls, after a third call that updated the conversation
// with no compare-and-set. A failure between the delete and the insert lost the themes for good.
//
// F-HR-010 (leave): the approver's step row was decided, and its HR siblings closed, with their own
// calls BEFORE the request moved. When the request's status compare-and-set then missed, the step
// stayed decided and the request stood still — an approval recorded against a request still
// waiting on that approver.
//
// Both are now one database function each, one transaction: everything commits or nothing does —
// creating a retention conversation and deciding a Sick-leave step included (risk review, round 2).
// A lost compare-and-set answers 409, and the retention screen sends the version it loaded.

const RETENTION_MIGRATION = "supabase/migrations/20261113161724_retention_themes_replace_atomic.sql";
const VACATION_MIGRATION = "supabase/migrations/20261113161725_vacation_step_and_request_atomic.sql";

function sql(path: string): string {
  return stripSqlComments(readFileSync(path, "utf8")).toLowerCase();
}

function ts(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/** The text of one SQL function, from its `create or replace function` to its closing `$$;`. */
function sqlFunction(source: string, name: string): string {
  const start = source.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `${name} must be created by its migration`);
  const bodyOpen = source.indexOf("$$", start);
  const bodyClose = source.indexOf("$$;", bodyOpen + 2);
  assert.ok(bodyOpen > start && bodyClose > bodyOpen, `${name} must have a $$ body`);
  return source.slice(start, bodyClose + 3);
}

/** One top-level TypeScript function, from its declaration to the next top-level declaration. */
function tsFunction(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} must exist — the test is pinning a function that was renamed or removed`);
  const rest = source.slice(start + declaration.length);
  const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s/);
  return source.slice(start, next === -1 ? source.length : start + declaration.length + next);
}

/** The text array literal `v_allowed constant text[] := array[...]` as a sorted list. */
function allowedColumns(fn: string, name: string): string[] {
  const match = fn.match(/v_allowed constant text\[\] := array\[([\s\S]*?)\];/);
  assert.ok(match, `${name} must carry its column whitelist as v_allowed`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

function assertLockedDown(source: string, signature: string) {
  assert.ok(
    source.includes(`revoke execute on function public.${signature} from public, anon, authenticated;`),
    `${signature} must revoke EXECUTE from public, anon AND authenticated — revoking only the last two is a no-op while PUBLIC holds it`,
  );
  assert.ok(
    source.includes(`grant execute on function public.${signature} to service_role;`),
    `${signature} must be re-granted to service_role — revoking PUBLIC strips it, and every route calls through the service-role client`,
  );
}

function assertDefinerWithPath(fn: string, name: string) {
  assert.match(fn, /security definer/, `${name} runs as its owner (RLS seals these tables)`);
  assert.match(fn, /set search_path = public/, `${name} pins its search_path, as every definer function must`);
}

type Captured = { method: string; path: string; body: unknown };

/**
 * Runs `body` against the REAL admin client with every request answered by `respond` instead of
 * sent: a stand-in project URL and key and a global fetch, both restored afterwards. The client memo
 * is keyed on URL and key, so nothing downstream keeps talking to the stand-in.
 */
async function withFakeSupabase(
  respond: (request: Captured) => Response,
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
    const request: Captured = {
      method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    return respond(request);
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

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

export async function runHrAtomicWritesTests() {
  // ── 1. F-HR-011 — the retention functions ──────────────────────────────────────────────────────
  const retentionSql = sql(RETENTION_MIGRATION);

  const replaceFn = sqlFunction(retentionSql, "phx_replace_retention_conversation_themes");
  assertDefinerWithPath(replaceFn, "phx_replace_retention_conversation_themes");
  assert.match(
    replaceFn,
    /from public\.hr_retention_conversations\s+where id = p_conversation_id\s+for update;/,
    "the themes replacement must lock the conversation row FOR UPDATE, so two editors cannot interleave",
  );
  const deleteAt = replaceFn.indexOf("delete from public.hr_retention_conversation_themes");
  const insertAt = replaceFn.indexOf("insert into public.hr_retention_conversation_themes (conversation_id, theme_key, sentiment, note)");
  assert.ok(
    deleteAt !== -1 && insertAt > deleteAt,
    "THE F-HR-011 FIX: the delete and the insert of the themes are inside ONE function — one transaction, so a failure between them rolls the delete back",
  );
  assertLockedDown(retentionSql, "phx_replace_retention_conversation_themes(uuid, jsonb)");

  const updateFn = sqlFunction(retentionSql, "phx_update_retention_conversation");
  assertDefinerWithPath(updateFn, "phx_update_retention_conversation");
  assert.match(
    updateFn,
    /from public\.hr_retention_conversations\s+where id = p_conversation_id\s+for update;/,
    "the conversation update must lock its row FOR UPDATE before the compare-and-set",
  );
  assert.match(
    updateFn,
    /if p_expected_updated_at is not null and v_row\.updated_at is distinct from p_expected_updated_at then\s+raise exception 'this conversation was changed by someone else/,
    "a conversation changed since the editor read it is refused with its own message, never overwritten",
  );
  assert.deepEqual(
    allowedColumns(updateFn, "phx_update_retention_conversation"),
    [
      "follow_up_action",
      "follow_up_done_at",
      "follow_up_due",
      "is_regrettable",
      "retention_risk",
      "summary",
      "updated_at",
      "would_rejoin",
    ],
    "the update may touch only the eight columns updateRetentionConversation builds — never who the conversation was with, its kind or its author",
  );
  assert.match(updateFn, /where key <> all \(v_allowed\)/, "a patch key outside the whitelist must be refused");
  assert.match(
    updateFn,
    /if p_themes is not null then\s+perform public\.phx_replace_retention_conversation_themes\(p_conversation_id, p_themes\);/,
    "the themes are replaced inside the SAME call as the conversation update — they commit together",
  );
  assertLockedDown(retentionSql, "phx_update_retention_conversation(uuid, jsonb, jsonb, timestamptz)");

  // The create function: conversation and themes in ONE transaction (round 2 of the risk review).
  const createFn = sqlFunction(retentionSql, "phx_create_retention_conversation");
  assertDefinerWithPath(createFn, "phx_create_retention_conversation");
  const createInsertAt = createFn.indexOf("insert into public.hr_retention_conversations (");
  const createThemesAt = createFn.indexOf("perform public.phx_replace_retention_conversation_themes(v_id, coalesce(p_themes, '[]'::jsonb));");
  assert.ok(
    createInsertAt !== -1 && createThemesAt > createInsertAt,
    "creating a conversation inserts it AND its themes inside ONE function — a failure leaves nothing, so a retry never duplicates",
  );
  assert.match(createFn, /where key <> all \(v_allowed\)/, "a create key outside the whitelist must be refused");
  assertLockedDown(retentionSql, "phx_create_retention_conversation(jsonb, jsonb)");

  // ── 2. F-HR-011 — the retention service calls them, and no longer writes piece by piece ───────
  const retentionService = ts("src/lib/retention/service.ts");
  assert.doesNotMatch(
    retentionService,
    /\.from\("hr_retention_conversation_themes"\)\s*\.(?:delete|insert)\(/,
    "the service must never again delete or insert themes with its own separate calls",
  );
  assert.doesNotMatch(
    retentionService,
    /\.from\("hr_retention_conversations"\)\s*\.(?:insert|update)\(/,
    "the service must never again insert or update a conversation with its own separate call",
  );
  const createService = tsFunction(retentionService, "export async function createRetentionConversation(");
  assert.match(createService, /\.rpc\("phx_create_retention_conversation"/, "the create path must go through the atomic function");
  const createKeys = createService.slice(createService.indexOf("p_conversation: {"), createService.indexOf("p_themes: themeRows(themes)"));
  assert.deepEqual(
    allowedColumns(createFn, "phx_create_retention_conversation"),
    [...createKeys.matchAll(/^\s+([a-z_]+)[:,]/gm)].map((m) => m[1]).sort(),
    "the create whitelist must equal the columns createRetentionConversation builds — no more, no fewer",
  );
  assert.ok(
    createService.indexOf('rpc("phx_create_retention_conversation"') < createService.indexOf("writeRequiredAuditLog("),
    "the create audit row is written only after the atomic create succeeded",
  );
  const updateService = tsFunction(retentionService, "export async function updateRetentionConversation(");
  assert.match(updateService, /\.rpc\("phx_update_retention_conversation"/, "the update path must go through the atomic function");
  assert.match(
    updateService,
    /p_expected_updated_at: expectedUpdatedAt \?\? current\.updated_at \?\? null/,
    "the compare-and-set uses the version the editor's SCREEN loaded, and the server's read only when none was sent",
  );
  assert.ok(
    updateService.indexOf('rpc("phx_update_retention_conversation"') < updateService.indexOf("writeRequiredAuditLog("),
    "the audit row is written only after the atomic update succeeded",
  );

  // The screen sends the version it loaded; the dashboard read carries it.
  const workspace = ts("src/components/retention/retention-workspace.tsx");
  assert.match(
    workspace,
    /body: JSON\.stringify\(\{ conversation: \{ id, followUpDone: done, expectedUpdatedAt \} \}\)/,
    "the retention screen must send the updatedAt it loaded with every edit",
  );
  assert.equal(
    (workspace.match(/[mM]arkFollowUp\(conversation\.id, !conversation\.followUpDoneAt, conversation\.updatedAt\)/g) ?? []).length,
    2,
    "both follow-up buttons pass the conversation's loaded version",
  );
  const dashboardRead = tsFunction(retentionService, "export async function getRetentionDashboardData(");
  assert.match(dashboardRead, /follow_up_done_at,created_at,updated_at"/, "the dashboard read carries updated_at to the screen");
  assert.match(dashboardRead, /updatedAt: row\.updated_at,/);

  // A lost compare-and-set is 409, never 500.
  const retentionRoute = ts("app/api/retention/route.ts");
  assert.match(
    retentionRoute,
    /if \(error instanceof ApiError && \(error\.status === 409 \|\| error\.status === 400\)\) \{\s+return \{ message: error\.message, status: error\.status \};/,
    "the retention route answers a lost compare-and-set with 409 (and a malformed version with 400)",
  );

  // ── 3. F-HR-011 — the real service against a fake database ────────────────────────────────────
  const conversationId = "6f0c5d4e-1111-4222-8333-944455566677";
  const serverReadUpdatedAt = "2026-11-13T09:20:00.000001+00:00";
  const screenLoadedUpdatedAt = "2026-11-13T09:15:42.123456+00:00";
  const conflictBody = {
    code: "40001",
    message: "This conversation was changed by someone else since you opened it. Reload it and try again.",
    details: null,
    hint: null,
  };
  const conversationRow = {
    id: conversationId,
    kind: "stay",
    employee_name: "Test Person",
    retention_risk: "low",
    is_regrettable: null,
    would_rejoin: null,
    follow_up_action: null,
    follow_up_due: null,
    follow_up_done_at: null,
    updated_at: serverReadUpdatedAt,
  };
  const route = (request: Captured) => `${request.method} ${request.path.replace(/^\/rest\/v1/, "")}`;

  // 3a. The update is refused (40001): the service throws a 409, and nothing is written after it.
  let refused: unknown = null;
  const requests = await withFakeSupabase(
    (request) => {
      if (request.method === "GET" && request.path.endsWith("/hr_retention_conversations")) return json(200, conversationRow);
      if (request.path.endsWith("/rpc/phx_update_retention_conversation")) return json(400, conflictBody);
      return json(201, {});
    },
    async () => {
      try {
        await updateRetentionConversation(
          {
            id: conversationId,
            summary: "Talked about the new route.",
            themes: [{ themeKey: "pay", sentiment: "driver", note: "  fair  " }],
            expectedUpdatedAt: screenLoadedUpdatedAt,
          },
          "test-actor",
        );
      } catch (error) {
        refused = error;
      }
    },
  );
  assert.ok(
    refused instanceof ApiError && refused.status === 409,
    "THE 409: a retention save that lost its compare-and-set must throw a 409 conflict, never a plain error the route answers 500",
  );
  assert.match((refused as Error).message, /changed by someone else/, "the conflict keeps the function's own sentence");
  assert.deepEqual(
    requests.map(route),
    ["GET /hr_retention_conversations", "POST /rpc/phx_update_retention_conversation"],
    "a refused update writes NOTHING after it — no separate theme call and no audit row",
  );
  const rpcBody = requests[1].body as Record<string, unknown>;
  assert.equal(rpcBody.p_conversation_id, conversationId);
  assert.equal(
    rpcBody.p_expected_updated_at,
    screenLoadedUpdatedAt,
    "the compare-and-set carries the version the SCREEN loaded, not the server's own fresher read",
  );
  assert.deepEqual(rpcBody.p_themes, [{ theme_key: "pay", sentiment: "driver", note: "fair" }], "themes travel in the same call, normalised");
  assert.deepEqual(
    Object.keys(rpcBody.p_patch as Record<string, unknown>).sort(),
    ["summary", "updated_at"],
    "the patch carries only the fields the editor changed",
  );

  // 3b. An older client that sends no version falls back to the server's read.
  const fallbackRequests = await withFakeSupabase(
    (request) => {
      if (request.method === "GET" && request.path.endsWith("/hr_retention_conversations")) return json(200, conversationRow);
      if (request.path.endsWith("/rpc/phx_update_retention_conversation")) return json(400, conflictBody);
      return json(201, {});
    },
    async () => {
      await updateRetentionConversation({ id: conversationId, followUpDone: true }, "test-actor").catch(() => undefined);
    },
  );
  assert.equal(
    (fallbackRequests[1]?.body as Record<string, unknown> | undefined)?.p_expected_updated_at,
    serverReadUpdatedAt,
    "with no version from the screen, the server's own read is the expected value",
  );

  // 3c. A malformed version is refused (400) before anything is read or written.
  let malformed: unknown = null;
  const malformedRequests = await withFakeSupabase(
    () => json(201, {}),
    async () => {
      try {
        await updateRetentionConversation({ id: conversationId, followUpDone: true, expectedUpdatedAt: "yesterday-ish" }, "test-actor");
      } catch (error) {
        malformed = error;
      }
    },
  );
  assert.ok(malformed instanceof ApiError && malformed.status === 400, "a version that is not a timestamp is a 400");
  assert.equal(malformedRequests.length, 0, "a malformed version reaches no table");

  // 3d. Creating: the function fails, the service throws, and no audit row is written.
  let createFailed: unknown = null;
  const createRequests = await withFakeSupabase(
    (request) => {
      if (request.method === "GET" && request.path.endsWith("/employees")) {
        return json(200, { hr_id: "B-200", full_name: "Test Person", nickname: null, job_title: "Medical Representative" });
      }
      if (request.path.endsWith("/rpc/phx_create_retention_conversation")) {
        return json(409, { code: "23505", message: "duplicate theme", details: null, hint: null });
      }
      return json(201, {});
    },
    async () => {
      try {
        await createRetentionConversation(
          {
            kind: "stay",
            employeeHrId: "B-200",
            conductedOn: "2026-11-13",
            summary: "Talked about the new route.",
            retentionRisk: "low",
            themes: [{ themeKey: "pay", sentiment: "driver" }],
          },
          "test-actor",
        );
      } catch (error) {
        createFailed = error;
      }
    },
  );
  assert.ok(createFailed instanceof Error, "a failed create must throw");
  assert.deepEqual(
    createRequests.map(route),
    ["GET /employees", "POST /rpc/phx_create_retention_conversation"],
    "a failed create writes NOTHING after it — no theme call and no audit row",
  );
  const createBody = createRequests[1].body as Record<string, unknown>;
  assert.deepEqual(createBody.p_themes, [{ theme_key: "pay", sentiment: "driver", note: null }], "the themes travel in the same call as the conversation");

  // ── 4. F-HR-010 — the leave function ───────────────────────────────────────────────────────────
  const vacationSql = sql(VACATION_MIGRATION);
  const stepFn = sqlFunction(vacationSql, "phx_apply_vacation_step_decision");
  assertDefinerWithPath(stepFn, "phx_apply_vacation_step_decision");
  const lockAt = stepFn.indexOf("select * into v_row from public.v2_vacation_requests where id = p_request_id for update;");
  const stepWriteAt = stepFn.indexOf("update public.v2_vacation_approval_steps set");
  const requestWriteAt = stepFn.indexOf("update public.v2_vacation_requests set");
  assert.ok(lockAt !== -1, "the leave function must lock the request row FOR UPDATE");
  assert.ok(
    lockAt < stepWriteAt && stepWriteAt < requestWriteAt,
    "THE F-HR-010 FIX: lock the request, then decide the step, then move the request — all inside ONE function",
  );
  assert.match(
    stepFn,
    /if v_row\.status is distinct from p_expected_status then\s+raise exception 'vacation request was updated by another user\. refresh and try again\.'\s+using errcode = '40001';/,
    "a request whose status moved is refused BEFORE the step is touched",
  );
  assert.match(
    stepFn,
    /decided_at = p_now,\s+decision_comment = p_decision_comment,\s+overridden_at = case when v_overridden_by is not null then p_now else null end,\s+overridden_by_hr_id = v_overridden_by,\s+status = p_step_status,\s+updated_at = p_now\s+where id = p_step_id\s+and request_id = p_request_id\s+and status = 'pending'/,
    "the step write reproduces the old recordVacationApprovalStepDecision exactly — the same six columns and the pending compare-and-set",
  );
  assert.match(stepFn, /'this vacation approval step was already decided\.' using errcode = '55000'/, "a step already decided is its own refusal");
  assert.match(
    stepFn,
    /if v_step_key = 'hr' then\s+update public\.v2_vacation_approval_steps set\s+decided_at = p_now,\s+decision_comment = 'auto-completed: hr step already decided by '\s+\|\| coalesce\(p_actor_hr_id, 'another hr\/super admin account'\) \|\| '\.',\s+status = p_step_status,\s+updated_at = p_now\s+where request_id = p_request_id\s+and step_key = 'hr'\s+and status = 'pending'\s+and id <> p_step_id;/,
    "the HR siblings close exactly as the old closeSiblingPendingHrApprovalSteps closed them — same columns, same comment",
  );
  assert.match(stepFn, /where key <> all \(v_allowed\)/, "a request patch key outside the whitelist must be refused");
  assertLockedDown(vacationSql, "phx_apply_vacation_step_decision(uuid, text, uuid, text, text, text, text, timestamptz, jsonb)");

  // The SQL whitelist is exactly the set of columns the two decision paths build — read from them.
  const vacationService = ts("src/lib/vacation/service.ts");
  const sequential = tsFunction(vacationService, "async function applyVacationDecisionSequential(");
  const sick = tsFunction(vacationService, "async function applyVacationDecisionLegacy(");
  const payloadColumns = (fn: string, name: string) => {
    const start = fn.indexOf("const updatePayload: Record<string, unknown> = {");
    const end = fn.indexOf('rpc("phx_apply_vacation_step_decision"', start);
    assert.ok(start !== -1 && end > start, `${name} must build updatePayload and then call the atomic function`);
    const slice = fn.slice(start, end);
    const columns = new Set<string>();
    for (const m of slice.matchAll(/updatePayload\.([a-z_]+) =/g)) columns.add(m[1]);
    for (const m of slice.matchAll(/^\s+([a-z_]+):/gm)) columns.add(m[1]);
    return columns;
  };
  const builtColumns = new Set([
    ...payloadColumns(sequential, "applyVacationDecisionSequential"),
    ...payloadColumns(sick, "applyVacationDecisionLegacy (Sick leave)"),
  ]);
  assert.deepEqual(
    allowedColumns(stepFn, "phx_apply_vacation_step_decision"),
    [...builtColumns].sort(),
    "the SQL whitelist must equal the columns the sequential and Sick-leave decisions build — no more, no fewer",
  );

  // The paid branch: the step part runs first, then the UNCHANGED paid RPC, in one transaction.
  const paidFn = sqlFunction(vacationSql, "phx_apply_vacation_paid_approval_with_step");
  assertDefinerWithPath(paidFn, "phx_apply_vacation_paid_approval_with_step");
  const paidStepAt = paidFn.indexOf("perform public.phx_apply_vacation_step_decision(");
  const paidRpcAt = paidFn.indexOf("from public.phx_apply_vacation_paid_approval(");
  assert.ok(paidStepAt !== -1 && paidRpcAt > paidStepAt, "the paid wrapper decides the step, then runs the paid approval, in the same function");
  assert.match(paidFn, /'approved',\s+p_decision_comment,\s+p_overridden_by_hr_id,\s+p_decision_by_hr_id,\s+p_now,\s+null\s+\);/, "the paid wrapper's step part touches no request column itself (null patch)");
  assert.doesNotMatch(
    vacationSql,
    /create or replace function public\.phx_apply_vacation_paid_approval\(/,
    "the paid-balance RPC and its balance logic are NOT redefined here",
  );
  assertLockedDown(
    vacationSql,
    "phx_apply_vacation_paid_approval_with_step(uuid, text, uuid, text, text, text, text, text, timestamptz, numeric, date, date, numeric, text)",
  );

  // ── 5. F-HR-010 — no leave path writes a step on its own any more ─────────────────────────────
  assert.doesNotMatch(
    vacationService,
    /recordVacationApprovalStepDecision|closeSiblingPendingHrApprovalSteps/,
    "THE F-HR-010 FIX: the separate step writers are gone — no decision path can decide a step before its request moves",
  );
  assert.doesNotMatch(
    vacationService,
    /\.from\(vacationApprovalStepsTable\)\s*\.update\(\{\s*decided_at: now/,
    "no step row is decided by a separate update anywhere in the service (resubmission's reset to pending is not a decision)",
  );
  for (const [fn, name] of [[sequential, "applyVacationDecisionSequential"], [sick, "applyVacationDecisionLegacy (Sick leave)"]] as const) {
    assert.doesNotMatch(fn, /\.from\(vacationRequestsTable\)\s*\.update\(/, `${name} must not move the request with its own update outside the function`);
    assert.match(
      fn,
      /\.rpc\("phx_apply_vacation_step_decision", \{[\s\S]*?p_step_id: step\.id,[\s\S]*?p_request_patch: updatePayload,\s+\}\);\s+if \(error\) throw vacationDecisionWriteError\(error\);/,
      `${name} decides the step and moves the request in one call, and throws before anything else is written`,
    );
    const atomicAt = fn.indexOf('rpc("phx_apply_vacation_step_decision"');
    const eventAt = fn.indexOf("eventType: `approval_${step.stepKey}_${decisionValue}`");
    const auditAt = fn.indexOf("await writeRequiredAuditLog(");
    assert.ok(eventAt !== -1 && auditAt !== -1, `${name}: the decision event and its audit row must still be written`);
    assert.ok(atomicAt < eventAt && atomicAt < auditAt, `${name}: the event and the audit row follow the atomic write — a refused decision records neither`);
  }
  assert.match(
    sick,
    /p_step_status: decisionValue,\s+p_decision_comment: nullableText\(input\.decisionComment\),\s+p_overridden_by_hr_id: null,\s+p_actor_hr_id: input\.actorHrId \?\? null,/,
    "Sick leave hands the function the same step values the old writer stored (comment through nullableText, no override)",
  );
  assert.match(
    sick,
    /const stepsAfterDecision = steps\.map\(\(candidate\) =>\s+candidate\.id === step\.id \? \{ \.\.\.candidate, status: decisionValue \} : candidate\s+\);/,
    "Sick leave's finality rules read the step as it will be once the call commits",
  );
  assert.match(sequential, /\.rpc\("phx_apply_vacation_paid_approval_with_step", \{[\s\S]*?p_step_id: step\.id,/, "the paid branch writes its step inside the same transaction as the paid approval");
  assert.match(
    sequential,
    /const stepOverriddenByHrId = overrideContext \? hrIdForStorage\(input\.actorHrId\) \|\| null : null;/,
    "the override column is stored through hrIdForStorage",
  );
  assert.equal(
    (sequential.match(/if \(error\) throw vacationDecisionWriteError\(error\);/g) ?? []).length,
    2,
    "both sequential branches (paid and non-paid) map a lost race to a 409",
  );

  // ── 6. A lost race on a leave decision is 409, never 500 or 400 ────────────────────────────────
  for (const code of ["40001", "55000"]) {
    const mapped = vacationDecisionWriteError({ code, message: "Vacation request was updated by another user. Refresh and try again." });
    assert.ok(mapped instanceof ApiError && mapped.status === 409, `THE 409: SQLSTATE ${code} from the decision function must become a 409 conflict`);
    assert.equal(mapped.message, "Vacation request was updated by another user. Refresh and try again.", "the conflict keeps the function's own sentence");
  }
  const other = vacationDecisionWriteError({ code: "23514", message: "check constraint" });
  assert.ok(!(other instanceof ApiError), "any other database error stays a plain error");
  const decisionRoute = ts("app/api/vacations/requests/[id]/decision/route.ts");
  assert.match(
    decisionRoute,
    /if \(error instanceof ApiError && error\.status === 409\) \{\s+return NextResponse\.json\(\{ error: error\.code, message, success: false \}, \{ status: 409 \}\);/,
    "the decision route answers a lost race with 409",
  );
}
