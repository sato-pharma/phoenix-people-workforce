// The login page must fit a phone — and on a phone the SIGN-IN FORM must come first.
//
// WHY THIS EXISTS. `/login` is the one page every employee sees before anything else, and since
// 2026-09-29 it is also the mobile app's own login: the Expo app renders this exact page in a
// WebView (`mobile/src/app/login.tsx`), because the owner asked for the app's login to be "exactly
// as the web app". So a regression here is not one page — it is the front door on every phone, every
// tablet and the web at once, and on the app it is the only screen standing between a rep and the
// portal.
//
// Nothing guarded it. Measured 2026-09-29: every test touching `/login` graded auth, sessions,
// WebAuthn or access control — not one asserted the FITS-THE-SCREEN GOLDEN RULE (AGENTS.md §4:
// never a horizontal scroll, always mobile AND desktop friendly). The page happens to be correct
// today; this keeps it correct.
//
// 🔴 THE LOAD-BEARING PROPERTY IS THE STACKING ORDER, AND IT IS EASY TO BREAK WITHOUT NOTICING.
// The layout is two panels in a `lg:grid-cols-[…]` grid. Below `lg` they stack, and the ORDER
// classes are what decide which one a phone shows first: the sign-in `<section>` is `order-1` with
// `lg:order-2`, and the branding `<aside>` is `order-2` with `lg:order-1`. That deliberate inversion
// is why a desktop reads branding-left / form-right while a phone lands directly on the form. Delete
// or flip those classes — which looks like tidying, since on desktop nothing moves — and every phone
// gets a 500px-tall branding wall to scroll past before it can reach the password field. The desktop
// screenshot would look identical, so review would not catch it.
//
// WHAT THIS DELIBERATELY DOES NOT ASSERT. There is one `whitespace-nowrap` on the biometric sign-in
// button. It is not a layout floor: the button is `w-full`, and it only renders when
// `isUserVerifyingPlatformAuthenticatorAvailable()` resolves true (so, never in the app's WebView).
// Banning it would be asserting a defect that has not been shown to exist, against a design the
// owner froze as "exactly the web app". The rule this file enforces is the sideways-scroll one, and
// `min-w-*` / `overflow-x-*` are its actual causes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const LOGIN_PAGE = "src/components/auth/premium-login-page.tsx";
const ROUTE = "app/login/page.tsx";
const RULE = "FITS-THE-SCREEN GOLDEN RULE (AGENTS.md §4)";

const read = (relativePath: string) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

export function runLoginPageMobileFitTests() {
  const source = read(LOGIN_PAGE);
  const route = read(ROUTE);

  // Anchors first. Without these the whole file could pass against a page that moved or was gutted,
  // which is the failure mode that makes a guard worse than none.
  assert.match(
    route,
    /PremiumLoginPage/,
    `${ROUTE} no longer renders PremiumLoginPage — this test grades a component the /login route has stopped using. ` +
      "Point it at whatever draws the login page now, rather than deleting it.",
  );
  assert.ok(
    source.includes("<aside") && source.includes("<section"),
    `${LOGIN_PAGE} no longer has the two-panel <aside>/<section> layout this test grades — find where the login ` +
      "panels live now and re-point the assertions.",
  );

  // 1 · The form comes FIRST on a phone. This is the property worth a test.
  //
  // Pick the panels by their ORDER classes, never by position: the first <section> in this file is
  // the grid WRAPPER (`lg:grid-cols-[1.06fr_0.94fr]`), not the sign-in panel. Taking [0] graded the
  // wrapper and failed against a perfectly correct page — caught while writing this.
  const openingTags = (tag: string): string[] =>
    [...source.matchAll(new RegExp(`<${tag}\\s+className="([^"]+)"`, "g"))].map((match) => match[1] ?? "");

  const aside = openingTags("aside").find((cls) => /\border-\d/.test(cls)) ?? "";
  const section = openingTags("section").find((cls) => /\border-\d/.test(cls)) ?? "";

  assert.ok(
    aside !== "" && section !== "",
    `${LOGIN_PAGE}: neither panel carries an \`order-*\` class any more, so the phone stacking order is now whatever ` +
      "the source happens to be in. Restore the explicit order classes — see this file's header for why it matters.",
  );

  assert.ok(
    /\border-1\b/.test(section) && /\blg:order-2\b/.test(section),
    `${RULE}: the sign-in panel must be \`order-1 … lg:order-2\` so a PHONE lands on the form and a DESKTOP still ` +
      "reads form-right. It currently is not, which means every phone — and the mobile app, which renders this " +
      "very page in a WebView — now has to scroll past the branding panel to reach the password field.",
  );
  assert.ok(
    /\border-2\b/.test(aside) && /\blg:order-1\b/.test(aside),
    `${RULE}: the branding aside must be \`order-2 … lg:order-1\` so it sits BELOW the form on a phone. ` +
      "Flipping this looks harmless because desktop is unchanged, and it costs every phone user a scroll " +
      "before they can sign in.",
  );

  // 2 · No width floor. A min-width is the classic cause of a sideways scroll.
  const minWidth = source.match(/\bmin-w-[^\s"']+/g) ?? [];
  assert.deepEqual(
    minWidth,
    [],
    `${RULE}: ${LOGIN_PAGE} declares ${minWidth.join(", ")}. A min-width floor is what forces a page wider than the ` +
      "screen. Fit by letting the panels stack and by capping with max-w-*, never by pinning a minimum.",
  );

  // 3 · No sideways scroller. AGENTS.md is explicit that overflow-x-auto over a min-width IS the bug.
  const overflowX = source.match(/\boverflow-x-(?:auto|scroll)\b/g) ?? [];
  assert.deepEqual(
    overflowX,
    [],
    `${RULE}: ${LOGIN_PAGE} declares ${overflowX.join(", ")}. A horizontal scroller is the bug this rule forbids, ` +
      "not the fix for it — merge or stack the content instead.",
  );

  // 4 · No ellipsis. The owner's rule is that text wraps; it is never truncated.
  const ellipsis = source.match(/\b(?:truncate|text-ellipsis|overflow-ellipsis)\b/g) ?? [];
  assert.deepEqual(
    ellipsis,
    [],
    `${LOGIN_PAGE} declares ${ellipsis.join(", ")}. The owner's standing rule is NEVER truncate text with an ` +
      "ellipsis, and where it collides with the no-horizontal-scroll rule, wrapping wins (AGENTS.md §4).",
  );
}
