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
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  ACCOUNT_INFO_URL,
  CHANGE_PASSWORD_WORDINGS,
  describeField,
  describePage,
  describeShape,
  BOT_CHECK_SOURCES,
  describeSignInMeasurement,
  describeSignInStall,
  exchangeTarget,
  isTellingExchange,
  LOGIN_SUBMIT_WORDINGS,
  MAILBOX_EMAIL_FIELD,
  MAILBOX_LOGIN_URL,
  readSignInBlockersInPage,
  recordSignInNotices,
  watchSignInExchanges,
  SIGN_IN_LANDING_TIMEOUT_MS,
  SIGN_IN_MINIMUM_WAIT_MS,
  TurbifyJoinerStepError,
  waitForSignInLanding,
  withoutSecrets,
} from "../src/lib/new-hire-mailbox/robot/turbify-joiner.ts";
import {
  runTurbifyJoinerRobot,
  type JoinerCandidate,
  type JoinerRunnerDeps,
} from "../src/lib/new-hire-mailbox/robot/runner.ts";
import {
  APP_PASSWORD_PAGE,
  APP_PASSWORD_WORDINGS,
  ECP_LOCATORS,
  ONE_TIME_PASSWORD_DIALOG,
  describeLocator,
  missingControl,
  type Locator,
} from "../src/lib/turbify/locators.ts";
import {
  JOINER_STEP_ORDER,
  createDryRunJoinerDriver,
  type JoinerConsoleDriver,
} from "../src/lib/new-hire-mailbox/robot/driver.ts";
import {
  TurbifyAmbiguousControlError,
  cssQueryFor,
  findMatches,
  isPresent,
  matchesLocator,
  dialogNamesAddress,
  pickAppPassword,
  pickOneTimePassword,
  readExistenceFromRows,
  readMailboxRowCells,
  readRowStatus,
  resolveOne,
  rowIdentityRefusal,
  type CandidateReader,
  type ElementCandidate,
} from "../src/lib/turbify/resolve.ts";
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
  ROBOT_DEFAULT_MAX_CREATES_PER_RUN,
  ROBOT_MAX_CONSOLE_LOOKUPS_PER_RUN,
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

/**
 * "Does this address already exist?" is read from ROWS, never from the page's text.
 *
 * 🔴 Measured on production 2026-10-03. The check was
 * `document.body.innerText.includes(address)`, and the console leaves the searched address on the
 * page after an attempt — so it was reading the residue of the robot's OWN previous run. Of four
 * addresses, the two the robot had attempted carried their local part in the page text while showing
 * ZERO rows; the two it never reached carried neither. Ahmed Mohamed was absent from a console of 288
 * mailboxes and refused as "already exists" anyway, and every failed attempt re-poisoned the page for
 * the next run.
 *
 * This is the only check between a second mailbox and an address that already has one, so a text
 * scan being wrong in BOTH directions is the dangerous part — not the stuck queue.
 */
function runExistenceReadingCases(): void {
  const row = (address: string, status: "active" | "pending" | "unknown" = "active") => ({ address, status });

  // The two honest answers, read from the rows' own addresses.
  assert.deepEqual(readExistenceFromRows([], "new.hire@satopharma.com"), { exists: false });
  assert.deepEqual(
    readExistenceFromRows([row("taken@satopharma.com")], "taken@satopharma.com"),
    { exists: true, status: "active" },
  );

  // 🔴 THE SUBSTRING HIT. The console's search matches substrings, so searching
  // el.sayed@satopharma.com returns adel.sayed@satopharma.com — ONE row, a different employee. The
  // old count-based reader called that EXISTS and refused a real new hire for ever.
  assert.deepEqual(
    readExistenceFromRows([row("adel.sayed@satopharma.com")], "el.sayed@satopharma.com"),
    { exists: false },
    "a row that merely CONTAINS the address is not that address",
  );
  // And the same relation in reverse must not hide a mailbox that really is there.
  assert.deepEqual(
    readExistenceFromRows(
      [row("adel.sayed@satopharma.com"), row("el.sayed@satopharma.com")],
      "el.sayed@satopharma.com",
    ),
    { exists: true, status: "active" },
    "the exact row still answers when a substring neighbour is beside it",
  );

  // 🔴 PENDING IS EXISTING. A mailbox Turbify created but whose invitation never completed carries
  // no password, is absent from the "Active mailboxes" figure and has no Reset password button —
  // which is how two real mailboxes were created and then reported as never created at all.
  assert.deepEqual(
    readExistenceFromRows([row("ahmed.mohamed@satopharma.com", "pending")], "ahmed.mohamed@satopharma.com"),
    { exists: true, status: "pending" },
  );

  // 🔴 FAILS CLOSED. Rows that could not be read must NOT answer "absent" — absent is the answer
  // that goes on to create a mailbox.
  for (const unreadable of [null, undefined]) {
    const reading = readExistenceFromRows(unreadable, "new.hire@satopharma.com");
    assert.ok("refusal" in reading, "unreadable rows must refuse, never answer absent");
    assert.match("refusal" in reading ? reading.refusal : "", /cannot tell whether/);
    assert.match("refusal" in reading ? reading.refusal : "", /second one/);
  }

  // Two rows carrying the SAME address should be impossible; refuse rather than pick one.
  const duplicated = readExistenceFromRows(
    [row("dupe@satopharma.com"), row("dupe@satopharma.com")],
    "dupe@satopharma.com",
  );
  assert.ok("refusal" in duplicated);
  assert.match("refusal" in duplicated ? duplicated.refusal : "", /2 rows/);

  // Case and padding are not identity differences.
  assert.deepEqual(
    readExistenceFromRows([row("taken@satopharma.com")], "  TAKEN@satopharma.com  "),
    { exists: true, status: "active" },
  );

  // Every refusal names the address, so a log line is actionable on its own.
  const named = readExistenceFromRows(null, "named.person@satopharma.com");
  assert.match("refusal" in named ? named.refusal : "", /named\.person@satopharma\.com/);

  assert.equal(readRowStatus("Pending"), "pending");
  assert.equal(readRowStatus("Active"), "active");
  assert.equal(readRowStatus(undefined), "unknown");
}

/**
 * THE TWO TURBIFY LOGIN PAGES.
 *
 * `MAILBOX_LOGIN_URL` is a login.turbify.com URL with `.done=mail.turbify.com`, and Turbify
 * redirects it to `https://mail.turbify.com/login` — the "Bizmail Login" page. Measured in the
 * production container 2026-10-03, both pages read in one run:
 *
 *   login.turbify.com   input[type="email"] → 1
 *   mail.turbify.com    input[type="email"] → 0, and input#email[name="email"][type="text"]
 *
 * Two defects came out of that one reading, and both had already reached the owner:
 *
 *   1. `setMailboxPassword` waited 45s for `input[type="email"]` on a page that has none, so the
 *      adoption always died there — AFTER the reset, leaving a one-time password outstanding. His
 *      click just span, twice.
 *   2. The sign-in proof read `!url.includes("login.turbify.com")`, and the page it lands on is
 *      `mail.turbify.com/login` — so a REFUSED login satisfied the proof. A wrong one-time password
 *      would have been reported as a successful sign-in.
 */
