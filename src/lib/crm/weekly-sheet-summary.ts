/**
 * The Weekly Sheet — the figures the premium pass prints (owner, 9 Nov 2026: "eyeball every report in My Team's
 * Reports, premium polish, every single component"). The screen, its panels and its Excel file all read these
 * functions, so the three can never disagree.
 *
 * Pure: it reads the sheet `loadWeeklySheet` built and nothing else — no database, no clock but the sheet's own
 * `cairoToday`.
 *
 *   - 🔴 A WEEK STILL RUNNING IS NEVER GRADED "BELOW". On Monday every rep is short of a Saturday-to-Wednesday
 *     target by design, so a target not reached yet reads "So far"; a week not started reads "Not started" and a
 *     week of no working day (all leave, or all holidays) reads "No working day" — never "0 of 0 · Met".
 *   - A vacant seat is a seat, never a rep "below target": it is measured in no figure and counted apart.
 *   - The targets are said once, from `PM_PER_WORKING_DAY` and `AM_PER_WORKING_DAY` — never typed as numbers.
 *   - An account whose comments name no doctor says so in words; it is short of nothing, because nothing was read.
 *   - A visit waiting for validation is real work counted in no figure; it is named, never added in.
 */

import { DOCTOR_FAMILY_LABEL, DOCTORS_PER_SPECIALITY, type AccountDoctorDepth } from "@/lib/crm/account-doctor-notes";
import { addDaysIso } from "@/lib/crm/dates";
import {
  AM_PER_WORKING_DAY,
  PM_PER_WORKING_DAY,
  weeklySheetResult,
  type WeeklySheet,
  type WeeklySheetAccount,
  type WeeklySheetDistrict,
  type WeeklySheetRep,
} from "@/lib/crm/weekly-sheet";

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function weeklySheetRepsWord(count: number): string {
  return counted(count, "rep", "reps");
}

export function weeklySheetVisitsWord(count: number): string {
  return counted(count, "visit", "visits");
}

export function weeklySheetAccountsWord(count: number): string {
  return counted(count, "account", "accounts");
}

export function weeklySheetDaysWord(count: number): string {
  return counted(count, "day", "days");
}

/** The days in a full field week, Saturday to Wednesday. */
export const WEEKLY_SHEET_FULL_WEEK_DAYS = 5;

/** The one sentence that states the targets — screen and Excel — read off the rule's own constants. */
export function weeklySheetTargetLine(): string {
  return `Target per working day: ${PM_PER_WORKING_DAY} PM and ${AM_PER_WORKING_DAY} AM — ${PM_PER_WORKING_DAY * WEEKLY_SHEET_FULL_WEEK_DAYS} PM and ${AM_PER_WORKING_DAY * WEEKLY_SHEET_FULL_WEEK_DAYS} AM in a full Saturday-to-Wednesday week. Approved leave and national holidays come out of the target.`;
}

/** The one sentence that states the account depth, read off `DOCTORS_PER_SPECIALITY`. */
export function weeklySheetDepthLine(): string {
  return `At least ${DOCTORS_PER_SPECIALITY} doctors of each speciality — ${DOCTOR_FAMILY_LABEL.pediatrics}, ${DOCTOR_FAMILY_LABEL.internal}, ${DOCTOR_FAMILY_LABEL.ent} — inside every AM account, read from the AM visit comments.`;
}

/** What an account whose comments name no doctor says, on the screen and in the file. */
export const WEEKLY_SHEET_NO_DOCTORS = "No doctors written in the comment";

// ── Where the week stands ────────────────────────────────────────────────────────────────────────

export type WeeklySheetPosition = "past" | "current" | "ahead";

/** Over once its Wednesday has passed; ahead while its Saturday is still to come. */
export function weeklySheetPosition(sheet: Pick<WeeklySheet, "cairoToday" | "weekEnd" | "weekStart">): WeeklySheetPosition {
  if (sheet.cairoToday > sheet.weekEnd) return "past";
  if (sheet.cairoToday < sheet.weekStart) return "ahead";
  return "current";
}

export function weeklySheetPositionLine(position: WeeklySheetPosition): string {
  if (position === "past") return "The week is over, so every figure is final.";
  if (position === "current") return "The week is still running: a target not reached yet reads “So far”, never “Below”.";
  return "This week has not started yet, so nothing is graded.";
}

