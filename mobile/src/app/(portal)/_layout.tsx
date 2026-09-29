import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";

import { PushProvider } from "@/lib/push";
import { useSession } from "@/lib/session";
import { hairline } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

/**
 * The portal's bottom tab bar — the native counterpart of `EmployeePortalBottomNav` in the web app.
 *
 * Four tabs, and that is a ceiling rather than a starting point: the web portal's bottom nav is
 * capped and customisable for the same reason, because a rep uses two or three destinations all day
 * and a crowded bar makes all of them harder to hit.
 *
 * WHAT EACH ONE IS FOR, because the division is the whole design:
 *
 *   Home    — the portal itself, rendered in-app (owner, 2026-09-29: "make the app a shell over the
 *             web portal"). It IS the production landing page — same identity card, same modules —
 *             so the app cannot drift from the SaaS. It was a hand-drawn native command centre until
 *             then; index.tsx records what that traded (an offline READ of the rep's numbers; the
 *             offline WORK stays, in CRM).
 *   CRM     — Phoenix CRM, native, because it is camera, GPS, dictation and an offline outbox. A rep
 *             lives in it all day; the web gave it its own portal row for the same reason. This is
 *             the one part that must stay native — a web page cannot queue a visit with no signal.
 *   Modules — EVERY other portal module this employee has, the same list the web sidebar draws, each
 *             opening the production page itself so that the app and the browser cannot become two
 *             products (owner, 2026-09-28: "same module same design same everything").
 *   Profile — who is signed in, which server this build talks to, and the way out.
 *
 * A viewer with no CRM territory still sees the CRM tab and opens a plain "not open for you yet"
 * panel — the server, not this bar, decides access.
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
          name="modules"
          options={{
            tabBarIcon: ({ color, size }) => <Ionicons color={color as string} name="grid-outline" size={size} />,
            title: "Modules",
          }}
        />
        {/* A module opens full-screen, pushed from the Modules list or a tapped notification — never
            a tab of its own. `href: null` keeps it out of the bar; without it expo-router gives the
            route a fifth, iconless tab, which is how a stray route announces itself. */}
        <Tabs.Screen name="module" options={{ href: null }} />
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
