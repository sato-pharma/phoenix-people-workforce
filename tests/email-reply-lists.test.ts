import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  REPLY_BULK_MAX_PER_EMAIL,
  canSendReplyComposerToLists,
  countReplyBulkSources,
  isReplyBulkPayload,
  normalizeReplyListKeys,
  replyBulkTypedAddresses,
  replyBulkVariableProblem,
  replyBulkVisibleTo,
} from "../src/lib/email/email-reply-lists-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Distribution lists in the Email Reply Composer — a bulk send in the Phoenix identity.
 *
 * Owner 2026-11-19: "in this module add distrbution list to be able to send bulk emails but with
 * phx identity". Four things must hold, and each is pinned below:
 *
 *   1. only the Super Admin seat may send to a list, checked on the SERVER before anything resolves;
 *   2. a list send is manual mail: no `origin`, never `bypassConfidenceGate`, recipients in Bcc;
 *   3. a list email carries no {{variables}} (one person's details would reach everyone);
 *   4. the audience is resolved by the Sato composer's resolver, so there is still one place where a
 *      picked list becomes addresses (tests/sato-email-lists-only-composer.test.ts §1).
 */

/** Strip comments, so a comment that explains a call can never satisfy an assertion about the call. */
function code(relative: string): string {
  return stripComments(readFileSync(path.join(REPO_ROOT, relative), "utf8"));
}

export function runEmailReplyListsTests() {
  // --- 1. Who may send to a list -----------------------------------------------------------------
  assert.equal(canSendReplyComposerToLists({ role: "Super Admin", scope: "system" }), true);
  assert.equal(
    canSendReplyComposerToLists({ role: "HR Operations", scope: "company" }),
    false,
    "an HR seat must never get a list send — `communication` opens the composer, not a company-wide send",
  );
  assert.equal(canSendReplyComposerToLists({ role: "CEO", scope: "company" }), false);

  for (const route of ["app/api/admin/email-composer/preview/route.ts", "app/api/admin/email-reply/send/route.ts"]) {
    const source = code(route);
    const branch = source.indexOf("if (isReplyBulkPayload(body))");
    assert.ok(branch > 0, `${route} must branch on a list send`);
    const gate = source.indexOf("if (!canSendReplyComposerToLists(access))", branch);
    const resolve = source.search(/previewReplyBulk\(|sendReplyBulk\(/);
    assert.ok(
      gate > branch && gate < resolve,
      `${route} must refuse a non-Super-Admin list request BEFORE it resolves or sends anything`,
    );
    assert.match(source.slice(gate, resolve), /status:\s*403/, `${route} must answer 403 to a seat that may not use lists`);
  }
  const optionsRoute = code("app/api/admin/email-composer/options/route.ts");
  assert.match(
    optionsRoute,
    /canUseLists \? getReplyComposerListOptions\(\)/,
    "the options route must hand the lists only to a seat that may send to them",
  );

  // --- 2. Manual mail, never waved past a guard ---------------------------------------------------
  const service = code("src/lib/email/email-reply-lists.ts");
  const sendAt = service.indexOf("await sendPhoenixEmail({");
  assert.ok(sendAt > 0, "a list send must go through sendPhoenixEmail");
  const sendArgs = service.slice(sendAt, service.indexOf("});", sendAt) + 3);
  assert.ok(!/\bbypassConfidenceGate\b/.test(sendArgs), "a list send must NEVER set bypassConfidenceGate");
  assert.ok(
    !/\borigin\s*:/.test(sendArgs),
    "a list send must pass no origin — it is a hand-written email, and the fan-out hold is for automated mail",
  );
  assert.match(sendArgs, /fanoutToBcc:\s*true/, "list recipients stay hidden from each other");
  assert.match(sendArgs, /fanoutVisibleTo:\s*visibleTo/, "every copy shows the one visible To, never the Reply-To list");
  assert.match(
    service,
    /resolveSatoEmailAudience\(/,
    "the list audience must come from the Sato composer's resolver, so a list becomes addresses in one place",
  );
  assert.equal(REPLY_BULK_MAX_PER_EMAIL, 25, "emails of 25 — the manual recipient policy's own cap");

  // --- 3. No variables in a list email ------------------------------------------------------------
  assert.equal(replyBulkVariableProblem("Dear all, the policy is attached."), null);
  const problem = replyBulkVariableProblem("Subject", "Hello {{employeeName}}, your {{ hrId }} and {{employeeName}}");
  assert.ok(problem, "a variable in a list email must be refused");
  assert.match(problem, /\{\{employeeName\}\}, \{\{hrId\}\}/, "each variable is named once");

  // --- 4. Pure helpers ----------------------------------------------------------------------------
  assert.deepEqual(normalizeReplyListKeys([" hr_team ", "hr_team", 7, "", "sales_cns"]), ["hr_team", "sales_cns"]);
  assert.deepEqual(normalizeReplyListKeys("hr_team"), [], "only an array of keys is a list request");
  assert.equal(normalizeReplyListKeys(Array.from({ length: 300 }, (_, i) => `l${i}`)).length, 100);
  assert.equal(isReplyBulkPayload({ listKeys: ["hr_team"] } as never), true);
  assert.equal(isReplyBulkPayload({ listKeys: ["  "] } as never), false, "blank keys are not a list send");
  assert.equal(isReplyBulkPayload({} as never), false);

  assert.equal(replyBulkVisibleTo("first@satopharma.com, second@satopharma.com"), "first@satopharma.com");

  assert.deepEqual(
    replyBulkTypedAddresses({
      bcc: "",
      cc: "Out@Example.com",
      ccSelections: [{ email: "chip@example.com", type: "email" }, { email: "x@satopharma.com", hrId: "B-1", type: "employee" }],
      to: "out@example.com",
    } as never),
    ["out@example.com", "chip@example.com"],
    "only addresses the sender typed need a reason; picked employees do not",
  );

  assert.deepEqual(
    countReplyBulkSources([
      { email: "a@x", source: "HR team" },
      { email: "b@x", source: "Sales" },
      { email: "c@x", source: "Sales" },
      { email: "d@x" },
    ] as never),
    [
      { count: 2, source: "Sales" },
      { count: 1, source: "HR team" },
      { count: 1, source: "Picked in the composer" },
    ],
  );
}
