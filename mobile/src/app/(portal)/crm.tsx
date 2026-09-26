import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CrmChoice, CrmNote } from "@/components/crm/crm-kit";
import { ErrorNotice, LoadingScreen } from "@/components/ui";
import { useCrm } from "@/lib/crm/client";
import { ExceptionsScreen } from "@/features/crm/exceptions-screen";
import { ListScreen } from "@/features/crm/list-screen";
import { PlanScreen } from "@/features/crm/plan-screen";
import { TeamScreen } from "@/features/crm/team-screen";
import { TodayScreen } from "@/features/crm/today-screen";
import { VisitsScreen } from "@/features/crm/visits-screen";
import type { PendingValidate, PendingVisit } from "@/features/crm/handoff";
import { hairline, radius, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";
import type { CrmOverview, TerritorySummary } from "@/lib/crm/types";

/**
 * Phoenix CRM on the phone — the module's own tab.
 *
 * The native counterpart of the web `PhoenixCrmApp` (src/components/phoenix-crm/phoenix-crm-app.tsx):
 * the rep's four sub-tabs of one territory, the territory picker for anyone who reads more than one,
 * the Super Admin's test mode, and since B3 the two a manager acts on between visits — Team and
 * "Needs you". The Directory, the rest of Reports, Settings and the customer's own page stay the
 * browser's: a phone is where he DECIDES, and those are study he does sitting down.
 *
 * The server decides who sees what (GET /api/phoenix-crm/overview) and checks every read and save
 * again; this screen only lays out what it is handed. The two hand-offs the web module carries are here
 * too: validate a customer and its photo can stand for today's visit; save a visit on a customer not
 * validated yet and validate him now. While a visit, a validation or a plan day is open the chrome is
 * hidden, so the whole screen is the entry the rep is standing at the door to finish.
 */

type SubTab = "today" | "visits" | "list" | "plan" | "team" | "exceptions";

const SUB_TAB_LABEL: Record<SubTab, string> = {
  today: "Today",
  visits: "Visits",
  list: "List",
  plan: "Plan",
  team: "Team",
  exceptions: "Needs you",
};

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
    // which tab, and the phone must never re-derive that from a role. 🔴 In particular not from
    // `viewer.isManager`, which is a fact ABOUT him and not a grant: an acting district manager holds
    // no manager seat and an SFE Manager holds no territory, and either one read from a role here
    // would disagree with the gate the service applies.
    ...(overview.tabs.today ? (["today"] as const) : []),
    ...(overview.tabs.visits ? (["visits"] as const) : []),
    ...(overview.tabs.list ? (["list"] as const) : []),
    ...(overview.tabs.plan ? (["plan"] as const) : []),
    ...(overview.tabs.team ? (["team"] as const) : []),
    // B3: "Needs you" rides on the SAME flag as Team, deliberately. The board's own gate on the
    // server is `readsTeamReports` — Super Admin, SFE Manager, a company basis, or a manager seat —
    // and `tabs.team` admits that same audience, so nobody is ever offered a tab whose read would
    // then be refused, and a medical rep is offered neither. It is not `tabs.reports`, which is true
    // for every seat in the module and would put the board in a rep's hand.
    ...(overview.tabs.team ? (["exceptions"] as const) : []),
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
  // Only the three tabs that can take the whole screen hide the chrome. Read as a fallthrough — the
  // old `: planWorking` — Team and "Needs you" would inherit the planner's open day and lose their
  // own tab bar.
  const working =
    activeTab === "visits" ? visitsWorking : activeTab === "list" ? listWorking : activeTab === "plan" ? planWorking : false;
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
        {/*
          B3 — the manager's two. Neither is scoped to the chosen territory: Team is every decision
          waiting on him across his whole reach, and the board is every territory in it. So neither
          takes `seatId`, and neither is keyed by one — switching the picker must not throw away a
          note he has half typed into a refusal.
        */}
        {overview.tabs.team ? (
          <View style={{ display: activeTab === "team" ? "flex" : "none", flex: activeTab === "team" ? 1 : 0 }}>
            <TeamScreen key={`team|${test}`} test={test} />
          </View>
        ) : null}
        {overview.tabs.team ? (
          <View style={{ display: activeTab === "exceptions" ? "flex" : "none", flex: activeTab === "exceptions" ? 1 : 0 }}>
            <ExceptionsScreen key={`exceptions|${test}`} test={test} />
          </View>
        ) : null}
      </View>
    </View>
  );
}
