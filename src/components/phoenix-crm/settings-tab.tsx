"use client";

/**
 * Phoenix CRM — the Settings tab, the Super Admin's only (the server refuses everyone else).
 *
 * Owner rules (2026-09-16):
 *   - A plan day holds at most 15 doctors (PM) and 5 accounts (AM). Both are settings, and they cap the
 *     weekly plan only: a visit is never refused for the count.
 *   - Customers of one plan day far apart are pointed out to the reviewer; the plan still goes through.
 *   - A visit saved far from the customer's validated place still saves, flagged.
 *   - Ramadan fills in from the Umm al-Qura calendar, and the Super Admin moves a year for the moon
 *     sighting.
 *   - Lines open one at a time: a line with no opening day is closed.
 *
 * The server reads the settings uncached, so a saved change reaches the very next plan or visit saved,
 * for everyone: the Super Admin's test mode does not keep a change private. Grade visit numbers are
 * read when a report runs, so a changed number restates frequency for past months too, and the screen
 * says so beside them.
 *
 * One save runs at a time, and none while the view reloads: every save answers with the whole view,
 * and two answers crossing would put the older one back on screen.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { crmPost, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { countText, dayLabel, dayLabelWithYear, plural } from "@/components/phoenix-crm/format";
import {
  CrmBlock,
  CrmButton,
  CrmEmpty,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  crmInputClassName,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { PHOENIX_CRM_DEFAULT_SETTINGS, type PhoenixCrmDoctorListType, type PhoenixCrmGrade, type PhoenixCrmSettings } from "@/lib/phoenix-crm/types";
import type { PhoenixCrmSettingsView, SettingsLine, SettingsRamadan } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

const SETTINGS_PATH = "/api/phoenix-crm/settings";

/** PM before AM, as on every other tab. */
const LIST_TYPES: PhoenixCrmDoctorListType[] = ["PM", "AM"];
const GRADES: PhoenixCrmGrade[] = ["A", "B", "C"];

// ── The numbers ─────────────────────────────────────────────────────────────────────────────────

type TargetKey = `${PhoenixCrmDoctorListType}${PhoenixCrmGrade}`;
type FieldKey = "pmDailyCap" | "amDailyCap" | "sharedPlaceDailyCap" | "offPlanDailyCap" | "offPlanWeeklyCap" | "farApartKm" | "visitFarMeters" | "weakGpsMeters" | TargetKey;

/** What is typed, field by field. Kept as text, so a box can be emptied while a new number goes in. */
type NumbersDraft = Record<FieldKey, string>;

type FieldSpec = {
  key: FieldKey;
  label: string;
  /** What a screen reader says when the visible label leans on its group ("Grade A"). */
  ariaLabel: string | null;
  hint: string | null;
  /** Written inside the box, after the number. */
  unit: "km" | "m" | null;
  min: number;
  max: number;
  /** The far-apart distance only: one decimal place, as the server stores it. */
  decimal: boolean;
  /** A grade may have no number. */
  blankAllowed: boolean;
};

const CAP_FIELDS: FieldSpec[] = [
  { key: "pmDailyCap", label: "PM", ariaLabel: "PM a plan day holds at most", hint: null, unit: null, min: 1, max: 60, decimal: false, blankAllowed: false },
  { key: "amDailyCap", label: "AM", ariaLabel: "AM a plan day holds at most", hint: null, unit: null, min: 1, max: 60, decimal: false, blankAllowed: false },
];

/**
 * Its own group, never inside the two above: those two are the PLAN's and say so ("Visits are never
 * capped"). This one caps the visit itself as well, because a polyclinic's day is one physical queue.
 */
const SHARED_PLACE_FIELDS: FieldSpec[] = [
  {
    key: "sharedPlaceDailyCap",
    label: "Visits a day",
    ariaLabel: "Visits one polyclinic or centre holds a day",
    hint: null,
    unit: null,
    min: 1,
    max: 20,
    decimal: false,
    blankAllowed: false,
  },
];

/** The door's own group: how many DOCTORS a rep may visit off his plan. Not the plan's caps, not a venue's. */
const OFF_PLAN_FIELDS: FieldSpec[] = [
  { key: "offPlanDailyCap", label: "A day", ariaLabel: "Customers a rep may visit out of plan in a day", hint: null, unit: null, min: 1, max: 20, decimal: false, blankAllowed: false },
  { key: "offPlanWeeklyCap", label: "A week", ariaLabel: "Customers a rep may visit out of plan in a week", hint: null, unit: null, min: 1, max: 100, decimal: false, blankAllowed: false },
];

const DISTANCE_FIELDS: FieldSpec[] = [
  {
    key: "farApartKm",
    label: "Far apart on one plan day",
    ariaLabel: null,
    hint: "Two customers of one plan day further apart than this are pointed out to the reviewer. The plan still goes through.",
    unit: "km",
    min: 0,
    max: 500,
    decimal: true,
    blankAllowed: false,
  },
  {
    key: "visitFarMeters",
    label: "Far visit",
    ariaLabel: null,
    hint: "A visit saved further than this from the customer's place is flagged. It still saves.",
    unit: "m",
    min: 50,
    max: 20000,
    decimal: false,
    blankAllowed: false,
  },
  {
    key: "weakGpsMeters",
    label: "Weak location",
    ariaLabel: null,
    hint: "A location reading less accurate than this is marked weak, on a visit or a newly captured place.",
    unit: "m",
    min: 10,
    max: 5000,
    decimal: false,
    blankAllowed: false,
  },
];

