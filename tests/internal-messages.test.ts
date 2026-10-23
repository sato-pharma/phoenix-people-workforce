import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
}
