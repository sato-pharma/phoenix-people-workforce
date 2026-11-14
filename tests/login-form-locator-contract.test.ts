// The Playwright login setups must find the login form by something that is NOT product copy.
//
// WHY THIS EXISTS, MEASURED. On 2026-10-06 #5418 shipped Sato-email sign-in and widened the
// identifier field's label from "HR_ID or Login ID" to "HR ID, Login ID or Sato email". All
// three Playwright setups located that field by its accessible NAME —
// `getByRole("textbox", { name: /HR_ID or Login ID/i })` — so the rename made the element
// unfindable and the setup failed on `expect(...).toBeVisible()` after 15s.
//
// That is not an inconvenience, it is an outage of the deploy pipeline. The build and the login
// smoke are skipped on a `pull_request` and run only on a push to `main`, so the break could not
// appear until after the merge — and because Railway holds the production deploy until every
// check suite on the commit is green, the merges that followed never shipped. Nothing turned red
// anywhere a human was looking: every required check on the PR was green.
//
// The repair (#5421) was to locate by the form's own `id`, which is wired to the submit handler
// and so cannot be moved by an editor tidying a label. It is proven: on `eb286d2a8` the `validate`
// job's "Run Playwright login smoke test" step reported `success`, and production shipped.
//
// Nothing yet held that repair in place, which is the hole this test closes. It asserts, on a
// pull request, where a failure costs nothing:
//
//   1. the login component still renders every id the setups drive, and every `#id` a setup
//      locates still exists in the component — so renaming an id fails here instead of
//      withholding a deploy after the merge;
//   2. no setup goes back to matching a login field by label text, because that is the exact
//      coupling that broke;
//   3. the submit button's accessible-name pattern is ANCHORED. The page also renders "Sign in
//      with biometrics" (behind `biometricAvailable`, so it does not render in CI today) — an
//      unanchored /Sign in/i matches both, and two hits is a Playwright strict-mode error rather
//      than a pick. Anchoring costs nothing and removes the trap before a passkey-capable runner
//      makes it real.
//
// 🔴 It deliberately does NOT assert the label's wording. Pinning the copy would just move the
// breakage: the next person to widen that label would fail a test that is right to change, and
// the lesson of this incident is that the label is free to change and the test must not care.
//
// Each property is asserted SEPARATELY with its own message: one combined condition makes every
// clause after the first unreachable, so the failure would not say which end moved. And every
// extraction is COUNT-GUARDED against the raw occurrences in the file, because a regex that
// quietly matches nothing passes every assertion built on it — that is how an earlier draft of
// this guard went green with the real break sitting in the file.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const LOGIN_COMPONENT = "src/components/auth/premium-login-page.tsx";

/** Every setup that drives the real login form to get a session. */
const SETUPS = [
  "tests/e2e/auth.setup.ts",
  "tests/e2e/auth.data-user.setup.ts",
  "tests/synthetic/helpers/auth.setup.ts",
];

/** The two fields a setup has to fill before it can submit. */
const REQUIRED_IDS = ["login-id", "login-password"];

/**
 * Everything below reads CODE, never prose. The comment in auth.setup.ts quotes the locator that
 * broke — `getByRole("textbox", { name: /HR_ID or Login ID/i })` — because that is the whole
 * point of the comment, and an earlier draft of this test failed on it. Policing the wording of
 * a comment would mean nobody could ever document the incident next to the fix.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Every `id="…"` the login component actually renders. */
