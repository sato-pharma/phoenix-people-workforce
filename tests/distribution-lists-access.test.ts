import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  canManageDistributionList,
  canManageDistributionLists,
  distributionListScopeFor,
} from "../src/lib/distribution-lists/access.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

/**
 * THE HR BUSINESS PARTNER REACHES THE DISTRIBUTION LISTS, AND ONLY THE HR ONES.
 *
 * Owner 2026-09-11: she should see that screen and use it. Asked whether "all of it" included the
 * Monthly Closing Cc, he answered plainly: *"HR lists only, she shouldn't touch the closing cc."*
 *
 * 🔴 THE THREE FAILURES THIS PINS ARE EACH SILENT.
 *
 * A DENYLIST INSTEAD OF AN ALLOWLIST. "Everything except the closing" reads equivalent and is not:
 * the next list added is visible to her by default, and the first one nobody remembered to deny is
 * a widening no error reports. The set is an allowlist, and an unknown key is OUT.
 *
 * A SCREEN THAT ONLY HIDES. `/api/admin/distribution-lists/[listKey]` takes a key from the URL. A
 * page that filters its rows stops nobody from naming `closing_fixed_cc` by hand, so the per-list
 * check has to live in the ROUTE. Same for both alias actions.
 *
 * AN ALIAS AS THE SIDE DOOR. Registering an alias pointed at a list she cannot edit, or recording
 * membership on somebody else's alias, would reach the same data around the list check.
 */

const ROUTE_LIST = readFileSync(
  fileURLToPath(new URL("../app/api/admin/distribution-lists/[listKey]/route.ts", import.meta.url)),
  "utf8",
);
const ROUTE_ALIASES = readFileSync(
  fileURLToPath(new URL("../app/api/admin/email-aliases/route.ts", import.meta.url)),
  "utf8",
);
const ROUTE_INDEX = readFileSync(
  fileURLToPath(new URL("../app/api/admin/distribution-lists/route.ts", import.meta.url)),
  "utf8",
);
const ROUTE_SEND = readFileSync(
  fileURLToPath(new URL("../app/api/admin/email-reply/send/route.ts", import.meta.url)),
  "utf8",
);
const MIGRATION_REPLY_TO = readFileSync(
  fileURLToPath(new URL("../supabase/migrations/20260911220000_distribution_list_reply_to.sql", import.meta.url)),
  "utf8",
);

const as = (role: string): AccessContext =>
  ({ hrId: "X-1", loginId: "X-1", role, scope: "company", source: "session" }) as unknown as AccessContext;

export function runDistributionListsAccessTests() {
  const hrbp = as("HR Advisory");
  const superAdmin = as("Super Admin");

  // ── Who reaches the screen at all ────────────────────────────────────────────────────────────
  assert.equal(canManageDistributionLists(superAdmin), true, "Super Admin keeps the screen");
  assert.equal(canManageDistributionLists(hrbp), true, "the HR Business Partner reaches it — owner 2026-09-11");
  for (const role of ["HR Operations", "Finance Manager", "CEO", "Medical Rep", "National Sales Manager", "Employee"]) {
    assert.equal(
      canManageDistributionLists(as(role)),
      false,
      `${role} must not reach the distribution lists — the grant was to the HR Business Partner alone`,
    );
  }

  // ── 🔴 Scope is an ALLOWLIST, and an unknown key is OUT ──────────────────────────────────────
  assert.equal(distributionListScopeFor(superAdmin), "all", "Super Admin is unscoped");
  const hrScope = distributionListScopeFor(hrbp);
  assert.notEqual(hrScope, "all", "the HR Business Partner is scoped, never unscoped");
  if (hrScope === "all") return;

  assert.equal(canManageDistributionList(hrbp, "hr_team"), true, "she owns the HR Team list");
  assert.equal(
    canManageDistributionList(hrbp, "closing_fixed_cc"),
    false,
    'she must not touch the Monthly Closing Cc — owner: "HR lists only, she shouldn\'t touch the closing cc"',
  );
  assert.equal(canManageDistributionList(hrbp, "finance_team"), false, "nor the Finance list");
  assert.equal(
    canManageDistributionList(hrbp, "a_list_invented_next_week"),
    false,
    "🔴 a list she has never been granted is OUT — an allowlist fails closed, a denylist would have shown it to her by default",
  );
  assert.equal(canManageDistributionList(superAdmin, "closing_fixed_cc"), true, "Super Admin still edits everything");
  assert.equal(
    canManageDistributionList(as("Medical Rep"), "hr_team"),
    false,
    "a role outside the gate holds no list, even one inside the HR set",
  );

  // ── The ROUTES enforce it, not just the screen ───────────────────────────────────────────────
  assert.match(
    ROUTE_LIST,
    /canManageDistributionList\(\s*access\s*,\s*listKey\s*\)/,
    "the [listKey] route must check the specific list — the key comes from the URL, so filtering rows on the page stops nobody",
  );
  assert.match(ROUTE_INDEX, /distributionListScopeFor\(/, "the index route must narrow what it returns");
  assert.match(ROUTE_ALIASES, /distributionListScopeFor\(/, "the alias route must narrow too");

  // Both alias actions, or the one left open is the side door.
  assert.equal(
    (ROUTE_ALIASES.match(/inScope\(/g) ?? []).length >= 2,
    true,
    "BOTH alias actions must be scoped — register (pointing a new alias at a list) and record (writing to an existing one)",
  );
  assert.match(
    ROUTE_ALIASES,
    /getCompanyEmailAliases\(\)/,
    "recording membership must judge the alias as STORED, not as the request claims — otherwise the caller asserts which list it belongs to",
  );

  // ── A list can name its own reply address, and it is REPLY-TO, never FROM ────────────────────
  // Owner 2026-09-11: mail sent through the HR list should answer to HRBP@satopharma.com.
  assert.match(
    MIGRATION_REPLY_TO,
    /'hrbp@satopharma\.com'/,
    "the HR Team list must carry the HR Business Partner's address",
  );
  assert.match(
    MIGRATION_REPLY_TO,
    /where list_key = 'hr_team'/,
    "and only that list — a global reply address would make a Monthly Closing publish answer to HR",
  );

  assert.match(
    ROUTE_SEND,
    /replyTo:\s*resolved\.replyTo/,
    "the composer send must pass the list's reply address through",
  );
  // 🔴 THE ONE THAT PROTECTS DELIVERABILITY. `from` is phoenix@send.satopharma.com — a subdomain
  // Resend authenticates. Sending as an apex-domain mailbox is rejected or filed as spam, so the
  // list address must never reach `from`, however natural "send it from HRBP" sounds.
  // The regex below was once written through a Python heredoc as `\b`, which is the BACKSPACE
  // escape there, not two characters — so it required a 0x08 byte after "replyTo" and could never
  // match. The guard passed while the code under it was broken. Kept in the assert.equal form with
  // the boolean named, so the thing being asserted is readable and a stray byte is visible.
  const fromUsesTheListAddress = /from:\s*(resolved\.replyTo|replyTo)/.test(ROUTE_SEND);
  assert.equal(
    fromUsesTheListAddress,
    false,
    "a list's address must NEVER become the From - From stays on the verified sending subdomain or the mail stops being delivered",
  );
}