/** The week links: the next one only while it has begun, so the screen never opens on a week of zeros to come. */
export function weeklySheetNav(sheet: Pick<WeeklySheet, "cairoToday" | "weekStart">): { previous: string; next: string | null } {
  const next = addDaysIso(sheet.weekStart, 7);
  return { next: next <= sheet.cairoToday ? next : null, previous: addDaysIso(sheet.weekStart, -7) };
}

// ── One figure against its target ────────────────────────────────────────────────────────────────

export const WEEKLY_SHEET_VERDICTS = ["Met", "Below", "So far", "Not started", "No working day", "Seat is vacant"] as const;
export type WeeklySheetVerdict = (typeof WEEKLY_SHEET_VERDICTS)[number];

/**
 * One grading rule for the screen and the Excel. It extends `weeklySheetResult` (a finished week's Met or Below,
 * and the vacant seat) with the three cases that rule cannot see: no working day, a week still running, and a
 * week not started.
 */
export function weeklySheetVerdict(value: number, target: number, vacant: boolean, position: WeeklySheetPosition): WeeklySheetVerdict {
  if (vacant) return "Seat is vacant";
  if (target <= 0) return "No working day";
  if (position === "ahead") return "Not started";
  const result = weeklySheetResult(value, target, vacant);
  if (result === "Below" && position === "current") return "So far";
  return result;
}

/** The colour of each verdict's word: green and amber for the two grades, slate for every case graded on nothing. */
export const WEEKLY_SHEET_VERDICT_TONE: Record<WeeklySheetVerdict, string> = {
  Below: "border-amber-300 bg-amber-50 text-amber-800",
  Met: "border-emerald-300 bg-emerald-50 text-emerald-800",
  "No working day": "border-slate-200 bg-slate-50 text-slate-600",
  "Not started": "border-slate-200 bg-slate-50 text-slate-600",
  "Seat is vacant": "border-slate-200 bg-slate-50 text-slate-500",
  "So far": "border-slate-300 bg-white text-slate-700",
};

/** The gap in words: "12 short" for a finished week, "12 to go" for one still running, nothing otherwise. */
export function weeklySheetGapWords(value: number, target: number, verdict: WeeklySheetVerdict): string | null {
  const gap = Math.max(0, target - value);
  if (gap === 0) return null;
  if (verdict === "Below") return `${gap} short`;
  if (verdict === "So far") return `${gap} to go`;
  return null;
}

export type WeeklySheetRepVerdicts = { pm: WeeklySheetVerdict; am: WeeklySheetVerdict };

export function weeklySheetRepVerdicts(rep: Pick<WeeklySheetRep, "am" | "amTarget" | "pm" | "pmTarget" | "vacant">, position: WeeklySheetPosition): WeeklySheetRepVerdicts {
  return {
    am: weeklySheetVerdict(rep.am, rep.amTarget, rep.vacant, position),
    pm: weeklySheetVerdict(rep.pm, rep.pmTarget, rep.vacant, position),
  };
}

/** A rep measured this week: someone on the seat and at least one working day to measure. */
export function isWeeklySheetMeasured(rep: Pick<WeeklySheetRep, "pmTarget" | "vacant">): boolean {
  return !rep.vacant && rep.pmTarget > 0;
}

/** The rep's own line under the name: the territory, the working days and the days of leave. */
export function weeklySheetRepDaysLine(rep: Pick<WeeklySheetRep, "leaveDays" | "territory" | "vacant" | "workingDays">): string {
  if (rep.vacant) return rep.territory;
  const parts = [rep.territory, `${rep.workingDays} working ${rep.workingDays === 1 ? "day" : "days"}`];
  if (rep.leaveDays > 0) parts.push(`${rep.leaveDays} on leave`);
  return parts.join(" · ");
}

/** The visits waiting for validation, named and never added in. */
export function weeklySheetWaitingLine(waiting: number): string | null {
  return waiting > 0 ? `${waiting} waiting for validation` : null;
}

// ── The account depth ────────────────────────────────────────────────────────────────────────────

export type WeeklySheetFamily = "pediatrics" | "internal" | "ent";
export const WEEKLY_SHEET_FAMILIES: readonly WeeklySheetFamily[] = ["pediatrics", "internal", "ent"];

