import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";

import { PushProvider } from "@/lib/push";
import { useSession } from "@/lib/session";
import { hairline } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

/**
 * The portal's bottom tab bar — the native counterpart of `EmployeePortalBottomNav` in the web app.
 *
 * Four tabs only, and that is a ceiling rather than a starting point: the web portal's bottom nav
 * is capped and customisable for the same reason, because a rep uses two or three destinations all
 * day and a crowded bar makes all of them harder to hit. Phoenix CRM earns a tab because a rep lives
 * in it all day (the web gave it its own portal row for the same reason); everything else reaches the
 * app through the Home screen, not through another tab. A viewer with no CRM territory still sees the
 * tab and opens a plain "not open for you yet" panel — the server, not this bar, decides access.
 *
 * Push starts here rather than at the root because it belongs to a signed-in session: this layout
 * exists only while someone is signed in, and a tapped notification needs the tabs mounted to open
 * a screen in them.
 */
export default function PortalTabsLayout() {
  const palette = usePalette();
  const { token } = useSession();

  return (
    <PushProvider token={token}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: palette.accent,
          tabBarInactiveTintColor: palette.inkSoft,
          tabBarStyle: {
            backgroundColor: palette.surface,
            borderTopColor: palette.line,
            borderTopWidth: hairline,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            tabBarIcon: ({ color, size }) => <Ionicons color={color as string} name="home-outline" size={size} />,
            title: "Home",
          }}
        />
        <Tabs.Screen
          name="crm"
          options={{
            tabBarIcon: ({ color, size }) => <Ionicons color={color as string} name="briefcase-outline" size={size} />,
            title: "CRM",
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            tabBarIcon: ({ color, size }) => <Ionicons color={color as string} name="person-outline" size={size} />,
            title: "Profile",
          }}
        />
      </Tabs>
    </PushProvider>
  );
}
