import { SIGN_IN_AFTER_SETUP_PARAM, SIGN_IN_AFTER_SETUP_VALUE } from "./temporary-password.ts";

/**
 * THE CHOOSE-YOUR-PASSWORD SCREEN SAVES WITHOUT JAVASCRIPT (owner, 12 Nov 2026: "he changes the password
 * and keeps being redirected to choose a new password").
 *
 * Measured on production that day: Next.js's own client runtime, shipped on every page, contains a class
 * static block (`static{this.contextType=…}`), which Safari before 16.4 cannot parse. On an iPhone held at
 * iOS 15 (Ghoneim Mohamed, PD-0035, iOS 15.8) every page therefore renders but never hydrates. The sign-in
 * form already posted natively (app/api/auth/login, responseMode "redirect"), so the temporary password
 * worked and sent him to /password-setup — whose form had only a script submit handler and no action. A
 * press reloaded the same screen with nothing saved, four times, and then he tried the password he thought
 * he had chosen and was refused.
 *
 * So the form now carries a real `method="post"` action and named fields, and the route answers a native
 * form post with a 303 back to the screen: `?saved=1` once the password is saved, `?error=<code>` when it is
 * refused. Only a fixed code travels in the address, never the server's own words, so a crafted link cannot
 * make the screen say anything Phoenix did not write.
 */

export const PASSWORD_SETUP_SAVED_PARAM = "saved";
export const PASSWORD_SETUP_SAVED_VALUE = "1";
export const PASSWORD_SETUP_ERROR_PARAM = "error";

const NO_SCRIPT_ERROR_MESSAGES = {
  missing_password: "Password is required.",
  password_mismatch: "Passwords do not match.",
  password_setup_failed: "Password setup failed. Try again, or ask your admin for a new link.",
  rate_limited: "Too many password setup attempts. Please try again later.",
  too_short: "Password must be at least 8 characters.",
} as const;

export type PasswordSetupNoScriptErrorCode = keyof typeof NO_SCRIPT_ERROR_MESSAGES;

/** The message for a code carried back in the address, or null for anything Phoenix did not send. */
export function passwordSetupNoScriptErrorMessage(code: string | null | undefined): string | null {
  if (!code || !Object.prototype.hasOwnProperty.call(NO_SCRIPT_ERROR_MESSAGES, code)) return null;
  return NO_SCRIPT_ERROR_MESSAGES[code as PasswordSetupNoScriptErrorCode];
}

/** True for a browser's own form post — the path taken when the page's scripts never ran. */
export function isNativeFormSubmission(contentType: string | null | undefined): boolean {
  const value = String(contentType ?? "").toLowerCase();
  return value.includes("application/x-www-form-urlencoded") || value.includes("multipart/form-data");
}

/** Where the form posts: the setup route, carrying the sign-in-after flag so a refusal returns to the same screen. */
export function passwordSetupFormAction(token: string, signInAfter: boolean): string {
  const base = `/api/auth/password-setup/${encodeURIComponent(token)}`;
  return signInAfter ? `${base}?${SIGN_IN_AFTER_SETUP_PARAM}=${SIGN_IN_AFTER_SETUP_VALUE}` : base;
}

/** The screen a native form post is sent back to. */
export function passwordSetupReturnPath(
  token: string,
  outcome: { error: PasswordSetupNoScriptErrorCode; signInAfter: boolean } | { saved: true },
): string {
  const params = new URLSearchParams();
  if ("saved" in outcome) {
    params.set(PASSWORD_SETUP_SAVED_PARAM, PASSWORD_SETUP_SAVED_VALUE);
  } else {
    if (outcome.signInAfter) params.set(SIGN_IN_AFTER_SETUP_PARAM, SIGN_IN_AFTER_SETUP_VALUE);
    params.set(PASSWORD_SETUP_ERROR_PARAM, outcome.error);
  }
  return `/password-setup/${encodeURIComponent(token)}?${params.toString()}`;
}