/** One speciality column reaches the minimum. */
export function weeklySheetDepthMet(value: number): boolean {
  return value >= DOCTORS_PER_SPECIALITY;
}

export type WeeklySheetAccountState = "met" | "short" | "no_doctors";
export const WEEKLY_SHEET_ACCOUNT_STATES: readonly WeeklySheetAccountState[] = ["met", "short", "no_doctors"];

export const WEEKLY_SHEET_ACCOUNT_STATE_LABEL: Record<WeeklySheetAccountState, string> = {
  met: "3 of each",
  no_doctors: "No doctors written",
  short: "Short of a speciality",
};

export const WEEKLY_SHEET_ACCOUNT_STATE_SWATCH: Record<WeeklySheetAccountState, string> = {
  met: "bg-emerald-600",
  no_doctors: "bg-slate-300",
  short: "bg-amber-500",
};

export function weeklySheetAccountState(depth: Pick<AccountDoctorDepth, "met" | "noDoctorsWritten">): WeeklySheetAccountState {
  if (depth.noDoctorsWritten) return "no_doctors";
  return depth.met ? "met" : "short";
}

/** The specialities an account is short of, and by how many doctors — empty when it is met or names nobody. */
export function weeklySheetAccountShort(depth: AccountDoctorDepth): Array<{ family: WeeklySheetFamily; label: string; missing: number }> {
  if (depth.noDoctorsWritten || depth.met) return [];
  return WEEKLY_SHEET_FAMILIES.filter((family) => !weeklySheetDepthMet(depth[family])).map((family) => ({
    family,
    label: DOCTOR_FAMILY_LABEL[family],
    missing: DOCTORS_PER_SPECIALITY - depth[family],
  }));
}

/** "Needs 2 more ENT · 1 more Pediatrics" — what would make the account 3 of each. */
export function weeklySheetAccountShortLine(depth: AccountDoctorDepth): string | null {
  const short = weeklySheetAccountShort(depth);
  if (short.length === 0) return null;
  return `Needs ${short.map((entry) => `${entry.missing} more ${entry.label}`).join(" · ")}`;
}

/** "3 of each" for a met account, the plain words otherwise — the Excel's last column. */
export function weeklySheetAccountResult(depth: Pick<AccountDoctorDepth, "met" | "noDoctorsWritten">): string {
  const state = weeklySheetAccountState(depth);
  return state === "met" ? "Met" : state === "short" ? "Below" : "No doctors written";
}

// ── The team and each district ───────────────────────────────────────────────────────────────────

export type WeeklySheetTotals = {
  /** Every seat on the sheet, vacant ones included. */
  seats: number;
  vacant: number;
  /** Reps measured this week (someone on the seat, a working day to measure). */
  measured: number;
  /** Reps on the seat with no working day at all (a week of leave or of holidays). */
  noWorkingDay: number;
  pm: number;
  pmTarget: number;
  am: number;
  amTarget: number;
  /** Measured reps by their PM verdict, and by their AM verdict. */
  pmByVerdict: Record<WeeklySheetVerdict, number>;
  amByVerdict: Record<WeeklySheetVerdict, number>;
  /** Measured reps who met both targets. */
  bothMet: number;
  pharmacies: number;
  waiting: number;
  leaveDays: number;
  accounts: number;
  byAccountState: Record<WeeklySheetAccountState, number>;
  /** Accounts short of each speciality (an account short of two counts in both). */
  shortBy: Record<WeeklySheetFamily, number>;
};

function emptyVerdicts(): Record<WeeklySheetVerdict, number> {
  return Object.fromEntries(WEEKLY_SHEET_VERDICTS.map((verdict) => [verdict, 0])) as Record<WeeklySheetVerdict, number>;
}

