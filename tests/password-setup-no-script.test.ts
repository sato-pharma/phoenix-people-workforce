import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isNativeFormSubmission,
  passwordSetupFormAction,
  passwordSetupNoScriptErrorMessage,
  passwordSetupReturnPath,
} from "../src/lib/auth/password-setup-no-script.ts";

import { stripComments } from "./support/comment-strip.ts";

/**
 * THE CHOOSE-YOUR-PASSWORD SCREEN SAVES WITHOUT JAVASCRIPT — owner, 12 Nov 2026: "he changes the password
 * and keeps being redirected to choose a new password".
 *
 * Measured on production: Next.js's own client runtime carries a class static block, which Safari before
 * 16.4 cannot parse, so on an iOS 15 iPhone no page ever hydrates. Sign-in posted natively and worked; the
 * /password-setup form had only a script handler, so every press reloaded the screen with nothing saved.
 *
 * WHAT THIS PINS:
 *   1. 🔴 THE FORM POSTS ON ITS OWN — method="post", a real action, and NAMED fields. Lose any one and the
 *      native submit carries nothing (or goes nowhere) and the loop is back.
 *   2. 🔴 THE ROUTE ANSWERS A NATIVE POST WITH A 303 BACK TO THE SCREEN, never JSON a phone would print raw.
 *   3. 🔴 ONLY A FIXED CODE TRAVELS IN THE ADDRESS — an unknown code shows nothing, so a crafted link
 *      cannot make Phoenix's screen say words Phoenix did not write.
 *   4. 🔴 ?saved=1 IS BELIEVED ONLY ON A SPENT LINK — a live link with ?saved=1 still shows the form.
 */
export function runPasswordSetupNoScriptTests() {
  // ── The helpers ─────────────────────────────────────────────────────────────────────────
  assert.equal(isNativeFormSubmission("application/x-www-form-urlencoded"), true, "a browser's own form post is recognised");
  assert.equal(isNativeFormSubmission("multipart/form-data; boundary=x"), true, "a multipart form post is recognised");
  assert.equal(isNativeFormSubmission("application/json"), false, "the script's JSON post keeps its JSON answer");
  assert.equal(isNativeFormSubmission(null), false, "no content type is not a form post");

  assert.equal(
    passwordSetupFormAction("ab/c", true),
    "/api/auth/password-setup/ab%2Fc?then=sign-in",
    "the action carries the token encoded and the sign-in-after flag, so a refusal returns to the same screen",
  );
  assert.equal(passwordSetupFormAction("abc", false), "/api/auth/password-setup/abc", "an admin link posts with no flag");

  assert.equal(
    passwordSetupReturnPath("abc", { error: "password_mismatch", signInAfter: true }),
    "/password-setup/abc?then=sign-in&error=password_mismatch",
    "a refusal goes back to the same screen with a code",
  );
  assert.equal(passwordSetupReturnPath("abc", { saved: true }), "/password-setup/abc?saved=1", "a save goes to the saved screen");

  assert.equal(passwordSetupNoScriptErrorMessage("password_mismatch"), "Passwords do not match.");
  assert.equal(passwordSetupNoScriptErrorMessage("too_short"), "Password must be at least 8 characters.");
  assert.equal(
    passwordSetupNoScriptErrorMessage("Your account is locked, call 0100"),
    null,
    "🔴 an unknown code shows nothing — the address never carries words onto Phoenix's screen",
  );
  assert.equal(passwordSetupNoScriptErrorMessage("toString"), null, "an inherited property name is not a code");
  assert.equal(passwordSetupNoScriptErrorMessage(undefined), null);

  // ── The form ────────────────────────────────────────────────────────────────────────────
  const form = stripComments(readFileSync("src/components/auth/password-setup-form.tsx", "utf8"));
  const formTag = form.match(/<form\b[^>]*>/u)?.[0] ?? "";
  assert.match(formTag, /method="post"/u, "🔴 the form posts natively — without it a press is a GET that reloads the screen");
  assert.match(formTag, /action=\{action\}/u, "🔴 the form carries the setup route as its action");
  assert.match(formTag, /onSubmit=\{submitForm\}/u, "a browser that runs scripts still takes the JSON path and signs in after");
  assert.match(form, /name="password"/u, "🔴 the new password field is named, or the native post carries nothing");
  assert.match(form, /name="confirmPassword"/u, "🔴 the confirm field is named with the key the route reads");
  assert.match(form, /useState<string \| null>\(initialError\)/u, "a refusal carried back in the address is shown on the screen");
  assert.doesNotMatch(form, /password-setup-no-script/u, "the client form never imports the helper — it sits beside node:crypto");

  // ── The page ────────────────────────────────────────────────────────────────────────────
  const page = stripComments(readFileSync("app/password-setup/[token]/page.tsx", "utf8"));
  assert.match(page, /action=\{passwordSetupFormAction\(token, signInAfter\)\}/u, "the page builds the action on the server");
  const catchAt = page.indexOf("} catch (error) {");
  const savedAt = page.indexOf("if (saved)");
  assert.ok(
    catchAt > 0 && savedAt > catchAt,
    "🔴 the saved screen is shown only when the link no longer previews (spent) — never ahead of the preview",
  );

  // ── The route ───────────────────────────────────────────────────────────────────────────
  const route = stripComments(readFileSync("app/api/auth/password-setup/[token]/route.ts", "utf8"));
  assert.match(route, /isNativeFormSubmission\(request\.headers\.get\("content-type"\)\)/u, "the route tells a form post from the script's JSON");
  assert.match(route, /request\.formData\(\)/u, "a native post is read as a form");
  assert.match(route, /form\?\.get\("password"\)/u, "the route reads the field the form names");
  assert.match(route, /form\?\.get\("confirmPassword"\)/u, "the route reads the confirm field the form names");
  assert.match(route, /passwordSetupReturnPath\(token, \{ saved: true \}\)/u, "a save answers with the saved screen");
  assert.equal(route.match(/NextResponse\.redirect\([\s\S]*?\b303,?\s*\)/gu)?.length ?? 0, 2,"🔴 both native answers are 303s, so the browser follows with a GET");
  assert.match(route, /auth:password_setup/u, "the same rate-limit bucket guards both callers");
}
