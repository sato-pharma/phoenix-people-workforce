import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { permissionMatrix, phoenixRoles, retiredPhoenixRoles } from "@/lib/auth/permissions";
import { internalMessageError } from "@/lib/internal-messages/http";
import { INTERNAL_MESSAGE_EMAILS_PER_DAY, INTERNAL_MESSAGE_SENDS_PER_MINUTE } from "@/lib/internal-messages/service";
import { ApiRateLimitError } from "@/lib/security/api-rate-limit";

import { stripComments } from "./support/comment-strip.ts";

// The internal-messages service is almost entirely Supabase I/O (no pure exported helpers),
// so these tests lock the security/scoping invariants at the source level — the same style
// used by the probation, vacation, and contract-renewal hardening tests.
export async function runInternalMessagesTests() {
  const source = readFileSync("src/lib/internal-messages/service.ts", "utf8");

  // --- sendInternalMessage: input validation --------------------------------------------
  assert.match(source, /if \(!subject\) throw new Error\("Subject is required\."\)/,
    "a message must require a subject");
  assert.match(source, /if \(!body\) throw new Error\("Message is required\."\)/,
    "a message must require a body");
  assert.match(source, /body\.length > 5000/,
    "message body must be length-capped to prevent abuse");

  // --- listInternalMessagesForViewer: viewer-scoped reads only --------------------------
  // The viewer may only see messages where they are the recipient OR the sender.
  const listStart = source.indexOf("export async function listInternalMessagesForViewer");
  const listEnd = source.indexOf("export async function", listStart + 1);
  const listBody = source.slice(listStart, listEnd > listStart ? listEnd : undefined);
  assert.ok(listStart >= 0, "listInternalMessagesForViewer must exist");
  assert.match(listBody, /quotedOrClause\("recipient_hr_id", "eq", sender\.hrId\)/,
    "inbox must be scoped to the viewer's recipient_hr_id");
  assert.match(listBody, /quotedOrClause\("sender_hr_id", "eq", sender\.hrId\)/,
    "outbox must be scoped to the viewer's sender_hr_id");
  assert.match(listBody, /if \(filters\.length === 0\) return \{ messages: \[\], unreadCount: 0 \}/,
    "an unauthenticated viewer must get an empty list, never an unscoped query");

  // --- markInternalMessageRead: only the recipient can mark a message read ---------------
  const markStart = source.indexOf("export async function markInternalMessageRead");
  const markEnd = source.indexOf("export async function", markStart + 1);
  const markBody = source.slice(markStart, markEnd > markStart ? markEnd : source.length);
  assert.ok(markStart >= 0, "markInternalMessageRead must exist");
  assert.match(markBody, /quotedOrClause\("recipient_hr_id", "eq", sender\.hrId\)/,
    "read-state update must target the viewer as recipient");
  assert.match(markBody, /quotedOrClause\("recipient_login_id", "eq", sender\.loginId\)/,
    "read-state update must also match the viewer's login id");
  assert.doesNotMatch(markBody, /"sender_hr_id", "eq"|"sender_login_id", "eq"|sender_hr_id\.eq|sender_login_id\.eq/,
    "marking read must NOT match on sender — a sender cannot mark the recipient's copy read");
  assert.match(markBody, /if \(filters\.length === 0\) throw new Error\("Authentication is required\."\)/,
    "marking read without an identity must be rejected");
  assert.match(markBody, /if \(!data\) throw new Error\("Message was not found\."\)/,
    "marking a message the viewer doesn't own must fail (the scoped update returns no row)");

  // --- schema-missing degradation --------------------------------------------------------
  assert.match(source, /schemaMissing\(error\)/,
    "missing internal-messages schema must degrade gracefully, not crash the topbar");

  // --- the messaging permission: every active role, as before (owner, 2026-11-13) --------
  for (const role of phoenixRoles) {
    const actions = (permissionMatrix[role].internal_messages ?? []).slice().sort();
    assert.deepEqual(
      actions,
      retiredPhoenixRoles.has(role) ? [] : ["create", "read"],
      `${role} must ${retiredPhoenixRoles.has(role) ? "hold nothing (retired seat)" : "read and send internal messages, as before"}`,
    );
  }

  // --- sending: permission, then the per-sender limits, then the insert, then one audit row
  const code = stripComments(source);
  const sendStart = code.indexOf("export async function sendInternalMessage");
  const sendBody = code.slice(sendStart, code.indexOf("export async function", sendStart + 1));
  const at = (needle: string) => {
    const index = sendBody.indexOf(needle);
    assert.ok(index >= 0, `sendInternalMessage must contain ${needle}`);
    return index;
  };
  const gate = at('assertPermission(access, "internal_messages", "create")');
  const perMinute = at('scope: "internal-message-send"');
  const perDay = at('scope: "internal-message-email"');
  const insert = at(".insert({");
  const audit = at('entityType: "internal_message"');
  const notify = at("createSystemNotification(");
  assert.ok(gate < perMinute && perMinute < perDay && perDay < insert, "the gate and both limits run before anything is stored");
  assert.ok(insert < audit && audit < notify, "each stored message writes its audit row before anyone is notified");
  assert.match(sendBody, /if \(input\.sendEmail\) \{\s*await assertApiRateLimit\(/, "the daily limit counts email copies only");
  assert.equal(INTERNAL_MESSAGE_SENDS_PER_MINUTE, 10);
  assert.equal(INTERNAL_MESSAGE_EMAILS_PER_DAY, 20);
  assert.match(sendBody, /limit: INTERNAL_MESSAGE_SENDS_PER_MINUTE,[\s\S]*?windowMs: 60_000/);
  assert.match(sendBody, /limit: INTERNAL_MESSAGE_EMAILS_PER_DAY,[\s\S]*?windowMs: 24 \* 60 \* 60_000/);
  const auditCall = sendBody.slice(audit - 200, sendBody.indexOf("});", audit));
  assert.doesNotMatch(auditCall, /\bsubject\b|\bbody\b/, "the audit row never carries the subject or the words");

  // --- each route: signed-out 401, then the permission, then the service ------------------
  const routes: Array<[string, string, string]> = [
    ["app/api/messages/route.ts", "read", "listInternalMessagesForViewer(access"],
    ["app/api/messages/recipients/route.ts", "create", "searchInternalMessageRecipients(query"],
    ["app/api/messages/[id]/read/route.ts", "read", "markInternalMessageRead(access"],
  ];
  for (const [path, action, call] of routes) {
    const route = stripComments(readFileSync(path, "utf8"));
    const signedOut = route.indexOf("if (isSignedOut(access))");
    const permission = route.indexOf(`assertPermission(access, "internal_messages", "${action}")`);
    assert.ok(signedOut >= 0 && permission > signedOut, `${path} answers a signed-out call, then asserts internal_messages:${action}`);
    assert.ok(route.indexOf(call) > permission, `${path} calls the service only after the permission check`);
  }
  const post = stripComments(readFileSync("app/api/messages/route.ts", "utf8"));
  const postBody = post.slice(post.indexOf("export async function POST"));
  assert.ok(
    postBody.indexOf('assertPermission(access, "internal_messages", "create")') < postBody.indexOf("sendInternalMessage(access"),
    "sending asserts internal_messages:create before the service runs",
  );

  // --- the error answers -----------------------------------------------------------------
  assert.equal(internalMessageError(new ApiRateLimitError(30), "x", "y").status, 429);
  assert.equal(internalMessageError(new ApiRateLimitError(30), "x", "y").headers.get("Retry-After"), "30");
  assert.equal(internalMessageError(new Error("Forbidden: no"), "x", "y").status, 403);
  assert.equal(internalMessageError(new Error("Authentication is required."), "x", "y").status, 401);
  assert.equal(internalMessageError(new Error("Subject is required."), "x", "y").status, 400);
}