/** One arithmetic for the team and for a district: the reps it is handed, nothing else. */
export function weeklySheetTotals(reps: readonly WeeklySheetRep[], position: WeeklySheetPosition): WeeklySheetTotals {
  const totals: WeeklySheetTotals = {
    accounts: 0,
    am: 0,
    amByVerdict: emptyVerdicts(),
    amTarget: 0,
    bothMet: 0,
    byAccountState: { met: 0, no_doctors: 0, short: 0 },
    leaveDays: 0,
    measured: 0,
    noWorkingDay: 0,
    pharmacies: 0,
    pm: 0,
    pmByVerdict: emptyVerdicts(),
    pmTarget: 0,
    seats: reps.length,
    shortBy: { ent: 0, internal: 0, pediatrics: 0 },
    vacant: 0,
    waiting: 0,
  };
  for (const rep of reps) {
    totals.pm += rep.pm;
    totals.am += rep.am;
    totals.pmTarget += rep.pmTarget;
    totals.amTarget += rep.amTarget;
    totals.pharmacies += rep.pharmacies;
    totals.waiting += rep.waiting;
    totals.leaveDays += rep.leaveDays;
    for (const account of rep.accounts) {
      totals.accounts += 1;
      totals.byAccountState[weeklySheetAccountState(account.depth)] += 1;
      for (const entry of weeklySheetAccountShort(account.depth)) totals.shortBy[entry.family] += 1;
    }
    if (rep.vacant) {
      totals.vacant += 1;
      continue;
    }
    if (!isWeeklySheetMeasured(rep)) {
      totals.noWorkingDay += 1;
      continue;
    }
    totals.measured += 1;
    const verdicts = weeklySheetRepVerdicts(rep, position);
    totals.pmByVerdict[verdicts.pm] += 1;
    totals.amByVerdict[verdicts.am] += 1;
    if (verdicts.pm === "Met" && verdicts.am === "Met") totals.bothMet += 1;
  }
  return totals;
}

export function weeklySheetTeamTotals(sheet: Pick<WeeklySheet, "cairoToday" | "districts" | "weekEnd" | "weekStart">): WeeklySheetTotals {
  return weeklySheetTotals(
    sheet.districts.flatMap((district) => district.reps),
    weeklySheetPosition(sheet),
  );
}

/** "4 of 6 reps met · 2 below" — or "so far" while the week runs, or why nobody is graded. */
export function weeklySheetMetCaption(byVerdict: Record<WeeklySheetVerdict, number>, measured: number, position: WeeklySheetPosition): string {
  if (measured === 0) return "No rep to measure this week";
  if (position === "ahead") return `${weeklySheetRepsWord(measured)} to measure once the week starts`;
  const met = `${byVerdict.Met} of ${weeklySheetRepsWord(measured)} met`;
  if (position === "current") return `${met} · ${byVerdict["So far"]} still going`;
  return `${met} · ${byVerdict.Below} below`;
}

/** The seats graded on nothing, said once: "1 vacant seat · 1 rep with no working day". */
export function weeklySheetUnmeasuredLine(totals: Pick<WeeklySheetTotals, "noWorkingDay" | "vacant">): string | null {
  const parts: string[] = [];
  if (totals.vacant > 0) parts.push(counted(totals.vacant, "vacant seat", "vacant seats"));
  if (totals.noWorkingDay > 0) parts.push(`${weeklySheetRepsWord(totals.noWorkingDay)} with no working day`);
  return parts.length > 0 ? `${parts.join(" · ")}, counted in no grade` : null;
}

/** A district's line under its heading: "PM 230 of 250 · AM 40 of 50 · 2 of 5 reps met both". */
export function weeklySheetDistrictLine(totals: WeeklySheetTotals, position: WeeklySheetPosition): string {
  const figures = `PM ${totals.pm} of ${totals.pmTarget} · AM ${totals.am} of ${totals.amTarget}`;
  if (totals.measured === 0) return `${figures} · no rep to measure`;
  if (position === "ahead") return `${figures} · not started`;
  return `${figures} · ${totals.bothMet} of ${weeklySheetRepsWord(totals.measured)} met both${position === "current" ? " so far" : ""}`;
}

/** The team in one sentence, under "Where the week stands". */
export function weeklySheetTeamLine(totals: WeeklySheetTotals, position: WeeklySheetPosition): string {
  const parts = [`${weeklySheetRepsWord(totals.measured)} measured`, `PM ${totals.pm} of ${totals.pmTarget}`, `AM ${totals.am} of ${totals.amTarget}`];
  if (position !== "ahead" && totals.measured > 0) parts.push(`${totals.bothMet} met both${position === "current" ? " so far" : ""}`);
  return parts.join(" · ");
}

