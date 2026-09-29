import { router } from "expo-router";
import { useRef, useState } from "react";
import { View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewNavigation } from "react-native-webview";

import { ErrorNotice, LoadingScreen } from "@/components/ui";
import { apiBaseUrl } from "@/lib/config";
import { useSession } from "@/lib/session";
import { space } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

/**
 * Sign in on the REAL web /login page, inside the app.
 *
 * Owner, 2026-09-29: the login must be exactly the web app. So this is the production `/login` page
 * itself — same design, same biometrics, same everything — rendered in a WebView, not a native copy.
 * The web login sets the `phoenix_session` COOKIE in the WebView's jar; the native half of the app
 * (Phoenix CRM, its offline outbox, push) needs the SAME token as a BEARER. `injectedJavaScript`
 * bridges that gap: once login has redirected into `/employee-portals`, it asks
 * `/api/auth/native-token` for the bearer (the cookie rides that same-origin fetch automatically)
 * and posts it back here; `adoptWebSession` stores it exactly as a native sign-in would, and
 * RouteGuard then moves the app into the portal.
 *
 * 🔴 `applicationNameForUserAgent` CARRIES THE SHELL MARKER, and the whole flow rests on it. The
 * native-token bridge refuses any caller whose user-agent lacks it, and the portal reads it to drop
 * its own header/bottom-nav (app mode). A header on the initial load would not do — it would not
 * reach the page's own fetch to the bridge — but the user-agent is the WebView's own, on every
 * request.
 *
 * NAVIGATION IS PENNED to this server's login and portal space. A login page can carry links out
 * (a "forgot password" help page, say); following one inside a view about to hold a session is how
 * a credential leaks, so anything off this origin's `/login`, `/api/auth/*` or `/employee-portals`
 * is refused.
 */
const NATIVE_SHELL_USER_AGENT_MARKER = "PhoenixApp"; // must match phoenixNativeClientUserAgentMarker on the server

const BRIDGE = `
(function () {
  try {
    if (!location.pathname.indexOf) return true;
    if (location.pathname.indexOf('/employee-portals') !== 0) return true;
    if (window.__phoenixBridgeDone) return true;
    window.__phoenixBridgeDone = true;
    fetch('/api/auth/native-token', { method: 'POST', credentials: 'include', headers: { 'x-requested-with': 'PhoenixApp' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) window.ReactNativeWebView.postMessage(JSON.stringify(data)); })
      .catch(function () {});
  } catch (e) {}
  return true;
})();
`;

export default function LoginScreen() {
  const palette = usePalette();
  const dark = useColorScheme() === "dark";
  const insets = useSafeAreaInsets();
  const { adoptWebSession } = useSession();

  const [error, setError] = useState<string | null>(null);
  const adopted = useRef(false);

  const uri = `${apiBaseUrl}/login?next=${encodeURIComponent("/employee-portals")}`;

  /** Only this server's own login and portal space, and only http(s). Everything else is refused. */
  const allowed = (url: string): boolean => {
    if (!url.startsWith(`${apiBaseUrl}/`)) return false;
    const path = url.slice(apiBaseUrl.length);
    return (
      path === "/" ||
      path.startsWith("/login") ||
      path.startsWith("/api/auth/") ||
      path.startsWith("/employee-portals")
    );
  };

  const onNavigation = (event: WebViewNavigation): boolean => allowed(event.url);

  return (
    <View style={{ backgroundColor: palette.paper, flex: 1, paddingTop: insets.top }}>
      {error ? (
        <View style={{ padding: space.lg }}>
          <ErrorNotice message={error} />
        </View>
      ) : (
        <WebView<object>
          applicationNameForUserAgent={NATIVE_SHELL_USER_AGENT_MARKER}
          forceDarkOn={dark}
          injectedJavaScript={BRIDGE}
          onMessage={(event) => {
            if (adopted.current) return;
            try {
              const payload = JSON.parse(event.nativeEvent.data);
              if (payload?.sessionToken) {
                adopted.current = true;
                adoptWebSession(payload);
                // RouteGuard moves the app when the session flips; this is belt-and-braces for a
                // build where the guard is not mounted above this screen.
                router.replace("/");
              }
            } catch {
              setError("The sign-in did not complete. Please try again.");
            }
          }}
          onShouldStartLoadWithRequest={onNavigation}
          originWhitelist={[`${apiBaseUrl}/*`]}
          renderLoading={() => <LoadingScreen label="Loading sign in…" />}
          setSupportMultipleWindows={false}
          source={{ uri }}
          startInLoadingState
          style={{ backgroundColor: palette.paper, flex: 1 }}
        />
      )}
    </View>
  );
}
