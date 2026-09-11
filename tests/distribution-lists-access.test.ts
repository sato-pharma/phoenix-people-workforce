import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  canManageDistributionList,
  canManageDistributionLists,
  distributionListScopeFor,
} from "../src/lib/distribution-lists/access.ts";
import { refusePrivilegedTemplateChange } from "../src/lib/email-templates/privileged-fields.ts";
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
const ROUTE_TELEGRAM = readFileSync(
  fileURLToPath(new URL("../app/api/admin/notifications/telegram/route.ts", import.meta.url)),
  "utf8",
);
const ROUTE_TEMPLATE = readFileSync(
  fileURLToPath(new URL("../app/api/admin/email-templates/[templateKey]/route.ts", import.meta.url)),
  "utf8",
);
const SETTINGS = readFileSync(
  fileURLToPath(new URL("../src/config/system-settings.ts", import.meta.url)),
  "utf8",
);

/** Source with comments stripped, so a rule described in prose cannot satisfy a check. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

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
  // 🔴 AND THE SCOPE ITSELF ANSWERS EMPTY, not merely the gate above it. Asserting only through
  // canManageDistributionList hides this: that helper short-circuits on the gate, so the scope
  // function could hand the HR allowlist to every role in the company and every test would stay
  // green. A future caller that reads the scope without the gate must get nothing.
  for (const role of ["Medical Rep", "HR Operations", "Finance Manager", "CEO"]) {
    const scope = distributionListScopeFor(as(role));
    assert.notEqual(scope, "all", `${role} must not be unscoped`);
    if (scope === "all") continue;
    assert.equal(scope.size, 0, `${role} holds NO list - the scope must answer empty, not rely on the gate being checked first`);
  }

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
  // positive pin below narrows that by requiring the env-var line to survive. It does not CLOSE it:
  // routing through an intermediate (`const sender = replyTo || from`) still evades both. What
  // actually holds the property is send-phoenix-email.ts, which derives `from` from input.from and
  // never from replyTo.
  const fromUsesTheReplyAddress = /from:\s*(systemEmail\.seatReplyTo|replyTo)/.test(ROUTE_SEND);
  assert.equal(
    fromUsesTheReplyAddress,
    false,
    "a reply address must NEVER become the From - From stays on the verified sending subdomain or the mail stops being delivered",
  );
  // ── 🔴 THE TWO DOORS `communication` OPENED, AND WHY THEY ARE SHUT ───────────────────────────
  // Granting hr_communication made the HR Business Partner the SECOND holder of `communication` in
  // this system's history. Two actions on the Telegram route were gated on that resource alone and
  // were therefore Super-Admin-only by ACCIDENT, not by rule. Owner 2026-09-11, told what each did:
  // close both.
  //
  // send_invitations emails up to 250 employees in one call, and the mass-send brake cannot see it:
  // the confidence gate skips single-recipient sends by design and every campaign send is
  // single-recipient, so 250 of them read as 250 ordinary emails. That is the standing
  // never-fire-bulk-email rule.
  //
  // global_switch turns Telegram off company-wide - and Telegram is where the outbox drain's
  // dead-man's-switch alarm goes, deliberately never email, because it fires exactly when email is
  // the broken thing.
  // Anchored on the CODE, and on comment-stripped source. The first attempt sliced from
  // indexOf("send_invitations"), which found that word inside the comment on the OTHER gate - so
  // the window contained global_switch's check and the assertion passed with the real campaign gate
  // deleted. Proven by breaking it; a source pin that can match its own prose proves nothing.
  const telegram = code(ROUTE_TELEGRAM);
  // 🔴 FIVE ACTIONS, NOT TWO. The first pass gated the campaign and the company-wide switch and
  // stopped there. Review found three siblings on the same handler reaching the SAME outcome the
  // switch gate exists to protect - the outbox drain's dead-man's-switch alarm, which goes to
  // Telegram and deliberately never to email. `module_policy` drops the Telegram leg by naming
  // module "system"; `disable_user` and `disconnect_user` are that switch applied one person at a
  // time, against the alarm's own audience. A gate covering two of five doors is one nobody has to
  // walk past.
  for (const [guard, what] of [
    ['body?.action === "send_invitations"', "the 250-recipient onboarding campaign"],
    ['body?.type === "global_switch"', "the company-wide Telegram switch"],
    ['body?.type === "module_policy"', "a module's Telegram policy"],
    ['body?.action === "disable_user"', "switching off one person's Telegram"],
    ['body?.action === "disconnect_user"', "disconnecting one person's Telegram"],
  ] as const) {
    const idx = telegram.indexOf(guard);
    assert.ok(idx > 0, `${what} must still be handled on the telegram route`);
    const block = telegram.slice(idx, idx + 700);
    const inline = /access\.role !== "Super Admin"[\s\S]{0,160}status: 403/.test(block);
    const viaHelper = /refuseUnlessSuperAdmin\(\s*access\.role/.test(block);
    assert.ok(
      inline || viaHelper,
      `${what} must refuse anyone but Super Admin - the \`communication: update\` gate above it stopped being Super-Admin-only the moment a second seat held that resource`,
    );
  }
  // And the shared helper must really refuse, not merely be named. Without this, the three guards
  // above are satisfied by a function that returns null for everybody.
  assert.match(
    telegram,
    /function refuseUnlessSuperAdmin[\s\S]{0,260}role === "Super Admin"[\s\S]{0,260}status: 403/,
    "refuseUnlessSuperAdmin must pass Super Admin through and answer 403 to everyone else",
  );

  assert.match(
    ROUTE_SEND,
    /const from = process\.env\.HR_REPLY_EMAIL_FROM \|\| process\.env\.NOTIFICATION_EMAIL_FROM/,
    "and From must still be resolved from the env vars - without this positive pin, reassigning `from` higher up slips past the negative one",
  );

  // ── 🔴 WHERE A TEMPLATE'S MAIL GOES IS NOT THE SAME PRIVILEGE AS WHAT IT SAYS ────────────────
  // `communication: update` is the only gate on saving an email template, and a template carries
  // static To/Cc/Bcc addresses that are appended to EVERY send of it. One save putting a personal
  // address into bccStaticEmails on the offer letter copies every future offer, resignation notice
  // and contract, indefinitely. Three controls that look like they would catch that do not: the
  // Recipient Assurance Guard is handed these addresses as legitimate ON PURPOSE, an off-domain
  // static address is a -10 health warning and never a refusal, and the confidence gate never holds
  // a send this small. `isActive` is the mirror image - switching password_reset off ends every
  // password-reset mail company-wide, and `action: "save"` demands no change reason.
  const storedTemplate = {
    isActive: true,
    rules: { bccStaticEmails: ["hr@satopharma.com"], ccStaticEmails: [], toStaticEmails: [] },
  };
  const hrbpRole = "HR Advisory";

  assert.equal(
    refusePrivilegedTemplateChange({ payload: { subject: "A new subject" }, role: hrbpRole, stored: storedTemplate }),
    null,
    "editing what the mail SAYS is the whole point of the grant and must never be refused",
  );
  // 🔴 THE CHECK IS ON THE CHANGE, NOT ON THE FIELD BEING PRESENT. The designer posts the whole
  // rules object back on an ordinary content save, so refusing any payload that merely MENTIONS
  // these fields would block every legitimate edit and read as a broken screen rather than a rule.
  assert.equal(
    refusePrivilegedTemplateChange({
      payload: { isActive: true, rules: storedTemplate.rules },
      role: hrbpRole,
      stored: storedTemplate,
    }),
    null,
    "resending the stored values unchanged is not a change - without this, every content save is refused",
  );
  assert.ok(
    refusePrivilegedTemplateChange({
      payload: { rules: { bccStaticEmails: ["hr@satopharma.com", "her.personal@gmail.com"] } },
      role: hrbpRole,
      stored: storedTemplate,
    }),
    "🔴 adding a fixed Bcc must be refused - it is a permanent extra recipient on every send of this template",
  );
  assert.ok(
    refusePrivilegedTemplateChange({ payload: { rules: { bccStaticEmails: [] } }, role: hrbpRole, stored: storedTemplate }),
    "REMOVING a fixed address is refused too - dropping a compliance Bcc changes who is copied just as much as adding one",
  );
  assert.ok(
    refusePrivilegedTemplateChange({ payload: { isActive: false }, role: hrbpRole, stored: storedTemplate }),
    "🔴 switching a template off must be refused - deactivating password_reset ends every password-reset mail company-wide",
  );
  assert.equal(
    refusePrivilegedTemplateChange({
      payload: { isActive: false, rules: { bccStaticEmails: ["anything@example.com"] } },
      role: "Super Admin",
      stored: storedTemplate,
    }),
    null,
    "Super Admin still changes both",
  );
  // Case and order are NOT a change. The designer may normalise either, and a false refusal here
  // would be read as the screen being broken rather than as a boundary.
  assert.equal(
    refusePrivilegedTemplateChange({
      payload: { rules: { bccStaticEmails: ["HR@Satopharma.com"] } },
      role: hrbpRole,
      stored: storedTemplate,
    }),
    null,
    "the same address in a different case is the same address",
  );
  // And the ROUTE must call it BEFORE saving. A pure guard nobody invokes protects nothing, and one
  // invoked after the write protects nothing either.
  const templateRoute = code(ROUTE_TEMPLATE);
  const guardAt = templateRoute.indexOf("refusePrivilegedTemplateChange(");
  const saveAt = templateRoute.indexOf("saveEmailTemplate(templateKey");
  assert.ok(guardAt > 0, "the template route must call the privileged-field guard");
  assert.ok(saveAt > guardAt, "and it must call it BEFORE saving, or the write has already happened");
}