// ── Shares for a flat bar ────────────────────────────────────────────────────────────────────────

export type WeeklySheetBarPart<K extends string> = { key: K; label: string; count: number; percent: number; swatch: string };

/** Whole-number shares that add up to exactly 100 (the largest remainders take the leftover points). */
export function weeklySheetShares<K extends string>(parts: ReadonlyArray<{ key: K; label: string; count: number; swatch: string }>): WeeklySheetBarPart<K>[] {
  const present = parts.filter((part) => part.count > 0);
  const whole = present.reduce((sum, part) => sum + part.count, 0);
  if (whole === 0) return [];
  const raw = present.map((part) => ({ ...part, exact: (part.count / whole) * 100 }));
  const floors = raw.map((part) => ({ ...part, percent: Math.floor(part.exact) }));
  let left = 100 - floors.reduce((sum, part) => sum + part.percent, 0);
  for (const part of [...floors].sort((a, b) => b.exact - b.percent - (a.exact - a.percent))) {
    if (left <= 0) break;
    part.percent += 1;
    left -= 1;
  }
  return floors.map(({ count, key, label, percent, swatch }) => ({ count, key, label, percent, swatch }));
}

const VERDICT_SWATCH: Partial<Record<WeeklySheetVerdict, string>> = { Below: "bg-amber-500", Met: "bg-emerald-600", "So far": "bg-slate-400" };

/** The measured reps by one figure's verdict — Met, Below, or So far while the week runs. */
export function weeklySheetVerdictBar(byVerdict: Record<WeeklySheetVerdict, number>): WeeklySheetBarPart<WeeklySheetVerdict>[] {
  return weeklySheetShares(
    (["Met", "Below", "So far"] as const).map((verdict) => ({ count: byVerdict[verdict], key: verdict, label: verdict, swatch: VERDICT_SWATCH[verdict] ?? "bg-slate-300" })),
  );
}

/** Every AM account visited, by its depth. */
export function weeklySheetAccountBar(totals: Pick<WeeklySheetTotals, "byAccountState">): WeeklySheetBarPart<WeeklySheetAccountState>[] {
  return weeklySheetShares(
    WEEKLY_SHEET_ACCOUNT_STATES.map((state) => ({
      count: totals.byAccountState[state],
      key: state,
      label: WEEKLY_SHEET_ACCOUNT_STATE_LABEL[state],
      swatch: WEEKLY_SHEET_ACCOUNT_STATE_SWATCH[state],
    })),
  );
}

/** The specialities accounts fall short of, most first: "ENT short in 14 accounts · Pediatrics in 9". */
export function weeklySheetSpecialityGaps(totals: Pick<WeeklySheetTotals, "shortBy">): Array<{ family: WeeklySheetFamily; label: string; accounts: number }> {
  return WEEKLY_SHEET_FAMILIES.map((family) => ({ accounts: totals.shortBy[family], family, label: DOCTOR_FAMILY_LABEL[family] }))
    .filter((entry) => entry.accounts > 0)
    .sort((left, right) => right.accounts - left.accounts || WEEKLY_SHEET_FAMILIES.indexOf(left.family) - WEEKLY_SHEET_FAMILIES.indexOf(right.family));
}

export function weeklySheetSpecialityGapLine(totals: Pick<WeeklySheetTotals, "shortBy">): string | null {
  const gaps = weeklySheetSpecialityGaps(totals);
  if (gaps.length === 0) return null;
  return gaps.map((entry, index) => (index === 0 ? `${entry.label} short in ${weeklySheetAccountsWord(entry.accounts)}` : `${entry.label} in ${entry.accounts}`)).join(" · ");
}

// ── Reps to look at ──────────────────────────────────────────────────────────────────────────────

export const WEEKLY_SHEET_ATTENTION = ["pm_below", "am_below", "waiting", "no_doctors"] as const;
export type WeeklySheetAttentionReason = (typeof WEEKLY_SHEET_ATTENTION)[number];

export const WEEKLY_SHEET_ATTENTION_LABEL: Record<WeeklySheetAttentionReason, string> = {
  am_below: "AM below target",
  no_doctors: "Accounts with no doctors written",
  pm_below: "PM below target",
  waiting: "Visits waiting for validation",
};

