import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// "My email" in the envelope — each person's OWN Turbify mailbox, connected once with their own app
// password (src/lib/personal-mailbox/). The owner's rule for it is PRIVATE TO EACH PERSON: nobody
// else can open it through Phoenix, the compliance monitor least of all. Most of that promise is a
// property of what code does NOT exist — no id in any request, no admin screen, no path from the
// monitor — so most of this file reads source rather than calling functions. Each section names the
// failure it stops.

const root = process.cwd();
const TEST_SECRET = "phoenix-personal-mailbox-test-key-do-not-use-in-production";

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

function walk(relative: string): string[] {
  const full = path.join(root, relative);
  let entries: string[];
  try {
    entries = readdirSync(full);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const child = path.join(relative, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    const stats = statSync(path.join(root, child));
    if (stats.isDirectory()) return walk(child);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [child.split(path.sep).join("/")] : [];
  });
}

export async function runPersonalMailboxTests() {
  const rules = await import("../src/lib/personal-mailbox/rules.ts");

  // 0. THE OUTGOING SERVER. A Turbify business mailbox sends through smtp.bizmail.yahoo.com. Yahoo's
  //    consumer server (smtp.mail.yahoo.com) accepts the login and then refuses every @satopharma.com
  //    message with reply 550 — both hr@ job offers on 8 Nov 2026 died that way.
  assert.deepEqual(
    { ...rules.TURBIFY_SMTP },
    { host: "smtp.bizmail.yahoo.com", port: 465, secure: true },
    "Turbify business mail must be sent through smtp.bizmail.yahoo.com:465 — the consumer Yahoo server refuses it with 550",
  );

  // 1. WHOSE MAILBOX. The key comes from the session only — HR id first, upper case; the login id
  //    for the one kind of account with no HR id. A mismatch here would split one person across
  //    two rows, or (worse) merge two people into one.
  assert.equal(rules.mailboxOwnerKey({ hrId: " b-10 ", loginId: "omar" }), "B-10");
  assert.equal(rules.mailboxOwnerKey({ hrId: null, loginId: " Admin-HR " }), "admin-hr");
  assert.equal(rules.mailboxOwnerKey({ hrId: "  ", loginId: "" }), null);

  // 2. Addresses as people type or paste them.
  assert.deepEqual(rules.parseAddressList("A@x.com; Ahmed <b@y.org>\n a@x.com,, not-an-address"), {
    invalid: ["not-an-address"],
    valid: ["a@x.com", "b@y.org"],
  });
  assert.equal(rules.replySubject("Re: budget"), "Re: budget");
  assert.equal(rules.replySubject("budget"), "Re: budget");
  assert.equal(rules.replySubject(null), "Re:");

  // 3. Reply and Reply all. Reply-To wins over the sender; the owner is never put back on their own
  //    reply; replying to an email the owner SENT goes to its recipients.
  const received = {
    ccAddresses: ["cc@x.com", "me@satopharma.com"],
    fromAddress: "boss@x.com",
    replyToAddresses: ["desk@x.com"],
    toAddresses: ["me@satopharma.com", "peer@x.com"],
  };
  assert.deepEqual(rules.replyRecipients(received, "ME@satopharma.com", false), { cc: [], to: ["desk@x.com"] });
  assert.deepEqual(rules.replyRecipients(received, "me@satopharma.com", true), {
    cc: ["peer@x.com", "cc@x.com"],
    to: ["desk@x.com"],
  });
  assert.deepEqual(
    rules.replyRecipients(
      { ccAddresses: [], fromAddress: "me@satopharma.com", replyToAddresses: [], toAddresses: ["client@x.com"] },
      "me@satopharma.com",
      false,
    ),
    { cc: [], to: ["client@x.com"] },
    "a reply to one's own sent email must go to its recipients, not to nobody",
  );
  const chain = Array.from({ length: 25 }, (_, index) => `<m${index}@x>`);
  const references = rules.replyReferences({ messageId: "<last@x>", references: chain });
  assert.equal(references.length, 20);
  assert.equal(references.at(-1), "<last@x>");

  // 4. Refused before a login is spent on it.
  const base = { attachments: [], body: "hello", cc: [], inReplyTo: null, references: [], subject: "Hi", to: ["a@x.com"] };
  rules.validateSendInput(base);
  assert.throws(() => rules.validateSendInput({ ...base, to: [] }), /at least one address/);
  assert.throws(() => rules.validateSendInput({ ...base, body: "", subject: " " }), /empty/);
  assert.throws(
    () => rules.validateSendInput({ ...base, cc: Array.from({ length: 50 }, (_, index) => `p${index}@x.com`) }),
    /at most 50/,
  );
  assert.throws(
    () =>
      rules.validateSendInput({
        ...base,
        attachments: [{ content: Buffer.alloc(rules.MAX_ATTACHMENT_TOTAL_BYTES + 1), contentType: "application/pdf", filename: "a.pdf" }],
      }),
    /15 MB/,
  );

  // 5. THE LOCKOUT RULE's trigger. Yahoo locks a mailbox after enough failed logins; these are the
  //    shapes both mail clients use for "wrong password", and nothing else may count as one.
  assert.equal(rules.isAuthenticationFailure({ authenticationFailed: true }), true, "imapflow LOGIN refusal");
  assert.equal(rules.isAuthenticationFailure({ serverResponseCode: "AUTHENTICATIONFAILED" }), true);
  assert.equal(rules.isAuthenticationFailure({ code: "EAUTH" }), true, "nodemailer auth refusal");
  assert.equal(rules.isAuthenticationFailure({ responseCode: 535 }), true);
  assert.equal(rules.isAuthenticationFailure({ code: "ETIMEDOUT" }), false, "a timeout is not a wrong password");
  assert.equal(rules.isAuthenticationFailure(null), false);

  // 5b. A failed send's description is ALSO the error-monitor row, so it carries the reply code and
  //     never the server's text: a refusal quotes the recipient, and nodemailer appends it to message.
  const recipient = "someone.private@example.com";
  const refusedRecipients = rules.describeSmtpError({
    code: "EENVELOPE",
    message: `Can't send mail - all recipients were rejected: 550 5.1.1 <${recipient}>: Recipient address rejected`,
    response: `550 5.1.1 <${recipient}>: Recipient address rejected`,
    responseCode: 550,
  });
  assert.equal(refusedRecipients, "the outgoing mail server refused the recipients (reply 550)");
  for (const shape of [
    { code: "EMESSAGE", message: `Message failed: 554 rejected for ${recipient}`, response: `554 rejected for ${recipient}`, responseCode: 554 },
    { message: `unexpected reply mentioning ${recipient}` },
  ]) {
    assert.ok(
      !rules.describeSmtpError(shape).includes(recipient),
      "a send failure must never copy the mail server's reply (and the recipient it names) into the error monitor",
    );
  }

  // 6. Downloads and threading headers cannot be turned into header injection.
  assert.equal(rules.safeAttachmentFilename('..\\..\\evil"\r\nname.pdf'), "evilname.pdf");
  assert.equal(rules.safeAttachmentFilename("   "), "attachment");
  const disposition = rules.attachmentDisposition("تقرير \"شهري\".pdf");
  assert.ok(disposition.startsWith("attachment; "), "an attachment is always downloaded, never rendered inline");
  assert.ok(!/[\r\n]/.test(disposition));
  assert.ok(disposition.includes("filename*=UTF-8''"), "the real (Arabic) name travels in the RFC 5987 form");
  assert.deepEqual(rules.parseMessageIdList("<a@x> junk <b@y>\r\nBcc: evil@x.com <a@x>"), ["<a@x>", "<b@y>"]);

  // 7. The reader. Inline images come back as data URIs within a budget; the document blocks the
  //    referrer and opens links in a new tab.
  const html = rules.embedInlineImages('<img src="cid:logo@x"><img src="cid:big@x">', [
    { base64: Buffer.from("png").toString("base64"), contentId: "<logo@x>", contentType: "image/png" },
    { base64: "A".repeat(4 * 1024 * 1024), contentId: "<big@x>", contentType: "image/png" },
  ]);
  assert.ok(html.includes("data:image/png;base64,"));
  assert.ok(html.includes("cid:big@x"), "an image past the budget is left as a reference, not embedded");
  const document = rules.readerDocument("<p>x</p>");
  assert.ok(document.includes('<meta name="referrer" content="no-referrer">'));
  assert.ok(document.includes('<base target="_blank">'));

  const panel = read("src/components/layout/personal-mailbox-panel.tsx");
  const sandbox = /sandbox="([^"]*)"/.exec(panel);
  assert.ok(sandbox, "the email reader must render inside a sandboxed iframe");
  assert.ok(
    !/allow-scripts|allow-same-origin/.test(sandbox[1]),
    "a received email must never run script or share Phoenix's origin — that would let any sender act as the signed-in person",
  );
  assert.ok(!/dangerouslySetInnerHTML/.test(panel), "email HTML is never put into the Phoenix page itself");

  // 8. THE CRYPTOGRAPHIC HALF OF THE PRIVACY RULE. A personal app password is sealed under its own
  //    context: the monitor's openSecret (no context) must fail on it, and it must fail the other way
  //    round too. Existing monitor blobs (no context) are unaffected — tests/secret-box.test.ts pins
  //    the stored fixture byte for byte.
  const previous = process.env.MAILBOX_MONITOR_SECRET;
  process.env.MAILBOX_MONITOR_SECRET = TEST_SECRET;
  try {
    const { openSecret, sealSecret } = await import("../src/lib/security/secret-box.ts");
    const context = { context: rules.PERSONAL_MAILBOX_SECRET_CONTEXT };
    const personal = sealSecret("abcdefghijklmnop", context);
    assert.equal(openSecret(personal, context), "abcdefghijklmnop");
    assert.throws(
      () => openSecret(personal),
      "the compliance monitor (which opens with no context) must NOT be able to decrypt a personal app password",
    );
    const monitor = sealSecret("monitor-password");
    assert.equal(openSecret(monitor), "monitor-password", "a context-free seal must still open context-free");
    assert.throws(() => openSecret(monitor, context), "a monitor password must not open as a personal one either");
    assert.equal(openSecret(monitor, { context: "  " }), "monitor-password", "a blank context is no context");
  } finally {
    if (previous === undefined) delete process.env.MAILBOX_MONITOR_SECRET;
    else process.env.MAILBOX_MONITOR_SECRET = previous;
  }

  // 9. THE CODE HALF. The monitor never touches the personal table or module, the personal module
  //    never touches the monitor's table or its live client, and only the personal service names the
  //    table at all.
  const monitorFiles = [
    ...walk("src/lib/mailbox-monitor"),
    ...walk("app/api/admin/mailbox-monitor"),
    ...walk("src/components/admin").filter((file) => file.includes("mailbox-monitor")),
  ];
  assert.ok(monitorFiles.length >= 6, `the monitor scan found only ${monitorFiles.length} files — has it moved?`);
  for (const file of monitorFiles) {
    assert.ok(
      !/personal_mailbox|personal-mailbox/.test(read(file)),
      `${file} reaches the personal mailbox — the compliance monitor must never be able to open a person's own mailbox`,
    );
  }
  const personalFiles = [...walk("src/lib/personal-mailbox"), ...walk("app/api/messages/mailbox")];
  assert.ok(personalFiles.length >= 11, `the personal-mailbox scan found only ${personalFiles.length} files`);
  for (const file of personalFiles) {
    const source = read(file);
    assert.ok(!source.includes("mailbox_monitors"), `${file} reads the monitor's table`);
    assert.ok(
      !/@\/lib\/mailbox-monitor\/(service|imap-client)/.test(source),
      `${file} imports the monitor's service or live client — only its pure helpers may be shared`,
    );
  }
  const tableReaders = [...walk("src"), ...walk("app")].filter((file) =>
    read(file).includes("personal_mailbox_connections"),
  );
  assert.deepEqual(
    tableReaders,
    ["src/lib/personal-mailbox/service.ts"],
    "only the personal-mailbox service may read personal_mailbox_connections — a second reader is a second way in",
  );

  // 10. Whose mailbox a request reaches is decided by the session, never by the request. Every route
  //     resolves the owner from the access context and reads no person identifier from its input.
  const routes = walk("app/api/messages/mailbox").filter((file) => file.endsWith("/route.ts"));
  assert.equal(routes.length, 6, "the six personal-mailbox routes");
  for (const file of routes) {
    const source = read(file);
    assert.ok(source.includes("resolveAccessContext(request)"), `${file} must resolve the session`);
    assert.ok(source.includes("resolveMailboxOwner(access)"), `${file} must take the owner from the session`);
    assert.ok(
      !/searchParams\.get\("(hrId|hr_id|owner|ownerKey|loginId|email|emailAddress|address)"\)|body\.(hrId|owner|loginId|email)/.test(source),
      `${file} reads a person identifier from the request — that is how one employee would open another's mailbox`,
    );
    const mutations = source.match(/export async function (POST|DELETE|PUT|PATCH)\b/g) ?? [];
    const csrfChecks = source.match(/assertSameOriginMutation\(request\)/g) ?? [];
    assert.equal(csrfChecks.length, mutations.length, `${file}: every mutation must be same-origin only`);
  }
  const attachmentRoute = read("app/api/messages/mailbox/attachment/route.ts");
  assert.ok(attachmentRoute.includes('"Content-Type": "application/octet-stream"'));
  assert.ok(attachmentRoute.includes('"X-Content-Type-Options": "nosniff"'));
  assert.ok(attachmentRoute.includes("attachmentDisposition("));

  const service = read("src/lib/personal-mailbox/service.ts");
  assert.ok(
    /access\.source === "guest"/.test(service),
    "an unauthenticated caller resolves to role Employee — only the SOURCE tells a guest apart",
  );
  const refuseAt = service.indexOf('row.status === "needs_reconnect"');
  const openAt = service.indexOf("openSecret(row.sealed_password");
  assert.ok(
    refuseAt > 0 && openAt > refuseAt,
    "a mailbox Turbify already refused must be stopped BEFORE the password is opened and used again (Yahoo lockout)",
  );
  assert.ok(
    /isAuthenticationFailure\(error\)\) \{\s*await markNeedsReconnect/.test(service),
    "a refused password must flip the connection to needs_reconnect, or the next click logs in with it again",
  );
  const bodyOf = (name: string) => {
    const start = service.indexOf(`function ${name}`);
    const end = service.indexOf("\n}\n", start);
    return start >= 0 && end > start ? service.slice(start, end) : "";
  };
  assert.ok(
    /if \(isAuthenticationFailure\(error\)\) await markRefused\(\);/.test(bodyOf("sendPersonalMailboxEmail")),
    "filing the Sent copy is best-effort, but a refused password there must still stop every later login",
  );

  // 10b. A connection answers to the LOGIN that made it. app_auth_users.hr_id is not unique and user
  //      admin can set it on any login, so matching on the HR id alone let a second login carrying
  //      someone's HR id open their mailbox.
  for (const name of ["loadConnection", "disconnectPersonalMailbox"]) {
    assert.ok(
      bodyOf(name).includes('.eq("owner_login_id", owner.loginId)'),
      `${name} must match the signed-in login as well as the owner key — or another login on the same HR id reaches the mailbox`,
    );
  }
  assert.ok(
    /if \(!key \|\| !loginId\) throw new PersonalMailboxError/.test(bodyOf("resolveMailboxOwner")),
    "an identity with no login (the dev-header one) has no mailbox",
  );

  // 11. The access registry declares them honestly: owner-only (no permission), CSRF on writes, and
  //     resolved ahead of the /api/messages/** blanket.
  const { findAccessRegistryEntry } = await import("../src/lib/security/access-registry.ts");
  for (const [route, method] of [
    ["/api/messages/mailbox", "GET"],
    ["/api/messages/mailbox", "POST"],
    ["/api/messages/mailbox", "DELETE"],
    ["/api/messages/mailbox/send", "POST"],
    ["/api/messages/mailbox/attachment", "GET"],
    ["/api/messages/mailbox/unread", "GET"],
  ] as const) {
    const entry = findAccessRegistryEntry(route, method);
    assert.equal(entry?.pattern, "/api/messages/mailbox/**", `${method} ${route} must resolve to the personal-mailbox entry`);
    assert.equal(entry?.permission, null);
    if (method !== "GET") assert.equal(entry?.csrf.required, true, `${method} ${route} must require CSRF`);
  }

  // 12. The table is closed to browsers, and a leaver's connection is purged daily.
  const migration = read("supabase/migrations/20260918102043_personal_mailbox_connections.sql");
  assert.ok(migration.includes("alter table public.personal_mailbox_connections enable row level security;"));
  assert.ok(migration.includes("revoke all on table public.personal_mailbox_connections from public, anon, authenticated;"));
  assert.ok(
    migration.includes(
      "revoke execute on function public.phx_purge_departed_personal_mailboxes() from public, anon, authenticated;",
    ),
  );
  assert.ok(
    read("app/api/cron/mailbox-offboarding-sweep/route.ts").includes("await purgeDepartedPersonalMailboxes()"),
    "the daily leaver sweep must forget departed owners' sealed passwords",
  );

  // 13. UNREAD COUNT AND NEW-MAIL ALERTS (owner request 2026-09-18). The envelope shows how many inbox
  //     emails are unread and pops up when a new one arrives. What "new" means is pure and pinned
  //     here: the first look announces nothing (2,000 old unread emails are not news), one email is
  //     announced once, and a folder Turbify renumbered starts over silently.
  const item = (uid: number, subject: string | null = `Subject ${uid}`) => ({
    date: null,
    fromAddress: `sender${uid}@x.com`,
    fromName: `Sender ${uid}`,
    subject,
    uid,
  });
  const inbox = { newestUnread: [item(98), item(101), item(100)], uidValidity: "777", watermark: 102 };
  const first = rules.newUnreadSince(null, inbox);
  assert.deepEqual(first.fresh, [], "the first look must announce nothing — every old unread email would pop up at once");
  assert.deepEqual(first.next, { uidValidity: "777", watermark: 102 });
  const later = rules.newUnreadSince({ uidValidity: "777", watermark: 100 }, inbox);
  assert.deepEqual(
    later.fresh.map((entry) => entry.uid),
    [101, 100],
    "only emails at or above the last watermark are new, newest first",
  );
  assert.deepEqual(rules.newUnreadSince(later.next, inbox).fresh, [], "an email already announced is never announced again");
  assert.equal(
    rules.newUnreadSince({ uidValidity: "777", watermark: 150 }, inbox).next.watermark,
    150,
    "the watermark never moves backwards",
  );
  assert.deepEqual(
    rules.newUnreadSince({ uidValidity: "111", watermark: 5 }, inbox).fresh,
    [],
    "a renumbered folder (new UIDVALIDITY) starts over silently instead of announcing its whole unread list",
  );
  assert.deepEqual(rules.parseMailAlertBaseline(JSON.stringify(later.next)), later.next);
  for (const junk of [null, "", "not json", '{"uidValidity":"","watermark":3}', '{"uidValidity":"7","watermark":-1}', '{"uidValidity":"7"}']) {
    assert.equal(rules.parseMailAlertBaseline(junk), null, `a stored baseline of ${String(junk)} is no baseline`);
  }

  assert.equal(rules.unreadBadgeLabel(0), null, "no unread email shows no badge");
  assert.equal(rules.unreadBadgeLabel(null), null);
  assert.equal(rules.unreadBadgeLabel(7), "7");
  assert.equal(rules.unreadBadgeLabel(99), "99");
  assert.equal(rules.unreadBadgeLabel(2319), "99+");

  assert.deepEqual(rules.newMailAlertText([item(5, "  Budget for October  ")]), {
    body: "Budget for October",
    title: "New email from Sender 5",
  });
  assert.equal(rules.newMailAlertText([{ ...item(5, null), fromName: null }])?.title, "New email from sender5@x.com");
  assert.equal(rules.newMailAlertText([item(5, null)])?.body, "(no subject)");
  assert.deepEqual(rules.newMailAlertText([item(9), item(8)]), {
    body: "Latest from Sender 9: Subject 9",
    title: "2 new emails",
  });
  assert.equal(
    rules.newMailAlertText(Array.from({ length: rules.PERSONAL_MAILBOX_ALERT_LIMIT }, (_, index) => item(20 - index)))?.title,
    `${rules.PERSONAL_MAILBOX_ALERT_LIMIT} or more new emails`,
    "a full list may be the top of more, so it must not claim an exact count",
  );
  assert.equal(rules.newMailAlertText([]), null);
  const longSubject = "A".repeat(400);
  assert.ok(
    rules.newMailAlertText([item(5, longSubject)])?.body === longSubject,
    "the pop-up shows the subject in full — the owner's rule is never to shorten text with an ellipsis",
  );

  // 13b. The unread check only LOOKS. Opening an email marks it read (as any mail client does); the
  //      background check runs every couple of minutes and must never change the mailbox.
  const imap = read("src/lib/personal-mailbox/imap.ts");
  const statusStart = imap.indexOf("export async function readInboxStatus");
  const statusBody = imap.slice(statusStart, imap.indexOf("\n}\n", statusStart));
  assert.ok(statusStart > 0, "readInboxStatus exists");
  assert.ok(
    statusBody.includes('getMailboxLock("INBOX", { readOnly: true })'),
    "the unread check must open the inbox read-only — a writable open can change flags",
  );
  assert.ok(!/messageFlags(Add|Set|Remove)|messageDelete|messageMove/.test(statusBody), "the unread check must never change a message");
  assert.ok(!/source: true/.test(statusBody), "the unread check fetches envelopes only, never a message body");

  const types = read("src/lib/personal-mailbox/types.ts");
  const alertTypeStart = types.indexOf("export type PersonalMailboxAlertItem");
  const alertType = types.slice(alertTypeStart, types.indexOf("};", alertTypeStart));
  assert.ok(alertTypeStart > 0 && !/\b(text|html|body|attachments|password)\b/.test(alertType), "an alert carries who and what about, never the email itself");

  // 13c. The route: owner from the session, its own ceiling, never cached by a browser or proxy.
  const unreadRoute = read("app/api/messages/mailbox/unread/route.ts");
  assert.ok(unreadRoute.includes('assertPersonalMailboxCeiling(owner.key, "poll")'), "the unread check has its own per-owner ceiling");
  assert.ok(unreadRoute.includes('"Cache-Control": "private, no-store"'));

  // 13d. The service: a refused or missing connection answers WITHOUT a login (withCredential stops it
  //      first), a mail server that did not answer is quiet, and opening an email clears the cached
  //      count so the badge does not bounce back up.
  const checkBody = bodyOf("checkInbox");
  assert.ok(checkBody.includes("withCredential(owner, readFailure"), "the unread check must go through withCredential and its lockout rule");
  assert.ok(checkBody.includes('if (error.statusCode === 409) return { kind: "needs_reconnect" }'));
  assert.ok(checkBody.includes('if (error.statusCode === 404) return { kind: "not_connected" }'));
  assert.ok(checkBody.includes('if (error.diagnostic) return { kind: "unavailable" }'), "a background check must not flood the error monitor while Yahoo is down");
  assert.ok(
    bodyOf("openPersonalMailboxMessage").includes("forgetInboxStatus(owner)"),
    "opening an email makes the cached unread count stale — it must be dropped",
  );
  for (const name of ["connectPersonalMailbox", "disconnectPersonalMailbox"]) {
    assert.ok(bodyOf(name).includes("forgetInboxStatus(owner)"), `${name} must drop the cached answer, or the envelope keeps the old state`);
  }

  // 13e. The browser side: someone who never connected, or whose password Turbify refused, is not
  //      asked about again; and the "allow notifications" prompt only ever comes from a click.
  const hook = read("src/hooks/use-personal-mailbox-alerts.ts");
  assert.ok(
    /status\.kind === "not_connected" \|\| status\.kind === "needs_reconnect"\) \{\s*stopped = true;/.test(hook),
    "the envelope must stop checking for someone with no working connection",
  );
  assert.equal((hook.match(/requestPermission\(/g) ?? []).length, 1, "exactly one permission request, in askForDesktopMailAlerts");
  const askStart = hook.indexOf("export function askForDesktopMailAlerts");
  assert.ok(askStart > 0 && hook.indexOf("requestPermission(", askStart) < hook.indexOf("\n}\n", askStart));
  const menu = read("src/components/layout/internal-messages-menu.tsx");
  assert.ok(
    /onClick=\{\(\) => \{[^}]*askForDesktopMailAlerts\(\)/.test(menu),
    "the notification permission is asked from the My email tab's click, never from a timer",
  );
  assert.ok(menu.includes("usePersonalMailboxAlerts("), "the envelope runs the unread watch");

  // 13f. ON A PHONE TOO (owner request 2026-09-18). The envelope was `hidden sm:inline-flex`, so a
  //      phone showed no unread count and "Open" had nothing to open. It is drawn at every width;
  //      its panel stops at the screen's bottom and scrolls, because it hangs from a header that
  //      does not scroll away; and a message subject wraps rather than sliding its list sideways.
  const trigger = /<button\s+aria-expanded=\{open\}[\s\S]*?className=\{`([^`]*)/.exec(menu);
  assert.ok(trigger, "the envelope's trigger button is where this test expects it");
  const triggerClasses = trigger[1].split(/\s+/);
  assert.ok(
    triggerClasses.includes("inline-flex") && !triggerClasses.includes("hidden"),
    "the envelope must be drawn on a phone — `hidden` there hides the unread count it carries",
  );
  // Widened 2026-09-28 from phones only to every width: the columns stack below `xl`, so a 1024x768
  // laptop had the Send button ~250px under the screen too. The cap is HEADER_PANEL_MAX_HEIGHT,
  // pinned with the rest of the header panels in tests/portal-nav-chrome-behaviour.test.ts.
  assert.ok(
    /maxHeight: HEADER_PANEL_MAX_HEIGHT/.test(menu) && menu.includes("overflow-y-auto rounded border shadow-lg"),
    "the panel must stop at the screen and scroll at every width, or its lower half can never be reached",
  );
  assert.ok(
    !/className=\{cn\("whitespace-nowrap text-sm font-black"/.test(menu),
    "a message subject must wrap — unwrapped, it slides the scrolling list sideways",
  );
}