function targetKey(listType: PhoenixCrmDoctorListType, grade: PhoenixCrmGrade): TargetKey {
  return `${listType}${grade}`;
}

function targetSpec(listType: PhoenixCrmDoctorListType, grade: PhoenixCrmGrade): FieldSpec {
  return {
    key: targetKey(listType, grade),
    label: `Grade ${grade}`,
    ariaLabel: `${listType}, grade ${grade}: visits a month`,
    hint: null,
    unit: null,
    min: 0,
    max: 31,
    decimal: false,
    blankAllowed: true,
  };
}

const TARGET_FIELDS: Record<PhoenixCrmDoctorListType, FieldSpec[]> = {
  PM: GRADES.map((grade) => targetSpec("PM", grade)),
  AM: GRADES.map((grade) => targetSpec("AM", grade)),
};

const ALL_FIELDS: FieldSpec[] = [...CAP_FIELDS, ...SHARED_PLACE_FIELDS, ...OFF_PLAN_FIELDS, ...TARGET_FIELDS.PM, ...TARGET_FIELDS.AM, ...DISTANCE_FIELDS];

/**
 * The typed text as plain digits: Arabic-Indic digits read as 0–9, so an Arabic keyboard works. A whole
 * number drops thousands separators ("20,000"); the one decimal field reads a comma as the decimal mark.
 */
function plainNumberText(raw: string, decimal: boolean): string {
  const digits = raw
    .trim()
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  return decimal ? digits.replace(/[٫,]/g, ".") : digits.replace(/[٬,\s]/g, "");
}

/** What a field accepts, in the words shown under it. The server refuses the same with its own. */
function ruleText(spec: FieldSpec): string {
  const unit = spec.unit ? ` ${spec.unit}` : "";
  if (spec.decimal) return `More than ${countText(spec.min)} and at most ${countText(spec.max)}${unit}, with one decimal at most.`;
  const range = `A whole number from ${countText(spec.min)} to ${countText(spec.max)}${unit}`;
  return spec.blankAllowed ? `${range}, or blank.` : `${range}.`;
}

type FieldRead = { value: number | null; error: string | null };

function readField(spec: FieldSpec, raw: string): FieldRead {
  const text = plainNumberText(raw, spec.decimal);
  if (text === "") return spec.blankAllowed ? { value: null, error: null } : { value: null, error: ruleText(spec) };
  const value = Number(text);
  const shaped = spec.decimal ? /^\d+(\.\d)?$/.test(text) : /^\d+$/.test(text);
  const inRange = (spec.decimal ? value > spec.min : value >= spec.min) && value <= spec.max;
  return shaped && inRange ? { value, error: null } : { value: null, error: ruleText(spec) };
}

/** Whether two texts say the same number: "015" for 15 is no change. */
function sameField(spec: FieldSpec, left: string, right: string): boolean {
  const a = readField(spec, left);
  const b = readField(spec, right);
  return a.error === null && b.error === null && a.value === b.value;
}

function numberText(value: number | null): string {
  return value === null ? "" : String(value);
}

function draftOf(settings: PhoenixCrmSettings): NumbersDraft {
  const { AM: am, PM: pm } = settings.gradeTargets;
  return {
    pmDailyCap: numberText(settings.pmDailyCap),
    amDailyCap: numberText(settings.amDailyCap),
    sharedPlaceDailyCap: numberText(settings.sharedPlaceDailyCap),
    offPlanDailyCap: numberText(settings.offPlanDailyCap),
    offPlanWeeklyCap: numberText(settings.offPlanWeeklyCap),
    farApartKm: numberText(settings.farApartKm),
    visitFarMeters: numberText(settings.visitFarMeters),
    weakGpsMeters: numberText(settings.weakGpsMeters),
    PMA: numberText(pm.A),
    PMB: numberText(pm.B),
    PMC: numberText(pm.C),
    AMA: numberText(am.A),
    AMB: numberText(am.B),
    AMC: numberText(am.C),
  };
}

/** The settings a draft says, or null while any box holds something its field cannot take. */
function settingsFrom(draft: NumbersDraft): PhoenixCrmSettings | null {
  const reads = new Map(ALL_FIELDS.map((spec) => [spec.key, readField(spec, draft[spec.key])]));
  if ([...reads.values()].some((read) => read.error !== null)) return null;
  const value = (key: FieldKey) => reads.get(key)?.value ?? null;
  // A required field that read clean always holds a number. NaN (sent as null) is refused by the
  // server rather than quietly replaced, should that ever not hold.
  const whole = (key: FieldKey) => value(key) ?? Number.NaN;
  return {
    pmDailyCap: whole("pmDailyCap"),
    amDailyCap: whole("amDailyCap"),
    sharedPlaceDailyCap: whole("sharedPlaceDailyCap"),
    offPlanDailyCap: whole("offPlanDailyCap"),
    offPlanWeeklyCap: whole("offPlanWeeklyCap"),
    farApartKm: whole("farApartKm"),
    visitFarMeters: whole("visitFarMeters"),
    weakGpsMeters: whole("weakGpsMeters"),
    gradeTargets: {
      PM: { A: value("PMA"), B: value("PMB"), C: value("PMC") },
      AM: { A: value("AMA"), B: value("AMB"), C: value("AMC") },
    },
    // The call-rate targets are the fixed golden rule (AM against 2, PM against 10, never averaged),
    // not a Super-Admin knob — carried through as the constant, exactly as server/settings.ts does.
    callRateAmTarget: PHOENIX_CRM_DEFAULT_SETTINGS.callRateAmTarget,
    callRatePmTarget: PHOENIX_CRM_DEFAULT_SETTINGS.callRatePmTarget,
    // Not one of these numbers: it has its own switch and its own save, and the server ignores this one.
    visitResendEnabled: PHOENIX_CRM_DEFAULT_SETTINGS.visitResendEnabled,
  };
}