export type WeeklySheetAttentionItem = {
  district: WeeklySheetDistrict;
  rep: WeeklySheetRep;
  reasons: Array<{ reason: WeeklySheetAttentionReason; words: string }>;
};

/**
 * The reps the Regional Sales Manager may want to open first, each with every reason in words. A vacant seat is in
 * none; "Below" exists only in a finished week, so while the week runs only the waiting visits and the accounts
 * with no doctors written can list a rep. Most reasons first, then the larger PM gap, then the name.
 */
export function weeklySheetAttention(sheet: Pick<WeeklySheet, "cairoToday" | "districts" | "weekEnd" | "weekStart">): WeeklySheetAttentionItem[] {
  const position = weeklySheetPosition(sheet);
  const items: Array<WeeklySheetAttentionItem & { pmGap: number }> = [];
  for (const district of sheet.districts) {
    for (const rep of district.reps) {
      if (rep.vacant) continue;
      const reasons: WeeklySheetAttentionItem["reasons"] = [];
      const verdicts = weeklySheetRepVerdicts(rep, position);
      if (verdicts.pm === "Below") reasons.push({ reason: "pm_below", words: `PM ${rep.pm} of ${rep.pmTarget} · ${rep.pmTarget - rep.pm} short` });
      if (verdicts.am === "Below") reasons.push({ reason: "am_below", words: `AM ${rep.am} of ${rep.amTarget} · ${rep.amTarget - rep.am} short` });
      if (rep.waiting > 0) reasons.push({ reason: "waiting", words: `${weeklySheetVisitsWord(rep.waiting)} waiting for validation` });
      const unnamed = rep.accounts.filter((account) => account.depth.noDoctorsWritten).length;
      if (unnamed > 0) reasons.push({ reason: "no_doctors", words: `${weeklySheetAccountsWord(unnamed)} with no doctors written` });
      if (reasons.length > 0) items.push({ district, pmGap: verdicts.pm === "Below" ? rep.pmTarget - rep.pm : 0, reasons, rep });
    }
  }
  return items
    .sort((left, right) => right.reasons.length - left.reasons.length || right.pmGap - left.pmGap || left.rep.person.localeCompare(right.rep.person))
    .map(({ district, reasons, rep }) => ({ district, reasons, rep }));
}

export function weeklySheetAttentionCounts(items: readonly WeeklySheetAttentionItem[]): Record<WeeklySheetAttentionReason, number> {
  const counts = Object.fromEntries(WEEKLY_SHEET_ATTENTION.map((reason) => [reason, 0])) as Record<WeeklySheetAttentionReason, number>;
  for (const item of items) for (const entry of item.reasons) counts[entry.reason] += 1;
  return counts;
}

/** When nobody is listed, why — said for the week's position, never a bare empty list. */
export function weeklySheetAttentionEmptyLine(position: WeeklySheetPosition): string {
  if (position === "ahead") return "The week has not started.";
  if (position === "current") return "Nothing to look at so far: no visit waiting for validation and no account without its doctors.";
  return "Every rep met both targets, with no visit waiting for validation and no account without its doctors.";
}

// ── The filter and the addresses ─────────────────────────────────────────────────────────────────

export const WEEKLY_SHEET_SHOW = ["all", "below", "met"] as const;
export type WeeklySheetShow = (typeof WEEKLY_SHEET_SHOW)[number];

export const WEEKLY_SHEET_SHOW_LABEL: Record<WeeklySheetShow, string> = {
  all: "Every seat",
  below: "Below a target",
  met: "Both targets met",
};

/** Read strictly: anything else is every seat. */
export function parseWeeklySheetShow(value: unknown): WeeklySheetShow {
  const text = Array.isArray(value) ? value[0] : value;
  return (WEEKLY_SHEET_SHOW as readonly unknown[]).includes(text) ? (text as WeeklySheetShow) : "all";
}

function repShown(rep: WeeklySheetRep, show: WeeklySheetShow, position: WeeklySheetPosition): boolean {
  if (show === "all") return true;
  if (!isWeeklySheetMeasured(rep)) return false;
  const verdicts = weeklySheetRepVerdicts(rep, position);
  if (show === "below") return verdicts.pm === "Below" || verdicts.am === "Below";
  return verdicts.pm === "Met" && verdicts.am === "Met";
}

