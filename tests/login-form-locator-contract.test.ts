// The login smoke tests must find the login form by something that is NOT product copy.
//
// WHY THIS EXISTS, MEASURED. On 2026-10-07 #5418 shipped email sign-in and widened the
// identifier field's label from "HR_ID or Login ID" to "HR ID, Login ID or Sato email". Three
// Playwright setups located that field by its accessible NAME, so the rename made it
// unfindable and `auth.setup.ts` failed `expect(...).toBeVisible()` after 15s, twice.
//
// That failure is not an inconvenience, it is a stalled deploy pipeline. The build and the smoke
// test are skipped on a pull request and run only on a push to `main`, so the break could not
// appear until after the merge — and because Railway holds the production deploy until every
// check suite on the commit is green, THREE commits were marked SKIPPED and never shipped:
// `ac76bb73e` (#5418), `965bc7e53` (#5417) and `a982544de` (#5420). Every one of those PRs was
// green. #5421 repaired the locators and the next green merge carried production forward.
//
// #5421 fixed the identifier field. This test is what stops the next copy edit doing it again,
// because nothing else does: the smoke test cannot run on a pull request, so the only cheap
// place to catch a broken locator is a unit assertion like this one.
//
// It holds both ends:
//
//   1. every `#id` the setups locate must EXIST as an `id="…"` in the login component, so
//      renaming the id fails here — on a pull request — instead of withholding a deploy after
//      the merge;
//   2. no setup may go back to matching a login FIELD by label text, for either field, because
//      that is the exact coupling that broke;
//   3. the submit button's accessible-name pattern must be ANCHORED. The page also renders
//      "Sign in with biometrics", which an unanchored /Sign in/i matches as well — two hits is
//      a Playwright strict-mode error, not a pick. Both buttons render on the staging login
//      form today.
//
// 🔴 It deliberately does NOT assert the label's wording. Pinning the copy would just move the
// breakage: the next person to widen that label would fail a test that is right to change, and
// the lesson of this incident is that the label is free to change and the test must not care.
//
// Each property is asserted SEPARATELY with its own message, for the reason
// tests/scheduled-alarms-never-withhold.test.ts states in its own header: a single combined
// condition makes every clause after the first unreachable, so the failure would not say which
// end moved.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LOGIN_COMPONENT = "src/components/auth/premium-login-page.tsx";

/**
 * Every setup that drives the real login form.
 *
 * All three are listed because #5418 broke all three at once and only two were found first —
 * tests/synthetic/helpers/auth.setup.ts is the one that is easy to miss, since it lives outside
 * tests/e2e/. They must move together, or a green run just relocates the failure.
 */
const SETUPS = [
  "tests/e2e/auth.setup.ts",
  "tests/e2e/auth.data-user.setup.ts",
  "tests/synthetic/helpers/auth.setup.ts",
];

/** The two fields a setup has to drive to get a session. */
const REQUIRED_IDS = ["login-id", "login-password"];

function read(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

/** Every `id="…"` the login component actually renders. */
function renderedIds(source: string): Set<string> {
  return new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

/** Every `.locator("#…")` id a setup uses. */
function locatedIds(source: string): string[] {
  return [...source.matchAll(/\.locator\(\s*"#([^"]+)"\s*\)/g)].map((m) => m[1]);
}

/**
 * Code only, comments stripped.
 *
 * The comments in these setups QUOTE the old `getByRole("textbox", …)` locator to explain what
 * was removed and why, so a check for that pattern over the raw text fails on the very
 * documentation that records the incident.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

export function runLoginFormLocatorContractTests() {
  const component = read(LOGIN_COMPONENT);
  const ids = renderedIds(component);

  // The component still renders the ids every setup depends on.
  for (const id of REQUIRED_IDS) {
    assert.ok(
      ids.has(id),
      `${LOGIN_COMPONENT} no longer renders id="${id}". The Playwright login setups locate that ` +
        `field by this id, they run ONLY on a push to main, and that job is the production deploy ` +
        `gate — so a rename here does not fail a pull request, it silently stops production ` +
        `deploying (that is how ac76bb73e, 965bc7e53 and a982544de were all withheld on ` +
        `2026-10-07). Keep the id, or update all of ${SETUPS.join(", ")} in the SAME commit.`,
    );
  }

  for (const setupPath of SETUPS) {
    const raw = read(setupPath);
    const code = stripComments(raw);

    assert.ok(
      code.length < raw.length,
      `stripComments removed nothing from ${setupPath} — if the comment syntax changed, every ` +
        `assertion below is reading the wrong text and would pass vacuously.`,
    );

    // Nothing may point at an id the component does not render.
    const used = locatedIds(code);
    assert.ok(
      used.length > 0,
      `${setupPath} no longer locates the login form by id. It must not go back to matching a ` +
        `field by its visible label — that copy changed under it in #5418 and withheld three ` +
        `production deploys.`,
    );
    for (const id of used) {
      assert.ok(
        ids.has(id),
        `${setupPath} locates "#${id}", which ${LOGIN_COMPONENT} does not render. The smoke test ` +
          `would fail after the merge, on main, where its failure withholds the production deploy.`,
      );
    }

    // Both fields are driven by id, not just the one that broke.
    for (const id of REQUIRED_IDS) {
      assert.ok(
        used.includes(id),
        `${setupPath} does not drive "#${id}" by id. Both login fields are located by id so that ` +
          `a label rewrite cannot reach the deploy gate — fixing only the field that happened to ` +
          `break leaves the same defect one copy edit away.`,
      );
    }

    // The fragile coupling must not come back for either field.
    assert.ok(
      !/getByRole\(\s*"textbox"/.test(code),
      `${setupPath} matches a login field by accessible NAME again (getByRole("textbox", …)). ` +
        `The identifier label is product copy — it went from "HR_ID or Login ID" to ` +
        `"HR ID, Login ID or Sato email" in #5418 — and a copy edit must not be able to withhold ` +
        `a production deploy. Locate by id.`,
    );

    // The submit button's pattern is anchored, because "Sign in with biometrics" also matches.
    const signIn = code.match(/getByRole\(\s*"button",\s*\{\s*name:\s*(\/[^/]+\/[a-z]*)/);
    assert.ok(
      signIn,
      `${setupPath} no longer clicks the submit button by role and name — if the click moved, ` +
        `check that it cannot match "Sign in with biometrics" as well.`,
    );
    const pattern = signIn![1];
    assert.ok(
      pattern.includes("^") && pattern.includes("$"),
      `${setupPath} matches the submit button with ${pattern}, which is unanchored. The login ` +
        `page also renders "Sign in with biometrics", so that pattern resolves to TWO visible ` +
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