/** The saved number as it reads under a changed box: "Was 300 m", "Was blank". */
function wasText(spec: FieldSpec, savedText: string): string {
  if (savedText === "") return "Was blank";
  const number = spec.decimal ? savedText : countText(Number(savedText));
  return `Was ${number}${spec.unit ? ` ${spec.unit}` : ""}`;
}

// ── Days, lines and Ramadan ─────────────────────────────────────────────────────────────────────

/** Whole days from one ISO day to another (negative when `to` is the earlier one). */
function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** "Mon 8 Feb – Mon 8 Mar 2027"; both ends carry their year when the years differ. */
function spanText(from: string, to: string): string {
  return from.slice(0, 4) === to.slice(0, 4) ? `${dayLabel(from)} – ${dayLabelWithYear(to)}` : `${dayLabelWithYear(from)} – ${dayLabelWithYear(to)}`;
}

type LineState = "open" | "scheduled" | "closed";

function lineState(line: SettingsLine): LineState {
  if (line.isOpen) return "open";
  return line.opensOn === null ? "closed" : "scheduled";
}

const LINE_PILL_TONES: Record<LineState, PillTone> = { closed: "neutral", open: "good", scheduled: "info" };

function linePillText(line: SettingsLine): string {
  if (line.isOpen) return "Open";
  return line.opensOn ? `Opens ${dayLabel(line.opensOn)}` : "Closed";
}

function lineStateText(line: SettingsLine): string {
  if (line.isOpen) return line.opensOn ? `Open since ${dayLabelWithYear(line.opensOn)}.` : "Open.";
  if (line.opensOn) return `Its reps and managers see Phoenix CRM from ${dayLabelWithYear(line.opensOn)}.`;
  return "Its reps and managers do not see Phoenix CRM.";
}

/** The sentence after a line's opening day is saved. */
function lineSavedText(line: SettingsLine, opensOn: string | null, today: string): string {
  if (opensOn === null) return line.isOpen ? `${line.lineName} is closed.` : `The opening is cancelled: ${line.lineName} stays closed.`;
  return opensOn <= today ? `${line.lineName} is open from today.` : `${line.lineName} opens on ${dayLabelWithYear(opensOn)}.`;
}

/** A day typed for a line that has not opened yet: a real day, today or later. */
function lineDayProblem(day: string, today: string): string | null {
  if (!isIsoDay(day)) return "Choose a valid day.";
  return day < today ? "Choose today or a later day." : null;
}

/** A line or a Ramadan: what it is, where it stands, what can be done. Side by side on a desktop, stacked on a phone. */
const ROW_GRID = "grid min-w-0 gap-3 lg:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,22rem)] lg:items-start";

type RamadanDraft = { hijriYear: number; startsOn: string; endsOn: string };

type RamadanCheck = {
  /** First and last day included; null until both days read the right way round. */
  days: number | null;
  error: string | null;
  warning: string | null;
  /** The dates in force already. */
  unchanged: boolean;
  /** The Umm al-Qura calendar's own dates: saving them puts a moved year back on the calendar. */
  calendar: boolean;
};

/** A moon sighting moves Ramadan by a day or two; a first day further than this from the calendar's is questioned. */
const RAMADAN_DRIFT_DAYS = 3;

function checkRamadan(ramadan: SettingsRamadan, draft: RamadanDraft): RamadanCheck {
  const unchanged = draft.startsOn === ramadan.startsOn && draft.endsOn === ramadan.endsOn;
  const calendar = draft.startsOn === ramadan.calendarStartsOn && draft.endsOn === ramadan.calendarEndsOn;
  if (!isIsoDay(draft.startsOn) || !isIsoDay(draft.endsOn)) {
    return { calendar, days: null, error: "Choose Ramadan's first and last day.", unchanged, warning: null };
  }
  const days = daysFrom(draft.startsOn, draft.endsOn) + 1;
  if (days < 1) return { calendar, days: null, error: "The last day is before the first day.", unchanged, warning: null };
  // The server's own limit: 27 to 30 days from the first day to the last.
  if (days < 28 || days > 31) {
    return { calendar, days, error: "Ramadan lasts 28 to 31 days, first and last day included.", unchanged, warning: null };
  }
  const calendarStart = ramadan.calendarStartsOn;
  const drift = calendarStart ? Math.abs(daysFrom(calendarStart, draft.startsOn)) : 0;
  const warning =
    calendarStart && drift > RAMADAN_DRIFT_DAYS
      ? `This first day is ${plural(drift, "day", "days")} from the Umm al-Qura calendar's, ${dayLabelWithYear(calendarStart)}. A moon sighting moves Ramadan by a day or two.`
      : null;
  return { calendar, days, error: null, unchanged, warning };
}

/** A save's answer, shown where it was pressed: `numbers`, `line:<code>`, `ramadan` or `ramadan:<year>`. */
type Notice = { key: string; tone: "good" | "bad"; title: string; message?: string };

