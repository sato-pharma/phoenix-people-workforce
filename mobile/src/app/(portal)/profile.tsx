import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Card, MicroLabel, SecondaryButton } from "@/components/ui";
import { apiBaseUrl, isProductionTarget } from "@/lib/config";
import { useSession } from "@/lib/session";
import { hairline, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";
import { usePhoenixQuery } from "@/lib/use-phoenix-query";
import type { PortalHome } from "@/types/portal";

function Row({ label, value }: { label: string; value: string }) {
  const palette = usePalette();
  return (
    <View
      style={{
        borderTopColor: palette.line,
        borderTopWidth: hairline,
        flexDirection: "row",
        gap: space.md,
        paddingVertical: space.md,
      }}
    >
      <Text style={[type.meta, { color: palette.inkSoft, flexBasis: 0, flexGrow: 1, minWidth: 0 }]}>
        {label}
      </Text>
      {/* flexShrink with a right alignment rather than a fixed width: a long line or area name
          wraps onto a second line here. It never truncates — no ellipsis anywhere in this system —
          and it never widens the screen. */}
      <Text
        style={[
          type.body,
          { color: palette.ink, flexBasis: 0, flexGrow: 2, minWidth: 0, textAlign: "right" },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

export default function ProfileScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { signOut, user } = useSession();
  const { data } = usePhoenixQuery<PortalHome>("/api/employee-portals/home");

  const employee = data?.shell?.employee ?? null;

  return (
    <ScrollView
      contentContainerStyle={{
        gap: space.lg,
        paddingBottom: insets.bottom + space.xl,
        paddingHorizontal: space.lg,
        paddingTop: insets.top + space.lg,
      }}
      style={{ backgroundColor: palette.paper }}
    >
      <Text style={[type.display, { color: palette.ink }]}>Profile</Text>

      <Card style={{ paddingTop: 0 }}>
        <Row label="Name" value={employee?.fullName ?? "—"} />
        <Row label="HR ID" value={employee?.hrId ?? user?.hrId ?? user?.loginId ?? "—"} />
        <Row label="Job title" value={employee?.roleLabel ?? user?.role ?? "—"} />
        <Row label="Line" value={employee?.line ?? "—"} />
        <Row label="Area" value={employee?.area ?? "—"} />
        <Row label="Reports to" value={employee?.manager ?? "—"} />
      </Card>

      {!isProductionTarget ? (
        <Card>
          <MicroLabel>Connected to</MicroLabel>
          <Text style={[type.body, { color: palette.ink2, marginTop: space.sm }]}>{apiBaseUrl}</Text>
        </Card>
      ) : null}

      <SecondaryButton label="Sign out" onPress={() => void signOut()} />
    </ScrollView>
  );
}
