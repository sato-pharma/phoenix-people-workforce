import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ErrorNotice, LoadingScreen, MicroLabel, OfflineNotice } from "@/components/ui";
import { describeCachedAt } from "@/lib/offline-cache";
import { openPortalModule } from "@/lib/portal/open-module";
import { useSession } from "@/lib/session";
import { usePhoenixQuery } from "@/lib/use-phoenix-query";
import { hairline, radius, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";
import type { PortalHome, PortalModuleDirectory, PortalModule } from "@/types/portal";

/**
 * Every module this employee has in the portal — the app's counterpart of the web sidebar.
 *
 * WHAT THIS FIXED. Until this screen the app had Home, CRM and Profile against the portal's sixty-odd
 * modules, so the same person opening Phoenix on a tablet and in a browser saw two different products
 * (owner, 2026-09-28: "same module same design same everything"). The list is not written here — it
 * comes from `/api/employee-portals/navigation`, which reads the same registry and the same visibility
 * flags the sidebar reads, so a module cannot reach the browser and miss the phone.
 *
 * WHY EVERY ROW IS A FULL-WIDTH LINE AND NOT A TILE GRID. The labels are the portal's own descriptive
 * names — "Double-Visit Analytics", "Create Coaching Report" — and the golden rule forbids both a
 * horizontal scroll and shrinking or truncating type to fit. A two-column grid at 360dp gives each
 * name about 150dp, which those names do not fit in; one column gives them the width they need and
 * wraps what is still too long. The section captions are the same `MicroLabel` the portal uses.
 *
 * The search box is here because a Super Admin's list runs to sixty rows: scrolling is fine for a rep
 * with eight, and not fine for the one person who has all of them.
 */

/** Which pending count on the home snapshot answers which nav badge. */
const BADGE_COUNTS: Readonly<Record<string, (home: PortalHome) => number | null>> = {
  "vacation-approvals-pending": (home) =>
    home.pendingCountsAvailable ? home.pendingVacationCount : null,
  "excuse-approvals-pending": (home) => (home.pendingCountsAvailable ? home.pendingExcuseCount : null),
  "plan-approvals-pending": (home) =>
    home.plansCountAvailable ? home.plansAwaitingManagerApproval ?? null : null,
};

function matches(module: PortalModule, needle: string): boolean {
  return module.label.toLowerCase().includes(needle);
}

export default function PortalModulesScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { token } = useSession();

  const { cachedAt, data, error, loading, refresh, refreshing } =
    usePhoenixQuery<PortalModuleDirectory>("/api/employee-portals/navigation");
  // The same endpoint the Home tab reads, so this costs no extra round trip in practice — it is what
  // supplies the three pending counts the web bottom bar shows as a dot.
  const home = usePhoenixQuery<PortalHome>("/api/employee-portals/home");

  const [query, setQuery] = useState("");

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = data?.sections ?? [];
    if (needle.length === 0) return all;
    return all
      .map((section) => ({ ...section, modules: section.modules.filter((m) => matches(m, needle)) }))
      .filter((section) => section.modules.length > 0);
  }, [data, query]);

  const moduleCount = useMemo(
    () => (data?.sections ?? []).reduce((total, section) => total + section.modules.length, 0),
    [data],
  );

  // A plain navigation, not an await: the module screen mints its own hand-off, so the frame is on
  // screen before the network is asked anything. A tap that waits on a round trip before drawing is
  // what made the old browser-tab version feel like leaving the app.
  const open = (module: PortalModule) => {
    openPortalModule({ href: module.href, label: module.label });
  };

  if (loading) {
    return <LoadingScreen label="Loading your modules…" />;
  }

  return (
    <ScrollView
      contentContainerStyle={{
        gap: space.lg,
        paddingBottom: space.xl,
        paddingHorizontal: space.lg,
        paddingTop: insets.top + space.lg,
      }}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl onRefresh={refresh} refreshing={refreshing} tintColor={palette.accent} />
      }
      style={{ backgroundColor: palette.paper }}
    >
      <View style={{ gap: space.xs }}>
        <Text style={[type.display, { color: palette.ink }]}>Modules</Text>
        <Text style={[type.meta, { color: palette.inkSoft }]}>
          {moduleCount > 0
            ? `${moduleCount} modules, the same ones you have in the portal`
            : "The same modules you have in the portal"}
        </Text>
      </View>

      {cachedAt ? <OfflineNotice takenAt={describeCachedAt(cachedAt)} /> : null}
      {error ? <ErrorNotice message={error} /> : null}

      {moduleCount > 8 ? (
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Find a module"
          placeholderTextColor={palette.inkFaint}
          style={[
            type.body,
            {
              backgroundColor: palette.surface,
              borderColor: palette.line,
              borderRadius: radius,
              borderWidth: hairline,
              color: palette.ink,
              minHeight: 48,
              paddingHorizontal: space.md,
            },
          ]}
          value={query}
        />
      ) : null}

      {sections.map((section) => (
        <View key={section.title} style={{ gap: space.sm }}>
          <MicroLabel>{section.title}</MicroLabel>
          {/* One bordered block per section, rows divided by a hairline — the portal's own
              border-first structure, so a section reads as a group rather than as loose cards. */}
          <View
            style={{
              backgroundColor: palette.surface,
              borderColor: palette.line,
              borderRadius: radius,
              borderWidth: hairline,
              overflow: "hidden",
            }}
          >
            {section.modules.map((module, index) => {
              const count = module.badge ? BADGE_COUNTS[module.badge]?.(home.data ?? ({} as PortalHome)) ?? null : null;
              const waiting = typeof count === "number" && count > 0;

              return (
                <Pressable
                  accessibilityHint={
                    module.locked ? "Temporarily locked by an administrator" : "Opens the Phoenix module"
                  }
                  accessibilityRole="button"
                  key={module.href}
                  onPress={() => open(module)}
                  style={({ pressed }) => ({
                    alignItems: "center",
                    backgroundColor: pressed ? palette.surface2 : palette.surface,
                    borderTopColor: palette.line,
                    borderTopWidth: index === 0 ? 0 : hairline,
                    flexDirection: "row",
                    gap: space.md,
                    // 56 rather than the 48 minimum: this is the list a rep runs a thumb down.
                    minHeight: 56,
                    paddingHorizontal: space.md,
                    paddingVertical: space.sm,
                  })}
                >
                  <Ionicons
                    color={module.locked ? palette.inkFaint : palette.accent}
                    // `as never` only because Ionicons types its glyph names as a closed union and
                    // this name arrives from the server as a plain string. The name itself is pinned
                    // by tests/mobile-module-directory.test.ts, which is what keeps it real.
                    name={module.icon as never}
                    size={20}
                  />
                  {/* flexShrink with minWidth 0 so a long name WRAPS. Never an ellipsis, and never a
                      row wider than the screen — both are owner rules. */}
                  <Text
                    style={[
                      type.bodyStrong,
                      { color: module.locked ? palette.inkSoft : palette.ink, flexShrink: 1, minWidth: 0 },
                    ]}
                  >
                    {module.label}
                  </Text>
                  <View style={{ flexGrow: 1 }} />
                  {waiting ? (
                    <View
                      style={{
                        backgroundColor: palette.accentSoft,
                        borderColor: palette.accentLine,
                        borderRadius: radius,
                        borderWidth: hairline,
                        paddingHorizontal: space.sm,
                        paddingVertical: 2,
                      }}
                    >
                      <Text style={[type.meta, { color: palette.accent }]}>{String(count)}</Text>
                    </View>
                  ) : null}
                  <Ionicons
                    color={palette.inkFaint}
                    name={module.locked ? "lock-closed-outline" : "chevron-forward"}
                    size={18}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}

      {data && sections.length === 0 ? (
        <Text style={[type.meta, { color: palette.inkSoft }]}>
          {query.trim().length > 0
            ? `Nothing here matches “${query.trim()}”.`
            : "No modules are open for you yet."}
        </Text>
      ) : null}
    </ScrollView>
  );
}
