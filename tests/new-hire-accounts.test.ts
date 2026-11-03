import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  firstNewHireDate,
  isNewHireAccount,
  lastSendOf,
  NEW_HIRE_ACCOUNTS_EXPLAINER,
  newHireAddress,
  newHireMissingText,
  parseNewHireChannel,
  type NewHirePerson,
} from "../src/lib/new-hire-accounts/rules.ts";

function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/**
 * Owner, 2026-11-03: "I want him to be able to send the new accounts to the new hires, but without changing in access
 * or authorities or anything. For example, I want him to have the rep name and details and action buttons, send via
 * email, send via SATO email, or send via private email, or send via WhatsApp."
 */
export function runNewHireAccountsTests(): void {
  runWhoRules();
  runChannelRules();
  runSenderRules();
  runGateRules();
  runScreenRules();
}

function runWhoRules(): void {
  const today = "2026-11-03";
  const person = (change: Partial<NewHirePerson> = {}): NewHirePerson => ({
    role: "Medical Rep",
    isActive: true,
    forcePasswordReset: true,
    isTestPersona: false,
    employmentStatus: "active",
    hireDate: "2026-11-01",
    ...change,
  });

  assert.equal(firstNewHireDate(today), "2026-08-05", "ninety calendar days back");
  assert.equal(isNewHireAccount(person(), today), true, "a new rep waiting to set a password");
  assert.equal(isNewHireAccount(person({ role: "District Manager" }), today), true, "a new district manager too");
  assert.equal(isNewHireAccount(person({ hireDate: "2026-11-08" }), today), true, "🔴 a start date ahead of today counts: people are invited before they start");
  assert.equal(isNewHireAccount(person({ hireDate: "2026-08-05" }), today), true, "the first day of the window");
  assert.equal(isNewHireAccount(person({ hireDate: "2026-08-04" }), today), false, "🔴 an established hire date is refused");

  assert.equal(isNewHireAccount(person({ forcePasswordReset: false }), today), false, "🔴 somebody with a password of their own can never be reached: a link would take the login over");
  assert.equal(isNewHireAccount(person({ isActive: false }), today), false, "an inactive login");
  assert.equal(isNewHireAccount(person({ isTestPersona: true }), today), false, "a test account");
  assert.equal(isNewHireAccount(person({ employmentStatus: "resigned" }), today), false, "somebody who has left");
  assert.equal(isNewHireAccount(person({ hireDate: null }), today), false, "no hire date is never new");
  for (const role of ["Super Admin", "CEO", "SFE Manager", "HR Operations", "Employee", null]) {
    assert.equal(isNewHireAccount(person({ role }), today), false, `🔴 ${String(role)} is out of this page's reach`);
  }
}

function runChannelRules(): void {
  assert.equal(parseNewHireChannel("private_email"), "private_email");
  assert.equal(parseNewHireChannel("copy"), null, "🔴 no copy mode here: the raw link never reaches the screen");
  assert.equal(parseNewHireChannel(undefined), null, "nothing off the wire is trusted to be a channel");

  const row = { satoEmail: "a@satopharma.com", privateEmail: null, mobile: "01012345678" };
  assert.equal(newHireAddress(row, "sato_email"), "a@satopharma.com");
  assert.equal(newHireAddress(row, "private_email"), null, "🔴 a missing private email never falls back to the Sato one: each button is its own address");
  assert.equal(newHireAddress(row, "whatsapp"), "01012345678");
  assert.equal(newHireMissingText("private_email"), "No private email on file");

  assert.deepEqual(lastSendOf({ deliveryMode: "email", emailTo: "private", delivery: "email_sent" }), { how: "Private email", outcome: "sent" });
  assert.deepEqual(lastSendOf({ deliveryMode: "email", emailTo: "work", delivery: "link_generated_only" }), { how: "Sato email", outcome: "not_delivered" }, "🔴 a mail that did not leave never reads as sent");
  assert.deepEqual(lastSendOf({ deliveryMode: "email", delivery: "email_sent" }), { how: "Email", outcome: "sent" }, "an older row names no mailbox");
  assert.deepEqual(lastSendOf({ deliveryMode: "whatsapp", delivery: "whatsapp_link_prepared" }), { how: "WhatsApp", outcome: "prepared" }, "🔴 WhatsApp says prepared: Phoenix cannot know the chat was sent");

  assert.ok(NEW_HIRE_ACCOUNTS_EXPLAINER.includes("48 hours") && NEW_HIRE_ACCOUNTS_EXPLAINER.includes("cancels the last one"), "the page says what a press does");
  assert.ok(NEW_HIRE_ACCOUNTS_EXPLAINER.includes("Nothing here changes anybody's role, line, manager or access"), "🔴 and what it never does");
}

