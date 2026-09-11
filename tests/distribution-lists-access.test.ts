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
const SETTINGS = readFileSync(
  fileURLToPath(new URL("../src/config/system-settings.ts", import.meta.url)),
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

  // Both alias actions, PER ACTION. A count of `inScope(` across the file is the weaker form: the
  // register fix below adds a third call, after which a count would pass with `record` wide open.
  const registerHalf = ROUTE_ALIASES.slice(
    ROUTE_ALIASES.indexOf('action === "register"'),
    ROUTE_ALIASES.indexOf('action === "record"'),
  );
  const recordHalf = ROUTE_ALIASES.slice(ROUTE_ALIASES.indexOf('action === "record"'));
  assert.ok(registerHalf.includes("inScope("), "the register action must be scoped");
  assert.ok(recordHalf.includes("inScope("), "the record action must be scoped too, or it is the side door");
  // 🔴 register is an UPSERT on the address, so checking only the DESTINATION list lets her name an
  // alias that already exists and re-point it at a list she owns — making the very field every
  // reader scopes on say it is hers. It must read the stored row, as record does.
  assert.ok(
    registerHalf.includes("getCompanyEmailAliases()"),
    "register must read the alias AS STORED before overwriting it — otherwise the scope predicate is a field the caller can write",
  );

  // ── The reply address is keyed on the SENDER, and is Reply-To, never From ───────────────────
  // Owner 2026-09-11, asked and answered: a mail carries the HR Business Partner's address when
  // SHE is sending, not whenever the HR Team is addressed. Keying it on recipients meant a Super
  // Admin Bcc'ing HR Team sent a vendor's reply to her instead of to himself.
  assert.match(
    SETTINGS,
    /seatReplyTo:\s*\{[^}]*"HR Advisory":\s*"hrbp@satopharma\.com"/,
    "the HR Business Partner's seat must carry her reply address",
  );
  assert.match(
    ROUTE_SEND,
    /replyTo:\s*systemEmail\.seatReplyTo\[access\.role\]/,
    "the send must pick the reply address from the SENDER's seat",
  );

  // 🔴 THE PAIR THAT PROTECTS DELIVERABILITY, negative AND positive.
  // From is phoenix@send.satopharma.com - the subdomain Resend authenticates. An apex-domain From
  // is rejected or filed as spam. The negative pin alone was evadable: the send site writes `from,`
  // as property shorthand, so `const from = replyTo ?? ...` higher up would never match it. The
  // positive pin below closes that by requiring `from` to keep coming from the env vars.
  const fromUsesTheReplyAddress = /from:\s*(systemEmail\.seatReplyTo|replyTo)/.test(ROUTE_SEND);
  assert.equal(
    fromUsesTheReplyAddress,
    false,
    "a reply address must NEVER become the From - From stays on the verified sending subdomain or the mail stops being delivered",
  );
  assert.match(
    ROUTE_SEND,
    /const from = process\.env\.HR_REPLY_EMAIL_FROM \|\| process\.env\.NOTIFICATION_EMAIL_FROM/,
    "and From must still be resolved from the env vars - without this positive pin, reassigning `from` higher up slips past the negative one",
  );
}
