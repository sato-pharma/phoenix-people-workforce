import { Pressable, ScrollView, Text, View } from "react-native";

import { brickTintColorMap } from "@/components/crm/brick-tints";
import { CrmEmpty, CrmPill, CrmSection } from "@/components/crm/crm-kit";
import { ErrorNotice, LoadingScreen, StatTile } from "@/components/ui";
import { clusterByBrick, NO_BRICK_KEY } from "@/lib/crm/brick-groups";
import { useCrm } from "@/lib/crm/client";
import { dayLabelLong } from "@/lib/crm/format";
import { hairline, radius, space, type as type_ } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

import type { CrmTodayView } from "@/lib/crm/types";

/**
 * Phoenix CRM — Today, on the phone. The web twin is src/components/phoenix-crm/today-tab.tsx.
 *
 * GOLDEN RULE #1, the EASY half (owner, 2026-09-26): "very easy very simple". This is the screen the
 * app opens on: his stops in the order he will drive them, grouped by brick in the same eight hues as
 * the browser, each one either done with the time on it or one press from being entered.
 *
 * Everything here is HIS OWN WORK. No distance, no accuracy, no flag, and no count of one — the same
 * line the web screen holds, and `tests/phoenix-crm-today.test.ts` holds both to it.
 */
export function TodayScreen({
  onAddVisit,
  seatId,
  test,
}: {
  onAddVisit: (customerId: string, customerName: string) => void;
  seatId: string;
  test: boolean;
}) {
  const palette = usePalette();
  const resource = useCrm<CrmTodayView>(`/api/phoenix-crm/today?seatId=${encodeURIComponent(seatId)}&test=${test ? "1" : "0"}`, "today");
  const view = resource.data;

  if (!view) {
    return (
      <View style={{ backgroundColor: palette.paper, flex: 1, gap: space.lg, padding: space.lg }}>
        {resource.error ? <ErrorNotice message={resource.error} /> : <LoadingScreen label="Opening your day" />}
      </View>
    );
  }

  const groups = clusterByBrick(view.stops, (stop) => stop.brick, "first-appearance");
  const tints = brickTintColorMap(groups.filter((group) => group.key !== NO_BRICK_KEY).map((group) => group.key));
  const left = view.stops.filter((stop) => !stop.done).length;

  return (
    <ScrollView contentContainerStyle={{ gap: space.lg, padding: space.lg }} style={{ backgroundColor: palette.paper, flex: 1 }}>
      <View style={{ gap: 2 }}>
        <Text style={[type_.title, { color: palette.ink }]}>Today</Text>
        <Text style={[type_.meta, { color: palette.inkSoft }]}>{`${view.territory.name} · ${dayLabelLong(view.date)}`}</Text>
      </View>

      {/* AM and PM apart, never summed — the call-rate golden rule. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <StatTile label={`AM done of ${view.target.am}`} value={String(view.counts.doneAm)} />
        <StatTile label={`PM done of ${view.target.pm}`} value={String(view.counts.donePm)} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <StatTile label="Planned today" value={String(view.stops.length)} />
        <StatTile label="Left to do" tone={left > 0 ? "accent" : "default"} value={String(left)} />
      </View>

      {view.stops.length === 0 ? (
        <CrmEmpty message={view.emptyReason} title="Nothing planned for today" />
      ) : (
        groups.map((group) => (
          <CrmSection key={group.key} title={groups.length > 1 ? group.label : "Your day"}>
            <View style={{ gap: space.sm }}>
              {group.rows.map((stop) => (
                <View
                  key={stop.customerId}
                  style={{
                    backgroundColor: palette.surface,
                    borderColor: palette.line,
                    borderLeftColor: tints.get(group.key)?.bar ?? palette.line,
                    borderLeftWidth: 3,
                    borderRadius: radius,
                    borderWidth: hairline,
                    gap: 4,
                    padding: space.md,
                  }}
                >
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, justifyContent: "space-between" }}>
                    <Text style={[type_.bodyStrong, { color: palette.ink, flex: 1, minWidth: 0 }]}>{stop.name}</Text>
                    {stop.done ? <CrmPill tone="good">{`Done ${stop.doneAt ?? ""}`}</CrmPill> : <CrmPill tone="neutral">{stop.listType}</CrmPill>}
                  </View>
                  <Text style={[type_.meta, { color: palette.inkSoft }]}>
                    {`${stop.placeLabel ?? "No place saved yet"} · ${stop.todayWindows}`}
                  </Text>
                  {stop.done || !view.canAdd ? null : (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => onAddVisit(stop.customerId, stop.name)}
                      style={{
                        alignSelf: "flex-start",
                        backgroundColor: palette.accent,
                        borderRadius: radius,
                        marginTop: space.xs,
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                      }}
                    >
                      <Text style={[type_.bodyStrong, { color: "#ffffff" }]}>Add visit</Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </View>
          </CrmSection>
        ))
      )}

      {view.alsoVisited.length > 0 ? (
        // Beside the day, never inside it: dropping an off-plan visit into the middle of his route
        // would change the shape of the list he is reading as he works down it.
        <CrmSection title="Also visited today">
          <View style={{ gap: space.xs }}>
            {view.alsoVisited.map((extra) => (
              <View key={extra.customerId} style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, justifyContent: "space-between" }}>
                <Text style={[type_.body, { color: palette.ink, flex: 1, minWidth: 0 }]}>{extra.name}</Text>
                <Text style={[type_.meta, { color: palette.inkSoft }]}>{`${extra.listType} · ${extra.doneAt}`}</Text>
              </View>
            ))}
          </View>
        </CrmSection>
      ) : null}
    </ScrollView>
  );
}
