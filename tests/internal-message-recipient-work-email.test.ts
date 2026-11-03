// An internal message typed to an email lands with the employee whose WORK email it is, and a person
// can no longer rewrite their own sign-in email (audit point 3, owner-approved 2026-10-26).
//
// WHY THIS EXISTS. The profile screen (`/api/admin/profile` PATCH) let ANY signed-in user write ANY
// address into their own `app_auth_users.auth_email`, with no permission check and no verification.
// Internal messages then resolved a typed email with `email.ilike OR auth_email.ilike` and `limit(1)`
// with no order — so setting your auth_email to a colleague's address could capture the messages
// typed to them, and which of two matching logins won was Postgres's choice, not ours.
// Now:
//   - the profile route writes the display NAME only; the form's email field is read-only;
//   - a typed email matches the employee record's work email ONLY, current employees only, and two
//     employees sharing one is refused as ambiguous instead of picking one;
//   - the login/HR-id path picks the same login every time (exact login id, then active, then login
//     order) — `pickInternalRecipientUser`;
//   - the Super Admin recipient list for Private Calendar disputes runs its address through
//     `pickDeliverableEmail`, so a synthetic sign-in identity is never mailed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Namespace imports, so a build without the new pickers fails an ASSERTION below, not the import.
import * as service from "../src/lib/internal-messages/service.ts";
import * as notifyAdmin from "../src/lib/private-calendar/notify-admin.ts";
import { stripComments } from "./support/comment-strip.ts";

function code(path: string) {
  return stripComments(readFileSync(resolve(process.cwd(), path), "utf8"));
}

/** The text of one top-level function, from its declaration to the next top-level declaration. */
function functionBody(source: string, signature: RegExp) {
  const start = source.search(signature);
  assert.ok(start >= 0, `could not find ${signature} in the source`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s/);
  return next >= 0 ? source.slice(start, start + 1 + next) : source.slice(start);
}

function testTheWorkEmailPicker() {
  const pick = (service as Record<string, unknown>).pickWorkEmailEmployee;
  assert.equal(typeof pick, "function", "service.ts exports pickWorkEmailEmployee, the one work-email matcher");
  const pickWorkEmailEmployee = pick as typeof service.pickWorkEmailEmployee;

  const sara = { full_name: "Sara Adel", hr_id: "PD-0014", work_email: "Sara.Adel@satopharma.com" };
  assert.deepEqual(
    pickWorkEmailEmployee([sara], "sara.adel@satopharma.com"),
    { employee: sara, kind: "one" },
    "a work email matches its employee whatever the case",
  );

  // `_` is a one-character wildcard inside ilike, so the database answers a superset: the picker
  // keeps the literal address only.
  const lookalike = { full_name: "Other Person", hr_id: "PD-0099", work_email: "saraxadel@satopharma.com" };
  const underscored = { full_name: "Sara Adel", hr_id: "PD-0014", work_email: "sara_adel@satopharma.com" };
  assert.deepEqual(
    pickWorkEmailEmployee([lookalike, underscored], "sara_adel@satopharma.com"),
    { employee: underscored, kind: "one" },
    "an ilike wildcard look-alike is never taken for the typed address",
  );

  assert.deepEqual(
    pickWorkEmailEmployee(
      [sara, { full_name: "Sara Adel (2)", hr_id: "PD-0200", work_email: "sara.adel@satopharma.com" }],
      "sara.adel@satopharma.com",
    ),
    { kind: "ambiguous" },
    "two current employees sharing one work email is refused, never a coin toss",
  );

  assert.deepEqual(
    pickWorkEmailEmployee([sara, { ...sara, hr_id: "pd-0014" }], "sara.adel@satopharma.com"),
    { employee: sara, kind: "one" },
    "the same employee read twice (any HR-id spelling) is still one employee",
  );

  assert.deepEqual(
    pickWorkEmailEmployee([{ full_name: "No HR id", hr_id: null, work_email: "sara.adel@satopharma.com" }], "sara.adel@satopharma.com"),
    { kind: "none" },
    "a row with no HR id names nobody",
  );
  assert.deepEqual(pickWorkEmailEmployee([], "nobody@satopharma.com"), { kind: "none" });
}

function testTheLoginPickerIsDeterministic() {
  const pick = (service as Record<string, unknown>).pickInternalRecipientUser;
  assert.equal(typeof pick, "function", "service.ts exports pickInternalRecipientUser, the one login picker");
  const pickInternalRecipientUser = pick as typeof service.pickInternalRecipientUser;

  const inactiveA = { hr_id: "PD-0014", is_active: false, login_id: "a.sara", role: "Medical Rep" };
  const activeZ = { hr_id: "PD-0014", is_active: true, login_id: "z.sara", role: "District Manager" };
  const activeM = { hr_id: "PD-0014", is_active: true, login_id: "m.sara", role: "Medical Rep" };
  const other = { hr_id: "PD-0099", is_active: true, login_id: "pd-0014", role: "Medical Rep" };

  for (const rows of [
    [inactiveA, activeZ, activeM],
    [activeM, inactiveA, activeZ],
    [activeZ, activeM, inactiveA],
  ]) {
    assert.equal(
      pickInternalRecipientUser(rows, { hrId: "PD-0014", loginId: "PD-0014" })?.login_id,
      "m.sara",
      "by HR id: an active login first, then the lowest login id — whatever order the rows came in",
    );
  }

  assert.equal(
    pickInternalRecipientUser([inactiveA, activeZ, other], { hrId: "PD-0014", loginId: "pd-0014" })?.login_id,
    "pd-0014",
    "an exact login id outranks an HR-id match",
  );
  assert.equal(
    pickInternalRecipientUser([activeZ], { hrId: null, loginId: "Z.SARA" })?.login_id,
    "z.sara",
    "a login id matches whatever the case",
  );
  assert.equal(
    pickInternalRecipientUser([activeZ], { hrId: "PD-0500", loginId: "nobody" }),
    null,
    "no exact login and no HR-id holder names nobody — never the first row returned",
  );
}

