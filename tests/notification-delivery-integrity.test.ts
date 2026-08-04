import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { buildEmailActivityPage, type EmailActivityRow } from "../src/lib/email/engagement.ts";
import { isPersonalBellCategory, PERSONAL_BELL_CATEGORIES } from "../src/lib/notifications/recipients.ts";
import {
  dedupeRecipientsByPerson,
  type NotificationRoleRecipientAccount,
} from "../src/lib/notifications/role-recipients.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function account(
  hrId: string,
  userId: string | null,
  bindings: Partial<Pick<NotificationRoleRecipientAccount, "hasEmail" | "hasPush" | "hasTelegram">> = {},
): NotificationRoleRecipientAccount {
  return {
    hasEmail: bindings.hasEmail ?? false,
    hasPush: bindings.hasPush ?? false,
    hasTelegram: bindings.hasTelegram ?? false,
    hrId,
    userId,
  };
}

function activityRow(id: string, overrides: Partial<EmailActivityRow> = {}): EmailActivityRow {
  return {
    bounced: false,
    clicked: false,
    delivered: false,
    failedReason: null,
    id,
    lastActivityAt: null,
    opened: false,
    provider: "resend",
    recipientEmail: `person-${id}@satopharma.com`,
    recipientName: null,
    sendStatus: "sent",
    sentAt: null,
    subject: "Payslip",
    ...overrides,
  };
}

export function runNotificationDeliveryIntegrityTests() {
  // ── One person, one notification ────────────────────────────────────────────────
  // Live production shape (app_auth_users, 2026-08-04): the two active Super Admin accounts are
  // B-10 (the HR Manager, the only one with a mailbox) and PHX-1 / login admin-HR (the
  // system-administrator console, the only one holding the Telegram chat and the push
  // subscription). They are one human, so every role-addressed digest was delivered twice.
  const superAdminAccounts = [
    account("B-10", "B-10", { hasEmail: true }),
    account("PHX-1", "admin-HR", { hasPush: true, hasTelegram: true }),
  ];
  const superAdmins = dedupeRecipientsByPerson(superAdminAccounts);
  assert.equal(
    superAdmins.length,
    1,
    "B-10 and PHX-1 are one human, so a role-addressed digest must produce one recipient, not two",
  );
  assert.equal(
    superAdmins[0].hrId,
    "PHX-1",
    "the console account carries the Telegram and push bindings — keeping the mailbox account instead would fix the duplicate by silencing two channels",
  );
  assert.equal(
    superAdmins[0].userId,
    "admin-HR",
    "the surviving entry must keep its own login id, or the delivery path resolves a different profile than the one that was chosen",
  );
  assert.deepEqual(
    dedupeRecipientsByPerson([...superAdminAccounts].reverse()),
    superAdmins,
    "the pick must not depend on the order Supabase returns the accounts in — an unstable pick re-delivers under a fresh idempotency key",
  );

  // Different people must never be merged: this is a per-person dedupe, not a per-role one.
  const twoPeople = dedupeRecipientsByPerson([
    account("A-2", "A-2", { hasEmail: true }),
    account("B-10", "B-10", { hasEmail: true }),
  ]);
  assert.equal(twoPeople.length, 2, "two unrelated Super Admins are two humans and must each still be notified");

  // Case drift on one HR_ID is the same account, not a second person.
  assert.equal(
    dedupeRecipientsByPerson([account("b-10", "B-10", { hasEmail: true }), account("B-10", "B-10", { hasEmail: true })]).length,
    1,
    "the same HR_ID in two spellings is one person — matching must be canonicalized, never raw string equality",
  );

  // With nothing to separate them, the person's real employee HR_ID wins, so the choice is
  // explainable rather than whichever row the query happened to return first.
  const tied = dedupeRecipientsByPerson([account("PHX-1", "admin-HR"), account("B-10", "B-10")]);
  assert.equal(tied.length, 1, "a tie is still one person");
  assert.equal(tied[0].hrId, "B-10", "when no account can deliver, fall back to the person's canonical employee HR_ID");

  assert.equal(
    dedupeRecipientsByPerson([account("", null, { hasEmail: true })]).length,
    0,
    "a blank HR_ID is not a person and must never become a recipient",
  );

  // The cron path must actually use it — a shared resolver nobody calls fixes nothing.
  const syncDigest = source("src/lib/notifications/ireports360-sync-digest.ts");
  assert.match(
    syncDigest,
    /resolveNotificationPersonRecipients\("ireports360_sync_notify", "Sync-notify recipients"\)/,
    "the sync digest must resolve recipients per person through the shared resolver",
  );
  assert.doesNotMatch(
    syncDigest,
    /\.from\("app_auth_users"\)/,
    "enumerating auth accounts in the digest is what delivered it twice — it must not query them again",
  );

  // ── Bell allowlist covers what the code actually emits ───────────────────────────
  // notifyDirectOrder writes category "direct_order_request" and records its in_app delivery as
  // "sent"; while the category was off this list the approver saw nothing and the delivery audit
  // still reported success.
  assert.equal(
    isPersonalBellCategory("direct_order_request"),
    true,
    "direct-order approval notifications claim in_app delivery, so the bell must be able to render them",
  );
  assert.equal(
    (PERSONAL_BELL_CATEGORIES as readonly string[]).includes("direct_order_request"),
    true,
    "the SQL category filter reads this array — an entry only in the predicate would still be filtered out by the query",
  );
  assert.match(
    source("src/lib/direct-orders/service.ts"),
    /category: "direct_order_request"/,
    "the allowlist entry is only correct while this is the category the direct-order notifier writes",
  );

  // ── Chips describe the window, not the first page ────────────────────────────────
  // Production, last 30 days (2026-08-04): 996 sends, of which 910 sent / 86 not sent. Summarizing
  // the 200-row display page reported 178 / 22 under a heading that said "Last 30 days".
  const windowRows = [
    ...Array.from({ length: 200 }, (_, index) => activityRow(`sent-${index}`, { opened: true })),
    ...Array.from({ length: 100 }, (_, index) => activityRow(`skipped-${index}`, { sendStatus: "skipped" })),
  ];
  const { rows, summary } = buildEmailActivityPage(windowRows, 200);
  assert.equal(rows.length, 200, "the table still renders a single bounded page");
  assert.equal(summary.total, 300, "the chips must count the whole window, not the rows that fit on the page");
  assert.equal(summary.notSent, 100, "summarizing the display page would report 0 not-sent for a window holding 100");
  assert.equal(summary.sent, 200, "sent counts every send in the window");
  assert.equal(summary.opened, 200, "opened counts every open in the window");

  const engagement = source("src/lib/email/engagement.ts");
  assert.match(
    engagement,
    /\.\.\.buildEmailActivityPage\(matched, limit\)/,
    "the summary must be built from the full matched window, so it cannot be handed the sliced page",
  );
  assert.doesNotMatch(
    engagement,
    /if \(rows\.length >= limit\) break;/,
    "stopping the scan at the page limit is what made the chips describe one page instead of the window",
  );
}