function renderedIds(source: string): Set<string> {
  return new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

/** Every `#id` a setup locates. */
function locatedIds(source: string): string[] {
  return [...source.matchAll(/\.locator\(\s*"#([^"]+)"\s*\)/g)].map((m) => m[1]);
}

export function runLoginFormLocatorContractTests() {
  const component = stripComments(read(LOGIN_COMPONENT));
  const ids = renderedIds(component);

  // The extraction itself has to work, or every assertion below is vacuous.
  assert.ok(
    ids.size >= 4,
    `${LOGIN_COMPONENT}: the id extractor found only ${ids.size} id attributes, which cannot be ` +
      `right — the login form alone renders four. The regex has stopped matching, so every ` +
      `assertion in this test would pass without reading anything. Fix the extractor first.`,
  );

  // 1a. The component still renders the ids the smoke test depends on.
  for (const id of REQUIRED_IDS) {
    assert.ok(
      ids.has(id),
      `${LOGIN_COMPONENT} no longer renders id="${id}". The Playwright login setups locate that ` +
        `field by this id, they run ONLY on a push to main, and that job is the production ` +
        `deploy gate — so a rename here does not fail a PR, it silently stops production ` +
        `deploying. Keep the id, or update all of ${SETUPS.join(", ")} in the SAME commit. ` +
        `The ids it does render are ${JSON.stringify([...ids])}.`,
    );
  }

  for (const setupPath of SETUPS) {
    const setup = stripComments(read(setupPath));

    // 1b. Nothing in a setup may point at an id the component does not render.
    const used = locatedIds(setup);
    assert.equal(
      used.length,
      setup.split('.locator("#').length - 1,
      `${setupPath}: the id extractor found ${used.length} located ids but the file contains ` +
        `${setup.split('.locator("#').length - 1} occurrences of '.locator("#'. The regex is ` +
        `missing some, so this test would pass over whichever one is broken.`,
    );
    assert.ok(
      used.length > 0,
      `${setupPath} no longer locates the login form by id. It must not go back to matching a ` +
        `field by its visible label — that copy changed under it in #5418 and withheld the ` +
        `production deploy of the feature that changed it.`,
    );
    for (const id of used) {
      assert.ok(
        ids.has(id),
        `${setupPath} locates "#${id}", which ${LOGIN_COMPONENT} does not render. The login ` +
          `smoke would fail after the merge, on main, where its failure withholds the production ` +
          `deploy. The ids the component renders are ${JSON.stringify([...ids])}.`,
      );
    }

    // 1c. Both fields are driven by id, not just the first one.
    for (const id of REQUIRED_IDS) {
      assert.ok(
        used.includes(id),
        `${setupPath} does not drive "#${id}" by id. Both login fields are located by id so that ` +
          `a label rewrite cannot break the deploy gate.`,
      );
    }

    // 2. The fragile coupling must not come back for either field.
    assert.ok(
      !/getByRole\(\s*"textbox"/.test(setup),
      `${setupPath} matches a login field by accessible NAME again (getByRole("textbox", …)). ` +
        `The identifier label is product copy — it went from "HR_ID or Login ID" to ` +
        `"HR ID, Login ID or Sato email" in #5418 — and a copy edit must not be able to ` +
        `withhold a production deploy. Locate by id.`,
    );

    // 3. The submit button's pattern is anchored, because "Sign in with biometrics" also matches.
    const signIn = setup.match(/getByRole\(\s*"button",\s*\{\s*name:\s*(\/[^/]+\/[a-z]*)/);
    assert.ok(
      signIn,
      `${setupPath} no longer clicks the submit button by role and name — if the click moved, ` +
        `check it cannot match "Sign in with biometrics" as well.`,
    );
    const pattern = signIn![1];
    assert.ok(
      pattern.includes("^") && pattern.includes("$"),
      `${setupPath} matches the submit button with ${pattern}, which is unanchored. The login ` +
        `page also renders "Sign in with biometrics", so that pattern can resolve to TWO visible ` +
        `buttons and Playwright fails the click with a strict-mode error instead of choosing. ` +
        `Anchor it (/^Sign in$/i).`,
    );

    // The anchored pattern must still accept the real button and reject the biometrics one.
    const body = pattern.slice(1, pattern.lastIndexOf("/"));
    const flags = pattern.slice(pattern.lastIndexOf("/") + 1);
    const re = new RegExp(body, flags);
    assert.ok(
      re.test("Sign in"),
      `${setupPath}'s submit-button pattern ${pattern} no longer matches the button's own text ` +
        `"Sign in".`,
    );
    assert.ok(
      !re.test("Sign in with biometrics"),
      `${setupPath}'s submit-button pattern ${pattern} still matches "Sign in with biometrics", ` +
        `so the click resolves to two elements and fails strict mode.`,
    );
  }

  // 4. The production smoke test signs in as a SUPER ADMIN (admin-HR), and since 14 Nov 2026 that
  // account's password sign-in also asks for its authenticator code (docs/security/second-sign-in-step.md).
  // A setup that stops after "Sign in" sits on the code field until it times out, every journey is
  // skipped, and the smoke test pages Telegram every three hours. Each end of that chain is pinned.
  {
    const SYNTHETIC = "tests/synthetic/helpers/auth.setup.ts";
    const synthetic = stripComments(read(SYNTHETIC));
    assert.ok(
      locatedIds(synthetic).includes("login-second-step-code"),
      `${SYNTHETIC} no longer types into "#login-second-step-code". Its account is a Super Admin, so the ` +
        `password alone leaves it on the code field and the whole smoke run fails at sign-in.`,
    );
    assert.ok(
      /totpCode\(\s*totpSecret/.test(synthetic) && synthetic.includes("process.env.SYNTHETIC_ADMIN_TOTP_SECRET"),
      `${SYNTHETIC} no longer makes the code from SYNTHETIC_ADMIN_TOTP_SECRET with totpCode(). The key is ` +
        `the account's authenticator; nothing else can produce the code it is asked for.`,
    );
    const buttons = [...synthetic.matchAll(/getByRole\(\s*"button",\s*\{\s*name:\s*(\/[^/]+\/[a-z]*)/g)].map((m) => m[1]);
    const CHECK = "Check the code and sign in";
    assert.ok(
      component.includes(`"${CHECK}"`),
      `${LOGIN_COMPONENT} no longer labels the code step's button "${CHECK}". ${SYNTHETIC} clicks it by that ` +
        `name — change both in the same commit.`,
    );
    const checkPattern = buttons.find((p) => {
      const re = new RegExp(p.slice(1, p.lastIndexOf("/")), p.slice(p.lastIndexOf("/") + 1));
      return re.test(CHECK);
    });
    assert.ok(checkPattern, `${SYNTHETIC} never clicks the "${CHECK}" button, so the code it typed is never sent.`);
    assert.ok(
      checkPattern!.includes("^") && checkPattern!.includes("$"),
      `${SYNTHETIC} matches the code step's button with ${checkPattern}, which is unanchored.`,
    );
    const globalSetup = read("tests/synthetic/helpers/global-setup.ts");
    assert.ok(
      globalSetup.includes("!process.env.SYNTHETIC_ADMIN_TOTP_SECRET"),
      `tests/synthetic/helpers/global-setup.ts no longer refuses to start without SYNTHETIC_ADMIN_TOTP_SECRET, ` +
        `so a missing key shows up as a sign-in timeout instead of a one-line reason.`,
    );
    const workflow = read(".github/workflows/synthetic-journeys.yml");
    assert.ok(
      workflow.includes("SYNTHETIC_ADMIN_TOTP_SECRET: ${{ secrets.SYNTHETIC_ADMIN_TOTP_SECRET }}"),
      `.github/workflows/synthetic-journeys.yml no longer hands SYNTHETIC_ADMIN_TOTP_SECRET to the journeys ` +
        `step, so the production smoke test cannot make the code and fails at sign-in.`,
    );
    assert.ok(
      workflow.includes('[ -z "$TOTP_SECRET" ] && missing="$missing SYNTHETIC_ADMIN_TOTP_SECRET"'),
      `.github/workflows/synthetic-journeys.yml no longer checks SYNTHETIC_ADMIN_TOTP_SECRET is present.`,
    );
  }

  // Each setup must keep its OWN stored session. That is the one property a copy-paste between
  // these files destroys while every locator assertion above still passes — caught for real on
  // 2026-10-07, when a rebase of this very change overwrote tests/e2e/auth.setup.ts with the
  // synthetic setup's body: both files then stored state at tests/synthetic/.auth/admin.json and
  // the e2e setup read SYNTHETIC_ADMIN_* env vars, which are unset in the job that runs the login
  // smoke. The locators were correct in both copies; only the identity had moved, and the smoke
  // would have failed on main — withholding a production deploy exactly as #5418 did.
  const stateOwners = new Map();
  for (const setupPath of SETUPS) {
    // No escape sequences in this extraction on purpose: the declaration is found by index and
    // the value by a quote-only pattern, so nothing here can be mangled by a shell heredoc.
    const setupSource = read(setupPath);
    const at = setupSource.indexOf("AUTH_STATE_PATH =");
    const declared = at < 0 ? null : setupSource.slice(at, at + 240).match(/"([^"]+)"/);
    assert.ok(
      declared,
      `${setupPath} no longer declares AUTH_STATE_PATH. Each login setup writes its own storage ` +
        `state file, and this check is what proves two of them have not been collapsed into one.`,
    );
    const path = declared[1];
    const owner = stateOwners.get(path);
    assert.ok(
      owner === undefined,
      `${setupPath} stores its browser state at "${path}", which ${owner} already owns. Two login ` +
        `setups sharing a state file means one was overwritten with the other's body — they then ` +
        `log in as the wrong account, or with env vars the job does not set, and the failure lands ` +
        `on main where it withholds the production deploy.`,
    );
    stateOwners.set(path, setupPath);
  }
}