function runMailboxLoginCases(): void {
  // The email field must be looked for in BOTH shapes. Neither page carries the other's field, so
  // the union cannot select the wrong input on either one.
  assert.match(MAILBOX_EMAIL_FIELD, /input\[type="email"\]/, "the admin login's field must be covered");
  assert.match(MAILBOX_EMAIL_FIELD, /input\[name="email"\]/, "the Bizmail login's field must be covered");

  const driver = stripComments(
    readFileSync(
      new URL("src/lib/new-hire-mailbox/robot/turbify-joiner.ts", new URL("../", import.meta.url)),
      "utf8",
    ),
  ).replace(/\s+/g, " ");
  // 🔴 THE REGRESSION ITSELF: waiting on the bare selector. It cost the owner two dead clicks and
  // two outstanding one-time passwords on a mailbox Phoenix needs to read.
  assert.equal(
    /waitForSelector\('input\[type="email"\]'/.test(driver), false,
    "the sign-in must wait on MAILBOX_EMAIL_FIELD, never on the admin page's field alone",
  );
  // 🔴 NO URL-SHAPED PROOF, IN EITHER DIRECTION. Measured in the production container 2026-10-03:
  // a GOOD one-time password lands on "Set up your mailbox password" at
  // `https://mail.turbify.com/login` — the SAME url and the SAME title as the form it came from.
  // So the host check accepted a refusal, and the `/login` path check that replaced it rejected a
  // success and stopped the owner's third click. Both were the same mistake: asking the address bar
  // a question only the FORM can answer. The setup page has no address field; a refused login does.
  assert.equal(
    /includes\("login\.turbify\.com"\)/.test(driver), false,
    "a sign-in proof must not be a host check — mail.turbify.com/login passes one while refused",
  );
  assert.equal(
    /LOGIN_PAGE_URL/.test(driver), false,
    "a sign-in proof must not test the url path either — the setup page is served at /login too",
  );
  // 🔴 AND NOT AN ABSENCE EITHER — the third wrong answer. `$$` finds HIDDEN inputs, so a leftover
  // `name="email"` in the DOM reads as a login form, and so does a form that never submitted because
  // something covered the button. The proof is now POSITIVE: the setup form's own confirm field, or
  // no VISIBLE address box.
  assert.equal(
    /\$\$\(MAILBOX_EMAIL_FIELD\)\)\.length === 0/.test(driver), false,
    "the sign-in proof must not be the bare absence of the address field — a hidden input defeats it",
  );
  assert.match(
    driver, /await onSetupPage\(\)\) \|\| \(await pastTheLoginForm\(\)\)/,
    "the mailbox sign-in must be proven positively: the setup form, or being past the login form",
  );
  assert.match(
    driver, /getClientRects\(\)\.length > 0/,
    "being past the login form must count only VISIBLE address boxes",
  );

  // 🔴 THE MAILBOX SIGN-IN GOES THROUGH THE BIZMAIL PAGE DIRECTLY. The `.done=` round-trip could not
  // be calibrated: by then the browser holds the admin session, and a Turbify login url with a live
  // session renders no form at all — it forwards.
  assert.equal(
    MAILBOX_LOGIN_URL, "https://mail.turbify.com/login",
    "the mailbox signs in on the Bizmail page itself, not through a login.turbify.com redirect",
  );
  assert.equal(
    MAILBOX_LOGIN_URL.includes(".done="), false,
    "a .done= round-trip makes the page depend on whoever is already signed in",
  );
  // ...and in its OWN browser context, so no admin cookie can forward it anywhere.
  assert.match(
    driver, /openMailboxPage\(\)/,
    "the mailbox must sign in on its own page, not on the administrator's",
  );
  assert.match(
    driver, /createBrowserContext/,
    "the mailbox page needs its own cookie jar",
  );

  // 🔴 NO BLIND SUBMIT ANYWHERE. A bare page.click on the submit was the last control in this driver
  // delivered without a hit test, and a cookie banner eating a blind click is incident one.
  assert.equal(
    /page\.click\('button\[type="submit"\]'\)/.test(driver), false,
    "the sign-in submit must go through the hit-tested path, like every other click here",
  );
  assert.match(
    driver, /submitOpenForm\(target, LOGIN_SUBMIT_WORDINGS/,
    "the sign-in submit is resolved by type and sanity-checked against the measured wordings",
  );
  for (const wording of ["Login to Business Mail", "Log in to My Account"]) {
    assert.ok(
      (LOGIN_SUBMIT_WORDINGS as readonly string[]).includes(wording),
      `${wording} was read off a live Turbify login page and must stay in the sanity check`,
    );
  }

  // The setup screen's submit control, as read off the live page. None of the four wordings that
  // preceded it matched, so this step would have failed the moment the sign-in started working.
  assert.equal(
    CHANGE_PASSWORD_WORDINGS[0], "Generate mailbox password",
    "the measured wording must be tried first, ahead of the guesses",
  );

  // 🔴 NOTHING TICKS THE SETUP PAGE'S CHECKBOX. On the login form that shape is "Keep me logged in.";
  // on the setup form nobody has read its label, and a consent or terms box is the owner's click.
  assert.equal(
    /checkbox"\]'\)[\s.]*(click|check)/.test(driver), false,
    "the robot must not tick a checkbox whose label has never been read",
  );
}

/**
 * The page description that turns the next refusal into a measurement.
 *
 * 🔴 THESE CALL IT. Asserting on the SOURCE TEXT of in-page code proves nothing about whether it
 * runs — the 2026-10-02 lesson, where a fix shipped green while its code was never executed.
 */
