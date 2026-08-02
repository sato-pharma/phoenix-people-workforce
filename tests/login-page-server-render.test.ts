import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const loginPageSource = readFileSync(
  new URL("../app/login/page.tsx", import.meta.url),
  "utf8",
);
const premiumLoginSource = readFileSync(
  new URL("../src/components/auth/premium-login-page.tsx", import.meta.url),
  "utf8",
);

export function runLoginPageServerRenderTests() {
  // 1) HEADLINE: /login must server-render its form. PR #492 wrapped PremiumLoginPage in
  //    next/dynamic with `ssr: false` to dodge an SSR error that no longer exists
  //    (@simplewebauthn/browser 13.x touches no browser global at module scope). The cost
  //    was that the served HTML for /login contained ZERO inputs — the sign-in form only
  //    appeared after a second wave of client JS downloaded and hydrated, which on a weak
  //    mobile connection is a long blank wait before a user can even type credentials.
  //    Any `ssr: false` on the login page's own tree reintroduces exactly that.
  assert.doesNotMatch(
    loginPageSource,
    /ssr\s*:\s*false/,
    "app/login/page.tsx must not disable SSR — the sign-in form has to be in the served HTML.",
  );
  assert.doesNotMatch(
    loginPageSource,
    /premium-login-page-dynamic/,
    "The ssr:false wrapper is gone; app/login/page.tsx must import PremiumLoginPage directly.",
  );
  assert.match(
    loginPageSource,
    /import\s*\{\s*PremiumLoginPage\s*\}\s*from\s*"@\/components\/auth\/premium-login-page"/,
    "app/login/page.tsx must import PremiumLoginPage directly so it renders on the server.",
  );
  assert.match(
    loginPageSource,
    /<PremiumLoginPage\b/,
    "app/login/page.tsx must render <PremiumLoginPage /> itself, not a deferred wrapper.",
  );

  // 2) The component itself must not be re-wrapped in a client-only shim further down.
  assert.doesNotMatch(
    premiumLoginSource,
    /ssr\s*:\s*false/,
    "PremiumLoginPage must stay server-renderable — no ssr:false inside the component either.",
  );

  // 3) The password field is the thing a user needs in the first HTML response. If this
  //    ever stops being plain markup (moved behind an effect, a portal, or a client-only
  //    branch) the served HTML silently loses the form again without any other test failing.
  assert.match(
    premiumLoginSource,
    /type=\{showPassword \? "text" : "password"\}/,
    "PremiumLoginPage must render the password input as plain markup so it lands in the SSR HTML.",
  );

  // 4) @simplewebauthn/browser is only needed when the fingerprint button is pressed.
  //    A top-level VALUE import pulls the whole WebAuthn client into the login page's
  //    first JS payload — the opposite of the point of server-rendering the form. A
  //    type-only import is erased at build time and is fine.
  assert.doesNotMatch(
    premiumLoginSource,
    /^import\s+\{[^}]*\}\s+from\s+"@simplewebauthn\/browser"/m,
    "@simplewebauthn/browser must not be a top-level value import — load it inside handleBiometricSignIn.",
  );
  assert.match(
    premiumLoginSource,
    /await import\("@simplewebauthn\/browser"\)/,
    "handleBiometricSignIn must load @simplewebauthn/browser on demand.",
  );

  // 5) Getting the form into the HTML is only half the job. A `loading.tsx` ABOVE /login
  //    puts it inside a Suspense boundary, so the form is streamed into a hidden staging
  //    div and only revealed once React's client runtime runs — React 19.2 schedules that
  //    reveal on requestAnimationFrame. A root app/loading.tsx therefore silently undoes
  //    the point of server-rendering the form: the markup ships, but nobody can see it
  //    until JS boots. /login must stay the one content route with no loading boundary.
  //    Routes that want the full-screen fallback opt in with their own loading.tsx.
  assert.equal(
    existsSync(new URL("../app/loading.tsx", import.meta.url)),
    false,
    "app/loading.tsx must not exist — a root loading boundary wraps /login and hides its form until JS runs.",
  );
  assert.equal(
    existsSync(new URL("../app/login/loading.tsx", import.meta.url)),
    false,
    "app/login/loading.tsx must not exist — any boundary over /login defers the form behind a client-side reveal.",
  );
}
