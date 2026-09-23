import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { CrmChoice, CrmNote } from "@/components/crm/crm-kit";
import { SecondaryButton } from "@/components/ui";
import {
  CRM_WEEKDAY_NAMES,
  CRM_WEEKDAY_ORDER,
  CRM_WEEKDAY_SHORT,
  checkTimingsWhileEditing,
  formatTimingWindow,
  parseClockMinute,
  resolveEndMinute,
} from "@/lib/crm/timings";
import type { CrmSeason, CrmTiming } from "@/lib/crm/types";
import { hairline, radius, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";

/**
 * Phoenix CRM — the days and hours a customer receives visits at one place, on the phone.
 *
 * The native counterpart of the web `TimingsEditor` (src/components/phoenix-crm/timings-editor.tsx),
 * and it uses the same checks (mobile/src/lib/crm/timings.ts, a pure port of the server's): the rep
 * picks the days that share an hour, types the hour once and adds it; a day with two sittings gets a
 * second hour; Ramadan hours are a second, optional set. An overlap or a slip like "2:00 to 1:00" is
 * caught while the rep is still at the clinic.
 *
 * The hour is typed HH:MM (24-hour) rather than picked from a native wheel, because this build carries
 * no date-time picker dependency; `parseClockMinute` reads it and the list shows it back as "6:30 PM".
 */

function ClockField({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const palette = usePalette();
  return (
    <View style={{ flexBasis: 0, flexGrow: 1, gap: space.xs }}>
      <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>{label}</Text>
      <TextInput
        editable={!disabled}
        keyboardType="numbers-and-punctuation"
        maxLength={5}
        onChangeText={onChange}
        placeholder="18:30"
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
        value={value}
      />
    </View>
  );
}

function DayWindows({
  disabled,
  onRemove,
  season,
  timings,
}: {
  disabled: boolean;
  onRemove: (timing: CrmTiming) => void;
  season: CrmSeason;
  timings: ReadonlyArray<CrmTiming>;
}) {
  const palette = usePalette();
  const days = CRM_WEEKDAY_ORDER.map((weekday) => ({
    weekday,
    windows: timings.filter((timing) => timing.season === season && timing.weekday === weekday),
  })).filter((day) => day.windows.length > 0);

  if (days.length === 0) {
    return (
      <Text style={[type.meta, { color: palette.inkSoft }]}>
        {season === "normal" ? "No days added yet." : "No Ramadan hours. The normal hours are used in Ramadan."}
      </Text>
    );
  }
  return (
    <View style={{ borderColor: palette.line, borderRadius: radius, borderWidth: hairline }}>
      {days.map((day, dayIndex) => (
        <View
          key={day.weekday}
          style={{
            borderTopColor: palette.line,
            borderTopWidth: dayIndex === 0 ? 0 : hairline,
            flexDirection: "row",
            flexWrap: "wrap",
            gap: space.sm,
            padding: space.sm,
          }}
        >
          <Text style={[type.bodyStrong, { color: palette.ink, width: 96 }]}>{CRM_WEEKDAY_NAMES[day.weekday]}</Text>
          <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: space.xs, minWidth: 0 }}>
            {day.windows.map((timing) => (
              <View
                key={`${timing.startMinute}-${timing.endMinute ?? "open"}`}
                style={{
                  alignItems: "center",
                  backgroundColor: palette.surface2,
                  borderColor: palette.line,
                  borderRadius: radius,
                  borderWidth: hairline,
                  flexDirection: "row",
                  gap: space.xs,
                  paddingLeft: space.sm,
                  paddingRight: space.xs,
                  paddingVertical: 2,
                }}
              >
                <Text style={[type.meta, { color: palette.ink2 }]}>{formatTimingWindow(timing)}</Text>
                <Pressable
                  accessibilityLabel={`Remove ${CRM_WEEKDAY_NAMES[day.weekday]} ${formatTimingWindow(timing)}`}
                  accessibilityRole="button"
                  disabled={disabled}
                  hitSlop={8}
                  onPress={() => onRemove(timing)}
                >
                  <Ionicons color={palette.inkSoft} name="close" size={16} />
                </Pressable>
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

export function CrmTimingsInput({
  disabled = false,
  onChange,
  ramadanNote,
  value,
}: {
  disabled?: boolean;
  onChange: (next: CrmTiming[]) => void;
  ramadanNote?: string | null;
  value: ReadonlyArray<CrmTiming>;
}) {
  const palette = usePalette();
  const [season, setSeason] = useState<CrmSeason>("normal");
  const [days, setDays] = useState<number[]>([]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [error, setError] = useState<string | null>(null);

  function toggleDay(weekday: number) {
    setError(null);
    setDays((current) => (current.includes(weekday) ? current.filter((day) => day !== weekday) : [...current, weekday]));
  }

  function add() {
    if (days.length === 0) {
      setError("Choose the days that share this hour.");
      return;
    }
    const startMinute = parseClockMinute(start);
    if (startMinute === null) {
      setError("Write the hour the customer starts receiving, as HH:MM (for example 18:00).");
      return;
    }
    const endClock = end.trim() ? parseClockMinute(end) : null;
    if (end.trim() && endClock === null) {
      setError("The end hour is not a time. Clear it or write it as HH:MM.");
      return;
    }
    const additions: CrmTiming[] = days.map((weekday) => ({ endMinute: resolveEndMinute(startMinute, endClock), season, startMinute, weekday }));
    const checked = checkTimingsWhileEditing([...value, ...additions]);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    setDays([]);
    setStart("");
    setEnd("");
    onChange(checked.timings);
  }

  function remove(timing: CrmTiming) {
    setError(null);
    onChange(
      value.filter(
        (entry) =>
          !(entry.season === timing.season && entry.weekday === timing.weekday && entry.startMinute === timing.startMinute && entry.endMinute === timing.endMinute),
      ),
    );
  }

  const ramadanCount = value.filter((timing) => timing.season === "ramadan").length;

  return (
    <View style={{ gap: space.lg }}>
      <View style={{ gap: space.sm }}>
        <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>Receives visits</Text>
        <DayWindows disabled={disabled} onRemove={remove} season="normal" timings={value} />
      </View>
      <View style={{ gap: space.sm }}>
        <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>In Ramadan</Text>
        <DayWindows disabled={disabled} onRemove={remove} season="ramadan" timings={value} />
        {ramadanNote ? <Text style={[type.meta, { color: palette.inkSoft }]}>{ramadanNote}</Text> : null}
      </View>

      <View style={{ borderColor: palette.lineStrong, borderRadius: radius, borderStyle: "dashed", borderWidth: hairline, gap: space.md, padding: space.md }}>
        <CrmChoice
          columns={2}
          disabled={disabled}
          onChange={(next) => {
            setSeason(next);
            setError(null);
          }}
          options={[
            { label: "Normal hours", value: "normal" },
            { label: ramadanCount ? `Ramadan hours (${ramadanCount})` : "Ramadan hours", value: "ramadan" },
          ]}
          value={season}
        />

        <View style={{ gap: space.sm }}>
          <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>Days that share this hour</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            {CRM_WEEKDAY_ORDER.map((weekday) => {
              const selected = days.includes(weekday);
              return (
                <Pressable
                  accessibilityLabel={CRM_WEEKDAY_NAMES[weekday]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  disabled={disabled}
                  key={weekday}
                  onPress={() => toggleDay(weekday)}
                  style={{
                    backgroundColor: selected ? palette.accent : palette.surface,
                    borderColor: selected ? palette.accent : palette.line,
                    borderRadius: radius,
                    borderWidth: hairline,
                    minHeight: 44,
                    minWidth: 44,
                    paddingHorizontal: space.sm,
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <Text style={[type.bodyStrong, { color: selected ? palette.accentInk : palette.ink }]}>{CRM_WEEKDAY_SHORT[weekday]}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: space.sm }}>
          <ClockField disabled={disabled} label="From" onChange={setStart} value={start} />
          <ClockField disabled={disabled} label="To (if known)" onChange={setEnd} value={end} />
        </View>

        <SecondaryButton label={season === "ramadan" ? "Add Ramadan hours" : "Add these hours"} onPress={add} />
        {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
      </View>
    </View>
  );
}