/** A district's stable key: its region, its district and its manager. */
export function weeklySheetDistrictKey(district: Pick<WeeklySheetDistrict, "districtName" | "managerName" | "regionName">): string {
  return `${district.regionName}|${district.districtName}|${district.managerName}`;
}

/**
 * The districts the screen lists under a filter, each with only its listed reps; a district left empty goes. The
 * heading's caption and figures are the whole district's — read them off `sheet.districts` by `weeklySheetDistrictKey`,
 * never off the filtered reps.
 */
export function filterWeeklySheetDistricts(sheet: Pick<WeeklySheet, "cairoToday" | "districts" | "weekEnd" | "weekStart">, show: WeeklySheetShow): WeeklySheetDistrict[] {
  const position = weeklySheetPosition(sheet);
  if (show === "all") return sheet.districts;
  return sheet.districts
    .map((district) => {
      const reps = district.reps.filter((rep) => repShown(rep, show, position));
      return { ...district, reps, vacantSeats: reps.filter((rep) => rep.vacant).length };
    })
    .filter((district) => district.reps.length > 0);
}

export function weeklySheetShowCounts(sheet: Pick<WeeklySheet, "cairoToday" | "districts" | "weekEnd" | "weekStart">): Record<WeeklySheetShow, number> {
  const position = weeklySheetPosition(sheet);
  const reps = sheet.districts.flatMap((district) => district.reps);
  return {
    all: reps.length,
    below: reps.filter((rep) => repShown(rep, "below", position)).length,
    met: reps.filter((rep) => repShown(rep, "met", position)).length,
  };
}

/** When a filter lists nobody, the sentence that says so. */
export function weeklySheetShowEmptyLine(show: WeeklySheetShow, position: WeeklySheetPosition): string {
  if (show === "below") return position === "past" ? "No rep is below a target this week." : "Nobody is graded below a target until the week is over.";
  if (show === "met") return position === "ahead" ? "The week has not started." : "No rep has met both targets yet.";
  return "No reps on your team yet.";
}

export const WEEKLY_SHEET_PATH = "/employee-portals/weekly-sheet";
export const WEEKLY_SHEET_EXPORT_PATH = "/api/crm/weekly-sheet/export";

/** The page for a week (null: the last full week) and a filter (every seat is left out of the address). */
/** The Super Admin's twin in the admin shell, over the whole company (owner, 2026-11-11). */
export const WEEKLY_SHEET_ADMIN_PATH = "/admin/field-crm/weekly-sheet";

export function weeklySheetHref(week: string | null, show: WeeklySheetShow = "all", base: string = WEEKLY_SHEET_PATH): string {
  const params = new URLSearchParams();
  if (week) params.set("week", week);
  if (show !== "all") params.set("show", show);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/** The Excel file for the week on the screen. It always holds every seat, whatever the filter. */
export function weeklySheetExportHref(weekStart: string): string {
  return `${WEEKLY_SHEET_EXPORT_PATH}?week=${encodeURIComponent(weekStart)}`;
}

/** The anchor of a rep's row, so "Reps to look at" can open it. */
export function weeklySheetRepAnchor(rep: Pick<WeeklySheetRep, "seatId">): string {
  return `rep-${rep.seatId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** The seats the page lists under a filter — a "Reps to look at" name links only when its row is on the page. */
export function weeklySheetListedSeats(sheet: Pick<WeeklySheet, "cairoToday" | "districts" | "weekEnd" | "weekStart">, show: WeeklySheetShow): Set<string> {
  return new Set(filterWeeklySheetDistricts(sheet, show).flatMap((district) => district.reps.map((rep) => rep.seatId)));
}

/** The accounts a rep's row opens on, in the order the screen and the file print them: short first, then by name. */
export function weeklySheetAccountsInOrder(accounts: readonly WeeklySheetAccount[]): WeeklySheetAccount[] {
  const rank: Record<WeeklySheetAccountState, number> = { met: 2, no_doctors: 1, short: 0 };
  return [...accounts].sort(
    (left, right) => rank[weeklySheetAccountState(left.depth)] - rank[weeklySheetAccountState(right.depth)] || left.name.localeCompare(right.name),
  );
}