function runSenderRules(): void {
  const sender = stripComments(read("src/lib/auth/password-setup.ts"));
  assert.ok(
    sender.includes("input.emailTo ? await resolveChosenEmail(user, input.emailTo) : await resolveDeliverableEmail(user)"),
    "🔴 with no choice the mailbox is resolved exactly as before, so the Super Admin's page is untouched",
  );
  assert.ok(sender.includes('emailTo === "private" ? row?.personal_email : row?.work_email'), "🔴 each choice reads its own column and no other");

  const update = sender.slice(sender.indexOf('.from("app_auth_users")\n    .update({\n      force_password_reset: true'));
  const written = update.slice(update.indexOf("{") + 1, update.indexOf("}")).trim().split(/,\s*/).filter(Boolean).map((line) => line.split(":")[0].trim());
  assert.deepEqual(written, ["force_password_reset", "session_version", "updated_at"], "🔴 the send writes these and no role, line, manager or scope (owner: \"without changing in access or authorities\")");

  const code = sender.slice(sender.indexOf("export async function requestPasswordResetCode("));
  assert.ok(!code.includes("personal_email") && !code.includes("resolveChosenEmail"), "🔴 the self-service reset code still goes to the Sato mailbox alone (2026-10-07)");

  const service = stripComments(read("src/lib/new-hire-accounts/service.ts"));
  const send = service.slice(service.indexOf("export async function sendNewHireAccount("));
  assert.match(send.slice(0, 240), /assertSender\(viewer\);/, "the service refuses by itself");
  assert.ok(send.indexOf("loadPeople(viewer, loginId)") >= 0 && send.indexOf("loadPeople(viewer, loginId)") < send.indexOf("sendPasswordSetupLink("), "🔴 the person is asked for again at the press, before any link exists");
  assert.ok(service.includes("isNewHireAccount("), "and the same one rule answers it");
  const readsFromBody = [...send.matchAll(/body\.([a-zA-Z]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(readsFromBody)].sort(), ["channel", "loginId"], "🔴 an address, a role or a purpose is never read from the request");
  assert.ok(send.includes('purpose: "setup"'), "always a setup link, never a reset");
  assert.ok(!/\.(update|insert|upsert|delete)\(/.test(service), "🔴 the page's service writes nothing itself");
  assert.ok(!service.includes("user_admin"), "🔴 it grants no access");
}

function runGateRules(): void {
  const service = read("src/lib/new-hire-accounts/service.ts");
  assert.match(service, /export function canSendNewHireAccounts\(viewer: PhoenixCrmViewer\): boolean \{\s*return canUseSfeFieldControls\(viewer\);/, "🔴 the Super Admin and the SFE Manager");
  assert.match(service.slice(service.indexOf("export async function loadNewHireAccounts(")).slice(0, 160), /assertSender\(viewer\);/, "the read refuses by itself");

  const page = read("app/(admin)/admin/field-crm/new-hire-accounts/page.tsx");
  assert.match(page, /if \(!viewer \|\| !canSendNewHireAccounts\(viewer\)\) redirect\("\/admin"\);/, "the page redirects anybody else");
  assert.ok(page.indexOf("canSendNewHireAccounts(viewer)") < page.indexOf("loadNewHireAccounts(viewer)"), "the gate runs before the read");

  const route = read("app/api/new-hire-accounts/route.ts");
  assert.match(route, /assertSameOriginMutation\(request\)/, "a same-origin POST");
  assert.match(route, /await assertPermission\(access, "phoenix_crm", "approve"\)/, "it asks the permission first");
  assert.ok(route.includes("trustedOriginForRedirect(request)"), "🔴 the link is built on the allow-listed origin, never a forwarded host");

  const admin = read("app/api/admin/users/setup-link/route.ts");
  assert.ok(admin.includes('assertPermission(access, "user_admin", "update")') && admin.includes('access.role !== "Super Admin"'), "🔴 the door that reaches anybody stays the Super Admin's");

  assert.ok(read("src/lib/security/access-registry.ts").includes('pattern: "/api/new-hire-accounts"'), "the route is on the registry");
  assert.ok(read("src/lib/system-audit/api-page-map.ts").includes('"/api/new-hire-accounts": { admin: "/admin/field-crm/new-hire-accounts" }'), "an error on it names its page");
  const nav = read("src/config/system-navigation.ts");
  const card = nav.slice(nav.indexOf('href: "/admin/field-crm/new-hire-accounts"'));
  assert.ok(card.slice(0, 500).includes('roles: ["Super Admin", "SFE Manager"]'), "🔴 the card draws for those two");
  assert.ok(card.slice(0, 500).includes('{ resource: "phoenix_crm", action: "approve" }'), "and asks the verb the SFE Manager holds");
}

function runScreenRules(): void {
  const screen = read("src/components/new-hire-accounts/new-hire-accounts-admin.tsx");
  const code = stripComments(screen);
  const block = screen.slice(screen.indexOf("const ACCOUNT_COLUMNS = ["), screen.indexOf("] as const;"));
  const widths = [...block.matchAll(/width: "(\d+)%"/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, 4, "the table names its widths");
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, "under table-fixed anything over 100% is cut, never scrolled");
  assert.ok(screen.indexOf("<CrmCardsOnPhone>") < screen.indexOf("<CrmTable"), "the phone's cards come before the desktop table");
  assert.ok(!/overflow-x|truncate|rounded-(?!none)/.test(code), "no horizontal scroll, no ellipsis, no round corners");
  assert.ok(!code.includes("router.refresh"), "🔴 a re-read must never take the only copy of a WhatsApp link off the screen");
  assert.ok(/<a className=\{phxWhatsAppSendButtonClassName\} href=\{result\.whatsAppUrl\}/.test(code), "🔴 a real anchor: a popup blocker cannot swallow it");
  assert.ok(code.includes("disabled={locked || missing}"), "🔴 a channel with no address cannot be pressed");
  assert.ok(code.includes("newHireMissingText(channel)"), "and says why");
  assert.ok(code.includes("lastSendOf(row) || view.lastSendUnavailable"), "🔴 a second link cancels the first, so it asks first, and an unreadable record counts as sent");
  assert.ok(code.includes("result.delivered ?"), "🔴 a mail that did not leave never reads as success");
  assert.ok(!/loginId\}<|\{row\.loginId\}\s*</.test(code), "the login is the key of the press and is never drawn");
  assert.ok(code.includes('dir="auto"'), "an Arabic name carries its own direction");
}
