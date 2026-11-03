/**
 * Phoenix CRM — the Settings tab (Super Admin): the plan's daily maximums, the grade visit numbers,
 * the distances, each line's opening day and the Ramadan dates.
 *
 * Owner, 2026-09-16: the 15 doctors and 5 accounts a plan day holds are settings; Ramadan fills in from
 * the Umm al-Qura calendar and the Super Admin can shift it for the moon sighting. Lines open one at a
 * time: a line with no opening day is closed.
 */

import { validationError } from "@/lib/http/api-errors";
import { effectiveRamadanRanges, UMM_AL_QURA_RAMADAN } from "@/lib/phoenix-crm/calendar";
import { assertSettingsWriter, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { saveLineRollout, saveRamadanOverride, saveSettings, saveVisitResendSwitch } from "@/lib/phoenix-crm/server/settings";
import type { PhoenixCrmSettings } from "@/lib/phoenix-crm/types";

/** Ramadans shown: the running or next one and the two after it. */
const RAMADANS_SHOWN = 3;

export type SettingsLine = { lineCode: string; lineName: string; territories: number; opensOn: string | null; isOpen: boolean };

export type SettingsRamadan = {
  hijriYear: number;
  startsOn: string;
  endsOn: string;
  /** Shifted by the Super Admin; the calendar's own dates beside it. */
  overridden: boolean;
  calendarStartsOn: string | null;
  calendarEndsOn: string | null;
};

export type PhoenixCrmSettingsView = {
  cairoToday: string;
  settings: PhoenixCrmSettings;
  lines: SettingsLine[];
  ramadans: SettingsRamadan[];
};

export function loadSettingsView(viewer: PhoenixCrmViewer): PhoenixCrmSettingsView {
  assertSettingsWriter(viewer);
  const { config, cairoToday } = viewer;

  const lines = new Map<string, SettingsLine>();
  for (const seat of viewer.org.territories) {
    if (!seat.lineCode) continue;
    const line = lines.get(seat.lineCode) ?? {
      lineCode: seat.lineCode,
      lineName: seat.lineName ?? seat.lineCode,
      territories: 0,
      opensOn: config.lineRollout.find((entry) => entry.lineCode === seat.lineCode)?.opensOn ?? null,
      isOpen: viewer.openLines.has(seat.lineCode),
    };
    line.territories += 1;
    lines.set(seat.lineCode, line);
  }

  const calendar = new Map(UMM_AL_QURA_RAMADAN.map((range) => [range.hijriYear, range]));
  const overridden = new Set(config.ramadanOverrides.map((range) => range.hijriYear));
  const ramadans = effectiveRamadanRanges(config.ramadanOverrides)
    .filter((range) => range.endsOn >= cairoToday)
    .slice(0, RAMADANS_SHOWN)
    .map((range) => ({
      ...range,
      overridden: overridden.has(range.hijriYear),
      calendarStartsOn: calendar.get(range.hijriYear)?.startsOn ?? null,
      calendarEndsOn: calendar.get(range.hijriYear)?.endsOn ?? null,
    }));

  return {
    cairoToday,
    settings: config.settings,
    lines: [...lines.values()].sort((left, right) => left.lineName.localeCompare(right.lineName)),
    ramadans,
  };
}

export async function saveSettingsChange(viewer: PhoenixCrmViewer, raw: unknown): Promise<void> {
  assertSettingsWriter(viewer);
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (body.kind === "settings") {
    await saveSettings(viewer.hrId, body.settings);
    return;
  }
  if (body.kind === "visit_resend") {
    await saveVisitResendSwitch(viewer.hrId, body.enabled);
    return;
  }
  if (body.kind === "line") {
    const lineCode = typeof body.lineCode === "string" ? body.lineCode.trim() : "";
    const opensOn = body.opensOn === null || body.opensOn === "" || body.opensOn === undefined ? null : String(body.opensOn);
    const knownLines = new Set(viewer.org.territories.map((seat) => seat.lineCode).filter((code): code is string => Boolean(code)));
    await saveLineRollout(viewer.hrId, lineCode, opensOn, knownLines);
    return;
  }
  if (body.kind === "ramadan") {
    await saveRamadanOverride(viewer.hrId, body);
    return;
  }
  throw validationError("Reload the page and try again.");
}
