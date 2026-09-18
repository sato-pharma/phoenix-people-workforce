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
  assert.equal(routes.length, 5, "the five personal-mailbox routes");
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
}