function withoutKey(record: Readonly<Record<string, string>>, key: string): Record<string, string> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

// ── The tab ─────────────────────────────────────────────────────────────────────────────────────

export function SettingsTab({
  onChanged,
  onDirtyChange,
}: {
  /** A save landed; the app reloads what it reaches (a line opening or closing changes who sees what). */
  onChanged?: (change: "numbers" | "line" | "ramadan") => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const idPrefix = useId();
  const resource = useCrmGet<PhoenixCrmSettingsView>(SETTINGS_PATH, "settings");
  const [draft, setDraft] = useState<NumbersDraft | null>(null);
  /** Boxes left once show their problem from then on; every box does after a save is tried. */
  const [touched, setTouched] = useState<ReadonlySet<FieldKey>>(() => new Set<FieldKey>());
  const [showAllProblems, setShowAllProblems] = useState(false);
  const [numbersProblem, setNumbersProblem] = useState<string | null>(null);
  const [lineDays, setLineDays] = useState<Readonly<Record<string, string>>>({});
  const [closingLine, setClosingLine] = useState<string | null>(null);
  const [ramadanDraft, setRamadanDraft] = useState<RamadanDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const numbersRef = useRef<HTMLDivElement>(null);

  const view = resource.data;
  const savedNumbers = view ? draftOf(view.settings) : null;
  const numbers = draft ?? savedNumbers;
  const changedFields = numbers && savedNumbers ? ALL_FIELDS.filter((spec) => !sameField(spec, numbers[spec.key], savedNumbers[spec.key])) : [];
  const editedRamadan = view && ramadanDraft ? (view.ramadans.find((ramadan) => ramadan.hijriYear === ramadanDraft.hijriYear) ?? null) : null;
  const dirty =
    changedFields.length > 0 ||
    (view !== null && view.lines.some((line) => (lineDays[line.lineCode] ?? line.opensOn ?? "") !== (line.opensOn ?? ""))) ||
    (editedRamadan !== null &&
      ramadanDraft !== null &&
      (ramadanDraft.startsOn !== editedRamadan.startsOn || ramadanDraft.endsOn !== editedRamadan.endsOn));
  const locked = busy !== null || resource.loading;

  // Leaving the page is the one way out an unsaved change cannot survive, so the browser asks first.
  // Only while something is unsaved: a listener left attached keeps the page out of the back/forward cache.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  if (!view || !numbers || !savedNumbers) {
    return (
      <CrmPanel eyebrow="Settings" title="Phoenix CRM settings">
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Loading the settings" />}
      </CrmPanel>
    );
  }

  const today = view.cairoToday;
  const startingNumbers = draftOf(PHOENIX_CRM_DEFAULT_SETTINGS);
  const atStartingNumbers = ALL_FIELDS.every((spec) => sameField(spec, numbers[spec.key], startingNumbers[spec.key]));

  const clearNotice = (key: string) => {
    if (notice?.key === key) setNotice(null);
  };

  // ── Saving the numbers ──

  const editField = (key: FieldKey, value: string) => {
    if (locked) return;
    setDraft((current) => ({ ...(current ?? savedNumbers), [key]: value }));
    setNumbersProblem(null);
    clearNotice("numbers");
  };

  const leaveField = (key: FieldKey) => {
    setTouched((current) => (current.has(key) ? current : new Set(current).add(key)));
  };

  const fillStartingNumbers = () => {
    if (locked) return;
    setDraft(startingNumbers);
    setNumbersProblem(null);
    clearNotice("numbers");
  };

  const discardNumbers = () => {
    setDraft(null);
    setTouched(new Set<FieldKey>());
    setShowAllProblems(false);
    setNumbersProblem(null);
  };

  const saveNumbers = async () => {
    if (locked) return;
    const settings = settingsFrom(numbers);
    if (!settings) {
      setShowAllProblems(true);
      setNumbersProblem("Fix the boxes marked in red, then save.");
      return;
    }
    setBusy("numbers");
    setNumbersProblem(null);
    setNotice(null);
    try {
      const next = await crmPost<PhoenixCrmSettingsView>(SETTINGS_PATH, { kind: "settings", settings }, "settings");
      resource.replace(next);
      setDraft(null);
      setTouched(new Set<FieldKey>());
      setShowAllProblems(false);
      setNotice({ key: "numbers", tone: "good", title: "Numbers saved", message: "Everyone's next plan or visit saved uses them." });
      onChanged?.("numbers");
      const block = numbersRef.current;
      if (block && block.getBoundingClientRect().top < 0) block.scrollIntoView({ block: "start" });
    } catch (error) {
      setNumbersProblem(messageOf(error));
    } finally {
      setBusy(null);
    }
  };

  // ── The visit retry's off switch (owner, 3 Nov 2026) ──

  const saveVisitResend = async (enabled: boolean) => {
    if (locked) return;
    setBusy("visit-resend");
    setNotice(null);
    try {
      const next = await crmPost<PhoenixCrmSettingsView>(SETTINGS_PATH, { kind: "visit_resend", enabled }, "settings");
      resource.replace(next);
      setNotice({
        key: "visit-resend",
        tone: "good",
        title: enabled ? "Visit retry is on" : "Visit retry is off",
        message: enabled ? "A visit that loses signal stays on the phone and sends itself." : "A visit that loses signal asks the rep to try again, and nothing on a phone sends by itself.",
      });
    } catch (error) {
      setNotice({ key: "visit-resend", tone: "bad", title: "The switch did not change", message: messageOf(error) });
    } finally {
      setBusy(null);
    }
  };

  // ── Opening a line ──

  const editLineDay = (line: SettingsLine, value: string) => {
    setLineDays((days) => ({ ...days, [line.lineCode]: value }));
    clearNotice(`line:${line.lineCode}`);
  };

  const askToClose = (line: SettingsLine) => {
    if (locked) return;
    setClosingLine(line.lineCode);
    clearNotice(`line:${line.lineCode}`);
  };

  const saveLine = async (line: SettingsLine, opensOn: string | null) => {
    if (locked) return;
    const key = `line:${line.lineCode}`;
    setBusy(`${key}:${opensOn === null ? "close" : "open"}`);
    setNotice(null);
    try {
      const next = await crmPost<PhoenixCrmSettingsView>(SETTINGS_PATH, { kind: "line", lineCode: line.lineCode, opensOn }, "settings");
      resource.replace(next);
      setLineDays((days) => withoutKey(days, line.lineCode));
      setClosingLine(null);
      setNotice({ key, tone: "good", title: lineSavedText(line, opensOn, next.cairoToday) });
      onChanged?.("line");
    } catch (error) {
      setNotice({ key, tone: "bad", title: "Not saved", message: messageOf(error) });
    } finally {
      setBusy(null);
    }
  };

  // ── Moving Ramadan ──

  const startRamadan = (ramadan: SettingsRamadan) => {
    if (locked) return;
    setRamadanDraft({ hijriYear: ramadan.hijriYear, startsOn: ramadan.startsOn, endsOn: ramadan.endsOn });
    setNotice(null);
  };

  const editRamadan = (change: Partial<Pick<RamadanDraft, "startsOn" | "endsOn">>) => {
    setRamadanDraft((current) => (current ? { ...current, ...change } : current));
  };

  const saveRamadan = async (ramadan: SettingsRamadan, dates: { startsOn: string; endsOn: string } | "calendar") => {
    if (locked) return;
    const rowKey = `ramadan:${ramadan.hijriYear}`;
    const payload =
      dates === "calendar"
        ? { kind: "ramadan", hijriYear: ramadan.hijriYear, reset: true }
        : { kind: "ramadan", hijriYear: ramadan.hijriYear, startsOn: dates.startsOn, endsOn: dates.endsOn };
    setBusy(`${rowKey}:${dates === "calendar" ? "calendar" : "dates"}`);
    setNotice(null);
    try {
      const next = await crmPost<PhoenixCrmSettingsView>(SETTINGS_PATH, payload, "settings");
      resource.replace(next);
      setRamadanDraft(null);
      const now = next.ramadans.find((entry) => entry.hijriYear === ramadan.hijriYear);
      // Shown above the rows, not in one: a Ramadan moved to end before today leaves the list.
      setNotice({
        key: "ramadan",
        tone: "good",
        title:
          dates === "calendar"
            ? `Ramadan ${ramadan.hijriYear} AH is back on the Umm al-Qura calendar`
            : `Ramadan ${ramadan.hijriYear} AH is moved`,
        message: now ? `${spanText(now.startsOn, now.endsOn)}. The plan and Add Visit read these days from now on.` : undefined,
      });
      onChanged?.("ramadan");
    } catch (error) {
      setNotice({ key: rowKey, tone: "bad", title: "Not saved", message: messageOf(error) });
    } finally {
      setBusy(null);
    }
  };

  const saveRamadanDraft = (ramadan: SettingsRamadan, edit: RamadanDraft, check: RamadanCheck) => {
    if (check.error !== null || check.unchanged) return;
    // A moved year given the calendar's own dates goes back on the calendar, and reads so again.
    void saveRamadan(ramadan, check.calendar && ramadan.overridden ? "calendar" : { startsOn: edit.startsOn, endsOn: edit.endsOn });
  };

  // ── Drawing ──

  const noticeNote = (key: string, className?: string) =>
    notice && notice.key === key ? (
      <CrmNote className={className} title={notice.title} tone={notice.tone}>
        {notice.message}
      </CrmNote>
    ) : null;

  const groupHeading = (id: string, title: string, note: ReactNode) => (
    <div className="min-w-0">
      <h4 className="break-words text-sm font-black text-slate-950" id={id}>
        {title}
      </h4>
      {note ? <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">{note}</p> : null}
    </div>
  );

  const numberField = (spec: FieldSpec) => {
    const inputId = `${idPrefix}-${spec.key}`;
    const text = numbers[spec.key];
    const read = readField(spec, text);
    const showProblem = read.error !== null && (showAllProblems || touched.has(spec.key));
    const edited = !sameField(spec, text, savedNumbers[spec.key]);
    const hint =
      spec.hint || edited ? (
        <>
          {spec.hint}
          {edited ? (
            <span className={cn("block font-bold text-orange-700", spec.hint ? "mt-0.5" : undefined)}>{wasText(spec, savedNumbers[spec.key])}</span>
          ) : null}
        </>
      ) : null;
    return (
      <CrmField error={showProblem ? read.error : null} hint={hint} htmlFor={inputId} key={spec.key} label={spec.label}>
        <div className="relative min-w-0">
          <input
            aria-invalid={showProblem || undefined}
            aria-label={spec.ariaLabel ?? undefined}
            autoComplete="off"
            className={cn(
              crmInputClassName,
              "appearance-none",
              spec.unit ? "pr-11" : undefined,
              edited ? "border-orange-400" : undefined,
              showProblem ? "border-rose-400" : undefined,
            )}
            disabled={locked}
            enterKeyHint="done"
            id={inputId}
            inputMode={spec.decimal ? "decimal" : "numeric"}
            onBlur={() => leaveField(spec.key)}
            onChange={(event) => editField(spec.key, event.target.value)}
            type="text"
            value={text}
          />
          {spec.unit ? (
            <span aria-hidden className="pointer-events-none absolute right-3 top-3 text-sm font-bold text-slate-400">
              {spec.unit}
            </span>
          ) : null}
        </div>
      </CrmField>
    );
  };

  const lineControls = (line: SettingsLine, index: number) => {
    const key = `line:${line.lineCode}`;
    if (line.isOpen) {
      if (closingLine !== line.lineCode) {
        return (
          <div className="flex flex-wrap gap-2">
            <CrmButton disabled={locked} onClick={() => askToClose(line)} size="sm" variant="danger">
              Close the line
            </CrmButton>
          </div>
        );
      }
      return (
        <CrmNote title={`Close ${line.lineName}?`} tone="warn">
          <p>Its reps and managers lose Phoenix CRM until you give the line a new opening day. Nothing they entered is deleted.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <CrmButton busy={busy === `${key}:close`} disabled={locked} onClick={() => void saveLine(line, null)} size="sm" variant="danger">
              Close the line
            </CrmButton>
            <CrmButton disabled={busy !== null} onClick={() => setClosingLine(null)} size="sm">
              Keep it open
            </CrmButton>
          </div>
        </CrmNote>
      );
    }
    const inputId = `${idPrefix}-line-${index}`;
    const day = lineDays[line.lineCode] ?? line.opensOn ?? "";
    const moved = day !== (line.opensOn ?? "");
    const problem = moved && day !== "" ? lineDayProblem(day, today) : null;
    return (
      <CrmField
        error={problem}
        hint={moved && problem === null && day === today ? "Today: its reps and managers see Phoenix CRM straight away." : null}
        htmlFor={inputId}
        label={line.opensOn ? "Move the opening day" : "Opening day"}
      >
        <div className="flex min-w-0 flex-wrap gap-2">
          <input
            className={cn(crmInputClassName, "appearance-none sm:w-44")}
            disabled={locked}
            id={inputId}
            min={today}
            onChange={(event) => editLineDay(line, event.target.value)}
            type="date"
            value={day}
          />
          <CrmButton
            busy={busy === `${key}:open`}
            disabled={locked || !moved || day === "" || problem !== null}
            onClick={() => void saveLine(line, day)}
            variant="primary"
          >
            {line.opensOn ? "Save the day" : "Open on this day"}
          </CrmButton>
          {line.opensOn ? (
            <CrmButton busy={busy === `${key}:close`} disabled={locked} onClick={() => void saveLine(line, null)}>
              Cancel the opening
            </CrmButton>
          ) : null}
        </div>
      </CrmField>
    );
  };

  const lineRow = (line: SettingsLine, index: number) => (
    <li className="px-4 py-3.5 sm:px-5" key={line.lineCode}>
      <div className={ROW_GRID}>
        <div className="min-w-0">
          <p className="break-words text-sm font-black text-slate-950">{line.lineName}</p>
          <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{plural(line.territories, "territory", "territories")}</p>
        </div>
        <div className="min-w-0">
          <CrmPill tone={LINE_PILL_TONES[lineState(line)]}>{linePillText(line)}</CrmPill>
          <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">{lineStateText(line)}</p>
        </div>
        <div className="grid min-w-0 gap-2">
          {lineControls(line, index)}
          {noticeNote(`line:${line.lineCode}`)}
        </div>
      </div>
    </li>
  );

  const ramadanEditor = (ramadan: SettingsRamadan, edit: RamadanDraft) => {
    const check = checkRamadan(ramadan, edit);
    const firstId = `${idPrefix}-ramadan-${ramadan.hijriYear}-first`;
    const lastId = `${idPrefix}-ramadan-${ramadan.hijriYear}-last`;
    return (
      <div className="mt-3 grid min-w-0 gap-3 border border-slate-200 bg-slate-50 px-3 py-3 sm:px-4">
        <div className="grid min-w-0 grid-cols-2 gap-3 md:max-w-md">
          <CrmField htmlFor={firstId} label="First day">
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={locked}
              id={firstId}
              onChange={(event) => editRamadan({ startsOn: event.target.value })}
              type="date"
              value={edit.startsOn}
            />
          </CrmField>
          <CrmField htmlFor={lastId} label="Last day">
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={locked}
              id={lastId}
              min={isIsoDay(edit.startsOn) ? edit.startsOn : undefined}
              onChange={(event) => editRamadan({ endsOn: event.target.value })}
              type="date"
              value={edit.endsOn}
            />
          </CrmField>
        </div>
        {check.error ? (
          <p className="break-words text-xs font-bold leading-5 text-rose-700">{check.error}</p>
        ) : (
          <p className="break-words text-xs font-semibold leading-5 text-slate-600">
            {check.days !== null ? `${plural(check.days, "day", "days")}, first and last day included.` : null}
            {check.calendar ? " The Umm al-Qura calendar's own dates." : null}
          </p>
        )}
        {check.warning ? <CrmNote tone="warn">{check.warning}</CrmNote> : null}
        {noticeNote(`ramadan:${ramadan.hijriYear}`)}
        <div className="flex flex-wrap gap-2">
          <CrmButton
            busy={busy === `ramadan:${ramadan.hijriYear}:dates`}
            disabled={locked || check.error !== null || check.unchanged}
            onClick={() => saveRamadanDraft(ramadan, edit, check)}
            size="sm"
            variant="primary"
          >
            Save the dates
          </CrmButton>
          <CrmButton disabled={busy !== null} onClick={() => setRamadanDraft(null)} size="sm">
            Cancel
          </CrmButton>
        </div>
      </div>
    );
  };

  const ramadanRow = (ramadan: SettingsRamadan) => {
    const rowKey = `ramadan:${ramadan.hijriYear}`;
    const running = ramadan.startsOn <= today && today <= ramadan.endsOn;
    const edit = ramadanDraft?.hijriYear === ramadan.hijriYear ? ramadanDraft : null;
    return (
      <li className="px-4 py-3.5 sm:px-5" key={ramadan.hijriYear}>
        <div className={ROW_GRID}>
          <div className="min-w-0">
            <p className="break-words text-sm font-black text-slate-950">Ramadan {ramadan.hijriYear} AH</p>
            <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">
              {plural(daysFrom(ramadan.startsOn, ramadan.endsOn) + 1, "day", "days")}
            </p>
          </div>
          <div className="min-w-0">
            <p className="break-words text-sm font-bold text-slate-800">{spanText(ramadan.startsOn, ramadan.endsOn)}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {running ? <CrmPill tone="orange">Running now</CrmPill> : null}
              <CrmPill tone={ramadan.overridden ? "info" : "neutral"}>{ramadan.overridden ? "Moved for the moon sighting" : "Umm al-Qura calendar"}</CrmPill>
            </div>
            {ramadan.overridden && ramadan.calendarStartsOn && ramadan.calendarEndsOn ? (
              <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">
                The calendar has {spanText(ramadan.calendarStartsOn, ramadan.calendarEndsOn)}.
              </p>
            ) : null}
          </div>
          <div className="grid min-w-0 gap-2">
            {edit ? null : (
              <>
                <div className="flex flex-wrap gap-2">
                  <CrmButton disabled={locked} onClick={() => startRamadan(ramadan)} size="sm">
                    Move the dates
                  </CrmButton>
                  {ramadan.overridden && ramadan.calendarStartsOn ? (
                    <CrmButton
                      busy={busy === `${rowKey}:calendar`}
                      disabled={locked}
                      onClick={() => void saveRamadan(ramadan, "calendar")}
                      size="sm"
                      variant="ghost"
                    >
                      Back to the calendar
                    </CrmButton>
                  ) : null}
                </div>
                {noticeNote(rowKey)}
              </>
            )}
          </div>
        </div>
        {edit ? ramadanEditor(ramadan, edit) : null}
      </li>
    );
  };

  const saveBar =
    changedFields.length > 0 ? (
      // Held above the portal's bottom bar on phones (the app sets --crm-sticky-bottom to its height).
      <div data-portal-action-bar="" className="sticky bottom-[var(--crm-sticky-bottom,0px)] z-20 border-t border-orange-300 bg-white px-4 py-3 shadow-[0_-10px_30px_rgba(15,23,42,0.12)] sm:px-5 lg:bottom-0">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 basis-56">
            <p className="break-words text-sm font-black text-slate-950">Unsaved numbers</p>
            <p className="break-words text-xs font-semibold leading-5 text-slate-500">
              {`${plural(changedFields.length, "change", "changes")}. Plans, visits and reports use the new numbers once saved.`}
            </p>
            {/*
             * What Discard changes will do, said BEFORE it is pressed — there is no second press left to
             * say it in (the plan board's own bar reads the same way).
             */}
            <p className="break-words text-xs font-semibold leading-5 text-slate-500">Discard changes puts every box back to what was last saved.</p>
            {numbersProblem ? (
              <p className="break-words text-xs font-bold leading-5 text-rose-700" role="alert">
                {numbersProblem}
              </p>
            ) : null}
          </div>
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
            {/*
             * ONE press, on the owner's own instruction (2026-09-30), after the same change on the plan
             * board: it used to ask "Discard your changes to the numbers?" and wait for a second press,
             * which reads as a button that did nothing — the bar's wording changed and the boxes stayed.
             * So the press discards, and it keeps the danger variant the confirm's own button wore.
             */}
            <CrmButton disabled={locked} onClick={discardNumbers} variant="danger">
              Discard changes
            </CrmButton>
            <CrmButton busy={busy === "numbers"} disabled={locked} onClick={() => void saveNumbers()} variant="primary">
              Save the numbers
            </CrmButton>
          </div>
        </div>
      </div>
    ) : null;

  return (
    <CrmPanel
      actions={
        <CrmButton busy={resource.loading} disabled={busy !== null} onClick={resource.reload} size="sm">
          Refresh
        </CrmButton>
      }
      description="These apply to every rep and manager straight away, whether you are in test mode or not."
      eyebrow="Settings"
      title="Phoenix CRM settings"
    >
      {resource.error ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title="The settings could not be refreshed" tone="warn">
            {resource.error}
          </CrmNote>
        </div>
      ) : null}

      <div className="scroll-mt-24" ref={numbersRef}>
        <CrmBlock
          actions={
            <CrmButton disabled={locked || atStartingNumbers} onClick={fillStartingNumbers} size="sm" variant="ghost">
              Fill in the starting numbers
            </CrmButton>
          }
          title="Plan and visit numbers"
        >
          {noticeNote("numbers", "mb-4")}
          <div className="grid min-w-0 gap-5">
            <div aria-labelledby={`${idPrefix}-caps`} className="grid min-w-0 gap-3" role="group">
              {groupHeading(`${idPrefix}-caps`, "A plan day holds at most", "The weekly plan only: a full day takes no more. Visits are never capped.")}
              <div className="grid min-w-0 grid-cols-2 gap-3 md:max-w-md">{CAP_FIELDS.map(numberField)}</div>
            </div>
            <div aria-labelledby={`${idPrefix}-shared-place`} className="grid min-w-0 gap-3 border-t border-slate-100 pt-5" role="group">
              {groupHeading(
                `${idPrefix}-shared-place`,
                "One polyclinic or centre holds at most",
                "Several customers receive behind one door. This is the visits that door takes in a day, whatever the number of customers in it — on the weekly plan and when a visit is logged.",
              )}
              <div className="grid min-w-0 grid-cols-2 gap-3 md:max-w-md">{SHARED_PLACE_FIELDS.map(numberField)}</div>
            </div>
            <div aria-labelledby={`${idPrefix}-off-plan`} className="grid min-w-0 gap-3 border-t border-slate-100 pt-5" role="group">
              {groupHeading(
                `${idPrefix}-off-plan`,
                "Customers a rep may visit out of plan, at most",
                "Out-of-plan visits only: a customer on the rep's list who is not on the sent plan for that day. The week runs Saturday to Thursday. A visit past either number is not saved, and the rep is told to log it on another day.",
              )}
              <div className="grid min-w-0 grid-cols-2 gap-3 md:max-w-md">{OFF_PLAN_FIELDS.map(numberField)}</div>
            </div>
            <div aria-labelledby={`${idPrefix}-grades`} className="grid min-w-0 gap-3 border-t border-slate-100 pt-5" role="group">
              {groupHeading(
                `${idPrefix}-grades`,
                "Visits a month, by grade",
                "Plan suggestions put customers behind these first, and the reports measure frequency against them, past months included. A blank grade has no number: its customers count for coverage only.",
              )}
              {LIST_TYPES.map((listType) => (
                <div className="min-w-0" key={listType}>
                  <p className="text-xs font-black text-slate-700">
                    {listType}
                  </p>
                  <div className="mt-1.5 grid min-w-0 grid-cols-3 gap-2 md:max-w-lg">{TARGET_FIELDS[listType].map(numberField)}</div>
                </div>
              ))}
            </div>
            <div aria-labelledby={`${idPrefix}-distances`} className="grid min-w-0 gap-3 border-t border-slate-100 pt-5" role="group">
              {groupHeading(`${idPrefix}-distances`, "Distances", null)}
              <div className="grid min-w-0 gap-3 lg:grid-cols-3">{DISTANCE_FIELDS.map(numberField)}</div>
            </div>
          </div>
        </CrmBlock>
      </div>

      <div className="border-t border-slate-100">
        <CrmBlock title="Line opening days">
          <p className="break-words text-sm font-medium leading-6 text-slate-500">
            A line&apos;s reps and managers see Phoenix CRM from its opening day; a line with no day stays closed. Nobody is sent a message when a
            line opens.
          </p>
        </CrmBlock>
        {view.lines.length === 0 ? (
          <CrmEmpty message="A line shows here once its territories are in the organogram." title="No lines to open" />
        ) : (
          <ul className="divide-y divide-slate-100 border-t border-slate-100">{view.lines.map(lineRow)}</ul>
        )}
      </div>

      <div className="border-t border-slate-100">
        <CrmBlock
          actions={
            <CrmButton busy={busy === "visit-resend"} disabled={locked} onClick={() => void saveVisitResend(!view.settings.visitResendEnabled)} size="sm">
              {view.settings.visitResendEnabled ? "Turn off" : "Turn on"}
            </CrmButton>
          }
          title="Visit retry"
        >
          {noticeNote("visit-resend", "mb-3")}
          <p className="text-sm font-semibold text-slate-600">
            {view.settings.visitResendEnabled
              ? "On. A visit that loses signal stays on the rep's phone and sends itself for up to two hours, until 02:00."
              : "Off. A visit that loses signal asks the rep to try again, as it did before."}
          </p>
        </CrmBlock>
      </div>

      <div className="border-t border-slate-100">
        <CrmBlock title="Ramadan dates">
          <p className="break-words text-sm font-medium leading-6 text-slate-500">
            Filled in from the Umm al-Qura calendar; move a year when the moon sighting differs. On these days the plan and Add Visit read each
            customer&apos;s Ramadan timings, and a customer with none keeps the normal ones.
          </p>
          {noticeNote("ramadan", "mt-3")}
        </CrmBlock>
        {view.ramadans.length === 0 ? (
          <CrmEmpty message="The Umm al-Qura dates Phoenix holds run to 2038." title="No Ramadan ahead in the calendar" />
        ) : (
          <ul className="divide-y divide-slate-100 border-t border-slate-100">{view.ramadans.map(ramadanRow)}</ul>
        )}
      </div>

      {saveBar}
    </CrmPanel>
  );
}
