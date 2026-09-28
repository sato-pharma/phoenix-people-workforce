import { Ionicons } from "@expo/vector-icons";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, Text, View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewNavigation } from "react-native-webview";

import { ErrorNotice, LoadingScreen } from "@/components/ui";
import { apiBaseUrl } from "@/lib/config";
import { ModuleOpenError, mintPortalModuleUrl } from "@/lib/portal/open-module";
import { useSession } from "@/lib/session";
import { hairline, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

/**
 * A portal module, rendered INSIDE the app.
 *
 * This is the production page itself — same layout, same figures, same permissions — carried by a
 * one-trip hand-off that leaves the tab signed in (`src/lib/auth/native-web-handoff.ts`). It replaced
 * a system browser tab on 2026-09-28: the Custom Tab worked, but it put Chrome's address bar above
 * every module, which is the one place the app still read as "not the app".
 *
 * 🔴 WHY A WEBVIEW IS SAFE HERE NOW, AND WAS NOT BEFORE. On Android the WebView's cookie jar is the
 * SAME `CookieManager` React Native's own networking reads, so the session cookie this hand-off sets
 * would have ridden every request the app makes — which the CSRF guard refuses, breaking every
 * mutation with `csrf_blocked` (measured against production 2026-09-23). `lib/api.ts` now sets
 * `credentials: "omit"` on every call, which switches those requests to `CookieJar.NO_COOKIES` in
 * React Native's own `NetworkingModule`, so nothing the WebView stores can reach them. That one line
 * is what this screen rests on; if it goes, this screen must go back to a browser tab.
 *
 * NAVIGATION IS PENNED IN. A portal page links to other Phoenix pages, and a doctor's or a
 * distributor's page may link outward. Anything that is not this server's own `/employee-portals`
 * space is refused rather than followed: the app is signed in here, and following a foreign link
 * inside a signed-in view is how a session leaks. Android's back gesture walks the page history
 * first and leaves the screen only at the start of it, which is what a rep expects.
 */
export default function PortalModuleScreen() {
  const palette = usePalette();
  const dark = useColorScheme() === "dark";
  const insets = useSafeAreaInsets();
  const { token } = useSession();
  const { href, label } = useLocalSearchParams<{ href: string; label?: string }>();

  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const webRef = useRef<WebView>(null);
  const canGoBack = useRef(false);

  // The hand-off URL is minted once, for this screen. It is good for sixty seconds and sets the
  // cookie on its first load, so it is never re-used on a reload — the tab is already signed in.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const minted = await mintPortalModuleUrl({ href: String(href ?? ""), token });
        if (!cancelled) setUri(minted);
      } catch (failure) {
        if (!cancelled) {
          setError(
            failure instanceof ModuleOpenError ? failure.message : "Could not open that module.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [href, token]);

  // Back walks the page's own history before it leaves the module, the way a browser would.
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
    <View style={{ backgroundColor: palette.paper, flex: 1, paddingTop: insets.top }}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* The app's own bar, not Chrome's: the module's name and one way back. Square, hairline,
          the portal's own structure — the whole point of leaving the Custom Tab behind. */}
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

      {error ? (
        <View style={{ padding: space.lg }}>
          <ErrorNotice message={error} />
        </View>
      ) : !uri ? (
        <LoadingScreen label="Opening…" />
      ) : (
        <WebView
          // The tab is signed in by the hand-off, so nothing here carries a token of its own.
          allowsBackForwardNavigationGestures
          forceDarkOn={dark}
          onShouldStartLoadWithRequest={onNavigation}
          onNavigationStateChange={(event) => {
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