async function runPageDescriptionCases(): Promise<void> {
  const secret = "Zq7-TempPass-4417"; // gitleaks:allow — an invented fixture, never a real password
  // The known secret is removed by exact match, case-insensitively.
  assert.equal(
    withoutSecrets(`heading says ${secret} here`, [secret]),
    "heading says [redacted] here",
    "a secret the run is holding must never survive into a refusal message",
  );
  assert.equal(
    withoutSecrets(`HEADING SAYS ${secret.toUpperCase()}`, [secret]),
    "HEADING SAYS [redacted]",
    "the match must not depend on case",
  );
  // 🔴 AND THE THINGS THE DESCRIPTION EXISTS TO SHOW MUST SURVIVE. `redactLabel` would have dropped
  // all three of these as secret-shaped, which is why this has its own redactor.
  for (const keep of [
    "https://mail.turbify.com/login",
    "password:confirmPassword",
    "hr.mailbox@satopharma.com",
  ]) {
    assert.equal(
      withoutSecrets(keep, [secret]), keep,
      `${keep} is what the description is for and must not be redacted away`,
    );
  }
  // Too short to match safely: replacing it would corrupt the description and protect nothing.
  assert.equal(withoutSecrets("inputs [text:email]", ["ail"]), "inputs [text:email]");
  // 🔴 AND IT MUST TERMINATE. A secret that is a substring of the marker it is replaced with —
  // "redact" becomes "[redacted]", which contains "redact" — loops for ever if the search restarts
  // from 0. The passwords here would not trigger it, but a redactor that hangs hangs the whole
  // provisioning run with NO output, which is the exact failure shape that cost four clicks today.
  // This test is the thing that would hang, so it failing is a timeout, not an assertion.
  assert.equal(withoutSecrets("value redact here", ["redact"]), "value [redacted] here");
  assert.equal(withoutSecrets("redacted", ["redacted"]), "[redacted]");
  assert.equal(withoutSecrets("aa redact bb redact cc", ["redact"]), "aa [redacted] bb [redacted] cc");

  const shape = {
    buttons: ["Generate mailbox password", "Cancel"],
    controls: [],
    errors: [],
    formValid: null,
    headings: ["Set up your mailbox password"],
    inputs: ["password:password", "password:confirmPassword", "checkbox:-", "hidden:email (hidden)"],
    title: "Bizmail Login",
    url: "https://mail.turbify.com/login",
  };
  const described = describeShape(shape, [secret]);
  assert.equal(
    described.includes("the page says"), false,
    "with no error on the page the description must not invent an empty one",
  );

  // 🔴 THE PAGE'S OWN WORDS ARE THE ONLY AUTHORITY ON THE RULE TURBIFY DID NOT PUBLISH CLEARLY.
  // Their help requires "no repeated characters" without saying whether that means consecutively or
  // anywhere, so the robot refuses to rule on it and reports what the FORM said instead.
  const rejected = describeShape(
    { ...shape, errors: ["Password must not contain repeated characters."] },
    [secret],
  );
  assert.match(rejected, /the page says \[Password must not contain repeated characters\.\]/);

  // And an error that happens to quote the credential is still redacted.
  assert.ok(
    !describeShape({ ...shape, errors: [`The password ${secret} was rejected`] }, [secret]).includes(secret),
    "the page's error text goes through the redactor like everything else",
  );
  for (const fragment of [
    "https://mail.turbify.com/login",
    'title "Bizmail Login"',
    "Set up your mailbox password",
    "password:confirmPassword",
    "hidden:email (hidden)",
    "Generate mailbox password",
  ]) {
    assert.ok(described.includes(fragment), `the description must carry ${fragment}`);
  }
  assert.equal(
    describeShape(null, []), "the page could not be read at all.",
    "an unreadable page must say so rather than describing an empty one",
  );

  // ── the form's own state, which is where a "still on screen" failure actually lives ──────────
  //
  // 🔴 THE MEASURED 2026-10-03 FAILURE. The owner's refusal said the form was "filled and submitted
  // but is still on screen" and listed `checkbox:-`. Three unrelated causes were indistinguishable
  // from that: a required consent box, an unfilled confirm field, and a submit that never landed.
  // These cases pin that each one now reads differently.
  const field = (over: Partial<Parameters<typeof describeField>[0]>) => ({
    checked: null, disabled: false, filled: 0, label: "", markup: "", name: "", near: "",
    required: false, type: "text", why: "",
    ...over,
  });
  const plain = (value: string) => value;

  const consentBlocked = describeShape(
    {
      ...shape,
      controls: [
        field({ filled: 14, name: "password", required: true, type: "password" }),
        field({ filled: 14, name: "confirmPassword", required: true, type: "password" }),
        field({ checked: false, required: true, type: "checkbox", label: "I agree to the Terms of Service", why: "valueMissing: Please tick this box if you want to proceed." }),
      ],
      errors: ["Very Strong"],
      formValid: false,
    },
    [secret],
  );
  for (const fragment of [
    "password:password REQUIRED filled=14",
    "password:confirmPassword REQUIRED filled=14",
    "I agree to the Terms of Service",
    "UNTICKED",
    "INVALID(valueMissing",
    "the form reports itself INVALID",
  ]) {
    assert.ok(
      consentBlocked.includes(fragment),
      `a blocked consent box must be actionable from the refusal alone — missing ${fragment}`,
    );
  }

  // An unfilled confirm box reads differently from a filled one, which is the whole point of
  // reporting a LENGTH. `filled=0` would be ambiguous with "not reported", so it says EMPTY.
  assert.match(
    describeShape({ ...shape, controls: [field({ name: "confirmPassword", type: "password", required: true })] }, []),
    /password:confirmPassword REQUIRED EMPTY/,
  );

  // A form that validates fine says so explicitly: that is what tells a reader to stop looking at
  // the password and start looking at the click delivery.
  assert.match(
    describeShape({ ...shape, controls: [], formValid: true }, []),
    /the form reports itself valid, so the submit is not being refused by validation/,
  );

  // 🔴 A CONTROL LINE CAN NEVER CARRY A VALUE — `filled` is a number by construction. The one text
  // a control contributes is its LABEL, so that goes through the redactor like everything else.
  assert.ok(
    !describeShape({ ...shape, controls: [field({ label: `type ${secret} again`, type: "password" })] }, [secret]).includes(secret),
    "a control's label goes through the redactor",
  );

  // A hidden field with nothing interesting about it contributes no line at all, so the one line a
  // tired reader has to scan stays scannable.
  assert.equal(
    describeField(field({ name: "csrf", type: "hidden" }), plain), "",
    "a hidden field with nothing of note must contribute NO line — the refusal is one line a tired "
    + "reader has to scan, and padding it with csrf tokens is how the actionable control gets lost",
  );
  // And a parent's text can be the whole page, so the label is capped.
  assert.ok(
    describeField(field({ label: "x".repeat(400), type: "checkbox", checked: false }), plain).length < 260,
    "a label read off a parent element must be capped, or the refusal becomes unreadable",
  );

  // ── 🔴 THE BOX WITH NO LABEL ANYWHERE ────────────────────────────────────────────────────────
  // Measured on production 2026-10-03 at 23:10:35. The setup form's checkbox read
  // `checkbox:- UNTICKED` with EVERY link of the label chain empty, the parent's text included —
  // and the form reported itself VALID, which rules out the required-consent reading the driver had
  // assumed. So the refusal named a control it still could not identify. Two readings do identify
  // it: its own attributes (whose `id`/`class`/`name` say whether it is the form's box or the
  // cookie banner's) and the nearest ancestor that has any text at all.
  const unlabelled = describeField(
    field({
      checked: false,
      markup: '<input type="checkbox" id="cc-necessary" class="consent-toggle">',
      near: "Cookie Settings Accept All",
      type: "checkbox",
    }),
    plain,
  );
  assert.match(
    unlabelled, /near:"Cookie Settings Accept All"/,
    "an unlabelled box must report the nearest ancestor that has text — on 2026-10-03 the label "
    + "chain including the parent came back empty, so this is the only place the wording can live",
  );
  assert.match(
    unlabelled, /markup:<input type="checkbox" id="cc-necessary"/,
    "an unlabelled box must report its own attributes — with no label anywhere, id/class/name are "
    + "what say whether it belongs to the form or to the cookie banner",
  );

  // 🔴 AND A LABELLED CONTROL MUST NOT CARRY EITHER, or every refusal grows two lines of markup per
  // field and the one actionable control is lost again — which is the defect this whole reader
  // exists to undo.
  const labelled = describeField(
    field({
      checked: false,
      label: "I agree to the Terms of Service",
      markup: '<input type="checkbox" id="tos">',
      near: "some ancestor text",
      type: "checkbox",
    }),
    plain,
  );
  assert.equal(
    /near:|markup:/.test(labelled), false,
    "a control that HAS a label must not also print its markup or its ancestor text — the extra "
    + "readings are a last resort for the unidentifiable box, not a default",
  );

  // 🔴 A CONTROL'S MARKUP MUST NEVER REACH A PASSWORD FIELD. `outerHTML` on an input carries its
  // `value`, and on the setup form two of the three controls are the password and its confirmation.
  // Asserted on the comment-stripped driver, because the comment explaining this names `outerHTML`.
  const reader = stripComments(
    readFileSync(
      new URL("../src/lib/new-hire-mailbox/robot/turbify-joiner.ts", import.meta.url),
      "utf8",
    ),
  ).replace(/\s+/g, " ");
  assert.match(
    reader, /const markup = box \? field\.outerHTML/,
    "the markup read must be gated on the control being a checkbox or radio — outerHTML on a "
    + "password field carries the password itself",
  );
  assert.match(
    reader, /field\.outerHTML\.replace\(\/\\svalue\\s\*=/,
    "the markup read must strip `value` regardless of the gate — two guards, because the one thing "
    + "that may never appear in a refusal, a log or an audit row is a credential",
  );

  // 🔴 THE IN-PAGE READER MUST BE A REAL FUNCTION. `page.evaluate(string)` evaluates the string as an
  // EXPRESSION, so an arrow-function string is never called — it made every click in this driver a
  // no-op on 2026-10-02 and shipped green.
  const handed: string[] = [];
  const fakePage = {
    evaluate: async (fn: unknown) => {
      handed.push(typeof fn);
      return shape;
    },
  } as unknown as Parameters<typeof describePage>[0];
  const line = await describePage(fakePage, [secret]);
  assert.deepEqual(handed, ["function"], "the page reader must be handed over as a function, never a string");
  // The negative control: the same recorder must be able to SEE a string, or the assertion above
  // would pass for a reason that has nothing to do with the driver.
  await (fakePage as unknown as { evaluate: (fn: unknown) => Promise<unknown> }).evaluate("(() => ({}))()");
  assert.deepEqual(
    handed, ["function", "string"],
    "the recorder must distinguish the two, otherwise it proves nothing about the driver",
  );
  assert.ok(line.includes("Bizmail Login"), "describePage must render what the page handed back");
  assert.ok(line.includes("password:confirmPassword"), "describePage must render the inputs it read");
}

/** The driver must ask the DOM for rows, and reload first — only the first search filters. */
function runExistenceWiringCases(): void {
  const driver = readFileSync(
    new URL("src/lib/new-hire-mailbox/robot/turbify-joiner.ts", new URL("../", import.meta.url)),
    "utf8",
  );
  const flat = driver.replace(/\s+/g, " ");

  assert.match(
    flat, /readExistenceFromRows\(rows, address\)/,
    "the driver must read existence from the rows themselves",
  );
  assert.match(
    flat, /\$\$eval<ConsoleMailboxRow\[\]>\(MAILBOX_ROW_QUERY, readMailboxRowCells\)/,
    "rows come from the row reader, not from counting a row control",
  );
  // 🔴 THE ROW COUNT MUST BE GONE FROM THE EXISTENCE PATH. Counting Reset-password buttons cannot
  // see a PENDING mailbox (it has none) and cannot tell a substring hit from the address itself.
  assert.equal(
    flat.includes("$$eval<number>(cssQueryFor(ECP_LOCATORS.resetPassword)"), false,
    "existence must not be read by counting Reset-password buttons",
  );
  // 🔴 THE TEXT SCAN MUST BE GONE FROM THE CREATE STEP. Scoped to that method, because the driver
  // reads page text legitimately elsewhere (the one-time-password dialog, the app password). An
  // earlier version of this assertion used a regex that could not cross a ")" and let a reinstated
  // scan through — caught by break-and-watch, which is the only reason it is written this way.
  const createStart = driver.indexOf("async createMailbox(");
  const createEnd = driver.indexOf("async setMailboxPassword(", createStart);
  assert.ok(createStart > 0 && createEnd > createStart, "could not locate the createMailbox method");
  const createBody = driver.slice(createStart, createEnd);
  assert.equal(
    createBody.includes("innerText"), false,
    "the create step must not read page text at all — it carries the last attempt's residue",
  );
  assert.match(createBody, /readExistingRow/, "and it must read existence from the row reader");
  // 🔴 A CREATE THAT SHOWED NO PASSWORD MUST STILL SAY WHAT IT LEFT BEHIND. Turbify's create makes
  // the mailbox PENDING and hands the password over by invitation, so "no dialog" is not "nothing
  // happened" — two real mailboxes were created while the run reported none provisioned.
  assert.match(
    createBody, /describeCreateWithoutPassword/,
    "the create step must report what it actually left behind",
  );
  // And the fresh load before the search.
  assert.match(flat, /page\.goto\(consoleUrl/, "each existence check must start from a fresh page load");
}

/**
 * 🔴 THE SUBSTRING RELATION DEFEATS A COUNT AND AN `includes` TOGETHER, which is why both the row
 * guard and the dialog confirmation compare identity. Measured 2026-10-03: searching
 * el.sayed@satopharma.com returns the single ACTIVE row for adel.sayed@satopharma.com, carrying its
 * own Reset password button — so a count said "safe to act", and the dialog that then opened named
 * adel.sayed, whose text CONTAINS el.sayed@satopharma.com, so an includes() check confirmed the
 * wrong reset as the right one. On a leaver run that resets a working employee out of their mail.
 */
function runRowIdentityCases(): void {
  const row = (address: string, status: "active" | "pending" | "unknown" = "active") => ({ address, status });

  assert.equal(
    rowIdentityRefusal([row("leaver@satopharma.com")], "leaver@satopharma.com"), null,
    "one row carrying the address is safe to act on",
  );

  const substring = rowIdentityRefusal([row("adel.sayed@satopharma.com")], "el.sayed@satopharma.com");
  assert.ok(substring, "a substring hit must refuse — it is somebody else's mailbox");
  assert.match(substring ?? "", /no row CARRIES that address/);
  assert.match(substring ?? "", /Nothing was clicked/);

  const pending = rowIdentityRefusal([row("new.hire@satopharma.com", "pending")], "new.hire@satopharma.com");
  assert.ok(pending, "a PENDING row has no password to reset");
  assert.match(pending ?? "", /PENDING/);

  for (const unreadable of [null, undefined]) {
    assert.ok(rowIdentityRefusal(unreadable, "leaver@satopharma.com"), "unreadable rows must refuse");
  }

  assert.match(rowIdentityRefusal([], "x@satopharma.com", "Delete") ?? "", /^Delete x@satopharma\.com/);

  // The dialog confirmation, on the same relation.
  assert.equal(
    dialogNamesAddress("One-time password for el.sayed@satopharma.com", "el.sayed@satopharma.com"), true,
  );
  assert.equal(
    dialogNamesAddress("One-time password for adel.sayed@satopharma.com", "el.sayed@satopharma.com"), false,
    "a dialog naming adel.sayed must NOT confirm a reset of el.sayed",
  );
  assert.equal(
    dialogNamesAddress("Account: el.sayed", "el.sayed@satopharma.com"), true,
    "the local part on its own still names the mailbox",
  );
  assert.equal(dialogNamesAddress("Account: adel.sayed", "el.sayed@satopharma.com"), false);
  assert.equal(dialogNamesAddress("", "el.sayed@satopharma.com"), false);
  assert.equal(dialogNamesAddress("anything", ""), false);

  // 🔴 THE REAL DIALOG, read off production 2026-10-03 with the credential masked. `textContent`
  // runs the address straight into the NEXT LABEL, so the token was
  // `hr.mailbox@satopharma.comone-time` and this check refused a dialog that DOES name the mailbox —
  // which stopped the invite-inbox adoption on a live mailbox after it had already been reset.
  const realDialog =
    "One-time passwordWe've created a one-time password for this email account. Please sign in to "
    + "the account with this password and set a new, permanent password. Note that if this account "
    + "had another one-time password set previously, that one-time password is no longer valid."
    + "Email account:hr.mailbox@satopharma.comOne-time password: XXXXXXXXXXXXXXX "
    + "Login at:https://mail.turbify.com/loginHow do you want to inform the user?";
  assert.equal(
    dialogNamesAddress(realDialog, "hr.mailbox@satopharma.com"), true,
    "the real dialog names the mailbox — the glue to the next label must not hide it",
  );

  // 🔴 AND THE GLUE MUST NOT CREATE A FALSE MATCH. Splitting at a lowercase→uppercase boundary can
  // only ever break a token apart, so the near-miss pair stays refused even when glued.
  assert.equal(
    dialogNamesAddress(
      "Email account:adel.sayed@satopharma.comOne-time password: XXXX",
      "el.sayed@satopharma.com",
    ),
    false,
    "a glued dialog for adel.sayed must still NOT confirm a reset of el.sayed",
  );
  // The same dialog, read for the mailbox it really belongs to, does match.
  assert.equal(
    dialogNamesAddress(
      "Email account:adel.sayed@satopharma.comOne-time password: XXXX",
      "adel.sayed@satopharma.com",
    ),
    true,
  );
}

/** The row reader takes each address from its OWN cell, never from the row's concatenated text. */
function runRowReaderCases(): void {
  const makeRow = (cells: string[], all: string) => ({
    querySelectorAll: () => cells.map((text) => ({ textContent: text })),
    textContent: all,
  }) as unknown as Element;

  // The real shape: the display name runs straight into the address in the row's text, so reading
  // from that text yields "Abd-Elnaimahmed.mohamed@satopharma.com" — an address belonging to nobody.
  const rows = readMailboxRowCells([
    makeRow(
      ["Ahmed Mohamed Abd-Elnaim", "ahmed.mohamed@satopharma.com", "-", "Pending"],
      "Ahmed Mohamed Abd-Elnaimahmed.mohamed@satopharma.com- Pending",
    ),
    makeRow(
      ["Adel.Srour", "adel.srour@satopharma.com", "Add", "Active"],
      "Adel.Srouradel.srour@satopharma.comAdd Active",
    ),
    makeRow(["no address here", "neither"], "no address here neither"),
  ]);

  assert.deepEqual(rows, [
    { address: "ahmed.mohamed@satopharma.com", status: "pending" },
    { address: "adel.srour@satopharma.com", status: "active" },
  ], "one row per address cell, with its status, and rows carrying no address dropped");
}

/**
 * The credential reads — the thing that actually stopped the owner's adoption, five clicks running.
 *
 * 🔴 THE DEFECT IN ONE LINE: both reads scored candidates BY LENGTH, and the dialog is REQUIRED to
 * name the mailbox, so `hr.mailbox@satopharma.com` (25 characters) beat a ~10-character credential
 * every time. The robot typed the ADDRESS into the password box, Turbify refused it, and the failure
 * surfaced three steps later as "the expected page never appeared" — a message about the wrong thing
 * entirely. These are pure functions so the rule is settled here instead of one of his clicks at a
 * time.
 */
function runCredentialReadCases(): void {
  const address = "hr.mailbox@satopharma.com";
  const secret = "Xk9mPq2wTz";

  // 🔴 THE PREMISE OF THE BUG, asserted so it cannot quietly stop being true.
  assert.ok(
    address.length > secret.length,
    "the premise: the mailbox address outscores the real credential on length",
  );

  // The dialog as `innerText` renders it — label, the account it must name, then the credential.
  const dialog = [
    "One-time password", "Email account:", address, "One-time password:", secret,
    "Send invite", "Print", "Close modal",
  ].join("\n");

  const read = pickOneTimePassword(dialog, address);
  assert.ok("password" in read, "the measured dialog shape must yield a password");
  assert.equal("password" in read ? read.password : "", secret);

  // The same dialog printed on one line, which is the other rendering seen for this console.
  const inline = pickOneTimePassword(
    ["One-time password", `Email account: ${address}`, `One-time password: ${secret}`].join("\n"),
    address,
  );
  assert.equal("password" in inline ? inline.password : "", secret, "the value after the last colon counts");

  // 🔴 THE HEADLINE ASSERTION. Reading the whole BODY put the account list behind the modal into
  // play — a column of addresses, several LONGER than the one being reset. None may ever win.
  const withList = pickOneTimePassword(
    [dialog, "asmaa.zaghloul@satopharma.com", "ahmed.mohamed@satopharma.com", "merna.magdy@satopharma.com"].join("\n"),
    address,
  );
  assert.ok("password" in withList, "the account list behind the modal must not defeat the read");
  assert.equal("password" in withList ? withList.password : "", secret);

  // Nothing holding an @ can ever be returned, whatever else is on the page.
  for (const text of [dialog, `${dialog}\nsomebody.else@satopharma.com`]) {
    const any = pickOneTimePassword(text, address);
    assert.ok(
      !("password" in any) || !any.password.includes("@"),
      "a credential read must never return anything holding @ — that is an address, not a password",
    );
  }

  // Nothing but the address and the furniture → refuse, and say so in those terms.
  const empty = pickOneTimePassword(
    ["One-time password", "Email account:", address, "Send invite", "Print"].join("\n"),
    address,
  );
  assert.ok("refusal" in empty, "a dialog holding only the address and its labels must refuse");
  assert.match("refusal" in empty ? empty.refusal : "", /mailbox address/);

  // Two equally plausible values → refuse rather than guess, and never print either one.
  const twoWays = pickOneTimePassword(
    ["One-time password", "Email account:", address, secret, "Ab3cDe4fGh"].join("\n"),
    address,
  );
  assert.ok("refusal" in twoWays, "two plausible credentials must refuse, not pick one");
  const refusal = "refusal" in twoWays ? twoWays.refusal : "";
  assert.match(refusal, /lengths 10, 10/, "the refusal reports how long they were");
  assert.ok(!refusal.includes(secret), "a refusal must never quote a credential");
  assert.ok(!refusal.includes("Ab3cDe4fGh"), "a refusal must never quote a credential");

  // ── the app password, where the SAME defect sat and would have failed next ──────────────────────
  // 🔴 An app password on this platform is commonly 16 PLAIN LOWERCASE letters, so the shape test
  // that protects the dialog read would reject every real one. The two reads are genuinely
  // different, and this pair proves it rather than asserting it.
  const appText = ["Your app password", address, "abcdqrstwxyzmnop"].join("\n");
  const app = pickAppPassword(appText, address);
  assert.ok("password" in app, "an all-lowercase app password must be readable");
  assert.equal("password" in app ? app.password : "", "abcdqrstwxyzmnop");
  assert.ok(
    "refusal" in pickOneTimePassword(appText, address),
    "the one-time read must NOT accept the all-lowercase shape — the two reads differ on purpose",
  );

  // The address is longer than the app password too, and still must never be returned.
  assert.ok(address.length > "abcdqrstwxyzmnop".length);
  const appWithLonger = pickAppPassword(
    ["Account info", address, "App Passwords", "Generate", "abcdqrstwxyzmnop", "Done"].join("\n"),
    address,
  );
  assert.equal(
    "password" in appWithLonger ? appWithLonger.password : "",
    "abcdqrstwxyzmnop",
    "the app-password page prints the address — it must lose",
  );

  // 🔴 TURBIFY'S DIALOG CARRIES THE LOGIN URL, which their own help states outright: the dialog shows
  // "the user's email address, the one-time password, and the login URL" (SLN29262). A URL passes
  // every other test here — no spaces, no @, the right length — and the colon split yields a SECOND
  // candidate from it. It beat the password only by luck, because the password carries a digit.
  const withUrl = pickOneTimePassword(
    [
      "One-time password", "Email account:", address,
      "Login URL:", "https://mail.turbify.com",
      "One-time password:", secret,
    ].join("\n"),
    address,
  );
  assert.ok("password" in withUrl, "the login URL in the dialog must not defeat the read");
  assert.equal("password" in withUrl ? withUrl.password : "", secret);

  // A bare domain, with no scheme to recognise it by, is excluded on its suffix.
  const bareDomain = pickOneTimePassword(
    ["One-time password", "Email account:", address, "mail.turbify.com", secret].join("\n"),
    address,
  );
  assert.equal("password" in bareDomain ? bareDomain.password : "", secret);

  // 🔴 AND A URL WITH A PATH, which is the shape the login URL actually takes. This is the case the
  // domain-suffix rule does NOT cover — `https://mail.turbify.com/login` ends in `/login`, so only
  // the scheme test excludes it. Without this case the two guards look interchangeable and removing
  // the scheme one breaks nothing visible.
  // 🔴 AND THE CREDENTIAL HERE CARRIES NO DIGIT ON PURPOSE. With a digit, the letters-and-digits
  // preference picks the password over a URL by luck even with the scheme rule deleted — which is
  // precisely the accident this fix replaces, and a case that cannot fail is not a pin. With no
  // digit the preference cannot separate them, so the scheme exclusion is the only thing working.
  const noDigit = "XkMpQwTz";
  for (const url of ["https://mail.turbify.com/login", "http://mail.turbify.com/login?.done=x"]) {
    const withPath = pickOneTimePassword(
      ["One-time password", "Email account:", address, "Login URL:", url, noDigit].join("\n"),
      address,
    );
    assert.ok("password" in withPath, `a login URL (${url}) must not be read as the credential`);
    assert.equal("password" in withPath ? withPath.password : "", noDigit);
  }

  // ── and the driver must actually use them ──────────────────────────────────────────────────────
  const driver = readFileSync(
    new URL("src/lib/new-hire-mailbox/robot/turbify-joiner.ts", new URL("../", import.meta.url)),
    "utf8",
  );
  // 🔴 THE SAME SOURCE WITH THE COMMENTS TAKEN OUT, AND A SOURCE ASSERTION ABOUT A CALL MUST USE IT.
  // Proved by breaking it on 2026-10-03: `form.checkValidity()` was replaced with `return null` and
  // the suite stayed GREEN, because this file's own comment explaining the call still contained the
  // string. A heavily commented module makes `includes()` assertions self-satisfying — the prose
  // that documents a call keeps passing the test for the call. `driver` stays as it is for the
  // assertions that are genuinely about wording; anything asserting that code RUNS reads this.
  const driverCode = stripComments(driver);

  // 🔴 TURBIFY'S DOCUMENTED APP-PASSWORD PATH (SLN29264), which replaced three guesses.
  assert.equal(
    ACCOUNT_INFO_URL, "https://mail.turbify.com/accountinfo",
    "the account pages are reached by the URL Turbify publishes, not by hovering a profile menu",
  );
  assert.ok(
    driverCode.includes("ACCOUNT_INFO_URL"),
    "the app-password step must navigate to the documented deep link — the profile menu needs a HOVER, "
    + "which clickOneOf cannot do",
  );
  assert.ok(
    driverCode.includes("selectAppForPassword(mailbox, APP_PASSWORD_PAGE.passwordName)"),
    "Turbify requires an app chosen from a dropdown BEFORE Generate — pressing Generate with nothing "
    + "selected is how this step would have failed even with the right wordings",
  );
  assert.ok(
    driverCode.includes("errors:"),
    "a refusal must carry the page's own error text — it is the only authority on the rule Turbify "
    + "did not publish unambiguously",
  );
  // 🔴 EVERY ONE OF THESE READS `driverCode`, NOT `driver` — see the note where it is built. They
  // assert that code RUNS, and the comments in this module describe the very calls they name.
  assert.ok(
    driverCode.includes('document.querySelectorAll("input,select,textarea")'),
    "a refusal must read the form's own controls — asserting the word `controls:` alone is not enough, "
    + "because a gutted selector keeps the key and reports an empty form",
  );
  assert.ok(
    driverCode.includes("controls:") && driverCode.includes("formValid:"),
    "a refusal must carry the form's own view of its controls — the owner was directed at `checkbox:-` "
    + "with no label, required flag or ticked state, and three different causes read identically",
  );
  assert.ok(
    driverCode.includes("checkValidity()"),
    "the form's own validity is what separates a password Turbify refused from a submit that never "
    + "landed; without it both look like 'the form is still on screen'",
  );
  assert.ok(
    driverCode.includes('field.getAttribute("aria-label")') && driverCode.includes('label[for="${field.id}"]'),
    "the unnamed checkbox's label has never been read by anyone — the reader must actually try the "
    + "places a label lives, or the refusal keeps printing a dash",
  );
  // 🔴 THE VALUE MUST NEVER LEAVE THE CONTAINER. The control reader exists to report that a box is
  // empty or full, and a length does that; `.value.length` is allowed and a bare `.value` read into
  // the report is not. This is the assertion that keeps a convenience edit from leaking a password.
  assert.ok(
    driverCode.includes("value ?? \"\").length") || driverCode.includes("field.value === \"string\" ? field.value.length"),
    "the control reader must report value LENGTHS, never values",
  );
  assert.ok(
    !/filled:\s*(?:field\.)?value\s*[,}]/.test(driverCode),
    "a control's reported `filled` must be a length, never the value itself",
  );
  assert.ok(
    driverCode.includes("did not take the value as typed"),
    "typing must be PROVEN to have landed before anything is submitted — `type()` appends and "
    + "clearField fails silently, so an empty or doubled box is invisible from the outside",
  );
  assert.ok(
    !driver.includes("b.length - a.length"),
    "the length-scored credential read must not come back — it returned the mailbox address",
  );
  assert.ok(
    driverCode.includes("pickOneTimePassword(revealed, address)"),
    "the dialog read must go through pickOneTimePassword",
  );
  assert.ok(
    driverCode.includes("pickAppPassword(shown, address)"),
    "the app-password read must go through pickAppPassword",
  );
  assert.ok(
    driverCode.includes(".modal-container"),
    "the revealed credential is read from the dialog, not from the whole page",
  );
}

/**
 * The two refusals corrected on 2026-10-04, pinned because a refusal's WORDING is the whole product
 * here — it is the only thing the owner reads, and each of these sent him somewhere wrong.
 *
 * 🔴 BOTH READ COMMENT-STRIPPED SOURCE, because the comment that explains why a wording went has to
 * QUOTE it: `invite-inbox-runner.ts` carries "cannot read the mailbox until an adoption completes"
 * verbatim in the comment above the corrected refusal. A raw-source negative assertion would fail on
 * that documentation, and the cheapest way to make it green again is to delete the explanation —
 * which is the one thing these cases exist to stop.
 *
 * 🔴 AND BOTH JOIN THE CONCATENATION SEAMS. A refusal is built from `"…" + "…"` fragments, so a
 * phrase can be split across one, and collapsing whitespace is NOT enough — the `+ "` tokens survive
 * it. A negative assertion written without this passes against code that still says the retired
 * thing, which is a guard that cannot fail.
 */
function runCorrectedRefusalCases(): void {
  /** Comment-stripped, whitespace-collapsed, and with adjacent string fragments joined. */
  const readable = (path: string): string =>
    stripComments(readFileSync(new URL(path, import.meta.url), "utf8"))
      .replace(/\s+/g, " ")
      .replace(/["`]\s*\+\s*["`]/g, "");

  const driver = readable("../src/lib/new-hire-mailbox/robot/turbify-joiner.ts");
  const runner = readable("../src/lib/new-hire-mailbox/robot/invite-inbox-runner.ts");

  // ── 1. The setup page is Yahoo's Terms of Service, so the refusal stops sending him to a box ──
  //
  // Read from the live page: `pointer-events: none; opacity: 0; aria-hidden="true"; tabindex="-1"`
  // — a hidden value carrier behind a custom control. NOBODY can tick it, him included, so "a
  // consent box only the owner may tick" was unfollowable on every run that printed it.
  assert.equal(
    /owner may tick/.test(driver), false,
    "the refusal must not tell him to tick the setup box — it is pointer-events:none and cannot be "
    + "ticked by anyone, so that advice was unfollowable every time it was printed",
  );
  assert.equal(
    /a REQUIRED UNTICKED checkbox/.test(driver), false,
    "and it must not call that box REQUIRED — it carries no required flag and the form reports "
    + "itself valid, so the required-consent reading is disproved, not merely unproven",
  );
  assert.ok(
    driver.includes("password was NOT changed"),
    "the refusal must say the mailbox's password was NOT changed — the one fact that decides what "
    + "happens next, since a one-time password is left outstanding",
  );
  assert.match(
    driver, /Terms of Service/,
    "it must name what the page actually is: continuing accepts Yahoo's Terms of Service, which is "
    + "why this step is a boundary and not a calibration gap",
  );
  assert.match(
    driver, /Re-running this will not get past it/,
    "and it must say re-running cannot help — six dead clicks went on a page no retry clears",
  );

  // ── 2. A reset does NOT cost Phoenix the mailbox wherever an app password is already stored ──
  //
  // Measured 2026-10-04: hr.mailbox@satopharma.com passed a real IMAP login at 00:19:54 Cairo,
  // minutes after this refusal told the owner Phoenix could not read it. An app password survives a
  // password change — this module's own standing rule — so the claim was simply false.
  assert.equal(
    /Phoenix cannot read the mailbox until an adoption completes/.test(runner), false,
    "the runner must not claim Phoenix cannot read the mailbox until an adoption completes — an app "
    + "password survives a reset, and hr.mailbox passed a real IMAP login minutes after that refusal",
  );
  assert.match(
    runner, /an app password survives a password change/,
    "it must say instead that an app password survives a password change, so reading the mailbox is "
    + "a SEPARATE question from the mailbox's own password",
  );
  assert.match(
    runner, /read the Mailbox Monitor page before assuming access was lost/,
    "and it must point him at the page that answers it, rather than at a rescue he may not need",
  );
}

/**
 * 🔴 THE EXPECTED "ALREADY EXISTS" SKIP IS LOGGED AT INFO, NOT ERROR — the #5453 pattern.
 *
 * In production the daily sweep re-attempted the same three mailboxes (Elsayed Rady, Ahmed Mohamed,
 * Esraa Ibrahim) every morning, each already in Turbify, and each threw from `createMailbox`. That
 * threw straight to `logError("…could not finish a mailbox", event=new_hire_robot_failed)`, which
 * persists a row to `app_error_events` on EVERY sweep — so three already-known, already-surfaced
 * mailboxes wrote nine ERROR rows a day and buried genuinely-new failures. The robot was working
 * (it read the console and declined to double-create); only the LOG LEVEL was wrong, exactly as the
 * outstation auto-release's "awaiting a decision" skip was before #5453.
 *
 * This drives the real runner with a fake console driver and reads which severity actually fired —
 * a source-text assertion would not prove the branch is reached. The negative half (a genuine
 * console failure STILL logs ERROR) is the break-the-fix control: collapse the branch back to a
 * single `logError` and the `new_hire_robot_exists` assertion fails; drop the `alreadyExists` guard
 * so everything downgrades and the `new_hire_robot_failed` assertion fails.
 */
async function runAlreadyExistsLogLevelCases(): Promise<void> {
  /** A driver whose only live step is `createMailbox`, which throws whatever the case hands it. */
  const driverThatThrowsOnCreate = (thrown: unknown): JoinerConsoleDriver => {
    const unreached = (step: string) => async () => {
      throw new Error(`${step} must not be reached once createMailbox has thrown`);
    };
    return {
      close: async () => {},
      createMailbox: async () => {
        throw thrown;
      },
      describeAppPasswords: unreached("describeAppPasswords"),
      generateAppPassword: unreached("generateAppPassword"),
      rehearseAppPasswordRemoval: unreached("rehearseAppPasswordRemoval"),
      resetAndCapture: unreached("resetAndCapture"),
      setMailboxPassword: unreached("setMailboxPassword"),
      signIn: async () => {},
    } as unknown as JoinerConsoleDriver;
  };

  // One candidate that passes every gate, so the run reaches the console and `createMailbox` throws.
  const candidate: JoinerCandidate = {
    addressHeldBy: null,
    employee: employee(),
    task: task(),
  };
  const deps: JoinerRunnerDeps = {
    companyPassword: () => "Sato@2027",
    loadCandidates: async () => [candidate],
    record: async () => {
      throw new Error("record must not be called for a mailbox that was never provisioned");
    },
    today: () => TODAY,
  };

  /** Run one pass with the given throw, capturing every console line by severity. */
  const runCapturing = async (thrown: unknown): Promise<{ logs: string[]; errors: string[] }> => {
    const logs: string[] = [];
    const errors: string[] = [];
    const realLog = console.log;
    const realError = console.error;
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    try {
      await runTurbifyJoinerRobot({
        deps,
        driver: driverThatThrowsOnCreate(thrown),
        dryRun: false,
        enabled: true,
      });
    } finally {
      console.log = realLog;
      console.error = realError;
    }
    return { logs, errors };
  };

  // ── the already-exists throw: INFO, searchable, and NOT persisted as an error ────────────────
  const exists = await runCapturing(
    new TurbifyJoinerStepError(
      "mariam.hassan@satopharma.com already exists in Turbify as PENDING, so the robot did not "
      + "create it again.",
      { alreadyExists: true },
    ),
  );
  assert.ok(
    exists.logs.some((line) => line.includes('"event":"new_hire_robot_exists"')),
    "an already-exists mailbox must log at INFO under event=new_hire_robot_exists — it is the "
    + "expected skip, surfaced on the New Hire Mailboxes card, not a console failure",
  );
  assert.ok(
    !exists.errors.some((line) => line.includes('"event":"new_hire_robot_failed"')),
    "and it must NOT log new_hire_robot_failed at ERROR — that is the daily app_error_events row "
    + "#5453's pattern exists to stop",
  );

  // ── a genuine console failure: STILL ERROR (the break-the-fix control) ────────────────────────
  const failed = await runCapturing(new Error("Turbify returned an unexpected page"));
  assert.ok(
    failed.errors.some((line) => line.includes('"event":"new_hire_robot_failed"')),
    "a real console failure must still log at ERROR under new_hire_robot_failed — only the expected "
    + "already-exists skip is downgraded",
  );
  assert.ok(
    !failed.logs.some((line) => line.includes('"event":"new_hire_robot_exists"')),
    "and a real failure must NOT be miscounted as the expected skip",
  );

  // A bare TurbifyJoinerStepError without the flag is a real failure too — the discriminator is the
  // flag, never the error type, so a future throw that forgets it loudly stays loud.
  const unflagged = await runCapturing(new TurbifyJoinerStepError("some other step failed"));
  assert.ok(
    unflagged.errors.some((line) => line.includes('"event":"new_hire_robot_failed"')),
    "a TurbifyJoinerStepError without alreadyExists must stay at ERROR — the flag is the signal",
  );

  // The discriminator defaults to false and is set only when asked.
  assert.equal(new TurbifyJoinerStepError("x").alreadyExists, false);
  assert.equal(new TurbifyJoinerStepError("x", {}).alreadyExists, false);
  assert.equal(new TurbifyJoinerStepError("x", { alreadyExists: true }).alreadyExists, true);
}

/**
 * 🔴 AN EXISTING MAILBOX TAKES NO CREATE SLOT — a queue headed by three existing mailboxes still
 * reaches the fourth hire on the same run.
 *
 * In production on 10 and 11 Nov 2026 the sweep looked up Esraa Ibrahim Saad, Ahmed Abd-Elnaim and
 * Norhan Samir Selim Ramla, found each already in Turbify, and stopped: the cap was a `slice(0, 3)`
 * over a stable order, so those three used the whole run every morning and the seven hires behind
 * them were never tried. This drives the real runner with a fake console in which the first three
 * addresses exist, and reads which hires the console was asked about.
 *
 * Break-the-fix: put the `slice(0, 3)` back (or count an already-exists hire as a slot) and the
 * fourth hire is never reached, so the `reached` assertion fails. The cap half — exactly three REAL
 * create attempts, the fourth-and-later never pressed — is what keeps the fix from becoming a runaway.
 */
async function runExistingMailboxTakesNoSlotCases(): Promise<void> {
  const hires = Array.from({ length: 8 }, (_, index) => {
    const n = index + 1;
    return {
      addressHeldBy: null,
      employee: employee({ displayName: `Hire ${n}`, hrId: `B-90${n}` }),
      task: task({ emailAddress: `hire.${n}@satopharma.com` }),
    } satisfies JoinerCandidate;
  });

  /** A console in which `existing` addresses are already there; every create is recorded. */
  const consoleWith = (existing: ReadonlySet<string>, lookedUp: string[]): JoinerConsoleDriver => ({
    close: async () => {},
    createMailbox: async ({ local }: { local: string }) => {
      const address = `${local}@satopharma.com`;
      lookedUp.push(local);
      if (existing.has(local)) {
        throw new TurbifyJoinerStepError(`${address} already exists in Turbify`, { alreadyExists: true });
      }
      return { address, oneTimePassword: "Otp-1234!" };
    },
    generateAppPassword: async () => ({ appPassword: "abcdabcdabcdabcd" }),
    setMailboxPassword: async () => {},
    signIn: async () => {},
  }) as unknown as JoinerConsoleDriver;

  const runWith = async (
    existing: ReadonlySet<string>,
    extra: Partial<JoinerRunnerDeps> = {},
  ): Promise<{ lookedUp: string[]; recorded: string[]; result: Awaited<ReturnType<typeof runTurbifyJoinerRobot>> }> => {
    const lookedUp: string[] = [];
    const recorded: string[] = [];
    const realLog = console.log;
    console.log = () => {};
    try {
      const result = await runTurbifyJoinerRobot({
        deps: {
          companyPassword: () => "Sato@2027",
          loadCandidates: async () => hires,
          record: async ({ hrId }) => void recorded.push(hrId),
          today: () => TODAY,
          ...extra,
        },
        driver: consoleWith(existing, lookedUp),
        dryRun: false,
        enabled: true,
      });
      return { lookedUp, recorded, result };
    } finally {
      console.log = realLog;
    }
  };

  // ── the production shape: the first three exist ──────────────────────────────────────────────
  const headed = await runWith(new Set(["hire.1", "hire.2", "hire.3"]));
  assert.ok(
    headed.lookedUp.includes("hire.4"),
    "a queue headed by three existing mailboxes must still reach the fourth hire on the same run — "
    + `the console was asked only about ${headed.lookedUp.join(", ")}`,
  );
  assert.deepEqual(
    headed.lookedUp, ["hire.1", "hire.2", "hire.3", "hire.4", "hire.5", "hire.6"],
    "three existing hires take no slot, and the three slots go to the next three allowed hires",
  );
  assert.deepEqual(headed.recorded, ["B-904", "B-905", "B-906"], "the three created mailboxes are recorded");
  assert.equal(headed.result.provisioned, 3);

  // ── the cap still holds: never more than three REAL create attempts ──────────────────────────
  const none = await runWith(new Set());
  assert.deepEqual(none.lookedUp, ["hire.1", "hire.2", "hire.3"], "with nothing existing, exactly three are attempted");
  assert.equal(none.result.provisioned, 3);

  // A real console failure is a create attempt and DOES take a slot — only the proven
  // already-exists refusal hands its slot on.
  const failingLookedUp: string[] = [];
  const failing = {
    close: async () => {},
    createMailbox: async ({ local }: { local: string }) => {
      failingLookedUp.push(local);
      throw new Error("Turbify returned an unexpected page");
    },
    signIn: async () => {},
  } as unknown as JoinerConsoleDriver;
  const realError = console.error;
  console.error = () => {};
  try {
    await runTurbifyJoinerRobot({
      deps: {
        companyPassword: () => "Sato@2027",
        loadCandidates: async () => hires,
        record: async () => {},
        today: () => TODAY,
      },
      driver: failing,
      dryRun: false,
      enabled: true,
    });
  } finally {
    console.error = realError;
  }
  assert.deepEqual(failingLookedUp, ["hire.1", "hire.2", "hire.3"], "a real failure takes its slot");

  // Every hire existing: each one is looked up once, nothing is created, nothing is recorded.
  const all = await runWith(new Set(hires.map((_, index) => `hire.${index + 1}`)));
  assert.equal(all.lookedUp.length, hires.length);
  assert.deepEqual(all.recorded, []);

  // And the read-only lookups have their own ceiling, so a queue of existing mailboxes is bounded.
  const bounded = await runWith(new Set(hires.map((_, index) => `hire.${index + 1}`)), { maxLookupsPerRun: 5 });
  assert.equal(bounded.lookedUp.length, 5, "the lookup ceiling bounds a run of existing mailboxes");
  assert.ok(ROBOT_MAX_CONSOLE_LOOKUPS_PER_RUN > ROBOT_DEFAULT_MAX_CREATES_PER_RUN);
}

/**
 * The sign-in wait (2026-11-12). At 08:15 that morning the administrator's sign-in was still on the
 * login form six seconds after a delivered click, with nothing on the page to say why — the first
 * failed sign-in after daily successes since 3 October. The fixed six seconds became a floor with a
 * thirty-second ceiling, and a stall now names a captcha and the messages the page flashed.
 */
async function runSignInLandingCases(): Promise<void> {
  // A fake clock: sleep advances it, so the cases run instantly and the arithmetic is exact.
  const clock = () => {
    let t = 0;
    const slept: number[] = [];
    return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept };
  };

  // The floor and the ceiling themselves — the 08:15 failure was a ceiling of six.
  assert.equal(SIGN_IN_MINIMUM_WAIT_MS, 6_000, "the old six seconds stay as the floor");
  assert.ok(SIGN_IN_LANDING_TIMEOUT_MS >= 30_000, "a slow Turbify answer must get at least thirty seconds");

  // 1. Slow, not refused: the console appears at second 14. Six seconds alone would have refused.
  {
    const c = clock();
    const landing = await waitForSignInLanding(() => "https://login.turbify.com/login", async () => c.now() >= 14_000, c);
    assert.equal(landing, "landed", "a sign-in that lands after the old six seconds must be waited for");
    assert.equal(c.slept[0], SIGN_IN_MINIMUM_WAIT_MS, "the first look comes only after the full floor");
  }

  // 2. The floor is never skipped, even when the proof already holds — a page caught
  //    mid-navigation (password box gone, next page not drawn) must not read as "past the form".
  {
    const c = clock();
    let looked = false;
    await waitForSignInLanding(() => "x", async () => { looked = true; assert.ok(c.now() >= 6_000, "proof read before the floor"); return true; }, c);
    assert.ok(looked);
  }

  // 3. Never lands: refused at the ceiling, not before and not long after.
  {
    const c = clock();
    const landing = await waitForSignInLanding(() => "https://login.turbify.com/login", async () => false, c);
    assert.equal(landing, "still_on_form");
    assert.ok(c.now() >= SIGN_IN_LANDING_TIMEOUT_MS && c.now() <= SIGN_IN_LANDING_TIMEOUT_MS + 1_000, `refused at ${c.now()} ms`);
  }

  // 4. Two-step is answered on the first look, never waited out, even while the proof would pass.
  {
    const c = clock();
    const landing = await waitForSignInLanding(() => "https://login.turbify.com/tfavalidate?x=1", async () => true, c);
    assert.equal(landing, "two_step");
    assert.equal(c.now(), SIGN_IN_MINIMUM_WAIT_MS);
  }

  // 5. A proof that throws is "not yet", never a crash.
  {
    const c = clock();
    const landing = await waitForSignInLanding(() => "x", async () => { throw new Error("detached frame"); }, c);
    assert.equal(landing, "still_on_form");
  }

  // 6. The refusal: a captcha is named and never answered, and the secret never prints.
  const secret = "S3cretPass!";
  const captcha = describeSignInStall("the administrator", 30_000, { captcha: true, notices: [`Error: please verify ${secret}`] }, "url https://login.turbify.com/login", [secret]);
  assert.match(captcha, /captcha/i);
  assert.match(captcha, /never answers one/);
  assert.match(captcha, /signing in to Turbify by hand once/);
  assert.ok(!captcha.includes(secret), "a notice must pass through the secret redaction");
  assert.match(captcha, /Error: please verify/);

  // 7. No captcha, a flashed message: it is quoted, with the wait it ran for.
  const plain = describeSignInStall("the administrator", 30_000, { captcha: false, notices: ["Too many attempts"] }, "url https://login.turbify.com/login", []);
  assert.match(plain, /within 30 seconds/);
  assert.ok(plain.includes("Turbify showed [Too many attempts]"), "a flashed message must be quoted");
  assert.ok(!/captcha/i.test(plain), "no captcha must not be blamed on one");

  // 8. Nothing seen: no invented message.
  const quiet = describeSignInStall("the administrator", 30_000, { captcha: false, notices: [] }, "url x", []);
  assert.ok(!quiet.includes("Turbify showed"), "an empty notice list must not print an empty quote");

  // 9. Wiring: signInAs waits through the helper, records notices BEFORE the press, and the fixed
  //    six-second settle after the sign-in submit is gone.
  const source = stripComments(readFileSync(new URL("../src/lib/new-hire-mailbox/robot/turbify-joiner.ts", import.meta.url), "utf8"));
  const signIn = source.slice(source.indexOf("async function signInAs("), source.indexOf("return {", source.indexOf("async function signInAs(")));
  assert.ok(signIn.length > 0, "signInAs must exist");
  assert.ok(signIn.includes("waitForSignInLanding("), "signInAs must wait through waitForSignInLanding");
  assert.ok(!signIn.includes("settle(6_000)"), "the fixed six-second wait must not come back");
  const recorder = signIn.indexOf("recordSignInNotices");
  const press = signIn.indexOf("submitOpenForm(target, LOGIN_SUBMIT_WORDINGS, `sign-in button");
  assert.ok(recorder > -1 && press > -1 && recorder < press, "the notice recorder must be installed before the sign-in press");
  assert.ok(signIn.includes("describeSignInStall("), "a stall must be described through describeSignInStall");

  // 10. The two in-page functions, run against a fake page (module rule: real functions, tested).
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { document: g.document, MutationObserver: g.MutationObserver, window: g.window };
  try {
    const seen: { observe: ((changes: unknown[]) => void) | null } = { observe: null };
    g.window = {};
    g.document = { documentElement: {}, querySelector: () => null };
    g.MutationObserver = class { constructor(cb: (changes: unknown[]) => void) { seen.observe = cb; } observe() {} };
    assert.equal(recordSignInNotices(), true);
    const el = (attrs: Record<string, string>, text: string, className = "") => ({
      className, getAttribute: (name: string) => attrs[name] ?? null, innerText: text, nodeType: 1,
      querySelectorAll: () => [],
    });
    const observe = seen.observe;
    assert.ok(observe, "the recorder must start an observer");
    observe([
      { addedNodes: [el({ role: "alert" }, "  Error:   Please complete the captcha ")], target: { nodeType: 3, parentElement: null } },
      { addedNodes: [el({}, "Get Started for $0.99/mo")], target: { nodeType: 3, parentElement: null } },
      { addedNodes: [el({}, "Too many attempts", "Toastify__toast")], target: { nodeType: 3, parentElement: null } },
    ]);
    const quietPage = readSignInBlockersInPage();
    assert.deepEqual(quietPage.notices, ["Error: Please complete the captcha", "Too many attempts"], "only notice-shaped nodes are kept, whitespace folded");
    assert.equal(quietPage.captcha, false);
    g.document = { querySelector: (selector: string) => (selector.includes("recaptcha") ? {} : null) };
    assert.equal(readSignInBlockersInPage().captcha, true, "a reCAPTCHA frame on the page must be seen");

    // 11. An INVISIBLE bot check draws no widget, so it is read from the scripts the page loads: by
    //     host (a look-alike path on another host is not one), query never kept.
    const scripts = (sources: string[]) => ({
      querySelector: () => null,
      querySelectorAll: () => sources.map((src) => ({ getAttribute: (name: string) => (name === "src" ? src : null) })),
    });
    g.document = scripts([
      "https://www.google.com/recaptcha/enterprise.js?render=SITEKEY123",
      "https://client.px-cloud.net/PXabc/main.min.js",
      "/static/app.js",
      "https://evil.example/recaptcha.net/fake.js",
      "https://notdatadome.co.example/x.js",
    ]);
    const hidden = readSignInBlockersInPage();
    assert.deepEqual(hidden.botChecks, ["www.google.com/recaptcha", "px-cloud.net"], "known bot checks by host, look-alikes ignored");
    assert.ok(!JSON.stringify(hidden).includes("SITEKEY123"), "a script's query must never be kept");
    g.document = scripts(["/static/app.js", "https://login.turbify.com/main.js"]);
    assert.deepEqual(readSignInBlockersInPage().botChecks, [], "the page's own scripts are not a bot check");
  } finally {
    g.document = saved.document;
    g.window = saved.window;
    g.MutationObserver = saved.MutationObserver;
  }

  // 12. The in-page list is a copy (module constants do not exist inside the page): held equal.
  const inPage = source.slice(source.indexOf("export function readSignInBlockersInPage("));
  for (const entry of BOT_CHECK_SOURCES) {
    assert.ok(inPage.slice(0, inPage.indexOf("const botChecks")).includes(`"${entry}"`), `the in-page list must carry ${entry}`);
  }

  // 13. A request's host and path only — never its query or fragment, where a credential can ride.
  assert.equal(exchangeTarget("https://login.turbify.com/api/login?password=S3cretPass!&u=a#frag"), "login.turbify.com/api/login");
  assert.equal(exchangeTarget("data:text/plain,hello"), null);
  assert.equal(exchangeTarget("not a url"), null);
  assert.equal(isTellingExchange("POST", "image"), true, "anything that is not a GET is kept");
  assert.equal(isTellingExchange("GET", "document"), true);
  assert.equal(isTellingExchange("GET", "xhr"), true);
  assert.equal(isTellingExchange("GET", "image"), false, "a static file says nothing about a refusal");
  assert.equal(isTellingExchange("GET", "script"), false);

  // 14. The watcher only LISTENS, records the answers to the press, and lets go when stopped.
  {
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const page = {
      off: (event: string, fn: (payload: unknown) => void) => listeners.get(event)?.delete(fn),
      on: (event: string, fn: (payload: unknown) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
    };
    const emit = (event: string, payload: unknown) => { for (const fn of listeners.get(event) ?? []) fn(payload); };
    const request = (method: string, type: string, url: string, failure: string | null = null) => ({
      failure: () => (failure ? { errorText: failure } : null), method: () => method, resourceType: () => type, url: () => url,
    });
    const response = (method: string, type: string, url: string, status: number) => ({
      request: () => request(method, type, url), status: () => status, url: () => url,
    });
    const watch = watchSignInExchanges(page as never, 3);
    emit("response", response("POST", "xhr", `https://login.turbify.com/api/login?pw=${secret}`, 403));
    emit("response", response("GET", "image", "https://login.turbify.com/logo.png", 200));
    emit("requestfailed", request("POST", "fetch", "https://px.example/collector", "net::ERR_BLOCKED_BY_CLIENT"));
    emit("response", response("GET", "document", "https://login.turbify.com/login", 200));
    emit("response", response("GET", "xhr", "https://login.turbify.com/over-the-limit", 200));
    const answered = watch.stop();
    assert.deepEqual(answered, [
      { failed: null, method: "POST", status: 403, target: "login.turbify.com/api/login" },
      { failed: "net::ERR_BLOCKED_BY_CLIENT", method: "POST", status: null, target: "px.example/collector" },
      { failed: null, method: "GET", status: 200, target: "login.turbify.com/login" },
    ], "telling answers only, in order, capped, no query");
    assert.ok(!JSON.stringify(answered).includes(secret), "the password in a query must never be recorded");
    assert.equal([...listeners.values()].reduce((n, set) => n + set.size, 0), 0, "stop must remove every listener");
    emit("response", response("POST", "xhr", "https://login.turbify.com/late", 500));
    assert.equal(watch.stop().length, 3, "nothing is recorded after stop");
    assert.deepEqual(watchSignInExchanges({} as never).stop(), [], "a page with no events records nothing");
  }

  // 15. The measurement is printed, redacted, and says plainly when the press never left the page.
  const none = describeSignInMeasurement({ botChecks: [], captcha: false, exchanges: [], notices: [], webdriver: true }, []);
  assert.match(none, /made no request at all, so the press never reached Turbify/);
  assert.match(none, /loads no known hidden bot check/);
  assert.match(none, /navigator\.webdriver is true/);
  const some = describeSignInMeasurement({
    botChecks: ["www.google.com/recaptcha"],
    captcha: false,
    exchanges: [{ failed: null, method: "POST", status: 403, target: `login.turbify.com/${secret}` }],
    notices: [],
    webdriver: false,
  }, [secret]);
  assert.match(some, /made 1 request\(s\): \[POST login\.turbify\.com\/.* -> 403\]/);
  assert.match(some, /hidden bot check from \[www\.google\.com\/recaptcha\]/);
  assert.ok(!some.includes(secret), "a measured line must pass through the secret redaction");
  assert.ok(!/automated/.test(some), "webdriver false must not be reported as automated");
  assert.equal(describeSignInMeasurement({ captcha: false, notices: [] }, []), "", "an unmeasured stall prints nothing extra");
  assert.match(
    describeSignInStall("the administrator", 30_000, { captcha: false, exchanges: [], notices: [] }, "url x", []),
    /never reached Turbify\. The page it was on/,
    "the stall carries the measurement before the page description",
  );

  // 16. Wiring: the watcher starts BEFORE the press, stops on every path, and its answers reach the refusal.
  const watchAt = signIn.indexOf("watchSignInExchanges(target)");
  assert.ok(watchAt > -1 && watchAt < press, "the watcher must be installed before the sign-in press");
  assert.match(signIn, /finally \{\s*answered = exchanges\.stop\(\);\s*\}/, "the watcher must be stopped on every path");
  assert.match(signIn, /exchanges: answered/, "the answers must reach the stall description");
}

export async function runNewHireMailboxRobotTests(): Promise<void> {
  await runExistingMailboxTakesNoSlotCases();
  runExistenceReadingCases();
  runExistenceWiringCases();
  runMailboxLoginCases();
  runCredentialReadCases();
  runCorrectedRefusalCases();
  await runPageDescriptionCases();
  await runAlreadyExistsLogLevelCases();
  await runSignInLandingCases();
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
  // 🔴 "Manage your account" IS TURBIFY'S WORDING AFTER ALL, and this pin had it backwards for part
  // of 2026-10-03. Their own article SLN29264 gives the path as profile icon → "Manage your account"
  // → "Manage App Passwords" → a dropdown → "Generate"; "Account info" is the MOBILE DEEP-LINK path
  // (`/accountinfo`), not a link's text. The earlier correction trusted two third-party write-ups
  // that were both describing that URL, and demoted the right answer on the strength of it.
  assert.equal(APP_PASSWORD_PAGE.manageAccount.value, "Manage your account");
  assert.equal(APP_PASSWORD_WORDINGS.accountInfo[0], "Manage your account");
  // 🔴 EDITED 2026-10-04 WHEN THE LIVE PAGE ANSWERED. This asserted "Manage App Passwords", which
  // is the LABEL — and the real button's text is `APP Password Manage App Passwords`, the section
  // HEADING glued into it. `matchesLocator` compares exactly, never as a substring, so the label
  // alone can never match. The measured composite leads; the label stays behind it.
  assert.equal(APP_PASSWORD_WORDINGS.appPasswords[0], "APP Password Manage App Passwords");
  assert.ok(
    (APP_PASSWORD_WORDINGS.appPasswords as readonly string[]).includes("Manage App Passwords"),
    "the label stays behind the composite — it is what works if Turbify drops the heading back out",
  );
  assert.ok(
    (APP_PASSWORD_WORDINGS.accountInfo as readonly string[]).includes("Account info"),
    "the deep-link wording stays behind it rather than being deleted — a page may well show both",
  );
  // 🔴 AND THE DROPDOWN TURBIFY REQUIRES BEFORE GENERATE. Phoenix is never in their app list, so the
  // answer is always "Other" plus a name.
  assert.equal(APP_PASSWORD_WORDINGS.otherApp[0], "Other");
  for (const [step, wordings] of Object.entries(APP_PASSWORD_WORDINGS)) {
    // `appPasswords` IS measured now (2026-10-04); the rest are still well-sourced guesses, and
    // every list keeps more than one candidate so a reworded page has somewhere to land.
    assert.ok(wordings.length > 1, `${step} must offer more than one candidate`);
    for (const wording of wordings) {
      assert.doesNotMatch(wording, /[>#[\]]|__UNCALIBRATED__/, `${wording} must not be a CSS path`);
    }
  }
  // 🔴 AND THEY ARE PRESSED AS LINKS OR BUTTONS. `Account info` is an `<a>`; a list restricted to
  // `button` would have missed every candidate and blamed the wording.
  assert.match(
    stripComments(
      readFileSync(
        new URL("src/lib/new-hire-mailbox/robot/turbify-joiner.ts", new URL("../", import.meta.url)),
        "utf8",
      ),
    ).replace(/\s+/g, " "),
    /APP_PASSWORD_WORDINGS\.appPasswords, "the App Passwords section", LINK_OR_BUTTON/,
    "the app-password steps must accept a link, not only a button",
  );

  // A missing control fails CLOSED, with a message naming what to go and look at.
  const error = missingControl(ECP_LOCATORS.resetPassword);
  assert.equal(error.name, "TurbifyControlMissingError");
  assert.match(error.message, /aria-label "Reset password"/);
  assert.match(error.message, /stopped rather than guess/);
  assert.match(describeLocator(ECP_LOCATORS.searchBox), /placeholder "Search users\.\.\."/);

  // ── the company password the Super Admin hands over ──────────────────────────────────────────
  // 🔴 THE INVITE RECIPIENT CHANGED ON 2026-10-03, AND THE OLD ASSERTION HERE DEMANDED THE BUG.
  // It pinned an EMPTY recipient, on the belief that nobody should be emailed a credential. Then
  // Turbify's create turned out to hand back no password at all: it emails a `Temp Password:` line,
  // so with no recipient the only credential a new mailbox ever has went nowhere, and three real
  // mailboxes were stranded `Pending` while the sweep reported `provisioned: 0`.
  //
  // The intent behind the old line is kept, and it is the stronger half: no PERSON is emailed a new
  // hire's credential. The recipient is a mailbox Phoenix itself owns and reads.
  assert.equal(
    TURBIFY_INVITE_RECIPIENT, "hr.mailbox@satopharma.com",
    "the invitation must go to the mailbox Phoenix reads, so the robot can finish the mailbox itself",
  );
  assert.notEqual(TURBIFY_INVITE_RECIPIENT, "", "an empty recipient strands every mailbox the robot creates");
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

  // ── the same rule, for a driver that reads the rows itself ───────────────────────────────────
  // 🔴 The revocation driver drives puppeteer directly, so it uses this pure form. It is the gate
  // that stops a reset landing on a WORKING employee when the search box did not narrow to the one
  // mailbox: the driver's own dialog check catches a wrong row only AFTER the reset has happened,
  // and detection is not prevention. It is an IDENTITY rule, because the console's search matches
  // substrings and a count cannot see "one row, and it belongs to somebody else".
  runRowIdentityCases();
  runRowReaderCases();

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
