import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * A successful sign-in's "Login succeeded" audit row is written BEFORE the reply (owner, 23 Oct 2026:
 * "write the successful-login audit row before the sign-in reply").
 *
 * #6353 moved the sign-in's bookkeeping past the response to make sign-in faster, and the audit row
 * went with it. A task deferred with `afterResponse` is lost whenever the process stops between the
 * reply and the task — a deploy swaps the container at exactly that moment — so a person could be
 * signed in with no row saying so. The success row and the lockout reset stay deferred; only the
 * audit row moved back.
 *
 * What is pinned, on the source with comments stripped:
 *   1. The row is awaited, after the session exists and before the reply is built.
 *   2. Nothing defers it: no `afterResponse` call carries `writeAuthAudit`.
 *   3. It is written once, and the lockout reset is still the only sign-in task after the reply.
 */

const ROUTE = "app/api/auth/login/route.ts";

export function runLoginSuccessAuditBeforeReplyTests() {
  const code = stripComments(readFileSync(ROUTE, "utf8"));

  // ── 1. Awaited, after the session, before the reply ────────────────────────────────────────────
  const session = code.indexOf("appSession = await createAppSession(");
  const token = code.indexOf("const token = createSessionToken(");
  const built = code.indexOf('summary: "Login succeeded"');
  const written = code.indexOf("await writeAuthAudit(successAudit);");
  const reply = code.indexOf('const response = payload.responseMode === "redirect"');
  assert.ok(session !== -1 && token !== -1 && built !== -1 && reply !== -1, `${ROUTE} still has its session, token, success row and reply`);
  assert.notEqual(written, -1, "the success audit row is written with a plain await — never deferred, never fire-and-forget");
  assert.ok(session < written && token < written, "the row is written once the session exists, so it never claims a sign-in that then failed");
  assert.ok(built < written, "the row written is the one built from this sign-in");
  assert.ok(
    written < reply,
    "the success audit row is written BEFORE the reply is built — deferred past the response, a deploy loses it",
  );

  // ── 2. Nothing defers it ───────────────────────────────────────────────────────────────────────
  const deferred = [...code.matchAll(/afterResponse\(\s*"([^"]+)"\s*,([\s\S]*?)\);/g)];
  for (const [, label, task] of deferred) {
    assert.ok(!/writeAuthAudit\(/.test(task), `afterResponse("${label}") must not write the audit row — it is lost if the process stops after the reply`);
  }
  assert.ok(!code.includes('"auth.login.audit_success"'), "the deferred audit task is gone");

  // ── 3. Written once; the lockout reset is the only deferred sign-in task ─────────────────────
  assert.equal(code.split('summary: "Login succeeded"').length - 1, 1, "one success row per sign-in");
  assert.equal(code.split("writeAuthAudit(successAudit)").length - 1, 1, "written exactly once");
  assert.deepEqual(
    deferred.map(([, label]) => label),
    ["auth.login.clear_failed_state"],
    "the lockout reset (and the success attempt row inside it) is still the one task after the reply — #6353's speed-up stands",
  );
}
