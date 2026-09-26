import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CrmChoice, CrmNote } from "@/components/crm/crm-kit";
import { ErrorNotice, LoadingScreen } from "@/components/ui";
import { useCrm } from "@/lib/crm/client";
import { ListScreen } from "@/features/crm/list-screen";
import { PlanScreen } from "@/features/crm/plan-screen";
import { TodayScreen } from "@/features/crm/today-screen";
import { VisitsScreen } from "@/features/crm/visits-screen";
import type { PendingValidate, PendingVisit } from "@/features/crm/handoff";
import { hairline, radius, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";
import type { CrmOverview, TerritorySummary } from "@/lib/crm/types";

/**
 * Phoenix CRM on the phone — the module's own tab.
 *
 * The native counterpart of the web `PhoenixCrmApp` (src/components/phoenix-crm/phoenix-crm-app.tsx),
 * cut to the rep's core for this first release: the Visits and List sub-tabs of one territory, the
 * territory picker for anyone who reads more than one, and the Super Admin's test mode. The Plan, Team,
 * Directory, Reports and Settings tabs, and the customer's own page, are later releases.
 *
 * The server decides who sees what (GET /api/phoenix-crm/overview) and checks every read and save
 * again; this screen only lays out what it is handed. The two hand-offs the web module carries are here
 * too: validate a customer and its photo can stand for today's visit; save a visit on a customer not
 * validated yet and validate him now. While a visit, a validation or a plan day is open the chrome is
 * hidden, so the whole screen is the entry the rep is standing at the door to finish.
 */

type SubTab = "today" | "visits" | "list" | "plan";

const SUB_TAB_LABEL: Record<SubTab, string> = { today: "Today", visits: "Visits", list: "List", plan: "Plan" };

function seatOf(overview: CrmOverview, chosen: string | null): string | null {
  const options = overview.territories;
  if (chosen !== null && options.some((territory) => territory.seatId === chosen)) return chosen;
  const own = options.find((territory) => overview.ownSeatIds.includes(territory.seatId));
  const visits = options.find((territory) => overview.visitSeatIds.includes(territory.seatId));
  return (own ?? visits ?? options[0])?.seatId ?? null;
}

function placeOf(territory: TerritorySummary): string {
  return territory.areaName ?? territory.regionName ?? territory.name;
}

function territoryRow(territory: TerritorySummary): string {
  return `${placeOf(territory)} · ${territory.repName ?? "No rep"}`;
}

export default function PhoenixCrmScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const resource = useCrm<CrmOverview>("/api/phoenix-crm/overview", "overview");

  const [chosenSeat, setChosenSeat] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(true);
  const [tab, setTab] = useState<SubTab>("visits");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingVisit, setPendingVisit] = useState<PendingVisit | null>(null);
  const [pendingValidate, setPendingValidate] = useState<PendingValidate | null>(null);
  const [visitsWorking, setVisitsWorking] = useState(false);
  const [listWorking, setListWorking] = useState(false);
  const [planWorking, setPlanWorking] = useState(false);

  const onVisitsWork = useCallback((working: boolean) => setVisitsWorking(working), []);
  const onListWork = useCallback((working: boolean) => setListWorking(working), []);
  const onPlanWork = useCallback((working: boolean) => setPlanWorking(working), []);

  const overview = resource.data;

  if (!overview) {
    return (
      <View style={{ backgroundColor: palette.paper, flex: 1, paddingTop: insets.top }}>
        {resource.error ? (
          <View style={{ gap: space.lg, padding: space.lg }}>
            <ErrorNotice message={resource.error} />
          </View>
        ) : (
          <LoadingScreen label="Opening Phoenix CRM" />
        )}
      </View>
    );
  }

  const { viewer } = overview;
  const test = viewer.isSuperAdmin && testMode;
  const seatId = seatOf(overview, chosenSeat);

  const subTabs: SubTab[] = [
    // A2: the app opens on his day. Built from `overview.tabs` alone — the server decides who gets
    // which tab, and the phone must never re-derive that from a role.
    ...(overview.tabs.today ? (["today"] as const) : []),
    ...(overview.tabs.visits ? (["visits"] as const) : []),
    ...(overview.tabs.list ? (["list"] as const) : []),
    ...(overview.tabs.plan ? (["plan"] as const) : []),
  ];
  const activeTab: SubTab = subTabs.includes(tab) ? tab : (subTabs[0] ?? "visits");

  if (subTabs.length === 0 || seatId === null) {
    const reasons = [...new Set(overview.waiting.map((entry) => entry.message))];
    const message = reasons[0] ?? overview.closedMessage ?? "Phoenix CRM is not open for you yet.";
    return (
      <View style={{ backgroundColor: palette.paper, flex: 1, gap: space.lg, padding: space.lg, paddingTop: insets.top + space.lg }}>
        <Text style={[type.title, { color: palette.ink }]}>Phoenix CRM</Text>
        <CrmNote title="Not open for you yet" tone="info">{message}</CrmNote>
      </View>
    );
  }

  function changeSeat(nextSeat: string) {
    setPickerOpen(false);
    if (nextSeat === seatId) return;
    setPendingVisit(null);
    setPendingValidate(null);
    setChosenSeat(nextSeat);
  }

  function changeTest(nextTest: boolean) {
    if (nextTest === testMode) return;
    setPendingVisit(null);
    setPendingValidate(null);
    setTestMode(nextTest);
  }

  const entersVisits = test || (!viewer.isSuperAdmin && overview.visitSeatIds.includes(seatId));
  const working = activeTab === "visits" ? visitsWorking : activeTab === "list" ? listWorking : planWorking;
  const currentTerritory = overview.territories.find((territory) => territory.seatId === seatId) ?? null;

  const chrome = (
    <View style={{ borderBottomColor: palette.line, borderBottomWidth: hairline, gap: space.md, paddingBottom: space.md, paddingHorizontal: space.lg, paddingTop: space.md }}>
      {viewer.isSuperAdmin ? (
        <CrmChoice
          columns={2}
          onChange={(next) => changeTest(next === "test")}
          options={[
            { value: "test", label: "Test mode", note: "Try the module" },
            { value: "real", label: "Real entries", note: "Read only" },
          ]}
          value={test ? "test" : "real"}
        />
      ) : null}

      {overview.territories.length > 1 ? (
        <View style={{ gap: space.xs }}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setPickerOpen((open) => !open)}
            style={{ alignItems: "center", borderColor: palette.line, borderRadius: radius, borderWidth: hairline, flexDirection: "row", gap: space.sm, minHeight: 48, paddingHorizontal: space.md }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>Territory</Text>
              <Text style={[type.bodyStrong, { color: palette.ink }]}>{currentTerritory ? territoryRow(currentTerritory) : "Choose a territory"}</Text>
            </View>
            <Ionicons color={palette.ink2} name={pickerOpen ? "chevron-up" : "chevron-down"} size={20} />
          </Pressable>
          {pickerOpen ? (
            <View style={{ borderColor: palette.line, borderWidth: hairline }}>
              {overview.territories.map((territory, index) => {
                const selected = territory.seatId === seatId;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    key={territory.seatId}
                    onPress={() => changeSeat(territory.seatId)}
                    style={{
                      backgroundColor: selected ? palette.accentSoft : palette.surface,
                      borderTopColor: palette.line,
                      borderTopWidth: index === 0 ? 0 : hairline,
                      gap: 2,
                      padding: space.md,
                    }}
                  >
                    <Text style={[type.bodyStrong, { color: selected ? palette.accentPress : palette.ink }]}>{territoryRow(territory)}</Text>
                    {territory.lineName ? <Text style={[type.meta, { color: palette.inkSoft }]}>{territory.lineName}</Text> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}

      {subTabs.length > 1 ? (
        <CrmChoice
          columns={subTabs.length >= 3 ? 3 : 2}
          onChange={setTab}
          options={subTabs.map((value) => ({ value, label: SUB_TAB_LABEL[value] }))}
          value={activeTab}
        />
      ) : null}
    </View>
  );

  return (
    <View style={{ backgroundColor: palette.paper, flex: 1, paddingTop: insets.top }}>
      {working ? null : chrome}
      <View style={{ flex: 1 }}>
        {overview.tabs.today ? (
          <View style={{ display: activeTab === "today" ? "flex" : "none", flex: activeTab === "today" ? 1 : 0 }}>
            <TodayScreen
              key={`today|${seatId}|${test}`}
              onAddVisit={(customerId, customerName) => {
                // The module's existing hand-off, one press earlier: Add Visit opens with the customer
                // already chosen, so this is not a new step in his day.
                setPendingVisit({ customerId, customerName, photo: null, seatId, test, validatedAtMs: Date.now() });
                setTab("visits");
              }}
              seatId={seatId}
              test={test}
            />
          </View>
        ) : null}
        {overview.tabs.visits ? (
          <View style={{ display: activeTab === "visits" || visitsWorking ? "flex" : "none", flex: activeTab === "visits" ? 1 : 0 }}>
            <VisitsScreen
              cairoToday={overview.cairoToday}
              key={`visits|${seatId}|${test}`}
              onPendingVisitDone={() => setPendingVisit(null)}
              onStartValidate={(validate) => {
                setPendingValidate(validate);
                setTab("list");
              }}
              onWorkChange={onVisitsWork}
              pendingVisit={pendingVisit}
              seatId={seatId}
              test={test}
            />
          </View>
        ) : null}
        {overview.tabs.list ? (
          <View style={{ display: activeTab === "list" || listWorking ? "flex" : "none", flex: activeTab === "list" ? 1 : 0 }}>
            <ListScreen
              cairoToday={overview.cairoToday}
              key={`list|${seatId}|${test}`}
              onPendingValidateDone={() => setPendingValidate(null)}
              onStartVisit={
                entersVisits
                  ? (visit) => {
                      setPendingVisit(visit);
                      setTab("visits");
                    }
                  : undefined
              }
              onWorkChange={onListWork}
              pendingValidate={pendingValidate}
              seatId={seatId}
              test={test}
            />
          </View>
        ) : null}
        {overview.tabs.plan ? (
          <View style={{ display: activeTab === "plan" || planWorking ? "flex" : "none", flex: activeTab === "plan" ? 1 : 0 }}>
            <PlanScreen
              key={`plan|${seatId}|${test}`}
              onOpenList={overview.tabs.list ? () => setTab("list") : undefined}
              onWorkChange={onPlanWork}
              seatId={seatId}
              test={test}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}
