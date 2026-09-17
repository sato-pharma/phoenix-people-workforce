import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { LoadingScreen } from "@/components/ui";
import { SessionProvider, useSession } from "@/lib/session";
import { palettes } from "@/theme/tokens";

/**
 * The routing guard.
 *
 * Kept as a component inside the provider rather than as a check in each screen, so there is exactly
 * one rule about who may see what: signed out means the login screen, signed in means the portal,
 * and nothing renders at all until the stored session has been read off the keystore.
 *
 * That last part matters more than it looks. Redirecting while the session is still loading sends a
 * returning employee to the login screen for a frame before bouncing them back — which reads as the
 * app having forgotten them, and on a slow phone is long enough to start typing into.
 */
function RouteGuard({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (state.status === "loading") return;

    const inPortal = segments[0] === "(portal)";

    if (state.status === "signed-out" && inPortal) {
      router.replace("/login");
    } else if (state.status === "signed-in" && !inPortal) {
      router.replace("/(portal)");
    }
  }, [router, segments, state.status]);

  if (state.status === "loading") {
    return <LoadingScreen label="Signing you in…" />;
  }

  return <>{children}</>;
}

export default function RootLayout() {
  const scheme = useColorScheme();
  const palette = scheme === "dark" ? palettes.dark : palettes.light;

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <RouteGuard>
          <StatusBar style={scheme === "dark" ? "light" : "dark"} />
          <Stack
            screenOptions={{
              contentStyle: { backgroundColor: palette.paper },
              // No native header anywhere: every screen draws its own, the way the portal does, so
              // the app and the web app have the same page furniture rather than two conventions.
              headerShown: false,
            }}
          >
            <Stack.Screen name="login" />
            <Stack.Screen name="(portal)" />
          </Stack>
        </RouteGuard>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
