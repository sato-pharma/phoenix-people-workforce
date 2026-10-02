/**
 * The new-hire mailbox robot — what this file protects.
 *
 * A robot with a Turbify admin session can create a mailbox in the company domain and hand it an
 * identity. The damage is quieter than a deletion but it is real: an address derived from a name can
 * collide with an employee who already holds it, and the second holder then receives the first one's
 * mail. Nothing in the app would show that. So the gates in safety.ts are the feature, and the
 * single most important assertion here is that an address held by ANYONE else is never created.
 *
 * The second thing pinned here is the LOCATOR CONTRACT. The first Turbify robot carried captured CSS
 * paths, which forced a human to perform every action once before anything could run, and broke
 * silently on any restyle. Every locator must therefore be semantic — an aria-label, a form `name`,
 * visible text, or (once) a placeholder — and this file fails if a generated Tailwind path is ever
 * reintroduced.
 */

import assert from "node:assert/strict";

import {
  APP_PASSWORD_PAGE,
  ECP_LOCATORS,
  ONE_TIME_PASSWORD_DIALOG,
  describeLocator,
  missingControl,
  type Locator,
} from "../src/lib/new-hire-mailbox/robot/locators.ts";
import {
  JOINER_STEP_ORDER,
  createDryRunJoinerDriver,
} from "../src/lib/new-hire-mailbox/robot/driver.ts";
import {
  TurbifyAmbiguousControlError,
  cssQueryFor,
  findMatches,
  isPresent,
  matchesLocator,
  resolveOne,
  type CandidateReader,
  type ElementCandidate,
} from "../src/lib/new-hire-mailbox/robot/resolve.ts";
import {
  COMPANY_PASSWORD_ENV,
  INITIAL_PASSWORD_AUDIENCE,
  TURBIFY_INVITE_RECIPIENT,
  explainUnusableInitialPassword,
  isUsableInitialPassword,
  readCompanyInitialPassword,
} from "../src/lib/new-hire-mailbox/robot/initial-password.ts";
import {
  COMPANY_MAIL_DOMAIN,
  ROBOT_MAX_DAYS_BEFORE_HIRE,
  capForRun,
  evaluateProvisionSafety,
  isCreatableCompanyAddress,
  isQuietRefusal,
  wholeDaysBetween,
  type ProvisionEmployeeFacts,
  type ProvisionSafetyInput,
  type ProvisionTaskFacts,
} from "../src/lib/new-hire-mailbox/robot/safety.ts";

const TODAY = "2026-10-02";

function employee(overrides: Partial<ProvisionEmployeeFacts> = {}): ProvisionEmployeeFacts {
  return {
    displayName: "Mariam Hassan Ali",
    hireDate: "2026-10-05",
    hrId: "B-501",
    isActiveEmployee: true,
    workEmail: null,
    ...overrides,
  };
}

function task(overrides: Partial<ProvisionTaskFacts> = {}): ProvisionTaskFacts {
  return { emailAddress: "mariam.hassan@satopharma.com", status: "pending", ...overrides };
}

function verdict(overrides: Partial<ProvisionSafetyInput> = {}) {
  return evaluateProvisionSafety({
    addressHeldBy: null,
    employee: employee(),
    task: task(),
    today: TODAY,
    ...overrides,
  });
}

