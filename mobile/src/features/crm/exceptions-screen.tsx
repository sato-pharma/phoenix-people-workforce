import { ScrollView, Text, View } from "react-native";

import { CrmEmpty, CrmPill, CrmSection, type CrmTone } from "@/components/crm/crm-kit";
import { ErrorNotice, LoadingScreen, StatTile } from "@/components/ui";
import { crmUrl, useCrm } from "@/lib/crm/client";
import { dayLabelLong } from "@/lib/crm/format";
import { hairline, radius, space, type as type_ } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

import type { ExceptionKind, ExceptionsView } from "@/lib/crm/types";

/**
 * Phoenix CRM — "Needs you", on the phone. The web twin is the `exceptions` section of
 * src/components/phoenix-crm/reports-tab.tsx, and the rule itself is src/lib/phoenix-crm/exceptions.ts.
 *
 * 🔴 **A territory with nothing wrong is ABSENT.** That is the whole feature, and it is the server's
 * doing: `buildExceptions` drops the clean ones and hands back the rest worst first. This screen adds
 * no filter, no sort and no green row — a board that listed all 68 territories and coloured 8 would be
 * the Team tab again, and the manager would still be reading 68 rows at 7am to find 8.
 *
 * **Nothing here acts and nothing here judges anyone's honesty.** Every kind is about work NOT DONE —
 * a seat with no rep, a plan not sent, a day with no visit. None of it comes from the location
 * evidence, and none of it reaches a rep: the shell shows this tab on `overview.tabs.team`, whose
 * predicate is the same audience the service's own gate (`readsTeamReports`) admits, so a rep is never
 * offered a tab the server would then refuse. (That refusal is a plain 403 and is meant to be: unlike
 * the location board, this one keeps no secret whose existence has to be hidden as well as its rows.)
 *
 * The phone gets this board and Team, never the whole Reports tab: these two are what a manager acts
 * on between visits, and the rest is study he does sitting down.
 */

/** The two kinds nobody can work around — no rep at all, or a rep who has not begun. */
const GRAVE: ReadonlyArray<ExceptionKind> = ["vacant", "never_opened"];

function toneOf(kind: ExceptionKind): CrmTone {
  return GRAVE.includes(kind) ? "bad" : "warn";
}

export function ExceptionsScreen({ test }: { test: boolean }) {
  const palette = usePalette();
  const resource = useCrm<ExceptionsView>(crmUrl("/api/phoenix-crm/reports", { includeTest: test, section: "exceptions" }), "report");
  const view = resource.data;

  if (!view) {
    return (
      <View style={{ backgroundColor: palette.paper, flex: 1, gap: space.lg, padding: space.lg }}>
        {resource.error ? <ErrorNotice message={resource.error} /> : <LoadingScreen label="Opening the board" />}
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ gap: space.lg, padding: space.lg }} style={{ backgroundColor: palette.paper, flex: 1 }}>
      <View style={{ gap: 2 }}>
        <Text style={[type_.title, { color: palette.ink }]}>Needs you</Text>
        {/* The day "no visit" speaks about is printed, so nobody has to guess which one it means. */}
        <Text style={[type_.meta, { color: palette.inkSoft }]}>
          {`Last full field day: ${dayLabelLong(view.lastFieldDay)} · call rates over ${view.windowFieldDays} field days`}
        </Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <StatTile
          label="Territories to look at"
          tone={view.summary.needingAttention > 0 ? "accent" : "default"}
          value={String(view.summary.needingAttention)}
        />
        <StatTile label="Territories in all" value={String(view.summary.territories)} />
      </View>

      {view.summary.byKind.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          {view.summary.byKind.map((entry) => (
            <CrmPill key={entry.kind} tone={toneOf(entry.kind)}>{`${entry.label} · ${entry.count}`}</CrmPill>
          ))}
        </View>
      ) : null}

      {view.rows.length === 0 ? (
        <CrmEmpty
          message="Every territory you look after has a rep, a sent plan and a worked field day behind it."
          title="Nothing needs you"
        />
      ) : (
        <CrmSection title="Worst first">
          <View style={{ gap: space.sm }}>
            {view.rows.map((row) => (
              <View
                key={row.seatId}
                style={{
                  backgroundColor: palette.surface,
                  borderColor: palette.line,
                  borderRadius: radius,
                  borderWidth: hairline,
                  gap: 4,
                  padding: space.md,
                }}
              >
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, justifyContent: "space-between" }}>
                  <Text style={[type_.bodyStrong, { color: palette.ink, flex: 1, minWidth: 0 }]}>{row.territoryName}</Text>
                  <CrmPill tone={toneOf(row.kind)}>{row.label}</CrmPill>
                </View>
                <Text style={[type_.meta, { color: palette.inkSoft }]}>
                  {[row.repName ?? "No rep in this seat", row.lineName].filter(Boolean).join(" · ")}
                </Text>
                <Text style={[type_.body, { color: palette.ink }]}>{row.why}</Text>
                {row.detail ? <Text style={[type_.meta, { color: palette.inkSoft }]}>{row.detail}</Text> : null}
              </View>
            ))}
          </View>
        </CrmSection>
      )}
    </ScrollView>
  );
}
