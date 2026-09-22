import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  insertRecordConversationComment,
  RECORD_CONVERSATION_MAX_LENGTH,
} from "../src/lib/conversations/comments.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The record-level conversation — direct orders and marketing requests, open at ANY status.
//
// The owner, 2026-09-22: "I want to make the conversation option in direct orders and marketing
// requests at any status even if rejected, for everyone to know the reason and be clarified — every
// conversation action sends emails, Telegram and in-app." Asked who "everyone" is, he chose everyone
// on that request: the requester, their manager, and every approver/reviewer in that request's own
// chain — never a company-wide blast.
//
// The three properties this pins, because getting any one wrong reintroduces the bug he reported:
//   1. NO status gate. The old marketing "advisory comment" could be written only while a CC
//      reviewer's step was the active one, so a rejected/closed/cancelled request refused every
//      comment — which is exactly the case he needs to work. Neither conversation loader may gate on
//      the record's status.
//   2. The audience is the whole request. Every message is addressed To the requester, CCs the
//      chain, and is handed to the ONE shared notifier (conversations/notify.ts) that does the
//      email / Telegram / in-app fan-out — with the comment id as the per-message key, so a second
//      message is not deduplicated onto the first.
//   3. The store is append-only. A posted message is emailed out the instant it is written, so it
//      cannot be silently rewritten under a reader who already acted on it.
// ─────────────────────────────────────────────────────────────────────────────

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

/**
 * The body of the DEFINITION of `name`, up to the next top-level function declaration.
 *
 * Matches `function <name>(`, so it lands on the definition even when the function is CALLED before
 * it is defined (both notify helpers are — a bare indexOf would grab the call site and read empty).
 */