function testResolveRecipientNeverMatchesASignInEmail() {
  const source = code("src/lib/internal-messages/service.ts");
  const resolver = functionBody(source, /async function resolveRecipient\(/);

  assert.doesNotMatch(resolver, /auth_email\.ilike/, "resolveRecipient never matches app_auth_users.auth_email");
  assert.doesNotMatch(resolver, /[`"',]email\.ilike/, "resolveRecipient never matches app_auth_users.email");
  assert.doesNotMatch(resolver, /\.limit\(1\)/, "resolveRecipient never lets Postgres choose with an unordered limit(1)");
  assert.match(resolver, /loadEmployeeByWorkEmail\(/, "a typed email is matched on the employee's work email");
  assert.match(resolver, /kind === "ambiguous"[\s\S]{0,200}throw new Error/, "an ambiguous work email is refused");
  assert.match(resolver, /pickInternalRecipientUser\(/, "the login/HR-id path picks through the deterministic picker");

  const workEmailLookup = functionBody(source, /async function loadEmployeeByWorkEmail\(/);
  assert.match(workEmailLookup, /\.ilike\("work_email"/, "the email lookup reads employees.work_email");
  assert.match(
    workEmailLookup,
    /employment_status\.is\.null,employment_status\.in\.\$\{ACTIVE_EMPLOYMENT_STATUSES_IN_LIST\}/,
    "a former employee's work email names nobody",
  );
}

// Owner's decision, 2026-11-03: a persisted snapshot stays raw on write, and a reader gets the display name.
function testTheStoredNameStaysRawAndTheReaderGetsTheDisplayName() {
  const source = code("src/lib/internal-messages/service.ts");
  const send = functionBody(source, /export async function sendInternalMessage\(/);
  assert.match(send, /recipient_name: recipient\.storedName,/, "the stored recipient name is the full name, never the nickname of the day");
  assert.match(send, /sender_name: sender\.storedName,/, "the stored sender name is the full name, never the nickname of the day");
  assert.match(
    functionBody(source, /function displayNameForUser\(/),
    /resolveEmployeeDisplayName\(fullName, employee\?\.nickname, employee\?\.hr_id\)/,
    "what a person reads is the display name",
  );
  assert.match(
    functionBody(source, /export async function listInternalMessagesForViewer\(/),
    /withCurrentDisplayNames\(rows\.map/,
    "the inbox overlays today's display name on the stored row at read",
  );
}

function testTheProfileWritesTheNameOnly() {
  const route = code("app/api/admin/profile/route.ts");
  const patch = functionBody(route, /export async function PATCH\(/);
  assert.doesNotMatch(patch, /updates\.auth_email|auth_email\s*:|body\.email/, "the profile PATCH never writes the sign-in email");
  assert.match(patch, /updates\.name = body\.name\.trim\(\)/, "the profile PATCH still writes the display name");

  const form = code("src/components/admin/admin-profile-form.tsx");
  const emailInput = form.match(/<Input\b(?:(?!<Input\b)[\s\S])*?id="profile-email"[\s\S]*?\/>/);
  assert.ok(emailInput, "the profile form still shows the sign-in email");
  assert.match(emailInput[0], /\breadOnly\b/, "the profile form's email field is read-only");
  assert.doesNotMatch(emailInput[0], /onChange=/, "the profile form's email field cannot be typed into");
  assert.match(form, /JSON\.stringify\(\{ name \}\)/, "the profile form sends the name only");
}

function testTheSuperAdminListMailsOnlyARealMailbox() {
  const fromRow = (notifyAdmin as Record<string, unknown>).superAdminRecipientFromRow;
  assert.equal(typeof fromRow, "function", "notify-admin.ts maps each Super Admin row through one helper");
  const superAdminRecipientFromRow = fromRow as typeof notifyAdmin.superAdminRecipientFromRow;

  assert.deepEqual(
    superAdminRecipientFromRow({ auth_email: "b-10@phoenix.local", hr_id: "B-10" }),
    { email: null, hrId: "B-10" },
    "a synthetic sign-in identity is never a mail address",
  );
  assert.deepEqual(
    superAdminRecipientFromRow({ auth_email: " omar@satopharma.com ", hr_id: "B-10" }),
    { email: "omar@satopharma.com", hrId: "B-10" },
  );
  assert.equal(superAdminRecipientFromRow({ auth_email: "omar@satopharma.com", hr_id: null }), null);

  const source = code("src/lib/private-calendar/notify-admin.ts");
  assert.match(
    functionBody(source, /export async function resolveSuperAdminRecipients\(/),
    /\.map\(superAdminRecipientFromRow\)/,
    "resolveSuperAdminRecipients maps every row through the deliverable-address helper",
  );
}

export async function runInternalMessageRecipientWorkEmailTests() {
  testTheWorkEmailPicker();
  testTheLoginPickerIsDeterministic();
  testResolveRecipientNeverMatchesASignInEmail();
  testTheStoredNameStaysRawAndTheReaderGetsTheDisplayName();
  testTheProfileWritesTheNameOnly();
  testTheSuperAdminListMailsOnlyARealMailbox();
}
