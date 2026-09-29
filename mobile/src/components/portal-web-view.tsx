import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, Text, View, useColorScheme } from "react-native";
import { WebView, type WebViewNavigation } from "react-native-webview";

import { ErrorNotice, LoadingScreen } from "@/components/ui";
import { apiBaseUrl } from "@/lib/config";
import { ModuleOpenError, mintPortalModuleUrl } from "@/lib/portal/open-module";
import { useSession } from "@/lib/session";
import { hairline, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

/**
 * The Phoenix portal, rendered INSIDE the app — the shared engine behind both the Home tab and a
 * single opened module.
 *
 * This is the production page itself: same layout, same figures, same permissions, carried by a
 * one-trip hand-off that leaves the tab signed in (`src/lib/auth/native-web-handoff.ts`). That
 * hand-off also marks the browser context as the app shell (a cookie the GET half sets), so the
 * portal drops its own fixed header and bottom nav and lets the NATIVE frame — the tab bar, and the
 * optional bar below — do the navigating. Without that, the app would stack two nav bars.
 *
 * 🔴 WHY A WEBVIEW IS SAFE HERE. On Android the WebView's cookie jar is the SAME `CookieManager`
 * React Native's own networking reads, so the session cookie this hand-off sets would ride every
 * request the app makes — which the CSRF guard refuses, breaking every mutation with `csrf_blocked`
 * (measured against production 2026-09-23). `lib/api.ts` sets `credentials: "omit"` on every call,
 * which React Native's own `NetworkingModule` turns into `CookieJar.NO_COOKIES`, so nothing the
 * WebView stores reaches those requests. That one line is what this rests on; if it goes, this must
 * go back to a browser tab. `tests/native-web-handoff.test.ts` fails if it disappears.
 *
 * NAVIGATION IS PENNED IN. A portal page links to other Phoenix pages, and a doctor's or
 * distributor's page may link outward. Anything that is not this server's own `/employee-portals`
 * space (or the hand-off endpoint) is refused rather than followed: the app is signed in here, and
 * following a foreign link inside a signed-in view is how a session leaks. Android's back gesture
 * walks the page history first and leaves the screen only at the start of it.
 */
export function PortalWebView({
  href,
  label,
  showBar = false,
}: {
  /** A portal path — `/employee-portals` for the Home tab, a specific module for a single screen. */
  href: string;
  /** The bar's title when `showBar` is true. */
  label?: string;
  /** The app's own square top bar with a back control. Off for a root tab that fills the screen. */
  showBar?: boolean;
}) {
  const palette = usePalette();
  const dark = useColorScheme() === "dark";
  const { token } = useSession();

  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 🔴 `WebView<object>`, not a bare `WebView`. The package's own root declaration is
  // `class WebView<P = undefined> extends Component<WebViewProps & P>`, and `WebViewProps & undefined`
  // reduces to `never` — so the default instantiation types EVERY prop as never and tsc reports
  // "No overload matches this call" for correct code. `object` is the identity for that intersection,
  // so this is the package's own escape hatch rather than a cast.
  const webRef = useRef<WebView<object>>(null);
  const canGoBack = useRef(false);

  // The hand-off URL is minted once. It is good for sixty seconds and sets the cookies on its first
  // load, so it is never re-used on a reload — the tab is already signed in after that.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const minted = await mintPortalModuleUrl({ href, token });
        if (!cancelled) setUri(minted);
      } catch (failure) {
        if (!cancelled) {
          setError(failure instanceof ModuleOpenError ? failure.message : "Could not open Phoenix.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [href, token]);

  // Back walks the page's own history before it leaves the screen, the way a browser would. A root
  // tab (no bar) returns false so the OS handles Back as it would for any tab.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBack.current && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, []);

  /** Only this server's own portal space, and only http(s). Everything else is refused. */
  const allowed = (url: string): boolean => {
    if (!url.startsWith(`${apiBaseUrl}/`)) return false;
    const path = url.slice(apiBaseUrl.length);
    return path.startsWith("/employee-portals") || path.startsWith("/api/auth/web-session");
  };

  const onNavigation = (event: WebViewNavigation): boolean => {
    canGoBack.current = event.canGoBack;
    return allowed(event.url);
  };

  return (
    <View style={{ backgroundColor: palette.paper, flex: 1 }}>
      {showBar ? (
        // The app's own bar, not Chrome's: the module's name and one way back. Square, hairline,
        // the portal's own structure.
        <View
          style={{
            alignItems: "center",
            backgroundColor: palette.surface,
            borderBottomColor: palette.line,
            borderBottomWidth: hairline,
            flexDirection: "row",
            gap: space.md,
            minHeight: 52,
            paddingHorizontal: space.md,
          }}
        >
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => {
              if (canGoBack.current && webRef.current) webRef.current.goBack();
              else router.back();
            }}
          >
            <Ionicons color={palette.ink} name="chevron-back" size={24} />
          </Pressable>
          {/* Wraps rather than truncates — no module name is ever cut with an ellipsis. */}
          <Text style={[type.bodyStrong, { color: palette.ink, flexShrink: 1, minWidth: 0 }]}>
            {label ?? "Phoenix"}
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={{ padding: space.lg }}>
          <ErrorNotice message={error} />
        </View>
      ) : !uri ? (
        <LoadingScreen label="Opening…" />
      ) : (
        <WebView<object>
          // The tab is signed in by the hand-off, so nothing here carries a token of its own.
          // The shell marker in the user-agent is how the portal knows to render in app mode (drop
          // its own header + bottom nav); it must match phoenixNativeClientUserAgentMarker server-side.
          applicationNameForUserAgent="PhoenixApp"
          allowsBackForwardNavigationGestures
          forceDarkOn={dark}
          onShouldStartLoadWithRequest={onNavigation}
          onNavigationStateChange={(event: WebViewNavigation) => {
            canGoBack.current = event.canGoBack;
          }}
          originWhitelist={[`${apiBaseUrl}/*`]}
          ref={webRef}
          renderLoading={() => <LoadingScreen label="Opening…" />}
          setSupportMultipleWindows={false}
          source={{ uri }}
          startInLoadingState
          style={{ backgroundColor: palette.paper, flex: 1 }}
        />
      )}
    </View>
  );
}