function functionBody(src: string, name: string): string {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must exist`);
  const rest = src.slice(start + marker.length);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return end === -1 ? rest : rest.slice(0, end);
}

export function runRecordConversationAnyStatusTests() {
  // ── 1 · The store rejects an empty or over-long message before it ever reaches the database ─────
  assert.equal(RECORD_CONVERSATION_MAX_LENGTH, 2000, "the ceiling matches the plan and CV threads");

  return (async () => {
    for (const body of ["", "   ", "\n\t "]) {
      await assert.rejects(
        insertRecordConversationComment({ authorHrId: "B-10", authorName: null, authorRole: null, body, module: "direct_orders", recordId: "r1" }),
        /cannot be empty/,
        "a blank message is refused in the guard, before any Supabase call",
      );
    }
    await assert.rejects(
      insertRecordConversationComment({
        authorHrId: "B-10",
        authorName: null,
        authorRole: null,
        body: "x".repeat(RECORD_CONVERSATION_MAX_LENGTH + 1),
        module: "marketing_requests",
        recordId: "r1",
      }),
      new RegExp(`under ${RECORD_CONVERSATION_MAX_LENGTH} characters`),
      "an over-long message is refused in the guard, before any Supabase call",
    );

    // ── 2 · The migration: append-only, both modules, no anon/authenticated reach ─────────────────
    const migration = read("supabase/migrations/20260922112439_record_conversation_comments.sql");
    assert.match(migration, /create table if not exists public\.record_conversation_comments/);
    assert.match(
      migration,
      /check \(module in \('direct_orders', 'marketing_requests'\)\)/,
      "the module CHECK names exactly the two live record types",
    );
    assert.match(migration, /check \(btrim\(body\) <> ''\)/, "an empty body is refused at the database too");
    assert.match(migration, /char_length\(body\) <= 2000/, "the 2000 ceiling is pinned in the table, not only in code");
    assert.match(migration, /enable row level security/);
    assert.match(migration, /to service_role using \(true\) with check \(true\)/, "the app reads through the service-role client");
    // Anchored to a real GRANT statement (start of line), so the prose comment that mentions "no
    // grant to anon or authenticated" is not itself mistaken for one.
    assert.doesNotMatch(
      migration,
      /^\s*grant\b[^\n]*\b(anon|authenticated)\b/im,
      "no grant to anon or authenticated — visibility is application-scoped behind the route",
    );
    assert.match(
      migration,
      /before update on public\.record_conversation_comments/,
      "UPDATE is refused by trigger — a posted message cannot be silently rewritten",
    );
    assert.match(migration, /errcode = 'restrict_violation'/, "the append-only trigger raises restrict_violation");

    // ── 3 · NO status gate on either conversation loader ──────────────────────────────────────────
    const marketing = read("src/lib/marketing-requests/service.ts");
    // The conversation loader delegates its whole authorisation to the shared visibility gate — the
    // SAME helper the request-detail read calls — so the two surfaces can never drift apart.
    const marketingLoader = functionBody(marketing, "loadMarketingRequestForConversation");
    assert.match(
      marketingLoader,
      /assertCanViewMarketingRequest\(access, requestRow, employeeRows, steps\)/,
      "the marketing conversation authorises through the shared visibility gate the detail read also uses",
    );
    const marketingGate = functionBody(marketing, "assertCanViewMarketingRequest");
    assert.match(
      marketingGate,
      /canSeeMarketingRequest\(access, requestRow, employeeRows\)/,
      "the shared gate authorises on 'can you see the request', the same rule the detail read uses",
    );
    assert.match(marketingGate, /isAssignedApprover/, "an assigned approver can always join the thread");
    assert.match(marketingGate, /access\.scope !== "system"/, "a system-scope viewer can always join the thread");
    assert.doesNotMatch(
      marketingGate,
      /\.status\b|"rejected"|"cancelled"|"approved"|"closed"/,
      "the marketing conversation must NOT gate on the request's status — that is the whole point (owner, 2026-09-22)",
    );
    assert.doesNotMatch(
      marketingLoader,
      /\.status\b|"rejected"|"cancelled"|"approved"|"closed"/,
      "the marketing conversation loader adds no status gate of its own",
    );

    const direct = read("src/lib/direct-orders/service.ts");
    const directLoader = functionBody(direct, "loadDirectOrderForConversation");
    assert.match(
      directLoader,
      /getDirectOrderRequest\(access, cleanId\)/,
      "the direct-order conversation authorises through the one scope choke point every approval surface reads",
    );
    assert.doesNotMatch(
      directLoader,
      /\.status\b|"rejected"|"cancelled"|"approved"|"expired"|"held"/,
      "the direct-order conversation must NOT gate on the order's status — it is open even after a refusal (owner, 2026-09-22)",
    );

    // ── 4 · The audience is the whole request, fanned out by the ONE shared notifier ──────────────
    const marketingNotify = functionBody(marketing, "notifyMarketingRequestConversation");
    assert.match(marketingNotify, /notifyConversationMessage\(/, "marketing uses the shared conversation notifier");
    assert.match(marketingNotify, /submitterHrId: request\.requester_hr_id/, "the requester is the To address");
    assert.match(
      marketingNotify,
      /request\.requester_hr_id,\s*\n\s*request\.manager_hr_id/,
      "the requester and their manager are on the audience",
    );
    assert.match(
      marketingNotify,
      /steps\.filter\(\(step\) => step\.decisionAt\)\.map\(\(step\) => step\.assignedHrId\)/,
      "everyone who has decided a step is on the audience; an assignee who has not acted yet is not",
    );
    assert.match(marketingNotify, /\.\.\.priorAuthors/, "everyone who already posted keeps receiving the thread");
    assert.match(marketingNotify, /messageKey: input\.comment\.id/, "the comment id is the per-message key, so message 2 is not deduped onto message 1");

    const directNotify = functionBody(direct, "notifyDirectOrderConversation");
    assert.match(directNotify, /notifyConversationMessage\(/, "direct orders use the shared conversation notifier");
    assert.match(directNotify, /submitterHrId: request\.requesterHrId/, "the requester is the To address");
    assert.match(directNotify, /request\.requesterHrId,/, "the requester is on the audience");
    assert.match(directNotify, /steps\.map\(\(step\) => step\.approverHrId\)/, "every person rung in the chain is on the audience");
    assert.match(
      directNotify,
      /steps\.map\(\(step\) => step\.decidedByHrId \?\? null\)/,
      "whoever actually decided a rung (e.g. the CEO once it acted) is on the audience",
    );
    assert.match(directNotify, /\.\.\.priorAuthors/, "everyone who already posted keeps receiving the thread");
    assert.match(directNotify, /messageKey: comment\.id/, "the comment id is the per-message key");

    // ── 5 · The UI says, in words, that it is open at any status ──────────────────────────────────
    const thread = read("src/components/conversations/record-conversation-thread.tsx");
    assert.match(thread, /at any status/i, "the composer tells the reader the thread is open at any status");
    assert.match(thread, /if \(loaded && !schemaReady\) return null;/, "the box hides itself only while the migration is not yet applied");
    assert.doesNotMatch(
      thread,
      /\bstatus\b\s*[:=]/,
      "the component takes no status prop — nothing about the record's state may switch the thread off",
    );

    // ── 6 · The portal keeps a REJECTED request open to conversation ──────────────────────────────
    // A rejected request is a terminal card in the requester's portal — the one surface where the
    // reason is written down. Without a thread there, the requester can read the "why" but cannot
    // reply. The Rejected card must mount the shared thread against the marketing endpoint.
    const draftsWorkspace = read("src/components/employee-portal/marketing-request-drafts.tsx");
    assert.match(
      draftsWorkspace,
      /import \{ RecordConversationThread \} from "@\/components\/conversations\/record-conversation-thread";/,
      "the portal workspace imports the shared conversation thread",
    );
    assert.match(
      draftsWorkspace,
      /openRejectedConversationId/,
      "the Rejected card carries its own open-conversation state",
    );
    assert.match(
      draftsWorkspace,
      /<RecordConversationThread\s+base=\{`\/api\/marketing-requests\/\$\{request\.id\}\/conversation`\}/,
      "the Rejected card mounts the thread against the marketing conversation endpoint",
    );
  })();
}
