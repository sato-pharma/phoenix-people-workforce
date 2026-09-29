import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The cookie→bearer bridge, `/api/auth/native-token`, is the security crux of the web-login shell:
 * a rep signs in on the real /login inside the app's WebView (cookie), and this hands the SAME token
 * back as a bearer for the native half. Its whole safety is three guards and the promise that it
 * mints nothing — this pins all four to the source, so none can be quietly dropped.
 */
export async function runNativeTokenBridgeTests() {
  const route = readFileSync("app/api/auth/native-token/route.ts", "utf8");

  // 1. Same-origin CSRF — a cross-site page cannot trigger it.
  assert.match(
    route,
    /assertSameOriginMutation\(request\)/,
    "the bridge must be same-origin CSRF guarded",
  );
  assert.match(route, /if \(csrf\) return csrf/, "and must RETURN the guard's response, not drop it");

  // 2. The shell user-agent marker — a normal browser, or another app's WebView, is refused.
  assert.match(
    route,
    /phoenixNativeClientUserAgentMarker/,
    "the bridge must require the native shell's user-agent marker",
  );

  // 3. A live cookie session only — never a guest or a dev-header context — AND the same permission
  //    gate the portal shell asserts, so a role that cannot open the portal is not handed a bearer.
  assert.match(
    route,
    /access\.source !== "session"/,
    "the bridge must require a real cookie session (source === 'session')",
  );
  assert.match(
    route,
    /assertPermission\(access, "employee_profile", "read"\)/,
    "the bridge must assert the portal read permission, not merely check the session source",
  );

  // 4. It MINTS NOTHING: it returns the cookie's own token, re-verified — never createSessionToken.
  assert.match(
    route,
    /cookies\(\)\)\.get\(phoenixSessionCookieName\)/,
    "the bearer it returns must be the cookie's own value",
  );
  assert.doesNotMatch(
    route,
    /createSessionToken/,
    "the bridge must never mint a new token — that could hand back a different or longer-lived one",
  );

  // The marker is a real exported constant, shared by the gate and the app's WebViews.
  const nativeSession = readFileSync("src/lib/auth/native-session.ts", "utf8");
  assert.match(
    nativeSession,
    /export const phoenixNativeClientUserAgentMarker = "PhoenixApp"/,
    "the marker is a shared constant, so the server gate and the WebViews cannot drift",
  );

  // The mobile login screen is the real web /login in a WebView, not a native form, and carries the
  // marker so the bridge accepts its fetch and the portal renders in app mode.
  const login = readFileSync("mobile/src/app/login.tsx", "utf8");
  assert.match(login, /react-native-webview/, "the mobile login is the web /login in a WebView");
  assert.match(login, /\/login\?next=/, "it loads the production /login page");
  assert.match(
    login,
    /applicationNameForUserAgent=/,
    "and sets the shell user-agent marker the bridge requires",
  );
  assert.match(
    login,
    /native-token/,
    "and bridges the resulting cookie session to a bearer for the native half",
  );
}
