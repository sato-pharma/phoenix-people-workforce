import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Card, ErrorNotice, LoadingScreen, MicroLabel, StatTile } from "@/components/ui";
import { useSession } from "@/lib/session";
import { usePhoenixQuery } from "@/lib/use-phoenix-query";
import { space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";
import type { PortalHome } from "@/types/portal";

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}

function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return String(value);
}

export default function PortalHomeScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { data, error, loading, refresh, refreshing } = usePhoenixQuery<PortalHome>("/api/employee-portals/home");

  if (loading) {
    return <LoadingScreen label="Loading your command center…" />;
  }

  const employee = data?.shell?.employee ?? null;
  const kpis = data?.mrFieldKpis ?? null;

  // The employee's own name, falling back to the login id only if the directory lookup came back
  // empty. Names, never codes — an HR ID on screen is a last resort, not a default.
  const displayName = employee?.fullName ?? user?.loginId ?? "";
  const subtitle = [employee?.roleLabel, employee?.line, employee?.area].filter(Boolean).join(" · ");

  return (
    <ScrollView
      contentContainerStyle={{
        gap: space.lg,
        paddingBottom: space.xl,
        paddingHorizontal: space.lg,
        paddingTop: insets.top + space.lg,
      }}
      refreshControl={
        <RefreshControl onRefresh={refresh} refreshing={refreshing} tintColor={palette.accent} />
      }
      style={{ backgroundColor: palette.paper }}
    >
      <View style={{ gap: space.xs }}>
        <Text style={[type.display, { color: palette.ink }]}>{displayName}</Text>
        {subtitle.length > 0 ? (
          <Text style={[type.meta, { color: palette.inkSoft }]}>{subtitle}</Text>
        ) : null}
      </View>

      {error ? <ErrorNotice message={error} /> : null}

      {data ? (
        <>
          <View style={{ gap: space.md }}>
            <MicroLabel>Waiting on you</MicroLabel>
            {/* flexWrap, not a fixed row: three tiles must reflow rather than push the screen
                wider. Horizontal scroll is banned in this system at every width. */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
              <StatTile
                label="Vacation requests"
                tone={data.pendingVacationCount > 0 ? "accent" : "default"}
                value={data.pendingCountsAvailable ? count(data.pendingVacationCount) : "—"}
              />
              <StatTile
                label="Excuses"
                tone={data.pendingExcuseCount > 0 ? "accent" : "default"}
                value={data.pendingCountsAvailable ? count(data.pendingExcuseCount) : "—"}
              />
              <StatTile
                label="Plans to approve"
                tone={(data.plansAwaitingManagerApproval ?? 0) > 0 ? "accent" : "default"}
                value={data.plansCountAvailable ? count(data.plansAwaitingManagerApproval) : "—"}
              />
            </View>
          </View>

          {kpis ? (
            <View style={{ gap: space.md }}>
              <MicroLabel>{`Field performance · ${kpis.monthLabel}`}</MicroLabel>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
                <StatTile label="Coverage" value={percent(kpis.coveragePct)} />
                <StatTile label="Frequency" value={percent(kpis.frequencyPct)} />
              </View>

              {kpis.hasCallRate ? (
                <Card>
                  <MicroLabel>Call rate</MicroLabel>
                  {/* AM and PM are reported APART, never averaged and never joined with a slash:
                      AM is scored against 2 calls and PM against 10, so one combined number would
                      be meaningless. This is a locked reporting rule, not a layout preference. */}
                  <Text style={[type.title, { color: palette.ink, marginTop: space.sm }]}>
                    {`${kpis.amVerified} of ${kpis.amTarget} AM`}
                    <Text style={{ color: palette.inkFaint }}>{"  ·  "}</Text>
                    {`${kpis.pmVerified} of ${kpis.pmTarget} PM`}
                  </Text>
                  <Text style={[type.meta, { color: palette.inkSoft, marginTop: space.xs }]}>
                    {`Across ${kpis.workingDays} working days`}
                  </Text>
                </Card>
              ) : null}

              <Card>
                <MicroLabel>Doctors this month</MicroLabel>
                <Text style={[type.title, { color: palette.ink, marginTop: space.sm }]}>
                  {`${kpis.visitedDoctors} visited of ${kpis.plannedDoctors} planned`}
                </Text>
                {kpis.missedDoctors > 0 ? (
                  <Text style={[type.meta, { color: palette.inkSoft, marginTop: space.xs }]}>
                    {`${kpis.missedDoctors} still to see`}
                  </Text>
                ) : null}
              </Card>
            </View>
          ) : null}

          {data.mrSalesAchievement ? (
            <View style={{ gap: space.md }}>
              <MicroLabel>Sales</MicroLabel>
              <StatTile
                label="Achievement"
                tone="accent"
                value={percent(data.mrSalesAchievement.achievementPercent)}
              />
            </View>
          ) : null}

          {data.leaveEntitlementDays !== null ? (
            <Card>
              <MicroLabel>Annual leave balance</MicroLabel>
              <Text style={[type.title, { color: palette.ink, marginTop: space.sm }]}>
                {`${data.leaveEntitlementDays} days`}
              </Text>
            </Card>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
