import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";

import { hairline } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

/**
 * The portal's bottom tab bar — the native counterpart of `EmployeePortalBottomNav` in the web app.
 *
 * Four tabs only, and that is a ceiling rather than a starting point: the web portal's bottom nav
 * is capped and customisable for the same reason, because a rep uses two or three destinations all
 * day and a crowded bar makes all of them harder to hit. Everything else reaches the app through
 * the Home screen, not through another tab.
 */
export default function PortalTabsLayout() {
  const palette = usePalette();

  return (
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
          tabBarIcon: ({ color, size }) => <Ionicons color={color} name="home-outline" size={size} />,
          title: "Home",
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          tabBarIcon: ({ color, size }) => <Ionicons color={color} name="person-outline" size={size} />,
          title: "Profile",
        }}
      />
    </Tabs>
  );
}
