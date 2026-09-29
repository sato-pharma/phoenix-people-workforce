import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PortalWebView } from "@/components/portal-web-view";
import { usePalette } from "@/theme/use-palette";

/**
 * A single portal module, opened full-screen — pushed from the Modules list or a tapped
 * notification. It is the production page itself; the shared engine, and every reason a WebView is
 * safe here, live in `@/components/portal-web-view`. This screen adds only what a pushed screen needs
 * over the Home tab: the safe-area top inset, and the app's own bar with a back control (`showBar`),
 * because unlike a tab it was navigated INTO and needs a way out.
 */
export default function PortalModuleScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { href, label } = useLocalSearchParams<{ href: string; label?: string }>();

  return (
    <View style={{ backgroundColor: palette.paper, flex: 1, paddingTop: insets.top }}>
      <Stack.Screen options={{ headerShown: false }} />
      <PortalWebView href={String(href ?? "")} label={label} showBar />
    </View>
  );
}
