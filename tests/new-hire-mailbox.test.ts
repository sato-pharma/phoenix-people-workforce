import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

// New Hire Mailboxes (src/lib/new-hire-mailbox/). Owner instruction 2026-09-18: when an employee is
// added, their Turbify mailbox is taken care of and its app password lands in Phoenix, so the new
// hire's My email works on day one with nothing for them to do. Turbify has no API for mailboxes or
// app passwords, so one person does the Turbify half on the New Hire Mailboxes page; everything
// around it is Phoenix's.
//
// PURE: the suite runs with production credentials, so this file calls only the two modules that do
// no I/O (address.ts, messages.ts) and reads everything else as source. Each section names the
// failure it stops.

const root = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

function code(relative: string): string {
  return stripComments(read(relative));
}

export async function runNewHireMailboxTests() {
  const address = await import("../src/lib/new-hire-mailbox/address.ts");
  const messages = await import("../src/lib/new-hire-mailbox/messages.ts");

  // 1. THE ADDRESS HR TYPED ALWAYS WINS — every hire added in September arrived with one, and some
  //    are spelt the company's way rather than the obvious one.
  assert.deepEqual(
    address.mailboxAddressCandidates({ fullName: "Mohamed Alaa Eleiwa", workEmail: " Mohamad.Hamed@SatoPharma.com " }),
    ["mohamad.hamed@satopharma.com"],
    "a typed company address must be the only candidate, lower-cased",
  );
  assert.equal(
    address.proposeMailboxAddress(
      { fullName: "Mohamed Alaa Eleiwa", workEmail: "mohamad.hamed@satopharma.com" },
      new Set(["mohamad.hamed@satopharma.com"]),
    ),
    "mohamad.hamed@satopharma.com",
    "the hire's own typed address shows up in the taken set BECAUSE it is theirs — it must still be proposed",
  );
  assert.deepEqual(
    address.mailboxAddressCandidates({ fullName: "Mona Ali", workEmail: "mona.ali@gmail.com" }),
    ["mona.ali@satopharma.com"],
    "a personal address on the record is not a company mailbox and must not be proposed as one",
  );

  // 2. THE HOUSE SHAPE for a hire saved without one: first.second, then first.third, then first.last,
  //    nickname before full name, Latin letters only.
  assert.deepEqual(
    address.mailboxAddressCandidates({ fullName: "Mohamed Alaa El-Said Eleiwa", nickname: "Mohamed Eleiwa" }),
    [
      "mohamed.eleiwa@satopharma.com",
      "mohamed.alaa@satopharma.com",
      "mohamed.elsaid@satopharma.com",
    ],
  );
  assert.equal(
    address.proposeMailboxAddress(
      { fullName: "Mohamed Alaa El-Said Eleiwa", nickname: "Mohamed Eleiwa" },
      new Set(["mohamed.eleiwa@satopharma.com"]),
    ),
    "mohamed.alaa@satopharma.com",
    "a taken address must fall through to the next candidate — two hires are never handed one mailbox",
  );
  assert.deepEqual(address.latinNameParts("محمد علي"), [], "Arabic script yields no Latin part");
  assert.equal(
    address.proposeMailboxAddress({ fullName: "محمد علي" }, new Set()),
    null,
    "a name with no Latin letters proposes nothing (the person types one) rather than an invented address",
  );
  assert.equal(address.isCompanyAddress("a.b@satopharma.com"), true);
  assert.equal(address.isCompanyAddress("a.b@satopharma.com.eg"), false);
  assert.equal(address.isCompanyAddress("a b@satopharma.com"), false);

  // 3. WHAT THE NOTICE SAYS. Names, not codes: no HR id and no mobile number in the detail rows; a
  //    hiring date stays on its own calendar day.
  const subject = {
    displayName: "Mona Ali",
    emailAddress: "mona.ali@satopharma.com",
    hireDate: "2026-09-20",
    hrId: "S-2044",
    jobTitle: "Medical Representative",
    lineName: "Pedia",
  };
  assert.equal(messages.newHireMailboxTitle(subject), "New employee — company email needed: Mona Ali");
  const body = messages.newHireMailboxMessage(subject);
  assert.ok(body.includes("mona.ali@satopharma.com"), "the body names the address to create");
  assert.ok(body.includes('"Phoenix email"'), "the body names the app password the way Turbify will list it");
  const details = messages.newHireMailboxDetails(subject);
  assert.deepEqual(
    details.map((detail) => detail.label),
    ["Employee", "Job title", "Line", "Hiring date", "Email to create"],
  );
  assert.equal(details.find((detail) => detail.label === "Hiring date")?.value, "20 September 2026");
  for (const detail of details) {
    assert.ok(!detail.value.includes("S-2044"), `the "${detail.label}" row leaks the HR id — names, never codes`);
  }
  assert.ok(!details.some((detail) => /mobile|phone/i.test(detail.label)), "the notice carries no mobile number");
  assert.equal(
    messages.newHireMailboxDetails({ ...subject, emailAddress: null }).at(-1)?.value,
    messages.NO_ADDRESS_YET,
  );
  assert.equal(messages.newHireMailboxHref("S-2044"), "/new-hire-mailboxes?hrId=S-2044");

  // 4. NEVER EMAIL. The owner's standing rule, and the notice is about a mailbox that does not exist
  //    yet. The channels constant, the call site and the policy row must all agree.
  assert.deepEqual(
    [...messages.NEW_HIRE_MAILBOX_CHANNELS],
    ["in_app", "telegram"],
    "the new hire mailbox notice goes in-app and on Telegram, and never by email",
  );
  const notify = code("src/lib/new-hire-mailbox/notify.ts");
  assert.ok(notify.includes("channels: [...NEW_HIRE_MAILBOX_CHANNELS]"), "the send must pass the channel constant");
  assert.ok(!/"email"/.test(notify), "the new hire mailbox notice must never name the email channel");
  assert.ok(
    /idempotencyKey: `new-hire-mailbox:\$\{canonicalHrIdKey\(subject\.hrId\)\}`/.test(notify),
    "one notice per hire: the key is the folded HR id and carries no date",
  );
  const policy = code("src/lib/notifications/policy.ts");
  const policyEntry = /"new_hire_mailbox\.\*":\s*\{([^}]*)\}/.exec(policy)?.[1] ?? "";
  assert.ok(policyEntry.includes('channels: ["in_app", "telegram"]'), "the policy row must allow in-app and Telegram only");
  assert.ok(policyEntry.includes("telegramAllowed: true"));

  // 5. THE TURBIFY LINK is one URL across Phoenix: this page and Mailbox Revocation send the same
  //    person to the same control panel.
  const offboarding = read("src/lib/mailbox-offboarding/service.ts");
  assert.equal(
    /export const TURBIFY_CONTROL_PANEL_URL = "([^"]+)"/.exec(offboarding)?.[1],
    messages.TURBIFY_CONTROL_PANEL_URL,
  );

  // 6. BOTH employee-create paths open the task. A hire added by import and never announced would
  //    arrive on day one with no mailbox and nobody told.
  assert.ok(
    code("app/api/employees/route.ts").includes('source: "manual_add"'),
    "the manual employee add must open the new hire mailbox task",
  );
  assert.ok(
    /await openAndAnnounceNewHireMailboxes\(\{/.test(code("app/api/employees/route.ts")),
    "the manual employee add must call openAndAnnounceNewHireMailboxes",
  );
  const importRoute = code("app/api/imports/employees/confirm/route.ts");
  assert.ok(
    /await openAndAnnounceNewHireMailboxes\(\{/.test(importRoute),
    "the confirmed employee import must call openAndAnnounceNewHireMailboxes",
  );
  assert.ok(importRoute.includes('source: "employee_import"'), "the confirmed import must open the task too");

  // 7. THE ROUTE. Server-side permission before any work, same-origin only, rate-limited per hire
  //    (each try is two real logins, and Yahoo locks a mailbox after enough failures), and the app
  //    password goes to the service and NOWHERE else — never logged, audited or sent back.
  const route = code("app/api/new-hire-mailboxes/route.ts");
  const csrfAt = route.indexOf("assertSameOriginMutation(request)");
  const permissionAt = route.indexOf('await assertPermission(access, "mailbox_offboarding", "update")');
  const bodyAt = route.indexOf("request.json()");
  assert.ok(csrfAt > 0 && permissionAt > csrfAt && bodyAt > permissionAt, "CSRF, then permission, then the body");
  assert.ok(/scope: "new-hire-mailbox:connect"/.test(route), "the connect action must be rate-limited");
  assert.deepEqual(
    route
      .split("\n")
      .filter((line) => line.includes("appPassword"))
      .map((line) => line.trim()),
    ["appPassword?: unknown;", 'appPassword: typeof body.appPassword === "string" ? body.appPassword : "",'],
    "the app password may appear in the body type and in the one call that hands it to the service — nowhere else",
  );
  assert.ok(
    /appPassword: typeof body\.appPassword === "string" \? body\.appPassword : ""/.test(route),
    "the app password must go straight to connectNewHireMailboxTask",
  );
  assert.ok(!/console\.|logError\(/.test(route), "the route logs nothing — a log line is how a password leaks");
  for (const block of route.match(/writeAuditLog\(\{[\s\S]*?\}\);/g) ?? []) {
    assert.ok(!/password/i.test(block), "an audit row must never carry the app password");
  }
  const { findAccessRegistryEntry } = await import("../src/lib/security/access-registry.ts");
  const entry = findAccessRegistryEntry("/api/new-hire-mailboxes", "POST");
  assert.equal(entry?.pattern, "/api/new-hire-mailboxes");
  assert.deepEqual(entry?.permission, { action: "update", resource: "mailbox_offboarding" });
  assert.equal(entry?.csrf.required, true);

  // 8. THE ONE PATH THAT WRITES A MY-EMAIL ROW FOR SOMEBODY ELSE, AND ONLY WRITES. It seals under the
  //    hire's own single active login, it INSERTS (a connection the hire made themselves wins, never
  //    overwritten), and it checks the password with Turbify only after every cheap refusal.
  const personal = code("src/lib/personal-mailbox/service.ts");
  const start = personal.indexOf("export async function connectNewHireMailbox(");
  const connect = personal.slice(start, personal.indexOf("\n}\n", start));
  assert.ok(start > 0 && connect.length > 0, "connectNewHireMailbox must live in the personal-mailbox service");
  assert.ok(/\.insert\(\{/.test(connect), "a new hire's connection is INSERTED");
  assert.ok(!/\.upsert\(/.test(connect), "upsert would overwrite a connection the hire made themselves");
  assert.ok(!/openSecret\(/.test(connect), "the admin path writes a sealed password and never opens one");
  assert.ok(/\.eq\("is_active", true\)/.test(connect), "only an ACTIVE login may own the mailbox");
  assert.ok(/logins\.length > 1/.test(connect), "two active logins on one HR id must be refused, not guessed between");
  assert.ok(
    connect.indexOf("verifyAppPassword(") > connect.indexOf('.neq("owner_key", key)'),
    "no Turbify login is spent before the address-already-taken refusal",
  );
  assert.ok(/code === "23505"/.test(connect), "a connection that appeared mid-flight is a refusal, not a crash");
  // The personal-mailbox privacy pin (tests/personal-mailbox.test.ts §9) still holds: the new module
  // reaches the table only through that service.
  for (const file of [
    "src/lib/new-hire-mailbox/service.ts",
    "src/lib/new-hire-mailbox/notify.ts",
    "app/api/new-hire-mailboxes/route.ts",
    "src/components/new-hire-mailbox/new-hire-mailbox-panel.tsx",
  ]) {
    assert.ok(!/sealSecret|openSecret|mailbox_monitors/.test(read(file)), `${file} must not handle sealed secrets itself`);
  }

  // 8b. THE LOWER-CASE KEY BUG. A session's hrId is the lower-case comparison key while employees
  //     store "B-10", so a plain .eq on it matched nobody and My email silently fell back to the
  //     login's address — wrong for a new hire whose company address was filled in later.
  const ownerStart = personal.indexOf("export async function resolveMailboxOwner(");
  const owner = personal.slice(ownerStart, personal.indexOf("\n}\n", ownerStart));
  assert.ok(/\.in\("hr_id", hrIdLookupKeys\(hrId\)\)/.test(owner), "the employee lookup must try every stored case");
  assert.ok(!/\.eq\("hr_id", hrId\)/.test(owner));

  // 9. THE TASK SERVICE refuses what the database would otherwise have to: an address another
  //    employee already holds, and a work email that differs only by case (the column's UNIQUE is
  //    case-sensitive).
  const tasks = code("src/lib/new-hire-mailbox/service.ts");
  assert.ok(/isCompanyAddress\(/.test(tasks), "only a company address can be connected for a new hire");
  assert.ok(/connectNewHireMailbox\(\{/.test(tasks));
  const directory = code("src/lib/employees/employee-directory.ts");
  const setStart = directory.indexOf("export async function setEmployeeWorkEmail(");
  const setWorkEmail = directory.slice(setStart, directory.indexOf("\n}\n", setStart));
  assert.ok(/work_email=ilike\./.test(setWorkEmail), "the duplicate check must be case-insensitive");
  assert.ok(
    /\.trim\(\)\.toLowerCase\(\) === workEmail/.test(setWorkEmail),
    "ilike over-matches on _, so an exact comparison must narrow it",
  );
  assert.ok(/invalidateEmployeeDirectoryCache\(\)/.test(setWorkEmail));

  // 10. THE TABLE is closed to browsers and holds no credential.
  const migration = read("supabase/migrations/20260918112210_new_hire_mailbox_tasks.sql");
  assert.ok(migration.includes("alter table public.new_hire_mailbox_tasks enable row level security;"));
  assert.ok(migration.includes("revoke all on public.new_hire_mailbox_tasks from public, anon, authenticated;"));
  assert.ok(migration.includes("grant select, insert, update on public.new_hire_mailbox_tasks to service_role;"));
  const tableBody = /create table if not exists public\.new_hire_mailbox_tasks \(([\s\S]*?)\n\);/.exec(migration)?.[1] ?? "";
  const columns = [...tableBody.matchAll(/^\s+([a-z_]+)\s+(?:uuid|text|timestamptz)\b/gm)].map((match) => match[1]);
  assert.ok(columns.includes("email_address") && columns.length >= 10, `the column scan read only ${columns.join(", ")}`);
  assert.deepEqual(
    columns.filter((column) => /password|secret|sealed|credential/.test(column)),
    [],
    "the task table must hold no credential column — the app password is sealed into My email, nowhere else",
  );
  assert.ok(
    /on public\.new_hire_mailbox_tasks \(email_address\)\s+where email_address is not null and status <> 'not_needed'/.test(migration),
    "two open tasks must never hold the same address",
  );

  // 11. THE AUDIENCE ROW is seeded byte-matched to the code default, so the recipients console and
  //     the send path cannot disagree — and re-running it never clobbers an admin's later edit.
  const keyMigration = read("supabase/migrations/20260918120027_notification_role_policies_new_hire_mailbox_key.sql");
  const { DEFAULT_NOTIFICATION_ROLE_POLICIES } = await import("../src/lib/notifications/role-recipients.ts");
  const audience = DEFAULT_NOTIFICATION_ROLE_POLICIES.new_hire_mailbox_alert;
  assert.deepEqual(audience.roles, ["Super Admin"], "the owner named himself as the one who creates mailboxes");
  assert.equal(
    keyMigration.match(/'((?:[^']|'')*)',\s*\n\s*array\['Super Admin'\], true\)/)?.[1].replace(/''/g, "'"),
    audience.description,
    "the seeded description must be byte-matched to the TypeScript default",
  );
  assert.ok(keyMigration.includes("on conflict (notification_key) do nothing"));
}