export async function runNewHireMailboxRobotTests(): Promise<void> {
  // ── the happy path, so every refusal below is attributable to the one thing it changed ───────
  const ok = verdict();
  assert.equal(ok.allowed, true);
  assert.equal(ok.allowed === true ? ok.address : "", "mariam.hassan@satopharma.com");

  // 🔴 THE HEADLINE ASSERTION. An address anybody else holds or claims is NEVER created — this is
  // what stops one employee's mail being delivered to another.
  const taken = verdict({ addressHeldBy: "Mariam Hassan Mohamed" });
  assert.equal(taken.allowed, false, "an address held by somebody else must never be created");
  assert.equal(taken.allowed === false ? taken.refusal : "", "address_taken");
  assert.match(taken.allowed === false ? taken.detail : "", /Mariam Hassan Mohamed/);

  // A person who has left is never handed a live mailbox, however stale the queue row.
  const gone = verdict({ employee: employee({ isActiveEmployee: false }) });
  assert.equal(gone.allowed, false);
  assert.equal(gone.allowed === false ? gone.refusal : "", "not_an_active_employee");

  // A second company mailbox would split their mail in two, silently. A person decides.
  const hasOne = verdict({ employee: employee({ workEmail: "m.hassan@satopharma.com" }) });
  assert.equal(hasOne.allowed, false);
  assert.equal(hasOne.allowed === false ? hasOne.refusal : "", "work_email_already_set");

  // A personal address on the record is NOT a company mailbox, so it must not block provisioning.
  const personal = verdict({ employee: employee({ workEmail: "mariam.hassan@gmail.com" }) });
  assert.equal(personal.allowed, true, "a personal address on file must not block the company mailbox");

  // The robot never provisions off its own initiative, and finished/declined work is a quiet skip.
  for (const [status, refusal] of [["connected", "already_connected"], ["not_needed", "marked_not_needed"]] as const) {
    const v = verdict({ task: task({ status }) });
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false ? v.refusal : "", refusal);
    assert.equal(isQuietRefusal(refusal), true, `${refusal} is ordinary emptiness, not an alarm`);
  }

  // Nothing to create, and nothing outside the company domain.
  assert.equal((verdict({ task: task({ emailAddress: null }) }) as { refusal?: string }).refusal, "not_a_company_address");
  assert.equal((verdict({ task: task({ emailAddress: "mariam@gmail.com" }) }) as { refusal?: string }).refusal, "not_a_company_address");

  // A hire far in the future is deferred, quietly, and the boundary itself is allowed.
  const early = verdict({ employee: employee({ hireDate: "2026-12-01" }) });
  assert.equal(early.allowed, false);
  assert.equal(early.allowed === false ? early.refusal : "", "too_early_before_hire");
  const atBoundary = verdict({ employee: employee({ hireDate: "2026-10-16" }) }); // exactly 14 days
  assert.equal(wholeDaysBetween(TODAY, "2026-10-16"), ROBOT_MAX_DAYS_BEFORE_HIRE);
  assert.equal(atBoundary.allowed, true, "the boundary day itself is provisioned");

  // Someone starting immediately, with no date recorded, is provisioned now — HR relies on that.
  assert.equal(verdict({ employee: employee({ hireDate: null }) }).allowed, true);

  // ── the address shape, which must fail here rather than halfway through a console form ───────
  assert.equal(isCreatableCompanyAddress("a.b@satopharma.com"), true);
  assert.equal(isCreatableCompanyAddress(`x@${COMPANY_MAIL_DOMAIN}`), true);
  assert.equal(isCreatableCompanyAddress("@satopharma.com"), false, "an empty local part is refused");
  assert.equal(isCreatableCompanyAddress(".leading@satopharma.com"), false);
  assert.equal(isCreatableCompanyAddress("trailing.@satopharma.com"), false);
  assert.equal(isCreatableCompanyAddress("has space@satopharma.com"), false);
  assert.equal(isCreatableCompanyAddress("someone@satopharma.com.evil.com"), false);

  // The per-run cap bounds how many accounts one run can create.
  assert.equal(capForRun([1, 2, 3, 4, 5], 3).length, 3);
  assert.equal(capForRun([1, 2, 3], 0).length, 0);

  // ── 🔴 THE LOCATOR CONTRACT — no captured CSS paths, ever ─────────────────────────────────────
  const locators: Locator[] = [
    ECP_LOCATORS.searchBox, ECP_LOCATORS.resetPassword, ECP_LOCATORS.moreActions, ECP_LOCATORS.deleteUser,
    ECP_LOCATORS.emailUser, ECP_LOCATORS.emailLocal, ECP_LOCATORS.displayName, ECP_LOCATORS.inviteSendTo,
    ONE_TIME_PASSWORD_DIALOG.reveal, ONE_TIME_PASSWORD_DIALOG.close,
    APP_PASSWORD_PAGE.manageAccount, APP_PASSWORD_PAGE.manageAppPasswords, APP_PASSWORD_PAGE.generate,
  ];
  for (const locator of locators) {
    assert.ok(["aria", "name", "text", "placeholder"].includes(locator.kind), `${locator.value} uses a semantic kind`);
    assert.ok(locator.value.trim().length > 0, "a locator value is never blank");
    assert.ok(locator.tags.length > 0, `${locator.value} names the tags that may satisfy it`);
    assert.ok(locator.purpose.trim().length > 0, `${locator.value} says what it is for`);
    // The brittleness this file exists to keep out: a child combinator, an id or attribute chain, a
    // `tag.class` chain, or the old placeholder sentinel. Note a bare dot is NOT disqualifying —
    // "Search users..." is a real placeholder — so the class test needs a word on BOTH sides.
    assert.doesNotMatch(locator.value, /[>#[\]]|__UNCALIBRATED__|\w\.\w/, `${locator.value} must not be a CSS path`);
  }

  // The form fields are matched by their real `name` attributes, read from the live panel.
  assert.equal(ECP_LOCATORS.emailLocal.kind, "name");
  assert.equal(ECP_LOCATORS.emailLocal.value, "emailLocal");
  assert.equal(ECP_LOCATORS.displayName.value, "displayName");
  assert.equal(ECP_LOCATORS.inviteSendTo.value, "inviteSendTo");
  // The destructive pair are matched by accessible name and menu text, not position in the row.
  assert.equal(ECP_LOCATORS.resetPassword.kind, "aria");
  assert.equal(ECP_LOCATORS.deleteUser.kind, "text");
  // The success signal for a reset or a creation is the dialog's heading.
  assert.equal(ONE_TIME_PASSWORD_DIALOG.heading, "One-time password");
  // Two controls in that dialog must never be pressed: a leaver needs no invite.
  assert.deepEqual([...ONE_TIME_PASSWORD_DIALOG.neverPress], ["Send invite", "Print"]);
  // The app password keeps the name offboarding later looks for.
  assert.equal(APP_PASSWORD_PAGE.passwordName, "Phoenix email");

  // A missing control fails CLOSED, with a message naming what to go and look at.
  const error = missingControl(ECP_LOCATORS.resetPassword);
  assert.equal(error.name, "TurbifyControlMissingError");
  assert.match(error.message, /aria-label "Reset password"/);
  assert.match(error.message, /stopped rather than guess/);
  assert.match(describeLocator(ECP_LOCATORS.searchBox), /placeholder "Search users\.\.\."/);

  // ── the company password the Super Admin hands over ──────────────────────────────────────────
  // Nobody is emailed: Turbify's invite field is deliberately empty.
  assert.equal(TURBIFY_INVITE_RECIPIENT, "", "Turbify must be given no invite recipient");
  assert.equal(INITIAL_PASSWORD_AUDIENCE, "super_admin_only");

  // 🔴 THE HEADLINE ASSERTION. With no company password configured the robot gets NOTHING, so it
  // refuses before touching the console. A built-in fallback is how a guessable password that nobody
  // chose ends up on real mailboxes, and the refusal is the safe failure: no mailbox exists yet.
  assert.equal(readCompanyInitialPassword(undefined), null, "an unset company password must never fall back to a default");
  assert.equal(readCompanyInitialPassword(""), null);
  assert.equal(readCompanyInitialPassword("   "), null, "whitespace is not a configured password");

  // The value is read from the environment, never compiled in.
  assert.equal(COMPANY_PASSWORD_ENV, "PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD");
  assert.equal(readCompanyInitialPassword("Sato@2027"), "Sato@2027");
  assert.equal(readCompanyInitialPassword("  Sato@2027  "), "Sato@2027", "surrounding whitespace is trimmed");

  // The owner's own example is accepted — this module does not second-guess his pattern.
  assert.equal(isUsableInitialPassword("Sato@2027"), true, "the owner's company pattern must be accepted");
  assert.equal(explainUnusableInitialPassword("Sato@2027"), null);

  // What IS refused is only what breaks mid-flow, after the mailbox already exists.
  assert.equal(isUsableInitialPassword("Sato@12"), false, "under 8 characters");
  assert.equal(isUsableInitialPassword("sato@2027"), false, "no capital letter");
  assert.equal(isUsableInitialPassword("SATO@2027"), false, "no small letter");
  assert.equal(isUsableInitialPassword("Satopharma@"), false, "no digit");
  assert.equal(isUsableInitialPassword("Sato2027xy"), false, "no symbol");
  assert.equal(isUsableInitialPassword("Sato 2027@"), false, "a space breaks the console form");
  assert.equal(isUsableInitialPassword('Sato"2027@'), false, "a quote breaks exports and shell quoting");
  assert.equal(isUsableInitialPassword("Sato\\2027@"), false, "a backslash breaks exports and shell quoting");

  // Every refusal says what to change, since somebody has to go and fix the variable.
  assert.match(explainUnusableInitialPassword("") ?? "", /is not set/);
  assert.match(explainUnusableInitialPassword("Sato@12") ?? "", /shorter than 8/);
  assert.match(explainUnusableInitialPassword("sato@2027") ?? "", /a capital letter/);
  assert.match(explainUnusableInitialPassword("Sato2027xy") ?? "", /a symbol/);
  assert.match(explainUnusableInitialPassword("Sato 2027@") ?? "", /space, quote or backslash/);
  assert.match(explainUnusableInitialPassword("") ?? "", new RegExp(COMPANY_PASSWORD_ENV));

  // ── resolving a locator to exactly one control ────────────────────────────────────────────────
  /** A page holding whatever candidates a test hands it, ignoring the CSS query. */
  function pageOf(candidates: ElementCandidate[]): CandidateReader {
    return { candidates: async () => candidates };
  }
  const resetButton: ElementCandidate = { aria: "Reset password", tag: "button" };

  // One row, filtered by the search box: the control resolves.
  const one = pageOf([resetButton]);
  assert.equal((await resolveOne(one, ECP_LOCATORS.resetPassword)).index, 0);
  assert.equal(await isPresent(one, ECP_LOCATORS.resetPassword), true);

  // 🔴 THE HEADLINE ASSERTION. Every one of the 288 rows carries its own "Reset password" button, so
  // two matches means the search box did NOT filter the list to one mailbox. Acting on either would
  // reset — and later DELETE — a mailbox the robot was never asked about. It must refuse.
  const many = pageOf([resetButton, { ...resetButton }, { ...resetButton }]);
  await assert.rejects(
    () => resolveOne(many, ECP_LOCATORS.resetPassword),
    (error: unknown) => {
      assert.ok(error instanceof TurbifyAmbiguousControlError, "an ambiguous row action must be refused, never guessed");
      assert.equal(error.matches, 3);
      assert.match(error.message, /cannot tell which mailbox/);
      return true;
    },
    "two rows matching a row action must stop the run",
  );

  // None means the page is not the one expected — also a refusal, never a silent skip.
  await assert.rejects(
    () => resolveOne(pageOf([]), ECP_LOCATORS.resetPassword),
    /stopped rather than guess/,
  );

  // Matching is exact and tag-scoped, so a near-miss cannot be acted on.
  assert.equal(matchesLocator({ aria: "Reset password", tag: "button" }, ECP_LOCATORS.resetPassword), true);
  assert.equal(matchesLocator({ aria: "Reset password ", tag: "button" }, ECP_LOCATORS.resetPassword), true, "trimmed");
  assert.equal(matchesLocator({ aria: "Reset passwords", tag: "button" }, ECP_LOCATORS.resetPassword), false, "not a prefix match");
  assert.equal(matchesLocator({ aria: "Reset password", tag: "a" }, ECP_LOCATORS.resetPassword), false, "wrong tag");
  // A field is matched on its real name attribute, not on its placeholder or its text.
  assert.equal(matchesLocator({ name: "emailLocal", tag: "input" }, ECP_LOCATORS.emailLocal), true);
  assert.equal(matchesLocator({ placeholder: "emailLocal", tag: "input" }, ECP_LOCATORS.emailLocal), false);
  // Visible text is whitespace-collapsed, because rendered markup carries newlines and padding.
  assert.equal(matchesLocator({ tag: "button", text: "  Delete \n" }, ECP_LOCATORS.deleteUser), true);
  assert.equal(matchesLocator({ tag: "button", text: "Delete alias" }, ECP_LOCATORS.deleteUser), false);

  // The query is built from the attribute where there is one, and from the tags for text matching.
  assert.equal(cssQueryFor(ECP_LOCATORS.resetPassword), 'button[aria-label="Reset password"]');
  assert.equal(cssQueryFor(ECP_LOCATORS.emailLocal), 'input[name="emailLocal"],select[name="emailLocal"],textarea[name="emailLocal"]');
  assert.equal(cssQueryFor(ECP_LOCATORS.deleteUser), "button");
  assert.equal(cssQueryFor(ECP_LOCATORS.searchBox), 'input[placeholder="Search users..."]');

  // findMatches filters rather than throwing, for checking a page is the expected one.
  assert.equal((await findMatches(pageOf([resetButton, { aria: "Edit", tag: "button" }]), ECP_LOCATORS.resetPassword)).length, 1);

  // ── the step order, which is itself a safety property ────────────────────────────────────────
  // The app password can only ever be minted in the window before the mailbox is handed over, so a
  // reordering that put it last-but-one, or dropped it, must not pass quietly.
  assert.deepEqual([...JOINER_STEP_ORDER], ["createMailbox", "setMailboxPassword", "generateAppPassword"]);

  const driver = createDryRunJoinerDriver();
  await driver.signIn();
  const made = await driver.createMailbox({ displayName: "Mariam Hassan Ali", local: "mariam.hassan" });
  assert.equal(made.address, "mariam.hassan@satopharma.com");
  await driver.setMailboxPassword({ address: made.address, newPassword: "x", oneTimePassword: made.oneTimePassword });
  const minted = await driver.generateAppPassword({ address: made.address, password: "x" });
  await driver.close();
  assert.equal(
    driver.calls.join(" > "),
    "signIn > createMailbox:mariam.hassan > setMailboxPassword:mariam.hassan@satopharma.com "
    + "> generateAppPassword:mariam.hassan@satopharma.com > close",
  );
  // A dry run invents nothing that could be mistaken for a real credential.
  assert.match(made.oneTimePassword, /^DRY-RUN/);
  assert.match(minted.appPassword, /^DRY-RUN/);
}
